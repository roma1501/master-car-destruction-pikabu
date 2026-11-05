// GameTraffic.js — живое движение на дорогах мира: трафик и припаркованные машины. Те же физика и сетка, что у игрока и ботов
// (createCar + carEquipDamage + CarWorld), поэтому столкновения с игроком и ботами — настоящие (SoftBody.pair).
//
// Маркеры карты (ставит автор карты, параметры — слова ключ=значение в имени, как у GameWorld):
//   parked [id=van]                       машина у дороги; rot[1] — курс (°), id — модель (нет — любая из TRAFFIC_CARS)
//   traffic road=<id дороги> dir=1 lane=300 n=8
//       поток вдоль оси дороги GameWorld.roadById[id]: dir ±1 — по росту длины дуги или против, lane — смещение полосы от оси
//       (правостороннее движение: машина едет справа от оси по ходу; lane=300 при dir=1 и dir=−1 — две встречные полосы),
//       n — сколько машин в потоке на всей дороге (бюджет живых одновременно — TRAFFIC_MAX на ПК, TRAFFIC_MAX_LOW на телефоне).
//       Положение маркера не важно.
//
// Устройство. Все машины — из пула: он создаётся один раз под экраном загрузки (Traffic.build), в кадре «живы» только те, что
// рядом с игроком (ближе TRAFFIC_ACTIVE_R / PARKED_ON). Остальной поток — «виртуальные» машины: просто позиция вдоль дороги и
// скорость, без физики; подъезжая к игроку на TRAFFIC_ACTIVE_R, виртуальная берёт машину из пула (появляется вне кадра и
// далеко), удаляясь на TRAFFIC_DESPAWN_R — возвращается в поток. Живая едет автопилотом: держит полосу (погоня за точкой на
// полосе), скорость TRAFFIC_KMH_MIN…MAX, притормаживает на поворотах и перед машиной впереди (бот, игрок, другой трафик),
// получив удар — «пострадавшая»: глохнет, катится, и через TRAFFIC_HURT_MIN…MAX секунд вне поля зрения её заменяет новая
// (машина пула чинится car.reset: форма и вид повреждений). Припаркованные спят (ручник, низкий hz), просыпаются от контакта,
// их можно разбить; вернутся в строй целыми, когда игрок отъедет и вернётся (разбитые остаются, пока нужен слот).
// Логика без Babylon (вид — только если Traffic.build получил view): проверяется в node, tools/traffic-lab.mjs.
//
// API (основная сессия):
//   await Traffic.build({ view, map })    под экраном загрузки, после Bots.build; view — Babylon-вид (нет — без вида), map — карта
//   Traffic.update(dt, { car, eye })      каждый кадр перед CarWorld.flush: автопилот, появление и исчезновение (eye — камера)
//   Traffic.frame(dt, eye)                каждый кадр после CarWorld.flush: damage.update, шкура, поза вида, эффекты
//   Traffic.reset()                       новый заезд: всё обратно в пул, поток и припаркованные расставляются заново
//   Traffic.clear()                       убрать всё (смена карты — build зовёт сам)
//   Traffic.list                          живые записи { kind: 'traffic' | 'parked', car, view, state, value, id, … }
//   Traffic.on.hit(entry, power)          игрок ударил участника (или участник — игрока): зовётся в конце серии ударов (через ~0.5 с после последнего),
//                                         entry.value — весь ущерб машины, $ (damage.value), entry.damage — ущерб этой серии

// --- настройка (px, с, px/с, км/ч) ---
const TRAFFIC_MAX = 10;              // живых машин потока одновременно на ПК
const TRAFFIC_MAX_LOW = 3;           // на телефоне и при низком качестве
const PARKED_MAX = 8;                // живых припаркованных на ПК
const PARKED_MAX_LOW = 3;
const TRAFFIC_KMH_MIN = 40;          // крейсерская скорость машины потока: случайная между MIN и MAX (км/ч; STM_KMH игры)
const TRAFFIC_KMH_MAX = 90;
const TRAFFIC_ACTIVE_R = 36000;      // px до игрока: ближе виртуальная машина потока оживает (берёт машину из пула)
const TRAFFIC_DESPAWN_R = 40000;     // px: дальше живая возвращается в поток
const TRAFFIC_SPAWN_MIN = 20000;     // px: ближе к игроку новая машина не появляется (появилась бы на глазах)
const TRAFFIC_SPAWN_SEEN = 30000;    // px: в кадре новая появляется только дальше этого
const TRAFFIC_INIT_MIN = 6000;       // px: при расстановке на старте заезда ближе игрока и решётки никого
const TRAFFIC_LAT_ACC = 650;         // px/с²: допустимое поперечное ускорение в поворотах
const TRAFFIC_BRAKE = 1100;          // px/с²: торможение, на которое рассчитывает водитель перед препятствием (физика даёт до ~2500)
const TRAFFIC_GAP_MIN = 400;         // px: остановка за машиной впереди
const TRAFFIC_JAM_SEC = 14;          // с: стоит в очереди — и вне кадра её заменяют (заторы за аварией не копятся)
const TRAFFIC_SPACING = 3500;        // px: машины одного потока не ближе друг к другу при расстановке и замене
const TRAFFIC_LOOK_BASE = 700;       // px: цель погони впереди = это + скорость × TRAFFIC_LOOK_K
const TRAFFIC_LOOK_K = 0.5;
const TRAFFIC_HURT_POWER = 0.05;     // удар (CarDamage power 0..1) сильнее — машина пострадала
const TRAFFIC_HURT_TOTAL = 0.08;     // или damage.total выше
const TRAFFIC_HURT_MIN = 8;          // с: пострадавшая лежит минимум столько, потом меняется (вне кадра)
const TRAFFIC_HURT_MAX = 15;
const TRAFFIC_HURT_HIDE = 9000;      // px: пострадавшую меняют только дальше этого и вне кадра (или дальше TRAFFIC_SPAWN_SEEN)
const TRAFFIC_HURT_FORCE = 80;       // с: не дольше этого (когда игрок далеко)
const TRAFFIC_HIT_MIN = 0.03;        // удар сильнее этого по игроку/от игрока — событие Traffic.on.hit
const PARKED_ON = 26000;             // px до игрока: припаркованная оживает
const PARKED_OFF = 32000;            // px: дальше — возвращается в пул (целая; разбитая держится, пока не нужен слот)
const PARKED_SEEN = 20000;           // px: в кадре ближе этого припаркованная не появляется
const PARKED_HZ = 30;                // частота подшагов спящей припаркованной
const TRAFFIC_HZ_NEAR = 120;         // частота подшагов автопилота рядом с игроком
const TRAFFIC_HZ_FAR = 60;
const TRAFFIC_NEAR = 12000;          // px: ближе — TRAFFIC_HZ_NEAR и эффекты
const TRAFFIC_SHOW_R = 32000;        // px: дальше вид не показывается
const TRAFFIC_CARS = ['pocket', 'van', 'bus', 'pickup', 'finny', 'cruiser', 'wedge', 'rally', 'buggy'];   // «гражданские» модели пула

const trafficClamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Длина дуги в пределах дороги: у замкнутой — по кругу, у открытой — в [0, длина]. */
function trafficWrap(R, s) {
    const L = R.length;
    if (R.closed) return ((s % L) + L) % L;
    return s < 0 ? 0 : s > L ? L : s;
}

/**
 * Ближайшая точка оси дороги R к (x, z): { s — длина дуги, lat — вправо от оси (px), i — сегмент, d — расстояние }.
 * hint — прошлый сегмент: ищем рядом с ним (≥ 0), иначе или если далеко — по всей дороге. Результат — общий объект.
 */
function trafficProject(R, x, z, hint) {
    const X = R.X, Z = R.Z, segs = R.n - 1;
    let best = -1, bd = Infinity, bu = 0;
    const test = (i) => {
        const ax = X[i], az = Z[i], dx = X[i + 1] - ax, dz = Z[i + 1] - az, L2 = dx * dx + dz * dz || 1;
        let u = ((x - ax) * dx + (z - az) * dz) / L2;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const px = x - (ax + dx * u), pz = z - (az + dz * u), d = px * px + pz * pz;
        if (d < bd) { bd = d; best = i; bu = u; }
    };
    if (hint >= 0) {
        for (let k = -4; k <= 8; k++) {
            let i = hint + k;
            if (R.closed) i = ((i % segs) + segs) % segs; else if (i < 0 || i >= segs) continue;
            test(i);
        }
    }
    if (best < 0 || bd > 4000 * 4000) for (let i = 0; i < segs; i++) test(i);
    const i = best, ax = X[i], az = Z[i], dx = X[i + 1] - ax, dz = Z[i + 1] - az, sl = Math.sqrt(dx * dx + dz * dz) || 1;
    const px = ax + dx * bu, pz = az + dz * bu;
    const o = trafficProject._o;
    o.i = i; o.d = Math.sqrt(bd);
    o.s = R.S[i] + bu * (R.S[i + 1] - R.S[i]);
    o.lat = ((x - px) * (-dz) + (z - pz) * dx) / sl;
    return o;
}
trafficProject._o = { s: 0, lat: 0, i: 0, d: 0 };

/** Предельная скорость на поворотах впереди по ходу dir (px/с): по самой крутой дуге на ближайших ~(700 + 1.7·v) px. */
function trafficCurve(R, s, dir, vf, o) {
    const D = 700 + Math.max(0, vf) * 1.7, steps = 5;
    let f = GameWorld.roadFrame(R, trafficWrap(R, s), o);
    const a0 = Math.atan2(f.tz * dir, f.tx * dir);
    let kmax = 0;
    for (let k = 1; k <= steps; k++) {
        const d = D * k / steps;
        f = GameWorld.roadFrame(R, trafficWrap(R, s + dir * d), o);
        let da = Math.atan2(f.tz * dir, f.tx * dir) - a0;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        const kk = Math.abs(da) / d;
        if (kk > kmax) kmax = kk;
    }
    return kmax > 1e-7 ? Math.sqrt(TRAFFIC_LAT_ACC / kmax) : 1e9;
}

