// MotionMatch.js — Motion Matching для Humanoid: база движений, синтезируемая при загрузке (MotionDB), и
// рантайм-контроллер позы (MotionController): поиск кадра по признакам и прогнозу траектории, инерциализация
// переходов, полёт, подъём после падения, слои поверх, ноги на неровной земле. Чистая логика без Babylon
// (инвариант 4): результат — Humanoid-мир (mm.world, суставы в px); вид ставит model.apply(world, body).
//
// ═══ БАЗА ДВИЖЕНИЙ (MotionDB) ═══════════════════════════════════════════════════════════════════
// Мокапа у браузерной игры нет, поэтому база СИНТЕЗИРУЕТСЯ при загрузке «виртуальным актёром»:
//  1) сценарий дублей (стоит, идёт, бежит, спринтует, разгоняется, тормозит, разворачивается на 90–180°,
//     бежит по дуге, поворачивается на месте) — желаемые скорость и курс по отрезкам;
//  2) корень актёра движется той же пружиной, что и персонаж в игре (Holden, spring character), — база и
//     прогноз траектории в игре говорят на одном языке;
//  3) походка: фаза шага с частотой по скорости, доля опоры (ходьба — двойная опора, бег — полёт),
//     стопы ставятся в мировые точки по БУДУЩЕМУ положению корня в середине опоры (без скольжения),
//     перенос ноги по дуге с перекатом пятка-носок, таз качается и проседает, корпус наклоняется по
//     ускорению и в повороты, плечи против таза, руки маятником, голова смотрит в поворот и гасит качку;
//  4) ноги — аналитическим IK (Humanoid.ikLeg), таз опускается, если стопа иначе не достаётся.
// Каждый кадр базы (60 к/с) хранит позу, корень и признаки (features) для поиска:
//   стопы (положение и скорость), скорость таза, траектория корня через 1/3, 2/3 и 1 с (положение и курс).
// Признаки нормируются (среднее и разброс по группе, вес группы), поиск — полный перебор с ранним отсечением.
// База ВСЕГДА синтезируется для базового тела Humanoid.BODY1 (рост 184 px); растяжение тела рантайм
// масштабирует (длина шага, запас ног, запрос траектории — в единицах базы). Детерминирована: сид ГСЧ фиксирован,
// одинаковые настройки дают те же байты (MotionDB.hash()).
//
//   const db = MotionDB.shared();                 // один на игру: синхронно ~0.3–0.8 с на 200 с базы
//   await MotionDB.sharedAsync(p => loading.set(p)); // то же без подвисания кадра: между дублями отдаёт управление
//   new MotionDB({ seconds: 60, walk: 120 })      // своя база: любые поля MotionDB.cfg()
//
// ═══ КОНТРОЛЛЕР (MotionController) ════════════════════════════════════════════════════════════════
// Поток кадра (update(dt, ch), ch — «бегун»: CharacterPhysics или любой объект с теми же полями, см. MotionDriver):
//  1. Режим: 'mm' (по земле — Motion Matching), 'air' (полёт — процедурная поза по вертикальной скорости),
//     'getup' (подъём после рэгдолла), 'ragdoll' (части ставит Ragdoll — контроллер не вмешивается).
//  2. MM: раз в MOTION_SEARCH_INTERVAL с (или сразу при резкой смене ввода, конце дубля, приземлении)
//     запрос = признаки позы ТЕКУЩЕГО кадра базы + прогноз траектории физической капсулы (та же пружина
//     скорости и курса, что в базе) в системе анимационного корня -> лучший кадр базы. Переход —
//     инерциализацией (Holden): смещение «старая поза − новая» и его скорость затухают критической пружиной.
//  3. Root motion: анимационный корень едет по корню базы, затем подтягивается к физике (не больше доли
//     собственной скорости — ноги не скользят) и не отходит дальше MOTION_MAX_ERROR px.
//  4. Слои поверх: просадка при приземлении (пружина), «живая» вторичная физика корпуса, головы и рук
//     по ускорениям, толкание (ch.pushW), голова смотрит туда же, куда камера; свои слои игры — mm.layerHooks.
//  5. Ноги: стопы опускаются на землю под ними (лестницы, склоны), опорная стопа «прилипает» (foot locking),
//     таз проседает, если ногу иначе не дотянуть, — затем IK и поворот стопы по нормали земли.
//
// MotionDriver (поля, которые читает контроллер; пишет их физика — CharacterPhysics):
//   pos [x, y, z] и vel [vx, vy, vz] — мир px (y вверх, карта y = z), groundVel [3] и groundSpin — скорость и вращение опоры,
//   sx {v, a} / sz {v, a} — состояние пружины скорости, desired [vx, vz] — желаемая скорость, hlVel — её полупериод,
//   facing {x, v} — пружина курса, facingGoal, hlRot, grounded, airTime, jumpT, impact (скорость последнего приземления),
//   pushW 0..1 (толкаю предмет), camYaw/camPitch (взгляд камеры, для головы), ragdoll (≠ null — позой рулит рэгдолл),
//   ground(x, z, yTop) -> { y, n: [nx, ny, nz], moving } | null — опора под точкой (для стоп).

/** @returns {number} мс; в node-тестах и старых окружениях без performance — Date. */
const motionNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

class MotionDB {
    // opts — любые поля MotionDB.cfg() (walk, jog, sprint, seconds, веса признаков…) поверх констант MOTION_*.
    constructor(opts) {
        this.cfg = MotionDB.cfg(opts);
        this.FPS = 60;
        this.F = 27;                       // длина вектора признаков
        this.TRAJ = [20, 40, 60];          // кадры вперёд для траектории
        this.n = 0;
        /** @type {Float32Array} */ this.rootX = null;
        /** @type {Float32Array} */ this.rootZ = null;
        /** @type {Float32Array} */ this.rootYaw = null;
        /** @type {Float32Array} */ this.hips = null;
        /** @type {Float32Array} */ this.rot = null;
        /** @type {Uint8Array} */ this.contact = null;
        /** @type {Int16Array} */ this.take = null;
        /** @type {Uint8Array} */ this.valid = null;
        /** @type {Float32Array} */ this.speed = null;
        /** @type {Float32Array} */ this.feat = null;
        /** @type {Float32Array} */ this.fOffset = null;
        /** @type {Float32Array} */ this.fScale = null;
        /** @type {{ name: string, start: number, end: number }[]} */ this.takes = [];
        this.ready = false;
        this.buildMs = 0;
        this._ts = { v: 0, a: 0 }; this._tz = { v: 0, a: 0 }; this._tf = { x: 0, v: 0 };   // буферы прогноза траектории
    }

    // Параметры базы: константы MOTION_* / CHAR_GRAVITY (Constants.js) с дефолтами, поверх — over.
    static cfg(over) {
        const U = 'undefined', o = over || {};
        const pick = (k, v) => (o[k] != null ? o[k] : v);
        return {
            walk: pick('walk', typeof MOTION_WALK_SPEED !== U ? MOTION_WALK_SPEED : 140),
            jog: pick('jog', typeof MOTION_RUN_SPEED !== U ? MOTION_RUN_SPEED : 300),
            sprint: pick('sprint', typeof MOTION_SPRINT_SPEED !== U ? MOTION_SPRINT_SPEED : 470),
            hlVel: pick('hlVel', typeof MOTION_VEL_HALFLIFE !== U ? MOTION_VEL_HALFLIFE : 0.25),
            hlRot: pick('hlRot', typeof MOTION_ROT_HALFLIFE !== U ? MOTION_ROT_HALFLIFE : 0.18),
            gravity: pick('gravity', typeof CHAR_GRAVITY !== U ? CHAR_GRAVITY : 1200),
            seconds: pick('seconds', typeof MOTION_DB_SECONDS !== U ? MOTION_DB_SECONDS : 200),
            wFootPos: pick('wFootPos', typeof MOTION_W_FOOT_POS !== U ? MOTION_W_FOOT_POS : 0.75),
            wFootVel: pick('wFootVel', typeof MOTION_W_FOOT_VEL !== U ? MOTION_W_FOOT_VEL : 1),
            wHipVel: pick('wHipVel', typeof MOTION_W_HIP_VEL !== U ? MOTION_W_HIP_VEL : 1),
            wTrajPos: pick('wTrajPos', typeof MOTION_W_TRAJ_POS !== U ? MOTION_W_TRAJ_POS : 1.2),
            wTrajDir: pick('wTrajDir', typeof MOTION_W_TRAJ_DIR !== U ? MOTION_W_TRAJ_DIR : 1.5),
            seed: pick('seed', 1501),
        };
    }

    // Общая база игры (кэш по настройкам): строится синхронно при первом вызове.
    static shared(opts) {
        const key = JSON.stringify(MotionDB.cfg(opts));
        let db = MotionDB._shared.get(key);
        if (!db) { db = new MotionDB(opts).build(); MotionDB._shared.set(key, db); }
        return db;
    }

    // То же без подвисания кадра: между дублями возвращает управление событийному циклу (экран загрузки живёт).
    static async sharedAsync(opts, onProgress) {
        const key = JSON.stringify(MotionDB.cfg(opts));
        let db = MotionDB._shared.get(key);
        if (!db) { db = await new MotionDB(opts).buildAsync(onProgress); MotionDB._shared.set(key, db); }
        return db;
    }

    // Частота шагов (шагов/с) и доля опоры по скорости (px/с).
    cadence(s, c) { return 1.75 + 2.45 * Math.pow(GM.clamp(s / c.sprint, 0, 1.3), 0.8); }
    duty(s) { return GM.lerp(0.64, 0.36, GM.smooth((s - 150) / 110)); }
    runFactor(s) { return GM.smooth((s - 170) / 90); }

