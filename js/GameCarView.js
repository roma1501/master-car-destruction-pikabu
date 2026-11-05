// GameCarView.js — как выглядит машина (перенесено из Obby Car Master и упрощено: водителя и дисков нет, стёкла
// тонированные). Риг из Blender (assets/models/cars/<id>.glb): колёса крутятся и поворачивают, подвеска ходит,
// кузов кренится в повороте и клюёт при торможении, руль крутится, фары горят, стоп-сигналы вспыхивают. Дым и
// огонь нитро из труб, следы шин в заносе (Skids — один общий меш на все машины). Нет файла модели — собирается
// запасная машина из кубиков, игра не падает (инвариант 6). CarView — и игрока, и ботов.

// Узлы колёс по порядку колёс физики (GameCar: задние левое/правое, передние левое/правое).
const LOOK_HUBS = ['HubRL', 'HubRR', 'HubFL', 'HubFR'];
const LOOK_WHEELS = ['WheelRL', 'WheelRR', 'WheelFL', 'WheelFR'];
const LOOK_STEER_RATIO = 2.6;     // во сколько раз руль крутится больше колёс (вид)

/** Путь модели машины: литералами — сборщик берёт в архив только файлы с такими ссылками. */
const CAR_URLS = {
    pocket: 'assets/models/cars/pocket.glb', wedge: 'assets/models/cars/wedge.glb', brute: 'assets/models/cars/brute.glb',
    finny: 'assets/models/cars/finny.glb', buggy: 'assets/models/cars/buggy.glb', van: 'assets/models/cars/van.glb',
    bus: 'assets/models/cars/bus.glb', pickup: 'assets/models/cars/pickup.glb', rally: 'assets/models/cars/rally.glb',
    volt: 'assets/models/cars/volt.glb', cruiser: 'assets/models/cars/cruiser.glb', hyper: 'assets/models/cars/hyper.glb',
};

/** Метаданные модели (CAR_MODELS, метры Blender) -> px движка (x вперёд, y вверх, z вправо). */
function lookCarMeta(id) {
    const src = (typeof CAR_MODELS !== 'undefined' && CAR_MODELS && CAR_MODELS[id]) || {};
    const e = (a, d) => { const v = Array.isArray(a) && a.length >= 3 ? a : d; return [v[0] * 100, v[2] * 100, -v[1] * 100]; };
    const st = src.steering || {};
    const ax = e(st.axis, [-0.93, 0, 0.37]);
    const al = Math.hypot(ax[0], ax[1], ax[2]) || 1;
    const g = (typeof GAME_CARS !== 'undefined' && GAME_CARS.find(c => c.id === id)) || null;
    return {
        id,
        wheelR: (Number(src.wheelRadius) || 0.36) * 100,
        steerAxis: [ax[0] / al, ax[1] / al, ax[2] / al],
        exhausts: Array.isArray(src.exhausts) ? src.exhausts.map(p => e(p, p)) : [e(null, [-2.2, -0.45, 0.3])],   // пустой список — электромобиль
        length: (Number(src.length) || 4.5) * 100,
        width: (Number(src.width) || 1.95) * 100,
        height: (Number(src.height) || 1.4) * 100,
        color: src.color || (g ? '#' + g.color.toString(16).padStart(6, '0') : '#2f7fe0'),
    };
}

/** Цвет 0xRRGGBB или '#rrggbb' -> Color3. */
function lookColor(c) {
    if (c == null) return null;
    const hex = typeof c === 'string' ? c : '#' + Number(c).toString(16).padStart(6, '0');
    return BABYLON.Color3.FromHexString(hex);
}

