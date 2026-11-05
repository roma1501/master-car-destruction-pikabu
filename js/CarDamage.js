// CarDamage.js — что столкновения значат для машины. Читает сетку SoftBody раз в кадр: контакты — в искры, удары, вмятины и
// царапины; порванные балки — в болтающиеся и отлетающие панели, потерянные и загнутые колёса, пробитые шины; пластику зон —
// в проценты HUD, пар, дым, огонь и взрыв, падение мощности. Обломки (CarDebris) — панели и колёса, оторвавшиеся от кузова:
// твёрдые тела с точками контакта. Вид — CarSkin (js/CarSkin.js), он подписывается на события on.*; эффекты — CrashFx.
// Babylon здесь нет: считается и в node.

const CD_WHEEL_SHOCK = 7000;  // px/с: потеря скорости ступицы, которая сама по себе срывает колесо
const CD_WHEEL_BEND = 2.6;    // во сколько радиусов колеса загиб ступицы срывает его
const CD_BIGHIT = 900;     // px/с: потеря скорости за миг, с которой начинается киношный кадр аварии
// Когда панель болтается и когда отрывается: смятие её листа + удары по ней (доли, см. CarDamage._panelStress).
const CD_PANEL_LIMITS = { hood: [1.0, 2.7], trunk: [0.3, 0.9], door: [0.7, 1.7], bumper: [0.42, 0.85], wing: [0.25, 0.65], mirror: [0.1, 0.22] };

/** @satisfies {Record<string, any>} */
const CarDamageCfg = {
    /** Запас прочности: энергия (кг·px²/с²) на 100 % машины. */
    fullEnergy(mass) { return mass * 3200 * 3200 * 0.5 * 0.75; },
    impactMin: typeof CD_IMPACT_MIN !== 'undefined' ? CD_IMPACT_MIN : 260,     // px/с: потеря скорости узла за кадр, с которой есть удар
    scrapeMin: typeof CD_SCRAPE_MIN !== 'undefined' ? CD_SCRAPE_MIN : 240,     // px/с: скольжение узла, с которого искрит
};

class CarDamage {
    /** @param {any} car createCar с car.soft @param {{ name?: string, player?: boolean }} [opts] */
    constructor(car, opts) {
        this.car = car;
        const o = opts || {};
        this.name = o.name || 'car';
        this.player = !!o.player;
        /** @type {Record<string, (...a: any[]) => void>} */ this.on = {};
        this.soft = car.soft;
        this.def = car.soft.def;
        this.full = CarDamageCfg.fullEnergy(this.def.mass);
        /** @type {Record<string, any>} */ this.panels = {};
        for (const k of Object.keys(this.def.panels)) {
            const p = this.panels[k] = this.def.panels[k];
            const lim = CD_PANEL_LIMITS[p.kind] || CD_PANEL_LIMITS.wing;
            const j = 0.8 + Math.random() * 0.45;       // панели одной машины отлетают не хором
            p.limLoose = lim[0] * j; p.limOff = lim[1] * j;
        }
        this._rearm();
        this._tmp = [0, 0, 0];
        this._q = [0, 0, 0]; this._n = [0, 0, 0]; this._v = [0, 0, 0];
        /** @type {any} */ this.emitter = null;
    }

    _rearm() {
        this.total = 0; this.engine = 0; this.heat = 0; this.fireT = 0; this.boomT = 0; this.exploded = false; this.state = 'ok';
        this.zones = { front: 0, rear: 0, left: 0, right: 0, roof: 0 };
        this.wheels = [0, 0, 0, 0];
        this.hubShock = [0, 0, 0, 0];
        this.wheelLim = this.wheels.map(() => 0.85 + Math.random() * 0.4);   // колёса одной машины отрываются не хором
        this.burstImp = [0, 0, 0, 0];
        /** @type {Record<string, number>} */ this.panelState = {};
        for (const k of Object.keys(this.panels)) { this.panelState[k] = 0; this.panels[k].shock = 0; }   // 0 на месте, 1 болтается, 2 оторвана
        this.value = 0; this.lastValue = 0; this.burst = 0; this.burstT = 0;
        this.lastHit = -1; this.hardAcc = 0; this.bigT = 0; this.speedRef = 0;
        this.leakT = 0; this.scrapes = new Set(); this.impactT = 0; this.impactBudget = 0; this.dirtT = 0;
    }