    // ---- сценарий дублей ---------------------------------------------------------------------------
    // Отрезок: { dur, speed, dir (абсолютный курс), omega (рад/с, дуга), turn (поворот на месте), hlV, hlR }
    program(c) {
        const R = GM.rng(c.seed), D = GM.DEG;
        const rnd = (a, b) => a + (b - a) * R(), pick = (arr) => arr[Math.floor(R() * arr.length)];
        const sgn = () => (R() < 0.5 ? -1 : 1);
        const speedPick = () => { const r = R(); return r < 0.28 ? c.walk * rnd(0.85, 1.1) : r < 0.68 ? c.jog * rnd(0.9, 1.08) : c.sprint * rnd(0.93, 1.03); };
        const takes = [];
        const vary = (seg) => Object.assign({ hlV: c.hlVel * rnd(0.88, 1.15), hlR: c.hlRot * rnd(0.88, 1.15) }, seg);
        // 1. стойка
        takes.push({ name: 'idle', segs: [vary({ dur: 7, speed: 0, dir: 0 })] });
        // 2. повороты на месте
        {
            const segs = [vary({ dur: 1.2, speed: 0, dir: 0 })];
            let dir = 0;
            for (const a of [90, -90, 180, 45, -135, 135, -45, -180, 60, -60]) {
                dir += a * D * (a === 180 || a === -180 ? 0.985 : 1);
                segs.push(vary({ dur: rnd(1.1, 1.6), speed: 0, dir, turn: true }));
            }
            takes.push({ name: 'turn', segs });
        }
        // 3. старты и остановки с разворотом
        {
            const segs = [vary({ dur: 1.0, speed: 0, dir: 0 })];
            let dir = 0;
            for (let k = 0; k < 16; k++) {
                dir += pick([0, 0, 45, -45, 90, -90, 135, -135, 178, -178]) * D;
                segs.push(vary({ dur: rnd(1.0, 2.0), speed: speedPick(), dir }));
                segs.push(vary({ dur: rnd(0.9, 1.6), speed: 0, dir }));
            }
            takes.push({ name: 'start-stop', segs });
        }
        // 4. смена темпа по прямой
        {
            const segs = [vary({ dur: 1.0, speed: 0, dir: 0 })];
            const seq = ['walk', 'jog', 'sprint', 'jog', 'walk', 0, 'sprint', 'walk', 'sprint', 0, 'jog', 'sprint', 'walk', 0];
            for (const s of seq) segs.push(vary({ dur: s === 0 ? 1.3 : rnd(1.3, 2.2), speed: s === 0 ? 0 : c[s] * rnd(0.95, 1.05), dir: rnd(-0.1, 0.1) }));
            takes.push({ name: 'pace', segs });
        }
        // 5. свободная беготня (и её зеркало — левые и правые повороты поровну)
        const freeSeconds = Math.max(30, c.seconds - 7 - 16 - 40 - 26);
        const nFree = 4, perTake = freeSeconds / nFree;
        for (let t = 0; t < nFree / 2; t++) {
            const segs = [vary({ dur: 1.0, speed: 0, dir: 0 })];
            let dir = 0, time = 1, speed = 0;
            while (time < perTake) {
                const r = R();
                let seg;
                if (speed > 0 && r < 0.14) seg = { dur: rnd(0.8, 1.8), speed: 0, dir };
                else if (r < 0.3) seg = { dur: rnd(1.4, 3.0), speed: speedPick(), dir, omega: sgn() * rnd(40, 115) * D };
                else {
                    const r2 = R();
                    const d = r2 < 0.35 ? rnd(0, 25) : r2 < 0.6 ? rnd(25, 70) : r2 < 0.8 ? rnd(70, 120) : r2 < 0.92 ? rnd(120, 160) : rnd(172, 179);
                    dir += sgn() * d * D;
                    seg = { dur: rnd(0.6, 2.2), speed: speedPick(), dir };
                }
                seg = vary(seg);
                segs.push(seg);
                if (seg.omega) dir += seg.omega * seg.dur;
                speed = seg.speed;
                time += seg.dur;
            }
            takes.push({ name: 'free-' + t, segs });
            takes.push({ name: 'free-' + t + '-m', segs: segs.map(s => Object.assign({}, s, { dir: -s.dir, omega: s.omega ? -s.omega : 0 })) });
        }
        for (const tk of takes) tk.segs.push(vary({ dur: 1.7, speed: 0, dir: tk.segs[tk.segs.length - 1].dir + (tk.segs[tk.segs.length - 1].omega || 0) * tk.segs[tk.segs.length - 1].dur }));
        return takes;
    }

    // ---- синтез --------------------------------------------------------------------------------------
    // Синхронно. Возвращает this.
    build() {
        for (const p of this._steps()) void p;
        return this;
    }

    // Не блокируя кадр: после каждого дубля отдаёт управление (setTimeout 0). onProgress(0..1).
    async buildAsync(onProgress) {
        for (const p of this._steps()) {
            if (onProgress) onProgress(p);
            await new Promise((r) => setTimeout(r, 0));
        }
        return this;
    }

    // Шаги сборки: после каждого дубля отдаёт долю готовности.
    *_steps() {
        const t0 = motionNow();
        const c = this.cfg;
        this.ready = false;
        const takes = this.program(c);
        const parts = [];
        for (let i = 0; i < takes.length; i++) {
            parts.push(this.synthTake(takes[i], c, c.seed + i * 17));
            yield (i + 1) / (takes.length + 1);
        }
        let n = 0;
        for (const p of parts) n += p.n;
        this.n = n;
        this.rootX = new Float32Array(n); this.rootZ = new Float32Array(n); this.rootYaw = new Float32Array(n);
        this.hips = new Float32Array(n * 3); this.rot = new Float32Array(n * 60);
        this.contact = new Uint8Array(n * 2); this.take = new Int16Array(n); this.valid = new Uint8Array(n);
        this.speed = new Float32Array(n);
        this.takes = [];
        let o = 0;
        for (let k = 0; k < parts.length; k++) {
            const p = parts[k];
            this.rootX.set(p.X, o); this.rootZ.set(p.Z, o); this.rootYaw.set(p.TH, o);
            this.hips.set(p.hips, o * 3); this.rot.set(p.rot, o * 60); this.contact.set(p.contact, o * 2);
            this.speed.set(p.S, o);
            for (let i = 0; i < p.n; i++) {
                this.take[o + i] = k;
                this.valid[o + i] = (i >= 1 && i + this.TRAJ[2] < p.n) ? 1 : 0;
            }
            this.takes.push({ name: takes[k].name, start: o, end: o + p.n });
            o += p.n;
        }
        this.computeFeatures(c);
        this.ready = true;
        this.buildMs = motionNow() - t0;
        yield 1;
    }

