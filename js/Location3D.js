// Location3D.js — локация: 3D-вид (свет, небо, туман, тени), земля (Terrain3D) и
// объекты ОДНОЙ карты из Maps.js (GAME_MAPS). Карта задаёт размер, текстуру
// земли, рельеф и объекты: модели (FBX / OBJ / glTF), маркеры — точки для логики
// игры (спавн, враги, финиш; в игре невидимы, в редакторе — булавки). Карты
// расставляет и правит редактор. Смена карты — loadMap(map): вид (сцена, камера,
// свет) остаётся, земля и объекты пересобираются.
// Общая для игры (main.js) и редактора (_utils/editor/lab.js): оба зовут
// update(dt) каждый кадр — вращение частей моделей (def.anim). Свои объекты игра
// создаёт в location.view.scene и регистрирует World3D.addObject(location.view,
// mesh, 'actor' | 'prop'); ставить на землю — по location.terrain.heightAt(x, y).
//
// МАРКЕРЫ-ЗОНЫ карты (zone-flat, zone-raise, paint-<тип>, water) читает Terrain3D (см. его
// шапку): рельеф, покраска и вода пересобираются с землёй. Редактор правит их живо —
// placeObject / markerEdited / addObject / removeObject маркера ставят пересборку не чаще
// кадра (refreshZones: меняется только то, что изменилось — холмы пересобирают землю,
// покраска и вода — каждая себя). Для игры: groundTypeAt(x, y), waterAt(x, y). В редакторе
// (showMarkers) у зоны ещё контур по рельефу — круг или повёрнутый прямоугольник.
//
// БАТЧИНГ ДЕКОРА (игра: opts.batchDecor): объекты с моделью из папки декора
// (Location3D.DECOR_PREFIX) становятся thin instances — одна пара мешей на модель, а не
// по мешу на объект: draw calls не растут от числа деревьев. Тени работают (прототип —
// кастер), контур рёбер — на прототипе; обводка силуэта у инстансов — по DECOR_BATCH_OUTLINE
// (0 нет, 1 только ПК, 2 везде; по умолчанию нет: тон обводки у инстансов один на меш, и
// далёкие деревья «светились» бы контуром сквозь туман). В буфере инстансов — только объекты
// в пределах видимости от камеры (туман съедает остальное): _cullBatches, раз в 5% дальности.
// У такого объекта rec.mesh = null, rec.batch — пачка; placeObject/removeObject работают.
// Модели из opts.batchRepeated (папки) идут в пачку, если стоят на карте не меньше BATCH_MIN раз
// (скамейки, фонари); одиночные ориентиры — мешами. Части модели с несколькими цветными
// материалами склеиваются в один submesh с вершинными цветами (Location3D.mergeColors): draw call
// на деталь, не на материал. Тень пачки рисует отдельный меш-прокси (part.sh) только с
// инстансами у кадра солнца: основной меш в карту теней не ставится, пачка без инстансов у
// игрока тени не стоит. Выключенные тени (WORLD3D_SHADOWS = 0) прокси не набирают.
//
// ПРОРЕЖИВАНИЕ ДЕКОРА ПО УРОВНЮ ГРАФИКИ (opts.quality, Quality.js): объект kind 'prop' из папки
// декора (без anim) остаётся на сцене, только если его место Location3D.decorRank(def) < доли
// Quality.decorKeep() — детерминированно по модели и позиции, а не по номеру в списке: на каждой
// загрузке остаются одни и те же деревья, и множество «низкого» входит в «среднее», а оно — в
// «высокое». Убранный объект — запись без меша (rec.hidden), она остаётся в map.objects и
// location.objects на своём месте. Смена уровня — applyDecor(): меши появляются и исчезают живо.

class Location3D {
    // opts: { assetBase?: '' — игра (пути от index.html) | '/' — редактор (от корня сервера),
    //         map?: запись GAME_MAPS (правится на месте: объекты — её objects),
    //         showMarkers?: булавки маркеров и контуры зон (редактор),
    //         batchDecor?: декор из папки декора — инстансами (игра), decorPrefix? — другая папка
    //           (строка или массив), batchRepeated? — папки, чьи модели идут в пачку при повторах,
    //         quality?: прореживать декор по Quality.decorKeep() (игра), decorKeep?: доля 0..1 вручную,
    //         onTerrain?: (terrain) => void — землю пересобрала правка зон (редактор: камере нужна новая) }
    constructor(opts) {
        this.opts = opts || {};
        this.view = World3D.createView({});
        if (this.view) /** @type {any} */ (this.view).location = this;   // обратная ссылка: CameraSight берёт отсюда пачки декора для заслонов
        this.terrain = null;
        /** @type {LocationObject[]} */
        this.objects = [];   // { def, mesh, error, loaded } — см. addObject
        /** @type {GameMap} */
        this.map = null;
        this._groundImage = null;
        this._groundIndex = -1;
        /** @type {Map<string, any>} */
        this._batches = new Map();   // 'модель|вид' -> пачка инстансов
        this._modelCounts = new Map();   // модель -> сколько раз стоит на карте
        this._dirtyBatches = new Set();
        this._placingAll = false;
        this._zoneQueued = false;
        /** @type {{ rel: string, paint: string, water: string } | null} */
        this._zoneSig = null;
        /** @type {(() => void) | null} */
        this._offQuality = null;
        if (this.opts.quality && typeof Quality !== 'undefined') this._offQuality = Quality.onChange(() => this.applyDecor());
        /** @type {Promise<any>} */
        this.ready = this.loadMap(this.opts.map || Location3D.newMap('map'));
    }

    // Размеры и рельеф — из карты; нет поля — дефолт (карта старше кода или пустая).
    get width() { return Math.max(64, Number(this.map && this.map.width) || 2048); }
    get height() { return Math.max(64, Number(this.map && this.map.height) || 2048); }

    // Показать карту: прежние объекты уходят, земля и объекты — по новой карте.
    // map правится на месте: addObject/removeObject держат map.objects в том же
    // порядке, что this.objects. Игре — копия (Location3D.copyMap), чтобы правки
    // во время игры не попадали в GAME_MAPS. Промис — как ready.
    /** @param {GameMap} map */
    loadMap(map) {
        for (const rec of this.objects.slice()) this._drop(rec);
        this.objects = [];
        this._batches.clear();
        this._dirtyBatches.clear();
        this.map = map;
        if (!Array.isArray(map.objects)) map.objects = [];
        this._modelCounts = this._countModels(map.objects);
        this.buildTerrain();
        let completed = 0;
        this._placingAll = true;   // маркеры-зоны не просят пересборку: земля только что собрана
        let models;
        try {
            models = map.objects.slice().map(def => this._add(def).loaded.then(rec => {
                completed++;
                if (this.opts.onProgress) this.opts.onProgress(completed, map.objects.length);
                return rec;
            }));
        } finally { this._placingAll = false; }
        // Готова — текстура земли и модели объектов пришли (или не нашлись) и шейдеры сцены
        // собраны. Не дольше READY_TIMEOUT: сломанный ассет не держит экран загрузки вечно.
        const view = this.view;
        this.ready = Promise.all([this.loadGround()].concat(models))
            .then(() => new Promise(resolve => {
                this._flushBatches();   // инстансы декора готовы до сборки шейдеров
                view.scene.executeWhenReady(() => resolve(undefined));
                setTimeout(resolve, Location3D.READY_TIMEOUT);
            }));
        return this.ready;
    }

