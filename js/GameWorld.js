// GameWorld.js — мир игры: рельеф с вписанными дорогами, поверхности с трением, лучи колёс. ЧИСТЫЕ ДАННЫЕ (Babylon здесь не
// спрашивается никогда, инвариант 4): одни и те же числа на телефоне, на ПК и в node-симуляции. Вид — GameWorldView.js
// (WorldView: чанки рельефа с LOD, ленты дорог, небо, свет, декор). Предметы — GameProps.js (Props). Описание для того, кто строит
// карты, — docs/WORLD.md; контракт для физики — docs/DESTRUCTION.md, раздел «Мир».
//
// КООРДИНАТЫ — мир Babylon: x вправо (x карты), y ВВЕРХ (h карты), z вниз по карте (y карты). 1 м = 100 px. Курс rot[1] маркера — как у
// Location3D (0 — вдоль +x, 90 — вдоль +z). Справа по курсу — вектор (−tz, tx).
//
// КАРТА ОПИСЫВАЕТ МИР МАРКЕРАМИ (kind 'marker', параметры — слова ключ=значение в имени, как ObbyCourse.params; имя маркера
// в редакторе — до 64 знаков, поэтому умолчания не пишут):
//   world biome=alpine seed=12 size=320000 relief=18000 sea=-1 hour=11 fog=1 trees=1 cell=200
//       biome: proving | alpine | highway | city | canyon;  sea < 0 — моря нет;  hour — час суток по умолчанию (Sky3D)
//   road-<id>-<n> w=1100 surf=asphalt bank=0 rail=lr kerb=0 lamp=0 bridge=0 tunnel=0 mark=1 sh=250 auto=0 loop=0
//       контрольные точки оси дороги (Catmull-Rom); x, y — на карте, h — высота оси над нулём (auto=1: h — отступ над рельефом);
//       всё, кроме bank и auto, «липкое»: действует до следующей точки с другим значением; w и bank плавно меняются между точками
//   flat w=4000 d=3000 surf=asphalt auto=0 blend=0     ровная площадка (прямоугольник w×d по курсу rot[1]; r=2000 — круг); zone-flat — то же
//   prop <id> ... / scatter <id> n=30 r=900            предметы (Props, GameProps.js)
//
// ПУБЛИЧНЫЙ API (контракт docs/DESTRUCTION.md):
//   GameWorld.buildData(map)            мир из маркеров карты; быстро, плитки рельефа считаются лениво
//   GameWorld.heightAt(x, z)            высота поверхности (рельеф с вписанной дорогой; мосты — только земля под ними)
//   GameWorld.normalAt(x, z, out)       нормаль [x, y, z] (сглаженная)
//   GameWorld.surfaceAt(x, z[, y])      { name, mu, rough, onRoad, drag } — общий неизменяемый объект (держать можно, менять нельзя)
//   GameWorld.ray(ox, oy, oz, dx, dy, dz, maxT[, out]) → { t, n: [x, y, z], x, y, z, road } | null   ОБЩИЙ объект (до следующего вызова)
//   GameWorld.buildView(app)            меши под загрузкой (WorldView)
//   GameWorld.clear()
// Дополнительно: roadAt, waterAt, autoHeight, decorNear, warm, envTexture, update (вид), stats.

// Math через локальный алиас: в vm-контексте node (симуляции) обращение к глобальному Math в разы медленнее.
const WM = Math;

// --- настройка (числа, px) ---
const WORLD_CELL = 200;               // шаг сетки высот: физика и самый подробный уровень вида (2 м)
const WORLD_TILE = 32;                // ячеек в плитке сетки (64 м): плитки считаются лениво
const WORLD_ROAD_STEP = 400;          // шаг выборки оси дороги на прямых
const WORLD_ROAD_MIN_STEP = 120;      // не чаще
const WORLD_ROAD_TURN_DEG = 2.5;      // и чаще, если курс повернулся на столько градусов
const WORLD_DEFAULT_W = 1000;         // ширина дороги по умолчанию
const WORLD_SHOULDER = 250;           // ширина гравийной обочины за кромкой асфальта (бетон и асфальт)
const WORLD_SHOULDER_SOFT = 120;      // то же у грунтовых дорог
const WORLD_PLATEAU = 140;            // ровная полоса за обочиной до откоса
const WORLD_SLOPE = 2.3;              // откос: px длины на 1 px перепада высоты
const WORLD_BLEND_MIN = 420;          // откос не короче
const WORLD_BLEND_MAX = 4600;         // и не длиннее (перепад больше — откос круче)
const WORLD_WALL_BLEND = 150;         // tunnel=1: отвесные стены траншеи
const WORLD_JUNCTION_DH = 90;         // дороги в перекрёстке: перепад высот не больше (иначе путепровод)
const WORLD_JUNCTION_PAD = 500;       // px: площадка перекрёстка шире дорог на столько
const WORLD_ROAD_CELL = 2400;         // ячейка поискового индекса дорог
const WORLD_DECOR_CELL = 6400;        // ячейка декора (64 м)

/** @typedef {{ name: string, mu: number, rough: number, drag: number, onRoad: boolean }} WorldSurface */

// ---------------------------------------------------------------------------------------------
// Шум: детерминированный (целочисленный хэш, без WM.random) — результат одинаков в любой среде
// ---------------------------------------------------------------------------------------------

/** Хэш целых → [0, 1). */
const worldHash = (ix, iz, seed) => {
    let h = (WM.imul(ix | 0, 374761393) + WM.imul(iz | 0, 668265263) + WM.imul(seed | 0, 1442695041)) | 0;
    h = WM.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
};

/** Значимый шум [0, 1], квинтическое сглаживание. */
const worldNoise = (x, z, seed) => {
    const ix = WM.floor(x), iz = WM.floor(z);
    const fx = x - ix, fz = z - iz;
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
    const a = worldHash(ix, iz, seed), b = worldHash(ix + 1, iz, seed), c = worldHash(ix, iz + 1, seed), d = worldHash(ix + 1, iz + 1, seed);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
};

/** Фрактальный шум ≈ [−1, 1]: октавы с поворотом (без осевых артефактов). */
const worldFbm = (x, z, oct, seed) => {
    let amp = 1, sum = 0, norm = 0;
    for (let i = 0; i < oct; i++) {
        sum += amp * (worldNoise(x, z, seed + i * 31) * 2 - 1);
        norm += amp;
        const nx = (x * 0.8776 - z * 0.4794) * 2.03, nz = (x * 0.4794 + z * 0.8776) * 2.03;
        x = nx; z = nz; amp *= 0.5;
    }
    return sum / norm;
};

/** Гребневой шум [0, 1]: хребты. */
const worldRidge = (x, z, oct, seed) => {
    let amp = 0.5, sum = 0, norm = 0, w = 1;
    for (let i = 0; i < oct; i++) {
        let s = 1 - WM.abs(worldNoise(x, z, seed + i * 17) * 2 - 1);
        s *= s; s *= w;
        w = WM.min(1, WM.max(0, s * 2));
        sum += s * amp; norm += amp;
        const nx = (x * 0.8776 - z * 0.4794) * 2.1, nz = (x * 0.4794 + z * 0.8776) * 2.1;
        x = nx; z = nz; amp *= 0.5;
    }
    return sum / norm;
};

const worldClamp = (v, a, b) => { return v < a ? a : v > b ? b : v; };
const worldSmooth = (a, b, v) => { const t = worldClamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const worldLerp = (a, b, t) => { return a + (b - a) * t; };

/** Имя маркера без хвоста «-N», который редактор дописывает дублю: «flat w=3000 d=2000-2» → «flat w=3000 d=2000». */
const worldCleanName = (name) => {
    const s = String(name || '').trim();
    if (!/\s/.test(s)) return s;
    return s.replace(/([^=\s])-\d+$/, '$1');
};;;;

/** 'road-a-1 w=1100 surf=dirt' → { role: 'road-a-1', w: 1100, surf: 'dirt' }; числа приводятся к числам, регистр ключей не важен. */
const worldParams = (name) => {
    /** @type {any} */
    const out = { role: '' };
    const words = worldCleanName(name).split(/\s+/).filter(Boolean);
    if (!words.length) return out;
    out.role = /=/.test(words[0]) ? '' : words[0];
    for (const w of words) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(w);
        if (!m) continue;
        const v = Number(m[2]);
        out[m[1].toLowerCase()] = Number.isFinite(v) ? v : m[2];
    }
    return out;
};

/** Поверхности (общие неизменяемые записи: mu — сцепление, rough — тряска 0..1, drag — доп. сопротивление качению). */
/** @type {Record<string, WorldSurface>} */
const WORLD_SURF = {};
(() => {
    const defs = {
        asphalt: [1.0, 0.02, 0], concrete: [0.95, 0.035, 0], gravel: [0.7, 0.34, 0.05], dirt: [0.6, 0.4, 0.06], grass: [0.55, 0.26, 0.12],
        sand: [0.5, 0.2, 0.26], rock: [0.85, 0.6, 0.03], snow: [0.38, 0.12, 0.14],
    };
    for (const k of Object.keys(defs)) {
        const d = defs[k];
        WORLD_SURF[k] = Object.freeze({ name: k, mu: d[0], rough: d[1], drag: d[2], onRoad: false });
        WORLD_SURF[k + '@road'] = Object.freeze({ name: k, mu: d[0], rough: d[1], drag: d[2], onRoad: true });
    }
})();

/** Типы декора мира: размеры при scale 1 (px), радиус ствола для столкновений (0 — проходимо). */
const WORLD_DECOR = {
    spruce: { r: 30, h: 1150, mass: 3000 },
    oak: { r: 34, h: 820, mass: 3000 },
    poplar: { r: 22, h: 1450, mass: 2500 },
    bush: { r: 0, h: 120, mass: 0 },
    rock: { r: 70, h: 110, mass: 60000 },
    cactus: { r: 22, h: 380, mass: 1800 },
    dead: { r: 20, h: 520, mass: 1500 },
    snag: { r: 25, h: 1300, mass: 1500 },
};

/** Умолчания биомов: relief — размах высот, px; hour — час суток; sea — уровень моря (<0 нет). */
const WORLD_BIOMES = {
    proving: { relief: 220, hour: 12, sea: -1 },
    alpine: { relief: 30000, hour: 11, sea: -1 },
    highway: { relief: 6500, hour: 17.4, sea: -1 },
    city: { relief: 500, hour: 15, sea: -1 },
    canyon: { relief: 16000, hour: 14.5, sea: -1 },
};

