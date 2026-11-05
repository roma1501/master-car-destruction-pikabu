// CarSkin.js — вид повреждений: меш машины гнётся за сеткой SoftBody. Каждая вершина привязана к ближайшим узлам своей детали
// (афинно-точные веса с плавным спадом: форма в покое воспроизводится точно, стыков при смене соседей нет). Поверх сетки —
// два слоя мелких деталей: заломы (шум вдоль нормали там, где балки смялись) и вмятины от ударов (сдвиг вершин у точки удара).
// Царапины, копоть и трещины стёкол — атрибут вершин dmgData и шейдер CarDamagePlugin (текстура царапин в координатах покоя,
// поэтому рисунок не плывёт вместе с вмятиной). Отвалившиеся панели и колёса превращаются в обломки CarDebris.

const SKIN_K = 6;                  // узлов на вершину
const SKIN_CRUMPLE_PX = 7;         // px: глубина заломов на полном смятии
const SKIN_CRUMPLE_K = 3.5;          // смятие узла (доля длины балки) -> сила заломов
const SKIN_DENT_PX = 5;           // px: вмятина от удара силой 1
const SKIN_DENT_MAX = 7;          // px: предел вмятины от мелких ударов (большое смятие делает сетка)
const SKIN_LOD_DIST = 9000;        // px: дальше от камеры сетка обновляется реже
const SKIN_GLASS_CRACK = 0.012;    // смятие около стекла, с которого идут трещины
const SKIN_GLASS_BREAK = 0.05;     // смятие около стекла, с которого оно рассыпается

/** Текстура повреждений: R — царапины, G — пятна ржавчины, B — копоть, A — паутина трещин стекла. */
function carDamageTexture(scene) {
    if (scene.metadata && scene.metadata.carDmgTex) return scene.metadata.carDmgTex;
    const N = 512;
    const tex = new BABYLON.DynamicTexture('car-dmg', { width: N, height: N }, scene, true);
    const ctx = /** @type {CanvasRenderingContext2D} */ (/** @type {any} */ (tex.getContext()));
    let seed = 41;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const layer = (draw) => {
        const c = document.createElement('canvas'); c.width = c.height = N;
        const g = c.getContext('2d');
        g.fillStyle = '#000'; g.fillRect(0, 0, N, N);
        draw(g);
        return g.getImageData(0, 0, N, N).data;
    };
    const wrap = (g, fn) => { for (const dx of [-N, 0, N]) for (const dy of [-N, 0, N]) { g.save(); g.translate(dx, dy); fn(g); g.restore(); } };
    // царапины: пучки длинных тонких штрихов и глубокие борозды
    const scratches = [];
    for (let i = 0; i < 260; i++) {
        const a = rnd() < 0.7 ? rnd() * 0.5 - 0.25 : rnd() * Math.PI, len = 40 + rnd() * 240;
        scratches.push({ x: rnd() * N, y: rnd() * N, a, len, w: 0.5 + rnd() * rnd() * 3.2, v: 70 + rnd() * 185, bow: (rnd() - 0.5) * 30 });
    }
    const R = layer((g) => wrap(g, (h) => {
        for (const s of scratches) {
            h.strokeStyle = `rgb(${s.v},${s.v},${s.v})`; h.lineWidth = s.w;
            h.beginPath(); h.moveTo(s.x, s.y);
            h.quadraticCurveTo(s.x + Math.cos(s.a) * s.len / 2 - Math.sin(s.a) * s.bow, s.y + Math.sin(s.a) * s.len / 2 + Math.cos(s.a) * s.bow, s.x + Math.cos(s.a) * s.len, s.y + Math.sin(s.a) * s.len);
            h.stroke();
        }
    }));
    // пятна: шум из мягких пятен
    const blobs = [];
    for (let i = 0; i < 300; i++) blobs.push({ x: rnd() * N, y: rnd() * N, r: 8 + rnd() * rnd() * 70, a: 0.06 + rnd() * 0.22 });
    const blob = (h, s) => { const gr = h.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r); gr.addColorStop(0, `rgba(255,255,255,${s.a})`); gr.addColorStop(1, 'rgba(255,255,255,0)'); h.fillStyle = gr; h.fillRect(s.x - s.r, s.y - s.r, s.r * 2, s.r * 2); };
    const G = layer((g) => wrap(g, (h) => { for (const s of blobs) blob(h, s); }));
    const soot = [];
    for (let i = 0; i < 700; i++) soot.push({ x: rnd() * N, y: rnd() * N, r: 2 + rnd() * rnd() * 34, a: 0.1 + rnd() * 0.5 });
    const B = layer((g) => wrap(g, (h) => { for (const s of soot) blob(h, s); }));
    // паутина трещин: лучи от центров и кольцевые перемычки
    const webs = [];
    for (let w = 0; w < 5; w++) {
        const cx = rnd() * N, cy = rnd() * N, rays = 9 + Math.floor(rnd() * 8), rr = [];
        for (let i = 0; i < rays; i++) rr.push({ a: i / rays * 6.283 + rnd() * 0.3, l: 60 + rnd() * 170 });
        webs.push({ cx, cy, rr, rings: [0.25 + rnd() * 0.1, 0.5 + rnd() * 0.15, 0.8] });
    }
    const A = layer((g) => wrap(g, (h) => {
        h.strokeStyle = '#fff';
        for (const w of webs) {
            h.lineWidth = 1.1;
            for (const r of w.rr) { h.beginPath(); h.moveTo(w.cx, w.cy); let x = w.cx, y = w.cy; for (let k = 1; k <= 5; k++) { const t = r.l * k / 5; x = w.cx + Math.cos(r.a + Math.sin(k * 3.1 + r.a) * 0.05) * t; y = w.cy + Math.sin(r.a + Math.sin(k * 3.1 + r.a) * 0.05) * t; h.lineTo(x, y); } h.stroke(); }
            h.lineWidth = 0.8;
            for (const q of w.rings) { h.beginPath(); w.rr.forEach((r, i) => { const x = w.cx + Math.cos(r.a) * r.l * q, y = w.cy + Math.sin(r.a) * r.l * q; if (i) h.lineTo(x, y); else h.moveTo(x, y); }); h.closePath(); h.stroke(); }
        }
    }));
    const img = ctx.createImageData(N, N), d = img.data;
    for (let i = 0; i < N * N * 4; i += 4) { d[i] = R[i]; d[i + 1] = G[i]; d[i + 2] = B[i]; d[i + 3] = 255; }
    // альфа холста портит каналы (premultiply), поэтому паутина — отдельной текстурой
    ctx.putImageData(img, 0, 0);
    tex.update(false);
    tex.wrapU = tex.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    tex.anisotropicFilteringLevel = 4;
    const web = new BABYLON.DynamicTexture('car-web', { width: N, height: N }, scene, true);
    const wc = /** @type {CanvasRenderingContext2D} */ (/** @type {any} */ (web.getContext()));
    const wi = wc.createImageData(N, N), wd = wi.data;
    for (let i = 0; i < N * N * 4; i += 4) { wd[i] = wd[i + 1] = wd[i + 2] = A[i]; wd[i + 3] = 255; }
    wc.putImageData(wi, 0, 0);
    web.update(false);
    web.wrapU = web.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    scene.metadata = scene.metadata || {};
    scene.metadata.carDmgTex = { tex, web };
    return scene.metadata.carDmgTex;
}

