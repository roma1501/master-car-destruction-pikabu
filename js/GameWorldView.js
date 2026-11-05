// GameWorldView.js — вид мира GameWorld: чанки рельефа с LOD (квадродерево без дыр: верхний уровень строится всегда, недостроенное закрывает предок; юбки против щелей),
// шейдер рельефа (узор земли в двух масштабах, площадки-плиты, колеи грунтовки), ленты дорог (асфальт, обочина и «фартук» по высоте физики, разметка, бордюры,
// заплаты и трещины), декор (деревья, камни) thin instances, небо (шейдер-купол), свет и туман по биому, отражения для машин, вода.
// Решений вид не принимает: физика и поверхности — GameWorld (инвариант 4). Всё, что здесь нарисовано, умирает в WorldView.dispose().
//
// Постройка: await GameWorld.buildView(app) → WorldView.build(app, GameWorld). Кадр: GameWorld.update(dt) → WorldView.update (рывок камеры — достройка сразу).
// Числа — константы WVIEW_* ниже; уровни графики — Quality (деревья, дальность, облака, число узлов рельефа). Текстуры земли — assets/textures/ground-{a,b}.webp
// и road-asphalt.webp (python tools/fx-gen/world_tex.py); описание для того, кто строит карты, — docs/WORLD.md, раздел «Как рисуется мир».
//
// Состав файла: WorldGeo (накопитель геометрии и процедурные модели), WorldTex (запасные текстуры кодом), WorldView (ядро: свет, небо, рельеф),
// WorldRoads (дороги), WorldDecor (деревья и камни).

// --- настройка (px; 1 м = 100 px) ---
const WVIEW_NODE_CELLS = 16;          // квадов на сторону узла рельефа (17×17 вершин на любом уровне)
const WVIEW_LEVELS = 6;               // уровней LOD: шаг вершин 2 м × 2^уровень (до 64 м)
const WVIEW_SPLIT = 1.85;              // узел делится, пока камера ближе размер × K (ПК)
const WVIEW_SPLIT_MOBILE = 1.0;       // то же на телефоне
const WVIEW_SPLIT_LOW = 1.2;          // низкое качество
const WVIEW_MIN_LEVEL_MOBILE = 1;     // самый подробный уровень на телефоне (4 м)
const WVIEW_BUILD_PER_FRAME = 4;      // узлов рельефа в кадр после загрузки (ближние первыми)
const WVIEW_BUILD_MS = 4;             // и не дольше стольки мс за кадр (рывок камеры и загрузка строят всё сразу)
const WVIEW_BACK_NEAR = 12000;        // px: при рывке камеры узлы позади строятся сразу только ближе этого (дальше — очередью)
const WVIEW_JUMP = 5000;              // px: камера ушла дальше за кадр — это рывок (респавн, телепорт): рельеф и декор строятся сразу, без дыр
const WVIEW_NODES_MAX = 520;          // узлов в памяти (лишние старые освобождаются)
const WVIEW_FAR = 175000;             // px: дальняя плоскость камеры
const WVIEW_NEAR = 40;                // px: ближняя плоскость (глубина 24 бита: чем дальше, тем меньше z-fighting; камера погони далеко от машины)
const WVIEW_SKIRT = 0.55;             // юбка узла: доля шага вершин ниже края
const WVIEW_ROAD_CHUNK = 40;          // выборок оси дороги на меш
const WVIEW_ROAD_DRAW = 130000;       // px: дальше дорога не рисуется
const WVIEW_DECOR_CHUNK = 2;          // ячеек декора (64 м) на сторону чанка
const WVIEW_TEXEL = 700;              // px мира на повтор ближнего узора земли (7 м)
const WVIEW_TEXEL_MICRO = 140;        // px мира на повтор мелкого узора (1.4 м: зерно, щебень, пучки травы)
const WVIEW_FLATS_GPU = 4;            // площадок, которые шейдер рельефа рисует сам (остальные — плитами-мешами)
const WVIEW_ROAD_SINK = 2;            // px: рельеф под лентой дороги ниже физики на столько (лента всегда сверху, без «прорезов»)
const WVIEW_ASPHALT = [0.29, 0.275, 0.268];   // средний цвет асфальта (текстура road-asphalt.webp): плита-площадка рисуется тем же цветом
const WVIEW_LAYERS = 4;               // слоёв наложения дорог (перекрёстки)
const WVIEW_ZOFF = -4;                // сдвиг глубины (zOffset) нижнего слоя дорог; рельеф — 0
const WVIEW_ZSTEP = 3;                // и на сколько каждый следующий слой ближе к камере
const WVIEW_LIFT = 1.2;               // px: лента дороги над рельефом (плюс zOffset материала)

const WVIEW_BIOME = {
    proving: { sky: 0xbfd8ee, sunColor: 0xfff0d9, sunIntensity: 1.08, skyLight: 0xb2cdee, skyIntensity: 0.5, groundLight: 0x8c8578, fog: 0.0000085, sunAz: 28, sunEl: 52, shadowColor: 0x1b2230, shadowStrength: 0.58, cloud: 0.35 },
    alpine: { sky: 0xb2cde8, sunColor: 0xfff0d6, sunIntensity: 1.08, skyLight: 0xa3c3ee, skyIntensity: 0.52, groundLight: 0x7f7a66, fog: 0.000012, sunAz: 205, sunEl: 40, shadowColor: 0x1a2232, shadowStrength: 0.6, cloud: 0.55 },
    highway: { sky: 0xbcd0e2, sunColor: 0xffe9c4, sunIntensity: 1.1, skyLight: 0xa9c5e8, skyIntensity: 0.5, groundLight: 0x82785f, fog: 0.000012, sunAz: 232, sunEl: 44, shadowColor: 0x1d2231, shadowStrength: 0.6, cloud: 0.5 },
    city: { sky: 0xc2cfda, sunColor: 0xfff1da, sunIntensity: 1.02, skyLight: 0xb0c6e2, skyIntensity: 0.54, groundLight: 0x85817b, fog: 0.000016, sunAz: 40, sunEl: 48, shadowColor: 0x1e2430, shadowStrength: 0.56, cloud: 0.5 },
    canyon: { sky: 0xe6d3bd, sunColor: 0xffe0b0, sunIntensity: 1.14, skyLight: 0xb9c6e2, skyIntensity: 0.46, groundLight: 0x95644a, fog: 0.00001, sunAz: 150, sunEl: 52, shadowColor: 0x2a1d1c, shadowStrength: 0.6, cloud: 0.25 },
};

/** Палитры земли по биомам: [тёмный, светлый] вариант в экранных тонах (0..1). */
const WVIEW_PALETTE = {
    alpine: { grass: [[0.2, 0.33, 0.12], [0.34, 0.43, 0.17]], dirt: [[0.34, 0.27, 0.19], [0.46, 0.37, 0.26]], rock: [[0.36, 0.35, 0.34], [0.52, 0.49, 0.45]], sand: [[0.6, 0.55, 0.42], [0.7, 0.64, 0.5]], snow: [[0.86, 0.89, 0.94], [0.96, 0.97, 1]], concrete: [[0.5, 0.5, 0.5], [0.58, 0.58, 0.58]], verge: [0.44, 0.38, 0.28] },
    highway: { grass: [[0.27, 0.4, 0.14], [0.4, 0.5, 0.2]], dirt: [[0.37, 0.26, 0.17], [0.5, 0.36, 0.23]], rock: [[0.43, 0.41, 0.38], [0.58, 0.55, 0.5]], sand: [[0.7, 0.63, 0.45], [0.8, 0.72, 0.54]], snow: [[0.9, 0.92, 0.96], [0.96, 0.97, 1]], concrete: [[0.5, 0.5, 0.5], [0.58, 0.58, 0.58]], verge: [0.5, 0.42, 0.3] },
    canyon: { grass: [[0.45, 0.4, 0.2], [0.58, 0.5, 0.26]], dirt: [[0.5, 0.28, 0.17], [0.66, 0.38, 0.23]], rock: [[0.5, 0.27, 0.18], [0.72, 0.46, 0.3]], sand: [[0.72, 0.5, 0.31], [0.85, 0.63, 0.42]], snow: [[0.9, 0.9, 0.9], [1, 1, 1]], concrete: [[0.5, 0.45, 0.4], [0.6, 0.55, 0.5]], verge: [0.62, 0.42, 0.28] },
    city: { grass: [[0.22, 0.36, 0.14], [0.34, 0.46, 0.2]], dirt: [[0.38, 0.32, 0.24], [0.5, 0.42, 0.32]], rock: [[0.42, 0.42, 0.42], [0.55, 0.55, 0.55]], sand: [[0.65, 0.6, 0.48], [0.75, 0.7, 0.58]], snow: [[0.9, 0.92, 0.96], [0.96, 0.97, 1]], concrete: [[0.4, 0.4, 0.4], [0.5, 0.5, 0.5]], verge: [0.46, 0.44, 0.4] },
    proving: { grass: [[0.25, 0.36, 0.15], [0.36, 0.46, 0.2]], dirt: [[0.4, 0.34, 0.26], [0.5, 0.43, 0.33]], rock: [[0.45, 0.45, 0.45], [0.58, 0.58, 0.58]], sand: [[0.66, 0.6, 0.47], [0.76, 0.7, 0.56]], snow: [[0.9, 0.92, 0.96], [0.96, 0.97, 1]], concrete: [[0.46, 0.46, 0.45], [0.56, 0.56, 0.54]], verge: [0.46, 0.42, 0.33] },
};

// ---------------------------------------------------------------------------------------------
// WorldGeo — накопитель геометрии (вершинные цвета, плоские и сглаженные грани) и процедурные модели декора
// ---------------------------------------------------------------------------------------------

/** @satisfies {Record<string, any>} */
const WorldGeo = {
    /**
     * Накопитель: v(...) добавляет вершину, tri/quad — грани с обходом по желаемой нормали (против неё — разворачиваются).
     * Преобразование: setTransform(O, ax, ay, az) — локальные точки в мир; цвет — [r, g, b, a].
     */
    builder() {
        /** @type {number[]} */ const pos = [], nrm = [], col = [], uv = [], idx = [], wm = [];
        let hasWm = false;
        let O = [0, 0, 0], AX = [1, 0, 0], AY = [0, 1, 0], AZ = [0, 0, 1], moved = false;
        const tp = (p) => moved ? [O[0] + p[0] * AX[0] + p[1] * AY[0] + p[2] * AZ[0], O[1] + p[0] * AX[1] + p[1] * AY[1] + p[2] * AZ[1], O[2] + p[0] * AX[2] + p[1] * AY[2] + p[2] * AZ[2]] : p;
        const tn = (n) => moved ? [n[0] * AX[0] + n[1] * AY[0] + n[2] * AZ[0], n[0] * AX[1] + n[1] * AY[1] + n[2] * AZ[1], n[0] * AX[2] + n[1] * AY[2] + n[2] * AZ[2]] : n;
        const b = {
            pos, nrm, col, uv, idx, wm,
            /** Локальные оси → мир (для пачки деталей): setTransform([x, y, z], ax, ay, az); без аргументов — единичное. */
            setTransform(o, ax, ay, az) { moved = !!o; O = o || [0, 0, 0]; AX = ax || [1, 0, 0]; AY = ay || [0, 1, 0]; AZ = az || [0, 0, 1]; },
            get count() { return pos.length / 3; },
            /** Вершина: p [x, y, z], n [x, y, z], c [r, g, b, a], uv [u, v] (необязательно), w — веса узора земли [скала, щебень, бетон, песок] (для материала рельефа). → индекс. */
            v(p, n, c, t, w) {
                const q = tp(p), m = tn(n);
                pos.push(q[0], q[1], q[2]); nrm.push(m[0], m[1], m[2]);
                col.push(c[0], c[1], c[2], c[3] == null ? 1 : c[3]);
                uv.push(t ? t[0] : 0, t ? t[1] : 0);
                if (w) { hasWm = true; wm.push(w[0], w[1], w[2], w[3]); } else wm.push(0, 0, 0, 0);
                return pos.length / 3 - 1;
            },
            /** Треугольник по индексам; обход проверяется по сумме нормалей вершин (и пересчитывается). */
            tri(i, j, k) {
                const ax = pos[i * 3], ay = pos[i * 3 + 1], az = pos[i * 3 + 2], bx = pos[j * 3], by = pos[j * 3 + 1], bz = pos[j * 3 + 2], cx = pos[k * 3], cy = pos[k * 3 + 1], cz = pos[k * 3 + 2];
                // нормаль грани в соглашении Babylon: (p1 − p2) × (p3 − p2)
                const e1x = ax - bx, e1y = ay - by, e1z = az - bz, e2x = cx - bx, e2y = cy - by, e2z = cz - bz;
                const gx = e1y * e2z - e1z * e2y, gy = e1z * e2x - e1x * e2z, gz = e1x * e2y - e1y * e2x;
                const nx = nrm[i * 3] + nrm[j * 3] + nrm[k * 3], ny = nrm[i * 3 + 1] + nrm[j * 3 + 1] + nrm[k * 3 + 1], nz = nrm[i * 3 + 2] + nrm[j * 3 + 2] + nrm[k * 3 + 2];
                if (gx * nx + gy * ny + gz * nz < 0) idx.push(i, k, j); else idx.push(i, j, k);
            },
            quad(i, j, k, l) { b.tri(i, j, k); b.tri(i, k, l); },
            /** Плоский многоугольник (выпуклый) с одной нормалью и цветом. */
            poly(pts, n, c, uvs) {
                const ids = pts.map((p, i) => b.v(p, n, c, uvs ? uvs[i] : null));
                for (let i = 1; i + 1 < ids.length; i++) b.tri(ids[0], ids[i], ids[i + 1]);
            },
            /** Параллелепипед по осям: x ∈ [−hx, hx], y ∈ [y0, y1], z ∈ [−hz, hz]. top/side — цвета. */
            box(hx, y0, y1, hz, side, top, noBottom) {
                const t = top || side;
                b.poly([[-hx, y1, -hz], [-hx, y1, hz], [hx, y1, hz], [hx, y1, -hz]], [0, 1, 0], t);
                if (!noBottom) b.poly([[-hx, y0, -hz], [hx, y0, -hz], [hx, y0, hz], [-hx, y0, hz]], [0, -1, 0], side);
                b.poly([[hx, y0, -hz], [hx, y1, -hz], [hx, y1, hz], [hx, y0, hz]], [1, 0, 0], side);
                b.poly([[-hx, y0, hz], [-hx, y1, hz], [-hx, y1, -hz], [-hx, y0, -hz]], [-1, 0, 0], side);
                b.poly([[hx, y0, hz], [hx, y1, hz], [-hx, y1, hz], [-hx, y0, hz]], [0, 0, 1], side);
                b.poly([[-hx, y0, -hz], [-hx, y1, -hz], [hx, y1, -hz], [hx, y0, -hz]], [0, 0, -1], side);
            },
            /** Усечённый конус/цилиндр с осью Y: радиусы r0 (низ) и r1 (верх), seg граней; сглаженные нормали; крышки по флагам. */
            cyl(cx, cz, r0, r1, y0, y1, seg, c, cTop, capTop, capBot, c1) {
                const top = cTop || c, bot = c1 || c;
                const ring = [];
                const slope = (r0 - r1) / Math.max(1e-6, y1 - y0);
                for (let i = 0; i < seg; i++) { const a = i / seg * Math.PI * 2; ring.push([Math.cos(a), Math.sin(a)]); }
                for (let i = 0; i < seg; i++) {
                    const [c0, s0] = ring[i], [c1b, s1] = ring[(i + 1) % seg];
                    const n0 = norm3([c0, slope, s0]), n1 = norm3([c1b, slope, s1]);
                    const a = b.v([cx + c0 * r0, y0, cz + s0 * r0], n0, bot), d = b.v([cx + c1b * r0, y0, cz + s1 * r0], n1, bot);
                    const e = b.v([cx + c0 * r1, y1, cz + s0 * r1], n0, c), f = b.v([cx + c1b * r1, y1, cz + s1 * r1], n1, c);
                    b.quad(a, d, f, e);
                }
                if (capTop && r1 > 0) b.poly(ring.map(([c0, s0]) => [cx + c0 * r1, y1, cz + s0 * r1]), [0, 1, 0], top);
                if (capBot && r0 > 0) b.poly(ring.map(([c0, s0]) => [cx + c0 * r0, y0, cz + s0 * r0]).reverse(), [0, -1, 0], bot);
            },
            /** Низкополигональный эллипсоид (икосаэдр, subdiv 0 или 1) с граненым освещением; jitter — сдвиг вершин 0..1 по сиду. */
            blob(cx, cy, cz, rx, ry, rz, c, subdiv, jitter, seed, shade) {
                const t = (1 + Math.sqrt(5)) / 2;
                /** @type {number[][]} */
                let V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(norm3);
                let F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
                for (let s = 0; s < (subdiv | 0); s++) {
                    /** @type {Map<string, number>} */ const mid = new Map();
                    const half = (a, bb) => { const k = a < bb ? a + '_' + bb : bb + '_' + a; let m = mid.get(k); if (m == null) { V.push(norm3([(V[a][0] + V[bb][0]) / 2, (V[a][1] + V[bb][1]) / 2, (V[a][2] + V[bb][2]) / 2])); m = V.length - 1; mid.set(k, m); } return m; };
                    /** @type {number[][]} */ const nf = [];
                    for (const [a, bb, cc] of F) { const ab = half(a, bb), bc = half(bb, cc), ca = half(cc, a); nf.push([a, ab, ca], [bb, bc, ab], [cc, ca, bc], [ab, bc, ca]); }
                    F = nf;
                }
                const P = V.map((v, i) => { const j = jitter ? 1 + (worldHash(i, 7, seed | 0) - 0.5) * 2 * jitter : 1; return [cx + v[0] * rx * j, cy + v[1] * ry * j, cz + v[2] * rz * j]; });
                for (let fi = 0; fi < F.length; fi++) {
                    const f = F[fi], p0 = P[f[0]], p1 = P[f[1]], p2 = P[f[2]];
                    const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
                    let n = norm3([e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]);
                    const mx = (p0[0] + p1[0] + p2[0]) / 3 - cx, my = (p0[1] + p1[1] + p2[1]) / 3 - cy, mz = (p0[2] + p1[2] + p2[2]) / 3 - cz;
                    if (n[0] * mx + n[1] * my + n[2] * mz < 0) n = [-n[0], -n[1], -n[2]];
                    const k = 1 + (worldHash(fi, 3, (seed | 0) + 5) - 0.5) * (shade == null ? 0.22 : shade) + n[1] * 0.06;
                    const cc = [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k), 1];
                    const ia = b.v(p0, n, cc), ib = b.v(p1, n, cc), ic = b.v(p2, n, cc);
                    b.tri(ia, ib, ic);
                }
            },
            /** Меш Babylon из накопленного. mat — материал; opts: { uvs: false }. */
            toMesh(scene, name, mat, opts) {
                if (!idx.length) return null;
                const mesh = new BABYLON.Mesh(name, scene);
                const vd = new BABYLON.VertexData();
                vd.positions = new Float32Array(pos); vd.normals = new Float32Array(nrm); vd.colors = new Float32Array(col);
                if (!opts || opts.uvs !== false) vd.uvs = new Float32Array(uv);
                vd.indices = pos.length / 3 > 65000 ? new Uint32Array(idx) : new Uint16Array(idx);
                vd.applyToMesh(mesh, false);
                if (hasWm) mesh.setVerticesData('wmix', new Float32Array(wm), false, 4);
                if (mat) mesh.material = mat;
                return mesh;
            },
        };
        return b;
    },

    /** Модели декора мира единичной высоты (низ в y = 0, ширина по ±x, z): near — полная, far — упрощённая. */
    decorModel(kind, far) {
        const g = WorldGeo.builder();
        const C = (r, gg, bb) => [r, gg, bb, 1];
        switch (kind) {
            case 'spruce': {
                const trunk = C(0.24, 0.17, 0.11);
                if (far) { g.cyl(0, 0, 0.2, 0, 0.1, 1.0, 5, C(0.1, 0.23, 0.12)); break; }
                g.cyl(0, 0, 0.028, 0.02, 0, 0.3, 5, trunk);
                const tiers = [[0.1, 0.46, 0.215, C(0.1, 0.24, 0.12)], [0.3, 0.72, 0.165, C(0.11, 0.27, 0.13)], [0.54, 1.0, 0.1, C(0.12, 0.29, 0.14)]];
                for (const [y0, y1, r, col] of tiers) g.cyl(0, 0, r, 0, y0, y1, 7, col, col, false, true, [col[0] * 0.7, col[1] * 0.7, col[2] * 0.7, 1]);
                break;
            }
            case 'oak': {
                g.cyl(0, 0, 0.034, 0.024, 0, 0.5, 5, C(0.27, 0.2, 0.13));
                if (far) { g.blob(0, 0.68, 0, 0.3, 0.3, 0.3, C(0.2, 0.34, 0.12), 0, 0.12, 1); break; }
                g.blob(0, 0.66, 0, 0.3, 0.28, 0.3, C(0.2, 0.35, 0.12), 1, 0.16, 11, 0.3);
                g.blob(0.13, 0.82, 0.07, 0.2, 0.18, 0.2, C(0.26, 0.4, 0.14), 0, 0.15, 12, 0.3);
                g.blob(-0.12, 0.5, -0.08, 0.17, 0.15, 0.17, C(0.17, 0.3, 0.1), 0, 0.15, 13, 0.3);
                break;
            }
            case 'poplar': {
                g.cyl(0, 0, 0.012, 0.01, 0, 0.3, 5, C(0.3, 0.24, 0.16));
                g.blob(0, 0.62, 0, 0.13, 0.4, 0.13, C(0.18, 0.34, 0.1), far ? 0 : 1, 0.12, 21, 0.28);
                break;
            }
            case 'bush': g.blob(0, 0.45, 0, 0.5, 0.45, 0.5, C(0.2, 0.32, 0.12), far ? 0 : 1, 0.2, 31, 0.3); break;
            case 'rock': g.blob(0, 0.3, 0, 1, 0.8, 1, C(0.46, 0.44, 0.41), far ? 0 : 1, 0.28, 41, 0.34); break;
            case 'cactus': {
                const col = C(0.25, 0.42, 0.2);
                g.cyl(0, 0, 0.05, 0.045, 0, 1, 6, col, col, true);
                if (!far) {
                    g.cyl(0.13, 0, 0.032, 0.03, 0.4, 0.62, 5, col, col, true);
                    g.cyl(0.08, 0, 0.03, 0.028, 0.58, 0.8, 5, col, col, true);
                }
                break;
            }
            case 'snag':
            case 'dead': {
                const col = C(0.3, 0.24, 0.18);
                g.cyl(0, 0, 0.03, 0.012, 0, 1, 5, col);
                if (!far) { g.cyl(0.1, 0, 0.012, 0.004, 0.55, 0.8, 4, col); g.cyl(-0.09, 0.03, 0.01, 0.004, 0.45, 0.68, 4, col); }
                break;
            }
            default: g.blob(0, 0.3, 0, 0.3, 0.3, 0.3, C(0.4, 0.4, 0.4), 0, 0.1, 1);
        }
        return g;
    },
};

