// Rig.js — жёсткие риги из Blender GLB (кости-узлы, меши на костях, без скиннинга) и
// их клипы: проигрывание, переходы, слои, события.
//
// МОДЕЛЬ РИГА. Арматура Blender: кости — узлы glTF, меши-части привязаны к костям
// (parent_type BONE) и в файле — дети узла своей кости. Вершины мешей НЕ привязаны к
// весам костей (нет скиннинга): часть едет вместе с костью целиком, как у персонажей
// Roblox R6 (Motor6D между частями). Клипы — Actions Blender, каждая выходит анимацией
// glTF (смещение, вращение, масштаб узлов). Рецепт экспорта и скрипт Blender —
// claude/skills/world3d/SKILL.md. ModelGLTF.js отдаёт model.nodes (узлы с локальными TRS
// в метрах), model.animations (каналы) и part.node (узел части).
//
// НЕ ПОДДЕРЖИВАЕТСЯ — СКИННИНГ И МОРФЫ. Меш со skin (вершины с весами костей)
// рисуется жёстко, в позе покоя, на узле, где лежит в файле, и НЕ деформируется (одно
// предупреждение на модель). Shape keys и каналы weights игнорируются. Нужна гибкость —
// в Blender резать тело на жёсткие части и привязывать каждую к своей кости.
//
// ПРИМЕР:
//   const model = await Rig.load(ПУТЬ_К_hero.glb);                   // Model3D.load + проверка (путь — литералом в игре; в комментарии без кавычек)
//   const rig = Rig.create(model, location.view, { name: 'hero' });  // корень регистрирует
//                                    // World3D.addObject(view, rig.root, 'actor'): тень, контур, обводка
//   rig.root.position.set(x, location.terrain.heightAt(x, y), y);    // корень — меш без геометрии, px
//   rig.root.rotation.y = -heading;                                  // нос модели вдоль +X
//   rig.play('run');                                                 // слой base: всё тело
//   rig.play('attack', { layer: 'upper', loop: false, onEnd: () => rig.play('run'),
//                        events: [{ time: 0.33, fn: () => hit() }] });  // верх тела поверх бега
//   app.onUpdate(dt => Rig.updateAll(dt));   // раз в кадр, вне паузы: ЕДИНСТВЕННЫЙ вызов обновления
//   rig.dispose();
//
// ИЕРАРХИЯ. create строит TransformNode на каждый узел glTF под корнем rig.root (меш без
// геометрии). Единицы — px мира: смещения узлов × 100, масштаб корня 1. Части модели
// разборщик запёк в пространство модели (px, поза покоя) — Rig «распекает» их: вершины ×
// inverse(мировая матрица узла в покое), часть становится ребёнком узла. rig.nodes —
// Map имя -> TransformNode (кость важнее одноимённого меша), rig.parts — имя -> меш части.
//
// ГЕОМЕТРИЯ И МАТЕРИАЛЫ ОБЩИЕ: на модель и сцену строится скрытый прототип, каждый риг —
// клоны его частей (общие буферы вершин и материалы: 40 мобов — те же 2–3 материала).
// Перекрасить одного: назначить части свой материал (клон), удалять его — владельцу.
//
// КЛИПЫ. Свои клипы модели + библиотека (opts.clips — модель клипов, например
// anim_humanoid.glb из Blender, или массив моделей): клип библиотеки переносится на
// модель по ИМЕНАМ узлов. Вращение: покой кости в библиотеке и в модели совпадает —
// значение как есть, иначе дельта от покоя библиотеки в пространстве родителя поверх
// покоя модели (q = q_lib · q_libRest⁻¹ · q_rest). Смещения из библиотеки — только у
// Rig.ROOT_NODES (Root, Hips), дельтой от покоя и с поправкой на рост (высота Hips
// модели / библиотеки). Масштаб из библиотеки не переносится. Свои клипы — все каналы как
// есть. Время клипа — от первого ключа (Blender пишет клип с кадра 1, а при
// export_anim_slide_to_zero — с 0). Канал, у которого все ключи равны (так Blender пишет
// неподвижные кости), считается константой.
//
// СЛОИ. 'base' — всё тело, всегда есть. Любой другой слой — по имени, создаётся при
// первом play({ layer }): накладывается поверх нижних с весом на маску (узел и его
// потомки). Маска слоя: opts.mask (имя узла или массив) или Rig.LAYER_MASKS[слой]
// ('upper' — Torso и потомки; нет такого узла — все узлы). Слои считаются в порядке
// создания, верхний перекрывает нижние. Вес нарастает за fade и гаснет сам, когда
// клип слоя закончился (holdLast: true — держит последнюю позу), или по stop(слой).
//
// ПЕРЕХОДЫ. Смена клипа на слое — плавный переход от ТЕКУЩЕЙ позы (снимок) за fade с,
// кривая smoothstep, сферическая интерполяция кватернионов: прервать переход новым
// play можно в любой момент без скачка. Клип loop: false на base замирает на последнем
// кадре; current() после конца — null (holdLast: true — имя остаётся).
//
// СОБЫТИЯ. play({ onEnd }) — один раз, когда клип без цикла дошёл до конца (смена клипа
// до конца onEnd снимает). play({ events: [{ time | frac, fn }] }) — когда время клипа
// проходит отметку (с или доля 0..1), на каждом витке цикла. Обратные вызовы идут ПОСЛЕ
// того, как поза записана, — внутри можно звать play, stop, dispose.
//
// КАДР. rig.update(dt) / Rig.updateAll(dt) — по dt владельца, без собственных часов.
// updateAll на паузе (Pause.active) ничего не двигает; rig.speed — масштаб времени
// одного рига (замедление при попадании). Горячий путь без выделений памяти: буферы поз
// (Float32Array: t xyz, r xyzw, s xyz на узел) заведены на риг заранее. Риг с
// root.setEnabled(false) позу не считает.