/** Следы шин: тёмные полосы под колёсами в заносе, при пробуксовке и резком торможении (кольцевой буфер). */
const Skids = {
    /** @type {any} */ mesh: null,
    /** @type {any} */ view: null,
    N: 900, head: 0, t: 0, fadeT: 0, dirty: false,
    /** @type {Float32Array | null} */ pos: null,
    /** @type {Float32Array | null} */ col: null,
    /** @type {Float32Array | null} */ born: null,
    /** @type {Float32Array | null} */ base: null,
    /** @type {Map<string, any>} */ tracks: new Map(),
    LIFE: 14,

    init(view) {
        if (this.mesh && this.view === view && !this.mesh.isDisposed()) return;
        this.view = view;
        const N = this.N, scene = view.scene;
        this.pos = new Float32Array(N * 12); this.col = new Float32Array(N * 16);
        this.born = new Float32Array(N).fill(-1e9); this.base = new Float32Array(N);
        const idx = new Uint32Array(N * 6);
        for (let i = 0; i < N; i++) { const v = i * 4, k = i * 6; idx[k] = v; idx[k + 1] = v + 1; idx[k + 2] = v + 2; idx[k + 3] = v + 1; idx[k + 4] = v + 3; idx[k + 5] = v + 2; }
        const mesh = new BABYLON.Mesh('skids', scene);
        const vd = new BABYLON.VertexData();
        vd.positions = this.pos; vd.colors = this.col; vd.indices = idx;
        vd.normals = new Float32Array(N * 12).map((_, i) => (i % 3 === 1 ? 1 : 0));
        vd.applyToMesh(mesh, true);
        mesh.hasVertexAlpha = true;
        mesh.isPickable = false;
        mesh.alwaysSelectAsActiveMesh = true;
        mesh.receiveShadows = false;
        const mat = new BABYLON.StandardMaterial('skids-mat', scene);
        mat.diffuseColor = new BABYLON.Color3(1, 1, 1);
        mat.specularColor = new BABYLON.Color3(0, 0, 0);
        mat.backFaceCulling = false;
        mat.zOffset = -4;
        mat.metadata = { toon: false };
        mesh.material = mat;
        this.mesh = mesh;
        this.tracks.clear();
    },

    mark(key, q, n, width, strength) {
        if (!this.mesh) return;
        const tr = this.tracks.get(key);
        const lift = 1.6, p = [q[0] + n[0] * lift, q[1] + n[1] * lift, q[2] + n[2] * lift];
        if (!tr) { this.tracks.set(key, { p, t: this.t }); return; }
        const dx = p[0] - tr.p[0], dy = p[1] - tr.p[1], dz = p[2] - tr.p[2], d = Math.hypot(dx, dy, dz);
        if (d > 420 || this.t - tr.t > 0.3) { tr.p = p; tr.t = this.t; return; }
        if (d < 36) return;
        let sx = dy * n[2] - dz * n[1], sy = dz * n[0] - dx * n[2], sz = dx * n[1] - dy * n[0];
        const sl = Math.hypot(sx, sy, sz) || 1, w = width / 2;
        sx = sx / sl * w; sy = sy / sl * w; sz = sz / sl * w;
        const i = this.head, P = this.pos, C = this.col;
        this.head = (this.head + 1) % this.N;
        const o = i * 12, a = tr.p, b = p;
        P[o] = a[0] - sx; P[o + 1] = a[1] - sy; P[o + 2] = a[2] - sz;
        P[o + 3] = a[0] + sx; P[o + 4] = a[1] + sy; P[o + 5] = a[2] + sz;
        P[o + 6] = b[0] - sx; P[o + 7] = b[1] - sy; P[o + 8] = b[2] - sz;
        P[o + 9] = b[0] + sx; P[o + 10] = b[1] + sy; P[o + 11] = b[2] + sz;
        const al = Math.max(0.15, Math.min(0.75, strength * 0.8));
        this.base[i] = al; this.born[i] = this.t;
        for (let k = 0; k < 4; k++) { const c = i * 16 + k * 4; C[c] = 0.04; C[c + 1] = 0.04; C[c + 2] = 0.05; C[c + 3] = al; }
        tr.p = p; tr.t = this.t;
        this.dirty = true;
    },

    lift(key) { this.tracks.delete(key); },

    clear() {
        if (!this.mesh) return;
        this.pos.fill(0); this.col.fill(0); this.born.fill(-1e9); this.tracks.clear(); this.head = 0;
        this.dirty = true;
    },

    update(dt) {
        if (!this.mesh) return;
        this.t += dt;
        this.fadeT += dt;
        if (this.fadeT > 0.25) {
            this.fadeT = 0;
            const C = this.col, fade = 3;
            for (let i = 0; i < this.N; i++) {
                const age = this.t - this.born[i];
                if (age < this.LIFE - fade || age > this.LIFE + 1) continue;
                const a = this.base[i] * Math.max(0, (this.LIFE - age) / fade);
                for (let k = 0; k < 4; k++) C[i * 16 + k * 4 + 3] = a;
                this.dirty = true;
            }
        }
        if (this.dirty) {
            this.dirty = false;
            this.mesh.updateVerticesData(BABYLON.VertexBuffer.PositionKind, this.pos);
            this.mesh.updateVerticesData(BABYLON.VertexBuffer.ColorKind, this.col);
        }
    },
};