    // (Пере)собрать землю по размерам и рельефу карты (редактор — живо).
    // Объекты карты встают на новую землю; свои объекты игры — забота владельца.
    buildTerrain() {
        if (this.terrain) this.terrain.dispose();
        const t = /** @type {any} */ ((this.map && this.map.terrain) || {});
        const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
        this.terrain = new Terrain3D(this.view, {
            worldW: this.width,
            worldH: this.height,
            groundImage: this._groundImage,
            noise: { amp: Math.max(0, num(t.amp, 40)), scale: num(t.scale, 800), seed: num(t.seed, 1), base: num(t.base, 0) },
            markers: this._markerDefs(),
            baseType: this.groundEntry().type
        });
        this._zoneSig = this._zoneSigs();
        this.placeObjects();
        return this.terrain;
    }

    // --- Зоны: маркеры zone-*, paint-*, water ------------------------------------------------

    _markerDefs() {
        return ((this.map && this.map.objects) || []).filter(d => d.kind === 'marker');
    }

    // Подписи (JSON полей) маркеров-зон по частям: rel — холмы и ровные участки (земля),
    // paint, water. Изменилась подпись — пересобирается своя часть.
    _zoneSigs() {
        const rel = [], paint = [], water = [];
        for (const d of this._markerDefs()) {
            const k = Terrain3D.zoneKind(d.name);
            if (!k) continue;
            (k.kind === 'paint' ? paint : k.kind === 'water' ? water : rel).push([d.name, d.x, d.y, d.h, d.rot, d.scale]);
        }
        return { rel: JSON.stringify(rel), paint: JSON.stringify(paint), water: JSON.stringify(water) };
    }

    // Правка маркера (редактор: сдвиг, размер, имя, добавление, удаление): сверка зон не чаще кадра.
    // Маркер мог СТАТЬ зоной или перестать ею быть (имя), поэтому ставим сверку для любого маркера:
    // не-зона и неизменившиеся зоны — ничего не пересобирается (подписи совпали).
    /** @param {LocationObject | LocationObjectDef} recOrDef */
    markerEdited(recOrDef) {
        const rec = /** @type {any} */ (recOrDef).def ? /** @type {LocationObject} */ (recOrDef) : this.objects.find(r => r.def === recOrDef);
        const d = rec ? rec.def : /** @type {LocationObjectDef} */ (recOrDef);
        if (!d || d.kind !== 'marker') return;
        if (rec) this._updateZoneLine(rec);
        this.queueZones();
    }

    queueZones() {
        if (this._zoneQueued) return;
        this._zoneQueued = true;
        const run = () => { this._zoneQueued = false; if (this.view) this.refreshZones(); };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
        else if (typeof setTimeout === 'function') setTimeout(run, 0);
        else run();
    }

    // Пересобрать то, что изменилось в зонах: холмы и ровные участки — всю землю (и
    // воду, и объекты на ней), покраску и воду — только себя. true — что-то пересобрано.
    refreshZones() {
        if (!this.terrain || !this.map) return false;
        const now = this._zoneSigs(), was = this._zoneSig || { rel: '', paint: '', water: '' };
        if (now.rel !== was.rel) {
            this.buildTerrain();
            if (this.opts.onTerrain) this.opts.onTerrain(this.terrain);
            return true;
        }
        this._zoneSig = now;
        let changed = false;
        if (now.paint !== was.paint) { this.terrain.setPaints(this._markerDefs()); changed = true; }
        if (now.water !== was.water) { this.terrain.setWaters(this._markerDefs()); changed = true; }
        return changed;
    }

    // Тип земли под точкой для логики игры ('grass' | 'sand' | 'snow' — основа карты, или тип
    // покраски paint-<тип>: dirt, path, sand, snow, rock, dark, grass2, lava). Не зависит от
    // устройства: считается по маркерам карты, а не по сетке террейна.
    /** @returns {string} */
    groundTypeAt(x, y) {
        return this.terrain ? this.terrain.groundTypeAt(x, y) : 'grass';
    }

    // Уровень воды под точкой (px) или null: точка внутри маркера water и земля под ней ниже воды.
    /** @returns {number | null} */
    waterAt(x, y) {
        return this.terrain ? this.terrain.waterAt(x, y) : null;
    }

    // Контур зоны на земле (редактор, showMarkers): ломаная по рельефу, круг или повёрнутый
    // прямоугольник, поверх мира (слой OVERLAY: виден и за холмом). Точек столько, чтобы между ними
    // было порядка 24 px; число точек то же — ломаная обновляется на месте, иначе строится заново.
    // Цвет — по виду зоны (покраска — цвет краски). У не-зоны контура нет. Обновляется при каждой
    // правке маркера и пересборке земли.
    /** @param {LocationObject} rec */
    _updateZoneLine(rec) {
        const d = rec.def, k = this.opts.showMarkers && d.kind === 'marker' ? Terrain3D.zoneKind(d.name) : null;
        if (!k || !this.terrain || !this.view) { this._dropZoneLine(rec); return; }
        const s = Terrain3D.shapeOf(d);
        if (k.kind === 'raise' || k.kind === 'water') s.rect = false;
        const N = Math.max(12, Math.min(256, Math.ceil((s.rect ? 2 * Math.max(s.a, s.b) : Math.PI * s.a / 2) / 24)));
        const pts = [], t = this.terrain;
        const at = (lx, lz) => {
            const px = s.x + lx * s.cos - lz * s.sin, py = s.y + lx * s.sin + lz * s.cos;
            pts.push(new BABYLON.Vector3(px, t.heightAt(px, py) + 6, py));
        };
        if (s.rect) {
            const a = s.a, b = s.b;
            for (let i = 0; i < N; i++) at(-a + 2 * a * i / N, -b);
            for (let i = 0; i < N; i++) at(a, -b + 2 * b * i / N);
            for (let i = 0; i < N; i++) at(a - 2 * a * i / N, b);
            for (let i = 0; i < N; i++) at(-a, b - 2 * b * i / N);
            at(-a, -b);
        } else {
            for (let i = 0; i <= 4 * N; i++) { const q = i / (4 * N) * Math.PI * 2; at(Math.cos(q) * s.a, Math.sin(q) * s.a); }
        }
        const scene = this.view.scene;
        if (rec.zone && !rec.zone.isDisposed() && rec.zoneN === pts.length) {
            rec.zone = BABYLON.MeshBuilder.CreateLines(rec.zone.name, { points: pts, instance: rec.zone }, scene);
        } else {
            this._dropZoneLine(rec);
            const line = rec.zone = BABYLON.MeshBuilder.CreateLines('zone:' + d.name, { points: pts, updatable: true }, scene);
            rec.zoneN = pts.length;
            line.isPickable = false;
            line.alwaysSelectAsActiveMesh = true;
            line.renderingGroupId = World3D.LAYER.OVERLAY;
            const mat = /** @type {any} */ (line.material);
            if (mat) { mat.depthFunction = BABYLON.Constants.ALWAYS; mat.disableDepthWrite = true; }
        }
        const hex = k.kind === 'paint' ? (Terrain3D.PAINT_COLORS[k.type || ''] || 0xffffff) : Location3D.ZONE_COLORS[k.kind] || 0xffffff;
        rec.zone.color = World3D.hexColor3(hex);
    }

