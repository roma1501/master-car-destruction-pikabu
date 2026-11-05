// GameBots.js — соперники на трассе: едут на той же физике машины (createCar + мягкий кузов carEquipDamage), стартуют с решётки
// вместе с игроком и сами проходят трассу по маршруту карты (маркеры route-N: точка на оси дороги, scale[0] — скорость в долях
// BOT_REF_SPEED, scale[1] — действие: 1 едем, 2 точка отрыва трамплина — держать скорость точно, 3 приземление).
// Автопилот: руль на точку впереди по ломаной маршрута (со смещением по ширине дороги — своя «полоса» бота и объезд), скорость по
// точке маршрута, повороту и умению (с учётом мощности car.powerK), объезд и торможение перед машинами (другие боты, игрок,
// трафик Traffic.list), выжидание вертушек и молотов старых трасс. Агрессия: иногда бот таранит игрока рядом и толкается.
// Столкновения машин считает SoftBody.pair (CarWorld.flush) — здесь только события Bots.on.bump / on.knock по контактам сетки
// (car.damage.on.hit: SOFT_SURF_CAR и cRef — сетка игрока).
// Разбитый бот теряет скорость и управление сам (физика): потерянное колесо, загнутая подвеска. Застрявший бот, бот с
// damage.total > BOTS_EVAC_DAMAGE или без колёс через BOTS_EVAC_MIN…MAX с «эвакуируется»: car.reset на свой чекпоинт, мигает —
// это штраф по времени (стоит BOTS_EVAC_PENALTY секунд). Падать в пропасть на карте мира некуда: dead при 'fall' бывает только за
// краем мира или ниже killY — тогда то же возвращение на чекпоинт. Дальних ботов шагаем с низким hz.
// Логика без Babylon (вид — только если есть CarView), поэтому боты проверяются в node: tools/traffic-lab.mjs, tools/sim-level.mjs.

// --- настройка (px, с, px/с) ---
const BOTS_EVAC_MIN = 4;             // с: застрявший или разбитый бот ждёт, прежде чем «эвакуироваться» (случайно между MIN и MAX)
const BOTS_EVAC_MAX = 6;
const BOTS_EVAC_DAMAGE = 0.85;       // damage.total, с которого бот считается разбитым
const BOTS_EVAC_LOST = 2;            // потерянных колёс, с которых бот не может ехать
const BOTS_EVAC_PENALTY = 1.6;       // с: после эвакуации бот стоит на чекпоинте (штраф по времени)
const BOTS_STUCK_SPEED = 120;        // px/с: медленнее — не едет
const BOTS_STUCK_AFTER = 1;          // с без продвижения по маршруту: застрял, пробует задний ход, потом копится время эвакуации
const BOTS_LOOK_BASE = 320;          // px: прицельная точка впереди — это плюс скорость × BOTS_LOOK_K
const BOTS_LOOK_K = 0.24;
const BOTS_LANE_MAX = 200;           // px: личная «полоса» бота — смещение от оси маршрута вбок (только на дороге мира; у разделителей и кромок — уже, см. _scan)
const BOTS_ROAD_EDGE = 170;          // px: не ближе к кромке дороги
const BOTS_AVOID_RANGE = 3000;       // px: видит машины впереди на столько (плюс скорость × 1.2)
const BOTS_AVOID_MARGIN = 90;        // px: зазор объезда; у лихих меньше
const BOTS_RAM_RANGE = 2600;         // px: игрок ближе — можно таранить
const BOTS_RAM_FIRST = 7;            // с гонки: раньше агрессии нет
const BOTS_RAM_TIME_MIN = 2.5;       // с: сколько длится таран
const BOTS_RAM_TIME_MAX = 4.5;
const BOTS_RAM_COOL_MIN = 7;         // с: пауза между таранами
const BOTS_RAM_COOL_MAX = 18;
const BOTS_RAM_OVER = 420;           // px/с: насколько бот быстрее игрока в момент тарана (умножается на агрессию)
const BOTS_HZ_NEAR = 120;            // подшагов физики в секунду: рядом с игроком
const BOTS_HZ_MID = 60;
const BOTS_HZ_FAR = 40;
const BOTS_NEAR_DIST = 10000;        // px до игрока: ближе — BOTS_HZ_NEAR
const BOTS_MID_DIST = 25000;         // px: ближе — BOTS_HZ_MID, дальше — BOTS_HZ_FAR (и вид позируется реже)

const BOT_NAMES = {
    ru: ['Гайка', 'Турбик', 'Шумахерыч', 'Пилот_99', 'Карбюратор', 'Шина', 'Дымок', 'Форсаж', 'Бампер', 'Кардан',
        'Ласточка', 'Тормоз', 'Стартер', 'Глушак', 'Поршень', 'Педаль', 'Сцепление', 'Клаксон', 'Руль_Огонь', 'Вираж',
        'Каскадёр', 'Бензин', 'Дрифтер', 'Колёсико', 'Пружинка', 'Трамплин', 'Нитро', 'Капот', 'Спойлер', 'Фара'],
    en: ['Sprocket', 'Turbo', 'Piston', 'Pilot_99', 'Skid', 'Nitro', 'Bumper', 'Throttle', 'Gearbox', 'Drifter',
        'Swallow', 'Clutch', 'Starter', 'Muffler', 'Pedal', 'Horn', 'Stuntman', 'Spoiler', 'Headlight', 'Fender'],
};

const botsClamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** @satisfies {Record<string, any>} */
const Bots = {
    /** @type {any} */ view: null,
    /** @type {any[]} */ list: [],
    /** @type {any[]} */ route: [],
    /** @type {number[]} */ cpRoute: [],
    /** @type {any[]} */ haz: [],
    /** @type {any[]} */ zones: [],
    /** @type {HTMLElement | null} */ tags: null,
    /** @type {string[]} */ _names: [],
    /** @type {() => number} */ rng: Math.random,
    time: 0,
    /** Игрок последнего update: { car, alive } (контакты и таран). */
    /** @type {any} */ player: null,
    /** @type {any[]} */ _obs: [],
    /** @type {number[]} */ _cand: [],
    /** @type {any[]} */ _hard: [],
    /** @type {any[]} */ _pl: [],
    _stamp: 0,
    /** Лаборатория: пишет в b.dbg список замеченных машин. */
    debug: false,
    /** Длины сегментов маршрута и накопленная длина до точки (px, по x и z). */
    /** @type {number[]} */ routeL: [],
    /** @type {number[]} */ routeS: [0],
    /** @type {Record<string, (...a: any[]) => void>} */
    on: {},

    cfg() {
        const U = 'undefined';
        return {
            count: IS_MOBILE ? (typeof BOT_COUNT_MOBILE !== U ? BOT_COUNT_MOBILE : 3) : (typeof BOT_COUNT !== U ? BOT_COUNT : 4),
            skillMin: typeof BOT_SKILL_MIN !== U ? BOT_SKILL_MIN : 0.55,
            skillMax: typeof BOT_SKILL_MAX !== U ? BOT_SKILL_MAX : 0.95,
            knock: typeof BOT_KNOCK_SPEED !== U ? BOT_KNOCK_SPEED : 700,
            shield: typeof BOT_SPAWN_SHIELD !== U ? BOT_SPAWN_SHIELD : 2,
            skip: typeof BOT_SKIP_AFTER !== U ? BOT_SKIP_AFTER : 4,
            ref: typeof BOT_REF_SPEED !== U ? BOT_REF_SPEED : 2600,
            rowBack: typeof BOT_GRID_BACK !== U ? BOT_GRID_BACK : 750,
            side: typeof BOT_GRID_SIDE !== U ? BOT_GRID_SIDE : 240,
        };
    },

    /** Сколько ботов на этом устройстве (низкий уровень графики — меньше). */
    count() {
        const n = this.cfg().count;
        const q = typeof Quality !== 'undefined' && Quality.level != null ? String(Quality.level) : 'high';
        return Math.max(0, q === 'low' || q === '0' ? Math.min(n, 2) : n);
    },

    // ---------------------------------------------------------------------------------------------
    // Постройка: маршрут, опасности, боты на решётке
    // ---------------------------------------------------------------------------------------------

    /**
     * Под экраном загрузки уровня (ObbyCourse.build уже был): маршрут, привязка чекпоинтов, боты. Каждому боту сразу ставится
     * сетка и повреждения (carEquipDamage) и он входит в CarWorld — снаружи оснащать не нужно.
     * opts: { view (Babylon-вид для CarView; нет — без вида), count, cars: [id], rng, tags (DOM-слой ников) }.
     */
    async build(opts) {
        const o = opts || {};
        this.clear();
        this.view = o.view || null;
        this.rng = o.rng || Math.random;
        this.tags = o.tags || null;
        this.time = 0;
        this.player = null;
        this.route = ObbyCourse.route.slice();
        // чекпоинт k (этап k) -> индекс точки маршрута
        this.cpRoute = ObbyCourse.stageRoute.slice();
        this.routeL = []; this.routeS = [0];
        for (let i = 0; i + 1 < this.route.length; i++) {
            const a = this.route[i], c = this.route[i + 1], l = Math.hypot(c.x - a.x, c.z - a.z) || 1;
            this.routeL.push(l); this.routeS.push(this.routeS[i] + l);
        }
        this._mapHazards();
        const n = o.count != null ? o.count : this.count();
        const pool = (o.cars && o.cars.length ? o.cars : GAME_CARS.map(c => c.id)).slice();
        const jobs = [];
        for (let i = 0; i < n; i++) jobs.push(this._spawn(i, pool[Math.floor(this.rng() * pool.length)]));
        await Promise.all(jobs);
        this.list.sort((a, b) => a.i - b.i);
        this.toGrid();
    },

    clear() {
        for (const b of this.list) this._dispose(b);
        this.list = [];
    },

    _dispose(b) {
        try { if (b.car && typeof CarWorld !== 'undefined') CarWorld.remove(b.car); } catch (e) { /* уже */ }
        try { if (b.view) b.view.dispose(); } catch (e) { /* уже */ }
        if (b.tag) b.tag.remove();
    },

    _name() {
        const lang = typeof Lang !== 'undefined' && Lang.code === 'en' ? 'en' : 'ru';
        const list = BOT_NAMES[lang];
        if (!this._names.length) this._names = list.slice().sort(() => this.rng() - 0.5);
        return this._names.pop();
    },

    async _spawn(i, carId) {
        const b = {
            i, carId, car: createCar(carSpec(carId)), view: null, name: this._name(), skill: 0, ri: 0, cpRi: 0, stage: 0,
            state: 'grid', deadT: 0, waitT: 0, noise: this.rng() * 10, tag: null, finishT: 0, place: 0, progress: 0,
            fails: 0, lastCp: -1, invT: 0, stuckT: 0, bestD: Infinity, turnT: 0, waited: 0, reckless: false, rash: false,
            recklessT: 0, backT: 0, backRun: false, slowT: 0, holdT: 0, backFor: -1, backN: 0, alignBrake: 0, hzT: 0, hzWait: false, bumpT: 0, knockT: 0,
            // 1.5: агрессия, личная полоса, объезд, эвакуация
            aggr: 0, lane: 0, lat: 0, latAct: 0, seg: 0, segU: 0, latT: 0, hwLim: 0, scanT: 0, obsGap: Infinity, obsV: 0, blocked: false,
            ramT: 0, ramCd: 0, evacT: 0, evacLimit: 5, backCool: 0, backDir: 1, aim: { x: 0, y: 0, z: 0, rx: 0, rz: 1 },
            off: false, hitFn: null, poseT: 0, poseN: 0, pose: true, hurtT: 0,
        };
        const C = this.cfg();
        b.skill = C.skillMin + this.rng() * (C.skillMax - C.skillMin);
        b.rash = this.rng() < (1 - b.skill) * 0.5;
        b.reckless = b.rash;
        b.aggr = this.rng();
        b.lane = (i % 2 ? 1 : -1) * (60 + this.rng() * (BOTS_LANE_MAX - 60));
        b.lat = b.lane; b.latT = b.lane; b.latAct = b.lane;
        b.car.isBot = true;
        b.car.on.die = (reason) => this._die(b, reason);
        if (this.view && typeof CarView !== 'undefined') {
            const cv = new CarView(this.view, 'bot-' + i);
            await cv.setCar(carId);
            b.view = cv;
        }
        if (this.tags && typeof document !== 'undefined') {
            const tag = document.createElement('div');
            tag.className = 'tag off';
            tag.textContent = b.name;
            this.tags.appendChild(tag);
            b.tag = tag;
        }
        this._equip(b);
        this.list.push(b);
    },

    /** Мягкий кузов, повреждения, вид повреждений и вход в CarWorld (один раз; повторный вызов только возвращает в CarWorld). */
    _equip(b) {
        if (typeof carEquipDamage !== 'function' || typeof SoftBody === 'undefined' || typeof CarLattice === 'undefined' || typeof CarDamage === 'undefined') return;
        if (b.car.soft) { if (!CarWorld.has(b.car)) CarWorld.add(b.car); return; }
        carEquipDamage(b.car, b.view, { name: 'bot' + b.i });
    },

    /** Слоты решётки за стартом: два ряда по два, игрок — на самом старте. */
    gridSlot(i) {
        const C = this.cfg(), sp = ObbyCourse.respawn(0);
        const row = Math.floor(i / 2) + 1, side = i % 2 ? 1 : -1;
        const fx = Math.cos(sp.yaw), fz = Math.sin(sp.yaw), rx = -fz, rz = fx;
        // на дороге мира слоты шире суммы описанных сфер двух машин: ближе их CarWorld будит друг друга, и вся решётка считается бодрствующей
        const wide = typeof GameWorld !== 'undefined' && GameWorld.active ? 330 : 0;
        const back = Math.max(C.rowBack, wide ? 760 : 0) * row, lat = Math.max(C.side, wide) * side;
        return { x: sp.x - fx * back + rx * lat, y: sp.y, z: sp.z - fz * back + rz * lat, yaw: sp.yaw };
    },

    /** Высота опоры в точке: земля мира, но детали трассы (мост, плита) выше — главнее. */
    _ground(x, y, z) {
        const world = typeof GameWorld !== 'undefined' && GameWorld.active;
        let h = world ? GameWorld.heightAt(x, z) : y;
        const hit = ObbyCourse.rayDown(x, y + 200, z, 600);
        if (hit && (!world || hit.y > h - 20)) h = hit.y;
        return h;
    },

    /** Все боты — на решётку, стоят до start(). */
    toGrid() {
        for (const b of this.list) {
            const s = this.gridSlot(b.i);
            this._wake(b);
            b.car.reset(s.x, this._ground(s.x, s.y, s.z), s.z, s.yaw);
            this._repaired(b);
            b.ri = 0; b.cpRi = 0; b.stage = 0; b.state = 'grid'; b.finishT = 0; b.place = 0; b.progress = 0; b.fails = 0; b.lastCp = -1;
            b.stuckT = 0; b.slowT = 0; b.holdT = 0; b.bestD = Infinity; b.turnT = 0; b.waited = 0; b.backT = 0; b.backN = 0; b.backFor = -1; b.alignBrake = 0;
            b.invT = 0; b.evacT = 0; b.backCool = 0; b.ramT = 0; b.ramCd = 4 + this.rng() * 8; b.lat = b.latT = b.latAct = b.lane; b.obsGap = Infinity; b.blocked = false;
            b.evacLimit = BOTS_EVAC_MIN + this.rng() * (BOTS_EVAC_MAX - BOTS_EVAC_MIN);
            if (b.view) { b.view.setVisible(true); b.view.setAlpha(1); }
            this._pose(b, 0, true);
        }
    },

    /** Старт гонки: у каждого своя реакция. */
    start() {
        this.time = 0;
        for (const b of this.list) { b.state = 'ride'; b.waitT = 0.08 + this.rng() * (0.5 - 0.35 * b.skill); }
    },

    // car.reset не обнуляет память ударов панелей (CarDamage.panels[].shock): у уснувшей после аварии она не спадает и срывает панели при первом пробуждении.
    _repaired(b) {
        const d = b.car.damage;
        if (d) for (const k in d.panels) d.panels[k].shock = 0;
    },

    /** Бот выбыл из игры (финишировал и скрыт): физика не считается, из CarWorld убран. */
    _sleep(b) {
        if (b.off) return;
        b.off = true;
        b.car.frozen = true;
        if (typeof CarWorld !== 'undefined') CarWorld.remove(b.car);
    },

    _wake(b) {
        b.off = false;
        b.car.frozen = false;
        if (b.car.soft && typeof CarWorld !== 'undefined' && !CarWorld.has(b.car)) CarWorld.add(b.car);
    },

    // ---------------------------------------------------------------------------------------------
    // Опасности у точек маршрута (вертушки, молоты, шины — выждать; движущиеся плиты — дождаться)
    // ---------------------------------------------------------------------------------------------

    _mapHazards() {
        const R = this.route;
        this.haz = R.map(() => null);
        for (const p of ObbyCourse.pieces) {
            if (!p.dynamic || !p.base) continue;
            const tire = p.role === 'move' && p.prm.tire;
            const kind = p.type === 'spinner' ? (p.sy < 330 ? 'spin' : '') : p.type === 'hammer' ? 'hammer' : tire ? 'tire' : p.role === 'move' ? 'move' : '';
            if (!kind) continue;
            const O = p.base.O;
            const span = Math.hypot(p.prm.x || 0, p.prm.z || 0);
            const reach = kind === 'spin' ? p.sx / 2 + 340 : kind === 'hammer' ? p.sy + p.sx / 2 + 340 : kind === 'tire' ? span + p.sx / 2 + 380 : Math.max(p.sx, p.sz) / 2 + 40;
            // молот висит на кране высоко над дорогой: шар достаёт до дороги на длину рукояти и бойка ниже подвеса
            const dyMax = kind === 'hammer' ? p.sy + p.sz + 700 : 900;
            for (let i = 0; i < R.length; i++) {
                const q = R[i];
                if (Math.hypot(q.x - O[0], q.z - O[2]) > reach || Math.abs(q.y - O[1]) > dyMax) continue;
                (this.haz[i] || (this.haz[i] = [])).push({ p, kind });
            }
        }
        // ветряки: лопасти поперёк трассы (Turbines)
        if (typeof Turbines !== 'undefined') for (const T of Turbines.list) {
            for (let i = 0; i < R.length; i++) {
                const q = R[i];
                if (Math.hypot(q.x - T.H[0], q.z - T.H[2]) > T.L + 450 || Math.abs(q.y - T.H[1]) > T.L + 300) continue;
                (this.haz[i] || (this.haz[i] = [])).push({ p: T, kind: 'turbine' });
            }
        }
        // зоны вертушек, молотов, шин и ветряков: от первой до последней задетой точки маршрута
        /** @type {any[]} */
        const zones = [];
        for (let i = 0; i < R.length; i++) for (const h of this.haz[i] || []) {
            if (h.kind === 'move') continue;
            const z = zones.find(q => q.p === h.p && i - q.i1 <= 2);
            if (z) z.i1 = i; else zones.push({ p: h.p, h, i0: i, i1: i });
        }
        this.zones = zones;
    },

    // Расстояние между отрезками a1-a2 и b1-b2 на плоскости (x, z).
    _segDist(a1x, a1z, a2x, a2z, b1x, b1z, b2x, b2z) {
        const pt = (px, pz, sx, sz, ex, ez) => {
            const vx = ex - sx, vz = ez - sz, L = vx * vx + vz * vz;
            const u = L > 1e-9 ? Math.max(0, Math.min(1, ((px - sx) * vx + (pz - sz) * vz) / L)) : 0;
            return Math.hypot(px - (sx + vx * u), pz - (sz + vz * u));
        };
        const cr = (ax, az, bx, bz, cx, cz) => (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
        const d1 = cr(a1x, a1z, a2x, a2z, b1x, b1z), d2 = cr(a1x, a1z, a2x, a2z, b2x, b2z);
        const d3 = cr(b1x, b1z, b2x, b2z, a1x, a1z), d4 = cr(b1x, b1z, b2x, b2z, a2x, a2z);
        if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
        return Math.min(pt(a1x, a1z, b1x, b1z, b2x, b2z), pt(a2x, a2z, b1x, b1z, b2x, b2z), pt(b1x, b1z, a1x, a1z, a2x, a2z), pt(b2x, b2z, a1x, a1z, a2x, a2z));
    },

    // Опасность h для машины с центром q, курсом yaw и половиной длины half в момент трассы t.
    _danger(h, q, t, yaw, half) {
        const p = h.p;
        const hl = half || 240;
        const cy = Math.cos(yaw || 0), sy = Math.sin(yaw || 0);
        const c1x = q.x - cy * hl, c1z = q.z - sy * hl, c2x = q.x + cy * hl, c2z = q.z + sy * hl;
        if (h.kind === 'spin' || h.kind === 'hammer') {
            for (const c of ObbyCourse.capsulesAt(p, t)) {
                const lo = Math.min(c.a[1], c.b[1]) - c.r, hi = Math.max(c.a[1], c.b[1]) + c.r;
                if (q.y != null && (hi < q.y - 40 || lo > q.y + 300)) continue;
                if (this._segDist(c1x, c1z, c2x, c2z, c.a[0], c.a[2], c.b[0], c.b[2]) < c.r + 150) return true;
            }
            return false;
        }
        if (h.kind === 'turbine') {
            // точки корпуса (вдоль и по высоте — низ кузова и крыша высокой машины) против капсул лопастей в момент t
            const y0 = q.y != null ? q.y : h.p.H[1];
            for (const B of Turbines.bladesAt(h.p, t)) {
                const abx = B.b[0] - B.a[0], aby = B.b[1] - B.a[1], abz = B.b[2] - B.a[2], L2 = abx * abx + aby * aby + abz * abz;
                for (const y of [y0 + 90, y0 + 250]) for (const k of [-1, 0, 1]) {
                    const px = q.x + cy * hl * k, pz = q.z + sy * hl * k;
                    const u = Math.max(0, Math.min(1, ((px - B.a[0]) * abx + (y - B.a[1]) * aby + (pz - B.a[2]) * abz) / L2));
                    if (Math.hypot(px - (B.a[0] + abx * u), y - (B.a[1] + aby * u), pz - (B.a[2] + abz * u)) < B.r + 150) return true;
                }
            }
            return false;
        }
        if (h.kind === 'tire') {
            const pose = ObbyCourse.poseAt(p, t, {});
            const r = p.sx / 2;
            const ax = pose.ay, w = p.sy;       // ось шины — локальная Y детали (лежит на боку), ширина — толщина
            const a = [pose.O[0], pose.O[2]], b = [pose.O[0] - ax[0] * w, pose.O[2] - ax[2] * w];
            return this._segDist(c1x, c1z, c2x, c2z, a[0], a[1], b[0], b[1]) < r + 140;
        }
        // движущаяся плита: опасно, если в этот момент точка q (на плите в базовой позе) не лежит на плите с запасом
        const pose = ObbyCourse.poseAt(p, t, {});
        const covered = ObbyCourse.coversPose(p, pose, q.x, q.z, -150) && (q.y == null || Math.abs(pose.O[1] - q.y) < 90);
        return !covered;
    },

    // Проскочит ли бот зону целиком, если поедет сейчас: прибытие к каждой точке зоны по разгону.
    _zoneClear(b, z) {
        const R = this.route, B = b.car;
        const a = B.cfg().accel * 0.7, vz = Math.min(1800, B.cfg().vmax);
        let v = Math.max(0, B.vf), prev = { x: B.p[0], z: B.p[2] }, t = 0;
        const t0 = ObbyCourse.time, half = B.spec.L / 2 + 15;
        for (let j = b.ri; j <= z.i1 + 1 && j < R.length; j++) {
            const q = R[j];
            const d = Math.hypot(q.x - prev.x, q.z - prev.z), yaw = Math.atan2(q.z - prev.z, q.x - prev.x);
            const n = Math.max(1, Math.ceil(d / 120));
            for (let k = 1; k <= n; k++) {
                const dd = d / n;
                const v2 = Math.min(vz, Math.sqrt(v * v + 2 * a * dd));
                t += dd / Math.max(120, (v + v2) / 2);
                v = v2;
                const s = { x: prev.x + (q.x - prev.x) * k / n, y: q.y, z: prev.z + (q.z - prev.z) * k / n };
                for (const dtw of [-0.2, 0, 0.2]) if (this._danger(z.h, s, t0 + t + dtw, yaw, half)) return false;
            }
            prev = q;
        }
        return true;
    },

    /** Впереди движущаяся плита не на месте в момент прибытия: притормозить и выждать. */
    _hazardAhead(b) {
        const R = this.route, B = b.car;
        if (!this.haz) return false;
        const v = Math.max(500, Math.abs(B.vf));
        let dist = 0, prev = { x: B.p[0], z: B.p[2] };
        for (let j = b.ri; j < Math.min(R.length, b.ri + 8); j++) {
            const q = R[j];
            dist += Math.hypot(q.x - prev.x, q.z - prev.z);
            prev = q;
            if (dist > 1600) break;
            const hs = this.haz[j];
            if (!hs) continue;
            if (dist < 150) return false;
            const tau = dist / v, t = ObbyCourse.time, yaw = Math.atan2(q.z - (R[j - 1] || q).z, q.x - (R[j - 1] || q).x) || B.yaw;
            for (const h of hs) {
                if (h.kind !== 'move') continue;
                if (B.wheels.some(w => w.contact && w.col && w.col.piece === h.p)) continue;   // уже на этой плите
                if (dist < 800 && (this._danger(h, q, t + tau, yaw) || this._danger(h, q, t + tau + 0.35, yaw))) return true;
            }
        }
        return false;
    },

    // ---------------------------------------------------------------------------------------------
    // Кадр
    // ---------------------------------------------------------------------------------------------

    /** player: { car, alive } — машина игрока (таран, контакты); null — без игрока (симулятор, меню). Зовётся перед CarWorld.flush. */
    update(dt, player) {
        const R = this.route;
        this.time += dt;
        this.player = player && player.car ? player : null;
        if (!R.length || !this.list.length) return;
        for (const b of this.list) {
            const B = b.car;
            if (b.off) continue;
            this._hook(b);
            if (B.soft && !CarWorld.has(B)) CarWorld.add(B);
            if (B.frozen) continue;              // свободный режим: соперники скрыты и стоят
            const hz = this._hz(b);
            if (b.state === 'grid') B.step(dt, { throttle: 0, steer: 0, handbrake: true }, 90);
            else if (b.state === 'ride') this._drive(b, dt, hz);
            else if (b.state === 'dead') {
                b.deadT -= dt;
                if (!(b.view && !b.view.visible)) B.step(dt, {});
                if (b.deadT < 0.35 && B.deadReason === 'fall' && b.view) b.view.setVisible(false);
                if (b.deadT <= 0) {
                    const tries = this.cfg().skip;
                    b.fails = b.lastCp === b.cpRi ? b.fails + 1 : 1;
                    b.lastCp = b.cpRi;
                    if (b.fails >= tries) {
                        const next = this.cpRoute.findIndex((ci, k) => k > b.stage && k < this.cpRoute.length - 1);
                        b.fails = 0;
                        if (next > 0) { b.stage = next; b.cpRi = this.cpRoute[next]; b.lastCp = b.cpRi; }
                    }
                    this._place(b);
                }
            } else if (b.state === 'finish') {
                b.finishT += dt;
                B.step(dt, { throttle: B.vf > 200 ? -0.6 : 0, steer: 0, handbrake: B.vf < 200 }, 60);
                if (b.finishT > 2.5) { if (b.view) b.view.setVisible(false); this._sleep(b); continue; }
            }
            if (b.invT > 0) {
                b.invT -= dt;
                if (b.view) b.view.setAlpha(b.invT > 0 ? (Math.floor(b.invT * 8) % 2 ? 0.35 : 0.85) : 1);
            }
            if (b.state === 'ride' || b.state === 'grid') b.progress = Math.max(b.progress, ObbyCourse.progress(b.stage, B.p[0], B.p[1], B.p[2]));
            this._pose(b, dt, false);
        }
    },

    /** Частота подшагов физики: дальние от игрока шагают реже (спящий кузов считается дёшево, шагает в основном шасси). */
    _hz(b) {
        const P = this.player && this.player.car;
        if (!P) return BOTS_HZ_NEAR;
        const B = b.car, d = Math.hypot(B.c[0] - P.c[0], B.c[2] - P.c[2]);
        return d < BOTS_NEAR_DIST ? BOTS_HZ_NEAR : d < BOTS_MID_DIST ? BOTS_HZ_MID : BOTS_HZ_FAR;
    },

    /** Вернуть бота на его чекпоинт (после падения или эвакуации): чинит кузов, мигает и стоит BOTS_… секунд. */
    _place(b) {
        const s = ObbyCourse.respawn(b.stage);
        this._wake(b);
        // в сторону от оси — на свою полосу (на мосту и в мире высоту даёт чекпоинт)
        const fx = Math.cos(s.yaw), fz = Math.sin(s.yaw);
        const lat = typeof GameWorld !== 'undefined' && GameWorld.active ? b.lane * 0.5 : 0;
        b.car.reset(s.x - fz * lat, s.y - 20, s.z + fx * lat, s.yaw);
        this._repaired(b);
        b.ri = this.cpRoute[b.stage] || 0;
        b.cpRi = b.ri;
        b.state = 'ride';
        b.waitT = 0.3 + this.rng() * 0.7;
        b.invT = this.cfg().shield;
        b.stuckT = 0; b.slowT = 0; b.holdT = 0; b.bestD = Infinity; b.turnT = 0; b.waited = 0; b.recklessT = 0; b.backT = 0; b.backFor = -1; b.backN = 0; b.alignBrake = 0;
        b.evacT = 0; b.backCool = 0; b.ramT = 0; b.ramCd = 5 + this.rng() * 8; b.lat = b.latT = b.latAct = b.lane; b.obsGap = Infinity; b.blocked = false;
        b.evacLimit = BOTS_EVAC_MIN + this.rng() * (BOTS_EVAC_MAX - BOTS_EVAC_MIN);
        b.reckless = b.rash;
        if (b.view) b.view.setVisible(true);
        this._pose(b, 0, true);
    },

    /** Эвакуация: застрял, разбит или без колёс — на чекпоинт со штрафом по времени. */
    _evac(b, reason) {
        this._place(b);
        b.waitT += BOTS_EVAC_PENALTY;
        if (this.on.evac) this.on.evac(b, reason);
    },

    /** Бот не может ехать сам: разбит, без колёс или взорван. */
    _crippled(b) {
        const B = b.car, D = B.damage;
        if (!D) return false;
        let lost = 0;
        for (const w of B.wheels) if (w.lost) lost++;
        return D.total > BOTS_EVAC_DAMAGE || lost >= BOTS_EVAC_LOST || D.exploded || D.state === 'dead';
    },

    // Смотрит на машины впереди (боты, игрок, трафик). Каждая — полоса поперёк маршрута [lat − hw − зазор, lat + hw + зазор], где она занята;
    // бот выбирает смещение вбок, ближайшее к текущему, вне всех занятых полос и в пределах дороги. Нет свободного — тормозит до
    // скорости ближайшей на пути (blocked). Положение — от маршрута (b.latAct), поэтому объезд не мечется на поворотах.
    _scan(b, B) {
        const R = this.route, RS = this.routeS, RL = this.routeL, i0 = b.seg;
        const sB = RS[i0] + b.segU * RL[i0];
        const vf = Math.max(0, B.vf);
        const D = (BOTS_AVOID_RANGE + vf * 1.2) * (0.55 + 0.45 * b.skill);
        const margin = BOTS_AVOID_MARGIN * (b.rash ? 0.25 : 1.3 - 0.5 * b.skill);
        const ram = b.ramT > 0;
        const obs = this._obs;
        obs.length = 0;
        const one = (X, isPlayer) => {
            if (X === B || X.dead || X.frozen) return;
            const dy = X.c[1] - B.c[1];
            if (dy > 260 || dy < -260) return;
            const dx = X.c[0] - B.c[0], dz = X.c[2] - B.c[2], far = D + 4200;
            if (dx * dx + dz * dz > far * far) return;
            // проекция машины на маршрут впереди: длина пути до неё и смещение вбок от маршрута (вправо по ходу)
            let best = -1, bd = Infinity, bu = 0;
            for (let i = Math.max(0, i0 - 1); i < R.length - 1 && RS[i] < sB + far; i++) {
                const a = R[i], c = R[i + 1], vx = c.x - a.x, vz = c.z - a.z;
                let t = ((X.c[0] - a.x) * vx + (X.c[2] - a.z) * vz) / (vx * vx + vz * vz || 1);
                t = t < 0 ? 0 : t > 1 ? 1 : t;
                const px = X.c[0] - (a.x + vx * t), pz = X.c[2] - (a.z + vz * t), d = px * px + pz * pz;
                if (d < bd) { bd = d; best = i; bu = t; }
            }
            if (best < 0 || bd > 1100 * 1100) return;
            const a = R[best], c = R[best + 1], L = RL[best], tx = (c.x - a.x) / L, tz = (c.z - a.z) / L;
            const ahead = RS[best] + bu * L - sB;
            const vX = X.v[0] * tx + X.v[2] * tz;
            if (ahead < -250 || ahead > D + Math.max(0, -vX) * 0.8) return;       // встречная опаснее: ближе по времени
            if (isPlayer && ram) return;
            const lat = (X.c[0] - (a.x + (c.x - a.x) * bu)) * (-tz) + (X.c[2] - (a.z + (c.z - a.z) * bu)) * tx;
            // встречную и стоящую обходят с запасом даже лихие: на сближении 150 км/ч «чуть-чуть» — это уже удар
            obs.push({ lat, hw: (B.spec.W + X.spec.W) / 2 + (vX < 150 ? 45 : 0), g: ahead - (B.spec.L + X.spec.L) / 2, v: vX });
        };
        for (const o of this.list) if (o !== b && !o.off && o.state !== 'dead') one(o.car, false);
        const P = this.player;
        if (P && P.alive && P.car) one(P.car, true);
        if (typeof Traffic !== 'undefined') for (const e of Traffic.list) one(e.car, false);
        if (b.hwLim > 0) this._propObs(b, B, sB, D, obs);
        const lim = b.hwLim;
        let latT = b.lane, blocked = false, gap = Infinity, vObs = 0;
        if (obs.length) {
            if (lim > 0) {
                // свободная полоса среди всех машин; нет — среди встречных (их не пересидеть: их объезжаем всегда), за попутной едем следом
                let sol = this._solve(obs, margin, lim, b);
                if (sol === null) {
                    const hard = this._hard;
                    hard.length = 0;
                    for (const o of obs) if (o.v < 150) hard.push(o);
                    sol = hard.length ? this._solve(hard, margin, lim, b) : b.latAct;
                    blocked = true;
                }
                if (sol === null) { sol = this._widest(obs, lim, b.latAct); blocked = true; }
                latT = sol;
            } else for (const o of obs) if (Math.abs(o.lat - b.latAct) < o.hw + margin) blocked = true;
            // ближайшая на пути — и по выбранному смещению, и по текущему положению (пока идёт перестроение)
            for (const o of obs) {
                if (o.g < -B.spec.L * 0.6) continue;                       // рядом или позади: скорость не ограничивает
                if ((Math.abs(o.lat - latT) < o.hw + 30 || Math.abs(o.lat - b.latAct) < o.hw + 30) && o.g < gap) { gap = o.g; vObs = o.v; }
            }
        }
        if (this.debug) b.dbg = obs.map(o => `[lat ${o.lat.toFixed(0)} hw ${o.hw.toFixed(0)} g ${o.g.toFixed(0)} v ${(o.v * 0.036).toFixed(0)}]`).join('');
        b.obsGap = gap; b.obsV = vObs; b.blocked = blocked && gap < Infinity;
        b.latT = lim > 0 ? botsClamp(latT, -lim, lim) : 0;
    },

    // Тяжёлые неподвижные предметы вдоль маршрута (бетонный разделитель, блоки, стволы): те же полосы-препятствия, что и у машин, —
    // личная полоса бота сужается там, где с одной стороны разделитель, а объезд не чиркает по нему. Лёгкое (конусы, бочки) бот переезжает.
    _propObs(b, B, sB, D, obs) {
        if (typeof Props === 'undefined' || !Props.near) return;
        const R = this.route, RS = this.routeS, RL = this.routeL, i0 = b.seg, out = this._pl, far = D + 1400;
        const stamp = this._stamp = (this._stamp + 1) | 0;
        // куски маршрута впереди по ~2400 px: коробка вокруг каждого
        let c0 = Math.max(0, i0 - 1);
        while (c0 < R.length - 1 && RS[c0] < sB + far) {
            let c1 = c0 + 1;
            while (c1 < R.length - 1 && RS[c1] - RS[c0] < 2400 && RS[c1] < sB + far) c1++;
            let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
            for (let k = c0; k <= c1; k++) { const q = R[k]; x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); z0 = Math.min(z0, q.z); z1 = Math.max(z1, q.z); }
            Props.near(x0 - 900, B.c[1] - 500, z0 - 900, x1 + 900, B.c[1] + 700, z1 + 900, out);
            for (let n = 0; n < out.length; n++) {
                const p = out[n];
                if (p._st === stamp || !(p.mass >= 200) || p.state === 3) continue;
                p._st = stamp;
                // проекция предмета на маршрут
                let best = -1, bd = Infinity, bu = 0;
                for (let i = Math.max(0, i0 - 1); i < R.length - 1 && RS[i] < sB + far; i++) {
                    const a = R[i], c = R[i + 1], vx = c.x - a.x, vz = c.z - a.z;
                    let t = ((p.x - a.x) * vx + (p.z - a.z) * vz) / (vx * vx + vz * vz || 1);
                    t = t < 0 ? 0 : t > 1 ? 1 : t;
                    const px = p.x - (a.x + vx * t), pz = p.z - (a.z + vz * t), d = px * px + pz * pz;
                    if (d < bd) { bd = d; best = i; bu = t; }
                }
                if (best < 0 || bd > 1200 * 1200) continue;
                const a = R[best], c = R[best + 1], L = RL[best], tx = (c.x - a.x) / L, tz = (c.z - a.z) / L, nx = -tz, nz = tx;
                let eN, eT;
                if (p.shape === 0 && p.R) {      // брус: полуразмеры по осям тела, проекция на нормаль и касательную маршрута
                    const r = p.R;
                    eN = Math.abs(r[0] * nx + r[2] * nz) * p.hx + Math.abs(r[6] * nx + r[8] * nz) * p.hz;
                    eT = Math.abs(r[0] * tx + r[2] * tz) * p.hx + Math.abs(r[6] * tx + r[8] * tz) * p.hz;
                } else eN = eT = p.r || p.hx || 40;
                const ahead = RS[best] + bu * L - sB;
                if (ahead < -250 - eT || ahead > D + eT) continue;
                const lat = (p.x - (a.x + (c.x - a.x) * bu)) * nx + (p.z - (a.z + (c.z - a.z) * bu)) * nz;
                obs.push({ lat, hw: eN + B.spec.W / 2 + 45, g: ahead - eT - B.spec.L / 2, v: 0 });
            }
            c0 = c1;
        }
    },

    // _free с запасом, который уменьшается: полный, 0.6 и минимальный (меньше — руль не держит: пройти впритык нельзя).
    _solve(obs, margin, lim, b) {
        for (const m of [margin, margin * 0.6, 40]) { const v = this._free(obs, m, lim, b.latAct, b.lane); if (v !== null) return v; }
        return null;
    },

    /** Нигде не пройти без касания: смещение с наибольшим просветом до ближайшей машины (середина между полосами занятых). */
    _widest(obs, lim, cur) {
        const c = this._cand;
        c.length = 0;
        c.push(cur, -lim, lim);
        for (const o of obs) c.push(o.lat - o.hw - 1, o.lat + o.hw + 1);
        let best = cur, bc = -Infinity;
        for (const v of c) {
            if (v > lim || v < -lim) continue;
            let m = Infinity;
            for (const o of obs) m = Math.min(m, Math.abs(o.lat - v) - o.hw);
            if (m > bc) { bc = m; best = v; }
        }
        return best;
    },

    /** Смещение вбок, ближайшее к cur, вне полос obs (с зазором m) и в [−lim, lim]; pref — любимая полоса бота. null — свободного нет. */
    _free(obs, m, lim, cur, pref) {
        const c = this._cand;
        c.length = 0;
        c.push(pref, cur, -lim, lim);
        for (const o of obs) { c.push(o.lat - o.hw - m - 1, o.lat + o.hw + m + 1); }
        let best = null, bc = Infinity;
        for (const v of c) {
            if (v > lim || v < -lim) continue;
            let ok = true;
            for (const o of obs) if (v > o.lat - o.hw - m && v < o.lat + o.hw + m) { ok = false; break; }
            if (!ok) continue;
            const cost = Math.abs(v - cur) + 0.25 * Math.abs(v - pref);
            if (cost < bc) { bc = cost; best = v; }
        }
        return best;
    },

    // Таран игрока рядом: пока идёт — цель не точка маршрута, а упреждённая позиция игрока. Условия: бот лихой, игрока можно достать.
    _ramStep(b, B, dt) {
        const P = this.player;
        if (b.ramT > 0) {
            b.ramT -= dt;
            if (b.ramT <= 0) b.ramCd = BOTS_RAM_COOL_MIN + this.rng() * (BOTS_RAM_COOL_MAX - BOTS_RAM_COOL_MIN) * (1.3 - b.aggr);
            return;
        }
        b.ramCd -= dt;
        if (b.ramCd > 0 || !P || !P.alive || !P.car || b.invT > 0 || this.time < BOTS_RAM_FIRST) return;
        const Q = P.car;
        if (Q.dead || (Q.damage && Q.damage.total > 0.9) || Math.abs(Q.vf) < 450) { b.ramCd = 1.5; return; }
        const dx = Q.c[0] - B.c[0], dz = Q.c[2] - B.c[2], d = Math.hypot(dx, dz);
        const fwd = dx * Math.cos(B.yaw) + dz * Math.sin(B.yaw);
        if (d > BOTS_RAM_RANGE || d < 220 || fwd < -500 || Math.abs(Q.c[1] - B.c[1]) > 300) { b.ramCd = 0.4 + this.rng() * 0.4; return; }
        b.ramCd = 0.5 + this.rng() * 0.5;
        if (this.rng() < b.aggr * 0.45) b.ramT = BOTS_RAM_TIME_MIN + this.rng() * (BOTS_RAM_TIME_MAX - BOTS_RAM_TIME_MIN);
    },

    // Автопилот: руль на точку впереди (со смещением вбок), скорость по точке маршрута, повороту и умению; объезд; точный разгон к трамплину.
    _drive(b, dt, hz) {
        const R = this.route, B = b.car, C = this.cfg();
        if (b.waitT > 0) { b.waitT -= dt; B.step(dt, { throttle: 0, steer: 0, handbrake: true }, hz); return; }
        const world = typeof GameWorld !== 'undefined' && GameWorld.active;
        const d2 = (i) => (R[i].x - B.p[0]) ** 2 + (R[i].z - B.p[2]) ** 2 + ((R[i].y - B.p[1]) * (R[i].f === 4 || R[Math.max(0, i - 1)].f === 4 ? 1 : 0.15)) ** 2;
        const ri0 = b.ri;
        while (b.ri < R.length - 1 && (d2(b.ri + 1) < d2(b.ri) || d2(b.ri) < 170 * 170) && Math.abs(R[b.ri + 1].y - B.p[1]) < 2400) b.ri++;
        if (b.ri !== ri0) { b.bestD = Infinity; b.stuckT = 0; }
        // этапы: чекпоинты берутся как у игрока (зона маркера)
        const ns = ObbyCourse.reached(B.p[0], B.p[1], B.p[2], b.stage);
        if (ns > b.stage) {
            b.stage = ns; b.cpRi = Math.max(b.cpRi, this.cpRoute[ns] || b.ri);
            if (ns >= ObbyCourse.stages.length - 1 && ObbyCourse.finish) {
                b.state = 'finish'; b.finishT = 0; b.progress = 1;
                if (this.on.finish) this.on.finish(b);
                return;
            }
        }
        // застрял: нет продвижения к следующей точке, не едет, перевёрнут или разбит — копим время до эвакуации
        const dn = Math.sqrt(d2(Math.min(R.length - 1, b.ri + 1)));
        let moved = false;
        if (dn < b.bestD - 60) { b.bestD = dn; b.stuckT = 0; moved = true; } else b.stuckT += dt;
        if (b.ri !== ri0) moved = true;
        // не едет совсем (ползёт медленнее BOTS_STUCK_SPEED) — тоже застрял, даже если медленно продвигается; при заднем ходе счёт не обнуляется
        if (B.speed() < BOTS_STUCK_SPEED) b.slowT += dt; else if (b.backT <= 0) b.slowT = Math.max(0, b.slowT - dt);
        if (moved && B.speed() > 400) { b.holdT = 0; b.slowT = 0; }
        // «застрял» держится ещё 1.5 с после последнего признака: пока бот выбирается задним ходом, признак мигает, а время до эвакуации должно копиться
        if (!b.hzWait && (b.stuckT > BOTS_STUCK_AFTER || b.slowT > BOTS_STUCK_AFTER)) b.holdT = 1.5; else b.holdT = Math.max(0, b.holdT - dt);
        const stuck = b.holdT > 0;
        const flipped = B.u[1] < 0.35 && B.speed() < 500;
        const crippled = this._crippled(b);
        if (stuck || flipped || crippled) {
            b.evacT += dt;
            if (b.evacT > b.evacLimit) { this._evac(b, crippled ? 'damage' : flipped ? 'flipped' : 'stuck'); return; }
        } else if (b.backT <= 0) b.evacT = Math.max(0, b.evacT - dt * 2);
        b.backCool -= dt;
        if (stuck && !crippled && b.backT <= 0 && b.backCool <= 0 && B.grounded) { b.backRun = false; b.backT = 0.8 + this.rng() * 0.7; b.backCool = 2.5 + this.rng() * 1.5; b.backDir = this.rng() < 0.5 ? 1 : -1; }
        if (!stuck && !flipped && !crippled && B.stickT <= 0 && B.u[1] < 0.3 && B.groundTime === 0 && B.airTime > 3) { this._evac(b, 'flipped'); return; }
        // проекция на маршрут: сегмент i0, доля u и фактическое смещение вбок от маршрута (вправо по ходу маршрута)
        let i0 = Math.min(b.ri, R.length - 2), u = 0;
        {
            const segU = (i) => { const a = R[i], c = R[i + 1], vx = c.x - a.x, vz = c.z - a.z, L2 = vx * vx + vz * vz || 1; return ((B.p[0] - a.x) * vx + (B.p[2] - a.z) * vz) / L2; };
            u = segU(i0);
            if (u < 0 && i0 > 0) { i0--; u = segU(i0); }
            u = botsClamp(u, 0, 1);
            const a = R[i0], c = R[i0 + 1], sl = Math.hypot(c.x - a.x, c.z - a.z) || 1;
            b.latAct = (B.p[0] - (a.x + (c.x - a.x) * u)) * (-(c.z - a.z) / sl) + (B.p[2] - (a.z + (c.z - a.z) * u)) * ((c.x - a.x) / sl);
            b.seg = i0; b.segU = u;
        }
        // соседи и ширина дороги — не каждый кадр
        b.scanT -= dt;
        if (b.scanT <= 0) {
            b.scanT = 0.1;
            let lim = 0;
            if (world && R[b.ri]) {
                const rd = GameWorld.roadAt(B.p[0], B.p[2], B.p[1]);
                if (rd) lim = Math.max(0, rd.hw - BOTS_ROAD_EDGE - B.spec.W / 2);
            }
            b.hwLim = Math.min(lim, 600);
            this._scan(b, B);
        }
        this._ramStep(b, B, dt);
        b.lat += (b.latT - b.lat) * Math.min(1, dt * (b.obsGap < 3500 ? 5 : 2.5));
        // прицельная точка: по ломаной маршрута на look px вперёд от проекции машины; смещение вбок — вправо от курса маршрута
        const look = BOTS_LOOK_BASE + Math.max(0, B.vf) * BOTS_LOOK_K;
        const aim = b.aim;
        {
            let i = i0, rem = look;
            let a = R[i], c = R[i + 1];
            let x = a.x + (c.x - a.x) * u, y = a.y + (c.y - a.y) * u, z = a.z + (c.z - a.z) * u;
            while (true) {
                const sl = Math.hypot(c.x - x, c.z - z);
                if (rem <= sl || i >= R.length - 2) {
                    const k = sl > 1e-6 ? Math.min(1, rem / sl) : 0;
                    x += (c.x - x) * k; y += (c.y - y) * k; z += (c.z - z) * k;
                    break;
                }
                rem -= sl; x = c.x; y = c.y; z = c.z; i++; a = R[i]; c = R[i + 1];
            }
            const tl = Math.hypot(c.x - a.x, c.z - a.z) || 1;
            aim.rx = -(c.z - a.z) / tl; aim.rz = (c.x - a.x) / tl;
            aim.x = x + aim.rx * b.lat; aim.z = z + aim.rz * b.lat; aim.y = y;
        }
        const ti = Math.min(R.length - 1, i0 + 1);
        let T = { x: aim.x, y: aim.y, z: aim.z, s: Math.max(R[ti].s, 0.6), f: 1 };
        const vg = B.grounded && B.wheels.some(w => w.contact && w.col && w.col.dynamic) ? B._groundVel() : null;
        if (vg) {
            const tt = Math.hypot(T.x - B.p[0], T.z - B.p[2]) / Math.max(400, Math.abs(B.vf));
            T = { x: T.x - vg[0] * tt, z: T.z - vg[2] * tt, y: T.y, s: T.s, f: 1 };
        }
        // таран: цель — упреждённая позиция игрока
        let ramming = false;
        if (b.ramT > 0 && this.player && this.player.car) {
            const Q = this.player.car, d = Math.hypot(Q.c[0] - B.c[0], Q.c[2] - B.c[2]);
            const tt = Math.min(0.6, d / Math.max(800, Math.abs(B.vf) + 500));
            T = { x: Q.c[0] + Q.v[0] * tt, y: Q.c[1], z: Q.c[2] + Q.v[2] * tt, s: 1, f: 1 };
            ramming = true;
            if (d > BOTS_RAM_RANGE * 1.6) b.ramT = 0;
        }
        // в петле (точки f=4) — цель в осях машины (по поверхности), полный газ
        const inLoop = R[b.ri].f === 4 || (R[b.ri + 1] && R[b.ri + 1].f === 4);
        let a;
        if (inLoop) {
            const L = R[Math.min(R.length - 1, b.ri + 1)], dx = L.x - B.p[0], dy = L.y - B.p[1], dz = L.z - B.p[2];
            a = Math.atan2(dx * B.r[0] + dy * B.r[1] + dz * B.r[2], Math.max(1, dx * B.f[0] + dy * B.f[1] + dz * B.f[2]));
        } else {
            // руль: на цель от передней оси
            const fx0 = Math.cos(B.yaw), fz0 = Math.sin(B.yaw), axle = B.spec.halfBase;
            const want = Math.atan2(T.z - (B.p[2] + fz0 * axle), T.x - (B.p[0] + fx0 * axle));
            a = want - B.yaw;
            a = Math.atan2(Math.sin(a), Math.cos(a));
        }
        if (Math.abs(a) > 1.6 && B.grounded && !inLoop && !ramming) b.turnT += dt; else b.turnT = 0;
        if (b.turnT > 2.4) { this._evac(b, 'turn'); return; }
        b.noise += dt * 0.7;
        const wobble = Math.sin(b.noise * 2.3) * (1 - b.skill) * 0.16;
        const yawRate = -B.w[1];
        const steer = Math.max(-1, Math.min(1, a * 2.4 + wobble - yawRate * 0.12));
        const vmax = B.cfg().vmax * (0.45 + 0.55 * B.powerK), ref = C.ref;
        const onMove = !!vg;
        // скорость точки маршрута — абсолютная (доля BOT_REF_SPEED), у быстрых машин та же: трамплины рассчитаны на неё
        const sAt = (q) => q.s * ref;
        let tgt = Math.min(vmax, Math.max(450, (onMove ? Math.min(sAt(R[b.ri]), 1500) : Math.min(sAt(R[b.ri]), sAt(R[ti]) + 0.15 * ref)) * (0.9 + 0.1 * b.skill)));
        // трамплин впереди: к точке отрыва — ровно её скорость (с ошибкой по умению), раньше — не быстрее, чем успеем сбросить
        let launch = -1, launchD = 0;
        {
            let dist = 0, prev = { x: B.p[0], z: B.p[2] };
            for (let k = b.ri; k < Math.min(R.length, b.ri + 14) && dist < 3200; k++) {
                const q = R[k];
                dist += Math.hypot(q.x - prev.x, q.z - prev.z); prev = q;
                if (q.f === 2) { launch = k; launchD = dist; break; }
            }
        }
        if (launch >= 0) {
            const need = Math.min(vmax, sAt(R[launch]) * (1 + (1 - b.skill) * 0.06 * Math.sin(b.noise * 1.7 + launch)));
            const brakeA = 2600;
            const capV = Math.sqrt(need * need + 2 * brakeA * Math.max(0, launchD - 80));
            tgt = launchD < 700 ? need : Math.min(Math.max(tgt, need), capV);
            // слишком медленно и уже близко — не дотянуть: сдать назад и разогнаться снова
            const accel = B.cfg().accel * 0.85;
            const reach = Math.sqrt(Math.max(0, B.vf) ** 2 + 2 * accel * Math.max(0, launchD - 60));
            if (b.backFor !== launch) { b.backFor = launch; b.backN = 0; }
            if (B.grounded && !onMove && reach < need * 0.86 && launchD < 1800 && b.backN < 2 && B.vf < need * 0.6) {
                b.backN++;
                b.backT = Math.min(2.2, 0.6 + (need - reach) / 1100); b.backRun = true;
            }
        }
        // поворот впереди: чем круче, тем медленнее
        {
            let turn = 0, prevYaw = B.yaw, dist = 0, prev = { x: B.p[0], z: B.p[2] };
            const span = 500 + Math.max(0, B.vf) * 0.45;
            for (let k = b.ri; k < Math.min(R.length - 1, b.ri + 10) && dist < span; k++) {
                if (R[k].f === 2 || R[k].f === 4 || R[k + 1].f === 4) break;
                const q = R[k + 1], y = Math.atan2(q.z - R[k].z, q.x - R[k].x);
                dist += Math.hypot(q.x - prev.x, q.z - prev.z); prev = q;
                let dy = y - prevYaw; dy = Math.abs(Math.atan2(Math.sin(dy), Math.cos(dy)));
                turn = Math.max(turn, dy);
            }
            const vc = 2600 * Math.max(0.22, Math.min(1, 1.05 - turn / 1.6));
            tgt = Math.min(tgt, vc);
        }
        // таран: чуть быстрее игрока; машина впереди без места объехать: тормозим до её скорости на зазоре
        if (ramming && this.player) tgt = Math.min(vmax * 0.97, Math.max(tgt, Math.abs(this.player.car.vf) + BOTS_RAM_OVER * (0.4 + b.aggr)));
        else if (b.blocked && b.obsGap < Infinity) {
            const aB = 1500 + 800 * b.skill;
            tgt = Math.min(tgt, Math.sqrt(Math.max(0, b.obsV) ** 2 + 2 * aB * Math.max(0, b.obsGap - 260)));
        } else if (b.obsGap < Infinity && b.obsGap / Math.max(150, B.vf - b.obsV) < 0.8) tgt = Math.min(tgt, Math.max(0, b.obsV) + 600);   // перестраиваемся, а она уже близко — сбросить
        let throttle = B.vf < tgt - 120 ? 1 : (B.vf > tgt + 160 ? -0.8 : Math.max(0.15, Math.min(1, tgt / vmax)));
        if (Math.abs(a) > 0.9 && B.grounded && !inLoop && !ramming) throttle = Math.min(throttle, 0.3);
        if (inLoop || R.slice(b.ri, b.ri + 4).some(q => q.f === 4)) throttle = 1;
        b.hzT -= dt;
        const zone = this.zones.find(z => z.i1 >= b.ri && z.i0 - b.ri <= 4);
        const inZone = zone && b.ri >= zone.i0;
        if (inZone && launch < 0 && B.vf < 1500) throttle = Math.max(throttle, 0.9);        // в зоне препятствия — проскочить, но не разгоняться без предела
        if (b.hzT <= 0) {
            b.hzT = 0.08;
            const near = zone && !inZone && d2(Math.max(0, zone.i0 - 1)) < 700 * 700;
            b.hzWait = !b.reckless && ((near && !this._zoneClear(b, zone)) || (!zone && this._hazardAhead(b)));
        }
        if (b.hzWait) {
            b.waited += dt;
            if (b.waited > 7) { b.reckless = true; b.recklessT = 2.5; }
            throttle = B.vf > 150 ? -0.9 : 0; b.bestD = Infinity; b.stuckT = 0;
        } else b.waited = 0;
        if (b.recklessT > 0) { b.recklessT -= dt; if (b.recklessT <= 0) b.reckless = b.rash; }
        if (b.backT > 0) {
            b.backT -= dt;
            if (b.backRun) { b.bestD = Infinity; b.stuckT = 0; }       // разгон назад перед трамплином — не застревание; задний ход из ямы продвижением не считается (иначе evacT не копится)
            B.step(dt, { throttle: B.vf > 60 ? -1 : -0.85, steer: -Math.max(-1, Math.min(1, a * 1.5)) * (stuck ? b.backDir : 1) }, hz);
            return;
        }
        // в полёте: держать машину ровно (газ/тормоз — тангаж), руль — курс на точку приземления
        let handbrake = false;
        if (inLoop && (B.grounded || B.stickT > 0)) { B.step(dt, { throttle: 1, steer: Math.max(-1, Math.min(1, a * 2)) }, hz); return; }
        if (!B.grounded) {
            const pitchErr = B.pitch - Math.max(-0.25, Math.min(0.15, Math.atan2(B.v[1], Math.max(400, B.speed())) * 0.4));
            throttle = Math.max(-1, Math.min(1, pitchErr * 3));
        } else if (Math.abs(a) > 0.7 && B.vf > 900 && b.skill > 0.75 && !ramming) handbrake = true;   // крутой вираж — ручником
        B.step(dt, { throttle, steer, handbrake }, hz);
    },

    _die(b, reason) {
        if (b.state !== 'ride') return;
        b.state = 'dead';
        b.deadT = 1.2 + this.rng() * 0.8;
        if (this.on.die) this.on.die(b, reason);
    },

    // ---------------------------------------------------------------------------------------------
    // Контакты: события по сетке (сами столкновения считает SoftBody.pair в CarWorld.flush)
    // ---------------------------------------------------------------------------------------------

    /** Вешаем разбор контактов на damage.on.hit (оборачиваем вид повреждений: пересоздание CarSkin затирает обработчик — вешаем снова). */
    _hook(b) {
        const d = b.car.damage;
        if (!d || d.on.hit === b.hitFn) return;
        const prev = d.on.hit;
        b.hitFn = (i, power, dv) => { if (prev) prev(i, power, dv); this._onHit(b, i, power, dv); };
        d.on.hit = b.hitFn;
    },

    // Удар бота: если он пришёлся на сетку игрока — bump (искры, звук), быстрый — knock.
    _onHit(b, i, power, dv) {
        const S = b.car.soft, P = this.player && this.player.car;
        if (!S || !P || !P.soft || S.cSurf[i] !== SOFT_SURF_CAR || S.cRef[i] !== P.soft) return;
        const t = this.time;
        if (b.ramT > 0 && dv > 200) b.ramT = Math.min(b.ramT, 0.8);
        if (dv > 140 && b.bumpT <= t) {
            b.bumpT = t + 0.25;
            if (this.on.bump) this.on.bump(b, dv, [S.x[i], S.y[i], S.z[i]]);
        }
        if (dv > this.cfg().knock && !(b.invT > 0) && b.knockT <= t) {
            b.knockT = t + 1;
            if (this.on.knock) this.on.knock(b);
        }
        void power;
    },

    // Вид: машина по физике. Дальних позируем реже, скрытых — нет.
    _pose(b, dt, force) {
        const v = b.view;
        if (!v || !v.visible) return;
        b.poseT += dt;
        if (!force && b.state !== 'dead') {
            const P = this.player && this.player.car;
            if (P && Math.hypot(b.car.c[0] - P.c[0], b.car.c[2] - P.c[2]) > BOTS_MID_DIST * 1.6 && (++b.poseN & 3)) return;
        }
        const t = b.poseT;
        b.poseT = 0;
        v.pose(b.car, t);
        v.effects(b.car, t, { bot: true, on: b.state === 'ride' });
    },

    /**
     * Кадр повреждений ботов (после CarWorld.flush): damage.update и обновление шкуры. Можно вызывать из Game._damageFrame вместо
     * общего цикла по ботам: скрытые и выбывшие боты ничего не считают.
     */
    frame(dt, eye) {
        for (const b of this.list) {
            const B = b.car, d = B.damage;
            if (!d || b.off || B.frozen) continue;
            d.update(dt);
            const sk = b.view && b.view.skin;
            if (sk && b.view.visible) sk.update(dt, eye ? Math.hypot(B.c[0] - eye.x, B.c[1] - eye.y, B.c[2] - eye.z) : 0);
        }
    },

    /** Ники над машинами (зовёт игра каждый кадр, когда трасса на экране). */
    tagsUpdate(show, eye) {
        if (!this.view) return;
        for (const b of this.list) {
            const tag = b.tag;
            if (!tag) continue;
            const B = b.car;
            const vis = show && b.view && b.view.visible && b.state !== 'dead';
            const dist = eye ? Math.hypot(B.p[0] - eye.x, B.p[1] - eye.y, B.p[2] - eye.z) : 0;
            const pr = vis && dist < 9000 ? this.view.projectToScreen(B.p[0], B.p[2], B.p[1] + B.spec.H + 70) : null;
            if (!pr || !pr.visible || pr.behind) { tag.classList.add('off'); continue; }
            tag.classList.remove('off');
            const k = Math.max(0.55, Math.min(1.1, 1400 / Math.max(400, dist)));
            tag.style.transform = `translate(${pr.x.toFixed(1)}px, ${pr.y.toFixed(1)}px) translate(-50%, -100%) scale(${k.toFixed(3)})`;
        }
    },
};