/** Запасная машина из кубиков: тот же интерфейс, что у RigInstance (то, чем пользуется CarView). */
class LookBlockRig {
    constructor(view, meta) {
        const scene = view.scene;
        this.view = view;
        this.root = new BABYLON.Mesh('block-car', scene);
        /** @type {Map<string, any>} */ this.nodes = new Map();
        /** @type {Map<string, any>} */ this.parts = new Map();
        this._off = new Map();
        this._rest = new Map();
        this.disposed = false;
        const L = meta.length, W = meta.width, H = meta.height, R = meta.wheelR;
        const node = (name, parent, x, y, z) => {
            const tn = new BABYLON.TransformNode('block:' + name, scene);
            tn.parent = parent || this.root; tn.position.set(x, y, z);
            tn.rotationQuaternion = new BABYLON.Quaternion();
            this.nodes.set(name, tn); this._rest.set(name, [x, y, z]); return tn;
        };
        const box = (name, parent, w, h, d, x, y, z, color, alpha) => {
            const m = BABYLON.MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, scene);
            const mat = new BABYLON.StandardMaterial(name + '-m', scene);
            mat.diffuseColor = BABYLON.Color3.FromHexString(color); mat.specularColor = new BABYLON.Color3(0.15, 0.15, 0.15);
            if (alpha != null) mat.alpha = alpha;
            m.material = mat; m.parent = parent; m.position.set(x, y, z); m.isPickable = false;
            m.metadata = { part: name };
            if (!this.parts.has(name)) this.parts.set(name, m);
            return m;
        };
        const body = node('Body', null, 0, 0, 0);
        box('Body', body, L * 0.96, H * 0.36, W * 0.95, 0, R + H * 0.12, 0, '#ffffff');
        box('Glass', body, L * 0.45, H * 0.34, W * 0.85, -L * 0.06, R + H * 0.47, 0, '#1b2534', 0.85);
        box('BodyRoof', body, L * 0.4, 8, W * 0.8, -L * 0.06, H - 6, 0, '#ffffff');
        box('LightF', body, 6, 16, W * 0.75, L * 0.48, R + H * 0.18, 0, '#fff6d0');
        box('LightR', body, 6, 14, W * 0.75, -L * 0.48, R + H * 0.2, 0, '#ff2a2a');
        node('Steering', body, 0, R + H * 0.3, -W * 0.2);
        const ax = (typeof CAR_MODELS !== 'undefined' && CAR_MODELS[meta.id] && CAR_MODELS[meta.id].axleX ? CAR_MODELS[meta.id].axleX * 100 : 135);
        const tr = (typeof CAR_MODELS !== 'undefined' && CAR_MODELS[meta.id] && CAR_MODELS[meta.id].trackY ? CAR_MODELS[meta.id].trackY * 100 : 80);
        const spots = /** @type {Array<[string, string, number, number]>} */ ([['HubRL', 'WheelRL', -ax, -tr], ['HubRR', 'WheelRR', -ax, tr], ['HubFL', 'WheelFL', ax, -tr], ['HubFR', 'WheelFR', ax, tr]]);
        for (const [hub, wheel, x, z] of spots) {
            const h = node(hub, body, x, R, z);
            const w = node(wheel, h, 0, 0, 0);
            const t = BABYLON.MeshBuilder.CreateCylinder(wheel, { diameter: R * 2, height: 26, tessellation: 20 }, scene);
            t.rotation.x = Math.PI / 2; t.parent = w; t.isPickable = false; t.metadata = { part: wheel };
            const mat = new BABYLON.StandardMaterial(wheel + '-m', scene); mat.diffuseColor = new BABYLON.Color3(0.1, 0.1, 0.12); t.material = mat;
            this.parts.set(wheel, t);
            box(wheel + 'Rim', w, R * 1.1, R * 1.1, 28, 0, 0, 0, '#c9ced8');
        }
        World3D.addObject(view, this.root, 'actor');
    }
    offset(name, rx, ry, rz, px, py, pz) { this._off.set(name, [rx || 0, ry || 0, rz || 0, px || 0, py || 0, pz || 0]); }
    update() {
        for (const [name, r] of this._off) {
            const n = this.nodes.get(name), rest = this._rest.get(name);
            if (!n) continue;
            BABYLON.Quaternion.RotationYawPitchRollToRef(r[1], r[0], r[2], n.rotationQuaternion);
            if (rest) n.position.set(rest[0] + r[3], rest[1] + r[4], rest[2] + r[5]);
        }
        this._off.clear();
    }
    play() { return true; }
    stop() { /* клипов нет */ }
    has() { return false; }
    setPartVisible(prefix, on) { for (const [name, m] of this.parts) if (name.startsWith(prefix)) m.setEnabled(!!on); }
    dispose() { this.disposed = true; World3D.removeObject(this.view, this.root); try { this.root.dispose(false, true); } catch (e) { /* уже */ } }
}

