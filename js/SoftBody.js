// SoftBody.js — кузов машины как сетка узлов и балок (node-beam, как в BeamNG.drive). Узлы — точечные массы, балки —
// пружины с пределом текучести: сверх предела длина покоя уходит навсегда (вмятина), сверх предела разрыва балка рвётся.
// Интегратор — симплектический Эйлер ~1000 Гц: при фиксированных k/m устойчивость не зависит от силы удара, а сила балки
// ограничена текучестью. Контакт — точечные сферы узлов против земли (GameWorld), коллайдеров (ObbyCourse), предметов
// (Props) и узлов других машин: снимается скорость в поверхность, ставится трение, всё пишется в счётчики контактов.
//
// Связь с машиной (GameCar): водительская физика остаётся лучевой машиной на твёрдом теле, а тело берёт состояние из узлов.
// pull() — центр, поворот (shape matching по узлам ядра), скорость и угловая скорость из импульса узлов;
// push() — всё, что сделали шины, подвеска и сила тяжести, ложится на узлы жёстким полем скоростей, поэтому езда балки не
// нагружает и не трясёт, напрягают их только столкновения. Без контакта тело спит: сетка не считается, машина — чистое
// твёрдое тело с замороженной формой; перед касанием (checkWake) сетка просыпается без скачка.
// Состояние — мир Babylon, px, кг. Babylon здесь нет: считается и в node (tests/, tools/).

const SOFT_HULL = 1;      // узел обшивки: участвует в контакте
const SOFT_WHEEL = 2;     // ступица: контакт только со стенами, опора — дело лучей колёс
const SOFT_LOOSE = 4;     // панель болтается: не получает жёсткого поля, только тяжесть, балки и воздух
const SOFT_OFF = 8;       // оторван: не считается

const SOFT_SURF_NONE = 0, SOFT_SURF_GROUND = 1, SOFT_SURF_SOLID = 2, SOFT_SURF_PROP = 3, SOFT_SURF_CAR = 4;

class SoftBody {
    /**
     * @param {any} def описание сетки CarLattice.build: nodes [{x,y,z,m,r,flags,core,part}], beams [{a,b,k,c,yc,yt,brk,zone}]
     * @param {{ comH: number, zones?: number }} opts
     */
    constructor(def, opts) {
        const N = this.n = def.nodes.length, M = this.nb = def.beams.length;
        this.def = def;
        this.comH = opts.comH;
        const F = (n) => new Float64Array(n);
        this.x = F(N); this.y = F(N); this.z = F(N);
        this.vx = F(N); this.vy = F(N); this.vz = F(N);
        this.fx = F(N); this.fy = F(N); this.fz = F(N);
        this.lx = F(N); this.ly = F(N); this.lz = F(N);        // форма в осях машины (замороженная во сне)
        this.rx = F(N); this.ry = F(N); this.rz = F(N);        // исходная форма
        this.m = F(N); this.im = F(N); this.rad = F(N);
        this.flag = new Uint8Array(N);
        this.dmg = F(N);                                       // накопленная пластика узла (доли длины балки)
        // контакты за кадр (читает CarDamage и сбрасывает)
        this.cImp = F(N); this.cSlip = F(N);
        this.cNx = F(N); this.cNy = F(N); this.cNz = F(N);
        this.cVx = F(N); this.cVy = F(N); this.cVz = F(N);
        this.cSurf = new Uint8Array(N);
        /** @type {any[]} */ this.cRef = new Array(N).fill(null);
        for (let i = 0; i < N; i++) {
            const d = def.nodes[i];
            this.rx[i] = this.lx[i] = d.x; this.ry[i] = this.ly[i] = d.y; this.rz[i] = this.lz[i] = d.z;
            this.m[i] = d.m; this.im[i] = 1 / d.m; this.rad[i] = d.r; this.flag[i] = d.flags | 0;
        }
        this.A = new Int32Array(M); this.B = new Int32Array(M);
        this.L0 = F(M); this.Lo = F(M); this.K = F(M); this.C = F(M); this.YC = F(M); this.YX = F(M); this.YT = F(M); this.BRK = F(M); this.BRC = F(M);
        this.zone = new Uint8Array(M);
        this.alive = new Uint8Array(M).fill(1);
        this.bl = new Int32Array(M);
        this.nAlive = M;
        for (let b = 0; b < M; b++) {
            const d = def.beams[b], a = d.a, c = d.b;
            this.A[b] = a; this.B[b] = c;
            const L = Math.hypot(this.rx[a] - this.rx[c], this.ry[a] - this.ry[c], this.rz[a] - this.rz[c]) || 1;
            this.L0[b] = this.Lo[b] = L;
            this.K[b] = d.k; this.C[b] = d.c; this.YC[b] = d.yc; this.YX[b] = d.yc * 3.5; this.YT[b] = d.yt; this.BRK[b] = d.brk; this.BRC[b] = d.brc || 0;
            this.zone[b] = d.zone | 0;
            this.bl[b] = b;
        }
        this.deg = new Int16Array(N);      // сколько живых балок у узла
        for (let b = 0; b < M; b++) { this.deg[this.A[b]]++; this.deg[this.B[b]]++; }
        /** @type {number[]} */ this.orphans = [];   // узлы, потерявшие опору (отключены)
        this.zones = F(8);                 // пластическая работа по зонам
        this.energy = 0;                   // вся пластическая работа
        /** @type {number[]} */ this.broken = [];    // индексы балок, порванных с последнего чтения
        // множества
        this.hull = Int32Array.from(def.nodes.map((d, i) => (d.flags & (SOFT_HULL | SOFT_WHEEL) ? i : -1)).filter(i => i >= 0));
        this.core = Int32Array.from(def.nodes.map((d, i) => (d.core ? i : -1)).filter(i => i >= 0));
        this.R0 = 0;                       // радиус описанной сферы
        for (let i = 0; i < N; i++) this.R0 = Math.max(this.R0, Math.hypot(this.rx[i], this.ry[i] - opts.comH, this.rz[i]) + this.rad[i]);
        this._massProps();
        // центр ядра в исходной форме: от него считается поворот
        let w = 0, cx = 0, cy = 0, cz = 0;
        for (const i of this.core) { const m = this.m[i]; w += m; cx += this.rx[i] * m; cy += this.ry[i] * m; cz += this.rz[i] * m; }
        this.coreW = w; this.cc = [cx / w, cy / w, cz / w];
        this.q = [0, 0, 0, 1];
        this.awake = false;
        this.quietT = 0; this.touching = false; this.killHit = false; this.anyLoose = false; this.dirty = false;
        this.maxLocal = 0; this.keepAwake = false;
        this.hz = typeof SOFT_HZ !== 'undefined' ? SOFT_HZ : 960;
        this.mu = typeof SOFT_FRICTION !== 'undefined' ? SOFT_FRICTION : 0.42;
        this.rest = typeof SOFT_RESTITUTION !== 'undefined' ? SOFT_RESTITUTION : 0.03;
        this.airDrag = typeof SOFT_LOOSE_AIR !== 'undefined' ? SOFT_LOOSE_AIR : 0.9;
        this.sleepAfter = typeof SOFT_SLEEP_SEC !== 'undefined' ? SOFT_SLEEP_SEC : 0.45;
        /** @type {any[]} */ this.cols = [];    // коллайдеры рядом (обновляются реже подшагов)
        /** @type {any[]} */ this.props = [];   // предметы рядом
        this._nearT = 0;
        this.aabb = [0, 0, 0, 0, 0, 0];
        this._tmp = [0, 0, 0];
        this._vel = [0, 0, 0];
        this._res = { nx: 0, ny: 0, nz: 0, depth: 0, jn: 0, jx: 0, jy: 0, jz: 0 };
        this._hit = { nx: 0, ny: 0, nz: 0, d: 0, qx: 0, qy: 0, qz: 0 };
    }