/** Нормализация вектора [x, y, z]. */
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

// ---------------------------------------------------------------------------------------------
// WorldTex — текстуры кодом (без холста: массивы RGBA, работают и без DOM)
// ---------------------------------------------------------------------------------------------

/** @satisfies {Record<string, any>} */
const WorldTex = {
    /** Периодический значимый шум [0, 1] с периодом P по обеим осям (стык без шва). */
    tnoise(x, y, P, seed) {
        const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
        const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
        const m = (n) => ((n % P) + P) % P;
        const a = worldHash(m(ix), m(iy), seed), b = worldHash(m(ix + 1), m(iy), seed), c = worldHash(m(ix), m(iy + 1), seed), d = worldHash(m(ix + 1), m(iy + 1), seed);
        return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    },
    /** Периодический фрактальный шум [0, 1]: base — период первой октавы (в узлах). */
    tfbm(u, v, base, oct, seed) {
        let amp = 1, sum = 0, norm = 0, p = base;
        for (let i = 0; i < oct; i++) { sum += amp * WorldTex.tnoise(u * p, v * p, p, seed + i * 13); norm += amp; amp *= 0.5; p *= 2; }
        return sum / norm;
    },

    /**
     * Мелкая деталь земли (RGBA, size×size): R — мягкая пятнистость, G — мелкое зерно, B — рисунок камня (трещины, слои) или плит
     * (concrete — швы 2×2 плит на повтор), A — крупные пятна. Среднее ≈ 0.5: шейдер умножает цвет вершин на 0.6…1.4.
     * @param {number} size @param {boolean} concrete
     */
    detail(size, concrete) {
        const d = new Uint8Array(size * size * 4);
        for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
            const u = i / size, v = j / size, o = (j * size + i) * 4;
            const soft = Math.max(0, Math.min(1, (WorldTex.tfbm(u, v, 6, 4, 11) - 0.5) * 1.9 + 0.5));
            const grain = 0.5 + (WorldTex.tfbm(u, v, 64, 2, 22) - 0.5) * 1.1 + (worldHash(i, j, 5) - 0.5) * 0.45;
            let rock;
            if (concrete) {
                // плиты 2×2: тон плиты, шов, мелкие поры
                const su = (u * 2) % 1, sv = (v * 2) % 1, cell = worldHash(Math.floor(u * 2), Math.floor(v * 2), 31);
                const e = Math.min(su, 1 - su, sv, 1 - sv) * size / 2;
                const joint = e < 1.4 ? 0.12 : e < 3 ? 0.4 : 1;
                rock = (0.5 + (cell - 0.5) * 0.18 + (WorldTex.tfbm(u, v, 8, 3, 41) - 0.5) * 0.3 + (worldHash(i, j, 9) - 0.5) * 0.15) * (0.3 + 0.7 * joint);
            } else {
                const r = Math.abs(WorldTex.tfbm(u, v, 8, 4, 41) - 0.5) * 2, r2 = Math.abs(WorldTex.tfbm(u + 0.31, v + 0.17, 16, 3, 43) - 0.5) * 2;
                rock = 0.34 + 0.62 * Math.pow(Math.min(1, r * 1.5), 0.6) - 0.28 * (1 - Math.min(1, r2 * 6)) + (worldHash(i, j, 7) - 0.5) * 0.12;
            }
            const blot = WorldTex.tfbm(u, v, 3, 3, 51);
            d[o] = Math.max(0, Math.min(255, soft * 255 * 1.05)); d[o + 1] = Math.max(0, Math.min(255, grain * 255)); d[o + 2] = Math.max(0, Math.min(255, rock * 255)); d[o + 3] = Math.max(0, Math.min(255, blot * 255));
        }
        return d;
    },

    /** Покрытие дороги кодом: kind 'concrete' (плиты, шов вверху), 'gravel', 'dirt', 'asphalt' (запас, если фото не загрузилось). RGBA непрозрачный. */
    surface(kind, size) {
        const d = new Uint8Array(size * size * 4);
        const base = { concrete: [172, 170, 164], gravel: [138, 128, 114], dirt: [122, 96, 70], asphalt: [68, 70, 74] }[kind] || [120, 120, 120];
        for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
            const u = i / size, v = j / size, o = (j * size + i) * 4;
            let k = 1;
            if (kind === 'concrete') {
                k = 0.93 + (WorldTex.tfbm(u, v, 5, 3, 61) - 0.5) * 0.24 + (worldHash(i, j, 3) - 0.5) * 0.08;
                if (j < 2) k *= 0.45; else if (j < 4) k *= 0.75;
            } else if (kind === 'gravel') {
                // щебень: камни 6–12 см (шум периода 40), мелкая крошка и тёмные щели между ними
                const st = WorldTex.tnoise(u * 40, v * 40, 40, 74), st2 = WorldTex.tnoise(u * 90 + 3, v * 90, 90, 75);
                k = 0.5 + 0.55 * st * st + 0.22 * st2 + (worldHash(i, j, 72) - 0.5) * 0.16 + (WorldTex.tfbm(u, v, 4, 3, 73) - 0.5) * 0.3;
            } else if (kind === 'dirt') {
                k = 0.8 + (WorldTex.tfbm(u, v, 6, 4, 81) - 0.5) * 0.6 + (worldHash(i, j, 82) - 0.5) * 0.18;
            } else {
                k = 0.85 + (worldHash(i, j, 91) - 0.5) * 0.35 + (WorldTex.tfbm(u, v, 5, 3, 92) - 0.5) * 0.25;
            }
            d[o] = Math.max(0, Math.min(255, base[0] * k)); d[o + 1] = Math.max(0, Math.min(255, base[1] * k)); d[o + 2] = Math.max(0, Math.min(255, base[2] * k)); d[o + 3] = 255;
        }
        return d;
    },

    /** Шум облаков: тайл size×size, R — крупные формы, G — мелкие (RGBA). */
    clouds(size) {
        const d = new Uint8Array(size * size * 4);
        for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
            const u = i / size, v = j / size, o = (j * size + i) * 4;
            d[o] = WorldTex.tfbm(u, v, 3, 5, 101) * 255; d[o + 1] = WorldTex.tfbm(u, v, 9, 4, 103) * 255; d[o + 2] = 0; d[o + 3] = 255;
        }
        return d;
    },
};

// ---------------------------------------------------------------------------------------------
// WorldView — ядро вида: свет и небо по биому, рельеф-квадродерево, материалы
// ---------------------------------------------------------------------------------------------

const WVIEW_SKY_VS = `precision highp float;
attribute vec3 position;
uniform mat4 view;
uniform mat4 projection;
varying vec3 vDir;
void main(void) {
    vDir = position;
    vec4 v = view * vec4(position, 0.0);
    gl_Position = (projection * vec4(v.xyz, 1.0)).xyww;
}`;

const WVIEW_SKY_FS = `precision highp float;
varying vec3 vDir;
uniform vec3 horizon;
uniform vec3 zenith;
uniform vec3 groundCol;
uniform vec3 sunDir;
uniform vec3 sunCol;
uniform vec4 prm;
uniform sampler2D cloudTex;
float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
void main(void) {
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 col = mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.45));
    col = mix(col, groundCol, smoothstep(0.0, -0.2, h));
    float sd = max(dot(d, sunDir), 0.0);
    col += sunCol * (pow(sd, 5.0) * 0.1 + pow(sd, 40.0) * 0.26);
    col += sunCol * smoothstep(0.99962, 0.99985, sd) * 5.0 * (1.0 - prm.z * 0.55);
    if (prm.z > 0.04 && h > 0.0) {
        float s = hash3(floor(d * 230.0));
        col += vec3(step(0.9975, s) * (s - 0.9975) * 300.0) * prm.z * smoothstep(0.0, 0.25, h);
    }
    if (prm.w > 0.5 && h > 0.015) {
        vec2 uv = d.xz / (h + 0.2) * 0.5 + vec2(prm.y * 0.0035, prm.y * 0.0014);
        float n = texture2D(cloudTex, uv).r * 0.64 + texture2D(cloudTex, uv * 3.3 + 0.37).g * 0.36;
        float th = 1.0 - prm.x * 0.78;
        float c = smoothstep(th - 0.06, th + 0.2, n) * smoothstep(0.015, 0.2, h);
        vec3 lit = mix(horizon * 0.85 + 0.15, vec3(1.0), 0.65) * (1.0 - prm.z * 0.88);
        float thick = smoothstep(th, th + 0.45, n);
        vec3 cc = mix(lit, lit * 0.62, thick) + sunCol * (pow(sd, 6.0) * 0.28) * (1.0 - thick * 0.6);
        col = mix(col, cc, c * 0.94);
    }
    gl_FragColor = vec4(col, 1.0);
}`;

/** Слои сланца каньона (тона). */
const WVIEW_STRATA = [[0.66, 0.36, 0.22], [0.8, 0.54, 0.34], [0.56, 0.3, 0.21], [0.84, 0.64, 0.44], [0.72, 0.42, 0.27]];

