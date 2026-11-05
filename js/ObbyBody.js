// ObbyBody.js — тело героя-«блока» для обби: бег, прыжок, гравитация, ступени, стены, подвижные опоры, батуты и
// ускорители на деталях ObbyCourse. ЧИСТАЯ ЛОГИКА (без Babylon, шаг 1/120 с): то же тело двигает игрока и ботов.
// Это эталон «тела» для ObbyBots: любое другое (велосипед, машина, свой контроллер) повторяет его поля и методы —
// контракт см. в шапке ObbyBots.js.
//
// КООРДИНАТЫ — мир Babylon: x вправо, y ВВЕРХ, z вниз по карте; (x, y, z) — НОГИ. Курс yaw = atan2(dz, dx) (0 — вдоль +x).
// Опора — ObbyCourse.rayDown, стены — ObbyCourse.capsule: решения не зависят от устройства.
//
//   const body = new ObbyBody(ObbyCourse, { x, y, z, yaw });
//   // кадр: ввод игрока (камера -> мировое направление) или решение бота
//   body.step(dt, { dx, dz, jump: Input.pressed('jump') });      // dx, dz — желаемое направление (длина ≤ 1)
//   const cause = ObbyCourse.killCause(body.x, body.y + body.height / 2, body.z, body.radius);   // смерть решает игра
//
// cmd: { dx, dz, speed? (px/с, по умолчанию бег), jump? (нажатие — запоминается на OBBY_JUMP_BUFFER) }.
// Поля для вида и мозга: x y z vx vy vz yaw speed (вдоль курса) grounded support (коллайдер под ногами) airTime radius height.

class ObbyBody {
    /** Числа тела из Constants.js (OBBY_*) с дефолтами. */
    static cfg() {
        const U = 'undefined';
        return {
            run: typeof OBBY_RUN_SPEED !== U ? OBBY_RUN_SPEED : 620,
            jump: typeof OBBY_JUMP_SPEED !== U ? OBBY_JUMP_SPEED : 1120,
            gravity: typeof OBBY_GRAVITY !== U ? OBBY_GRAVITY : 3000,
            fallMax: typeof OBBY_FALL_MAX !== U ? OBBY_FALL_MAX : 2600,
            radius: typeof OBBY_RADIUS !== U ? OBBY_RADIUS : 28,
            height: typeof OBBY_HEIGHT !== U ? OBBY_HEIGHT : 180,
            step: typeof OBBY_STEP !== U ? OBBY_STEP : 34,
            accGround: typeof OBBY_ACCEL_GROUND !== U ? OBBY_ACCEL_GROUND : 9000,
            accAir: typeof OBBY_ACCEL_AIR !== U ? OBBY_ACCEL_AIR : 4200,
            accIce: typeof OBBY_ACCEL_ICE !== U ? OBBY_ACCEL_ICE : 900,
            coyote: typeof OBBY_COYOTE !== U ? OBBY_COYOTE : 0.1,
            buffer: typeof OBBY_JUMP_BUFFER !== U ? OBBY_JUMP_BUFFER : 0.12,
            snap: 14,          // px: спуск по склону/ступеньке вниз без отрыва
            turn: 16,          // рад/с: поворот курса к направлению бега
            sub: 1 / 120,      // с: подшаг
        };
    }

    /** @param {any} course ObbyCourse @param {{ x?: number, y?: number, z?: number, yaw?: number, radius?: number, height?: number, cfg?: any }} [opts] */
    constructor(course, opts) {
        const o = opts || {};
        this.course = course || ObbyCourse;
        this.cfg = Object.assign(ObbyBody.cfg(), o.cfg || {});
        this.radius = o.radius || this.cfg.radius;
        this.height = o.height || this.cfg.height;
        this.x = o.x || 0; this.y = o.y || 0; this.z = o.z || 0; this.yaw = o.yaw || 0;
        this.vx = 0; this.vy = 0; this.vz = 0;
        this.speed = 0;
        this.grounded = false; this.support = null; this.ice = false;
        this.airTime = 0; this.coyote = 0; this.jumpBuf = 0; this.boostT = 0; this.boostV = 0;
        this.knocked = false; this.landed = 0;
        /** Последний выброс батута (для звука/частиц): сбрасывает игра. */
        this.bounced = false;
    }

    /** Поставить на точку (возрождение, старт): скорость обнуляется, опора ищется сразу. */
    place(x, y, z, yaw) {
        this.x = x; this.y = y; this.z = z;
        if (yaw != null) this.yaw = yaw;
        this.vx = this.vy = this.vz = 0; this.speed = 0;
        this.grounded = false; this.support = null; this.ice = false;
        this.airTime = 0; this.coyote = 0; this.jumpBuf = 0; this.boostT = 0; this.knocked = false; this.bounced = false;
        this._probe(0);
    }

    /** Центр тела (для запросов опасностей): ноги + половина роста. */
    centerY() { return this.y + this.height / 2; }

    /** Выбить: скорость уходит в полёт, управление отключено до place(). */
    knock(vx, vy, vz) {
        this.vx = vx; this.vy = vy; this.vz = vz;
        this.knocked = true; this.grounded = false; this.support = null;
    }