    /** @param {LocationObject} rec */
    _dropZoneLine(rec) {
        if (rec.zone) { try { rec.zone.dispose(); } catch (e) { /* уже снят */ } }
        rec.zone = null;
    }

    // --- Объекты карты --------------------------------------------------------------

    // Запись карты -> объект: { def, mesh, error, loaded }. Запись
    // возвращается сразу, меш появляется, когда модель догрузится (loaded —
    // промис). Нет файла — объект без меша (error), сцена не падает.
    // def: { name, model, kind, x, y, h, rot, scale, anim? } — поля живые: правка +
    // placeObject; anim читается каждый кадр (spinPart). kind 'marker' — маркер без модели.
    // at — место в списке (по умолчанию — в конец); def попадает и в map.objects.
    /** @param {LocationObjectDef} def @param {number} [at] @returns {LocationObject} */
    addObject(def, at) {
        const list = this.map.objects;
        const i = list.indexOf(def);
        if (i >= 0) list.splice(i, 1);
        const pos = at == null || at < 0 || at > this.objects.length ? this.objects.length : at;
        list.splice(pos, 0, def);
        if (def.kind !== 'marker' && typeof def.model === 'string') this._modelCounts.set(def.model, (this._modelCounts.get(def.model) || 0) + 1);
        const rec = this._add(def, pos);
        this.markerEdited(rec);
        return rec;
    }

    /** @param {LocationObjectDef} def @param {number} [at] @returns {LocationObject} */
    _add(def, at) {
        /** @type {LocationObject} */
        const rec = { def, mesh: null, error: null, loaded: null };
        this.objects.splice(at == null ? this.objects.length : at, 0, rec);
        if (def.kind === 'marker') {
            if (this.opts.showMarkers) {
                rec.mesh = Location3D.markerMesh(this.view.scene, def.name || 'marker');
                rec.mesh.metadata = { locationObject: rec };
                this.placeObject(rec);
            }
            rec.loaded = Promise.resolve(rec);
            return rec;
        }
        if (this._decorOff(def)) {   // прореженный декор: запись есть, меша нет
            rec.hidden = true;
            rec.loaded = Promise.resolve(rec);
            return rec;
        }
        return this._build(rec);
    }

    // Меш (или инстанс пачки) для записи с моделью.
    /** @param {LocationObject} rec @returns {LocationObject} */
    _build(rec) {
        const def = rec.def;
        if (this._batchable(def)) return this._addBatched(rec);
        rec.loaded = Model3D.load((this.opts.assetBase || '') + def.model).then((model) => {
            if (this.objects.indexOf(rec) < 0 || !this.view || rec.mesh || rec.hidden) return rec;   // сняли, спрятали или собрали, пока грузилась
            rec.mesh = Model3D.build(model, this.view.scene, { name: def.name || 'object' });
            rec.mesh.metadata = { locationObject: rec };
            World3D.addObject(this.view, rec.mesh, def.kind);
            this.placeObject(rec);
            return rec;
        }).catch((e) => {
            rec.error = (e && e.message) || String(e);
            console.warn('Location3D: не загрузилась модель ' + def.model + ' — ' + rec.error);
            return rec;
        });
        return rec;
    }

    // Меш — по полям def: позиция на земле + h; rot — [x, y, z] градусы (y — курс по
    // карте, как heading: rotation.y = −y; x, z — наклон); scale — [x, y, z]. Старая
    // запись с числами (rot — только курс, scale — равномерный) тоже читается.
    /** @param {LocationObject} rec */
    placeObject(rec) {
        const m = rec.mesh, d = rec.def;
        if (rec.batch) { this._dirtyBatches.add(rec.batch); return; }   // инстанс: матрицу пересоберёт flush
        if (!this._placingAll && d.kind === 'marker') this.markerEdited(rec);   // зона — пересборка земли
        else if (this._placingAll && d.kind === 'marker') this._updateZoneLine(rec);
        if (!m) return;
        const x = Number(d.x) || 0, y = Number(d.y) || 0, D = Math.PI / 180;
        const r = Array.isArray(d.rot) ? d.rot : [0, d.rot, 0];
        const s = Array.isArray(d.scale) ? d.scale : [d.scale, d.scale, d.scale];
        const k = (v) => (Number(v) > 0 ? Number(v) : 1);
        m.position.set(x, (this.terrain ? this.terrain.heightAt(x, y) : 0) + (Number(d.h) || 0), y);
        m.rotationQuaternion = null;   // кватернион (его может поставить гизмо) перекрыл бы rotation
        m.rotation.set((Number(r[0]) || 0) * D, -(Number(r[1]) || 0) * D, (Number(r[2]) || 0) * D);
        m.scaling.set(k(s[0]), k(s[1]), k(s[2]));
    }

    placeObjects() {
        this._placingAll = true;   // маркеры-зоны не просят пересборку: земля только что собрана
        try { for (const rec of this.objects) this.placeObject(rec); } finally { this._placingAll = false; }
    }

    // --- Декор: папка, прореживание по уровню графики -----------------------------------------

    // Папки декора (префиксы пути модели): opts.decorPrefix или Location3D.DECOR_PREFIX.
    /** @returns {string[]} */
    _decorPrefixes() {
        const p = this.opts.decorPrefix;
        return p ? [].concat(p) : [Location3D.DECOR_PREFIX];
    }

    // Декор карты: окружение (kind 'prop') из папки декора и без анимации части.
    /** @param {LocationObjectDef} def */
    isDecor(def) {
        return def.kind === 'prop' && !def.anim && typeof def.model === 'string' &&
            this._decorPrefixes().some(p => def.model.indexOf(p) === 0);
    }

    // Доля декора, которая остаётся на сцене, 0..1: opts.decorKeep (число), иначе Quality.decorKeep()
    // при opts.quality, иначе всё.
    _decorKeep() {
        const o = this.opts.decorKeep;
        if (typeof o === 'number') return Math.max(0, Math.min(1, o));
        if (this.opts.quality && typeof Quality !== 'undefined') return Math.max(0, Math.min(1, Quality.decorKeep()));
        return 1;
    }

    // Объект прорежен? Детерминированно: место декора в порядке Location3D.decorRank против доли.
    /** @param {LocationObjectDef} def */
    _decorOff(def) {
        const keep = this._decorKeep();
        return keep < 1 && this.isDecor(def) && Location3D.decorRank(def) >= keep;
    }