/** Шейдер повреждений: царапины до голого металла, ржавчина, копоть, трещины стекла, погасшие фары. */
class CarDamagePlugin extends BABYLON.MaterialPluginBase {
    constructor(material, kind) {
        super(material, 'CarDamage', 220, { CARDAMAGE: false, CARDMGGLASS: false, CARDMGLIGHT: false, CARDMGPAINT: false }, true, true);
        this.kind = kind || 'paint';
    }
    getClassName() { return 'CarDamagePlugin'; }
    prepareDefines(defines, scene, mesh) {
        const on = !!(mesh && mesh.isVerticesDataPresent && mesh.isVerticesDataPresent('dmgData'));
        defines.CARDAMAGE = on;
        defines.CARDMGGLASS = on && this.kind === 'glass';
        defines.CARDMGLIGHT = on && this.kind === 'light';
        defines.CARDMGPAINT = on && this.kind === 'paint';
    }
    getAttributes(attributes, scene, mesh) {
        if (mesh && mesh.isVerticesDataPresent && mesh.isVerticesDataPresent('dmgData')) attributes.push('dmgData', 'dmgRest');
    }
    getSamplers(samplers) { samplers.push('dmgTex', 'dmgWeb'); }
    getUniforms() {
        return {
            ubo: [{ name: 'dmgSky', size: 4, type: 'vec4' }, { name: 'dmgZen', size: 4, type: 'vec4' }, { name: 'dmgSun', size: 4, type: 'vec4' }],
            fragment: '#ifdef CARDAMAGE\nuniform vec4 dmgSky;\nuniform vec4 dmgZen;\nuniform vec4 dmgSun;\n#endif',
        };
    }
    bindForSubMesh(ubo, scene) {
        const t = carDamageTexture(scene);
        ubo.setTexture('dmgTex', t.tex);
        ubo.setTexture('dmgWeb', t.web);
        // отражение неба на лаке: горизонт — цвет тумана, зенит темнее и синее, солнце — из света сцены
        const f = scene.fogColor || { r: 0.72, g: 0.8, b: 0.88 }, sun = scene.metadata && scene.metadata.lorySun;
        ubo.updateFloat4('dmgSky', f.r, f.g, f.b, 1);
        ubo.updateFloat4('dmgZen', f.r * 0.45 + 0.02, f.g * 0.55 + 0.04, Math.min(1, f.b * 0.8 + 0.1), 1);
        if (sun) ubo.updateFloat4('dmgSun', sun.dir.x, sun.dir.y, sun.dir.z, 1);
        else ubo.updateFloat4('dmgSun', 0.45, 0.8, 0.4, 1);
    }
    getCustomCode(shaderType) {
        return shaderType === 'vertex' ? CarDamagePlugin.VS : shaderType === 'fragment' ? CarDamagePlugin.FS : null;
    }
}
CarDamagePlugin.VS = {
    CUSTOM_VERTEX_DEFINITIONS: `
#ifdef CARDAMAGE
attribute vec3 dmgData;
attribute vec3 dmgRest;
varying vec3 vDmg;
varying vec3 vDmgRest;
varying vec3 vDmgN;
#endif`,
    CUSTOM_VERTEX_MAIN_END: `
#ifdef CARDAMAGE
vDmg = dmgData;
vDmgRest = dmgRest;
#ifdef NORMAL
vDmgN = normal;
#else
vDmgN = vec3(0.0, 1.0, 0.0);
#endif
#endif`,
};
CarDamagePlugin.FS = {
    CUSTOM_FRAGMENT_DEFINITIONS: `
#ifdef CARDAMAGE
varying vec3 vDmg;
varying vec3 vDmgRest;
varying vec3 vDmgN;
uniform sampler2D dmgTex;
uniform sampler2D dmgWeb;
vec4 dmgTri(sampler2D t, vec3 p, vec3 n, float s) {
    vec3 w = abs(n); w = w * w; w /= (w.x + w.y + w.z + 0.001);
    return texture2D(t, p.yz * s) * w.x + texture2D(t, p.xz * s) * w.y + texture2D(t, p.xy * s) * w.z;
}
#endif`,
    CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `
#ifdef CARDAMAGE
#ifdef CARDMGGLASS
    if (vDmg.x > 0.003) {
        float web = dmgTri(dmgWeb, vDmgRest, vDmgN, 0.006).r;
        float crack = smoothstep(0.25, 0.7, web) * clamp(vDmg.x * 1.6, 0.0, 1.0);
        baseColor.rgb = mix(baseColor.rgb, vec3(0.92, 0.95, 0.97), crack);
        baseColor.a = mix(baseColor.a, 1.0, crack);
    }
#elif defined(CARDMGLIGHT)
    baseColor.rgb *= 1.0 - clamp(vDmg.x, 0.0, 1.0) * 0.85;
#else
    if (vDmg.x + vDmg.y + vDmg.z > 0.004) {
        vec4 dt = dmgTri(dmgTex, vDmgRest, vDmgN, 0.0052);
        vec4 dt2 = dmgTri(dmgTex, vDmgRest * 1.0, vDmgN, 0.019);
        float scr = dt.r * 0.8 + dt2.r * 0.55;
        float blot = dt.g * 1.6;
        float s = clamp(vDmg.x, 0.0, 1.0);
        float mask = smoothstep(1.0 - s * 1.15, 1.18 - s * 1.15, scr + blot * 0.35 * s);
        vec3 bare = mix(vec3(0.60, 0.61, 0.63), vec3(0.27, 0.18, 0.13), clamp(blot * blot * s * 1.5, 0.0, 1.0));
        baseColor.rgb = mix(baseColor.rgb, bare, mask);
        float z = clamp(vDmg.z, 0.0, 1.0);
        baseColor.rgb *= 1.0 - z * (0.22 + 0.4 * dt2.g);
        float soot = clamp(vDmg.y, 0.0, 1.0);
        baseColor.rgb = mix(baseColor.rgb, vec3(0.025, 0.022, 0.02) + 0.05 * dt2.b, soot * (0.75 + 0.25 * dt.b));
    }
#endif
#endif`,
    CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `
#ifdef CARDAMAGE
#ifdef CARDMGLIGHT
    color.rgb *= 1.0 - clamp(vDmg.x, 0.0, 1.0) * 0.8;
#endif
#if defined(CARDMGPAINT) || defined(CARDMGGLASS)
    {
        vec3 dmgV = normalize(vEyePosition.xyz - vPositionW);
        vec3 dmgNw = normalize(vNormalW);
        vec3 dmgR = reflect(-dmgV, dmgNw);
        float dmgF = pow(1.0 - max(dot(dmgNw, dmgV), 0.0), 4.0);
        float up = dmgR.y;
        vec3 env = up > 0.0 ? mix(dmgSky.rgb, dmgZen.rgb, pow(up, 0.55)) : mix(dmgSky.rgb * 0.55, vec3(0.12, 0.12, 0.13), clamp(-up * 5.0, 0.0, 1.0));
        float sunD = max(dot(dmgR, normalize(dmgSun.xyz)), 0.0);
        env += vec3(1.0, 0.93, 0.8) * (pow(sunD, 280.0) * 3.2 + pow(sunD, 24.0) * 0.22);
#ifdef CARDMGPAINT
        float wear = clamp(vDmg.x * 1.4 + vDmg.y * 1.5 + vDmg.z * 0.8, 0.0, 1.0);
        float dmgK = (0.06 + dmgF * 0.62) * (1.0 - wear * 0.92);
#else
        float dmgK = 0.12 + dmgF * 0.75;
#endif
        color.rgb = mix(color.rgb, env, dmgK);
    }
#endif
#endif`,
};