    /** Огонь и дым этой машины больше не нужны (починка, замена машины, смена карты). */
    stopFx() {
        if (this.emitter) { try { this.emitter.stop(); } catch (e) { /* уже */ } this.emitter = null; }
    }

    reset() {
        this.stopFx();
        this._rearm();
        for (const key of this._scrapeKeys || []) if (typeof CrashFx !== 'undefined') CrashFx.scrapeEnd(key);
        this._scrapeKeys = null;
        if (this.on.reset) this.on.reset();
    }

    // ---------------------------------------------------------------------------------------------
    // Кадр
    // ---------------------------------------------------------------------------------------------

    update(dt) {
        const S = this.soft, C = this.car;
        if (S.awake) S._toLocal(C);
        this.speedRef = Math.max(Math.hypot(C.v[0], C.v[1], C.v[2]), this.speedRef * Math.exp(-dt * 3));
        this._contacts(dt);
        if (S.broken.length || S.orphans.length) this._structure();
        this._wheelState(dt);
        this._engineState(dt);
        // счёт ущерба и большие аварии: всё, что случилось за одну серию ударов
        const E = S.energy;
        const value = Math.floor(E / this.full * this._price());
        const delta = value - this.value;
        if (delta > 0) { this.value = value; this.burst += delta; this.burstT = 0.45; }
        if (this.burstT > 0) {
            this.burstT -= dt;
            if (this.burstT <= 0 && this.burst > 0) { const b = this.burst; this.burst = 0; if (this.on.crash) this.on.crash(b); }
        }
        const z = this.zones, f = S.zones, F = this.full * 0.45;
        z.front = Math.min(1, (f[0] + f[5] * 0.6) / F);
        z.rear = Math.min(1, f[1] / F);
        z.left = Math.min(1, f[2] / F);
        z.right = Math.min(1, f[3] / F);
        z.roof = Math.min(1, f[4] / (F * 0.7));
        this.total = Math.min(1, E / this.full);
    }

    _price() { return 45000; }

    /** Жёсткая посадка: удар в подвеску i. */
    wheelShock(i, speed) {
        const S = this.soft, hub = this.def.hubs[i];
        if (S.flag[hub] & SOFT_OFF) return;
        this.burstImp[i] += speed;
        const C = this.car;
        if (!S.awake) { S.wake(C); }
        // ступице — скорость вверх вдоль оси машины: подвеска примет удар сеткой
        const k = Math.min(1300, (speed - 900) * 0.8);
        S.vx[hub] += C.u[0] * k; S.vy[hub] += C.u[1] * k; S.vz[hub] += C.u[2] * k;
        S.quietT = 0;
    }