    // Место объекта среди декора, 0..1: хэш модели и позиции (в целых px). Не зависит ни от номера в
    // списке, ни от других объектов, ни от запуска: одно и то же дерево всегда «выпадает» или остаётся
    // при одной и той же доле, а при росте доли остаются все прежние (множества вложены).
    /** @param {LocationObjectDef} def @returns {number} */
    static decorRank(def) {
        let h = 2166136261;
        const m = String(def.model || '');
        for (let i = 0; i < m.length; i++) { h ^= m.charCodeAt(i); h = Math.imul(h, 16777619); }
        h = Math.imul(h ^ Math.round(Number(def.x) || 0), 0x85ebca6b);
        h = Math.imul(h ^ Math.round(Number(def.y) || 0), 0xc2b2ae35);
        h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
        h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
        h ^= h >>> 16;
        return (h >>> 0) / 4294967296;
    }

    // Уровень графики сменился (Quality.onChange) или поменяли opts.decorKeep: декор появляется и
    // исчезает на живой сцене. Меши убранного снимаются, пачки перебирают инстансы.
    applyDecor() {
        if (!this.view) return;
        for (const rec of this.objects) {
            const d = rec.def;
            if (d.kind === 'marker') continue;
            const off = this._decorOff(d);
            if (off === !!rec.hidden) continue;
            rec.hidden = off;
            if (rec.batch) { this._dirtyBatches.add(rec.batch); continue; }
            if (off) {
                if (rec.mesh) { Model3D.dispose(this.view, rec.mesh); rec.mesh = null; }
                rec.loaded = Promise.resolve(rec);
            } else {
                this._build(rec);
            }
        }
    }

    // --- Батчинг декора (opts.batchDecor) -----------------------------------------------------

    // Объект идёт в инстансы: модель из папки декора (всегда) или из папок opts.batchRepeated — только
    // если эта модель стоит на карте не меньше BATCH_MIN раз (у одиночного объекта пачка ничего не
    // экономит и отсекается по кадру хуже). Объект с анимацией части (её вращают у меша) остаётся мешем.
    /** @param {LocationObjectDef} def */
    _batchable(def) {
        if (!this.opts.batchDecor || def.kind === 'marker' || def.anim || typeof def.model !== 'string') return false;
        if (this._decorPrefixes().some(p => def.model.indexOf(p) === 0)) return true;
        const rep = /** @type {string[]} */ ([]).concat(this.opts.batchRepeated || []);
        return rep.some(p => def.model.indexOf(p) === 0) && (this._modelCounts.get(def.model) || 0) >= Location3D.BATCH_MIN;
    }

    // Сколько раз каждая модель стоит на карте (для решения «в пачку или мешем»).
    /** @param {LocationObjectDef[]} list */
    _countModels(list) {
        const counts = new Map();
        for (const d of list) if (d.kind !== 'marker' && typeof d.model === 'string') counts.set(d.model, (counts.get(d.model) || 0) + 1);
        return counts;
    }

    // Объект -> пачка своей модели. Модель грузится один раз (Model3D.load кэширует); меши
    // прототипа строятся при первом объекте пачки, инстансы собирает _flushBatch.
    /** @param {LocationObject} rec */
    _addBatched(rec) {
        const def = rec.def, kind = def.kind === 'actor' ? 'actor' : 'prop';
        const key = def.model + '|' + kind;
        let batch = this._batches.get(key);
        if (!batch) {
            batch = { key, model: def.model, kind, recs: [], parts: null };
            this._batches.set(key, batch);
        }
        if (!batch.recs.includes(rec)) batch.recs.push(rec);
        rec.batch = batch;
        rec.loaded = Model3D.load((this.opts.assetBase || '') + def.model).then((model) => {
            if (rec.dead || !this.view) return rec;   // сняли, пока грузилась
            if (!batch.parts) this._buildBatch(batch, model);
            this._dirtyBatches.add(batch);
            return rec;
        }).catch((e) => {
            rec.error = (e && e.message) || String(e);
            console.warn('Location3D: не загрузилась модель ' + def.model + ' — ' + rec.error);
            this._dirtyBatches.add(batch);
            return rec;
        });
        return rec;
    }

    // Прототип пачки: меши модели без родителя и без собственного положения — положение каждого
    // экземпляра (и положение части в модели) несёт матрица инстанса. Контур рёбер и тени —
    // штатные World3D.addObject; обводка силуэта — по DECOR_BATCH_OUTLINE.
    // Тень пачки — отдельный меш-«прокси» на копии тех же вершин (part.sh; свой Geometry — у него свой буфер матриц): в него попадают только инстансы, задевающие кадр
    // солнца (_cullShadow), а основной меш в карту теней не ставится. Так в карте теней рисуются не все деревья в
    // дальности тумана, а те, что рядом, и пачка без инстансов у игрока не стоит draw call. Прокси спрятан от камеры маской слоя.
    _buildBatch(batch, model) {
        const scene = this.view.scene;
        const root = Model3D.build(model, scene, { name: batch.model.split('/').pop() });
        const level = typeof DECOR_BATCH_OUTLINE !== 'undefined' ? DECOR_BATCH_OUTLINE : 0;
        const outline = level >= 2 || (level >= 1 && !IS_MOBILE);
        const decor = this.isDecor({ kind: batch.kind, model: batch.model, name: '', x: 0, y: 0, h: 0, rot: [0, 0, 0], scale: [1, 1, 1] });
        // Радиус модели от её начала координат (инстанс стоит началом на земле): по дальнему углу габарита.
        const ext = (a, b) => Math.max(Math.abs(a), Math.abs(b));
        batch.radius = model.min && model.max && Number.isFinite(model.min[0]) ? Math.hypot(ext(model.min[0], model.max[0]), ext(model.min[1], model.max[1]), ext(model.min[2], model.max[2])) : 200;
        batch.min = model.min; batch.max = model.max;   // габарит модели: CameraSight строит по нему габарит инстанса
        batch.parts = [];
        for (const mesh of root.getChildMeshes(true)) {
            Location3D.mergeColors(mesh);   // части с несколькими цветными материалами — один draw call (и в тенях тоже)
            mesh.computeWorldMatrix(true);
            const local = mesh.getWorldMatrix().clone();   // корень в начале координат: часть в системе модели
            mesh.parent = null;
            mesh.isPickable = false;
            const proxied = this.opts.shadowProxies !== false && !!mesh.geometry;
            World3D.addObject(this.view, mesh, batch.kind, { outline, castShadow: !proxied });
            // decor — растительность и камни природы (игра может снять с них тень и контур рёбер), batched — любая пачка
            mesh.metadata = Object.assign({}, mesh.metadata, { decor, batched: true });
            const part = { mesh, local, full: null, out: null, sh: null };
            if (proxied) {
                const proxy = new BABYLON.Mesh(mesh.name + '/sh', scene);
                // Свой Geometry у прокси: буфер матриц thin instances (вершинные буферы world0…3) лежит в Geometry меша, и общий Geometry
                // отдавал основному мешу буфер прокси — меш рисовал инстансы тени, а не свои (cull камеры и setInstanceHidden не действовали).
                mesh.geometry.copy(mesh.geometry.id + '/sh').applyToMesh(proxy);
                proxy.material = mesh.material;
                proxy.layerMask = Location3D.SHADOW_LAYER;   // камера мира его не видит, карта теней (явный список кастеров) — рисует
                proxy.isPickable = false;
                proxy.receiveShadows = false;
                proxy.metadata = { decor, batched: true, shadowProxy: true };
                proxy.setEnabled(false);
                this.view.addShadowCaster(proxy, false);
                part.sh = { mesh: proxy, out: null };
            }
            batch.parts.push(part);
        }
        root.dispose(true, false);
    }

