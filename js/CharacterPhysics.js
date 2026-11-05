// CharacterPhysics.js — физический контроллер персонажа: «парящая капсула» на пружинах Холдена. Чистая логика
// (инвариант 4): решения не спрашивают у Babylon ни высоту, ни пересечения. Мир ему даёт игра запросами
// (CharacterWorld): высота и нормаль земли под точкой и — по желанию — горизонтальный шаг со скольжением.
// Готовые миры: CharacterPhysics.heightWorld(fn) — любая функция высоты (x, z) -> y; terrainWorld(terrain) —
// Terrain3D.fieldHeight (одна на всех устройствах); navWorld(Nav) — Nav.height и Nav.move (стены, вода, перепады,
// walk-поверхности); flatWorld(y). Свою физику игра подключает объектом с теми же методами.
//
// ЕДИНИЦЫ: px мира (1 м = 100 px), секунды; pos = [x, h, z] — мир Babylon (карта y = мир z), h — высота над уровнем
// моря; курс — как в Maps.js: atan2(vy, vx). Рост базового тела 180 px; scale (по телу: body.height / 184)
// масштабирует капсулу, ступень и длины лучей.
//
// ЧТО ДЕЛАЕТ. Капсула висит над землёй на пружине-луче (5 лучей вниз), поэтому ступени до CHAR_STEP_HEIGHT px и
// неровности берутся без рывков, а приземление само пружинит. Жёсткий пол — на высоте ступени ниже опоры: быстрое
// падение сквозь землю не проходит. Горизонталь: скорость относительно опоры догоняет желаемую той же пружиной,
// что в базе Motion Matching (Holden spring character), но ускорение ограничено сцеплением (CHAR_TRACTION) — в
// воздухе управление слабое (CHAR_AIR_CONTROL). Вверх по склону медленнее, круче CHAR_MAX_SLOPE_DEG — скольжение.
// Движущаяся опора (лифт, платформа) несёт персонажа: желаемая скорость — ОТНОСИТЕЛЬНО опоры (hit.moving + hit.vel).
// Прыжок: буфер нажатия, «койот-время», короткое нажатие — ниже прыжок. Шаг физики фиксированный, 1/120 с.
//
// ПРИМЕР:
//   const world = CharacterPhysics.navWorld(Nav);                      // или terrainWorld(location.terrain)
//   const ch = new CharacterPhysics(world, { scale: 1 });
//   ch.place(x, location.terrain.fieldHeight(x, y), y, heading);       // x, y — карта; pos = [x, h, y]
//   ch.setInput(Input.move(), Input.down('sprint') ? 'sprint' : 'run', Input.pressed('jump'), Input.down('jump'), camera.azimuth, 0);
//   ch.update(dt);                                                     // пружины, опора, прыжок, столкновения мира
//   const ev = ch.consumeEvents();                                     // { jumped, landed (скорость удара), hit, bump }
//   mm.update(dt, ch);                                                 // поза: MotionController читает поля ch
//
// CharacterWorld (методы; нужен только ground):
//   ground(x, z, yTop, maxDist, out) -> out | null — ближайшая опора под точкой не выше yTop в пределах maxDist вниз:
//       out = { y, n: [nx, ny, nz], body?, moving?, kinematic?, vel?: [vx, vy, vz], spin? } (spin — рад/с вокруг
//       вертикали в сторону роста курса). out отдан на запись — не создавай новый объект.
//   move?(x, z, dx, dz, r, y, out) -> out { x, z } — шаг кругом радиуса r со скольжением вдоль стен (Nav.move);
//       без него горизонталь свободна.
//   push?(p, r, out) -> out | null — выталкивание сферы (частицы Ragdoll) из мира; без него — только земля.
//   support?(hit, impulse, point) — вес и разгон персонажа на опору (ящик проседает, качается).
//   gravity? — своя гравитация (по умолчанию CHAR_GRAVITY).