/** @satisfies {Record<string, any>} */
const Rig = {
    UNIT: 100,                      // px на метр
    STRIDE: 10,                     // чисел позы на узел: t xyz, r xyzw, s xyz
    ROOT_NODES: /^(root|hips)$/i,   // узлы, чьё смещение переносится из библиотеки клипов
    HIPS: 'Hips',                   // узел, по высоте которого масштабируется смещение библиотеки
    LAYER_MASKS: { upper: 'Torso' },   // маска слоя по умолчанию: слой -> узел (с потомками)
    /** @type {WeakMap<object, any>} */
    _prep: new WeakMap(),
    /** @type {WeakMap<object, string>} */
    _urls: new WeakMap(),
    /** @type {Set<string>} */
    _warned: new Set(),
    /** @type {Set<any>} */
    _live: new Set(),

    // Число из Constants.js (RIG_FADE) с дефолтом: в игре константы лексические, в редакторе — window.
    cfg() {
        return { fade: this._fade() };
    },

    _fade() {
        return typeof RIG_FADE !== 'undefined' ? RIG_FADE : 0.15;
    },

    // url -> Promise<модель> (кэш Model3D). Модель без узлов (FBX, OBJ) тоже годится:
    // риг выйдет статичным, клипов нет.
    async load(url) {
        const model = await Model3D.load(url);
        this._urls.set(model, url);
        if (!model.nodes) this.warnOnce('nodes|' + url, 'Rig: у модели нет узлов glTF (риг без анимации): ' + url);
        return model;
    },

    // load + create: Promise<RigInstance>. opts.clips — URL библиотеки клипов (или массив URL, или модель).
    async spawn(url, view, opts) {
        const o = Object.assign({}, opts);
        const model = await this.load(url);
        if (o.clips) {
            const list = Array.isArray(o.clips) ? o.clips : [o.clips];
            o.clips = await Promise.all(list.map((c) => (typeof c === 'string' ? this.load(c) : c)));
        }
        return this.create(model, view, o);
    },

    // Новый риг модели в виде view (View3D). opts: { name?, kind?: 'actor' | 'prop',
    // clips?: модель | модель[] (библиотеки клипов), hide?: [префиксы имён частей],
    // ignorePause?: updateAll двигает риг и на паузе (меню) }.
    create(model, view, opts) {
        return new RigInstance(model, view, opts || {});
    },

    // Один вызов обновления на кадр: все живые риги. На паузе (Pause.active) стоят все,
    // кроме рига с ignorePause; сдохшие (сцена убита) выкидываются.
    updateAll(dt) {
        const paused = typeof Pause !== 'undefined' && Pause.active;
        for (const rig of this._live) {
            if (rig.disposed || rig.root.isDisposed()) { this._live.delete(rig); continue; }
            if (!paused || rig.ignorePause) rig.update(dt);
        }
    },

    warnOnce(key, text) {
        if (this._warned.has(key)) return;
        this._warned.add(key);
        console.warn(text);
    },

    // Узел по имени: кость скина важнее одноимённого узла-меша, узел без части — важнее
    // узла с частью (в Blender меш части назван как его кость). -1 — нет такого.
    findNode(nodes, name) {
        let best = -1, score = -1;
        for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i];
            if (n.name !== name) continue;
            const s = (n.joint ? 2 : 0) + (n.part < 0 ? 1 : 0);
            if (s > score) { score = s; best = i; }
        }
        return best;
    },

    // Сводка модели для проверки экспорта: { nodes: [{ name, parent, rest: [x, y, z] px, mesh }],
    // parts: [{ name, bone, skinned }], clips: [{ name, length, channels }], warnings }.
    describe(model) {
        const nodes = model.nodes || [];
        const list = nodes.map((n) => ({ name: n.name, parent: n.parent >= 0 ? nodes[n.parent].name : null,
            rest: n.t.map((v) => Math.round(v * this.UNIT * 100) / 100), mesh: n.part >= 0 }));
        const parts = model.parts.map((p) => ({ name: p.name,
            bone: p.node != null && nodes[p.node] && nodes[p.node].parent >= 0 ? nodes[nodes[p.node].parent].name : null, skinned: !!p.skinned }));
        const clips = (model.animations || []).map((a) => ({ name: a.name, length: Math.round((a.duration - a.start) * 1000) / 1000, channels: a.channels.length }));
        const warnings = [];
        if (!nodes.length) warnings.push('нет узлов glTF — это не glTF/GLB');
        if (parts.some((p) => p.skinned)) warnings.push('есть меши со скином: скиннинг не поддерживается, части не деформируются');
        for (const p of parts) if (!p.bone && nodes.length) warnings.push('часть ' + p.name + ' не висит на узле-родителе');
        return { nodes: list, parts, clips, warnings };
    },

    // --- Подготовка модели (раз на модель) --------------------------------------------

    _prepare(model) {
        let p = this._prep.get(model);
        if (p) return p;
        const U = this.UNIT, ST = this.STRIDE;
        const nodes = model.nodes || [];
        const N = nodes.length;
        const rest = new Float32Array(N * ST);
        const local = [], world = [];
        const V3 = BABYLON.Vector3, Q = BABYLON.Quaternion, M = BABYLON.Matrix;
        nodes.forEach((n, i) => {
            const o = i * ST;
            rest[o] = n.t[0] * U; rest[o + 1] = n.t[1] * U; rest[o + 2] = n.t[2] * U;
            const q = new Q(n.r[0], n.r[1], n.r[2], n.r[3]).normalize();
            rest[o + 3] = q.x; rest[o + 4] = q.y; rest[o + 5] = q.z; rest[o + 6] = q.w;
            rest[o + 7] = n.s[0]; rest[o + 8] = n.s[1]; rest[o + 9] = n.s[2];
            local[i] = M.Compose(new V3(n.s[0], n.s[1], n.s[2]), q, new V3(rest[o], rest[o + 1], rest[o + 2]));
        });
        // Мировые матрицы покоя (px) — родитель раньше ребёнка (обход от корней).
        const order = [];
        const seen = new Uint8Array(N);
        const kids = nodes.map(() => []);
        nodes.forEach((n, i) => { if (n.parent >= 0 && n.parent < N) kids[n.parent].push(i); });
        const walk = (i, depth) => {
            if (seen[i] || depth > 64) return;
            seen[i] = 1;
            order.push(i);
            const par = nodes[i].parent;
            world[i] = par >= 0 && world[par] ? local[i].multiply(world[par]) : local[i].clone();
            for (const c of kids[i]) walk(c, depth + 1);
        };
        nodes.forEach((n, i) => { if (n.parent < 0 || n.parent >= N) walk(i, 0); });
        nodes.forEach((n, i) => { if (!seen[i]) walk(i, 0); });   // цикл или битый родитель — как корень

        // Части: вершины из пространства модели (px) в пространство узла.
        const skinned = [];
        const parts = model.parts.map((part) => {
            if (part.skinned) skinned.push(part.name);
            const ni = part.node;
            if (ni == null || ni < 0 || !world[ni]) return part;
            const W = world[ni];
            const inv = W.clone().invert(), WT = W.transpose();
            const src = part.positions, pos = new Float32Array(src.length);
            const v = new V3();
            for (let i = 0; i < src.length; i += 3) {
                V3.TransformCoordinatesFromFloatsToRef(src[i], src[i + 1], src[i + 2], inv, v);
                pos[i] = v.x; pos[i + 1] = v.y; pos[i + 2] = v.z;
            }
            let nrm = null;
            if (part.normals) {
                nrm = new Float32Array(part.normals.length);
                const sn = part.normals;
                for (let i = 0; i < sn.length; i += 3) {
                    V3.TransformNormalFromFloatsToRef(sn[i], sn[i + 1], sn[i + 2], WT, v);
                    v.normalize();
                    nrm[i] = v.x; nrm[i + 1] = v.y; nrm[i + 2] = v.z;
                }
            }
            let indices = part.indices;
            // Зеркальный узел: разборщик развернул обход, а Babylon развернёт и сам по
            // отрицательному определителю мировой матрицы — вернуть обход как в файле.
            if (W.determinant() < 0 && indices) {
                indices = indices.slice();
                for (let t = 0; t + 2 < indices.length; t += 3) { const a = indices[t + 1]; indices[t + 1] = indices[t + 2]; indices[t + 2] = a; }
            }
            return Object.assign({}, part, { positions: pos, normals: nrm, indices });
        });
        if (skinned.length) {
            this.warnOnce('skin|' + (this._urls.get(model) || skinned[0]), 'Rig: скиннинг не поддерживается — части ' + skinned.join(', ')
                + ' нарисованы жёстко, без деформации (привяжите части к костям: parent_type BONE)');
        }

        const byName = new Map();
        nodes.forEach((n) => { if (!byName.has(n.name)) byName.set(n.name, this.findNode(nodes, n.name)); });
        const hips = this.findNode(nodes, this.HIPS);
        p = {
            model, nodes, N, rest, world, order, byName,
            hipsY: hips >= 0 ? world[hips].m[13] : 0,
            build: { materials: model.materials, parts, min: model.min, max: model.max },
            height: Number.isFinite(model.max[1] - model.min[1]) ? model.max[1] - model.min[1] : 0,
            own: new Map(),          // имя -> клип модели
            bindings: new Map(),     // библиотека (prep) -> Map<имя, клип>
            protos: new Map(),       // scene.uid + вид -> { root, parts }
            masks: new Map(),        // ключ имён -> Uint8Array(N) | null
        };
        this._prep.set(model, p);
        for (const anim of model.animations || []) {
            const clip = this._bindClip(anim, p, null);
            if (clip) p.own.set(clip.name, clip);
        }
        return p;
    },

    // Маска узлов: Uint8Array(N), 1 — узел из names или потомок. names: имя | массив имён.
    // Нет ни одного из имён — null (все узлы) и предупреждение.
    _mask(prep, names) {
        const list = (Array.isArray(names) ? names : [names]).filter((n) => n != null).map(String);
        const key = list.join('|');
        if (prep.masks.has(key)) return prep.masks.get(key);
        const nodes = prep.nodes, N = prep.N;
        const roots = list.map((n) => prep.byName.has(n) ? prep.byName.get(n) : -1).filter((i) => i >= 0);
        let mask = null;
        if (roots.length) {
            mask = new Uint8Array(N);
            for (let i = 0; i < N; i++) {
                for (let k = i, d = 0; k >= 0 && d < 64; k = nodes[k].parent, d++) if (roots.includes(k)) { mask[i] = 1; break; }
            }
        } else if (list.length) {
            this.warnOnce('mask|' + key, 'Rig: в модели нет узлов маски слоя «' + key + '» — слой действует на все узлы');
        }
        prep.masks.set(key, mask);
        return mask;
    },

    // Канал glTF -> канал сэмплера: постоянный (все ключи равны) запоминает значение —
    // Blender пишет неподвижные кости двумя одинаковыми ключами.
    _channel(ch) {
        const stride = ch.path === 'rotation' ? 4 : 3;
        const cubic = ch.interp === 'CUBICSPLINE';
        const n = ch.times.length, vals = ch.values;
        const first = cubic ? stride : 0, step = cubic ? stride * 3 : stride;
        let constant = null;
        if (n >= 1 && vals.length >= (n - 1) * step + first + stride) {
            let same = true;
            for (let k = 1; k < n && same; k++) {
                for (let j = 0; j < stride; j++) if (Math.abs(vals[k * step + first + j] - vals[first + j]) > 1e-6) { same = false; break; }
            }
            if (same) constant = Float32Array.from(vals.subarray(first, first + stride));
        }
        return { times: ch.times, values: vals, interp: ch.interp, stride, constant };
    },

    // Анимация -> клип для модели target. lib — подготовленная библиотека (null — свои клипы).
    _bindClip(anim, target, lib) {
        const tracks = new Map();
        const ST = this.STRIDE;
        const src = lib || target;
        for (const ch of anim.channels) {
            const sn = src.nodes[ch.node];
            if (!sn) continue;
            const ti = lib ? target.byName.get(sn.name) : ch.node;
            if (ti == null || ti < 0) continue;
            if (lib && ch.node !== src.byName.get(sn.name)) continue;   // одноимённый узел-меш библиотеки
            let tr = tracks.get(ti);
            if (!tr) { tr = { target: ti, T: null, R: null, S: null, tMode: 0, rMode: 0, k: 1, a: null, b: null, lt: null, tt: null }; tracks.set(ti, tr); }
            const c = this._channel(ch);
            const lo = ch.node * ST, to = ti * ST;
            if (ch.path === 'translation') {
                if (!lib) { tr.T = c; tr.tMode = 0; continue; }
                if (!this.ROOT_NODES.test(sn.name)) continue;
                tr.T = c; tr.tMode = 1;
                tr.lt = Float32Array.from(src.rest.subarray(lo, lo + 3));
                tr.tt = Float32Array.from(target.rest.subarray(to, to + 3));
                tr.k = lib.hipsY > 1 && target.hipsY > 1 ? target.hipsY / lib.hipsY : 1;
            } else if (ch.path === 'rotation') {
                tr.R = c;
                if (!lib) { tr.rMode = 0; continue; }
                const lr = src.rest.subarray(lo + 3, lo + 7), rr = target.rest.subarray(to + 3, to + 7);
                const dot = lr[0] * rr[0] + lr[1] * rr[1] + lr[2] * rr[2] + lr[3] * rr[3];
                if (Math.abs(dot) > 0.9999) { tr.rMode = 0; continue; }
                tr.rMode = 1;
                tr.a = Float32Array.from([-lr[0], -lr[1], -lr[2], lr[3]]);   // q_libRest⁻¹
                tr.b = Float32Array.from(rr);                                 // q_rest модели
            } else if (ch.path === 'scale' && !lib) {
                tr.S = c;
            }
        }
        const list = [...tracks.values()].filter((t) => t.T || t.R || t.S);
        if (!list.length) return null;
        const start = anim.start || 0;
        return { name: anim.name, start, length: Math.max(1 / 60, (anim.duration || 0) - start), tracks: list, lib: !!lib };
    },

    // Клипы библиотеки для модели (кэш на пару).
    _libClips(target, libModel) {
        const lib = this._prepare(libModel);
        let m = target.bindings.get(lib);
        if (!m) {
            m = new Map();
            if (lib !== target) {
                for (const anim of libModel.animations || []) {
                    const clip = this._bindClip(anim, target, lib);
                    if (clip) m.set(clip.name, clip);
                }
            }
            target.bindings.set(lib, m);
        }
        return m;
    },

    // Скрытый прототип частей на сцену и вид объекта: клоны рига делят его буферы и материалы.
    _proto(prep, scene, kind) {
        const key = scene.uid + '|' + kind;
        let pr = prep.protos.get(key);
        if (pr && !pr.root.isDisposed()) return pr;
        const root = Model3D.build(prep.build, scene, { name: 'rigproto' });
        root.setEnabled(false);
        const parts = /** @type {BABYLON.Mesh[]} */ (root.getChildMeshes(true));
        for (const m of parts) m.isPickable = false;
        pr = { root, parts };
        prep.protos.set(key, pr);
        return pr;
    },

    // --- Сэмплер ---------------------------------------------------------------------

    // Значение канала в момент t (с, время файла) -> out[o .. o+stride). Вращение LINEAR —
    // slerp по короткой дуге, CUBICSPLINE — эрмитов сплайн с нормализацией, STEP — левый ключ.
    _sample(c, t, out, o) {
        const s = c.stride;
        if (c.constant) { for (let j = 0; j < s; j++) out[o + j] = c.constant[j]; return; }
        const times = c.times, n = times.length, v = c.values;
        const cubic = c.interp === 'CUBICSPLINE';
        const step = cubic ? s * 3 : s, mid = cubic ? s : 0;
        if (n === 0) return;
        if (n === 1 || t <= times[0]) { for (let j = 0; j < s; j++) out[o + j] = v[mid + j]; return; }
        if (t >= times[n - 1]) { const b = (n - 1) * step + mid; for (let j = 0; j < s; j++) out[o + j] = v[b + j]; return; }
        let lo = 0, hi = n - 1;
        while (hi - lo > 1) { const m = (lo + hi) >> 1; if (times[m] <= t) lo = m; else hi = m; }
        const t0 = times[lo], d = times[hi] - t0, u = d > 0 ? (t - t0) / d : 0;
        if (c.interp === 'STEP') { const b = lo * step + mid; for (let j = 0; j < s; j++) out[o + j] = v[b + j]; return; }
        if (cubic) {
            const u2 = u * u, u3 = u2 * u;
            const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
            const a = lo * step, b = hi * step;
            for (let j = 0; j < s; j++) {
                out[o + j] = h00 * v[a + s + j] + h10 * d * v[a + 2 * s + j] + h01 * v[b + s + j] + h11 * d * v[b + j];
            }
            if (s === 4) Rig.norm4(out, o);
            return;
        }
        const a = lo * s, b = hi * s;
        if (s === 4) Rig.slerp(v, a, v, b, u, out, o);
        else for (let j = 0; j < s; j++) out[o + j] = v[a + j] + (v[b + j] - v[a + j]) * u;
    },

    // --- Кватернионы и позы на массивах (xyzw) — без выделений памяти ------------------

    norm4(q, o) {
        const l = Math.hypot(q[o], q[o + 1], q[o + 2], q[o + 3]) || 1;
        q[o] /= l; q[o + 1] /= l; q[o + 2] /= l; q[o + 3] /= l;
    },

    // out[oo..] = slerp(a[ao..], b[bo..], u); out может совпадать с a или b.
    slerp(a, ao, b, bo, u, out, oo) {
        const ax = a[ao], ay = a[ao + 1], az = a[ao + 2], aw = a[ao + 3];
        let bx = b[bo], by = b[bo + 1], bz = b[bo + 2], bw = b[bo + 3];
        let cos = ax * bx + ay * by + az * bz + aw * bw;
        if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
        let k0 = 1 - u, k1 = u;
        if (cos < 0.9995) {
            const th = Math.acos(cos), sn = Math.sin(th);
            k0 = Math.sin((1 - u) * th) / sn;
            k1 = Math.sin(u * th) / sn;
        }
        out[oo] = ax * k0 + bx * k1; out[oo + 1] = ay * k0 + by * k1;
        out[oo + 2] = az * k0 + bz * k1; out[oo + 3] = aw * k0 + bw * k1;
        Rig.norm4(out, oo);
    },

    // out[oo..] = a · b (произведение Гамильтона: сначала b, потом a).
    mul(a, ao, b, bo, out, oo) {
        const ax = a[ao], ay = a[ao + 1], az = a[ao + 2], aw = a[ao + 3];
        const bx = b[bo], by = b[bo + 1], bz = b[bo + 2], bw = b[bo + 3];
        out[oo] = aw * bx + ax * bw + ay * bz - az * by;
        out[oo + 1] = aw * by - ax * bz + ay * bw + az * bx;
        out[oo + 2] = aw * bz + ax * by - ay * bx + az * bw;
        out[oo + 3] = aw * bw - ax * bx - ay * by - az * bz;
    },

    // Вес перехода x 0..1 -> smoothstep.
    ease(x) { return x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x); },

    // Поза a -> b с долей w (смещение и масштаб линейно, вращение slerp) по списку узлов idx;
    // out может совпадать с a.
    blend(a, b, w, out, idx, ST) {
        for (let k = 0; k < idx.length; k++) {
            const o = idx[k] * ST;
            for (let j = 0; j < 3; j++) out[o + j] = a[o + j] + (b[o + j] - a[o + j]) * w;
            Rig.slerp(a, o + 3, b, o + 3, w, out, o + 3);
            for (let j = 7; j < 10; j++) out[o + j] = a[o + j] + (b[o + j] - a[o + j]) * w;
        }
    },

    // Слой анимации рига.
    _layer(name, size, base) {
        return {
            name, base,
            clip: null, clipName: '', time: 0, speed: 1, loop: true, holdLast: false, finished: false,
            onEnd: null, events: null, evT: -1,
            fadeT: 1, fadeDur: 0, fadeOut: 0.15,        // переход между клипами слоя
            from: new Float32Array(size),               // снимок позы слоя — откуда переходим
            pose: new Float32Array(size),               // поза слоя за этот кадр
            weight: base ? 1 : 0, wTarget: base ? 1 : 0, wRate: 1,   // вес слоя над нижними (base — всегда 1)
            mask: null, maskIdx: null, maskSet: false,
        };
    },
};

