// ObbyAvatar.js — вид персонажа-«блока» из простой геометрии (без моделей и ригов), табличка с ником над головой и
// ObbyCharacter — готовый актор для ObbyBots / игрока: тело ObbyBody + вид. Игра с настоящей моделью (Rig, байк, машина)
// заменяет этот файл своим актором того же контракта (см. шапку ObbyBots.js).
//
//   const view = app.location.view;
//   const hero = new ObbyCharacter(ObbyCourse, view, { x, y, z, look: { skin, shirt, pants, hair, hairColor, cap } });
//   hero.step(dt, { dx, dz, jump });                 // физика и вид вместе; hero.pose('run'|'idle'|'air'|'dead'|'cheer', dt)
//   const tags = new ObbyNameTags(view);             // ники и пузыри реплик ботов (DOM поверх холста)
//   ObbyBots.init({ createActor: spec => new ObbyCharacter(ObbyCourse, view, { look: spec.look }), tags, … });
//
// Часть тела — один меш с цветами в вершинах (общий белый материал): персонаж = 6 мешей (голова с лицом и волосами,
// торс, две руки, две ноги). Оси: нос персонажа вдоль +X, вверх Y, конечности качаются вокруг оси Z.

/** @satisfies {Record<string, any>} */
const ObbyAvatar = {
    /** Рост модели при масштабе 1, px. */
    HEIGHT: 172,
    /** @type {WeakMap<any, any>} */ _mats: new WeakMap(),

    // Общий белый материал сцены: цвет несут вершины.
    material(scene) {
        let m = this._mats.get(scene);
        if (m) return m;
        m = new BABYLON.StandardMaterial('obby-avatar', scene);
        m.diffuseColor = new BABYLON.Color3(1, 1, 1);
        m.specularColor = new BABYLON.Color3(0.05, 0.05, 0.05);
        this._mats.set(scene, m);
        return m;
    },

    _color(hex) { return BABYLON.Color3.FromHexString('#' + Number(hex).toString(16).padStart(6, '0')); },

    // Брус w × h × d (x, y, z) с центром в (cx, cy, cz) и своим цветом.
    _box(scene, name, w, h, d, hex, cx, cy, cz) {
        const c = this._color(hex), col = new BABYLON.Color4(c.r, c.g, c.b, 1);
        const m = BABYLON.MeshBuilder.CreateBox(name, { width: w, height: h, depth: d, faceColors: [col, col, col, col, col, col] }, scene);
        m.position.set(cx, cy, cz);
        m.material = this.material(scene);
        m.isPickable = false;
        return m;
    },

    // Слить меши в один (вершинные цвета сохраняются); пусто — null.
    _merge(list, name) {
        const m = BABYLON.Mesh.MergeMeshes(list, true, true);
        if (m) m.name = name;
        return m;
    },

    /**
     * Построить аватар: { root, body, parts, dispose } — root ставит игра (позиция ног, rotation.y = −курс).
     * look: { skin, shirt, pants, hair: 'short' | 'spiky' | 'long' | 'none', hairColor, cap: цвет | −1 }. height — рост, px.
     */
    create(view, look, height) {
        const scene = view.scene, L = Object.assign({ skin: 0xf4d6b0, shirt: 0x3e7bfa, pants: 0x2a2f45, hair: 'short', hairColor: 0x3b2a1a, cap: -1 }, look || {});
        const S = (height || this.HEIGHT) / this.HEIGHT, B = (...a) => this._box(scene, ...a);
        const root = new BABYLON.Mesh('obby-avatar-root', scene);
        const body = new BABYLON.TransformNode('obby-avatar-body', scene);   // качание, прыжок и кувырок — на нём, не на корне
        body.parent = root;
        body.scaling.setAll(S);
        // голова: куб + лицо + волосы / кепка — одним мешем
        const head = [B('h', 40, 40, 40, L.skin, 0, 0, 0), B('eyeL', 3, 7, 7, 0x1b1b24, 20, 4, -9), B('eyeR', 3, 7, 7, 0x1b1b24, 20, 4, 9), B('mouth', 3, 3, 14, 0x7a3b3b, 20, -9, 0)];
        if (L.hair === 'short') head.push(B('hair', 44, 10, 44, L.hairColor, 0, 21, 0), B('hairB', 6, 20, 44, L.hairColor, -20, 8, 0));
        else if (L.hair === 'spiky') for (const z of [-14, 0, 14]) head.push(B('spike', 10, 16, 10, L.hairColor, 0, 25, z), B('spikeB', 10, 10, 10, L.hairColor, -14, 22, z));
        else if (L.hair === 'long') head.push(B('hair', 44, 8, 44, L.hairColor, 0, 21, 0), B('hairB', 6, 38, 44, L.hairColor, -20, -2, 0), B('hairL', 36, 20, 5, L.hairColor, -4, -8, -21), B('hairR', 36, 20, 5, L.hairColor, -4, -8, 21));
        if (L.cap != null && L.cap >= 0) head.push(B('cap', 46, 9, 46, L.cap, 0, 22, 0), B('brim', 20, 3, 34, L.cap, 22, 18, 0));
        const headMesh = this._merge(head, 'obby-head');
        headMesh.parent = body;
        headMesh.position.set(0, 66 + 66 + 20, 0);
        // торс, руки и ноги на шарнирах (pivot-узлы), качание вокруг оси Z
        const torso = B('obby-torso', 30, 66, 58, L.shirt, 0, 0, 0);
        torso.parent = body; torso.position.set(0, 66 + 33, 0);
        const limb = (name, hex, w, h, d, px, py, pz, extra) => {
            const pivot = new BABYLON.TransformNode(name + '-pivot', scene);
            pivot.parent = body; pivot.position.set(px, py, pz);
            const parts = [B(name, w, h, d, hex, 0, -h / 2, 0)];
            if (extra) parts.push(extra(B));
            const m = parts.length > 1 ? this._merge(parts, name) : parts[0];
            m.parent = pivot;
            return { pivot, mesh: m };
        };
        const legL = limb('obby-legL', L.pants, 24, 66, 24, 0, 66, -15), legR = limb('obby-legR', L.pants, 24, 66, 24, 0, 66, 15);
        // руки: рукав цвета рубашки, кисть цвета кожи
        const arm = (name, z) => limb(name, L.shirt, 20, 60, 20, 0, 66 + 62, z, (Bx) => Bx(name + '-hand', 20, 12, 20, L.skin, 0, -60 + 6 - 0, 0));
        const armL = arm('obby-armL', -39), armR = arm('obby-armR', 39);
        const meshes = [headMesh, torso, legL.mesh, legR.mesh, armL.mesh, armR.mesh];
        World3D.addObject(view, root, 'actor');
        return {
            root, body, head: headMesh, meshes,
            legL: legL.pivot, legR: legR.pivot, armL: armL.pivot, armR: armR.pivot,
            dispose() { try { World3D.removeObject(view, root); } catch (e) { /* уже снят */ } },
        };
    },
};

