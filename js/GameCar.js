// GameCar.js — физика машины: «лучевая» машина на четырёх колёсах с подвеской (raycast vehicle, перенесена из
// Obby Car Master и расширена). Тело — твёрдое тело с полным поворотом (кватернион) и угловой скоростью: крен,
// тангаж и рысканье получаются сами из сил подвески и шин. Каждое колесо ищет опору лучом вдоль «низа» машины
// (ObbyCourse.ray), пружина-демпфер давит по нормали опоры, стабилизаторы гасят крен. Шины — импульсы в пятне
// контакта: продольная сила (газ, тормоз, накат, удержание) и боковая (гасит занос), обе в круге трения μ·N.
// Ручник (Пробел) отпускает задние колёса в занос; нитро (Shift) — запас в баке, быстрее разгон и выше предел.
// В полёте — управление: W/S — тангаж (сальто), A/D — рысканье; без ввода машина мягко выравнивается.
// Детали трассы с параметром stick=1 (петли, «трубы») держат машину: сила тяжести вдоль нормали опоры.
// Размеры у каждой машины свои (колёсная база, колея, радиус колеса, габарит — из метаданных модели
// CAR_MODELS и данных гаража GAME_CARS), числа управляемости — константы CAR_* × множители машины.
// Состояние — в координатах Babylon (x, y вверх, z), px.
// Кузов — мягкое тело SoftBody (js/SoftBody.js): при касании сетка узлов просыпается и сама считает столкновение,
// твёрдое тело тогда читает позу из узлов (pull) и отдаёт им шины и подвеску (push). CarWorld шагает все машины вместе.

/** Поворот вектора (x, y, z) кватернионом q = [x, y, z, w] (v' = q v q*). */
function carRot(q, x, y, z, out) {
    const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
    out[0] = x + qw * tx + (qy * tz - qz * ty);
    out[1] = y + qw * ty + (qz * tx - qx * tz);
    out[2] = z + qw * tz + (qx * ty - qy * tx);
    return out;
}

/** Луч колеса: детали трассы и земля мира, что ближе. → { t, n, col } | null (n — только на чтение до следующего луча). */
function carRay(ox, oy, oz, dx, dy, dz, maxT) {
    const a = ObbyCourse.ray(ox, oy, oz, dx, dy, dz, maxT);
    if (typeof GameWorld !== 'undefined' && GameWorld.active) {
        const g = GameWorld.ray(ox, oy, oz, dx, dy, dz, a ? a.t : maxT);
        if (g && (!a || g.t < a.t)) { const r = carRay._g; r.t = g.t; r.n = g.n; r.col = carRay._groundCol; return r; }
    }
    return a;
}
carRay._g = { t: 0, n: [0, 1, 0], col: null };
/** @type {any} */ carRay._groundCol = { ground: true };

/**
 * Размеры и управляемость машины id (px и множители) из CAR_MODELS (Blender, метры) и GAME_CARS (гараж).
 * Нет модели — размеры обычной легковушки: физика работает и без файлов (тесты, симулятор трасс).
 */
function carSpec(id) {
    /** @type {any} */
    const m = (typeof CAR_MODELS !== 'undefined' && CAR_MODELS && CAR_MODELS[id]) || {};
    /** @type {any} */
    const g = (typeof GAME_CARS !== 'undefined' && GAME_CARS.find(c => c.id === id)) || {};
    const st = g.stats || {};
    const R = (Number(m.wheelRadius) || 0.36) * 100;
    const L = (Number(m.length) || 4.5) * 100, W = (Number(m.width) || 1.95) * 100, H = (Number(m.height) || 1.4) * 100;
    const ax = (Number(m.axleX) || g.axleX || 1.35) * 100, tr = (Number(m.trackY) || g.trackY || 0.8) * 100;
    const k = Number(st.inertia) || 1;
    // сферы кузова: торцы приподняты (угол въезда ~30°), середина по длине, крыша
    const rEnd = Math.max(34, Math.min(62, W * 0.21)), rMid = Math.max(40, Math.min(70, W * 0.25)), rTop = Math.max(36, Math.min(60, W * 0.22));
    const xEnd = L / 2 - rEnd, zEnd = Math.max(20, W / 2 - rEnd * 1.05), zMid = Math.max(16, W / 2 - rMid * 1.05);
    const yEnd = R * 0.9 + rEnd, yMid = R * 0.65 + rMid, yTop = Math.max(yMid + 10, H - rTop);
    const spheres = [];
    for (const s of [-1, 1]) {
        spheres.push([-xEnd, yEnd, s * zEnd, rEnd], [xEnd, yEnd, s * zEnd, rEnd]);
        const nMid = Math.max(2, Math.round((xEnd * 2) / 240));
        for (let i = 0; i < nMid; i++) spheres.push([-xEnd * 0.62 + (xEnd * 1.24) * i / (nMid - 1), yMid, s * zMid, rMid]);
    }
    const nTop = Math.max(2, Math.round(L / 300));
    for (let i = 0; i < nTop; i++) spheres.push([-L * 0.22 + L * 0.36 * i / Math.max(1, nTop - 1), yTop, 0, rTop]);
    const susp = Number(st.susp) || 1;
    return {
        id, R, L, W, H, halfBase: ax, halfTrack: tr, inertiaK: k,
        comH: R + H * 0.12,
        suspRest: 30 * susp, sagK: susp, travelK: susp,
        iRoll: (W * W + H * H) / 12 * 1.9 * k, iYaw: (L * L + W * W) / 12 * 1.3 * k, iPitch: (L * L + H * H) / 12 * 1.3 * k,
        spheres,
        vmax: Number(st.speed) || 1, accel: Number(st.accel) || 1, grip: Number(st.grip) || 1, air: Number(st.air) || 1,
        nitro: Number(st.nitro) || 1, downforce: Number(st.downforce) || 1,
    };
}

