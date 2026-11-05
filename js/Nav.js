// Nav.js — коллизии, высоты, видимость и пути на плоской карте. Чистая логика: Babylon
// у решений не спрашивается никогда (инвариант 4 — высота и пересечения должны быть
// одинаковы на всех устройствах; клетка террейна на мобильных крупнее). Земля — шум
// карты (location.terrain.terrainNoise, не зависит от клетки), поверхность — фигуры walk.
//
// ИСТОЧНИКИ. Nav.build(location, opts) читает карту (location.map.objects):
//   1. Модели. Игра поставляет реестр фигур по пути модели: Nav.register('путь.glb', [фигуры])
//      или Nav.register({ 'путь.glb': [...], ... }) (то же — Nav.colliders; на один вызов — ещё
//      opts.colliders). Фигуры переносятся в мир: масштаб scale[0] по x и scale[2] по y, высота
//      walk × scale[1] + h объекта, поворот курсом rot[1] (rot[0] и rot[2] — наклон —
//      игнорируются), сдвиг (x, y). Объект с моделью без записи в реестре просто не мешает;
//      их список — Nav.missing (для отладки). Чем писать фигуры руками: Nav.shapeOf(model) —
//      коробка по габариту модели; точные — из Blender-скрипта модели (рецепт — скилл world3d).
//   2. Маркеры, имена — из location.markers(имя) (имя и имя-2, имя-3…; Nav.MARKERS):
//        block — невидимая стена: прямоугольник scale[0]·100 × scale[2]·100 px, курс rot[1]
//                (твёрдая для движения, на видимость не влияет);
//        safe  — безопасная зона: круг радиусом scale[0]·100 px (Nav.safe, Nav.safeZone).
//
// ФИГУРЫ МОДЕЛИ (px модели: x вперёд — +X в Blender и glTF, y = −Y в Blender = +Z в glTF; угол a —
// градусы, как курс: от +x к +y; в карте y вниз):
//   { t: 'box',    x, y, w, d, a? }        твёрдая коробка: w по локальному x, d по y, центр (x, y);
//   { t: 'circle', x, y, r }               твёрдый круг (ствол, столб, камень);
//   { t: 'water',  x, y, w, d, a? } | { t: 'water', x, y, r }   вода: центр юнита в неё не заходит,
//                                          если над точкой нет walk (мост);
//   { t: 'walk',   x, y, w, d, a?, h, h2?, arch? }   ходибельная поверхность высотой h (px,
//                                          абсолютной); h2 — пандус от h (при −w/2) к h2 (при +w/2)
//                                          вдоль локального x; arch — арка: h в центре, 0 на концах.
//   Любой твёрдой фигуре можно дописать los: false — низкая (забор, куст): движению мешает,
//   видимость (Nav.los) не закрывает.
// Высота точки = max(земля, walk под ней).
//
// ДВИЖЕНИЕ. move идёт шагами не длиннее min(r/2, 25) px (тонкую стену не перепрыгнуть); круг
// выталкивается из твёрдых фигур, скользя вдоль стен; вода, край карты и перепад высот больше
// climb(шаг) = NAV_STEP_PX + шаг·NAV_SLOPE останавливают по этой оси (стенка помоста — нельзя,
// пандус и арка моста — можно): пробуется полный шаг, потом по x, потом по y.
//
// ПУТИ. Сетка NAV_CELL px (50): клетка занята, если твёрдая фигура ближе 0.55 клетки к её
// центру или там вода без walk; края карты заняты. Просвет клетки (расстояние до занятой, px) —
// двухпроходный chamfer-трансформ: путь для радиуса r идёт по клеткам с просветом ≥ 0.8·r.
// A* — 8 направлений без срезания углов; переход между соседними клетками рядом с walk
// проверяется той же мерой climb (биты edges); затем «натягивание нити» по прямой видимости
// в сетке. Недостижимая цель отсекается сразу (связные области на радиус). Карта 9600×9600 —
// 36 864 клеток, путь через всю карту — единицы мс.
//
// ПРИМЕР:
//   Nav.register(MY_COLLIDERS);                       // реестр игры: путь модели -> фигуры
//   await app.loadMap(id, { prepare: () => Nav.build(app.location) });   // после загрузки карты
//   const p = Nav.move(hero.x, hero.y, vx * dt, vy * dt, 30);            // шаг со скольжением, радиус 30
//   hero.x = p.x; hero.y = p.y; hero.h = Nav.height(p.x, p.y);           // высота — из логики, не из Babylon
//   const way = Nav.path(mob.x, mob.y, hero.x, hero.y, 40);              // [{ x, y }, …] без старта | null
//   if (Nav.los(mob.x, mob.y, hero.x, hero.y)) shoot();                  // прямая видимость
//   Nav.build(app.location);   // заново — если объекты карты менялись во время игры (стоит O(клеток))