    // Контакты узлов за кадр: удары и царапины.
    _contacts(dt) {
        const S = this.soft, C = this.car, hull = S.hull, cfg = CarDamageCfg;
        const hasFx = typeof CrashFx !== 'undefined';
        // удар — это потеря скорости узлом за кадр, а не вес машины на земле
        let topI = -1, topDv = 0, n2 = -1, n2Dv = 0, sumImp = 0;
        // группы трения: перед, зад, левый и правый бок, крыша, низ
        const groups = CarDamage._groups;
        for (const g of groups) { g.imp = 0; g.slip = 0; g.i = -1; }
        for (let k = 0; k < hull.length; k++) {
            const i = hull[k], surf = S.cSurf[i];
            if (!surf) continue;
            const imp = S.cImp[i], slip = S.cSlip[i], dv = imp * S.im[i];
            if (dv > cfg.impactMin) {
                sumImp += imp;
                if (dv > topDv) { n2 = topI; n2Dv = topDv; topI = i; topDv = dv; }
                else if (dv > n2Dv) { n2 = i; n2Dv = dv; }
            }
            if (slip > cfg.scrapeMin) {
                const lx = S.rx[i], ly = S.ry[i], lz = S.rz[i], L = C.spec.L;
                const g = groups[S.cNy[i] > 0.6 && ly > C.spec.H * 0.6 ? 4 : lx > L * 0.3 ? 0 : lx < -L * 0.3 ? 1 : lz < 0 ? 2 : 3];
                if (slip > g.slip) { g.slip = slip; g.i = i; }
            }
        }
        // удары: один-два самых сильных на кадр, не чаще лимита
        this.impactT -= dt;
        this.bigT -= dt;
        this.hardAcc *= Math.exp(-dt * 7);
        if (topI >= 0) {
            this._registerHit(topI, topDv, sumImp);
            if (n2 >= 0 && n2Dv > cfg.impactMin * 1.6 && Math.hypot(S.x[n2] - S.x[topI], S.y[n2] - S.y[topI], S.z[n2] - S.z[topI]) > 70) this._registerHit(n2, n2Dv, sumImp * 0.5);
            const hard = sumImp / this.def.mass;     // сколько скорости потеряно за кадр, px/с
            if (hard > 160) C.crashT = Math.max(C.crashT, Math.min(2.2, 0.5 + hard / 700));
            this.lastHit = topI;
            this.hardAcc += hard;
            if (this.hardAcc > CD_BIGHIT && this.bigT <= 0) { this.bigT = 1.6; if (this.on.bigHit) this.on.bigHit(this.hardAcc, topI); }
        }
        // трение
        const keys = this._scrapeKeys || (this._scrapeKeys = groups.map((g, i) => this.name + ':s' + i));
        for (let gi = 0; gi < groups.length; gi++) {
            const g = groups[gi], key = keys[gi];
            if (g.i >= 0 && S.awake) {
                const i = g.i, r = S.rad[i], nx = S.cNx[i], ny = S.cNy[i], nz = S.cNz[i];
                const q = this._q, n = this._n, v = this._v;
                q[0] = S.x[i] - nx * r; q[1] = S.y[i] - ny * r; q[2] = S.z[i] - nz * r;
                n[0] = nx; n[1] = ny; n[2] = nz;
                v[0] = S.cVx[i]; v[1] = S.cVy[i]; v[2] = S.cVz[i];
                const power = Math.min(1, (g.slip - cfg.scrapeMin) / 1800);
                const surface = this._surface(i);
                if (hasFx && surface !== 'grass' && surface !== 'sand') CrashFx.scrape(key, q, n, v, power, surface);
                else if (hasFx) power > 0.2 && CrashFx.gear(q, v, n, null);
                if (this.on.scrape) this.on.scrape(i, power, dt);
                if (!this.scrapes.has(key)) this.scrapes.add(key);
            } else if (this.scrapes.has(key)) {
                this.scrapes.delete(key);
                if (hasFx) CrashFx.scrapeEnd(key);
            }
        }
        // сброс счётчиков
        this._panelStress(dt);
        S.cImp.fill(0); S.cSlip.fill(0); S.cSurf.fill(0);
    }

    // Крепления не только рвутся сами: панель срывает, когда её лист смят или по ней пришёлся удар.
    _panelStress(dt) {
        const S = this.soft;
        if (!S.awake) return;
        let changed = false;
        for (const name of Object.keys(this.panels)) {
            const st = this.panelState[name];
            if (st >= 2) continue;
            const p = this.panels[name], nodes = p.nodes;
            let d = 0, hit = 0;
            for (let k = 0; k < nodes.length; k++) { const i = nodes[k]; d += S.dmg[i]; const dv = S.cImp[i] * S.im[i]; if (dv > hit) hit = dv; }
            hit = Math.min(hit, this.speedRef * 3.2);      // лёгкий узел за кадр бьётся много раз: удар не сильнее скорости машины
            p.shock = Math.max((p.shock || 0) * Math.exp(-dt * 2), hit / 7000);
            const stress = d / nodes.length + p.shock;
            if (st === 0 && stress > p.limLoose) { S.cut(p.latch); changed = true; }
            if (stress > p.limOff) { S.cut(p.latch); S.cut(p.hinge); changed = true; }
        }
        if (changed) this._structure();
    }