    // Один дубль: корень, фаза, стопы, таз, корпус, руки, IK -> массивы кадров.
    synthTake(tk, c, seed) {
        const R = GM.rng(seed), D = GM.DEG, dt = 1 / this.FPS, G = c.gravity;
        let total = 0;
        for (const s of tk.segs) total += s.dur;
        const n = Math.max(2, Math.round(total * this.FPS));
        const X = new Float32Array(n), Z = new Float32Array(n), TH = new Float32Array(n), S = new Float32Array(n);
        const W = new Float32Array(n), AF = new Float32Array(n), VX = new Float32Array(n), VZ = new Float32Array(n);
        // 1) корень
        const sx = { v: 0, a: 0 }, sz = { v: 0, a: 0 }, fa = { x: tk.segs[0].dir || 0, v: 0 };
        let x = 0, z = 0, seg = 0, segT = 0, goalDir = fa.x;
        for (let i = 0; i < n; i++) {
            while (seg < tk.segs.length - 1 && segT >= tk.segs[seg].dur) { segT -= tk.segs[seg].dur; seg++; }
            const sg = tk.segs[seg];
            const dir = sg.dir + (sg.omega || 0) * segT;
            const vgx = sg.speed * Math.cos(dir), vgz = sg.speed * Math.sin(dir);
            x += GM.springChar(sx, vgx, sg.hlV, dt);
            z += GM.springChar(sz, vgz, sg.hlV, dt);
            if (sg.speed > 0 || sg.turn) goalDir = dir;
            GM.springAngle(fa, goalDir, sg.hlR, dt);
            X[i] = x; Z[i] = z; TH[i] = fa.x; W[i] = fa.v; VX[i] = sx.v; VZ[i] = sz.v;
            S[i] = Math.hypot(sx.v, sz.v);
            AF[i] = sx.a * Math.cos(fa.x) + sz.a * Math.sin(fa.x);
            segT += dt;
        }
        // 2) фаза шага: движение по окну (что будет в ближайшие 0.4 с), остановка — в двойной опоре
        const moving = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
            let m = 0;
            for (let j = Math.max(0, i - 6); j <= Math.min(n - 1, i + 24); j++) if (S[j] > 18 || Math.abs(W[j]) > 0.9) { m = 1; break; }
            moving[i] = m;
        }
        const PH = new Float64Array(n), BETA = new Float32Array(n), FROZEN = new Uint8Array(n);
        let ph = R() < 0.5 ? 0.05 : 0.55, frozen = true;
        for (let i = 0; i < n; i++) {
            const s = S[i];
            BETA[i] = this.duty(s);
            let rate = this.cadence(s, c) / 2;
            if (Math.abs(W[i]) > 0.9 && s < 80) rate = Math.max(rate, 1.05);
            if (frozen && moving[i]) frozen = false;
            if (!frozen) {
                let nx = ph + rate * dt;
                if (!moving[i] && Math.floor((ph - 0.05) / 0.5) < Math.floor((nx - 0.05) / 0.5)) {
                    nx = Math.floor((nx - 0.05) / 0.5) * 0.5 + 0.05;
                    frozen = true;
                }
                ph = nx;
            }
            PH[i] = ph; FROZEN[i] = frozen ? 1 : 0;
        }
        // 3) опоры каждой стопы и точки постановки
        const plants = [[], []];   // { a, b, x, z, yaw, run }
        for (let k = 0; k < 2; k++) {
            let a = -1;
            for (let i = 0; i <= n; i++) {
                const st = i < n && GM.frac(PH[i] - k * 0.5) < BETA[i];
                if (st && a < 0) a = i;
                if (!st && a >= 0) {
                    const m = Math.floor((a + i - 1) / 2);
                    const th = TH[m], sp = S[m];
                    const w = GM.lerp(15, 9, GM.clamp(sp / c.sprint, 0, 1));
                    const side = k ? 1 : -1;
                    const toe = (5 - 3 * this.runFactor(sp)) * D * side;
                    plants[k].push({ a, b: i, x: X[m] - Math.sin(th) * w * side, z: Z[m] + Math.cos(th) * w * side, yaw: th + toe, run: this.runFactor(S[a]), sp });
                    a = -1;
                }
            }
        }
        // 4) стопы по кадрам: подошва (плоская точка), курс, тангаж
        const FS = [new Float32Array(n * 3), new Float32Array(n * 3)], FY = [new Float32Array(n), new Float32Array(n)], FP = [new Float32Array(n), new Float32Array(n)];
        const STANCE = [new Uint8Array(n), new Uint8Array(n)];
        for (let k = 0; k < 2; k++) {
            const pl = plants[k];
            for (let q = 0; q < pl.length; q++) {
                const p = pl[q], T = (p.b - p.a) / this.FPS;
                const lifts = p.b < n;
                const offA = (22 + 18 * p.run) * D;
                const strike = (-12 * (1 - p.run) - 1) * D;
                for (let i = p.a; i < p.b; i++) {
                    let pitch = 0;
                    const tIn = (i - p.a) / this.FPS, tLeft = (p.b - i) / this.FPS;
                    if (q > 0 || p.a > 0) pitch = strike * (1 - GM.smooth(tIn / 0.09));
                    if (lifts) { const Th = GM.clamp(0.35 * T, 0.06, 0.24); if (tLeft < Th) pitch = offA * GM.smooth(1 - tLeft / Th); }
                    FS[k][i * 3] = p.x; FS[k][i * 3 + 1] = 0; FS[k][i * 3 + 2] = p.z; FY[k][i] = p.yaw; FP[k][i] = pitch;
                    STANCE[k][i] = 1;
                }
                // перенос до следующей опоры
                const nx = pl[q + 1];
                if (!nx) continue;
                const span = nx.a - p.b + 1, run = this.runFactor(S[Math.min(n - 1, Math.floor((p.b + nx.a) / 2))]);
                const sp = S[Math.min(n - 1, Math.floor((p.b + nx.a) / 2))];
                const Hs = (6 + 0.042 * sp) * (Math.abs(W[p.b] || 0) > 0.9 && sp < 80 ? 0.7 : 1);
                const landPitch = (-12 * (1 - nx.run) - 2) * D;
                const dyaw = GM.wrap(nx.yaw - p.yaw);
                for (let i = p.b; i < nx.a; i++) {
                    const u = (i - p.b + 1) / span;
                    const uh = GM.smoother(Math.pow(u, 1 + 0.6 * run));
                    const lift = Hs * Math.sin(Math.PI * Math.pow(u, 0.9 - 0.3 * run));
                    FS[k][i * 3] = GM.lerp(p.x, nx.x, uh); FS[k][i * 3 + 1] = lift; FS[k][i * 3 + 2] = GM.lerp(p.z, nx.z, uh);
                    FY[k][i] = p.yaw + dyaw * GM.smooth(u);
                    FP[k][i] = GM.lerp(offA, landPitch, GM.smooth(u * 1.15));
                }
            }
            // до первой опоры и после последней — на месте
            if (pl.length) {
                for (let i = 0; i < pl[0].a; i++) { FS[k][i * 3] = pl[0].x; FS[k][i * 3 + 2] = pl[0].z; FY[k][i] = pl[0].yaw; STANCE[k][i] = 1; }
                const L = pl[pl.length - 1];
                for (let i = L.b; i < n; i++) { FS[k][i * 3] = L.x; FS[k][i * 3 + 2] = L.z; FY[k][i] = L.yaw; STANCE[k][i] = 1; }
            }
        }
        // 5) таз, корпус, руки, голова; IK ног
        const pose = Humanoid.newPose(), w = Humanoid.newWorld(), B1 = Humanoid.BODY1;
        const hipsOut = new Float32Array(n * 3), rotOut = new Float32Array(n * 60), contact = new Uint8Array(n * 2);
        const rootQ = [0, 0, 0, 1], rootP = [0, 0, 0], q = [0, 0, 0, 1], q2 = [0, 0, 0, 1], v = [0, 0, 0];
        const footQ = [[0, 0, 0, 1], [0, 0, 0, 1]], ankle = [[0, 0, 0], [0, 0, 0]], sole = [0, 0, 0];
        const hipsW = [0, 0, 0], hipsQ = [0, 0, 0, 1], hj = [0, 0, 0];
        const drop = new Float32Array(n);
        const hipY = new Float32Array(n);
        const J = Humanoid.J, LMAX = B1.thigh + B1.shin - 1.2;
        // тазобедренные суставы относительно таза и высота таза с прямыми ногами (базовое тело: 74 px)
        const HJ = [[B1.off[J.HIPL * 3], B1.off[J.HIPL * 3 + 1], B1.off[J.HIPL * 3 + 2]], [B1.off[J.HIPR * 3], B1.off[J.HIPR * 3 + 1], B1.off[J.HIPR * 3 + 2]]];
        const HY = B1.off[1];
        let idleT = 0;
        const smAF = new Float32Array(n), smW = new Float32Array(n);
        // сглаженные ускорение и угловая скорость (наклоны не дёргаются)
        for (let i = 0; i < n; i++) {
            let sa = 0, sw = 0, cnt = 0;
            for (let j = Math.max(0, i - 5); j <= Math.min(n - 1, i + 5); j++) { sa += AF[j]; sw += W[j]; cnt++; }
            smAF[i] = sa / cnt; smW[i] = sw / cnt;
        }
        // проход A: таз (высота с ограничением по досягаемости стоп)
        const hipRot = new Float32Array(n * 4), lean = new Float32Array(n), bankA = new Float32Array(n), twistA = new Float32Array(n), dropRoll = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const s = S[i], ph = PH[i], beta = BETA[i], r = this.runFactor(s), th = TH[i];
            const mv = GM.clamp(s / 80, 0, 1);
            idleT = FROZEN[i] ? idleT + dt : 0;
            const idleW = GM.smooth(idleT / 1.2);
            const twist = -(3 + 5 * s / c.sprint) * D * mv * Math.cos(2 * Math.PI * ph);
            const sr = GM.clamp(s / c.sprint, 0, 1.2);
            const leanV = (2 + 6 * sr * sr) * D;
            const leanA = GM.clamp(Math.atan(smAF[i] / G) * 0.55, -14 * D, 16 * D);
            const bank = GM.clamp(Math.atan(s * smW[i] / G) * 0.55, -18 * D, 18 * D);
            const pdrop = 3 * D * (1 - r) * mv * Math.cos(2 * Math.PI * (ph - beta / 2));
            const idleSway = idleW * 0.9 * D * Math.sin(2 * Math.PI * i * dt / 5.3);
            lean[i] = leanV + leanA; bankA[i] = bank; twistA[i] = twist; dropRoll[i] = pdrop;
            GM.qheading(rootQ, th);
            GM.qeuler(q, twist + idleSway * 0.6, -(leanV + leanA) * 0.6, bank + pdrop + idleSway);
            GM.qmul(hipsQ, rootQ, q);
            hipRot.set(hipsQ, i * 4);
            // центр таза (сустав Hips; тазобедренные — на 8 px ниже, прямая нога — 74): стойка — колени чуть мягкие, бег — ниже
            const h0 = s < c.walk ? GM.lerp(HY - 0.8, HY - 1.6, s / c.walk) : GM.lerp(HY - 1.6, HY - 4.8, GM.clamp((s - c.walk) / (c.sprint - c.walk), 0, 1));
            const bobW = 1.6 * GM.clamp(s / c.walk, 0, 1) * Math.cos(4 * Math.PI * (ph - beta / 2));
            const bobR = -(3.2 + 3 * GM.clamp((s - 260) / 210, 0, 1)) * Math.cos(4 * Math.PI * (ph - beta / 2));
            hipY[i] = h0 + GM.lerp(bobW, bobR, r) + idleW * 0.4 * Math.sin(2 * Math.PI * i * dt / 3.4);
            const sway = -(2.4 * (1 - r) * mv) * Math.cos(2 * Math.PI * (ph - beta / 2)) + idleW * 2.2 * Math.sin(2 * Math.PI * i * dt / 5.3);
            hipsW[0] = X[i] - Math.sin(th) * sway; hipsW[1] = hipY[i]; hipsW[2] = Z[i] + Math.cos(th) * sway;
            hipsOut[i * 3] = hipsW[0]; hipsOut[i * 3 + 1] = hipsW[1]; hipsOut[i * 3 + 2] = hipsW[2];
            // досягаемость: опорные — жёстко, переносимые — наполовину
            let need = 0;
            for (let k = 0; k < 2; k++) {
                sole[0] = FS[k][i * 3]; sole[1] = FS[k][i * 3 + 1]; sole[2] = FS[k][i * 3 + 2];
                Humanoid.footFrame(sole, FY[k][i], FP[k][i], null, footQ[k], ankle[k]);
                GM.qrot(hj, hipsQ, HJ[k]); GM.add(hj, hj, hipsW);
                const dh = Math.hypot(hj[0] - ankle[k][0], hj[2] - ankle[k][2]);
                const maxY = ankle[k][1] + Math.sqrt(Math.max(0, LMAX * LMAX - dh * dh));
                const d = hj[1] - maxY;
                if (d > 0) need = Math.max(need, STANCE[k][i] ? d : d * 0.5);
            }
            drop[i] = need;
        }
        // сгладить провал таза (без рывков), но не меньше нужного для опорной ноги
        const dropS = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            let m = 0;
            for (let j = Math.max(0, i - 4); j <= Math.min(n - 1, i + 4); j++) { m = Math.max(m, drop[j] * (1 - Math.abs(j - i) / 6)); }
            dropS[i] = m;
        }
        // проход B: поза
        for (let i = 0; i < n; i++) {
            const s = S[i], ph = PH[i], r = this.runFactor(s), th = TH[i];
            const mv = GM.clamp(s / 80, 0, 1);
            GM.qheading(rootQ, th);
            rootP[0] = X[i]; rootP[1] = 0; rootP[2] = Z[i];
            // таз в системе корня
            v[0] = hipsOut[i * 3] - X[i]; v[1] = hipsOut[i * 3 + 1] - dropS[i]; v[2] = hipsOut[i * 3 + 2] - Z[i];
            GM.qinvrot(pose.hips, rootQ, v);
            q[0] = hipRot[i * 4]; q[1] = hipRot[i * 4 + 1]; q[2] = hipRot[i * 4 + 2]; q[3] = hipRot[i * 4 + 3];
            GM.qinvmul(q, rootQ, q);
            Humanoid.setLocal(pose, J.HIPS, q);
            // корпус: против таза, наклон, дыхание
            const idleW = FROZEN[i] ? GM.smooth(Math.min(1, (i > 0 ? 1 : 0))) : 0;
            const breath = (FROZEN[i] ? 1 : 0.25) * 0.9 * D * Math.sin(2 * Math.PI * i * dt / 3.4);
            const runLean = (2 + 7 * GM.clamp(s / c.sprint, 0, 1.2)) * D;
            GM.qeuler(q, -1.35 * twistA[i], -(0.4 * lean[i] + runLean) + breath, -0.75 * dropRoll[i] - 0.25 * bankA[i]);
            Humanoid.setLocal(pose, J.WAIST, q);
            // руки маятником (противофаза ногам)
            const amp = (22 * GM.clamp(s / c.walk, 0, 1) + 30 * GM.clamp((s - c.walk) / (c.sprint - c.walk), 0, 1)) * D;
            const sw = Math.cos(2 * Math.PI * (ph - 0.04));
            const bias = (3 + 7 * r) * D;
            const abd = (4 + 4 * r) * D + idleW * 0.4 * D * Math.sin(2 * Math.PI * i * dt / 3.4);
            const elb0 = GM.lerp(10, 72, r) * D + 12 * D * s / c.sprint;
            for (let k = 0; k < 2; k++) {
                const side = k ? 1 : -1;            // правая +, левая −
                const a = side * amp * sw + bias;     // правая рука вперёд при левой ноге впереди
                GM.qeuler(q, 0, a, -side * abd);
                Humanoid.setLocal(pose, k ? J.SHR : J.SHL, q);
                const fw = Math.max(0, a) / Math.max(1e-3, amp + bias);
                GM.qeuler(q, 0, elb0 + 18 * D * fw * mv, 0);
                Humanoid.setLocal(pose, k ? J.ELR : J.ELL, q);
                GM.qeuler(q, 0, 6 * D, 0);
                Humanoid.setLocal(pose, k ? J.WRR : J.WRL, q);
            }
            // FK верха, чтобы поставить голову и найти тазобедренные суставы
            Humanoid.fk(pose, rootP, rootQ, w);
            // голова: смотрит в будущий курс, гасит наклоны корпуса
            const fut = Math.min(n - 1, i + 27);
            const look = GM.clamp(GM.wrap(TH[fut] - th), -50 * D, 50 * D) * 0.8;
            const nod = 1.5 * D * r * Math.cos(4 * Math.PI * (ph - BETA[i] / 2));
            GM.qheading(q2, th + look);
            GM.qeuler(q, 0, nod, 0);
            GM.qmul(q2, q2, q);
            Humanoid.getRot(w, J.WAIST, q);
            GM.qinvmul(q2, q, q2);
            GM.qslerp(q2, [0, 0, 0, 1], q2, 0.78);
            Humanoid.setLocal(pose, J.NECK, q2);
            // ноги — IK к стопам
            for (let k = 0; k < 2; k++) {
                sole[0] = FS[k][i * 3]; sole[1] = FS[k][i * 3 + 1]; sole[2] = FS[k][i * 3 + 2];
                Humanoid.footFrame(sole, FY[k][i], FP[k][i], null, footQ[k], ankle[k]);
                Humanoid.getRot(w, J.HIPS, q);
                const axis = Humanoid.kneeAxis([0, 0, 0], footQ[k], q);
                Humanoid.ikLeg(pose, w, k, ankle[k], axis, footQ[k]);
                contact[i * 2 + k] = STANCE[k][i] && Math.abs(FP[k][i]) < 4 * D ? 1 : 0;
            }
            hipsOut[i * 3] = pose.hips[0]; hipsOut[i * 3 + 1] = pose.hips[1]; hipsOut[i * 3 + 2] = pose.hips[2];
            rotOut.set(pose.rot, i * 60);
        }
        void VX; void VZ;
        return { n, X, Z, TH, S, hips: hipsOut, rot: rotOut, contact };
    }

    // ---- признаки ------------------------------------------------------------------------------------
    computeFeatures(c) {
        const n = this.n, F = this.F;
        const feat = this.feat = new Float32Array(n * F);
        const pose = Humanoid.newPose(), w = Humanoid.newWorld(), id = [0, 0, 0, 1], zero = [0, 0, 0];
        // положения суставов (стопы, таз) в системе корня каждого кадра
        const loc = new Float32Array(n * 9);
        const J = Humanoid.J;
        for (let i = 0; i < n; i++) {
            this.samplePoseAt(i, pose);
            Humanoid.fk(pose, zero, id, w);
            for (const [s, j] of [[0, J.ANL], [1, J.ANR], [2, J.HIPS]]) {
                loc[i * 9 + s * 3] = w.pos[j * 3]; loc[i * 9 + s * 3 + 1] = w.pos[j * 3 + 1]; loc[i * 9 + s * 3 + 2] = w.pos[j * 3 + 2];
            }
        }
        const world = (i, s, o) => {   // мировое положение сустава s кадра i
            const th = this.rootYaw[i], cs = Math.cos(th), sn = Math.sin(th);
            const lx = loc[i * 9 + s * 3], ly = loc[i * 9 + s * 3 + 1], lz = loc[i * 9 + s * 3 + 2];
            // Ry(−θ)·(x, y, z): x' = x cos θ − z sin θ, z' = x sin θ + z cos θ
            o[0] = this.rootX[i] + lx * cs - lz * sn; o[1] = ly; o[2] = this.rootZ[i] + lx * sn + lz * cs;
            return o;
        };
        const a = [0, 0, 0], b = [0, 0, 0];
        for (const tk of this.takes) {
            for (let i = tk.start; i < tk.end; i++) {
                const o = i * F, th = this.rootYaw[i], cs = Math.cos(th), sn = Math.sin(th);
                for (let s = 0; s < 2; s++) { feat[o + s * 3] = loc[i * 9 + s * 3]; feat[o + s * 3 + 1] = loc[i * 9 + s * 3 + 1]; feat[o + s * 3 + 2] = loc[i * 9 + s * 3 + 2]; }
                const i0 = Math.max(tk.start, i - 1), i1 = Math.min(tk.end - 1, i + 1), inv = this.FPS / Math.max(1, i1 - i0);
                for (let s = 0; s < 3; s++) {
                    world(i0, s, a); world(i1, s, b);
                    const vx = (b[0] - a[0]) * inv, vy = (b[1] - a[1]) * inv, vz = (b[2] - a[2]) * inv;
                    // в систему корня: Ry(θ)
                    const k = o + 6 + s * 3;
                    feat[k] = vx * cs + vz * sn; feat[k + 1] = vy; feat[k + 2] = -vx * sn + vz * cs;
                }
                for (let t = 0; t < 3; t++) {
                    const j = Math.min(tk.end - 1, i + this.TRAJ[t]);
                    const dx = this.rootX[j] - this.rootX[i], dz = this.rootZ[j] - this.rootZ[i];
                    feat[o + 15 + t * 2] = dx * cs + dz * sn; feat[o + 15 + t * 2 + 1] = -dx * sn + dz * cs;
                    const dth = this.rootYaw[j] - th;
                    feat[o + 21 + t * 2] = Math.cos(dth); feat[o + 21 + t * 2 + 1] = Math.sin(dth);
                }
            }
        }
        // нормировка: среднее по измерению, разброс — по группе / вес группы
        const groups = [[0, 6, c.wFootPos], [6, 12, c.wFootVel], [12, 15, c.wHipVel], [15, 21, c.wTrajPos], [21, 27, c.wTrajDir]];
        const mean = new Float64Array(F), sd = new Float64Array(F);
        for (let i = 0; i < n; i++) for (let d = 0; d < F; d++) mean[d] += feat[i * F + d];
        for (let d = 0; d < F; d++) mean[d] /= n;
        for (let i = 0; i < n; i++) for (let d = 0; d < F; d++) { const e = feat[i * F + d] - mean[d]; sd[d] += e * e; }
        for (let d = 0; d < F; d++) sd[d] = Math.sqrt(sd[d] / n);
        this.fOffset = new Float32Array(F); this.fScale = new Float32Array(F);
        for (const [g0, g1, wt] of groups) {
            let m = 0;
            for (let d = g0; d < g1; d++) m += sd[d];
            m = m / (g1 - g0) || 1;
            for (let d = g0; d < g1; d++) { this.fOffset[d] = mean[d]; this.fScale[d] = m / Math.max(1e-4, wt); }
        }
        for (let i = 0; i < n; i++) for (let d = 0; d < F; d++) feat[i * F + d] = (feat[i * F + d] - this.fOffset[d]) / this.fScale[d];
    }

    // Нормировать вектор запроса на месте.
    normalize(q) { for (let d = 0; d < this.F; d++) q[d] = (q[d] - this.fOffset[d]) / this.fScale[d]; return q; }

    // Траектория бегуна -> часть запроса q[15..27) (положение корня через 1/3, 2/3 и 1 с и курс), уже нормированная.
    // ch — MotionDriver; origin [x, y, z] и yaw — анимационный корень (прогноз считается в его системе);
    // invLeg = 1 / длина ноги тела: траектория растянутого тела переводится в единицы базы.
    trajectoryQuery(ch, origin, yaw, invLeg, q) {
        const cy = Math.cos(yaw), sy = Math.sin(yaw);
        const gx = ch.groundVel[0], gz = ch.groundVel[2];
        const sx = this._ts, sz = this._tz, fa = this._tf;
        for (let t = 0; t < 3; t++) {
            const T = this.TRAJ[t] / this.FPS;
            sx.v = ch.sx.v; sx.a = ch.sx.a; sz.v = ch.sz.v; sz.a = ch.sz.a;
            const dx = GM.springChar(sx, ch.desired[0], ch.hlVel, T) + gx * T;
            const dz = GM.springChar(sz, ch.desired[1], ch.hlVel, T) + gz * T;
            const rx = ch.pos[0] + dx - origin[0], rz = ch.pos[2] + dz - origin[2];
            q[15 + t * 2] = (rx * cy + rz * sy) * invLeg; q[15 + t * 2 + 1] = (-rx * sy + rz * cy) * invLeg;
            fa.x = ch.facing.x; fa.v = ch.facing.v;
            GM.springAngle(fa, ch.facingGoal, ch.hlRot, T);
            const dth = fa.x - yaw;
            q[21 + t * 2] = Math.cos(dth); q[21 + t * 2 + 1] = Math.sin(dth);
        }
        for (let d = 15; d < this.F; d++) q[d] = (q[d] - this.fOffset[d]) / this.fScale[d];
        return q;
    }

    // Лучший кадр для запроса (нормированного). skipFrom..skipTo — исключить кадры [from, to). -> out { index, cost }
    search(q, out, skipFrom, skipTo) {
        const F = this.F, feat = this.feat, valid = this.valid, n = this.n;
        let best = -1, bestCost = Infinity;
        for (let i = 0; i < n; i++) {
            if (!valid[i] || (i >= skipFrom && i < skipTo)) continue;
            const o = i * F;
            let cost = 0;
            for (let d = 0; d < F; d++) {
                const e = q[d] - feat[o + d];
                cost += e * e;
                if (cost >= bestCost) break;
            }
            if (cost < bestCost) { bestCost = cost; best = i; }
        }
        out.index = best; out.cost = bestCost;
        return out;
    }

    // Стоимость кадра i для запроса (для решения «остаться ли на текущем»).
    costAt(q, i) {
        const F = this.F, o = i * F;
        let cost = 0;
        for (let d = 0; d < F; d++) { const e = q[d] - this.feat[o + d]; cost += e * e; }
        return cost;
    }

    takeOf(i) { return this.takes[this.take[i]]; }

    // Хеш содержимого (FNV-1a по байтам рядов): одинаковые настройки — одинаковая база.
    hash() {
        let h = 0x811c9dc5;
        for (const arr of [this.rootX, this.rootZ, this.rootYaw, this.hips, this.rot, this.feat, this.contact, this.take]) {
            const u = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
            for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 0x01000193); }
        }
        return (h >>> 0).toString(16);
    }

    // ---- выборка ---------------------------------------------------------------------------------------
    samplePoseAt(i, pose) {
        pose.hips[0] = this.hips[i * 3]; pose.hips[1] = this.hips[i * 3 + 1]; pose.hips[2] = this.hips[i * 3 + 2];
        for (let k = 0; k < 60; k++) pose.rot[k] = this.rot[i * 60 + k];
        return pose;
    }
    // Поза в дробном кадре f (внутри дубля): таз — линейно, повороты — nlerp короткой дугой.
    samplePose(f, pose) {
        const i0 = Math.floor(f), tk = this.takeOf(i0), i1 = Math.min(tk.end - 1, i0 + 1), t = f - i0;
        const H = this.hips, Rr = this.rot;
        for (let k = 0; k < 3; k++) pose.hips[k] = H[i0 * 3 + k] + (H[i1 * 3 + k] - H[i0 * 3 + k]) * t;
        for (let j = 0; j < 15; j++) {
            const a = i0 * 60 + j * 4, b = i1 * 60 + j * 4;
            let bx = Rr[b], by = Rr[b + 1], bz = Rr[b + 2], bw = Rr[b + 3];
            if (Rr[a] * bx + Rr[a + 1] * by + Rr[a + 2] * bz + Rr[a + 3] * bw < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
            let x = Rr[a] + (bx - Rr[a]) * t, y = Rr[a + 1] + (by - Rr[a + 1]) * t, z = Rr[a + 2] + (bz - Rr[a + 2]) * t, w = Rr[a + 3] + (bw - Rr[a + 3]) * t;
            const l = Math.sqrt(x * x + y * y + z * z + w * w) || 1;
            pose.rot[j * 4] = x / l; pose.rot[j * 4 + 1] = y / l; pose.rot[j * 4 + 2] = z / l; pose.rot[j * 4 + 3] = w / l;
        }
        return pose;
    }
    // Корень в дробном кадре: { x, z, yaw }.
    sampleRoot(f, o) {
        const i0 = Math.floor(f), tk = this.takeOf(i0), i1 = Math.min(tk.end - 1, i0 + 1), t = f - i0;
        o.x = this.rootX[i0] + (this.rootX[i1] - this.rootX[i0]) * t;
        o.z = this.rootZ[i0] + (this.rootZ[i1] - this.rootZ[i0]) * t;
        o.yaw = this.rootYaw[i0] + GM.wrap(this.rootYaw[i1] - this.rootYaw[i0]) * t;
        return o;
    }
}