// ---------------------------------------------------------------------------------------------------------------------
// Персонаж = тело + вид
// ---------------------------------------------------------------------------------------------------------------------

class ObbyCharacter extends ObbyBody {
    /** @param {any} course @param {any} view View3D @param {{ look?: any, height?: number, x?: number, y?: number, z?: number, yaw?: number, radius?: number, cfg?: any }} [opts] */
    constructor(course, view, opts) {
        super(course, opts);
        const o = opts || {};
        this.view = view;
        this.avatar = ObbyAvatar.create(view, o.look, this.height);
        this.phase = Math.random() * 6;
        this.state = 'idle';
        this.shield = false;
        this.tumble = 0;
        this.t = 0;
        this.visible = true;
        this.sync();
    }

    /** Шаг физики и вида. */
    step(dt, cmd) {
        super.step(dt, cmd);
        this.sync();
    }

    place(x, y, z, yaw) {
        super.place(x, y, z, yaw);
        this.tumble = 0;
        if (this.avatar) { this.avatar.body.rotation.z = 0; this.sync(); }
    }

    /** Корень вида — на ноги тела. */
    sync() {
        const r = this.avatar.root;
        r.position.set(this.x, this.y, this.z);
        r.rotation.y = -this.yaw;
    }

    setVisible(on) { this.visible = !!on; this.avatar.root.setEnabled(this.visible); }

    setShield(on) {
        this.shield = !!on;
        if (!on) for (const m of this.avatar.meshes) m.visibility = 1;
    }

    /** Поза конечностей: 'idle' | 'run' | 'air' | 'dead' | 'cheer'. Чистая функция фазы — вид, не игровое решение. */
    pose(state, dt) {
        const a = this.avatar;
        this.t += dt || 0;
        const sp = Math.min(1, Math.abs(this.speed || 0) / 520);
        if (state === 'run') this.phase += (dt || 0) * (7 + sp * 8);
        let ls = 0, rs = 0, la = 0, ra = 0, bob = 0, tilt = 0;
        const ph = this.phase;
        if (state === 'run') { const k = 0.35 + 0.65 * sp; ls = Math.sin(ph) * 0.95 * k; rs = -ls; la = -ls * 0.9; ra = -rs * 0.9; bob = Math.abs(Math.cos(ph)) * 5 * k; tilt = -0.08 * sp; }
        else if (state === 'air') { ls = 0.55; rs = -0.45; la = 2.5; ra = 2.5; tilt = -0.05; }
        else if (state === 'cheer') { la = 2.7 + Math.sin(this.t * 11) * 0.35; ra = 2.7 - Math.sin(this.t * 11) * 0.35; bob = Math.abs(Math.sin(this.t * 6)) * 22; }
        else if (state === 'dead') { ls = 0.9; rs = -0.9; la = 1.3; ra = -1.3; this.tumble += (dt || 0) * 9; }
        else { la = Math.sin(this.t * 1.8) * 0.05; ra = -la; bob = Math.sin(this.t * 2.2) * 1.2; }
        if (state !== 'dead') this.tumble = 0;
        a.legL.rotation.z = ls; a.legR.rotation.z = rs; a.armL.rotation.z = la; a.armR.rotation.z = ra;
        a.body.position.y = bob;
        a.body.rotation.z = state === 'dead' ? this.tumble : tilt;
        this.state = state;
        if (this.shield) { const v = Math.floor(this.t * 8) % 2 ? 0.35 : 0.85; for (const m of a.meshes) m.visibility = v; }
    }