/** @satisfies {Record<string, any>} */
const WorldView = {
    /** @type {any} */ gw: null,
    /** @type {any} */ app: null,
    /** @type {any} */ view: null,
    /** @type {any} */ scene: null,
    biome: 'proving',
    /** @type {any} */ pal: null,
    /** @type {any[]} */ palArr: [],
    /** @type {any} */ atmo: null,
    frame: 0,
    time: 0,
    quality: 2,
    splitK: WVIEW_SPLIT,
    minLevel: 0,
    cloudQ: 1,
    ready: false,
    /** @type {any[]} */ meshes: [],
    /** @type {Map<string, any>} */ nodes: new Map(),
    /** @type {Map<string, boolean>} */ split: new Map(),
    /** @type {any[]} */ active: [],
    /** @type {any[]} */ wanted: [],
    /** @type {any} */ tex: null,
    /** @type {Record<string, any>} */ mats: {},
    /** @type {any} */ terrainMat: null,
    /** @type {any} */ plug: null,
    /** @type {any[]} */ plugs: [],
    /** Площадки, которые рисует шейдер рельефа. @type {any[]} */ gpuFlats: [],
    /** @type {any} */ sky: null,
    /** @type {any} */ skyMat: null,
    /** @type {any} */ probe: null,
    envTimer: 0,
    envKey: '',
    /** @type {any} */ water: null,
    /** @type {any} */ idx: null,
    /** @type {Float32Array} */ hs: new Float32Array((WVIEW_NODE_CELLS + 1) * (WVIEW_NODE_CELLS + 1)),
    /** @type {any} */ unsub: null,
    cam: { x: 0, y: 0, z: 0, fx: 1, fz: 0 },
    budget: 0,
    sync: false,
    full: false,
    /** @type {any} */ warm: null,
    /** Недостающие узлы кадра: { L, ix, iz, d }. @type {any[]} */ _need: [],
    /** Где камера была в прошлом кадре (рывок — см. WVIEW_JUMP). */
    last: { x: 0, y: 0, z: 0, ok: false },
    stat: { nodes: 0, tris: 0, created: 0, missing: 0 },
    /** Скретч макро-цвета: r, g, b, веса узора (скала, щебень, бетон, песок). */
    col: [0, 0, 0, 0, 0, 0, 0],
    /** @type {any} */ _Plugin: null,
    /** @type {any} */ _sun: null,
    /** @type {any} */ _u: null,

    cfg() {
        const U = 'undefined';
        return {
            tonemap: typeof WORLD_TONEMAP !== U ? WORLD_TONEMAP : 0,
            exposure: typeof WORLD_EXPOSURE !== U ? WORLD_EXPOSURE : 1.0,
        };
    },

    // ---------------------------------------------------------------------------------------------
    // Постройка
    // ---------------------------------------------------------------------------------------------

    /**
     * Меши мира для карты, данные которой уже в gw (GameWorld.buildData). Под экраном загрузки.
     * opts: { focus: { x, y, z } — где камера на старте (иначе старт трассы или начало первой дороги) }.
     * @param {any} app @param {any} gw @param {any} [opts]
     */
    async build(app, gw, opts) {
        this.dispose();
        const o = opts || {};
        this.app = app; this.gw = gw;
        const view = this.view = app.location.view;
        const scene = this.scene = view.scene;
        this.biome = gw.biome;
        this.pal = WVIEW_PALETTE[gw.biome] || WVIEW_PALETTE.proving;
        this.palArr = [this.pal.grass, this.pal.dirt, this.pal.rock, this.pal.sand, this.pal.snow, this.pal.concrete];
        this.time = 0; this.frame = 0;
        view.camera.minZ = WVIEW_NEAR;
        view.camera.maxZ = WVIEW_FAR;
        this._quality();
        this._atmosphere();
        this._textures();
        this._materials();
        await Promise.all(this.tex.pending);   // узоры земли и асфальт: под экраном загрузки, чтобы первый кадр не остался без рельефа
        this._warmShader();                    // шейдер рельефа собирается параллельно со сборкой узлов, дорог и декора
        this._buildSky();
        this._buildIndex();
        // старт камеры: переданная точка, трасса, первая дорога
        let f = o.focus;
        this.cam.fx = 0; this.cam.fz = 0;   // направление взгляда неизвестно: «позади» нет, строится круг
        if (!f && typeof ObbyCourse !== 'undefined' && ObbyCourse.stages && ObbyCourse.stages.length) { const s = ObbyCourse.respawn(0); f = { x: s.x, y: s.y, z: s.z }; this.cam.fx = Math.cos(s.yaw); this.cam.fz = Math.sin(s.yaw); }
        if (!f && gw.roads.length) f = { x: gw.roads[0].X[0], y: gw.roads[0].Y[0] + 300, z: gw.roads[0].Z[0] };
        if (!f) { const t = view.camera.position; f = { x: t.x, y: t.y, z: t.z }; }
        this._setCam(f.x, f.y == null ? 500 : f.y, f.z);
        this.last.ok = false;
        gw.warm(f.x, f.z, 30000);
        this._terrain(true, false);   // впереди и рядом — сразу; далеко позади — очередью в первых кадрах (грубый предок закрывает), загрузка короче
        await Promise.resolve();
        WorldRoads.build(this);
        WorldDecor.init(this);
        await WorldDecor.loadModels();
        WorldDecor.update(this.cam, true);
        if (this.warm) await this.warm;
        this._buildWater();
        this._buildProbe();
        if (typeof Quality !== 'undefined' && Quality.onChange) this.unsub = Quality.onChange(() => this._onQuality());
        this.ready = true;
        return this;
    },

    dispose() {
        if (this.unsub) { try { this.unsub(); } catch (e) { /* ok */ } this.unsub = null; }
        WorldDecor.dispose();
        WorldRoads.dispose();
        for (const rec of this.nodes.values()) { try { rec.mesh.dispose(false, false); } catch (e) { /* ok */ } }
        this.nodes.clear(); this.split.clear(); this.active = []; this.wanted = [];
        for (const m of this.meshes) { try { m.dispose(false, false); } catch (e) { /* ok */ } }
        this.meshes = [];
        if (this.probe) { try { this.probe.dispose(); } catch (e) { /* ok */ } this.probe = null; }
        if (this.gw) this.gw.envTexture = null;
        // текстуры живут в scene.__worldTex и служат всем картам; освобождаем только материалы карты
        for (const k in this.mats) { try { this.mats[k].dispose(false, false); } catch (e) { /* ok */ } }
        this.mats = {}; this.terrainMat = null; this.plug = null; this.plugs = []; this.gpuFlats = []; this.sky = null; this.skyMat = null; this.water = null;
        const W = /** @type {any} */ (World3D);
        this.atmo = null;
        if (W.__worldAtmo && this.view && this.view.scene) { try { World3D.setLighting({}, this.view); } catch (e) { /* ok */ } }
        this.ready = false; this.view = null; this.scene = null; this.app = null;
    },

    _setCam(x, y, z) { const c = this.cam; c.x = x; c.y = y; c.z = z; },

    // ---------------------------------------------------------------------------------------------
    // Качество
    // ---------------------------------------------------------------------------------------------

    _quality() {
        const q = typeof Quality !== 'undefined' ? Quality.level : 2;
        const mobile = typeof IS_MOBILE !== 'undefined' && IS_MOBILE;
        this.quality = q;
        this.splitK = mobile ? WVIEW_SPLIT_MOBILE * (q === 0 ? 0.9 : 1) : q === 0 ? WVIEW_SPLIT_LOW : WVIEW_SPLIT;
        this.minLevel = mobile || q === 0 ? WVIEW_MIN_LEVEL_MOBILE : 0;
        this.cloudQ = q >= 1 ? 1 : 0;
    },

    _onQuality() {
        this._quality();
        if (this.skyMat) this._skyUniforms(0, true);
        WorldDecor.requality();
        this.split.clear();
    },

    // ---------------------------------------------------------------------------------------------
    // Свет и небо по биому: «полдень» биома подменяет константы Sky3D (World3D.baseCfg), время суток и погода идут от них
    // ---------------------------------------------------------------------------------------------

    _atmosphere() {
        const gw = this.gw;
        const a = Object.assign({}, WVIEW_BIOME[gw.biome] || WVIEW_BIOME.proving);
        a.fog = a.fog * Math.max(0.05, gw.P.fog == null ? 1 : gw.P.fog);
        this.atmo = a;
        const W = /** @type {any} */ (World3D);
        if (!W.__worldAtmo) {
            const orig = World3D.baseCfg;
            W.__worldAtmo = true;
            World3D.baseCfg = function () {
                const c = orig.call(this);
                const at = WorldView.atmo;
                if (at) for (const k in at) if (k in c) c[k] = at[k];
                return c;
            };
        }
        // тени вокруг машины: кадр солнца ужимается по кастерам (View3D.fitShadowFrustum), предел — _shadowRadius
        if (this.view && this.view._shadowRadius < 1900 && !(typeof IS_MOBILE !== 'undefined' && IS_MOBILE)) this.view._shadowRadius = 1900;
        World3D.setLighting({}, this.view);
        if (typeof Sky3D !== 'undefined') {
            if (!Sky3D.view || Sky3D.view !== this.view) Sky3D.init(this.view, { hour: gw.hour, fx: this.app && this.app.fx });
            else Sky3D.setHour(gw.hour);
        }
        const ip = this.scene.imageProcessingConfiguration;
        const c = this.cfg();
        if (ip) {
            ip.toneMappingEnabled = c.tonemap > 0;
            if (c.tonemap > 0) ip.toneMappingType = BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES;
            ip.exposure = c.exposure;
        }
    },

    // ---------------------------------------------------------------------------------------------
    // Текстуры и материалы (текстуры живут в сцене — между картами не пересоздаются)
    // ---------------------------------------------------------------------------------------------

    /**
     * Текстуры мира живут в сцене (между картами не пересоздаются): узоры земли ground-a / ground-b (файлы, запас — шум кодом), дорожный асфальт,
     * покрытия кодом, облака. Файл не загрузился — остаётся запасной шум: сцена не падает (инвариант 6).
     */
    _textures() {
        const scene = this.scene;
        const hostTex = /** @type {any} */ (scene).__worldTex;
        if (hostTex) { this.tex = hostTex; return; }
        const mob = typeof IS_MOBILE !== 'undefined' && IS_MOBILE;
        const mk = (data, size, mip, aniso) => {
            const t = BABYLON.RawTexture.CreateRGBATexture(data, size, size, scene, mip !== false, false, BABYLON.Texture.TRILINEAR_SAMPLINGMODE);
            t.wrapU = t.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
            t.anisotropicFilteringLevel = aniso || (mob ? 1 : 6);
            return t;
        };
        const T = /** @type {any} */ ({});
        T.pending = [];
        /** @type {any[]} */ T.failed = [];
        // файл → текстура; не загрузился — запоминаем (сцена получит запасной шум), в консоль — одно предупреждение
        const file = (url, aniso) => {
            const tex = new BABYLON.Texture(url, scene, false, true, BABYLON.Texture.TRILINEAR_SAMPLINGMODE, null, () => { T.failed.push(url); if (T.onFail) T.onFail(url); });
            tex.wrapU = tex.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
            tex.anisotropicFilteringLevel = aniso;
            T.pending.push(new Promise((res) => { if (tex.isReady()) res(1); else tex.onLoadObservable.addOnce(() => res(1)); setTimeout(res, 6000); }));
            return tex;
        };
        // запасные и кодовые текстуры считаются при первом обращении: обычно файлы приходят, и сотни миллисекунд шума на загрузке не нужны
        const lazy = (key, make) => { let v = null; Object.defineProperty(T, key, { get() { return v || (v = make()); }, enumerable: true }); };
        lazy('fallbackA', () => mk(WorldTex.detail(mob ? 128 : 256, false), mob ? 128 : 256));
        lazy('concreteRoad', () => mk(WorldTex.surface('concrete', 256), 256));
        lazy('asphaltFallback', () => mk(WorldTex.surface('asphalt', 256), 256));
        T.groundA = file('assets/textures/ground-a.webp', mob ? 2 : 8);
        T.groundB = file('assets/textures/ground-b.webp', mob ? 2 : 8);
        T.asphalt = file('assets/textures/road-asphalt.webp', mob ? 2 : 8);
        const clouds = BABYLON.RawTexture.CreateRGBATexture(WorldTex.clouds(256), 256, 256, scene, true, false, BABYLON.Texture.BILINEAR_SAMPLINGMODE);
        clouds.wrapU = clouds.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
        T.clouds = clouds;
        const white = BABYLON.RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene, false, false, BABYLON.Texture.NEAREST_SAMPLINGMODE);
        white.wrapU = white.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
        T.white = white;
        /** @type {any} */ (scene).__worldTex = T;
        this.tex = T;
    },

    /**
     * Плагин рельефа: цвет вершин × узоры земли (ближний 7 м и мелкий 1.4 м по мировым координатам, на крутом — вторая проекция), выбор узора по
     * весам поверхности вершины (скала, щебень, бетон, песок; остальное — почва и трава), наклон нормали от узора (свет на камнях и щебне), крупные
     * пятна шумом; площадки (до WVIEW_FLATS_GPU) рисуются здесь же — чёткий край, ни наложения, ни z-fighting с лентами дорог.
     */
    _terrainPlugin() {
        if (WorldView._Plugin) return WorldView._Plugin;
        if (typeof BABYLON === 'undefined' || !BABYLON.MaterialPluginBase) return null;
        const N = WVIEW_FLATS_GPU;
        const names = (p) => Array.from({ length: N }, (_, i) => p + i);
        const colNames = ['worldCol0', 'worldCol1', 'worldCol2', 'worldCol3'];
        class WorldTerrainPlugin extends BABYLON.MaterialPluginBase {
            constructor(material) {
                super(material, 'WorldTerrain', 560, { WORLDTERRAIN: false, WORLDLITE: false, WORLDDERIV: false }, true, true);
                this.a = null; this.b = null;
                this.lite = false; this.deriv = true;
                this.info = [1 / WVIEW_TEXEL, 1 / WVIEW_TEXEL_MICRO, 0, 0];
                this.fa = new Float32Array(N * 4); this.fb = new Float32Array(N * 4); this.col = new Float32Array(4 * 4);
            }
            getClassName() { return 'WorldTerrainPlugin'; }
            setDetail(a, b) { this.a = a; this.b = b; this.markAllDefinesAsDirty(); }
            prepareDefines(defines) { defines.WORLDTERRAIN = !!(this.a && this.b); defines.WORLDLITE = this.lite; defines.WORLDDERIV = this.deriv; }
            isReadyForSubMesh() { return !(this.a && this.b) || (this.a.isReady() && this.b.isReady()); }
            hasTexture(texture) { return texture === this.a || texture === this.b; }
            getActiveTextures(list) { if (this.a) list.push(this.a); if (this.b) list.push(this.b); }
            getSamplers(samplers) { samplers.push('worldDetailA', 'worldDetailB'); }
            getAttributes(attributes) { attributes.push('wmix'); }
            getUniforms() {
                const all = ['worldDetailInfo'].concat(names('worldFlatA'), names('worldFlatB'), colNames);
                return {
                    ubo: all.map(n => ({ name: n, size: 4, type: 'vec4' })),
                    fragment: '#ifdef WORLDTERRAIN\n' + all.map(n => 'uniform vec4 ' + n + ';').join('\n') + '\n#endif'
                };
            }
            bindForSubMesh(ubo) {
                if (!(this.a && this.b)) return;
                const i = this.info, fa = this.fa, fb = this.fb, c = this.col;
                ubo.updateFloat4('worldDetailInfo', i[0], i[1], i[2], i[3]);
                for (let k = 0; k < N; k++) {
                    ubo.updateFloat4('worldFlatA' + k, fa[k * 4], fa[k * 4 + 1], fa[k * 4 + 2], fa[k * 4 + 3]);
                    ubo.updateFloat4('worldFlatB' + k, fb[k * 4], fb[k * 4 + 1], fb[k * 4 + 2], fb[k * 4 + 3]);
                }
                for (let k = 0; k < 4; k++) ubo.updateFloat4('worldCol' + k, c[k * 4], c[k * 4 + 1], c[k * 4 + 2], 1);
                ubo.setTexture('worldDetailA', this.a);
                ubo.setTexture('worldDetailB', this.b);
            }
            getCustomCode(shaderType) { return shaderType === 'fragment' ? WorldTerrainPlugin.FS : shaderType === 'vertex' ? WorldTerrainPlugin.VS : null; }
        }
        WorldTerrainPlugin.VS = {
            CUSTOM_VERTEX_DEFINITIONS: '#ifdef WORLDTERRAIN\nattribute vec4 wmix;\nvarying vec4 vWorldMix;\n#endif',
            CUSTOM_VERTEX_MAIN_END: '#ifdef WORLDTERRAIN\nvWorldMix = wmix;\n#endif'
        };
        const flatBlocks = names('').map((_, k) => 'if (worldDetailInfo.w > ' + (k + 0.5).toFixed(1) + ') WD_PLATE(worldFlatA' + k + ', worldFlatB' + k + ')').join('\n        ');
        WorldTerrainPlugin.FS = {
            CUSTOM_FRAGMENT_DEFINITIONS: `
#ifdef WORLDTERRAIN
uniform sampler2D worldDetailA;
uniform sampler2D worldDetailB;
varying vec4 vWorldMix;
float wdHash(vec2 p) { p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
float wdVNoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(wdHash(i), wdHash(i + vec2(1.0, 0.0)), f.x), mix(wdHash(i + vec2(0.0, 1.0)), wdHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// расстояние (px) до площадки: < 0 внутри; q — координаты в её осях (для швов плит)
float wdFlat(vec4 A, vec4 B, vec2 p, out vec2 q) {
    vec2 d = p - A.xy;
    q = vec2(d.x * B.x + d.y * B.y, -d.x * B.y + d.y * B.x);
    if (B.z > 0.0) return length(d) - B.z;
    vec2 e = abs(q) - A.zw;
    return length(max(e, 0.0)) + min(max(e.x, e.y), 0.0);
}
float wdAA(float v) {
#ifdef WORLDDERIV
    return max(fwidth(v), 0.5);
#else
    return 1.0;
#endif
}
vec3 wdPlateColor(float type, vec2 q, float dist, vec4 a1, vec4 b1, vec4 a3, vec4 b3, float kMicro, vec3 c0, vec3 c1, vec3 c2, vec3 c3) {
    if (type < 0.5) {
        vec2 sc = q / 500.0; vec2 id = floor(sc); vec2 f = abs(fract(sc) - 0.5);
        float je = (0.5 - max(f.x, f.y)) * 500.0;
        float joint = clamp(0.5 + (1.4 - je) / wdAA(je), 0.0, 1.0) * (1.0 - smoothstep(18000.0, 60000.0, dist));
        float slab = 0.965 + 0.07 * wdHash(id);
        return c0 * slab * (0.9 + 0.2 * b1.b) * (1.0 + (b3.b - 0.5) * 0.35 * kMicro) * (1.0 - 0.38 * joint);
    }
    if (type < 1.5) return c1 * (0.86 + 0.28 * b1.b) * (1.0 + (b3.b - 0.5) * 0.5 * kMicro + (a3.r - 0.5) * 0.35 * kMicro);
    if (type < 2.5) return c2 * (0.9 + 0.2 * a1.r) * (1.0 + (b3.r - 0.5) * 1.3 * kMicro + (b1.r - 0.5) * 0.5);
    return c3 * (0.9 + 0.2 * a1.r) * (1.0 + (a3.r - 0.5) * 0.7 * kMicro + (b3.r - 0.5) * 0.35 * kMicro);
}
#define WD_PLATE(A, B) { vec2 q; float sd = wdFlat(A, B, wdP, q); float m = clamp(0.5 - sd / wdAA(sd), 0.0, 1.0); if (m > wdPM) { wdPM = m; wdPB = B.w; wdPQ = q; wdPS = sd; } }
#endif
`,
            CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `
#ifdef WORLDTERRAIN
{
    vec3 wdPos = vPositionW;
    vec2 wdP = wdPos.xz;
    float wdDist = length(wdPos - vEyePosition.xyz);
    vec3 wdNrm = normalize(vNormalW);
    float wdSteep = smoothstep(0.42, 0.78, 1.0 - wdNrm.y);
    float kNear = 1.0 - smoothstep(22000.0, 80000.0, wdDist);
    float kMicro = 1.0 - smoothstep(2500.0, 12000.0, wdDist);
    vec2 uvN = wdP * worldDetailInfo.x;
    vec4 a1 = texture2D(worldDetailA, uvN);
    vec4 b1 = texture2D(worldDetailB, uvN);
    vec4 a3 = vec4(0.5);
    vec4 b3 = vec4(0.5);
#ifndef WORLDLITE
    vec2 uvS = (abs(wdNrm.x) > abs(wdNrm.z) ? wdPos.zy : wdPos.xy) * worldDetailInfo.x;
    a1 = mix(a1, texture2D(worldDetailA, uvS), wdSteep);
    b1 = mix(b1, texture2D(worldDetailB, uvS), wdSteep);
    vec2 uvM = wdP * worldDetailInfo.y;
    a3 = texture2D(worldDetailA, uvM);
    b3 = texture2D(worldDetailB, uvM);
#endif
    vec4 W = vWorldMix;
    W.x = max(W.x, wdSteep);
    float wSoil = clamp(1.0 - W.x - W.y - W.z - W.w, 0.0, 1.0);
    float green = clamp((baseColor.g - baseColor.r) * 5.0, 0.0, 1.0);
    float pN = wSoil * mix(a1.r, a1.g, green) + W.x * a1.b + W.y * b1.r + W.z * b1.b + W.w * b1.g;
    float pM = wSoil * mix(a3.r, a3.g, green) + W.x * a3.b + W.y * b3.r + W.z * b3.b + W.w * b3.g;
    float cN = wSoil * 0.95 + W.x * 0.65 + W.y * 0.9 + W.z * 0.7 + W.w * 0.6;
    float cM = wSoil * 0.8 + W.x * 0.7 + W.y * 1.0 + W.z * 0.55 + W.w * 0.5;
    float tone = 1.0 + (pN - 0.5) * 1.2 * cN * kNear + (pM - 0.5) * 0.7 * cM * kMicro;
    // крупные пятна: на крутом склоне — по боковой проекции (иначе вертикальные полосы)
    vec2 wdM = wdP;
#ifndef WORLDLITE
    wdM = mix(wdP, (abs(wdNrm.x) > abs(wdNrm.z) ? wdPos.zy : wdPos.xy), wdSteep);
#endif
    float wdMacro = wdVNoise(wdM * 0.00012) * 0.55 + wdVNoise(wdM * 0.00055 + 7.3) * 0.3 + wdVNoise(wdM * 0.0024 + 3.1) * 0.15;
    tone *= 0.86 + 0.3 * wdMacro;
    float wdLum = dot(baseColor.rgb, vec3(0.3333));
    float wdSnow = smoothstep(0.78, 0.9, wdLum) * (1.0 - smoothstep(0.1, 0.2, max(baseColor.r, max(baseColor.g, baseColor.b)) - min(baseColor.r, min(baseColor.g, baseColor.b))));
    tone = mix(tone, 1.0 + (b1.b - 0.5) * 0.18 * kNear, wdSnow);
    baseColor.rgb *= clamp(tone, 0.55, 1.5);
    float wdHw = abs(vDiffuseUV.y);
    if (wdHw > 100.0) {
        // лента грунтовки или гравийки: uv.x — смещение от оси, |uv.y| — полуширина (плюс — грунт, минус — гравий). Колеи на 0.9 м от оси полосы
        float wdLat = abs(vDiffuseUV.x);
        float wdD = abs(wdLat - wdHw * 0.5);
        float wdRut = exp(-pow((wdD - 90.0) / (40.0 + 16.0 * wdVNoise(wdP * 0.004)), 2.0)) * smoothstep(0.2, 0.8, wdVNoise(wdP * 0.0017 + 11.0));
        float wdCrown = exp(-pow(wdD / 60.0, 2.0));
        float wdIn = 1.0 - smoothstep(0.78 * wdHw, 0.98 * wdHw, wdLat);
        baseColor.rgb *= 1.0 - (vDiffuseUV.y > 0.0 ? 0.17 : 0.1) * wdRut * wdIn * (0.55 + 0.45 * kNear) + 0.07 * wdCrown * wdIn;
    }
    float wdPM = 0.0; float wdPB = 0.0; float wdPS = 0.0; vec2 wdPQ = vec2(0.0);
    if (worldDetailInfo.w > 0.5) {
        ${flatBlocks}
        if (wdPM > 0.0) {
            vec3 pc = wdPlateColor(wdPB, wdPQ, wdDist, a1, b1, a3, b3, kMicro, worldCol0.rgb, worldCol1.rgb, worldCol2.rgb, worldCol3.rgb);
            pc *= 1.0 - 0.16 * (1.0 - smoothstep(0.0, max(30.0, wdAA(wdPS) * 2.0), -wdPS));
            baseColor.rgb = mix(baseColor.rgb, pc, wdPM);
        }
    }
#if defined(WORLDDERIV) && !defined(WORLDLITE)
    float wdH = ((pM - 0.5) * cM * kMicro + (pN - 0.5) * cN * kNear * 0.6) * 5.0 * (1.0 - wdPM);
    vec3 wdDpx = dFdx(wdPos); vec3 wdDpy = dFdy(wdPos);
    vec3 wdR1 = cross(wdDpy, normalW); vec3 wdR2 = cross(normalW, wdDpx);
    float wdDet = dot(wdDpx, wdR1);
    vec3 wdGrad = sign(wdDet) * (dFdx(wdH) * wdR1 + dFdy(wdH) * wdR2);
    normalW = normalize(abs(wdDet) * normalW - wdGrad * 0.9);
#endif
}
#endif
`
        };
        WorldView._Plugin = WorldTerrainPlugin;
        return WorldTerrainPlugin;
    },

    /** Материал рельефа: цвет — вершины, узор — плагин. */
    _materials() {
        const scene = this.scene, T = this.tex;
        const m = new BABYLON.StandardMaterial('world-terrain', scene);
        m.diffuseColor = new BABYLON.Color3(1, 1, 1);
        m.specularColor = new BABYLON.Color3(0, 0, 0);
        m.diffuseTexture = T.white;
        m.backFaceCulling = true;
        const Plugin = this._terrainPlugin();
        if (Plugin) {
            const p = new Plugin(m);
            p.deriv = scene.getEngine().webGLVersion >= 2;
            p.lite = typeof IS_MOBILE !== 'undefined' && IS_MOBILE;
            p.setDetail(T.groundA, T.groundB);
            this.plug = p;
            this._flatsGpu(p);
            // файл не пришёл — запасной рисунок (сцена не падает)
            T.onFail = (u) => this._texFailed(u);
            for (const u of T.failed) this._texFailed(u);
        }
        this.mats.terrain = m;
        this.terrainMat = m;
    },

    /** Запустить сборку шейдера рельефа сразу (ждём её в конце build): иначе она идёт после всей постройки и держит экран загрузки. */
    _warmShader() {
        this.warm = null;
        try {
            const m = new BABYLON.Mesh('world-warm', this.scene);
            const vd = new BABYLON.VertexData();
            vd.positions = [0, 0, 0, 1, 0, 0, 0, 0, 1]; vd.normals = [0, 1, 0, 0, 1, 0, 0, 1, 0]; vd.colors = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]; vd.uvs = [0, 0, 1, 0, 0, 1]; vd.indices = [0, 1, 2];
            vd.applyToMesh(m);
            m.setVerticesData('wmix', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], false, 4);
            m.receiveShadows = true; m.isPickable = false; m.setEnabled(false);
            m.material = this.terrainMat;
            const done = () => { try { m.dispose(false, false); } catch (e) { /* ok */ } };
            this.warm = this.terrainMat.forceCompilationAsync(m).then(done, done);
        } catch (e) { this.warm = null; }
    },

    /** Материал «как рельеф» (узор земли, площадки) для лент дорог: z — сдвиг глубины, чтобы лента лежала над землёй без борьбы за пиксель. */
    _terrainMaterial(name, z) {
        const scene = this.scene, T = this.tex, src = this.plug;
        const m = new BABYLON.StandardMaterial(name, scene);
        m.diffuseColor = new BABYLON.Color3(1, 1, 1);
        m.specularColor = new BABYLON.Color3(0, 0, 0);
        m.diffuseTexture = T.white;
        m.backFaceCulling = false;
        m.zOffset = z; m.zOffsetUnits = z;
        const Plugin = this._terrainPlugin();
        if (Plugin && src) {
            const p = new Plugin(m);
            p.deriv = src.deriv; p.lite = src.lite; p.info = src.info; p.fa = src.fa; p.fb = src.fb; p.col = src.col;
            p.setDetail(src.a, src.b);
            (this.plugs || (this.plugs = [])).push(p);
        }
        return m;
    },

    /** Файл текстуры не пришёл (404): запасные текстуры вместо него, в консоль — одно предупреждение. */
    _texFailed(url) {
        const T = this.tex;
        console.warn('GameWorldView: текстура ' + url + ' не загрузилась — запасной рисунок');
        if (/ground-[ab]/.test(url)) { for (const p of [this.plug].concat(this.plugs || [])) if (p) p.setDetail(T.fallbackA, T.fallbackA); }
        else if (/road-asphalt/.test(url)) { for (const k in WorldRoads.mats) if (/^asphalt/.test(k)) WorldRoads.mats[k].diffuseTexture = T.asphaltFallback; }
    },

    /** Площадки для шейдера рельефа: чётко, без отдельных плит. Какие из них нарисованы здесь — gpuFlats (остальные рисует WorldRoads). */
    _flatsGpu(p) {
        const gw = this.gw, TYPE = /** @type {Record<string, number>} */ ({ concrete: 0, asphalt: 1, gravel: 2, dirt: 3 });
        this.gpuFlats = [];
        const area = (f) => f.r > 0 ? Math.PI * f.r * f.r : 4 * f.hw * f.hd;
        const list = gw.flats.filter(f => TYPE[f.surf] != null).sort((a, b) => area(b) - area(a));
        for (let k = 0; k < Math.min(WVIEW_FLATS_GPU, list.length); k++) {
            const f = list[k];
            p.fa[k * 4] = f.x; p.fa[k * 4 + 1] = f.z; p.fa[k * 4 + 2] = f.hw; p.fa[k * 4 + 3] = f.hd;
            p.fb[k * 4] = f.cos; p.fb[k * 4 + 1] = f.sin; p.fb[k * 4 + 2] = f.r > 0 ? f.r : 0; p.fb[k * 4 + 3] = TYPE[f.surf];
            this.gpuFlats.push(f);
        }
        p.info[3] = this.gpuFlats.length;
        const dirt = this.pal.dirt;
        const set = (i, r, g, b) => { p.col[i * 4] = r; p.col[i * 4 + 1] = g; p.col[i * 4 + 2] = b; };
        set(0, 0.66, 0.65, 0.62);                                                                  // бетон
        set(1, WVIEW_ASPHALT[0], WVIEW_ASPHALT[1], WVIEW_ASPHALT[2]);                              // асфальт: как лента дороги
        set(2, 0.58, 0.54, 0.48);                                                                  // гравий
        set(3, (dirt[0][0] + dirt[1][0]) * 0.525, (dirt[0][1] + dirt[1][1]) * 0.525, (dirt[0][2] + dirt[1][2]) * 0.525);   // грунт: тон земли биома
    },

    // ---------------------------------------------------------------------------------------------
    // Небо: купол с градиентом, солнцем, облаками и звёздами; цвета — от света сцены (Sky3D)
    // ---------------------------------------------------------------------------------------------

    _buildSky() {
        const scene = this.scene;
        BABYLON.Effect.ShadersStore['worldSkyVertexShader'] = WVIEW_SKY_VS;
        BABYLON.Effect.ShadersStore['worldSkyFragmentShader'] = WVIEW_SKY_FS;
        const mat = new BABYLON.ShaderMaterial('world-sky', scene, { vertex: 'worldSky', fragment: 'worldSky' }, {
            attributes: ['position'], uniforms: ['view', 'projection', 'horizon', 'zenith', 'groundCol', 'sunDir', 'sunCol', 'prm'], samplers: ['cloudTex'],
        });
        mat.backFaceCulling = false;
        mat.disableDepthWrite = true;
        mat.fogEnabled = false;
        mat.setTexture('cloudTex', this.tex.clouds);
        const dome = BABYLON.MeshBuilder.CreateSphere('world-sky', { diameter: 2000, segments: 16 }, scene);
        dome.material = mat;
        dome.isPickable = false;
        dome.alwaysSelectAsActiveMesh = true;
        dome.renderingGroupId = 0;
        dome.freezeWorldMatrix();
        dome.doNotSyncBoundingInfo = true;
        this.sky = dome; this.skyMat = mat;
        this.mats.sky = mat;
        this.meshes.push(dome);
        this._skyUniforms(0, true);
    },

    _skyUniforms(dt, force) {
        const mat = this.skyMat, scene = this.scene, view = this.view;
        if (!mat || !scene || !view) return;
        const fog = scene.fogColor, sun = view.sun;
        const day = typeof Sky3D !== 'undefined' && Sky3D.view ? Sky3D.daylight : 1;
        const hr = fog.r, hg = fog.g, hb = fog.b;
        const blue = 0.25 + 0.75 * day;
        const zr = hr * 0.34 + 0.07 * blue, zg = hg * 0.34 + 0.19 * blue, zb = hb * 0.38 + 0.46 * blue;
        const dir = sun.direction, ln = Math.hypot(dir.x, dir.y, dir.z) || 1;
        const sx = -dir.x / ln, sy = -dir.y / ln, sz = -dir.z / ln;
        const si = Math.max(0, Math.min(1.5, sun.intensity));
        const sc = sun.diffuse;
        let cover = this.atmo ? this.atmo.cloud : 0.4;
        if (typeof Sky3D !== 'undefined' && Sky3D.view) {
            const wid = Sky3D.weatherId;
            cover = wid === 'clear' ? cover : wid === 'cloudy' ? 0.82 : wid === 'fog' ? 0.9 : wid === 'rain' ? 0.95 : wid === 'storm' ? 1 : wid === 'snow' ? 0.88 : cover;
        }
        if (this.gw && this.gw.P.clouds != null) cover = Math.min(1, cover * this.gw.P.clouds);
        this.time += dt;
        const U = this._u || (this._u = { zenith: new BABYLON.Vector3(), ground: new BABYLON.Vector3(), dir: new BABYLON.Vector3(), sun: new BABYLON.Vector3(), prm: new BABYLON.Vector4(0, 0, 0, 0) });
        mat.setColor3('horizon', fog);
        mat.setVector3('zenith', U.zenith.set(zr, zg, zb));
        mat.setVector3('groundCol', U.ground.set(hr * 0.62, hg * 0.6, hb * 0.55));
        mat.setVector3('sunDir', U.dir.set(sx, sy, sz));
        mat.setVector3('sunCol', U.sun.set(sc.r * si * 0.9, sc.g * si * 0.9, sc.b * si * 0.9));
        mat.setVector4('prm', U.prm.set(cover, this.time, 1 - day, this.cloudQ > 0 ? 1 : 0));
        // отражения для машин: перерисовать, когда небо заметно изменилось
        if (this.probe) {
            const key = [hr, hg, hb, sx, sy, sz, cover].map(v => Math.round(v * 24)).join(',');
            if (force || (key !== this.envKey && this.envTimer <= 0)) {
                this.envKey = key; this.envTimer = 1.2;
                this.probe.refreshRate = BABYLON.RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
            }
        }
        this.envTimer -= dt;
        this._sun = { x: sx, y: sy, z: sz };
    },

    /** Кубическая карта неба для отражений машин: GameWorld.envTexture. Рисуется один раз и при смене неба. */
    _buildProbe() {
        if (!this.scene || !this.sky) return;
        try {
            const probe = new BABYLON.ReflectionProbe('world-env', 64, this.scene, true);
            probe.renderList.push(this.sky);
            probe.refreshRate = BABYLON.RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
            this.probe = probe;
            this.gw.envTexture = probe.cubeTexture;
        } catch (e) {
            console.warn('GameWorld: карта отражений не создана — ' + ((e && e.message) || e));
        }
    },

    _buildWater() {
        const gw = this.gw;
        if (!(gw.sea >= 0)) return;
        const scene = this.scene;
        const m = new BABYLON.StandardMaterial('world-water', scene);
        m.diffuseColor = new BABYLON.Color3(0.1, 0.27, 0.34);
        m.specularColor = new BABYLON.Color3(0.9, 0.95, 1);
        m.specularPower = 120;
        m.alpha = 0.86;
        m.backFaceCulling = false;
        this.mats.water = m;
        const g = BABYLON.MeshBuilder.CreateGround('world-water', { width: 400000, height: 400000, subdivisions: 1 }, scene);
        g.material = m;
        g.position.y = gw.sea;
        g.isPickable = false;
        g.alwaysSelectAsActiveMesh = true;
        g.receiveShadows = false;
        this.water = g; this.meshes.push(g);
    },

    // ---------------------------------------------------------------------------------------------
    // Рельеф: квадродерево узлов 17×17 вершин на каждом уровне (шаг 2 м × 2^L)
    // ---------------------------------------------------------------------------------------------

    _size(L) { return this.gw.cell * (1 << L) * WVIEW_NODE_CELLS; },
    _key(L, ix, iz) { return L + ':' + ix + ':' + iz; },

    /** Индексы узла (общие для всех): сетка с диагональю по чётности (как в физике) и юбки по четырём краям. */
    _buildIndex() {
        const n = WVIEW_NODE_CELLS, N = n + 1, nv = N * N;
        /** @type {number[]} */ const idx = [];
        const P = (i) => {
            if (i < nv) return [i % N, 0, Math.floor(i / N)];
            const e = i - nv, side = Math.floor(e / N), t = e % N;
            return side === 0 ? [t, -1, 0] : side === 1 ? [t, -1, n] : side === 2 ? [0, -1, t] : [n, -1, t];
        };
        const push = (a, b, c, up) => {   // up — желаемая нормаль грани; обход по соглашению Babylon: (p1 − p2) × (p3 − p2)
            const pa = P(a), pb = P(b), pc = P(c);
            const e1 = [pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]], e2 = [pc[0] - pb[0], pc[1] - pb[1], pc[2] - pb[2]];
            const g = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
            if (g[0] * up[0] + g[1] * up[1] + g[2] * up[2] < 0) idx.push(a, c, b); else idx.push(a, b, c);
        };
        for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
            const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
            if (((i + j) & 1) === 0) { push(a, b, d, [0, 1, 0]); push(a, d, c, [0, 1, 0]); }
            else { push(a, b, c, [0, 1, 0]); push(b, d, c, [0, 1, 0]); }
        }
        // юбки: сторона 0 — z = 0 (наружу −z), 1 — z = n (+z), 2 — x = 0 (−x), 3 — x = n (+x)
        for (let side = 0; side < 4; side++) for (let t = 0; t < n; t++) {
            let e0, e1;
            if (side === 0) { e0 = t; e1 = t + 1; } else if (side === 1) { e0 = n * N + t; e1 = n * N + t + 1; } else if (side === 2) { e0 = t * N; e1 = (t + 1) * N; } else { e0 = t * N + n; e1 = (t + 1) * N + n; }
            const s0 = nv + side * N + t, s1 = s0 + 1;
            const out = side === 0 ? [0, 0, -1] : side === 1 ? [0, 0, 1] : side === 2 ? [-1, 0, 0] : [1, 0, 0];
            push(e0, e1, s1, out); push(e0, s1, s0, out);
        }
        this.idx = new Uint16Array(idx);
    },

    /**
     * Высота вершины узла уровня 1 и выше. У дорог и площадок — минимум по окрестности: рельеф не поднимается над лентой (грубый треугольник
     * режет угол откоса выемки). С насыпи (земля ниже дороги) не занижаем: щель у кромки закрывает «фартук» ленты (WorldRoads._apron), а
     * занижение дало бы уступ под дорогой.
     */
    _lodHeight(x, z, step) {
        const gw = this.gw;
        if ((gw.roads.length || gw.flats.length) && gw.edgeDistFar(x, z) < step * 1.2 + 260) {
            const h0 = gw.heightAt(x, z);
            let h = h0;
            const s = step * 0.5;
            for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const v = gw.heightAt(x + a * s, z + b * s); if (v < h) h = v; }
            if (h < h0 && gw.roads.length) {
                const q = gw.roadAt(x, z, h0);
                if (q) {
                    const R = q.road, lc = q.lat < -q.hw ? -q.hw : q.lat > q.hw ? q.hw : q.lat;
                    const plane = q.y - Math.tan(R.BK[q.seg] * (1 - q.u) + R.BK[q.seg + 1] * q.u) * lc;
                    if (h0 < plane - 30) return h0;
                }
            }
            return h;
        }
        return gw.heightFar(x, z);
    },

    _createNode(L, ix, iz) {
        const gw = this.gw, C = gw.cell, step = C * (1 << L), n = WVIEW_NODE_CELLS, N = n + 1, nv = N * N, size = step * n;
        const x0 = ix * size, z0 = iz * size, cx = x0 + size / 2, cz = z0 + size / 2;
        const total = nv + 4 * N;
        const hasRoad = gw.roads.length > 0 || gw.flats.length > 0;
        const pos = new Float32Array(total * 3), nrm = new Float32Array(total * 3), col = new Float32Array(total * 4), uv = new Float32Array(total * 2), wmx = new Float32Array(total * 4);
        const hs = this.hs;
        let ymin = Infinity, ymax = -Infinity;
        for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
            const x = x0 + i * step, z = z0 + j * step;
            let h = L === 0 ? gw.heightAt(x, z) : this._lodHeight(x, z, step);
            if (hasRoad && (L === 0 ? gw.edgeDist(x, z) : gw.edgeDistFar(x, z)) <= 0) h -= WVIEW_ROAD_SINK;   // под лентой: рельеф чуть ниже, ленту не прорезает
            hs[j * N + i] = h;
            if (h < ymin) ymin = h;
            if (h > ymax) ymax = h;
        }
        const skirt = Math.max(60, step * WVIEW_SKIRT);
        const c = this.col;
        for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
            const x = x0 + i * step, z = z0 + j * step, k = j * N + i;
            const far = L >= 2;
            const hl = i > 0 ? hs[k - 1] : far ? gw.heightFar(x - step, z) : gw.heightAt(x - step, z), hr = i < n ? hs[k + 1] : far ? gw.heightFar(x + step, z) : gw.heightAt(x + step, z);
            const hu = j > 0 ? hs[k - N] : far ? gw.heightFar(x, z - step) : gw.heightAt(x, z - step), hd = j < n ? hs[k + N] : far ? gw.heightFar(x, z + step) : gw.heightAt(x, z + step);
            let nx = (hl - hr) / (2 * step), nz = (hu - hd) / (2 * step);
            const l = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
            nx *= l; nz *= l;
            const h = hs[k];
            pos[k * 3] = x - cx; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z - cz;
            nrm[k * 3] = nx; nrm[k * 3 + 1] = l; nrm[k * 3 + 2] = nz;
            this._macro(x, z, h, l, far ? gw.edgeDistFar(x, z) : gw.edgeDist(x, z), c);
            col[k * 4] = c[0]; col[k * 4 + 1] = c[1]; col[k * 4 + 2] = c[2]; col[k * 4 + 3] = 1;
            wmx[k * 4] = c[3]; wmx[k * 4 + 1] = c[4]; wmx[k * 4 + 2] = c[5]; wmx[k * 4 + 3] = c[6];
        }
        // юбки: копии краевых вершин ниже
        for (let side = 0; side < 4; side++) for (let t = 0; t < N; t++) {
            const e = side === 0 ? t : side === 1 ? n * N + t : side === 2 ? t * N : t * N + n;
            const k = nv + side * N + t;
            pos[k * 3] = pos[e * 3]; pos[k * 3 + 1] = pos[e * 3 + 1] - skirt; pos[k * 3 + 2] = pos[e * 3 + 2];
            nrm[k * 3] = nrm[e * 3]; nrm[k * 3 + 1] = nrm[e * 3 + 1]; nrm[k * 3 + 2] = nrm[e * 3 + 2];
            for (let q = 0; q < 4; q++) { col[k * 4 + q] = col[e * 4 + q]; wmx[k * 4 + q] = wmx[e * 4 + q]; }
        }
        const mesh = new BABYLON.Mesh('world-t' + L, this.scene);
        const vd = new BABYLON.VertexData();
        vd.positions = pos; vd.normals = nrm; vd.colors = col; vd.uvs = uv; vd.indices = this.idx;
        vd.applyToMesh(mesh, false);
        mesh.setVerticesData('wmix', wmx, false, 4);
        mesh.position.set(cx, 0, cz);
        mesh.material = this.terrainMat;
        mesh.receiveShadows = true;
        mesh.isPickable = false;
        mesh.freezeWorldMatrix();
        mesh.doNotSyncBoundingInfo = true;
        mesh.setEnabled(false);   // рисуется только то, что выбрало квадродерево этого кадра (_terrain включает), иначе узел накладывается на соседние уровни
        const rec = { L, ix, iz, mesh, ym: (ymin + ymax) / 2, frame: this.frame, key: this._key(L, ix, iz) };
        this.nodes.set(rec.key, rec);
        this.stat.created++;
        return rec;
    },

    /**
     * Макро-цвет земли в точке (по биому): веса поверхностей из GameWorld.groundWeights × палитра × пятна, пыль у дорог.
     * out: r, g, b, веса узора земли [скала, щебень, бетон, песок] (шейдер рельефа выбирает по ним рисунок детали).
     */
    _macro(x, z, h, ny, rd, out) {
        const gw = this.gw, w = gw.groundWeights(x, z, h, ny), seed = gw.seed | 0, mx = x * 0.01, mz = z * 0.01;
        const t1 = worldFbm(mx / 190, mz / 190, 2, seed + 301) * 0.5 + 0.5, t2 = worldFbm(mx / 37, mz / 37, 2, seed + 302) * 0.5 + 0.5;
        const k = Math.max(0, Math.min(1, (t1 * 0.62 + t2 * 0.38 - 0.5) * 2.1 + 0.5));
        let r = 0, g = 0, b = 0;
        const arr = this.palArr;
        const biome = this.biome;
        for (let i = 0; i < 6; i++) {
            const wt = w[i];
            if (wt < 0.002) continue;
            const p = arr[i];
            let a0 = p[0], a1 = p[1];
            if (i === 0 && biome === 'highway') {
                const pc = gw.parcel(x, z);
                if (pc.kind === 1) { a0 = [0.36, 0.5, 0.2]; a1 = [0.46, 0.57, 0.25]; }
                else if (pc.kind === 3) { a0 = [0.62, 0.52, 0.24]; a1 = [0.76, 0.66, 0.32]; }
                if (pc.edge < 160) { a0 = [0.15, 0.27, 0.1]; a1 = [0.2, 0.33, 0.12]; }
            }
            let kr = k;
            if (i === 2 && biome === 'canyon') {
                const sk = h / Math.max(1, gw.relief / 11), si = Math.floor(sk);
                const s0 = WVIEW_STRATA[((si % 5) + 5) % 5], s1 = WVIEW_STRATA[(((si + 1) % 5) + 5) % 5];
                const f = Math.min(1, Math.max(0, (sk - si - 0.85) / 0.15));
                a0 = [s0[0] * 0.8, s0[1] * 0.8, s0[2] * 0.8]; a1 = [s0[0] + (s1[0] - s0[0]) * f, s0[1] + (s1[1] - s0[1]) * f, s0[2] + (s1[2] - s0[2]) * f];
                kr = t2;
            }
            r += wt * (a0[0] + (a1[0] - a0[0]) * kr); g += wt * (a0[1] + (a1[1] - a0[1]) * kr); b += wt * (a0[2] + (a1[2] - a0[2]) * kr);
        }
        // лес темнит подстилку
        if (biome === 'alpine' || biome === 'highway') {
            const f = gw.forestMask(x, z) * w[0] * 0.38;
            r += (0.12 - r) * f; g += (0.2 - g) * f; b += (0.09 - b) * f;
        }
        // пыль и гравий у кромки дороги
        if (rd < 560) {
            const v = this.pal.verge, a = (1 - Math.min(1, rd / 560)) * 0.42;
            r += (v[0] - r) * a; g += (v[1] - g) * a; b += (v[2] - b) * a;
        }
        const br = 0.88 + 0.22 * t2;
        out[0] = r * br; out[1] = g * br; out[2] = b * br;
        // веса узора для шейдера: скала, щебень (в грунте немного), бетон, песок; остальное — почва и трава
        out[3] = w[2]; out[4] = w[1] * 0.25; out[5] = w[5]; out[6] = w[3];
        return out;
    },

    /**
     * Какие узлы рисовать сейчас: квадродерево по расстоянию до камеры. ГАРАНТИЯ СПЛОШНОСТИ: верхний уровень (L5, 1 км) строится всегда и сразу,
     * а любой узел, которого ещё нет, заменяется ближайшим построенным предком — рельеф без дыр на любом кадре. Недостающие узлы строятся
     * по очереди от ближних к дальним (WVIEW_BUILD_PER_FRAME в кадр), а при sync (загрузка, рывок камеры) — все сразу, в этом же кадре.
     */
    _terrain(sync, full) {
        const cam = this.cam, S = this._size(WVIEW_LEVELS - 1), far = WVIEW_FAR * 1.04;
        const out = this.wanted, need = this._need;
        out.length = 0; need.length = 0;
        this.sync = !!sync;
        this.full = !!full;
        this.budget = full ? 1e9 : WVIEW_BUILD_PER_FRAME;
        const i0 = Math.floor((cam.x - far) / S), i1 = Math.floor((cam.x + far) / S), j0 = Math.floor((cam.z - far) / S), j1 = Math.floor((cam.z + far) / S);
        for (let ix = i0; ix <= i1; ix++) for (let iz = j0; iz <= j1; iz++) this._visit(WVIEW_LEVELS - 1, ix, iz, out);
        // недостающие узлы: ближние первыми (при равном расстоянии — крупные: они держат покрытие)
        if (need.length) {
            need.sort((a, b) => a.d - b.d || b.L - a.L);
            const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
            for (const q of need) {
                if (this.budget <= 0) break;
                if (t0 && !full && performance.now() - t0 > WVIEW_BUILD_MS) break;
                if (this.nodes.has(this._key(q.L, q.ix, q.iz))) continue;
                this.budget--;
                this._createNode(q.L, q.ix, q.iz);
            }
        }
        const f = ++this.frame;
        for (const rec of out) {
            rec.frame = f;
            if (!rec.mesh.isEnabled()) rec.mesh.setEnabled(true);
        }
        const prev = this.active;
        for (const rec of prev) if (rec.frame !== f && rec.mesh.isEnabled()) rec.mesh.setEnabled(false);
        this.active = out; this.wanted = prev; prev.length = 0;   // два массива по очереди: без выделений в кадре
        this.stat.nodes = out.length; this.stat.tris = out.length * (this.idx.length / 3); this.stat.missing = need.length;
        if (this.nodes.size > WVIEW_NODES_MAX) this._evict();
        if (this.split.size > 8000) this.split.clear();
    },

    /**
     * Узел (L, ix, iz): true — поддерево нарисовано (в out), false — нечем покрыть (узла нет, и бюджет кончился): родитель рисует себя.
     * Верхний уровень не отказывает никогда.
     */
    _visit(L, ix, iz, out) {
        const cam = this.cam, size = this._size(L), x0 = ix * size, z0 = iz * size, key = this._key(L, ix, iz), top = L === WVIEW_LEVELS - 1;
        let rec = this.nodes.get(key);
        const dx = Math.max(x0 - cam.x, 0, cam.x - (x0 + size)), dz = Math.max(z0 - cam.z, 0, cam.z - (z0 + size));
        if (Math.hypot(dx, dz) > WVIEW_FAR * 1.04) return true;
        if (!rec && top) rec = this._createNode(L, ix, iz);   // основа: без неё нечем закрыть дыру
        const ym = rec ? rec.ym : this.gw.heightFar(x0 + size / 2, z0 + size / 2);
        const dy = Math.max(0, Math.abs(cam.y - ym) - size * 0.2);
        const d = Math.sqrt(dx * dx + dz * dz + dy * dy);
        const was = this.split.get(key) === true;
        const want = L > this.minLevel && d < size * this.splitK * (was ? 1.1 : 1);
        this.split.set(key, want);
        const mark = out.length;
        if (want) {
            let ok = true;
            for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) if (!this._visit(L - 1, ix * 2 + a, iz * 2 + b, out)) ok = false;
            if (ok) return true;
            out.length = mark;
        }
        if (!rec) {
            // позади камеры строим позже, чем перед ней
            const mx = x0 + size / 2 - cam.x, mz = z0 + size / 2 - cam.z, dist = Math.hypot(mx, mz) || 1;
            const back = (mx * cam.fx + mz * cam.fz) / dist < -0.25 && dist > size ? 2.5 : 1;
            this._need.push({ L, ix, iz, d: d * back });
            // рывок камеры: сразу строится то, что впереди и рядом; далеко позади — очередью (грубый предок закрывает), загрузка строит всё
            if (!this.sync || (!this.full && back > 1 && d > WVIEW_BACK_NEAR)) return false;
            rec = this._createNode(L, ix, iz);
            this._need.pop();
        }
        out.push(rec);
        return true;
    },

    _evict() {
        const f = this.frame, list = [], top = WVIEW_LEVELS - 1;
        // сначала то, что не нужно уже давно; если памяти всё равно много (рывки камеры) — всё, что не в кадре этого цикла
        const age = this.nodes.size > WVIEW_NODES_MAX * 2.2 ? 30 : 240;
        for (const rec of this.nodes.values()) if (f - rec.frame > age && rec.L < top) list.push(rec);
        list.sort((a, b) => a.frame - b.frame);
        let drop = this.nodes.size - Math.floor(WVIEW_NODES_MAX * 0.8);
        for (const rec of list) {
            if (drop-- <= 0) break;
            try { rec.mesh.dispose(false, false); } catch (e) { /* ok */ }
            this.nodes.delete(rec.key);
        }
    },

    // ---------------------------------------------------------------------------------------------
    // Кадр
    // ---------------------------------------------------------------------------------------------

    /** Раз в кадр: узлы рельефа, декор, дороги, небо. camera — { x, y, z } (иначе камера вида). */
    update(dt, camera) {
        if (!this.ready || !this.view) return;
        const cam = this.view.camera;
        const p = camera || cam.position;
        const c = this.cam;
        c.x = p.x; c.y = p.y; c.z = p.z;
        if (cam.getTarget) {
            const t = cam.getTarget(), fx = t.x - p.x, fz = t.z - p.z, l = Math.hypot(fx, fz) || 1;
            c.fx = fx / l; c.fz = fz / l;
        }
        // рывок камеры (респавн, телепорт, смена вида): всё вокруг строится сразу, этим же кадром — без дыр и без «пустых» минут
        const L = this.last, jump = !L.ok || Math.hypot(c.x - L.x, c.z - L.z) > WVIEW_JUMP || Math.abs(c.y - L.y) > WVIEW_JUMP * 4;
        L.x = c.x; L.y = c.y; L.z = c.z; L.ok = true;
        this._terrain(jump);
        if (jump) { WorldDecor.update(c, true); WorldRoads.cull(c); } else {
            if ((this.frame & 3) === 0) WorldDecor.update(c, false);
            if ((this.frame & 7) === 0) WorldRoads.cull(c);
        }
        this._skyUniforms(Math.min(0.1, dt || 0), false);
        if (this.water) { this.water.position.x = c.x; this.water.position.z = c.z; }
    },

    /** Сводка для проверки: узлов рельефа в кадре, треугольников рельефа, декор. */
    stats() {
        // «в кадре» — узлы, попавшие в пирамиду видимости камеры (остальные Babylon не рисует); «всего» — весь выбранный набор вокруг камеры
        let vis = 0;
        try {
            const sc = this.scene, planes = BABYLON.Frustum.GetPlanes(sc.getTransformMatrix());
            for (const rec of this.active) if (rec.mesh.isInFrustum(planes)) vis++;
        } catch (e) { vis = this.active.length; }
        const per = this.idx ? this.idx.length / 3 : 0;
        return { nodes: vis, terrainTris: vis * per, nodesAll: this.stat.nodes, terrainTrisAll: this.stat.tris, missing: this.stat.missing, nodesInMemory: this.nodes.size, created: this.stat.created, decorChunks: WorldDecor.chunks.size, roadMeshes: WorldRoads.meshes.length };
    },
};