class RigInstance {
    // Не звать напрямую — Rig.create(model, view, opts).
    constructor(model, view, opts) {
        const prep = Rig._prepare(model);
        const scene = view.scene;
        const ST = Rig.STRIDE, N = prep.N;
        this.model = model;
        this.view = view;
        this.prep = prep;
        this.name = opts.name || 'rig';
        this.kind = opts.kind === 'prop' ? 'prop' : 'actor';
        this.ignorePause = !!opts.ignorePause;
        this.speed = 1;                 // масштаб времени этого рига (1 — норма, 0 — стоп)
        this.height = prep.height;      // px: высота модели в покое (по габариту частей)
        this.disposed = false;
        /** @type {BABYLON.Mesh} */
        this.root = new BABYLON.Mesh(this.name, scene);
        /** @type {Map<string, BABYLON.TransformNode>} */
        this.nodes = new Map();         // имя узла -> TransformNode
        /** @type {Map<string, BABYLON.Mesh>} */
        this.parts = new Map();         // имя части -> меш
        /** @type {Array<BABYLON.TransformNode | null>} */
        this._tn = new Array(N).fill(null);
        // Узлы по порядку «родитель раньше ребёнка».
        for (const i of prep.order) {
            const n = prep.nodes[i], o = i * ST, r = prep.rest;
            const tn = new BABYLON.TransformNode(this.name + ':' + n.name, scene);
            tn.parent = n.parent >= 0 && this._tn[n.parent] ? this._tn[n.parent] : this.root;
            tn.position.set(r[o], r[o + 1], r[o + 2]);
            tn.rotationQuaternion = new BABYLON.Quaternion(r[o + 3], r[o + 4], r[o + 5], r[o + 6]);
            tn.scaling.set(r[o + 7], r[o + 8], r[o + 9]);
            this._tn[i] = tn;
        }
        prep.byName.forEach((i, name) => { if (this._tn[i]) this.nodes.set(name, this._tn[i]); });
        // Части — клоны прототипа (общие буферы и материалы).
        const proto = Rig._proto(prep, scene, this.kind);
        /** @type {BABYLON.Mesh[]} */
        this._meshes = [];
        model.parts.forEach((part, pi) => {
            const src = proto.parts[pi];
            if (!src) return;
            const m = src.clone(this.name + '/' + part.name, null, true);
            const tn = part.node != null && part.node >= 0 ? this._tn[part.node] : null;
            m.parent = tn || this.root;
            m.isPickable = false;
            m.metadata = { part: part.name, rig: this };
            if (!this.parts.has(part.name)) this.parts.set(part.name, m);
            this._meshes.push(m);
        });
        /** @type {BABYLON.AbstractMesh[]} */
        this._attached = [];
        /** @type {Map<string, BABYLON.TransformNode[]>} */
        this._chains = new Map();

        // Клипы: свои + библиотеки (свои важнее).
        /** @type {Map<string, any>} */
        this._clips = new Map(prep.own);
        const libs = opts.clips ? (Array.isArray(opts.clips) ? opts.clips : [opts.clips]) : [];
        for (const lib of libs) {
            if (!lib || !lib.nodes) continue;
            Rig._libClips(prep, lib).forEach((clip, name) => { if (!this._clips.has(name)) this._clips.set(name, clip); });
        }
        // Узлы, которые двигает хоть один клип: остальные стоят в покое.
        const act = new Set();
        this._clips.forEach((clip) => { for (const t of clip.tracks) act.add(t.target); });
        this._active = Int32Array.from([...act].sort((a, b) => a - b));
        const size = Math.max(1, N * ST);
        this._size = size;
        this._base = Rig._layer('base', size, true);
        /** @type {any[]} */
        this._layers = [this._base];    // по порядку создания; верхний перекрывает нижние
        this._final = new Float32Array(size);
        this._tmp = new Float32Array(8);
        this._base.pose.set(prep.rest); this._base.from.set(prep.rest);
        this._final.set(prep.rest);
        /** @type {Array<{ fn: Function, layer: string }>} */
        this._queue = [];
        // Процедурные смещения узлов на один кадр (offset).
        /** @type {Map<number, any>} */
        this._offPool = new Map();
        /** @type {any[]} */
        this._offUsed = [];
        /** @type {number[]} */
        this._offLast = [];
        this._offTmp = new BABYLON.Quaternion();

        for (const prefix of opts.hide || []) this.setPartVisible(prefix, false);
        World3D.addObject(view, this.root, this.kind);
        Rig._live.add(this);
    }

