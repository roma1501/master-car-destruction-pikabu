// ObbyCourse.js — трасса обби из объектов карты: детали (модели из папки assets/models/obby/ + маркеры),
// точные коллайдеры, движущиеся препятствия, опасные зоны, чекпоинты, спавн и возрождение. ЧИСТАЯ ЛОГИКА:
// Babylon здесь не спрашивается никогда (инвариант 4) — одни и те же числа на телефоне и на ПК. Рисует трассу
// ObbyCourseView.js (статика слита в пачки по участкам и материалам, подвижное — свои меши).
//
// КООРДИНАТЫ физики — как у Babylon: x вправо (x карты), y ВВЕРХ (h карты), z вниз по карте (y карты). 1 м = 100 px.
// Размер детали в px = scale × 100. Курс rot[1] — как у Location3D (rotation.y = −rot[1]), rot[0] и rot[2] — наклон.
//
// ДЕТАЛИ (модель assets/models/obby/<тип>_<цвет>.glb — без кавычек: сканер сборщика; контракт — как в играх Bike Obby / Obby Car Master).
//   Локальные оси: X — длина, Y — вверх, Z — ширина. Размер = scale × 100 px.
//   box   брус X∈[−½,½] Z∈[−½,½] Y∈[−1,0]    начало — центр ВЕРХНЕЙ грани     scale [длина, толщина, ширина]
//   cyl   цилиндр Ø1, Y∈[−1,0]                начало — центр верхней грани      scale [Ø, толщина, Ø]
//   ramp  клин: низ Y=0, верх 0 при X=−½ → 1 при X=+½   начало — центр нижней   scale [длина, подъём, ширина]
//   arch  горб (синоним bump): верх Y = ½ + ½·cos(2πX)  начало — центр нижней   scale [длина, высота, ширина]
//   kill / lava / water   как box, но касание = смерть (причина kill | lava | water)
//   boost плита-ускоритель 1×0.05×1 (v= скорость)     jump батут Ø (v= скорость выброса)
//   pillar столб, fence бортик — твёрдые стены без верхней опоры для ног (они и опора, но «стеной» помечены)
//   spinner стойка + вращающаяся балка (капсула-ловушка): scale [длина балки, высота оси над основанием, толщина]
//   hammer молот-маятник, начало — точка подвеса: scale [Ø бойка, длина рукояти, длина бойка]
//   arrow подсказка без коллизии (рисует вид)
//   Цвета: purple orange green yellow red blue pink mint white dark ice (ice — скользкий).
// ПАРАМЕТРЫ в имени объекта: первое слово — роль, дальше `ключ=число`:
//   move x=600 y=0 z=0 t=4 ph=0   ездит по ЛОКАЛЬНЫМ осям (x, y, z — размах в px), период t с, фаза ph 0..1
//   fall d=0.6 r=3                падающая плита: дрожь d с после касания, падение, возврат через r с
//   spin rpm=12                   вращение вокруг вертикали (rpm < 0 — по часовой; или anim редактора: speed/dir)
//   hammer t=2.6 a=70 ph=0        период, размах (°), фаза;   boost v=1100;   jump v=1750
//
// МАРКЕРЫ (kind 'marker', location.markers(имя), номера -2, -3…):
//   spawn            старт: h — поверхность, rot[1] — курс
//   checkpoint-N     чекпоинты по номеру N: h — поверхность, rot[1] — курс возрождения, scale[0]·100 — радиус, scale[1]·160 — высота зоны
//   finish           финиш: радиус scale[0]·100
//   route-N          маршрут ботов: scale[0] — доля скорости 0.3..1, scale[1] — действие (1 бег, 2 прыжок здесь, 3 приземление)
//   kill / lava      убивающий объём: полуразмеры scale[0]·100 × scale[2]·100 (равны — круг), высота scale[1]·100 вверх от h
//   kill-plane       h — высота, ниже которой смерть (нет маркера — самая низкая опора − OBBY_KILL_DEPTH)
//
// ВОДА: убивает и вода Terrain3D (маркер water): игра отдаёт функцию — ObbyCourse.build(map, { waterAt: (x, z) => location.waterAt(x, z) }).
//
// ЗАПРОСЫ (чистая логика, все в мире Babylon): rayDown, ray, sphere, capsule, pushOut, groundAt, hazardAt/killCause.
// Годятся как «запрос земли и столкновений» для контроллера персонажа: groundAt(x, z, fromY, maxDrop) → высота | null,
// pushOut(x, y, z, r, h) — вытолкнуть капсулу из твёрдых деталей. Подвижные детали считаются по времени course.time:
// poseAt(piece, t) — чистая функция, боты предсказывают ею будущее.
//
// ПРИМЕР:
//   ObbyCourse.hookMaps();                                // до main.js: детали уходят из Location3D (иначе рисовались бы дважды)
//   await app.loadMap('course', { prepare: app => { ObbyCourse.build(app.location.map); ObbyCourseView.build(app, ObbyCourse); } });
//   app.onUpdate(dt => { ObbyCourse.update(dt); ObbyCourseView.update(dt); });
//   const g = ObbyCourse.groundAt(x, z, y + 60, 400);     // высота опоры под героем | null
//   const bad = ObbyCourse.killCause(x, y + 90, z, 30);   // 'lava' | 'water' | 'trap' | 'void' | 'kill' | null
//   const spot = ObbyCourse.respawn(stage);               // { x, y, z, yaw } чекпоинта игрока

/** @typedef {{ kind: string, O: number[], ax: number[], ay: number[], az: number[], hx?: number, hz?: number, y0?: number, y1?: number,
 *   rx?: number, rz?: number, sy?: number, a?: number[], b?: number[], r?: number, aabb: number[], piece?: any, dynamic?: boolean,
 *   enabled?: boolean, kill?: boolean, cause?: string, hazard?: boolean, ice?: boolean, boost?: number, jump?: number, wall?: boolean,
 *   poly?: number[][], local?: any, _s?: number }} ObbyCollider */