// ---------------------------------------------------------------------------------------------
// WorldRoads — ленты дорог точно по поверхности (те же выборки оси, что у физики), разметка, бордюры, трещины, площадки
// ---------------------------------------------------------------------------------------------

/** @satisfies {Record<string, any>} */
const WorldRoads = {
    /** @type {any} */ V: null,
    /** @type {any[]} */ meshes: [],
    /** @type {any[]} */ chunks: [],
    /** @type {Record<string, any>} */ mats: {},
    /** @type {any} */ _fr: { x: 0, y: 0, z: 0, rx: 0, rz: 0, tx: 0, tz: 0, tb: 0, hw: 0, sh: 0, nx: 0, ny: 1, nz: 0, s: 0 },
    /** @type {any} */ _fr2: { x: 0, y: 0, z: 0, rx: 0, rz: 0, tx: 0, tz: 0, tb: 0, hw: 0, sh: 0, nx: 0, ny: 1, nz: 0, s: 0 },

    // ---------------------------------------------------------------------------------------------
    // Материалы: по слоям наложения (на перекрёстке главная дорога выше второстепенной)
    // ---------------------------------------------------------------------------------------------

    /**
     * Слои наложения дорог: на перекрёстке главная дорога выше второстепенной (у слоя больше сдвиг глубины zOffset) — ленты одной плоскости
     * не борются за пиксель. Рельеф — нулевой слой; площадки рисует сам рельеф, борьбы с лентой у них нет.
     */
    _layers(gw) {
        const n = gw.roads.length, lay = new Array(n).fill(0);
        for (let it = 0; it < 8; it++) {
            let ch = false;
            for (const j of gw.junctions) {
                const a = j.main.index, b = j.sec.index;
                if (lay[a] <= lay[b] && lay[b] < WVIEW_LAYERS - 1) { lay[a] = lay[b] + 1; ch = true; }
            }
            if (!ch) break;
        }
        gw.roads.forEach((R, i) => { R.lay = lay[i]; });
    },

    /** Материал вида kind на слое layer (создаётся при первом запросе). kind: asphalt | concrete | strip (как рельеф) | kerb | deck | paint | decal. */
    mat(kind, layer) {
        const key = kind + layer;
        const have = this.mats[key];
        if (have) return have;
        const V = this.V, scene = V.scene, T = V.tex;
        const z = WVIEW_ZOFF - WVIEW_ZSTEP * layer;
        const std = (hex, spec, zz) => {
            const m = new BABYLON.StandardMaterial('wr-' + key, scene);
            m.diffuseColor = new BABYLON.Color3(hex[0], hex[1], hex[2]);
            m.specularColor = new BABYLON.Color3(spec, spec, spec);
            m.specularPower = 28;
            m.backFaceCulling = false;
            m.zOffset = zz; m.zOffsetUnits = zz;
            return m;
        };
        let m;
        switch (kind) {
            case 'asphalt': {
                m = std([1, 1, 1], 0.1, z);
                m.diffuseTexture = T.failed.some(u => /road-asphalt/.test(u)) ? T.asphaltFallback : T.asphalt;
                break;
            }
            case 'concrete': m = std([1, 1, 1], 0.1, z); m.diffuseTexture = T.concreteRoad; break;
            case 'strip': m = V._terrainMaterial('wr-' + key, z); break;
            case 'fgravel': m = std([0.58, 0.54, 0.48], 0.03, z); break;
            case 'fdirt': m = std([0.52, 0.38, 0.26], 0.02, z); break;
            case 'kerb': m = std([1, 1, 1], 0.06, z - 1); break;
            case 'deck': m = std([1, 1, 1], 0.05, z); break;
            case 'paint': m = std([1, 1, 1], 0.1, z - 2); m.emissiveColor = new BABYLON.Color3(0.06, 0.06, 0.06); break;
            default: {   // decal: заплаты и трещины, полупрозрачные
                m = std([1, 1, 1], 0, z - 1);
                const dt = T.decal;
                if (dt) {
                    m.diffuseTexture = dt;
                    m.useAlphaFromDiffuseTexture = true;
                    m.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
                    m.needDepthPrePass = false;
                    m.disableDepthWrite = true;
                } else m.alpha = 0;
            }
        }
        this.mats[key] = m; V.mats['wr-' + key] = m;
        return m;
    },

    /** Атлас заплат и трещин (2×2 по 256 px): аккуратные прямоугольные заплаты едва темнее асфальта и тонкие трещины; пятен и клякс нет. */
    _decalTexture(scene) {
        try {
            const dt = new BABYLON.DynamicTexture('wr-decals', { width: 512, height: 512 }, scene, true);
            const ctx = /** @type {any} */ (dt.getContext());
            if (!ctx) { dt.dispose(); return null; }
            this._drawDecals(ctx, 512);
            dt.update(true);
            dt.hasAlpha = true;
            dt.wrapU = dt.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
            dt.anisotropicFilteringLevel = 4;
            return dt;
        } catch (e) { return null; }
    },

    _drawDecals(ctx, n) {
        const h = n / 2;
        const rnd = (() => { let s = 29; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; })();
        // трещина: ломаная случайным блужданием, тонкая, тёмно-серая; ветви короче и тоньше
        const crack = (x, y, len, ang, wd, depth, a) => {
            ctx.strokeStyle = 'rgba(20,20,23,' + a + ')'; ctx.lineWidth = wd; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
            ctx.beginPath(); ctx.moveTo(x, y);
            let px = x, py = y, an = ang;
            const seg = 12;
            for (let i = 0; i < seg; i++) {
                an += (rnd() - 0.5) * 0.7;
                px += Math.cos(an) * len / seg; py += Math.sin(an) * len / seg;
                ctx.lineTo(px, py);
                if (depth > 0 && rnd() < 0.22) { ctx.stroke(); crack(px, py, len * 0.38, an + (rnd() < 0.5 ? 1 : -1) * (0.5 + rnd() * 0.7), wd * 0.7, depth - 1, a * 0.85); ctx.beginPath(); ctx.moveTo(px, py); }
            }
            ctx.stroke();
        };
        ctx.clearRect(0, 0, n, n);
        // (0,0) квадратная заплата: чуть темнее, тонкий шов по периметру
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, h, h); ctx.clip();
        ctx.fillStyle = 'rgba(0,0,0,0.11)'; ctx.fillRect(h * 0.1, h * 0.1, h * 0.8, h * 0.8);
        ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 2; ctx.strokeRect(h * 0.1, h * 0.1, h * 0.8, h * 0.8);
        ctx.restore();
        // (1,0) заплата-полоса (ремонт траншеи): вытянутая, с двойным швом
        ctx.save(); ctx.beginPath(); ctx.rect(h, 0, h, h); ctx.clip();
        ctx.fillStyle = 'rgba(0,0,0,0.09)'; ctx.fillRect(h + h * 0.04, h * 0.3, h * 0.92, h * 0.4);
        ctx.strokeStyle = 'rgba(0,0,0,0.26)'; ctx.lineWidth = 2; ctx.strokeRect(h + h * 0.04, h * 0.3, h * 0.92, h * 0.4);
        ctx.restore();
        // (0,1) одна длинная трещина с парой коротких ветвей, (1,1) волосяные трещины
        ctx.save(); ctx.beginPath(); ctx.rect(0, h, h, h); ctx.clip();
        crack(h * 0.06, h + h * 0.5, h * 0.88, 0.05, 2.2, 2, 0.5);
        ctx.restore();
        ctx.save(); ctx.beginPath(); ctx.rect(h, h, h, h); ctx.clip();
        crack(h + h * 0.1, h + h * 0.35, h * 0.7, 0.25, 1.4, 1, 0.38);
        crack(h + h * 0.18, h + h * 0.78, h * 0.62, -0.2, 1.3, 1, 0.34);
        ctx.restore();
    },

    // ---------------------------------------------------------------------------------------------
    // Кадры дороги: поверхность в точке выборки и между ними
    // ---------------------------------------------------------------------------------------------

    /** Кадр у выборки s: положение оси, вектор вправо, наклон, ширина, нормаль поверхности. */
    _frame(R, s, o) {
        const n = R.n;
        o.x = R.X[s]; o.y = R.Y[s]; o.z = R.Z[s]; o.tx = R.TX[s]; o.tz = R.TZ[s];
        o.rx = -o.tz; o.rz = o.tx;
        o.tb = Math.tan(R.BK[s]); o.hw = R.HW[s]; o.sh = R.SH[s]; o.s = R.S[s];
        const a = Math.max(0, s - 1), b = Math.min(n - 1, s + 1);
        const dl = Math.hypot(R.X[b] - R.X[a], R.Z[b] - R.Z[a]) || 1;
        const sl = (R.Y[b] - R.Y[a]) / dl, cb = Math.cos(R.BK[s]), sb = Math.sin(R.BK[s]);
        // нормаль = (вправо с креном) × (вдоль с подъёмом)
        const ax = o.rx * cb, ay = -sb, az = o.rz * cb, bx = o.tx, by = sl, bz = o.tz;
        let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
        const l = Math.hypot(nx, ny, nz) || 1;
        o.nx = nx / l; o.ny = ny / l; o.nz = nz / l;
        return o;
    },

    /** Кадр на длине дуги sArc: интерполяция между выборками. */
    _arc(R, sArc, o) {
        const S = R.S;
        let lo = 0, hi = R.n - 1;
        if (sArc <= S[0]) { lo = 0; hi = 1; } else if (sArc >= S[R.n - 1]) { lo = R.n - 2; hi = R.n - 1; }
        else { while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= sArc) lo = m; else hi = m; } }
        const t = Math.max(0, Math.min(1, (sArc - S[lo]) / ((S[hi] - S[lo]) || 1)));
        const a = this._frame(R, lo, this._fr), b = this._frame(R, hi, this._fr2);
        o.x = a.x + (b.x - a.x) * t; o.y = a.y + (b.y - a.y) * t; o.z = a.z + (b.z - a.z) * t;
        let tx = a.tx + (b.tx - a.tx) * t, tz = a.tz + (b.tz - a.tz) * t;
        const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
        o.tx = tx; o.tz = tz; o.rx = -tz; o.rz = tx;
        o.tb = a.tb + (b.tb - a.tb) * t; o.hw = a.hw + (b.hw - a.hw) * t; o.sh = a.sh + (b.sh - a.sh) * t;
        let nx = a.nx + (b.nx - a.nx) * t, ny = a.ny + (b.ny - a.ny) * t, nz = a.nz + (b.nz - a.nz) * t;
        const nl = Math.hypot(nx, ny, nz) || 1;
        o.nx = nx / nl; o.ny = ny / nl; o.nz = nz / nl;
        o.s = sArc; o.i = lo; o.t = t;
        return o;
    },

    // ---------------------------------------------------------------------------------------------
    // Постройка
    // ---------------------------------------------------------------------------------------------

    build(V) {
        this.dispose();
        this.V = V;
        const gw = V.gw;
        this._layers(gw);
        // атлас заплат и трещин — один на сцену (как и остальные текстуры мира)
        if (V.tex.decal === undefined) V.tex.decal = this._decalTexture(V.scene);
        for (const R of gw.roads) this._road(V, R);
        // площадки, которые шейдер рельефа нарисовать не смог (их больше WVIEW_FLATS_GPU), — плитами
        for (const f of gw.flats) if (!V.gpuFlats.includes(f)) this._flat(V, f);
    },

    dispose() {
        for (const m of this.meshes) { try { m.dispose(false, false); } catch (e) { /* ok */ } }
        this.meshes = []; this.chunks = []; this.mats = {};
        this.V = null;
    },

    cull(cam) {
        const far = WVIEW_ROAD_DRAW;
        for (const c of this.chunks) {
            const on = Math.hypot(c.cx - cam.x, c.cz - cam.z) < far + c.r;
            if (on !== c.on) { c.on = on; for (const m of c.meshes) m.setEnabled(on); }
        }
    },

    _mesh(V, g, name, kind, layer, ox, oz, chunk) {
        const mesh = g.toMesh(V.scene, name, this.mat(kind, layer));
        if (!mesh) return null;
        mesh.position.set(ox, 0, oz);
        mesh.isPickable = false;
        mesh.receiveShadows = kind !== 'paint' && kind !== 'decal';
        mesh.freezeWorldMatrix();
        mesh.doNotSyncBoundingInfo = true;
        this.meshes.push(mesh);
        if (chunk) chunk.meshes.push(mesh);
        return mesh;
    },

    /** Дорога по кускам WVIEW_ROAD_CHUNK выборок: каждая часть — несколько мешей по материалам. */
    _road(V, R) {
        const N = R.n;
        for (let s0 = 0; s0 + 1 < N; s0 += WVIEW_ROAD_CHUNK) {
            const s1 = Math.min(N - 1, s0 + WVIEW_ROAD_CHUNK);
            const ox = R.X[s0], oz = R.Z[s0];
            /** @type {Record<string, any>} */ const B = {};
            const get = (k) => B[k] || (B[k] = WorldGeo.builder());
            this._surface(V, R, s0, s1, ox, oz, get);
            this._kerbs(R, s0, s1, ox, oz, get);
            this._marks(R, s0, s1, ox, oz, get);
            this._decals(R, s0, s1, ox, oz, get);
            this._sides(V, R, s0, s1, ox, oz, get);
            let cx = 0, cz = 0, r = 0;
            for (let s = s0; s <= s1; s++) { cx += R.X[s]; cz += R.Z[s]; }
            cx /= (s1 - s0 + 1); cz /= (s1 - s0 + 1);
            for (let s = s0; s <= s1; s++) r = Math.max(r, Math.hypot(R.X[s] - cx, R.Z[s] - cz));
            const chunk = { cx, cz, r: r + R.maxHW + 800, on: true, meshes: [] };
            for (const k of Object.keys(B)) this._mesh(V, B[k], 'road-' + R.id + '-' + k, k, R.lay || 0, ox, oz, chunk);
            this.chunks.push(chunk);
        }
    },

    /** Полоса между боковыми смещениями lats(s) (px от оси, вправо +): вершины по выборкам, quad между соседними. */
    _strip(g, R, s0, s1, ox, oz, lats, col, opts) {
        const f = this._fr, rows = [];
        const uS = opts.uvU || 1 / 600, vS = opts.uvV || 1 / 600, lift = opts.lift == null ? WVIEW_LIFT : opts.lift;
        for (let s = s0; s <= s1; s++) {
            this._frame(R, s, f);
            const L = lats(s, f), row = [];
            for (let i = 0; i < L.length; i++) {
                const l = L[i];
                const c = col(s, i, l, f);
                row.push(g.v([f.x + f.rx * l - ox, f.y - f.tb * l + lift + (opts.drop && opts.drop(i, l, f) || 0), f.z + f.rz * l - oz], [f.nx, f.ny, f.nz], c, [l * uS, f.s * vS]));
            }
            rows.push(row);
        }
        for (let k = 0; k + 1 < rows.length; k++) {
            if (opts.skip && opts.skip(s0 + k)) continue;
            const a = rows[k], b = rows[k + 1];
            for (let i = 0; i + 1 < a.length; i++) g.quad(a[i], a[i + 1], b[i + 1], b[i]);
        }
    },

    /** Покрытие, обочины и откосы по участкам с одним покрытием: асфальт и бетон — своя лента, грунт и гравий — лента-«земля»; у всех плавный край в рельеф. */
    _surface(V, R, s0, s1, ox, oz, get) {
        let a = s0;
        while (a < s1) {
            const surf = R.SURF[a], br = R.BRIDGE[a], tn = R.TUNNEL[a];
            let b = a + 1;
            while (b < s1 && R.SURF[b] === surf && R.BRIDGE[b] === br && R.TUNNEL[b] === tn) b++;
            const name = R.surfNames[surf], hard = name === 'asphalt' || name === 'concrete';
            if (hard) this._hard(R, a, b, ox, oz, get, name, br);
            else this._soft(V, R, a, b, ox, oz, get, name);
            if (!br) this._verge(V, R, a, b, ox, oz, get, hard, !tn);
            a = b;
        }
    },

    /** Асфальт и бетон: лента во всю ширину; колея едва темнее, крупные пятна износа ±8%. Мост — полотно вместе с обочиной. */
    _hard(R, a, b, ox, oz, get, name, br) {
        const g = get(name);
        const tone = (s, i, l, f) => {
            const u = Math.abs(l) / Math.max(1, f.hw);
            const wp = 1 - 0.07 * Math.exp(-Math.pow((u - 0.5) / 0.15, 2));
            const n = 1 + 0.16 * (worldNoise(R.S[s] * 0.0022 + i * 3.1, 1.7, 77) - 0.5);
            const k = wp * n;
            return [k, k * 0.996, k, 1];
        };
        const uvV = name === 'concrete' ? 1 / 500 : 1 / 600;
        if (br) this._strip(g, R, a, b, ox, oz, (s, f) => [-(f.hw + f.sh), -f.hw * 0.5, 0, f.hw * 0.5, f.hw + f.sh], tone, { uvV, lift: 0 });
        else this._strip(g, R, a, b, ox, oz, (s, f) => [-f.hw, -f.hw * 0.5, 0, f.hw * 0.5, f.hw], tone, { uvV });
    },

    /** Цвет и веса узора земли в точке (x, z) — те же, что у вершин рельефа: out = [r, g, b, скала, щебень, бетон, песок]. */
    _ground(V, x, z, out) {
        const gw = V.gw, h = gw.heightAt(x, z), n = gw.normalAt(x, z);
        return V._macro(x, z, h, n[1], gw.edgeDist(x, z), out);
    },

    /**
     * Грунтовка и гравийка: лента того же материала, что рельеф (зерно, щебень, свет на камнях), цвет — от земли вокруг: у кромки он равен
     * цвету земли, ни уступа, ни тёмной полосы. Колеи рисует шейдер по поперечной координате (uv = смещение, ± ширина дороги).
     */
    _soft(V, R, a, b, ox, oz, get, name) {
        const g = get('strip'), f = this._fr, dirt = name === 'dirt';
        const dc = V.pal.dirt;
        const base = dirt ? [(dc[0][0] + dc[1][0]) * 0.5, (dc[0][1] + dc[1][1]) * 0.5, (dc[0][2] + dc[1][2]) * 0.5] : [0.6, 0.56, 0.5];
        const K = [-1, -0.78, -0.45, -0.18, 0, 0.18, 0.45, 0.78, 1];
        const mL = [0, 0, 0, 0, 0, 0, 0], mC = [0, 0, 0, 0, 0, 0, 0], mR = [0, 0, 0, 0, 0, 0, 0];
        const rows = [];
        for (let s = a; s <= b; s++) {
            this._frame(R, s, f);
            const E = f.hw + f.sh;
            this._ground(V, f.x - f.rx * E, f.z - f.rz * E, mL); this._ground(V, f.x, f.z, mC); this._ground(V, f.x + f.rx * E, f.z + f.rz * E, mR);
            const row = [];
            for (let i = 0; i < K.length; i++) {
                const k = K[i], l = k * E, t = Math.abs(k), mg = k < 0 ? mL : mR;
                const e = worldSmooth(0.8, 1.0, t);
                const j = 0.95 + 0.1 * worldNoise(R.S[s] * 0.003 + i * 4.1, 3.3, 79);
                const m = [], w = [];
                for (let q = 0; q < 7; q++) m.push(mC[q] + (mg[q] - mC[q]) * t);
                const pe = dirt ? 0.3 : 0.85;
                for (let q = 0; q < 3; q++) m[q] = (base[q] * j * 0.8 + m[q] * 0.2) * (1 - e) + m[q] * e;
                w.push(m[3] * e, pe * (1 - e) + m[4] * e, m[5] * e, m[6] * e);
                row.push(g.v([f.x + f.rx * l - ox, f.y - f.tb * l + WVIEW_LIFT, f.z + f.rz * l - oz], [f.nx, f.ny, f.nz], [m[0], m[1], m[2], 1], [l, dirt ? f.hw : -f.hw], w));
            }
            rows.push(row);
        }
        for (let k = 0; k + 1 < rows.length; k++) {
            const p = rows[k], q = rows[k + 1];
            for (let i = 0; i + 1 < p.length; i++) g.quad(p[i], p[i + 1], q[i + 1], q[i]);
        }
    },

    /**
     * Кромка дороги: обочина (асфальт и бетон — мелкий гравий в плоскости дороги, к краю он переходит в цвет земли) и «фартук» — полоса земли
     * шириной ≈ 6 м за ней, которая идёт ТОЧНО по высоте физики (ровная полоса, потом откос), цвет и узор — как у рельефа. Грубые узлы рельефа
     * вдали режут угол откоса, фартук закрывает щель и не даёт дороге стоять на стенке; внешний край уходит чуть под землю.
     * apron = false (траншея): без фартука.
     */
    _verge(V, R, a, b, ox, oz, get, hard, apron) {
        const g = get('strip'), gw = V.gw, f = this._fr;
        const G0 = [0.52, 0.49, 0.45];
        const AP = [0, 140, 330, 620];   // смещения фартука от кромки обочины, px
        const m0 = [0, 0, 0, 0, 0, 0, 0], m1 = [0, 0, 0, 0, 0, 0, 0], m2 = [0, 0, 0, 0, 0, 0, 0];
        for (let side = -1; side <= 1; side += 2) {
            const rows = [];
            for (let s = a; s <= b; s++) {
                this._frame(R, s, f);
                const hw = f.hw, e0 = hw + f.sh, sg = side;
                const P = (l) => [f.x + f.rx * sg * l, f.z + f.rz * sg * l];
                let p0 = P(e0), p1 = P(e0 + AP[2]), p2 = P(e0 + AP[3]);
                this._ground(V, p0[0], p0[1], m0); this._ground(V, p1[0], p1[1], m1); this._ground(V, p2[0], p2[1], m2);
                const j = 0.92 + 0.16 * worldNoise(R.S[s] * 0.004 + side * 9, 5.5, 91);
                const gc = [G0[0] * j, G0[1] * j, G0[2] * j];
                const mix = (A, B, t) => [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t, 1];
                const row = [];
                const nr = [f.nx, f.ny, f.nz];
                const road = (l, col, w) => row.push(g.v([f.x + f.rx * sg * l - ox, f.y - f.tb * sg * l + WVIEW_LIFT, f.z + f.rz * sg * l - oz], nr, col, [0, 0], w));
                const sh = (l, col, w) => { const q = P(l); const h = gw.heightAt(q[0], q[1]), n = gw.normalAt(q[0], q[1]); row.push(g.v([q[0] - ox, h + WVIEW_LIFT * 0.6, q[1] - oz], [n[0], n[1], n[2]], col, [0, 0], w)); };
                if (hard) {
                    road(hw, mix(gc, m0, 0.0), [0, 0.75, 0, 0]);
                    road(hw + f.sh * 0.5, mix(gc, m0, 0.2), [m0[3] * 0.3, 0.6, 0, m0[6] * 0.3]);
                    road(e0, mix(gc, m0, 0.4), [m0[3] * 0.5, 0.45, 0, m0[6] * 0.5]);
                } else road(e0, [m0[0], m0[1], m0[2], 1], [m0[3], m0[4], m0[5], m0[6]]);
                if (apron) {
                    const c1 = hard ? mix(gc, m1, 0.62) : mix(m0, m1, 0.5);
                    sh(e0 + AP[1], c1, [m1[3] * 0.7, hard ? 0.28 : m1[4], m1[5] * 0.7, m1[6] * 0.7]);
                    sh(e0 + AP[2], [m1[0], m1[1], m1[2], 1], [m1[3], m1[4], m1[5], m1[6]]);
                    // внешний край фартука на 25 см ниже земли: уходит под рельеф (в том числе под грубые узлы вдали), шва не видно
                    { const q = P(e0 + AP[3]); const h = gw.heightAt(q[0], q[1]), n = gw.normalAt(q[0], q[1]); row.push(g.v([q[0] - ox, h - 25, q[1] - oz], [n[0], n[1], n[2]], [m2[0], m2[1], m2[2], 1], [0, 0], [m2[3], m2[4], m2[5], m2[6]])); }
                }
                rows.push(row);
            }
            for (let k = 0; k + 1 < rows.length; k++) {
                if (R.JN[a + k] || R.JN[a + k + 1]) continue;   // на перекрёстке — дорога другой дороги: обочины и фартука нет
                const p = rows[k], q = rows[k + 1];
                for (let i = 0; i + 1 < p.length; i++) g.quad(p[i], p[i + 1], q[i + 1], q[i]);
            }
        }
    },

    /** Бордюры: kerb=1 бетонный, kerb=2 красно-белый (полосы 1.2 м по дуге). */
    _kerbs(R, s0, s1, ox, oz, get) {
        let any = false;
        for (let s = s0; s < s1; s++) if (R.KERB[s] > 0 && !R.BRIDGE[s]) { any = true; break; }
        if (!any) return;
        const g = get('kerb'), fr = this._fr, H = 11, W = 24;
        const sa = R.S[s0], sb = R.S[s1];
        let striped = false;
        for (let s = s0; s < s1; s++) if (R.KERB[s] === 2) { striped = true; break; }
        const step = striped ? 120 : 420;      // полосатому нужен шаг полосы, бетонному — только изгиб дороги
        const nSt = Math.max(1, Math.ceil((sb - sa) / step));
        for (let side = -1; side <= 1; side += 2) {
            for (let k = 0; k < nSt; k++) {
                const a0 = sa + (sb - sa) * k / nSt, a1 = sa + (sb - sa) * (k + 1) / nSt;
                const si = Math.min(R.n - 2, this._arc(R, (a0 + a1) / 2, fr).i);
                const kind = R.KERB[si];
                if (kind === 0 || R.BRIDGE[si] || R.JN[si]) continue;
                const red = kind === 2 && (Math.floor(a0 / step) & 1) === 0;
                const c = kind === 2 ? (red ? [0.82, 0.14, 0.12, 1] : [0.92, 0.92, 0.9, 1]) : [0.62, 0.61, 0.58, 1];
                const cs = [c[0] * 0.85, c[1] * 0.85, c[2] * 0.85, 1];
                const p = (arc, l, up) => { const f = this._arc(R, arc, this._fr2); return [f.x + f.rx * l - ox, f.y - f.tb * l + WVIEW_LIFT + up, f.z + f.rz * l - oz, f]; };
                const hw0 = this._arc(R, a0, this._fr2).hw, hw1 = this._arc(R, a1, this._fr2).hw;
                const q00 = p(a0, side * hw0, 0), q01 = p(a0, side * hw0, H), q02 = p(a0, side * (hw0 + W), H), q03 = p(a0, side * (hw0 + W), 0);
                const q10 = p(a1, side * hw1, 0), q11 = p(a1, side * hw1, H), q12 = p(a1, side * (hw1 + W), H), q13 = p(a1, side * (hw1 + W), 0);
                const nIn = [-side * q00[3].rx, 0, -side * q00[3].rz], nUp = [0, 1, 0], nOut = [side * q00[3].rx, 0, side * q00[3].rz];
                const v = (q, n, col) => g.v([q[0], q[1], q[2]], n, col, [0, 0]);
                // внутренняя грань, верх, внешняя грань
                g.quad(v(q00, nIn, cs), v(q01, nIn, cs), v(q11, nIn, cs), v(q10, nIn, cs));
                g.quad(v(q01, nUp, c), v(q02, nUp, c), v(q12, nUp, c), v(q11, nUp, c));
                g.quad(v(q02, nOut, cs), v(q03, nOut, cs), v(q13, nOut, cs), v(q12, nOut, cs));
            }
        }
    },

    /** Полоса-линия вдоль дороги от дуги a0 до a1 на смещении lat(f) шириной wd. */
    _line(g, R, a0, a1, ox, oz, latFn, wd, color, lift) {
        const f = this._fr2, n = Math.max(1, Math.ceil((a1 - a0) / 450));
        let prev = null;
        for (let k = 0; k <= n; k++) {
            const arc = a0 + (a1 - a0) * k / n;
            this._arc(R, arc, f);
            const l = latFn(f), wear = 0.72 + 0.28 * worldNoise(arc * 0.004, l * 0.01, 13);
            const c = [color[0] * wear, color[1] * wear, color[2] * wear, 1];
            const mk = (ll) => g.v([f.x + f.rx * ll - ox, f.y - f.tb * ll + WVIEW_LIFT + lift, f.z + f.rz * ll - oz], [f.nx, f.ny, f.nz], c, [0, 0]);
            const row = [mk(l - wd / 2), mk(l + wd / 2)];
            if (prev) g.quad(prev[0], prev[1], row[1], row[0]);
            prev = row;
        }
    },

    /** Разметка: кромки, осевая (пунктир или сплошная двойная), полосы на широких дорогах, стоп-линии у перекрёстков. */
    _marks(R, s0, s1, ox, oz, get) {
        const g = get('paint');
        const WHITE = [0.94, 0.94, 0.9], YELLOW = [0.96, 0.78, 0.14];
        const lift = 0.7;
        // участки без перекрёстка и с разметкой
        let s = s0;
        while (s < s1) {
            const marked = (i) => R.MARK[i] > 0 && R.SURF[i] <= 1 && !R.JN[i];
            if (!marked(s)) { s++; continue; }
            let e = s + 1;
            while (e < s1 && marked(e) && R.MARK[e] === R.MARK[s]) e++;
            const a0 = R.S[s], a1 = R.S[e], hw = R.HW[s], mark = R.MARK[s];
            if (a1 - a0 > 10) {
                // кромки
                this._line(g, R, a0, a1, ox, oz, f => -(f.hw - 55), 14, WHITE, lift);
                this._line(g, R, a0, a1, ox, oz, f => f.hw - 55, 14, WHITE, lift);
                const perDir = Math.max(1, Math.floor(hw / 330));   // полос в одну сторону
                if (hw >= 330) {
                    if (mark === 2 || perDir >= 2) {
                        // двойная сплошная по оси
                        this._line(g, R, a0, a1, ox, oz, () => -11, 11, mark === 2 ? YELLOW : WHITE, lift);
                        this._line(g, R, a0, a1, ox, oz, () => 11, 11, mark === 2 ? YELLOW : WHITE, lift);
                    } else {
                        // пунктир по оси
                        const per = 900, dash = 300;
                        for (let a = Math.ceil(a0 / per) * per; a + dash < a1; a += per) this._line(g, R, a, a + dash, ox, oz, () => 0, 14, WHITE, lift);
                    }
                    // полосы по сторонам
                    for (let k = 1; k < perDir; k++) {
                        const lat = (f) => k * (f.hw - 55) / perDir;
                        for (const sd of [-1, 1]) {
                            const per = 1200, dash = 300;
                            for (let a = Math.ceil(a0 / per) * per; a + dash < a1; a += per) this._line(g, R, a, a + dash, ox, oz, (f) => sd * lat(f), 12, WHITE, lift);
                        }
                    }
                }
            }
            s = e;
        }
        // стоп-линии: вход в перекрёсток по ходу (правая полоса) и против хода (левая)
        for (let i = Math.max(1, s0); i < Math.min(s1 + 1, R.n); i++) {
            if (R.MARK[i] === 0 || R.SURF[i] > 1) continue;
            if (!R.JN[i - 1] && R.JN[i] && i - 1 >= s0) { this._stop(g, R, R.S[i - 1] + 20, 1, ox, oz, WHITE, lift); this._arrow(g, R, R.S[i - 1] - 900, 1, ox, oz, WHITE, lift); }
            if (R.JN[i - 1] && !R.JN[i] && i >= s0 && i <= s1) { this._stop(g, R, R.S[i] + 60, -1, ox, oz, WHITE, lift); this._arrow(g, R, R.S[i] + 1100, -1, ox, oz, WHITE, lift); }
        }
    },

    _stop(g, R, arc, side, ox, oz, color, lift) {
        const f = this._arc(R, arc, this._fr2);
        const hw = f.hw, a = 45, b = hw - 70;
        const mk = (along, l) => {
            const q = this._arc(R, arc + along, this._fr2);
            return g.v([q.x + q.rx * l - ox, q.y - q.tb * l + WVIEW_LIFT + lift, q.z + q.rz * l - oz], [q.nx, q.ny, q.nz], [color[0], color[1], color[2], 1], [0, 0]);
        };
        const l0 = side > 0 ? a : -b, l1 = side > 0 ? b : -a;
        g.quad(mk(-20, l0), mk(-20, l1), mk(20, l1), mk(20, l0));
    },

    /** Стрелка «прямо» на полосе подъезда к перекрёстку: side +1 — правая полоса, движение по курсу дороги; −1 — левая, против. */
    _arrow(g, R, arc, side, ox, oz, color, lift) {
        if (arc < R.S[0] + 400 || arc > R.S[R.n - 1] - 400) return;
        const hw = this._arc(R, arc, this._fr2).hw, latC = side * (hw - 25) / 2;
        const mk = (u, v) => {
            const q = this._arc(R, arc + side * u, this._fr2), l = latC + v;
            return g.v([q.x + q.rx * l - ox, q.y - q.tb * l + WVIEW_LIFT + lift, q.z + q.rz * l - oz], [q.nx, q.ny, q.nz], [color[0] * 0.92, color[1] * 0.92, color[2] * 0.92, 1], [0, 0]);
        };
        g.quad(mk(-350, -12), mk(-350, 12), mk(120, 12), mk(120, -12));
        g.tri(mk(120, -46), mk(120, 46), mk(360, 0));
    },

    /**
     * Заплаты и трещины: редко и аккуратно, по хэшу от длины дуги (шаг 36 м): заплата — примерно в одной точке из девяти, трещина — в трёх из десяти.
     * Заплата — ровный прямоугольник вдоль дороги, едва темнее асфальта; трещина — тонкая линия под случайным углом. Клякс и кругов нет.
     */
    _decals(R, s0, s1, ox, oz, get) {
        if (R.SURF[s0] > 1) return;
        const g = get('decal');
        const sa = R.S[s0], sb = R.S[s1], step = 3600;
        const f = this._fr2;
        for (let a = Math.ceil(sa / step) * step; a < sb; a += step) {
            const id = Math.round(a / step), seed = 501 + R.index * 7;
            const h0 = worldHash(id, 1, seed), h1 = worldHash(id, 2, seed), h2 = worldHash(id, 3, seed), h3 = worldHash(id, 4, seed), h4 = worldHash(id, 5, seed), h5 = worldHash(id, 6, seed);
            if (h0 > 0.42) continue;
            const patch = h0 < 0.11;
            const arc = a + (h1 - 0.5) * step * 0.8;
            if (arc < sa || arc >= sb) continue;
            this._arc(R, arc, f);
            const si = Math.min(R.n - 2, f.i);
            if (R.JN[si] || R.JN[si + 1] || R.BRIDGE[si] || R.SURF[si] > 1) continue;
            const kind = patch ? (h2 < 0.5 ? 0 : 1) : (h2 < 0.5 ? 2 : 3), qx = (kind & 1) * 0.5, qy = (kind >> 1) * 0.5;
            const lat = (h3 - 0.5) * 2 * f.hw * 0.62;
            // заплата вдоль дороги, трещина — под случайным углом
            const half = patch ? (kind === 0 ? 170 + h4 * 110 : 250 + h4 * 160) : 220 + h4 * 150, ang = patch ? (h5 - 0.5) * 0.05 : h5 * Math.PI;
            const ca = Math.cos(ang), sn = Math.sin(ang);
            const c = [1, 1, 1, 1];
            const px = f.x + f.rx * lat, pz = f.z + f.rz * lat, py = f.y - f.tb * lat + WVIEW_LIFT + 0.2;
            const corner = (u, v, tu, tv) => {
                const du = u * ca - v * sn, dv = u * sn + v * ca;
                return g.v([px + f.tx * du + f.rx * dv - ox, py, pz + f.tz * du + f.rz * dv - oz], [f.nx, f.ny, f.nz], c, [qx + tu * 0.5, 1 - (qy + tv * 0.5)]);
            };
            g.quad(corner(-half, -half, 0, 0), corner(half, -half, 1, 0), corner(half, half, 1, 1), corner(-half, half, 0, 1));
        }
    },

    /** Бока моста (плита с торцами) и стены траншеи tunnel=1. */
    _sides(V, R, s0, s1, ox, oz, get) {
        const gw = V.gw, f = this._fr;
        let hasB = false, hasT = false;
        for (let s = s0; s < s1; s++) { if (R.BRIDGE[s]) hasB = true; if (R.TUNNEL[s]) hasT = true; }
        if (!hasB && !hasT) return;
        const g = get('deck');
        for (let s = s0; s < s1; s++) {
            const a = this._frame(R, s, this._fr), ax = a.x, ay = a.y, az = a.z, arx = a.rx, arz = a.rz, atb = a.tb, ahw = a.hw + a.sh, nxA = a.nx, nyA = a.ny, nzA = a.nz;
            const b = this._frame(R, s + 1, this._fr2);
            void f; void nxA; void nyA; void nzA;
            if (R.BRIDGE[s]) {
                const T = 110, cs = [0.6, 0.6, 0.58, 1], cb = [0.46, 0.46, 0.44, 1];
                for (let side = -1; side <= 1; side += 2) {
                    const la = side * ahw, lb = side * (b.hw + b.sh);
                    const nOut = [side * arx, 0, side * arz];
                    const p0 = [ax + arx * la - ox, ay - atb * la + WVIEW_LIFT, az + arz * la - oz], p1 = [b.x + b.rx * lb - ox, b.y - b.tb * lb + WVIEW_LIFT, b.z + b.rz * lb - oz];
                    g.quad(g.v(p0, nOut, cs), g.v([p0[0], p0[1] - T, p0[2]], nOut, cs), g.v([p1[0], p1[1] - T, p1[2]], nOut, cs), g.v(p1, nOut, cs));
                }
                // низ плиты
                const nd = [0, -1, 0];
                const pa = [ax - arx * ahw - ox, ay + atb * ahw - T + WVIEW_LIFT, az - arz * ahw - oz], pb = [ax + arx * ahw - ox, ay - atb * ahw - T + WVIEW_LIFT, az + arz * ahw - oz];
                const bw = b.hw + b.sh;
                const pc = [b.x + b.rx * bw - ox, b.y - b.tb * bw - T + WVIEW_LIFT, b.z + b.rz * bw - oz], pd = [b.x - b.rx * bw - ox, b.y + b.tb * bw - T + WVIEW_LIFT, b.z - b.rz * bw - oz];
                g.quad(g.v(pa, nd, cb), g.v(pb, nd, cb), g.v(pc, nd, cb), g.v(pd, nd, cb));
            }
            if (R.TUNNEL[s]) {
                const cw = [0.7, 0.69, 0.66, 1], cw2 = [0.58, 0.57, 0.55, 1];
                for (let side = -1; side <= 1; side += 2) {
                    const la = side * (ahw + 60), lb = side * (b.hw + b.sh + 60);
                    const ta = gw.heightAt(ax + arx * (la + side * 220), az + arz * (la + side * 220)), tbb = gw.heightAt(b.x + b.rx * (lb + side * 220), b.z + b.rz * (lb + side * 220));
                    const ha = Math.max(ay + 40, ta + 25), hb = Math.max(b.y + 40, tbb + 25);
                    const nIn = [-side * arx, 0, -side * arz];
                    const p0 = [ax + arx * la - ox, ay - atb * la, az + arz * la - oz], p1 = [b.x + b.rx * lb - ox, b.y - b.tb * lb, b.z + b.rz * lb - oz];
                    g.quad(g.v(p0, nIn, cw2), g.v([p0[0], ha, p0[2]], nIn, cw), g.v([p1[0], hb, p1[2]], nIn, cw), g.v(p1, nIn, cw2));
                }
            }
        }
    },

    /** Площадка сверх WVIEW_FLATS_GPU: плита по контуру на высоте f.y (у физики — ровный участок сетки). Обычно площадки рисует шейдер рельефа. */
    _flat(V, f) {
        const mat = f.surf === 'concrete' ? 'concrete' : f.surf === 'dirt' ? 'fdirt' : f.surf === 'gravel' ? 'fgravel' : f.surf === 'asphalt' ? 'asphalt' : '';
        if (!mat) return;
        const g = WorldGeo.builder();
        const y = f.y + WVIEW_LIFT * 2;
        const up = [0, 1, 0], S = 1 / 600;
        const tone = (x, z) => { const k = 0.93 + 0.1 * (worldNoise(x * 0.0005, z * 0.0005, 303) - 0.5) * 2; return [k, k, k, 1]; };
        const pts = [];
        if (f.r > 0) { const n = 40; for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; pts.push([f.x + Math.cos(a) * f.r, f.z + Math.sin(a) * f.r]); } }
        else for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) pts.push([f.x + f.cos * u * f.hw - f.sin * v * f.hd, f.z + f.sin * u * f.hw + f.cos * v * f.hd]);
        // подразбить на ячейки 8 м (освещение и цвет по тону)
        const ox = f.x, oz = f.z;
        if (f.r > 0) {
            const c = g.v([0, y - 0, 0], up, tone(f.x, f.z), [f.x * S, f.z * S]);
            const ids = pts.map(p => g.v([p[0] - ox, y, p[1] - oz], up, tone(p[0], p[1]), [p[0] * S, p[1] * S]));
            for (let i = 0; i < ids.length; i++) g.tri(c, ids[i], ids[(i + 1) % ids.length]);
        } else {
            const n = 6;
            const at = (a, b) => { const u = a / n * 2 - 1, v = b / n * 2 - 1; const x = f.x + f.cos * u * f.hw - f.sin * v * f.hd, z = f.z + f.sin * u * f.hw + f.cos * v * f.hd; return g.v([x - ox, y, z - oz], up, tone(x, z), [x * S, z * S]); };
            const grid = [];
            for (let a = 0; a <= n; a++) { const row = []; for (let b = 0; b <= n; b++) row.push(at(a, b)); grid.push(row); }
            for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) g.quad(grid[a][b], grid[a + 1][b], grid[a + 1][b + 1], grid[a][b + 1]);
        }
        this._mesh(V, g, 'flat', mat, 0, ox, oz, null);
    },
};