/** Сетка, повреждения и вид повреждений для машины C (игрок, бот, трафик). */
function carEquipDamage(C, carView, opts) {
    const id = C.spec.id;
    const m = (typeof CAR_MODELS !== 'undefined' && CAR_MODELS[id]) || {}, h = (typeof CAR_HULLS !== 'undefined' && CAR_HULLS[id]) || null;
    C.soft = new SoftBody(CarLattice.build(C.spec, m, h), { comH: C.spec.comH });
    C.damage = new CarDamage(C, opts);
    if (carView) carView.attachDamage(C);
    CarWorld.add(C);
    return C;
}

/** Вид одной машины (игрок и боты). */
class CarView {
    constructor(view, name) {
        /** @type {any} */ this.skin = null;
        /** @type {any} */ this.dmgCar = null;
        this._setToken = 0;
        this.view = view;
        this.name = name || 'car';
        /** @type {any} */ this.car = null;
        /** @type {any} */ this.meta = lookCarMeta('');
        this.id = '';
        this.paintId = '';
        /** @type {any[]} */ this._mats = [];
        this.brakeOn = null;
        this.lightsOn = null;
        /** @type {any} */ this.lightMats = { f: [], r: [] };
        this.steerVis = 0;
        this.visible = true;
        /** @type {any[] | null} */ this.exFx = null;
        this._uid = String(Math.random()).slice(2, 7);
    }

    /** Поставить машину id (модель из кэша CarView.load). */
    async setCar(id) {
        const meta = lookCarMeta(id);
        const token = ++this._setToken;
        const model = await CarView.load(id);
        if (token !== this._setToken) return this.car;     // пока грузилась, выбрали другую машину
        const old = this.car;
        const car = model ? Rig.create(model, this.view, { name: this.name }) : new LookBlockRig(this.view, meta);
        car.root.rotationQuaternion = new BABYLON.Quaternion();
        this.car = car; this.meta = meta; this.id = id;
        for (const e of this.exFx || []) { try { e.h.stop(); } catch (er) { /* уже */ } }
        this.exFx = null;
        if (old) old.dispose();
        for (const m of this._mats) { try { m.dispose(); } catch (e) { /* уже */ } }   // краска и огни прежнего рига
        this._mats = [];
        for (const m of car.root.getChildMeshes(false)) m.receiveShadows = false;
        this._paint();
        this._lights();
        car.root.setEnabled(this.visible);
        if (this.skin) { this.skin.dispose(); this.skin = null; }
        if (this.dmgCar) this.attachDamage(this.dmgCar);
        return car;
    }