/** Превращает флаги rail в маску: бит 0 — слева по курсу, бит 1 — справа. */
const worldRailMask = (v) => {
    if (v == null) return null;
    if (typeof v === 'number') return v > 0 ? 3 : 0;
    const s = String(v).toLowerCase();
    let m = 0;
    if (s.includes('l')) m |= 1;
    if (s.includes('r')) m |= 2;
    if (s === 'both' || s === 'lr' || s === 'rl') m = 3;
    return m;
};

/** @typedef {{ n: number, X: Float64Array, Y: Float64Array, Z: Float64Array, TX: Float64Array, TZ: Float64Array, HW: Float32Array,
 *   SH: Float32Array, BK: Float32Array, S: Float64Array, SURF: Uint8Array, RAIL: Uint8Array, KERB: Uint8Array, LAMP: Uint8Array,
 *   BRIDGE: Uint8Array, TUNNEL: Uint8Array, MARK: Uint8Array, JN: Uint8Array }} WorldRoadSamples */

/** @satisfies {Record<string, any>} */
const GameWorld = {
    /** Есть ли построенный мир (buildData звали). */
    active: false,
    /** @type {any} */ map: null,
    /** @type {Record<string, any>} */ P: { biome: 'proving', seed: 1, size: 320000, relief: 220, sea: -1, hour: 12, fog: 1, trees: 1, cell: WORLD_CELL },
    biome: 'proving',
    size: 320000,
    cell: WORLD_CELL,
    seed: 1,
    relief: 220,
    sea: -1,
    hour: 12,
    /** @type {any[]} */ roads: [],
    /** @type {Record<string, any>} */ roadById: {},
    /** @type {any[]} */ flats: [],
    /** @type {any[]} */ junctions: [],
    /** Дороги в порядке наложения на рельеф: широкие последними (их поверхность главнее на перекрёстках). */
    /** @type {any[]} */ _order: [],
    /** @type {any[]} */ segs: [],
    /** @type {Map<number, any>} */ tiles: new Map(),
    /** @type {any} */ _last: null,
    /** @type {Map<number, number[]>} */ _rgrid: new Map(),
    /** Плитки, на которые влияют дороги и площадки (остальное — чистый рельеф биома). */
    /** @type {Set<number>} */ _infl: new Set(),
    /** @type {(x: number, z: number, detail?: boolean) => number} */ hf: (x, z) => 0,
    /** @type {Map<number, any>} */ _decor: new Map(),
    /** @type {any} */ envTexture: null,
    /** @type {any} */ view: null,
    stats: { tiles: 0, tileMs: 0, build: 0 },
    _gw: new Float32Array(6),
    /** Общий результат ray (до следующего вызова). */
    _hit: { t: 0, n: [0, 1, 0], x: 0, y: 0, z: 0, road: false },
    _n: [0, 1, 0],
    _rq: { road: null, seg: 0, u: 0, lat: 0, dist: 0, y: 0, hw: 0, sh: 0 },

    cfg() {
        const U = 'undefined';
        return {
            gravity: typeof CAR_GRAVITY !== U ? CAR_GRAVITY : 981,
        };
    },

    // ---------------------------------------------------------------------------------------------
    // Постройка данных
    // ---------------------------------------------------------------------------------------------

    /**
     * Мир из маркеров карты (map.objects с kind 'marker'): настройки, дороги, площадки. Дёшево: плитки рельефа считаются при первом
     * запросе. Повторный вызов для той же карты ничего не пересчитывает (force — пересобрать).
     * @param {any} map @param {boolean} [force]
     */
    buildData(map, force) {
        if (!force && this.active && this.map === map && map) return this;
        const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
        this.clear();
        this.map = map || null;
        const objs = (map && map.objects) || [];
        const markers = objs.filter(d => d && d.kind === 'marker');
        // --- world ---
        /** @type {any} */
        let wp = null;
        for (const d of markers) { const p = worldParams(d.name); if (p.role === 'world') { wp = p; break; } }
        const w = wp || {};
        const biomeIn = String(w.biome || 'proving').toLowerCase();
        const biome = WORLD_BIOMES[biomeIn] ? biomeIn : 'proving';
        const def = WORLD_BIOMES[biome];
        const mapSize = map ? WM.max(Number(map.width) || 0, Number(map.height) || 0) : 0;
        this.biome = biome;
        this.seed = Number.isFinite(w.seed) ? WM.round(w.seed) : 1;
        this.size = Number.isFinite(w.size) && w.size > 1000 ? w.size : WM.max(320000, mapSize);
        this.relief = Number.isFinite(w.relief) && w.relief >= 0 ? w.relief : def.relief;
        this.sea = Number.isFinite(w.sea) ? w.sea : def.sea;
        this.hour = Number.isFinite(w.hour) ? w.hour : def.hour;
        this.cell = Number.isFinite(w.cell) && w.cell >= 100 && w.cell <= 400 ? WM.round(w.cell) : WORLD_CELL;
        this.P = { biome, seed: this.seed, size: this.size, relief: this.relief, sea: this.sea, hour: this.hour, fog: Number.isFinite(w.fog) ? w.fog : 1,
            trees: Number.isFinite(w.trees) ? w.trees : 1, cell: this.cell, snow: Number.isFinite(w.snow) ? w.snow : 1, clouds: Number.isFinite(w.clouds) ? w.clouds : 1 };
        this.hf = this._biomeHeight(biome);
        // --- площадки и дороги ---
        this._buildFlats(markers);
        this._buildRoads(markers);
        this._junctions();
        this._order = this.roads.slice().sort((a, b) => a.maxHW - b.maxHW);
        this._indexRoads();
        this._influence();
        this.active = true;
        this.stats.build = typeof performance !== 'undefined' ? performance.now() - t0 : 0;
        return this;
    },

    clear() {
        if (this.view && this.view.dispose) { try { this.view.dispose(); } catch (e) { /* уже снят */ } }
        this.view = null;
        this.active = false;
        this.map = null;
        this.roads = []; this._order = []; this.roadById = {}; this.flats = []; this.junctions = []; this.segs = [];
        this.tiles = new Map(); this._last = null; this._rgrid = new Map(); this._decor = new Map(); this._infl = new Set();
        this.envTexture = null;
        this.stats.tiles = 0; this.stats.tileMs = 0;
        this.hf = this._biomeHeight('proving');
    },

    /** Высота рельефа по биому БЕЗ дорог (px). detail === false — только крупные формы (по ним ставятся дороги auto=1). */
    _biomeHeight(biome) {
        const R = WM.max(0, this.relief), seed = this.seed | 0;
        switch (biome) {
            case 'alpine': return (x, z, detail) => {
                const mx = x * 0.01, mz = z * 0.01;
                const wx = worldFbm(mx / 380 + 3.1, mz / 380 + 1.7, 2, seed + 11) * 110, wz = worldFbm(mx / 380 - 5.3, mz / 380 + 8.2, 2, seed + 12) * 110;
                const qx = mx + wx, qz = mz + wz;
                const massif = worldFbm(qx / 1300, qz / 1300, 4, seed + 1) * 0.5 + 0.5;
                const ridge = worldRidge(qx / 640, qz / 640, 4, seed + 2);
                const mask = worldSmooth(0.28, 0.64, worldFbm(mx / 2100 + 9, mz / 2100 - 4, 2, seed + 3) * 0.5 + 0.5);
                let t = massif * 0.42 + ridge * 0.58;
                t = WM.pow(WM.max(0, t), 1.5) * (0.2 + 0.8 * mask);
                let h = R * (0.03 + 0.97 * t);
                if (detail !== false) h += (worldFbm(mx / 42, mz / 42, 3, seed + 4) * 70 + worldFbm(mx / 11, mz / 11, 2, seed + 5) * 9) * (0.35 + 0.65 * t);
                return h;
            };
            case 'highway': return (x, z, detail) => {
                const mx = x * 0.01, mz = z * 0.01;
                const a = worldFbm(mx / 950, mz / 950, 3, seed + 1) * 0.5 + 0.5;
                const b = worldFbm(mx / 330, mz / 330, 3, seed + 2) * 0.5 + 0.5;
                let h = R * (0.62 * a + 0.38 * b * (0.4 + 0.6 * a));
                if (detail !== false) h += worldFbm(mx / 30, mz / 30, 2, seed + 3) * 26 + worldFbm(mx / 9, mz / 9, 2, seed + 4) * 5;
                return h;
            };
            case 'canyon': return (x, z, detail) => {
                const mx = x * 0.01, mz = z * 0.01;
                const wx = worldFbm(mx / 300 + 1.3, mz / 300 + 2.9, 2, seed + 11) * 70, wz = worldFbm(mx / 300 + 7.7, mz / 300 - 1.1, 2, seed + 12) * 70;
                const qx = mx + wx, qz = mz + wz;
                const t = worldFbm(qx / 1050, qz / 1050, 4, seed + 1) * 0.5 + 0.5;
                const u = worldFbm(qx / 380, qz / 380, 2, seed + 2) * 0.5 + 0.5;
                const levels = 5.5, k = WM.max(0, t * levels + (u - 0.5) * 0.45);
                const f = WM.floor(k);
                let h = R * ((f + worldSmooth(0.3, 0.7, k - f)) / levels);
                if (detail !== false) h += worldFbm(mx / 26, mz / 26, 3, seed + 3) * 34 * (0.5 + 0.5 * u) + worldFbm(mx / 8, mz / 8, 2, seed + 4) * 7;
                return h;
            };
            case 'city': return (x, z, detail) => {
                const mx = x * 0.01, mz = z * 0.01;
                let h = R * (worldFbm(mx / 1200, mz / 1200, 2, seed + 1) * 0.5 + 0.5);
                if (detail !== false) h += worldFbm(mx / 40, mz / 40, 2, seed + 2) * 4;
                return h;
            };
            default: return (x, z, detail) => {
                const mx = x * 0.01, mz = z * 0.01;
                let h = R * (worldFbm(mx / 1500, mz / 1500, 2, seed + 1) * 0.5 + 0.5);
                if (detail !== false) h += worldFbm(mx / 33, mz / 33, 2, seed + 2) * 2;
                return h;
            };
        }
    },

    /** Крупные формы рельефа без дорог в точке (px): по ним ставятся дороги с auto=1 (в node их же берёт worldkit). */
    autoHeight(x, z) { return this.hf(x, z, false); },

    // ---------------------------------------------------------------------------------------------
    // Площадки
    // ---------------------------------------------------------------------------------------------

    _buildFlats(markers) {
        for (const d of markers) {
            const p = worldParams(d.name);
            const isZone = /^zone-flat(-\d+)?$/.test(p.role);
            if (!(p.role === 'flat' || /^flat-\d+$/.test(p.role) || isZone)) continue;
            const rot = Array.isArray(d.rot) ? d.rot : [0, Number(d.rot) || 0, 0];
            const sc = Array.isArray(d.scale) ? d.scale : [1, 1, 1];
            const yaw = (Number(rot[1]) || 0) * WM.PI / 180;
            const cx = Number(d.x) || 0, cz = Number(d.y) || 0;
            let hw = 0, hd = 0, r = 0;
            if (isZone) {
                const a = WM.max(20, (Number(sc[0]) || 1) * 100), b = (Number(sc[2]) || Number(sc[0]) || 1) * 100;
                if (WM.abs(a - b) < 1) r = a; else { hw = a; hd = WM.max(20, b); }
            } else if (Number.isFinite(p.r)) r = WM.max(50, p.r);
            else { hw = WM.max(50, (Number.isFinite(p.w) ? p.w : 3000) / 2); hd = WM.max(50, (Number.isFinite(p.d) ? p.d : 3000) / 2); }
            const auto = isZone || p.auto === 1;
            const y = auto ? this.autoHeight(cx, cz) + (Number(d.h) || 0) : (Number(d.h) || 0);
            const reach = (r || WM.hypot(hw, hd)) + WORLD_BLEND_MAX;
            const surf = WORLD_SURF[String(p.surf || 'asphalt')] ? String(p.surf || 'asphalt') : 'asphalt';
            this.flats.push({ x: cx, z: cz, y, hw, hd, r, yaw, cos: WM.cos(yaw), sin: WM.sin(yaw), surf, blend: Number.isFinite(p.blend) && p.blend > 0 ? p.blend : 0,
                bx0: cx - reach, bx1: cx + reach, bz0: cz - reach, bz1: cz + reach, mark: Number.isFinite(p.mark) ? p.mark : 0, def: d });
        }
    },

    /** Расстояние от точки до площадки (≤ 0 внутри). */
    _flatDist(f, x, z) {
        if (f.r > 0) return WM.hypot(x - f.x, z - f.z) - f.r;
        const dx = x - f.x, dz = z - f.z;
        const u = dx * f.cos + dz * f.sin, v = -dx * f.sin + dz * f.cos;
        const qx = WM.abs(u) - f.hw, qz = WM.abs(v) - f.hd;
        return qx > 0 || qz > 0 ? WM.hypot(WM.max(qx, 0), WM.max(qz, 0)) : WM.max(qx, qz);
    },

    // ---------------------------------------------------------------------------------------------
    // Дороги: сплайн Catmull-Rom → выборка оси → дорога из массивов
    // ---------------------------------------------------------------------------------------------

    _buildRoads(markers) {
        /** @type {Map<string, any[]>} */
        const groups = new Map();
        for (const d of markers) {
            const p = worldParams(d.name);
            const m = /^road-([A-Za-z0-9_]+)-(\d+)$/.exec(p.role);
            if (!m) continue;
            if (!groups.has(m[1])) groups.set(m[1], []);
            /** @type {any[]} */ (groups.get(m[1])).push({ n: Number(m[2]), x: Number(d.x) || 0, z: Number(d.y) || 0, h: Number(d.h) || 0, prm: p });
        }
        for (const [id, list] of groups) {
            list.sort((a, b) => a.n - b.n);
            if (list.length < 2) { console.warn('GameWorld: у дороги ' + id + ' меньше двух точек — пропущена'); continue; }
            const road = this._makeRoad(id, list);
            road.index = this.roads.length;
            this.roads.push(road);
            this.roadById[id] = road;
        }
    },

    /** Контрольные точки с липкими параметрами. */
    _controls(list) {
        const cur = { w: WORLD_DEFAULT_W, surf: 'asphalt', rail: 0, kerb: 0, lamp: 0, bridge: 0, tunnel: 0, mark: 1, sh: -1 };
        return list.map(pt => {
            const p = pt.prm;
            if (Number.isFinite(p.w) && p.w > 100) cur.w = p.w;
            if (typeof p.surf === 'string' && WORLD_SURF[p.surf.toLowerCase()]) cur.surf = p.surf.toLowerCase();
            const rm = worldRailMask(p.rail); if (rm != null) cur.rail = rm;
            if (Number.isFinite(p.kerb)) cur.kerb = WM.max(0, WM.min(2, p.kerb | 0));
            if (Number.isFinite(p.lamp)) cur.lamp = WM.max(0, WM.min(2, p.lamp | 0));
            if (Number.isFinite(p.bridge)) cur.bridge = p.bridge ? 1 : 0;
            if (Number.isFinite(p.tunnel)) cur.tunnel = p.tunnel ? 1 : 0;
            if (Number.isFinite(p.mark)) cur.mark = WM.max(0, WM.min(2, p.mark | 0));
            if (Number.isFinite(p.sh)) cur.sh = WM.max(0, p.sh);
            const auto = p.auto === 1;
            const y = auto ? this.autoHeight(pt.x, pt.z) + pt.h : pt.h;
            const sh = cur.sh >= 0 ? cur.sh : (cur.surf === 'dirt' || cur.surf === 'gravel' ? WORLD_SHOULDER_SOFT : WORLD_SHOULDER);
            return { x: pt.x, z: pt.z, y, w: cur.w, bank: (Number(p.bank) || 0) * WM.PI / 180, surf: cur.surf, rail: cur.rail, kerb: cur.kerb, lamp: cur.lamp,
                bridge: cur.bridge, tunnel: cur.tunnel, mark: cur.mark, sh, loop: p.loop === 1 };
        });
    },

    /** Точка Catmull-Rom (centripetal) между p1 и p2: [x, y, z] → out. */
    _cr(p0, p1, p2, p3, t, out) {
        const d = (a, b) => WM.pow(WM.hypot(b[0] - a[0], b[2] - a[2]) + 1e-3, 0.5);
        const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
        const tt = t1 + (t2 - t1) * t;
        for (let k = 0; k < 3; k++) {
            const a1 = (t1 - tt) / (t1 - t0) * p0[k] + (tt - t0) / (t1 - t0) * p1[k];
            const a2 = (t2 - tt) / (t2 - t1) * p1[k] + (tt - t1) / (t2 - t1) * p2[k];
            const a3 = (t3 - tt) / (t3 - t2) * p2[k] + (tt - t2) / (t3 - t2) * p3[k];
            const b1 = (t2 - tt) / (t2 - t0) * a1 + (tt - t0) / (t2 - t0) * a2;
            const b2 = (t3 - tt) / (t3 - t1) * a2 + (tt - t1) / (t3 - t1) * a3;
            out[k] = (t2 - tt) / (t2 - t1) * b1 + (tt - t1) / (t2 - t1) * b2;
        }
        return out;
    },

    _makeRoad(id, list) {
        const ctl = this._controls(list);
        const closed = ctl.some(c => c.loop) && ctl.length >= 3;
        const nC = ctl.length, nSeg = closed ? nC : nC - 1;
        const P = (i) => { const c = ctl[closed ? ((i % nC) + nC) % nC : WM.max(0, WM.min(nC - 1, i))]; return [c.x, c.y, c.z]; };
        const ext = (i, from, over) => { const a = P(from), b = P(over); return [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]]; };
        // плотная ломаная
        /** @type {number[][]} */ const dense = [];   // [x, y, z, k, f]
        const tmp = [0, 0, 0];
        for (let k = 0; k < nSeg; k++) {
            const p1 = P(k), p2 = P(k + 1);
            const p0 = closed || k > 0 ? P(k - 1) : ext(0, 0, 1);
            const p3 = closed || k + 1 < nC - 1 ? P(k + 2) : ext(0, nC - 1, nC - 2);
            const m = WM.max(3, WM.min(96, WM.ceil(WM.hypot(p2[0] - p1[0], p2[2] - p1[2]) / 120)));
            for (let j = 0; j < m; j++) { this._cr(p0, p1, p2, p3, j / m, tmp); dense.push([tmp[0], tmp[1], tmp[2], k, j / m]); }
        }
        const last = closed ? P(0) : P(nC - 1);
        dense.push([last[0], last[1], last[2], nSeg - 1, 1]);
        // выборка по длине и повороту
        /** @type {number[]} */ const pick = [0];
        let acc = 0, dev = 0, dirAng = WM.atan2(dense[1][2] - dense[0][2], dense[1][0] - dense[0][0]);
        for (let i = 1; i < dense.length; i++) {
            const a = dense[i - 1], b = dense[i];
            const seg = WM.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
            acc += seg;
            if (i + 1 < dense.length) {
                const c = dense[i + 1];
                let da = WM.atan2(c[2] - b[2], c[0] - b[0]) - WM.atan2(b[2] - a[2], b[0] - a[0]);
                while (da > WM.PI) da -= WM.PI * 2; while (da < -WM.PI) da += WM.PI * 2;
                dev += da;
            }
            const turn = WM.abs(dev) * 180 / WM.PI;
            if (i === dense.length - 1) { if (acc < WORLD_ROAD_MIN_STEP * 0.5 && pick.length > 1) pick[pick.length - 1] = i; else pick.push(i); }
            else if (acc >= WORLD_ROAD_STEP || (turn >= WORLD_ROAD_TURN_DEG && acc >= WORLD_ROAD_MIN_STEP)) { pick.push(i); acc = 0; dev = 0; }
        }
        void dirAng;
        const n = pick.length;
        /** @type {any} */
        const R = { id, closed, n, ctl, X: new Float64Array(n), Y: new Float64Array(n), Z: new Float64Array(n), TX: new Float64Array(n), TZ: new Float64Array(n),
            HW: new Float32Array(n), SH: new Float32Array(n), BK: new Float32Array(n), S: new Float64Array(n), SURF: new Uint8Array(n), RAIL: new Uint8Array(n),
            KERB: new Uint8Array(n), LAMP: new Uint8Array(n), BRIDGE: new Uint8Array(n), TUNNEL: new Uint8Array(n), MARK: new Uint8Array(n), JN: new Uint8Array(n),
            maxHW: 0, bbox: [Infinity, Infinity, -Infinity, -Infinity], surfNames: ['asphalt', 'concrete', 'dirt', 'gravel'] };
        for (let s = 0; s < n; s++) {
            const dp = dense[pick[s]];
            const k = dp[3], f = dp[4];
            const c0 = ctl[k], c1 = ctl[closed ? (k + 1) % nC : WM.min(nC - 1, k + 1)];
            const sm = f * f * (3 - 2 * f);
            R.X[s] = dp[0]; R.Y[s] = dp[1]; R.Z[s] = dp[2];
            R.HW[s] = worldLerp(c0.w, c1.w, sm) / 2;
            R.SH[s] = worldLerp(c0.sh, c1.sh, sm);
            R.BK[s] = worldLerp(c0.bank, c1.bank, sm);
            const cd = f >= 1 && !closed && k === nSeg - 1 ? c1 : c0;
            R.SURF[s] = WM.max(0, R.surfNames.indexOf(cd.surf)); R.RAIL[s] = cd.rail; R.KERB[s] = cd.kerb; R.LAMP[s] = cd.lamp;
            R.BRIDGE[s] = cd.bridge; R.TUNNEL[s] = cd.tunnel; R.MARK[s] = cd.mark;
            R.maxHW = WM.max(R.maxHW, R.HW[s] + R.SH[s]);
            R.bbox[0] = WM.min(R.bbox[0], dp[0]); R.bbox[1] = WM.min(R.bbox[1], dp[2]); R.bbox[2] = WM.max(R.bbox[2], dp[0]); R.bbox[3] = WM.max(R.bbox[3], dp[2]);
        }
        this._frames(R);
        return R;
    },

    /** Касательные и длина дуги по выборке. */
    _frames(R) {
        const n = R.n;
        for (let s = 0; s < n; s++) {
            const a = WM.max(0, s - 1), b = WM.min(n - 1, s + 1);
            let tx = R.X[b] - R.X[a], tz = R.Z[b] - R.Z[a];
            if (R.closed && (s === 0 || s === n - 1)) { tx = R.X[1] - R.X[n - 2]; tz = R.Z[1] - R.Z[n - 2]; }
            const l = WM.hypot(tx, tz) || 1;
            R.TX[s] = tx / l; R.TZ[s] = tz / l;
            if (s > 0) R.S[s] = R.S[s - 1] + WM.hypot(R.X[s] - R.X[s - 1], R.Y[s] - R.Y[s - 1], R.Z[s] - R.Z[s - 1]);
        }
        R.length = R.S[n - 1];
    },

    /** Поверхность дороги: имя по коду. */
    roadSurf(R, s) { return R.surfNames[R.SURF[s]] || 'asphalt'; },

    // ---------------------------------------------------------------------------------------------
    // Перекрёстки: пересечения осей на одной высоте — плоские площадки; в общем месте дороги выравниваются по главной
    // ---------------------------------------------------------------------------------------------

    _junctions() {
        const roads = this.roads;
        /** @type {any[]} */ const found = [];
        const add = (a, b, sa, sb, x, z, ua, ub) => {
            const ya = worldLerp(a.Y[sa], a.Y[sa + 1], ua), yb = worldLerp(b.Y[sb], b.Y[sb + 1], ub);
            if (WM.abs(ya - yb) > WORLD_JUNCTION_DH) return;   // путепровод
            for (const j of found) if (j.a === a && j.b === b && WM.hypot(j.x - x, j.z - z) < (a.maxHW + b.maxHW) * 0.8) return;
            found.push({ a, b, x, z, y: (ya + yb) / 2, sa: sa + ua, sb: sb + ub });
        };
        for (let ia = 0; ia < roads.length; ia++) for (let ib = ia + 1; ib < roads.length; ib++) {
            const a = roads[ia], b = roads[ib];
            if (a.bbox[0] - a.maxHW > b.bbox[2] + b.maxHW || a.bbox[2] + a.maxHW < b.bbox[0] - b.maxHW || a.bbox[1] - a.maxHW > b.bbox[3] + b.maxHW || a.bbox[3] + a.maxHW < b.bbox[1] - b.maxHW) continue;
            // сетка сегментов b
            /** @type {Map<number, number[]>} */ const g = new Map();
            const CS = 3000;
            for (let s = 0; s + 1 < b.n; s++) {
                const x0 = WM.floor(WM.min(b.X[s], b.X[s + 1]) / CS), x1 = WM.floor(WM.max(b.X[s], b.X[s + 1]) / CS);
                const z0 = WM.floor(WM.min(b.Z[s], b.Z[s + 1]) / CS), z1 = WM.floor(WM.max(b.Z[s], b.Z[s + 1]) / CS);
                for (let i = x0; i <= x1; i++) for (let k = z0; k <= z1; k++) { const key = i * 100003 + k; const l = g.get(key); if (l) l.push(s); else g.set(key, [s]); }
            }
            for (let s = 0; s + 1 < a.n; s++) {
                const ax = a.X[s], az = a.Z[s], bx = a.X[s + 1], bz = a.Z[s + 1];
                const x0 = WM.floor(WM.min(ax, bx) / CS), x1 = WM.floor(WM.max(ax, bx) / CS), z0 = WM.floor(WM.min(az, bz) / CS), z1 = WM.floor(WM.max(az, bz) / CS);
                /** @type {Set<number>} */ const seen = new Set();
                for (let i = x0; i <= x1; i++) for (let k = z0; k <= z1; k++) {
                    const l = g.get(i * 100003 + k);
                    if (!l) continue;
                    for (const t of l) {
                        if (seen.has(t)) continue;
                        seen.add(t);
                        const cx = b.X[t], cz = b.Z[t], dx = b.X[t + 1], dz = b.Z[t + 1];
                        const r1x = bx - ax, r1z = bz - az, r2x = dx - cx, r2z = dz - cz;
                        const den = r1x * r2z - r1z * r2x;
                        if (WM.abs(den) < 1e-9) continue;
                        const ua = ((cx - ax) * r2z - (cz - az) * r2x) / den, ub = ((cx - ax) * r1z - (cz - az) * r1x) / den;
                        if (ua < 0 || ua > 1 || ub < 0 || ub > 1) continue;
                        add(a, b, s, t, ax + r1x * ua, az + r1z * ua, ua, ub);
                    }
                }
            }
            // Т-образные: конец одной дороги упирается в ось другой
            for (const [r, o] of [[a, b], [b, a]]) {
                for (const end of [0, r.n - 1]) {
                    if (r.closed) continue;
                    let best = null, bd = Infinity;
                    for (let s = 0; s + 1 < o.n; s++) {
                        const dx = o.X[s + 1] - o.X[s], dz = o.Z[s + 1] - o.Z[s], L2 = dx * dx + dz * dz || 1;
                        const u = worldClamp(((r.X[end] - o.X[s]) * dx + (r.Z[end] - o.Z[s]) * dz) / L2, 0, 1);
                        const d = WM.hypot(r.X[end] - (o.X[s] + dx * u), r.Z[end] - (o.Z[s] + dz * u));
                        if (d < bd) { bd = d; best = { s, u }; }
                    }
                    if (best && bd < o.HW[best.s] + 150 && (best.s > 0 || best.u > 0.02) && (best.s < o.n - 2 || best.u < 0.98)) {
                        const px = worldLerp(o.X[best.s], o.X[best.s + 1], best.u), pz = worldLerp(o.Z[best.s], o.Z[best.s + 1], best.u);
                        const ya = r.Y[end], yb = worldLerp(o.Y[best.s], o.Y[best.s + 1], best.u);
                        if (WM.abs(ya - yb) > WORLD_JUNCTION_DH) continue;
                        if (found.some(j => WM.hypot(j.x - px, j.z - pz) < 900)) continue;
                        const sr = end === 0 ? 0 : r.n - 2, ur = end === 0 ? 0 : 1;
                        if (r === a) found.push({ a, b, x: px, z: pz, y: (ya + yb) / 2, sa: sr + ur, sb: best.s + best.u });
                        else found.push({ a, b, x: px, z: pz, y: (ya + yb) / 2, sa: best.s + best.u, sb: sr + ur });
                    }
                }
            }
        }
        // выравнивание: главная дорога (шире) держит поверхность, вторая плавно подходит к ней по высоте и поперечному уклону
        for (const j of found) {
            const main = j.a.maxHW >= j.b.maxHW ? j.a : j.b, sec = main === j.a ? j.b : j.a;
            const sm = main === j.a ? j.sa : j.sb;
            const R = main.maxHW + sec.maxHW + WORLD_JUNCTION_PAD;
            j.r = R; j.main = main; j.sec = sec;
            const i0 = WM.max(0, WM.floor(sm) - 60), i1 = WM.min(main.n - 2, WM.floor(sm) + 60);
            for (let s = 0; s < sec.n; s++) {
                const d = WM.hypot(sec.X[s] - j.x, sec.Z[s] - j.z);
                if (d >= R) continue;
                // поверхность главной дороги под этой точкой
                let bd = Infinity, by = sec.Y[s];
                for (let k = i0; k <= i1; k++) {
                    const ax = main.X[k], az = main.Z[k], dx = main.X[k + 1] - ax, dz = main.Z[k + 1] - az, L2 = dx * dx + dz * dz || 1;
                    const u = worldClamp(((sec.X[s] - ax) * dx + (sec.Z[s] - az) * dz) / L2, 0, 1);
                    const ex = sec.X[s] - (ax + dx * u), ez = sec.Z[s] - (az + dz * u), dd = WM.hypot(ex, ez);
                    if (dd >= bd) continue;
                    bd = dd;
                    const half = worldLerp(main.HW[k], main.HW[k + 1], u) + worldLerp(main.SH[k], main.SH[k + 1], u);
                    const lat = worldClamp((-ex * dz + ez * dx) / WM.sqrt(L2), -half, half);
                    by = worldLerp(main.Y[k], main.Y[k + 1], u) - WM.tan(worldLerp(main.BK[k], main.BK[k + 1], u)) * lat;
                }
                sec.Y[s] += (by - sec.Y[s]) * (1 - worldSmooth(R * 0.3, R, d));
            }
            j.y = worldLerp(main.Y[WM.floor(sm)], main.Y[WM.min(main.n - 1, WM.floor(sm) + 1)], sm - WM.floor(sm));
            // метки «в перекрёстке» для разметки
            const mr = WM.max(main.HW[WM.floor(sm)], sec.maxHW) + 300;
            for (const r of [main, sec]) for (let s = 0; s < r.n; s++) if (WM.hypot(r.X[s] - j.x, r.Z[s] - j.z) < mr) r.JN[s] = 1;
            j.markR = mr;
        }
        this.junctions = found;
    },

    /** Индекс сегментов дорог для запросов roadAt/surfaceAt: ячейки WORLD_ROAD_CELL, запас — ширина с обочиной и пылью. */
    _indexRoads() {
        this._rgrid = new Map();
        this.segs = [];
        const CS = WORLD_ROAD_CELL;
        for (const R of this.roads) {
            for (let s = 0; s + 1 < R.n; s++) {
                const id = this.segs.length;
                this.segs.push({ road: R, s });
                const reach = WM.max(R.HW[s], R.HW[s + 1]) + WM.max(R.SH[s], R.SH[s + 1]) + 400;
                const x0 = WM.floor((WM.min(R.X[s], R.X[s + 1]) - reach) / CS), x1 = WM.floor((WM.max(R.X[s], R.X[s + 1]) + reach) / CS);
                const z0 = WM.floor((WM.min(R.Z[s], R.Z[s + 1]) - reach) / CS), z1 = WM.floor((WM.max(R.Z[s], R.Z[s + 1]) + reach) / CS);
                for (let i = x0; i <= x1; i++) for (let k = z0; k <= z1; k++) { const key = i * 100003 + k; const l = this._rgrid.get(key); if (l) l.push(id); else this._rgrid.set(key, [id]); }
            }
        }
    },

    /**
     * Кадр оси дороги R на длине дуги s (px): { x, y, z (ось), tx, tz (вдоль), rx, rz (вправо), tb (tg крена: высота на смещении l = y − tb·l),
     * hw, sh, slope (dy/dl), i (выборка), t }. o — свой объект (без него — общий).
     */
    roadFrame(R, s, o) {
        const f = o || this._rf;
        const S = R.S;
        let lo = 0, hi = R.n - 1;
        if (s <= S[0]) { lo = 0; hi = 1; } else if (s >= S[R.n - 1]) { lo = R.n - 2; hi = R.n - 1; }
        else { while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= s) lo = m; else hi = m; } }
        const t = worldClamp((s - S[lo]) / ((S[hi] - S[lo]) || 1), 0, 1);
        f.x = worldLerp(R.X[lo], R.X[hi], t); f.y = worldLerp(R.Y[lo], R.Y[hi], t); f.z = worldLerp(R.Z[lo], R.Z[hi], t);
        let tx = worldLerp(R.TX[lo], R.TX[hi], t), tz = worldLerp(R.TZ[lo], R.TZ[hi], t);
        const l = WM.hypot(tx, tz) || 1; tx /= l; tz /= l;
        f.tx = tx; f.tz = tz; f.rx = -tz; f.rz = tx;
        f.tb = WM.tan(worldLerp(R.BK[lo], R.BK[hi], t)); f.hw = worldLerp(R.HW[lo], R.HW[hi], t); f.sh = worldLerp(R.SH[lo], R.SH[hi], t);
        f.slope = (R.Y[hi] - R.Y[lo]) / (WM.hypot(R.X[hi] - R.X[lo], R.Z[hi] - R.Z[lo]) || 1);
        f.i = lo; f.t = t;
        return f;
    },
    /** @type {any} */ _rf: { x: 0, y: 0, z: 0, tx: 1, tz: 0, rx: 0, rz: 1, tb: 0, hw: 0, sh: 0, slope: 0, i: 0, t: 0 },

    /** Плитки под влиянием дорог и площадок: по ним вид решает, нужна ли сетка (иначе крупные узлы берут рельеф биома напрямую). */
    _influence() {
        const TS = WORLD_TILE * this.cell;
        const mark = (x0, z0, x1, z1) => {
            const i0 = WM.floor(x0 / TS), i1 = WM.floor(x1 / TS), j0 = WM.floor(z0 / TS), j1 = WM.floor(z1 / TS);
            for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) this._infl.add((i + 32768) * 65536 + (j + 32768));
        };
        for (const R of this.roads) {
            const reach = R.maxHW + WORLD_PLATEAU + WORLD_BLEND_MAX;
            for (let s = 0; s + 1 < R.n; s++) mark(WM.min(R.X[s], R.X[s + 1]) - reach, WM.min(R.Z[s], R.Z[s + 1]) - reach, WM.max(R.X[s], R.X[s + 1]) + reach, WM.max(R.Z[s], R.Z[s + 1]) + reach);
        }
        for (const f of this.flats) mark(f.bx0, f.bz0, f.bx1, f.bz1);
    },

    /** Высота для крупных узлов вида: у дорог и площадок — по сетке, вдали — рельеф биома без обращения к плиткам. */
    heightFar(x, z) {
        const TS = WORLD_TILE * this.cell;
        return this._infl.has((WM.floor(x / TS) + 32768) * 65536 + WM.floor(z / TS) + 32768) ? this.heightAt(x, z) : this.hf(x, z);
    },

    /** edgeDist для крупных узлов: вдали от дорог — 1e5 без плитки. */
    edgeDistFar(x, z) {
        const TS = WORLD_TILE * this.cell;
        return this._infl.has((WM.floor(x / TS) + 32768) * 65536 + WM.floor(z / TS) + 32768) ? this.edgeDist(x, z) : 1e5;
    },

    /**
     * Ближайший участок дороги к точке в пределах ширины с обочиной и 4 м пыли → общий объект
     * { road, seg, u, lat (справа +), dist, y (высота оси), hw, sh } или null. Мосты участвуют (под мостом — пока y не мешает: filterY).
     * @param {number} x @param {number} z @param {number} [filterY] если задан — дороги-мосты, лежащие выше точки больше чем на 3 м, пропускаются
     */
    roadAt(x, z, filterY) {
        if (!this.segs.length) return null;
        const l = this._rgrid.get(WM.floor(x / WORLD_ROAD_CELL) * 100003 + WM.floor(z / WORLD_ROAD_CELL));
        if (!l) return null;
        const q = this._rq;
        let best = -1, bd = Infinity, bu = 0, blat = 0;
        for (let i = 0; i < l.length; i++) {
            const sg = this.segs[l[i]], R = sg.road, s = sg.s;
            const ax = R.X[s], az = R.Z[s], dx = R.X[s + 1] - ax, dz = R.Z[s + 1] - az;
            const L2 = dx * dx + dz * dz || 1;
            const u = worldClamp(((x - ax) * dx + (z - az) * dz) / L2, 0, 1);
            const px = x - (ax + dx * u), pz = z - (az + dz * u);
            const d = WM.sqrt(px * px + pz * pz);
            if (d >= bd) continue;
            const reach = worldLerp(R.HW[s], R.HW[s + 1], u) + worldLerp(R.SH[s], R.SH[s + 1], u) + 400;
            if (d > reach) continue;
            if (filterY != null && R.BRIDGE[s] && filterY < worldLerp(R.Y[s], R.Y[s + 1], u) - 300) continue;
            const il = 1 / WM.sqrt(L2);
            bd = d; best = l[i]; bu = u; blat = (-px * dz + pz * dx) * il;
        }
        if (best < 0) return null;
        const sg = this.segs[best], R = sg.road, s = sg.s;
        q.road = R; q.seg = s; q.u = bu; q.lat = blat; q.dist = bd;
        q.y = worldLerp(R.Y[s], R.Y[s + 1], bu);
        q.hw = worldLerp(R.HW[s], R.HW[s + 1], bu); q.sh = worldLerp(R.SH[s], R.SH[s + 1], bu);
        return q;
    },

    // ---------------------------------------------------------------------------------------------
    // Плитки сетки высот (ленивая постройка)
    // ---------------------------------------------------------------------------------------------

    _tile(ti, tj) {
        const key = (ti + 32768) * 65536 + (tj + 32768);
        let t = this.tiles.get(key);
        if (!t) {
            const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
            t = this._genTile(ti, tj);
            this.tiles.set(key, t);
            this.stats.tiles++;
            if (t0) this.stats.tileMs += performance.now() - t0;
        }
        this._last = t;
        return t;
    },

    _scratchDe: new Float32Array((WORLD_TILE + 1) * (WORLD_TILE + 1)),
    _scratchH: new Float32Array((WORLD_TILE + 1) * (WORLD_TILE + 1)),
    _scratchB: new Float32Array((WORLD_TILE + 1) * (WORLD_TILE + 1)),

    _genTile(ti, tj) {
        const C = this.cell, T = WORLD_TILE, N = T + 1;
        const H = new Float32Array(N * N), RD = new Float32Array(N * N);
        const x0 = ti * T * C, z0 = tj * T * C, x1 = x0 + T * C, z1 = z0 + T * C;
        const hf = this.hf;
        for (let j = 0, o = 0; j < N; j++) {
            const z = z0 + j * C;
            for (let i = 0; i < N; i++, o++) { H[o] = hf(x0 + i * C, z); RD[o] = 1e5; }
        }
        // площадки
        for (const f of this.flats) {
            if (f.bx1 < x0 || f.bx0 > x1 || f.bz1 < z0 || f.bz0 > z1) continue;
            for (let j = 0, o = 0; j < N; j++) for (let i = 0; i < N; i++, o++) {
                const sd = this._flatDist(f, x0 + i * C, z0 + j * C);
                if (sd > WORLD_BLEND_MAX) continue;
                if (sd <= 0) { H[o] = f.y; RD[o] = 0; continue; }
                const B = f.blend > 0 ? f.blend : worldClamp(WM.abs(H[o] - f.y) * WORLD_SLOPE, WORLD_BLEND_MIN, WORLD_BLEND_MAX);
                if (sd < B) H[o] += (f.y - H[o]) * (1 - worldSmooth(0, 1, sd / B));
                if (sd < RD[o]) RD[o] = sd;
            }
        }
        // дороги
        const de = this._scratchDe, bh = this._scratchH, bb = this._scratchB;
        for (const R of this._order) {
            if (R.bbox[0] - R.maxHW - WORLD_BLEND_MAX > x1 || R.bbox[2] + R.maxHW + WORLD_BLEND_MAX < x0 || R.bbox[1] - R.maxHW - WORLD_BLEND_MAX > z1 || R.bbox[3] + R.maxHW + WORLD_BLEND_MAX < z0) continue;
            de.fill(Infinity);
            let touched = false;
            for (let s = 0; s + 1 < R.n; s++) {
                const ax = R.X[s], az = R.Z[s], bx = R.X[s + 1], bz = R.Z[s + 1];
                const tunnel = R.TUNNEL[s] === 1, bridge = R.BRIDGE[s] === 1;
                const hwm = WM.max(R.HW[s], R.HW[s + 1]) + WM.max(R.SH[s], R.SH[s + 1]) + WORLD_PLATEAU;
                const reach = hwm + (tunnel ? WORLD_WALL_BLEND : WORLD_BLEND_MAX);
                const sx0 = WM.min(ax, bx) - reach, sx1 = WM.max(ax, bx) + reach, sz0 = WM.min(az, bz) - reach, sz1 = WM.max(az, bz) + reach;
                if (sx1 < x0 || sx0 > x1 || sz1 < z0 || sz0 > z1) continue;
                const i0 = WM.max(0, WM.ceil((sx0 - x0) / C)), i1 = WM.min(T, WM.floor((sx1 - x0) / C));
                const j0 = WM.max(0, WM.ceil((sz0 - z0) / C)), j1 = WM.min(T, WM.floor((sz1 - z0) / C));
                if (i1 < i0 || j1 < j0) continue;
                const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1, invL = 1 / WM.sqrt(L2);
                const y0 = R.Y[s], y1 = R.Y[s + 1], k0 = R.BK[s], k1 = R.BK[s + 1];
                for (let j = j0; j <= j1; j++) {
                    const pz = z0 + j * C, vz = pz - az;
                    for (let i = i0; i <= i1; i++) {
                        const px = x0 + i * C, vx = px - ax;
                        const u = worldClamp((vx * dx + vz * dz) / L2, 0, 1);
                        const ex = vx - dx * u, ez = vz - dz * u;
                        const d = WM.sqrt(ex * ex + ez * ez);
                        const half = worldLerp(R.HW[s], R.HW[s + 1], u) + worldLerp(R.SH[s], R.SH[s + 1], u);
                        const plateau = half + WORLD_PLATEAU;
                        const e = d - plateau;
                        const o = j * N + i;
                        if (bridge) { if (e < RD[o]) RD[o] = WM.max(0, e); continue; }
                        if (e >= de[o]) continue;
                        const lat = (-ex * dz + ez * dx) * invL;                 // справа по курсу +
                        const lc = worldClamp(lat, -half, half);
                        de[o] = e;
                        bh[o] = worldLerp(y0, y1, u) - WM.tan(worldLerp(k0, k1, u)) * lc;
                        bb[o] = tunnel ? WORLD_WALL_BLEND : 0;
                        touched = true;
                    }
                }
            }
            if (!touched) continue;
            for (let o = 0; o < N * N; o++) {
                const e = de[o];
                if (e === Infinity) continue;
                const hv = bh[o];
                if (e <= 0) { H[o] = hv; RD[o] = 0; continue; }
                let B;
                if (bb[o] > 0 && H[o] > hv) B = bb[o];
                else B = worldClamp(WM.abs(H[o] - hv) * WORLD_SLOPE, WORLD_BLEND_MIN, WORLD_BLEND_MAX);
                if (e < B) H[o] += (hv - H[o]) * (1 - worldSmooth(0, 1, e / B));
                if (e < RD[o]) RD[o] = e;
            }
        }
        return { ti, tj, H, RD };
    },

    /** Заранее посчитать плитки в круге радиуса r px (чтобы кадр игры не считал их на ходу). */
    warm(x, z, r) {
        const TS = WORLD_TILE * this.cell;
        const i0 = WM.floor((x - r) / TS), i1 = WM.floor((x + r) / TS), j0 = WM.floor((z - r) / TS), j1 = WM.floor((z + r) / TS);
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) this._tile(i, j);
    },

    // ---------------------------------------------------------------------------------------------
    // Запросы физики
    // ---------------------------------------------------------------------------------------------

    /** Высота поверхности в точке (px): рельеф с вписанной дорогой. Мосты — только земля под ними. */
    heightAt(x, z) {
        const C = this.cell, inv = 1 / C;
        const gx = x * inv, gz = z * inv;
        const gi = WM.floor(gx), gj = WM.floor(gz);
        const fx = gx - gi, fz = gz - gj;
        const ti = WM.floor(gi / WORLD_TILE), tj = WM.floor(gj / WORLD_TILE);
        let t = this._last;
        if (!t || t.ti !== ti || t.tj !== tj) t = this._tile(ti, tj);
        const N = WORLD_TILE + 1, H = t.H;
        const o = (gj - tj * WORLD_TILE) * N + (gi - ti * WORLD_TILE);
        const ha = H[o], hb = H[o + 1], hc = H[o + N], hd = H[o + N + 1];
        if (((gi + gj) & 1) === 0) return fx >= fz ? ha + (hb - ha) * fx + (hd - hb) * fz : ha + (hd - hc) * fx + (hc - ha) * fz;
        return fx + fz <= 1 ? ha + (hb - ha) * fx + (hc - ha) * fz : hd + (hc - hd) * (1 - fx) + (hb - hd) * (1 - fz);
    },

    /** Расстояние до ближайшей дороги или площадки за кромкой её ровной полосы (0 — на ней), px; 1e5 — далеко (по ближайшей вершине). */
    edgeDist(x, z) {
        const C = this.cell, ti = WM.floor(x / (C * WORLD_TILE)), tj = WM.floor(z / (C * WORLD_TILE));
        const t = this._tile(ti, tj);
        const li = WM.max(0, WM.min(WORLD_TILE, WM.round((x - ti * WORLD_TILE * C) / C))), lj = WM.max(0, WM.min(WORLD_TILE, WM.round((z - tj * WORLD_TILE * C) / C)));
        return t.RD[lj * (WORLD_TILE + 1) + li];
    },

    /**
     * Нормаль поверхности [x, y, z] (сглаженная по ячейке). out — свой массив; без него — общий (до следующего вызова).
     * @param {number} x @param {number} z @param {number[]} [out]
     */
    normalAt(x, z, out) {
        const o = out || this._n;
        const C = this.cell, inv = 1 / C;
        const gx = x * inv, gz = z * inv;
        const gi = WM.floor(gx), gj = WM.floor(gz);
        const fx = gx - gi, fz = gz - gj;
        const ti = WM.floor(gi / WORLD_TILE), tj = WM.floor(gj / WORLD_TILE);
        let t = this._last;
        if (!t || t.ti !== ti || t.tj !== tj) t = this._tile(ti, tj);
        const N = WORLD_TILE + 1, H = t.H;
        const k = (gj - tj * WORLD_TILE) * N + (gi - ti * WORLD_TILE);
        const ha = H[k], hb = H[k + 1], hc = H[k + N], hd = H[k + N + 1];
        const sx = ((hb - ha) * (1 - fz) + (hd - hc) * fz) * inv, sz = ((hc - ha) * (1 - fx) + (hd - hb) * fx) * inv;
        const l = 1 / WM.sqrt(sx * sx + 1 + sz * sz);
        o[0] = -sx * l; o[1] = l; o[2] = -sz * l;
        return o;
    },

    /** Уровень воды в точке (px) или null: земля ниже моря. */
    waterAt(x, z) { return this.sea >= 0 && this.heightAt(x, z) < this.sea ? this.sea : null; },

    /** Веса поверхностей земли в точке по биому → общий Float32Array [трава, грунт, скала, песок, снег, бетон] (сумма 1). */
    groundWeights(x, z, h, ny, out) {
        const w = out || this._gw;
        const P = this.P, seed = this.seed | 0, mx = x * 0.01, mz = z * 0.01;
        let g = 0, d = 0, r = 0, s = 0, sn = 0, c = 0;
        const slope = 1 - ny;
        switch (this.biome) {
            case 'alpine': {
                const R = WM.max(1, this.relief), rel = h / R;
                const n1 = worldFbm(mx / 70, mz / 70, 2, seed + 21), n2 = worldFbm(mx / 160, mz / 160, 2, seed + 22), n3 = worldFbm(mx / 90, mz / 90, 2, seed + 23);
                r = worldSmooth(0.2, 0.36, slope + 0.07 * n1);
                const snowLine = 0.62 - 0.1 * ((P.snow == null ? 1 : P.snow) - 1);
                sn = worldSmooth(snowLine, snowLine + 0.1, rel + 0.07 * n2) * (1 - r * 0.9) * (P.snow === 0 ? 0 : 1);
                d = worldSmooth(0.36, 0.5, rel + 0.09 * n3) * (1 - sn) * (1 - r) + worldSmooth(0.6, 0.85, worldFbm(mx / 28, mz / 28, 2, seed + 24) * 0.5 + 0.5) * 0.45 * (1 - sn) * (1 - r);
                g = WM.max(0, 1 - r - sn - d);
                break;
            }
            case 'highway': {
                const parcel = this.parcel(x, z);
                r = worldSmooth(0.28, 0.45, slope + 0.05 * worldFbm(mx / 60, mz / 60, 2, seed + 21));
                d = (parcel.kind === 2 ? 0.92 : 0) * (1 - r) + worldSmooth(0.7, 0.9, worldFbm(mx / 40, mz / 40, 2, seed + 22) * 0.5 + 0.5) * 0.25;
                if (this.sea >= 0 && h < this.sea + 260) { s = worldSmooth(this.sea + 260, this.sea + 60, h); }
                d = WM.min(1 - r, d);
                g = WM.max(0, 1 - r - d - s);
                break;
            }
            case 'canyon': {
                r = worldSmooth(0.16, 0.34, slope + 0.06 * worldFbm(mx / 50, mz / 50, 2, seed + 21));
                d = worldSmooth(0.45, 0.8, worldFbm(mx / 60, mz / 60, 2, seed + 22) * 0.5 + 0.5) * (1 - r) * 0.7;
                s = WM.max(0, 1 - r - d);
                break;
            }
            case 'city': {
                const park = worldSmooth(0.64, 0.74, worldFbm(mx / 230, mz / 230, 2, seed + 21) * 0.5 + 0.5);
                g = park; c = 1 - park;
                r = worldSmooth(0.4, 0.6, slope) ; g *= 1 - r; c *= 1 - r;
                break;
            }
            default: {
                // полигон: бетон; у карты с холмами (relief > 1500) бетон — только плиты-площадки (их рисует вид), вокруг обычная земля
                if (this.relief > 1500) {
                    const rel = h / WM.max(1, this.relief);
                    r = worldSmooth(0.2, 0.36, slope + 0.07 * worldFbm(mx / 60, mz / 60, 2, seed + 21));
                    d = (worldSmooth(0.55, 0.8, worldFbm(mx / 45, mz / 45, 2, seed + 24) * 0.5 + 0.5) * 0.55 + worldSmooth(0.5, 0.85, rel + 0.08 * worldFbm(mx / 140, mz / 140, 2, seed + 25)) * 0.5) * (1 - r);
                    g = WM.max(0, 1 - r - d);
                } else c = 1;
            }
        }
        const sum = g + d + r + s + sn + c || 1;
        w[0] = g / sum; w[1] = d / sum; w[2] = r / sum; w[3] = s / sum; w[4] = sn / sum; w[5] = c / sum;
        return w;
    },

    /** Участок полей (биом highway): { kind: 0 луг, 1 луг-2, 2 вспаханное, 3 колосья, hash, edge (px до границы) }. Общий объект. */
    _parcel: { kind: 0, hash: 0, edge: 9999 },
    parcel(x, z) {
        const a = 0.41, ca = WM.cos(a), sa = WM.sin(a);
        const wx = x + worldFbm(x * 0.0009, z * 0.0009, 2, this.seed + 71) * 5200, wz = z + worldFbm(x * 0.0009 + 9, z * 0.0009 - 3, 2, this.seed + 72) * 5200;
        const u = (wx * ca + wz * sa) / 21000, v = (-wx * sa + wz * ca) / 15000;
        const iu = WM.floor(u), iv = WM.floor(v);
        const hsh = worldHash(iu, iv, this.seed + 73);
        const eu = WM.min(u - iu, iu + 1 - u) * 21000, ev = WM.min(v - iv, iv + 1 - v) * 15000;
        const p = this._parcel;
        p.hash = hsh; p.kind = hsh < 0.3 ? 0 : hsh < 0.52 ? 1 : hsh < 0.72 ? 2 : 3; p.edge = WM.min(eu, ev);
        return p;
    },

    /** Лесистость 0..1 в точке (биомы alpine и highway): по ней сажаются деревья и темнеет подстилка; остальные биомы — 0. */
    forestMask(x, z) {
        const mx = x * 0.01, mz = z * 0.01, seed = this.seed | 0;
        if (this.biome === 'alpine') return worldSmooth(0.4, 0.58, worldFbm(mx / 230, mz / 230, 3, seed + 90) * 0.5 + 0.5);
        if (this.biome === 'highway') return worldSmooth(0.46, 0.6, worldFbm(mx / 190, mz / 190, 3, seed + 90) * 0.5 + 0.5);
        return 0;
    },

    /** Название поверхности земли (без дорог) по весам. */
    _groundName(w) {
        let best = 0;
        for (let i = 1; i < 6; i++) if (w[i] > w[best]) best = i;
        return ['grass', 'dirt', 'rock', 'sand', 'snow', 'concrete'][best];
    },

    /**
     * Поверхность под точкой: дорога (асфальт, бетон, грунт, гравий), её обочина (гравий), площадка или земля биома. Общий
     * неизменяемый объект { name, mu, rough, onRoad, drag }. y — высота колеса: под мостом дорога не считается.
     * @param {number} x @param {number} z @param {number} [y]
     * @returns {WorldSurface}
     */
    surfaceAt(x, z, y) {
        const q = this.roadAt(x, z, y);
        if (q) {
            const R = q.road;
            if (WM.abs(q.lat) <= q.hw) return WORLD_SURF[this.roadSurf(R, q.seg) + '@road'];
            if (WM.abs(q.lat) <= q.hw + q.sh) return WORLD_SURF[this.roadSurf(R, q.seg) === 'dirt' ? 'dirt' : 'gravel'];
        }
        for (let i = 0; i < this.flats.length; i++) {
            const f = this.flats[i];
            if (this._flatDist(f, x, z) <= 0) return WORLD_SURF[f.surf + (f.surf === 'asphalt' || f.surf === 'concrete' ? '@road' : '')];
        }
        const h = this.heightAt(x, z), n = this.normalAt(x, z);
        return WORLD_SURF[this._groundName(this.groundWeights(x, z, h, n[1]))];
    },

    // --- луч -----------------------------------------------------------------------------------

    /**
     * Луч по рельефу: ближайшее пересечение сверху (грань смотрит против луча). Направление — единичное, maxT — длина, px. Быстрый
     * марш по ячейкам сетки и точное пересечение с треугольниками — короткие лучи колёс стоят одну-две ячейки, длинные (камера) тоже работают.
     * Результат ОБЩИЙ (до следующего вызова) или out: { t, n: [x, y, z], x, y, z }.
     * @param {number} ox @param {number} oy @param {number} oz @param {number} dx @param {number} dy @param {number} dz @param {number} maxT @param {any} [out]
     */
    ray(ox, oy, oz, dx, dy, dz, maxT, out) {
        const o = out || this._hit;
        const C = this.cell, inv = 1 / C;
        let gi = WM.floor(ox * inv), gj = WM.floor(oz * inv);
        const si = dx > 0 ? 1 : -1, sj = dz > 0 ? 1 : -1;
        const tDx = WM.abs(dx) > 1e-12 ? C / WM.abs(dx) : Infinity, tDz = WM.abs(dz) > 1e-12 ? C / WM.abs(dz) : Infinity;
        let tMx = dx > 0 ? ((gi + 1) * C - ox) / dx : dx < 0 ? (gi * C - ox) / dx : Infinity;
        let tMz = dz > 0 ? ((gj + 1) * C - oz) / dz : dz < 0 ? (gj * C - oz) / dz : Infinity;
        let t = 0;
        for (let guard = 0; guard < 6000; guard++) {
            const tEnd = WM.min(tMx, tMz, maxT);
            if (this._cellRay(gi, gj, ox, oy, oz, dx, dy, dz, t, tEnd, o)) return o;
            if (tEnd >= maxT) return null;
            if (tMx < tMz) { gi += si; t = tMx; tMx += tDx; } else { gj += sj; t = tMz; tMz += tDz; }
        }
        return null;
    },

    _cellRay(gi, gj, ox, oy, oz, dx, dy, dz, t0, t1, o) {
        const C = this.cell, T = WORLD_TILE, N = T + 1;
        const ti = WM.floor(gi / T), tj = WM.floor(gj / T);
        let tile = this._last;
        if (!tile || tile.ti !== ti || tile.tj !== tj) tile = this._tile(ti, tj);
        const H = tile.H, k = (gj - tj * T) * N + (gi - ti * T);
        const ha = H[k], hb = H[k + 1], hc = H[k + N], hd = H[k + N + 1];
        const ya = oy + dy * t0, yb = oy + dy * t1;
        const hmax = WM.max(ha, hb, hc, hd), hmin = WM.min(ha, hb, hc, hd);
        if (WM.min(ya, yb) > hmax + 0.01 || WM.max(ya, yb) < hmin - 0.01) return false;
        const xa = gi * C, za = gj * C;
        const lx = (ox - xa) / C, lz = (oz - za) / C, ldx = dx / C, ldz = dz / C;   // локальные координаты ячейки 0..1
        let bestT = Infinity, bnx = 0, bny = 1, bnz = 0;
        const even = ((gi + gj) & 1) === 0;
        for (let tri = 0; tri < 2; tri++) {
            let gx, gz, h0, x0, z0;   // плоскость: h = h0 + gx*(u−x0) + gz*(v−z0), u, v — локальные 0..1; gx, gz — на единицу ячейки
            if (even) {
                if (tri === 0) { h0 = ha; x0 = 0; z0 = 0; gx = hb - ha; gz = hd - hb; }
                else { h0 = ha; x0 = 0; z0 = 0; gx = hd - hc; gz = hc - ha; }
            } else if (tri === 0) { h0 = ha; x0 = 0; z0 = 0; gx = hb - ha; gz = hc - ha; }
            else { h0 = hd; x0 = 1; z0 = 1; gx = hd - hc; gz = hd - hb; }
            // подъём на единицу локальной координаты; в мире — деление на C
            const sx = gx / C, sz = gz / C;
            const den = dy - sx * dx - sz * dz;
            if (den >= -1e-12) continue;   // луч не входит сверху
            // h(t) = h0 + sx*(C*(lx+ldx t) − C*x0)... в мире: уровень поверхности под лучом
            const num = h0 + sx * (ox - xa - x0 * C) + sz * (oz - za - z0 * C) - oy;
            const t = num / den;
            if (t < t0 - 1e-4 || t > t1 + 1e-4 || t >= bestT) continue;
            const u = lx + ldx * t, v = lz + ldz * t;
            const eps = 1e-5;
            const inside = even ? (tri === 0 ? u + eps >= v : u - eps <= v) : (tri === 0 ? u + v <= 1 + eps : u + v >= 1 - eps);
            if (!inside) continue;
            const l = 1 / WM.sqrt(sx * sx + 1 + sz * sz);
            bestT = t; bnx = -sx * l; bny = l; bnz = -sz * l;
        }
        if (bestT === Infinity) return false;
        o.t = bestT; o.n[0] = bnx; o.n[1] = bny; o.n[2] = bnz;
        o.x = ox + dx * bestT; o.y = oy + dy * bestT; o.z = oz + dz * bestT;
        return true;
    },

    // ---------------------------------------------------------------------------------------------
    // Декор: деревья и камни детерминированно по ячейкам 64 м (вид рисует их, Props.near отдаёт стволы как неподвижные предметы)
    // ---------------------------------------------------------------------------------------------

    /** Правила декора биома: [{ kind, step, seed, scale: [мин, макс], prob(c) }], c — контекст точки. */
    _decorRules() {
        const P = this.P, seed = this.seed | 0, td = WM.max(0, P.trees);
        const R = WM.max(1, this.relief);
        
        switch (this.biome) {
            case 'alpine': return [
                { kind: 'spruce', step: 820, seed: 1, scale: [0.7, 1.45], clear: 1100, prob: c => td * (0.06 + 0.9 * c.forest) * worldSmooth(0.5, 0.36, c.rel) * worldSmooth(0.42, 0.6, c.ny) },
                { kind: 'spruce', step: 1500, seed: 2, scale: [0.5, 0.9], clear: 800, prob: c => td * 0.5 * worldSmooth(0.55, 0.4, c.rel) * worldSmooth(0.45, 0.65, c.ny) },
                { kind: 'rock', step: 1700, seed: 3, scale: [0.5, 2.6], clear: 450, prob: c => 0.2 + 0.7 * (1 - worldSmooth(0.5, 0.9, c.ny)) },
                { kind: 'bush', step: 700, seed: 4, scale: [0.6, 1.4], clear: 400, prob: c => td * 0.35 * worldSmooth(0.5, 0.3, c.rel) * worldSmooth(0.7, 0.85, c.ny) },
                { kind: 'snag', step: 2800, seed: 5, scale: [0.75, 1.15], clear: 900, prob: c => td * 0.16 * worldSmooth(0.62, 0.42, c.rel) * worldSmooth(0.45, 0.65, c.ny) },
            ];
            case 'highway': return [
                { kind: 'oak', step: 1000, seed: 1, scale: [0.7, 1.4], clear: 1000, prob: c => td * (0.03 + 0.9 * c.forest) },
                { kind: 'poplar', step: 2200, seed: 2, scale: [0.8, 1.3], clear: 700, prob: c => td * 0.5 * (c.parcelEdge < 500 ? 1 : 0.08) },
                { kind: 'bush', step: 800, seed: 3, scale: [0.6, 1.5], clear: 350, prob: c => td * (c.parcelEdge < 380 ? 0.8 : 0.1) },
                { kind: 'rock', step: 2600, seed: 4, scale: [0.4, 1.6], clear: 450, prob: c => 0.15 + 0.6 * (1 - worldSmooth(0.6, 0.9, c.ny)) },
            ];
            case 'canyon': return [
                { kind: 'rock', step: 1200, seed: 1, scale: [0.6, 3.2], clear: 450, prob: c => 0.12 + 0.75 * (1 - worldSmooth(0.55, 0.95, c.ny)) },
                { kind: 'cactus', step: 1500, seed: 2, scale: [0.6, 1.4], clear: 800, prob: c => td * 0.2 * worldSmooth(0.85, 0.95, c.ny) },
                { kind: 'dead', step: 2100, seed: 3, scale: [0.7, 1.3], clear: 900, prob: c => td * 0.14 },
                { kind: 'bush', step: 900, seed: 4, scale: [0.5, 1.1], clear: 350, prob: c => td * 0.3 * worldSmooth(0.85, 0.95, c.ny) },
            ];
            case 'city': return [
                { kind: 'oak', step: 1400, seed: 1, scale: [0.55, 0.95], clear: 1200, prob: c => td * c.park * 0.8 },
                { kind: 'bush', step: 900, seed: 2, scale: [0.6, 1.1], clear: 400, prob: c => td * c.park * 0.5 },
            ];
            default:
                // полигон с холмами: только кусты на траве (проходимые, физике не нужны); плоский полигон — без декора
                return this.relief > 1500 ? [{ kind: 'bush', step: 1000, seed: 1, scale: [0.6, 1.5], clear: 500, prob: c => td * 0.45 * worldSmooth(0.6, 0.75, c.ny) }] : (void R, []);
        }
    },

    /** Есть ли у мира декор (деревья, кусты, камни): плоский полигон — нет. */
    hasDecor() { return this.biome !== 'proving' || this.relief > 1500; },

    /**
     * Декор одной ячейки 64 м (ci, cj): { items: [{ kind, x, y, z, yaw, s, r, h, solid, prop }], cx, cz }. Строится один раз и кэшируется.
     * Всё — функция координат и сида: вид и физика получают одни и те же деревья.
     */
    decorCell(ci, cj) {
        const key = (ci + 32768) * 65536 + (cj + 32768);
        let cell = this._decor.get(key);
        if (cell) return cell;
        cell = { ci, cj, items: [], bx0: ci * WORLD_DECOR_CELL, bz0: cj * WORLD_DECOR_CELL };
        this._decor.set(key, cell);
        if (this._decor.size > 4000) { const first = this._decor.keys().next().value; this._decor.delete(first); }
        const rules = this.hasDecor() ? this._decorRules() : [];
        const CS = WORLD_DECOR_CELL, seed = this.seed | 0;
        const c = { x: 0, z: 0, h: 0, ny: 1, rel: 0, park: 0, parcelEdge: 9999, forest: 0 };
        const nrm = [0, 1, 0];
        for (let ri = 0; ri < rules.length; ri++) {
            const rule = rules[ri], step = rule.step, n = WM.ceil(CS / step), info = WORLD_DECOR[rule.kind];
            for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
                const hx = worldHash(ci * 64 + a, cj * 64 + b, seed + rule.seed * 131 + 7), hz = worldHash(ci * 64 + a, cj * 64 + b, seed + rule.seed * 131 + 8);
                const x = cell.bx0 + (a + hx) * step, z = cell.bz0 + (b + hz) * step;
                if (x < cell.bx0 || x >= cell.bx0 + CS || z < cell.bz0 || z >= cell.bz0 + CS) continue;
                const pr = worldHash(ci * 64 + a, cj * 64 + b, seed + rule.seed * 131 + 9);
                const rd = this.edgeDist(x, z);
                if (rd < rule.clear) continue;
                const h = this.heightAt(x, z);
                if (this.sea >= 0 && h < this.sea + 80) continue;
                this.normalAt(x, z, nrm);
                c.x = x; c.z = z; c.h = h; c.ny = nrm[1]; c.rel = h / WM.max(1, this.relief);
                if (this.biome === 'city') c.park = this.groundWeights(x, z, h, nrm[1])[0];
                c.forest = this.forestMask(x, z);
                if (this.biome === 'highway') c.parcelEdge = this.parcel(x, z).edge;
                const p = rule.prob(c);
                if (!(pr < p)) continue;
                const sc = rule.scale[0] + (rule.scale[1] - rule.scale[0]) * worldHash(ci * 64 + a, cj * 64 + b, seed + rule.seed * 131 + 10);
                const yaw = worldHash(ci * 64 + a, cj * 64 + b, seed + rule.seed * 131 + 11) * WM.PI * 2;
                const sink = rule.kind === 'rock' ? -info.h * sc * 0.28 : 0;
                cell.items.push({ kind: rule.kind, x, y: h + sink, z, yaw, s: sc, r: info.r * sc, h: info.h * sc, solid: info.r > 0, mass: info.mass, id: cell.items.length,
                    // поля неподвижного предмета Props (ствол — вертикальный цилиндр от y до y + h): Props.contact читает их так же, как у предметов
                    shape: 2, state: 0, invM: 0, brk: 0, mu: 0.6, e: 0.12, rad: Math.max(info.r * sc, info.h * sc * 0.5), surface: rule.kind === 'rock' ? 'rock' : 'wood' });
            }
        }
        return cell;
    },

    /**
     * Травяной покров биома (только вид, проходим): [{ kind, step, clear, scale, tint, prob(c) }], c = { rel, ny, surf, forest, park }, surf — имя поверхности.
     * Считается только рядом с камерой, поэтому отдельно от decorCell: физике покров не нужен.
     */
    coverRules() {
        if (!this.hasDecor()) return [];
        const td = WM.min(1, WM.max(0, this.P.trees));
        const soft = (c) => (c.surf === 'grass' || c.surf === 'dirt' ? 1 : 0);
        const green = [0.92, 1.02, 0.86], dry = [1.18, 1.0, 0.55], pale = [1, 1, 0.82];
        switch (this.biome) {
            case 'alpine': return [
                { kind: 'grass', step: 460, seed: 21, clear: 140, scale: [0.7, 1.35], tint: green, prob: c => td * 0.55 * soft(c) * worldSmooth(0.5, 0.32, c.rel) * worldSmooth(0.7, 0.85, c.ny) },
                { kind: 'fern', step: 900, seed: 22, clear: 180, scale: [0.7, 1.2], tint: green, prob: c => td * (0.1 + 0.4 * c.forest) * soft(c) * worldSmooth(0.5, 0.32, c.rel) * worldSmooth(0.7, 0.85, c.ny) },
                { kind: 'flower', step: 1000, seed: 23, clear: 160, scale: [0.8, 1.3], tint: green, prob: c => td * 0.3 * soft(c) * worldSmooth(0.45, 0.28, c.rel) * worldSmooth(0.8, 0.92, c.ny) },
            ];
            case 'highway': return [
                { kind: 'grass', step: 420, seed: 21, clear: 120, scale: [0.75, 1.45], tint: pale, prob: c => td * 0.6 * soft(c) * worldSmooth(0.75, 0.88, c.ny) },
                { kind: 'flower', step: 1000, seed: 23, clear: 140, scale: [0.8, 1.35], tint: pale, prob: c => td * 0.32 * soft(c) * worldSmooth(0.8, 0.92, c.ny) },
            ];
            case 'canyon': return [
                { kind: 'grass', step: 800, seed: 21, clear: 170, scale: [0.6, 1.1], tint: dry, prob: c => td * 0.3 * worldSmooth(0.85, 0.95, c.ny) },
            ];
            case 'city': return [
                { kind: 'grass', step: 440, seed: 21, clear: 120, scale: [0.65, 1.1], tint: green, prob: c => td * 0.6 * c.park },
                { kind: 'flower', step: 1000, seed: 23, clear: 140, scale: [0.8, 1.2], tint: green, prob: c => td * 0.3 * c.park },
            ];
            default: return [
                { kind: 'grass', step: 440, seed: 21, clear: 130, scale: [0.7, 1.3], tint: pale, prob: c => td * 0.5 * soft(c) * worldSmooth(0.75, 0.88, c.ny) },
            ];
        }
    },

    /** Стволы и камни в прямоугольнике [x0..x1]×[z0..z1]: добавляет записи декора в out (массив). */
    decorNear(x0, z0, x1, z1, out) {
        const CS = WORLD_DECOR_CELL;
        const i0 = WM.floor(x0 / CS), i1 = WM.floor(x1 / CS), j0 = WM.floor(z0 / CS), j1 = WM.floor(z1 / CS);
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
            const cell = this.decorCell(i, j), items = cell.items;
            for (let k = 0; k < items.length; k++) {
                const it = items[k];
                if (it.solid && it.x + it.r >= x0 && it.x - it.r <= x1 && it.z + it.r >= z0 && it.z - it.r <= z1) out.push(it);
            }
        }
        return out;
    },

    // ---------------------------------------------------------------------------------------------
    // Вид (WorldView, GameWorldView.js): тонкая обвязка — игра зовёт только GameWorld
    // ---------------------------------------------------------------------------------------------

    /** Меши мира под экраном загрузки: рельеф, дороги, декор, небо, свет. app.location.view — сцена. */
    async buildView(app, opts) {
        if (typeof WorldView === 'undefined') return null;
        this.view = WorldView;
        await WorldView.build(app, this, opts || {});
        return WorldView;
    },

    /** Раз в кадр: уровни рельефа и декор по камере, небо и свет. camera — позиция {x, y, z} (по умолчанию камера вида). */
    update(dt, camera) {
        if (this.view && this.view.update) this.view.update(dt, camera);
    },
};
