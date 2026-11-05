// Ragdoll.js — рэгдолл Humanoid: частицы Верле в суставах (Jakobsen). Торс — жёсткий набор частиц, конечности — звенья
// с фиксированной длиной, колено и локоть сгибаются только в свою сторону и не складываются полностью.
// Результат — Humanoid-мир (rag.world): тот же model.apply(world, body), что и у Motion Matching. Чистая логика без
// Babylon; столкновения — через подключаемый обратный вызов collide(p, r, out): вытолкнуть сферу (частицу) из
// мира НА МЕСТЕ и вернуть { n, body, depth } или null. Готовый вариант по CharacterWorld (земля + стены world.push) —
// Ragdoll.worldCollider(world); игра с собственной физикой подаёт свой callback (как GamePhysics.pushSphere).
//
// Работает с растянутым телом (body из Humanoid.body): радиусы и массы частиц растут вместе с телом.
//
// ПРИМЕР:
//   const rag = new Ragdoll(mm.world, ch.vel, [0, 1, 0], body, { collide: Ragdoll.worldCollider(world, body.leg) });
//   const impact = rag.update(dt);                      // 0 или скорость самого сильного касания (звук удара)
//   model.apply(rag.world, body);                       // вид
//   if (rag.t > 1.1 && rag.still > 0.35) { const info = rag.getupInfo(); /* mm.enterGetup(ch, rag.world, info.faceDown, info.yaw) */ }
//
// Частицы (индексы rag.i): pelvis, chest, head, shL/elL/haL, shR/elR/haR, hiL/knL/anL/toL, hiR/knR/anR/toR, belly.