/**
 * @typedef {object} CharacterWorld
 * @property {(x: number, z: number, yTop: number, maxDist: number, out: any) => any} ground
 * @property {(x: number, z: number, dx: number, dz: number, r: number, y: number, out: any) => any} [move]
 * @property {(p: number[], r: number, out: any) => any} [push]
 * @property {(hit: any, impulse: number[], point: number[]) => void} [support]
 * @property {number} [gravity]
 */

class CharacterPhysics {
    // world — CharacterWorld (null — ровная земля на 0). opts: { scale?: 1, cfg?: поля CharacterPhysics.cfg() }.
    constructor(world, opts) {
        const o = opts || {};
        this.c = CharacterPhysics.cfg(o.cfg);
        this.world = world || CharacterPhysics.flatWorld(0);
        this.k = 1; this.rc = 24; this.height = 180; this.stepH = this.c.stepHeight; this.a = 0; this.b = 0;
        this.setScale(o.scale || 1);
        this.pos = [0, 0, 0];
        this.vel = [0, 0, 0];
        this.enabled = true;
        this.grounded = false;
        /** @type {{ y: number, n: number[], body: any, moving: boolean }} */
        this.groundHit = { y: 0, n: [0, 1, 0], body: null, moving: false };
        this.groundVel = [0, 0, 0];
        this.groundSpin = 0;
        this.sx = { v: 0, a: 0 }; this.sz = { v: 0, a: 0 };
        this.desired = [0, 0];
        this.facing = { x: 0, v: 0 }; this.facingGoal = 0;
        this.hlVel = this.c.hlVel; this.hlRot = this.c.hlRot;
        this.airTime = 0; this.jumpT = 9; this.coyote = 0; this.jumpBuffer = 0; this.jumpHeld = false;
        this.impact = 0; this.lastAirVy = 0;
        this.events = { jumped: false, landed: 0, hit: null, bump: 0 };
        this.pushW = 0;             // 0..1: толкаю предмет (руки вперёд) — пишет игра, физика не трогает
        /** @type {any} Ragdoll | null: позой рулит рэгдолл (читает MotionController) */
        this.ragdoll = null;
        this.camYaw = 0; this.camPitch = 0;
        this.speedMode = 'run';
        this.slope = 0;
        this.onBody = null;
        this.mass = this.c.mass;
        this.acc = 0;
        this.time = 0;
        this._hit = { y: 0, n: [0, 1, 0], body: null, t: 0, moving: false };
        this._ghit = { y: 0, n: [0, 1, 0], body: null, t: 0, moving: false };
        this._probe = { y: 0, n: [0, 1, 0], body: null, t: 0, moving: false, kinematic: false, vel: [0, 0, 0], spin: 0 };
        this._gv = [0, 0, 0];
        this._mv = { x: 0, z: 0 };
        this._floorY = -Infinity;
        this._fn = [0, 1, 0];
        this._imp = [0, 0, 0];
        this._pt = [0, 0, 0];
    }