/** @type {Map<string, MotionDB>} общие базы игры по настройкам (MotionDB.shared) */
MotionDB._shared = new Map();

// ═══ КОНТРОЛЛЕР ═══════════════════════════════════════════════════════════════════════════════════
class MotionController {
    // model — объект с apply(world, body) (Humanoid.build, HumanoidRig, свой) или null: тогда игра читает mm.world сама.
    // opts: { db?: MotionDB (по умолчанию общая), body?: Humanoid.body(...), cfg?: поля MotionController.cfg() }.
    constructor(model, opts) {
        const o = opts || {};
        this.db = o.db || MotionDB.shared();
        this.model = model || null;
        this.base = Humanoid.newPose();       // источник кадра (база / процедурная поза)
        this.blend = Humanoid.newPose();      // источник + затухающие смещения инерциализации
        this.prevBlend = Humanoid.newPose();
        this.pose = Humanoid.newPose();       // итог кадра (со слоями)
        this.tmp = Humanoid.newPose();
        this.tmp2 = Humanoid.newPose();
        this.world = Humanoid.newWorld();
        this.offHips = new Float64Array(6);
        this.offRot = new Float64Array(15 * 6);
        this.cur = 0;
        this.char = { pos: [0, 0, 0], yaw: 0, vel: [0, 0, 0] };   // анимационный корень (идёт за физикой)
        this.mode = 'mm';
        this.modeT = 0;
        this.searchT = 0;
        this.lastDt = 1 / 60;
        this.lastDesired = [0, 0];
        this.locks = [0, 1].map(() => ({ on: false, pos: [0, 0, 0], off: new Float64Array(6), body: null }));
        this.pelvisDrop = 0;
        this.land = new Float64Array(2);
        this.sec = new Float64Array(20);
        this.aFast = [0, 0, 0]; this.aSlow = [0, 0, 0];
        this.prevCharVel = [0, 0, 0];
        this.look = { yaw: 0, pitch: 0 };
        this.pushW = 0;
        this.takeoffLeg = 0;
        this.getup = { faceDown: true, T: 1.25 };
        this.q = new Float32Array(this.db.F);
        this.res = { index: 0, cost: 0 };
        this.debug = { index: 0, take: '', cost: 0, searches: 0, transitions: 0, ms: 0, mode: 'mm' };
        /** @type {Float32Array | null} */
        this.dbgTraj = null;
        /** @type {{ side: number, x: number, y: number, z: number, speed: number }[]} стопа коснулась земли (звук шагов, пыль) */
        this.footEvents = [];
        this._prevContact = [1, 1];
        this._r0 = { x: 0, z: 0, yaw: 0 }; this._r1 = { x: 0, z: 0, yaw: 0 };
        this._v = [0, 0, 0]; this._v2 = [0, 0, 0]; this._q = [0, 0, 0, 1]; this._q2 = [0, 0, 0, 1]; this._q3 = [0, 0, 0, 1];
        this._rootQ = [0, 0, 0, 1];
        this._dv = { hips: [0, 0, 0], rot: new Float64Array(45) };
        this._lastPos = null;
        this._ft0 = [0, 0, 0]; this._ft1 = [0, 0, 0]; this._fq0 = [0, 0, 0, 1]; this._fq1 = [0, 0, 0, 1];
        this.cfg = MotionController.cfg(o.cfg);
        this.body = o.body || Humanoid.BODY1;            // растяжение тела (рост, ширина): шаг и IK масштабируются
        /** @type {((mm: MotionController, dt: number, ch: any) => void)[]} свои слои позы игры: зовутся в конце layers() */
        this.layerHooks = [];
        this.reset([0, 0, 0], 0);
    }