    // Масса, центр и момент инерции (диагональ в осях машины) по неоторванным узлам.
    _massProps() {
        let M = 0, cx = 0, cy = 0, cz = 0;
        const n = this.n, fl = this.flag;
        for (let i = 0; i < n; i++) { if (fl[i] & SOFT_OFF) continue; const m = this.m[i]; M += m; cx += this.lx[i] * m; cy += this.ly[i] * m; cz += this.lz[i] * m; }
        M = M || 1;
        cx /= M; cy /= M; cz /= M;
        let Ix = 0, Iy = 0, Iz = 0;
        for (let i = 0; i < n; i++) {
            if (fl[i] & SOFT_OFF) continue;
            const m = this.m[i], x = this.lx[i] - cx, y = this.ly[i] - cy, z = this.lz[i] - cz;
            Ix += m * (y * y + z * z); Iy += m * (x * x + z * z); Iz += m * (x * x + y * y);
        }
        this.M = M; this.com = [cx, cy, cz];
        this.Ix = Ix || 1; this.Iy = Iy || 1; this.Iz = Iz || 1;
    }

    /** Масса кузова и узла i (кг) для внешних импульсов. */
    invMassOf(i) { return this.im[i]; }

    // ---------------------------------------------------------------------------------------------
    // Твёрдое тело <-> узлы
    // ---------------------------------------------------------------------------------------------

    /** Разбудить: узлы из позы машины и поля скоростей твёрдого тела. */
    wake(car) {
        if (this.awake) return;
        this.awake = true;
        this.quietT = 0;
        const q = car.q, C = car.c, v = car.v, w = car.w, H = this.comH, n = this.n, fl = this.flag;
        this.q[0] = q[0]; this.q[1] = q[1]; this.q[2] = q[2]; this.q[3] = q[3];
        const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
        for (let i = 0; i < n; i++) {
            if (fl[i] & SOFT_OFF) continue;
            const x = this.lx[i], y = this.ly[i] - H, z = this.lz[i];
            const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
            const rx = x + qw * tx + (qy * tz - qz * ty), ry = y + qw * ty + (qz * tx - qx * tz), rz = z + qw * tz + (qx * ty - qy * tx);
            this.x[i] = C[0] + rx; this.y[i] = C[1] + ry; this.z[i] = C[2] + rz;
            this.vx[i] = v[0] + w[1] * rz - w[2] * ry;
            this.vy[i] = v[1] + w[2] * rx - w[0] * rz;
            this.vz[i] = v[2] + w[0] * ry - w[1] * rx;
        }
        this._massProps();
        this._nearT = 0;
    }

    /** Усыпить: форма замораживается в осях машины, дальше машина — твёрдое тело. */
    sleep(car) {
        if (!this.awake) return;
        this._toLocal(car);
        this.awake = false;
        this.quietT = 0;
    }

    _toLocal(car) {
        const q = car.q, C = car.c, H = this.comH, n = this.n, fl = this.flag;
        const qx = -q[0], qy = -q[1], qz = -q[2], qw = q[3];
        for (let i = 0; i < n; i++) {
            if (fl[i] & SOFT_OFF) continue;
            const x = this.x[i] - C[0], y = this.y[i] - C[1], z = this.z[i] - C[2];
            const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
            this.lx[i] = x + qw * tx + (qy * tz - qz * ty);
            this.ly[i] = y + qw * ty + (qz * tx - qx * tz) + H;
            this.lz[i] = z + qw * tz + (qx * ty - qy * tx);
        }
    }