/** @satisfies {Record<string, any>} */
const Traffic = {
    /** @type {any} */ view: null,
    /** @type {any} */ map: null,
    /** @type {() => number} */ rng: Math.random,
    ready: false,
    time: 0,
    /** Живые записи (машины потока и припаркованные, у которых сейчас есть машина пула). */
    /** @type {any[]} */ list: [],
    /** @type {any[]} */ streams: [],
    /** @type {any[]} */ parked: [],
    /** @type {any[]} */ slots: [],
    /** @type {any} */ player: null,
    /** @type {Record<string, (...a: any[]) => void>} */
    on: {},
    nTraffic: 0, nParked: 0,
    needFill: false,
    stats: { spawned: 0, recycled: 0, hurt: 0, released: 0, hits: 0, reseeded: 0 },
    _tick: 0, _fx: 1, _fz: 0, _ex: 0, _ez: 0,
    /** @type {any} */ _f1: {}, /** @type {any} */ _f2: {},
    /** @type {any[]} */ _pl: [],

    // ---------------------------------------------------------------------------------------------
    // Постройка
    // ---------------------------------------------------------------------------------------------

    /** Бюджет живых машин на этом устройстве: { t — поток, p — припаркованные }. */
    limits() {
        const low = (typeof IS_MOBILE !== 'undefined' && IS_MOBILE) || (typeof Quality !== 'undefined' && Quality.level === 0);
        return low ? { t: TRAFFIC_MAX_LOW, p: PARKED_MAX_LOW } : { t: TRAFFIC_MAX, p: PARKED_MAX };
    },

    /**
     * Под экраном загрузки (после Bots.build, GameWorld.buildData уже был): маркеры карты, пул машин.
     * opts: { view (Babylon-вид; нет — без вида), map (карта с маркерами parked и traffic), rng, cars: [id] }.
     */
    async build(opts) {
        const o = opts || {};
        this.clear();
        this.view = o.view || null;
        this.map = o.map || null;
        this.rng = o.rng || Math.random;
        const world = typeof GameWorld !== 'undefined' && GameWorld.active;
        this._parse(this.map);
        if (!world) { this.streams = []; this.parked = []; }
        const lim = this.limits();
        let sumN = 0;
        for (const st of this.streams) sumN += st.n;
        const nT = this.streams.length ? Math.min(lim.t, sumN) : 0;
        const nP = this.parked.length ? Math.min(lim.p, this.parked.length) : 0;
        const civil = (o.cars && o.cars.length ? o.cars : TRAFFIC_CARS).slice().sort(() => this.rng() - 0.5);
        const jobs = [];
        let idx = 0;
        // пул потока: модели по кругу
        for (let i = 0; i < nT; i++) jobs.push(['traffic', civil[i % civil.length]]);
        // пул припаркованных: сначала модели, которых просят маркеры, остальное — любые
        const want = [];
        for (const p of this.parked) if (p.id && !want.includes(p.id)) want.push(p.id);
        for (let i = 0; i < nP; i++) jobs.push(['parked', want[i] || civil[(i + 3) % civil.length]]);
        for (const j of jobs) {
            const slot = await this._makeSlot(j[0], j[1], idx++);
            this.slots.push(slot);
        }
        this.ready = this.streams.length > 0 || this.parked.length > 0;
        this._seedStreams();
        this.needFill = this.ready;
        this.time = 0;
        return this;
    },

    // Маркеры карты → потоки и припаркованные.
    _parse(map) {
        this.streams = []; this.parked = [];
        if (!map || !map.objects) return;
        const world = typeof GameWorld !== 'undefined' && GameWorld.active ? GameWorld : null;
        const par = typeof worldParams === 'function' ? worldParams : (name) => ({ role: String(name).split(/\s+/)[0] });
        for (const d of map.objects) {
            if (!d || d.kind !== 'marker') continue;
            const p = par(d.name);
            if (/^parked(-\d+)?$/.test(p.role)) {
                const rot = Array.isArray(d.rot) ? d.rot : [0, Number(d.rot) || 0, 0];
                this.parked.push({ x: Number(d.x) || 0, z: Number(d.y) || 0, h: Number(d.h) || 0, abs: p.abs === 1, yaw: (Number(rot[1]) || 0) * Math.PI / 180,
                    id: p.id ? String(p.id) : '', entry: null, slot: null });
            } else if (/^traffic(-\d+)?$/.test(p.role) && p.road != null) {
                const R = world && world.roadById[String(p.road)];
                if (!R) { console.warn('Traffic: нет дороги ' + p.road + ' для потока'); continue; }
                const dir = Number(p.dir) < 0 ? -1 : 1, lane = Number.isFinite(p.lane) ? p.lane : 300, n = Math.max(1, Math.min(40, Number.isFinite(p.n) ? Math.round(p.n) : 6));
                this.streams.push({ road: String(p.road), R, dir, lane, latR: lane * dir, n, cars: [] });
            }
        }
    },

    async _makeSlot(kind, id, idx) {
        const car = createCar(carSpec(id));
        car.isBot = true;
        let view = null;
        if (this.view && typeof CarView !== 'undefined') {
            view = new CarView(this.view, 'traf-' + idx);
            await view.setCar(id);
        }
        if (typeof carEquipDamage === 'function' && typeof SoftBody !== 'undefined' && typeof CarLattice !== 'undefined' && typeof CarDamage !== 'undefined') carEquipDamage(car, view, { name: kind + idx });
        this._world(car, false);
        car.frozen = true;
        if (view) view.setVisible(false);
        return { kind, id, idx, car, view, entry: null };
    },

    _world(car, on) {
        if (typeof CarWorld === 'undefined') return;
        if (on) { if (car.soft) CarWorld.add(car); } else CarWorld.remove(car);
    },

    /** Раскидать виртуальные машины потоков по дорогам. */
    _seedStreams() {
        for (const st of this.streams) {
            st.cars = [];
            const L = st.R.length, base = this.rng() * L;
            for (let k = 0; k < st.n; k++) {
                const s = st.R.closed ? (base + (k + this.rng() * 0.5) * L / st.n) % L : 800 + (k + 0.25 + this.rng() * 0.5) * Math.max(1, L - 1600) / st.n;
                const vc = { s, v: 0, cruise: 0, live: null, st };
                this._cruise(vc);
                vc.v = vc.cruise;
                st.cars.push(vc);
            }
        }
    },

    _cruise(vc) {
        const k = typeof STM_KMH !== 'undefined' ? STM_KMH : 0.036;
        vc.cruise = (TRAFFIC_KMH_MIN + this.rng() * (TRAFFIC_KMH_MAX - TRAFFIC_KMH_MIN)) / k;
    },

    clear() {
        for (const e of this.list.slice()) this._release(e);
        for (const s of this.slots) {
            try { if (s.car) this._world(s.car, false); } catch (e) { /* уже */ }
            try { if (s.view) s.view.dispose(); } catch (e) { /* уже */ }
        }
        this.slots = []; this.list = []; this.streams = []; this.parked = [];
        this.nTraffic = 0; this.nParked = 0;
        this.ready = false; this.needFill = false; this.player = null;
        this.stats = { spawned: 0, recycled: 0, hurt: 0, released: 0, hits: 0, reseeded: 0 };
    },

    /** Новый заезд: все машины — в пул; расстановка — при ближайшем update (игрок уже на старте). */
    reset() {
        for (const e of this.list.slice()) this._release(e);
        for (const p of this.parked) { p.entry = null; p.slot = null; }
        this._seedStreams();
        this.needFill = this.ready;
        this.time = 0;
        this._tick = 0;
    },

    // ---------------------------------------------------------------------------------------------
    // Кадр: управление составом
    // ---------------------------------------------------------------------------------------------

    /** Камера и игрок: направление взгляда (камера смотрит на игрока) для проверки «в кадре». */
    _setEye(P, eye) {
        const ex = eye ? eye.x : P.c[0] - Math.cos(P.yaw) * 1000, ez = eye ? eye.z : P.c[2] - Math.sin(P.yaw) * 1000;
        let fx = P.c[0] - ex, fz = P.c[2] - ez;
        const l = Math.hypot(fx, fz);
        if (l < 60) { fx = Math.cos(P.yaw); fz = Math.sin(P.yaw); } else { fx /= l; fz /= l; }
        this._ex = ex; this._ez = ez; this._fx = fx; this._fz = fz;
    },

    /** Косинус угла между направлением камеры и точкой (x, z): > 0.45 — в кадре, < −0.35 — позади камеры. */
    _cos(x, z) {
        const dx = x - this._ex, dz = z - this._ez, l = Math.hypot(dx, dz);
        return l < 400 ? 1 : (dx * this._fx + dz * this._fz) / l;
    },

    /**
     * Главный вход кадра (до CarWorld.flush): состав (появление, возврат в поток, замена), потом автопилот живых.
     * ctx: { car — машина игрока, eye — позиция камеры { x, y, z } }.
     */
    update(dt, ctx) {
        if (!this.ready) return;
        const P = ctx && ctx.car;
        if (!P) return;
        this.player = P;
        this._setEye(P, ctx.eye || null);
        this.time += dt;
        if (this.needFill) { this.needFill = false; this._manage(true); this._tick = 0.15; }
        this._tick -= dt;
        if (this._tick <= 0) { this._tick = 0.15; this._manage(false); }
        this._virtual(dt);
        for (const e of this.list) {
            if (e.kind === 'traffic') this._drive(e, dt); else this._stepParked(e, dt);
        }
    },

    /** Виртуальные машины потоков: едут вдоль дороги, держат дистанцию (в том числе за живыми и пострадавшими). */
    _virtual(dt) {
        for (const st of this.streams) {
            const L = st.R.length, cars = st.cars, dir = st.dir, closed = st.R.closed;
            for (const vc of cars) {
                if (vc.live) { vc.s = vc.live.s; vc.v = Math.abs(vc.live.car.vf); continue; }
                let v = vc.cruise;
                for (const o of cars) {
                    if (o === vc) continue;
                    let g = (o.s - vc.s) * dir;
                    if (closed) g = ((g % L) + L) % L;
                    if (g > 0 && g < 3200) { v = Math.min(v, g < 1500 ? o.v * 0.85 : o.v); }
                }
                vc.v += (v - vc.v) * Math.min(1, dt * 2);
                vc.s += dir * vc.v * dt;
                if (closed) vc.s = ((vc.s % L) + L) % L;
                else if ((dir > 0 && vc.s > L - 500) || (dir < 0 && vc.s < 500)) this._reseed(vc);
            }
        }
    },

    // Состав: оживление виртуальных, возврат живых в поток, замена пострадавших, припаркованные. initial — расстановка на старте.
    _manage(initial) {
        const P = this.player, px = P.c[0], pz = P.c[2], lim = this.limits();
        // --- поток
        /** @type {any[]} */
        const cand = [];
        for (const st of this.streams) {
            const R = st.R;
            for (const vc of st.cars) {
                const e = vc.live;
                if (e) {
                    const B = e.car, d = Math.hypot(B.c[0] - px, B.c[2] - pz);
                    e.d = d;
                    if (B.dead && e.state !== 'hurt') this._hurt(e, 2);
                    if (e.state === 'hurt') {
                        if ((e.hurtT > e.hurtLimit && this._unseen(B.c[0], B.c[2], d)) || (e.hurtT > TRAFFIC_HURT_FORCE && d > TRAFFIC_SPAWN_SEEN * 0.7)) {
                            this._release(e); vc.live = null; this._reseed(vc); this.stats.recycled++;
                        }
                    } else if (d > TRAFFIC_DESPAWN_R) {
                        const s = e.s, cr = e.cruise;
                        this._release(e); vc.live = null; vc.s = s; vc.cruise = cr; vc.v = cr;
                    } else if (e.offT > 6) {                // давно не на дороге (съехала, застряла)
                        this._hurt(e, 3);
                    } else if (e.queueT > TRAFFIC_JAM_SEC && this._unseen(B.c[0], B.c[2], d)) {      // затор: заменить ту, что вне кадра
                        this._hurt(e, 0.1);
                    }
                    continue;
                }
                if (this.nTraffic >= lim.t) continue;
                const fr = GameWorld.roadFrame(R, trafficWrap(R, vc.s), this._f1);
                const x = fr.x + fr.rx * st.latR, z = fr.z + fr.rz * st.latR, d = Math.hypot(x - px, z - pz);
                if (d > TRAFFIC_ACTIVE_R) continue;
                if (initial) { if (d >= TRAFFIC_INIT_MIN) cand.push({ vc, st, d }); continue; }
                if (d < TRAFFIC_SPAWN_MIN) { this._reseed(vc); continue; }          // проспали: появилась бы на глазах
                if (d < TRAFFIC_SPAWN_SEEN && this._cos(x, z) > 0.45) continue;       // в кадре и близко: подождёт
                this._spawnTraffic(vc, st);
            }
        }
        if (initial) {                                   // старт заезда: ближайшие из допустимых, без проверки «в кадре»
            cand.sort((a, b) => a.d - b.d);
            for (const c of cand) { if (this.nTraffic >= lim.t) break; this._spawnTraffic(c.vc, c.st); }
        }
        // --- припаркованные
        let order = this.parked;
        if (initial) order = this.parked.slice().sort((a, b) => Math.hypot(a.x - px, a.z - pz) - Math.hypot(b.x - px, b.z - pz));
        for (const p of order) {
            const d = Math.hypot(p.x - px, p.z - pz);
            const e = p.entry;
            if (e) {
                e.d = d;
                if (d > PARKED_OFF && !(e.car.damage && e.car.damage.total > 0.05)) { this._release(e); p.entry = null; }
                continue;
            }
            if (d > PARKED_ON) continue;
            if (!initial && d < PARKED_SEEN && this._cos(p.x, p.z) > 0.45) continue;
            if (this.nParked >= lim.p) continue;
            this._spawnParked(p, d);
        }
        // слот нужен, а свободных нет: самая дальняя разбитая припаркованная за пределами показа уступает место
        if (this.parked.some(p => !p.entry && Math.hypot(p.x - px, p.z - pz) <= PARKED_ON) && !this.slots.some(s => s.kind === 'parked' && !s.entry)) {
            let far = null, fd = PARKED_OFF;
            for (const p of this.parked) if (p.entry) { const d = Math.hypot(p.x - px, p.z - pz); if (d > fd) { fd = d; far = p; } }
            if (far) { this._release(far.entry); far.entry = null; }
        }
    },

    /** Машину (x, z) не видно игроку: далеко от него и вне кадра (или очень далеко). */
    _unseen(x, z, d) {
        return d > TRAFFIC_HURT_HIDE && (d > TRAFFIC_SPAWN_SEEN || this._cos(x, z) < 0.3);
    },

    /** Перенести виртуальную машину на новое место далеко от игрока, вдоль дороги: чаще впереди по ходу игрока. */
    _reseed(vc) {
        const st = vc.st, R = st.R, P = this.player;
        this.stats.reseeded++;
        this._cruise(vc);
        vc.v = vc.cruise; vc.live = null;
        const L = R.length;
        if (!P) { vc.s = this.rng() * L; return; }
        const pr = trafficProject(R, P.c[0], P.c[2], -1);
        if (pr.d > 90000) { vc.s = R.closed ? this.rng() * L : 800 + this.rng() * Math.max(1, L - 1600); return; }
        const ps = pr.s;
        // «вперёд» — по курсу игрока вдоль дороги
        const fr = GameWorld.roadFrame(R, ps, this._f2);
        const ahead = (Math.cos(P.yaw) * fr.tx + Math.sin(P.yaw) * fr.tz) >= 0 ? 1 : -1;
        for (let k = 0; k < 8; k++) {
            const sign = (this.rng() < 0.65 ? 1 : -1) * ahead * (k >= 4 ? -1 : 1);
            const dist = TRAFFIC_ACTIVE_R + 3000 + this.rng() * 14000;
            let s = ps + sign * dist;
            if (R.closed) s = ((s % L) + L) % L; else if (!(s > 700 && s < L - 700)) continue;
            if (this._roomAt(st, vc, s)) { vc.s = s; return; }
        }
        for (let k = 0; k < 8; k++) {            // рядом с игроком не вышло — где угодно, лишь бы свободно
            const s = R.closed ? this.rng() * L : 800 + this.rng() * Math.max(1, L - 1600);
            if (this._roomAt(st, vc, s)) { vc.s = s; return; }
        }
        vc.s = R.closed ? this.rng() * L : 800 + this.rng() * Math.max(1, L - 1600);
    },

    /** Свободно ли на длине дуги s потока st: другие машины этого потока — не ближе TRAFFIC_SPACING px вдоль дороги. */
    _roomAt(st, self, s) {
        const L = st.R.length;
        for (const o of st.cars) {
            if (o === self) continue;
            let g = Math.abs(o.s - s);
            if (st.R.closed) g = Math.min(g, L - g);
            if (g < TRAFFIC_SPACING) return false;
        }
        return true;
    },

    // ---------------------------------------------------------------------------------------------
    // Пул: взять, поставить, вернуть
    // ---------------------------------------------------------------------------------------------

    _take(kind, id) {
        let any = null;
        for (const s of this.slots) {
            if (s.kind !== kind || s.entry) continue;
            if (id && s.id === id) return s;
            if (!any) any = s;
        }
        return any;
    },

    // Машина пула — на точку (x, h, z) с курсом yaw, ровно и целой (reset чинит сетку и вид повреждений), скорость v вдоль курса.
    _put(slot, x, h, z, yaw, v, vy) {
        const car = slot.car;
        car.frozen = false;
        car.reset(x, h, z, yaw);
        // память ударов панелей (CarDamage.panels[].shock) reset не сбрасывает: у уснувшей после аварии она не спадает и срывает панели при первом пробуждении
        if (car.damage) for (const k in car.damage.panels) car.damage.panels[k].shock = 0;
        if (v) {
            const fx = Math.cos(yaw), fz = Math.sin(yaw);
            car.v[0] = fx * v; car.v[2] = fz * v; car.v[1] = vy || 0; car.vf = v;
            for (const w of car.wheels) w.rate = v / car.spec.R;
        }
        this._world(car, true);
        if (slot.view) { slot.view.setVisible(true); slot.view.pose(car, 0); }
    },

    // На точке (x, z) в радиусе r px уже стоит машина (игрок, бот, живая из пула): ставить сюда новую нельзя.
    _occupied(x, z, r) {
        const r2 = r * r, near = (C) => { const dx = C.c[0] - x, dz = C.c[2] - z; return dx * dx + dz * dz < r2; };
        if (this.player && near(this.player)) return true;
        for (const e of this.list) if (near(e.car)) return true;
        if (typeof Bots !== 'undefined') for (const b of Bots.list) if (!b.off && near(b.car)) return true;
        return false;
    },

    _spawnTraffic(vc, st) {
        const slot = this._take('traffic', '');
        if (!slot) return false;
        const R = st.R, dir = st.dir;
        const f = GameWorld.roadFrame(R, trafficWrap(R, vc.s), this._f1);
        const lat = st.latR;
        const x = f.x + f.rx * lat, z = f.z + f.rz * lat, y = f.y - f.tb * lat;
        if (this._occupied(x, z, 1400)) return false;
        const yaw = Math.atan2(f.tz * dir, f.tx * dir);
        const car = slot.car;
        const vmax = car.cfg().vmax;
        const cruise = Math.min(vc.cruise, vmax * 0.9);
        this._put(slot, x, y, z, yaw, cruise * 0.98, f.slope * dir * cruise);
        const e = { kind: 'traffic', slot, car, view: slot.view, id: slot.id, state: 'drive', stream: st, vc, R, dir, lane: lat, cruise, vmax, s: vc.s, hint: f.i,
            lat: 0, d: 0, hurtT: 0, hurtLimit: TRAFFIC_HURT_MIN + this.rng() * (TRAFFIC_HURT_MAX - TRAFFIC_HURT_MIN), value: 0, damage: 0, ep: null, pend: 0, hitFn: null, born: this.time,
            cv: 1e9, cvT: 0, offT: 0, flipT: 0, stuckT: 0, poseT: 0, poseN: 0, gap: Infinity, vLead: 0, kind2: '', queueT: 0, hitBy: '', hitPower: 0, hitDv: 0, propT: 0, propGap: Infinity };
        slot.entry = e; vc.live = e; vc.cruise = cruise;
        car.on.die = () => { if (e.state !== 'hurt') this._hurt(e, 3); };
        this.list.push(e);
        this.nTraffic++;
        this.stats.spawned++;
        this._hookEntry(e);
        return true;
    },

    _spawnParked(p, d) {
        const slot = this._take('parked', p.id);
        if (!slot) return false;
        if (this._occupied(p.x, p.z, 500)) return false;
        const h = p.abs ? p.h : GameWorld.heightAt(p.x, p.z);
        this._put(slot, p.x, h, p.z, p.yaw, 0, 0);
        const e = { kind: 'parked', slot, car: slot.car, view: slot.view, id: slot.id, state: 'parked', marker: p, d, value: 0, damage: 0, ep: null, pend: 0, hitFn: null,
            born: this.time, poseT: 0, poseN: 0, hurtT: 0, idleT: 0 };
        slot.entry = e; p.entry = e;
        this.list.push(e);
        this.nParked++;
        this.stats.spawned++;
        this._hookEntry(e);
        return true;
    },

    /** Машина обратно в пул: не виден, не считается, не в CarWorld. */
    _release(e) {
        const i = this.list.indexOf(e);
        if (i >= 0) this.list.splice(i, 1);
        const car = e.car, d = car.damage;
        if (e.kind === 'traffic') this.nTraffic--; else this.nParked--;
        e.slot.entry = null;
        if (e.kind === 'parked' && e.marker) e.marker.entry = null;
        if (e.kind === 'traffic' && e.vc && e.vc.live === e) e.vc.live = null;
        if (d) {
            if (typeof CrashFx !== 'undefined' && d._scrapeKeys) for (const k of d._scrapeKeys) CrashFx.scrapeEnd(k);
            if (d.scrapes) d.scrapes.clear();
            if (d.emitter) d.emitter.set(0, 0, 0);
        }
        car.frozen = true;
        this._world(car, false);
        if (e.view) e.view.setVisible(false);
        e.released = true;
        this.stats.released++;
    },

    // ---------------------------------------------------------------------------------------------
    // Удары: пострадавшая машина и события игры
    // ---------------------------------------------------------------------------------------------

    /** Разбор контактов на damage.on.hit (вид повреждений CarSkin вешает свой обработчик — оборачиваем; пересоздание затирает, вешаем снова). */
    _hookEntry(e) {
        const d = e.car.damage;
        if (!d || d.on.hit === e.hitFn) return;
        const prev = d.on.hit;
        e.hitFn = (i, power, dv) => { if (prev) prev(i, power, dv); this._onHit(e, i, power, dv); };
        d.on.hit = e.hitFn;
    },

    _onHit(e, i, power, dv) {
        const S = e.car.soft, P = this.player;
        if (e.kind === 'traffic' && e.state === 'drive' && power >= TRAFFIC_HURT_POWER) {
            const ref = S.cSurf[i] === SOFT_SURF_PROP ? S.cRef[i] : null;       // лёгкий предмет (конус, бочка, шины) не ломает машину
            if (!ref || !(ref.mass < 100)) { e.hitBy = this._who(S, i); e.hitPower = power; e.hitDv = dv; this._hurt(e, 0); }
        }
        if (P && P.soft && S && S.cSurf[i] === SOFT_SURF_CAR && S.cRef[i] === P.soft && power >= TRAFFIC_HIT_MIN) e.pend = Math.max(e.pend, power);
        void dv;
    },

    /** Чем ударило узел i сетки S: 'player' | 'bot<N>' | 'traffic:<id>' | 'parked:<id>' | 'ground' | 'solid' | 'prop:<тип>' (отладка, лаборатория). */
    _who(S, i) {
        const f = S.cSurf[i];
        if (f === SOFT_SURF_GROUND) return 'ground';
        if (f === SOFT_SURF_PROP) return 'prop:' + ((S.cRef[i] && S.cRef[i].type) || '?');
        if (f !== SOFT_SURF_CAR) return 'solid';
        const o = S.cRef[i];
        if (this.player && this.player.soft === o) return 'player';
        if (typeof Bots !== 'undefined') for (const b of Bots.list) if (b.car.soft === o) return 'bot' + b.i;
        for (const e of this.list) if (e.car.soft === o) return e.kind + ':' + e.id;
        return 'car';
    },

    /** Машина потока пострадала: глохнет и катится; через hurtLimit секунд вне кадра её заменит новая. sec > 0 — свой (короткий) срок. */
    _hurt(e, sec) {
        if (e.state === 'hurt') return;
        e.state = 'hurt'; e.hurtT = 0;
        if (sec) e.hurtLimit = sec;
        this.stats.hurt++;
        if (this.on.hurt) this.on.hurt(e);
    },

    // ---------------------------------------------------------------------------------------------
    // Автопилот машины потока
    // ---------------------------------------------------------------------------------------------

    // Тяжёлый неподвижный предмет в полосе впереди (бетонный отбойник, блок, ствол): зазор до него, px. Лёгкое (конусы, бочки) водитель переедет.
    _props(B, fx, fz, D) {
        if (typeof Props === 'undefined' || !Props.near) return Infinity;
        const out = this._pl, rx = -fz, rz = fx;
        const ex = B.c[0] + fx * D, ez = B.c[2] + fz * D;
        Props.near(Math.min(B.c[0], ex) - 250, B.c[1] - 300, Math.min(B.c[2], ez) - 250, Math.max(B.c[0], ex) + 250, B.c[1] + 500, Math.max(B.c[2], ez) + 250, out);
        const kappa = -B.w[1] / Math.max(400, Math.abs(B.vf));
        let gap = Infinity;
        for (let i = 0; i < out.length; i++) {
            const p = out[i];
            if (!(p.mass >= 200) || p.state === 3) continue;
            const hr = p.shape === 0 ? Math.max(p.hx, p.hz) : (p.r || p.hx || 40);
            const dx = p.x - B.c[0], dz = p.z - B.c[2], fwd = dx * fx + dz * fz;
            if (fwd < -hr || fwd > D + hr) continue;
            const lat = dx * rx + dz * rz - 0.5 * kappa * fwd * fwd;
            if (Math.abs(lat) > B.spec.W / 2 + hr + 40) continue;
            const g = fwd - hr - B.spec.L / 2;
            if (g < gap) gap = g;
        }
        return gap;
    },

    // Ближайшая помеха впереди в полосе (игрок, боты, другой трафик, припаркованные; виртуальный лидер потока; предметы): e.gap, e.vLead.
    _ahead(e, B, dt) {
        const fx = Math.cos(B.yaw), fz = Math.sin(B.yaw), rx = -fz, rz = fx;
        const vf = Math.max(0, B.vf);
        const D = 3200 + vf * 1.4;
        const kappa = -B.w[1] / Math.max(400, vf);
        let gap = Infinity, vl = 0;
        const one = (X) => {
            if (X === B || X.dead || X.frozen) return;
            const dy = X.c[1] - B.c[1];
            if (dy > 260 || dy < -260) return;
            const dx = X.c[0] - B.c[0], dz = X.c[2] - B.c[2];
            const fwd = dx * fx + dz * fz;
            if (fwd < -200 || fwd > D) return;
            const lat = dx * rx + dz * rz - 0.5 * kappa * fwd * fwd;
            if (Math.abs(lat) >= (B.spec.W + X.spec.W) / 2 + 50) return;
            const g = fwd - (B.spec.L + X.spec.L) / 2;
            if (g < gap) { gap = g; vl = X.v[0] * fx + X.v[2] * fz; }
        };
        one(this.player);
        for (const o of this.list) if (o !== e) one(o.car);
        if (typeof Bots !== 'undefined') for (const b of Bots.list) if (!b.off) one(b.car);
        // виртуальные машины того же потока впереди (физически их нет, но водитель «знает» поток)
        const st = e.stream, L = e.R.length;
        for (const vc of st.cars) {
            if (vc.live) continue;
            let g = (vc.s - e.s) * e.dir;
            if (e.R.closed) g = ((g % L) + L) % L;
            g -= B.spec.L;
            if (g > 0 && g < D && g < gap) { gap = g; vl = vc.v; }
        }
        e.propT -= dt;
        if (e.propT <= 0) { e.propT = 0.1 + this.rng() * 0.05; e.propGap = this._props(B, fx, fz, D); }
        if (e.propGap < gap) { gap = e.propGap; vl = 0; }
        e.gap = gap; e.vLead = vl;
    },

    _drive(e, dt) {
        const B = e.car, R = e.R, dir = e.dir;
        const pr = trafficProject(R, B.p[0], B.p[2], e.hint);
        e.hint = pr.i; e.s = pr.s; e.lat = pr.lat - e.lane;
        e.offT = Math.abs(e.lat) > R.maxHW + 800 ? e.offT + dt : 0;
        const vf = B.vf, spd = B.speed();
        const hz = e.d < TRAFFIC_NEAR ? TRAFFIC_HZ_NEAR : TRAFFIC_HZ_FAR;
        if (e.state === 'hurt') {
            e.hurtT += dt;
            B.step(dt, { throttle: vf > 150 ? -0.12 : 0, steer: 0, handbrake: vf < 90 && e.hurtT > 1.5 }, hz);
            return;
        }
        // перевёрнута или стоит поперёк: тоже пострадавшая
        if (B.u[1] < 0.4 && spd < 400) { e.flipT += dt; if (e.flipT > 1.5) this._hurt(e, 3); } else e.flipT = 0;
        const Ld = trafficClamp(TRAFFIC_LOOK_BASE + Math.max(0, vf) * TRAFFIC_LOOK_K, TRAFFIC_LOOK_BASE, 2200);
        const f = GameWorld.roadFrame(R, trafficWrap(R, e.s + dir * Ld), this._f1);
        const tx = f.x + f.rx * e.lane, tz = f.z + f.rz * e.lane;
        const fx0 = Math.cos(B.yaw), fz0 = Math.sin(B.yaw), axle = B.spec.halfBase;
        let a = Math.atan2(tz - (B.p[2] + fz0 * axle), tx - (B.p[0] + fx0 * axle)) - B.yaw;
        a = Math.atan2(Math.sin(a), Math.cos(a));
        const steer = trafficClamp(a * 2.4 - (-B.w[1]) * 0.12, -1, 1);
        // скорость: крейсерская, поворот впереди, машина впереди, конец открытой дороги
        let tgt = e.cruise;
        e.cvT -= dt;
        if (e.cvT <= 0) { e.cvT = 0.12; e.cv = trafficCurve(R, e.s, dir, vf, this._f2); }
        if (e.cv < tgt) tgt = Math.max(450, e.cv);
        e.kind2 = '';
        this._ahead(e, B, dt);
        if (e.gap < Infinity) {
            const vl = Math.max(0, e.vLead);
            const v = e.gap < TRAFFIC_GAP_MIN ? vl * Math.max(0, e.gap) / TRAFFIC_GAP_MIN : Math.sqrt(vl * vl + 2 * TRAFFIC_BRAKE * (e.gap - TRAFFIC_GAP_MIN));
            if (v < tgt) { tgt = v; e.kind2 = 'follow'; }
        }
        if (!R.closed) {
            const rest = dir > 0 ? R.length - e.s : e.s;
            tgt = Math.min(tgt, Math.sqrt(2 * TRAFFIC_BRAKE * Math.max(0, rest - 600)));
        }
        const vmaxE = e.vmax * (0.45 + 0.55 * B.powerK);
        tgt = Math.min(tgt, vmaxE * 0.95);
        let thr, hb = false;
        if (vf > tgt + 60) {
            // торможение: догнать профиль скорости и не меньше, чем нужно по кинематике до помехи (иначе отстаёт и въезжает в неё)
            let dec = (vf - tgt) / 0.7;
            if (e.kind2 === 'follow') {
                const vl = Math.max(0, e.vLead);
                dec = Math.max(dec, (vf * vf - vl * vl) / (2 * Math.max(60, e.gap - TRAFFIC_GAP_MIN * 0.5)));
                if (e.gap < 160 && vf > vl + 40) dec = Math.max(dec, 2400);          // вплотную — экстренно
            }
            thr = -trafficClamp(dec / 4200, 0.05, 1);
        } else thr = trafficClamp(tgt / vmaxE + 0.04, 0, 0.85);
        if (tgt < 80 && vf < 140) { thr = 0; hb = true; }
        // застряла на месте при свободной дороге
        if (spd < 40 && tgt > 500 && e.gap > 1500) { e.stuckT += dt; if (e.stuckT > 6) this._hurt(e, 3); } else e.stuckT = 0;
        // стоит в очереди за аварией: долго — вне кадра её заменят
        if (spd < 60 && e.kind2 === 'follow') e.queueT += dt; else e.queueT = Math.max(0, e.queueT - dt * 2);
        B.step(dt, { throttle: thr, steer, handbrake: hb }, hz);
    },

    // Кто-то движущийся (игрок, бот, машина потока) скоро коснётся машины C: ближе R0 обеих машин + запас на скорость за пару кадров.
    // Шагать припаркованные раньше нельзя: CarWorld будит любые две машины ближе суммы описанных сфер, и ряд припаркованных
    // «вплотную» держал бы друг друга бодрствующими (сетка 960 Гц), а проснувшаяся сетка не спит, пока рядом проснувшаяся.
    _someoneNear(C, extra) {
        const test = (X) => {
            if (X === C || X.frozen || X.dead) return false;
            const dx = X.c[0] - C.c[0], dz = X.c[2] - C.c[2], r = 1000 + 0.06 * Math.hypot(X.v[0], X.v[2]) + extra;
            return dx * dx + dz * dz < r * r && Math.abs(X.c[1] - C.c[1]) < 600;
        };
        if (this.player && test(this.player)) return true;
        for (const o of this.list) if (o.kind === 'traffic' && test(o.car)) return true;
        if (typeof Bots !== 'undefined') for (const b of Bots.list) if (!b.off && test(b.car)) return true;
        return false;
    },

    // Припаркованная: ручник; шагаем, только когда кто-то подъезжает вплотную или она ещё движется после удара; успокоившуюся усыпляем.
    _stepParked(e, dt) {
        const B = e.car, S = B.soft;
        const awake = !!(S && S.awake);
        if (this._someoneNear(B, S && S.R0 ? S.R0 : 300)) { e.idleT = 0; B.step(dt, { throttle: 0, steer: 0, handbrake: true }, awake ? 240 : PARKED_HZ); return; }
        if (!awake) return;
        // проснулась и никого рядом: ждём, пока сетка успокоится, и усыпляем (иначе шкура и сетка считались бы каждый кадр)
        e.idleT += dt;
        if (S.maxLocal < 90 && B.speed() < 80) S.sleep(B);
        else B.step(dt, { throttle: 0, steer: 0, handbrake: true }, 240);
        if (e.idleT > 8 && S.awake) S.sleep(B);
    },

    // ---------------------------------------------------------------------------------------------
    // Кадр вида (после CarWorld.flush)
    // ---------------------------------------------------------------------------------------------

    /**
     * После CarWorld.flush: повреждения (damage.update), шкура, поза вида и эффекты живых машин. Далёкие и позади камеры скрыты и
     * не позируются. eye — позиция камеры { x, y, z }.
     */
    frame(dt, eye) {
        const ex = eye ? eye.x : this._ex, ey = eye ? eye.y : 0, ez = eye ? eye.z : this._ez;
        for (const e of this.list) {
            const car = e.car, d = car.damage;
            if (d) {
                const v0 = e.value;
                d.update(dt);
                e.value = d.value;
                if (e.hitFn !== d.on.hit) this._hookEntry(e);
                if (e.kind === 'traffic' && e.state === 'drive' && d.total > TRAFFIC_HURT_TOTAL) this._hurt(e, 0);
                // удар по игроку (или игрока): событие в конце серии ударов, когда ущерб уже набрался (entry.value — весь ущерб машины, entry.damage — за эту серию)
                if (e.pend) {
                    const ep = e.ep || (e.ep = { t: this.time, last: this.time, v0, power: 0 });
                    ep.power = Math.max(ep.power, e.pend); ep.last = this.time; e.pend = 0;
                }
                const ep = e.ep;
                if (ep && (this.time - ep.last > 0.5 || this.time - ep.t > 1.5)) {
                    e.ep = null;
                    e.damage = e.value - ep.v0;
                    this.stats.hits++;
                    if (this.on.hit) this.on.hit(e, ep.power);
                }
            }
            const v = e.view;
            if (!v) continue;
            const dist = Math.hypot(car.c[0] - ex, car.c[1] - ey, car.c[2] - ez);
            const show = dist < TRAFFIC_SHOW_R && (dist < 6000 || this._cos(car.c[0], car.c[2]) > -0.35);
            if (show !== v.visible) v.setVisible(show);
            if (!show) continue;
            if (v.skin) v.skin.update(dt, dist);
            e.poseT += dt;
            if (dist > 22000 && (++e.poseN % 3)) continue;
            const t = e.poseT;
            e.poseT = 0;
            v.pose(car, t);
            if (dist < TRAFFIC_NEAR) v.effects(car, t, { bot: true, on: e.state === 'drive' });
        }
    },

    /** Сводка для лаборатории и отладки. */
    counts() {
        let low = 0;
        for (const s of this.slots) if (s.entry) low++;
        return { traffic: this.nTraffic, parked: this.nParked, pool: this.slots.length, used: low, virtual: this.streams.reduce((n, st) => n + st.cars.filter(c => !c.live).length, 0) };
    },
};
