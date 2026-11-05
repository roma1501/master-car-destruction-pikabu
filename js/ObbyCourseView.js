// ObbyCourseView.js — вид трассы ObbyCourse в сцене Babylon: детали рисуются кодом (модели из папки деталей нужны
// только редактору как превью). Статика слита в пачки по участкам карты (OBBY_CHUNK) и материалам — мало draw calls;
// подвижные детали (move, fall, spin, spinner, hammer) — свои меши со своей позой из ObbyCourse.current(p). Флаги
// чекпоинтов, арка финиша и площадка старта — маркеры карты. Решений вид не принимает: физика и опасности — ObbyCourse.
//
//   await app.loadMap('course', { prepare: app => { ObbyCourse.build(app.location.map); ObbyCourseView.build(app, ObbyCourse, { hideGround: true }); } });
//   app.onUpdate(dt => { ObbyCourse.update(dt); ObbyCourseView.update(dt, { x: hero.x, z: hero.z }); });
//   ObbyCourseView.setStage(stage);       // взятые чекпоинты — зелёные флаги
//   ObbyCourseView.stats();               // { chunks, dynamic, triangles, materials } — для проверки draw calls
// opts: { hideGround (скрыть землю карты — трасса висит в небе), markers (флаги и арка, по умолчанию да), side (цвет боков плит),
//         viewDist (дальше этого px подвижные детали не двигают меши, по умолчанию 16000), ink (контур рёбер, по умолчанию нет) }.
// Нет холста для текстур (тест, сборка без DOM) — плиты ровного цвета: сцена не падает.

