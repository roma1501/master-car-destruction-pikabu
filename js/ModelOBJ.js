// ModelOBJ.js — разбор Wavefront OBJ (+ материалы .mtl) в модель Model3D (формат —
// шапка Model3D.js). Зовёт Model3D.load по расширению .obj.
//
// Берётся: v (и цвет вершины «v x y z r g b»), vt, vn, f (полигоны веером в
// треугольники, индексы 1.. и отрицательные), o — части (если o в файле нет —
// g), usemtl — группы материалов, mtllib -> newmtl: Kd (цвет), d / Tr
// (прозрачность), map_Kd (текстура рядом с моделью). Не берётся: линии и точки,
// кривые, другие карты материала.
//
// ЕДИНИЦЫ: метры (так пишет Blender) × 100 = px мира. Центр части — середина её
// габарита, оси — оси модели: у OBJ нет своих origin объектов.
// ОБХОД: треугольники задом наперёд (шапка Model3D.js). Нормалей нет — у
// треугольников свои вершины, ComputeNormals даст плоское затенение.

/** @satisfies {Record<string, any>} */
const ModelOBJ = {
    UNIT: 100,   // px мира на единицу файла (1 м = 100 px)

    // Текст OBJ -> модель; ctx: { url, base } — папка файла для .mtl и текстур.
    async parse(text, ctx) {
        const base = (ctx && ctx.base) || '';
        const lines = String(text).split(/\r?\n/);
        const S = this.UNIT;
        const V = [], VC = [], VT = [], VN = [];
        const libs = [];
        const hasO = lines.some((l) => /^\s*o\s/.test(l));
        const parts = [];
        let part = null, group = null, matName = 'default';

        const startPart = (name) => {
            part = { name: name || 'part' + (parts.length + 1), groups: new Map() };
            parts.push(part);
            group = null;
        };
        const useGroup = () => {
            if (!part) startPart('');
            group = part.groups.get(matName);
            if (!group) part.groups.set(matName, (group = { pos: [], nrm: [], uv: [], col: [], flat: false }));
            return group;
        };

        for (const raw of lines) {
            const line = raw.trim();
            if (!line || line[0] === '#') continue;
            const sp = line.indexOf(' ');
            const key = sp < 0 ? line : line.slice(0, sp);
            const rest = sp < 0 ? '' : line.slice(sp + 1).trim();
            if (key === 'v') {
                const n = rest.split(/\s+/).map(Number);
                V.push(n[0] * S, n[1] * S, n[2] * S);
                VC.push(n.length >= 6 ? [n[3], n[4], n[5]] : null);
            } else if (key === 'vt') {
                const n = rest.split(/\s+/).map(Number);
                VT.push(n[0] || 0, n[1] || 0);
            } else if (key === 'vn') {
                const n = rest.split(/\s+/).map(Number);
                VN.push(n[0], n[1], n[2]);
            } else if (key === 'f') {
                const g = useGroup();
                const corners = rest.split(/\s+/).map((c) => c.split('/'));
                const idx = (s, count) => {
                    const i = parseInt(s, 10);
                    return Number.isFinite(i) ? (i < 0 ? count + i : i - 1) : -1;
                };
                const push = (c) => {
                    const v = idx(c[0], V.length / 3), t = idx(c[1], VT.length / 2), n = idx(c[2], VN.length / 3);
                    g.pos.push(V[3 * v] || 0, V[3 * v + 1] || 0, V[3 * v + 2] || 0);
                    g.uv.push(t >= 0 ? VT[2 * t] : 0, t >= 0 ? VT[2 * t + 1] : 0);
                    if (n >= 0) g.nrm.push(VN[3 * n], VN[3 * n + 1], VN[3 * n + 2]);
                    else { g.nrm.push(0, 0, 0); g.flat = true; }
                    const col = VC[v];
                    g.col.push(col ? col[0] : 1, col ? col[1] : 1, col ? col[2] : 1, 1);
                };
                // Веер (0, k, k+1) задом наперёд — обход Babylon.
                for (let k = 1; k + 1 < corners.length; k++) {
                    push(corners[0]);
                    push(corners[k + 1]);
                    push(corners[k]);
                }
            } else if (key === 'o' || (key === 'g' && !hasO)) {
                startPart(rest);
            } else if (key === 'usemtl') {
                matName = rest || 'default';
                if (part) group = null;
            } else if (key === 'mtllib') {
                libs.push(rest);
            }
        }

        const mtl = {};
        for (const lib of libs) {
            try { Object.assign(mtl, this.parseMtl(await Model3D.fetchText(Model3D.resolve(base, lib)), base)); }
            catch (e) { console.warn('ModelOBJ: no material library ' + lib + ' — ' + ((e && e.message) || e)); }
        }

        const model = Model3D.emptyModel();
        const matIndex = new Map();
        const materialIndex = (name) => {
            if (!matIndex.has(name)) {
                matIndex.set(name, model.materials.length);
                model.materials.push(mtl[name] || Model3D.material(name));
            }
            return matIndex.get(name);
        };
        const anyColor = VC.some(Boolean), anyUv = VT.length > 0;
        for (const p of parts) {
            let total = 0, flat = false;
            for (const g of p.groups.values()) { total += g.pos.length; flat = flat || g.flat; }
            if (!total) continue;
            const n = total / 3;
            const positions = new Float32Array(total), normals = flat ? null : new Float32Array(total);
            const uvs = anyUv ? new Float32Array(n * 2) : null, colors = anyColor ? new Float32Array(n * 4) : null;
            const groups = [];
            let at = 0;
            for (const [name, g] of p.groups) {
                if (!g.pos.length) continue;
                positions.set(g.pos, at);
                if (normals) normals.set(g.nrm, at);
                if (uvs) uvs.set(g.uv, at / 3 * 2);
                if (colors) colors.set(g.col, at / 3 * 4);
                groups.push({ material: materialIndex(name), start: at / 3, count: g.pos.length / 3 });
                at += g.pos.length;
            }
            const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
            Model3D.grow({ min: lo, max: hi }, positions);
            Model3D.grow(model, positions);
            model.parts.push({
                name: p.name, positions, normals, uvs, colors, indices: null, groups,
                pivot: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2],
                axes: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }
            });
        }
        if (!model.parts.length) throw new Error('no faces in OBJ');
        return model;
    },

    // Текст .mtl -> { имя: материал Model3D }. Пути текстур — от папки модели.
    parseMtl(text, base) {
        const out = {};
        let m = null;
        for (const raw of String(text).split(/\r?\n/)) {
            const line = raw.trim();
            if (!line || line[0] === '#') continue;
            const sp = line.indexOf(' ');
            const key = (sp < 0 ? line : line.slice(0, sp)).toLowerCase();
            const rest = sp < 0 ? '' : line.slice(sp + 1).trim();
            if (key === 'newmtl') { m = out[rest] = Model3D.material(rest); continue; }
            if (!m) continue;
            if (key === 'kd') {
                const n = rest.split(/\s+/).map(Number);
                if (n.length >= 3 && n.every(Number.isFinite)) m.color = [n[0], n[1], n[2]];
            } else if (key === 'd' || key === 'tr') {
                const v = Number(rest.split(/\s+/).pop());
                if (Number.isFinite(v)) m.alpha = key === 'd' ? v : 1 - v;
                if (m.alpha < 1) m.alphaMode = 'blend';
            } else if (key === 'map_kd') {
                const file = this._mapFile(rest);
                if (file) m.texture = { url: Model3D.resolve(base, file), mimeType: Model3D.mimeOf(file) };
            }
        }
        return out;
    },

    // «-bm 1 -s 1 1 1 wood tex.png» -> «wood tex.png»: опции карты со своими числами отбрасываются.
    _mapFile(rest) {
        const t = rest.split(/\s+/);
        const ARGS = { '-bm': 1, '-boost': 1, '-mm': 2, '-o': 3, '-s': 3, '-t': 3, '-texres': 1, '-clamp': 1, '-blendu': 1, '-blendv': 1, '-imfchan': 1, '-cc': 1 };
        let i = 0;
        while (i < t.length && t[i][0] === '-' && t[i] in ARGS) {
            let n = ARGS[t[i]];
            i++;
            // -o/-s/-t: от одного до трёх чисел.
            while (n-- > 0 && i < t.length && (!Number.isNaN(Number(t[i])) || /^(on|off|[rgbmlz])$/.test(t[i]))) i++;
        }
        return t.slice(i).join(' ');
    },
};