    // Матрица экземпляра: масштаб × поворот × положение — та же, что placeObject даёт мешу
    // (rotation.y = −rot[1], Euler YXZ), высота — по земле.
    /** @param {LocationObject} rec */
    _instanceMatrix(rec) {
        const d = rec.def, D = Math.PI / 180;
        const x = Number(d.x) || 0, y = Number(d.y) || 0;
        const r = Array.isArray(d.rot) ? d.rot : [0, d.rot, 0];
        const s = Array.isArray(d.scale) ? d.scale : [d.scale, d.scale, d.scale];
        const k = (v) => (Number(v) > 0 ? Number(v) : 1);
        const q = BABYLON.Quaternion.RotationYawPitchRoll(-(Number(r[1]) || 0) * D, (Number(r[0]) || 0) * D, (Number(r[2]) || 0) * D);
        return BABYLON.Matrix.Compose(new BABYLON.Vector3(k(s[0]), k(s[1]), k(s[2])), q,
            new BABYLON.Vector3(x, (this.terrain ? this.terrain.heightAt(x, y) : 0) + (Number(d.h) || 0), y));
    }

    // Живые объекты пачки: не сняты, без ошибки загрузки, не прорежены.
    /** @param {any} batch @returns {LocationObject[]} */
    _liveRecs(batch) {
        return batch.recs.filter(/** @param {LocationObject} r */ r => !r.dead && !r.error && !r.hidden);
    }

    // Пересобрать пачку по её живым объектам: полные массивы матриц (по одному на часть модели —
    // part.full) и позиции для отсечения (batch.pos); в видеобуфер (part.out) попадает то, что
    // не дальше видимости от камеры (_cullBatch).
    _flushBatch(batch) {
        this._dirtyBatches.delete(batch);
        if (!batch.parts) return;
        const recs = this._liveRecs(batch), n = recs.length;
        batch.n = n;
        batch.live = recs;   // объект i буфера — recs[i]: _cullBatch пропускает спрятанные, CameraSight находит заслон по индексу
        batch.pos = new Float32Array(n * 2);
        batch.pos3 = new Float32Array(n * 3);   // x, высота, z центра инстанса — для отсечения теней
        batch.rad = new Float32Array(n);        // радиус инстанса (радиус модели × наибольший масштаб)
        const base = new Float32Array(n * 16);
        for (let i = 0; i < n; i++) {
            const d = recs[i].def, s = Array.isArray(d.scale) ? d.scale : [d.scale, d.scale, d.scale];
            this._instanceMatrix(recs[i]).copyToArray(base, i * 16);
            batch.pos[i * 2] = Number(d.x) || 0;
            batch.pos[i * 2 + 1] = Number(d.y) || 0;
            batch.pos3[i * 3] = base[i * 16 + 12];
            batch.pos3[i * 3 + 1] = base[i * 16 + 13];
            batch.pos3[i * 3 + 2] = base[i * 16 + 14];
            batch.rad[i] = (batch.radius || 200) * Math.max(Number(s[0]) || 1, Number(s[1]) || 1, Number(s[2]) || 1);
        }
        for (const part of batch.parts) {
            if (!n) { part.mesh.setEnabled(false); if (part.sh) part.sh.mesh.setEnabled(false); continue; }
            if (part.local.isIdentity()) part.full = base;
            else {
                part.full = new Float32Array(n * 16);
                for (let i = 0; i < n; i++) part.local.multiply(BABYLON.Matrix.FromArray(base, i * 16)).copyToArray(part.full, i * 16);
            }
            part.out = new Float32Array(n * 16);
            part.mesh.thinInstanceSetBuffer('matrix', part.out, 16, false);
            if (part.sh) {
                part.sh.out = new Float32Array(n * 16);
                part.sh.mesh.thinInstanceSetBuffer('matrix', part.sh.out, 16, false);
            }
        }
        batch.cull = null;
        batch.shCull = null;
        this._cullBatch(batch, ...this._cullCenter());
        this._cullShadow(batch);
    }

    _flushBatches() {
        for (const b of Array.from(this._dirtyBatches)) this._flushBatch(b);
    }

    // Дальность видимости декора (px): дальше туман сцены съедает ~93% цвета (линии контура рёбер в тумане не гаснут) — инстансы за ней
    // не рисуются (иначе контур рёбер далёких деревьев светился бы сквозь туман, а вершины
    // всей карты считались бы каждый кадр). Нет тумана — дальняя плоскость камеры.
    _visibleRadius() {
        const scene = this.view.scene, cam = this.view.camera;
        const far = cam && cam.maxZ > 0 ? cam.maxZ : 9000, rho = scene.fogDensity;
        let d = far;
        if (scene.fogEnabled) {
            if (scene.fogMode === BABYLON.Scene.FOGMODE_EXP2 && rho > 0) d = 1.7 / rho;
            else if (scene.fogMode === BABYLON.Scene.FOGMODE_EXP && rho > 0) d = 2.8 / rho;
            else if (scene.fogMode === BABYLON.Scene.FOGMODE_LINEAR) d = scene.fogEnd;
        }
        return Math.max(1500, Math.min(far, d)) + 300;   // + запас на размер дерева
    }

    // [x, y, r] отсечения: камера и дальность видимости; нет камеры — без отсечения.
    _cullCenter() {
        const cam = this.view && this.view.camera;
        if (!cam) return [0, 0, Infinity];
        return [cam.position.x, cam.position.z, this._visibleRadius()];
    }

    // Отсечение по расстоянию: в буфер инстансов — только объекты не дальше r от точки (x, y).
    _cullBatch(batch, x, y, r) {
        if (!batch.parts || !batch.n) return;
        const n = batch.n, pos = batch.pos, r2 = r * r, parts = batch.parts;
        const skip = batch.hidden && batch.hidden.size ? batch.hidden : null, live = batch.live;   // setInstanceHidden
        let k = 0;
        for (let i = 0; i < n; i++) {
            const dx = pos[i * 2] - x, dy = pos[i * 2 + 1] - y;
            if (dx * dx + dy * dy > r2) continue;
            if (skip && skip.has(live[i])) continue;
            for (const part of parts) Location3D.copy16(part.out, k * 16, part.full, i * 16);
            k++;
        }
        batch.visible = k;
        batch.cull = { x, y, r };
        for (const part of parts) {
            const mesh = part.mesh;
            mesh.thinInstanceCount = k;
            mesh.setEnabled(k > 0);
            if (k > 0) {
                mesh.thinInstanceBufferUpdated('matrix');
                mesh.thinInstanceRefreshBoundingInfo(true);
            }
        }
    }