    // --- Клипы -----------------------------------------------------------------------

    clips() { return [...this._clips.keys()]; }
    has(name) { return this._clips.has(name); }
    // Длина клипа, с (при speed 1).
    duration(name) { const c = this._clips.get(name); return c ? c.length : 0; }

    _layerOf(name) {
        const key = name == null ? 'base' : String(name);
        if (key === 'base') return this._base;
        let L = this._layers.find((l) => l.name === key);
        if (!L) { L = Rig._layer(key, this._size, false); L.pose.set(this.prep.rest); L.from.set(this.prep.rest); this._layers.push(L); }
        return L;
    }

    // Маска слоя: узлы names (и потомки) или null — все. maskIdx — активные узлы под маской.
    _setMask(L, names) {
        L.maskSet = true;
        if (L.base) { L.mask = null; L.maskIdx = this._active; return; }
        L.mask = names == null ? null : Rig._mask(this.prep, names);
        const m = L.mask;
        L.maskIdx = m ? this._active.filter((i) => m[i]) : this._active;
    }

    // Запустить клип name. opts:
    //   layer      'base' (по умолчанию) | имя слоя;
    //   loop       true (по умолчанию) | false — один раз;
    //   speed      множитель времени клипа, 1;
    //   fade       секунды перехода от текущей позы (RIG_FADE, 0.15), 0 — сразу;
    //   restart    начать заново, даже если этот клип уже идёт (иначе повторный play — только
    //              новые speed, loop, holdLast: можно звать каждый кадр);
    //   holdLast   клип без цикла на конце держит последний кадр (на верхнем слое — не гаснет);
    //   at         старт с доли клипа 0..1 (разнести фазы толпы);
    //   weight     максимальный вес слоя 0..1 (не base), 1;
    //   fadeOut    секунды угасания слоя после конца клипа (по умолчанию = fade);
    //   mask       имя узла или массив имён (с потомками): где действует слой (не base);
    //   onEnd      fn(rig) — клип без цикла дошёл до конца;
    //   events     [{ time (с клипа) | frac (доля 0..1), fn(rig) }] — отметки времени клипа.
    // Нет клипа — предупреждение один раз и false, поза остаётся.
    play(name, opts) {
        const o = opts || {};
        const clip = this._clips.get(name);
        if (!clip) {
            Rig.warnOnce('clip|' + (Rig._urls.get(this.model) || this.name) + '|' + name, 'Rig: нет клипа «' + name + '» у ' + (Rig._urls.get(this.model) || this.name));
            return false;
        }
        const L = this._layerOf(o.layer);
        const over = !L.base;
        if (!L.maskSet || (over && o.mask !== undefined)) {
            this._setMask(L, o.mask !== undefined ? o.mask : Rig.LAYER_MASKS[L.name]);
        }
        const loop = o.loop !== false;
        const speed = Number.isFinite(o.speed) ? Math.max(0, o.speed) : 1;
        const fade = Number.isFinite(o.fade) ? Math.max(0, o.fade) : Rig._fade();
        const wMax = over && Number.isFinite(o.weight) ? Math.max(0, Math.min(1, o.weight)) : 1;
        const playing = L.clip === clip && !(L.finished && !L.holdLast) && (!over || L.wTarget > 0);
        if (playing && !o.restart) {
            L.speed = speed; L.loop = loop; L.holdLast = !!o.holdLast;
            if (over) L.wTarget = wMax;
            if (o.onEnd) L.onEnd = o.onEnd;
            return true;
        }
        if (over) {
            if (L.clip && L.weight > 0.001) { L.from.set(L.pose); L.fadeT = 0; L.fadeDur = fade; }
            else { L.fadeT = L.fadeDur = 0; }
            L.wTarget = wMax;
            L.wRate = fade > 0 ? 1 / fade : 1e9;
        } else {
            L.from.set(L.pose);
            L.fadeT = 0;
            L.fadeDur = fade;
        }
        L.clip = clip;
        L.clipName = name;
        L.time = Number.isFinite(o.at) ? Math.max(0, Math.min(1, o.at)) * clip.length : 0;
        L.speed = speed;
        L.loop = loop;
        L.holdLast = !!o.holdLast;
        L.fadeOut = Number.isFinite(o.fadeOut) ? Math.max(0, o.fadeOut) : fade;
        L.onEnd = o.onEnd || null;
        L.finished = false;
        L.events = o.events && o.events.length ? this._events(o.events, clip.length) : null;
        L.evT = L.time > 0 ? L.time : -1;
        return true;
    }

