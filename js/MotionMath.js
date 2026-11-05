// MotionMath.js — векторы, кватернионы и пружины для персонажа (Humanoid, MotionMatch, CharacterPhysics, Ragdoll).
// Глобал называется GM (короткое имя: в горячем коде его пишут сотни раз). Чистая математика, без Babylon.
//
// СОГЛАШЕНИЯ. Мир правосторонний, Y вверх (как в сцене движка: карта (x, y) = мир (x, z)).
// Вектор — массив [x, y, z], кватернион — [x, y, z, w] (или Float32/64Array). Персонаж: нос вдоль +X, верх +Y,
// правая рука +Z. Курс θ — как в Maps.js и Rig: atan2(vy, vx) в плоскости карты (карта y = мир z):
// «вперёд» = (cos θ, 0, sin θ), поворот курса = Ry(−θ) (rotation.y = −heading, как у Location3D.placeObject).
//
// БЕЗ ВЫДЕЛЕНИЙ ПАМЯТИ. Функции пишут результат в ПЕРВЫЙ аргумент `o` и возвращают его; `o` может совпадать с
// другими аргументами — значения читаются в локальные переменные заранее. Временные буферы GM._t0.. — только
// внутри одной функции, не через вызовы.
//
// ПРУЖИНЫ — по статьям Daniel Holden (theorangeduck.com: «Spring-It-On», «Code vs Data Driven Displacement»,
// «Dead Blending»): halflife — время, за которое пружина проходит половину пути. Критически демпфированные пружины
// считаются в замкнутом виде, поэтому шаг любой длины даёт тот же результат, что и сумма мелких (тест
// tests/motion.test.mjs). springChar — «пружина персонажа»: скорость v догоняет цель, a — состояние ускорения; ей
// же растёт корень в базе движений (MotionMatch) и бежит капсула (CharacterPhysics): прогноз траектории и сам
// бегун говорят на одном языке.