    dispose() { this.avatar.dispose(); }
}

// ---------------------------------------------------------------------------------------------------------------------
// Таблички с ником и пузыри реплик (DOM поверх холста)
// ---------------------------------------------------------------------------------------------------------------------

const OBBY_TAGS_CSS = `
#obby-tags { position: fixed; inset: 0; pointer-events: none; z-index: 15; overflow: hidden; font-family: var(--obby-tag-font, system-ui, sans-serif); }
#obby-tags .otag { position: absolute; left: 0; top: 0; white-space: nowrap; will-change: transform; display: flex; flex-direction: column; align-items: center; gap: 3px; }
#obby-tags .otag.off { display: none; }
#obby-tags .oname { color: #fff; font-size: 15px; font-weight: 700; padding: 1px 8px 2px; border-radius: 9px; background: rgba(20,24,40,.58); text-shadow: 0 1px 2px #000, 0 0 3px #000; }
#obby-tags .obub { max-width: 220px; white-space: normal; text-align: center; color: #1b1b24; font-size: 14px; font-weight: 600; line-height: 1.15; padding: 4px 9px; border-radius: 11px; background: rgba(255,255,255,.94); }
#obby-tags .obub:empty { display: none; }
`;

/** Ники и реплики над головами ботов: проекция через View3D.projectToScreen, без чужих слоёв и текстур. */
class ObbyNameTags {
    /** @param {any} view View3D @param {{ css?: string, parent?: HTMLElement, maxDist?: number }} [opts] */
    constructor(view, opts) {
        this.view = view;
        this.opts = opts || {};
        /** @type {Map<number, { el: HTMLElement, bub: HTMLElement, left: number }>} */
        this.tags = new Map();
        this.box = null;
        if (typeof document === 'undefined') return;
        if (!document.getElementById('obby-tags-css')) {
            const st = document.createElement('style');
            st.id = 'obby-tags-css'; st.textContent = OBBY_TAGS_CSS + (this.opts.css || '');
            document.head.appendChild(st);
        }
        this.box = document.getElementById('obby-tags');
        if (!this.box) {
            this.box = document.createElement('div');
            this.box.id = 'obby-tags';
            (this.opts.parent || document.body).appendChild(this.box);
        }
    }

    add(id, name) {
        if (!this.box || this.tags.has(id)) return;
        const el = document.createElement('div');
        el.className = 'otag off';
        const bub = document.createElement('div'); bub.className = 'obub';
        const nm = document.createElement('div'); nm.className = 'oname'; nm.textContent = name;
        el.appendChild(bub); el.appendChild(nm);
        this.box.appendChild(el);
        this.tags.set(id, { el, bub, left: 0 });
    }

    /** Поставить табличку над точкой мира (x, y, z — Babylon). visible = false — спрятать. */
    place(id, x, y, z, visible) {
        const t = this.tags.get(id);
        if (!t) return;
        if (!visible) { t.el.classList.add('off'); return; }
        const cam = this.view.camera, dist = cam ? Math.hypot(cam.position.x - x, cam.position.y - y, cam.position.z - z) : 0;
        const pr = dist < (this.opts.maxDist || 6500) ? this.view.projectToScreen(x, z, y) : null;
        if (!pr || !pr.visible || pr.behind) { t.el.classList.add('off'); return; }
        t.el.classList.remove('off');
        const k = Math.max(0.6, Math.min(1.15, 1100 / Math.max(400, dist)));
        t.el.style.transform = `translate(${pr.x.toFixed(1)}px, ${pr.y.toFixed(1)}px) translate(-50%, -100%) scale(${k.toFixed(3)})`;
    }

    /** Пузырь реплики над ником на sec секунд. */
    say(id, text, sec) {
        const t = this.tags.get(id);
        if (!t) return;
        t.bub.textContent = text;
        t.left = sec || 4;
    }

    /** Время пузырей (звать раз в кадр; на паузе не нужен). */
    update(dt) {
        for (const t of this.tags.values()) if (t.left > 0) { t.left -= dt; if (t.left <= 0) t.bub.textContent = ''; }
    }

    hide(id) { const t = this.tags.get(id); if (t) t.el.classList.add('off'); }

    remove(id) {
        const t = this.tags.get(id);
        if (!t) return;
        t.el.remove();
        this.tags.delete(id);
    }

    clear() { for (const id of Array.from(this.tags.keys())) this.remove(id); }

    dispose() { this.clear(); }
}