    /** Подключить повреждения машины C (физика с soft и damage): меш пойдёт за сеткой. */
    attachDamage(C) {
        this.dmgCar = C;
        if (this.skin) { this.skin.dispose(); this.skin = null; }
        if (!C || !C.soft || !this.car || this.car instanceof LookBlockRig) return;
        this.skin = new CarSkin(this, C);
    }

    /** Окраска игрока: id из CAR_PAINTS или '' — заводская. Применяется пересборкой рига из кэша модели. */
    async setPaint(id) {
        const want = id || '';
        if (this.paintId === want) return;
        this.paintId = want;
        if (this.id) await this.setCar(this.id);
    }

    // Белые вершины частей Body — цвет машины (заводской или окраска CAR_PAINTS; своя копия буфера, клоны рига делят геометрию).
    _paint() {
        const car = this.car;
        const paint = this.paintId && typeof CAR_PAINTS !== 'undefined' ? CAR_PAINTS.find(p => p.id === this.paintId) : null;
        const col = (paint ? lookColor(paint.color) : lookColor(this.meta.color)) || new BABYLON.Color3(1, 1, 1);
        const spec = paint ? lookColor(paint.spec) : new BABYLON.Color3(0.38, 0.38, 0.38);
        const glow = paint && paint.glow ? lookColor(paint.glow) : null;
        for (const [name, mesh] of car.parts) {
            if (!name.startsWith('Body') && !name.startsWith('Panel')) continue;
            if (car instanceof LookBlockRig) { mesh.material.diffuseColor = col.clone(); continue; }
            const kind = BABYLON.VertexBuffer.ColorKind;
            const src = mesh.getVerticesData(kind);
            if (!src) continue;
            mesh.makeGeometryUnique();
            const out = new Float32Array(src.length);
            for (let i = 0; i < src.length; i += 4) {
                const white = src[i] > 0.985 && src[i + 1] > 0.985 && src[i + 2] > 0.985;
                out[i] = white ? col.r : src[i]; out[i + 1] = white ? col.g : src[i + 1]; out[i + 2] = white ? col.b : src[i + 2]; out[i + 3] = src[i + 3];
            }
            mesh.setVerticesData(kind, out, false);
            const one = (m) => {
                const k = m.clone(m.name + '+paint');
                k.specularColor = spec.clone(); k.specularPower = paint ? paint.power : 40;
                if (glow) k.emissiveColor = glow.clone();
                this._mats.push(k); return k;
            };
            const mat = mesh.material;
            if (mat && mat.subMaterials) { const multi = new BABYLON.MultiMaterial(mat.name + '+paint', mesh.getScene()); multi.subMaterials = mat.subMaterials.map(m => (m && !/glass/i.test(m.name) ? one(m) : m)); mesh.material = multi; this._mats.push(multi); }
            else if (mat && !/glass/i.test(mat.name)) mesh.material = one(mat);
        }
    }

    // Фары и фонари — свои материалы (светятся; стоп-сигналы ярче при торможении).
    _lights() {
        const car = this.car;
        this.lightMats = { f: [], r: [] };
        this.brakeOn = null; this.lightsOn = null;
        for (const [name, mesh] of car.parts) {
            const key = name.startsWith('LightF') ? 'f' : name.startsWith('LightR') ? 'r' : '';
            if (!key || !mesh.material) continue;
            const one = (m) => { const k = m.clone(m.name + '+lit'); k.metadata = Object.assign({}, k.metadata, { toon: false }); this._mats.push(k); this.lightMats[key].push(k); return k; };
            const mat = mesh.material;
            if (mat.subMaterials) { const multi = new BABYLON.MultiMaterial(mat.name + '+lit', mesh.getScene()); multi.subMaterials = mat.subMaterials.map(m => (m ? one(m) : m)); mesh.material = multi; this._mats.push(multi); }
            else mesh.material = one(mat);
        }
    }

    _setLights(brake) {
        if (this.brakeOn === brake && this.lightsOn) return;
        this.brakeOn = brake; this.lightsOn = true;
        for (const m of this.lightMats.f) m.emissiveColor = new BABYLON.Color3(0.85, 0.82, 0.7);
        for (const m of this.lightMats.r) m.emissiveColor = brake ? new BABYLON.Color3(1, 0.12, 0.08) : new BABYLON.Color3(0.45, 0.04, 0.03);
    }