    _events(list, len) {
        const out = [];
        for (const e of list) {
            if (!e || typeof e.fn !== 'function') continue;
            const t = e.time != null ? e.time : e.frac != null ? e.frac * len : 0;
            out.push({ t: Math.max(0, Math.min(len, Number(t) || 0)), fn: e.fn });
        }
        return out.sort((a, b) => a.t - b.t);
    }

    // Остановить слой. base — плавно к позе покоя за fade; другой слой — вес к нулю.
    stop(layer, fade) {
        const L = this._layerOf(layer);
        const f = Number.isFinite(fade) ? Math.max(0, fade) : Rig._fade();
        L.onEnd = null;
        L.events = null;
        if (L.base) {
            L.from.set(L.pose);
            L.fadeT = 0;
            L.fadeDur = f;
            L.clip = null;
            L.clipName = '';
        } else {
            L.wTarget = 0;
            L.wRate = f > 0 ? 1 / f : 1e9;
        }
    }

    // Имя клипа слоя, null — ничего не играет (клип без цикла закончился, слой гаснет).
    current(layer) {
        const L = this._layerOf(layer);
        if (!L.clip) return null;
        if (L.finished && !L.holdLast) return null;
        if (!L.base && L.wTarget <= 0) return null;
        return L.clipName;
    }