/** @satisfies {Record<string, any>} */
const GM = {
    EPS: 1e-8,
    DEG: Math.PI / 180,

    clamp(x, a, b) { return x < a ? a : x > b ? b : x; },
    lerp(a, b, t) { return a + (b - a) * t; },
    smooth(t) { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); },
    smoother(t) { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * t * (t * (6 * t - 15) + 10); },
    // Угол в (−π, π].
    wrap(a) {
        a = (a + Math.PI) % (2 * Math.PI);
        if (a < 0) a += 2 * Math.PI;
        return a - Math.PI;
    },
    frac(x) { return x - Math.floor(x); },

    // ---- векторы -------------------------------------------------------------------------------
    v(x, y, z) { return [x || 0, y || 0, z || 0]; },
    set(o, x, y, z) { o[0] = x; o[1] = y; o[2] = z; return o; },
    copy(o, a) { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; return o; },
    add(o, a, b) { o[0] = a[0] + b[0]; o[1] = a[1] + b[1]; o[2] = a[2] + b[2]; return o; },
    sub(o, a, b) { o[0] = a[0] - b[0]; o[1] = a[1] - b[1]; o[2] = a[2] - b[2]; return o; },
    scale(o, a, s) { o[0] = a[0] * s; o[1] = a[1] * s; o[2] = a[2] * s; return o; },
    // o = a + b·s
    adds(o, a, b, s) { o[0] = a[0] + b[0] * s; o[1] = a[1] + b[1] * s; o[2] = a[2] + b[2] * s; return o; },
    vlerp(o, a, b, t) { o[0] = a[0] + (b[0] - a[0]) * t; o[1] = a[1] + (b[1] - a[1]) * t; o[2] = a[2] + (b[2] - a[2]) * t; return o; },
    dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; },
    cross(o, a, b) {
        const ax = a[0], ay = a[1], az = a[2], bx = b[0], by = b[1], bz = b[2];
        o[0] = ay * bz - az * by; o[1] = az * bx - ax * bz; o[2] = ax * by - ay * bx;
        return o;
    },
    len(a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); },
    dist(a, b) { const x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2]; return Math.sqrt(x * x + y * y + z * z); },
    norm(o, a) {
        const l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
        if (l < 1e-12) { o[0] = 0; o[1] = 0; o[2] = 0; return o; }
        o[0] = a[0] / l; o[1] = a[1] / l; o[2] = a[2] / l;
        return o;
    },

    // ---- кватернионы ---------------------------------------------------------------------------
    q() { return [0, 0, 0, 1]; },
    qset(o, x, y, z, w) { o[0] = x; o[1] = y; o[2] = z; o[3] = w; return o; },
    qcopy(o, a) { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; o[3] = a[3]; return o; },
    qid(o) { o[0] = 0; o[1] = 0; o[2] = 0; o[3] = 1; return o; },
    // o = a · b (сначала b, потом a — как матрицы на столбцах)
    qmul(o, a, b) {
        const ax = a[0], ay = a[1], az = a[2], aw = a[3], bx = b[0], by = b[1], bz = b[2], bw = b[3];
        o[0] = aw * bx + ax * bw + ay * bz - az * by;
        o[1] = aw * by - ax * bz + ay * bw + az * bx;
        o[2] = aw * bz + ax * by - ay * bx + az * bw;
        o[3] = aw * bw - ax * bx - ay * by - az * bz;
        return o;
    },
    // o = a⁻¹ · b
    qinvmul(o, a, b) {
        const ax = -a[0], ay = -a[1], az = -a[2], aw = a[3], bx = b[0], by = b[1], bz = b[2], bw = b[3];
        o[0] = aw * bx + ax * bw + ay * bz - az * by;
        o[1] = aw * by - ax * bz + ay * bw + az * bx;
        o[2] = aw * bz + ax * by - ay * bx + az * bw;
        o[3] = aw * bw - ax * bx - ay * by - az * bz;
        return o;
    },
    // o = a · b⁻¹
    qmulinv(o, a, b) {
        const ax = a[0], ay = a[1], az = a[2], aw = a[3], bx = -b[0], by = -b[1], bz = -b[2], bw = b[3];
        o[0] = aw * bx + ax * bw + ay * bz - az * by;
        o[1] = aw * by - ax * bz + ay * bw + az * bx;
        o[2] = aw * bz + ax * by - ay * bx + az * bw;
        o[3] = aw * bw - ax * bx - ay * by - az * bz;
        return o;
    },
    qconj(o, a) { o[0] = -a[0]; o[1] = -a[1]; o[2] = -a[2]; o[3] = a[3]; return o; },
    qnorm(o, a) {
        const l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2] + a[3] * a[3]) || 1;
        o[0] = a[0] / l; o[1] = a[1] / l; o[2] = a[2] / l; o[3] = a[3] / l;
        return o;
    },
    // Короткая дуга: w ≥ 0.
    qabs(o, a) {
        if (a[3] < 0) { o[0] = -a[0]; o[1] = -a[1]; o[2] = -a[2]; o[3] = -a[3]; }
        else if (o !== a) { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; o[3] = a[3]; }
        return o;
    },
    qdot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]; },
    // Повернуть вектор: o = q · v · q⁻¹
    qrot(o, q, v) {
        const qx = q[0], qy = q[1], qz = q[2], qw = q[3], vx = v[0], vy = v[1], vz = v[2];
        const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
        o[0] = vx + qw * tx + (qy * tz - qz * ty);
        o[1] = vy + qw * ty + (qz * tx - qx * tz);
        o[2] = vz + qw * tz + (qx * ty - qy * tx);
        return o;
    },
    // Повернуть обратным: o = q⁻¹ · v · q
    qinvrot(o, q, v) {
        const qx = -q[0], qy = -q[1], qz = -q[2], qw = q[3], vx = v[0], vy = v[1], vz = v[2];
        const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
        o[0] = vx + qw * tx + (qy * tz - qz * ty);
        o[1] = vy + qw * ty + (qz * tx - qx * tz);
        o[2] = vz + qw * tz + (qx * ty - qy * tx);
        return o;
    },
    qaxis(o, ax, ay, az, ang) {
        const s = Math.sin(ang / 2);
        o[0] = ax * s; o[1] = ay * s; o[2] = az * s; o[3] = Math.cos(ang / 2);
        return o;
    },
    qx(o, a) { return GM.qaxis(o, 1, 0, 0, a); },
    qy(o, a) { return GM.qaxis(o, 0, 1, 0, a); },
    qz(o, a) { return GM.qaxis(o, 0, 0, 1, a); },
    // Курс θ -> поворот Ry(−θ): нос +X смотрит на (cos θ, 0, sin θ).
    qheading(o, th) { return GM.qaxis(o, 0, 1, 0, -th); },
    // Курс поворота: куда смотрит его +X в плоскости XZ.
    headingOf(q) {
        const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
        const fx = 1 - 2 * (qy * qy + qz * qz), fz = 2 * (qx * qz - qw * qy);
        return Math.atan2(fz, fx);
    },
    // Локальные углы Эйлера: o = Ry(yaw)·Rz(pitch)·Rx(roll) — «повернуть, наклонить вперёд-назад, вбок».
    qeuler(o, yaw, pitch, roll) {
        const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
        const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
        const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2);
        // Ry·Rz
        const ax = sy * sp, ay = sy * cp, az = cy * sp, aw = cy * cp;
        // (Ry·Rz)·Rx
        o[0] = aw * sr + ax * cr;
        o[1] = ay * cr + az * sr;
        o[2] = az * cr - ay * sr;
        o[3] = aw * cr - ax * sr;
        return o;
    },
    qslerp(o, a, b, t) {
        let bx = b[0], by = b[1], bz = b[2], bw = b[3];
        let d = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
        if (d < 0) { d = -d; bx = -bx; by = -by; bz = -bz; bw = -bw; }
        let s0, s1;
        if (d > 0.9995) { s0 = 1 - t; s1 = t; }
        else {
            const th = Math.acos(d), st = Math.sin(th);
            s0 = Math.sin((1 - t) * th) / st; s1 = Math.sin(t * th) / st;
        }
        o[0] = s0 * a[0] + s1 * bx; o[1] = s0 * a[1] + s1 * by; o[2] = s0 * a[2] + s1 * bz; o[3] = s0 * a[3] + s1 * bw;
        return GM.qnorm(o, o);
    },
    // Поворот как вектор «угол × ось» (scaled angle axis); q считается коротким (w ≥ 0 — qabs заранее).
    qlog(o, q) {
        const x = q[0], y = q[1], z = q[2];
        const l = Math.sqrt(x * x + y * y + z * z);
        if (l < 1e-9) { o[0] = 2 * x; o[1] = 2 * y; o[2] = 2 * z; return o; }
        const half = Math.acos(GM.clamp(q[3], -1, 1));
        const k = 2 * half / l;
        o[0] = x * k; o[1] = y * k; o[2] = z * k;
        return o;
    },
    qexp(o, v) {
        const hx = v[0] / 2, hy = v[1] / 2, hz = v[2] / 2;
        const h = Math.sqrt(hx * hx + hy * hy + hz * hz);
        if (h < 1e-9) { o[0] = hx; o[1] = hy; o[2] = hz; o[3] = 1; return GM.qnorm(o, o); }
        const s = Math.sin(h) / h;
        o[0] = hx * s; o[1] = hy * s; o[2] = hz * s; o[3] = Math.cos(h);
        return o;
    },
    // Поворот из ортонормированного базиса: локальные X, Y, Z модели -> мировые векторы x, y, z.
    qbasis(o, x, y, z) {
        const m00 = x[0], m10 = x[1], m20 = x[2], m01 = y[0], m11 = y[1], m21 = y[2], m02 = z[0], m12 = z[1], m22 = z[2];
        const tr = m00 + m11 + m22;
        if (tr > 0) {
            const s = 0.5 / Math.sqrt(tr + 1);
            o[3] = 0.25 / s; o[0] = (m21 - m12) * s; o[1] = (m02 - m20) * s; o[2] = (m10 - m01) * s;
        } else if (m00 > m11 && m00 > m22) {
            const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
            o[3] = (m21 - m12) / s; o[0] = 0.25 * s; o[1] = (m01 + m10) / s; o[2] = (m02 + m20) / s;
        } else if (m11 > m22) {
            const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
            o[3] = (m02 - m20) / s; o[0] = (m01 + m10) / s; o[1] = 0.25 * s; o[2] = (m12 + m21) / s;
        } else {
            const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
            o[3] = (m10 - m01) / s; o[0] = (m02 + m20) / s; o[1] = (m12 + m21) / s; o[2] = 0.25 * s;
        }
        return GM.qnorm(o, o);
    },
    // Базис по направлению «вниз по кости» d (локальная −Y) и подсказке «вперёд» f (локальная +X).
    // Правая (+Z) = вперёд × верх.
    qlimb(o, d, f) {
        const yx = -d[0], yy = -d[1], yz = -d[2];
        const k = f[0] * yx + f[1] * yy + f[2] * yz;
        let xx = f[0] - yx * k, xy = f[1] - yy * k, xz = f[2] - yz * k;
        let l = Math.sqrt(xx * xx + xy * xy + xz * xz);
        if (l < 1e-6) {   // подсказка вдоль кости — берём любую перпендикулярную
            xx = Math.abs(yy) < 0.9 ? 0 : 1; xy = Math.abs(yy) < 0.9 ? 1 : 0; xz = 0;
            const k2 = xx * yx + xy * yy + xz * yz; xx -= yx * k2; xy -= yy * k2; xz -= yz * k2;
            l = Math.sqrt(xx * xx + xy * xy + xz * xz);
        }
        xx /= l; xy /= l; xz /= l;
        const _x = GM._t0, _y = GM._t1, _z = GM._t2;
        _x[0] = xx; _x[1] = xy; _x[2] = xz;
        _y[0] = yx; _y[1] = yy; _y[2] = yz;
        GM.cross(_z, _x, _y);
        return GM.qbasis(o, _x, _y, _z);
    },
    // Базис по направлению «вниз по кости» d (локальная −Y) и оси сгиба z (локальная +Z, вправо):
    // устойчив, когда кость смотрит вперёд (подсказка «вперёд» там вырождается).
    qlimbZ(o, d, zh) {
        const yx = -d[0], yy = -d[1], yz = -d[2];
        const k = zh[0] * yx + zh[1] * yy + zh[2] * yz;
        let zx = zh[0] - yx * k, zy = zh[1] - yy * k, zz = zh[2] - yz * k;
        let l = Math.sqrt(zx * zx + zy * zy + zz * zz);
        if (l < 1e-6) { zx = 0; zy = 0; zz = 1; const k2 = yz; zx -= yx * k2; zy -= yy * k2; zz -= yz * k2; l = Math.sqrt(zx * zx + zy * zy + zz * zz) || 1; }
        zx /= l; zy /= l; zz /= l;
        const _x = GM._t0, _y = GM._t1, _z = GM._t2;
        _y[0] = yx; _y[1] = yy; _y[2] = yz;
        _z[0] = zx; _z[1] = zy; _z[2] = zz;
        GM.cross(_x, _y, _z);
        return GM.qbasis(o, _x, _y, _z);
    },
    // Кратчайший поворот вектора u в v (оба единичные).
    qbetween(o, u, v) {
        const d = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
        if (d < -0.999999) {
            const ax = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
            const c = GM.norm([0, 0, 0], GM.cross([0, 0, 0], u, ax));
            return GM.qaxis(o, c[0], c[1], c[2], Math.PI);
        }
        o[0] = u[1] * v[2] - u[2] * v[1];
        o[1] = u[2] * v[0] - u[0] * v[2];
        o[2] = u[0] * v[1] - u[1] * v[0];
        o[3] = 1 + d;
        return GM.qnorm(o, o);
    },
    // Угловая скорость (мировая, рад/с) из двух поворотов: next = exp(ω dt) · cur.
    qangvel(o, next, cur, dt) {
        const t = GM.qmulinv(GM._q0, next, cur);
        GM.qabs(t, t);
        GM.qlog(o, t);
        return GM.scale(o, o, 1 / Math.max(1e-6, dt));
    },

    // ---- пружины -------------------------------------------------------------------------------
    halflifeToDamping(h) { return (4 * Math.LN2) / (h + 1e-5); },
    // Доля пути, которую «демпфер» проходит за dt: x += (goal − x)·k.
    damperK(halflife, dt) { return 1 - Math.exp(-Math.LN2 * dt / (halflife + 1e-5)); },
    damper(x, goal, halflife, dt) { return x + (goal - x) * GM.damperK(halflife, dt); },
    // Затухание смещения критически демпфированной пружиной (инерциализация): st = [x, v], на месте.
    decay(st, i, halflife, dt) {
        const y = GM.halflifeToDamping(halflife) / 2;
        const x = st[i], v = st[i + 1];
        const j1 = v + x * y, e = Math.exp(-y * dt);
        st[i] = e * (x + j1 * dt);
        st[i + 1] = e * (v - j1 * y * dt);
    },
    // Пружина персонажа (Holden, spring_character_update): скорость v догоняет цель vg критически
    // демпфированно, a — состояние ускорения. Возвращает смещение позиции за dt; s = { v, a } на месте.
    springChar(s, vg, halflife, dt) {
        const y = GM.halflifeToDamping(halflife) / 2;
        const j0 = s.v - vg, j1 = s.a + j0 * y, e = Math.exp(-y * dt);
        const dx = e * ((-j1) / (y * y) + (-j0 - j1 * dt) / y) + j1 / (y * y) + j0 / y + vg * dt;
        s.v = e * (j0 + j1 * dt) + vg;
        s.a = e * (s.a - j1 * y * dt);
        return dx;
    },
    // Пружина угла (курс): s = { x: угол, v: угловая скорость }, цель g, на месте.
    springAngle(s, g, halflife, dt) {
        const y = GM.halflifeToDamping(halflife) / 2;
        const j0 = GM.wrap(s.x - g), j1 = s.v + j0 * y, e = Math.exp(-y * dt);
        s.x = GM.wrap(e * (j0 + j1 * dt) + g);
        s.v = e * (s.v - j1 * y * dt);
    },
    // Пружина значения с заданной частотой и затуханием (для вторичной физики): st = [x, v].
    // Явный шаг не крупнее 1/240 с: устойчива при любом dt кадра.
    springTo(st, i, goal, freq, zeta, dt) {
        const w = 2 * Math.PI * freq;
        const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
        const h = dt / steps;
        for (let k = 0; k < steps; k++) {
            const a = -w * w * (st[i] - goal) - 2 * zeta * w * st[i + 1];
            st[i + 1] += a * h;
            st[i] += st[i + 1] * h;
        }
    },

    // ГСЧ с сидом (mulberry32): база движений одинакова при каждом запуске.
    rng(seed) {
        let a = seed >>> 0;
        return () => {
            a = (a + 0x6D2B79F5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    },

    // Временные буферы (только внутри одной функции, не через вызовы).
    _t0: [0, 0, 0], _t1: [0, 0, 0], _t2: [0, 0, 0], _q0: [0, 0, 0, 1],
};