    // Числа контроллера: константы CHAR_* / MOTION_* (Constants.js) с дефолтами, поверх — over.
    static cfg(over) {
        const U = 'undefined', o = over || {};
        const pick = (k, v) => (o[k] != null ? o[k] : v);
        return {
            walk: pick('walk', typeof MOTION_WALK_SPEED !== U ? MOTION_WALK_SPEED : 140),
            run: pick('run', typeof MOTION_RUN_SPEED !== U ? MOTION_RUN_SPEED : 300),
            sprint: pick('sprint', typeof MOTION_SPRINT_SPEED !== U ? MOTION_SPRINT_SPEED : 470),
            hlVel: pick('hlVel', typeof MOTION_VEL_HALFLIFE !== U ? MOTION_VEL_HALFLIFE : 0.25),
            hlRot: pick('hlRot', typeof MOTION_ROT_HALFLIFE !== U ? MOTION_ROT_HALFLIFE : 0.18),
            mass: pick('mass', typeof CHAR_MASS !== U ? CHAR_MASS : 70),
            stepHeight: pick('stepHeight', typeof CHAR_STEP_HEIGHT !== U ? CHAR_STEP_HEIGHT : 22),
            traction: pick('traction', typeof CHAR_TRACTION !== U ? CHAR_TRACTION : 2300),
            airControl: pick('airControl', typeof CHAR_AIR_CONTROL !== U ? CHAR_AIR_CONTROL : 380),
            jumpHeight: pick('jumpHeight', typeof CHAR_JUMP_HEIGHT !== U ? CHAR_JUMP_HEIGHT : 88),
            gravity: pick('gravity', typeof CHAR_GRAVITY !== U ? CHAR_GRAVITY : 1200),
            springHz: pick('springHz', typeof CHAR_RIDE_SPRING_HZ !== U ? CHAR_RIDE_SPRING_HZ : 5.5),
            springZeta: pick('springZeta', typeof CHAR_RIDE_SPRING_DAMPING !== U ? CHAR_RIDE_SPRING_DAMPING : 0.75),
            maxSlope: pick('maxSlope', typeof CHAR_MAX_SLOPE_DEG !== U ? CHAR_MAX_SLOPE_DEG : 48),
            coyote: pick('coyote', typeof CHAR_COYOTE_TIME !== U ? CHAR_COYOTE_TIME : 0.12),
            buffer: pick('buffer', typeof CHAR_JUMP_BUFFER !== U ? CHAR_JUMP_BUFFER : 0.14),
            fallRagdoll: pick('fallRagdoll', typeof CHAR_RAGDOLL_FALL_SPEED !== U ? CHAR_RAGDOLL_FALL_SPEED : 1080),
            hitRagdoll: pick('hitRagdoll', typeof CHAR_RAGDOLL_HIT_SPEED !== U ? CHAR_RAGDOLL_HIT_SPEED : 320),
        };
    }

    // Размер капсулы и длины лучей по масштабу k (1 — рост 180 px; тело: body.height / Humanoid.HEIGHT).
    setScale(k) {
        this.k = Math.max(0.05, Number(k) || 1);
        this.rc = 24 * this.k;
        this.height = 180 * this.k;
        this.stepH = this.c.stepHeight * this.k;
        this.a = this.stepH + this.rc;       // центр нижней сферы капсулы над корнем
        this.b = this.height - this.rc;      // центр верхней
    }

    get gravity() { return this.world.gravity != null ? this.world.gravity : this.c.gravity; }

    // Встать в точку (ноги: x, h над уровнем моря, z мира), курс heading.
    place(x, y, z, heading) {
        GM.set(this.pos, x, y, z);
        GM.set(this.vel, 0, 0, 0);
        this.sx.v = this.sx.a = this.sz.v = this.sz.a = 0;
        this.facing.x = heading; this.facing.v = 0; this.facingGoal = heading;
        this.desired[0] = this.desired[1] = 0;
        this.airTime = 0; this.jumpT = 9; this.coyote = 0; this.jumpBuffer = 0;
        this.grounded = true;
        this.ragdoll = null;
        this.enabled = true;
        this.acc = 0;
        GM.set(this.groundVel, 0, 0, 0); GM.set(this._gv, 0, 0, 0); this.groundSpin = 0; this.onBody = null;
        this.events.jumped = false; this.events.landed = 0; this.events.hit = null; this.events.bump = 0;
    }

    // Ввод кадра: move {x вправо, y вперёд} (длина ≤ 1; Input.move()), mode 'walk' | 'run' | 'sprint', прыжок: нажат в
    // этот кадр / удерживается, камера — курс взгляда (camera.azimuth) и наклон.
    setInput(move, mode, jumpPressed, jumpHeld, camYaw, camPitch) {
        const c = this.c;
        this.camYaw = camYaw; this.camPitch = camPitch;
        const m = Math.min(1, Math.hypot(move.x, move.y));
        let speed = 0;
        if (m > 0.05) {
            const base = mode === 'sprint' ? c.sprint : mode === 'walk' ? c.walk : c.run;
            // аналоговый стик: мало — шаг, больше — бег
            speed = m < 0.999 ? GM.lerp(c.walk * 0.7, base, GM.smooth((m - 0.15) / 0.7)) : base;
            if (mode === 'walk') speed = Math.min(speed, c.walk);
        }
        this.speedMode = mode;
        // направление относительно камеры: вперёд = курс камеры, вправо = +90°
        let dx = 0, dz = 0;
        if (m > 0.05) {
            const fx = Math.cos(camYaw), fz = Math.sin(camYaw), rx = -fz, rz = fx;
            dx = fx * move.y + rx * move.x; dz = fz * move.y + rz * move.x;
            const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
        }
        // склон: вверх медленнее, вниз чуть быстрее
        if (this.grounded && this.slope > 0.05 && m > 0.05) {
            const n = this.groundHit.n, gx = -n[0] / n[1], gz = -n[2] / n[1];
            const up = dx * gx + dz * gz;
            speed *= up > 0 ? 1 / (1 + 0.65 * up) : 1 + 0.15 * Math.min(1, -up);
        }
        this.desired[0] = dx * speed; this.desired[1] = dz * speed;
        if (m > 0.05) this.facingGoal = Math.atan2(dz, dx);
        if (jumpPressed) this.jumpBuffer = c.buffer;
        this.jumpHeld = jumpHeld;
    }