/** Решение 4×4 (a — по строкам, b — правая часть), результат в b. false — вырождена. */
function skinSolve4(a, b) {
    for (let c = 0; c < 4; c++) {
        let p = c, best = Math.abs(a[c * 4 + c]);
        for (let r = c + 1; r < 4; r++) { const v = Math.abs(a[r * 4 + c]); if (v > best) { best = v; p = r; } }
        if (best < 1e-12) return false;
        if (p !== c) { for (let k = 0; k < 4; k++) { const t = a[c * 4 + k]; a[c * 4 + k] = a[p * 4 + k]; a[p * 4 + k] = t; } const t = b[c]; b[c] = b[p]; b[p] = t; }
        const d = a[c * 4 + c];
        for (let r = c + 1; r < 4; r++) {
            const f = a[r * 4 + c] / d;
            if (f === 0) continue;
            for (let k = c; k < 4; k++) a[r * 4 + k] -= f * a[c * 4 + k];
            b[r] -= f * b[c];
        }
    }
    for (let c = 3; c >= 0; c--) {
        let v = b[c];
        for (let k = c + 1; k < 4; k++) v -= a[c * 4 + k] * b[k];
        b[c] = v / a[c * 4 + c];
    }
    return true;
}

/**
 * Веса вершин по узлам list. rest — xyz вершин в осях машины. → { idx: Int16Array(n*K), wt: Float32Array(n*K), e: Float32Array(n*3) }
 */