/** @satisfies {Record<string, any>} */
const Nav = {
    ready: false,
    width: 0,
    height_px: 0,           // высота карты, px (height — метод)
    cell: 50,
    cols: 0,
    rows: 0,
    /** @type {Record<string, any[]>} */ colliders: {},   // реестр: путь модели -> фигуры
    MARKERS: { block: 'block', safe: 'safe' },            // имена маркеров (пустая строка — не читать)
    MARKER_UNIT: 100,       // px маркера при scale 1
    /** @type {any[]} */ solids: [],
    /** @type {any[]} */ waters: [],
    /** @type {any[]} */ walks: [],
    /** @type {any[]} */ safes: [],
    /** @type {string[]} */ missing: [],   // модели карты без записи в реестре
    /** @type {Uint8Array | null} */ grid: null,       // 0 — свободно, 1 — твёрдое, 2 — вода
    /** @type {Float32Array | null} */ clearance: null, // px до занятой клетки
    /** @type {Float32Array | null} */ hgt: null,       // высота поверхности в центре клетки
    /** @type {Uint8Array | null} */ edges: null,      // биты 8 направлений: перепад высот проходим
    _step: 12,
    _slope: 1.6,
    DI: [1, -1, 0, 0, 1, 1, -1, -1],
    DJ: [0, 0, 1, -1, 1, -1, 1, -1],

    DIR: [7, 1, 6, 3, -1, 2, 5, 0, 4],   // (di + 1) * 3 + (dj + 1) -> направление

    // Номер направления по сдвигу клетки (−1 — не сосед).
    dirOf(di, dj) {
        if (di < -1 || di > 1 || dj < -1 || dj > 1) return -1;
        return Nav.DIR[(di + 1) * 3 + (dj + 1)];
    },
    _ground: 0,
    /** @type {((x: number, y: number) => number) | null} */ _groundFn: null,
    _bucket: 400,
    _bcols: 0,
    _brows: 0,
    /** @type {any[][]} */ _buckets: [],
    _stamp: 1,
    /** @type {any} */ _astar: null,
    /** @type {any} */ _debug: null,
    /** @type {any} */ _location: null,
    /** @type {Map<number, Int32Array> | null} */ _comp: null,

    // Числа из Constants.js (NAV_*) с дефолтами: в игре константы лексические, в редакторе — window.
    cfg() {
        const U = 'undefined';
        return {
            cell: typeof NAV_CELL !== U ? NAV_CELL : 50,
            step: typeof NAV_STEP_PX !== U ? NAV_STEP_PX : 12,
            slope: typeof NAV_SLOPE !== U ? NAV_SLOPE : 1.6,
        };
    },

    // --- Реестр фигур -------------------------------------------------------------------

    // register('путь.glb', [фигуры]) или register({ путь: [фигуры], … }) — дописать в Nav.colliders.
    register(model, shapes) {
        if (model && typeof model === 'object') Object.assign(this.colliders, model);
        else if (model) this.colliders[String(model)] = Array.isArray(shapes) ? shapes : [];
        return this;
    },

    // Фигура-коробка по габариту модели (Model3D.load -> model.min / max): { t: 'box', x, y, w, d }
    // в координатах модели — заготовка для register, пока нет точных фигур. kind: 'box' | 'circle'
    // (круг по большей полуоси). pad — запас, px с каждой стороны.
    shapeOf(model, kind, pad) {
        const lo = model.min, hi = model.max, p = Number(pad) || 0;
        const w = hi[0] - lo[0] + 2 * p, d = hi[2] - lo[2] + 2 * p;
        const x = (lo[0] + hi[0]) / 2, y = (lo[2] + hi[2]) / 2;
        if (kind === 'circle') return { t: 'circle', x, y, r: Math.max(w, d) / 2 };
        return { t: 'box', x, y, w, d };
    },

    // --- Сборка ------------------------------------------------------------------------

    // Собрать навигацию карты location (Location3D; нужны map, width, height, terrain, markers).
    // opts: { colliders? — реестр на этот вызов (поверх Nav.colliders), ground? — (x, y) => высота
    // земли вместо terrain.terrainNoise, markers? — { block, safe } имена маркеров, cell?, step?,
    // slope? — вместо NAV_* }. Возвращает Nav.
    build(location, opts) {
        const o = opts || {};
        const map = location && location.map;
        this._location = location || null;
        this.width = Math.max(64, Number(location && location.width) || Number(map && map.width) || 2048);
        this.height_px = Math.max(64, Number(location && location.height) || Number(map && map.height) || 2048);
        const c = this.cfg();
        this.cell = Math.max(10, Number(o.cell) || c.cell);
        this._step = Math.max(0, o.step != null ? Number(o.step) : c.step);
        this._slope = Math.max(0.05, Number(o.slope) || c.slope);
        const terrain = location && location.terrain && typeof location.terrain.terrainNoise === 'function' ? location.terrain : null;
        this._groundFn = typeof o.ground === 'function' ? o.ground : terrain ? (x, y) => terrain.terrainNoise(x, y) : null;
        this._ground = Number(map && map.terrain && map.terrain.base) || 0;
        this.solids = []; this.waters = []; this.walks = []; this.safes = []; this.missing = [];

        const reg = Object.assign({}, this.colliders, o.colliders);
        const objects = (map && Array.isArray(map.objects)) ? map.objects : [];
        const miss = new Set();
        for (const def of objects) {
            if (!def || def.kind === 'marker') continue;
            const list = def.model ? reg[def.model] : null;
            if (!Array.isArray(list)) { if (def.model) miss.add(def.model); continue; }
            const T = this._transform(def);
            for (const s of list) {
                if (!s || !s.t) continue;
                this._add(s, T, s.t === 'water' ? 'water' : s.t === 'walk' ? 'walk' : 'solid');
            }
        }
        const names = Object.assign({}, this.MARKERS, o.markers);
        const U = this.MARKER_UNIT;
        for (const def of this._markers(location, names.block)) {
            const f = this._add({ t: 'box', x: 0, y: 0, w: U, d: U, los: false }, this._transform(def), 'solid');
            f.name = def.name;
        }
        for (const def of this._markers(location, names.safe)) {
            const T = this._transform(def);
            this.safes.push({ name: def.name, x: T.x, y: T.y, r: U * T.sx });
        }
        this.missing = [...miss];
        this._index();
        this._comp = null;
        this._buildGrid();
        this.ready = true;
        if (this._debug && this._debug.on) this.debug(true);
        return this;
    },

    // Маркеры с именем name (и name-N) через location.markers; без него — по записям карты.
    _markers(location, name) {
        if (!name || !location) return [];
        if (typeof location.markers === 'function') return location.markers(name);
        const objs = (location.map && location.map.objects) || [];
        return objs.filter((d) => d && d.kind === 'marker' && (d.name === name || String(d.name).startsWith(name + '-')));
    },

    // Положение, поворот и масштаб объекта карты (как у Location3D.placeObject): { x, y, a (рад), sx, sy, sh, h }.
    _transform(def) {
        const rot = Array.isArray(def.rot) ? def.rot : [0, def.rot || 0, 0];
        const sc = Array.isArray(def.scale) ? def.scale : [def.scale || 1, def.scale || 1, def.scale || 1];
        const k = (v) => (Number(v) > 0 ? Number(v) : 1);
        return { x: Number(def.x) || 0, y: Number(def.y) || 0, a: (Number(rot[1]) || 0) * Math.PI / 180,
            sx: k(sc[0]), sy: k(sc[2]), sh: k(sc[1]), h: Number(def.h) || 0 };
    },

    // Фигура модели -> фигура мира. T: { x, y, a (рад), sx, sy, sh, h }.
    _add(s, T, kind) {
        const ca = Math.cos(T.a), sa = Math.sin(T.a);
        const lx = (Number(s.x) || 0) * T.sx, ly = (Number(s.y) || 0) * T.sy;
        const cx = T.x + lx * ca - ly * sa, cy = T.y + lx * sa + ly * ca;
        const f = { kind, circle: false, cx, cy, r: 0, hw: 0, hd: 0, c: 1, s: 0, see: s.los !== false,
            h: 0, h2: null, arch: false, x0: 0, y0: 0, x1: 0, y1: 0, id: 0, mark: 0, name: '' };
        if (s.r != null && (s.t === 'circle' || s.w == null)) {
            f.circle = true;
            f.r = Math.max(0, Number(s.r) || 0) * (T.sx + T.sy) / 2;
            f.x0 = cx - f.r; f.x1 = cx + f.r; f.y0 = cy - f.r; f.y1 = cy + f.r;
        } else {
            const a = T.a + (Number(s.a) || 0) * Math.PI / 180;
            f.hw = Math.max(0, Number(s.w) || 0) * T.sx / 2;
            f.hd = Math.max(0, Number(s.d) || 0) * T.sy / 2;
            f.c = Math.cos(a); f.s = Math.sin(a);
            const ex = Math.abs(f.hw * f.c) + Math.abs(f.hd * f.s), ey = Math.abs(f.hw * f.s) + Math.abs(f.hd * f.c);
            f.x0 = cx - ex; f.x1 = cx + ex; f.y0 = cy - ey; f.y1 = cy + ey;
        }
        if (kind === 'walk') {
            f.h = (Number(s.h) || 0) * T.sh + T.h;
            f.h2 = s.h2 != null ? (Number(s.h2) || 0) * T.sh + T.h : null;
            f.arch = !!s.arch;
            this.walks.push(f);
        } else if (kind === 'water') this.waters.push(f);
        else this.solids.push(f);
        return f;
    },

    // Пространственный хэш твёрдых фигур, воды и поверхностей: корзины 400 px.
    _index() {
        const B = this._bucket;
        this._bcols = Math.ceil(this.width / B) + 1;
        this._brows = Math.ceil(this.height_px / B) + 1;
        this._buckets = new Array(this._bcols * this._brows);
        for (let i = 0; i < this._buckets.length; i++) this._buckets[i] = [];
        let id = 0;
        for (const list of [this.solids, this.waters, this.walks]) {
            for (const f of list) {
                f.id = id++;
                f.mark = 0;
                const i0 = this._bi(f.x0), i1 = this._bi(f.x1), j0 = this._bj(f.y0), j1 = this._bj(f.y1);
                for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this._buckets[j * this._bcols + i].push(f);
            }
        }
    },

    _bi(x) { return Math.max(0, Math.min(this._bcols - 1, Math.floor(x / this._bucket))); },
    _bj(y) { return Math.max(0, Math.min(this._brows - 1, Math.floor(y / this._bucket))); },

    // fn(фигура) для фигур, чьи габариты задевают круг (x, y, r); true из fn — стоп.
    _query(x, y, r, fn) {
        if (!this._buckets.length) return false;
        const stamp = ++this._stamp;
        const i0 = this._bi(x - r), i1 = this._bi(x + r), j0 = this._bj(y - r), j1 = this._bj(y + r);
        for (let j = j0; j <= j1; j++) {
            for (let i = i0; i <= i1; i++) {
                const list = this._buckets[j * this._bcols + i];
                for (let k = 0; k < list.length; k++) {
                    const f = list[k];
                    if (f.mark === stamp) continue;
                    f.mark = stamp;
                    if (x + r < f.x0 || x - r > f.x1 || y + r < f.y0 || y - r > f.y1) continue;
                    if (fn(f)) return true;
                }
            }
        }
        return false;
    },

    // Расстояние от точки до фигуры (0 — внутри).
    _dist(f, x, y) {
        if (f.circle) return Math.max(0, Math.hypot(x - f.cx, y - f.cy) - f.r);
        const dx = x - f.cx, dy = y - f.cy;
        const u = dx * f.c + dy * f.s, v = -dx * f.s + dy * f.c;
        const qu = Math.max(0, Math.abs(u) - f.hw), qv = Math.max(0, Math.abs(v) - f.hd);
        return Math.hypot(qu, qv);
    },

    _inside(f, x, y) { return this._dist(f, x, y) <= 0; },

    // --- Запросы -----------------------------------------------------------------------

    _groundAt(x, y) {
        return this._groundFn ? this._groundFn(x, y) : this._ground;
    },

    _walkAt(f, x, y) {
        if (f.circle) return f.h;
        const dx = x - f.cx, dy = y - f.cy;
        const u = dx * f.c + dy * f.s;
        if (f.arch) { const k = f.hw > 0 ? u / f.hw : 0; return f.h * Math.max(0, 1 - k * k); }
        if (f.h2 != null) { const k = f.hw > 0 ? (u + f.hw) / (2 * f.hw) : 0; return f.h + (f.h2 - f.h) * Math.max(0, Math.min(1, k)); }
        return f.h;
    },

    // Высота поверхности (px): земля карты + ходибельные фигуры.
    height(x, y) {
        let h = this._groundAt(x, y);
        if (!this.walks.length) return h;
        this._query(x, y, 0, (f) => {
            if (f.kind === 'walk' && this._inside(f, x, y)) { const w = this._walkAt(f, x, y); if (w > h) h = w; }
            return false;
        });
        return h;
    },

    _onWalk(x, y) {
        return this._query(x, y, 0, (f) => f.kind === 'walk' && this._inside(f, x, y));
    },

    // Вода под кругом (x, y, r), если точка не на walk.
    _water(x, y, r) {
        if (!this.waters.length) return false;
        const wet = this._query(x, y, r, (f) => f.kind === 'water' && this._dist(f, x, y) < r + 1e-6);
        return wet && !this._onWalk(x, y);
    },

    _outside(x, y, r) {
        const m = Math.min(r, 20);
        return x < m || y < m || x > this.width - m || y > this.height_px - m;
    },

    _solidHit(x, y, r) {
        const lim = Math.max(r, 1e-6);   // r = 0: точка внутри (расстояние 0) — тоже занято
        return this._query(x, y, r, (f) => f.kind === 'solid' && this._dist(f, x, y) < lim);
    },

    // Твёрдое препятствие, вода или край карты под кругом (x, y, r). До build ничего не занято.
    blocked(x, y, r) {
        if (!this.ready) return false;
        r = Math.max(0, r || 0);
        if (this._outside(x, y, r)) return true;
        if (this._solidHit(x, y, r)) return true;
        return this._water(x, y, r * 0.4);
    },

    // В безопасной зоне (маркер safe)?
    safe(x, y) {
        return this.safeZone(x, y) != null;
    },

    // Безопасная зона, в которой лежит точка: { name, x, y, r } | null.
    safeZone(x, y) {
        for (const s of this.safes) if (Math.hypot(x - s.x, y - s.y) <= s.r) return s;
        return null;
    },

    // Выталкивание круга из твёрдых фигур (до трёх проходов) -> out { x, y }.
    _resolve(x, y, r, out) {
        for (let it = 0; it < 3; it++) {
            let moved = false;
            this._query(x, y, r, (f) => {
                if (f.kind !== 'solid') return false;
                let px = 0, py = 0;
                if (f.circle) {
                    const dx = x - f.cx, dy = y - f.cy, d = Math.hypot(dx, dy), need = f.r + r;
                    if (d >= need) return false;
                    if (d < 1e-6) { px = need; } else { px = dx / d * (need - d); py = dy / d * (need - d); }
                } else {
                    const dx = x - f.cx, dy = y - f.cy;
                    const u = dx * f.c + dy * f.s, v = -dx * f.s + dy * f.c;
                    const cu = Math.max(-f.hw, Math.min(f.hw, u)), cv = Math.max(-f.hd, Math.min(f.hd, v));
                    const du = u - cu, dv = v - cv;
                    const d = Math.hypot(du, dv);
                    let pu = 0, pv = 0;
                    if (d > 1e-6) {
                        if (d >= r) return false;
                        pu = du / d * (r - d); pv = dv / d * (r - d);
                    } else {
                        // Центр внутри коробки — наружу по оси с наименьшим погружением.
                        const ou = f.hw - Math.abs(u) + r, ov = f.hd - Math.abs(v) + r;
                        if (ou < ov) pu = (u >= 0 ? 1 : -1) * ou; else pv = (v >= 0 ? 1 : -1) * ov;
                    }
                    px = pu * f.c - pv * f.s; py = pu * f.s + pv * f.c;
                }
                x += px * 1.001; y += py * 1.001;
                moved = true;
                return false;
            });
            if (!moved) break;
        }
        out.x = x; out.y = y;
        return out;
    },

    // Шаг со скольжением: из (x, y) на (dx, dy) кругом радиуса r -> { x, y }. До build — просто сумма.
    move(x, y, dx, dy, r) {
        const res = { x: x + (dx || 0), y: y + (dy || 0) };
        if (!this.ready) return res;
        r = Math.max(0, r || 0);
        const len = Math.hypot(dx || 0, dy || 0);
        const stepMax = Math.max(4, Math.min(r * 0.5 || 25, 25));
        const n = Math.max(1, Math.ceil(len / stepMax));
        const sx = (dx || 0) / n, sy = (dy || 0) / n;
        const tmp = { x: 0, y: 0 };
        let cx = x, cy = y, ch = this.height(x, y);
        const climb = this.climb(stepMax);
        const ok = (nx, ny) => {
            if (this._outside(nx, ny, r)) return false;
            if (this._water(nx, ny, r * 0.4)) return false;
            if (Math.abs(this.height(nx, ny) - ch) > climb) return false;
            return !this._solidHit(nx, ny, r * 0.98);
        };
        // Если стоим внутри препятствия — сперва вытолкнуться.
        if (this._solidHit(cx, cy, r * 0.98)) {
            this._resolve(cx, cy, r, tmp);
            if (!this._outside(tmp.x, tmp.y, r) && !this._water(tmp.x, tmp.y, r * 0.4)) { cx = tmp.x; cy = tmp.y; ch = this.height(cx, cy); }
        }
        for (let i = 0; i < n; i++) {
            let done = false;
            for (let attempt = 0; attempt < 3 && !done; attempt++) {
                // Полный шаг, потом только по x, потом только по y (скольжение вдоль стены).
                const mx = attempt === 2 ? 0 : sx, my = attempt === 1 ? 0 : sy;
                if (!mx && !my) continue;
                this._resolve(cx + mx, cy + my, r, tmp);
                if (ok(tmp.x, tmp.y)) { cx = tmp.x; cy = tmp.y; ch = this.height(cx, cy); done = true; }
            }
            if (!done) break;
        }
        res.x = Math.max(1, Math.min(this.width - 1, cx));
        res.y = Math.max(1, Math.min(this.height_px - 1, cy));
        return res;
    },

    // Допустимый перепад высоты на горизонтальном отрезке len px: ступень + уклон.
    climb(len) {
        return this._step + Math.max(0, len) * this._slope;
    },

    // Прямая из a в b проходима для круга r (препятствия, вода, перепады высот).
    clear(ax, ay, bx, by, r) {
        if (!this.ready) return true;
        r = Math.max(0, r || 0);
        const len = Math.hypot(bx - ax, by - ay);
        const step = Math.max(6, Math.min(r || 25, 25));
        const n = Math.max(1, Math.ceil(len / step));
        let ph = this.height(ax, ay);
        const climb = this.climb(len / n);
        for (let i = 1; i <= n; i++) {
            const x = ax + (bx - ax) * i / n, y = ay + (by - ay) * i / n;
            if (this.blocked(x, y, r)) return false;
            const h = this.height(x, y);
            if (Math.abs(h - ph) > climb) return false;
            ph = h;
        }
        return true;
    },

    // Прямая видимость из a в b: ни одна твёрдая фигура (кроме низких los: false и стен-маркеров
    // block) не пересекает отрезок. Вода, высота и край карты не мешают. r — толщина луча
    // (круг радиуса r не должен задевать фигуры), по умолчанию 0.
    los(ax, ay, bx, by, r) {
        if (!this.ready) return true;
        r = Math.max(0, r || 0);
        const mx = (ax + bx) / 2, my = (ay + by) / 2, half = Math.hypot(bx - ax, by - ay) / 2 + r;
        return !this._query(mx, my, half, (f) => f.kind === 'solid' && f.see && this._segHits(f, ax, ay, bx, by, r));
    },

    // Отрезок (a, b), утолщённый на r, задевает фигуру f?
    _segHits(f, ax, ay, bx, by, r) {
        if (f.circle) {
            const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
            const t = l2 > 0 ? Math.max(0, Math.min(1, ((f.cx - ax) * dx + (f.cy - ay) * dy) / l2)) : 0;
            return Math.hypot(ax + dx * t - f.cx, ay + dy * t - f.cy) < f.r + r;
        }
        // В систему коробки; коробка раздувается на r (углы не скругляются — запас пренебрежимо мал).
        const ux = (ax - f.cx) * f.c + (ay - f.cy) * f.s, uy = -(ax - f.cx) * f.s + (ay - f.cy) * f.c;
        const vx = (bx - f.cx) * f.c + (by - f.cy) * f.s, vy = -(bx - f.cx) * f.s + (by - f.cy) * f.c;
        const hw = f.hw + r, hd = f.hd + r;
        let t0 = 0, t1 = 1;
        const dxl = vx - ux, dyl = vy - uy;
        for (const [p, d, h] of [[ux, dxl, hw], [uy, dyl, hd]]) {
            if (Math.abs(d) < 1e-9) { if (Math.abs(p) >= h) return false; continue; }
            let a = (-h - p) / d, b = (h - p) / d;
            if (a > b) { const t = a; a = b; b = t; }
            t0 = Math.max(t0, a); t1 = Math.min(t1, b);
            if (t0 >= t1) return false;
        }
        return true;
    },

    // Ближайшая свободная для круга r точка (сама точка, если свободна).
    nearestFree(x, y, r) {
        r = r == null ? 40 : Math.max(0, r);
        if (!this.ready || !this.blocked(x, y, r)) return { x, y };
        const C = this.cell, ci = this._ci(x), cj = this._cj(y);
        let best = null, bd = Infinity;
        for (let ring = 0; ring <= 60 && !best; ring++) {
            for (let j = cj - ring; j <= cj + ring; j++) {
                for (let i = ci - ring; i <= ci + ring; i++) {
                    if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== ring) continue;
                    if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) continue;
                    const px = (i + 0.5) * C, py = (j + 0.5) * C;
                    if (this.blocked(px, py, r)) continue;
                    const d = Math.hypot(px - x, py - y);
                    if (d < bd) { bd = d; best = { x: px, y: py }; }
                }
            }
        }
        if (!best) return { x, y };
        // Подтянуть к исходной точке, пока свободно (бинарный поиск по отрезку).
        let lo = 0, hi = 1;
        for (let k = 0; k < 8; k++) {
            const m = (lo + hi) / 2, px = best.x + (x - best.x) * m, py = best.y + (y - best.y) * m;
            if (this.blocked(px, py, r)) hi = m; else lo = m;
        }
        return { x: best.x + (x - best.x) * lo, y: best.y + (y - best.y) * lo };
    },

    // --- Сетка -------------------------------------------------------------------------

    _ci(x) { return Math.max(0, Math.min(this.cols - 1, Math.floor(x / this.cell))); },
    _cj(y) { return Math.max(0, Math.min(this.rows - 1, Math.floor(y / this.cell))); },

    _buildGrid() {
        const C = this.cell;
        const cols = this.cols = Math.max(1, Math.ceil(this.width / C));
        const rows = this.rows = Math.max(1, Math.ceil(this.height_px / C));
        const n = cols * rows;
        const grid = this.grid = new Uint8Array(n);
        const hgt = this.hgt = new Float32Array(n);
        const R = C * 0.55;
        // Твёрдое — растеризация по габариту фигуры.
        for (const f of this.solids) {
            const i0 = this._ci(f.x0 - R), i1 = this._ci(f.x1 + R), j0 = this._cj(f.y0 - R), j1 = this._cj(f.y1 + R);
            for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
                if (this._dist(f, (i + 0.5) * C, (j + 0.5) * C) < R) grid[j * cols + i] = 1;
            }
        }
        for (const f of this.waters) {
            const i0 = this._ci(f.x0), i1 = this._ci(f.x1), j0 = this._cj(f.y0), j1 = this._cj(f.y1);
            for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
                const k = j * cols + i;
                if (grid[k]) continue;
                const px = (i + 0.5) * C, py = (j + 0.5) * C;
                if (this._dist(f, px, py) < C * 0.25 && !this._onWalk(px, py)) grid[k] = 2;
            }
        }
        for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
            const k = j * cols + i;
            if (i === 0 || j === 0 || i === cols - 1 || j === rows - 1) grid[k] = grid[k] || 1;
            hgt[k] = this.height((i + 0.5) * C, (j + 0.5) * C);
        }
        // Просвет: chamfer (шаги 1 и √2 в клетках), потом в px, минус полклетки запаса.
        const INF = 1e9, d = new Float32Array(n);
        for (let k = 0; k < n; k++) d[k] = grid[k] ? 0 : INF;
        const s1 = 1, s2 = Math.SQRT2;
        for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
            const k = j * cols + i;
            if (!d[k]) continue;
            let v = d[k];
            if (i > 0) v = Math.min(v, d[k - 1] + s1);
            if (j > 0) {
                v = Math.min(v, d[k - cols] + s1);
                if (i > 0) v = Math.min(v, d[k - cols - 1] + s2);
                if (i < cols - 1) v = Math.min(v, d[k - cols + 1] + s2);
            }
            d[k] = v;
        }
        for (let j = rows - 1; j >= 0; j--) for (let i = cols - 1; i >= 0; i--) {
            const k = j * cols + i;
            if (!d[k]) continue;
            let v = d[k];
            if (i < cols - 1) v = Math.min(v, d[k + 1] + s1);
            if (j < rows - 1) {
                v = Math.min(v, d[k + cols] + s1);
                if (i < cols - 1) v = Math.min(v, d[k + cols + 1] + s2);
                if (i > 0) v = Math.min(v, d[k + cols - 1] + s2);
            }
            d[k] = v;
        }
        // Перепады высот между соседними клетками — по той же мерке, что у move (climb):
        // считаются только рядом с walk, на остальной карте земля ровная.
        const edges = this.edges = new Uint8Array(n).fill(255);
        if (this.walks.length) {
            const near = new Uint8Array(n);
            for (const f of this.walks) {
                const i0 = this._ci(f.x0 - C), i1 = this._ci(f.x1 + C), j0 = this._cj(f.y0 - C), j1 = this._cj(f.y1 + C);
                for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) near[j * cols + i] = 1;
            }
            const DI = Nav.DI, DJ = Nav.DJ;
            for (let k = 0; k < n; k++) {
                if (!near[k]) continue;
                const i = k % cols, j = Math.floor(k / cols);
                for (let dd = 0; dd < 8; dd++) {
                    const ni = i + DI[dd], nj = j + DJ[dd];
                    if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) { edges[k] &= ~(1 << dd); continue; }
                    const ax = (i + 0.5) * C, ay = (j + 0.5) * C, bx = (ni + 0.5) * C, by = (nj + 0.5) * C;
                    const seg = Math.hypot(bx - ax, by - ay) / 4, lim = this.climb(seg);
                    let ph = this.height(ax, ay), bad = false;
                    for (let t = 1; t <= 4 && !bad; t++) {
                        const h = this.height(ax + (bx - ax) * t / 4, ay + (by - ay) * t / 4);
                        if (Math.abs(h - ph) > lim) bad = true;
                        ph = h;
                    }
                    if (bad) edges[k] &= ~(1 << dd);
                }
            }
        }
        const cl = this.clearance = new Float32Array(n);
        for (let k = 0; k < n; k++) cl[k] = grid[k] ? 0 : Math.max(0, d[k] * C - C * 0.55);
        this._astar = {
            g: new Float32Array(n), f: new Float32Array(n), parent: new Int32Array(n),
            open: new Uint32Array(n), closed: new Uint32Array(n), gen: 0,
            heap: new Int32Array(Math.max(64, n)), size: 0,
        };
    },

    _passable(k, r) {
        return this.grid[k] === 0 && this.clearance[k] >= r * 0.8;
    },

    // Ближайшая проходимая клетка (кольцами), -1 — нет в пределах max колец. При
    // равенстве — ближе к клетке toward (финиш в реке — свой берег, а не дальний).
    _nearCell(i, j, r, max, toward) {
        const cols = this.cols;
        const ti = toward >= 0 ? toward % cols : i, tj = toward >= 0 ? Math.floor(toward / cols) : j;
        for (let ring = 0; ring <= max; ring++) {
            let best = -1, bd = Infinity;
            for (let jj = j - ring; jj <= j + ring; jj++) {
                for (let ii = i - ring; ii <= i + ring; ii++) {
                    if (Math.max(Math.abs(ii - i), Math.abs(jj - j)) !== ring) continue;
                    if (ii < 0 || jj < 0 || ii >= cols || jj >= this.rows) continue;
                    const k = jj * cols + ii;
                    if (!this._passable(k, r)) continue;
                    const dd = ((ii - i) * (ii - i) + (jj - j) * (jj - j)) * 1e6 + (ii - ti) * (ii - ti) + (jj - tj) * (jj - tj);
                    if (dd < bd) { bd = dd; best = k; }
                }
            }
            if (best >= 0) return best;
        }
        return -1;
    },

    // Связные области сетки для радиуса r (4 соседа с учётом перепадов) — кэш на радиус:
    // недостижимый финиш отсекается сразу, без обхода всей карты.
    _components(r) {
        const key = Math.round(r * 0.8);
        const cache = this._comp || (this._comp = new Map());
        let lab = cache.get(key);
        if (lab) return lab;
        const n = this.cols * this.rows, cols = this.cols, rows = this.rows, edges = this.edges;
        lab = new Int32Array(n).fill(-1);
        const q = new Int32Array(n);
        let id = 0;
        for (let k0 = 0; k0 < n; k0++) {
            if (lab[k0] >= 0 || !this._passable(k0, r)) continue;
            let head = 0, tail = 0;
            q[tail++] = k0; lab[k0] = id;
            while (head < tail) {
                const k = q[head++], i = k % cols, j = (k - i) / cols;
                for (let d = 0; d < 4; d++) {
                    const ni = i + Nav.DI[d], nj = j + Nav.DJ[d];
                    if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
                    const nk = nj * cols + ni;
                    if (lab[nk] >= 0 || !(edges[k] & (1 << d)) || !this._passable(nk, r)) continue;
                    lab[nk] = id; q[tail++] = nk;
                }
            }
            id++;
        }
        cache.set(key, lab);
        return lab;
    },

    // Путь A* + сглаживание: [{x, y}, ...] без старта, с финишем (ближайшей свободной
    // точкой, если финиш занят); null — пути нет. opts.partial — вместо null путь к
    // ближайшей ДОСТИЖИМОЙ точке (клик по острову, за реку без моста). До build — прямо к цели.
    path(ax, ay, bx, by, r, opts) {
        r = r == null ? 40 : Math.max(0, r);
        if (!this.ready) return [{ x: bx, y: by }];
        const C = this.cell, cols = this.cols;
        const s = this._nearCell(this._ci(ax), this._cj(ay), r, 6, -1);
        if (s < 0) return null;
        let g = this._nearCell(this._ci(bx), this._cj(by), r, 40, s);
        const lab = this._components(r);
        let exact = true;
        if (g < 0 || lab[g] !== lab[s]) {
            if (!(opts && opts.partial)) return null;
            // Ближайшая к финишу клетка той же области, что старт.
            const gi = this._ci(bx), gj = this._cj(by);
            let best = -1, bd = Infinity;
            for (let k = 0; k < lab.length; k++) {
                if (lab[k] !== lab[s]) continue;
                const di = k % cols - gi, dj = Math.floor(k / cols) - gj, dd = di * di + dj * dj;
                if (dd < bd) { bd = dd; best = k; }
            }
            if (best < 0) return null;
            g = best;
            exact = false;
        }
        let goal = { x: bx, y: by };
        if (!exact || this.blocked(bx, by, r) || !this._passable(this._cj(by) * cols + this._ci(bx), r)) {
            goal = { x: (g % cols + 0.5) * C, y: (Math.floor(g / cols) + 0.5) * C };
            if (exact) goal = this.nearestFree(goal.x, goal.y, r);
        }
        if (s === g) return [goal];
        const cells = this._astarRun(s, g, r);
        if (!cells) return null;
        // Центры клеток -> натягивание нити по прямой видимости в сетке.
        const pts = [{ x: ax, y: ay }];
        for (let k = 1; k < cells.length - 1; k++) pts.push({ x: (cells[k] % cols + 0.5) * C, y: (Math.floor(cells[k] / cols) + 0.5) * C });
        pts.push(goal);
        const out = [];
        let cur = pts[0], i = 0;
        while (i < pts.length - 1) {
            let j = i + 1;
            while (j + 1 < pts.length && this._gridLine(cur.x, cur.y, pts[j + 1].x, pts[j + 1].y, r)) j++;
            out.push(pts[j]);
            cur = pts[j];
            i = j;
        }
        return out;
    },

    // A* по клеткам: список клеток от s до g или null.
    _astarRun(s, g, r) {
        const A = this._astar, cols = this.cols, rows = this.rows, edges = this.edges;
        const gen = ++A.gen;
        const gi = g % cols, gj = Math.floor(g / cols);
        const SQ = Math.SQRT2;
        const hfun = (k) => {
            const dx = Math.abs(k % cols - gi), dy = Math.abs(Math.floor(k / cols) - gj);
            return ((dx + dy) + (SQ - 2) * Math.min(dx, dy)) * 1.08;   // лёгкий вес: меньше раскрытий, путь почти оптимален
        };
        A.size = 0;
        const push = (k, f) => {
            if (A.size >= A.heap.length) { const bigger = new Int32Array(A.heap.length * 2); bigger.set(A.heap); A.heap = bigger; }
            const H = A.heap;
            let i = A.size++;
            H[i] = k; A.f[k] = f;
            while (i > 0) {
                const p = (i - 1) >> 1;
                if (A.f[H[p]] <= f) break;
                H[i] = H[p]; H[p] = k; i = p;
            }
        };
        const pop = () => {
            const H = A.heap, top = H[0], last = H[--A.size];
            let i = 0;
            if (A.size > 0) {
                H[0] = last;
                const fl = A.f[last];
                for (;;) {
                    const l = 2 * i + 1, rr = l + 1;
                    let m = i, fm = fl;
                    if (l < A.size && A.f[H[l]] < fm) { m = l; fm = A.f[H[l]]; }
                    if (rr < A.size && A.f[H[rr]] < fm) { m = rr; }
                    if (m === i) break;
                    H[i] = H[m]; H[m] = last; i = m;
                }
            }
            return top;
        };
        A.g[s] = 0; A.open[s] = gen; A.parent[s] = -1;
        push(s, hfun(s));
        const DI = Nav.DI, DJ = Nav.DJ;
        let iter = 0;
        while (A.size > 0) {
            const k = pop();
            if (A.closed[k] === gen) continue;
            A.closed[k] = gen;
            if (k === g) {
                const list = [];
                for (let c = g; c >= 0; c = A.parent[c]) list.push(c);
                return list.reverse();
            }
            if (++iter > cols * rows) break;
            const ki = k % cols, kj = Math.floor(k / cols);
            for (let d = 0; d < 8; d++) {
                const ni = ki + DI[d], nj = kj + DJ[d];
                if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
                const nk = nj * cols + ni;
                if (A.closed[nk] === gen || !this._passable(nk, r)) continue;
                const diag = d >= 4;
                if (diag && (!this._passable(kj * cols + ni, r) || !this._passable(nj * cols + ki, r))) continue;
                if (!(edges[k] & (1 << d))) continue;
                const ng = A.g[k] + (diag ? SQ : 1);
                if (A.open[nk] === gen && ng >= A.g[nk]) continue;
                A.open[nk] = gen;
                A.g[nk] = ng;
                A.parent[nk] = k;
                push(nk, ng + hfun(nk));
            }
        }
        return null;
    },

    // Прямая по сетке: все клетки по пути проходимы для r, перепады в пределах шага.
    _gridLine(ax, ay, bx, by, r) {
        const C = this.cell, len = Math.hypot(bx - ax, by - ay);
        const n = Math.max(1, Math.ceil(len / (C * 0.35)));
        let pk = this._cj(ay) * this.cols + this._ci(ax);
        for (let i = 1; i <= n; i++) {
            const x = ax + (bx - ax) * i / n, y = ay + (by - ay) * i / n;
            const k = this._cj(y) * this.cols + this._ci(x);
            if (k === pk) continue;
            if (!this._passable(k, r)) return false;
            const di = (k % this.cols) - (pk % this.cols), dj = Math.floor(k / this.cols) - Math.floor(pk / this.cols);
            const d = Nav.dirOf(di, dj);
            if (d < 0 || !(this.edges[pk] & (1 << d))) return false;
            pk = k;
        }
        return true;
    },

    // --- Отладка -----------------------------------------------------------------------

    // Сетка поверх земли (только вид): красное — твёрдое, синее — вода, зелёное — walk,
    // жёлтое — безопасная зона, оранжевое — узкий проход.
    debug(on) {
        const st = this._debug || (this._debug = { on: false, mesh: null, tex: null, mat: null, path: null });
        st.on = !!on;
        if (st.mesh) { try { st.mesh.dispose(); st.mat.dispose(); st.tex.dispose(); } catch (e) { /* ok */ } st.mesh = null; }
        if (!on || !this.ready || typeof BABYLON === 'undefined') return;
        const loc = this._location;
        const scene = loc && loc.view && loc.view.scene;
        if (!scene) return;
        const cols = this.cols, rows = this.rows, C = this.cell;
        const tex = new BABYLON.DynamicTexture('navDebug', { width: cols, height: rows }, scene, false, BABYLON.Texture.NEAREST_SAMPLINGMODE);
        const ctx = /** @type {CanvasRenderingContext2D} */ (/** @type {any} */ (tex.getContext()));
        const img = ctx.createImageData(cols, rows);
        for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
            const k = j * cols + i, p = (j * cols + i) * 4;
            const x = (i + 0.5) * C, y = (j + 0.5) * C;
            let c = [0, 0, 0, 0];
            if (this.grid[k] === 1) c = [230, 40, 40, 150];
            else if (this.grid[k] === 2) c = [40, 110, 255, 150];
            else if (this.hgt[k] > this._groundAt(x, y) + 1) c = [40, 220, 90, 120];
            else if (this.clearance[k] < 40 * 0.8) c = [255, 150, 40, 60];
            if (this.safe(x, y)) c = [Math.max(c[0], 250), Math.max(c[1], 220), c[2], Math.max(c[3], 70)];
            img.data[p] = c[0]; img.data[p + 1] = c[1]; img.data[p + 2] = c[2]; img.data[p + 3] = c[3];
        }
        ctx.putImageData(img, 0, 0);
        tex.update(false);   // строка канваса j = клетка j (v = y / H)
        tex.hasAlpha = true;
        tex.wrapU = tex.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
        // Квад по карте: u = x / W, v = y / H — клетка (i, j) ровно под пикселем (i, j).
        const W = cols * C, H = rows * C, y0 = this._ground + 4;
        const mesh = new BABYLON.Mesh('navDebug', scene);
        const vd = new BABYLON.VertexData();
        vd.positions = [0, y0, 0, W, y0, 0, W, y0, H, 0, y0, H];
        vd.uvs = [0, 0, 1, 0, 1, 1, 0, 1];
        vd.indices = [0, 2, 1, 0, 3, 2];
        vd.normals = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
        vd.applyToMesh(mesh);
        const mat = new BABYLON.StandardMaterial('navDebug', scene);
        // Цвет — emissiveTexture (emissiveColor чёрный, иначе выбелит), прозрачность — из диффуза.
        mat.disableLighting = true;
        mat.emissiveColor = new BABYLON.Color3(0, 0, 0);
        mat.emissiveTexture = tex;
        mat.diffuseTexture = tex;
        mat.useAlphaFromDiffuseTexture = true;
        mat.backFaceCulling = false;
        mat.disableDepthWrite = true;
        mat.metadata = { toon: false };
        // Не писать в трафарет: иначе обводка объектов под сеткой зальёт её тёмным.
        mat.stencil.enabled = true; mat.stencil.mask = 0x00; mat.stencil.func = BABYLON.Constants.ALWAYS;
        mesh.material = mat;
        mesh.isPickable = false;
        mesh.alphaIndex = 1000;
        st.mesh = mesh; st.tex = tex; st.mat = mat;
    },

    // Показать путь линией (отладка): точки [{x, y}] или null; from — старт.
    debugPath(points, from) {
        const st = this._debug || (this._debug = { on: false, mesh: null, tex: null, mat: null, path: null });
        if (st.path) { try { st.path.dispose(); } catch (e) { /* ok */ } st.path = null; }
        const loc = this._location, scene = loc && loc.view && loc.view.scene;
        if (!points || !points.length || !scene || typeof BABYLON === 'undefined') return;
        const all = (from ? [from] : []).concat(points);
        const pts = all.map((p) => new BABYLON.Vector3(p.x, this.height(p.x, p.y) + 12, p.y));
        if (pts.length < 2) return;
        const line = BABYLON.MeshBuilder.CreateLines('navPath', { points: pts }, scene);
        line.color = new BABYLON.Color3(1, 0.9, 0.1);
        line.isPickable = false;
        st.path = line;
    },
};