    // Идёт ли клип name (любой, если не задан) на слое.
    isPlaying(name, layer) {
        const cur = this.current(layer);
        return cur != null && (name == null || cur === name);
    }

    // Время клипа слоя, с (от его начала).
    time(layer) {
        const L = this._layerOf(layer);
        return L.clip ? L.time : 0;
    }

    // Доля клипа слоя 0..1.
    phase(layer) {
        const L = this._layerOf(layer);
        return L.clip && L.clip.length > 0 ? L.time / L.clip.length : 0;
    }

    // --- Кадр ------------------------------------------------------------------------

    // dt — секунды кадра владельца как есть (main.js уже ограничивает его 0.1), умножаются на this.speed.
    // Большой dt (перемотка) пролистывает клип: цикл заворачивается, клип без цикла доходит до конца.
    update(dt) {
        if (this.disposed) return;
        dt = Math.max(0, dt || 0) * this.speed;
        const ST = Rig.STRIDE, layers = this._layers;
        for (let i = 0; i < layers.length; i++) this._advance(layers[i], dt);
        if (this.root.isEnabled(false)) {
            const act = this._active;
            if (act.length) {
                const B = this._base, fin = this._final;
                this._evalLayer(B, this.prep.rest, act, null);
                for (let k = 0; k < act.length; k++) {
                    const o = act[k] * ST;
                    for (let j = 0; j < ST; j++) fin[o + j] = B.pose[o + j];
                }
                for (let i = 1; i < layers.length; i++) {
                    const L = layers[i];
                    if (!L.clip || L.weight <= 0) continue;
                    this._evalLayer(L, fin, L.maskIdx, L.mask);
                    Rig.blend(fin, L.pose, Rig.ease(L.weight), fin, L.maskIdx, ST);
                }
                this._write();
            }
            if (this._offUsed.length || this._offLast.length) this._writeOffsets();
        } else {
            this._offUsed.length = 0;   // выключенный риг смещений не копит
        }
        if (this._queue.length) {
            const list = this._queue.splice(0);
            for (const e of list) { try { e.fn(this); } catch (err) { console.error('Rig callback:', err); } }
        }
    }