    // Числа контроллера: константы MOTION_* с дефолтами, поверх — over.
    static cfg(over) {
        const U = 'undefined', o = over || {};
        const pick = (k, v) => (o[k] != null ? o[k] : v);
        return {
            searchInterval: pick('searchInterval', typeof MOTION_SEARCH_INTERVAL !== U ? MOTION_SEARCH_INTERVAL : 0.1),
            blendHalflife: pick('blendHalflife', typeof MOTION_BLEND_HALFLIFE !== U ? MOTION_BLEND_HALFLIFE : 0.1),
            adjHalflife: pick('adjHalflife', typeof MOTION_ADJUST_HALFLIFE !== U ? MOTION_ADJUST_HALFLIFE : 0.1),
            adjRatio: pick('adjRatio', typeof MOTION_ADJUST_RATIO !== U ? MOTION_ADJUST_RATIO : 0.5),
            maxError: pick('maxError', typeof MOTION_MAX_ERROR !== U ? MOTION_MAX_ERROR : 15),
            footLock: pick('footLock', typeof MOTION_FOOT_LOCK !== U ? MOTION_FOOT_LOCK : 1),
            secondary: pick('secondary', typeof MOTION_SECONDARY !== U ? MOTION_SECONDARY : 1),
            lookAtCamera: pick('lookAtCamera', typeof MOTION_LOOK_AT_CAMERA !== U ? MOTION_LOOK_AT_CAMERA : 1),
        };
    }

    // Кадр «стойка» из базы — для сброса.
    idleFrame() {
        const t = this.db.takes.find(k => k.name === 'idle') || this.db.takes[0];
        return t.start + Math.floor((t.end - t.start) * 0.4);
    }

    reset(pos, yaw) {
        GM.copy(this.char.pos, pos);
        this.char.yaw = yaw;
        GM.set(this.char.vel, 0, 0, 0);
        this.mode = 'mm'; this.modeT = 0;
        this._lastPos = null;
        if (this.db.ready) {
            this.cur = this.idleFrame();
            this.db.samplePose(this.cur, this.base);
        }
        Humanoid.copyPose(this.blend, this.base); Humanoid.copyPose(this.prevBlend, this.base); Humanoid.copyPose(this.pose, this.base);
        this.offHips.fill(0); this.offRot.fill(0);
        for (const L of this.locks) { L.on = false; L.off.fill(0); }
        this.land.fill(0); this.sec.fill(0); this.pelvisDrop = 0;
        this.searchT = 0;
    }

