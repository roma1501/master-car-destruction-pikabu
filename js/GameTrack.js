// GameTrack.js — как выглядят детали трассы и что на ней стоит. Земля, дороги, небо и предметы — GameWorld, GameWorldView и GameProps
// (Track.build зовёт их одной строкой: данные, вид и предметы карты). Логика трассы — ObbyCourse (коллайдеры, движение, этапы); здесь
// только вид деталей: асфальт сверху, красно-белые бортики по кромкам, бетонные бока; сегменты одной дуги или петли (arc=N) рисуются
// одной гладкой лентой (физика — бруски); трамплины со шевронами, ускорители, катящиеся шины (модель props/tire.glb), вертушки и
// молоты; ворота чекпоинтов и финиша (props/*_gate.glb), разметка старта и решётки, парящий подиум гаража.
// Параметры деталей в имени объекта карты: hide=1 — невидимый коллайдер (стены зданий, настил моста), model=<id> — вместо плиты рисуется
// модель из таблицы TRACK_MODELS (начало модели — центр низа бруска, курс бруска; ms=число — масштаб). Решений вид не принимает (инвариант 4).

const TRACK_CURB = 70;            // px: ширина бортика на кромке
const TRACK_CURB_STRIPE = 180;    // px: длина полосы бортика
const TRACK_TILE = 900;           // px: повтор текстуры асфальта
const TRACK_PAINT_ZOFF = 20;      // сдвиг глубины краски старта, ускорителей и полос на дороге (больше, чем у лент WorldRoads)
const TRACK_MODEL_CHUNK = 24000;  // px: пачка неподвижных моделей (thin instances модель × участок 240 м)
const TRACK_MODEL_DRAW = 140000;  // px: дальше пачка маленьких моделей не рисуется (высокие — до дальней плоскости)
const TRACK_PODIUM_CLEAR = 3200;  // px: сколько свободного места хотим вокруг подиума меню (камера отъезжает далеко)
const TRACK_PODIUM_SEARCH = 36000; // px: как далеко от старта его искать
const TRACK_LOD_MIN = 15000;      // px: ближе всегда подробная модель
const TRACK_LOD_MAX = 24000;      // px: дальше подробных моделей нет (коробки)
const TRACK_LOD_K = 8;           // дальность подробной модели в её радиусах
const TRACK_LOD_HORIZON_R = 3000; // px: модель шире этого радиуса — часть горизонта, рисуется на всю дальность
const TRACK_LOD_FAR = 90000;      // px: дальше обычные модели не рисуются
const TRACK_LOD_FAR_TALL = 320000; // px: высокие (здания, скалы) видно до горизонта

/** Модели для деталей с model=<id>: пути литералами (сборщик архива берёт файл по ссылке). Игра и карты дописывают свои. */
const TRACK_MODELS = {
    building_1: 'assets/models/props/building_1.glb', building_2: 'assets/models/props/building_2.glb',
    building_3: 'assets/models/props/building_3.glb', building_4: 'assets/models/props/building_4.glb',
    turbine: 'assets/models/props/turbine.glb', 
    crash_wall: 'assets/models/props/crash_wall.glb', jump_ramp: 'assets/models/props/jump_ramp.glb', container_red: 'assets/models/props/container_red.glb',
    container_blue: 'assets/models/props/container_blue.glb', container_green: 'assets/models/props/container_green.glb', wrecking_ball: 'assets/models/props/wrecking_ball.glb',
    hangar: 'assets/models/props/hangar.glb', control_tower: 'assets/models/props/control_tower.glb', grandstand: 'assets/models/props/grandstand.glb',
    tire_wall: 'assets/models/props/tire_wall.glb', building_a: 'assets/models/props/building_a.glb', building_b: 'assets/models/props/building_b.glb',
    building_c: 'assets/models/props/building_c.glb', building_d: 'assets/models/props/building_d.glb', building_e: 'assets/models/props/building_e.glb',
    building_f: 'assets/models/props/building_f.glb', bus_stop: 'assets/models/props/bus_stop.glb', gas_station: 'assets/models/props/gas_station.glb',
    billboard: 'assets/models/props/billboard.glb', overpass_span: 'assets/models/props/overpass_span.glb', 
    rock_a: 'assets/models/props/rock_a.glb', rock_b: 'assets/models/props/rock_b.glb', rock_c: 'assets/models/props/rock_c.glb',
    pine_a: 'assets/models/props/pine_a.glb', pine_b: 'assets/models/props/pine_b.glb', tree_a: 'assets/models/props/tree_a.glb',
    bush_a: 'assets/models/props/bush_a.glb', cactus_a: 'assets/models/props/cactus_a.glb', dry_bush: 'assets/models/props/dry_bush.glb',
    palm_small: 'assets/models/props/palm_small.glb', wreck_a: 'assets/models/props/wreck_a.glb', wreck_b: 'assets/models/props/wreck_b.glb',
    wreck_stack: 'assets/models/props/wreck_stack.glb', scrap_pile: 'assets/models/props/scrap_pile.glb', crane_arm: 'assets/models/props/crane_arm.glb',
    rock_arch: 'assets/models/props/rock_arch.glb', cliff_a: 'assets/models/props/cliff_a.glb',
    cliff_b: 'assets/models/props/cliff_b.glb', mesa_a: 'assets/models/props/mesa_a.glb',
    cliff_grey: 'assets/models/props/cliff_grey.glb', snow_rock: 'assets/models/props/snow_rock.glb',
    avalanche_gallery: 'assets/models/props/avalanche_gallery.glb', wood_cabin: 'assets/models/props/wood_cabin.glb',
    pine_c: 'assets/models/props/pine_c.glb', tree_b: 'assets/models/props/tree_b.glb',
    tree_c: 'assets/models/props/tree_c.glb', grass_tuft: 'assets/models/props/grass_tuft.glb',
    flower_tuft: 'assets/models/props/flower_tuft.glb', fern_a: 'assets/models/props/fern_a.glb',
    house_a: 'assets/models/props/house_a.glb', house_b: 'assets/models/props/house_b.glb',
    barn: 'assets/models/props/barn.glb', silo: 'assets/models/props/silo.glb',
    power_wires: 'assets/models/props/power_wires.glb', billboard_b: 'assets/models/props/billboard_b.glb',
    highway_sign: 'assets/models/props/highway_sign.glb', toll_booth: 'assets/models/props/toll_booth.glb',
    fountain: 'assets/models/props/fountain.glb', kiosk: 'assets/models/props/kiosk.glb',
    scaffold: 'assets/models/props/scaffold.glb', crash_gantry: 'assets/models/props/crash_gantry.glb',
    sled_rail: 'assets/models/props/sled_rail.glb', barrier_stack: 'assets/models/props/barrier_stack.glb',
    lab_building: 'assets/models/props/lab_building.glb', light_mast: 'assets/models/props/light_mast.glb',
    tire_pile: 'assets/models/props/tire_pile.glb', chain_fence: 'assets/models/props/chain_fence.glb',
    oil_tank: 'assets/models/props/oil_tank.glb', derby_barrier: 'assets/models/props/derby_barrier.glb',
    arena_light: 'assets/models/props/arena_light.glb',
};