    // Опора под точкой (для стоп MotionController): { y, n, body, moving } | null.
    ground(x, z, yTop) {
        const h = this.world.ground(x, z, yTop, 130 * this.k, this._ghit);
        if (!h) return null;
        h.moving = !!h.moving;
        return h;
    }

    // ---- шаг физики --------------------------------------------------------------------------
    // dt кадра -> число подшагов по 1/120 с (не больше 6 за кадр: долгий кадр не раскручивает физику).
    update(dt) {
        const S = CharacterPhysics.STEP;
        this.acc = Math.min(this.acc + dt, S * 6);
        let n = 0;
        while (this.acc >= S) {
            this.substep(S);
            this.acc -= S;
            n++;
        }
        return n;
    }

    substep(h) {
        if (!this.enabled) return;
        this.time += h;
        this.preStep(h);
        this.integrate(h);
    }

    // Опора, вертикаль, горизонталь, курс, прыжок.
    preStep(h) {
        const c = this.c, g = this.gravity, p = this.pos, v = this.vel, w = this.world, k = this.k;
        this.jumpT += h;
        this.jumpBuffer -= h;
        // 1) опора: 5 лучей
        const fallStep = Math.max(0, -v[1] * h);
        const top = p[1] + 60 * k, reach = 60 * k + (this.grounded ? this.stepH + 6 * k : 6 * k + fallStep);
        const R = 12 * k;
        let best = null;
        const pr = this._probe;
        for (let n = 0; n < 5; n++) {
            const ox = n === 1 ? R : n === 2 ? -R : 0, oz = n === 3 ? R : n === 4 ? -R : 0;
            const hit = w.ground(p[0] + ox, p[2] + oz, top, reach, this._hit);
            if (!hit) continue;
            if (hit.n[1] < 0.35 && n > 0) continue;
            if (hit.y > p[1] + this.stepH + 3 * k) continue;   // выше ступени — это стена/препятствие, не пол
            if (!best || hit.y > best.y + 0.5 || (n === 0 && Math.abs(hit.y - best.y) < 0.5)) {
                pr.y = hit.y; GM.copy(pr.n, hit.n); pr.body = hit.body || null; pr.t = hit.t || 0;
                pr.moving = !!hit.moving; pr.kinematic = !!hit.kinematic; pr.spin = hit.spin || 0;
                if (hit.vel) GM.copy(pr.vel, hit.vel); else GM.set(pr.vel, 0, 0, 0);
                best = pr;
            }
        }
        const slopeOk = best && best.n[1] >= Math.cos(c.maxSlope * GM.DEG);
        const wasGrounded = this.grounded;
        const rising = this.jumpT < 0.2 && v[1] > 0;
        this.grounded = !!(best && slopeOk && !rising && p[1] - best.y < (wasGrounded ? this.stepH + 4 * k : 4 * k + fallStep));
        this._floorY = best ? best.y - this.stepH : -Infinity;
        if (best) GM.copy(this._fn, best.n);
        const gv = this.groundVel;
        if (this.grounded) {
            const pg = this._gv;
            if (best.moving) {
                GM.copy(gv, best.vel); this.groundSpin = best.spin;
                // стоим на той же движущейся опоре: её разгон переносится сразу (как в её системе отсчёта)
                if (best.body && best.body === this.onBody && best.kinematic) { v[0] += gv[0] - pg[0]; v[2] += gv[2] - pg[2]; }
            } else { GM.set(gv, 0, 0, 0); this.groundSpin = 0; }
            GM.copy(pg, gv);
            GM.copy(this.groundHit.n, best.n); this.groundHit.y = best.y; this.groundHit.body = best.body;
            this.groundHit.moving = best.moving;
            this.slope = Math.acos(GM.clamp(best.n[1], -1, 1));
            this.onBody = best.body;
        } else {
            // в воздухе скорость опоры плавно забывается
            const kk = Math.exp(-h / 0.5);
            gv[0] *= kk; gv[2] *= kk; gv[1] = 0;
            this.groundSpin *= kk;
            this.onBody = null;
        }
        if (!wasGrounded && this.grounded) {
            this.impact = Math.max(0, -(this.lastAirVy - gv[1]));
            this.events.landed = this.impact;
            this.airTime = 0;
        }
        if (!this.grounded) { this.airTime += h; this.lastAirVy = v[1]; }
        this.coyote = this.grounded ? 0 : this.coyote + h;
        // 2) вертикаль: пружина над опорой (вместо гравитации), иначе гравитация
        let ay = 0;
        if (this.grounded) {
            const wn = 2 * Math.PI * c.springHz, x = p[1] - best.y, rv = v[1] - gv[1];
            ay = -wn * wn * x - 2 * c.springZeta * wn * rv;
            ay = GM.clamp(ay, -3 * g, 6 * g);
            v[1] += ay * h;
        } else {
            v[1] -= g * h;
            if (v[1] > 0 && !this.jumpHeld && this.jumpT < 0.6) v[1] -= g * 1.4 * h;   // короткое нажатие — ниже
        }
        // 3) горизонталь: пружина скорости относительно опоры, ограничение сцепления
        const rvx = v[0] - gv[0], rvz = v[2] - gv[2];
        this.sx.v = rvx; this.sz.v = rvz;
        GM.springChar(this.sx, this.desired[0], this.hlVel, h);
        GM.springChar(this.sz, this.desired[1], this.hlVel, h);
        let ax = (this.sx.v - rvx) / h, az = (this.sz.v - rvz) / h;
        const lim = this.grounded ? c.traction : c.airControl;
        const al = Math.hypot(ax, az);
        if (al > lim) { ax *= lim / al; az *= lim / al; }
        if (!this.grounded && Math.hypot(this.desired[0], this.desired[1]) < 1) { ax *= 0.15; az *= 0.15; }
        v[0] += ax * h; v[2] += az * h;
        this.sx.v = v[0] - gv[0]; this.sz.v = v[2] - gv[2];
        // вес и разгон — на опору (ящик проседает, качается)
        if (this.grounded && w.support && best.body) {
            const I = this._imp, pt = this._pt;
            GM.set(I, -ax * c.mass * h * 0.5, -(ay + g) * c.mass * h * 0.5, -az * c.mass * h * 0.5);
            GM.set(pt, p[0], best.y, p[2]);
            w.support(best, I, pt);
        }
        // 4) курс
        GM.springAngle(this.facing, this.facingGoal, this.hlRot, h);
        if (this.grounded && this.groundSpin) {
            this.facing.x = GM.wrap(this.facing.x + this.groundSpin * h);
            if (Math.hypot(this.desired[0], this.desired[1]) < 1) this.facingGoal = GM.wrap(this.facingGoal + this.groundSpin * h);
        }
        // 5) прыжок
        if (this.jumpBuffer > 0 && (this.grounded || this.coyote < c.coyote) && this.jumpT > 0.3) {
            const jv = Math.sqrt(2 * g * c.jumpHeight);
            v[1] = gv[1] + jv;
            this.jumpT = 0; this.jumpBuffer = 0; this.coyote = 9;
            this.grounded = false;
            this.events.jumped = true;
        }
    }