    _surface(i) {
        const S = this.soft, f = S.cSurf[i], ref = S.cRef[i];
        if (f === SOFT_SURF_GROUND) {
            if (typeof GameWorld !== 'undefined' && GameWorld.active) return GameWorld.surfaceAt(S.x[i], S.z[i]).name;
            return 'asphalt';
        }
        if (f === SOFT_SURF_PROP) return (ref && ref.surface) || 'metal';
        if (f === SOFT_SURF_CAR) return 'car';
        return (ref && ref.surface) || 'concrete';
    }

    _registerHit(i, dv, sum) {
        const S = this.soft, r = S.rad[i], cfg = CarDamageCfg, nx = S.cNx[i], ny = S.cNy[i], nz = S.cNz[i];
        const q = this._q, n = this._n;
        q[0] = S.x[i] - nx * r; q[1] = S.y[i] - ny * r; q[2] = S.z[i] - nz * r;
        n[0] = nx; n[1] = ny; n[2] = nz;
        const power = Math.min(1, (dv - cfg.impactMin) / 2600 + sum / this.def.mass / 2400);
        if (this.impactT <= 0 || power > 0.45) {
            this.impactT = 0.05;
            // трещины и сколы остаются только на неподвижном: о предмет или чужую машину декали не будет
            if (typeof CrashFx !== 'undefined') CrashFx.impact(q, n, power, this._surface(i), S.cSurf[i] === SOFT_SURF_PROP || S.cSurf[i] === SOFT_SURF_CAR);
        }
        if (this.on.hit) this.on.hit(i, power, dv);
    }

    // Порванные балки: панели, узлы без опоры.
    _structure() {
        const S = this.soft;
        for (const name of Object.keys(this.panels)) {
            const p = this.panels[name];
            const st = this.panelState[name];
            if (st >= 2) continue;
            let latch = 0, hinge = 0;
            for (const b of p.latch) if (S.alive[b]) latch++;
            for (const b of p.hinge) if (S.alive[b]) hinge++;
            const had = p.latch.length + p.hinge.length, alive = latch + hinge;
            if (alive === 0 || (p.hinge.length === 0 && alive < Math.max(1, had * 0.2))) { this._panelOff(name, p); continue; }
            if (st === 0 && (latch === 0 || alive < had * 0.55)) {
                this.panelState[name] = 1;
                S.setLoose(p.nodes);
                if (this.on.loose) this.on.loose(name, p);
            }
        }
        S.broken.length = 0;
        if (S.orphans.length) {
            if (this.on.orphans) this.on.orphans(S.orphans);
            S.orphans.length = 0;
        }
    }

    _panelOff(name, p) {
        const S = this.soft, C = this.car;
        this.panelState[name] = 2;
        let vx = 0, vy = 0, vz = 0, x = 0, y = 0, z = 0, n = 0;
        for (const i of p.nodes) { if (S.flag[i] & SOFT_OFF) continue; vx += S.vx[i]; vy += S.vy[i]; vz += S.vz[i]; x += S.x[i]; y += S.y[i]; z += S.z[i]; n++; }
        n = n || 1;
        const v = [vx / n, vy / n, vz / n], q = [x / n, y / n, z / n];
        if (this.on.panelOff) this.on.panelOff(name, p, q, v);     // вид снимает форму панели до отключения узлов
        S.detach(p.nodes);
        if (typeof CrashFx !== 'undefined') CrashFx.panelOff(q, v, p.kind);
        C.crashT = Math.max(C.crashT, 0.2);
    }