class Ragdoll {
    // world — мировые суставы персонажа в момент падения (Humanoid.newWorld() от MotionController: mm.world), vel —
    // начальная скорость тела [x, y, z] px/с, spin — угловая скорость [x, y, z] рад/с (вокруг таза), body — тело
    // (по умолчанию базовое). opts: { collide?, gravity?, onHit?(particleIndex, hit), cfg? — поля Ragdoll.cfg() }.
    constructor(world, vel, spin, body, opts) {
        const o = opts || {};
        const BD = body || Humanoid.BODY1, sc = Math.sqrt(BD.leg * BD.wide);
        this.body = BD;
        this.c = Ragdoll.cfg(o.cfg);
        this.gravity = o.gravity != null ? o.gravity : (typeof CHAR_GRAVITY !== 'undefined' ? CHAR_GRAVITY : 1200);
        /** @type {((p: number[], r: number, out: any) => any) | null} */
        this.collide = o.collide || null;
        /** @type {((i: number, hit: any) => void) | null} */
        this.onHit = o.onHit || null;
        const J = Humanoid.J, gp = (j) => Humanoid.getPos(world, j, [0, 0, 0]), gr = (j) => Humanoid.getRot(world, j, [0, 0, 0, 1]);
        /** @type {{ p: number[], o: number[], r: number, m: number }[]} */
        const P = [];
        const add = (p, r, m) => { P.push({ p: p.slice(), o: p.slice(), r: r * sc, m: m * BD.leg * BD.wide }); return P.length - 1; };
        const rotate = (q, v) => GM.qrot([0, 0, 0], q, v);
        const hipsQ = gr(J.HIPS), headQ = gr(J.NECK);
        /** @type {Record<string, number>} */
        this.i = {};
        const I = this.i;
        I.pelvis = add(gp(J.HIPS), 15, 10);
        I.chest = add(gp(J.NECK), 15, 10);
        I.head = add(GM.add([0, 0, 0], gp(J.NECK), rotate(headQ, [0, BD.partOff[2][1], 0])), 20, 5);
        I.shL = add(gp(J.SHL), 11, 3); I.elL = add(gp(J.ELL), 11, 2);
        I.haL = add(GM.add([0, 0, 0], gp(J.WRL), rotate(gr(J.WRL), [0, -6, 0])), 10, 1.5);
        I.shR = add(gp(J.SHR), 11, 3); I.elR = add(gp(J.ELR), 11, 2);
        I.haR = add(GM.add([0, 0, 0], gp(J.WRR), rotate(gr(J.WRR), [0, -6, 0])), 10, 1.5);
        I.hiL = add(gp(J.HIPL), 13, 5); I.knL = add(gp(J.KNL), 12, 3); I.anL = add(gp(J.ANL), 9, 2);
        I.toL = add(GM.add([0, 0, 0], gp(J.ANL), rotate(gr(J.ANL), [15, -10, 0])), 6, 1);
        I.hiR = add(gp(J.HIPR), 13, 5); I.knR = add(gp(J.KNR), 12, 3); I.anR = add(gp(J.ANR), 9, 2);
        I.toR = add(GM.add([0, 0, 0], gp(J.ANR), rotate(gr(J.ANR), [15, -10, 0])), 6, 1);
        I.belly = add(GM.add([0, 0, 0], gp(J.WAIST), rotate(hipsQ, [16, 20, 0])), 12, 4);
        this.P = P;
        // скорость: поступательная + вращение вокруг таза (Верле хранит её как «прошлое положение»)
        const h = 1 / Ragdoll.RATE, c0 = P[I.pelvis].p;
        for (const q of P) {
            const r = GM.sub([0, 0, 0], q.p, c0);
            const w = spin || [0, 0, 0];
            const vx = vel[0] + w[1] * r[2] - w[2] * r[1], vy = vel[1] + w[2] * r[0] - w[0] * r[2], vz = vel[2] + w[0] * r[1] - w[1] * r[0];
            q.o[0] = q.p[0] - vx * h; q.o[1] = q.p[1] - vy * h; q.o[2] = q.p[2] - vz * h;
        }
        // связи: { a, b, L, k, min } — расстояние a–b равно L (или не меньше L, если min)
        /** @type {{ a: number, b: number, L: number, k: number, min: boolean }[]} */
        this.C = [];
        const link = (a, b, k, minOnly) => this.C.push({ a, b, L: GM.dist(P[a].p, P[b].p), k: k || 1, min: !!minOnly });
        const torso = [I.pelvis, I.chest, I.shL, I.shR, I.hiL, I.hiR, I.belly];
        for (let x = 0; x < torso.length; x++) for (let y = x + 1; y < torso.length; y++) link(torso[x], torso[y], 1);
        link(I.chest, I.head, 1); link(I.head, I.shL, 0.35); link(I.head, I.shR, 0.35); link(I.head, I.belly, 0.3);
        link(I.shL, I.elL); link(I.elL, I.haL); link(I.shR, I.elR); link(I.elR, I.haR);
        link(I.hiL, I.knL); link(I.knL, I.anL); link(I.anL, I.toL); link(I.knL, I.toL);
        link(I.hiR, I.knR); link(I.knR, I.anR); link(I.anR, I.toR); link(I.knR, I.toR);
        // пределы: локоть и колено не складываются полностью (расстояние плечо–кисть, бедро–голеностоп не меньше f·рост ноги)
        const lim = (a, b, f) => this.C.push({ a, b, L: f * BD.leg, k: 1, min: true });
        lim(I.shL, I.haL, 30); lim(I.shR, I.haR, 30); lim(I.hiL, I.anL, 30); lim(I.hiR, I.anR, 30);
        lim(I.haL, I.hiL, 14); lim(I.haR, I.hiR, 14);
        // шарниры: [начало, сустав, конец, знак] — сустав не уходит за линию «начало–конец» против своего сгиба
        this.H = [[I.hiL, I.knL, I.anL, 1], [I.hiR, I.knR, I.anR, 1], [I.shL, I.elL, I.haL, -1], [I.shR, I.elR, I.haR, -1]];
        this.t = 0; this.still = 0; this.acc = 0;
        /** @type {{ pos: Float64Array, rot: Float64Array }} */
        this.world = Humanoid.newWorld();
        this._hit = { n: [0, 0, 0], body: null, depth: 0 };
        this._f = [0, 0, 0];
        this._u = [0, 0, 0]; this._r = [0, 0, 0];
        this.bounce = 0;
        this.toWorld();
    }

