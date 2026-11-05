// GameProps.js — предметы мира: отбойники, столбы, фонари, конусы, бочки, шины, бетонные блоки — твёрдые тела с точечным контактом.
// Решения (удар, слом, сон) — чистая логика без Babylon (инвариант 4): детерминированно; вид — thin instances пачками «тип × участок 400 м»
// (не больше одного draw call на тип в пачке), спящие и неподвижные предметы не стоят ничего, кроме матрицы в буфере.
//
// ПРЕДМЕТЫ ПРИХОДЯТ ИЗ КАРТЫ (docs/WORLD.md):
//   правила дороги   rail=lr — отбойник вдоль кромки (шаг 4 м), lamp=1 — фонари (шаг 40 м, через сторону), lamp=2 — с обеих сторон;
//   prop <id>        один предмет (rot[1] — курс, h — над поверхностью, abs=1 — абсолютная высота);
//   scatter <id> n=30 r=900   россыпь n предметов в круге r px.
// Деревья, камни и кактусы биома — неподвижные предметы с большой массой: их отдаёт GameWorld.decorNear (детерминированно по ячейкам
// 64 м, вид рисует WorldDecor из тех же данных), Props.near добавляет их в общий список. contact для них — как для неподвижного предмета.
//
// API (контракт docs/DESTRUCTION.md):
//   Props.build(map, view)        построить предметы карты (view — View3D; без него — только логика, как в node)
//   Props.update(dt)              шаг твёрдых тел: спящие не считаются
//   Props.near(x0, y0, z0, x1, y1, z1, out)   предметы в AABB → out (массив очищается, без выделений); деревья и камни — тоже
//   Props.contact(prop, x, y, z, r, vx, vy, vz, invM, res)   точка-сфера против предмета: false — нет касания; true — res:
//        nx, ny, nz (нормаль наружу, к точке), depth, jn (импульс точке по нормали), jx, jy, jz (полный импульс точке с трением),
//        px, py, pz (точка касания), surface; предмету импульс применён, он проснулся и мог сломаться
//   Props.reset()                 всё на исходные места (новый заезд)
//   Props.sync(dt)                раз в кадр: матрицы подвижных предметов в буферы, дальние пачки выключены
//   Props.stats()                 { total, active, asleep, broken, batches }
// Предмет: { id, type, shape (0 брус, 1 цилиндр, 2 ствол), x, y, z (центр), hx, hy, hz | r, state (0 неподвижен, 1 в движении, 2 спит,
// 3 убран), invM, surface, mu, e, brk (порог слома, кг·px/с), rad, R (оси — 9 чисел), vx.., wx.. } — поля читает физика машины.

// --- настройка ---
const PROPS_CELL = 800;            // px: ячейка пространственного индекса
const PROPS_MAXR = 480;            // px: самый большой радиус предмета (запас при выборке)
const PROPS_CHUNK = 40000;         // px: пачка отрисовки (участок)
const PROPS_DRAW = 95000;          // px: дальше пачка не рисуется
const PROPS_STEP = 1 / 100;        // с: шаг твёрдых тел
const PROPS_SLEEP_V = 26;          // px/с: медленнее — «почти стоит»
const PROPS_SLEEP_W = 0.75;        // рад/с
const PROPS_SLEEP_T = 0.5;         // с покоя до сна
const PROPS_RAIL_STEP = 400;       // px: отбойник вдоль кромки (длина секции 4 м)
const PROPS_RAIL_OFF = 90;         // px: от кромки асфальта до оси отбойника
const PROPS_LAMP_STEP = 4000;      // px: фонари
const PROPS_MIN_R = 24;            // px: наименьший радиус инерции цилиндра
const PROPS_MAX_W = 28;            // рад/с: предел вращения предмета
const PROPS_MAX_V = 9000;          // px/с: предел скорости предмета
const PROPS_UPRIGHT_HY = 150;      // px: выше этой полувысоты предмет стоит вертикально, а не по нормали склона (столбы, фонари, деревья)
const PROPS_BREAK_WINDOW = 0.14;   // с: удары в окне складываются перед проверкой порога слома

/** Типы предметов: размеры в px (полуразмеры), масса кг, порог слома brk (кг·px/с суммарного импульса за 0.14 с; 0 — не ломается),
 *  hold — неподвижен, пока не сломан. Модель: model — путь assets/models/props/… литералом (нет файла — процедурная модель): размеры — по
 *  art/blender/props/manifest.json (в игре x = X, y = Z, z = −Y), начало модели — центр основания тела; mx — сдвиг начала модели вдоль оси x тела,
 *  если модель не по центру (шлагбаум: тумба с краю, тело — вся стрела). draw — дальность рисования пачек типа, px (мелочь не рисуется до горизонта). */