    // Перенос по скорости: горизонталь через world.move (стены), вертикаль — жёсткий пол под опорой.
    integrate(h) {
        const p = this.pos, v = this.vel, w = this.world;
        const mx = v[0] * h, mz = v[2] * h;
        if (w.move && (mx !== 0 || mz !== 0)) {
            const r = w.move(p[0], p[2], mx, mz, this.rc, p[1], this._mv);
            const ax = r.x - p[0], az = r.z - p[2];
            if (Math.abs(ax - mx) > 1e-4 || Math.abs(az - mz) > 1e-4) {
                // упёрлись: скорость — по фактическому смещению (в стену не копится); сила удара — для хит-логики игры
                const nvx = ax / h, nvz = az / h;
                this.events.bump = Math.max(this.events.bump, Math.hypot(v[0] - nvx, v[2] - nvz));
                v[0] = nvx; v[2] = nvz;
            }
            p[0] = r.x; p[2] = r.z;
        } else { p[0] += mx; p[2] += mz; }
        p[1] += v[1] * h;
        if (p[1] < this._floorY) {
            p[1] = this._floorY;
            if (this.grounded) { if (v[1] < this.groundVel[1]) v[1] = this.groundVel[1]; }
            else {
                // крутой склон или быстрое падение: убрать составляющую скорости в землю — остаётся скольжение
                const n = this._fn, vn = (v[0] - this.groundVel[0]) * n[0] + v[1] * n[1] + (v[2] - this.groundVel[2]) * n[2];
                if (vn < 0) { v[0] -= n[0] * vn; v[1] -= n[1] * vn; v[2] -= n[2] * vn; }
            }
        }
    }