    // Отсечение для карты теней: в буфер теневого прокси (part.sh) — только инстансы, чья сфера задевает ортокадр солнца и его
    // диапазон глубины (те же оси и запас, что у View3D.shadowCasters: lightBasis, WORLD3D_SHADOW_CULL_PAD). Нет инстансов у
    // игрока — прокси выключен и draw call в карте теней не тратится. Основной меш в тени не участвует. Тени выключены
    // (scene.shadowsEnabled) — прокси спят.
    _cullShadow(batch) {
        const view = this.view, at = view && view._lightAt, b = view && view._lightBasis;
        if (!batch.parts || !batch.n || !at || !b || !batch.parts.some(p => p.sh)) return;
        if (view.scene.shadowsEnabled === false) {
            if (batch.shVisible) {
                for (const part of batch.parts) if (part.sh) { part.sh.mesh.thinInstanceCount = 0; part.sh.mesh.setEnabled(false); }
            }
            batch.shVisible = 0;
            batch.shCull = null;
            return;
        }
        const pad = (view._shadowCullPad || 0) + Location3D.SHADOW_RECULL;   // + запас на кадр отставания: камера идёт после update
        const H = b.H + pad, D = b.D + pad;
        const n = batch.n, p3 = batch.pos3, rad = batch.rad, parts = batch.parts;
        const ax = at.x, ay = at.h, az = at.y;
        let k = 0;
        for (let i = 0; i < n; i++) {
            const r = rad[i];
            const vx = p3[i * 3] - ax, vy = p3[i * 3 + 1] - ay, vz = p3[i * 3 + 2] - az;
            if (Math.abs(vx * b.rx + vz * b.rz) > H + r) continue;
            if (Math.abs(vx * b.ux + vy * b.uy + vz * b.uz) > H + r) continue;
            if (Math.abs(vx * b.dx + vy * b.dy + vz * b.dz) > D + r) continue;
            for (const part of parts) if (part.sh) Location3D.copy16(part.sh.out, k * 16, part.full, i * 16);
            k++;
        }
        batch.shVisible = k;
        batch.shCull = { x: ax, z: az, h: ay, H: b.H };
        for (const part of parts) {
            const sh = part.sh;
            if (!sh) continue;
            sh.mesh.thinInstanceCount = k;
            sh.mesh.setEnabled(k > 0);
            if (k > 0) {
                sh.mesh.thinInstanceBufferUpdated('matrix');
                sh.mesh.thinInstanceRefreshBoundingInfo(true);
            }
        }
    }

    // Каждый кадр: камера сдвинулась больше 5% дальности (или дальность изменилась — туман) — пачки отсекаются заново;
    // кадр теней сдвинулся больше Location3D.SHADOW_RECULL (или сменился размер) — заново набираются инстансы теневых прокси.
    _cullBatches() {
        if (!this.view) return;
        const [x, y, r] = this._cullCenter();
        const at = this.view._lightAt, lb = this.view._lightBasis, shadows = this.view.scene.shadowsEnabled !== false;
        for (const b of this._batches.values()) {
            const c = b.cull;
            if (!c || Math.hypot(x - c.x, y - c.y) > 0.05 * r || Math.abs(r - c.r) > 0.05 * r) this._cullBatch(b, x, y, r);
            const s = b.shCull;
            if (shadows) {
                if (at && lb && (!s || Math.hypot(at.x - s.x, at.y - s.z) > Location3D.SHADOW_RECULL * 0.5 || Math.abs(at.h - s.h) > 120 || s.H !== lb.H)) this._cullShadow(b);
            } else if (b.shVisible) {
                this._cullShadow(b);   // тени выключили: прокси гаснут
            }
        }
    }

    // Инстанс пачки на время прячется из видеобуфера (камера рисует его полупрозрачным мешем-призраком — CameraSight.js);
    // в карте теней он остаётся. true — состояние применено, false — объект не в пачке.
    /** @param {LocationObject} rec @param {boolean} hidden */
    setInstanceHidden(rec, hidden) {
        const b = rec && rec.batch;
        if (!b || !b.parts) return false;
        const set = b.hidden || (b.hidden = new Set());
        if (set.has(rec) === !!hidden) return true;
        if (hidden) set.add(rec); else set.delete(rec);
        this._cullBatch(b, ...this._cullCenter());
        return true;
    }

    // Что собрано батчингом: пачек (моделей), мешей и инстансов — для замеров draw calls.
    // visible — инстансов в основном буфере (в дальности видимости), shadow — в буферах теней (у игрока).
    batchStats() {
        let instances = 0, meshes = 0, visible = 0, shadow = 0;
        for (const b of this._batches.values()) {
            instances += this._liveRecs(b).length;
            meshes += b.parts ? b.parts.length : 0;
            visible += b.visible || 0;
            shadow += b.shVisible || 0;
        }
        return { batches: this._batches.size, meshes, instances, visible, shadow };
    }

    // Снять пачку: меши и материалы прототипа (как Model3D.dispose у одиночного объекта).
    _disposeBatch(batch) {
        this._batches.delete(batch.key);
        this._dirtyBatches.delete(batch);
        if (!batch.parts || !this.view) return;
        for (const { mesh, sh } of batch.parts) {
            const mats = new Set();
            if (mesh.material) { mats.add(mesh.material); for (const sm of mesh.material.subMaterials || []) if (sm) mats.add(sm); }
            if (sh) { this.view.removeShadowCaster(sh.mesh); sh.mesh.dispose(false, false); }   // у прокси своя копия Geometry: уходит вместе с ним
            World3D.removeObject(this.view, mesh);
            for (const m of mats) m.dispose(false, false);
        }
        batch.parts = null;
    }

    // Маркеры карты для логики игры: записи с kind 'marker' и именем name или
    // name-2, name-3… (так их нумерует редактор). Без имени — все маркеры.
    // Запись: { name, x, y, h, rot: [x, курс, z], scale } — поля карты как есть.
    /** @param {string} [name] @returns {LocationObjectDef[]} */
    markers(name) {
        const all = this.map.objects.filter(d => d.kind === 'marker');
        if (!name) return all;
        return all.filter(d => d.name === name || String(d.name).startsWith(name + '-'));
    }

    /** @param {string} name @returns {LocationObjectDef | null} */
    marker(name) {
        return this.markers(name)[0] || null;
    }

    // Кадр анимации объектов — до World3D.renderFrame().
    update(dt) {
        dt = Math.min(0.1, Math.max(0, dt || 0));
        if (this.terrain) this.terrain.update(dt);   // время воды
        for (const rec of this.objects) this.spinPart(rec, dt);
        if (this._dirtyBatches.size) this._flushBatches();
        if (this._batches.size) this._cullBatches();
    }