    // Время слоя вперёд, события и конец клипа, вес слоя.
    _advance(L, dt) {
        if (L.fadeT < L.fadeDur) L.fadeT += dt;
        if (!L.base && L.weight !== L.wTarget) {
            const step = L.wRate * dt;
            L.weight = L.wTarget > L.weight ? Math.min(L.wTarget, L.weight + step) : Math.max(L.wTarget, L.weight - step);
            if (L.weight <= 0 && L.wTarget <= 0) { L.clip = null; L.clipName = ''; L.events = null; L.onEnd = null; }
        }
        if (!L.clip || L.finished) return;
        const len = L.clip.length;
        let t = L.time + dt * L.speed;
        if (L.loop) {
            if (t >= len) {
                this._fire(L, L.evT, len);
                t = t % len;
                L.evT = -1;
            }
            this._fire(L, L.evT, t);
            L.time = t;
        } else if (t >= len) {
            this._fire(L, L.evT, len);
            L.time = len;
            L.evT = len;
            L.finished = true;
            if (L.onEnd) { this._queue.push({ fn: L.onEnd, layer: L.name }); L.onEnd = null; }
            if (!L.base && !L.holdLast) { L.wTarget = 0; L.wRate = L.fadeOut > 0 ? 1 / L.fadeOut : 1e9; }
        } else {
            this._fire(L, L.evT, t);
            L.time = t;
        }
    }

    // Отметки слоя в (from, to] — в очередь обратных вызовов.
    _fire(L, from, to) {
        L.evT = to;
        const ev = L.events;
        if (!ev) return;
        for (let i = 0; i < ev.length; i++) if (ev[i].t > from && ev[i].t <= to) this._queue.push({ fn: ev[i].fn, layer: L.name });
    }

    // Поза слоя: база (fallback — поза ниже) -> каналы клипа (только узлы маски) -> переход от снимка.
    _evalLayer(L, fallback, idx, mask) {
        const ST = Rig.STRIDE, P = L.pose, U = Rig.UNIT, tmp = this._tmp;
        for (let k = 0; k < idx.length; k++) {
            const o = idx[k] * ST;
            for (let j = 0; j < ST; j++) P[o + j] = fallback[o + j];
        }
        const clip = L.clip;
        if (clip) {
            const t = clip.start + L.time, tracks = clip.tracks;
            for (let q = 0; q < tracks.length; q++) {
                const tr = tracks[q];
                if (mask && !mask[tr.target]) continue;
                const o = tr.target * ST;
                if (tr.T) {
                    Rig._sample(tr.T, t, tmp, 0);
                    if (tr.tMode === 0) { P[o] = tmp[0] * U; P[o + 1] = tmp[1] * U; P[o + 2] = tmp[2] * U; }
                    else {
                        const lt = tr.lt, tt = tr.tt, k = tr.k;
                        P[o] = tt[0] + (tmp[0] * U - lt[0]) * k;
                        P[o + 1] = tt[1] + (tmp[1] * U - lt[1]) * k;
                        P[o + 2] = tt[2] + (tmp[2] * U - lt[2]) * k;
                    }
                }
                if (tr.R) {
                    if (tr.rMode === 0) Rig._sample(tr.R, t, P, o + 3);
                    else {
                        Rig._sample(tr.R, t, tmp, 0);
                        Rig.mul(tmp, 0, tr.a, 0, tmp, 4);         // q_lib · q_libRest⁻¹
                        Rig.mul(tmp, 4, tr.b, 0, P, o + 3);       // · q_rest модели
                        Rig.norm4(P, o + 3);
                    }
                }
                if (tr.S) Rig._sample(tr.S, t, P, o + 7);
            }
        }
        if (L.fadeT < L.fadeDur && L.fadeDur > 0) {
            Rig.blend(L.from, P, Rig.ease(L.fadeT / L.fadeDur), P, idx, ST);
        }
    }

    _write() {
        const fin = this._final, act = this._active, ST = Rig.STRIDE;
        for (let k = 0; k < act.length; k++) {
            const i = act[k], tn = this._tn[i];
            if (!tn) continue;
            const o = i * ST;
            tn.position.set(fin[o], fin[o + 1], fin[o + 2]);
            tn.rotationQuaternion.set(fin[o + 3], fin[o + 4], fin[o + 5], fin[o + 6]);
            tn.scaling.set(fin[o + 7], fin[o + 8], fin[o + 9]);
        }
    }

    // --- Процедурные смещения ---------------------------------------------------------

    // Добавить к анимации узла поворот (радианы, оси родителя: rx, ry, rz — как pitch, yaw,
    // roll) и сдвиг (px, py, pz — px родителя) НА ОДИН КАДР: зови перед update каждый кадр
    // (голова за целью, отдача); перестал звать — узел вернулся к анимации. Узла нет — молча.
    offset(name, rx, ry, rz, px, py, pz) {
        const i = this.prep.byName.has(name) ? this.prep.byName.get(name) : -1;
        if (i < 0 || !this._tn[i]) return;
        let o = this._offPool.get(i);
        if (!o) { o = { i, q: new BABYLON.Quaternion(), p: new BABYLON.Vector3(), used: false }; this._offPool.set(i, o); }
        const q = this._offTmp;
        BABYLON.Quaternion.RotationYawPitchRollToRef(ry || 0, rx || 0, rz || 0, q);
        if (o.used) { q.multiplyToRef(o.q, o.q); o.p.x += px || 0; o.p.y += py || 0; o.p.z += pz || 0; }
        else { o.q.copyFrom(q); o.p.set(px || 0, py || 0, pz || 0); o.used = true; this._offUsed.push(o); }
    }

    _writeOffsets() {
        const fin = this._final, ST = Rig.STRIDE, q = this._offTmp;
        // Узлы с прошлого кадра, которых сегодня не двигали, — назад к позе.
        for (let k = 0; k < this._offLast.length; k++) {
            const i = this._offLast[k], tn = this._tn[i], o = i * ST;
            if (!tn || (this._offPool.get(i) || {}).used) continue;
            tn.position.set(fin[o], fin[o + 1], fin[o + 2]);
            tn.rotationQuaternion.set(fin[o + 3], fin[o + 4], fin[o + 5], fin[o + 6]);
        }
        this._offLast.length = 0;
        for (let k = 0; k < this._offUsed.length; k++) {
            const f = this._offUsed[k], tn = this._tn[f.i], o = f.i * ST;
            tn.position.set(fin[o] + f.p.x, fin[o + 1] + f.p.y, fin[o + 2] + f.p.z);
            q.copyFromFloats(fin[o + 3], fin[o + 4], fin[o + 5], fin[o + 6]);
            f.q.multiplyToRef(q, tn.rotationQuaternion);
            f.used = false;
            this._offLast.push(f.i);
        }
        this._offUsed.length = 0;
    }

