// ModelGLTF.js — разбор glTF 2.0 (.glb — бинарный, .gltf — JSON с буферами
// data: или файлами рядом) в модель Model3D (формат — шапка Model3D.js). Зовёт
// Model3D.load по расширению .glb / .gltf. Так приходят модели генераторов
// (generate_3d) и экспорт Blender «glTF Binary».
//
// Берётся: сцена по умолчанию, узлы с мешами (matrix или TRS, родители),
// примитивы-треугольники (TRIANGLES, STRIP, FAN) с индексами или без, POSITION,
// NORMAL, TEXCOORD_0, COLOR_0, sparse-аксессоры, материал: baseColorFactor,
// baseColorTexture (картинка в буфере или файл), alphaMode, doubleSided. Узел с
// мешем — часть модели (его начало и оси — pivot и axes для вращения части).
// Для ригов (Rig.js) — ещё узлы и анимации, статичной модели они не нужны:
//   model.nodes      — ВСЕ узлы файла, индекс = индекс узла glTF (на него ссылаются
//                      каналы): { name, parent (индекс | −1), t, r, s (локальные TRS в
//                      МЕТРАХ: смещение, кватернион xyzw, масштаб), part (индекс в
//                      model.parts | −1), joint (кость скина) };
//   model.animations — [{ name, start, duration, channels: [{ node, path: 'translation' |
//                      'rotation' | 'scale', times, values, interp: 'LINEAR' | 'STEP' |
//                      'CUBICSPLINE' }] }]: start — время первого ключа (Blender пишет клип
//                      с кадра 1), duration — время последнего; значения как в файле
//                      (смещения в метрах; у CUBICSPLINE на ключ три значения — входная
//                      касательная, значение, выходная);
//   part.node        — индекс узла glTF, из которого сделана часть.
// Части всё равно запечены в координаты модели (px, поза покоя): так их рисуют статичные
// объекты; Rig «распекает» их обратно в пространство узла. Модель без мешей, но с
// анимациями (библиотека клипов из Blender) разбирается — меши ей не нужны.
// Не берётся: скиннинг (меш в позе привязки; part.skinned = true), морфы, остальные
// PBR-карты, KHR_draco_mesh_compression и EXT_meshopt_compression (ошибка с подсказкой).
//
// ЕДИНИЦЫ: метры × 100 = px мира. ОСИ: glTF правосторонний, Y вверх — как сцена.
// ОБХОД: треугольники задом наперёд (шапка Model3D.js). UV: v переворачивается —
// у glTF начало картинки вверху, у набора — внизу.
// Матрица glTF (по столбцам, вектор-столбец) в памяти совпадает с матрицей
// Babylon (по строкам, вектор-строка): Matrix.FromArray берёт её как есть.