    // Внешний удар (маятник, снаряд, быстрый предмет игры): vel — куда отбросит, speed — скорость сближения.
    // Игра решает, падать ли в рэгдолл: HumanoidCharacter.hit проверяет порог CHAR_RAGDOLL_HIT_SPEED.
    hit(vel, speed, body) {
        const e = this.events;
        if (!e.hit || speed > e.hit.speed) e.hit = { speed, vel: [vel[0], vel[1], vel[2]], body: body || null };
    }

    // События с прошлого вызова (сбрасываются): прыжок, скорость приземления, удар, сила удара о стену.
    consumeEvents() {
        const e = this.events;
        const out = { jumped: e.jumped, landed: e.landed, hit: e.hit, bump: e.bump };
        e.jumped = false; e.landed = 0; e.hit = null; e.bump = 0;
        return out;
    }

    // ---- готовые миры ------------------------------------------------------------------------

    // Ровная земля на высоте y.
    /** @returns {CharacterWorld} */
    static flatWorld(y) { return CharacterPhysics.heightWorld(() => y || 0, { eps: 8 }); }

    // Мир по аналитической карте высот Terrain3D (zone-flat, холмы; не зависит от клетки сетки устройства).
    /** @returns {CharacterWorld} */
    static terrainWorld(terrain, opts) {
        return CharacterPhysics.heightWorld((x, z) => terrain.fieldHeight(x, z), opts);
    }

    // Мир по Nav: земля и walk-поверхности (Nav.height), стены, вода и перепады (Nav.move). Nav.build(location) —
    // до первого update; при смене карты игра пересобирает Nav сама. opts: { ground?: (x, z) => высота земли без walk
    // (для проходов под мостом; по умолчанию Nav._groundAt), wallHeight?: до какой высоты над землёй стены Nav толкают частицы рэгдолла }.
    /** @returns {CharacterWorld} */
    static navWorld(nav, opts) {
        const o = opts || {};
        const groundFn = o.ground || (typeof nav._groundAt === 'function' ? (x, z) => nav._groundAt(x, z) : (x, z) => nav.height(x, z));
        const wall = o.wallHeight != null ? o.wallHeight : 180;
        const world = CharacterPhysics.heightWorld((x, z) => nav.height(x, z), Object.assign({}, o, {
            under: groundFn,
            move: (x, z, dx, dz, r, y, out) => {
                const m = nav.move(x, z, dx, dz, r);
                out.x = m.x; out.z = m.y;
                return out;
            },
        }));
        // Частицы рэгдолла: из стен Nav (круг радиуса r, пока частица ниже стен), земля — в Ragdoll.groundPush.
        world.push = (p, r, out) => {
            if (!nav.ready || p[1] - groundFn(p[0], p[2]) > wall) return null;
            const m = nav.move(p[0], p[2], 0, 0, r);
            const ddx = m.x - p[0], ddz = m.y - p[2], d = Math.hypot(ddx, ddz);
            if (d < 1e-3) return null;
            p[0] = m.x; p[2] = m.y;
            const n = out.n || (out.n = [0, 0, 0]);
            GM.set(n, ddx / d, 0, ddz / d);
            out.body = null; out.depth = d;
            return out;
        };
        return world;
    }