function skinBind(rest, n, nodes, list) {
    const K = Math.min(SKIN_K, list.length);
    const idx = new Int16Array(n * SKIN_K).fill(-1), wt = new Float32Array(n * SKIN_K), e = new Float32Array(n * 3);
    const m = list.length, ds = new Float64Array(m), order = new Int32Array(m);
    const A = new Float64Array(16), B = new Float64Array(4), S = new Float64Array(SKIN_K), W = new Float64Array(SKIN_K);
    const Xs = list.map(i => nodes[i].x), Ys = list.map(i => nodes[i].y), Zs = list.map(i => nodes[i].z);
    for (let v = 0; v < n; v++) {
        const px = rest[v * 3], py = rest[v * 3 + 1], pz = rest[v * 3 + 2];
        for (let i = 0; i < m; i++) { const dx = Xs[i] - px, dy = Ys[i] - py, dz = Zs[i] - pz; ds[i] = dx * dx + dy * dy + dz * dz; order[i] = i; }
        // K + 1 ближайших частичной сортировкой
        const need = Math.min(m, K + 1);
        for (let a = 0; a < need; a++) {
            let best = a;
            for (let b = a + 1; b < m; b++) if (ds[order[b]] < ds[order[best]]) best = b;
            const t = order[a]; order[a] = order[best]; order[best] = t;
        }
        const D = Math.sqrt(ds[order[need - 1]]) * 1.02 + 1;
        A.fill(0);
        let sum = 0, cx = 0, cy = 0, cz = 0;
        for (let k = 0; k < K; k++) {
            const i = order[k], d = Math.sqrt(ds[i]) / D, f = 1 - d;
            const s = (f * f) / (d + 0.04);
            S[k] = s; sum += s;
            cx += Xs[i] * s; cy += Ys[i] * s; cz += Zs[i] * s;
        }
        sum = sum || 1;
        cx /= sum; cy /= sum; cz /= sum;
        let tr = 0;
        for (let k = 0; k < K; k++) {
            const i = order[k], s = S[k], x = Xs[i] - cx, y = Ys[i] - cy, z = Zs[i] - cz;
            A[0] += s * x * x; A[1] += s * x * y; A[2] += s * x * z; A[3] += s * x;
            A[5] += s * y * y; A[6] += s * y * z; A[7] += s * y;
            A[10] += s * z * z; A[11] += s * z; A[15] += s;
            tr += s * (x * x + y * y + z * z);
        }
        A[4] = A[1]; A[8] = A[2]; A[9] = A[6]; A[12] = A[3]; A[13] = A[7]; A[14] = A[11];
        const eps = tr * 2e-3 + 1e-6;
        A[0] += eps; A[5] += eps; A[10] += eps;
        B[0] = px - cx; B[1] = py - cy; B[2] = pz - cz; B[3] = 1;
        let ok = skinSolve4(A, B), maxW = 0, sw = 0;
        if (ok) {
            for (let k = 0; k < K; k++) {
                const i = order[k], w = S[k] * ((Xs[i] - cx) * B[0] + (Ys[i] - cy) * B[1] + (Zs[i] - cz) * B[2] + B[3]);
                W[k] = w; sw += w; if (Math.abs(w) > maxW) maxW = Math.abs(w);
            }
            if (maxW > 1.8 || !Number.isFinite(maxW)) ok = false;
        }
        if (!ok) { for (let k = 0; k < K; k++) W[k] = S[k] / sum; sw = 1; }
        let qx = 0, qy = 0, qz = 0;
        for (let k = 0; k < K; k++) {
            const i = order[k], w = W[k] / (sw || 1);
            idx[v * SKIN_K + k] = list[i];
            wt[v * SKIN_K + k] = w;
            qx += Xs[i] * w; qy += Ys[i] * w; qz += Zs[i] * w;
        }
        e[v * 3] = px - qx; e[v * 3 + 1] = py - qy; e[v * 3 + 2] = pz - qz;
    }
    return { idx, wt, e };
}

/** Заломы: острый шум по месту вершины (-1..1), свой у каждой вершины, но гладкий по поверхности. */
function skinNoise(x, y, z) {
    const f = (a, b, c) => {
        const s = Math.sin(a * 0.071 + b * 0.113) * Math.cos(b * 0.057 - c * 0.097) + Math.sin(c * 0.083 + a * 0.041) * 0.7;
        return s;
    };
    const n1 = f(x, y, z), n2 = f(x * 2.3 + 17, y * 2.3 - 9, z * 2.3 + 31) * 0.5, n3 = f(x * 4.7 - 5, y * 4.7 + 11, z * 4.7) * 0.25;
    const v = n1 + n2 + n3;
    return Math.sign(v) * (1 - Math.pow(1 - Math.min(1, Math.abs(v) / 1.5), 1.6));
}

class CarSkin {
    /** @param {any} carView CarView @param {any} C машина с soft и damage */
    constructor(carView, C) {
        this.view = carView;
        this.C = C;
        this.rig = carView.car;
        this.soft = C.soft;
        this.def = C.soft.def;
        /** @type {any[]} */ this.parts = [];
        /** @type {Map<string, any[]>} */ this.byName = new Map();
        this.hubs = [];
        /** @type {any[]} */ this.windows = [];
        this.lastDirty = -1;
        this.frame = 0;
        this.dirtyAttr = false;
        this.needPos = false;
        this.tGlass = 0;
        this.scene = this.rig.root.getScene();
        this._bind();
        this._hook(C.damage);
    }

    _partKind(name) {
        if (/^(Wheel|Brake|Hub|Steering)/.test(name)) return null;
        if (/^Panel/.test(name)) return 'panel';
        if (/^Glass/.test(name)) return 'glass';
        if (/^Light/.test(name)) return 'light';
        if (name === 'Engine') return 'engine';
        if (name === 'Interior' || name === 'Frame') return 'inner';
        return 'body';
    }