    // ---- инерциализация ------------------------------------------------------------------------
    // Переход к позе dst со скоростями dstVel ({ hips: [3], rot: Float64Array(45) }).
    transition(dst, dstVel) {
        const inv = 1 / Math.max(1e-3, this.lastDt), q = this._q, q2 = this._q2, v = this._v, v2 = this._v2;
        for (let k = 0; k < 3; k++) {
            this.offHips[k * 2] = this.blend.hips[k] - dst.hips[k];
            this.offHips[k * 2 + 1] = (this.blend.hips[k] - this.prevBlend.hips[k]) * inv - (dstVel ? dstVel.hips[k] : 0);
        }
        for (let j = 0; j < 15; j++) {
            Humanoid.getLocal(this.blend, j, q); Humanoid.getLocal(dst, j, q2);
            GM.qmulinv(this._q3, q, q2); GM.qabs(this._q3, this._q3); GM.qlog(v, this._q3);
            Humanoid.getLocal(this.prevBlend, j, q2);
            GM.qangvel(v2, q, q2, this.lastDt);
            for (let a = 0; a < 3; a++) {
                this.offRot[(j * 3 + a) * 2] = v[a];
                this.offRot[(j * 3 + a) * 2 + 1] = v2[a] - (dstVel ? dstVel.rot[j * 3 + a] : 0);
            }
        }
        this.debug.transitions++;
    }

    // Скорости позы базы в кадре i (по соседнему кадру).
    dbVel(i, out) {
        const tk = this.db.takeOf(i), i1 = Math.min(tk.end - 1, i + 1), i0 = i1 - 1;
        const H = this.db.hips, Rr = this.db.rot, fps = this.db.FPS, a = this._q, b = this._q2, v = this._v;
        for (let k = 0; k < 3; k++) out.hips[k] = (H[i1 * 3 + k] - H[i0 * 3 + k]) * fps;
        for (let j = 0; j < 15; j++) {
            for (let k = 0; k < 4; k++) { a[k] = Rr[i0 * 60 + j * 4 + k]; b[k] = Rr[i1 * 60 + j * 4 + k]; }
            GM.qangvel(v, b, a, 1 / fps);
            out.rot[j * 3] = v[0]; out.rot[j * 3 + 1] = v[1]; out.rot[j * 3 + 2] = v[2];
        }
        return out;
    }

    // Источник + смещения -> blend; смещения затухают.
    compose(dt, halflife) {
        for (let k = 0; k < 3; k++) {
            GM.decay(this.offHips, k * 2, halflife, dt);
            this.blend.hips[k] = this.base.hips[k] + this.offHips[k * 2];
        }
        const v = this._v, q = this._q, q2 = this._q2;
        for (let j = 0; j < 15; j++) {
            for (let a = 0; a < 3; a++) { GM.decay(this.offRot, (j * 3 + a) * 2, halflife, dt); v[a] = this.offRot[(j * 3 + a) * 2]; }
            GM.qexp(q, v);
            Humanoid.getLocal(this.base, j, q2);
            GM.qmul(q, q, q2); GM.qnorm(q, q);
            Humanoid.setLocal(this.blend, j, q);
        }
    }

    // ---- запрос MM -------------------------------------------------------------------------------
    buildQuery(ch) {
        const db = this.db, F = db.F, q = this.q, i = Math.floor(this.cur);
        for (let d = 0; d < 15; d++) q[d] = db.feat[i * F + d];
        db.trajectoryQuery(ch, this.char.pos, this.char.yaw, 1 / this.body.leg, q);
        const dt = this.dbgTraj || (this.dbgTraj = new Float32Array(6));
        for (let d = 0; d < 6; d++) dt[d] = q[15 + d] * db.fScale[15 + d] + db.fOffset[15 + d];   // траектория в px базы (для отладки)
        return q;
    }

    // Поиск лучшего кадра. always — переход в любом случае (из полёта, подъёма): поза сейчас не из базы.
    search(ch, always) {
        const t0 = motionNow(), db = this.db;
        const q = this.buildQuery(ch);
        const i = Math.floor(this.cur);
        const curCost = db.valid[i] ? db.costAt(q, i) : Infinity;
        db.search(q, this.res, -1, -1);
        this.debug.searches++;
        this.debug.ms = motionNow() - t0;
        const best = this.res.index;
        if (best < 0) return;
        const near = best >= i && best - i < 12 && db.take[best] === db.take[i];
        if (always || (!near && this.res.cost < curCost - 0.01) || !db.valid[i]) {
            this.db.samplePose(best, this.tmp);
            this.transition(this.tmp, this.dbVel(best, this._dv));
            this.cur = best;
        }
        this.debug.cost = Math.min(curCost, this.res.cost);
        this.debug.index = Math.floor(this.cur);
        this.debug.take = db.takeOf(Math.floor(this.cur)).name;
    }

    // ---- процедурные позы ------------------------------------------------------------------------
    airPose(ch, out) {
        const D = GM.DEG, J = Humanoid.J;
        const up = GM.clamp(ch.vel[1] / 450, -1.2, 1);
        const rise = GM.smooth((up + 0.25) / 1.0), fall = 1 - rise;
        const hs = Math.hypot(ch.vel[0] - ch.groundVel[0], ch.vel[2] - ch.groundVel[2]);
        const run = GM.smooth((hs - 120) / 200);
        const long = GM.smooth((ch.airTime - 0.75) / 0.5);
        const t = this.modeT, fl = Math.sin(t * 13), fl2 = Math.sin(t * 11 + 1.3);
        out.hips[0] = 0; out.hips[1] = 70; out.hips[2] = 0;
        GM.qeuler(this._q, 0, (-6 * rise + 4 * fall - 6 * run * rise) * D, 0); Humanoid.setLocal(out, J.HIPS, this._q);
        GM.qeuler(this._q, 0, (-8 * rise - 2 * fall + 6 * long) * D, 0); Humanoid.setLocal(out, J.WAIST, this._q);
        GM.qeuler(this._q, 0, (6 * rise - 8 * fall) * D, 0); Humanoid.setLocal(out, J.NECK, this._q);
        for (let k = 0; k < 2; k++) {
            const side = k ? 1 : -1, lead = k !== this.takeoffLeg;
            // ноги: толчковая отстаёт, маховая поднята; к приземлению обе готовятся
            const hipR = lead ? GM.lerp(35, 62, run) : GM.lerp(35, -18, run);
            const kneeR = lead ? GM.lerp(-60, -88, run) : GM.lerp(-60, -38, run);
            const hipF = lead ? 24 : 6, kneeF = lead ? -32 : -26;
            const hip = GM.lerp(hipF, hipR, rise) + long * 10 * (lead ? fl : -fl);
            const knee = GM.lerp(kneeF, kneeR, rise) - long * 12 * Math.abs(lead ? fl2 : fl);
            GM.qeuler(this._q, 0, hip * D, side * -3 * D); Humanoid.setLocal(out, k ? J.HIPR : J.HIPL, this._q);
            GM.qeuler(this._q, 0, knee * D, 0); Humanoid.setLocal(out, k ? J.KNR : J.KNL, this._q);
            GM.qeuler(this._q, 0, (-18 * rise + 6 * fall) * D, 0); Humanoid.setLocal(out, k ? J.ANR : J.ANL, this._q);
            // руки: на взлёте вверх-вперёд (против ног), в падении — в стороны; долгое падение — вверх
            const armRun = lead ? -22 : 48;
            const pitchA = GM.lerp(GM.lerp(28, armRun, run), 22, fall);
            const pitch = GM.lerp(pitchA, 150 + 12 * (k ? fl : fl2), long);
            const roll = GM.lerp(GM.lerp(18, 10, run), 52, fall) * (1 - long * 0.6) + long * 12;
            GM.qeuler(this._q, 0, pitch * D, -side * roll * D); Humanoid.setLocal(out, k ? J.SHR : J.SHL, this._q);
            GM.qeuler(this._q, 0, GM.lerp(GM.lerp(25, 70, run), 32, fall) * (1 - long * 0.7) * D, 0); Humanoid.setLocal(out, k ? J.ELR : J.ELL, this._q);
            GM.qeuler(this._q, 0, 0, 0); Humanoid.setLocal(out, k ? J.WRR : J.WRL, this._q);
        }
        return out;
    }

    // Подъём после падения: сидя на корточках с упором руками -> стойка. Ноги — IK к стопам в системе корня.
    getupPose(t, out) {
        const D = GM.DEG, J = Humanoid.J, T = this.getup.T;
        const u = GM.clamp(t / T, 0, 1), s = GM.smoother(u), s2 = GM.smoother((u - 0.15) / 0.85);
        out.hips[0] = GM.lerp(-6, 0, s); out.hips[1] = GM.lerp(34, 72.8, s2); out.hips[2] = 0;
        GM.qeuler(this._q, 0, -GM.lerp(48, 0, s) * D, 0); Humanoid.setLocal(out, J.HIPS, this._q);
        GM.qeuler(this._q, 0, -GM.lerp(22, 2, s) * D, 0); Humanoid.setLocal(out, J.WAIST, this._q);
        GM.qeuler(this._q, 0, GM.lerp(42, 0, s) * D, 0); Humanoid.setLocal(out, J.NECK, this._q);
        for (let k = 0; k < 2; k++) {
            const side = k ? 1 : -1;
            const push = 1 - GM.smooth((u - 0.1) / 0.45);
            GM.qeuler(this._q, 0, GM.lerp(4, 68, push) * D, -side * GM.lerp(6, 14, push) * D); Humanoid.setLocal(out, k ? J.SHR : J.SHL, this._q);
            GM.qeuler(this._q, 0, GM.lerp(10, 18, push) * D, 0); Humanoid.setLocal(out, k ? J.ELR : J.ELL, this._q);
            GM.qeuler(this._q, 0, 0, 0); Humanoid.setLocal(out, k ? J.WRR : J.WRL, this._q);
        }
        // стопы: шаг вразножку -> вместе
        const sole = [0, 0, 0], fq = [0, 0, 0, 1], ank = [0, 0, 0];
        const B = this.body;
        Humanoid.fk(out, [0, 0, 0], [0, 0, 0, 1], this.world, B);
        for (let k = 0; k < 2; k++) {
            const side = k ? 1 : -1;
            sole[0] = GM.lerp(k ? -12 : 12, 0, GM.smooth((u - 0.55) / 0.4)) * B.leg; sole[1] = 0; sole[2] = side * 15 * B.wide;
            Humanoid.footFrame(sole, 0, 0, null, fq, ank, B);
            Humanoid.ikLeg(out, this.world, k, ank, [0, 0, 1], fq, B);
        }
        return out;
    }

    // ---- переходы режимов ------------------------------------------------------------------------
    enterAir(ch) {
        this.mode = 'air'; this.modeT = 0;
        // толчковая — та, что дольше на земле (последний контакт)
        const i = Math.floor(this.cur), c = this.db.contact;
        this.takeoffLeg = c[i * 2] && !c[i * 2 + 1] ? 0 : !c[i * 2] && c[i * 2 + 1] ? 1 : this.takeoffLeg ^ 1;
        this.airPose(ch, this.tmp);
        this.transition(this.tmp, null);
        for (const L of this.locks) this.unlock(L, null);
    }