    // Мир по функции высоты fn(x, z) -> y: опора = fn, нормаль — конечными разностями (перепад круче ступени считается
    // стеной, а не склоном), горизонталь — шаг со скольжением, который не взбирается на перепад выше ступени
    // (стена) и пускает по плавному склону. opts: { step?: ступень (CHAR_STEP_HEIGHT), eps?: шаг разности, 8 px,
    // maxSlope?: ° (CHAR_MAX_SLOPE_DEG), move?: свой шаг, under?: функция земли под мостом (если fn выше луча),
    // gravity? }.
    /** @returns {CharacterWorld} */
    static heightWorld(fn, opts) {
        const o = opts || {}, U = 'undefined';
        const stepMax = o.step != null ? o.step : (typeof CHAR_STEP_HEIGHT !== U ? CHAR_STEP_HEIGHT : 22);
        const maxSlope = o.maxSlope != null ? o.maxSlope : (typeof CHAR_MAX_SLOPE_DEG !== U ? CHAR_MAX_SLOPE_DEG : 48);
        const tanMax = Math.tan(maxSlope * GM.DEG);
        const eps = o.eps || 8;
        const under = o.under || null;
        const sampleNormal = (f, x, z, n) => {
            let gx = f(x + eps, z) - f(x - eps, z), gz = f(x, z + eps) - f(x, z - eps);
            if (Math.abs(gx) > stepMax * 2) gx = 0;   // перепад-стена, не склон
            if (Math.abs(gz) > stepMax * 2) gz = 0;
            n[0] = -gx / (2 * eps); n[1] = 1; n[2] = -gz / (2 * eps);
            return GM.norm(n, n);
        };
        const world = {
            gravity: o.gravity,
            ground(x, z, yTop, maxDist, out) {
                let f = fn, y = fn(x, z);
                if (under && y > yTop) { f = under; y = under(x, z); }
                const t = yTop - y;
                if (!(t >= 0 && t <= maxDist)) return null;
                out.y = y; out.t = t;
                out.n = out.n || [0, 1, 0];
                sampleNormal(f, x, z, out.n);
                out.body = null; out.moving = false; out.kinematic = false; out.vel = null; out.spin = 0;
                return out;
            },
            move: o.move || function (x, z, dx, dz, r, y, out) {
                const len = Math.hypot(dx, dz);
                out.x = x + dx; out.z = z + dz;
                if (len < 1e-9) return out;
                // можно ли встать центром в (nx, nz), двигаясь вдоль (ux, uz): центр не выше ступени; впереди на r —
                // не перепад круче склона (стена), а плавный подъём пускается
                const f = (nx, nz, ux, uz) => {
                    const hc = fn(nx, nz);
                    if (hc - y > stepMax) return false;
                    const hf = fn(nx + ux * r, nz + uz * r);
                    return !(hf - y > stepMax && (hf - hc) / r > tanMax);
                };
                const ux = dx / len, uz = dz / len;
                if (f(x + dx, z + dz, ux, uz)) return out;
                if (dx !== 0 && f(x + dx, z, Math.sign(dx), 0)) { out.z = z; return out; }
                if (dz !== 0 && f(x, z + dz, 0, Math.sign(dz))) { out.x = x; return out; }
                out.x = x; out.z = z;
                return out;
            },
        };
        return world;
    }
}

CharacterPhysics.STEP = 1 / 120;   // шаг физики, с