    // Колёса: сколько креплений живо, загиб ступицы (меняет точку луча и схождение), пробои.
    _wheelState(dt) {
        const S = this.soft, C = this.car, def = this.def, hubs = def.hubs;
        for (let i = 0; i < 4; i++) {
            const w = C.wheels[i], hub = hubs[i], beams = def.wheelBeams[i];
            if (w.lost) continue;
            let alive = 0;
            for (const b of beams) if (S.alive[b]) alive++;
            const off = (S.flag[hub] & SOFT_OFF) !== 0;
            if (off || alive <= 1) { this._wheelOff(i); continue; }
            // загиб: где ступица относительно исходного места (подвеска в сетке не ходит: всё смещение — поломка)
            const bx = S.lx[hub] - S.rx[hub], by = S.ly[hub] - S.ry[hub], bz = S.lz[hub] - S.rz[hub];
            const lim = C.spec.R * 0.9;
            w.bx = Math.max(-lim, Math.min(lim, bx));
            w.by = Math.max(-lim * 0.6, Math.min(lim * 0.8, by));
            w.bz = Math.max(-lim, Math.min(lim, bz));
            // схождение: боковой увод относительно оси, развал — от вертикального загиба
            w.toe = Math.max(-0.3, Math.min(0.3, (bz / 70) * (w.front ? 1 : 0.6) + (Math.abs(bx) / 400) * (w.sz > 0 ? 1 : -1)));
            w.camber = Math.max(-0.45, Math.min(0.45, (w.sz > 0 ? -1 : 1) * by / 60));
            const bend = Math.hypot(bx, by, bz);
            // сильный удар по ступице или глубокий загиб срывают колесо
            const hubDv = Math.min(S.cImp[hub] * S.im[hub], this.speedRef * 2);
            this.hubShock[i] = Math.max(this.hubShock[i] * Math.exp(-dt * 2), hubDv / CD_WHEEL_SHOCK);
            if (this.hubShock[i] + bend / (lim * CD_WHEEL_BEND) > this.wheelLim[i]) { this._wheelOff(i); continue; }
            this.wheels[i] = Math.max(this.wheels[i], Math.min(0.95, bend / lim * 0.8 + (beams.length - alive) / beams.length * 0.5));
            // пробой: сильный удар по ступице или жёсткая посадка
            const imp = S.cImp[hub];
            this.burstImp[i] = Math.max(0, this.burstImp[i] - dt * 900) + imp * 0.02;
            if (!w.flat && (this.burstImp[i] > 2800 || bend > lim * 0.9)) {
                w.flat = true;
                const q = this._hubWorld(hub);
                if (typeof CrashFx !== 'undefined') CrashFx.tireBurst(q);
                if (this.on.flat) this.on.flat(i);
            }
        }
    }

    _hubWorld(hub) {
        const S = this.soft;
        if (S.awake) return [S.x[hub], S.y[hub], S.z[hub]];
        return this.car.point(S.lx[hub], S.ly[hub], S.lz[hub], [0, 0, 0]);
    }

    _wheelOff(i) {
        const S = this.soft, C = this.car, hub = this.def.hubs[i], w = C.wheels[i];
        w.lost = true; w.contact = false; w.col = null; w.load = 0;
        this.wheels[i] = 1;
        const q = this._hubWorld(hub), r = this.car;
        const v = [S.vx[hub] || r.v[0], S.vy[hub] || r.v[1], S.vz[hub] || r.v[2]];
        if (this.on.wheelOff) this.on.wheelOff(i, q, v);
        if (!(S.flag[hub] & SOFT_OFF)) S.detach([hub]);
        if (typeof CrashFx !== 'undefined') CrashFx.wheelOff(q, v);
        C.crashT = Math.max(C.crashT, 0.4);
    }