    // Числа рэгдолла: константы RAGDOLL_* (Constants.js) с дефолтами, поверх — over.
    static cfg(over) {
        const U = 'undefined', o = over || {};
        const pick = (k, v) => (o[k] != null ? o[k] : v);
        return {
            iterations: pick('iterations', typeof RAGDOLL_ITERATIONS !== U ? RAGDOLL_ITERATIONS : 8),
            damping: pick('damping', typeof RAGDOLL_DAMPING !== U ? RAGDOLL_DAMPING : 0.996),
            friction: pick('friction', typeof RAGDOLL_FRICTION !== U ? RAGDOLL_FRICTION : 0.28),
            bounce: pick('bounce', typeof RAGDOLL_BOUNCE !== U ? RAGDOLL_BOUNCE : 0.15),
            stillSpeed: pick('stillSpeed', typeof RAGDOLL_STILL_SPEED !== U ? RAGDOLL_STILL_SPEED : 22),
        };
    }

    // Сборка collide по CharacterWorld: стены и препятствия мира (world.push — Nav, коробки игры), затем земля
    // (world.ground, нормаль опоры). scale — масштаб тела (радиусы частиц растут, длина проб тоже).
    /** @returns {(p: number[], r: number, out: any) => any} */
    static worldCollider(world, scale) {
        const k = Math.max(0.05, scale || 1);
        const g = { y: 0, n: [0, 1, 0], body: null, t: 0, moving: false };
        return (p, r, out) => {
            let hit = null, depth = 0;
            if (world.push) {
                const h = world.push(p, r, out);
                if (h) { hit = h; depth = h.depth || 0; }
            }
            // земля: луч сверху с запасом на проникновение (частица могла глубоко зайти в склон за подшаг)
            const margin = 4 * r + 20 * k;
            const s = world.ground(p[0], p[2], p[1] + r + margin, margin + 2 * r + 4, g);
            if (s && p[1] - r < s.y) {
                const d = (s.y - (p[1] - r)) * s.n[1];
                p[0] += s.n[0] * d; p[1] += s.n[1] * d; p[2] += s.n[2] * d;
                if (d >= depth) { depth = d; hit = out; GM.copy(out.n, s.n); out.body = s.body || null; }
            }
            if (!hit) return null;
            out.depth = depth;
            return out;
        };
    }

    update(dt) {
        const S = 1 / Ragdoll.RATE;
        this.acc = Math.min(this.acc + dt, S * 6);
        let impact = 0;
        while (this.acc >= S) {
            impact = Math.max(impact, this.step(S));
            this.acc -= S;
        }
        this.t += dt;
        // покой: средняя скорость частиц
        let sp = 0;
        for (const q of this.P) sp += GM.dist(q.p, q.o) * Ragdoll.RATE;
        sp /= this.P.length;
        this.still = sp < this.c.stillSpeed ? this.still + dt : 0;
        this.toWorld();
        return impact;
    }