    enterGround(ch, impact) {
        this.mode = 'mm'; this.modeT = 0;
        this.search(ch, true);
        // пружина просадки таза: чем сильнее удар, тем глубже
        this.land[1] += GM.clamp(impact * 0.62, 0, 720);
        this.searchT = this.cfg.searchInterval;
    }

    // Из рэгдолла: поза по мировым частям -> подъём. ragWorld — Ragdoll.world, yaw — курс подъёма (Ragdoll.getupInfo).
    enterGetup(ch, ragWorld, faceDown, yaw) {
        this.mode = 'getup'; this.modeT = 0;
        this.getup.faceDown = faceDown;
        this.char.yaw = yaw;
        const hp = Humanoid.getPos(ragWorld, Humanoid.J.HIPS, [0, 0, 0]);
        GM.set(this.char.pos, hp[0], ch.pos[1], hp[2]);
        // локальная поза рэгдолла = текущая (скорость ноль)
        const rq = GM.qheading(this._rootQ, yaw);
        GM.sub(this._v, hp, this.char.pos);
        GM.qinvrot(this.blend.hips, rq, this._v);
        this.blend.hips[0] /= this.body.hx; this.blend.hips[1] /= this.body.hy; this.blend.hips[2] /= this.body.hz;
        const w = ragWorld;
        for (let j = 0; j < 15; j++) Humanoid.storeLocal(this.blend, w, j, rq);
        Humanoid.copyPose(this.prevBlend, this.blend);
        this.getupPose(0, this.tmp);
        this.transition(this.tmp, null);
        for (const L of this.locks) { L.on = false; L.off.fill(0); }
        this.land.fill(0);
        this.pelvisDrop = 0;
    }

    unlock(L, target) {
        if (!L.on) return;
        L.on = false;
        if (target) { for (let a = 0; a < 3; a++) { L.off[a * 2] = L.pos[a] - target[a]; L.off[a * 2 + 1] = 0; } }
        else L.off.fill(0);
    }

    // ---- кадр ------------------------------------------------------------------------------------
    update(dt, ch) {
        if (!this.db.ready) return;
        dt = Math.max(1e-4, dt);
        this.footEvents.length = 0;
        if (ch.ragdoll) { this.mode = 'ragdoll'; this.debug.mode = 'ragdoll'; return; }
        this.modeT += dt;
        const c = this.cfg;
        // режимы
        if (this.mode === 'mm' && !ch.grounded && (ch.airTime > 0.07 || ch.jumpT < 0.15)) this.enterAir(ch);
        else if (this.mode === 'air' && ch.grounded) this.enterGround(ch, ch.impact);
        else if (this.mode === 'getup' && this.modeT >= this.getup.T) {
            this.mode = 'mm'; this.modeT = 0;
            this.cur = this.idleFrame();
            this.search(ch, true);
        } else if (this.mode === 'ragdoll') {
            this.mode = 'mm';
        }
        this.debug.mode = this.mode;

        let halflife = c.blendHalflife;
        const rootQ = this._rootQ;
        if (this.mode === 'mm') {
            // поиск: по таймеру, при резкой смене ввода, у конца дубля
            const d = ch.desired, ld = this.lastDesired;
            const m0 = Math.hypot(ld[0], ld[1]), m1 = Math.hypot(d[0], d[1]);
            let changed = Math.abs(m1 - m0) > 0.25 * this.db.cfg.sprint;
            if (!changed && m0 > 20 && m1 > 20) changed = Math.abs(GM.wrap(Math.atan2(d[1], d[0]) - Math.atan2(ld[1], ld[0]))) > 30 * GM.DEG;
            const i = Math.floor(this.cur), tk = this.db.takeOf(i);
            const nearEnd = i + 2 >= tk.end - 1 || !this.db.valid[i];
            this.searchT -= dt;
            if (this.searchT <= 0 || changed || nearEnd) {
                this.search(ch, false);
                this.searchT = c.searchInterval;
                ld[0] = d[0]; ld[1] = d[1];
            }
            // проигрывание с лёгкой подгонкой темпа под скорость физики
            const i2 = Math.floor(this.cur), tk2 = this.db.takeOf(i2);
            const animSp = this.db.speed[i2], simSp = Math.hypot(ch.vel[0] - ch.groundVel[0], ch.vel[2] - ch.groundVel[2]);
            const rate = animSp > 60 && simSp > 60 ? GM.clamp(simSp / animSp, 0.9, 1.1) : 1;
            const r0 = this.db.sampleRoot(this.cur, this._r0);
            const next = Math.min(tk2.end - 1.001, this.cur + dt * this.db.FPS * rate);
            const r1 = this.db.sampleRoot(next, this._r1);
            this.cur = next;
            // root motion: смещение в системе корня базы -> в мир персонажа
            const cs0 = Math.cos(r0.yaw), sn0 = Math.sin(r0.yaw), dx = r1.x - r0.x, dz = r1.z - r0.z;
            const lx = dx * cs0 + dz * sn0, lz = -dx * sn0 + dz * cs0;
            const cy = Math.cos(this.char.yaw), sy = Math.sin(this.char.yaw);
            const L = this.body.leg, mx = (lx * cy - lz * sy) * L, mz = (lx * sy + lz * cy) * L;
            this.char.pos[0] += mx; this.char.pos[2] += mz;
            const dyaw = GM.wrap(r1.yaw - r0.yaw);
            this.char.yaw = GM.wrap(this.char.yaw + dyaw + ch.groundSpin * dt);
            this.char.pos[0] += ch.groundVel[0] * dt; this.char.pos[2] += ch.groundVel[2] * dt;
            // подстройка к физике (Holden: adjustment by velocity + clamping)
            const ex = ch.pos[0] - this.char.pos[0], ez = ch.pos[2] - this.char.pos[2];
            const k = GM.damperK(c.adjHalflife, dt);
            let ax = ex * k, az = ez * k;
            const lim = c.adjRatio * Math.hypot(mx, mz) + 0.02 * dt * 60;
            const al = Math.hypot(ax, az);
            if (al > lim) { ax *= lim / al; az *= lim / al; }
            this.char.pos[0] += ax; this.char.pos[2] += az;
            const eyaw = GM.wrap(ch.facing.x - this.char.yaw);
            let ay = eyaw * GM.damperK(c.adjHalflife * 2, dt);
            const liml = 2.0 * Math.abs(dyaw) + 0.008 * dt * 60;
            ay = GM.clamp(ay, -liml, liml);
            this.char.yaw = GM.wrap(this.char.yaw + ay);
            this.clampToSim(ch, c.maxError * this.body.leg, 70 * GM.DEG);
            this.db.samplePose(this.cur, this.base);
        } else if (this.mode === 'air') {
            this.airPose(ch, this.base);
            halflife = 0.12;
            const k = GM.damperK(0.05, dt);
            this.char.pos[0] += (ch.pos[0] - this.char.pos[0]) * k + ch.vel[0] * dt * (1 - k);
            this.char.pos[2] += (ch.pos[2] - this.char.pos[2]) * k + ch.vel[2] * dt * (1 - k);
            this.char.yaw = GM.wrap(this.char.yaw + GM.wrap(ch.facing.x - this.char.yaw) * GM.damperK(0.08, dt));
            this.clampToSim(ch, c.maxError, 70 * GM.DEG);
        } else if (this.mode === 'getup') {
            this.getupPose(this.modeT, this.base);
            halflife = 0.22;
            const k = GM.damperK(0.25, dt);
            this.char.pos[0] += (ch.pos[0] - this.char.pos[0]) * k;
            this.char.pos[2] += (ch.pos[2] - this.char.pos[2]) * k;
        }
        // высота корня — за физикой (капсула «парит» на пружине над землёй)
        const yk = GM.damperK(this.mode === 'air' ? 0.01 : 0.04, dt);
        this.char.pos[1] += (ch.pos[1] - this.char.pos[1]) * yk;
        if (Math.abs(ch.pos[1] - this.char.pos[1]) > 40) this.char.pos[1] = ch.pos[1] + Math.sign(this.char.pos[1] - ch.pos[1]) * 40;

        // инерциализация
        Humanoid.copyPose(this.prevBlend, this.blend);
        this.compose(dt, halflife);
        Humanoid.copyPose(this.pose, this.blend);
        this.lastDt = dt;

        // скорость и ускорение анимационного корня (для вторичной физики)
        const cv = this.char.vel;
        const lp = this._lastPos || (this._lastPos = [this.char.pos[0], this.char.pos[1], this.char.pos[2]]);
        const vx = (this.char.pos[0] - lp[0]) / dt;
        const vy = ch.vel[1];
        const vz = (this.char.pos[2] - lp[2]) / dt;
        GM.copy(lp, this.char.pos);
        const ax = (vx - cv[0]) / dt, ayv = (vy - cv[1]) / dt, az = (vz - cv[2]) / dt;
        GM.set(cv, vx, vy, vz);
        const kf = GM.damperK(0.03, dt), ks = GM.damperK(0.35, dt);
        this.aFast[0] += (ax - this.aFast[0]) * kf; this.aFast[1] += (ayv - this.aFast[1]) * kf; this.aFast[2] += (az - this.aFast[2]) * kf;
        for (let k = 0; k < 3; k++) this.aSlow[k] += (this.aFast[k] - this.aSlow[k]) * ks;

        this.layers(dt, ch);
        // мир, ноги
        GM.qheading(rootQ, this.char.yaw);
        Humanoid.fk(this.pose, this.char.pos, rootQ, this.world, this.body);
        if (this.mode !== 'air') this.feet(dt, ch, rootQ);
        if (this.model && this.model.apply) this.model.apply(this.world, this.body);
    }

    clampToSim(ch, maxErr, maxAng) {
        const ex = this.char.pos[0] - ch.pos[0], ez = this.char.pos[2] - ch.pos[2], e = Math.hypot(ex, ez);
        if (e > maxErr) { this.char.pos[0] = ch.pos[0] + ex / e * maxErr; this.char.pos[2] = ch.pos[2] + ez / e * maxErr; }
        const ey = GM.wrap(this.char.yaw - ch.facing.x);
        if (Math.abs(ey) > maxAng) this.char.yaw = GM.wrap(ch.facing.x + Math.sign(ey) * maxAng);
    }