    _bind() {
        const rig = this.rig, def = this.def, cache = CarSkin._cache[this.C.spec.id] || (CarSkin._cache[this.C.spec.id] = new Map());
        rig.root.computeWorldMatrix(true);
        const rootInv = rig.root.getWorldMatrix().clone().invert();
        const frame = def.frameIdx;
        const meshes = rig._meshes || Array.from(rig.parts.values());
        for (let pi = 0; pi < meshes.length; pi++) {
            const mesh = meshes[pi], name = (mesh.metadata && mesh.metadata.part) || mesh.name;
            const kind = this._partKind(name);
            if (!kind) continue;
            const src = mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
            const idx = mesh.getIndices();
            if (!src || !idx) continue;
            mesh.computeWorldMatrix(true);
            const M = mesh.getWorldMatrix().multiply(rootInv);
            const isId = M.isIdentity();
            const n = src.length / 3;
            let bind = cache.get(pi);
            if (!bind) {
                const rest = new Float32Array(n * 3), v = new BABYLON.Vector3(), o = new BABYLON.Vector3();
                for (let i = 0; i < n; i++) {
                    v.set(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]);
                    BABYLON.Vector3.TransformCoordinatesToRef(v, M, o);
                    rest[i * 3] = o.x; rest[i * 3 + 1] = o.y; rest[i * 3 + 2] = o.z;
                }
                const list = this._nodesFor(name, kind, def, frame);
                const b = skinBind(rest, n, def.nodes, list);
                const noise = new Float32Array(n);
                for (let i = 0; i < n; i++) noise[i] = skinNoise(rest[i * 3], rest[i * 3 + 1], rest[i * 3 + 2]);
                bind = { rest, idx: b.idx, wt: b.wt, e: b.e, noise, n };
                cache.set(pi, bind);
            }
            mesh.makeGeometryUnique();
            mesh.setVerticesData(BABYLON.VertexBuffer.PositionKind, Float32Array.from(src), true);
            const nrm0 = mesh.getVerticesData(BABYLON.VertexBuffer.NormalKind);
            const nrm = nrm0 ? Float32Array.from(nrm0) : new Float32Array(n * 3);
            if (!nrm0) BABYLON.VertexData.ComputeNormals(src, idx, nrm);
            mesh.setVerticesData(BABYLON.VertexBuffer.NormalKind, nrm, true);
            const attr = new Float32Array(n * 3);
            mesh.setVerticesData('dmgData', attr, true, 3);
            mesh.setVerticesData('dmgRest', bind.rest, false, 3);
            mesh.alwaysSelectAsActiveMesh = true;
            // нормали покоя, посчитанные тем же способом: разница даёт изменение от вмятины, авторские рёбра не теряются
            const nRestCalc = new Float32Array(n * 3);
            BABYLON.VertexData.ComputeNormals(src, idx, nRestCalc);
            let dot = 0;
            for (let i = 0; i < n * 3; i++) dot += nRestCalc[i] * nrm[i];
            const P = { name, kind, mesh, M: isId ? null : BABYLON.Matrix.Invert(M), bind, n, src: Float32Array.from(src), idx, pos: new Float32Array(n * 3), nrm, nrm0: Float32Array.from(nrm), nCalc: nRestCalc, nTmp: new Float32Array(n * 3),
                flip: dot < 0, attr, off: new Float32Array(n * 3), hasOff: false, attrDirty: false, gone: false, parent0: mesh.parent, pos0: mesh.position.clone(), rq0: mesh.rotationQuaternion ? mesh.rotationQuaternion.clone() : null, rot0: mesh.rotation.clone(), scale0: mesh.scaling.clone() };
            this.parts.push(P);
            if (!this.byName.has(name)) this.byName.set(name, []);
            this.byName.get(name).push(P);
            if (kind === 'glass') this.windows.push({ part: P, crack: 0, broken: false });
            this._material(mesh, kind);
        }
        for (const w of LOOK_HUBS) this.hubs.push({ node: rig.nodes.get(w) || null });
    }

    _nodesFor(name, kind, def, frame) {
        const panels = def.panels;
        if (kind === 'panel' && panels[name]) return panels[name].nodes.slice();
        if (kind === 'glass') {
            const m = /^GlassDoor(..)/.exec(name);
            if (m && panels['PanelDoor' + m[1]]) return panels['PanelDoor' + m[1]].nodes.slice();
            return frame;
        }
        if (kind === 'engine') return def.engine.concat(frame);
        return frame;
    }

    _material(mesh, kind) {
        const pk = kind === 'glass' ? 'glass' : kind === 'light' ? 'light' : kind === 'body' || kind === 'panel' ? 'paint' : 'plain';
        const add = (m) => { if (m && !m.carDamage && BABYLON.MaterialPluginBase) { m.carDamage = new CarDamagePlugin(m, /glass/i.test(m.name) ? 'glass' : pk); } };
        const mat = mesh.material;
        if (!mat) return;
        if (mat.subMaterials) mat.subMaterials.forEach(add); else add(mat);
    }

    // ---------------------------------------------------------------------------------------------
    // События повреждений
    // ---------------------------------------------------------------------------------------------

    _hook(d) {
        if (!d) return;
        d.on.hit = (i, power, imp) => this._onHit(i, power, imp);
        d.on.scrape = (i, power, dt) => this._onScrape(i, power, dt);
        d.on.panelOff = (name, p, q, v) => this._onPanelOff(name, p, q, v);
        d.on.wheelOff = (i, q, v) => this._onWheelOff(i, q, v);
        d.on.reset = () => this.restore();
        d.on.explode = () => this._burn(1, 900);
        d.on.engineEmitter = () => this._engineEmitter();
    }

    _engineEmitter() {
        if (typeof CrashFx === 'undefined') return null;
        const C = this.C, S = this.soft, en = this.def.engine[0];
        const o = new BABYLON.Vector3();
        return CrashFx.emitter(() => { const p = C.point(S.lx[en], S.ly[en] + 26, S.lz[en], [0, 0, 0]); o.set(p[0], p[1], p[2]); return o; });
    }

    // Вмятина и царапины там, куда пришёлся удар (координаты — оси машины).
    _onHit(i, power, imp) {
        const S = this.soft, C = this.C;
        const lx = S.lx[i], ly = S.ly[i], lz = S.lz[i];
        // нормаль контакта — в оси машины
        const nx = S.cNx[i], ny = S.cNy[i], nz = S.cNz[i], f = C.f, u = C.u, r = C.r;
        const ax = nx * f[0] + ny * f[1] + nz * f[2], ay = nx * u[0] + ny * u[1] + nz * u[2], az = nx * r[0] + ny * r[1] + nz * r[2];
        const depth = SKIN_DENT_PX * (0.35 + power), rad = 22 + 34 * power;
        this._splat(lx, ly, lz, rad, depth, ax, ay, az, 0.1 + power * 0.32, 0.25 * power);
        void imp;
    }

    _onScrape(i, power, dt) {
        const S = this.soft;
        this._splat(S.lx[i], S.ly[i], S.lz[i], 30 + power * 18, 0, 0, 0, 0, (0.15 + power) * dt * 3.2, 0);
    }

    // Сдвиг вершин и краска в шаре вокруг точки; depth вдоль (ax, ay, az) — внутрь кузова (нормаль контакта смотрит наружу от препятствия).
    _splat(lx, ly, lz, rad, depth, ax, ay, az, scrape, crumple) {
        const R2 = rad * rad;
        for (const P of this.parts) {
            if (P.gone || P.kind === 'inner' || P.kind === 'engine') continue;
            const rest = P.bind.rest, n = P.n, off = P.off, attr = P.attr, noise = P.bind.noise, idx = P.bind.idx, S = this.soft;
            for (let v = 0; v < n; v++) {
                // текущее положение без мелких деталей считаем по покою + смещению узлов
                const a = idx[v * SKIN_K];
                const dx0 = S.lx[a] - S.rx[a], dy0 = S.ly[a] - S.ry[a], dz0 = S.lz[a] - S.rz[a];
                const dx = rest[v * 3] + dx0 - lx, dy = rest[v * 3 + 1] + dy0 - ly, dz = rest[v * 3 + 2] + dz0 - lz;
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 >= R2) continue;
                const t = 1 - d2 / R2, k = t * t;
                if (depth > 0) {
                    const j = 0.75 + noise[v] * 0.5;
                    let ox = off[v * 3] + ax * depth * k * j, oy = off[v * 3 + 1] + ay * depth * k * j, oz = off[v * 3 + 2] + az * depth * k * j;
                    const ol = Math.sqrt(ox * ox + oy * oy + oz * oz);
                    if (ol > SKIN_DENT_MAX) { const c = SKIN_DENT_MAX / ol; ox *= c; oy *= c; oz *= c; }
                    off[v * 3] = ox; off[v * 3 + 1] = oy; off[v * 3 + 2] = oz;
                    P.hasOff = true;
                }
                if (P.kind === 'glass') { attr[v * 3] = Math.min(1, attr[v * 3] + scrape * k * 1.5); }
                else if (P.kind === 'light') { if (scrape > 0.3) attr[v * 3] = Math.min(1, attr[v * 3] + scrape * k * 2); }
                else {
                    attr[v * 3] = Math.min(1, attr[v * 3] + scrape * k);
                    if (crumple) attr[v * 3 + 2] = Math.min(1, attr[v * 3 + 2] + crumple * k);
                }
                P.attrDirty = true;
            }
        }
        this.needPos = this.needPos || depth > 0;
    }

    /** Копоть вокруг точки (огонь, взрыв): amount 0..1 в радиусе. */
    _burn(amount, rad) {
        const en = this.def.engine[0], S = this.soft;
        this._burnAt(S.lx[en], S.ly[en], S.lz[en], amount, rad);
    }

    _burnAt(lx, ly, lz, amount, rad) {
        const R2 = rad * rad;
        for (const P of this.parts) {
            if (P.gone) continue;
            const rest = P.bind.rest, n = P.n, attr = P.attr;
            for (let v = 0; v < n; v++) {
                const dx = rest[v * 3] - lx, dy = rest[v * 3 + 1] - ly, dz = rest[v * 3 + 2] - lz, d2 = dx * dx + dy * dy + dz * dz;
                if (d2 >= R2) continue;
                attr[v * 3 + 1] = Math.min(1, attr[v * 3 + 1] + amount * (1 - d2 / R2));
                if (P.kind === 'light') attr[v * 3] = Math.min(1, attr[v * 3] + amount);
            }
            P.attrDirty = true;
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Обломки
    // ---------------------------------------------------------------------------------------------

    _onPanelOff(name, p, q, v) {
        const list = this.byName.get(name) || [];
        const glass = /Door/.test(name) ? (this.byName.get('GlassDoor' + name.replace('PanelDoor', '')) || []) : [];
        const S = this.soft, C = this.C;
        const nodes = p.nodes;
        // центр панели и её точки контакта — в текущей форме, в осях машины
        let cx = 0, cy = 0, cz = 0;
        for (const i of nodes) { cx += S.lx[i]; cy += S.ly[i]; cz += S.lz[i]; }
        cx /= nodes.length; cy /= nodes.length; cz /= nodes.length;
        const pts = [];
        let R = 20;
        for (const i of nodes) {
            const x = S.lx[i] - cx, y = S.ly[i] - cy, z = S.lz[i] - cz;
            pts.push([x, y, z]);
            R = Math.max(R, Math.hypot(x, y, z));
        }
        // последняя форма вида до отключения узлов
        this._updateMesh(true);
        const root = new BABYLON.TransformNode('debris-' + name, this.scene);
        const wc = C.point(cx, cy, cz, [0, 0, 0]);
        root.position.set(wc[0], wc[1], wc[2]);
        root.rotationQuaternion = new BABYLON.Quaternion(C.q[0], C.q[1], C.q[2], C.q[3]);
        const parts = list.concat(glass);
        for (const P of parts) {
            P.gone = true;
            const mesh = P.mesh;
            mesh.parent = root;
            mesh.position.set(-cx, -cy, -cz);
            if (mesh.rotationQuaternion) mesh.rotationQuaternion.set(0, 0, 0, 1); else mesh.rotation.set(0, 0, 0);
            mesh.scaling.set(1, 1, 1);
            if (P.M) this._bakeLocal(P);
        }
        const w = [C.w[0] + (Math.random() - 0.5) * 6, C.w[1] + (Math.random() - 0.5) * 6, C.w[2] + (Math.random() - 0.5) * 6];
        CarDebris.add({ owner: this, p: wc, q: C.q.slice(), v: v.slice(), w, pts, R, surface: 'metal',
            onPose(b) { root.position.set(b.p[0], b.p[1], b.p[2]); root.rotationQuaternion.set(b.q[0], b.q[1], b.q[2], b.q[3]); },
            onDrop() { for (const P of parts) { if (P.mesh.parent === root) P.mesh.setEnabled(false); } root.setEnabled(false); } });
        (this._debris || (this._debris = [])).push({ root, parts });
        if (typeof CrashFx !== 'undefined' && glass.length) CrashFx.glass(wc, v, 0.5);
    }

    // Меш с собственной матрицей: вершины уже в осях машины — меш теперь рисуется без неё.
    _bakeLocal(P) {
        const pos = P.pos, n = P.n;
        const M = P.M, m = BABYLON.Matrix.Invert(M), v = new BABYLON.Vector3(), o = new BABYLON.Vector3();
        for (let i = 0; i < n; i++) {
            v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
            BABYLON.Vector3.TransformCoordinatesToRef(v, m, o);
            pos[i * 3] = o.x; pos[i * 3 + 1] = o.y; pos[i * 3 + 2] = o.z;
        }
        P.mesh.updateVerticesData(BABYLON.VertexBuffer.PositionKind, pos);
    }

    _onWheelOff(i, q, v) {
        const rig = this.rig, hub = rig.nodes.get(LOOK_HUBS[i]), C = this.C;
        if (!hub) return;
        const R = C.spec.R;
        const saved = { parent: hub.parent, pos: hub.position.clone(), rq: hub.rotationQuaternion ? hub.rotationQuaternion.clone() : null };
        hub.parent = null;
        hub.position.set(q[0], q[1], q[2]);
        hub.rotationQuaternion = new BABYLON.Quaternion(C.q[0], C.q[1], C.q[2], C.q[3]);
        const pts = [];
        for (let a = 0; a < 8; a++) {
            const t = a / 8 * Math.PI * 2;
            pts.push([Math.cos(t) * R, Math.sin(t) * R, -12], [Math.cos(t) * R, Math.sin(t) * R, 12]);
        }
        const r = C.r;
        const spin = (Math.abs(C.vf) / R) * (Math.random() < 0.5 ? 1 : 0.7);
        const w = [r[0] * -spin + (Math.random() - 0.5) * 4, r[1] * -spin + (Math.random() - 0.5) * 4, r[2] * -spin + (Math.random() - 0.5) * 4];
        const vv = [v[0] || C.v[0], (v[1] || C.v[1]) + 120 + Math.random() * 200, v[2] || C.v[2]];
        CarDebris.add({ owner: this, p: q.slice(), q: C.q.slice(), v: vv, w, pts, R, wheel: true, surface: 'rubber', life: 30,
            onPose(b) { hub.position.set(b.p[0], b.p[1], b.p[2]); hub.rotationQuaternion.set(b.q[0], b.q[1], b.q[2], b.q[3]); },
            onDrop() { hub.setEnabled(false); } });
        (this._wheels || (this._wheels = [])).push({ hub, saved });
    }

    /** Починка (возврат на дорогу): всё как с завода. */
    restore() {
        // сначала снять свои обломки: иначе живой обломок колеса продолжит двигать уже возвращённый на место узел
        CarDebris.list = CarDebris.list.filter(b => b.owner !== this);
        for (const d of this._debris || []) {
            for (const P of d.parts) {
                const mesh = P.mesh;
                mesh.parent = P.parent0;
                mesh.position.copyFrom(P.pos0);
                if (P.rq0) { if (!mesh.rotationQuaternion) mesh.rotationQuaternion = P.rq0.clone(); else mesh.rotationQuaternion.copyFrom(P.rq0); } else mesh.rotation.copyFrom(P.rot0);
                mesh.scaling.copyFrom(P.scale0);
                mesh.setEnabled(true);
                P.gone = false;
            }
            try { d.root.dispose(); } catch (e) { /* уже */ }
        }
        this._debris = [];
        for (const w of this._wheels || []) {
            w.hub.parent = w.saved.parent;
            w.hub.position.copyFrom(w.saved.pos);
            if (w.saved.rq && w.hub.rotationQuaternion) w.hub.rotationQuaternion.copyFrom(w.saved.rq);
            w.hub.setEnabled(true);
        }
        this._wheels = [];
        for (const P of this.parts) {
            P.off.fill(0); P.attr.fill(0); P.hasOff = false; P.gone = false;
            const m = P.mesh;
            m.updateVerticesData(BABYLON.VertexBuffer.PositionKind, P.src);
            m.updateVerticesData(BABYLON.VertexBuffer.NormalKind, P.nrm0);
            m.updateVerticesData('dmgData', P.attr);
            P.mesh.setEnabled(true);
        }
        for (const w of this.windows) { w.crack = 0; w.broken = false; }
        this.needPos = false;
        this.deformed = false;
    }

    // ---------------------------------------------------------------------------------------------
    // Кадр
    // ---------------------------------------------------------------------------------------------

    /** dist — от машины до камеры: дальние обновляются реже. */
    update(dt, dist) {
        const S = this.soft;
        this.frame++;
        const far = dist > SKIN_LOD_DIST;
        const awake = S.awake;
        if (S.dirty) this.deformed = true;
        const changed = (awake && this.deformed) || S.dirty || this.needPos;
        if (changed && (!far || this.frame % 4 === 0)) {
            this._updateMesh(false);
            S.dirty = false;
            this.needPos = false;
        }
        for (const P of this.parts) {
            if (P.attrDirty) { P.attrDirty = false; if (!P.gone || P.mesh.isEnabled()) P.mesh.updateVerticesData('dmgData', P.attr); }
        }
        this.tGlass -= dt;
        if (this.tGlass <= 0) { this.tGlass = 0.08; this._glass(); }
        const d = this.C.damage;
        if (d && d.state === 'fire') this._burn(dt * 0.25, 240);
    }

    _updateMesh(force) {
        const S = this.soft, lx = S.lx, ly = S.ly, lz = S.lz, dmg = S.dmg;
        const POS = BABYLON.VertexBuffer.PositionKind, NOR = BABYLON.VertexBuffer.NormalKind;
        const K = SKIN_K, CK = SKIN_CRUMPLE_K, CP = SKIN_CRUMPLE_PX;
        for (const P of this.parts) {
            if (P.gone) continue;
            if (!force && P.kind === 'inner' && this.frame % 2) continue;
            const b = P.bind, idx = b.idx, wt = b.wt, e = b.e, noise = b.noise, n = P.n, pos = P.pos, off = P.off, nrmRest = P.nrm0;
            const hasCrumple = P.kind === 'body' || P.kind === 'panel';
            for (let v = 0; v < n; v++) {
                let x = e[v * 3], y = e[v * 3 + 1], z = e[v * 3 + 2], dv = 0;
                const o = v * K;
                for (let k = 0; k < K; k++) {
                    const i = idx[o + k];
                    if (i < 0) break;
                    const w = wt[o + k];
                    x += lx[i] * w; y += ly[i] * w; z += lz[i] * w;
                    dv += dmg[i] * (w < 0 ? 0 : w);
                }
                x += off[v * 3]; y += off[v * 3 + 1]; z += off[v * 3 + 2];
                if (hasCrumple && dv > 0.03) {
                    const a = Math.min(1, (dv - 0.03) * CK) * CP * (noise[v] * 0.75 + 0.25);
                    x += nrmRest[v * 3] * a; y += nrmRest[v * 3 + 1] * a; z += nrmRest[v * 3 + 2] * a;
                    const cr = Math.min(1, dv * 2.2);
                    if (cr > P.attr[v * 3 + 2] + 0.02) { P.attr[v * 3 + 2] = cr; P.attrDirty = true; }
                }
                pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
            }
            if (P.M) {
                const m = P.M.m;
                for (let v = 0; v < n; v++) {
                    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
                    pos[v * 3] = x * m[0] + y * m[4] + z * m[8] + m[12];
                    pos[v * 3 + 1] = x * m[1] + y * m[5] + z * m[9] + m[13];
                    pos[v * 3 + 2] = x * m[2] + y * m[6] + z * m[10] + m[14];
                }
            }
            P.mesh.updateVerticesData(POS, pos);
            if (P.kind === 'inner') continue;
            // нормали: авторская + (новая − покоя)
            const nt = P.nTmp, nc = P.nCalc, nr = P.nrm;
            BABYLON.VertexData.ComputeNormals(pos, P.idx, nt);
            const s = P.flip ? -1 : 1;
            for (let i = 0; i < n * 3; i += 3) {
                const ax = nrmRest[i] + (nt[i] - nc[i]) * s, ay = nrmRest[i + 1] + (nt[i + 1] - nc[i + 1]) * s, az = nrmRest[i + 2] + (nt[i + 2] - nc[i + 2]) * s;
                const l = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
                nr[i] = ax / l; nr[i + 1] = ay / l; nr[i + 2] = az / l;
            }
            P.mesh.updateVerticesData(NOR, nr);
        }
    }

    // Стёкла: трещат и рассыпаются, когда рядом смялось.
    _glass() {
        const S = this.soft;
        for (const W of this.windows) {
            if (W.broken) continue;
            const P = W.part;
            const b = P.bind, n = P.n;
            let sum = 0;
            const step = Math.max(1, Math.floor(n / 12));
            let cnt = 0;
            for (let v = 0; v < n; v += step) {
                for (let k = 0; k < SKIN_K; k++) { const i = b.idx[v * SKIN_K + k]; if (i < 0) break; const w = b.wt[v * SKIN_K + k]; if (w > 0) sum += S.dmg[i] * w; }
                cnt++;
            }
            const d = sum / Math.max(1, cnt);
            const scratched = P.attr[0] + P.attr[(n >> 1) * 3];
            if (d > SKIN_GLASS_CRACK || scratched > 0.1) {
                const crack = Math.min(1, (d - SKIN_GLASS_CRACK) / (SKIN_GLASS_BREAK - SKIN_GLASS_CRACK));
                if (crack > W.crack + 0.04) {
                    W.crack = crack;
                    for (let v = 0; v < n; v++) P.attr[v * 3] = Math.max(P.attr[v * 3], crack * 0.8);
                    P.attrDirty = true;
                }
            }
            if (d > SKIN_GLASS_BREAK || P.attr[0] > 0.95) this._shatter(W);
        }
    }

    _shatter(W) {
        W.broken = true;
        const P = W.part, C = this.C, r = P.bind.rest, n = P.n;
        let x = 0, y = 0, z = 0;
        for (let i = 0; i < n; i++) { x += r[i * 3]; y += r[i * 3 + 1]; z += r[i * 3 + 2]; }
        const q = C.point(x / n, y / n, z / n, [0, 0, 0]);
        P.mesh.setEnabled(false);
        P.gone = true;
        if (typeof CrashFx !== 'undefined') CrashFx.glass(q, [C.v[0] * 0.7, C.v[1] * 0.7 + 60, C.v[2] * 0.7], Math.min(1, n / 200 + 0.4));
    }

    dispose() {
        CarDebris.list = CarDebris.list.filter(b => b.owner !== this);
        for (const d of this._debris || []) { try { d.root.dispose(); } catch (e) { /* уже */ } }
        this._debris = [];
        if (this.C.damage) this.C.damage.stopFx();
    }
}
/** @type {Record<string, Map<number, any>>} */
CarSkin._cache = {};