    /** Состояние машины из узлов: поворот — shape matching по ядру, скорость и вращение — из импульса. */
    pull(car) {
        const n = this.n, fl = this.flag, m = this.m, x = this.x, y = this.y, z = this.z, vx = this.vx, vy = this.vy, vz = this.vz;
        // центр и импульс всех прикреплённых узлов
        let M = 0, cx = 0, cy = 0, cz = 0, px = 0, py = 0, pz = 0;
        for (let i = 0; i < n; i++) {
            if (fl[i] & (SOFT_OFF | SOFT_LOOSE)) continue;
            const w = m[i];
            M += w; cx += x[i] * w; cy += y[i] * w; cz += z[i] * w; px += vx[i] * w; py += vy[i] * w; pz += vz[i] * w;
        }
        M = M || 1; cx /= M; cy /= M; cz /= M; px /= M; py /= M; pz /= M;
        // центр ядра и матрица A = Σ m (x - xc)(X - Xc)^T
        const core = this.core, W = this.coreW, cc = this.cc;
        let gx = 0, gy = 0, gz = 0;
        for (let k = 0; k < core.length; k++) { const i = core[k], w = m[i]; gx += x[i] * w; gy += y[i] * w; gz += z[i] * w; }
        gx /= W; gy /= W; gz /= W;
        let a00 = 0, a01 = 0, a02 = 0, a10 = 0, a11 = 0, a12 = 0, a20 = 0, a21 = 0, a22 = 0;
        for (let k = 0; k < core.length; k++) {
            const i = core[k], w = m[i], ax = (x[i] - gx) * w, ay = (y[i] - gy) * w, az = (z[i] - gz) * w;
            const bx = this.rx[i] - cc[0], by = this.ry[i] - cc[1], bz = this.rz[i] - cc[2];
            a00 += ax * bx; a01 += ax * by; a02 += ax * bz;
            a10 += ay * bx; a11 += ay * by; a12 += ay * bz;
            a20 += az * bx; a21 += az * by; a22 += az * bz;
        }
        // поворот (Müller et al. 2016): несколько итераций от прошлого кватерниона
        const q = this.q;
        for (let it = 0; it < 4; it++) {
            const X = q[0], Y = q[1], Z = q[2], Q = q[3];
            const r00 = 1 - 2 * (Y * Y + Z * Z), r01 = 2 * (X * Y - Z * Q), r02 = 2 * (X * Z + Y * Q);
            const r10 = 2 * (X * Y + Z * Q), r11 = 1 - 2 * (X * X + Z * Z), r12 = 2 * (Y * Z - X * Q);
            const r20 = 2 * (X * Z - Y * Q), r21 = 2 * (Y * Z + X * Q), r22 = 1 - 2 * (X * X + Y * Y);
            // ω = Σ r_i × a_i / (|Σ r_i·a_i| + eps), столбцы
            const ox = (r10 * a20 - r20 * a10) + (r11 * a21 - r21 * a11) + (r12 * a22 - r22 * a12);
            const oy = (r20 * a00 - r00 * a20) + (r21 * a01 - r01 * a21) + (r22 * a02 - r02 * a22);
            const oz = (r00 * a10 - r10 * a00) + (r01 * a11 - r11 * a01) + (r02 * a12 - r12 * a02);
            const dn = Math.abs(r00 * a00 + r10 * a10 + r20 * a20 + r01 * a01 + r11 * a11 + r21 * a21 + r02 * a02 + r12 * a12 + r22 * a22) + 1e-6;
            const wx = ox / dn, wy = oy / dn, wz = oz / dn, ang = Math.hypot(wx, wy, wz);
            if (ang < 1e-7) break;
            const s = Math.sin(ang / 2) / ang, c = Math.cos(ang / 2), dx = wx * s, dy = wy * s, dz = wz * s;
            const nx = c * X + dx * Q + dy * Z - dz * Y;
            const ny = c * Y + dy * Q + dz * X - dx * Z;
            const nz = c * Z + dz * Q + dx * Y - dy * X;
            const nw = c * Q - dx * X - dy * Y - dz * Z;
            const l = Math.hypot(nx, ny, nz, nw) || 1;
            q[0] = nx / l; q[1] = ny / l; q[2] = nz / l; q[3] = nw / l;
        }
        // оси машины
        const X = q[0], Y = q[1], Z = q[2], Q = q[3];
        const fx = 1 - 2 * (Y * Y + Z * Z), fy = 2 * (X * Y + Z * Q), fz = 2 * (X * Z - Y * Q);       // столбец x
        const ux = 2 * (X * Y - Z * Q), uy = 1 - 2 * (X * X + Z * Z), uz = 2 * (Y * Z + X * Q);       // столбец y
        const rx = 2 * (X * Z + Y * Q), ry = 2 * (Y * Z - X * Q), rz = 1 - 2 * (X * X + Y * Y);       // столбец z
        // момент импульса относительно центра, угловая скорость через инерцию сетки
        let Lx = 0, Ly = 0, Lz = 0, maxLoc = 0;
        for (let i = 0; i < n; i++) {
            if (fl[i] & (SOFT_OFF | SOFT_LOOSE)) continue;
            const w = m[i], ax = x[i] - cx, ay = y[i] - cy, az = z[i] - cz, bx = vx[i] - px, by = vy[i] - py, bz = vz[i] - pz;
            Lx += w * (ay * bz - az * by); Ly += w * (az * bx - ax * bz); Lz += w * (ax * by - ay * bx);
        }
        const lf = (Lx * fx + Ly * fy + Lz * fz) / this.Ix, lu = (Lx * ux + Ly * uy + Lz * uz) / this.Iy, lr = (Lx * rx + Ly * ry + Lz * rz) / this.Iz;
        const wx = fx * lf + ux * lu + rx * lr, wy = fy * lf + uy * lu + ry * lr, wz = fz * lf + uz * lu + rz * lr;
        // насколько сетка ещё движется относительно твёрдого тела (для сна)
        for (let i = 0; i < n; i++) {
            if (fl[i] & (SOFT_OFF | SOFT_LOOSE)) continue;
            const ax = x[i] - cx, ay = y[i] - cy, az = z[i] - cz;
            const dvx = vx[i] - px - (wy * az - wz * ay), dvy = vy[i] - py - (wz * ax - wx * az), dvz = vz[i] - pz - (wx * ay - wy * ax);
            const d2 = dvx * dvx + dvy * dvy + dvz * dvz;
            if (d2 > maxLoc) maxLoc = d2;
        }
        this.maxLocal = Math.sqrt(maxLoc);
        // опорная точка машины — (0, comH, 0) в осях модели
        const ox = -cc[0], oy = this.comH - cc[1], oz = -cc[2];
        const Cx = gx + fx * ox + ux * oy + rx * oz, Cy = gy + fy * ox + uy * oy + ry * oz, Cz = gz + fz * ox + uz * oy + rz * oz;
        car.c[0] = Cx; car.c[1] = Cy; car.c[2] = Cz;
        const dx = Cx - cx, dy = Cy - cy, dz = Cz - cz;
        car.v[0] = px + wy * dz - wz * dy;
        car.v[1] = py + wz * dx - wx * dz;
        car.v[2] = pz + wx * dy - wy * dx;
        car.w[0] = wx; car.w[1] = wy; car.w[2] = wz;
        car.q[0] = q[0]; car.q[1] = q[1]; car.q[2] = q[2]; car.q[3] = q[3];
        this.aabbFrom();
    }