/** @satisfies {Record<string, any>} */
const ObbyCourse = {
    // Папка деталей: литерал разбит — сканер сборщика не примет его за ссылку на ассет (как Location3D.DECOR_PREFIX).
    PREFIX: 'assets/' + 'models/obby/',
    /** Типы деталей: остальные модели из папки (монета, флаг) остаются обычными объектами карты. */
    TYPES: ['box', 'cyl', 'ramp', 'arch', 'kill', 'lava', 'water', 'boost', 'jump', 'pillar', 'fence', 'spinner', 'hammer', 'arrow'],
    ALIAS: { bump: 'arch', beam: 'box', wedge: 'ramp', slab: 'box' },
    /** Тона плит (светлый, тёмный) — их берёт и вид, и боты не знают. Игра дописывает свои. */
    COLORS: {
        purple: [0xa77bff, 0x8a5cf0], orange: [0xf7b267, 0xe0904a], green: [0x8ee05a, 0x6cc43c],
        yellow: [0xfbe86a, 0xe8cf3e], red: [0xff6b6b, 0xe24c4c], blue: [0x5ab8ff, 0x3d97e6],
        pink: [0xff9ad5, 0xf173b9], mint: [0x7ef0c8, 0x4fd6a8], white: [0xffffff, 0xe3e8f0],
        dark: [0x4a4560, 0x36324a], ice: [0xd2f8ff, 0xa6e6f7],
    },

    /** @type {any} */ map: null,
    /** @type {any[]} */ pieces: [],
    /** @type {ObbyCollider[]} */ colliders: [],
    /** @type {ObbyCollider[]} */ zones: [],
    /** @type {any[]} */ dynamicPieces: [],
    /** @type {any[]} */ fallers: [],
    /** @type {Map<string, ObbyCollider[]>} */ grid: new Map(),
    /** @type {any} */ spawn: null,
    /** @type {any} */ finish: null,
    /** @type {any[]} */ checkpoints: [],
    /** @type {any[]} */ stages: [],        // spawn, checkpoint-1…K, finish: точки возрождения по номеру этапа
    /** @type {any[]} */ route: [],          // route-N: маршрут ботов
    /** @type {number[]} */ stageRoute: [],  // номер этапа → индекс точки маршрута
    /** @type {number[]} */ stageDist: [],   // накопленная длина пути до этапа (progress)
    /** @type {((x: number, z: number) => number | null) | null} */ waterAt: null,
    killY: -Infinity,
    minTop: 0,
    time: 0,
    _frame: 1,
    _stamp: 0,
    _dt: 1 / 60,
    _tmp: [],

    // ---------------------------------------------------------------------------------------------
    // Настройки (Constants.js, блок «1.40 — ОББИ»)
    // ---------------------------------------------------------------------------------------------

    cfg() {
        const U = 'undefined';
        return {
            grid: typeof OBBY_GRID !== U ? OBBY_GRID : 1024,
            fallShake: typeof OBBY_FALL_SHAKE !== U ? OBBY_FALL_SHAKE : 0.6,
            fallReturn: typeof OBBY_FALL_RETURN !== U ? OBBY_FALL_RETURN : 3,
            fallGravity: typeof OBBY_FALL_GRAVITY !== U ? OBBY_FALL_GRAVITY : 2600,
            lift: typeof OBBY_RESPAWN_LIFT !== U ? OBBY_RESPAWN_LIFT : 30,
            killDepth: typeof OBBY_KILL_DEPTH !== U ? OBBY_KILL_DEPTH : 1500,
            bounce: typeof OBBY_BOUNCE_SPEED !== U ? OBBY_BOUNCE_SPEED : 1750,
            boost: typeof OBBY_BOOST_SPEED !== U ? OBBY_BOOST_SPEED : 1100,
        };
    },

    // ---------------------------------------------------------------------------------------------
    // Разбор карты
    // ---------------------------------------------------------------------------------------------

    /** Тип детали по пути модели ('' — не деталь трассы). bump_red.glb из папки деталей → 'arch'. */
    typeOf(model) {
        const m = String(model || '');
        if (!m.startsWith(this.PREFIX)) return '';
        const file = m.slice(this.PREFIX.length).replace(/\.glb$/i, '');
        const us = file.indexOf('_');
        let type = (us > 0 ? file.slice(0, us) : file).toLowerCase();
        type = this.ALIAS[type] || type;
        return this.TYPES.includes(type) ? type : '';
    },

    /** Объект карты — деталь трассы (модель из папки деталей известного типа). */
    isPart(def) { return !!(def && def.kind !== 'marker' && def.model && this.typeOf(def.model)); },

    /** Разделить объекты карты: { parts, rest }. */
    split(objects) {
        const parts = [], rest = [];
        for (const d of objects || []) (this.isPart(d) ? parts : rest).push(d);
        return { parts, rest };
    },

    /**
     * Детали не должен строить Location3D (их сотни, а рисует трассу ObbyCourseView): копия карты (Location3D.copyMap)
     * отдаёт их в map.obbyKit, в map.objects остаются маркеры и обычные объекты. Звать ДО main.js, один раз.
     * В редакторе хук не ставится — там детали видны моделями-превью.
     */
    hookMaps() {
        if (typeof Location3D === 'undefined') return false;
        const L = /** @type {any} */ (Location3D);
        if (L.__obbyHook) return false;
        const copy = L.copyMap;
        L.copyMap = function (map) {
            const m = copy.call(this, map);
            if (m && Array.isArray(m.objects)) {
                const s = ObbyCourse.split(m.objects);
                m.objects = s.rest;
                m.obbyKit = s.parts;
            }
            return m;
        };
        L.__obbyHook = true;
        return true;
    },

    /** 'move x=600 t=4' → { role: 'move', x: 600, t: 4 }; регистр ключей не важен. */
    params(name) {
        const out = { role: '' };
        const words = String(name || '').trim().split(/\s+/).filter(Boolean);
        if (!words.length) return out;
        out.role = /=/.test(words[0]) ? '' : words[0].toLowerCase();
        for (const w of words) {
            const m = /^([a-z]+)=(-?[\d.]+)$/i.exec(w);
            if (m) out[m[1].toLowerCase()] = Number(m[2]);
        }
        return out;
    },

    /** Матрица поворота объекта карты — как Babylon RotationYawPitchRoll(−rot[1], rot[0], rot[2]) (проверяет тест). */
    rotation(rot) {
        const r = Array.isArray(rot) ? rot : [0, Number(rot) || 0, 0];
        const D = Math.PI / 180, yaw = -(Number(r[1]) || 0) * D, pitch = (Number(r[0]) || 0) * D, roll = (Number(r[2]) || 0) * D;
        const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
        // M = Rz(roll) · Rx(pitch) · Ry(yaw), векторы-строки (как Babylon); строки M — образы осей X, Y, Z детали.
        const Rz = [[cr, sr, 0], [-sr, cr, 0], [0, 0, 1]], Rx = [[1, 0, 0], [0, cp, sp], [0, -sp, cp]], Ry = [[cy, 0, -sy], [0, 1, 0], [sy, 0, cy]];
        const mul = (A, B) => A.map(row => [0, 1, 2].map(j => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
        const M = mul(mul(Rz, Rx), Ry);
        return { ax: M[0], ay: M[1], az: M[2] };
    },

    /** Деталь из записи карты: тип, цвет, размеры px, базовая поза и параметры. @returns {any} */
    parse(def) {
        const file = String(def.model).slice(this.PREFIX.length).replace(/\.glb$/i, '');
        const us = file.indexOf('_');
        const type = this.typeOf(def.model);
        const color = us > 0 ? file.slice(us + 1).toLowerCase() : '';
        const s = Array.isArray(def.scale) ? def.scale : [def.scale || 1, def.scale || 1, def.scale || 1];
        const R = this.rotation(def.rot);
        const prm = this.params(def.name);
        return {
            def, type, color, prm,
            sx: Math.max(1, (Number(s[0]) || 1) * 100), sy: Math.max(1, (Number(s[1]) || 1) * 100), sz: Math.max(1, (Number(s[2]) || 1) * 100),
            O: [Number(def.x) || 0, Number(def.h) || 0, Number(def.y) || 0],
            ax: R.ax, ay: R.ay, az: R.az,
            anim: def.anim || null,
        };
    },

    // ---------------------------------------------------------------------------------------------
    // Постройка
    // ---------------------------------------------------------------------------------------------

    /**
     * Собрать трассу из карты: детали — map.obbyKit (после hookMaps) и объекты map.objects, маркеры — оттуда же.
     * opts: { waterAt(x, z) → уровень | null, killY, prefix }. Повторный вызов заменяет прежнюю трассу.
     */
    build(map, opts) {
        const o = opts || {};
        this.clear();
        if (o.prefix) this.PREFIX = o.prefix;
        this.map = map || { objects: [] };
        this.waterAt = o.waterAt || null;
        const all = (this.map.obbyKit || []).concat(this.map.objects || []);
        let minTop = Infinity;
        let id = 0;
        for (const def of all) {
            if (!this.isPart(def)) continue;
            const p = this.parse(def);
            p.id = ++id;
            p.role = this._role(p);
            p.dynamic = ['move', 'fall', 'spin', 'spinner', 'hammer'].includes(p.role);
            p.cols = this._collidersFor(p);
            for (const c of p.cols) {
                c.piece = p; c.dynamic = p.dynamic; c.enabled = true;
                this.colliders.push(c);
                if (!p.dynamic) this._insert(c);
                if (c.kind !== 'capsule' && !c.kill && !c.boost && !c.jump && c.aabb[4] > -1e6 && p.type !== 'arrow') minTop = Math.min(minTop, c.aabb[4]);
            }
            p.base = { O: p.O.slice(), ax: p.ax.slice(), ay: p.ay.slice(), az: p.az.slice() };
            if (p.dynamic) { this._reach(p); this.dynamicPieces.push(p); }
            if (p.role === 'fall') { p.fallState = 'idle'; p.fallT = 0; p.fallDrop = 0; p.fallVel = 0; this.fallers.push(p); }
            this.pieces.push(p);
        }
        this.minTop = Number.isFinite(minTop) ? minTop : 0;
        this._markers(all);
        this.killY = Number.isFinite(o.killY) ? o.killY : (this.killY > -Infinity ? this.killY : (Number.isFinite(minTop) ? minTop - this.cfg().killDepth : -Infinity));
        this._buildStages();
        this.time = 0;
        this._frame++;
        return this;
    },

    clear() {
        this.pieces = []; this.colliders = []; this.zones = []; this.dynamicPieces = []; this.fallers = [];
        this.grid = new Map();
        this.spawn = null; this.finish = null; this.checkpoints = []; this.stages = []; this.route = []; this.stageRoute = []; this.stageDist = [];
        this.killY = -Infinity; this.minTop = 0; this.time = 0; this._frame++;
    },

    _role(p) {
        const r = p.prm.role;
        if (p.type === 'spinner') return 'spinner';
        if (p.type === 'hammer') return 'hammer';
        if (r === 'move') return 'move';
        if (r === 'fall') return 'fall';
        const rpm = p.prm.rpm != null ? p.prm.rpm : (p.anim && Number(p.anim.speed) > 0 ? Number(p.anim.speed) : 0);
        if (r === 'spin' || (rpm && (p.type === 'box' || p.type === 'cyl'))) return 'spin';
        return '';
    },

    /** Число из имени маркера: 'checkpoint-12' → 12 (без числа — 0). */
    num(def) { const m = /-(\d+)$/.exec(String(def.name)); return m ? Number(m[1]) : 0; },

    /** Маркеры карты с именем name или name-N, по номеру. */
    _named(all, name) {
        const re = new RegExp('^' + name + '-\\d+$');   // 'kill-plane' — не 'kill-N'
        return all.filter(d => d.kind === 'marker' && (d.name === name || re.test(String(d.name)))).sort((a, b) => this.num(a) - this.num(b));
    },

    _pt(d) {
        const rot = Array.isArray(d.rot) ? d.rot : [0, Number(d.rot) || 0, 0];
        const sc = Array.isArray(d.scale) ? d.scale : [1, 1, 1];
        return { x: Number(d.x) || 0, y: Number(d.h) || 0, z: Number(d.y) || 0, yaw: (Number(rot[1]) || 0) * Math.PI / 180, sx: Number(sc[0]) || 1, sy: Number(sc[1]) || 1, sz: Number(sc[2]) || 1, def: d };
    },

    _markers(all) {
        const sp = this._named(all, 'spawn')[0];
        if (sp) this.spawn = this._pt(sp);
        this.checkpoints = this._named(all, 'checkpoint').map((d, i) => {
            const p = this._pt(d);
            return { n: i + 1, name: d.name, x: p.x, y: p.y, z: p.z, yaw: p.yaw, r: Math.max(60, p.sx * 100), vt: Math.max(120, p.sy * 160), def: d };
        });
        const fin = this._named(all, 'finish')[0];
        if (fin) { const p = this._pt(fin); this.finish = { n: this.checkpoints.length + 1, name: fin.name, x: p.x, y: p.y, z: p.z, yaw: p.yaw, r: Math.max(80, p.sx * 100), vt: Math.max(160, p.sy * 160), def: fin }; }
        this.route = this._named(all, 'route').map(d => {
            const p = this._pt(d);
            const sc = Array.isArray(d.scale) ? d.scale : [1, 1, 1];
            return { x: p.x, y: p.y, z: p.z, yaw: p.yaw, s: Math.max(0.3, Math.min(1, Number(sc[0]) || 1)), f: Math.round(Number(sc[1]) || 1) };
        });
        for (const name of ['kill', 'lava']) for (const d of this._named(all, name)) {
            const p = this._pt(d);
            const hx = Math.max(10, p.sx * 100), hz = Math.max(10, p.sz * 100), th = Math.max(10, p.sy * 100);
            const R = this.rotation(Array.isArray(d.rot) ? [0, d.rot[1], 0] : [0, d.rot, 0]);
            const base = { O: [p.x, p.y, p.z], ax: R.ax, ay: R.ay, az: R.az, aabb: [0, 0, 0, 0, 0, 0], kill: true, cause: name, enabled: true, zone: true };
            /** @type {any} */
            const c = Math.abs(hx - hz) < 1 ? { ...base, kind: 'cyl', rx: hx, rz: hz, y0: 0, y1: th } : { ...base, kind: 'box', hx, hz, y0: 0, y1: th };
            this._aabb(c);
            this.zones.push(c); this.colliders.push(c); this._insert(c);
        }
        const kp = this._named(all, 'kill-plane')[0];
        if (kp) this.killY = Number(kp.h) || 0;
    },

    // Этапы: 0 — старт, 1…K — чекпоинты, K+1 — финиш; маршрут ботов привязывается по ближайшей точке (по порядку).
    _buildStages() {
        const st = [];
        const fallback = this.checkpoints[0] || this.finish;
        const sp = this.spawn || (fallback ? { x: fallback.x - 400, y: fallback.y, z: fallback.z, yaw: fallback.yaw } : { x: 0, y: 0, z: 0, yaw: 0 });
        st.push({ n: 0, x: sp.x, y: sp.y, z: sp.z, yaw: sp.yaw, r: 0, vt: 0 });
        for (const c of this.checkpoints) st.push(c);
        if (this.finish) st.push(this.finish);
        this.stages = st;
        this.stageDist = [0];
        for (let i = 1; i < st.length; i++) this.stageDist.push(this.stageDist[i - 1] + Math.hypot(st[i].x - st[i - 1].x, st[i].z - st[i - 1].z, (st[i].y - st[i - 1].y) * 0.5));
        if (this.route.length < 2) this.route = this.fallbackRoute();
        this.stageRoute = [];
        let from = 0;
        for (const s of st) {
            let best = from, bd = Infinity;
            for (let i = from; i < this.route.length; i++) {
                const q = this.route[i];
                const d = (q.x - s.x) ** 2 + (q.z - s.z) ** 2 + ((q.y - s.y) * 2) ** 2;
                if (d < bd) { bd = d; best = i; }
            }
            this.stageRoute.push(best);
            from = best;
        }
    },

    /** Маршрут без маркеров route-N: прямые между этапами, точка раз в ~300 px (боты будут чаще падать). */
    fallbackRoute() {
        const pts = this.stages;
        const out = [];
        for (let i = 0; i + 1 < pts.length; i++) {
            const a = pts[i], b = pts[i + 1];
            const L = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(1, Math.ceil(L / 300));
            const yaw = Math.atan2(b.z - a.z, b.x - a.x);
            for (let k = 0; k < n; k++) { const t = k / n; out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, yaw, s: 0.8, f: 1 }); }
        }
        if (pts.length) { const l = pts[pts.length - 1]; out.push({ x: l.x, y: l.y, z: l.z, yaw: l.yaw, s: 0.6, f: 1 }); }
        return out;
    },

    // ---------------------------------------------------------------------------------------------
    // Чекпоинты, спавн, возрождение (общее для игрока и ботов)
    // ---------------------------------------------------------------------------------------------

    /** Число этапов после старта: чекпоинты + финиш (если он есть). */
    stageCount() { return Math.max(0, this.stages.length - 1); },

    /** Номер этапа финиша (0, если финиша на карте нет). */
    finishStage() { return this.finish ? this.stages.length - 1 : 0; },

    /** Точка возрождения этапа n (0 — старт): чуть выше поверхности, курс чекпоинта. Нет этапа — старт. */
    respawn(n, out) {
        const s = this.stages[Math.max(0, Math.min(this.stages.length - 1, n | 0))] || { x: 0, y: 0, z: 0, yaw: 0 };
        const o = out || {};
        o.x = s.x; o.y = s.y + this.cfg().lift; o.z = s.z; o.yaw = s.yaw; o.n = s.n || 0;
        return o;
    },

    /**
     * Какой этап взят в точке (x, y, z), если сейчас взят stage: возвращает новый (≥ stage). Берётся любой дальний
     * чекпоинт, до которого дотянулись (по горизонтали не дальше r, по высоте — окно зоны); финиш — только когда взяты
     * все чекпоинты (strict = false снимает условие).
     */
    reached(x, y, z, stage, strict) {
        let best = stage | 0;
        const last = this.stages.length - 1;
        for (let n = best + 1; n <= last; n++) {
            const s = this.stages[n];
            if (n === last && this.finish && strict !== false && best < last - 1) continue;
            if (Math.hypot(x - s.x, z - s.z) <= s.r && y >= s.y - 120 && y <= s.y + s.vt) best = n;
        }
        return best;
    },

    /** Доля пройденного пути 0..1: по отрезкам между этапами (проекция точки на отрезок до следующего этапа). */
    progress(stage, x, y, z) {
        const st = this.stages;
        if (st.length < 2) return 0;
        const total = this.stageDist[st.length - 1] || 1;
        const n = Math.max(0, Math.min(st.length - 1, stage | 0));
        if (n >= st.length - 1) return 1;
        const a = st[n], b = st[n + 1];
        const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / L2));
        const seg = this.stageDist[n + 1] - this.stageDist[n];
        void y;
        return Math.max(0, Math.min(1, (this.stageDist[n] + seg * t) / total));
    },

    // ---------------------------------------------------------------------------------------------
    // Коллайдеры
    // ---------------------------------------------------------------------------------------------

    _collidersFor(p) {
        const hx = p.sx / 2, hz = p.sz / 2;
        const cfg = this.cfg();
        /** @type {any} */
        const base = { O: p.O.slice(), ax: p.ax.slice(), ay: p.ay.slice(), az: p.az.slice(), aabb: [0, 0, 0, 0, 0, 0] };
        const out = [];
        const add = (c) => { out.push(c); return c; };
        const ice = p.color === 'ice';
        switch (p.type) {
            case 'box': add({ ...base, kind: 'box', hx, hz, y0: -p.sy, y1: 0, ice }); break;
            case 'kill': case 'lava': case 'water': add({ ...base, kind: 'box', hx, hz, y0: -p.sy, y1: 0, kill: true, cause: p.type }); break;
            case 'cyl': add({ ...base, kind: 'cyl', rx: hx, rz: hz, y0: -p.sy, y1: 0, ice }); break;
            case 'ramp': add(this._wedgeCol({ ...base, kind: 'wedge', hx, hz, sy: p.sy, ice })); break;
            case 'arch': add(this._archCol({ ...base, kind: 'arch', hx, hz, sy: p.sy, ice })); break;
            case 'boost': add({ ...base, kind: 'box', hx, hz, y0: 0, y1: 5, boost: p.prm.v || cfg.boost }); break;
            case 'jump': add({ ...base, kind: 'cyl', rx: hx, rz: hz, y0: 0, y1: 14, jump: p.prm.v || cfg.bounce }); break;
            case 'pillar': add({ ...base, kind: 'box', hx, hz, y0: 0, y1: p.sy, wall: true }); break;
            case 'fence': add({ ...base, kind: 'box', hx, hz: 6, y0: 0, y1: 46, wall: true }); break;
            case 'spinner': {
                add({ ...base, kind: 'cyl', rx: 20, rz: 20, y0: 0, y1: p.sy + 26, wall: true });
                const t = Math.max(16, p.sz / 2);
                add({ ...base, kind: 'capsule', a: [0, 0, 0], b: [0, 0, 0], r: t, hazard: true, cause: 'trap', local: { a: [-hx, p.sy, 0], b: [hx, p.sy, 0] } });
                break;
            }
            case 'hammer': {
                add({ ...base, kind: 'capsule', a: [0, 0, 0], b: [0, 0, 0], r: 10, hazard: true, cause: 'trap', local: { a: [0, 0, 0], b: [0, -p.sy, 0] } });
                add({ ...base, kind: 'capsule', a: [0, 0, 0], b: [0, 0, 0], r: p.sx / 2, hazard: true, cause: 'trap', local: { a: [0, -p.sy, -Math.max(0, hz - hx)], b: [0, -p.sy, Math.max(0, hz - hx)] } });
                break;
            }
            case 'arrow': break;
            default: add({ ...base, kind: 'box', hx, hz, y0: -p.sy, y1: 0 });
        }
        for (const c of out) if (c.kind === 'capsule') this._capsuleWorld(c, p, 0);
        for (const c of out) this._aabb(c);
        return out;
    },

    _wedgeCol(c) {
        c.poly = [[-c.hx, 0], [c.hx, 0], [c.hx, c.sy]];
        return c;
    },

    // Горб: профиль — полуэллипс многоугольником (точная сфера-коллизия выпуклой призмы).
    _archCol(c) {
        const n = 32;
        // против часовой (вид с +Z): низ слева → низ справа → по холму справа налево
        c.poly = [[-c.hx, 0], [c.hx, 0]];
        for (let i = 1; i < n; i++) { const X = 1 - 2 * i / n; c.poly.push([X * c.hx, c.sy * (0.5 + 0.5 * Math.cos(Math.PI * X))]); }
        return c;
    },

    _capsuleWorld(c, p, angle) {
        const L = c.local;
        const ca = Math.cos(angle), sa = Math.sin(angle);
        const rot = (v) => {
            if (p.type === 'spinner') return [v[0] * ca + v[2] * sa, v[1], -v[0] * sa + v[2] * ca];   // вокруг локальной Y
            if (p.type === 'hammer') return [v[0], v[1] * ca - v[2] * sa, v[1] * sa + v[2] * ca];     // качание вокруг локальной X
            return v;
        };
        const w = (v) => { const q = rot(v); return [c.O[0] + q[0] * c.ax[0] + q[1] * c.ay[0] + q[2] * c.az[0], c.O[1] + q[0] * c.ax[1] + q[1] * c.ay[1] + q[2] * c.az[1], c.O[2] + q[0] * c.ax[2] + q[1] * c.ay[2] + q[2] * c.az[2]]; };
        c.a = w(L.a); c.b = w(L.b);
    },

    _aabb(c) {
        if (c.kind === 'capsule') {
            const r = c.r;
            c.aabb = [Math.min(c.a[0], c.b[0]) - r, Math.min(c.a[1], c.b[1]) - r, Math.min(c.a[2], c.b[2]) - r,
                Math.max(c.a[0], c.b[0]) + r, Math.max(c.a[1], c.b[1]) + r, Math.max(c.a[2], c.b[2]) + r];
            return;
        }
        let pts;
        if (c.kind === 'box') pts = this._corners(c.hx, c.y0, c.y1, c.hz);
        else if (c.kind === 'cyl') pts = this._corners(c.rx, c.y0, c.y1, c.rz);
        else pts = this._corners(c.hx, 0, c.sy, c.hz);
        const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        for (const q of pts) {
            const x = c.O[0] + q[0] * c.ax[0] + q[1] * c.ay[0] + q[2] * c.az[0];
            const y = c.O[1] + q[0] * c.ax[1] + q[1] * c.ay[1] + q[2] * c.az[1];
            const z = c.O[2] + q[0] * c.ax[2] + q[1] * c.ay[2] + q[2] * c.az[2];
            if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (z < bb[2]) bb[2] = z;
            if (x > bb[3]) bb[3] = x; if (y > bb[4]) bb[4] = y; if (z > bb[5]) bb[5] = z;
        }
        c.aabb = bb;
    },

    _corners(hx, y0, y1, hz) {
        const out = [];
        for (const x of [-hx, hx]) for (const y of [y0, y1]) for (const z of [-hz, hz]) out.push([x, y, z]);
        return out;
    },

    _insert(c) {
        const G = this.cfg().grid, bb = c.aabb;
        const x0 = Math.floor(bb[0] / G), x1 = Math.floor(bb[3] / G), z0 = Math.floor(bb[2] / G), z1 = Math.floor(bb[5] / G);
        for (let i = x0; i <= x1; i++) for (let k = z0; k <= z1; k++) {
            const key = i + ',' + k;
            let list = this.grid.get(key);
            if (!list) { list = []; this.grid.set(key, list); }
            list.push(c);
        }
    },

    /** Объём, который задевает подвижная деталь за весь период: запрос проверяет его раньше, чем позу. */
    _reach(p) {
        const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        const pose = { O: [0, 0, 0], ax: p.ax, ay: p.ay, az: p.az, angle: 0 };
        const N = 32;
        const T = this.period(p);
        for (let i = 0; i < N; i++) {
            this.poseAt(p, T * i / N, pose);
            for (const c of p.cols) {
                const save = { O: c.O, ax: c.ax, ay: c.ay, az: c.az };
                c.O = pose.O; c.ax = pose.ax; c.ay = pose.ay; c.az = pose.az;
                if (c.kind === 'capsule') this._capsuleWorld(c, p, pose.angle);
                this._aabb(c);
                for (let k = 0; k < 3; k++) { if (c.aabb[k] < bb[k]) bb[k] = c.aabb[k]; if (c.aabb[k + 3] > bb[k + 3]) bb[k + 3] = c.aabb[k + 3]; }
                c.O = save.O; c.ax = save.ax; c.ay = save.ay; c.az = save.az;
            }
        }
        const pad = 0.1 * Math.max(p.sx, p.sz) + 10;
        p.reach = [bb[0] - pad, bb[1] - pad, bb[2] - pad, bb[3] + pad, bb[4] + pad, bb[5] + pad];
        // исходное положение коллайдеров
        for (const c of p.cols) { if (c.kind === 'capsule') this._capsuleWorld(c, p, 0); this._aabb(c); }
    },

    /** Период движения детали, с (для выборки и предсказаний). */
    period(p) {
        const prm = p.prm;
        if (p.role === 'move') return Math.max(0.3, prm.t || 4);
        if (p.role === 'hammer') return Math.max(0.5, prm.t || 2.6);
        if (p.role === 'spin' || p.role === 'spinner') { const rate = Math.abs(this.spinRate(p)); return rate > 1e-6 ? 2 * Math.PI / rate : 4; }
        return 1;
    },

    /** Скорость вращения, рад/с (знак: положительная — против часовой, dir 'cw' и rpm < 0 — наоборот). */
    spinRate(p) {
        let rpm = p.prm.rpm != null ? p.prm.rpm : (p.anim && Number(p.anim.speed) > 0 ? Number(p.anim.speed) : 0);
        if (!rpm && (p.role === 'spinner' || p.role === 'spin')) rpm = 12;
        const sign = p.prm.rpm != null ? 1 : (p.anim && p.anim.dir === 'cw' ? -1 : 1);
        return rpm / 60 * Math.PI * 2 * sign;
    },

    // ---------------------------------------------------------------------------------------------
    // Движение деталей: поза — чистая функция времени (падающие плиты — ещё и состояние)
    // ---------------------------------------------------------------------------------------------

    /**
     * Поза подвижной детали в момент t: { O, ax, ay, az, angle } (angle — поворот балки spinner / молота hammer).
     * Падающая плита (fall) читает состояние, а не t. out — переиспользуемый объект.
     */
    poseAt(p, t, out) {
        const B = p.base || { O: p.O, ax: p.ax, ay: p.ay, az: p.az };
        const o = out || { O: null, ax: null, ay: null, az: null, angle: 0 };
        let O = B.O, ax = B.ax, ay = B.ay, az = B.az, angle = 0;
        const prm = p.prm;
        if (p.role === 'move') {
            const T = Math.max(0.3, prm.t || 4), s = Math.sin(2 * Math.PI * (t / T + (prm.ph || 0)));
            const dx = (prm.x || 0) * s, dy = (prm.y || 0) * s, dz = (prm.z || 0) * s;
            O = [O[0] + dx * ax[0] + dy * ay[0] + dz * az[0], O[1] + dx * ax[1] + dy * ay[1] + dz * az[1], O[2] + dx * ax[2] + dy * ay[2] + dz * az[2]];
        } else if (p.role === 'spin' || p.role === 'spinner') {
            angle = this.spinRate(p) * t;
            if (p.role === 'spin') {
                const ca = Math.cos(angle), sa = Math.sin(angle);
                const ry = (v) => [v[0] * ca + v[2] * sa, v[1], -v[0] * sa + v[2] * ca];   // вокруг мировой вертикали
                ax = ry(ax); ay = ry(ay); az = ry(az);
            }
        } else if (p.role === 'hammer') {
            const T = Math.max(0.5, prm.t || 2.6), A = (prm.a || 70) * Math.PI / 180;
            angle = A * Math.sin(2 * Math.PI * (t / T + (prm.ph || 0)));
        } else if (p.role === 'fall') {
            if (p.fallState === 'shake') {
                const k = Math.sin(this.time * 60) * 4;
                O = [O[0] + k, O[1], O[2] + k * 0.6];
            } else if (p.fallState === 'drop') O = [O[0], O[1] - p.fallDrop, O[2]];
        }
        o.O = O; o.ax = ax; o.ay = ay; o.az = az; o.angle = angle;
        return o;
    },

    _pose: null,

    // Привести коллайдеры детали к позе текущего кадра (лениво: только то, что сейчас спрашивают).
    _sync(p) {
        if (p._st === this._frame) return;
        p._st = this._frame;
        const pose = this._pose || (this._pose = { O: null, ax: null, ay: null, az: null, angle: 0 });
        this.poseAt(p, this.time, pose);
        p.pose = { O: pose.O, ax: pose.ax, ay: pose.ay, az: pose.az, angle: pose.angle };
        for (const c of p.cols) {
            c.O = pose.O; c.ax = pose.ax; c.ay = pose.ay; c.az = pose.az;
            if (c.kind === 'capsule') this._capsuleWorld(c, p, pose.angle);
            this._aabb(c);
        }
        if (p.role === 'fall') for (const c of p.cols) c.enabled = p.fallState !== 'drop' || p.fallDrop < 40;
    },

    /** Поза детали сейчас (для вида): { O, ax, ay, az, angle }. */
    current(p) { this._sync(p); return p.pose || { O: p.O, ax: p.ax, ay: p.ay, az: p.az, angle: 0 }; },

    /** Поставить время трассы (тесты, перемотка) — подвижные детали встают на свои позы этого момента. */
    setTime(t) { this.time = t; this._frame++; },

    /** Кадр: время идёт, падающие плиты дрожат и падают. dt ограничен 0.1 с. */
    update(dt) {
        dt = Math.min(0.1, Math.max(0, dt || 0));
        this._dt = dt > 0 ? dt : 1 / 60;
        this.time += dt;
        this._frame++;
        const cfg = this.cfg();
        for (const p of this.fallers) {
            if (p.fallState === 'idle') continue;
            p.fallT += dt;
            if (p.fallState === 'shake') {
                if (p.fallT >= (p.prm.d != null ? p.prm.d : cfg.fallShake)) { p.fallState = 'drop'; p.fallT = 0; p.fallVel = 0; p.fallDrop = 0; }
            } else if (p.fallState === 'drop') {
                p.fallVel += cfg.fallGravity * dt; p.fallDrop += p.fallVel * dt;
                if (p.fallT >= (p.prm.r != null ? p.prm.r : cfg.fallReturn)) { p.fallState = 'idle'; p.fallT = 0; p.fallDrop = 0; p.fallVel = 0; }
            }
        }
    },

    /** Деталям вернуться в начальное состояние (падающие плиты на месте, время 0) — новый заход. */
    reset() {
        this.time = 0;
        for (const p of this.fallers) { p.fallState = 'idle'; p.fallT = 0; p.fallDrop = 0; p.fallVel = 0; }
        this._frame++;
    },

    /** Касание опоры: падающая плита начинает дрожать. Зовёт тело, стоящее на коллайдере (ObbyBody делает это сам). */
    touch(c) {
        const p = c && c.piece;
        if (p && p.role === 'fall' && p.fallState === 'idle') { p.fallState = 'shake'; p.fallT = 0; this._frame++; }
    },

    // ---------------------------------------------------------------------------------------------
    // Выбор коллайдеров рядом
    // ---------------------------------------------------------------------------------------------

    /** Коллайдеры рядом с прямоугольником [x0..x1]×[z0..z1]: статика из сетки + подвижные (с позой этого кадра). */
    _near(x0, z0, x1, z1, out) {
        const G = this.cfg().grid;
        const stamp = ++this._stamp;
        out.length = 0;
        for (let i = Math.floor(x0 / G); i <= Math.floor(x1 / G); i++) for (let k = Math.floor(z0 / G); k <= Math.floor(z1 / G); k++) {
            const list = this.grid.get(i + ',' + k);
            if (!list) continue;
            for (const c of list) { if (c._s === stamp) continue; c._s = stamp; if (c.enabled !== false) out.push(c); }
        }
        for (const p of this.dynamicPieces) {
            const r = p.reach;
            if (r[3] < x0 || r[0] > x1 || r[5] < z0 || r[2] > z1) continue;
            this._sync(p);
            for (const c of p.cols) if (c.enabled && c.aabb[3] >= x0 && c.aabb[0] <= x1 && c.aabb[5] >= z0 && c.aabb[2] <= z1) out.push(c);
        }
        return out;
    },

    // ---------------------------------------------------------------------------------------------
    // Запросы физики (мир Babylon: x, y вверх, z)
    // ---------------------------------------------------------------------------------------------

    /**
     * Луч вниз из (x, y, z) на maxDist: самая высокая опора ниже точки. Стены (крутые грани, normal.y < minNy) и
     * капсулы-ловушки пропускаются; noKill — лава и вода не опора. → { y, n: [x, y, z], col, t } | null
     */
    rayDown(x, y, z, maxDist, minNy, noKill) {
        const list = this._near(x - 1, z - 1, x + 1, z + 1, this._tmp);
        let best = null;
        const lim = minNy == null ? 0.45 : minNy;
        for (const c of list) {
            if (!c.enabled || c.kind === 'capsule' || c.zone || (noKill && c.kill)) continue;
            const bb = c.aabb;
            if (x < bb[0] || x > bb[3] || z < bb[2] || z > bb[5] || bb[1] > y || bb[4] < y - maxDist) continue;
            const h = this._rayLocal(c, x, y, z, 0, -1, 0, maxDist);
            if (!h || h.n[1] < lim) continue;
            if (!best || h.t < best.t) { best = h; best.col = c; }
        }
        if (best) best.y = y - best.t;
        return best;
    },

    /**
     * Высота опоры под точкой (x, z): луч вниз от fromY на maxDrop. Число | null. Запрос земли для контроллера персонажа.
     * Опасные и убивающие детали (лава, вода) — не земля.
     */
    groundAt(x, z, fromY, maxDrop, minNy) {
        const list = this._near(x - 1, z - 1, x + 1, z + 1, this._tmp);
        const md = maxDrop == null ? 1e6 : maxDrop;
        const lim = minNy == null ? 0.45 : minNy;
        let best = null;
        for (const c of list) {
            if (!c.enabled || c.kind === 'capsule' || c.kill) continue;
            const bb = c.aabb;
            if (x < bb[0] || x > bb[3] || z < bb[2] || z > bb[5] || bb[1] > fromY || bb[4] < fromY - md) continue;
            const h = this._rayLocal(c, x, fromY, z, 0, -1, 0, md);
            if (!h || h.n[1] < lim) continue;
            if (best == null || h.t < best) best = h.t;
        }
        return best == null ? null : fromY - best;
    },

    /** Луч (единичное направление) до maxT: ближайшее твёрдое тело (камера не уходит сквозь плиты). → { t, n, col } | null */
    ray(ox, oy, oz, dx, dy, dz, maxT) {
        const ex = ox + dx * maxT, ez = oz + dz * maxT;
        const list = this._near(Math.min(ox, ex), Math.min(oz, ez), Math.max(ox, ex), Math.max(oz, ez), this._tmp);
        let best = null;
        for (const c of list) {
            if (!c.enabled || c.kind === 'capsule' || c.kill) continue;
            const h = this._rayLocal(c, ox, oy, oz, dx, dy, dz, maxT);
            if (h && (!best || h.t < best.t)) { best = h; best.col = c; }
        }
        return best;
    },

    _rayLocal(c, wx, wy, wz, dx, dy, dz, maxT) {
        const px = wx - c.O[0], py = wy - c.O[1], pz = wz - c.O[2];
        const o = [px * c.ax[0] + py * c.ax[1] + pz * c.ax[2], px * c.ay[0] + py * c.ay[1] + pz * c.ay[2], px * c.az[0] + py * c.az[1] + pz * c.az[2]];
        const d = [dx * c.ax[0] + dy * c.ax[1] + dz * c.ax[2], dx * c.ay[0] + dy * c.ay[1] + dz * c.ay[2], dx * c.az[0] + dy * c.az[1] + dz * c.az[2]];
        let hit = null;
        if (c.kind === 'box') hit = this._rayBox(o, d, c.hx, c.y0, c.y1, c.hz);
        else if (c.kind === 'cyl') hit = this._rayCyl(o, d, c.rx, c.rz, c.y0, c.y1);
        else if (c.kind === 'wedge' || c.kind === 'arch') hit = this._rayPrism(o, d, c.poly, c.hz, c.kind === 'arch');
        if (!hit || hit.t < 0 || hit.t > maxT) return null;
        const n = hit.n;
        hit.n = [n[0] * c.ax[0] + n[1] * c.ay[0] + n[2] * c.az[0], n[0] * c.ax[1] + n[1] * c.ay[1] + n[2] * c.az[1], n[0] * c.ax[2] + n[1] * c.ay[2] + n[2] * c.az[2]];
        return hit;
    },

    _rayBox(o, d, hx, y0, y1, hz) {
        let tin = -Infinity, tout = Infinity, axis = -1, sign = 0;
        const lo = [-hx, y0, -hz], hi = [hx, y1, hz];
        for (let i = 0; i < 3; i++) {
            if (Math.abs(d[i]) < 1e-9) { if (o[i] < lo[i] || o[i] > hi[i]) return null; continue; }
            let t1 = (lo[i] - o[i]) / d[i], t2 = (hi[i] - o[i]) / d[i], s = -1;
            if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
            if (t1 > tin) { tin = t1; axis = i; sign = s; }
            if (t2 < tout) tout = t2;
            if (tin > tout) return null;
        }
        if (tin < 0 || axis < 0) return null;   // старт внутри — не опора
        const n = [0, 0, 0];
        n[axis] = sign;
        return { t: tin, n };
    },

    _rayCyl(o, d, rx, rz, y0, y1) {
        const ox = o[0] / rx, oz = o[2] / rz, dx = d[0] / rx, dz = d[2] / rz;
        let tin = -Infinity, tout = Infinity, cap = false, capSign = 0;
        const a = dx * dx + dz * dz;
        if (a < 1e-12) { if (ox * ox + oz * oz > 1) return null; }
        else {
            const b = 2 * (ox * dx + oz * dz), c = ox * ox + oz * oz - 1, disc = b * b - 4 * a * c;
            if (disc < 0) return null;
            const s = Math.sqrt(disc);
            tin = (-b - s) / (2 * a); tout = (-b + s) / (2 * a);
        }
        if (Math.abs(d[1]) < 1e-9) { if (o[1] < y0 || o[1] > y1) return null; }
        else {
            let t1 = (y0 - o[1]) / d[1], t2 = (y1 - o[1]) / d[1], s = -1;
            if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
            if (t1 > tin) { tin = t1; cap = true; capSign = s; }
            if (t2 < tout) tout = t2;
        }
        if (tin > tout || tin < 0) return null;
        if (cap) return { t: tin, n: [0, capSign, 0] };
        const hx = o[0] + d[0] * tin, hz = o[2] + d[2] * tin;
        const nx = hx / (rx * rx), nz = hz / (rz * rz), l = Math.hypot(nx, nz) || 1;
        return { t: tin, n: [nx / l, 0, nz / l] };
    },

    // Точка в многоугольнике (чётность пересечений; годится и для невыпуклого).
    _inPoly(poly, x, y) {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const a = poly[i], b = poly[j];
            if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
        }
        return inside;
    },

    _edgeN(a, b) { const ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey) || 1; return [ey / l, -ex / l]; },

    // Луч против призмы (невыпуклой тоже): вход через боковой контур или торец Z. Старт внутри — не опора.
    _rayPrism(o, d, poly, hz, smooth) {
        let tz0 = -Infinity, tz1 = Infinity;
        if (Math.abs(d[2]) < 1e-9) { if (Math.abs(o[2]) > hz) return null; }
        else { tz0 = (-hz - o[2]) / d[2]; tz1 = (hz - o[2]) / d[2]; if (tz0 > tz1) { const t = tz0; tz0 = tz1; tz1 = t; } }
        if (Math.abs(o[2]) <= hz && this._inPoly(poly, o[0], o[1])) return null;
        let bestT = Infinity, bestN = null;
        const n = poly.length;
        for (let i = 0; i < n; i++) {
            const a = poly[i], b = poly[(i + 1) % n];
            const ex = b[0] - a[0], ey = b[1] - a[1];
            const den = d[0] * ey - d[1] * ex;
            if (Math.abs(den) < 1e-12) continue;
            const t = ((a[0] - o[0]) * ey - (a[1] - o[1]) * ex) / den;
            const u = ((a[0] - o[0]) * d[1] - (a[1] - o[1]) * d[0]) / den;
            if (u < 0 || u > 1 || t < 0 || t >= bestT || t < tz0 || t > tz1) continue;
            const l = Math.hypot(ex, ey) || 1, nx = ey / l, ny = -ex / l;
            if (nx * d[0] + ny * d[1] >= 0) continue;          // выход, а не вход
            if (!smooth) { bestT = t; bestN = [nx, ny, 0]; continue; }   // клин: грани острые — нормаль грани как есть
            // нормаль сглажена между соседними рёбрами (холм без «граней» под ногами)
            const pa = poly[(i - 1 + n) % n], pb = poly[(i + 2) % n];
            const na = this._edgeN(pa, a), nb = this._edgeN(b, pb);
            const va = [(na[0] + nx) / 2, (na[1] + ny) / 2], vb = [(nb[0] + nx) / 2, (nb[1] + ny) / 2];
            let sx = va[0] + (vb[0] - va[0]) * u, sy = va[1] + (vb[1] - va[1]) * u;
            const sl = Math.hypot(sx, sy) || 1;
            sx /= sl; sy /= sl;
            if (sx * nx + sy * ny < 0.7) { sx = nx; sy = ny; }   // острый угол — без сглаживания
            bestT = t; bestN = [sx, sy, 0];
        }
        if (tz0 > 0 && tz0 < bestT) {
            const x = o[0] + d[0] * tz0, y = o[1] + d[1] * tz0;
            if (this._inPoly(poly, x, y)) { bestT = tz0; bestN = [0, 0, d[2] > 0 ? -1 : 1]; }
        }
        return bestN ? { t: bestT, n: bestN } : null;
    },

    // Сфера против призмы: многоугольник poly в плоскости XY (против часовой), вытянут по Z на ±hz.
    _prismHit(poly, hz, o, r) {
        const n = poly.length;
        let best = Infinity, bq = null, bn = null;
        for (let i = 0; i < n; i++) {
            const a = poly[i], b = poly[(i + 1) % n];
            const ex = b[0] - a[0], ey = b[1] - a[1];
            const l2 = ex * ex + ey * ey || 1;
            let t = ((o[0] - a[0]) * ex + (o[1] - a[1]) * ey) / l2;
            t = Math.max(0, Math.min(1, t));
            const qx = a[0] + ex * t, qy = a[1] + ey * t;
            const d = (o[0] - qx) * (o[0] - qx) + (o[1] - qy) * (o[1] - qy);
            if (d < best) { best = d; bq = [qx, qy]; const l = Math.sqrt(l2); bn = [ey / l, -ex / l]; }
        }
        const inside = this._inPoly(poly, o[0], o[1]);
        const z = o[2];
        if (inside && Math.abs(z) <= hz) {
            const dz = hz - Math.abs(z), de = Math.sqrt(best);
            if (dz < de) return { depth: r + dz, nl: [0, 0, z >= 0 ? 1 : -1], q: [o[0], o[1], z >= 0 ? hz : -hz] };
            return { depth: r + de, nl: [bn[0], bn[1], 0], q: [bq[0], bq[1], z] };
        }
        const q = inside ? [o[0], o[1], z >= 0 ? hz : -hz] : [bq[0], bq[1], Math.max(-hz, Math.min(hz, z))];
        const dx = o[0] - q[0], dy = o[1] - q[1], dzz = o[2] - q[2];
        const dd = Math.hypot(dx, dy, dzz);
        if (dd >= r || dd < 1e-6) return null;
        return { depth: r - dd, nl: [dx / dd, dy / dd, dzz / dd], q };
    },

    /**
     * Сфера (x, y, z, r) против коллайдеров рядом: fn(контакт) на каждое касание.
     * Контакт: { col, depth, n: [x, y, z] (от коллайдера к сфере), q: [x, y, z] (ближайшая точка) }.
     */
    sphere(x, y, z, r, fn) {
        const list = this._near(x - r, z - r, x + r, z + r, this._tmp).slice();
        for (const c of list) {
            if (!c.enabled) continue;
            const bb = c.aabb;
            if (x + r < bb[0] || x - r > bb[3] || y + r < bb[1] || y - r > bb[4] || z + r < bb[2] || z - r > bb[5]) continue;
            const h = this._sphereCol(c, x, y, z, r);
            if (h) { h.col = c; fn(h); }
        }
    },

    _sphereCol(c, x, y, z, r) {
        if (c.kind === 'capsule') {
            const a = c.a, b = c.b;
            const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
            const L2 = abx * abx + aby * aby + abz * abz;
            let t = L2 > 1e-9 ? ((x - a[0]) * abx + (y - a[1]) * aby + (z - a[2]) * abz) / L2 : 0;
            t = Math.max(0, Math.min(1, t));
            const q = [a[0] + abx * t, a[1] + aby * t, a[2] + abz * t];
            const dx = x - q[0], dy = y - q[1], dz = z - q[2], dd = Math.hypot(dx, dy, dz);
            if (dd >= r + c.r) return null;
            const n = dd > 1e-6 ? [dx / dd, dy / dd, dz / dd] : [0, 1, 0];
            return { depth: r + c.r - dd, n, q: [q[0] + n[0] * c.r, q[1] + n[1] * c.r, q[2] + n[2] * c.r] };
        }
        const px = x - c.O[0], py = y - c.O[1], pz = z - c.O[2];
        const o = [px * c.ax[0] + py * c.ax[1] + pz * c.ax[2], px * c.ay[0] + py * c.ay[1] + pz * c.ay[2], px * c.az[0] + py * c.az[1] + pz * c.az[2]];
        let q = null, nl = null, depth = 0;
        if (c.kind === 'box' || c.kind === 'cyl') {
            const isBox = c.kind === 'box';
            const y0 = c.y0, y1 = c.y1;
            if (isBox) {
                q = [Math.max(-c.hx, Math.min(c.hx, o[0])), Math.max(y0, Math.min(y1, o[1])), Math.max(-c.hz, Math.min(c.hz, o[2]))];
            } else {
                const rr = Math.hypot(o[0] / c.rx, o[2] / c.rz);
                const k = rr > 1 ? 1 / rr : 1;
                q = [o[0] * k, Math.max(y0, Math.min(y1, o[1])), o[2] * k];
            }
            const dx = o[0] - q[0], dy = o[1] - q[1], dz = o[2] - q[2], dd = Math.hypot(dx, dy, dz);
            if (dd > 1e-6) {
                if (dd >= r) return null;
                nl = [dx / dd, dy / dd, dz / dd]; depth = r - dd;
            } else {   // центр внутри: выталкивать через ближайшую грань
                const faces = isBox
                    ? [[c.hx - o[0], [1, 0, 0]], [o[0] + c.hx, [-1, 0, 0]], [y1 - o[1], [0, 1, 0]], [o[1] - y0, [0, -1, 0]], [c.hz - o[2], [0, 0, 1]], [o[2] + c.hz, [0, 0, -1]]]
                    : [[y1 - o[1], [0, 1, 0]], [o[1] - y0, [0, -1, 0]], [(1 - Math.hypot(o[0] / c.rx, o[2] / c.rz)) * Math.min(c.rx, c.rz), (() => { const l = Math.hypot(o[0], o[2]) || 1; return [o[0] / l, 0, o[2] / l]; })()]];
                faces.sort((a, b) => a[0] - b[0]);
                nl = faces[0][1]; depth = faces[0][0] + r;
            }
        } else {
            const h = this._prismHit(c.poly, c.hz, o, r);
            if (!h) return null;
            nl = h.nl; depth = h.depth; q = h.q;
        }
        const n = [nl[0] * c.ax[0] + nl[1] * c.ay[0] + nl[2] * c.az[0], nl[0] * c.ax[1] + nl[1] * c.ay[1] + nl[2] * c.az[1], nl[0] * c.ax[2] + nl[1] * c.ay[2] + nl[2] * c.az[2]];
        const qw = [c.O[0] + q[0] * c.ax[0] + q[1] * c.ay[0] + q[2] * c.az[0], c.O[1] + q[0] * c.ax[1] + q[1] * c.ay[1] + q[2] * c.az[1], c.O[2] + q[0] * c.ax[2] + q[1] * c.ay[2] + q[2] * c.az[2]];
        return { depth, n, q: qw };
    },

    /**
     * Капсула (отрезок a→b, радиус r) против коллайдеров: сферы вдоль оси, fn(контакт) — по одному, самому глубокому, на коллайдер.
     */
    capsule(ax, ay, az, bx, by, bz, r, fn) {
        const len = Math.hypot(bx - ax, by - ay, bz - az);
        const n = Math.max(1, Math.ceil(len / (r * 0.8)));
        /** @type {Map<any, any>} */
        const best = new Map();
        for (let i = 0; i <= n; i++) {
            const t = i / n;
            this.sphere(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t, r, (h) => {
                const was = best.get(h.col);
                if (!was || h.depth > was.depth) best.set(h.col, h);
            });
        }
        for (const h of best.values()) fn(h);
    },

    /**
     * Вытолкнуть вертикальную капсулу (ноги в (x, y, z), радиус r, рост h) из твёрдых деталей: до 4 проходов.
     * Опасные и убивающие детали не толкают. → out { x, y, z, moved, up: опора под ногами по нормали, col: опора }.
     */
    pushOut(x, y, z, r, h, out) {
        const o = out || { x: 0, y: 0, z: 0, moved: false, up: false, col: null };
        let px = x, py = y, pz = z, moved = false, up = false, col = null;
        for (let it = 0; it < 4; it++) {
            let any = false;
            this.capsule(px, py + r, pz, px, py + Math.max(r, h - r), pz, r, (c) => {
                if (c.col.kill || c.col.hazard || c.col.boost || c.col.jump) return;
                const k = c.depth + 0.01;
                px += c.n[0] * k; py += c.n[1] * k; pz += c.n[2] * k;
                any = true; moved = true;
                if (c.n[1] > 0.6) { up = true; col = c.col; }
            });
            if (!any) break;
        }
        o.x = px; o.y = py; o.z = pz; o.moved = moved; o.up = up; o.col = col;
        return o;
    },

    // ---------------------------------------------------------------------------------------------
    // Опасности
    // ---------------------------------------------------------------------------------------------

    /**
     * Что убивает: убивающая деталь или объём, капсула-ловушка (spinner, hammer), ниже killY или в воде (waterAt).
     * → { cause: 'lava' | 'water' | 'kill' | 'trap' | 'void', col?, n?, depth? } | null.
     * Без h — сфера (x, y, z) радиуса r, y — её центр. С h — вертикальное тело: ноги в (x, y, z), радиус r, рост h
     * (низкая балка у самых ног тоже задевает).
     */
    hazardAt(x, y, z, r, h) {
        const body = h != null;
        const low = body ? y : y - r;
        if (low < this.killY) return { cause: 'void', col: null, n: [0, 1, 0] };
        let hit = null;
        const visit = (k) => {
            const c = k.col;
            if (!(c.kill || c.hazard)) return;
            if (!hit || k.depth > hit.depth) hit = { cause: c.cause || (c.kill ? 'kill' : 'trap'), col: c, n: k.n, depth: k.depth };
        };
        if (body) this.capsule(x, y + r, z, x, y + Math.max(r, h - r), z, r, visit);
        else this.sphere(x, y, z, r, visit);
        if (hit) return hit;
        if (this.waterAt) {
            const w = this.waterAt(x, z);
            if (w != null && low < w - 8) return { cause: 'water', col: null, n: [0, 1, 0] };
        }
        return null;
    },

    /** Причина смерти или null (см. hazardAt; h — рост, если (x, y, z) — ноги). */
    killCause(x, y, z, r, h) { const k = this.hazardAt(x, y, z, r, h); return k ? k.cause : null; },

    /**
     * Куда унесёт точку q (мир), закреплённую на коллайдере c в момент t0, к моменту t1: смещение [dx, dy, dz], px.
     * Точное по позам (вращающийся диск не «раздувается» хордами). Статика — нули; падающая плита — скорость падения.
     */
    carry(c, q, t0, t1) {
        if (!c || !c.dynamic || !c.piece) return [0, 0, 0];
        const p = c.piece;
        if (p.role === 'fall') return [0, p.fallState === 'drop' ? -(p.fallVel * (t1 - t0)) : 0, 0];
        const a = this.poseAt(p, t0, {}), b = this.poseAt(p, t1, {});
        // точка в осях позы t0 -> в мир позы t1
        const px = q[0] - a.O[0], py = q[1] - a.O[1], pz = q[2] - a.O[2];
        const lx = px * a.ax[0] + py * a.ax[1] + pz * a.ax[2], ly = px * a.ay[0] + py * a.ay[1] + pz * a.ay[2], lz = px * a.az[0] + py * a.az[1] + pz * a.az[2];
        return [b.O[0] + lx * b.ax[0] + ly * b.ay[0] + lz * b.az[0] - q[0], b.O[1] + lx * b.ax[1] + ly * b.ay[1] + lz * b.az[1] - q[1], b.O[2] + lx * b.ax[2] + ly * b.ay[2] + lz * b.az[2] - q[2]];
    },

    /** Смещение точки q (мир), закреплённой на коллайдере c, за последний кадр, px — «опора унесла». [0,0,0] у статики. */
    pointDelta(c, q) { return this.carry(c, q, this.time - this._dt, this.time); },

    // ---------------------------------------------------------------------------------------------
    // Предсказания по времени (боты ждут вертушку и плиту): чистые функции, состояния не трогают
    // ---------------------------------------------------------------------------------------------

    /** Капсулы-ловушки детали (spinner, hammer) в момент t: [{ a, b, r }] в мире. */
    capsulesAt(p, t) {
        const pose = this.poseAt(p, t, {}), out = [];
        for (const c of p.cols) {
            if (c.kind !== 'capsule') continue;
            const tmp = { O: pose.O, ax: pose.ax, ay: pose.ay, az: pose.az, local: c.local, a: null, b: null };
            this._capsuleWorld(tmp, p, pose.angle);
            out.push({ a: tmp.a, b: tmp.b, r: c.r });
        }
        return out;
    },

    /** Капсулы-ловушки задевают вертикальное тело (ноги в (x, y, z), радиус r, рост h) в момент t. margin — запас, px. */
    trapHits(p, t, x, y, z, r, h, margin) {
        const m = margin || 0;
        for (const c of this.capsulesAt(p, t)) {
            if (Math.max(c.a[1], c.b[1]) + c.r < y || Math.min(c.a[1], c.b[1]) - c.r > y + h) continue;
            const abx = c.b[0] - c.a[0], abz = c.b[2] - c.a[2], L2 = abx * abx + abz * abz;
            const k = L2 > 1e-9 ? Math.max(0, Math.min(1, ((x - c.a[0]) * abx + (z - c.a[2]) * abz) / L2)) : 0;
            if (Math.hypot(x - (c.a[0] + abx * k), z - (c.a[2] + abz * k)) < c.r + r + m) return true;
        }
        return false;
    },

    /** Верх горизонтальной плиты (box / cyl) p в позе pose накрывает точку (x, z) с запасом margin. */
    coversPose(p, pose, x, z, margin) {
        const c = p.cols[0];
        if (!c || (c.kind !== 'box' && c.kind !== 'cyl')) return false;
        const m = margin || 0, px = x - pose.O[0], pz = z - pose.O[2];
        const lx = px * pose.ax[0] + pz * pose.ax[2], lz = px * pose.az[0] + pz * pose.az[2];
        if (c.kind === 'box') return Math.abs(lx) <= c.hx + m && Math.abs(lz) <= c.hz + m;
        const a = lx / (c.rx + m), b = lz / (c.rz + m);
        return a * a + b * b <= 1;
    },

    /** Плита p в момент t накрывает точку (x, z) (по горизонтали, с запасом margin). */
    coversAt(p, t, x, z, margin) { return this.coversPose(p, this.poseAt(p, t, {}), x, z, margin); },

    /** Базовая поза подвижной детали (всё в нуле: ни смещения, ни поворота). */
    basePose(p) { return { O: p.base.O, ax: p.base.ax, ay: p.base.ay, az: p.base.az, angle: 0 }; },

    /** Точка q, лежащая на детали p в БАЗОВОЙ позе, где окажется в момент t (маршрут ботов задан по базовой позе). */
    fromBase(p, q, t) {
        const a = this.basePose(p), b = this.poseAt(p, t, {});
        const px = q[0] - a.O[0], py = q[1] - a.O[1], pz = q[2] - a.O[2];
        const lx = px * a.ax[0] + py * a.ax[1] + pz * a.ax[2], ly = px * a.ay[0] + py * a.ay[1] + pz * a.ay[2], lz = px * a.az[0] + py * a.az[1] + pz * a.az[2];
        return [b.O[0] + lx * b.ax[0] + ly * b.ay[0] + lz * b.az[0], b.O[1] + lx * b.ax[1] + ly * b.ay[1] + lz * b.az[1], b.O[2] + lx * b.ax[2] + ly * b.ay[2] + lz * b.az[2]];
    },

    /** Скорость точки коллайдера, px/с (подвижные детали несут героя и бьют молотом). */
    pointVel(c, q) {
        const d = this.pointDelta(c, q);
        const inv = 1 / Math.max(1e-4, this._dt);
        return [d[0] * inv, d[1] * inv, d[2] * inv];
    },

    /** Угловая скорость вращающейся опоры вокруг вертикали, рад/с (поворот героя на диске). */
    yawRate(c) { const p = c && c.piece; return p && p.role === 'spin' ? this.spinRate(p) : 0; },
};