/** @satisfies {Record<string, any>} */
const ObbyCourseView = {
    /** @type {any} */ view: null,
    /** @type {any} */ course: null,
    /** @type {any[]} */ meshes: [],
    /** @type {any[]} */ nodes: [],
    /** @type {any[]} */ flags: [],
    /** @type {Record<string, any>} */ mats: {},
    /** @type {any} */ opts: {},
    _stage: 0,
    _tris: 0,

    // ---------------------------------------------------------------------------------------------
    // Постройка
    // ---------------------------------------------------------------------------------------------

    /** Снести прежний вид и построить вид трассы course (ObbyCourse.build уже вызван). */
    build(app, course, opts) {
        this.clear();
        this.opts = opts || {};
        const view = this.view = app.location.view;
        this.course = course || ObbyCourse;
        this._makeMaterials(view.scene);
        if (this.opts.hideGround) this.hideGround(app.location.terrain);
        const chunk = typeof OBBY_CHUNK !== 'undefined' ? OBBY_CHUNK : 5000;
        /** @type {Map<string, any>} */
        const chunks = new Map();
        for (const p of this.course.pieces) {
            if (p.type === 'arrow') { this._addArrow(view, p); continue; }
            if (p.dynamic) { this._buildDynamic(view, p); continue; }
            const key = Math.floor(p.O[0] / chunk) + ',' + Math.floor(p.O[2] / chunk);
            let b = chunks.get(key);
            if (!b) { b = this._builder(); chunks.set(key, b); }
            b.setTransform(p.O, p.ax, p.ay, p.az);
            this._geometry(b, p);
        }
        for (const b of chunks.values()) for (const mesh of b.toMeshes(view.scene, this.mats, 'course')) { this._register(view, mesh, true); this._tris += mesh.getTotalIndices() / 3; }
        if (this.opts.markers !== false) this._buildMarkers(view);
        this.setStage(0);
        this.update(0);
        return this;
    },

    clear() {
        const view = this.view;
        for (const m of this.meshes) { try { if (view) World3D.removeObject(view, m); else m.dispose(); } catch (e) { /* уже снят */ } }
        for (const k in this.mats) { try { this.mats[k].dispose(false, true); } catch (e) { /* уже */ } }
        this.meshes = []; this.nodes = []; this.flags = []; this.mats = {}; this._tris = 0; this._stage = 0;
    },

    /** Земля карты — вспомогательная для редактора: в небесном мире её нет. */
    hideGround(terrainObj) {
        const terrain = /** @type {any} */ (terrainObj);
        if (!terrain) return;
        for (const m of terrain.meshes || []) if (m && m.setEnabled) m.setEnabled(false);
        for (const m of [terrain.mesh, terrain.outer]) if (m && m.setEnabled) m.setEnabled(false);
        for (const w of terrain.waters || []) if (w && w.mesh && w.mesh.setEnabled) w.mesh.setEnabled(false);
    },

    /** Сколько мешей и треугольников вышло (draw calls ≈ chunks + dynamic + маркеры). */
    stats() {
        return { chunks: this.meshes.filter(m => m.metadata && m.metadata.obbyStatic).length, dynamic: this.nodes.length, flags: this.flags.length,
            triangles: Math.round(this._tris), materials: Object.keys(this.mats).length };
    },

    _register(view, mesh, isStatic) {
        mesh.isPickable = false;
        if (isStatic) { mesh.freezeWorldMatrix(); mesh.doNotSyncBoundingInfo = true; mesh.metadata = Object.assign({}, mesh.metadata, { obbyStatic: true }); }
        World3D.addObject(view, mesh, 'prop', { outline: false, ink: !!this.opts.ink });
        this.meshes.push(mesh);
        return mesh;
    },

    // ---------------------------------------------------------------------------------------------
    // Материалы
    // ---------------------------------------------------------------------------------------------

    _makeMaterials(scene) {
        const hex = (h) => BABYLON.Color3.FromHexString('#' + Number(h).toString(16).padStart(6, '0'));
        const std = (name, color) => {
            const m = new BABYLON.StandardMaterial('course-' + name, scene);
            m.diffuseColor = color != null ? hex(color) : new BABYLON.Color3(1, 1, 1);
            m.specularColor = new BABYLON.Color3(0.06, 0.06, 0.06);
            m.backFaceCulling = false;
            this.mats[name] = m;
            return m;
        };
        // Текстура рисуется на холсте; нет холста (тест, окружение без DOM) — null, материал остаётся цветом.
        const tex = (name, size, draw) => {
            try {
                const t = new BABYLON.DynamicTexture('course-tex-' + name, { width: size, height: size }, scene, true);
                const ctx = /** @type {CanvasRenderingContext2D} */ (/** @type {any} */ (t.getContext()));
                if (!ctx) { t.dispose(); return null; }
                draw(ctx, size);
                t.update(true);
                t.wrapU = t.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
                t.anisotropicFilteringLevel = 8;
                return t;
            } catch (e) { return null; }
        };
        const mixc = (h1, h2, k) => { const c1 = [(h1 >> 16) & 255, (h1 >> 8) & 255, h1 & 255], c2 = [(h2 >> 16) & 255, (h2 >> 8) & 255, h2 & 255]; return 'rgb(' + c1.map((v, i) => Math.round(v + (c2[i] - v) * k)).join(',') + ')'; };
        const colors = this.course.COLORS;
        for (const name of Object.keys(colors)) {
            const [a, b] = colors[name];
            const m = std('top:' + name, null);
            m.diffuseColor = hex(a);
            const t = tex(name, 512, (ctx, n) => {
                // дорожная плитка: 2×2 плиты чуть разного тона, швы, мелкое зерно
                let seed = 1 + name.length * 977;
                const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
                const half = n / 2;
                for (let ty = 0; ty < 2; ty++) for (let tx = 0; tx < 2; tx++) { ctx.fillStyle = mixc(a, b, (tx + ty) % 2 ? 0.28 : 0.08); ctx.fillRect(tx * half, ty * half, half, half); }
                for (let i = 0; i < 2600; i++) {
                    const x = rnd() * n, y = rnd() * n, r = 0.6 + rnd() * 1.6;
                    ctx.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.09)';
                    ctx.fillRect(x, y, r, r);
                }
                ctx.fillStyle = 'rgba(20,16,40,0.22)';
                for (const k of [0, half]) { ctx.fillRect(k, 0, 3, n); ctx.fillRect(0, k, n, 3); }
                ctx.fillStyle = 'rgba(255,255,255,0.18)';
                for (const k of [0, half]) { ctx.fillRect(k + 3, 0, 1.5, n); ctx.fillRect(0, k + 3, n, 1.5); }
            });
            if (t) { m.diffuseTexture = t; m.diffuseColor = new BABYLON.Color3(1, 1, 1); }
            if (name === 'ice') { m.specularColor = new BABYLON.Color3(0.7, 0.8, 0.9); m.specularPower = 48; }
        }
        std('side', this.opts.side != null ? this.opts.side : 0x2c3a5c);
        // лава (kill и lava): неоновая, переливается; вода — полупрозрачная
        const lava = std('kill', 0xff4a1c);
        lava.emissiveColor = new BABYLON.Color3(0.9, 0.25, 0.05);
        const lt = tex('lava', 256, (ctx, n) => {
            ctx.fillStyle = '#ff5a1a'; ctx.fillRect(0, 0, n, n);
            let seed = 7;
            const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
            for (let i = 0; i < 60; i++) {
                const x = rnd() * n, y = rnd() * n, r = 8 + rnd() * 26;
                const g = ctx.createRadialGradient(x, y, 0, x, y, r);
                g.addColorStop(0, '#ffe36b'); g.addColorStop(1, 'rgba(255,120,30,0)');
                ctx.fillStyle = g;
                for (const dx of [-n, 0, n]) for (const dy of [-n, 0, n]) { ctx.beginPath(); ctx.arc(x + dx, y + dy, r, 0, Math.PI * 2); ctx.fill(); }
            }
        });
        if (lt) { lava.diffuseTexture = lt; lava.diffuseColor = new BABYLON.Color3(1, 1, 1); }
        lava.metadata = { toon: false };
        const water = std('water', 0x2a8fe0);
        water.emissiveColor = new BABYLON.Color3(0.05, 0.2, 0.35);
        water.alpha = 0.72;
        water.metadata = { toon: false };
        const boost = std('boost', 0x20c4ff);
        boost.emissiveColor = new BABYLON.Color3(0.35, 0.35, 0.35);
        const bt = tex('boost', 256, (ctx, n) => {
            ctx.fillStyle = '#20c4ff'; ctx.fillRect(0, 0, n, n);
            ctx.fillStyle = '#fff36a'; ctx.strokeStyle = '#1b1240'; ctx.lineWidth = 8;
            for (const ox of [0, n / 2]) {
                ctx.beginPath();
                ctx.moveTo(ox + n * 0.06, n * 0.14); ctx.lineTo(ox + n * 0.3, n * 0.5); ctx.lineTo(ox + n * 0.06, n * 0.86);
                ctx.lineTo(ox + n * 0.2, n * 0.86); ctx.lineTo(ox + n * 0.44, n * 0.5); ctx.lineTo(ox + n * 0.2, n * 0.14); ctx.closePath();
                ctx.fill(); ctx.stroke();
            }
        });
        if (bt) { boost.diffuseTexture = bt; boost.diffuseColor = new BABYLON.Color3(1, 1, 1); }
        const jump = std('jump', 0xff4fa3);
        jump.emissiveColor = new BABYLON.Color3(0.2, 0.2, 0.2);
        const jt = tex('jump', 256, (ctx, n) => {
            for (let i = 6; i > 0; i--) {
                ctx.fillStyle = i % 2 ? '#ff4fa3' : '#ffffff';
                ctx.beginPath(); ctx.arc(n / 2, n / 2, n / 2 * i / 6, 0, Math.PI * 2); ctx.fill();
            }
        });
        if (jt) { jump.diffuseTexture = jt; jump.diffuseColor = new BABYLON.Color3(1, 1, 1); }
        std('jumpside', 0x46d65a);
        std('pillar', 0xff3b4e);
        std('wood', 0xc98a4b);
        std('post', 0x8b93a8);
        std('bar', 0xff8c1a);
        std('arm', 0x9fb4c8);
        std('head', 0xd9893a);
        std('pivot', 0x3b3560);
        // маркеры: флаг чекпоинта (не взят / взят), столб, кольцо, арка финиша
        const off = std('flag-off', 0xc9ced8); off.emissiveColor = new BABYLON.Color3(0.15, 0.15, 0.17);
        const on = std('flag-on', 0x44e07a); on.emissiveColor = new BABYLON.Color3(0.1, 0.45, 0.2);
        std('flag-pole', 0xe8eaf0);
        const ring = std('flag-ring', 0xffffff); ring.emissiveColor = new BABYLON.Color3(0.5, 0.5, 0.55); ring.alpha = 0.45; ring.metadata = { toon: false };
        const checker = std('checker', 0xffffff);
        const ct = tex('checker', 128, (ctx, n) => {
            for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { ctx.fillStyle = (x + y) % 2 ? '#14141c' : '#ffffff'; ctx.fillRect(x * n / 4, y * n / 4, n / 4, n / 4); }
        });
        if (ct) checker.diffuseTexture = ct;
        std('start', 0x35c46b);
    },

    // ---------------------------------------------------------------------------------------------
    // Геометрия деталей (локально, px; X вперёд, Y вверх, Z вправо)
    // ---------------------------------------------------------------------------------------------

    _builder() {
        /** @type {Record<string, { pos: number[], nrm: number[], uv: number[], idx: number[] }>} */
        const bufs = {};
        let O = [0, 0, 0], AX = [1, 0, 0], AY = [0, 1, 0], AZ = [0, 0, 1];
        const tp = (p) => [O[0] + p[0] * AX[0] + p[1] * AY[0] + p[2] * AZ[0], O[1] + p[0] * AX[1] + p[1] * AY[1] + p[2] * AZ[1], O[2] + p[0] * AX[2] + p[1] * AY[2] + p[2] * AZ[2]];
        const tn = (n) => [n[0] * AX[0] + n[1] * AY[0] + n[2] * AZ[0], n[0] * AX[1] + n[1] * AY[1] + n[2] * AZ[1], n[0] * AX[2] + n[1] * AY[2] + n[2] * AZ[2]];
        const buf = (key) => bufs[key] || (bufs[key] = { pos: [], nrm: [], uv: [], idx: [] });
        const api = {
            setTransform(o, ax, ay, az) { O = o; AX = ax; AY = ay; AZ = az; },
            /** Многоугольник (выпуклый, по кругу): точки, нормали (одна на всё или на точку), uv. */
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
        return api;
    },

    _tile() { return (typeof OBBY_TILE !== 'undefined' ? OBBY_TILE : 240) * 2; },

    _geometry(b, p) {
        const S = this._tile();
        const known = this.course.COLORS;
        const top = p.color && known[p.color] ? 'top:' + p.color : 'top:white';
        const hx = p.sx / 2, hz = p.sz / 2;
        switch (p.type) {
            case 'box': this._box(b, hx, -p.sy, 0, hz, top, 'side', S); break;
            case 'kill': case 'lava': this._box(b, hx, -p.sy, 0, hz, 'kill', 'kill', S); break;
            case 'water': this._box(b, hx, -p.sy, 0, hz, 'water', 'water', S); break;
            case 'cyl': this._cyl(b, hx, hz, -p.sy, 0, 30, top, 'side', S); break;
            case 'ramp': this._wedge(b, hx, p.sy, hz, top, 'side', S); break;
            case 'arch': this._arch(b, hx, p.sy, hz, 28, top, 'side', S); break;
            case 'boost': this._box(b, hx, 0, 5, hz, 'boost', 'side', S); break;
            case 'jump': this._cyl(b, hx, hz, 0, 14, 30, 'jump', 'jumpside', p.sx); break;
            case 'pillar': this._box(b, hx, 0, p.sy, hz, 'pillar', 'pillar', S); break;
            case 'fence': this._fence(b, p.sx); break;
            case 'spinner': this._cyl(b, 20, 20, 0, p.sy + 26, 14, 'post', 'post', S); break;
            case 'hammer': this._box(b, 16, -16, 16, 16, 'pivot', 'pivot', S); break;
            default: this._box(b, hx, -p.sy, 0, hz, top, 'side', S);
        }
    },

    _box(b, hx, y0, y1, hz, topKey, sideKey, S) {
        const uvTop = (x, z) => [(x + hx) / S, (z + hz) / S];
        b.poly(topKey, [[-hx, y1, -hz], [-hx, y1, hz], [hx, y1, hz], [hx, y1, -hz]], [0, 1, 0],
            [uvTop(-hx, -hz), uvTop(-hx, hz), uvTop(hx, hz), uvTop(hx, -hz)]);
        const k = 1 / S;
        b.poly(sideKey, [[-hx, y0, -hz], [hx, y0, -hz], [hx, y0, hz], [-hx, y0, hz]], [0, -1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
        b.poly(sideKey, [[hx, y0, -hz], [hx, y1, -hz], [hx, y1, hz], [hx, y0, hz]], [1, 0, 0], [[0, y0 * k], [0, y1 * k], [2 * hz * k, y1 * k], [2 * hz * k, y0 * k]]);
        b.poly(sideKey, [[-hx, y0, hz], [-hx, y1, hz], [-hx, y1, -hz], [-hx, y0, -hz]], [-1, 0, 0], [[0, y0 * k], [0, y1 * k], [2 * hz * k, y1 * k], [2 * hz * k, y0 * k]]);
        b.poly(sideKey, [[hx, y0, hz], [hx, y1, hz], [-hx, y1, hz], [-hx, y0, hz]], [0, 0, 1], [[0, y0 * k], [0, y1 * k], [2 * hx * k, y1 * k], [2 * hx * k, y0 * k]]);
        b.poly(sideKey, [[-hx, y0, -hz], [-hx, y1, -hz], [hx, y1, -hz], [hx, y0, -hz]], [0, 0, -1], [[0, y0 * k], [0, y1 * k], [2 * hx * k, y1 * k], [2 * hx * k, y0 * k]]);
    },

    _cyl(b, rx, rz, y0, y1, seg, topKey, sideKey, S) {
        const ring = [];
        for (let i = 0; i < seg; i++) { const a = i / seg * Math.PI * 2; ring.push([Math.cos(a), Math.sin(a)]); }
        const uv = (x, z) => [(x + rx) / S, (z + rz) / S];
        b.poly(topKey, ring.map(([c, s]) => [c * rx, y1, s * rz]).reverse(), [0, 1, 0], ring.map(([c, s]) => uv(c * rx, s * rz)).reverse());
        b.poly(sideKey, ring.map(([c, s]) => [c * rx, y0, s * rz]), [0, -1, 0], ring.map(([c, s]) => uv(c * rx, s * rz)));
        for (let i = 0; i < seg; i++) {
            const [c0, s0] = ring[i], [c1, s1] = ring[(i + 1) % seg];
            const n0 = [c0 / rx, 0, s0 / rz], n1 = [c1 / rx, 0, s1 / rz];
            const l0 = Math.hypot(n0[0], n0[2]), l1 = Math.hypot(n1[0], n1[2]);
            b.poly(sideKey, [[c0 * rx, y0, s0 * rz], [c0 * rx, y1, s0 * rz], [c1 * rx, y1, s1 * rz], [c1 * rx, y0, s1 * rz]],
                [[n0[0] / l0, 0, n0[2] / l0], [n0[0] / l0, 0, n0[2] / l0], [n1[0] / l1, 0, n1[2] / l1], [n1[0] / l1, 0, n1[2] / l1]],
                [[i / seg, 0], [i / seg, 1], [(i + 1) / seg, 1], [(i + 1) / seg, 0]]);
        }
    },

    _wedge(b, hx, sy, hz, topKey, sideKey, S) {
        const len = Math.hypot(2 * hx, sy);
        const n = [-sy / len, 2 * hx / len, 0];
        b.poly(topKey, [[-hx, 0, -hz], [-hx, 0, hz], [hx, sy, hz], [hx, sy, -hz]], n,
            [[0, 0], [0, 2 * hz / S], [len / S, 2 * hz / S], [len / S, 0]]);
        b.poly(sideKey, [[-hx, 0, -hz], [hx, 0, -hz], [hx, 0, hz], [-hx, 0, hz]], [0, -1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
        b.poly(sideKey, [[hx, 0, -hz], [hx, sy, -hz], [hx, sy, hz], [hx, 0, hz]], [1, 0, 0], [[0, 0], [0, 1], [1, 1], [1, 0]]);
        b.poly(sideKey, [[-hx, 0, hz], [hx, 0, hz], [hx, sy, hz]], [0, 0, 1], [[0, 0], [1, 0], [1, 1]]);
        b.poly(sideKey, [[-hx, 0, -hz], [hx, sy, -hz], [hx, 0, -hz]], [0, 0, -1], [[0, 0], [1, 1], [1, 0]]);
    },

    _arch(b, hx, sy, hz, seg, topKey, sideKey, S) {
        const pts = [];
        let arc = 0;
        for (let i = 0; i <= seg; i++) {
            const X = -1 + 2 * i / seg, x = X * hx, y = sy * (0.5 + 0.5 * Math.cos(Math.PI * X));
            if (i) arc += Math.hypot(x - pts[i - 1].x, y - pts[i - 1].y);
            const slope = -0.5 * Math.PI * Math.sin(Math.PI * X) * sy / hx;   // dy/dx
            const l = Math.hypot(slope, 1);
            pts.push({ x, y, nx: -slope / l, ny: 1 / l, u: arc / S });
        }
        for (let i = 0; i < seg; i++) {
            const a = pts[i], c = pts[i + 1];
            b.poly(topKey, [[a.x, a.y, -hz], [a.x, a.y, hz], [c.x, c.y, hz], [c.x, c.y, -hz]],
                [[a.nx, a.ny, 0], [a.nx, a.ny, 0], [c.nx, c.ny, 0], [c.nx, c.ny, 0]],
                [[a.u, 0], [a.u, 2 * hz / S], [c.u, 2 * hz / S], [c.u, 0]]);
        }
        b.poly(sideKey, [[-hx, 0, -hz], [hx, 0, -hz], [hx, 0, hz], [-hx, 0, hz]], [0, -1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
        // бока — веером от середины низа (профиль невыпуклый у краёв, но звёздный относительно этой точки)
        const side = (zz, nz) => {
            for (let i = 0; i < seg; i++) {
                const a = pts[i], c = pts[i + 1];
                const tri = [[0, 0, zz], [a.x, a.y, zz], [c.x, c.y, zz]];
                b.poly(sideKey, nz > 0 ? tri : tri.reverse(), [0, 0, nz], [[0, 0], [a.x / S, a.y / S], [c.x / S, c.y / S]]);
            }
        };
        side(hz, 1); side(-hz, -1);
    },

    _fence(b, len) {
        const hx = len / 2, S = 200;
        const posts = Math.max(2, Math.round(len / 120) + 1);
        for (let i = 0; i < posts; i++) {
            const x = -hx + 6 + (len - 12) * i / (posts - 1);
            this._boxAt(b, x, 23, 6, 23, 6, 'wood', S);
        }
        this._boxAt(b, 0, 36, hx, 7, 4, 'wood', S);
        this._boxAt(b, 0, 14, hx, 6, 4, 'wood', S);
    },

    // Брус с центром (x, yc) в локальных осях детали: hx, hh, hz — полуразмеры.
    _boxAt(b, x, yc, hx, hh, hz, key, S) {
        const pts = (list) => list.map(([a, c, d]) => [a + x, c + yc, d]);
        const k = 1 / S;
        b.poly(key, pts([[-hx, hh, -hz], [-hx, hh, hz], [hx, hh, hz], [hx, hh, -hz]]), [0, 1, 0], [[0, 0], [0, 1], [1, 1], [1, 0]]);
        b.poly(key, pts([[-hx, -hh, -hz], [hx, -hh, -hz], [hx, -hh, hz], [-hx, -hh, hz]]), [0, -1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
        b.poly(key, pts([[hx, -hh, -hz], [hx, hh, -hz], [hx, hh, hz], [hx, -hh, hz]]), [1, 0, 0], [[0, 0], [0, 1], [1, 1], [1, 0]]);
        b.poly(key, pts([[-hx, -hh, hz], [-hx, hh, hz], [-hx, hh, -hz], [-hx, -hh, -hz]]), [-1, 0, 0], [[0, 0], [0, 1], [1, 1], [1, 0]]);
        b.poly(key, pts([[hx, -hh, hz], [hx, hh, hz], [-hx, hh, hz], [-hx, -hh, hz]]), [0, 0, 1], [[0, 0], [0, hh * k], [hx * k, hh * k], [hx * k, 0]]);
        b.poly(key, pts([[-hx, -hh, -hz], [-hx, hh, -hz], [hx, hh, -hz], [hx, -hh, -hz]]), [0, 0, -1], [[0, 0], [0, hh * k], [hx * k, hh * k], [hx * k, 0]]);
    },

    // ---------------------------------------------------------------------------------------------
    // Подвижные детали: свой корень, части в локальных осях; поза ставится в update
    // ---------------------------------------------------------------------------------------------

    _buildDynamic(view, p) {
        const scene = view.scene;
        const root = new BABYLON.Mesh('dyn-' + p.type, scene);
        root.rotationQuaternion = new BABYLON.Quaternion();
        const S = this._tile();
        const hx = p.sx / 2;
        const make = (fill, parent) => {
            const b = this._builder(); fill(b);
            for (const m of b.toMeshes(scene, this.mats, 'dyn')) { m.parent = parent || root; m.isPickable = false; }
        };
        let bar = null, arm = null;
        if (p.type === 'spinner') {
            make(b => this._cyl(b, 20, 20, 0, p.sy + 26, 14, 'post', 'post', S));
            bar = new BABYLON.Mesh('spinner-bar', scene);
            bar.parent = root;
            bar.rotationQuaternion = new BABYLON.Quaternion();
            const t = Math.max(16, p.sz / 2);
            make(b => this._boxAt(b, 0, p.sy, hx, t, t, 'bar', S), bar);
        } else if (p.type === 'hammer') {
            make(b => this._boxAt(b, 0, 0, 18, 18, 18, 'pivot', S));
            arm = new BABYLON.Mesh('hammer-swing', scene);
            arm.parent = root;
            arm.rotationQuaternion = new BABYLON.Quaternion();
            make(b => this._boxAt(b, 0, -p.sy / 2, 9, p.sy / 2, 9, 'arm', S), arm);
            const head = BABYLON.MeshBuilder.CreateCylinder('hammer-head', { diameter: p.sx, height: p.sz, tessellation: 20 }, scene);
            head.material = this.mats.head;
            head.parent = arm;
            head.rotation.x = Math.PI / 2;
            head.position.y = -p.sy;
            head.isPickable = false;
        } else {
            make(b => this._geometry(b, p));
        }
        World3D.addObject(view, root, 'prop', { outline: false, ink: !!this.opts.ink });
        this.meshes.push(root);
        this.nodes.push({ p, root, bar, arm });
    },

    // Парящая стрелка-подсказка: шеврон кодом; без коллизии.
    _addArrow(view, p) {
        const scene = view.scene;
        const root = new BABYLON.Mesh('arrow', scene);
        const b = this._builder();
        const w = 46, l = 70;
        // шеврон из двух выпуклых половин (у хвоста вырез)
        b.poly('boost', [[-l, 0, w], [-l * 0.1, 0, 0], [l * 0.9, 0, 0], [0, 0, w]], [0, 1, 0], [[0, 1], [0.45, 0.5], [1, 0.5], [0.5, 1]]);
        b.poly('boost', [[-l * 0.1, 0, 0], [-l, 0, -w], [0, 0, -w], [l * 0.9, 0, 0]], [0, 1, 0], [[0.45, 0.5], [0, 0], [0.5, 0], [1, 0.5]]);
        for (const m of b.toMeshes(scene, this.mats, 'arrow')) { m.parent = root; m.isPickable = false; }
        root.position.set(p.O[0], p.O[1], p.O[2]);
        root.rotationQuaternion = BABYLON.Quaternion.FromRotationMatrix(BABYLON.Matrix.FromValues(
            p.ax[0], p.ax[1], p.ax[2], 0, p.ay[0], p.ay[1], p.ay[2], 0, p.az[0], p.az[1], p.az[2], 0, 0, 0, 0, 1));
        root.rotate(BABYLON.Axis.X, -Math.PI / 2, BABYLON.Space.LOCAL);
        const s = Math.max(0.5, p.sx / 100);
        root.scaling.set(s, s, s);
        World3D.addObject(view, root, 'prop', { outline: false, castShadow: false });
        this.meshes.push(root);
        this.nodes.push({ p, root, bar: null, arm: null, arrow: true, baseH: p.O[1] });
    },

    // ---------------------------------------------------------------------------------------------
    // Маркеры: старт, флаги чекпоинтов, арка финиша
    // ---------------------------------------------------------------------------------------------

    _buildMarkers(view) {
        const scene = view.scene, C = this.course;
        const add = (mesh, castShadow) => { mesh.isPickable = false; World3D.addObject(view, mesh, 'prop', { outline: false, ink: false, castShadow: castShadow !== false }); this.meshes.push(mesh); return mesh; };
        const B = BABYLON.MeshBuilder;
        if (C.spawn) {
            const pad = B.CreateCylinder('spawn-pad', { diameter: 260, height: 6, tessellation: 28 }, scene);
            pad.material = this.mats.start;
            pad.position.set(C.spawn.x, C.spawn.y + 3, C.spawn.z);
            add(pad, false);
        }
        for (const cp of C.checkpoints) {
            const pole = B.CreateBox('cp-pole', { width: 12, height: 230, depth: 12 }, scene);
            pole.material = this.mats['flag-pole'];
            pole.position.set(cp.x, cp.y + 115, cp.z);
            const cloth = B.CreateBox('cp-flag', { width: 95, height: 58, depth: 5 }, scene);
            cloth.material = this.mats['flag-off'];
            cloth.parent = pole;                       // полотнище — ребёнок столба: регистрируются вместе
            cloth.position.set(52, 88, 0);
            add(pole);
            const ring = B.CreateCylinder('cp-ring', { diameter: Math.min(cp.r * 2, 700), height: 3, tessellation: 36 }, scene);
            ring.material = this.mats['flag-ring'];
            ring.position.set(cp.x, cp.y + 2, cp.z);
            add(ring, false);
            this.flags.push({ n: cp.n, cloth, ring, pole });
        }
        if (C.finish) {
            const f = C.finish, half = Math.min(f.r, 380);
            const L = BABYLON.Vector3, ca = Math.cos(f.yaw), sa = Math.sin(f.yaw);
            // арка поперёк курса: стойки по бокам линии, перекладина с шахматкой
            const px = -sa * half, pz = ca * half;
            for (const sgn of [-1, 1]) {
                const post = B.CreateBox('finish-post', { width: 20, height: 330, depth: 20 }, scene);
                post.material = this.mats['flag-pole'];
                post.position = new L(f.x + px * sgn, f.y + 165, f.z + pz * sgn);
                add(post);
            }
            const beam = B.CreateBox('finish-beam', { width: 28, height: 70, depth: half * 2 + 20 }, scene);
            beam.material = this.mats.checker;
            beam.position.set(f.x, f.y + 330, f.z);
            beam.rotation.y = -f.yaw;
            add(beam);
            const ring = B.CreateCylinder('finish-ring', { diameter: Math.min(f.r * 2, 800), height: 3, tessellation: 36 }, scene);
            ring.material = this.mats['flag-ring'];
            ring.position.set(f.x, f.y + 2, f.z);
            add(ring, false);
        }
    },

    /** Взятые этапы: флаги чекпоинтов n ≤ stage — зелёные. */
    setStage(stage) {
        this._stage = stage | 0;
        for (const f of this.flags) f.cloth.material = f.n <= this._stage ? this.mats['flag-on'] : this.mats['flag-off'];
    },

    // ---------------------------------------------------------------------------------------------
    // Кадр
    // ---------------------------------------------------------------------------------------------

    /** Кадр вида: позы подвижных деталей (в пределах viewDist от focus { x, z }), переливы лавы и ускорителей. */
    update(dt, focus) {
        const C = this.course;
        if (!C) return;
        const t = C.time, mats = this.mats;
        if (mats.boost && mats.boost.diffuseTexture) mats.boost.diffuseTexture.uOffset = -(t * 1.6) % 1;
        if (mats.kill) {
            const k = 0.75 + 0.25 * Math.sin(t * 4);
            mats.kill.emissiveColor.set(0.95 * k, 0.32 * k, 0.06 * k);
            if (mats.kill.diffuseTexture) { mats.kill.diffuseTexture.uOffset = (t * 0.05) % 1; mats.kill.diffuseTexture.vOffset = (t * 0.03) % 1; }
        }
        if (mats['flag-ring']) mats['flag-ring'].alpha = 0.35 + 0.15 * Math.sin(t * 3);
        const R = this.opts.viewDist != null ? this.opts.viewDist : 16000;
        for (const n of this.nodes) {
            const p = n.p;
            if (n.arrow) { n.root.position.y = n.baseH + Math.sin(t * 2.4 + p.O[0] * 0.01) * 14; continue; }
            if (focus && p.reach && (p.reach[3] < focus.x - R || p.reach[0] > focus.x + R || p.reach[5] < focus.z - R || p.reach[2] > focus.z + R)) continue;
            const pose = C.current(p);
            const O = pose.O, ax = pose.ax, ay = pose.ay, az = pose.az;
            n.root.position.set(O[0], O[1], O[2]);
            BABYLON.Quaternion.FromRotationMatrixToRef(BABYLON.Matrix.FromValues(ax[0], ax[1], ax[2], 0, ay[0], ay[1], ay[2], 0, az[0], az[1], az[2], 0, 0, 0, 0, 1), n.root.rotationQuaternion);
            if (n.bar) BABYLON.Quaternion.RotationAxisToRef(BABYLON.Axis.Y, pose.angle, n.bar.rotationQuaternion);
            if (n.arm) BABYLON.Quaternion.RotationAxisToRef(BABYLON.Axis.X, pose.angle, n.arm.rotationQuaternion);
            if (p.role === 'fall') n.root.setEnabled(p.fallState !== 'drop' || p.fallDrop < 2500);
        }
    },
};