    // def.anim = { part, axis, speed, dir }: часть модели (объект FBX) вращается вокруг
    // своего центра (origin из Blender) по своей оси axis — 'x' | 'y' | 'z', с минусом —
    // обратный конец; speed — об/мин; dir — 'cw' | 'ccw', по/против часовой, если
    // смотреть с конца оси. Сняли анимацию или сменили часть — прежняя встаёт на место.
    /** @param {LocationObject} rec @param {number} dt */
    spinPart(rec, dt) {
        const a = rec.def.anim;
        const name = a && rec.mesh ? String(a.part || '') : '';
        let s = rec.spin;
        if (s && (s.name !== name || s.root !== rec.mesh)) {
            if (s.mesh && !s.mesh.isDisposed()) {
                s.mesh.rotationQuaternion = null;
                s.mesh.setPivotPoint(BABYLON.Vector3.Zero());
            }
            s = rec.spin = null;
        }
        if (!name) return;
        if (!s) {
            const mesh = rec.mesh.getChildMeshes(true).find(m => m.metadata && m.metadata.part === name) || null;
            s = rec.spin = { name, root: rec.mesh, mesh, angle: 0, axis: new BABYLON.Vector3(), q: new BABYLON.Quaternion() };
            if (mesh) mesh.setPivotPoint(BABYLON.Vector3.FromArray(mesh.metadata.pivot));
        }
        if (!s.mesh) return;
        const axis = String(a.axis || 'y'), dirs = s.mesh.metadata.axes;
        const v = dirs[axis.slice(-1)] || dirs.y, sign = axis[0] === '-' ? -1 : 1;
        s.axis.set(v[0] * sign, v[1] * sign, v[2] * sign);
        // Сцена правосторонняя: положительный угол — против часовой с конца оси.
        const turn = Math.max(0, Number(a.speed) || 0) * Math.PI / 30 * (a.dir === 'ccw' ? 1 : -1);
        s.angle = (s.angle + turn * dt) % (2 * Math.PI);
        BABYLON.Quaternion.RotationAxisToRef(s.axis, s.angle, s.q);
        s.mesh.rotationQuaternion = s.q;
    }

    // Снять объект со сцены и из карты.
    /** @param {LocationObject} rec */
    removeObject(rec) {
        const i = this.map ? this.map.objects.indexOf(rec.def) : -1;
        if (i >= 0) this.map.objects.splice(i, 1);
        this._drop(rec);
    }

    /** @param {LocationObject} rec */
    _drop(rec) {
        const i = this.objects.indexOf(rec);
        if (i >= 0) this.objects.splice(i, 1);
        this._dropZoneLine(rec);
        if (rec.batch) {
            const batch = rec.batch;
            rec.dead = true;
            rec.batch = null;
            if (!batch.recs.some(/** @param {LocationObject} r */ r => !r.dead)) this._disposeBatch(batch);
            else this._dirtyBatches.add(batch);
            return;
        }
        if (rec.mesh && this.view) {
            if (rec.def.kind === 'marker') rec.mesh.dispose(false, true);
            else Model3D.dispose(this.view, rec.mesh);
        }
        rec.mesh = null;
        rec.dead = true;
        if (rec.def.kind === 'marker' && !this._placingAll) this.markerEdited(rec.def);
    }

    // Все земли игры по номеру map.ground: встроенные 0..2 (Location3D.GROUNDS / GROUND_TYPES / GROUND_NAMES), за
    // ними — GAME_GROUNDS из Constants.js (номер = число встроенных + индекс записи). Список собирается на каждом
    // вызове: в редакторе Constants.js приходит позже скриптов движка. Запись без url остаётся на своём месте
    // (номера соседей не едут): такая земля — ровного цвета. Редактор строит по списку выбор земли и проверку.
    /** @returns {Array<{ id: number, url: string, type: string, name: { ru: string, en: string } }>} */
    static groundList() {
        const out = [];
        const label = (id) => ({ ru: 'земля ' + id, en: 'ground ' + id });
        Location3D.GROUNDS.forEach((url, i) => out.push({
            id: i, url, type: Location3D.GROUND_TYPES[i] || 'grass', name: Location3D.GROUND_NAMES[i] || label(i)
        }));
        const custom = typeof GAME_GROUNDS !== 'undefined' && Array.isArray(GAME_GROUNDS) ? GAME_GROUNDS : [];
        for (const g of custom) {
            const id = out.length, e = g && typeof g === 'object' ? g : {};
            const name = label(id);
            out.push({
                id, url: typeof e.url === 'string' ? e.url : '', type: typeof e.type === 'string' && e.type ? e.type : 'grass',
                name: { ru: typeof e.ru === 'string' && e.ru ? e.ru : name.ru, en: typeof e.en === 'string' && e.en ? e.en : name.en }
            });
        }
        return out;
    }

    // Запись списка земель для карты (по map.ground; номер за пределами — ближайший край).
    groundEntry() {
        const list = Location3D.groundList();
        const n = Math.round(Number(this.map && this.map.ground) || 0);
        return list[Math.max(0, Math.min(list.length - 1, n))];
    }

    // Текстура земли по map.ground. Пути — ЛИТЕРАЛАМИ в GROUNDS и GAME_GROUNDS (Constants.js): сканер
    // сборщика (tools/asset-scan.mjs) находит ассеты только так. Нет файла — земля остаётся ровного
    // цвета, сцена не падает.
    loadGround() {
        const entry = this.groundEntry();
        const idx = entry.id;
        if (idx === this._groundIndex && this._groundImage) return Promise.resolve(this._groundImage);
        this._groundIndex = idx;
        if (!entry.url) return Promise.resolve(null);   // запись реестра без картинки
        const url = (this.opts.assetBase || '') + entry.url;
        return new Promise(resolve => {
            const img = new Image();
            img.onload = () => {
                if (this._groundIndex === idx) {
                    this._groundImage = img;
                    if (this.terrain) this.terrain.setGroundImage(img);
                }
                resolve(img);
            };
            img.onerror = () => {
                console.warn('Location3D: не загрузилась текстура земли ' + url);
                resolve(null);
            };
            img.src = url;
        });
    }

    applyRenderConstants() {
        World3D.applyRenderConstants(this.view);
    }

    dispose() {
        if (this._offQuality) this._offQuality();
        this._offQuality = null;
        this.objects = [];   // меши и материалы умирают со сценой
        if (this.terrain) this.terrain.dispose();
        this.terrain = null;
        if (this.view) this.view.dispose();
        this.view = null;
    }

    // Новая пустая карта (редактор — «Новая карта»; игра без Maps.js).
    /** @param {string} id @param {string} [name] @returns {GameMap} */
    static newMap(id, name) {
        return { id, name: name || id, width: 2048, height: 2048, ground: 0,
            terrain: { amp: 40, scale: 800, seed: 1, base: 0 }, objects: [] };
    }

    // Глубокая копия карты: игра правит её, GAME_MAPS остаётся как в файле.
    /** @param {GameMap} map @returns {GameMap} */
    static copyMap(map) {
        return JSON.parse(JSON.stringify(map));
    }

    // Булавка маркера (редактор): шест, шар и стрелка курса вдоль +X. Без света
    // и теней — toon не квантует, тень не падает; в карту теней не ставится.
    static markerMesh(scene, name) {
        const B = BABYLON.MeshBuilder;
        const pole = B.CreateCylinder('pole', { height: 70, diameter: 5, tessellation: 8 }, scene);
        pole.position.y = 35;
        const head = B.CreateSphere('head', { diameter: 22, segments: 8 }, scene);
        head.position.y = 76;
        const arrow = B.CreateCylinder('arrow', { height: 34, diameterTop: 0, diameterBottom: 14, tessellation: 3 }, scene);
        arrow.rotation.z = -Math.PI / 2;
        arrow.position.set(20, 3, 0);
        const ring = B.CreateTorus('ring', { diameter: 40, thickness: 3, tessellation: 24 }, scene);
        ring.position.y = 1;
        const mesh = BABYLON.Mesh.MergeMeshes([pole, head, arrow, ring], true, true);
        mesh.name = 'marker:' + name;
        const mat = new BABYLON.StandardMaterial('marker-mat:' + name, scene);
        mat.disableLighting = true;
        mat.emissiveColor = World3D.hexColor3(Location3D.markerColor(name));
        mat.diffuseColor = BABYLON.Color3.Black();
        mat.specularColor = BABYLON.Color3.Black();
        mat.metadata = { toon: false };
        mesh.material = mat;
        mesh.renderingGroupId = World3D.LAYER.ACTOR;
        return mesh;
    }