/** @type {Record<string, any>} */
const PROP_TYPES = {
    guardrail: { shape: 0, hx: 200, hy: 38, hz: 15, mass: 170, brk: 950000, mu: 0.35, e: 0.1, surface: 'metal', hold: true, model: 'assets/models/props/guardrail.glb', draw: 24000 },
    barrier: { shape: 0, hx: 150, hy: 40.5, hz: 30.6, mass: 1400, brk: 0, mu: 0.6, e: 0.08, surface: 'concrete', hold: false, model: 'assets/models/props/barrier.glb', draw: 36000 },
    jersey: { shape: 0, hx: 150, hy: 40.5, hz: 30.6, mass: 1400, brk: 0, mu: 0.6, e: 0.08, surface: 'concrete', hold: false, model: 'assets/models/props/barrier.glb', draw: 36000 },
    barrier_plastic: { shape: 0, hx: 100, hy: 50, hz: 25.3, mass: 30, brk: 0, mu: 0.5, e: 0.25, surface: 'plastic', hold: false, model: 'assets/models/props/barrier_plastic.glb', draw: 40000 },
    block: { shape: 0, hx: 50, hy: 50, hz: 50, mass: 2400, brk: 0, mu: 0.6, e: 0.1, surface: 'concrete', hold: false },
    crate: { shape: 0, hx: 50, hy: 50, hz: 50, mass: 40, brk: 0, mu: 0.5, e: 0.2, surface: 'wood', hold: false, model: 'assets/models/props/crate.glb', draw: 40000 },
    cone: { shape: 1, r: 20, hy: 37.5, mass: 4, brk: 0, mu: 0.5, e: 0.35, surface: 'plastic', hold: false, model: 'assets/models/props/cone.glb', draw: 30000 },
    barrel: { shape: 1, r: 29.3, hy: 45, mass: 45, brk: 0, mu: 0.45, e: 0.25, surface: 'metal', hold: false, model: 'assets/models/props/barrel.glb', draw: 40000 },
    tires: { shape: 1, r: 34.5, hy: 44, mass: 45, brk: 0, mu: 0.8, e: 0.3, surface: 'rubber', hold: false, model: 'assets/models/props/tire_stack.glb', draw: 40000 },
    tire_stack: { shape: 1, r: 34.5, hy: 44, mass: 45, brk: 0, mu: 0.8, e: 0.3, surface: 'rubber', hold: false, model: 'assets/models/props/tire_stack.glb', draw: 40000 },
    lamp: { shape: 1, r: 9, hy: 400, mass: 180, brk: 1250000, mu: 0.3, e: 0.1, surface: 'metal', hold: true, model: 'assets/models/props/street_lamp.glb', draw: 62000 },
    street_lamp: { shape: 1, r: 9, hy: 400, mass: 180, brk: 1250000, mu: 0.3, e: 0.1, surface: 'metal', hold: true, model: 'assets/models/props/street_lamp.glb', draw: 62000 },
    traffic_light: { shape: 1, r: 10, hy: 220, mass: 140, brk: 900000, mu: 0.3, e: 0.1, surface: 'metal', hold: true, model: 'assets/models/props/traffic_light.glb', draw: 38000 },
    sign: { shape: 1, r: 5, hy: 125, mass: 16, brk: 320000, mu: 0.3, e: 0.1, surface: 'metal', hold: true, model: 'assets/models/props/sign_speed.glb', draw: 45000 },
    sign_stop: { shape: 1, r: 5, hy: 125, mass: 18, brk: 320000, mu: 0.3, e: 0.1, surface: 'metal', hold: true, model: 'assets/models/props/sign_stop.glb', draw: 45000 },
    sign_arrow: { shape: 1, r: 5, hy: 115, mass: 16, brk: 320000, mu: 0.3, e: 0.1, surface: 'metal', hold: true, model: 'assets/models/props/sign_arrow.glb', draw: 45000 },
    sign_speed: { shape: 1, r: 5, hy: 125, mass: 16, brk: 320000, mu: 0.3, e: 0.1, surface: 'metal', hold: true, model: 'assets/models/props/sign_speed.glb', draw: 45000 },
    hydrant: { shape: 1, r: 22, hy: 43.8, mass: 110, brk: 700000, mu: 0.4, e: 0.1, surface: 'metal', hold: true, model: 'assets/models/props/hydrant.glb', draw: 30000 },
    bench: { shape: 0, hx: 90, hy: 44, hz: 30, mass: 55, brk: 260000, mu: 0.5, e: 0.15, surface: 'wood', hold: true, model: 'assets/models/props/bench.glb', draw: 30000 },
    bollard: { shape: 1, r: 17, hy: 50, mass: 45, brk: 380000, mu: 0.4, e: 0.15, surface: 'metal', hold: true, model: 'assets/models/props/bollard.glb', draw: 30000 },
    fence_panel: { shape: 0, hx: 150, hy: 104.5, hz: 12, mass: 45, brk: 240000, mu: 0.4, e: 0.1, surface: 'metal', hold: true, model: 'assets/models/props/fence_panel.glb', draw: 45000 },
    trash_bin: { shape: 1, r: 32, hy: 53, mass: 30, brk: 0, mu: 0.5, e: 0.25, surface: 'plastic', hold: false, model: 'assets/models/props/trash_bin.glb', draw: 30000 },
    mailbox: { shape: 0, hx: 24, hy: 64.5, hz: 29, mass: 60, brk: 300000, mu: 0.4, e: 0.15, surface: 'metal', hold: true, model: 'assets/models/props/mailbox.glb', draw: 30000 },
    parking_barrier: { shape: 0, hx: 240, hy: 61, hz: 12, mass: 70, brk: 130000, mu: 0.4, e: 0.1, surface: 'metal', hold: true, mx: 190, model: 'assets/models/props/parking_barrier.glb', draw: 30000 },
    road_works_sign: { shape: 0, hx: 46, hy: 78, hz: 20, mass: 14, brk: 0, mu: 0.5, e: 0.2, surface: 'plastic', hold: false, model: 'assets/models/props/road_works_sign.glb', draw: 35000 },
    bus_stop: { shape: 0, hx: 269, hy: 142, hz: 91, mass: 300, brk: 1300000, mu: 0.4, e: 0.1, surface: 'metal', hold: true, mx: 27, model: 'assets/models/props/bus_stop.glb', draw: 60000 },
    power_pole: { shape: 1, r: 16, hy: 600, mass: 380, brk: 1400000, mu: 0.4, e: 0.1, surface: 'wood', hold: true, model: 'assets/models/props/power_pole.glb', draw: 70000 },
    field_fence: { shape: 0, hx: 150, hy: 60, hz: 10, mass: 32, brk: 200000, mu: 0.4, e: 0.1, surface: 'wood', hold: true, model: 'assets/models/props/field_fence.glb', draw: 40000 },
    hay_bale: { shape: 0, hx: 80, hy: 80, hz: 65, mass: 280, brk: 0, mu: 0.6, e: 0.15, surface: 'wood', hold: false, model: 'assets/models/props/hay_bale.glb', draw: 45000 },
    newsstand: { shape: 0, hx: 95, hy: 110, hz: 45, mass: 170, brk: 300000, mu: 0.4, e: 0.1, surface: 'metal', hold: true, model: 'assets/models/props/newsstand.glb', draw: 35000 },
    planter: { shape: 0, hx: 90, hy: 40, hz: 50, mass: 900, brk: 0, mu: 0.6, e: 0.08, surface: 'concrete', hold: false, model: 'assets/models/props/planter.glb', draw: 35000 },
    street_tree: { shape: 1, r: 14, hy: 325, mass: 260, brk: 560000, mu: 0.4, e: 0.1, surface: 'wood', hold: true, model: 'assets/models/props/street_tree.glb', draw: 62000 },
    parking_meter: { shape: 1, r: 8, hy: 71, mass: 28, brk: 200000, mu: 0.4, e: 0.1, surface: 'metal', hold: true, model: 'assets/models/props/parking_meter.glb', draw: 28000 },
    dumpster: { shape: 0, hx: 100, hy: 70, hz: 65, mass: 520, brk: 0, mu: 0.5, e: 0.15, surface: 'metal', hold: false, model: 'assets/models/props/dumpster.glb', draw: 40000 },
    traffic_barrel: { shape: 1, r: 30, hy: 53, mass: 22, brk: 0, mu: 0.5, e: 0.3, surface: 'plastic', hold: false, model: 'assets/models/props/traffic_barrel.glb', draw: 35000 },
    crosswalk_sign: { shape: 1, r: 5, hy: 137, mass: 16, brk: 320000, mu: 0.3, e: 0.1, surface: 'metal', hold: true, model: 'assets/models/props/crosswalk_sign.glb', draw: 40000 },
    awning_stand: { shape: 0, hx: 150, hy: 126, hz: 60, mass: 130, brk: 300000, mu: 0.4, e: 0.1, surface: 'wood', hold: true, model: 'assets/models/props/awning_stand.glb', draw: 40000 },
    dummy_stand: { shape: 1, r: 32, hy: 93, mass: 82, brk: 0, mu: 0.5, e: 0.2, surface: 'plastic', hold: false, model: 'assets/models/props/dummy_stand.glb', draw: 35000 },
    flag_pole: { shape: 1, r: 8, hy: 550, mass: 70, brk: 420000, mu: 0.3, e: 0.1, surface: 'metal', hold: true, model: 'assets/models/props/flag_pole.glb', draw: 70000 },
    crushed_cube: { shape: 0, hx: 75, hy: 75, hz: 75, mass: 1350, brk: 0, mu: 0.6, e: 0.08, surface: 'metal', hold: false, model: 'assets/models/props/crushed_cube.glb', draw: 40000 },
    palm_small: { shape: 1, r: 14, hy: 180, mass: 90, brk: 520000, mu: 0.4, e: 0.1, surface: 'wood', hold: true, model: 'assets/models/props/palm_small.glb', draw: 60000 },
    cactus: { shape: 1, r: 13, hy: 206, mass: 120, brk: 420000, mu: 0.4, e: 0.1, surface: 'wood', hold: true, model: 'assets/models/props/cactus_a.glb', draw: 60000 },
};