/** @satisfies {Record<string, any>} */
const Track = {
    /** @type {any} */ app: null,
    /** @type {any} */ view: null,
    /** @type {any[]} */ meshes: [],
    /** @type {any[]} */ nodes: [],
    /** @type {any[]} */ gates: [],
    /** Пачки маленьких моделей: дальше TRACK_MODEL_DRAW не рисуются. @type {any[]} */ farCull: [],
    /** Модели карты с уровнями подробности. @type {any[]} */ lods: [],
    _lodT: 0,
    _cullT: 0,
    /** @type {Record<string, any>} */ mats: {},
    /** @type {any} */ podium: null,
    /** @type {any} */ garage: null,
    _stage: 0,
    time: 0,

    // ---------------------------------------------------------------------------------------------
    // Постройка (под экраном загрузки уровня; ObbyCourse.build уже вызван)
    // ---------------------------------------------------------------------------------------------

    /**
     * Под экраном загрузки уровня (ObbyCourse.build уже вызван): мир карты (данные, рельеф, дороги, небо, свет, декор — GameWorld),
     * предметы карты (Props) и детали трассы. levelIndex оставлен для совместимости.
     */
    async build(app, levelIndex) {
        void levelIndex;
        this.clear();
        this.app = app;
        const view = this.view = app.location.view;
        const scene = view.scene;
        this._hideGround(app.location.terrain);
        const map = app.location.map;
        GameWorld.buildData(map);
        await GameWorld.buildView(app);
        Props.build(map, view);
        await Props.ready;                       // модели предметов из файлов (если есть) загружены
        this._makeMaterials(scene);
        const C = ObbyCourse;
        /** @type {Record<string, any[]>} */
        const byModel = {};
        const chunk = 6000;
        /** @type {Map<string, any>} */
        const chunks = new Map();
        /** @type {Map<number, any[]>} */
        const arcs = new Map();
        for (const p of C.pieces) {
            const mid = this._modelId(p);                              // model=<id> — вместо плиты модель (hide=1 прячет только плиту)
            if (mid && !p.dynamic) { (byModel[mid] || (byModel[mid] = [])).push(p); continue; }
            if (p.type === 'arrow' || p.prm.hide) continue;           // hide=1 — невидимый коллайдер
            if (p.dynamic) { await this._buildDynamic(view, p); continue; }
            if (p.prm.arc) { const k = p.prm.arc; if (!arcs.has(k)) arcs.set(k, []); arcs.get(k).push(p); continue; }
            const key = Math.floor(p.O[0] / chunk) + ',' + Math.floor(p.O[2] / chunk);
            let b = chunks.get(key);
            if (!b) { b = this._builder(); chunks.set(key, b); }
            b.setTransform(p.O, p.ax, p.ay, p.az);
            this._geometry(b, p);
        }
        for (const list of arcs.values()) {
            const b = this._builder();
            this._ribbon(b, list.sort((a, c) => (a.prm.seg || 0) - (c.prm.seg || 0)));
            for (const m of b.toMeshes(scene, this.mats, 'arc')) this._register(view, m, true);
        }
        for (const b of chunks.values()) for (const m of b.toMeshes(scene, this.mats, 'track')) this._register(view, m, true);
        await this._modelBatches(view, byModel);
        this._startPaint(view);
        await this._gates(view);
        await this._buildPodium(view);
        this.setStage(0);
        this.update(0, null);
        return this;
    },

    /** Освободить всё: детали трассы, предметы и мир (при смене карты хватает следующего build — он освобождает прежнее сам). */
    dispose() { this.clear(); Props.clear(); GameWorld.clear(); },

    /** Идентификатор модели из имени детали (model=building_1) или ''. */
    _modelId(p) {
        const m = /(?:^|\s)model=([A-Za-z0-9_]+)/.exec(String((p.def && p.def.name) || ''));
        return m && TRACK_MODELS[m[1]] ? m[1] : '';
    },

    /**
     * Неподвижные детали с model=<id>: коллайдеры остаются у ObbyCourse, вид — thin instances одной модели на всю карту.
     * Начало модели — центр низа бруска или начало детали (arrow — вид без коллизии), курс детали; ms=число — масштаб.
     * Город — сотни зданий по 4 тыс. треугольников, поэтому рисуются только те, что близко и в поле зрения; остальные — коробка той же
     * формы с окнами (12 треугольников). Наборы пересобирает _lodUpdate несколько раз в секунду.
     */
    async _modelBatches(view, byModel) {
        const scene = view.scene;
        await Promise.all(Object.keys(byModel).map(async (id) => {
            let root = null;
            try { root = Model3D.build(await Model3D.load(TRACK_MODELS[id]), scene, { name: 'model-' + id }); } catch (e) { root = null; }
            if (!root) { console.warn('Track: модель «' + id + '» не загрузилась'); return; }
            World3D.addObject(view, root, 'prop', { outline: false, ink: false, castShadow: false });
            const parts = /** @type {any[]} */ (root.getChildMeshes(false)).filter(m => m.getTotalVertices() > 0);
            this.meshes.push(root);
            const list = byModel[id], n = list.length, all = new Float32Array(n * 16), pos = new Float32Array(n * 2);
            let top = 0;
            list.forEach((p, i) => {
                const o = i * 16, k = Number(p.prm.ms) > 0 ? Number(p.prm.ms) : 1;
                const down = p.type === 'box' || p.type === 'cyl' ? -p.sy : 0;   // низ детали: у брусков и цилиндров верх на O, толщина вниз
                const ax = p.ax, ay = p.ay, az = p.az;
                all[o] = ax[0] * k; all[o + 1] = ax[1] * k; all[o + 2] = ax[2] * k;
                all[o + 4] = ay[0] * k; all[o + 5] = ay[1] * k; all[o + 6] = ay[2] * k;
                all[o + 8] = az[0] * k; all[o + 9] = az[1] * k; all[o + 10] = az[2] * k;
                all[o + 12] = p.O[0] + ay[0] * down; all[o + 13] = p.O[1] + ay[1] * down; all[o + 14] = p.O[2] + ay[2] * down; all[o + 15] = 1;
                pos[i * 2] = p.O[0]; pos[i * 2 + 1] = p.O[2];
                top = Math.max(top, k);
            });
            const bb = root.getHierarchyBoundingVectors(true), sx = bb.max.x - bb.min.x, sy = bb.max.y - bb.min.y, sz = bb.max.z - bb.min.z;
            const radius = Math.hypot(sx, sz) * 0.5 * top;
            const near = new Float32Array(n * 16);
            for (const m of parts) {
                m.isVisible = true; m.isPickable = false; m.receiveShadows = true;
                m.alwaysSelectAsActiveMesh = true;
                m.thinInstanceSetBuffer('matrix', near, 16, false);
                m.thinInstanceCount = 0;
                view.addShadowCaster(m, false);
            }
            // коробка издали: той же формы, цвет — средний по вершинам, окна — у зданий
            const far = this._lodBox(scene, id, parts, bb, sx, sy, sz);
            const farBuf = new Float32Array(n * 16);
            if (far) { far.thinInstanceSetBuffer('matrix', farBuf, 16, false); far.thinInstanceCount = 0; far.alwaysSelectAsActiveMesh = true; World3D.addObject(view, far, 'prop', { outline: false, ink: false, castShadow: false }); this.meshes.push(far); }
            this.lods.push({ id, parts, far, farBuf, near, all, pos, n, radius, tall: sy * top > 1500, nearN: -1, farN: -1 });
        }));
    },

    // Коробка-заменитель модели: единичные UV по размеру, чтобы окна были одного масштаба на любом здании.
    _lodBox(scene, id, parts, bb, sx, sy, sz) {
        if (!/building|container|gas_station|crash_wall/.test(id)) return null;   // коробка годится только прямоугольному
        let r = 0, g = 0, b = 0, c = 0;
        for (const m of parts) {
            const col = m.getVerticesData(BABYLON.VertexBuffer.ColorKind);
            if (!col) continue;
            for (let i = 0; i < col.length; i += 16) { r += col[i]; g += col[i + 1]; b += col[i + 2]; c++; }
        }
        const k = c ? 1 / c : 0;
        const x0 = bb.min.x, x1 = bb.max.x, y0 = bb.min.y, y1 = bb.max.y, z0 = bb.min.z, z1 = bb.max.z;
        const T = 300, u = sx / T, v = sy / T, w = sz / T;
        const windows = /building/.test(id);
        const pos = [], nrm = [], uv = [], idx = [];
        const face = (a, c2, d, e, n, us, vs) => {
            const o = pos.length / 3;
            pos.push(...a, ...c2, ...d, ...e); for (let i = 0; i < 4; i++) nrm.push(...n);
            uv.push(0, 0, us, 0, us, vs, 0, vs);
            idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
        };
        face([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [1, 0, 0], w, v);
        face([x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [-1, 0, 0], w, v);
        face([x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [0, 0, 1], u, v);
        face([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [0, 0, -1], u, v);
        face([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [0, 1, 0], 0, 0);
        const mesh = new BABYLON.Mesh('model-' + id + '-far', scene);
        const vd = new BABYLON.VertexData();
        vd.positions = pos; vd.normals = nrm; vd.uvs = uv; vd.indices = idx;
        vd.applyToMesh(mesh, false);
        mesh.isPickable = false;
        const mat = new BABYLON.StandardMaterial('lod-' + id, scene);
        mat.specularColor = new BABYLON.Color3(0, 0, 0);
        mat.diffuseColor = new BABYLON.Color3(r * k * 1.12, g * k * 1.12, b * k * 1.12);
        mat.backFaceCulling = false;
        if (windows) {
            const t = this.mats.lodWindows || (this.mats.lodWindows = this._tex(scene, 'lodwin', 64, 64, (ctx, n) => {
                ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, n, n);
                ctx.fillStyle = '#5a6068'; ctx.fillRect(n * 0.2, n * 0.22, n * 0.6, n * 0.5);
                ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(0, n * 0.84, n, n * 0.08);
            }));
            if (t) mat.diffuseTexture = t;
        }
        mesh.material = mat;
        this.mats['lod-' + id] = mat;
        return mesh;
    },

    // Какие модели рисовать подробно: близко и в поле зрения; остальное — коробками или никак. Несколько раз в секунду.
    _lodUpdate() {
        const view = this.view;
        if (!view || !this.lods.length) return;
        const cam = view.camera, cp = cam.position;
        const tgt = cam.getTarget ? cam.getTarget() : null;
        const fwx = tgt ? tgt.x - cp.x : 1, fwz = tgt ? tgt.z - cp.z : 0;
        const fl = Math.hypot(fwx, fwz) || 1, fx = fwx / fl, fz = fwz / fl;
        const eng = view.scene.getEngine(), aspect = eng.getRenderWidth() / Math.max(1, eng.getRenderHeight());
        const half = Math.atan(Math.tan((cam.fov || 1) / 2) * aspect) + 0.22, cone = Math.cos(Math.min(1.5, half));
        const q = typeof Quality !== 'undefined' ? String(Quality.level) : '2';
        const k = (typeof IS_MOBILE !== 'undefined' && IS_MOBILE) ? 0.5 : q === 'low' || q === '0' ? 0.55 : q === 'medium' || q === '1' ? 0.75 : 1;
        for (const L of this.lods) {
            // без коробки-заменителя (скалы, лом, деревья) модель держим дальше: иначе она пропадает на глазах
            const farD = (L.tall ? TRACK_LOD_FAR_TALL : TRACK_LOD_FAR) * (k > 0.6 ? 1 : 0.75);
            // горы (столовые в каньоне) — линия горизонта: их держим до самого конца, треугольников в них немного
            const nearD = L.radius > TRACK_LOD_HORIZON_R ? farD : (L.far ? Math.max(TRACK_LOD_MIN, Math.min(TRACK_LOD_MAX, L.radius * TRACK_LOD_K)) : TRACK_LOD_FAR * (L.tall ? 1.4 : 0.8)) * k;
            const near = L.near, all = L.all, pos = L.pos, far = L.farBuf, R = L.radius;
            let nn = 0, fn = 0;
            for (let i = 0; i < L.n; i++) {
                const dx = pos[i * 2] - cp.x, dz = pos[i * 2 + 1] - cp.z, d = Math.sqrt(dx * dx + dz * dz);
                if (d > farD) continue;
                if (d > R * 1.6 && dx * fx + dz * fz < cone * d - R) continue;     // за кадром
                const o = i * 16;
                if (d < nearD) { for (let c = 0; c < 16; c++) near[nn * 16 + c] = all[o + c]; nn++; }
                else if (L.far) { for (let c = 0; c < 16; c++) far[fn * 16 + c] = all[o + c]; fn++; }
            }
            if (nn !== L.nearN || nn > 0) {
                for (const m of L.parts) { m.thinInstanceCount = nn; m.thinInstanceBufferUpdated('matrix'); m.setEnabled(nn > 0); }
                L.nearN = nn;
            }
            if (L.far && (fn !== L.farN || fn > 0)) {
                L.far.thinInstanceCount = fn; L.far.thinInstanceBufferUpdated('matrix'); L.far.setEnabled(fn > 0);
                L.farN = fn;
            }
        }
    },

    clear() {
        const view = this.view;
        // removeObject освобождает меш, но не материал: материалы моделей (ворота, подиум, здания) у каждой сборки свои, снимаем их сами
        const own = new Set();
        for (const m of this.meshes) {
            try { for (const part of [m].concat(m.getChildMeshes ? m.getChildMeshes(false) : [])) if (part.material) own.add(part.material); } catch (e) { /* уже */ }
            try { if (view) World3D.removeObject(view, m); } catch (e) { /* вид уже сменился */ }
            try { m.dispose(false, true); } catch (e) { /* уже */ }
        }
        for (const mat of own) { try { mat.dispose(false, true); } catch (e) { /* уже */ } }
        for (const k in this.mats) { try { this.mats[k].dispose(false, true); } catch (e) { /* уже */ } }
        this.meshes = []; this.nodes = []; this.gates = []; this.mats = {};
        this.podium = null; this.garage = null; this._stage = 0; this.farCull = []; this.lods = []; this._lodT = 0;
    },

    _hideGround(terrain) {
        const t = /** @type {any} */ (terrain);
        if (!t) return;
        for (const m of t.meshes || []) if (m && m.setEnabled) m.setEnabled(false);
        for (const m of [t.mesh, t.outer]) if (m && m.setEnabled) m.setEnabled(false);
        for (const w of t.waters || []) if (w && w.mesh && w.mesh.setEnabled) w.mesh.setEnabled(false);
    },

    _register(view, mesh, isStatic, opts) {
        mesh.isPickable = false;
        if (isStatic) { mesh.freezeWorldMatrix(); mesh.doNotSyncBoundingInfo = true; }
        World3D.addObject(view, mesh, 'prop', Object.assign({ outline: false, ink: false }, opts || {}));
        this.meshes.push(mesh);
        return mesh;
    },

    // ---------------------------------------------------------------------------------------------
    // Материалы: текстуры рисуются на холсте (нет холста — ровный цвет, сцена не падает)
    // ---------------------------------------------------------------------------------------------

    _tex(scene, name, w, h, draw) {
        try {
            const t = new BABYLON.DynamicTexture('trk-' + name, { width: w, height: h || w }, scene, true);
            const ctx = /** @type {CanvasRenderingContext2D} */ (/** @type {any} */ (t.getContext()));
            if (!ctx) { t.dispose(); return null; }
            draw(ctx, w, h || w);
            t.update(true);
            t.wrapU = t.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
            t.anisotropicFilteringLevel = 8;
            return t;
        } catch (e) { return null; }
    },

    _makeMaterials(scene) {
        const std = (name, hex, spec) => {
            const m = new BABYLON.StandardMaterial('trk-' + name, scene);
            m.diffuseColor = BABYLON.Color3.FromHexString(hex);
            m.specularColor = new BABYLON.Color3(spec || 0.05, spec || 0.05, spec || 0.05);
            m.backFaceCulling = false;
            this.mats[name] = m;
            return m;
        };
        let seed = 7;
        const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
        // асфальт: та же текстура, что у лент дорог мира (WorldRoads, road-asphalt.webp: светлое фото Poly Haven, CC0); пока грузится — ровный серый
        const asphalt = std('asphalt', '#4a4b4f', 0.08);
        try {
            const t = new BABYLON.Texture('assets/textures/road-asphalt.webp', scene, false, true, BABYLON.Texture.TRILINEAR_SAMPLINGMODE, null, () => { asphalt.diffuseTexture = null; });
            t.anisotropicFilteringLevel = 8;
            asphalt.diffuseTexture = t;
            asphalt.diffuseColor = new BABYLON.Color3(1, 1, 1);
        } catch (e) { /* без текстуры — цвет */ }
        const concrete = std('concrete', '#c9c6be');
        const ct = this._tex(scene, 'concrete', 256, 256, (ctx, n) => {
            ctx.fillStyle = '#c4c1b9'; ctx.fillRect(0, 0, n, n);
            for (let i = 0; i < 1800; i++) { ctx.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.08)'; ctx.fillRect(rnd() * n, rnd() * n, 1 + rnd() * 2, 1 + rnd() * 2); }
            ctx.fillStyle = 'rgba(60,55,50,0.25)'; ctx.fillRect(0, 0, n, 2); ctx.fillRect(0, 0, 2, n);
        });
        if (ct) { concrete.diffuseTexture = ct; concrete.diffuseColor = new BABYLON.Color3(1, 1, 1); }
        // бок плиты: бетон с поясом-плинтусом
        const side = std('side', '#8d8a84');
        const st = this._tex(scene, 'side', 256, 256, (ctx, n) => {
            const g = ctx.createLinearGradient(0, 0, 0, n); g.addColorStop(0, '#a9a59d'); g.addColorStop(1, '#7c7972');
            ctx.fillStyle = g; ctx.fillRect(0, 0, n, n);
            for (let i = 0; i < 1400; i++) { ctx.fillStyle = 'rgba(0,0,0,0.07)'; ctx.fillRect(rnd() * n, rnd() * n, 1 + rnd() * 2, 1 + rnd() * 2); }
            ctx.fillStyle = 'rgba(40,38,35,0.35)'; ctx.fillRect(0, 0, 3, n);
        });
        if (st) { side.diffuseTexture = st; side.diffuseColor = new BABYLON.Color3(1, 1, 1); }
        // бортик: красно-белые полосы вдоль (u — длина)
        const curb = std('curb', '#e8e8e8', 0.12);
        const cbt = this._tex(scene, 'curb', 128, 32, (ctx, w, h) => {
            ctx.fillStyle = '#f2f2f0'; ctx.fillRect(0, 0, w, h);
            ctx.fillStyle = '#d7262b'; ctx.fillRect(0, 0, w / 2, h);
            ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.fillRect(0, h - 3, w, 3);
        });
        if (cbt) { curb.diffuseTexture = cbt; curb.diffuseColor = new BABYLON.Color3(1, 1, 1); }
        // трамплин: асфальт с лаймовыми шевронами по ходу
        const ramp = std('ramp', '#5d6066', 0.08);
        const rt = this._tex(scene, 'ramp', 256, 256, (ctx, n) => {
            ctx.fillStyle = '#55585e'; ctx.fillRect(0, 0, n, n);
            for (let i = 0; i < 2200; i++) { ctx.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.07)'; ctx.fillRect(rnd() * n, rnd() * n, 1 + rnd() * 1.5, 1 + rnd() * 1.5); }
            ctx.fillStyle = '#c5ef5c';
            for (const y0 of [0.15, 0.6]) {
                ctx.beginPath();
                ctx.moveTo(n * 0.15, n * y0); ctx.lineTo(n * 0.5, n * (y0 + 0.22)); ctx.lineTo(n * 0.85, n * y0);
                ctx.lineTo(n * 0.85, n * (y0 + 0.1)); ctx.lineTo(n * 0.5, n * (y0 + 0.32)); ctx.lineTo(n * 0.15, n * (y0 + 0.1)); ctx.closePath(); ctx.fill();
            }
        });
        if (rt) { ramp.diffuseTexture = rt; ramp.diffuseColor = new BABYLON.Color3(1, 1, 1); }
        const ice = std('ice', '#d6f6ff', 0.6); ice.specularPower = 48;
        // металлическая плита (паром): рифление и лаймовая кайма
        const metal = std('metal', '#9aa3ad', 0.4);
        const mt = this._tex(scene, 'metal', 256, 256, (ctx, n) => {
            ctx.fillStyle = '#8f98a2'; ctx.fillRect(0, 0, n, n);
            ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 3;
            for (let y = 8; y < n; y += 24) for (let x = (y / 24 % 2) * 12; x < n; x += 24) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 10, y + 6); ctx.stroke(); }
            ctx.fillStyle = '#c5ef5c'; ctx.fillRect(0, 0, n, 10); ctx.fillRect(0, n - 10, n, 10);
        });
        if (mt) { metal.diffuseTexture = mt; metal.diffuseColor = new BABYLON.Color3(1, 1, 1); }
        // разметка-предупреждение: жёлто-графитовые диагонали
        const hazard = std('hazard', '#f5c400');
        const ht = this._tex(scene, 'hazard', 128, 128, (ctx, n) => {
            ctx.fillStyle = '#f2c200'; ctx.fillRect(0, 0, n, n);
            ctx.fillStyle = '#22252b';
            for (let k = -n; k < n * 2; k += 64) { ctx.beginPath(); ctx.moveTo(k, 0); ctx.lineTo(k + 32, 0); ctx.lineTo(k + 32 - n, n); ctx.lineTo(k - n, n); ctx.closePath(); ctx.fill(); }
        });
        if (ht) { hazard.diffuseTexture = ht; hazard.diffuseColor = new BABYLON.Color3(1, 1, 1); }
        const kill = std('kill', '#ff4a1c'); kill.emissiveColor = new BABYLON.Color3(0.9, 0.25, 0.05); kill.metadata = { toon: false };
        // ускоритель: лаймовые стрелки бегут вперёд
        const boost = std('boost', '#c5ef5c'); boost.emissiveColor = new BABYLON.Color3(0.35, 0.45, 0.15);
        const bt = this._tex(scene, 'boost', 256, 128, (ctx, w, h) => {
            ctx.fillStyle = '#22252b'; ctx.fillRect(0, 0, w, h);
            ctx.fillStyle = '#c5ef5c';
            for (const ox of [0, w / 2]) { ctx.beginPath(); ctx.moveTo(ox + 10, h * 0.1); ctx.lineTo(ox + w * 0.3, h * 0.5); ctx.lineTo(ox + 10, h * 0.9); ctx.lineTo(ox + 50, h * 0.9); ctx.lineTo(ox + w * 0.3 + 40, h * 0.5); ctx.lineTo(ox + 50, h * 0.1); ctx.closePath(); ctx.fill(); }
        });
        if (bt) { boost.diffuseTexture = bt; boost.diffuseColor = new BABYLON.Color3(1, 1, 1); }
        const jump = std('jump', '#ff4fa3'); jump.emissiveColor = new BABYLON.Color3(0.2, 0.1, 0.15);
        const pillar = std('pillar', '#f0f0ee');
        const pt = this._tex(scene, 'pillar', 64, 256, (ctx, w, h) => {
            for (let i = 0; i < 4; i++) { ctx.fillStyle = i % 2 ? '#f0f0ee' : '#d7262b'; ctx.fillRect(0, i * h / 4, w, h / 4); }
        });
        if (pt) { pillar.diffuseTexture = pt; pillar.diffuseColor = new BABYLON.Color3(1, 1, 1); }
        std('post', '#e9ecef', 0.2);
        const bar = std('bar', '#d7262b'); bar.emissiveColor = new BABYLON.Color3(0.15, 0.02, 0.02);
        std('arm', '#9fb4c8'); std('head', '#2b2e35', 0.3); std('pivot', '#2b2e35');
        const paint = std('paint', '#f4f4f0'); paint.emissiveColor = new BABYLON.Color3(0.25, 0.25, 0.25);
        const checker = std('checker', '#ffffff');
        const cht = this._tex(scene, 'checker', 128, 128, (ctx, n) => { for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { ctx.fillStyle = (x + y) % 2 ? '#14141c' : '#ffffff'; ctx.fillRect(x * n / 4, y * n / 4, n / 4, n / 4); } });
        if (cht) checker.diffuseTexture = cht;
        const lime = std('lime', '#c5ef5c'); lime.emissiveColor = new BABYLON.Color3(0.45, 0.6, 0.18); lime.metadata = { toon: false };
        // то, что лежит на полотне дороги мира, — разметка старта, ускорители, предупреждающие полосы: ближе к камере, чем любая лента дороги
        // (ленты WorldRoads сдвинуты по глубине на 4…15 единиц, иначе их закрывает полотно); сдвиг не зависит от расстояния
        for (const k of ['paint', 'checker', 'boost', 'hazard']) { const m = this.mats[k]; if (m) { m.zOffset = -TRACK_PAINT_ZOFF; m.zOffsetUnits = -TRACK_PAINT_ZOFF; } }
        void concrete;
    },

    // ---------------------------------------------------------------------------------------------
    // Геометрия (как у ObbyCourseView: многоугольники в локальных осях детали, пачки по материалам)
    // ---------------------------------------------------------------------------------------------

    _builder() {
        /** @type {Record<string, { pos: number[], nrm: number[], uv: number[], idx: number[] }>} */
        const bufs = {};
        let O = [0, 0, 0], AX = [1, 0, 0], AY = [0, 1, 0], AZ = [0, 0, 1];
        const tp = (p) => [O[0] + p[0] * AX[0] + p[1] * AY[0] + p[2] * AZ[0], O[1] + p[0] * AX[1] + p[1] * AY[1] + p[2] * AZ[1], O[2] + p[0] * AX[2] + p[1] * AY[2] + p[2] * AZ[2]];
        const tn = (n) => [n[0] * AX[0] + n[1] * AY[0] + n[2] * AZ[0], n[0] * AX[1] + n[1] * AY[1] + n[2] * AZ[1], n[0] * AX[2] + n[1] * AY[2] + n[2] * AZ[2]];
        const buf = (key) => bufs[key] || (bufs[key] = { pos: [], nrm: [], uv: [], idx: [] });
        return {
            setTransform(o, ax, ay, az) { O = o; AX = ax; AY = ay; AZ = az; },
            identity() { O = [0, 0, 0]; AX = [1, 0, 0]; AY = [0, 1, 0]; AZ = [0, 0, 1]; },
            poly(key, pts, nrms, uvs) {
                const b = buf(key), base = b.pos.length / 3;
                for (let i = 0; i < pts.length; i++) {
                    const p = tp(pts[i]), n = tn(Array.isArray(nrms[0]) ? nrms[i] : nrms);
                    b.pos.push(p[0], p[1], p[2]); b.nrm.push(n[0], n[1], n[2]); b.uv.push(uvs[i][0], uvs[i][1]);
                }
                for (let i = 1; i + 1 < pts.length; i++) b.idx.push(base, base + i, base + i + 1);
            },
            toMeshes(scene, mats, name) {
                const out = [];
                for (const key of Object.keys(bufs)) {
                    const b = bufs[key];
                    if (!b.idx.length) continue;
                    const mesh = new BABYLON.Mesh(name + '-' + key, scene);
                    const vd = new BABYLON.VertexData();
                    vd.positions = b.pos; vd.normals = b.nrm; vd.uvs = b.uv; vd.indices = b.idx;
                    vd.applyToMesh(mesh, false);
                    mesh.material = mats[key] || mats.side;
                    out.push(mesh);
                }
                return out;
            },
        };
    },

    _topKey(p) {
        if (p.def && /^start/.test(p.def.name || '')) return 'asphalt';
        return ({ white: 'concrete', ice: 'ice', yellow: 'hazard', mint: 'metal' })[p.color] || 'asphalt';
    },

    _geometry(b, p) {
        const hx = p.sx / 2, hz = p.sz / 2;
        const curb = p.prm.curb !== 0 && !p.prm.loop;
        switch (p.type) {
            case 'box': this._slab(b, hx, -p.sy, 0, hz, this._topKey(p), curb && hz > 160); break;
            case 'kill': case 'lava': case 'water': this._box(b, hx, -p.sy, 0, hz, 'kill', 'kill'); break;
            case 'cyl': this._cyl(b, hx, hz, -p.sy, 0, 36, this._topKey(p), curb && hx > 200); break;
            case 'ramp': this._wedge(b, hx, p.sy, hz, curb && hz > 160); break;
            case 'arch': this._arch(b, hx, p.sy, hz, 28, curb && hz > 160); break;
            case 'boost': this._box(b, hx, 0, 6, hz, 'boost', 'side'); break;
            case 'jump': this._cyl(b, hx, hz, 0, 14, 30, 'jump', false); break;
            case 'pillar': this._box(b, hx, 0, p.sy, hz, 'pillar', 'pillar', true); break;
            case 'fence': this._box(b, hx, 0, 46, 6, 'curb', 'curb'); break;
            case 'spinner': this._cylRaw(b, 26, 26, 0, p.sy + 26, 14, 'post'); break;
            case 'hammer': this._box(b, 16, -16, 16, 16, 'pivot', 'pivot'); break;
            default: this._slab(b, hx, -p.sy, 0, hz, this._topKey(p), false);
        }
    },

    // Плита дороги: верх (асфальт, мировые UV), бортики по длинным кромкам (верх и пояс на боку), бетонные бока.
    _slab(b, hx, y0, y1, hz, topKey, curbs) {
        const S = TRACK_TILE, cw = curbs ? Math.min(TRACK_CURB, hz * 0.12) : 0, P = TRACK_CURB_STRIPE * 2;
        const uv = (x, z) => [(x + hx) / S, (z + hz) / S];
        const iz = hz - cw;
        b.poly(topKey, [[-hx, y1, -iz], [-hx, y1, iz], [hx, y1, iz], [hx, y1, -iz]], [0, 1, 0], [uv(-hx, -iz), uv(-hx, iz), uv(hx, iz), uv(hx, -iz)]);
        if (cw > 0) {
            for (const s of [-1, 1]) {
                const za = s * iz, zb = s * hz;
                const q = [[-hx, y1 + 0.5, za], [-hx, y1 + 0.5, zb], [hx, y1 + 0.5, zb], [hx, y1 + 0.5, za]];
                b.poly('curb', s > 0 ? q : q.slice().reverse(), [0, 1, 0], (s > 0 ? [[0, 0], [0, 1], [2 * hx / P, 1], [2 * hx / P, 0]] : [[2 * hx / P, 0], [2 * hx / P, 1], [0, 1], [0, 0]]));
            }
        }
        const band = cw > 0 ? Math.min(34, (y1 - y0) * 0.4) : 0;
        const k = 1 / 256;
        // бока по длине: пояс бортика сверху, ниже бетон
        for (const s of [-1, 1]) {
            const z = s * hz, n = [0, 0, s];
            const face = (ya, yb, key, uvs) => { const q = [[-hx, ya, z], [-hx, yb, z], [hx, yb, z], [hx, ya, z]]; b.poly(key, s > 0 ? q : q.slice().reverse(), n, s > 0 ? uvs : uvs.slice().reverse()); };
            face(y0, y1 - band, 'side', [[0, y0 * k], [0, (y1 - band) * k], [2 * hx * k, (y1 - band) * k], [2 * hx * k, y0 * k]]);
            if (band > 0) face(y1 - band, y1, 'curb', [[0, 0], [0, 1], [2 * hx / P, 1], [2 * hx / P, 0]]);
        }
        b.poly('side', [[hx, y0, -hz], [hx, y1, -hz], [hx, y1, hz], [hx, y0, hz]], [1, 0, 0], [[0, y0 * k], [0, y1 * k], [2 * hz * k, y1 * k], [2 * hz * k, y0 * k]]);
        b.poly('side', [[-hx, y0, hz], [-hx, y1, hz], [-hx, y1, -hz], [-hx, y0, -hz]], [-1, 0, 0], [[0, y0 * k], [0, y1 * k], [2 * hz * k, y1 * k], [2 * hz * k, y0 * k]]);
        b.poly('side', [[-hx, y0, -hz], [hx, y0, -hz], [hx, y0, hz], [-hx, y0, hz]], [0, -1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
    },

    _box(b, hx, y0, y1, hz, topKey, sideKey, vStripes) {
        const S = TRACK_TILE, k = 1 / 256;
        const uvTop = (x, z) => [(x + hx) / S, (z + hz) / S];
        b.poly(topKey, [[-hx, y1, -hz], [-hx, y1, hz], [hx, y1, hz], [hx, y1, -hz]], [0, 1, 0], [uvTop(-hx, -hz), uvTop(-hx, hz), uvTop(hx, hz), uvTop(hx, -hz)]);
        b.poly(sideKey, [[-hx, y0, -hz], [hx, y0, -hz], [hx, y0, hz], [-hx, y0, hz]], [0, -1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
        const v = (y) => (vStripes ? (y - y0) / Math.max(1, y1 - y0) * Math.max(1, Math.round((y1 - y0) / 240)) : y * k);
        b.poly(sideKey, [[hx, y0, -hz], [hx, y1, -hz], [hx, y1, hz], [hx, y0, hz]], [1, 0, 0], [[0, v(y0)], [0, v(y1)], [1, v(y1)], [1, v(y0)]]);
        b.poly(sideKey, [[-hx, y0, hz], [-hx, y1, hz], [-hx, y1, -hz], [-hx, y0, -hz]], [-1, 0, 0], [[0, v(y0)], [0, v(y1)], [1, v(y1)], [1, v(y0)]]);
        b.poly(sideKey, [[hx, y0, hz], [hx, y1, hz], [-hx, y1, hz], [-hx, y0, hz]], [0, 0, 1], [[0, v(y0)], [0, v(y1)], [1, v(y1)], [1, v(y0)]]);
        b.poly(sideKey, [[-hx, y0, -hz], [-hx, y1, -hz], [hx, y1, -hz], [hx, y0, -hz]], [0, 0, -1], [[0, v(y0)], [0, v(y1)], [1, v(y1)], [1, v(y0)]]);
    },

    _cylRaw(b, rx, rz, y0, y1, seg, key) {
        const ring = [];
        for (let i = 0; i < seg; i++) { const a = i / seg * Math.PI * 2; ring.push([Math.cos(a), Math.sin(a)]); }
        b.poly(key, ring.map(([c, s]) => [c * rx, y1, s * rz]).reverse(), [0, 1, 0], ring.map(([c, s]) => [c, s]).reverse());
        for (let i = 0; i < seg; i++) {
            const [c0, s0] = ring[i], [c1, s1] = ring[(i + 1) % seg];
            b.poly(key, [[c0 * rx, y0, s0 * rz], [c0 * rx, y1, s0 * rz], [c1 * rx, y1, s1 * rz], [c1 * rx, y0, s1 * rz]], [[c0, 0, s0], [c0, 0, s0], [c1, 0, s1], [c1, 0, s1]], [[i / seg, 0], [i / seg, 1], [(i + 1) / seg, 1], [(i + 1) / seg, 0]]);
        }
    },

    // Круглая площадка: верх, кольцо бортика, бетонный бок.
    _cyl(b, rx, rz, y0, y1, seg, topKey, curbs) {
        const S = TRACK_TILE, ring = [];
        for (let i = 0; i < seg; i++) { const a = i / seg * Math.PI * 2; ring.push([Math.cos(a), Math.sin(a)]); }
        const cw = curbs ? TRACK_CURB : 0, kx = (rx - cw) / rx, kz = (rz - cw) / rz;
        const uv = (x, z) => [(x + rx) / S, (z + rz) / S];
        b.poly(topKey, ring.map(([c, s]) => [c * rx * kx, y1, s * rz * kz]).reverse(), [0, 1, 0], ring.map(([c, s]) => uv(c * rx * kx, s * rz * kz)).reverse());
        const per = 2 * Math.PI * rx / (TRACK_CURB_STRIPE * 2);
        for (let i = 0; i < seg; i++) {
            const [c0, s0] = ring[i], [c1, s1] = ring[(i + 1) % seg];
            if (cw > 0) b.poly('curb', [[c1 * rx, y1 + 0.5, s1 * rz], [c1 * rx * kx, y1 + 0.5, s1 * rz * kz], [c0 * rx * kx, y1 + 0.5, s0 * rz * kz], [c0 * rx, y1 + 0.5, s0 * rz]], [0, 1, 0],
                [[(i + 1) / seg * per, 1], [(i + 1) / seg * per, 0], [i / seg * per, 0], [i / seg * per, 1]]);
            b.poly('side', [[c0 * rx, y0, s0 * rz], [c0 * rx, y1, s0 * rz], [c1 * rx, y1, s1 * rz], [c1 * rx, y0, s1 * rz]], [[c0, 0, s0], [c0, 0, s0], [c1, 0, s1], [c1, 0, s1]],
                [[i / seg * 8, y0 / 256], [i / seg * 8, y1 / 256], [(i + 1) / seg * 8, y1 / 256], [(i + 1) / seg * 8, y0 / 256]]);
        }
        b.poly('side', ring.map(([c, s]) => [c * rx, y0, s * rz]), [0, -1, 0], ring.map(([c, s]) => [c, s]));
    },

    // Трамплин-клин: верх со шевронами, бортики по бокам, бетонные бока.
    _wedge(b, hx, sy, hz, curbs) {
        const len = Math.hypot(2 * hx, sy), n = [-sy / len, 2 * hx / len, 0];
        const cw = curbs ? Math.min(TRACK_CURB, hz * 0.12) : 0, iz = hz - cw, P = TRACK_CURB_STRIPE * 2;
        const vLen = len / Math.max(300, Math.min(700, 2 * hz));
        b.poly('ramp', [[-hx, 0, -iz], [-hx, 0, iz], [hx, sy, iz], [hx, sy, -iz]], n, [[0, 0], [1, 0], [1, vLen], [0, vLen]].map(([u, v]) => [u, v]));
        if (cw > 0) for (const s of [-1, 1]) {
            const za = s * iz, zb = s * hz, lift = 0.6;
            const q = [[-hx, lift, za], [-hx, lift, zb], [hx, sy + lift, zb], [hx, sy + lift, za]];
            b.poly('curb', s > 0 ? q : q.slice().reverse(), n, s > 0 ? [[0, 0], [0, 1], [len / P, 1], [len / P, 0]] : [[len / P, 0], [len / P, 1], [0, 1], [0, 0]]);
        }
        b.poly('side', [[-hx, 0, -hz], [hx, 0, -hz], [hx, 0, hz], [-hx, 0, hz]], [0, -1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
        b.poly('side', [[hx, 0, -hz], [hx, sy, -hz], [hx, sy, hz], [hx, 0, hz]], [1, 0, 0], [[0, 0], [0, sy / 256], [2 * hz / 256, sy / 256], [2 * hz / 256, 0]]);
        b.poly('curb', [[-hx, 0, hz], [hx, 0, hz], [hx, sy, hz]], [0, 0, 1], [[0, 0], [len / P, 0], [len / P, 1]]);
        b.poly('curb', [[-hx, 0, -hz], [hx, sy, -hz], [hx, 0, -hz]], [0, 0, -1], [[0, 0], [len / P, 1], [len / P, 0]]);
    },

    _arch(b, hx, sy, hz, seg, curbs) {
        const pts = [];
        let arc = 0;
        for (let i = 0; i <= seg; i++) {
            const X = -1 + 2 * i / seg, x = X * hx, y = sy * (0.5 + 0.5 * Math.cos(Math.PI * X));
            if (i) arc += Math.hypot(x - pts[i - 1].x, y - pts[i - 1].y);
            const slope = -0.5 * Math.PI * Math.sin(Math.PI * X) * sy / hx, l = Math.hypot(slope, 1);
            pts.push({ x, y, nx: -slope / l, ny: 1 / l, u: arc / TRACK_TILE, c: arc / (TRACK_CURB_STRIPE * 2) });
        }
        const cw = curbs ? Math.min(TRACK_CURB, hz * 0.12) : 0, iz = hz - cw;
        for (let i = 0; i < seg; i++) {
            const a = pts[i], c = pts[i + 1];
            const na = [a.nx, a.ny, 0], nc = [c.nx, c.ny, 0];
            b.poly('asphalt', [[a.x, a.y, -iz], [a.x, a.y, iz], [c.x, c.y, iz], [c.x, c.y, -iz]], [na, na, nc, nc], [[a.u, 0], [a.u, 2 * iz / TRACK_TILE], [c.u, 2 * iz / TRACK_TILE], [c.u, 0]]);
            if (cw > 0) for (const s of [-1, 1]) {
                const q = [[a.x, a.y + 0.5, s * iz], [a.x, a.y + 0.5, s * hz], [c.x, c.y + 0.5, s * hz], [c.x, c.y + 0.5, s * iz]];
                b.poly('curb', s > 0 ? q : q.slice().reverse(), s > 0 ? [na, na, nc, nc] : [nc, nc, na, na], s > 0 ? [[a.c, 0], [a.c, 1], [c.c, 1], [c.c, 0]] : [[c.c, 0], [c.c, 1], [a.c, 1], [a.c, 0]]);
            }
        }
        b.poly('side', [[-hx, 0, -hz], [hx, 0, -hz], [hx, 0, hz], [-hx, 0, hz]], [0, -1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
        const side = (zz, nz) => {
            for (let i = 0; i < seg; i++) {
                const a = pts[i], c = pts[i + 1], tri = [[0, 0, zz], [a.x, a.y, zz], [c.x, c.y, zz]];
                b.poly('side', nz > 0 ? tri : tri.reverse(), [0, 0, nz], [[0, 0], [a.x / 256, a.y / 256], [c.x / 256, c.y / 256]]);
            }
        };
        side(hz, 1); side(-hz, -1);
    },

    // Лента дуги или петли: сегменты-бруски одной группы arc=N — одна гладкая поверхность (в мире).
    _ribbon(b, list) {
        b.identity();
        const add = (a, c) => [a[0] + c[0], a[1] + c[1], a[2] + c[2]];
        const sc = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
        const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
        const hz = list[0].sz / 2, th = list[0].sy;
        const curbs = list[0].prm.curb !== 0;
        const P = [], L = [], N = [];
        for (let i = 0; i < list.length; i++) {
            const p = list[i], A = add(p.O, sc(p.ax, -p.sx / 2)), B = add(p.O, sc(p.ax, p.sx / 2));
            if (i === 0) { P.push(A); L.push(p.az); N.push(p.ay); }
            else { const q = list[i - 1]; const Bq = add(q.O, sc(q.ax, q.sx / 2)); P[P.length - 1] = sc(add(Bq, A), 0.5); L[L.length - 1] = norm(add(q.az, p.az)); N[N.length - 1] = norm(add(q.ay, p.ay)); }
            P.push(B); L.push(p.az); N.push(p.ay);
        }
        const cw = curbs ? Math.min(TRACK_CURB, hz * 0.12) : 0, iz = hz - cw;
        let u = 0;
        const PS = TRACK_CURB_STRIPE * 2;
        for (let i = 0; i + 1 < P.length; i++) {
            const a = P[i], c = P[i + 1], la = L[i], lc = L[i + 1], na = N[i], nc = N[i + 1];
            const d = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]), u1 = u + d;
            const at = (p, l, z, n, lift) => add(add(p, sc(l, z)), sc(n, lift || 0));
            b.poly('asphalt', [at(a, la, -iz, na), at(a, la, iz, na), at(c, lc, iz, nc), at(c, lc, -iz, nc)], [na, na, nc, nc],
                [[u / TRACK_TILE, 0], [u / TRACK_TILE, 2 * iz / TRACK_TILE], [u1 / TRACK_TILE, 2 * iz / TRACK_TILE], [u1 / TRACK_TILE, 0]]);
            if (cw > 0) {
                b.poly('curb', [at(a, la, iz, na, 0.6), at(a, la, hz, na, 0.6), at(c, lc, hz, nc, 0.6), at(c, lc, iz, nc, 0.6)], [na, na, nc, nc], [[u / PS, 0], [u / PS, 1], [u1 / PS, 1], [u1 / PS, 0]]);
                b.poly('curb', [at(c, lc, -iz, nc, 0.6), at(c, lc, -hz, nc, 0.6), at(a, la, -hz, na, 0.6), at(a, la, -iz, na, 0.6)], [nc, nc, na, na], [[u1 / PS, 0], [u1 / PS, 1], [u / PS, 1], [u / PS, 0]]);
            }
            // бока и низ
            const dn = (p, n) => add(p, sc(n, -th));
            for (const s of [-1, 1]) {
                const ea = at(a, la, s * hz, na), ec = at(c, lc, s * hz, nc);
                const q = [dn(ea, na), ea, ec, dn(ec, nc)];
                const ln = sc(la, s);
                b.poly('side', s > 0 ? q : q.slice().reverse(), ln, s > 0 ? [[u / 256, -th / 256], [u / 256, 0], [u1 / 256, 0], [u1 / 256, -th / 256]] : [[u1 / 256, -th / 256], [u1 / 256, 0], [u / 256, 0], [u / 256, -th / 256]]);
            }
            const ba = dn(at(a, la, -hz, na), na), bb = dn(at(a, la, hz, na), na), bc = dn(at(c, lc, hz, nc), nc), bd = dn(at(c, lc, -hz, nc), nc);
            b.poly('side', [bd, bc, bb, ba], sc(na, -1), [[0, 0], [1, 0], [1, 1], [0, 1]]);
            u = u1;
        }
        // торцы
        for (const [i, s] of [[0, -1], [P.length - 1, 1]]) {
            const p = P[i], l = L[i], n = N[i];
            const a = add(p, sc(l, -hz)), c = add(p, sc(l, hz));
            const q = [add(a, sc(n, -th)), a, c, add(c, sc(n, -th))];
            const f = list[s < 0 ? 0 : list.length - 1].ax;
            b.poly('side', s > 0 ? q : q.slice().reverse(), sc(f, s), [[0, 0], [0, 1], [1, 1], [1, 0]]);
        }
    },

    // ---------------------------------------------------------------------------------------------
    // Подвижные детали: свой корень, поза ставится в update
    // ---------------------------------------------------------------------------------------------

    async _buildDynamic(view, p) {
        const scene = view.scene;
        const root = new BABYLON.Mesh('dyn-' + p.type, scene);
        root.rotationQuaternion = new BABYLON.Quaternion();
        const make = (fill, parent) => {
            const b = this._builder(); fill(b);
            for (const m of b.toMeshes(scene, this.mats, 'dyn')) { m.parent = parent || root; m.isPickable = false; }
        };
        let bar = null, arm = null, tire = null;
        if (p.prm.tire) {
            // огромная шина: модель props/tire.glb (Ø 1 м, ось Y Blender) под размер детали; нет файла — цилиндр
            tire = new BABYLON.Mesh('tire-spin', scene);
            tire.parent = root;
            tire.rotationQuaternion = new BABYLON.Quaternion();
            try {
                const model = await Model3D.load('assets/models/props/tire.glb');
                const mesh = Model3D.build(model, scene, { name: 'tire' });
                mesh.parent = tire;
                // ось шины: Blender Y -> локальная Z модели; деталь — цилиндр с осью локальной Y (верх в 0, низ в −sy)
                const s = p.sx / 100;
                mesh.scaling.set(s, s, p.sy / 42);
                mesh.rotation.x = Math.PI / 2;
                mesh.position.y = -p.sy / 2;
                for (const m of mesh.getChildMeshes(false)) m.isPickable = false;
            } catch (e) {
                make(b => this._cylRaw(b, p.sx / 2, p.sx / 2, -p.sy, 0, 28, 'head'), tire);
            }
        } else if (p.type === 'spinner') {
            make(b => this._cylRaw(b, 26, 26, 0, p.sy + 26, 14, 'post'));
            bar = new BABYLON.Mesh('spinner-bar', scene);
            bar.parent = root;
            bar.rotationQuaternion = new BABYLON.Quaternion();
            const t = Math.max(18, p.sz / 2);
            make(b => this._box(b, p.sx / 2, p.sy - t, p.sy + t, t, 'bar', 'bar'), bar);
        } else if (p.type === 'hammer') {
            make(b => this._box(b, 18, -18, 18, 18, 'pivot', 'pivot'));
            arm = new BABYLON.Mesh('hammer-swing', scene);
            arm.parent = root;
            arm.rotationQuaternion = new BABYLON.Quaternion();
            // model=<id> — своя модель (шар на цепи wrecking_ball: начало — точка подвеса), иначе рукоять и боёк
            const mid = this._modelId(p);
            let model = null;
            if (mid) { try { model = Model3D.build(await Model3D.load(TRACK_MODELS[mid]), scene, { name: 'hammer-' + mid }); } catch (e) { model = null; } }
            if (model) {
                const k = Number(p.prm.ms) > 0 ? Number(p.prm.ms) : 1;
                model.parent = arm;
                model.scaling.set(k, k, k);
                for (const m of model.getChildMeshes(false)) m.isPickable = false;
            } else {
                make(b => this._box(b, 10, -p.sy, 0, 10, 'arm', 'arm'), arm);
                const head = BABYLON.MeshBuilder.CreateCylinder('hammer-head', { diameter: p.sx, height: p.sz, tessellation: 22 }, scene);
                head.material = this.mats.head;
                head.parent = arm;
                head.rotation.x = Math.PI / 2;
                head.position.y = -p.sy;
                head.isPickable = false;
            }
        } else {
            make(b => this._geometry(b, p));
        }
        World3D.addObject(view, root, 'prop', { outline: false, ink: false });
        this.meshes.push(root);
        this.nodes.push({ p, root, bar, arm, tire, roll: 0, lastX: null });
    },

    // ---------------------------------------------------------------------------------------------
    // Старт: линия старта и слоты решётки — краской на асфальте
    // ---------------------------------------------------------------------------------------------

    _startPaint(view) {
        const scene = view.scene, sp = ObbyCourse.respawn(0);
        const b = this._builder();
        const fx = Math.cos(sp.yaw), fz = Math.sin(sp.yaw), rx = -fz, rz = fx;
        // краска ложится на ту поверхность, что под колёсами: рельеф (дорога мира) или деталь трассы
        const surf = (x, z) => {
            let h = GameWorld.heightAt(x, z);
            const g = ObbyCourse.pieces.length ? ObbyCourse.groundAt(x, z, sp.y + 500, 1200) : null;
            if (g != null && g > h - 200) h = Math.max(h, g);
            return h + 1.6;
        };
        const pt = (along, lat) => { const x = sp.x + fx * along + rx * lat, z = sp.z + fz * along + rz * lat; return [x, surf(x, z), z]; };
        const quad = (key, a0, a1, l0, l1, u) => b.poly(key, [pt(a0, l0), pt(a0, l1), pt(a1, l1), pt(a1, l0)], [0, 1, 0], u || [[0, 0], [0, 1], [1, 1], [1, 0]]);
        // шахматная линия старта поперёк дороги перед машиной
        const half = 500;
        quad('checker', 300, 380, -half, half, [[0, 0], [0, 12], [1, 12], [1, 0]]);
        // рамки слотов: игрок и 4 бота
        const slot = (a, l) => {
            const w = 130, L = 260, t = 12;
            quad('paint', a - L, a - L + t, l - w, l + w); quad('paint', a + L - t, a + L, l - w, l + w);
            quad('paint', a - L, a + L, l - w, l - w + t); quad('paint', a - L, a + L, l + w - t, l + w);
        };
        slot(0, 0);
        const back = typeof BOT_GRID_BACK !== 'undefined' ? BOT_GRID_BACK : 750, side = typeof BOT_GRID_SIDE !== 'undefined' ? BOT_GRID_SIDE : 240;
        for (let i = 0; i < 4; i++) slot(-back * (Math.floor(i / 2) + 1), side * (i % 2 ? 1 : -1));
        for (const m of b.toMeshes(scene, this.mats, 'start')) { this._register(view, m, true, { castShadow: false }); m.receiveShadows = true; }
    },

    // ---------------------------------------------------------------------------------------------
    // Ворота чекпоинтов и финиша
    // ---------------------------------------------------------------------------------------------

    async _gates(view) {
        const scene = view.scene, C = ObbyCourse;
        const glow = (root, color) => {
            for (const m of root.getChildMeshes(false)) {
                const part = m.metadata && m.metadata.part;
                if (part !== 'Glow' && part !== 'Lights') continue;
                const mat = new BABYLON.StandardMaterial('gate-glow', scene);
                mat.diffuseColor = BABYLON.Color3.FromHexString(color);
                mat.emissiveColor = BABYLON.Color3.FromHexString(color).scale(0.8);
                mat.metadata = { toon: false };
                m.material = mat;
                return mat;
            }
            return null;
        };
        const place = async (url, s, kind, n) => {
            let root = null;
            try { root = Model3D.build(await Model3D.load(url), scene, { name: kind }); } catch (e) { root = null; }
            if (!root) {
                // запасные ворота: две стойки и перекладина
                root = new BABYLON.Mesh(kind, scene);
                for (const z of [-650, 650]) { const post = BABYLON.MeshBuilder.CreateBox('gate-post', { width: 40, height: 600, depth: 40 }, scene); post.parent = root; post.position.set(0, 300, z); post.material = this.mats.pivot; }
                const beam = BABYLON.MeshBuilder.CreateBox('gate-beam', { width: 40, height: 60, depth: 1340 }, scene); beam.parent = root; beam.position.set(0, 600, 0); beam.material = kind === 'finish' ? this.mats.checker : this.mats.lime;
            }
            const w = Math.max(700, 2 * (s.r - 120));
            const k = Math.max(0.55, (w + 160) / 1420);
            root.scaling.set(1, Math.min(1.2, Math.max(0.8, k)), k);
            root.position.set(s.x, s.y, s.z);
            root.rotation.y = -s.yaw;
            for (const m of root.getChildMeshes(false)) m.isPickable = false;
            World3D.addObject(view, root, 'prop', { outline: false, ink: false });
            this.meshes.push(root);
            const mat = glow(root, kind === 'finish' ? '#c5ef5c' : '#ffffff');
            this.gates.push({ kind, n, root, mat });
        };
        for (const cp of C.checkpoints) await place('assets/models/props/checkpoint_gate.glb', cp, 'checkpoint', cp.n);
        if (C.finish) await place('assets/models/props/finish_gate.glb', C.finish, 'finish', C.finish.n);
    },

    /** Взятые этапы: ворота пройденных чекпоинтов гаснут, следующие светятся лаймом. */
    setStage(stage) {
        this._stage = stage | 0;
        for (const g of this.gates) {
            if (!g.mat || g.kind === 'finish') continue;
            const done = g.n <= this._stage, next = g.n === this._stage + 1;
            const c = done ? '#5b6170' : next ? '#c5ef5c' : '#ffffff';
            g.mat.diffuseColor = BABYLON.Color3.FromHexString(c);
            g.mat.emissiveColor = BABYLON.Color3.FromHexString(c).scale(done ? 0.2 : 0.8);
        }
    },

    // ---------------------------------------------------------------------------------------------
    // Гараж: подиум парит рядом со стартом
    // ---------------------------------------------------------------------------------------------

    // Где поставить подиум меню: ровная земля у старта, не на дороге, с наибольшим свободным местом вокруг — иначе в городе витрина
    // оказывается внутри здания. null — на карте нет земли мира.
    _podiumPlace(sp) {
        const W = typeof GameWorld !== 'undefined' && GameWorld.active ? GameWorld : null;
        if (!W) return null;
        const NEED = TRACK_PODIUM_CLEAR;
        /** @type {any[]} */ const near = [];
        /** @type {any[]} */ const decor = [];
        let best = null, bestScore = -Infinity;
        for (let r = 2400; r <= TRACK_PODIUM_SEARCH; r += 1200) for (let a = 0; a < 24; a++) {
            const ang = sp.yaw + (a / 24) * Math.PI * 2 + r * 0.0007;
            const x = sp.x + Math.cos(ang) * r, z = sp.z + Math.sin(ang) * r;
            if (W.surfaceAt(x, z).name === 'asphalt') continue;      // на проезжей части подиум не ставим (плиты тротуаров и полигона годятся)
            const y = W.heightAt(x, z);
            const hh = [W.heightAt(x - 700, z), W.heightAt(x + 700, z), W.heightAt(x, z - 700), W.heightAt(x, z + 700)];
            if (Math.max(...hh) - Math.min(...hh) > 140) continue;     // на склоне подиум повиснет
            let clear = NEED;
            const dist = (px, pz, x0, z0, x1, z1) => Math.hypot(Math.max(x0 - px, 0, px - x1), Math.max(z0 - pz, 0, pz - z1));
            ObbyCourse._near(x - NEED, z - NEED, x + NEED, z + NEED, near);
            for (const c of near) {
                const bb = c.aabb;
                if (c.zone || bb[4] < y + 40 || bb[1] > y + 1800) continue;
                clear = Math.min(clear, dist(x, z, bb[0], bb[2], bb[3], bb[5]));
            }
            for (const L of this.lods) for (let i = 0; i < L.n && clear > 0; i++) clear = Math.min(clear, Math.hypot(L.pos[i * 2] - x, L.pos[i * 2 + 1] - z) - L.radius);
            if (W.decorNear) { decor.length = 0; W.decorNear(x - NEED, z - NEED, x + NEED, z + NEED, decor); for (const it of decor) clear = Math.min(clear, Math.hypot(it.x - x, it.z - z) - (it.r || 40) - 120); }
            const score = clear - r * 0.02;
            if (score > bestScore) { bestScore = score; best = { x, y, z, yaw: sp.yaw }; }
        }
        return best;
    },

    /** Сколько свободно от точки (x, y, z) по направлению (dx, dz, единичное) до max: коллайдеры и модели карты. Для витрины меню. */
    freeRange(x, y, z, dx, dz, max) {
        let t = max;
        const hit = ObbyCourse.ray(x, y, z, dx, 0, dz, max);
        if (hit) t = Math.min(t, hit.t);
        for (const L of this.lods) {
            const r = L.radius;
            for (let i = 0; i < L.n; i++) {
                const ox = L.pos[i * 2] - x, oz = L.pos[i * 2 + 1] - z, along = ox * dx + oz * dz;
                if (along < -r || along - r > t) continue;
                const px = ox - dx * along, pz = oz - dz * along, d2 = px * px + pz * pz;
                if (d2 < r * r) t = Math.min(t, Math.max(0, along - Math.sqrt(r * r - d2)));
            }
        }
        return t;
    },

    async _buildPodium(view) {
        const sp = ObbyCourse.respawn(0);
        const fx = Math.cos(sp.yaw), fz = Math.sin(sp.yaw), rx = -fz, rz = fx;
        const g = this._podiumPlace(sp) || { x: sp.x - fx * 2600 - rx * 3600, y: sp.y + 1400, z: sp.z - fz * 2600 - rz * 3600, yaw: sp.yaw };
        this.garage = g;
        let root = null;
        try { root = Model3D.build(await Model3D.load('assets/models/props/podium.glb'), view.scene, { name: 'podium' }); } catch (e) { root = null; }
        if (!root) {
            root = BABYLON.MeshBuilder.CreateCylinder('podium', { diameter: 700, height: 50, tessellation: 40 }, view.scene);
            root.material = this.mats.pivot;
            root.position.y = 25;
            const holder = new BABYLON.Mesh('podium-root', view.scene); root.parent = holder; root = holder;
        }
        root.position.set(g.x, g.y, g.z);
        for (const m of root.getChildMeshes(false)) {
            m.isPickable = false;
            if (m.metadata && m.metadata.part === 'Glow' && m.material) {
                // светящееся кольцо подиума — жёлтое, как разметка краш-теста
                const glow = new BABYLON.StandardMaterial('podium-glow', view.scene);
                glow.diffuseColor = new BABYLON.Color3(1, 0.76, 0);
                glow.emissiveColor = new BABYLON.Color3(0.92, 0.66, 0.02);
                glow.specularColor = new BABYLON.Color3(0, 0, 0);
                glow.metadata = { toon: false };
                m.useVertexColors = false;
                m.material = glow;
                this.mats.podiumGlow = glow;
            }
        }
        World3D.addObject(view, root, 'prop', { outline: false, ink: false });
        this.meshes.push(root);
        this.podium = root;
    },

    /** Где стоит машина на подиуме: { x, y (верх подиума), z, yaw }. */
    podiumSpot() { const g = this.garage || { x: 0, y: 0, z: 0, yaw: 0 }; return { x: g.x, y: g.y + 50, z: g.z, yaw: g.yaw }; },

    // ---------------------------------------------------------------------------------------------
    // Кадр
    // ---------------------------------------------------------------------------------------------

    update(dt, focus) {
        const C = ObbyCourse;
        this.time += dt;
        if (this.lods.length && (this._lodT++ & 3) === 0) this._lodUpdate();
        const t = C.time, mats = this.mats;
        if (mats.boost && mats.boost.diffuseTexture) mats.boost.diffuseTexture.uOffset = -(t * 1.6) % 1;
        if (mats.kill) { const k = 0.75 + 0.25 * Math.sin(t * 4); mats.kill.emissiveColor.set(0.95 * k, 0.32 * k, 0.06 * k); }
        for (const g of this.gates) if (g.mat && g.n === this._stage + 1) { const k = 0.6 + 0.4 * Math.sin(this.time * 5); g.mat.emissiveColor.set(0.77 * k, 0.94 * k, 0.36 * k); }
        const R = 18000;
        for (const n of this.nodes) {
            const p = n.p;
            if (focus && p.reach && (p.reach[3] < focus.x - R || p.reach[0] > focus.x + R || p.reach[5] < focus.z - R || p.reach[2] > focus.z + R)) continue;
            const pose = C.current(p);
            const O = pose.O, ax = pose.ax, ay = pose.ay, az = pose.az;
            n.root.position.set(O[0], O[1], O[2]);
            BABYLON.Quaternion.FromRotationMatrixToRef(BABYLON.Matrix.FromValues(ax[0], ax[1], ax[2], 0, ay[0], ay[1], ay[2], 0, az[0], az[1], az[2], 0, 0, 0, 0, 1), n.root.rotationQuaternion);
            if (n.bar) BABYLON.Quaternion.RotationAxisToRef(BABYLON.Axis.Y, pose.angle, n.bar.rotationQuaternion);
            if (n.arm) BABYLON.Quaternion.RotationAxisToRef(BABYLON.Axis.X, pose.angle, n.arm.rotationQuaternion);
            if (n.tire) {
                // катится: поворот вокруг своей оси (локальная Y детали) по пройденному пути
                const along = O[0] * ax[0] + O[2] * ax[2];
                if (n.lastX != null) n.roll += (along - n.lastX) / (p.sx / 2);
                n.lastX = along;
                BABYLON.Quaternion.RotationAxisToRef(BABYLON.Axis.Y, -n.roll, n.tire.rotationQuaternion);
            }
            if (p.role === 'fall') n.root.setEnabled(p.fallState !== 'drop' || p.fallDrop < 2500);
        }
        // маленькие модели вдали не рисуются (высокие — видны до дальней плоскости)
        if (focus && this.farCull.length && (++this._cullT & 7) === 0) {
            for (const c of this.farCull) {
                const on = Math.abs(c.x - focus.x) + Math.abs(c.z - focus.z) < TRACK_MODEL_DRAW * 1.3;
                if (on !== c.on) { c.on = on; c.m.setEnabled(on); }
            }
        }
        GameWorld.update(dt);
        Props.sync(dt);
    },
};