    // --- Предметы и части --------------------------------------------------------------

    // Предмет (Model3D.build, px) — к узлу nodeName. opts: { pos?: [x, y, z] м, rot?: [x, y, z] °,
    // scale?: число | [x, y, z], space?: 'model' | 'local' }. space 'model' (по умолчанию):
    // pos и rot — в осях МОДЕЛИ в позе покоя (вперёд +X, вверх +Y, влево −Z в glTF; в Blender
    // вверх +Z, влево +Y), начало — точка узла: оружие, смоделированное «в руке персонажа в
    // позе покоя», встаёт без подбора. 'local' — оси самого узла (кости). Предмет
    // регистрируется World3D.addObject. Нет узла — предмет на корне и предупреждение.
    attach(nodeName, mesh, opts) {
        if (!mesh || this.disposed) return mesh;
        const o = opts || {};
        const i = this.prep.byName.has(nodeName) ? this.prep.byName.get(nodeName) : -1;
        const tn = i >= 0 && this._tn[i] ? this._tn[i] : this.root;
        if (i < 0) Rig.warnOnce('node|' + (Rig._urls.get(this.model) || this.name) + '|' + nodeName, 'Rig: нет узла «' + nodeName + '» у ' + (Rig._urls.get(this.model) || this.name) + ' — предмет на корне');
        const D = Math.PI / 180, U = Rig.UNIT, V3 = BABYLON.Vector3, M = BABYLON.Matrix;
        const p = o.pos || [0, 0, 0], r = o.rot || [0, 0, 0];
        const sc = o.scale == null ? [1, 1, 1] : (Array.isArray(o.scale) ? o.scale : [o.scale, o.scale, o.scale]);
        // Смещение предмета: масштаб, поворот (углы как у mesh.rotation), сдвиг — px.
        let local = M.Compose(new V3(sc[0], sc[1], sc[2]),
            BABYLON.Quaternion.FromEulerAngles(r[0] * D, r[1] * D, r[2] * D),
            new V3(p[0] * U, p[1] * U, p[2] * U));
        if (o.space !== 'local' && i >= 0) {
            // Оси модели: мир узла в покое W = S·R·T (строки-векторы); нужно local·W = смещение·T,
            // значит local = смещение · R⁻¹ · S⁻¹ — снять поворот и масштаб узла.
            const s = new V3(), q = new BABYLON.Quaternion(), t = new V3();
            this.prep.world[i].decompose(s, q, t);
            const rotInv = new M();
            M.FromQuaternionToRef(BABYLON.Quaternion.Inverse(q), rotInv);
            local = local.multiply(rotInv).multiply(M.Scaling(1 / (s.x || 1), 1 / (s.y || 1), 1 / (s.z || 1)));
        }
        const s = new V3(), q = new BABYLON.Quaternion(), t = new V3();
        local.decompose(s, q, t);
        mesh.parent = tn;
        mesh.position.copyFrom(t);
        mesh.rotationQuaternion = q;
        mesh.scaling.copyFrom(s);
        World3D.addObject(this.view, mesh, this.kind);
        for (const m of [mesh].concat(mesh.getChildMeshes(false))) m.isPickable = false;
        this._attached.push(mesh);
        return mesh;
    }

    // Снять предмет. dispose !== false — удалить вместе с материалами, иначе только
    // отцепить (контур, обводка и тень сняты, меш остаётся владельцу).
    detach(mesh, dispose) {
        const k = this._attached.indexOf(mesh);
        if (k >= 0) this._attached.splice(k, 1);
        if (!mesh || mesh.isDisposed()) return;
        if (dispose !== false) { Model3D.dispose(this.view, mesh); return; }
        for (const m of [mesh].concat(mesh.getChildMeshes(false))) World3D.outlineRemove(this.view, m);
        this.view.removeShadowCaster(mesh);
        mesh.setParent(null);
    }

    // Части с именем, начинающимся с prefix ('Vest', 'Quiver'): показать или спрятать. Возвращает число частей.
    setPartVisible(prefix, on) {
        let n = 0;
        for (const m of this._meshes) {
            if (m.metadata && String(m.metadata.part).startsWith(prefix)) { m.setEnabled(!!on); n++; }
        }
        return n;
    }

    // Показать или спрятать весь риг. Спрятанный позу не считает.
    setEnabled(on) { this.root.setEnabled(!!on); }

    // Мировая точка узла (px): вылет снаряда, 'Head' — над головой. out — куда писать.
    // Это ВИД (Babylon), для эффектов, а не для игровых решений (инвариант 4).
    nodePosition(nodeName, out) {
        const res = out || new BABYLON.Vector3();
        const tn = this.nodes.get(nodeName);
        if (!tn) {
            this.root.computeWorldMatrix(true);
            res.copyFrom(this.root.getAbsolutePosition());
            res.y += nodeName === 'Head' ? this.height * 0.9 : this.height * 0.5;
            return res;
        }
        // Цепочка от корня: матрицы могли не пересчитаться с прошлого кадра.
        let chain = this._chains.get(nodeName);
        if (!chain) {
            chain = [];
            for (let n = /** @type {BABYLON.Node} */ (tn); n; n = n.parent) chain.unshift(/** @type {BABYLON.TransformNode} */ (n));
            this._chains.set(nodeName, chain);
        }
        for (let k = 0; k < chain.length; k++) chain[k].computeWorldMatrix(true);
        res.copyFrom(tn.getAbsolutePosition());
        return res;
    }

    // --- Конец -----------------------------------------------------------------------

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        Rig._live.delete(this);
        for (const a of this._attached.slice()) { if (!a.isDisposed()) Model3D.dispose(this.view, a); }
        this._attached = [];
        if (this.view && this.view.scene) World3D.removeObject(this.view, this.root);
        this._meshes = [];
        this.parts.clear();
        this.nodes.clear();
        this._queue = [];
        this._offUsed.length = 0;
    }
}