    // Добавить к локальному повороту сустава j поворот (yaw, pitch, roll — GM.qeuler) поверх позы кадра.
    // Для своих слоёв игры (layerHooks): стойка бойца, удар, взмах.
    addLocal(j, yaw, pitch, roll) {
        if (!yaw && !pitch && !roll) return;
        const P = this.pose, q = this._q, q2 = this._q2;
        GM.qeuler(q, yaw, pitch, roll);
        Humanoid.getLocal(P, j, q2);
        GM.qmul(q2, q2, q);
        Humanoid.setLocal(P, j, q2);
    }

    // Подмешать к локальному повороту сустава j целевой поворот q с весом w (0..1): slerp.
    blendLocal(j, qTarget, w) {
        const P = this.pose, q2 = this._q2;
        Humanoid.getLocal(P, j, q2);
        GM.qslerp(q2, q2, qTarget, w);
        Humanoid.setLocal(P, j, q2);
    }

    // ---- слои ------------------------------------------------------------------------------------
    layers(dt, ch) {
        const D = GM.DEG, J = Humanoid.J, P = this.pose, q = this._q, q2 = this._q2;
        const add = (j, yaw, pitch, roll) => this.addLocal(j, yaw, pitch, roll);
        // приземление: таз проседает и пружинит, корпус клонится, руки сгибаются
        GM.springTo(this.land, 0, 0, 3.0, 0.5, dt);
        const drop = GM.clamp(this.land[0], -6, 34);
        if (Math.abs(drop) > 0.01) {
            P.hips[1] -= drop;
            add(J.WAIST, 0, -drop * 0.7 * D, 0);
            add(J.NECK, 0, drop * 0.45 * D, 0);
            for (const j of [J.SHL, J.SHR]) add(j, 0, drop * 0.5 * D, 0);
            for (const j of [J.ELL, J.ELR]) add(j, 0, drop * 1.1 * D, 0);
        }
        // толкание: руки вперёд, корпус в наклон
        const pk = GM.damperK(0.12, dt);
        this.pushW += ((ch.pushW || 0) - this.pushW) * pk;
        if (this.pushW > 0.01) {
            const w = this.pushW;
            GM.qeuler(q, 0, -14 * D, 0); Humanoid.getLocal(P, J.WAIST, q2); GM.qslerp(q2, q2, GM.qmul(this._q3, q2, q), w); Humanoid.setLocal(P, J.WAIST, q2);
            for (let k = 0; k < 2; k++) {
                const side = k ? 1 : -1;
                GM.qeuler(q, 0, 78 * D, -side * 9 * D); Humanoid.getLocal(P, k ? J.SHR : J.SHL, q2); GM.qslerp(q2, q2, q, w); Humanoid.setLocal(P, k ? J.SHR : J.SHL, q2);
                GM.qeuler(q, 0, 32 * D, 0); Humanoid.getLocal(P, k ? J.ELR : J.ELL, q2); GM.qslerp(q2, q2, q, w); Humanoid.setLocal(P, k ? J.ELR : J.ELL, q2);
            }
        }
        // вторичная физика: пружины по рывкам ускорения (в системе персонажа)
        if (this.cfg.secondary) {
            const cy = Math.cos(this.char.yaw), sy = Math.sin(this.char.yaw);
            const ax = this.aFast[0] - this.aSlow[0], az = this.aFast[2] - this.aSlow[2], ayv = this.aFast[1] - this.aSlow[1];
            const af = ax * cy + az * sy, al = -ax * sy + az * cy;
            const S = this.sec, g = 1 / 1200;
            GM.springTo(S, 0, GM.clamp(af * g * 0.10, -0.25, 0.25), 2.6, 0.42, dt);   // корпус вперёд-назад
            GM.springTo(S, 2, GM.clamp(al * g * 0.08, -0.2, 0.2), 2.4, 0.42, dt);     // корпус вбок
            GM.springTo(S, 4, GM.clamp(-af * g * 0.16 + ayv * g * 0.05, -0.35, 0.35), 3.2, 0.32, dt);  // голова
            GM.springTo(S, 6, GM.clamp(al * g * 0.12, -0.3, 0.3), 3.0, 0.32, dt);
            GM.springTo(S, 8, GM.clamp(-af * g * 0.35, -0.6, 0.6), 2.2, 0.28, dt);    // руки
            GM.springTo(S, 10, GM.clamp(al * g * 0.3 - ayv * g * 0.12, -0.6, 0.6), 2.0, 0.3, dt);
            add(J.WAIST, 0, -S[0], S[2]);
            add(J.NECK, 0, S[4], -S[6]);
            add(J.SHL, 0, S[8], S[10] > 0 ? 0 : -S[10] * 0.9);
            add(J.SHR, 0, S[8], S[10] < 0 ? 0 : -S[10] * 0.9);
            add(J.ELL, 0, Math.abs(S[8]) * 0.5, 0); add(J.ELR, 0, Math.abs(S[8]) * 0.5, 0);
        }
        // голова за камерой: на месте и шагом сильнее, на бегу слабее
        if (this.cfg.lookAtCamera && ch.camYaw != null) {
            const sp = Math.hypot(this.char.vel[0], this.char.vel[2]);
            const w = (1 - GM.smooth((sp - 120) / 250)) * (this.mode === 'mm' ? 1 : 0.3) * (1 - this.pushW);
            let dy = GM.wrap(ch.camYaw - this.char.yaw);
            if (Math.abs(dy) > 120 * D) dy = 0;   // камера смотрит в лицо — голову не выворачиваем
            const ty = -GM.clamp(dy, -65 * D, 65 * D) * 0.75 * w, tp = GM.clamp(-ch.camPitch, -25 * D, 30 * D) * 0.6 * w;
            const k = GM.damperK(0.12, dt);
            this.look.yaw += (ty - this.look.yaw) * k; this.look.pitch += (tp - this.look.pitch) * k;
            add(J.NECK, this.look.yaw * 0.75, this.look.pitch, 0);
            add(J.WAIST, this.look.yaw * 0.25, 0, 0);
        }
        // свои слои игры
        for (let i = 0; i < this.layerHooks.length; i++) this.layerHooks[i](this, dt, ch);
    }

    // ---- стопы ---------------------------------------------------------------------------------
    feet(dt, ch, rootQ) {
        const J = Humanoid.J, w = this.world, P = this.pose;
        const i = Math.floor(this.cur), db = this.db;
        const tg = [this._ft0, this._ft1];
        const fq = [this._fq0, this._fq1];
        const nrm = [null, null], need = [0, 0], cont = [0, 0];
        const rootY = this.char.pos[1];
        for (let k = 0; k < 2; k++) {
            const ja = k ? J.ANR : J.ANL;
            Humanoid.getPos(w, ja, tg[k]); Humanoid.getRot(w, ja, fq[k]);
            let contact = this.mode === 'getup' ? 1 : (this.mode === 'mm' ? db.contact[i * 2 + k] : 0);
            if (!ch.grounded) contact = 0;
            cont[k] = contact;
            const hit = ch.ground(tg[k][0], tg[k][2], rootY + 60 * this.body.leg);
            if (hit && ch.grounded) {
                const dy = GM.clamp(hit.y - rootY, -45 * this.body.leg, 50 * this.body.leg);
                tg[k][1] += dy;
                nrm[k] = hit.n;
                const minY = hit.y + this.body.footAnkle[1] * 0.9;   // голеностоп не ниже подошвы на земле
                if (tg[k][1] < minY) tg[k][1] = minY;
            }
            const L = this.locks[k];
            if (this.cfg.footLock && contact && hit && !hit.moving) {
                if (!L.on) {
                    L.on = true;
                    for (let a = 0; a < 3; a++) L.pos[a] = tg[k][a] + L.off[a * 2];
                    L.off.fill(0);
                    if (this.mode === 'mm' && !this._prevContact[k]) this.footEvents.push({ side: k, x: L.pos[0], y: L.pos[1], z: L.pos[2], speed: db.speed[i] });
                } else if (GM.dist(L.pos, tg[k]) > 24 * this.body.leg) this.unlock(L, tg[k]);
                if (L.on) { L.pos[1] = tg[k][1] > L.pos[1] ? L.pos[1] + (tg[k][1] - L.pos[1]) * GM.damperK(0.05, dt) : tg[k][1]; GM.copy(tg[k], L.pos); }
            } else {
                if (L.on) this.unlock(L, tg[k]);
                if (contact && !this._prevContact[k] && this.mode === 'mm' && hit) this.footEvents.push({ side: k, x: tg[k][0], y: tg[k][1], z: tg[k][2], speed: db.speed[i] });
            }
            if (!L.on) {
                for (let a = 0; a < 3; a++) { GM.decay(L.off, a * 2, 0.07, dt); tg[k][a] += L.off[a * 2]; }
            }
            this._prevContact[k] = contact;
            // досягаемость: насколько опустить таз
            const hp = Humanoid.getPos(w, k ? J.HIPR : J.HIPL, this._v);
            const dh = Math.hypot(hp[0] - tg[k][0], hp[2] - tg[k][2]), LM = this.body.thigh + this.body.shin - 1.5;
            const maxY = tg[k][1] + Math.sqrt(Math.max(0, LM * LM - dh * dh));
            need[k] = Math.max(0, hp[1] - maxY) * (contact ? 1 : 0.6);
        }
        const want = Math.min(40 * this.body.leg, Math.max(need[0], need[1]));
        this.pelvisDrop += (want - this.pelvisDrop) * GM.damperK(want > this.pelvisDrop ? 0.03 : 0.09, dt);
        if (this.pelvisDrop > 0.05) {
            P.hips[1] -= this.pelvisDrop / this.body.hy;
            Humanoid.fk(P, this.char.pos, rootQ, w, this.body);
        }
        // IK и поворот стоп по земле
        const up = [0, 1, 0], hq = Humanoid.getRot(w, J.HIPS, this._q);
        for (let k = 0; k < 2; k++) {
            let footQ = fq[k];
            if (nrm[k] && cont[k]) {
                const tilt = GM.qbetween(this._q3, up, nrm[k]);
                footQ = GM.qmul(this._q2, tilt, fq[k]);
            }
            const axis = Humanoid.kneeAxis(this._v2, fq[k], hq);
            Humanoid.ikLeg(P, w, k, tg[k], axis, footQ, this.body);
        }
    }
}