/** Процедурные модели типов (origin — центр основания, y вверх; px). */
const PROP_MESHES = {
    guardrail(g) {
        const zinc = [0.74, 0.76, 0.78, 1], dark = [0.45, 0.47, 0.5, 1], post = [0.55, 0.57, 0.6, 1];
        g.box(200, 46, 76, 5, zinc, zinc);                         // лента
        g.box(200, 52, 58, 8.5, zinc, zinc); g.box(200, 64, 70, 8.5, zinc, zinc);   // гофры
        for (const x of [-170, 0, 170]) { g.box(4, 0, 74, 4, post, post); g.box(3, 50, 70, 9, dark, dark); }
    },
    jersey(g) {
        const c = [0.66, 0.65, 0.62, 1], c2 = [0.58, 0.57, 0.55, 1];
        const prof = [[-30, 0], [30, 0], [30, 12], [21, 36], [10, 82], [-10, 82], [-21, 36], [-30, 12]];
        // экструзия профиля (z, y) вдоль x
        for (let i = 0; i < prof.length; i++) {
            const a = prof[i], b = prof[(i + 1) % prof.length];
            const nz = b[1] - a[1], ny = -(b[0] - a[0]), l = Math.hypot(nz, ny) || 1;
            const n = [0, ny / l, nz / l];
            g.poly([[-300, a[1], a[0]], [300, a[1], a[0]], [300, b[1], b[0]], [-300, b[1], b[0]]], n, i % 2 ? c2 : c);
        }
        g.poly(prof.map(p => [300, p[1], p[0]]), [1, 0, 0], c2); g.poly(prof.map(p => [-300, p[1], p[0]]).reverse(), [-1, 0, 0], c2);
    },
    block(g) { const c = [0.62, 0.61, 0.58, 1]; g.box(50, 0, 100, 50, c, [0.68, 0.67, 0.64, 1]); },
    crate(g) { const c = [0.55, 0.38, 0.2, 1]; g.box(40, 0, 80, 40, c, [0.6, 0.43, 0.24, 1]); g.box(41, 0, 8, 41, [0.4, 0.27, 0.14, 1]); g.box(41, 72, 80, 41, [0.4, 0.27, 0.14, 1]); },
    cone(g) {
        g.box(24, 0, 3, 24, [0.12, 0.12, 0.12, 1]);
        g.cyl(0, 0, 14, 8, 3, 38, 10, [0.95, 0.4, 0.08, 1], [0.95, 0.4, 0.08, 1], false, false);
        g.cyl(0, 0, 9.5, 6, 38, 52, 10, [0.96, 0.96, 0.94, 1], [0.96, 0.96, 0.94, 1], false, false);
        g.cyl(0, 0, 6, 2.5, 52, 70, 10, [0.95, 0.4, 0.08, 1], [0.95, 0.4, 0.08, 1], true, false);
    },
    barrel(g) {
        const c = [0.2, 0.36, 0.72, 1], ring = [0.14, 0.24, 0.5, 1];
        g.cyl(0, 0, 29, 29, 0, 90, 14, c, c, true, true);
        for (const y of [18, 46, 72]) g.cyl(0, 0, 30.2, 30.2, y, y + 5, 14, ring, ring, false, false);
    },
    tires(g) { const c = [0.07, 0.07, 0.075, 1], c2 = [0.12, 0.12, 0.125, 1]; for (let i = 0; i < 3; i++) { g.cyl(0, 0, 36, 33, i * 26, i * 26 + 26, 12, i % 2 ? c2 : c, c, i === 2, i === 0); } },
    lamp(g) {
        const pole = [0.62, 0.64, 0.66, 1], head = [0.82, 0.82, 0.76, 1];
        g.cyl(0, 0, 14, 14, 0, 30, 8, pole, pole, true, true);
        g.cyl(0, 0, 9, 5.5, 0, 800, 8, pole, pole, false, false);
        g.setTransform([120, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]);   // консоль — вдоль +x тела, к дороге
        g.box(120, 796, 806, 4, pole, pole);
        g.box(34, 786, 796, 13, head, [0.96, 0.95, 0.85, 1]);
        g.setTransform();
    },
    sign(g) {
        g.cyl(0, 0, 4.5, 4.5, 0, 270, 6, [0.6, 0.62, 0.64, 1], [0.6, 0.62, 0.64, 1], true, true);
        g.box(32, 200, 270, 2, [0.9, 0.9, 0.9, 1], [0.9, 0.9, 0.9, 1]);
        g.box(26, 205, 265, 2.6, [0.78, 0.12, 0.1, 1], [0.78, 0.12, 0.1, 1]);
    },
    bollard(g) {
        g.cyl(0, 0, 10, 10, 0, 90, 8, [0.92, 0.92, 0.9, 1], [0.92, 0.92, 0.9, 1], true, true);
        g.cyl(0, 0, 10.4, 10.4, 50, 68, 8, [0.8, 0.12, 0.1, 1], [0.8, 0.12, 0.1, 1], false, false);
    },
};