    /** Кадр. dt режется на подшаги по cfg.sub. */
    step(dt, cmd) {
        const c = cmd || {};
        dt = Math.min(0.1, Math.max(0, dt || 0));
        if (c.jump) this.jumpBuf = this.cfg.buffer;
        // опора унесла за кадр (движущаяся плита, диск): один раз по точным позам, до подшагов
        if (this.grounded && this.support && dt > 0) {
            const t1 = this.course.time, d = this.course.carry(this.support, [this.x, this.y, this.z], t1 - dt, t1);
            this.x += d[0]; this.y += d[1]; this.z += d[2];
        }
        const n = Math.max(1, Math.ceil(dt / this.cfg.sub));
        const h = dt / n;
        for (let i = 0; i < n; i++) this._sub(h, c);
        this.speed = this.vx * Math.cos(this.yaw) + this.vz * Math.sin(this.yaw);
    }

    _sub(h, cmd) {
        const C = this.cfg;
        // 1. желаемая скорость
        let tx = 0, tz = 0;
        if (!this.knocked) {
            let dx = cmd.dx || 0, dz = cmd.dz || 0;
            const l = Math.hypot(dx, dz);
            if (l > 1) { dx /= l; dz /= l; }
            let sp = cmd.speed != null ? cmd.speed : C.run;
            if (this.boostT > 0) { this.boostT -= h; sp = Math.max(sp, this.boostV * Math.min(1, this.boostT / 0.35)); }
            tx = dx * sp; tz = dz * sp;
            if (l > 0.05) {
                let da = Math.atan2(dz, dx) - this.yaw;
                da = Math.atan2(Math.sin(da), Math.cos(da));
                const m = C.turn * h;
                this.yaw += Math.max(-m, Math.min(m, da));
            }
        }
        const acc = this.knocked ? (this.grounded ? 1400 : 0) : (this.grounded ? (this.ice ? C.accIce : C.accGround) : C.accAir);
        const ex = tx - this.vx, ez = tz - this.vz, el = Math.hypot(ex, ez);
        if (el > 1e-6) { const k = Math.min(1, acc * h / el); this.vx += ex * k; this.vz += ez * k; }
        // 2. прыжок: запомненное нажатие + «койот»
        this.jumpBuf = Math.max(0, this.jumpBuf - h);
        this.coyote = this.grounded ? C.coyote : Math.max(0, this.coyote - h);
        if (!this.knocked && this.jumpBuf > 0 && (this.grounded || this.coyote > 0)) {
            this.vy = C.jump; this.grounded = false; this.support = null; this.coyote = 0; this.jumpBuf = 0;
        }
        // 3. гравитация и перенос
        if (!this.grounded) { this.vy = Math.max(-C.fallMax, this.vy - C.gravity * h); this.airTime += h; } else this.airTime = 0;
        this.x += this.vx * h; this.z += this.vz * h;
        if (!this.grounded) this.y += this.vy * h;
        // 4. опора под ногами (ступени, спуск, посадка)
        this._probe(h);
        // 5. стены и потолок
        this._walls();
    }

    // Опора: луч вниз от высоты ступени. Лава и вода — не опора (герой тонет в них и «убивается» игрой).
    _probe(h) {
        if (this.vy > 0 && !this.grounded) return;
        const C = this.cfg;
        const below = this.grounded ? C.snap : Math.max(0, -this.vy * h) + 2;
        const hit = this.course.rayDown(this.x, this.y + C.step, this.z, C.step + below, 0.6, true);
        if (hit && hit.y <= this.y + C.step + 0.01 && hit.y >= this.y - below - 0.01) {
            const col = hit.col;
            if (!this.grounded) this.landed = this.vy;
            this.y = hit.y;
            this.vy = 0; this.grounded = true; this.support = col; this.ice = !!col.ice;
            this.course.touch(col);
            if (col.jump) { this.vy = col.jump; this.grounded = false; this.support = null; this.bounced = true; this.knocked = false; }
            else if (col.boost) {
                const a = col.ax, l = Math.hypot(a[0], a[2]) || 1;
                this.boostT = 0.9; this.boostV = col.boost;
                this.vx = a[0] / l * col.boost; this.vz = a[2] / l * col.boost;
            }
        } else if (this.grounded) {
            this.grounded = false; this.support = null;
        }
    }

    // Стены: капсула выше ступени; пол обрабатывает _probe, потолок бьёт голову.
    _walls() {
        const C = this.cfg, r = this.radius;
        for (let it = 0; it < 3; it++) {
            let any = false;
            this.course.capsule(this.x, this.y + C.step + r, this.z, this.x, this.y + Math.max(C.step + r, this.height - r), this.z, r, (k) => {
                const col = k.col;
                if (col.kill || col.hazard || col.boost || col.jump) return;
                const n = k.n;
                if (n[1] > 0.6) return;
                if (n[1] < -0.5) { this.y += n[1] * k.depth; if (this.vy > 0) this.vy = 0; any = true; return; }
                const l = Math.hypot(n[0], n[2]) || 1, nx = n[0] / l, nz = n[2] / l;
                this.x += nx * k.depth / l; this.z += nz * k.depth / l;
                const vn = this.vx * nx + this.vz * nz;
                if (vn < 0) { this.vx -= vn * nx; this.vz -= vn * nz; }
                any = true;
            });
            if (!any) break;
        }
    }
}