    /** Кадр: корень по физике машины, колёса, руль, огни, «живой» кузов. */
    pose(C, dt) {
        const car = this.car;
        if (!car) return;
        car.root.position.set(C.p[0], C.p[1] - (C.visLift || 0), C.p[2]);
        car.root.rotationQuaternion.set(C.q[0], C.q[1], C.q[2], C.q[3]);
        const R = this.meta.wheelR, S = C.spec;
        const k = dt ? Math.min(0.05, dt) : 0;
        if (k > 0) {
            let dyaw = C.yaw - (this._yawPrev == null ? C.yaw : this._yawPrev); dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
            const yawRate = dyaw / k, aLong = (C.vf - (this._vfBody == null ? C.vf : this._vfBody)) / k;
            this._yawPrev = C.yaw; this._vfBody = C.vf;
            const on = C.grounded ? 1 : 0;
            const wantR = on * Math.max(-0.07, Math.min(0.07, -C.vf * yawRate / 60000));
            const wantP = on * Math.max(-0.045, Math.min(0.04, aLong / 70000));
            const sp = this._bodySp || (this._bodySp = { r: 0, vr: 0, p: 0, vp: 0 });
            sp.vr += ((wantR - sp.r) * 140 - sp.vr * 15) * k; sp.r += sp.vr * k;
            sp.vp += ((wantP - sp.p) * 160 - sp.vp * 16) * k; sp.p += sp.vp * k;
            car.offset('Body', sp.r, 0, sp.p);
        }
        const bs = this._bodySp || { r: 0, p: 0 };
        for (let i = 0; i < 4; i++) {
            const w = C.wheels[i];
            if (w.lost) continue;      // колесо улетело: узел двигает обломок
            const comp = w.fx * Math.sin(bs.p) - w.sz * Math.sin(bs.r);
            const dy = Math.max(-S.suspRest * 0.6, Math.min(S.suspRest * 0.3, S.suspRest - w.susp)) - comp;
            car.offset(LOOK_HUBS[i], w.camber, (w.front ? -C.steer : 0) - w.toe, 0, w.bx, dy + w.by, w.bz);
            car.offset(LOOK_WHEELS[i], 0, 0, -w.spin * S.R / R);
            const wn = car.nodes.get(LOOK_WHEELS[i]);
            if (wn) { const k = w.flat ? 0.82 : 1; if (wn.scaling.x !== k) wn.scaling.set(k, k, 1); }
        }
        this.steerVis += (C.steer * LOOK_STEER_RATIO - this.steerVis) * Math.min(1, 14 * (dt || 0.016));
        const a = this.meta.steerAxis;
        const q = BABYLON.Quaternion.RotationAxis(new BABYLON.Vector3(a[0], a[1], a[2]), this.steerVis);
        const e = q.toEulerAngles();
        car.offset('Steering', e.x, e.y, e.z);
        this._setLights(!!C.braking || (C.throttle < -0.1 && C.vf > 60));
        if (car instanceof LookBlockRig) car.update();
    }