/** @satisfies {Record<string, any>} */
const Props = {
    /** @type {any} */ view: null,
    /** @type {any[]} */ list: [],
    /** @type {any[]} */ active: [],
    /** @type {Map<number, any[]>} */ grid: new Map(),
    /** @type {Map<string, any>} */ batches: new Map(),
    /** @type {Record<string, any>} */ srcMeshes: {},
    /** @type {any} */ mat: null,
    /** Шаблоны моделей из файлов по типу: { root, parts }. */
    /** @type {Record<string, any>} */ models: {},
    /** Промис: модели из PROP_TYPES[…].model загружены и пачки их типов переведены на них (Track.build ждёт его). */
    /** @type {Promise<void>} */ ready: Promise.resolve(),
    time: 0,
    frame: 0,
    broken: 0,
    /** Скретч: общий результат contact, если res не передан. */
    /** @type {any} */ _res: { nx: 0, ny: 1, nz: 0, depth: 0, jn: 0, jx: 0, jy: 0, jz: 0, px: 0, py: 0, pz: 0, surface: '' },
    _tmp: [0, 0, 0],
    _w: [0, 0, 0],
    _g: { h: 0, nx: 0, ny: 1, nz: 0 },
    /** @type {any[]} */ _near: [],

    cfg() {
        const U = 'undefined';
        return { gravity: typeof CAR_GRAVITY !== U ? CAR_GRAVITY : 981 };
    },

    // ---------------------------------------------------------------------------------------------
    // Постройка
    // ---------------------------------------------------------------------------------------------

    /** Предметы карты: правила дорог (rail, lamp) и объекты prop / scatter. view — View3D для отрисовки (без него — только логика). */
    build(map, view) {
        this.clear();
        const gw = GameWorld;
        if (map && gw.map !== map) gw.buildData(map);
        this.view = view || (gw.view && gw.view.view) || null;
        for (const R of gw.roads) this._road(R);
        for (const d of (map && map.objects) || []) {
            if (!d || d.kind !== 'marker') continue;
            const name = worldCleanName(d.name), words = name.split(/\s+/);
            if (words[0] !== 'prop' && words[0] !== 'scatter') continue;
            const prm = worldParams(name), id = words[1] && !/=/.test(words[1]) ? words[1] : 'block';
            const type = PROP_TYPES[id] ? id : 'block';
            if (!PROP_TYPES[id]) console.warn('Props: нет типа «' + id + '» (' + name + '), поставлен block');
            const rot = Array.isArray(d.rot) ? d.rot : [0, Number(d.rot) || 0, 0];
            const yaw = (Number(rot[1]) || 0) * Math.PI / 180;
            const cx = Number(d.x) || 0, cz = Number(d.y) || 0, hOff = Number(d.h) || 0, abs = prm.abs === 1;
            if (words[0] === 'prop') this._placeAt(type, cx, cz, yaw, hOff, abs);
            else this._scatter(type, cx, cz, prm.r > 0 ? prm.r : 900, prm.n > 0 ? Math.min(400, Math.round(prm.n)) : 20, Number.isFinite(prm.seed) ? prm.seed : 1, hOff, abs);
        }
        this._batches();
        this.ready = this._loadModels();
        return this;
    },

    clear() {
        for (const b of this.batches.values()) for (const m of b.meshes) { try { if (this.view) this.view.removeShadowCaster(m); m.dispose(false, false); } catch (e) { /* ok */ } }
        this.batches = new Map();
        for (const k in this.models) { try { this.models[k].root.dispose(false, true); } catch (e) { /* ok */ } }
        this.models = {};
        this.ready = Promise.resolve();
        for (const k in this.srcMeshes) { try { this.srcMeshes[k].dispose(false, false); } catch (e) { /* ok */ } }
        this.srcMeshes = {};
        if (this.mat) { try { this.mat.dispose(false, false); } catch (e) { /* ok */ } this.mat = null; }
        this.list = []; this.active = []; this.grid = new Map();
        this.time = 0; this.broken = 0;
    },

    /** Новый заезд: предметы на исходных местах, сломанные восстановлены. */
    reset() {
        for (const p of this.list) {
            p.x = p.x0; p.y = p.y0; p.z = p.z0;
            for (let i = 0; i < 9; i++) p.R[i] = p.R0[i];
            p.vx = p.vy = p.vz = p.wx = p.wy = p.wz = 0;
            p.state = p.hold0 ? 0 : 2; p.hold = p.hold0; p.invM = p.hold0 ? 0 : p.invM1; p.sleepT = 0; p.acc = 0;
            this._bucket(p);
            this._write(p);
            if (p.batch) p.batch.dirty = true;
        }
        this.active = [];
        this.broken = 0;
    },

    // --- создание ---

    /** Предмет по типу в точке: base — точка на поверхности, ось y тела — вверх по up (или нормаль земли). */
    _spawn(type, bx, by, bz, ax, ay, az) {
        const T = PROP_TYPES[type];
        const hy = T.hy;
        const p = /** @type {any} */ ({
            id: this.list.length, type, T, shape: T.shape, hx: T.hx || T.r, hy, hz: T.hz || T.r, r: T.r || 0,
            x: bx + ay[0] * hy, y: by + ay[1] * hy, z: bz + ay[2] * hy,
            R: new Float64Array([ax[0], ax[1], ax[2], ay[0], ay[1], ay[2], az[0], az[1], az[2]]),
            vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0,
            mass: T.mass, brk: T.brk, mu: T.mu, e: T.e, surface: T.surface,
            hold: !!T.hold, hold0: !!T.hold, state: T.hold ? 0 : 2, sleepT: 0, acc: 0, accT: -9,
            invM: T.hold ? 0 : 1 / T.mass, invM1: 1 / T.mass, i0: 0, i1: 0, i2: 0,
            rad: Math.hypot(T.hx || T.r, hy, T.hz || T.r),
            batch: null, slot: -1, cell: 0, deck: false,
        });
        p.R0 = new Float64Array(p.R);
        p.x0 = p.x; p.y0 = p.y; p.z0 = p.z;
        // обратная инерция по локальным осям (кг⁻¹·px⁻²)
        const m = T.mass;
        if (T.shape === 0) { p.i0 = 1 / (m / 3 * (hy * hy + p.hz * p.hz)); p.i1 = 1 / (m / 3 * (p.hx * p.hx + p.hz * p.hz)); p.i2 = 1 / (m / 3 * (p.hx * p.hx + hy * hy)); }
        else {   // тонкий столб вращается вокруг оси как тело не тоньше PROPS_MIN_R: иначе точки обода дают бешеную закрутку
            const ri = Math.max(p.r, PROPS_MIN_R);
            p.i1 = 1 / (m * ri * ri / 2); p.i0 = p.i2 = 1 / (m * (ri * ri / 4 + hy * hy / 3));
        }
        this.list.push(p);
        this._bucket(p);
        return p;
    },

    /** Оси тела: курс yaw на поверхности с нормалью n. */
    _axes(yaw, n) {
        const fx = Math.cos(yaw), fz = Math.sin(yaw);
        const d = fx * n[0] + fz * n[2];
        let ax = [fx - n[0] * d, -n[1] * d, fz - n[2] * d];
        const l = Math.hypot(ax[0], ax[1], ax[2]) || 1; ax = [ax[0] / l, ax[1] / l, ax[2] / l];
        const az = [ax[1] * n[2] - ax[2] * n[1], ax[2] * n[0] - ax[0] * n[2], ax[0] * n[1] - ax[1] * n[0]];
        return { ax, ay: n.slice(), az };
    },

    _surfY(x, z) { return GameWorld.heightAt(x, z); },

    _placeAt(type, x, z, yaw, hOff, abs) {
        const n = abs || PROP_TYPES[type].hy > PROPS_UPRIGHT_HY ? [0, 1, 0] : GameWorld.normalAt(x, z, [0, 1, 0]);   // abs=1 — на мосту: склон под ним ни при чём
        const base = abs ? hOff : this._surfY(x, z) + hOff;
        const A = this._axes(yaw, n);
        const p = this._spawn(type, x, base, z, A.ax, A.ay, A.az);
        if (abs || hOff > 30) p.deck = true;
        return p;
    },

    _scatter(type, cx, cz, r, n, seed, hOff, abs) {
        const T = PROP_TYPES[type], placed = [];
        const mind = (T.r || Math.max(T.hx, T.hz)) * 2.2;
        const sd = Math.round(cx * 0.37 + cz * 0.71) + seed * 131;
        for (let k = 0; k < n; k++) {
            for (let tries = 0; tries < 12; tries++) {
                const a = worldHash(k, tries, sd) * Math.PI * 2, rr = r * Math.sqrt(worldHash(k, tries + 40, sd + 1));
                const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
                if (placed.some(q => Math.hypot(q[0] - x, q[1] - z) < mind)) continue;
                placed.push([x, z]);
                this._placeAt(type, x, z, worldHash(k, tries, sd + 2) * Math.PI * 2, hOff, abs);
                break;
            }
        }
    },

    /** Правила дороги: отбойник вдоль кромки и фонари. */
    _road(R) {
        const gw = GameWorld, f = gw.roadFrame(R, 0, { x: 0, y: 0, z: 0, tx: 1, tz: 0, rx: 0, rz: 1, tb: 0, hw: 0, sh: 0, slope: 0, i: 0, t: 0 });
        const mk = (type, arc, side, off, lampYaw) => {
            gw.roadFrame(R, arc, f);
            const i = Math.min(R.n - 2, f.i);
            const l = side * (f.hw + off);
            const x = f.x + f.rx * l, z = f.z + f.rz * l;
            const y = R.BRIDGE[i] ? f.y - f.tb * l : gw.heightAt(x, z);
            // оси: вдоль дороги с уклоном, вверх — перпендикулярно ей
            const fw = [f.tx, f.slope, f.tz], fl = Math.hypot(fw[0], fw[1], fw[2]);
            const ax = [fw[0] / fl, fw[1] / fl, fw[2] / fl];
            const rt = [f.rx, 0, f.rz];
            let ay = [rt[1] * ax[2] - rt[2] * ax[1], rt[2] * ax[0] - rt[0] * ax[2], rt[0] * ax[1] - rt[1] * ax[0]];
            const al = Math.hypot(ay[0], ay[1], ay[2]) || 1; ay = [ay[0] / al, ay[1] / al, ay[2] / al];
            const az = [ax[1] * ay[2] - ax[2] * ay[1], ax[2] * ay[0] - ax[0] * ay[2], ax[0] * ay[1] - ax[1] * ay[0]];
            if (lampYaw) {   // фонарь стоит вертикально, консоль — к дороге
                const p = this._spawn(type, x, y, z, [1, 0, 0], [0, 1, 0], [0, 0, 1]);
                const yaw = Math.atan2(-side * f.rz, -side * f.rx);
                this._turn(p, yaw);
                return p;
            }
            // лицо секции (локальная +z) — к дороге: правый отбойник развёрнут на 180°
            const p = side > 0 ? this._spawn(type, x, y, z, [-ax[0], -ax[1], -ax[2]], ay, [-az[0], -az[1], -az[2]]) : this._spawn(type, x, y, z, ax, ay, az);
            if (R.BRIDGE[i]) p.deck = true;
            return p;
        };
        // отбойник
        let hasRail = false;
        for (let s = 0; s < R.n; s++) if (R.RAIL[s]) { hasRail = true; break; }
        if (hasRail) for (let a = PROPS_RAIL_STEP / 2; a < R.length; a += PROPS_RAIL_STEP) {
            gw.roadFrame(R, a, f);
            const i = Math.min(R.n - 2, f.i);
            if (R.JN[i] || R.TUNNEL[i]) continue;
            const m = R.RAIL[i];
            if (!m) continue;
            const off = R.BRIDGE[i] ? R.SH[i] - 40 : R.SH[i] > 0 ? PROPS_RAIL_OFF : 40;
            if (m & 1) mk('guardrail', a, -1, off);
            if (m & 2) mk('guardrail', a, 1, off);
        }
        // фонари
        let hasLamp = false;
        for (let s = 0; s < R.n; s++) if (R.LAMP[s]) { hasLamp = true; break; }
        if (hasLamp) {
            let k = 0;
            for (let a = PROPS_LAMP_STEP / 2; a < R.length; a += PROPS_LAMP_STEP, k++) {
                gw.roadFrame(R, a, f);
                const i = Math.min(R.n - 2, f.i);
                const mode = R.LAMP[i];
                if (!mode || R.JN[i]) continue;
                const off = R.BRIDGE[i] ? R.SH[i] - 30 : R.SH[i] + 90;
                if (mode === 2) { mk('lamp', a, -1, off, true); mk('lamp', a, 1, off, true); }
                else mk('lamp', a, k & 1 ? -1 : 1, off, true);
            }
        }
    },

    /** Повернуть тело вокруг вертикали на yaw от исходных осей. */
    _turn(p, yaw) {
        const c = Math.cos(yaw), s = Math.sin(yaw), R = p.R;
        // ax = (c, 0, s), ay = (0, 1, 0), az = (−s, 0, c): ось x тела — по yaw
        R[0] = c; R[1] = 0; R[2] = s; R[3] = 0; R[4] = 1; R[5] = 0; R[6] = -s; R[7] = 0; R[8] = c;
        for (let i = 0; i < 9; i++) p.R0[i] = R[i];
    },

    // ---------------------------------------------------------------------------------------------
    // Индекс
    // ---------------------------------------------------------------------------------------------

    _bucket(p) {
        const key = Math.floor(p.x / PROPS_CELL) * 100003 + Math.floor(p.z / PROPS_CELL);
        if (p.cell === key && p.inGrid) return;
        if (p.inGrid) {
            const old = this.grid.get(p.cell);
            if (old) { const i = old.indexOf(p); if (i >= 0) { old[i] = old[old.length - 1]; old.pop(); } }
        }
        let l = this.grid.get(key);
        if (!l) { l = []; this.grid.set(key, l); }
        l.push(p);
        p.cell = key; p.inGrid = true;
    },

    /** Предметы в AABB (мир Babylon: y вверх) → out; в конец добавляются стволы и камни биома. out очищается. */
    near(x0, y0, z0, x1, y1, z1, out) {
        out.length = 0;
        const C = PROPS_CELL, m = PROPS_MAXR;
        const i0 = Math.floor((x0 - m) / C), i1 = Math.floor((x1 + m) / C), j0 = Math.floor((z0 - m) / C), j1 = Math.floor((z1 + m) / C);
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
            const l = this.grid.get(i * 100003 + j);
            if (!l) continue;
            for (let k = 0; k < l.length; k++) {
                const p = l[k], r = p.rad;
                if (p.state === 3 || p.x + r < x0 || p.x - r > x1 || p.z + r < z0 || p.z - r > z1 || p.y + r < y0 || p.y - r > y1) continue;
                out.push(p);
            }
        }
        if (GameWorld.active && GameWorld.biome !== 'proving') GameWorld.decorNear(x0, z0, x1, z1, out);
        return out;
    },

    // ---------------------------------------------------------------------------------------------
    // Контакт: сфера (точка машины) против предмета
    // ---------------------------------------------------------------------------------------------

    /**
     * Точка-сфера (x, y, z, r) со скоростью v и обратной массой invM (по нормали контакта) против предмета. false — нет касания.
     * Иначе true и в res: нормаль наружу (nx, ny, nz — от предмета к точке), depth, jn, jx, jy, jz (импульс точке), px, py, pz, surface.
     * Предмету импульс применён: он проснулся, получил скорость и вращение; набрав порог brk, неподвижный ломается.
     * @param {any} p @param {number} x @param {number} y @param {number} z @param {number} r
     * @param {number} vx @param {number} vy @param {number} vz @param {number} invM @param {any} [res]
     */
    contact(p, x, y, z, r, vx, vy, vz, invM, res) {
        const o = res || this._res;
        const rr = p.rad + r;
        let dx = x - p.x, dy = y - p.y, dz = z - p.z;
        if (p.state === 3) return false;
        let qx, qy, qz, nx, ny, nz, depth;   // qx..qz — ближайшая точка предмета (мир), nx..nz — нормаль (мир)
        if (p.shape === 2) {
            // ствол: вертикальный цилиндр от y до y + h
            const cy = Math.max(p.y, Math.min(p.y + p.h, y));
            const hd = Math.hypot(dx, dz), k = hd > p.r ? p.r / hd : 1;
            qx = p.x + dx * k; qz = p.z + dz * k; qy = cy;
            const fx = x - qx, fy = y - qy, fz = z - qz, d2 = fx * fx + fy * fy + fz * fz;
            if (d2 >= r * r) return false;
            const d = Math.sqrt(d2);
            if (d > 1e-6) { nx = fx / d; ny = fy / d; nz = fz / d; depth = r - d; }
            else { const l = hd || 1; nx = dx / l; ny = 0; nz = dz / l; depth = r + p.r - hd; }
        } else {
            if (dx * dx + dy * dy + dz * dz > rr * rr) return false;
            const A = p.R;
            const lx = dx * A[0] + dy * A[1] + dz * A[2], ly = dx * A[3] + dy * A[4] + dz * A[5], lz = dx * A[6] + dy * A[7] + dz * A[8];
            let cx, cy, cz, nlx, nly, nlz;
            if (p.shape === 0) {
                cx = Math.max(-p.hx, Math.min(p.hx, lx)); cy = Math.max(-p.hy, Math.min(p.hy, ly)); cz = Math.max(-p.hz, Math.min(p.hz, lz));
            } else {
                const hd = Math.hypot(lx, lz), k = hd > p.r ? p.r / hd : 1;
                cx = lx * k; cz = lz * k; cy = Math.max(-p.hy, Math.min(p.hy, ly));
            }
            const ex = lx - cx, ey = ly - cy, ez = lz - cz, d2 = ex * ex + ey * ey + ez * ez;
            if (d2 > 1e-9) {
                if (d2 >= r * r) return false;
                const d = Math.sqrt(d2);
                nlx = ex / d; nly = ey / d; nlz = ez / d; depth = r - d;
            } else {
                // центр внутри: выходим через ближайшую грань
                if (p.shape === 0) {
                    const px = p.hx - Math.abs(lx), py = p.hy - Math.abs(ly), pz = p.hz - Math.abs(lz);
                    if (px <= py && px <= pz) { nlx = lx >= 0 ? 1 : -1; nly = 0; nlz = 0; depth = px + r; cx = nlx * p.hx; cy = ly; cz = lz; }
                    else if (py <= pz) { nlx = 0; nly = ly >= 0 ? 1 : -1; nlz = 0; depth = py + r; cx = lx; cy = nly * p.hy; cz = lz; }
                    else { nlx = 0; nly = 0; nlz = lz >= 0 ? 1 : -1; depth = pz + r; cx = lx; cy = ly; cz = nlz * p.hz; }
                } else {
                    const hd = Math.hypot(lx, lz), pr = p.r - hd, py = p.hy - Math.abs(ly);
                    if (pr <= py) { const l = hd || 1; nlx = lx / l; nly = 0; nlz = lz / l; depth = pr + r; cx = nlx * p.r; cy = ly; cz = nlz * p.r; }
                    else { nlx = 0; nly = ly >= 0 ? 1 : -1; nlz = 0; depth = py + r; cx = lx; cy = nly * p.hy; cz = lz; }
                }
            }
            nx = nlx * A[0] + nly * A[3] + nlz * A[6]; ny = nlx * A[1] + nly * A[4] + nlz * A[7]; nz = nlx * A[2] + nly * A[5] + nlz * A[8];
            qx = p.x + cx * A[0] + cy * A[3] + cz * A[6]; qy = p.y + cx * A[1] + cy * A[4] + cz * A[7]; qz = p.z + cx * A[2] + cy * A[5] + cz * A[8];
        }
        o.nx = nx; o.ny = ny; o.nz = nz; o.depth = depth; o.px = qx; o.py = qy; o.pz = qz; o.surface = p.surface;
        o.jn = 0; o.jx = 0; o.jy = 0; o.jz = 0;
        // скорость предмета в точке касания
        const rx = qx - p.x, ry = qy - p.y, rz = qz - p.z;
        const mov = p.invM > 0;
        const pvx = mov ? p.vx + p.wy * rz - p.wz * ry : 0, pvy = mov ? p.vy + p.wz * rx - p.wx * rz : 0, pvz = mov ? p.vz + p.wx * ry - p.wy * rx : 0;
        const rvx = vx - pvx, rvy = vy - pvy, rvz = vz - pvz;
        const vn = rvx * nx + rvy * ny + rvz * nz;
        if (p.state === 2) this._wake(p);
        if (vn >= 0) return true;   // расходятся: касание есть, импульса нет
        // импульс удара; неподвижный предмет с порогом слома: набрав его, срывается, и импульс считается заново — уже по его массе
        let jm = this._solve(p, rx, ry, rz, nx, ny, nz, rvx, rvy, rvz, vn, invM, o);
        if (p.brk > 0 && p.hold) {
            if (this.time - p.accT > PROPS_BREAK_WINDOW) p.acc = 0;
            p.accT = this.time; p.acc += jm;
            if (p.acc >= p.brk) { this._release(p, true); jm = this._solve(p, rx, ry, rz, nx, ny, nz, rvx, rvy, rvz, vn, invM, o); }
        }
        const jx = o.jx, jy = o.jy, jz = o.jz;
        const W = this._w;
        if (p.invM > 0) {
            p.vx -= jx * p.invM; p.vy -= jy * p.invM; p.vz -= jz * p.invM;
            // момент r × J
            const mx = ry * -jz - rz * -jy, my = rz * -jx - rx * -jz, mz = rx * -jy - ry * -jx;
            this._applyInvI(p, mx, my, mz, W);
            p.wx += W[0]; p.wy += W[1]; p.wz += W[2];
            // сдвиг предмета из проникновения: доля по массам
            const share = p.invM / (p.invM + invM);
            p.x -= nx * depth * share; p.y -= ny * depth * share; p.z -= nz * depth * share;
            if (p.batch) p.batch.dirty = true;
            p.sleepT = 0;
        }
        return true;
    },

    /** Импульс точке при ударе о предмет: по нормали (с отскоком e) и трение Кулона; пишет o.jn, o.jx, o.jy, o.jz; → длина импульса. */
    _solve(p, rx, ry, rz, nx, ny, nz, rvx, rvy, rvz, vn, invM, o) {
        const kn = invM + p.invM + this._invIK(p, rx, ry, rz, nx, ny, nz);
        const jn = -(1 + p.e) * vn / (kn || 1e-9);
        let tx = rvx - vn * nx, ty = rvy - vn * ny, tz = rvz - vn * nz;
        const tl = Math.hypot(tx, ty, tz);
        let jx = jn * nx, jy = jn * ny, jz = jn * nz;
        if (tl > 1e-6) {
            tx /= tl; ty /= tl; tz /= tl;
            const kt = invM + p.invM + this._invIK(p, rx, ry, rz, tx, ty, tz);
            const jt = Math.min(tl / (kt || 1e-9), p.mu * jn);
            jx -= tx * jt; jy -= ty * jt; jz -= tz * jt;
        }
        o.jn = jn; o.jx = jx; o.jy = jy; o.jz = jz;
        return Math.hypot(jx, jy, jz);
    },

    /** n·((I⁻¹(r × n)) × r): вклад вращения в эффективную обратную массу. */
    _invIK(p, rx, ry, rz, nx, ny, nz) {
        if (p.invM === 0) return 0;
        const cx = ry * nz - rz * ny, cy = rz * nx - rx * nz, cz = rx * ny - ry * nx;
        const W = this._w;
        this._applyInvI(p, cx, cy, cz, W);
        const ex = W[1] * rz - W[2] * ry, ey = W[2] * rx - W[0] * rz, ez = W[0] * ry - W[1] * rx;
        return nx * ex + ny * ey + nz * ez;
    },

    /** out = I⁻¹·u в мировых осях: локальные оси тела диагональные. */
    _applyInvI(p, ux, uy, uz, out) {
        const A = p.R;
        const a = (ux * A[0] + uy * A[1] + uz * A[2]) * p.i0, b = (ux * A[3] + uy * A[4] + uz * A[5]) * p.i1, c = (ux * A[6] + uy * A[7] + uz * A[8]) * p.i2;
        out[0] = a * A[0] + b * A[3] + c * A[6]; out[1] = a * A[1] + b * A[4] + c * A[7]; out[2] = a * A[2] + b * A[5] + c * A[8];
        return out;
    },

    _wake(p) {
        if (p.state === 2) { p.state = 1; p.sleepT = 0; if (this.active.indexOf(p) < 0) this.active.push(p); }
        else if (p.state === 0 && !p.hold) { p.state = 1; p.sleepT = 0; this.active.push(p); }
    },

    /** Сломанный или сорванный предмет становится телом: масса, инерция, движение. */
    _release(p, broke) {
        if (!p.hold) return;
        p.hold = false; p.invM = p.invM1;
        p.state = 1; p.sleepT = 0;
        if (this.active.indexOf(p) < 0) this.active.push(p);
        if (broke) this.broken++;
    },

    // ---------------------------------------------------------------------------------------------
    // Шаг тел
    // ---------------------------------------------------------------------------------------------

    /** Земля под предметом: рельеф (и детали ObbyCourse под мостом, если предмет на помосте). → общая запись _g */
    _ground(p, x, z, y) {
        const g = this._g;
        g.h = GameWorld.heightAt(x, z);
        const n = GameWorld.normalAt(x, z);
        g.nx = n[0]; g.ny = n[1]; g.nz = n[2];
        if (p.deck && typeof ObbyCourse !== 'undefined' && ObbyCourse.pieces.length) {
            const h = ObbyCourse.groundAt(x, z, y + 120, 400);
            if (h != null && h > g.h) { g.h = h; g.nx = 0; g.ny = 1; g.nz = 0; }
        }
        return g;
    },

    /** Шаг всех подвижных предметов; спящие не считаются. */
    update(dt) {
        dt = Math.min(0.1, Math.max(0, dt || 0));
        this.time += dt;
        if (!this.active.length) return;
        const n = Math.max(1, Math.ceil(dt / PROPS_STEP)), h = dt / n;
        for (let s = 0; s < n; s++) for (let i = this.active.length - 1; i >= 0; i--) this._step(this.active[i], h, i);
    },

    _step(p, dt, idx) {
        const gr = this.cfg().gravity;
        if (p.state !== 1) return;
        p.vy -= gr * dt;
        const R = p.R, A = R;
        const hx = p.shape === 0 ? p.hx : p.r, hy = p.hy, hz = p.shape === 0 ? p.hz : p.r;
        let touch = false, maxPen = 0, mx = 0, my = 0, mz = 0;
        // 8 точек контакта с землёй: углы бруса; у цилиндра — по четыре на обоих торцах (кромка)
        for (let k = 0; k < 8; k++) {
            let lx, ly, lz;
            if (p.shape === 0) { lx = (k & 1 ? hx : -hx); ly = (k & 2 ? hy : -hy); lz = (k & 4 ? hz : -hz); }
            else { const a = (k & 3) * Math.PI / 2 + Math.PI / 4; lx = Math.cos(a) * hx; lz = Math.sin(a) * hx; ly = k & 4 ? hy : -hy; }
            const rx = lx * A[0] + ly * A[3] + lz * A[6], ry = lx * A[1] + ly * A[4] + lz * A[7], rz = lx * A[2] + ly * A[5] + lz * A[8];
            const wx = p.x + rx, wy = p.y + ry, wz = p.z + rz;
            const g = this._ground(p, wx, wz, wy);
            const pen = g.h - wy;
            if (pen <= 0) continue;
            touch = true;
            if (pen > maxPen) { maxPen = pen; mx = g.nx; my = g.ny; mz = g.nz; }
            const nx = g.nx, ny = g.ny, nz = g.nz;
            const pvx = p.vx + p.wy * rz - p.wz * ry, pvy = p.vy + p.wz * rx - p.wx * rz, pvz = p.vz + p.wx * ry - p.wy * rx;
            const vn = pvx * nx + pvy * ny + pvz * nz;
            if (vn < 0) {
                const kn = p.invM + this._invIK(p, rx, ry, rz, nx, ny, nz);
                const e = vn < -250 ? p.e : 0;
                const jn = -(1 + e) * vn / (kn || 1e-9);
                let tx = pvx - vn * nx, ty = pvy - vn * ny, tz = pvz - vn * nz;
                const tl = Math.hypot(tx, ty, tz);
                let jx = jn * nx, jy = jn * ny, jz = jn * nz;
                if (tl > 1e-6) {
                    tx /= tl; ty /= tl; tz /= tl;
                    const kt = p.invM + this._invIK(p, rx, ry, rz, tx, ty, tz);
                    const jt = Math.min(tl / (kt || 1e-9), p.mu * 0.85 * jn);
                    jx -= tx * jt; jy -= ty * jt; jz -= tz * jt;
                }
                p.vx += jx * p.invM; p.vy += jy * p.invM; p.vz += jz * p.invM;
                const W = this._w;
                this._applyInvI(p, ry * jz - rz * jy, rz * jx - rx * jz, rx * jy - ry * jx, W);
                p.wx += W[0]; p.wy += W[1]; p.wz += W[2];
            }
        }
        if (touch) {
            // выдавить из земли и погасить дрожь
            const push = Math.min(maxPen, 40) * 0.5;
            p.x += mx * push; p.y += my * push; p.z += mz * push;
            const damp = Math.exp(-dt * 2.4), lin = Math.exp(-dt * 0.55);
            p.wx *= damp; p.wy *= damp; p.wz *= damp;
            p.vx *= lin; p.vz *= lin;
        }
        // пределы скоростей: удар по лёгкому предмету не должен разгонять его до взрыва
        const wl = Math.hypot(p.wx, p.wy, p.wz);
        if (wl > PROPS_MAX_W) { const k = PROPS_MAX_W / wl; p.wx *= k; p.wy *= k; p.wz *= k; }
        const vl = Math.hypot(p.vx, p.vy, p.vz);
        if (vl > PROPS_MAX_V) { const k = PROPS_MAX_V / vl; p.vx *= k; p.vy *= k; p.vz *= k; }
        // интеграция
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        // оси += (w × ось)·dt, затем ортонормировка
        const wx = p.wx * dt, wy = p.wy * dt, wz = p.wz * dt;
        if (wx !== 0 || wy !== 0 || wz !== 0) {
            for (let a = 0; a < 3; a++) {
                const o = a * 3, ax = R[o], ay = R[o + 1], az = R[o + 2];
                R[o] = ax + (wy * az - wz * ay); R[o + 1] = ay + (wz * ax - wx * az); R[o + 2] = az + (wx * ay - wy * ax);
            }
            let l = Math.hypot(R[0], R[1], R[2]) || 1; R[0] /= l; R[1] /= l; R[2] /= l;
            let d = R[3] * R[0] + R[4] * R[1] + R[5] * R[2];
            R[3] -= d * R[0]; R[4] -= d * R[1]; R[5] -= d * R[2];
            l = Math.hypot(R[3], R[4], R[5]) || 1; R[3] /= l; R[4] /= l; R[5] /= l;
            R[6] = R[1] * R[5] - R[2] * R[4]; R[7] = R[2] * R[3] - R[0] * R[5]; R[8] = R[0] * R[4] - R[1] * R[3];
        }
        this._bucket(p);
        if (p.batch) p.batch.dirty = true;
        // сон: тело касается земли и почти стоит
        const sp = p.vx * p.vx + p.vy * p.vy + p.vz * p.vz, sw = p.wx * p.wx + p.wy * p.wy + p.wz * p.wz;
        if (touch && sp < PROPS_SLEEP_V * PROPS_SLEEP_V && sw < PROPS_SLEEP_W * PROPS_SLEEP_W) {
            p.sleepT += dt;
            if (p.sleepT > PROPS_SLEEP_T) {
                p.state = 2; p.vx = p.vy = p.vz = p.wx = p.wy = p.wz = 0;
                const j = this.active.indexOf(p); if (j >= 0) this.active.splice(j, 1);
                if (p.batch) p.batch.stale = true;
            }
        } else p.sleepT = 0;
        void idx;
    },

    // ---------------------------------------------------------------------------------------------
    // Вид: пачки thin instances «тип × участок»
    // ---------------------------------------------------------------------------------------------

    /** Матрица предмета в буфер пачки (начало модели — центр основания тела). */
    _write(p) {
        const b = p.batch;
        if (!b) return;
        const o = p.slot * 16, buf = b.buf, A = p.R, hy = p.hy, mx = p.T.mx || 0;
        buf[o] = A[0]; buf[o + 1] = A[1]; buf[o + 2] = A[2]; buf[o + 3] = 0;
        buf[o + 4] = A[3]; buf[o + 5] = A[4]; buf[o + 6] = A[5]; buf[o + 7] = 0;
        buf[o + 8] = A[6]; buf[o + 9] = A[7]; buf[o + 10] = A[8]; buf[o + 11] = 0;
        buf[o + 12] = p.x - A[3] * hy - A[0] * mx; buf[o + 13] = p.y - A[4] * hy - A[1] * mx; buf[o + 14] = p.z - A[5] * hy - A[2] * mx; buf[o + 15] = 1;
    },

    _material() {
        if (this.mat || !this.view) return this.mat;
        const m = new BABYLON.StandardMaterial('props-mat', this.view.scene);
        m.diffuseColor = new BABYLON.Color3(1, 1, 1);
        m.specularColor = new BABYLON.Color3(0.12, 0.12, 0.12);
        m.specularPower = 24;
        m.backFaceCulling = true;
        this.mat = m;
        return m;
    },

    _source(type) {
        let s = this.srcMeshes[type];
        if (s) return s;
        const g = WorldGeo.builder();
        (PROP_MESHES[type] || PROP_MESHES.block)(g);
        s = g.toMesh(this.view.scene, 'prop-' + type, this._material(), { uvs: false });
        if (s) { s.isVisible = false; s.isPickable = false; }
        this.srcMeshes[type] = s;
        return s;
    },

    /** Пачки по предметам, уже созданным: в каждой — тип и участок. */
    _batches() {
        if (!this.view) return;
        /** @type {Map<string, any[]>} */ const groups = new Map();
        for (const p of this.list) {
            const key = p.type + '|' + Math.floor(p.x / PROPS_CHUNK) + '|' + Math.floor(p.z / PROPS_CHUNK);
            let l = groups.get(key);
            if (!l) { l = []; groups.set(key, l); }
            l.push(p);
        }
        for (const [key, list] of groups) {
            const src = this._source(list[0].type);
            if (!src) continue;
            const mesh = src.clone('props-' + key);
            mesh.makeGeometryUnique();   // буфер матриц thin instances лежит в Geometry: у каждой пачки — своя
            mesh.isVisible = true;
            const buf = new Float32Array(list.length * 16);
            const b = { key, mesh, meshes: [mesh], buf, n: list.length, dirty: false, stale: false, cx: 0, cz: 0, on: true, list, type: list[0].type, cast: list[0].type !== 'cone', draw: PROP_TYPES[list[0].type].draw || PROPS_DRAW };
            let sx = 0, sz = 0;
            list.forEach((p, i) => { p.batch = b; p.slot = i; this._write(p); sx += p.x; sz += p.z; });
            b.cx = sx / list.length; b.cz = sz / list.length;
            mesh.thinInstanceSetBuffer('matrix', buf, 16, false);   // изменяемый: подвижные предметы обновляют свои матрицы
            mesh.thinInstanceRefreshBoundingInfo(true);
            mesh.isPickable = false;
            mesh.receiveShadows = false;   // большие плоские грани брусов и блоков дают «акне» самотени; тень на них не ложится
            mesh.alwaysSelectAsActiveMesh = false;
            if (b.cast) this.view.addShadowCaster(mesh, false);
            this.batches.set(key, b);
        }
    },

    /**
     * Модели из файлов (PROP_TYPES[тип].model — путь литералом assets/models/props/…): грузятся через Model3D, пачки типа переводятся на части
     * модели (по мешу на материал, общий буфер матриц). Нет файла или ошибка — остаётся процедурная модель. Origin модели — центр основания, 1 м = 100 px.
     */
    _loadModels() {
        if (!this.view || typeof Model3D === 'undefined') return Promise.resolve();
        /** @type {string[]} */ const types = [];
        for (const b of this.batches.values()) if (PROP_TYPES[b.type].model && !types.includes(b.type)) types.push(b.type);
        const scene = this.view.scene;
        return Promise.all(types.map(async type => {
            try {
                const model = await Model3D.load(PROP_TYPES[type].model);
                const root = Model3D.build(model, scene, { name: 'prop-model-' + type });
                const parts = /** @type {any[]} */ (root.getChildMeshes(false)).filter(m => m.getTotalVertices() > 0);
                World3D.addObject(this.view, root, 'prop', { outline: false, ink: false, castShadow: false });   // те же настройки материала, что у остальных объектов
                for (const m of parts) { m.isVisible = false; m.isPickable = false; }
                if (!parts.length) { root.dispose(false, false); return; }
                this.models[type] = { root, parts };
                for (const b of this.batches.values()) {
                    if (b.type !== type) continue;
                    for (const m of b.meshes) { try { this.view.removeShadowCaster(m); m.dispose(false, false); } catch (e) { /* ok */ } }
                    b.meshes = parts.map((part, i) => {
                        const m = part.clone('props-' + b.key + '-' + i);
                        m.makeGeometryUnique();
                        m.isVisible = true; m.isPickable = false; m.receiveShadows = false;
                        m.thinInstanceSetBuffer('matrix', b.buf, 16, false);
                        m.thinInstanceRefreshBoundingInfo(true);
                        m.setEnabled(b.on);
                        if (b.cast) this.view.addShadowCaster(m, false);
                        return m;
                    });
                    b.mesh = b.meshes[0];
                }
            } catch (e) {
                console.warn('Props: модель «' + type + '» не загрузилась, остаётся процедурная — ' + ((e && e.message) || e));
            }
        })).then(() => undefined);
    },

    /** Раз в кадр: матрицы подвижных предметов в буферы, дальние пачки выключены. */
    sync(dt) {
        void dt;
        this.frame++;
        for (const b of this.batches.values()) {
            if (b.dirty) {
                for (const p of b.list) if (p.state === 1 || b.stale || p.state === 3) this._write(p);
                for (const m of b.meshes) m.thinInstanceBufferUpdated('matrix');
                b.dirty = b.list.some(p => p.state === 1);
                if (!b.dirty) { for (const m of b.meshes) m.thinInstanceRefreshBoundingInfo(true); b.stale = false; }
            }
        }
        if ((this.frame & 7) === 0 && this.view) {
            const c = this.view.camera.position;
            const q = typeof Quality !== 'undefined' ? String(Quality.level) : '2';
            const far = (typeof IS_MOBILE !== 'undefined' && IS_MOBILE) || q === 'low' || q === '0' ? 0.55 : q === 'medium' || q === '1' ? 0.8 : 1;
            for (const b of this.batches.values()) {
                const on = Math.hypot(b.cx - c.x, b.cz - c.z) < b.draw * far + PROPS_CHUNK * 0.5;
                if (on !== b.on) { b.on = on; for (const m of b.meshes) m.setEnabled(on); }
            }
        }
    },

    stats() {
        let asleep = 0, moving = 0, gone = 0;
        for (const p of this.list) { if (p.state === 2) asleep++; else if (p.state === 1) moving++; else if (p.state === 3) gone++; }
        return { total: this.list.length, active: this.active.length, moving, asleep, removed: gone, broken: this.broken, batches: this.batches.size };
    },

    /** Проверка из лаборатории (tools/world-lab.html): удар шаром по предметам вдоль луча. */
    test: {
        /** Груз 1200 кг летит из точки вдоль единичного вектора со скоростью 38 м/с: удар по первым предметам на пути. */
        shoot(ox, oy, oz, dx, dy, dz) {
            const v = 3800, res = { nx: 0, ny: 0, nz: 0, depth: 0, jn: 0, jx: 0, jy: 0, jz: 0, px: 0, py: 0, pz: 0, surface: '' };
            /** @type {any[]} */ const list = [];
            let hits = 0;
            for (let t = 100; t < 9000 && !hits; t += 40) {
                const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
                Props.near(x - 90, y - 90, z - 90, x + 90, y + 90, z + 90, list);
                for (const p of list) {
                    for (let a = -1; a <= 1; a++) if (Props.contact(p, x + dz * a * 90, y, z - dx * a * 90, 45, dx * v, dy * v, dz * v, 1 / 1200, res)) hits++;
                }
            }
            return hits;
        },
    },
};
