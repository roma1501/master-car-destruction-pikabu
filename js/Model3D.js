// Model3D.js — модели: файл -> разбор (формат по расширению) -> меши Babylon.
// Объекты карт (Maps.js) ставит Location3D: load(url) -> build() ->
// World3D.addObject. Модели лежат в assets/models/.
//
// ФОРМАТЫ — свои разборщики, без лоадеров Babylon (тот же toon-материал у всех):
//   .fbx         — ModelFBX.js (бинарный FBX 7.x: Blender, Maya, Unity, Meshy);
//   .obj (+.mtl) — ModelOBJ.js (текст, материалы из mtllib, текстуры map_Kd);
//   .glb, .gltf  — ModelGLTF.js (glTF 2.0: встроенные и внешние буферы и картинки).
// Берётся: геометрия, нормали, UV, цвета вершин, цвет и текстура материала
// (прозрачность, двусторонность), части с центром и осями (по ним Location3D
// вращает часть — def.anim). Не берётся: кости и анимация, морфы, PBR-карты
// (металл, шероховатость, нормали), сжатие Draco/meshopt. Узлы и анимации glTF (model.nodes,
// model.animations, part.node) разбирает ModelGLTF.js для Rig.js; Model3D.build их не использует.
//
// ЕДИНИЦЫ: 1 см = 1 px мира. FBX — сантиметры (UnitScaleFactor учтён), glTF и
// OBJ — метры (× 100): модель ростом 2 м — 200 px при scale 1.
// ОСИ: сцена правосторонняя, Y вверх — как FBX и glTF; оси FBX из GlobalSettings
// приводятся к ним. Начало координат модели — начало файла.
// ОБХОД: лицевая грань во всех трёх форматах — против часовой, а у мешей Babylon
// (MeshBuilder, Terrain3D) нормаль по обходу смотрит в обратную сторону —
// разборщики пишут треугольники задом наперёд, иначе backFaceCulling срежет лицо.
// ЦВЕТ: у FBX и glTF цвет материала линейный (linear: true) — build переводит в
// гамму, иначе краски темнее. У OBJ Kd уже экранный.
// UV: у всех разборщиков начало — левый НИЖНИЙ угол картинки (OpenGL); текстуры
// грузятся с invertY по умолчанию. glTF (начало вверху) переворачивает v сам.
//
// Модель (результат parse любого формата):
//   { materials: [{ name, color: [r, g, b], linear, tint (цвет умножает текстуру), alpha,
//                   texture: { url, mimeType } | null, alphaMode: 'opaque' | 'mask' | 'blend', doubleSided }],
//     parts: [{ name, positions, normals | null, uvs | null, colors | null (RGBA),
//               indices | null, groups: [{ material, start, count }], pivot: [x, y, z],
//               axes: { x, y, z } }],
//     min, max }
// Без indices вершины идут тройками (группа — диапазон вершин), с indices группа —
// диапазон индексов. pivot и axes — начало и единичные оси части (origin объекта в
// Blender) в координатах модели.