    // Мотор: пар -> дым -> огонь -> взрыв; мощность падает.
    _engineState(dt) {
        const S = this.soft, C = this.car, F = this.full;
        const hit = (S.zones[5] * 2.2 + S.zones[0] * 0.55) / F;
        this.engine = Math.max(this.engine, Math.min(1, hit));
        const e = this.engine;
        if (this.exploded) this.state = 'dead';
        else if (e > 0.82) this.state = 'fire';
        else if (e > 0.42) this.state = 'smoke';
        else this.state = 'ok';
        C.powerK = this.exploded || e >= 1 ? 0 : e < 0.25 ? 1 : Math.max(0.12, 1 - (e - 0.25) * 1.15);
        if (e >= 1 || this.exploded) { if (C.throttle > 0) C.throttle = 0; }
        if (typeof CrashFx === 'undefined') return;
        // пар — сразу после пробитого радиатора, дым и огонь — позже
        const steam = e > 0.2 ? Math.min(1, (e - 0.2) * 3.2) : 0;
        const smoke = e > 0.42 ? Math.min(1, (e - 0.42) * 2.4) : 0;
        const fire = e > 0.82 ? Math.min(1, (e - 0.82) * 6) : 0;
        if ((steam > 0 || this.exploded) && !this.emitter && this.on.engineEmitter) this.emitter = this.on.engineEmitter();
        if (this.emitter) this.emitter.set(this.exploded ? 0 : steam * (1 - smoke * 0.7), this.exploded ? 1 : smoke, this.exploded ? 0.7 : fire);
        // след на дороге
        this.leakT -= dt;
        if (e > 0.32 && this.leakT <= 0 && C.grounded) {
            this.leakT = 0.28 + Math.random() * 0.3;
            const en = this.def.engine[0], q = this._hubWorld(en);
            const Wrld = typeof GameWorld !== 'undefined' && GameWorld.active ? GameWorld : null;
            q[1] = Wrld ? Wrld.heightAt(q[0], q[2]) : C.p[1];
            CrashFx.leak(q, e > 0.6 && Math.random() < 0.5 ? 'fuel' : Math.random() < 0.6 ? 'oil' : 'coolant', Math.min(1, e));
        }
        // огонь: через какое-то время — взрыв
        if (fire > 0 && !this.exploded) {
            this.fireT += dt;
            if (!this.boomT) this.boomT = 5 + Math.random() * 7;
            if (this.fireT > this.boomT) this.explode();
        }
    }

    /** Взрыв машины: узлы разлетаются, панели срываются, кузов обгорает. */
    explode() {
        if (this.exploded) return;
        const C = this.car, S = this.soft;
        this.exploded = true; this.state = 'dead'; this.engine = 1;
        if (!S.awake) S.wake(C);
        const en = this.def.engine[0], x = S.x[en], y = S.y[en], z = S.z[en];
        S.blast(x, y, z, 420, 2600);
        C.v[1] += 700;
        C.crashT = 3;
        for (const name of Object.keys(this.panels)) {
            if (this.panelState[name] >= 2) continue;
            const p = this.panels[name];
            for (const b of p.latch.concat(p.hinge)) S.YT[b] *= 0.08;
            if (Math.random() < 0.75) {
                for (const i of p.nodes) { const dx = S.x[i] - x, dy = S.y[i] - y + 80, dz = S.z[i] - z, d = Math.hypot(dx, dy, dz) + 1, k = 2200 / d; S.vx[i] += dx * k; S.vy[i] += dy * k; S.vz[i] += dz * k; }
            }
        }
        if (typeof CrashFx !== 'undefined') { CrashFx.explosion([x, y, z], 1); CrashFx.scorch([x, C.p[1], z], [0, 1, 0], 420); }
        if (this.on.explode) this.on.explode([x, y, z]);
    }

    /** Откуда пришёл последний удар: 'front' | 'rear' | 'side' | 'roof' | 'car'. */
    hitKind() {
        const S = this.soft, i = this.lastHit, C = this.car;
        if (i < 0) return 'front';
        if (S.cSurf[i] === SOFT_SURF_CAR) return 'car';
        const x = S.rx[i], y = S.ry[i], L = C.spec.L;
        if (y > C.spec.H * 0.72 && Math.abs(x) < L * 0.3) return 'roof';
        return x > L * 0.22 ? 'front' : x < -L * 0.22 ? 'rear' : 'side';
    }

    /** Модель для GameHud.setDamage. */
    hud() {
        return { total: this.total, zones: this.zones, wheels: this.wheels, engine: this.engine, state: this.state };
    }
}
CarDamage._groups = [0, 1, 2, 3, 4].map(() => ({ imp: 0, slip: 0, i: -1 }));

/**
 * Обломки: оторванные панели и колёса. Твёрдое тело на единичную массу с точками контакта; вид — меш, который двигает игра.
 * Шаг без Babylon: позу забирает body.onPose. Спят, когда лежат; у каждого срок, самые старые исчезают первыми.
 * @satisfies {Record<string, any>}
 */