/** @satisfies {Record<string, any>} */
const ModelGLTF = {
    UNIT: 100,   // px мира на метр

    // ArrayBuffer (.glb или текст .gltf) -> модель; ctx: { url, base }.
    async parse(buffer, ctx) {
        const base = (ctx && ctx.base) || '';
        const bytes = new Uint8Array(buffer);
        let json, bin = null;
        if (bytes.length >= 12 && new DataView(buffer).getUint32(0, true) === 0x46546C67) {
            ({ json, bin } = this._readGlb(buffer));
        } else {
            json = JSON.parse(new TextDecoder().decode(bytes));
        }
        const used = (json.extensionsRequired || []).concat(json.extensionsUsed || []);
        if (used.includes('KHR_draco_mesh_compression')) throw new Error('Draco-compressed glTF is not supported — export without compression');
        if (used.includes('EXT_meshopt_compression')) throw new Error('meshopt-compressed glTF is not supported — export without compression');
        const buffers = await Promise.all((json.buffers || []).map((b, i) => this._buffer(b, i, bin, base)));
        const gltf = { json, buffers };

        const model = Model3D.emptyModel();
        const matIndex = new Map();
        const materialIndex = (i) => {
            const key = i == null ? -1 : i;
            if (!matIndex.has(key)) {
                matIndex.set(key, model.materials.length);
                model.materials.push(this._material(gltf, key, base));
            }
            return matIndex.get(key);
        };

        const S = BABYLON.Matrix.Scaling(this.UNIT, this.UNIT, this.UNIT);
        const nodes = json.nodes || [];
        model.nodes = this._nodes(nodes);
        for (const sk of json.skins || []) for (const j of sk.joints || []) if (model.nodes[j]) model.nodes[j].joint = true;
        const visit = (index, parent, depth) => {
            const node = nodes[index];
            if (!node || depth > 64) return;
            const world = this._localMatrix(node).multiply(parent);
            if (node.mesh != null && json.meshes && json.meshes[node.mesh]) {
                const part = this._part(gltf, json.meshes[node.mesh], world.multiply(S), materialIndex);
                if (part) {
                    part.name = node.name || json.meshes[node.mesh].name || 'node' + index;
                    const frame = world.multiply(S), V = BABYLON.Vector3;
                    part.pivot = V.TransformCoordinates(V.Zero(), frame).asArray();
                    part.axes = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
                    for (const k in part.axes) part.axes[k] = V.TransformNormal(V.FromArray(part.axes[k]), frame).normalize().asArray();
                    part.node = index;
                    if (node.skin != null) part.skinned = true;
                    if (model.nodes[index] && model.nodes[index].part < 0) model.nodes[index].part = model.parts.length;
                    Model3D.grow(model, part.positions);
                    model.parts.push(part);
                }
            }
            for (const c of node.children || []) visit(c, world, depth + 1);
        };
        const scene = json.scenes && json.scenes[json.scene || 0];
        let roots = scene && scene.nodes;
        if (!roots) {
            const child = new Set();
            for (const n of nodes) for (const c of n.children || []) child.add(c);
            roots = nodes.map((_, i) => i).filter((i) => !child.has(i));
        }
        for (const r of roots) visit(r, BABYLON.Matrix.Identity(), 0);
        model.animations = this._animations(gltf);
        // Без мешей годится только библиотека клипов (арматура + анимации): статичной модели нечего рисовать.
        if (!model.parts.length && !model.animations.length) throw new Error('no meshes in glTF');
        return model;
    },

    // Узлы glTF -> [{ name, parent (индекс | −1), t, r, s (локальные TRS, метры), part (−1),
    // joint (кость скина) }] в порядке файла (индекс = индекс узла glTF). matrix
    // раскладывается на TRS; part проставляет обход сцены. В файле Blender меш части
    // назван как его кость (узел «Leg_L» с мешем — ребёнок кости «Leg_L»): Rig ищет
    // узел по имени с учётом joint и part.
    _nodes(nodes) {
        const parent = new Int32Array(nodes.length).fill(-1);
        nodes.forEach((n, i) => { for (const c of n.children || []) if (c >= 0 && c < nodes.length) parent[c] = i; });
        return nodes.map((n, i) => {
            let t = n.translation || [0, 0, 0], r = n.rotation || [0, 0, 0, 1], s = n.scale || [1, 1, 1];
            if (n.matrix) {
                const sc = new BABYLON.Vector3(), q = new BABYLON.Quaternion(), tr = new BABYLON.Vector3();
                BABYLON.Matrix.FromArray(n.matrix).decompose(sc, q, tr);
                t = tr.asArray(); r = [q.x, q.y, q.z, q.w]; s = sc.asArray();
            }
            return { name: n.name || 'node' + i, parent: parent[i], t: t.slice(), r: r.slice(), s: s.slice(), part: -1, joint: false };
        });
    },

    // Анимации -> [{ name, start, duration, channels: [{ node, path, times, values, interp }] }].
    // start — время первого ключа, duration — последнего (Blender пишет клип с кадра 1,
    // `export_anim_slide_to_zero` сдвигает к нулю). Значения — как в файле: смещения в
    // метрах, вращение — кватернион xyzw; у CUBICSPLINE на ключ три значения (входная
    // касательная, значение, выходная). Каналы weights (морфы) и чужие пути пропускаются.
    _animations(gltf) {
        const out = [];
        (gltf.json.animations || []).forEach((a, ai) => {
            const channels = [];
            let start = Infinity, end = 0;
            for (const ch of a.channels || []) {
                const tgt = ch.target || {};
                if (tgt.node == null || !(tgt.path === 'translation' || tgt.path === 'rotation' || tgt.path === 'scale')) continue;
                const smp = (a.samplers || [])[ch.sampler];
                if (!smp || smp.input == null || smp.output == null) continue;
                const times = /** @type {Float32Array} */ (this._read(gltf, smp.input));
                const values = /** @type {Float32Array} */ (this._read(gltf, smp.output));
                if (!times.length) continue;
                const interp = smp.interpolation === 'STEP' ? 'STEP' : smp.interpolation === 'CUBICSPLINE' ? 'CUBICSPLINE' : 'LINEAR';
                start = Math.min(start, times[0]);
                end = Math.max(end, times[times.length - 1]);
                channels.push({ node: tgt.node, path: tgt.path, times, values, interp });
            }
            out.push({ name: a.name || 'anim' + ai, start: Number.isFinite(start) ? start : 0, duration: end, channels });
        });
        return out;
    },

    // .glb: заголовок 12 байт, затем куски JSON и BIN.
    _readGlb(buffer) {
        const dv = new DataView(buffer);
        if (dv.getUint32(4, true) !== 2) throw new Error('glTF: only version 2 is supported');
        let json = null, bin = null;
        for (let at = 12; at + 8 <= buffer.byteLength;) {
            const len = dv.getUint32(at, true), type = dv.getUint32(at + 4, true);
            const data = new Uint8Array(buffer, at + 8, len);
            if (type === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(data));
            else if (type === 0x004E4942) bin = data;
            at += 8 + len;
        }
        if (!json) throw new Error('glTF: no JSON chunk');
        return { json, bin };
    },

    // Буфер: BIN .glb, data: URI или файл рядом с моделью.
    async _buffer(b, i, bin, base) {
        if (!b.uri) {
            if (!bin) throw new Error('glTF: buffer ' + i + ' has no data');
            return bin;
        }
        const url = Model3D.resolve(base, b.uri);
        const r = await fetch(url);
        if (!r.ok) throw new Error('glTF: buffer not found ' + b.uri);
        return new Uint8Array(await r.arrayBuffer());
    },

    _localMatrix(node) {
        if (node.matrix) return BABYLON.Matrix.FromArray(node.matrix);
        const s = node.scale || [1, 1, 1], r = node.rotation || [0, 0, 0, 1], t = node.translation || [0, 0, 0];
        return BABYLON.Matrix.Compose(new BABYLON.Vector3(s[0], s[1], s[2]),
            new BABYLON.Quaternion(r[0], r[1], r[2], r[3]), new BABYLON.Vector3(t[0], t[1], t[2]));
    },

    // Меш узла -> часть: вершины в координатах модели (world с метрами × 100),
    // примитивы — группы индексов по материалу.
    _part(gltf, mesh, world, materialIndex) {
        const normalMatrix = world.clone().invert().transpose();
        const mirror = world.determinant() < 0;
        const prims = [];
        let nv = 0, ni = 0, hasNrm = true, hasUv = false, hasCol = false;
        for (const p of mesh.primitives || []) {
            const mode = p.mode == null ? 4 : p.mode;
            if (mode !== 4 && mode !== 5 && mode !== 6) continue;   // точки и линии не рисуются
            const at = p.attributes || {};
            if (at.POSITION == null) continue;
            const pos = this._read(gltf, at.POSITION);
            const count = pos.length / 3;
            let idx = p.indices != null ? this._read(gltf, p.indices, true) : null;
            if (!idx) { idx = new Uint32Array(count); for (let i = 0; i < count; i++) idx[i] = i; }
            idx = this._triangles(idx, mode);
            const rec = {
                pos, idx, material: materialIndex(p.material),
                nrm: at.NORMAL != null ? this._read(gltf, at.NORMAL) : null,
                uv: at.TEXCOORD_0 != null ? this._read(gltf, at.TEXCOORD_0) : null,
                col: at.COLOR_0 != null ? this._read(gltf, at.COLOR_0) : null,
                colSize: at.COLOR_0 != null && gltf.json.accessors[at.COLOR_0].type === 'VEC3' ? 3 : 4,
            };
            hasNrm = hasNrm && !!rec.nrm;
            hasUv = hasUv || !!rec.uv;
            hasCol = hasCol || !!rec.col;
            nv += count;
            ni += rec.idx.length;
            prims.push(rec);
        }
        if (!prims.length) return null;
        prims.sort((a, b) => a.material - b.material);

        const positions = new Float32Array(nv * 3), normals = hasNrm ? new Float32Array(nv * 3) : null;
        const uvs = hasUv ? new Float32Array(nv * 2) : null, colors = hasCol ? new Float32Array(nv * 4) : null;
        const indices = new Uint32Array(ni), groups = [];
        const v = new BABYLON.Vector3();
        let vo = 0, io = 0;
        for (const p of prims) {
            const count = p.pos.length / 3;
            for (let i = 0; i < count; i++) {
                BABYLON.Vector3.TransformCoordinatesFromFloatsToRef(p.pos[3 * i], p.pos[3 * i + 1], p.pos[3 * i + 2], world, v);
                positions[3 * (vo + i)] = v.x; positions[3 * (vo + i) + 1] = v.y; positions[3 * (vo + i) + 2] = v.z;
                if (normals) {
                    BABYLON.Vector3.TransformNormalFromFloatsToRef(p.nrm[3 * i], p.nrm[3 * i + 1], p.nrm[3 * i + 2], normalMatrix, v);
                    v.normalize();
                    normals[3 * (vo + i)] = v.x; normals[3 * (vo + i) + 1] = v.y; normals[3 * (vo + i) + 2] = v.z;
                }
                if (uvs && p.uv) { uvs[2 * (vo + i)] = p.uv[2 * i]; uvs[2 * (vo + i) + 1] = 1 - p.uv[2 * i + 1]; }
                if (colors) {
                    // Цвет вершины glTF линейный, StandardMaterial ждёт гамму.
                    const k = p.colSize, c = p.col;
                    for (let j = 0; j < 3; j++) colors[4 * (vo + i) + j] = c ? Math.pow(Math.max(0, c[k * i + j]), 1 / 2.2) : 1;
                    colors[4 * (vo + i) + 3] = c && k === 4 ? c[k * i + 3] : 1;
                }
            }
            const start = io;
            for (let t = 0; t + 2 < p.idx.length; t += 3) {
                // Задом наперёд — обход Babylon; зеркальный трансформ разворачивает сам.
                indices[io++] = vo + p.idx[t];
                indices[io++] = vo + p.idx[mirror ? t + 1 : t + 2];
                indices[io++] = vo + p.idx[mirror ? t + 2 : t + 1];
            }
            const last = groups[groups.length - 1];
            if (last && last.material === p.material) last.count += io - start;
            else groups.push({ material: p.material, start, count: io - start });
            vo += count;
        }
        return { positions, normals, uvs, colors, indices: indices.subarray(0, io), groups };
    },

    // Полоса и веер -> список треугольников (обход glTF: против часовой).
    _triangles(idx, mode) {
        if (mode === 4) return idx;
        const out = [];
        for (let i = 2; i < idx.length; i++) {
            if (mode === 5) {
                if (i % 2 === 0) out.push(idx[i - 2], idx[i - 1], idx[i]);
                else out.push(idx[i - 1], idx[i - 2], idx[i]);
            } else {
                out.push(idx[0], idx[i - 1], idx[i]);
            }
        }
        return Uint32Array.from(out);
    },

    // Материал glTF -> материал Model3D (цвет линейный, текстура умножается на цвет).
    _material(gltf, i, base) {
        const src = i >= 0 && gltf.json.materials ? gltf.json.materials[i] : null;
        const m = Model3D.material(src && src.name || (i >= 0 ? 'material' + i : 'default'));
        m.linear = true;
        m.tint = true;
        if (!src) return m;
        const pbr = src.pbrMetallicRoughness || {};
        const f = pbr.baseColorFactor || [1, 1, 1, 1];
        m.color = [f[0], f[1], f[2]];
        m.alpha = f[3] == null ? 1 : f[3];
        m.alphaMode = src.alphaMode === 'BLEND' ? 'blend' : src.alphaMode === 'MASK' ? 'mask' : 'opaque';
        if (m.alphaMode === 'opaque') m.alpha = 1;
        m.doubleSided = !!src.doubleSided;
        const info = pbr.baseColorTexture;
        if (info && gltf.json.textures && gltf.json.textures[info.index]) {
            const tex = gltf.json.textures[info.index];
            const ext = tex.extensions || {};
            const source = tex.source != null ? tex.source : (ext.EXT_texture_webp || ext.KHR_texture_basisu || {}).source;
            m.texture = this._image(gltf, source, base);
        }
        return m;
    },

    // Картинка: в буфере (bufferView) — blob: URL, иначе файл или data: URI.
    _image(gltf, index, base) {
        const img = gltf.json.images && gltf.json.images[index];
        if (!img) return null;
        if (img.bufferView != null) {
            const bv = gltf.json.bufferViews[img.bufferView], buf = gltf.buffers[bv.buffer];
            const bytes = buf.subarray((bv.byteOffset || 0), (bv.byteOffset || 0) + bv.byteLength);
            return { url: Model3D.blobUrl(bytes, img.mimeType), mimeType: img.mimeType || 'image/png' };
        }
        if (!img.uri) return null;
        return { url: Model3D.resolve(base, img.uri), mimeType: img.mimeType || Model3D.mimeOf(img.uri) };
    },

    // Аксессор -> Float32Array (нормализованные целые — в 0..1 / −1..1) или
    // Uint32Array (asIndex). Sparse-значения накладываются поверх.
    _read(gltf, index, asIndex) {
        const a = gltf.json.accessors[index];
        const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }[a.type] || 1;
        const T = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array }[a.componentType];
        if (!T) throw new Error('glTF: unknown component type ' + a.componentType);
        const out = asIndex ? new Uint32Array(a.count * n) : new Float32Array(a.count * n);
        const norm = a.normalized && !asIndex ? { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 }[a.componentType] || 1 : 1;
        const put = (src, count, stride, dst, dstAt) => {
            for (let i = 0; i < count; i++) for (let k = 0; k < n; k++) {
                const v = src(i * stride + k);
                dst[(dstAt(i)) * n + k] = norm === 1 ? v : Math.max(-1, v / norm);
            }
        };
        if (a.bufferView != null) this._view(gltf, a.bufferView, a.byteOffset || 0, T, a.count, n, (get, stride) => put(get, a.count, stride, out, (i) => i));
        if (a.sparse) {
            const s = a.sparse, IT = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array }[s.indices.componentType];
            const at = [];
            this._view(gltf, s.indices.bufferView, s.indices.byteOffset || 0, IT, s.count, 1, (get) => { for (let i = 0; i < s.count; i++) at.push(get(i)); });
            this._view(gltf, s.values.bufferView, s.values.byteOffset || 0, T, s.count, n, (get, stride) => put(get, s.count, stride, out, (i) => at[i]));
        }
        return out;
    },

    // Чтение bufferView: fn(get(номер компонента с учётом шага), шаг в компонентах).
    _view(gltf, viewIndex, offset, T, count, n, fn) {
        const bv = gltf.json.bufferViews[viewIndex], buf = gltf.buffers[bv.buffer];
        const size = T.BYTES_PER_ELEMENT, start = buf.byteOffset + (bv.byteOffset || 0) + offset;
        const strideBytes = bv.byteStride || n * size;
        if (strideBytes % size === 0 && start % size === 0) {
            const arr = new T(buf.buffer, start, Math.max(0, (count - 1) * strideBytes / size + n));
            fn((i) => arr[i], strideBytes / size);
            return;
        }
        // Невыровненные данные — через DataView (компонент i: элемент i/n, смещение i%n).
        const dv = new DataView(buf.buffer, start);
        const getter = { 1: T === Int8Array ? 'getInt8' : 'getUint8', 2: T === Int16Array ? 'getInt16' : 'getUint16',
            4: T === Float32Array ? 'getFloat32' : 'getUint32' }[size];
        fn((i) => dv[getter](Math.floor(i / n) * strideBytes + (i % n) * size, true), n);
    },
};