    // Копия матрицы 4×4 (16 чисел) между буферами инстансов — без временных subarray: отсечение идёт почти каждый кадр.
    /** @param {Float32Array} dst @param {number} di @param {Float32Array} src @param {number} si */
    static copy16(dst, di, src, si) {
        for (let j = 0; j < 16; j++) dst[di + j] = src[si + j];
    }

    // Часть модели с несколькими простыми цветными материалами -> один submesh с вершинными цветами: один draw call на
    // деталь вместо draw call на материал, и в основном проходе, и в карте теней. Картинка та же: цвет материала уходит в
    // вершины, у нового материала diffuseColor белый (свет × цвет вершины × цвет материала). Условия: все материалы —
    // StandardMaterial без текстур, прозрачности и собственного свечения, с одинаковыми backFaceCulling и бликом, а вершина
    // не делится материалами разного цвета (иначе меш остаётся как был). Цвета запекаются насовсем, прежние материалы
    // удаляются. true — склеено.
    /** @param {any} mesh @returns {boolean} */
    static mergeColors(mesh) {
        const mm = mesh && mesh.material, subs = mm && mm.subMaterials;
        if (!subs || subs.length < 2 || !mesh.subMeshes || mesh.subMeshes.length < 2) return false;
        const first = subs[0];
        for (const m of subs) {
            if (!m || !(m instanceof BABYLON.StandardMaterial) || m.diffuseTexture || m.emissiveTexture || m.opacityTexture || m.bumpTexture ||
                m.reflectionTexture || m.alpha < 1 || m.disableLighting || m.backFaceCulling !== first.backFaceCulling ||
                !m.emissiveColor.equals(first.emissiveColor) || !m.specularColor.equals(first.specularColor) || m.specularPower !== first.specularPower) return false;
        }
        const idx = mesh.getIndices(), nv = mesh.getTotalVertices();
        if (!idx || !nv) return false;
        const old = mesh.getVerticesData(BABYLON.VertexBuffer.ColorKind);
        const stride = old ? Math.round(old.length / nv) : 0;
        const col = new Float32Array(nv * 4).fill(1), owner = new Int16Array(nv).fill(-1);
        if (old) for (let v = 0; v < nv; v++) for (let k = 0; k < 4; k++) col[v * 4 + k] = k < stride ? old[v * stride + k] : 1;
        const base = old ? col.slice() : null;
        for (const sm of mesh.subMeshes) {
            const c = subs[sm.materialIndex].diffuseColor;
            for (let k = sm.indexStart, e = sm.indexStart + sm.indexCount; k < e; k++) {
                const v = idx[k], o = owner[v];
                if (o === sm.materialIndex) continue;
                if (o >= 0 && !subs[o].diffuseColor.equals(c)) return false;   // вершину делят материалы разного цвета
                owner[v] = sm.materialIndex;
                col[v * 4] = c.r * (base ? base[v * 4] : 1);
                col[v * 4 + 1] = c.g * (base ? base[v * 4 + 1] : 1);
                col[v * 4 + 2] = c.b * (base ? base[v * 4 + 2] : 1);
            }
        }
        const scene = mesh.getScene();
        const mat = new BABYLON.StandardMaterial(mesh.name + '/merged', scene);
        mat.diffuseColor = new BABYLON.Color3(1, 1, 1);
        mat.specularColor = first.specularColor.clone();
        mat.specularPower = first.specularPower;
        mat.emissiveColor = first.emissiveColor.clone();
        mat.backFaceCulling = first.backFaceCulling;
        if (first.metadata) mat.metadata = Object.assign({}, first.metadata);
        mesh.setVerticesData(BABYLON.VertexBuffer.ColorKind, col, false, 4);
        mesh.releaseSubMeshes();
        mesh.material = mat;
        new BABYLON.SubMesh(0, 0, nv, 0, idx.length, mesh);
        for (const m of subs) m.dispose(false, false);
        mm.dispose(false, false);
        return true;
    }

    // Цвет булавки — по имени без номера: у всех spawn-N один цвет.
    static markerColor(name) {
        const stem = String(name || '').replace(/-\d+$/, '');
        let h = 0;
        for (let i = 0; i < stem.length; i++) h = (h * 31 + stem.charCodeAt(i)) >>> 0;
        return Location3D.MARKER_COLORS[h % Location3D.MARKER_COLORS.length];
    }
}

// Встроенные текстуры земли по map.ground: 0 — трава, 1 — песок, 2 — снег. Движок этот список не правит:
// свои земли игра дописывает в GAME_GROUNDS (Constants.js), общий список — Location3D.groundList().
Location3D.GROUNDS = [
    'assets/ground_texture_g.jpg',
    'assets/ground_texture_d.jpg',
    'assets/ground_texture_s.jpg'
];

// Основа карты (тип земли для groundTypeAt) и названия в редакторе — в том же порядке, что GROUNDS.
Location3D.GROUND_TYPES = ['grass', 'sand', 'snow'];
/** @type {Array<{ ru: string, en: string }>} */
Location3D.GROUND_NAMES = [{ ru: 'трава', en: 'grass' }, { ru: 'песок', en: 'sand' }, { ru: 'снег', en: 'snow' }];

// Папка декора: префикс пути модели (opts.batchDecor — инстансы, opts.quality — прореживание). Собран
// из кусков — сканер сборщика видит ссылкой любой литерал пути ассета, а папка может ещё не существовать.
Location3D.DECOR_PREFIX = 'assets/' + 'models/nature/';

// Модели из папок opts.batchRepeated идут в пачку, если стоят на карте не меньше BATCH_MIN раз.
Location3D.BATCH_MIN = 2;

// Теневой прокси пачки (см. _buildBatch): маска слоя, которой нет у камеры мира, и сдвиг кадра теней (px), после которого
// прокси набирает инстансы заново (запас в отсечении — вдвое больше сдвига).
Location3D.SHADOW_LAYER = 0x10000000;
Location3D.SHADOW_RECULL = 64;

// ms: дольше карта «готовой» не ждёт (шейдеры, текстуры) — игра стартует и так.
Location3D.READY_TIMEOUT = 15000;

// Цвета булавок маркеров в редакторе.
Location3D.MARKER_COLORS = [0xffb020, 0x35d0ff, 0xff5a8a, 0x7cff6b, 0xb58cff, 0xffef5a];

// Цвет контура зоны в редакторе по виду зоны (покраска — цвет краски).
/** @type {Record<string, number>} */
Location3D.ZONE_COLORS = { flat: 0x35d0ff, raise: 0xffb020, water: 0x4a90f0 };