/** Новая машина со своим состоянием (игрок и боты едут на одной физике). spec — carSpec(id). */
function createCar(spec) {
    const S = spec || carSpec('');
    const wheel = (fx, sz, front) => ({
        fx, sz, front, contact: false, comp: 0, prevComp: 0, susp: S.suspRest, load: 0,
        n: [0, 1, 0], /** @type {any} */ col: null, q: [0, 0, 0], spin: 0, rate: 0, slip: 0, gy: 0,
        lost: false, flat: false, bx: 0, by: 0, bz: 0, toe: 0, camber: 0, mu: 1, surfT: 0, rough: 0, surf: 'asphalt', drag: 0,
    });
    return {
    spec: S,
    // p — начало модели (земля посередине между осями в покое), c — центр масс; q — поворот, w — угловая скорость (мир)
    p: [0, 0, 0], c: [0, 0, 0], v: [0, 0, 0], q: [0, 0, 0, 1], w: [0, 0, 0],
    f: [1, 0, 0], u: [0, 1, 0], r: [0, 0, 1],
    yaw: 0, pitch: 0, roll: 0, steer: 0, vf: 0, rpm: 0, gear: 1, throttle: 0, braking: false, handbrake: false,
    wheels: [wheel(-S.halfBase, -S.halfTrack, false), wheel(-S.halfBase, S.halfTrack, false),
        wheel(S.halfBase, -S.halfTrack, true), wheel(S.halfBase, S.halfTrack, true)],   // RL, RR, FL, FR
    contacts: 0, grounded: false, airTime: 0, groundTime: 0, jumpLock: 0,
    lastGroundY: 0, landSpeed: 0, slip: 0, flipT: 0, sideT: 0, stuckT: 0, bodyTouch: false,
    nitro: 1, nitroOn: false, airArm: false, padBoost: 0, stun: 0, hitCool: 0, bonkCool: 0, climbCool: 0, visLift: 0,
    stickT: 0, stickN: [0, 1, 0], crashT: 0, powerK: 1, strandedT: 0,
    /** @type {SoftBody | null} */ soft: null, /** @type {any} */ damage: null, /** @type {any} */ _pend: null, _hz: 240, /** @type {any} */ _step: null, _div: 1, _wasGr: false,
    _v0: [0, 0, 0], _w0: [0, 0, 0], _c0: [0, 0, 0],
    ice: false, dead: false, deadReason: '', frozen: false, isBot: false,
    /** @type {number[] | null} */ _lastN: null,
    _a: [0, 0, 0], _b: [0, 0, 0],
    /** @type {Record<string, (...a: any[]) => void>} */
    on: {},

    cfg() {
        const U = 'undefined', s = this.spec;
        return {
            g: typeof CAR_GRAVITY !== U ? CAR_GRAVITY : 3200,
            vmax: (typeof CAR_MAX_SPEED !== U ? CAR_MAX_SPEED : 2600) * s.vmax,
            accel: (typeof CAR_ACCEL !== U ? CAR_ACCEL : 1900) * s.accel,
            brake: typeof CAR_BRAKE !== U ? CAR_BRAKE : 4200,
            rev: typeof CAR_REVERSE_SPEED !== U ? CAR_REVERSE_SPEED : 700,
            coast: typeof CAR_COAST_DECEL !== U ? CAR_COAST_DECEL : 280,
            drag: typeof CAR_AIR_DRAG !== U ? CAR_AIR_DRAG : 0.1,
            steerLow: (typeof CAR_STEER_LOW_DEG !== U ? CAR_STEER_LOW_DEG : 34) * Math.PI / 180,
            steerHigh: (typeof CAR_STEER_HIGH_DEG !== U ? CAR_STEER_HIGH_DEG : 8) * Math.PI / 180,
            steerResp: typeof CAR_STEER_RESPONSE !== U ? CAR_STEER_RESPONSE : 8,
            mu: (typeof CAR_GRIP !== U ? CAR_GRIP : 1.55) * s.grip,
            iceMu: typeof CAR_ICE_GRIP !== U ? CAR_ICE_GRIP : 0.22,
            latStiff: typeof CAR_LATERAL_STIFF !== U ? CAR_LATERAL_STIFF : 0.85,
            handbrake: typeof CAR_HANDBRAKE_GRIP !== U ? CAR_HANDBRAKE_GRIP : 0.28,
            downforce: (typeof CAR_DOWNFORCE !== U ? CAR_DOWNFORCE : 0.00012) * s.downforce,
            sag: (typeof CAR_SUSP_SAG !== U ? CAR_SUSP_SAG : 11) * s.sagK,
            damp: typeof CAR_SUSP_DAMP !== U ? CAR_SUSP_DAMP : 0.55,
            travel: (typeof CAR_SUSP_TRAVEL !== U ? CAR_SUSP_TRAVEL : 22) * s.travelK,
            droop: (typeof CAR_SUSP_DROOP !== U ? CAR_SUSP_DROOP : 14) * s.travelK,
            antiroll: typeof CAR_ANTIROLL !== U ? CAR_ANTIROLL : 0.6,
            step: typeof CAR_STEP_UP !== U ? CAR_STEP_UP : 30,
            climbMax: typeof CAR_CLIMB_MAX !== U ? CAR_CLIMB_MAX : 80,
            airYaw: (typeof CAR_AIR_YAW !== U ? CAR_AIR_YAW : 2.4) * s.air,
            airPitch: (typeof CAR_AIR_PITCH !== U ? CAR_AIR_PITCH : 2.6) * s.air,
            airLevel: typeof CAR_AIR_LEVEL !== U ? CAR_AIR_LEVEL : 3,
            airTilt: typeof CAR_AIR_TILT !== U ? CAR_AIR_TILT : 0.1,
            takeoffKeep: typeof CAR_TAKEOFF_SPIN_KEEP !== U ? CAR_TAKEOFF_SPIN_KEEP : 0.15,
            upright: typeof CAR_UPRIGHT !== U ? CAR_UPRIGHT : 9,
            nitroSpeed: typeof NITRO_SPEED_K !== U ? NITRO_SPEED_K : 1.3,
            nitroAccel: (typeof NITRO_ACCEL_K !== U ? NITRO_ACCEL_K : 1.6) * s.nitro,
            nitroUse: typeof NITRO_USE_SEC !== U ? NITRO_USE_SEC : 3,
            nitroFill: typeof NITRO_REFILL_SEC !== U ? NITRO_REFILL_SEC : 9,
            stickG: typeof CAR_STICK_GRAVITY !== U ? CAR_STICK_GRAVITY : 1.25,
            overDrag: typeof CAR_OVERSPEED_DRAG !== U ? CAR_OVERSPEED_DRAG : 1.1,
            fallDepth: typeof CAR_FALL_DEPTH !== U ? CAR_FALL_DEPTH : 900,
            knock: typeof CAR_KNOCKBACK !== U ? CAR_KNOCKBACK : 1300,
        };
    },

    /** Поставить машину на точку (x, h, z) с курсом yaw (рад, курс карты) — старт и чекпоинт. */
    reset(x, h, z, yaw) {
        this.yaw = yaw || 0;
        const half = -this.yaw / 2;
        this.q = [0, Math.sin(half), 0, Math.cos(half)];
        this._axes();
        const S = this.spec;
        this.p = [x, h + 1, z];
        this.c = [x, h + 1 + S.comH, z];
        this.v = [0, 0, 0]; this.w = [0, 0, 0];
        this.pitch = 0; this.roll = 0; this.steer = 0; this.vf = 0; this.rpm = 0; this.gear = 1; this.throttle = 0; this.braking = false; this.handbrake = false;
        const c = this.cfg();
        for (const w of this.wheels) { w.contact = false; w.comp = w.prevComp = c.sag; w.susp = S.suspRest; w.load = 0; w.col = null; w.rate = 0; w.slip = 0; w.gy = h; w.lost = false; w.flat = false; w.bx = w.by = w.bz = 0; w.toe = 0; w.camber = 0; w.mu = 1; w.rough = 0; }
        this.crashT = 0; this.powerK = 1; this.strandedT = 0;
        if (this.soft) this.soft.resetShape();
        if (this.damage) this.damage.reset();
        this.contacts = 0; this.grounded = false; this.airTime = 0; this.groundTime = 0; this.jumpLock = 0;
        this.lastGroundY = h; this.stun = 0; this.hitCool = 0; this.padBoost = 0; this.dead = false; this.deadReason = ''; this.ice = false;
        this.slip = 0; this.flipT = 0; this.sideT = 0; this.stuckT = 0; this.visLift = 0; this.bodyTouch = false; this._lastN = null;
        this.stickT = 0; this.stickN = [0, 1, 0]; this.nitroOn = false; this.nitro = 1;
    },

    _axes() {
        carRot(this.q, 1, 0, 0, this.f);
        carRot(this.q, 0, 1, 0, this.u);
        carRot(this.q, 0, 0, 1, this.r);
    },

    /** Точка машины (вперёд, вверх над землёй в покое, вправо) -> мир. */
    point(fx, uy, rz, out) {
        const f = this.f, u = this.u, r = this.r, C = this.c, uu = uy - this.spec.comH;
        out = out || [0, 0, 0];
        out[0] = C[0] + f[0] * fx + u[0] * uu + r[0] * rz;
        out[1] = C[1] + f[1] * fx + u[1] * uu + r[1] * rz;
        out[2] = C[2] + f[2] * fx + u[2] * uu + r[2] * rz;
        return out;
    },

    // Обратный момент инерции в мировых осях, применённый к вектору t (результат — в out).
    _iinv(tx, ty, tz, out) {
        const f = this.f, u = this.u, r = this.r, S = this.spec;
        const a = (tx * f[0] + ty * f[1] + tz * f[2]) / S.iRoll;
        const b = (tx * u[0] + ty * u[1] + tz * u[2]) / S.iYaw;
        const d = (tx * r[0] + ty * r[1] + tz * r[2]) / S.iPitch;
        out[0] = f[0] * a + u[0] * b + r[0] * d;
        out[1] = f[1] * a + u[1] * b + r[1] * d;
        out[2] = f[2] * a + u[2] * b + r[2] * d;
        return out;
    },

    /** Импульс J (на единицу массы) в точке P мира: меняет скорость и вращение. */
    _impulse(P, jx, jy, jz) {
        const C = this.c, rx = P[0] - C[0], ry = P[1] - C[1], rz = P[2] - C[2];
        this.v[0] += jx; this.v[1] += jy; this.v[2] += jz;
        const t = this._iinv(ry * jz - rz * jy, rz * jx - rx * jz, rx * jy - ry * jx, this._a);
        this.w[0] += t[0]; this.w[1] += t[1]; this.w[2] += t[2];
    },

    /** Скорость точки P мира (поступательная + вращение). */
    _velAt(P, out) {
        const C = this.c, w = this.w, rx = P[0] - C[0], ry = P[1] - C[1], rz = P[2] - C[2];
        out[0] = this.v[0] + w[1] * rz - w[2] * ry;
        out[1] = this.v[1] + w[2] * rx - w[0] * rz;
        out[2] = this.v[2] + w[0] * ry - w[1] * rx;
        return out;
    },

    /** Обратная «эффективная масса» точки P вдоль единичного направления d. */
    _invMass(P, dx, dy, dz) {
        const C = this.c, rx = P[0] - C[0], ry = P[1] - C[1], rz = P[2] - C[2];
        const cx = ry * dz - rz * dy, cy = rz * dx - rx * dz, cz = rx * dy - ry * dx;
        const t = this._iinv(cx, cy, cz, this._b);
        return 1 + cx * t[0] + cy * t[1] + cz * t[2];
    },

    /** Ввод: { throttle -1..1, steer -1..1, handbrake, nitro }; hz — частота подшагов физики. */
    step(dt, input, hz) {
        if (typeof CarWorld !== 'undefined' && CarWorld.active && CarWorld.has(this)) { this._pend = input || {}; this._hz = hz || 240; return; }
        if (dt < 1e-5) return;
        const b = this._begin(dt, input || {});
        if (!b) return;
        const n = Math.min(this.soft && this.soft.awake ? 20 : 8, Math.max(1, Math.ceil(dt * (hz || 240))));
        const h = dt / n;
        for (let i = 0; i < n; i++) { this._sub(h, b.c, b.thr, b.str); if (this.dead) return; }
        this._end(dt, b.thr);
    },

    // Начало шага: таймеры, ввод, бак нитро. null — машина не считается (стоит на подиуме или падает мимо мира).
    _begin(dt, input) {
        if (this.frozen) return null;
        if (this.dead) { if (this.deadReason === 'fall') this._ballistic(dt); return null; }
        const c = this.cfg();
        this.jumpLock = Math.max(0, this.jumpLock - dt);
        this.stun = Math.max(0, this.stun - dt);
        this.hitCool = Math.max(0, this.hitCool - dt);
        this.bonkCool = Math.max(0, this.bonkCool - dt);
        this.climbCool = Math.max(0, this.climbCool - dt);
        this.crashT = Math.max(0, this.crashT - dt);
        this.visLift *= Math.exp(-14 * dt);
        this.padBoost = Math.max(0, this.padBoost - dt);
        const ctl = this.stun > 0 ? 0.25 : 1;
        const thr = Math.max(-1, Math.min(1, input.throttle || 0)) * ctl;
        const str = Math.max(-1, Math.min(1, input.steer || 0)) * (this.stun > 0 ? 0.4 : 1);
        this.throttle = thr;
        this.handbrake = !!input.handbrake && this.stun <= 0;
        // нитро: пока жмут и есть запас; бак медленно наполняется сам
        const wantNitro = !!input.nitro && this.nitro > 0.02 && this.stun <= 0 && this.powerK > 0.05;
        this.nitroOn = wantNitro;
        if (wantNitro) this.nitro = Math.max(0, this.nitro - dt / c.nitroUse);
        else this.nitro = Math.min(1, this.nitro + dt / c.nitroFill);
        // наклон в полёте — только от нажатия уже в воздухе: газ, зажатый с разгона, нос не опрокидывает
        if (!this.grounded && Math.abs(thr) < 0.15) this.airArm = true;
        this._wasGr = this.grounded;
        return { c, thr, str };
    },

    // Конец шага: отрыв, таймеры опоры, падение за край мира, застрял ли.
    _end(dt, thr) {
        if (this.dead) return;
        const c = this.cfg();
        if (this._wasGr && !this.grounded && this.stun <= 0 && this.crashT <= 0) this._takeoff(thr);
        if (this.grounded) { this.airTime = 0; this.groundTime += dt; }
        else { this.airTime += dt; this.groundTime = 0; }
        this.stickT = Math.max(0, this.stickT - dt);
        const world = typeof GameWorld !== 'undefined' && GameWorld.active;
        // Падение с трассы: ниже последней опоры и под нами пусто (в мире с землёй падать некуда — только за край карты).
        if (!this.grounded && this.v[1] < 0 && this.stickT <= 0) {
            if (!world && this.p[1] < this.lastGroundY - c.fallDepth) {
                const hit = ObbyCourse.rayDown(this.c[0], this.c[1], this.c[2], 2400, 0.3);
                if (!hit || this.p[1] < this.lastGroundY - 3600) this._die('fall');
            }
            if (this.p[1] < ObbyCourse.killY) this._die('fall');
        }
        // Застряла (перевёрнута, на боку, стоит): игра предложит вернуть на дорогу. Без сетки — старое правило.
        const sp = Math.hypot(this.v[0], this.v[1], this.v[2]);
        const upY = this.stickT > 0 ? this.u[0] * this.stickN[0] + this.u[1] * this.stickN[1] + this.u[2] * this.stickN[2] : this.u[1];
        if (this.soft) {
            const stuck = sp < 90 && (upY < 0.5 || this.contacts < 2);
            this.strandedT = stuck ? this.strandedT + dt : Math.max(0, this.strandedT - dt * 2);
            return;
        }
        if (upY < -0.25 && (this.bodyTouch || this.contacts > 0 || sp < 250)) this.flipT += dt; else this.flipT = 0;
        if (upY < 0.45 && this.bodyTouch && sp < 350) this.sideT += dt; else this.sideT = Math.max(0, this.sideT - dt * 2);
        // Повисла на краю или застряла боком: стоит, жмут газ — через 2.5 с вернём на чекпоинт.
        if (sp < 60 && Math.abs(this.throttle) > 0.3 && (this.contacts < 3 || upY < 0.8) && this.bodyTouch) this.stuckT += dt; else this.stuckT = 0;
        if (this.flipT > 0.45 || this.sideT > 1.3) this._die('crash');
        else if (this.stuckT > 2.5) this._die('stuck');
    },

    // Отрыв от опоры (кромка трамплина, край спуска): как в GTA 5 машина держит положение — вращение по тангажу и крену,
    // набранное на кромке (передние колёса уже в воздухе, задние ещё толкают), почти гасится.
    _takeoff(thr) {
        const W = this.w, r = this.r, f = this.f, k = 1 - this.cfg().takeoffKeep;
        const wr = W[0] * r[0] + W[1] * r[1] + W[2] * r[2], wf = W[0] * f[0] + W[1] * f[1] + W[2] * f[2];
        W[0] -= (r[0] * wr + f[0] * wf) * k; W[1] -= (r[1] * wr + f[1] * wf) * k; W[2] -= (r[2] * wr + f[2] * wf) * k;
        this.airArm = Math.abs(thr) < 0.15;
    },

    _die(reason) {
        if (this.dead) return;
        this.dead = true;
        this.deadReason = reason;
        if (this.on.die) this.on.die(reason);
    },

    // Упала с трассы: дальше просто летит вниз и кувыркается (вид, пока игра не вернёт на чекпоинт).
    _ballistic(dt) {
        const v = this.v, C = this.c, W = this.w, q = this.q;
        v[1] -= this.cfg().g * dt;
        C[0] += v[0] * dt; C[1] += v[1] * dt; C[2] += v[2] * dt;
        const qx = q[0], qy = q[1], qz = q[2], qw = q[3], h = dt;
        q[0] += 0.5 * h * (W[0] * qw + W[1] * qz - W[2] * qy);
        q[1] += 0.5 * h * (W[1] * qw + W[2] * qx - W[0] * qz);
        q[2] += 0.5 * h * (W[2] * qw + W[0] * qy - W[1] * qx);
        q[3] += 0.5 * h * (-W[0] * qx - W[1] * qy - W[2] * qz);
        const ql = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
        q[0] /= ql; q[1] /= ql; q[2] /= ql; q[3] /= ql;
        this._axes();
        this._pose();
    },

    _groundVel() {
        let vx = 0, vy = 0, vz = 0, k = 0;
        for (const w of this.wheels) if (w.contact && w.col && w.col.dynamic) { const pv = ObbyCourse.pointVel(w.col, w.q); vx += pv[0]; vy += pv[1]; vz += pv[2]; k++; }
        return k ? [vx / k, vy / k, vz / k] : [0, 0, 0];
    },

    _sub(h, c, thr, str) {
        this._axes();
        const f = this.f, u = this.u, r = this.r, v = this.v, C = this.c, S = this.spec;
        const sb = this.soft, awake = !!(sb && sb.awake);
        if (awake) {
            const V = this._v0, Wr = this._w0, K = this._c0;
            V[0] = v[0]; V[1] = v[1]; V[2] = v[2]; Wr[0] = this.w[0]; Wr[1] = this.w[1]; Wr[2] = this.w[2]; K[0] = C[0]; K[1] = C[1]; K[2] = C[2];
        }
        const touchingBody = awake && sb.touching;
        const R = S.R;
        const sMax = S.suspRest + c.sag;                  // пружина без нагрузки
        const sMin = S.suspRest - c.travel;               // упор отбойника
        const kW = c.g / (4 * c.sag);                    // жёсткость колеса: в покое 4 пружины держат вес
        const cW = 2 * c.damp * Math.sqrt(c.g / c.sag) / 4;
        const mountY = R + S.suspRest;                    // крепление над землёй в покое

        // ---- руль: угол по вводу, меньше на скорости; возврат к центру быстрее
        const vfNow = v[0] * f[0] + v[1] * f[1] + v[2] * f[2];
        const sp01 = Math.min(1, Math.abs(vfNow) / c.vmax);
        const maxSteer = c.steerLow + (c.steerHigh - c.steerLow) * sp01;
        const want = str * maxSteer;
        const resp = (Math.abs(want) < Math.abs(this.steer) ? 1.6 : 1) * c.steerResp;
        this.steer += (want - this.steer) * Math.min(1, resp * h);

        // ---- подвеска: луч от крепления вдоль -u
        let contacts = 0, ice = false, stick = false;
        const wasGrounded = this.grounded;
        const M = [0, 0, 0];
        for (const w of this.wheels) {
            if (w.lost) { w.contact = false; w.col = null; w.comp = 0; w.load = 0; continue; }
            const Rw = w.flat ? R * 0.74 : R;
            this.point(w.fx + w.bx, mountY + w.by, w.sz + w.bz, M);
            w.prevComp = w.comp;
            let hit = null;
            if (this.jumpLock <= 0 || v[1] < 0) hit = carRay(M[0], M[1], M[2], -u[0], -u[1], -u[2], sMax + c.droop + R + 2);
            if (hit && (hit.n[0] * u[0] + hit.n[1] * u[1] + hit.n[2] * u[2]) < 0.35) hit = null;   // стена под колесом — не опора
            if (hit && hit.col && hit.col.zone) hit = null;
            if (hit && hit.t - Rw < sMax + (w.contact ? c.droop : 0)) {
                const s = Math.max(sMin - 6, hit.t - Rw);
                w.contact = true; w.susp = s; w.comp = sMax - s; w.n[0] = hit.n[0]; w.n[1] = hit.n[1]; w.n[2] = hit.n[2]; w.col = hit.col;
                w.q[0] = M[0] - u[0] * hit.t; w.q[1] = M[1] - u[1] * hit.t; w.q[2] = M[2] - u[2] * hit.t;
                w.gy = w.q[1];
            } else {
                w.contact = false; w.col = null; w.comp = 0;
                w.susp += (sMax - w.susp) * Math.min(1, 18 * h);   // колесо провисает (вид)
            }
            if (w.contact) contacts++;
        }
        const wrld = typeof GameWorld !== 'undefined' && GameWorld.active ? GameWorld : null;
        if (wrld) for (const w of this.wheels) {
            w.surfT -= h;
            if (!w.contact || w.surfT > 0) continue;
            w.surfT = 0.03;
            if (w.col && w.col.ground) { const sf = wrld.surfaceAt(w.q[0], w.q[2]); w.mu = sf.mu; w.rough = sf.rough || 0; w.surf = sf.name; w.drag = sf.drag || 0; }
            else { w.mu = 1; w.rough = 0; w.surf = 'asphalt'; w.drag = 0; }
        }
        // стабилизаторы: разница сжатий слева/справа на оси
        const ar = [0, 0, 0, 0];
        for (const [a, b] of [[0, 1], [2, 3]]) {
            const A = this.wheels[a], B = this.wheels[b];
            if (A.contact && B.contact) { const d = (A.comp - B.comp) * kW * c.antiroll; ar[a] += d; ar[b] -= d; }
        }
        let wi = 0;
        let nx = 0, ny = 0, nz = 0;
        for (const w of this.wheels) {
            const i = wi++;
            if (!w.contact) { w.load = 0; continue; }
            const col = w.col;
            if (col.kill) { this._die('kill'); return; }
            if (col.ice) ice = true;
            if (col.piece && col.piece.prm && col.piece.prm.stick) stick = true;
            if (col.piece && col.piece.role === 'fall' && !this.isBot) ObbyCourse.touch(col);   // плиты роняет только игрок
            // резкий наезд на излом (въезд на трамплин, край ступени): лишняя скорость «в опору» гасится неупругим
            // импульсом по нормали в пятне — скорость поворачивает вдоль поверхности, пружина не копит удар
            {
                const nn = w.n, vp = this._velAt(w.q, this._b);
                if (col.dynamic) { const pv = ObbyCourse.pointVel(col, w.q); vp[0] -= pv[0]; vp[1] -= pv[1]; vp[2] -= pv[2]; }
                const vn = vp[0] * nn[0] + vp[1] * nn[1] + vp[2] * nn[2];
                if (vn < -220) {
                    const j = -(vn + 220) / this._invMass(w.q, nn[0], nn[1], nn[2]);
                    this._impulse(w.q, nn[0] * j, nn[1] * j, nn[2] * j);
                    if (sb && vn < -900 && this.damage) this.damage.wheelShock(i, -vn);   // жёсткая посадка: удар по подвеске
                }
            }
            const cv = (w.comp - w.prevComp) / h;
            let F = kW * w.comp + cW * Math.max(-350, Math.min(350, cv)) + ar[i];   // демпфер ограничен: на изломах не «выстреливает»
            F = Math.max(0, Math.min(F, c.g * 4));
            w.load = F;
            this.point(w.fx + w.bx, mountY + w.by, w.sz + w.bz, M);
            // пружина давит по нормали опоры (на склоне — перпендикулярно склону, без «торможения» стойкой)
            const sn = w.n;
            this._impulse(M, sn[0] * F * h, sn[1] * F * h, sn[2] * F * h);
            // отбойник: колесо «упёрлось» — гасим скорость в опору в этой точке, выталкиваем по чуть-чуть
            if (w.susp < sMin) {
                const nn = w.n;
                const vp = this._velAt(w.q, this._b);
                const vn = vp[0] * nn[0] + vp[1] * nn[1] + vp[2] * nn[2];
                if (vn < 0) { const j = -vn / this._invMass(w.q, nn[0], nn[1], nn[2]) * 0.9; this._impulse(w.q, nn[0] * j, nn[1] * j, nn[2] * j); }
                const over = Math.min(4, sMin - w.susp);
                C[0] += u[0] * over; C[1] += u[1] * over; C[2] += u[2] * over;
                w.susp += over;
            }
            nx += w.n[0]; ny += w.n[1]; nz += w.n[2];
            if (col.boost && thr >= -0.2) {
                const bx = col.ax[0], bz = col.ax[2], bl = Math.hypot(bx, bz) || 1;
                const along = v[0] * bx / bl + v[2] * bz / bl;
                if (along < col.boost) { const k = Math.min(1, 6 * h) * (col.boost - along); v[0] += bx / bl * k; v[2] += bz / bl * k; }
                this.padBoost = 1.4;
                if (this.on.pad) this.on.pad('boost');
            }
            if (col.jump && this.jumpLock <= 0) {
                v[1] = Math.max(v[1], col.jump);
                this.jumpLock = 0.25;
                for (const x of this.wheels) x.contact = false;
                contacts = 0;
                if (this.on.pad) this.on.pad('jump');
                break;
            }
        }
        // Аркадный трамплин: оторвались от наклонной опоры — вертикальная скорость как у идеального вылета с этого
        // уклона (v·tgθ по ходу), без «клевка» носом на кромке и без лишнего подброса подвеской.
        if (contacts === 0 && this._lastN && this.jumpLock <= 0 && this.stickT <= 0) {
            const N = this._lastN, up = -(N[0] * v[0] + N[2] * v[2]) / Math.max(0.5, N[1]);
            if (up > 150 && N[1] > 0.5) v[1] = Math.max(up * 0.97, Math.min(v[1], up * 1.08 + 120));
            this._lastN = null;
        }
        this.contacts = contacts;
        this.grounded = contacts > 0 && this.jumpLock <= 0;
        this.ice = ice;
        if (this.grounded && !wasGrounded) {
            this.landSpeed = -(v[0] * (nx || 0) + v[1] * (ny || 1) + v[2] * (nz || 0)) / Math.max(1, Math.hypot(nx, ny, nz) || 1);
            if (this.on.land) this.on.land(this.landSpeed);
        }
        const nl0 = Math.hypot(nx, ny, nz) || 1;
        if (stick && this.grounded) { this.stickT = 0.3; this.stickN = [nx / nl0, ny / nl0, nz / nl0]; }

        // ---- прижимная сила: растёт со скоростью (по оси подвески)
        if (this.grounded) {
            const df = c.downforce * vfNow * vfNow;
            v[0] -= u[0] * df * h; v[1] -= u[1] * df * h; v[2] -= u[2] * df * h;
        }

        // ---- покрытие тормозит: песок и трава вязкие, лопнувшая шина и потерянное колесо тянут ещё сильнее
        if (this.grounded) {
            let dragS = 0;
            for (const w of this.wheels) { if (w.contact) dragS += w.drag + (w.flat ? 0.1 : 0); else if (w.lost) dragS += 0.12; }
            if (dragS > 0) { const k = Math.max(0, 1 - dragS * 0.42 * h); v[0] *= k; v[1] *= k; v[2] *= k; }
        }

        // ---- шины: продольная и боковая сила в пятне контакта (последовательные импульсы)
        const nitro = this.nitroOn;
        const vmax = (nitro ? c.vmax * c.nitroSpeed : c.vmax) * (0.45 + 0.55 * this.powerK);
        const mu = (ice ? c.iceMu : 1) * c.mu;
        let slipSum = 0;
        let braking = false;
        if (this.grounded) {
            const curve = 1 - Math.pow(Math.min(1, Math.abs(vfNow) / vmax), 1.6);
            const driveA = c.accel * (nitro ? c.nitroAccel : 1) * Math.max(0.12, curve) * this.powerK;
            const PA = [0, 0, 0], vp = [0, 0, 0];
            const hb = this.handbrake;
            for (const w of this.wheels) {
                if (!w.contact) continue;
                const nn = w.n;
                // направление колеса: передние повёрнуты рулём; проекция на плоскость опоры
                const st = (w.front ? this.steer : 0) + w.toe, cs = Math.cos(st), sn = Math.sin(st);
                let fx = f[0] * cs + r[0] * sn, fy = f[1] * cs + r[1] * sn, fz = f[2] * cs + r[2] * sn;
                const fd = fx * nn[0] + fy * nn[1] + fz * nn[2];
                fx -= nn[0] * fd; fy -= nn[1] * fd; fz -= nn[2] * fd;
                const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
                const sx = fy * nn[2] - fz * nn[1], sy = fz * nn[0] - fx * nn[2], sz = fx * nn[1] - fy * nn[0];   // вправо
                // точка приложения — пятно контакта, поднятое к центру масс (меньше крен)
                const lift = S.comH * 0.55;
                PA[0] = w.q[0] + u[0] * lift; PA[1] = w.q[1] + u[1] * lift; PA[2] = w.q[2] + u[2] * lift;
                this._velAt(w.q, vp);
                if (w.col && w.col.dynamic) { const pv = ObbyCourse.pointVel(w.col, w.q); vp[0] -= pv[0]; vp[1] -= pv[1]; vp[2] -= pv[2]; }
                const vl = vp[0] * fx + vp[1] * fy + vp[2] * fz;
                const vs = vp[0] * sx + vp[1] * sy + vp[2] * sz;
                const drive = 0.4;
                const share = (w.front ? drive : 1 - drive) / 2;
                const mL = this._invMass(PA, fx, fy, fz);
                let jl = 0;
                const rearLock = hb && !w.front;
                if (rearLock) {
                    // ручник: задние колёса тормозят юзом
                    jl = -Math.sign(vl) * Math.min(Math.abs(vl) / mL, c.brake * 0.18 * h);
                    if (Math.abs(vl) > 60) braking = true;
                } else if (thr > 0.05) {
                    if (vl < -40) { jl = Math.min(-vl / mL, c.brake * 0.25 * thr * h); braking = true; }            // ехали назад — тормоз
                    else if (vl < vmax * thr) jl = driveA * thr * share * h;
                } else if (thr < -0.05) {
                    if (vl > 40) { jl = -Math.min(vl / mL, c.brake * 0.25 * -thr * h); braking = true; }              // тормоз
                    else if (vl > -c.rev * -thr) jl = -c.accel * 0.7 * -thr * share * h;                               // назад
                } else {
                    // накат: торможение двигателем, на малой скорости — удержание (стоит на склоне и на плите)
                    if (Math.abs(vl) < 70) jl = -vl / mL * 0.5;
                    else jl = -Math.sign(vl) * Math.min(Math.abs(vl) / mL, c.coast * 0.25 * h);
                }
                // свыше предела мотор не тянет; на спуске гравитация разгоняет дальше — гасит только сопротивление воздуха
                if (vl > vmax * 1.02 && this.padBoost <= 0 && !rearLock) jl = Math.min(jl, -Math.min(vl / mL, (vl - vmax) * c.overDrag * share * h));
                // боковое сцепление: погасить боковую скорость пятна (доля latStiff за подшаг); ручник — задние скользят
                const mS = this._invMass(PA, sx, sy, sz);
                let js = -vs / mS * c.latStiff * (rearLock ? 0.35 : 1);
                // круг трения
                const cap = mu * w.mu * (w.flat ? 0.55 : 1) * Math.max(w.load, c.g * 0.05) * h * (rearLock ? c.handbrake : 1);
                const tot = Math.hypot(jl, js);
                let slip = 0;
                if (tot > cap) { const k = cap / tot; slip = 1 - k; jl *= k; js *= k; }
                slipSum += slip + Math.min(1, Math.abs(vs) / 900);
                w.slip = Math.max(slip, Math.min(1, Math.abs(vs) / 600));
                this._impulse(PA, fx * jl + sx * js, fy * jl + sy * js, fz * jl + sz * js);
                // вращение колеса (вид): по скорости пятна, пробуксовка на газу с места; ручник — стоит
                const spinBoost = thr > 0.5 && Math.abs(vl) < 500 && slip > 0.2 ? 18 * thr : 0;
                w.rate = rearLock ? 0 : vl / R + spinBoost;
            }
            this.vf = v[0] * f[0] + v[1] * f[1] + v[2] * f[2];
            // мягкая стабилизация (аркада): машина стремится встать на колёса — «вверх» к нормали опоры
            if (this.crashT <= 0) this._upright(c.upright * (contacts < 4 ? 1.6 : 0.3) * h, nx / nl0, ny / nl0, nz / nl0);
            this.lastGroundY = Infinity;
            for (const w of this.wheels) if (w.contact) this.lastGroundY = Math.min(this.lastGroundY, w.gy);
            this._lastN = [nx / nl0, ny / nl0, nz / nl0];
        } else if (touchingBody || this.crashT > 0) {
            // кузов на земле или машину только что ударило: ни руля в воздухе, ни выравнивания — кувыркается честно
            for (const w of this.wheels) { w.rate *= Math.max(0, 1 - 0.8 * h); w.slip = 0; }
            this.vf = v[0] * f[0] + v[1] * f[1] + v[2] * f[2];
        } else {
            // ---- полёт: сопротивление воздуха, руль — рысканье, газ/тормоз — тангаж, выравнивание без ввода
            const k = Math.max(0, 1 - c.drag * h);
            v[0] *= k; v[2] *= k;
            this.vf = v[0] * f[0] + v[1] * f[1] + v[2] * f[2];
            for (const w of this.wheels) { w.rate *= Math.max(0, 1 - 0.6 * h); if (thr > 0.3) w.rate += (thr * 30 - w.rate) * Math.min(1, 3 * h); w.slip = 0; }
            const W = this.w;
            // рысканье вокруг вертикали мира
            const wy = W[1];
            W[1] += (-str * c.airYaw - wy) * Math.min(1, 3 * h);   // +ω по вертикали уменьшает курс: руль вправо — минус
            // тангаж от газа/тормоза вокруг оси «вправо»: W — нос вниз (вперёд), S — нос вверх (назад)
            const wr = W[0] * r[0] + W[1] * r[1] + W[2] * r[2];
            const wantR = -thr * c.airPitch;
            const pitching = this.airArm && Math.abs(thr) > 0.2;
            const dr = (pitching ? (wantR - wr) * Math.min(1, 3 * h) : 0);
            W[0] += r[0] * dr; W[1] += r[1] * dr; W[2] += r[2] * dr;
            // без ввода тангажа — мягко к горизонту (аркада), при вращении — слабо, чтобы сальто удавались
            if (this.stickT > 0) this._upright(c.upright * 1.6 * h, this.stickN[0], this.stickN[1], this.stickN[2]);
            else this._upright(c.airLevel * (pitching ? 0.1 : 1) * h, 0, 1, 0, true);
        }
        this.slip = slipSum / 4;
        this.braking = braking;

        // сила тяжести: обычная вниз; на «прилипающих» деталях (петли) — к опоре
        if (this.stickT > 0) {
            const N = this.stickN, gs = c.g * c.stickG;
            v[0] -= N[0] * gs * h; v[1] -= N[1] * gs * h; v[2] -= N[2] * gs * h;
        } else v[1] -= c.g * h;
        // угловая скорость — без «вечного» вращения: лёгкое затухание и предел
        const W = this.w;
        // в полёте вращение по тангажу и крену затухает (машина держит положение), рысканье — слабее
        const free = this.crashT > 0 || touchingBody;
        const damp = Math.max(0, 1 - (free ? 0.05 : this.grounded ? 1.2 : 0.3) * h);
        if (!this.grounded && !free && !(this.airArm && Math.abs(thr) > 0.2)) {
            const r = this.r, f = this.f, kk = Math.min(1, 1.6 * h);
            const wr2 = this.w[0] * r[0] + this.w[1] * r[1] + this.w[2] * r[2], wf2 = this.w[0] * f[0] + this.w[1] * f[1] + this.w[2] * f[2];
            for (let i = 0; i < 3; i++) this.w[i] -= (r[i] * wr2 + f[i] * wf2) * kk;
        }
        W[0] *= damp; W[1] *= damp; W[2] *= damp;
        const wl = Math.hypot(W[0], W[1], W[2]);
        const wMax = free ? 32 : 14;
        if (wl > wMax) { W[0] *= wMax / wl; W[1] *= wMax / wl; W[2] *= wMax / wl; }

        // ---- мягкий кузов: всё, что сделали шины и тяжесть, — на узлы; шаг сетки; поза снова из узлов
        if (awake) {
            sb.push(this, this._v0, this._w0, this._c0, this.stickT > 0 ? 0 : c.g * h);
            sb.simulate(h, this);
            sb.pull(this);
            this._axes();
            for (const w of this.wheels) w.spin = (w.spin + w.rate * h) % (Math.PI * 200);
            if (sb.killHit) { sb.killHit = false; this._die('kill'); return; }
            this.bodyTouch = sb.touching;
            if (sb.quietT > sb.sleepAfter && sb.maxLocal < 70 && !sb.anyLoose && !sb.keepAwake) sb.sleep(this);
            this._pose();
            return;
        }

        // ---- интегрирование: центр масс и поворот (q += ½·ω⊗q·h)
        C[0] += v[0] * h; C[1] += v[1] * h; C[2] += v[2] * h;
        const q = this.q, qx = q[0], qy = q[1], qz = q[2], qw = q[3], wx = W[0], wyy = W[1], wz = W[2];
        q[0] += 0.5 * h * (wx * qw + wyy * qz - wz * qy);
        q[1] += 0.5 * h * (wyy * qw + wz * qx - wx * qz);
        q[2] += 0.5 * h * (wz * qw + wx * qy - wyy * qx);
        q[3] += 0.5 * h * (-wx * qx - wyy * qy - wz * qz);
        const ql = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
        q[0] /= ql; q[1] /= ql; q[2] /= ql; q[3] /= ql;
        this._axes();

        // колёса: угол поворота (вид)
        for (const w of this.wheels) w.spin = (w.spin + w.rate * h) % (Math.PI * 200);

        if (sb) {
            const sp = Math.hypot(v[0], v[1], v[2]);
            if (sb.checkWake(this, 5 + sp * h * 1.5, 2 + Math.max(0, -v[1]) * h * 1.5)) sb.wake(this);
        } else this._collide(c, thr);
        this._pose();
    },

    // Момент, поворачивающий ось «вверх» машины к цели (tx, ty, tz): на опоре — к её нормали, в полёте — к
    // вертикали, наклонённой по траектории (нос чуть вверх на взлёте, вниз к посадке). Только крен и тангаж.
    _upright(k, tx, ty, tz, air) {
        const u = this.u, W = this.w, f = this.f, r = this.r;
        if (air) {
            const v = this.v, hs = Math.max(300, Math.hypot(v[0], v[2]));
            const tl = this.cfg().airTilt;
            const a = Math.max(-tl, Math.min(tl, Math.atan2(v[1], hs) * tl));
            const fh = Math.hypot(f[0], f[2]) || 1;
            tx = -f[0] / fh * Math.sin(a); ty = Math.cos(a); tz = -f[2] / fh * Math.sin(a);
        }
        // ось поворота u -> t: u × t
        const ax = u[1] * tz - u[2] * ty, ay = u[2] * tx - u[0] * tz, az = u[0] * ty - u[1] * tx;
        const kf = ax * f[0] + ay * f[1] + az * f[2], kr = ax * r[0] + ay * r[1] + az * r[2];
        const tilt = Math.hypot(kf, kr);
        if (!air && tilt < 0.04) return;   // ровно стоит — подвеска справится сама
        const wf = W[0] * f[0] + W[1] * f[1] + W[2] * f[2], wr = W[0] * r[0] + W[1] * r[1] + W[2] * r[2];
        const s = air ? 2.2 : Math.min(1, (tilt - 0.04) * 4);
        const dmp = air ? 0.55 : 0.15;
        const df = kf * k * s - wf * k * dmp, dr = kr * k * s - wr * k * dmp;
        W[0] += f[0] * df + r[0] * dr; W[1] += f[1] * df + r[1] * dr; W[2] += f[2] * df + r[2] * dr;
    },

    // Курс, тангаж, крен (для камеры, ботов, вида) и начало модели из центра масс.
    _pose() {
        const f = this.f, u = this.u, C = this.c, comH = this.spec.comH;
        this.yaw = Math.atan2(f[2], f[0]);
        this.pitch = Math.asin(Math.max(-1, Math.min(1, f[1])));
        this.roll = Math.asin(Math.max(-1, Math.min(1, this.r[1])));
        this.p[0] = C[0] - u[0] * comH; this.p[1] = C[1] - u[1] * comH; this.p[2] = C[2] - u[2] * comH;
        // обороты двигателя (звук, вид): по скорости и передаче
        const sp = Math.abs(this.vf), vmax = this.cfg().vmax;
        const gears = [0, 0.15, 0.32, 0.5, 0.71, 0.92, 99].map(k => k * vmax);
        let g = 1; while (g < 6 && sp > gears[g]) g++;
        const lo = gears[g - 1], hi = Math.min(gears[g], vmax * 1.4);
        const t = Math.max(0, Math.min(1, (sp - lo) / Math.max(1, hi - lo)));
        const free = !this.grounded || this.slip > 0.5;
        const target = free && Math.abs(this.throttle) > 0.2 ? 0.75 + 0.25 * Math.abs(this.throttle) : 0.18 + 0.82 * t * (g === 1 ? 1 : 0.85) + (g > 1 ? 0.15 : 0);
        this.gear = g;
        this.rpm += (Math.min(1, target) - this.rpm) * 0.08;
    },

    // Сферы кузова и колёс против стен и препятствий.
    _collide(c, thr) {
        const v = this.v, C = this.c, S = this.spec;
        this.bodyTouch = false;
        const P = [0, 0, 0];
        const R = S.R;
        /** @type {Array<[number, number, number, number, boolean]>} */
        const list = [];
        for (const s of S.spheres) list.push([s[0], s[1], s[2], s[3], false]);
        for (const w of this.wheels) list.push([w.fx, R + (S.suspRest - w.susp), w.sz, R - 3, true]);
        const turb = typeof Turbines !== 'undefined' && Turbines.list.length ? Turbines : null;
        for (const s of list) {
            this.point(s[0], s[1], s[2], P);
            const sx = P[0], sy = P[1], sz = P[2], isWheel = s[4], rad = s[3];
            const onHit = (hit) => {
                if (this.dead) return;
                const col = hit.col, n = hit.n;
                if (col.zone) return;
                if (col.kill) { this._die('kill'); return; }
                if (col.hazard || (col.piece && col.piece.prm && col.piece.prm.tire)) { this._hit(hit, c); return; }
                if (isWheel && n[1] > 0.3) return;                                                   // опора — дело лучей
                if (isWheel && hit.q[1] < sy - rad + c.step) return;                                 // невысокий бортик колесо переезжает
                if (!isWheel && (n[0] * this.u[0] + n[1] * this.u[1] + n[2] * this.u[2]) < -0.3) this.bodyTouch = true;   // крыша или бок о землю
                if (!isWheel && n[1] > 0.6) this.bodyTouch = true;
                // аркадный «заезд» на ступень: колесо или перед упёрлись в ступень, едем на неё — машина запрыгивает
                if (!col.wall && Math.abs(n[1]) < 0.6 && (isWheel || s[0] > 0) && (thr > 0.05 || this.vf > 300) && this.climbCool <= 0 && this.u[1] > 0.8
                    && (n[0] * this.f[0] + n[2] * this.f[2]) < -0.3 && this._climb(sx, sz, isWheel ? sy - rad - 3 : this.p[1], rad)) return;
                C[0] += n[0] * hit.depth; C[1] += n[1] * hit.depth; C[2] += n[2] * hit.depth;
                const Q = hit.q;
                const cv = col.vel || (col.dynamic ? ObbyCourse.pointVel(col, Q) : [0, 0, 0]);
                const vp = this._velAt(Q, [0, 0, 0]);
                const rx = vp[0] - cv[0], ry = vp[1] - cv[1], rz = vp[2] - cv[2];
                const rel = rx * n[0] + ry * n[1] + rz * n[2];
                if (rel < 0) {
                    const e = isWheel ? 0.05 : 0.15;
                    const jn = -rel * (1 + e) / this._invMass(Q, n[0], n[1], n[2]);
                    // трение кузова о стену — немного гасит скольжение вдоль
                    let tx = rx - n[0] * rel, ty = ry - n[1] * rel, tz = rz - n[2] * rel;
                    const tl = Math.hypot(tx, ty, tz);
                    let jt = 0;
                    if (tl > 1) { tx /= tl; ty /= tl; tz /= tl; jt = Math.min(tl / this._invMass(Q, tx, ty, tz), jn * 0.25); }
                    this._impulse(Q, n[0] * jn - tx * jt, n[1] * jn - ty * jt, n[2] * jn - tz * jt);
                    if (-rel > 800 && Math.abs(n[1]) < 0.6 && this.bonkCool <= 0) {
                        this.bonkCool = 0.4;
                        if (this.on.bonk) this.on.bonk(-rel);
                    }
                }
            };
            ObbyCourse.sphere(sx, sy, sz, rad, onHit);
            if (turb && !this.dead) turb.sphere(sx, sy, sz, rad, onHit);
            if (this.dead) return;
        }
        void v;
    },

    // Ступень впереди сферы (x, z): верх опоры не выше CAR_CLIMB_MAX над низом колёс (bottom) — машина
    // «запрыгивает» ровно на неё (физика — сразу, вид — плавно через visLift).
    _climb(x, z, bottom, rad) {
        const c = this.cfg();
        const fx = Math.cos(this.yaw), fz = Math.sin(this.yaw);
        const ahead = rad + 30;
        const hit = ObbyCourse.rayDown(x + fx * ahead, bottom + c.climbMax + 30, z + fz * ahead, c.climbMax + 30, 0.7);
        if (!hit || hit.col.wall || hit.col.kill) return false;
        const rise = hit.y - bottom;
        if (rise < c.step * 0.5 || rise > c.climbMax) return false;
        const lift = rise + 4;
        this.c[1] += lift; this.p[1] += lift;
        this.visLift += lift;
        if (this.v[1] < 0) this.v[1] = 0;
        const along = this.v[0] * fx + this.v[2] * fz;
        const need = Math.max(450, Math.min(900, along));
        if (along < need) { this.v[0] += fx * (need - along); this.v[2] += fz * (need - along); }
        this.w[0] *= 0.3; this.w[1] *= 0.3; this.w[2] *= 0.3;
        this.climbCool = 0.18;
        if (this.on.climb) this.on.climb(rise);
        return true;
    },

    // Удар молотом, балкой или огромной шиной: отброс по нормали удара + скорость препятствия, закрутка, оглушение.
    _hit(hit, c) {
        if (this.hitCool > 0) return;
        this.hitCool = 0.45;
        const vh = hit.col.vel || ObbyCourse.pointVel(hit.col, hit.q);
        let hx = hit.n[0], hz = hit.n[2];
        let l = Math.hypot(hx, hz);
        if (l < 0.2) { hx = vh[0]; hz = vh[2]; l = Math.hypot(hx, hz); }
        if (l < 1e-3) { hx = -Math.cos(this.yaw); hz = -Math.sin(this.yaw); l = 1; }
        hx /= l; hz /= l;
        const sp = Math.hypot(vh[0], vh[2]);
        const k = c.knock + Math.min(900, sp * 0.5);
        this.v[0] = this.v[0] * 0.3 + hx * k + vh[0] * 0.25;
        this.v[2] = this.v[2] * 0.3 + hz * k + vh[2] * 0.25;
        this.v[1] = Math.max(this.v[1], 0) + 700;
        this.c[0] += hit.n[0] * hit.depth; this.c[1] += Math.max(0, hit.n[1]) * hit.depth; this.c[2] += hit.n[2] * hit.depth;
        this.stun = 0.6;
        this.jumpLock = 0.15;
        for (const w of this.wheels) w.contact = false;
        this.grounded = false;
        this.w[1] += (Math.random() - 0.5) * 5;
        if (this.on.hit) this.on.hit(k);
    },

    /** Скорость по ходу, px/с. */
    speed() { return Math.hypot(this.v[0], this.v[2]); },
    };
}