    /** Выхлоп и пламя нитро из труб, следы шин; opts.bot — бот (реже), opts.on — едет. */
    effects(C, dt, opts) {
        const o = opts || {}, car = this.car, fx = CarView.app && CarView.app.fx;
        if (!car) return;
        const on = !!o.on && this.visible && !C.dead;
        if (fx && !this.exFx) {
            this.exFx = [];
            const ex = this.meta.exhausts.length ? this.meta.exhausts : [[-this.meta.length / 2 + 10, 40, -30], [-this.meta.length / 2 + 10, 40, 30]];
            for (const e of ex.slice(0, o.bot ? 1 : 2)) {
                const local = new BABYLON.Vector3(e[0] - 6, e[1], e[2]);
                const follow = () => BABYLON.Vector3.TransformCoordinates(local, car.root.getWorldMatrix());
                const smoke = this.meta.exhausts.length ? fx.create({ texture: 'assets/fx/smoke-puff.webp', blend: 'standard', rate: 0, capacity: o.bot ? 24 : 60, life: [0.45, 1.0], size: [12, 26], speed: [20, 70],
                    follow, direction: [[-0.35, 0.3, -0.35], [0.35, 0.8, 0.35]], gravity: [0, 70, 0],
                    colorGradient: [[0, '#d9dce6', 0.5], [0.5, '#b7bac6', 0.3], [1, '#a4a7b3', 0]], sizeGradient: [[0, 0.6], [1, 2.6]] }) : null;
                const flame = fx.create({ texture: 'assets/fx/flame.webp', rate: 0, capacity: 40, life: [0.08, 0.18], size: [26, 46], speed: [60, 160], follow,
                    direction: [[-1, -0.1, -0.15], [-0.6, 0.15, 0.15]], colorGradient: [[0, '#9ff3ff', 1], [0.5, '#3aa8ff', 0.8], [1, '#ff7a1a', 0]] });
                this.exFx.push({ h: smoke, flame, local });
            }
        }
        if (this.exFx) {
            const thr = Math.max(0, C.throttle || 0), sp = Math.min(1, Math.abs(C.vf) / 2600);
            const rate = !on ? 0 : (o.bot ? 2 + 8 * thr : 4 + 36 * thr * (1 - 0.45 * sp));
            for (const e of this.exFx) {
                if (e.h) e.h.setRate(rate);
                if (e.flame) e.flame.setRate(on && C.nitroOn ? 90 : 0);
            }
        }
        // следы шин: занос, пробуксовка с места, ручник, резкий тормоз
        const id = this.name + this._uid;
        for (let i = 0; i < 4; i++) {
            const w = C.wheels[i], key = id + i;
            const burn = !w.front && C.throttle > 0.6 && Math.abs(C.vf) < 650 && C.grounded;
            const brake = C.braking && Math.abs(C.vf) > 500;
            const s = Math.max(w.slip > 0.32 ? (w.slip - 0.25) * 1.6 : 0, burn ? 0.8 : 0, brake ? 0.55 : 0, w.flat ? 0.5 : 0);
            if (on && !w.lost && w.contact && !(w.col && w.col.dynamic) && s > 0.12) Skids.mark(key, w.q, w.n, Math.max(20, this.meta.width * 0.13), s);
            else Skids.lift(key);
            // пыль из-под колеса на грунте, дым шин в заносе и при пробуксовке
            if (on && !w.lost && w.contact && typeof CrashFx !== 'undefined') {
                const paved = w.surf === 'asphalt' || w.surf === 'concrete';
                const sp = Math.hypot(C.v[0], C.v[2]);
                const pw = paved ? (s > 0.35 ? s * 0.9 : 0) : (sp > 240 ? Math.min(1, sp / 2600) * (w.surf === 'grass' ? 0.45 : 1) : 0);
                if (pw > 0.02) CrashFx.wheelFx(key, w.q[0], w.q[1], w.q[2], C.v[0], C.v[1], C.v[2], pw, w.surf || 'asphalt');
            }
        }
    }

    setVisible(on) {
        this.visible = !!on;
        if (this.car) this.car.root.setEnabled(!!on);
        if (!on) for (const e of this.exFx || []) { if (e.h) e.h.setRate(0); if (e.flame) e.flame.setRate(0); }
    }

    /** Прозрачность (мигание после возрождения бота). */
    setAlpha(a) {
        if (this._alpha === a) return;
        this._alpha = a;
        if (this.car) for (const m of this.car.root.getChildMeshes(false)) m.visibility = a;
    }

    dispose() {
        for (const e of this.exFx || []) { try { if (e.h) e.h.stop(); if (e.flame) e.flame.stop(); } catch (er) { /* уже */ } }
        this.exFx = null;
        if (this.skin) { this.skin.dispose(); this.skin = null; }
        this.dmgCar = null;
        try { if (this.car) this.car.dispose(); } catch (e) { /* уже */ }
        for (const m of this._mats) { try { m.dispose(); } catch (e) { /* уже */ } }
        this._mats = [];
        this.car = null;
    }
}