const CarDebris = {
    /** @type {any[]} */ list: [],
    max: 14,
    _hit: { nx: 0, ny: 0, nz: 0, d: 0, qx: 0, qy: 0, qz: 0 },
    _nrm: [0, 1, 0],
    /** @type {any[]} */ _cols: [],

    /**
     * @param {any} b { p, q, v, w, pts, R, wheel?, surface?, life?, onPose?(b), onDrop?(b) }
     */
    add(b) {
        const lim = typeof IS_MOBILE !== 'undefined' && IS_MOBILE ? 8 : this.max;
        while (this.list.length >= lim) { const old = this.list.shift(); if (old.onDrop) old.onDrop(old); }
        b.t = 0; b.rest = 0; b.asleep = false; b.nearT = 0;
        b.life = b.life || 26;
        this.list.push(b);
        return b;
    },

    clear() { for (const b of this.list) if (b.onDrop) b.onDrop(b); this.list.length = 0; },

    /** Шаг всех обломков. */
    update(dt) {
        const h = Math.min(dt, 1 / 30), n = Math.max(1, Math.ceil(h * 180)), s = h / n;
        for (let i = this.list.length - 1; i >= 0; i--) {
            const b = this.list[i];
            b.t += dt;
            if (b.t > b.life) { if (b.onDrop) b.onDrop(b); this.list.splice(i, 1); continue; }
            if (b.asleep) continue;
            for (let k = 0; k < n; k++) this._step(b, s);
            if (b.onPose) b.onPose(b);
        }
    },

    _step(b, h) {
        const g = typeof CAR_GRAVITY !== 'undefined' ? CAR_GRAVITY : 2200;
        const v = b.v, w = b.w, p = b.p, q = b.q;
        v[1] -= g * h;
        p[0] += v[0] * h; p[1] += v[1] * h; p[2] += v[2] * h;
        const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
        q[0] += 0.5 * h * (w[0] * qw + w[1] * qz - w[2] * qy);
        q[1] += 0.5 * h * (w[1] * qw + w[2] * qx - w[0] * qz);
        q[2] += 0.5 * h * (w[2] * qw + w[0] * qy - w[1] * qx);
        q[3] += 0.5 * h * (-w[0] * qx - w[1] * qy - w[2] * qz);
        const ql = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
        q[0] /= ql; q[1] /= ql; q[2] /= ql; q[3] /= ql;
        const W = typeof GameWorld !== 'undefined' && GameWorld.active ? GameWorld : null;
        b.nearT -= h;
        if (b.nearT <= 0) {
            b.nearT = 0.05;
            b.cols = b.cols || [];
            b.cols.length = 0;
            if (typeof ObbyCourse !== 'undefined' && ObbyCourse._near) {
                const R = b.R + 60, tmp = this._cols;
                ObbyCourse._near(p[0] - R, p[2] - R, p[0] + R, p[2] + R, tmp);
                for (const c of tmp) if (c.enabled !== false && !c.zone && c.aabb[1] < p[1] + R && c.aabb[4] > p[1] - R) b.cols.push(c);
            }
        }
        const I = b.R * b.R * 0.4 + 200;      // момент инерции на единицу массы
        const hit = this._hit, nrm = this._nrm;
        let touched = false;
        const qqx = q[0], qqy = q[1], qqz = q[2], qqw = q[3];
        for (const P of b.pts) {
            const x = P[0], y = P[1], z = P[2];
            const tx = 2 * (qqy * z - qqz * y), ty = 2 * (qqz * x - qqx * z), tz = 2 * (qqx * y - qqy * x);
            const rx = x + qqw * tx + (qqy * tz - qqz * ty), ry = y + qqw * ty + (qqz * tx - qqx * tz), rz = z + qqw * tz + (qqx * ty - qqy * tx);
            const wx = p[0] + rx, wy = p[1] + ry, wz = p[2] + rz;
            let nx = 0, ny = 0, nz = 0, depth = 0;
            if (W) {
                const gy = W.heightAt(wx, wz);
                if (wy < gy) { W.normalAt(wx, wz, nrm); nx = nrm[0]; ny = nrm[1]; nz = nrm[2]; depth = (gy - wy) * ny; }
            }
            if (!depth && b.cols) for (const c of b.cols) {
                if (SoftBody.pointCol(c, wx, wy, wz, 1, hit) && hit.d < 1) { nx = hit.nx; ny = hit.ny; nz = hit.nz; depth = 1 - hit.d; break; }
            }
            if (!depth) continue;
            touched = true;
            p[0] += nx * depth; p[1] += ny * depth; p[2] += nz * depth;
            // скорость точки
            const vx = v[0] + w[1] * rz - w[2] * ry, vy = v[1] + w[2] * rx - w[0] * rz, vz = v[2] + w[0] * ry - w[1] * rx;
            const vn = vx * nx + vy * ny + vz * nz;
            if (vn >= 0) continue;
            const cx = ry * nz - rz * ny, cy = rz * nx - rx * nz, cz = rx * ny - ry * nx;
            const m = 1 + (cx * cx + cy * cy + cz * cz) / I;
            const e = b.wheel ? 0.42 : 0.2;
            const j = -vn * (1 + (vn < -160 ? e : 0)) / m;
            v[0] += nx * j; v[1] += ny * j; v[2] += nz * j;
            w[0] += cx * j / I; w[1] += cy * j / I; w[2] += cz * j / I;
            // трение
            let tvx = vx - nx * vn, tvy = vy - ny * vn, tvz = vz - nz * vn;
            const tl = Math.hypot(tvx, tvy, tvz);
            if (tl > 1) {
                tvx /= tl; tvy /= tl; tvz /= tl;
                const ctx = ry * tvz - rz * tvy, cty = rz * tvx - rx * tvz, ctz = rx * tvy - ry * tvx;
                const mt = 1 + (ctx * ctx + cty * cty + ctz * ctz) / I;
                const mu = b.wheel ? 0.9 : 0.5, jt = Math.min(tl / mt, mu * j);
                v[0] -= tvx * jt; v[1] -= tvy * jt; v[2] -= tvz * jt;
                w[0] -= ctx * jt / I; w[1] -= cty * jt / I; w[2] -= ctz * jt / I;
            }
            if (j > 500 && typeof CrashFx !== 'undefined') {
                const now = b.t;
                if (!b.hitT || now - b.hitT > 0.09) { b.hitT = now; CrashFx.impact([wx, wy, wz], [nx, ny, nz], Math.min(0.45, j / 2600), b.surface || 'metal', true); }
            }
        }
        const ang = touched ? Math.max(0, 1 - 2 * h) : Math.max(0, 1 - 0.12 * h);
        w[0] *= ang; w[1] *= ang; w[2] *= ang;
        if (touched && !b.wheel) { const k = Math.max(0, 1 - 1.4 * h); v[0] *= k; v[2] *= k; }
        const sp = Math.hypot(v[0], v[1], v[2]) + Math.hypot(w[0], w[1], w[2]) * 40;
        if (touched && sp < 26) { b.rest += h; if (b.rest > 0.35) { b.asleep = true; v[0] = v[1] = v[2] = 0; w[0] = w[1] = w[2] = 0; } } else b.rest = 0;
    },

    /** Машина пронеслась сквозь обломок: он отлетает (мягкий толчок, сетку не тревожит). */
    kick(x, y, z, r, vx, vy, vz) {
        for (const b of this.list) {
            const dx = b.p[0] - x, dy = b.p[1] - y, dz = b.p[2] - z, R = r + b.R;
            if (dx * dx + dy * dy + dz * dz > R * R) continue;
            b.asleep = false; b.rest = 0;
            const sp = Math.hypot(b.v[0] - vx, b.v[1] - vy, b.v[2] - vz);
            if (sp < 200) continue;
            b.v[0] += (vx - b.v[0]) * 0.7; b.v[1] += Math.abs(vx - b.v[0] + vz - b.v[2]) * 0.1 + 80; b.v[2] += (vz - b.v[2]) * 0.7;
            b.w[0] += (Math.random() - 0.5) * 10; b.w[2] += (Math.random() - 0.5) * 10;
        }
    },
};