/** @satisfies {Record<string, any>} */
const Model3D = {
    _cache: new Map(),   // url -> Promise разбора: файл качается и разбирается раз на страницу
    FORMATS: ['fbx', 'obj', 'glb', 'gltf'],

    // Расширение модели ('fbx' | 'obj' | 'glb' | 'gltf' | '').
    formatOf(url) {
        const m = /\.([a-z0-9]+)$/i.exec(String(url || '').split(/[?#]/)[0]);
        const ext = m ? m[1].toLowerCase() : '';
        return this.FORMATS.includes(ext) ? ext : '';
    },

    // url -> Promise<модель> (см. шапку).
    load(url) {
        let p = this._cache.get(url);
        if (!p) {
            p = this._parseUrl(url);
            this._cache.set(url, p);
            p.catch(() => this._cache.delete(url));   // ошибку не кэшируем: файл могут положить позже
        }
        return p;
    },

    async _parseUrl(url) {
        const fmt = this.formatOf(url);
        if (!fmt) throw new Error('unsupported model format (need .fbx, .obj, .glb or .gltf)');
        const ctx = { url, base: this.baseOf(url) };
        let model;
        if (fmt === 'obj') model = await ModelOBJ.parse(await this.fetchText(url), ctx);
        else {
            const buf = await this.fetchBuffer(url);
            model = await (fmt === 'fbx' ? ModelFBX.parse(buf, ctx) : ModelGLTF.parse(buf, ctx));
        }
        await this._fetchTextures(model);
        return model;
    },

    // Внешние текстуры — заранее, в blob: URL. Нет файла — материал без текстуры
    // (цвет) и предупреждение: текстура, которая не загрузилась, держала бы материал
    // «не готовым», и экран загрузки ждал бы вечно.
    // Общий атлас: внешняя картинка качается и становится blob: URL ОДИН раз на страницу (this._blobs, ключ —
    // адрес файла), даже если на неё ссылаются десятки разных моделей (блоки с одним атласом). Ключ текстуры сцены
    // (_texture) — этот blob: URL, поэтому в видеопамять атлас уходит один раз. Неудача в кэше не остаётся.
    /** @type {Map<string, Promise<string | null>>} */
    _blobs: new Map(),

    async _fetchTextures(model) {
        const byUrl = this._blobs;
        await Promise.all(model.materials.map(async (m) => {
            const url = m.texture && m.texture.url;
            if (!url || /^(blob:|data:)/.test(url)) return;
            if (!byUrl.has(url)) {
                byUrl.set(url, fetch(url).then(async (r) => {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return this.blobUrl(await r.arrayBuffer(), m.texture.mimeType || this.mimeOf(url));
                }).catch((e) => {
                    console.warn('Model3D: нет текстуры ' + decodeURIComponent(url) + ' — ' + ((e && e.message) || e));
                    byUrl.delete(url);   // файл могут положить позже: следующая модель попробует снова
                    return null;
                }));
            }
            const blob = await byUrl.get(url);
            m.texture = blob ? { url: blob, mimeType: m.texture.mimeType || this.mimeOf(url) } : null;
        }));
    },

    async fetchBuffer(url) {
        const r = await fetch(url);
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
        return r.arrayBuffer();
    },

    async fetchText(url) {
        const r = await fetch(url);
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
        return r.text();
    },

    // Папка файла: assets/models/a.obj -> assets/models/ (путь в комментарии — без
    // кавычек: сканер сборщика принял бы его за ссылку на ассет).
    baseOf(url) {
        const clean = String(url).split(/[?#]/)[0];
        return clean.slice(0, clean.lastIndexOf('/') + 1);
    },

    // Путь из файла модели (текстура, .mtl, .bin) -> URL рядом с моделью. Папки
    // Windows и абсолютные пути отбрасываются: файл ищется рядом с моделью. Имя —
    // безопасное (safeName): так файлы кладёт импорт редактора, так их ищет сканер
    // сборщика («My Tex.png» из файла модели -> My_Tex.png на диске).
    resolve(base, file) {
        const s = String(file || '').trim().replace(/\\/g, '/');
        if (/^(data:|blob:)/i.test(s)) return s;
        let name = /^([a-z]:)?\//i.test(s) || s.startsWith('../') ? s.split('/').pop() : s.replace(/^\.\//, '');
        try { name = decodeURIComponent(name); } catch (e) { /* % без кода — как есть */ }
        return base + name.split('/').map((seg) => this.safeName(seg)).join('/');
    },

    // Имя файла латиницей без пробелов: всё, кроме A-Z a-z 0-9 . _ -, — в «_».
    // То же правило — у импорта моделей (_utils/editor/server.mjs) и сканера (tools/asset-scan.mjs).
    safeName(name) {
        return String(name).normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^A-Za-z0-9._-]+/g, '_');
    },

    // Встроенная картинка -> blob: URL (живёт, пока открыта страница).
    blobUrl(bytes, mimeType) {
        return URL.createObjectURL(new Blob([bytes], { type: mimeType || 'image/png' }));
    },

    mimeOf(name) {
        const ext = String(name || '').split(/[?#]/)[0].split('.').pop().toLowerCase();
        return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext] || '';
    },

    // Новый пустой материал модели.
    material(name) {
        return { name: name || 'default', color: [0.8, 0.8, 0.8], linear: false, tint: false, alpha: 1, texture: null, alphaMode: 'opaque', doubleSided: false };
    },

    // Габарит модели по вершинам части (в координатах модели).
    grow(model, positions) {
        const lo = model.min, hi = model.max;
        for (let i = 0; i < positions.length; i += 3) {
            const x = positions[i], y = positions[i + 1], z = positions[i + 2];
            if (x < lo[0]) lo[0] = x; if (x > hi[0]) hi[0] = x;
            if (y < lo[1]) lo[1] = y; if (y > hi[1]) hi[1] = y;
            if (z < lo[2]) lo[2] = z; if (z > hi[2]) hi[2] = z;
        }
    },

    emptyModel() {
        return { materials: [], parts: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    },

    // Модель -> меш-корень без геометрии, части — его дети; у каждого вызова свои
    // меши и материалы (текстуры общие на сцену). opts: { name }.
    build(model, scene, opts) {
        const o = opts || {};
        const root = new BABYLON.Mesh(o.name || 'model', scene);
        const mats = [];
        const material = (i) => {
            if (!mats[i]) mats[i] = this._material(model, model.materials[i] || this.material(), root.name, scene);
            return mats[i];
        };
        for (const part of model.parts) {
            const mesh = new BABYLON.Mesh(root.name + '/' + part.name, scene);
            mesh.metadata = { part: part.name, pivot: part.pivot, axes: part.axes };
            const pos = part.positions.slice(), count = pos.length / 3;
            const vd = new BABYLON.VertexData();
            vd.positions = pos;
            vd.indices = part.indices ? part.indices.slice() : new Uint32Array(count).map((_, i) => i);
            vd.normals = part.normals ? part.normals.slice() : new Float32Array(pos.length);
            if (!part.normals) BABYLON.VertexData.ComputeNormals(pos, vd.indices, vd.normals);
            if (part.uvs) vd.uvs = part.uvs.slice();
            if (part.colors) vd.colors = part.colors.slice();
            vd.applyToMesh(mesh);
            if (part.groups.length > 1) {
                const multi = new BABYLON.MultiMaterial(mesh.name, scene);
                multi.subMaterials = part.groups.map((g) => material(g.material));
                mesh.material = multi;
                mesh.subMeshes = [];
                part.groups.forEach((g, i) => (part.indices
                    ? new BABYLON.SubMesh(i, 0, count, g.start, g.count, mesh)
                    : new BABYLON.SubMesh(i, g.start, g.count, g.start, g.count, mesh)));
            } else {
                mesh.material = material(part.groups[0].material);
            }
            mesh.parent = root;
        }
        return root;
    },

    // Материал модели -> StandardMaterial (toon-плагин вешается сам). Текстура —
    // множитель цвета; у FBX и OBJ с текстурой цвет белый (экспорт пишет туда
    // серый 0.8 по умолчанию и затемнил бы картинку), у glTF — по спецификации.
    _material(model, m, prefix, scene) {
        const mat = new BABYLON.StandardMaterial(prefix + '/' + m.name, scene);
        let c = new BABYLON.Color3(m.color[0], m.color[1], m.color[2]);
        if (m.linear) c = c.toGammaSpace();
        if (m.texture) {
            const alpha = m.alphaMode === 'mask' || m.alphaMode === 'blend';
            mat.diffuseTexture = this._texture(model, m.texture, scene, alpha);
            if (!m.tint) c = new BABYLON.Color3(1, 1, 1);
            if (m.alphaMode === 'blend') mat.useAlphaFromDiffuseTexture = true;
        }
        mat.diffuseColor = c;
        if (m.alpha < 1) mat.alpha = Math.max(0, m.alpha);
        if (m.doubleSided) mat.backFaceCulling = false;
        return mat;
    },

    // Текстура на сцену: одна на сцену, адрес картинки и «есть альфа» — общая для всех копий модели И для РАЗНЫХ
    // моделей с той же картинкой (внешний файл -> общий blob: URL, см. _fetchTextures): атлас блоков не плодит
    // текстуры по числу моделей. Альфа в ключе: hasAlpha превращает материал в альфа-тест, и модель без прозрачности
    // не должна его получить от соседа с маской. Освобождённую текстуру (сцену или её саму сняли — Babylon обнуляет
    // getScene()) берём заново; запись уходит из кэша и по onDisposeObservable, чтобы он не копил мёртвые.
    /** @type {Map<string, any>} */
    _sceneTextures: new Map(),

    _texture(model, tex, scene, alpha) {
        const byScene = this._sceneTextures;
        const key = scene.uid + '|' + tex.url + (alpha ? '|a' : '');
        let t = byScene.get(key);
        if (t && !t.getScene()) t = null;
        if (!t) {
            // Картинка не декодировалась — снять её с материалов: иначе материал «не готов» навсегда.
            const onError = () => {
                if (byScene.get(key) === t) byScene.delete(key);
                for (const m of scene.materials) {
                    if (/** @type {any} */ (m).diffuseTexture === t) /** @type {any} */ (m).diffuseTexture = null;
                }
                console.warn('Model3D: текстура не читается — ' + (tex.mimeType || tex.url));
            };
            t = new BABYLON.Texture(tex.url, scene, { invertY: true, mimeType: tex.mimeType || undefined,
                samplingMode: BABYLON.Texture.TRILINEAR_SAMPLINGMODE, onError });
            t.anisotropicFilteringLevel = IS_MOBILE ? 2 : 4;
            if (alpha) t.hasAlpha = true;
            byScene.set(key, t);
            const made = t;
            if (made.onDisposeObservable) made.onDisposeObservable.add(() => { if (byScene.get(key) === made) byScene.delete(key); });
        }
        return t;
    },

    // Снять построенную модель со сцены вместе с её материалами
    // (World3D.removeObject материалы оставляет владельцу; текстуры общие — остаются).
    dispose(view, root) {
        const mats = new Set();
        for (const m of [root].concat(root.getChildMeshes(false))) {
            if (!m.material) continue;
            mats.add(m.material);
            for (const sm of m.material.subMaterials || []) if (sm) mats.add(sm);
        }
        World3D.removeObject(view, root);
        for (const mat of mats) mat.dispose(false, false);
    },
};