/**
 * Все машины — одним шагом: подшаги твёрдых тел и сеток идут вместе, столкновения машин считаются на каждом подшаге
 * (иначе тот, кто шагает первым, бьётся о застывшего соседа). Машина просит шаг через step(), шаг делает flush().
 * @satisfies {Record<string, any>}
 */
const CarWorld = {
    active: false,
    /** @type {any[]} */ cars: [],
    has(c) { return this.cars.includes(c); },
    add(c) { if (!this.cars.includes(c)) this.cars.push(c); this.active = true; },
    remove(c) { const i = this.cars.indexOf(c); if (i >= 0) this.cars.splice(i, 1); },
    clear() { this.cars.length = 0; },

    /** Сделать шаг всех машин, попросивших его в этом кадре. */
    flush(dt) {
        if (dt < 1e-5) { for (const C of this.cars) C._pend = null; return; }
        const cars = this.cars, N = Math.max(1, Math.min(16, Math.ceil(dt * 240))), h = dt / N;
        for (const C of cars) {
            C._step = C._pend ? C._begin(dt, C._pend) : null;
            C._pend = null;
            C._div = C.soft && C.soft.awake ? 1 : Math.max(1, Math.round(240 / (C._hz || 240)));
        }
        for (let t = 0; t < N; t++) {
            for (const C of cars) {
                const b = C._step;
                if (!b || C.dead) continue;
                const div = C.soft && C.soft.awake ? 1 : C._div;
                if (t % div !== 0) continue;
                C._sub(h * Math.min(div, N - t), b.c, b.thr, b.str);
            }
            for (let i = 0; i < cars.length; i++) {
                const A = cars[i], sa = A.soft;
                if (!sa || !A._step || A.dead) continue;
                for (let j = i + 1; j < cars.length; j++) {
                    const B = cars[j], sb = B.soft;
                    if (!sb || !B._step || B.dead) continue;
                    const dx = A.c[0] - B.c[0], dy = A.c[1] - B.c[1], dz = A.c[2] - B.c[2], rr = sa.R0 + sb.R0 + 30;
                    if (dx * dx + dy * dy + dz * dz > rr * rr) continue;
                    if (!sa.awake) { sa.wake(A); sa.aabbFrom(); }
                    if (!sb.awake) { sb.wake(B); sb.aabbFrom(); }
                    sa.keepAwake = sb.keepAwake = true;
                    SoftBody.pair(sa, sb);
                }
            }
            for (const C of cars) if (C.soft) C.soft.keepAwake = false;
        }
        for (const C of cars) { const b = C._step; if (b) C._end(dt, b.thr); C._step = null; }
    },
};