// ---------------------------------------------------------------------------------------------
// WorldDecor — деревья, кусты, камни: чанки thin instances (две модели на вид: подробная и дальняя)
// ---------------------------------------------------------------------------------------------

/**
 * Модели декора по виду и биому (Blender, art/blender/props): ближний план рисует их, дальний — упрощённая процедурная. fit: 'h' — вписать в высоту
 * it.h (h — высота модели, px), 'r' — в радиус камня it.r (h — полуширина модели, px). Нет файла — процедурная модель. Пути — литералами (сборщик архива).
 */
const WVIEW_DECOR_MODELS = {
    spruce: () => [{ url: 'assets/models/props/pine_a.glb', fit: 'h', h: 1800 }, { url: 'assets/models/props/pine_b.glb', fit: 'h', h: 1100 }],
    oak: (biome) => (biome === 'city' ? [{ url: 'assets/models/props/tree_a.glb', fit: 'h', h: 1028 }]
        : [{ url: 'assets/models/props/tree_a.glb', fit: 'h', h: 1028 }, { url: 'assets/models/props/tree_a.glb', fit: 'h', h: 1028 }, { url: 'assets/models/props/tree_c.glb', fit: 'h', h: 1320 }]),
    poplar: () => [{ url: 'assets/models/props/tree_b.glb', fit: 'h', h: 1925 }],
    snag: () => [{ url: 'assets/models/props/pine_c.glb', fit: 'h', h: 1425 }],
    bush: (biome) => (biome === 'canyon' ? [{ url: 'assets/models/props/dry_bush.glb', fit: 'h', h: 132 }] : [{ url: 'assets/models/props/bush_a.glb', fit: 'h', h: 128 }]),
    cactus: () => [{ url: 'assets/models/props/cactus_a.glb', fit: 'h', h: 411 }],
    dead: (biome) => (biome === 'canyon' ? [{ url: 'assets/models/props/cactus_a.glb', fit: 'h', h: 411 }] : []),
    rock: (biome) => (biome === 'canyon' ? [{ url: 'assets/models/props/rock_b.glb', fit: 'r', h: 431 }]
        : [{ url: 'assets/models/props/rock_a.glb', fit: 'r', h: 191 }, { url: 'assets/models/props/rock_c.glb', fit: 'r', h: 638 }]),
};