    aabbFrom() {
        const n = this.n, fl = this.flag, x = this.x, y = this.y, z = this.z, bb = this.aabb;
        let a = Infinity, b = Infinity, c = Infinity, d = -Infinity, e = -Infinity, f = -Infinity;
        for (let i = 0; i < n; i++) {
            if (fl[i] & SOFT_OFF) continue;
            const X = x[i], Y = y[i], Z = z[i];
            if (X < a) a = X; if (X > d) d = X;
            if (Y < b) b = Y; if (Y > e) e = Y;
            if (Z < c) c = Z; if (Z > f) f = Z;
        }
        bb[0] = a; bb[1] = b; bb[2] = c; bb[3] = d; bb[4] = e; bb[5] = f;
    }

    /**
     * Что сделало твёрдое тело за шаг (шины, подвеска, тяжесть, стабилизация) — на узлы: жёстким полем вокруг машины.
     * gh — приращение от тяжести: болтающимся панелям только оно.
     */
    push(car, v0, w0, c0, gh) {
        const dvx = car.v[0] - v0[0], dvy = car.v[1] - v0[1], dvz = car.v[2] - v0[2];
        const dwx = car.w[0] - w0[0], dwy = car.w[1] - w0[1], dwz = car.w[2] - w0[2];
        const dcx = car.c[0] - c0[0], dcy = car.c[1] - c0[1], dcz = car.c[2] - c0[2];
        const Cx = car.c[0], Cy = car.c[1], Cz = car.c[2];
        const n = this.n, fl = this.flag, x = this.x, y = this.y, z = this.z, vx = this.vx, vy = this.vy, vz = this.vz;
        const moved = dcx !== 0 || dcy !== 0 || dcz !== 0;
        for (let i = 0; i < n; i++) {
            const f = fl[i];
            if (f & SOFT_OFF) continue;
            if (moved) { x[i] += dcx; y[i] += dcy; z[i] += dcz; }
            if (f & SOFT_LOOSE) { vy[i] -= gh; continue; }
            const ax = x[i] - Cx, ay = y[i] - Cy, az = z[i] - Cz;
            vx[i] += dvx + dwy * az - dwz * ay;
            vy[i] += dvy + dwz * ax - dwx * az;
            vz[i] += dvz + dwx * ay - dwy * ax;
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Шаг сетки
    // ---------------------------------------------------------------------------------------------

    /** Сетка на h секунд: подшаги балок и контакта. */
    simulate(h, car) {
        this._near(car, h);
        this.touching = false;
        const sub = Math.max(1, Math.ceil(h * this.hz)), dt = h / sub;
        for (let s = 0; s < sub; s++) {
            this._beams();
            this._integrate(dt);
            this._contacts(dt);
        }
        if (this.touching) this.quietT = 0; else this.quietT += h;
    }

    _beams() {
        const fx = this.fx, fy = this.fy, fz = this.fz, x = this.x, y = this.y, z = this.z, vx = this.vx, vy = this.vy, vz = this.vz;
        const A = this.A, B = this.B, L0 = this.L0, Lo = this.Lo, K = this.K, C = this.C, YC = this.YC, YX = this.YX, YT = this.YT, BRK = this.BRK, BRC = this.BRC, bl = this.bl, dmg = this.dmg;
        fx.fill(0); fy.fill(0); fz.fill(0);
        for (let bi = 0; bi < this.nAlive; bi++) {
            const b = bl[bi], a = A[b], c = B[b];
            const dx = x[c] - x[a], dy = y[c] - y[a], dz = z[c] - z[a];
            const L = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-6;
            const nx = dx / L, ny = dy / L, nz = dz / L;
            const k = K[b];
            let fs = k * (L - L0[b]);
            if (fs > YT[b]) {
                const over = (fs - YT[b]) / k;
                L0[b] += over;
                fs = YT[b];
                const lo = Lo[b], e = fs * over, st = over / lo;
                this.energy += e; this.zones[this.zone[b]] += e; dmg[a] += st; dmg[c] += st; this.dirty = true;
                if (L0[b] > lo * BRK[b]) {       // разрыв
                    this.alive[b] = 0;
                    bl[bi] = bl[--this.nAlive];
                    bi--;
                    this.broken.push(b);
                    if (--this.deg[a] <= 1) this._orphan(a);
                    if (--this.deg[c] <= 1) this._orphan(c);
                    continue;
                }
            } else if (fs < -YC[b]) {
                const over = (-fs - YC[b]) / k;
                L0[b] -= over;
                const lo = Lo[b], e = YC[b] * over, st = over / lo;
                fs = -YC[b];
                if (YC[b] < YX[b]) YC[b] *= 1 + st * 4;   // упрочнение: сжатый металл собирается в пакет и держит всё сильнее (до предела: иначе пружина копит удар)
                this.energy += e; this.zones[this.zone[b]] += e; dmg[a] += st; dmg[c] += st; this.dirty = true;
                if (L0[b] < lo * BRC[b]) {       // крепление раздавлено
                    this.alive[b] = 0;
                    bl[bi] = bl[--this.nAlive];
                    bi--;
                    this.broken.push(b);
                    if (--this.deg[a] <= 1) this._orphan(a);
                    if (--this.deg[c] <= 1) this._orphan(c);
                    continue;
                }
            }
            const f = fs + C[b] * ((vx[c] - vx[a]) * nx + (vy[c] - vy[a]) * ny + (vz[c] - vz[a]) * nz);
            const Fx = f * nx, Fy = f * ny, Fz = f * nz;
            fx[a] += Fx; fy[a] += Fy; fz[a] += Fz;
            fx[c] -= Fx; fy[c] -= Fy; fz[c] -= Fz;
        }
    }

    // Узел остался без опоры: дальше не считается, иначе улетает и портит импульс кузова.
    _orphan(i) {
        if (this.flag[i] & SOFT_OFF) return;
        this.flag[i] |= SOFT_OFF;
        this.orphans.push(i);
        for (let bi = 0; bi < this.nAlive; bi++) {
            const b = this.bl[bi];
            if (this.A[b] === i || this.B[b] === i) { this.alive[b] = 0; this.deg[this.A[b]]--; this.deg[this.B[b]]--; this.bl[bi] = this.bl[--this.nAlive]; bi--; }
        }
    }

    _integrate(dt) {
        const n = this.n, im = this.im, fl = this.flag, fx = this.fx, fy = this.fy, fz = this.fz, x = this.x, y = this.y, z = this.z, vx = this.vx, vy = this.vy, vz = this.vz;
        const air = this.anyLoose ? this.airDrag * dt : 0, vcap2 = 1e8;
        for (let i = 0; i < n; i++) {
            const f = fl[i];
            if (f & SOFT_OFF) continue;
            const k = im[i] * dt;
            let Vx = vx[i] + fx[i] * k, Vy = vy[i] + fy[i] * k, Vz = vz[i] + fz[i] * k;
            if (air > 0 && (f & SOFT_LOOSE)) { const d = 1 - air; Vx *= d; Vy *= d; Vz *= d; }
            const sp2 = Vx * Vx + Vy * Vy + Vz * Vz;
            if (sp2 > vcap2) { const d = Math.sqrt(vcap2 / sp2); Vx *= d; Vy *= d; Vz *= d; }     // обрывок не улетает со скоростью пули
            vx[i] = Vx; vy[i] = Vy; vz[i] = Vz;
            x[i] += Vx * dt; y[i] += Vy * dt; z[i] += Vz * dt;
        }
    }

    // Коллайдеры и предметы рядом: не на каждый подшаг.
    _near(car, h) {
        this._nearT -= h;
        if (this._nearT > 0) return;
        const sp = Math.hypot(car.v[0], car.v[1], car.v[2]);
        const R = this.R0 + 40 + sp * 0.02;
        this._nearT = 0.016;
        const C = car.c;
        this.nearBox = [C[0] - R, C[1] - R, C[2] - R, C[0] + R, C[1] + R, C[2] + R];
        const list = this.cols;
        list.length = 0;
        if (typeof ObbyCourse !== 'undefined' && ObbyCourse._near) {
            const tmp = SoftBody._tmpCols;
            ObbyCourse._near(C[0] - R, C[2] - R, C[0] + R, C[2] + R, tmp);
            for (let i = 0; i < tmp.length; i++) {
                const c = tmp[i], bb = c.aabb;
                if (c.enabled === false || c.zone) continue;
                if (bb[4] < C[1] - R || bb[1] > C[1] + R) continue;
                list.push(c);
            }
        }
        this.props.length = 0;
        if (typeof Props !== 'undefined' && Props.near) Props.near(C[0] - R, C[1] - R, C[2] - R, C[0] + R, C[1] + R, C[2] + R, this.props);
    }

    _contacts(dt) {
        const hull = this.hull, x = this.x, y = this.y, z = this.z, rad = this.rad, fl = this.flag;
        const W = typeof GameWorld !== 'undefined' && GameWorld.active ? GameWorld : null;
        const cols = this.cols, ncols = cols.length, props = this.props, nprops = props.length, hit = this._hit;
        const nrm = this._tmp;
        for (let k = 0; k < hull.length; k++) {
            const i = hull[k], f = fl[i];
            if (f & SOFT_OFF) continue;
            const r = rad[i];
            const wheel = (f & SOFT_WHEEL) !== 0;
            if (W && !wheel) {
                const px = x[i], pz = z[i], gy = W.heightAt(px, pz);
                if (y[i] - r < gy) {
                    W.normalAt(px, pz, nrm);
                    const d = (y[i] - gy) * nrm[1];
                    if (d < r) this._resolve(i, nrm[0], nrm[1], nrm[2], r - d, 0, 0, 0, this.mu, SOFT_SURF_GROUND, null);
                }
            }
            for (let c = 0; c < ncols; c++) {
                const col = cols[c], bb = col.aabb, px = x[i], py = y[i], pz = z[i];
                if (px + r < bb[0] || px - r > bb[3] || py + r < bb[1] || py - r > bb[4] || pz + r < bb[2] || pz - r > bb[5]) continue;
                if (!SoftBody.pointCol(col, px, py, pz, r, hit)) continue;
                if (wheel && hit.ny > 0.5) continue;
                if (col.kill) { this.killHit = true; continue; }
                let svx = 0, svy = 0, svz = 0;
                if (col.dynamic && typeof ObbyCourse !== 'undefined') {
                    const v = col.vel || ObbyCourse.pointVel(col, [hit.qx, hit.qy, hit.qz]);
                    svx = v[0]; svy = v[1]; svz = v[2];
                }
                this._resolve(i, hit.nx, hit.ny, hit.nz, r - hit.d, svx, svy, svz, col.ice ? 0.12 : this.mu, SOFT_SURF_SOLID, col);
            }
            if (nprops) {
                const res = this._res;
                for (let p = 0; p < nprops; p++) {
                    if (!Props.contact(props[p], x[i], y[i], z[i], r, this.vx[i], this.vy[i], this.vz[i], this.im[i], res)) continue;
                    this._applyProp(i, res, props[p]);
                }
            }
        }
    }

    _resolve(i, nx, ny, nz, depth, svx, svy, svz, mu, surf, ref) {
        const vx = this.vx, vy = this.vy, vz = this.vz;
        this.x[i] += nx * depth; this.y[i] += ny * depth; this.z[i] += nz * depth;
        const rx = vx[i] - svx, ry = vy[i] - svy, rz = vz[i] - svz;
        const vn = rx * nx + ry * ny + rz * nz;
        const tx = rx - nx * vn, ty = ry - ny * vn, tz = rz - nz * vn;
        const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
        let j = 0;
        if (vn < 0) {
            j = -vn * (1 + this.rest);
            vx[i] += nx * j; vy[i] += ny * j; vz[i] += nz * j;
        }
        if (tl > 0.5) {
            const k = Math.min(1, mu * (j + 2) / tl);     // +2: покоящийся контакт немного держит
            vx[i] -= tx * k; vy[i] -= ty * k; vz[i] -= tz * k;
        }
        this.touching = true;
        const imp = j * this.m[i];
        if (imp >= this.cImp[i]) { this.cNx[i] = nx; this.cNy[i] = ny; this.cNz[i] = nz; this.cSurf[i] = surf; this.cRef[i] = ref; }
        else if (!this.cSurf[i]) { this.cNx[i] = nx; this.cNy[i] = ny; this.cNz[i] = nz; this.cSurf[i] = surf; this.cRef[i] = ref; }
        this.cImp[i] += imp;
        if (tl > this.cSlip[i]) { this.cSlip[i] = tl; this.cVx[i] = tx; this.cVy[i] = ty; this.cVz[i] = tz; }
    }

    _applyProp(i, res, prop) {
        this.x[i] += res.nx * res.depth; this.y[i] += res.ny * res.depth; this.z[i] += res.nz * res.depth;
        const k = this.im[i];
        // jx.. — полный импульс точке (с трением), в тех же единицах, что и invM·импульс = скорость
        this.vx[i] += res.jx * k; this.vy[i] += res.jy * k; this.vz[i] += res.jz * k;
        this.touching = true;
        const imp = Math.abs(res.jn);
        if (imp >= this.cImp[i]) { this.cNx[i] = res.nx; this.cNy[i] = res.ny; this.cNz[i] = res.nz; this.cSurf[i] = SOFT_SURF_PROP; this.cRef[i] = prop; }
        this.cImp[i] += imp;
    }

    /**
     * Точка-сфера против коллайдера ObbyCourse без выделений. hit: нормаль (мир), d — знаковое расстояние от центра точки
     * до поверхности (меньше r — касание), q — точка на поверхности. false — нет касания.
     */
    static pointCol(c, x, y, z, r, hit) {
        if (c.kind === 'capsule') {
            const a = c.a, b = c.b, abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2], L2 = abx * abx + aby * aby + abz * abz;
            let t = L2 > 1e-9 ? ((x - a[0]) * abx + (y - a[1]) * aby + (z - a[2]) * abz) / L2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const qx = a[0] + abx * t, qy = a[1] + aby * t, qz = a[2] + abz * t;
            const dx = x - qx, dy = y - qy, dz = z - qz, dd = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const d = dd - c.r;
            if (d >= r) return false;
            if (dd > 1e-6) { hit.nx = dx / dd; hit.ny = dy / dd; hit.nz = dz / dd; } else { hit.nx = 0; hit.ny = 1; hit.nz = 0; }
            hit.d = d; hit.qx = qx + hit.nx * c.r; hit.qy = qy + hit.ny * c.r; hit.qz = qz + hit.nz * c.r;
            return true;
        }
        const O = c.O, ax = c.ax, ay = c.ay, az = c.az;
        const px = x - O[0], py = y - O[1], pz = z - O[2];
        const lx = px * ax[0] + py * ax[1] + pz * ax[2], ly = px * ay[0] + py * ay[1] + pz * ay[2], lz = px * az[0] + py * az[1] + pz * az[2];
        let d, nlx = 0, nly = 0, nlz = 0;
        if (c.kind === 'box') {
            const y0 = c.y0, y1 = c.y1, hy = (y1 - y0) / 2, cy = (y0 + y1) / 2;
            const dx = Math.abs(lx) - c.hx, dy = Math.abs(ly - cy) - hy, dz = Math.abs(lz) - c.hz;
            if (dx >= r || dy >= r || dz >= r) return false;
            if (dx > 0 && dz > 0 || dx > 0 && dy > 0 || dy > 0 && dz > 0) {     // у ребра: настоящее расстояние
                const ex = dx > 0 ? dx : 0, ey = dy > 0 ? dy : 0, ez = dz > 0 ? dz : 0, e = Math.sqrt(ex * ex + ey * ey + ez * ez);
                if (e >= r) return false;
                d = e;
                nlx = lx > 0 ? ex / e : -ex / e; nly = ly > cy ? ey / e : -ey / e; nlz = lz > 0 ? ez / e : -ez / e;
            } else if (dy >= dx && dy >= dz) { d = dy; nly = ly > cy ? 1 : -1; }
            else if (dx >= dz) { d = dx; nlx = lx > 0 ? 1 : -1; }
            else { d = dz; nlz = lz > 0 ? 1 : -1; }
        } else if (c.kind === 'cyl') {
            const y0 = c.y0, y1 = c.y1, hy = (y1 - y0) / 2, cy = (y0 + y1) / 2, rr = Math.max(c.rx, c.rz);
            const ex = lx / c.rx * rr, ez = lz / c.rz * rr, rl = Math.sqrt(ex * ex + ez * ez);
            const dr = rl - rr, dy = Math.abs(ly - cy) - hy;
            if (dr >= r || dy >= r) return false;
            if (dr > dy) { d = dr; if (rl > 1e-6) { nlx = ex / rl; nlz = ez / rl; } else nlx = 1; }
            else { d = dy; nly = ly > cy ? 1 : -1; }
        } else {
            // призма по многоугольнику (клин, горб): выпуклый контур против часовой в плоскости x-y
            const poly = c.poly, hz = c.hz;
            const dz = Math.abs(lz) - hz;
            if (dz >= r) return false;
            let best = dz, bnx = 0, bny = 0, bnz = lz > 0 ? 1 : -1;
            for (let i = 0, m = poly.length; i < m; i++) {
                const a = poly[i], b = poly[(i + 1) % m];
                const ex = b[0] - a[0], ey = b[1] - a[1], el = Math.sqrt(ex * ex + ey * ey) || 1;
                const ox = ey / el, oy = -ex / el;     // наружу для обхода против часовой
                const s = (lx - a[0]) * ox + (ly - a[1]) * oy;
                if (s >= r) return false;
                if (s > best) { best = s; bnx = ox; bny = oy; bnz = 0; }
            }
            d = best; nlx = bnx; nly = bny; nlz = bnz;
        }
        hit.nx = nlx * ax[0] + nly * ay[0] + nlz * az[0];
        hit.ny = nlx * ax[1] + nly * ay[1] + nlz * az[1];
        hit.nz = nlx * ax[2] + nly * ay[2] + nlz * az[2];
        hit.d = d;
        hit.qx = x - hit.nx * d; hit.qy = y - hit.ny * d; hit.qz = z - hit.nz * d;
        return true;
    }

    /**
     * Спящая машина: коснётся ли обшивка чего-нибудь на следующем шаге? (её поза уже посчитана твёрдым телом.)
     * margin — запас до стен, px (скорость за шаг плюс немного); down — запас до земли (только скорость вниз).
     */
    checkWake(car, margin, down) {
        const q = car.q, C = car.c, H = this.comH, hull = this.hull, fl = this.flag, hit = this._hit, nrm = this._tmp;
        const W = typeof GameWorld !== 'undefined' && GameWorld.active ? GameWorld : null;
        this._near(car, 1 / 240);
        const cols = this.cols, ncols = cols.length;
        if (this.props.length) {
            // предмет у описанной сферы машины: считаем сетку, а точный контакт решит Props.contact
            const bbR = this.R0 + margin;
            for (let k = 0; k < this.props.length; k++) {
                const p = this.props[k], dx = p.x - C[0], dy = p.y === undefined ? 0 : p.y - C[1], dz = p.z - C[2], rr = bbR * 0.7 + (p.rad || p.r || 60);
                if (dx * dx + dy * dy + dz * dz < rr * rr) return true;
            }
        }
        const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
        for (let k = 0; k < hull.length; k++) {
            const i = hull[k], f = fl[i];
            if (f & SOFT_OFF) continue;
            const x = this.lx[i], y = this.ly[i] - H, z = this.lz[i];
            const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
            const px = C[0] + x + qw * tx + (qy * tz - qz * ty), py = C[1] + y + qw * ty + (qz * tx - qx * tz), pz = C[2] + z + qw * tz + (qx * ty - qy * tx);
            const r = this.rad[i] + margin, wheel = (f & SOFT_WHEEL) !== 0;
            if (W && !wheel) {
                const gy = W.heightAt(px, pz), rg = this.rad[i] + down;
                if (py - rg < gy) { W.normalAt(px, pz, nrm); if ((py - gy) * nrm[1] < rg) return true; }
            }
            for (let c = 0; c < ncols; c++) {
                const col = cols[c], bb = col.aabb;
                if (px + r < bb[0] || px - r > bb[3] || py + r < bb[1] || py - r > bb[4] || pz + r < bb[2] || pz - r > bb[5]) continue;
                if (!SoftBody.pointCol(col, px, py, pz, r, hit)) continue;
                if (wheel && hit.ny > 0.5) continue;
                return true;
            }
        }
        return false;
    }

    // ---------------------------------------------------------------------------------------------
    // Панели и колёса
    // ---------------------------------------------------------------------------------------------

    /** Узлы nodes отрываются: балки к ним убираются, масса и инерция пересчитываются. */
    detach(nodes) {
        const set = new Set(nodes);
        for (const i of nodes) { this.flag[i] |= SOFT_OFF; this.vx[i] = this.vy[i] = this.vz[i] = 0; }
        for (let bi = 0; bi < this.nAlive; bi++) {
            const b = this.bl[bi];
            if (set.has(this.A[b]) || set.has(this.B[b])) { this.alive[b] = 0; this.deg[this.A[b]]--; this.deg[this.B[b]]--; this.bl[bi] = this.bl[--this.nAlive]; bi--; }
        }
        this._massProps();
    }

    /** Порвать балки списком (крепления панели сорваны ударом). */
    cut(beams) {
        for (const b of beams) {
            if (!this.alive[b]) continue;
            this.alive[b] = 0;
            for (let bi = 0; bi < this.nAlive; bi++) if (this.bl[bi] === b) { this.bl[bi] = this.bl[--this.nAlive]; break; }
            this.deg[this.A[b]]--; this.deg[this.B[b]]--;
            this.broken.push(b);
        }
    }

    /** Отметить узлы болтающимися (панель держится не на всех креплениях). */
    setLoose(nodes) {
        for (const i of nodes) this.flag[i] |= SOFT_LOOSE;
        this.anyLoose = true;
    }

    /** Толчок скорости по шару (взрыв): v — px/с у центра, спадает к краю. */
    blast(x, y, z, radius, v) {
        const n = this.n, fl = this.flag;
        for (let i = 0; i < n; i++) {
            if (fl[i] & SOFT_OFF) continue;
            const dx = this.x[i] - x, dy = this.y[i] - y, dz = this.z[i] - z, d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1;
            if (d >= radius) continue;
            const k = v * (1 - d / radius) / d;
            this.vx[i] += dx * k; this.vy[i] += dy * k; this.vz[i] += dz * k;
        }
        this.quietT = 0;
    }

    /** Починка: вся сетка как новая. */
    resetShape() {
        const n = this.n;
        for (let i = 0; i < n; i++) {
            this.lx[i] = this.rx[i]; this.ly[i] = this.ry[i]; this.lz[i] = this.rz[i];
            this.flag[i] = this.def.nodes[i].flags | 0; this.dmg[i] = 0;
            this.cImp[i] = 0; this.cSlip[i] = 0; this.cSurf[i] = 0; this.cRef[i] = null;
        }
        for (let b = 0; b < this.nb; b++) {
            const d = this.def.beams[b];
            this.L0[b] = this.Lo[b]; this.YC[b] = d.yc; this.YT[b] = d.yt; this.alive[b] = 1; this.bl[b] = b;
        }
        this.nAlive = this.nb;
        this.deg.fill(0);
        for (let b = 0; b < this.nb; b++) { this.deg[this.A[b]]++; this.deg[this.B[b]]++; }
        this.orphans.length = 0;
        this.zones.fill(0); this.energy = 0; this.broken.length = 0;
        this.anyLoose = false; this.dirty = true; this.killHit = false; this.awake = false; this.quietT = 0;
        this._massProps();
    }

    /** Столкновение двух сеток (обе бодрствуют): сферы узлов обшивки, импульс и выталкивание по обратным массам. */
    static pair(A, B) {
        const a = A.aabb, b = B.aabb, pad = 40;
        if (a[3] + pad < b[0] || a[0] - pad > b[3] || a[4] + pad < b[1] || a[1] - pad > b[4] || a[5] + pad < b[2] || a[2] - pad > b[5]) return false;
        const hA = A.hull, hB = B.hull, Rc = typeof SOFT_CAR_RADIUS !== 'undefined' ? SOFT_CAR_RADIUS : 24;
        const mu = 0.35, e = 0.05;
        let touched = false;
        const bx0 = b[0] - Rc * 2, bx1 = b[3] + Rc * 2, by0 = b[1] - Rc * 2, by1 = b[4] + Rc * 2, bz0 = b[2] - Rc * 2, bz1 = b[5] + Rc * 2;
        for (let ka = 0; ka < hA.length; ka++) {
            const i = hA[ka];
            if (A.flag[i] & SOFT_OFF) continue;
            const px = A.x[i], py = A.y[i], pz = A.z[i];
            if (px < bx0 || px > bx1 || py < by0 || py > by1 || pz < bz0 || pz > bz1) continue;
            const ra = (A.flag[i] & SOFT_WHEEL) ? A.rad[i] : Rc;
            for (let kb = 0; kb < hB.length; kb++) {
                const j = hB[kb];
                if (B.flag[j] & SOFT_OFF) continue;
                const rr = ra + ((B.flag[j] & SOFT_WHEEL) ? B.rad[j] : Rc);
                const dx = px - B.x[j];
                if (dx > rr || dx < -rr) continue;
                const dy = py - B.y[j];
                if (dy > rr || dy < -rr) continue;
                const dz = pz - B.z[j], d2 = dx * dx + dy * dy + dz * dz;
                if (d2 >= rr * rr) continue;
                const d = Math.sqrt(d2) + 1e-6, nx = dx / d, ny = dy / d, nz = dz / d, depth = rr - d;
                const ima = A.im[i], imb = B.im[j], s = ima + imb;
                const pa = depth * ima / s, pb = depth * imb / s;
                A.x[i] += nx * pa; A.y[i] += ny * pa; A.z[i] += nz * pa;
                B.x[j] -= nx * pb; B.y[j] -= ny * pb; B.z[j] -= nz * pb;
                const rx = A.vx[i] - B.vx[j], ry = A.vy[i] - B.vy[j], rz = A.vz[i] - B.vz[j];
                const vn = rx * nx + ry * ny + rz * nz;
                let jn = 0;
                if (vn < 0) jn = -vn * (1 + e) / s;
                const tx = rx - nx * vn, ty = ry - ny * vn, tz = rz - nz * vn, tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
                let jt = 0;
                if (tl > 1) jt = Math.min(tl / s, mu * jn) / tl;
                A.vx[i] += (nx * jn - tx * jt) * ima; A.vy[i] += (ny * jn - ty * jt) * ima; A.vz[i] += (nz * jn - tz * jt) * ima;
                B.vx[j] -= (nx * jn - tx * jt) * imb; B.vy[j] -= (ny * jn - ty * jt) * imb; B.vz[j] -= (nz * jn - tz * jt) * imb;
                touched = true;
                A.touching = B.touching = true; A.quietT = B.quietT = 0;
                if (jn >= A.cImp[i]) { A.cNx[i] = nx; A.cNy[i] = ny; A.cNz[i] = nz; A.cSurf[i] = SOFT_SURF_CAR; A.cRef[i] = B; }
                if (jn >= B.cImp[j]) { B.cNx[j] = -nx; B.cNy[j] = -ny; B.cNz[j] = -nz; B.cSurf[j] = SOFT_SURF_CAR; B.cRef[j] = A; }
                A.cImp[i] += jn; B.cImp[j] += jn;
                if (tl > A.cSlip[i]) { A.cSlip[i] = tl; A.cVx[i] = tx; A.cVy[i] = ty; A.cVz[i] = tz; }
                if (tl > B.cSlip[j]) { B.cSlip[j] = tl; B.cVx[j] = -tx; B.cVy[j] = -ty; B.cVz[j] = -tz; }
            }
        }
        return touched;
    }
}
/** @type {any[]} */
SoftBody._tmpCols = [];