    // Один шаг 1/120 с: интеграция Верле, затем итерации связей, шарниров и столкновений. -> сила самого сильного касания, px/с.
    step(h) {
        const g = this.gravity, damp = this.c.damping, f = this.c.friction;
        let impact = 0;
        for (const q of this.P) {
            const vx = (q.p[0] - q.o[0]) * damp, vy = (q.p[1] - q.o[1]) * damp, vz = (q.p[2] - q.o[2]) * damp;
            q.o[0] = q.p[0]; q.o[1] = q.p[1]; q.o[2] = q.p[2];
            q.p[0] += vx; q.p[1] += vy - g * h * h; q.p[2] += vz;
        }
        for (let it = 0; it < this.c.iterations; it++) {
            for (const c of this.C) {
                const a = this.P[c.a], b = this.P[c.b];
                const dx = b.p[0] - a.p[0], dy = b.p[1] - a.p[1], dz = b.p[2] - a.p[2];
                const L = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
                if (c.min && L >= c.L) continue;
                const diff = (L - c.L) / L * c.k;
                const wa = 1 / a.m, wb = 1 / b.m, s = wa + wb;
                a.p[0] += dx * diff * wa / s; a.p[1] += dy * diff * wa / s; a.p[2] += dz * diff * wa / s;
                b.p[0] -= dx * diff * wb / s; b.p[1] -= dy * diff * wb / s; b.p[2] -= dz * diff * wb / s;
            }
            this.hinges();
            if (this.collide && it % 2 === 1) {
                for (let i = 0; i < this.P.length; i++) {
                    const q = this.P[i];
                    const hit = this.collide(q.p, q.r, this._hit);
                    if (!hit) continue;
                    // трение и гашение удара
                    const n = hit.n, vx = q.p[0] - q.o[0], vy = q.p[1] - q.o[1], vz = q.p[2] - q.o[2];
                    const vn = vx * n[0] + vy * n[1] + vz * n[2];
                    if (vn < 0) impact = Math.max(impact, -vn * Ragdoll.RATE);
                    const tx = vx - vn * n[0], ty = vy - vn * n[1], tz = vz - vn * n[2];
                    const keep = vn > 0 ? vn : -vn * this.c.bounce;
                    q.o[0] = q.p[0] - (tx * (1 - f) + n[0] * keep); q.o[1] = q.p[1] - (ty * (1 - f) + n[1] * keep); q.o[2] = q.p[2] - (tz * (1 - f) + n[2] * keep);
                    if (this.onHit) this.onHit(i, hit);
                }
            }
        }
        return impact;
    }

    // Шарниры: колени сгибаются вперёд (сустав впереди линии бедро–стопа), локти — назад от линии плечо–кисть
    // (предплечье уходит вперёд). Против выворота сустав сдвигается вдоль «вперёд» корпуса.
    hinges() {
        const P = this.P, tol = this.body.leg;   // допуск выворота растёт с телом (1 px у базового)
        const f = this.forward(this._f);
        for (const [a, b, c, dir] of this.H) {
            const A = P[a].p, B = P[b].p, C = P[c].p;
            const mx = (A[0] + C[0]) / 2, my = (A[1] + C[1]) / 2, mz = (A[2] + C[2]) / 2;
            const ex = B[0] - mx, ey = B[1] - my, ez = B[2] - mz;
            const d = (ex * f[0] + ey * f[1] + ez * f[2]) * dir;
            if (d < -tol) {
                const k = (-d - tol) * 0.5;
                B[0] += f[0] * k * dir; B[1] += f[1] * k * dir; B[2] += f[2] * k * dir;
            }
        }
    }

    // Базис корпуса: вверх (таз -> грудь), вправо (левое -> правое плечо), вперёд = вверх × вправо.
    basis(u, r, f) {
        const I = this.i, P = this.P;
        GM.norm(u, GM.sub(u, P[I.chest].p, P[I.pelvis].p));
        GM.sub(r, P[I.shR].p, P[I.shL].p);
        GM.adds(r, r, u, -GM.dot(r, u)); GM.norm(r, r);
        GM.cross(f, u, r);
    }
    forward(f) { this.basis(this._u, this._r, f); return f; }