/** Травяной покров (GameWorld.coverRules): только из файлов, нет файла — нет покрова. */
const WVIEW_COVER_MODELS = { grass: 'assets/models/props/grass_tuft.glb', flower: 'assets/models/props/flower_tuft.glb', fern: 'assets/models/props/fern_a.glb' };
const WVIEW_COVER_HEIGHT = { grass: 68.5, flower: 61.9, fern: 67 };   // px: высота моделей покрова (манифест), масштаб правила — от неё

/** @satisfies {Record<string, any>} */
const WorldDecor = {
    /** @type {any} */ V: null,
    /** @type {Map<string, any>} */ chunks: new Map(),
    /** @type {Record<string, any>} */ src: {},
    /** @type {any} */ mat: null,
    rTree: 90000,
    rSmall: 38000,
    rNear: 19000,
    rModel: 13000,
    built: 0,
    /** Шаблоны из файлов: вид → [{ mesh, fit, h }]. @type {Record<string, any[]>} */ models: {},
    /** Шаблоны покрова: вид → меш. @type {Record<string, any>} */ coverTpl: {},
    /** Чанки покрова у камеры (ячейка декора). @type {Map<string, any>} */ cover: new Map(),
    /** @type {any[]} */ coverRules: [],
    /** @type {any} */ coverMat: null,
    rCover: 0,

    /** Загрузить модели видов декора этого биома (под экраном загрузки). Ошибка — остаётся процедурная модель. */
    async loadModels() {
        const V = this.V;
        if (!V || typeof Model3D === 'undefined' || !V.gw.hasDecor()) return;
        await Promise.all(Object.keys(WVIEW_DECOR_MODELS).map(async (kind) => {
            const defs = /** @type {any} */ (WVIEW_DECOR_MODELS)[kind](V.gw.biome), list = [];
            for (const d of defs) {
                try {
                    const root = Model3D.build(await Model3D.load(d.url), V.scene, { name: 'wd-model-' + kind });
                    const part = /** @type {any[]} */ (root.getChildMeshes(false)).find(m => m.getTotalVertices() > 0);
                    if (!part) { root.dispose(false, false); continue; }
                    if (part.material) part.material.dispose(false, false);
                    part.parent = null;
                    root.dispose(false, false);
                    part.material = this.mat;
                    part.isVisible = false; part.isPickable = false;
                    list.push({ mesh: part, fit: d.fit, h: d.h });
                } catch (e) { console.warn('WorldDecor: модель ' + d.url + ' не загрузилась — ' + ((e && e.message) || e)); }
            }
            if (list.length) this.models[kind] = list;
        }));
        this.coverRules = V.gw.coverRules();
        const kinds = [...new Set(this.coverRules.map((r) => r.kind))];
        await Promise.all(kinds.map(async (kind) => {
            try {
                const root = Model3D.build(await Model3D.load(/** @type {any} */ (WVIEW_COVER_MODELS)[kind]), V.scene, { name: 'wd-cover-' + kind });
                const part = /** @type {any[]} */ (root.getChildMeshes(false)).find(m => m.getTotalVertices() > 0);
                if (!part) { root.dispose(false, false); return; }
                if (part.material) part.material.dispose(false, false);
                part.parent = null;
                root.dispose(false, false);
                part.material = this.coverMat;
                part.isVisible = false; part.isPickable = false;
                this.coverTpl[kind] = part;
            } catch (e) { console.warn('WorldDecor: покров ' + kind + ' не загрузился — ' + ((e && e.message) || e)); }
        }));
    },

    init(V) {
        this.dispose();
        this.V = V;
        const m = new BABYLON.StandardMaterial('wd-decor', V.scene);
        m.diffuseColor = new BABYLON.Color3(1, 1, 1);
        m.specularColor = new BABYLON.Color3(0, 0, 0);
        m.backFaceCulling = true;
        V.mats['wd-decor'] = m;
        this.mat = m;
        const cm = new BABYLON.StandardMaterial('wd-cover', V.scene);
        cm.diffuseColor = new BABYLON.Color3(1, 1, 1);
        cm.specularColor = new BABYLON.Color3(0, 0, 0);
        cm.backFaceCulling = false;   // листья травы — одиночные треугольники
        cm.twoSidedLighting = true;
        V.mats['wd-cover'] = cm;
        this.coverMat = cm;
        this.requality();
    },

    requality() {
        const V = this.V;
        if (!V) return;
        const q = V.quality, mob = typeof IS_MOBILE !== 'undefined' && IS_MOBILE;
        this.rTree = (mob ? 32000 : q >= 2 ? 90000 : q === 1 ? 62000 : 36000);
        this.rSmall = (mob ? 14000 : q >= 2 ? 38000 : q === 1 ? 26000 : 16000);
        this.rNear = (mob ? 9000 : q >= 2 ? 19000 : 14000);
        this.rModel = (mob ? 6000 : q >= 2 ? 13000 : 9000);      // камни и кусты: дальше — простая процедурная модель
        this.rCover = (mob ? 4800 : q >= 2 ? 15000 : q === 1 ? 10500 : 6800);   // трава у земли: только рядом с камерой
        for (const c of this.chunks.values()) this._free(c);
        this.chunks.clear();
        this._coverFree();
    },

    dispose() {
        for (const c of this.chunks.values()) this._free(c);
        this.chunks.clear();
        this._coverFree();
        for (const k in this.coverTpl) { try { this.coverTpl[k].dispose(false, false); } catch (e) { /* ok */ } }
        this.coverTpl = {}; this.coverRules = [];
        if (this.coverMat) { try { this.coverMat.dispose(false, false); } catch (e) { /* ok */ } this.coverMat = null; }
        for (const k in this.src) { const s = this.src[k]; for (const m of [s.near, s.far]) if (m) { try { m.dispose(false, false); } catch (e) { /* ok */ } } }
        this.src = {};
        for (const k in this.models) for (const t of this.models[k]) { try { t.mesh.dispose(false, false); } catch (e) { /* ok */ } }
        this.models = {};
        if (this.mat) { try { this.mat.dispose(false, false); } catch (e) { /* ok */ } this.mat = null; }
        this.V = null;
    },

    _coverFree() {
        for (const c of this.cover.values()) for (const m of c) { try { m.dispose(false, false); } catch (e) { /* ok */ } }
        this.cover.clear();
    },

    /** Покров вокруг камеры: по одной ячейке за кадр от ближних к дальним (при загрузке — все), дальние освобождаются. */
    _coverUpdate(cam, initial) {
        if (!this.coverRules.length) return;
        const CS = WORLD_DECOR_CELL, R = this.rCover;
        const i0 = Math.floor((cam.x - R) / CS), i1 = Math.floor((cam.x + R) / CS), j0 = Math.floor((cam.z - R) / CS), j1 = Math.floor((cam.z + R) / CS);
        let best = null, bestD = Infinity;
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
            const key = i + ':' + j;
            if (this.cover.has(key)) continue;
            const d = Math.hypot((i + 0.5) * CS - cam.x, (j + 0.5) * CS - cam.z);
            if (d - CS * 0.75 > R) continue;
            if (initial) this.cover.set(key, this._coverBuild(i, j));
            else if (d < bestD) { bestD = d; best = [i, j, key]; }
        }
        if (best) this.cover.set(/** @type {string} */ (best[2]), this._coverBuild(/** @type {number} */ (best[0]), /** @type {number} */ (best[1])));
        for (const [key, list] of this.cover) {
            const a = key.split(':'), d = Math.hypot((Number(a[0]) + 0.5) * CS - cam.x, (Number(a[1]) + 0.5) * CS - cam.z);
            if (d - CS * 0.75 > R * 1.3) { for (const m of list) { try { m.dispose(false, false); } catch (e) { /* ok */ } } this.cover.delete(key); }
        }
    },

    /** Покров ячейки (i, j): функция координат и сида, поэтому при возврате на место трава та же. */
    _coverBuild(i, j) {
        const gw = this.V.gw, CS = WORLD_DECOR_CELL, seed = gw.seed | 0, sparse = this.V.quality === 0 ? 0.6 : 1;
        const x0 = i * CS, z0 = j * CS, nrm = [0, 1, 0], c = { rel: 0, ny: 1, surf: '', forest: 0, park: 0 };
        /** @type {Record<string, any[]>} */ const by = {};
        for (const rule of this.coverRules) {
            if (!this.coverTpl[rule.kind]) continue;
            const n = Math.ceil(CS / rule.step), hs = seed + rule.seed * 131;
            for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
                const u = i * 64 + a, v = j * 64 + b;
                const x = x0 + (a + worldHash(u, v, hs + 7)) * rule.step, z = z0 + (b + worldHash(u, v, hs + 8)) * rule.step;
                if (x >= x0 + CS || z >= z0 + CS || worldHash(u, v, hs + 9) > 0.95 * sparse) continue;
                if (gw.edgeDist(x, z) < rule.clear) continue;
                const h = gw.heightAt(x, z);
                if (gw.sea >= 0 && h < gw.sea + 60) continue;
                gw.normalAt(x, z, nrm);
                const sf = gw.surfaceAt(x, z);
                if (sf.onRoad) continue;
                c.ny = nrm[1]; c.rel = h / Math.max(1, gw.relief); c.surf = sf.name; c.forest = gw.forestMask(x, z);
                c.park = gw.biome === 'city' ? gw.groundWeights(x, z, h, nrm[1])[0] : 0;
                if (!(worldHash(u, v, hs + 10) < rule.prob(c))) continue;
                (by[rule.kind] || (by[rule.kind] = [])).push({ x, y: h, z, u, v, hs, rule });
            }
        }
        const list = [];
        for (const kind of Object.keys(by)) {
            const items = by[kind], cnt = items.length, H = /** @type {any} */ (WVIEW_COVER_HEIGHT)[kind];
            const mat = new Float32Array(cnt * 16), col = new Float32Array(cnt * 4);
            for (let k = 0; k < cnt; k++) {
                const it = items[k], r = it.rule, o = k * 16, sc = r.scale;
                const S = sc[0] + (sc[1] - sc[0]) * worldHash(it.u, it.v, it.hs + 11), yaw = worldHash(it.u, it.v, it.hs + 12) * Math.PI * 2;
                const cy = Math.cos(yaw) * S, sy = Math.sin(yaw) * S, t = 0.82 + worldHash(it.u, it.v, it.hs + 13) * 0.32, tint = r.tint;
                mat[o] = cy; mat[o + 2] = -sy; mat[o + 5] = S; mat[o + 8] = sy; mat[o + 10] = cy; mat[o + 12] = it.x; mat[o + 13] = it.y - H * 0.03; mat[o + 14] = it.z; mat[o + 15] = 1;
                col[k * 4] = tint[0] * t; col[k * 4 + 1] = tint[1] * t; col[k * 4 + 2] = tint[2] * t; col[k * 4 + 3] = 1;
            }
            const m = this.coverTpl[kind].clone('wd-cover-' + kind + '-' + i + '_' + j);
            m.makeGeometryUnique();
            m.isVisible = true; m.isPickable = false; m.receiveShadows = false; m.alwaysSelectAsActiveMesh = false;
            m.thinInstanceSetBuffer('matrix', mat, 16, true);
            m.thinInstanceSetBuffer('color', col, 4, true);
            m.thinInstanceRefreshBoundingInfo(true);
            list.push(m);
        }
        return list;
    },

    _free(c) {
        for (const m of c.meshes) { try { if (m.metadata && m.metadata.cast) this.V.view.removeShadowCaster(m); } catch (e) { /* ok */ } try { m.dispose(false, false); } catch (e) { /* ok */ } }
        c.meshes = [];
    },

    /** Исходные меши вида (невидимые): клоны делят геометрию. */
    _source(kind) {
        let s = this.src[kind];
        if (s) return s;
        const scene = this.V.scene;
        const mk = (far) => {
            const g = WorldGeo.decorModel(kind, far);
            const mesh = g.toMesh(scene, 'wd-' + kind + (far ? '-far' : ''), this.mat, { uvs: false });
            if (mesh) { mesh.isVisible = false; mesh.isPickable = false; }
            return mesh;
        };
        const near = mk(false);
        s = this.src[kind] = { near, far: kind === 'spruce' || kind === 'oak' || kind === 'poplar' ? mk(true) : null };
        return s;
    },

    _scale(it) {
        switch (it.kind) {
            case 'rock': return it.r * 1.3;
            case 'bush': return it.h * 1.7;
            default: return it.h;
        }
    },

    /** Чанки вокруг камеры: строятся по одному за вызов (кроме первого прохода), дальние освобождаются. */
    update(cam, initial) {
        const V = this.V;
        if (!V || !V.gw.active || !V.gw.hasDecor()) return;
        const CS = WORLD_DECOR_CELL * WVIEW_DECOR_CHUNK;
        const R = initial ? Math.min(this.rTree, this.rNear + CS * 1.2) : this.rTree;   // при загрузке — только ближнее, остальное подтянется в кадрах
        const i0 = Math.floor((cam.x - R) / CS), i1 = Math.floor((cam.x + R) / CS), j0 = Math.floor((cam.z - R) / CS), j1 = Math.floor((cam.z + R) / CS);
        let budget = initial ? 1e9 : 2;
        // ближние чанки — первыми
        /** @type {number[][]} */ const need = [];
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
            const cx = (i + 0.5) * CS, cz = (j + 0.5) * CS, d = Math.hypot(cx - cam.x, cz - cam.z);
            if (d - CS * 0.75 > R) continue;
            need.push([i, j, d]);
        }
        need.sort((a, b) => a[2] - b[2]);
        for (const [i, j, d] of need) {
            const key = i + ':' + j;
            let c = this.chunks.get(key);
            if (!c) {
                if (budget <= 0) continue;
                budget--;
                c = this._build(i, j);
                this.chunks.set(key, c);
            }
            this._lod(c, d);
        }
        // освободить дальние
        for (const [key, c] of this.chunks) {
            const d = Math.hypot(c.cx - cam.x, c.cz - cam.z);
            if (d - CS * 0.75 > R * 1.25) { this._free(c); this.chunks.delete(key); }
        }
        this._coverUpdate(cam, initial);
    },

    /** Чанк (i, j): ячейки декора → матрицы по видам. */
    _build(i, j) {
        const V = this.V, gw = V.gw, n = WVIEW_DECOR_CHUNK, CS = WORLD_DECOR_CELL;
        /** @type {Record<string, any[]>} */ const by = {};
        for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
            const cell = gw.decorCell(i * n + a, j * n + b);
            for (const it of cell.items) {
                // вариант модели — функция координат: вид не зависит от порядка постройки чанков
                const tpl = this.models[it.kind], v = tpl ? Math.floor(worldHash(Math.round(it.x), Math.round(it.z), 77) * tpl.length) : 0;
                const key = it.kind + '#' + v;
                (by[key] || (by[key] = [])).push(it);
            }
        }
        const c = { i, j, cx: (i + 0.5) * n * CS, cz: (j + 0.5) * n * CS, meshes: [], kinds: [] };
        for (const key of Object.keys(by)) {
            const list = by[key], cnt = list.length, kind = list[0].kind;
            const tpl = this.models[kind] ? this.models[kind][Number(key.split('#')[1])] : null;
            const mat = new Float32Array(cnt * 16), colr = new Float32Array(cnt * 4);
            for (let k = 0; k < cnt; k++) {
                const it = list[k], S = tpl ? (tpl.fit === 'r' ? it.r * 1.3 : it.h) / tpl.h : this._scale(it), cy = Math.cos(it.yaw) * S, sy = Math.sin(it.yaw) * S, o = k * 16;
                mat[o] = cy; mat[o + 2] = -sy; mat[o + 5] = S; mat[o + 8] = sy; mat[o + 10] = cy; mat[o + 12] = it.x; mat[o + 13] = it.y; mat[o + 14] = it.z; mat[o + 15] = 1;
                const t = 0.84 + worldHash(k, i * 7 + j, gw.seed + 606) * 0.3;
                colr[k * 4] = t; colr[k * 4 + 1] = t * (0.95 + worldHash(k, 3, 607) * 0.1); colr[k * 4 + 2] = t; colr[k * 4 + 3] = 1;
            }
            const src = this._source(kind);
            const rec = { kind, near: null, far: null, nearOn: false, farOn: false };
            for (const which of ['near', 'far']) {
                // модель из файла — только вблизи; дальше у деревьев их дальняя модель, у остальных — процедурная
                const s = which === 'near' && tpl ? tpl.mesh : which === 'far' && tpl && !src.far ? src.near : src[which];
                if (!s) continue;
                const m = s.clone('wd-' + key + '-' + which + '-' + i + '_' + j);
                m.makeGeometryUnique();   // буфер матриц thin instances лежит в Geometry: у каждого чанка — свой
                m.isVisible = true;
                m.thinInstanceSetBuffer('matrix', which === 'far' && tpl ? this._farMatrices(list) : mat, 16, true);
                m.thinInstanceSetBuffer('color', colr, 4, true);
                m.thinInstanceRefreshBoundingInfo(true);
                m.isPickable = false;
                m.receiveShadows = false;
                m.alwaysSelectAsActiveMesh = false;
                m.setEnabled(false);
                m.metadata = { cast: which === 'near' && kind !== 'bush' };
                if (m.metadata.cast) V.view.addShadowCaster(m, false);
                c.meshes.push(m);
                rec[which] = m;
            }
            c.kinds.push(rec);
        }
        return c;
    },

    /** Матрицы дальней (единичной) модели для тех же предметов, когда ближняя — из файла. */
    _farMatrices(list) {
        const mat = new Float32Array(list.length * 16);
        for (let k = 0; k < list.length; k++) {
            const it = list[k], S = this._scale(it), cy = Math.cos(it.yaw) * S, sy = Math.sin(it.yaw) * S, o = k * 16;
            mat[o] = cy; mat[o + 2] = -sy; mat[o + 5] = S; mat[o + 8] = sy; mat[o + 10] = cy; mat[o + 12] = it.x; mat[o + 13] = it.y; mat[o + 14] = it.z; mat[o + 15] = 1;
        }
        return mat;
    },

    _lod(c, d) {
        const de = Math.max(0, d - WORLD_DECOR_CELL * WVIEW_DECOR_CHUNK * 0.72);
        for (const r of c.kinds) {
            const small = !(r.kind === 'spruce' || r.kind === 'oak' || r.kind === 'poplar');
            const R = small ? this.rSmall : this.rTree;
            const edge = small ? (r.far ? this.rModel : R) : this.rNear;
            const wantNear = de < edge;
            const wantFar = de >= edge && de < R;
            if (r.near && wantNear !== r.nearOn) { r.near.setEnabled(wantNear); r.nearOn = wantNear; }
            if (r.far && wantFar !== r.farOn) { r.far.setEnabled(wantFar); r.farOn = wantFar; }
        }
    },
};