/** @type {any} */
CarView.app = null;
/** @type {Record<string, Promise<any>>} */
CarView._models = {};

/** Модель машины id (Rig.load, кэш; нет файла — null, будет машина из кубиков). */
CarView.load = function (id) {
    const url = CAR_URLS[id];
    if (!url) return Promise.resolve(null);
    if (!(id in CarView._models)) CarView._models[id] = Rig.load(url).catch((e) => { console.warn('CarView: нет модели ' + url + ' — запасная', e && e.message); return null; });
    return CarView._models[id];
};

/** Эффекты машин (зовёт игра один раз при запуске). */
CarView.registerFx = function (app) {
    CarView.app = app;
    const fx = app.fx;
    if (!fx) return;
    fx.register('carbump', [
        { texture: 'assets/fx/spark-streak.webp', burst: 22, capacity: 26, life: [0.15, 0.4], size: [14, 30], speed: [380, 900], gravity: [0, -1500, 0], direction: [[-1, 0.2, -1], [1, 1.2, 1]], color: '#ffe28a' },
        { texture: 'assets/fx/flash-star.webp', burst: 2, capacity: 3, life: [0.08, 0.14], size: [70, 120], speed: [0, 10], color: '#fff6d0' },
    ]);
    fx.register('carcrash', [
        { texture: 'assets/fx/smoke-puff.webp', blend: 'standard', burst: 18, capacity: 24, life: [0.8, 1.6], size: [90, 180], speed: [80, 260], direction: [[-1, 0.4, -1], [1, 1.4, 1]], gravity: [0, 160, 0], alpha: 0.85, color: '#3a3440' },
        { texture: 'assets/fx/flame.webp', burst: 16, capacity: 20, life: [0.25, 0.55], size: [70, 140], speed: [120, 380], direction: [[-1, 0.3, -1], [1, 1.2, 1]] },
        { texture: 'assets/fx/spark-streak.webp', burst: 24, capacity: 30, life: [0.2, 0.5], size: [20, 44], speed: [400, 900], gravity: [0, -1200, 0], color: '#ffd27a' },
    ]);
    fx.register('landdust', [
        { texture: 'assets/fx/dust-puff.webp', blend: 'standard', burst: 12, capacity: 16, life: [0.4, 0.9], size: [50, 100], speed: [80, 260], direction: [[-1, 0.1, -1], [1, 0.4, 1]], alpha: 0.75 },
    ]);
    fx.register('checkpoint', [
        { texture: 'assets/fx/confetti-color.webp', blend: 'standard', burst: 40, capacity: 50, life: [0.8, 1.6], size: [14, 26], speed: [250, 520], spin: [-6, 6], gravity: [0, -900, 0], direction: [[-1, 0.6, -1], [1, 1.4, 1]] },
        { texture: 'assets/fx/sparkle-4pt.webp', burst: 14, capacity: 20, life: [0.3, 0.7], size: [30, 60], speed: [40, 140], color: '#d9ff7a' },
    ]);
    fx.register('finish', [
        { texture: 'assets/fx/confetti-color.webp', blend: 'standard', burst: 130, capacity: 150, life: [1.2, 2.4], size: [16, 30], speed: [300, 800], spin: [-6, 6], gravity: [0, -700, 0], direction: [[-1, 0.5, -1], [1, 1.6, 1]] },
        { delay: 0.1, texture: 'assets/fx/rainbow-star.webp', blend: 'standard', burst: 30, capacity: 40, life: [0.8, 1.6], size: [24, 44], speed: [200, 500], gravity: [0, -400, 0] },
    ]);
    fx.register('stunt', [
        { texture: 'assets/fx/sparkle-4pt.webp', burst: 16, capacity: 20, life: [0.3, 0.7], size: [26, 54], speed: [80, 260], color: '#c5ef5c' },
        { texture: 'assets/fx/shockwave-ring.webp', burst: 1, capacity: 2, life: [0.35, 0.35], size: [80, 80], speed: [0, 0], sizeGradient: [[0, 0.4], [1, 3.2]], colorGradient: [[0, '#c5ef5c', 0.9], [1, '#c5ef5c', 0]] },
    ]);
};