    // Частицы -> мировые суставы.
    toWorld() {
        const I = this.i, P = this.P, J = Humanoid.J, w = this.world;
        const u = [0, 0, 0], r = [0, 0, 0], f = [0, 0, 0], q = [0, 0, 0, 1], v = [0, 0, 0], d = [0, 0, 0];
        this.basis(u, r, f);
        GM.qbasis(q, f, u, r);
        Humanoid.setRot(w, J.HIPS, q); Humanoid.setRot(w, J.WAIST, q);
        Humanoid.setPos(w, J.HIPS, P[I.pelvis].p);
        GM.add(v, P[I.pelvis].p, GM.qrot(v, q, [0, this.body.off[4], 0])); Humanoid.setPos(w, J.WAIST, v);
        Humanoid.setPos(w, J.NECK, P[I.chest].p);
        // голова
        GM.norm(d, GM.sub(d, P[I.head].p, P[I.chest].p));
        GM.qlimb(q, GM.scale(v, d, -1), f); Humanoid.setRot(w, J.NECK, q);
        // руки и ноги: звено = направление «вниз по кости» + ось сгиба «вправо»
        const limb = (j0, a, b, j1, c2, j2, lenEnd) => {
            Humanoid.setPos(w, j0, P[a].p);
            GM.norm(d, GM.sub(d, P[b].p, P[a].p)); GM.qlimbZ(q, d, r); Humanoid.setRot(w, j0, q);
            Humanoid.setPos(w, j1, P[b].p);
            GM.norm(d, GM.sub(d, P[c2].p, P[b].p)); GM.qlimbZ(q, d, r); Humanoid.setRot(w, j1, q);
            GM.add(v, P[b].p, GM.qrot(v, q, [0, -lenEnd, 0])); Humanoid.setPos(w, j2, v);
            return q;
        };
        const fore = -this.body.off[5 * 3 + 1];
        let qq = limb(J.SHL, I.shL, I.elL, J.ELL, I.haL, J.WRL, fore); Humanoid.setRot(w, J.WRL, qq);
        qq = limb(J.SHR, I.shR, I.elR, J.ELR, I.haR, J.WRR, fore); Humanoid.setRot(w, J.WRR, qq);
        for (const [jh, hi, kn, an, to] of [[J.HIPL, I.hiL, I.knL, I.anL, I.toL], [J.HIPR, I.hiR, I.knR, I.anR, I.toR]]) {
            Humanoid.setPos(w, jh, P[hi].p);
            GM.norm(d, GM.sub(d, P[kn].p, P[hi].p)); GM.qlimbZ(q, d, r); Humanoid.setRot(w, jh, q);
            Humanoid.setPos(w, jh + 1, P[kn].p);
            GM.norm(d, GM.sub(d, P[an].p, P[kn].p)); GM.qlimbZ(q, d, r); Humanoid.setRot(w, jh + 1, q);
            Humanoid.setPos(w, jh + 2, P[an].p);
            const toe = GM.norm([0, 0, 0], GM.sub([0, 0, 0], P[to].p, P[an].p));
            GM.qlimb(q, d, toe); Humanoid.setRot(w, jh + 2, q);
        }
        return w;
    }

    pelvis() { return this.P[this.i.pelvis].p; }

    // Лицом вниз? И курс подъёма (для лица вниз — к голове, вверх — к ногам).
    getupInfo() {
        const f = this.forward([0, 0, 0]);
        const I = this.i, P = this.P;
        const hx = P[I.head].p[0] - P[I.pelvis].p[0], hz = P[I.head].p[2] - P[I.pelvis].p[2];
        const faceDown = f[1] < 0;
        const yaw = faceDown ? Math.atan2(hz, hx) : Math.atan2(-hz, -hx);
        return { faceDown, yaw: Number.isFinite(yaw) ? yaw : 0 };
    }

    // Толкнуть частицы (удар по лежащему): v — прибавка скорости, px/с.
    kick(v) {
        for (const q of this.P) { q.o[0] -= v[0] / Ragdoll.RATE; q.o[1] -= v[1] / Ragdoll.RATE; q.o[2] -= v[2] / Ragdoll.RATE; }
    }
}
Ragdoll.RATE = 120;   // шагов Верле в секунду
