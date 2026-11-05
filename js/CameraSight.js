// CameraSight.js — камера не заслоняется сценой (1.40): столкновение с твёрдой геометрией, полупрозрачные
// заслоны между камерой и целью, постановка на цель без кадра внутри геометрии. Подключается к
// CameraController сама: camera.sight (нет файла — камера как в 1.30). Оба механизма — опт-ин:
// CAMERA_COLLIDE = 1 и CAMERA_FADE = 1 в Constants.js (или Object.assign(camera.c, { collide: 1, fade: 1 })).
// Работает только в игровом режиме и пока камера следует за объектом (follow); в редакторе (setFree) спит.
//
// 1. СТОЛКНОВЕНИЕ (pull-in). Луч идёт от точки взгляда (цель + CAMERA_SIGHT_LIFT) к желаемой позиции камеры.
//    Запрос геометрии подключаемый — query(from, to, radius) -> расстояние от from до препятствия или null:
//      · по умолчанию CameraSight.pickQuery: пучок лучей Babylon по мешам с metadata.cameraSolid
//        (CameraSight.solid(mesh) ставит флаг; у корня модели флаг действует на все части);
//      · свой: camera.sight.query = (from, to, radius) => Course.ray(...) — курс, Nav, физика игры;
//        CameraSight.bisect(isClear) собирает query из «отрезок чист?» (например Nav.los по x и z).
//    Камера встаёт на луче на hit − CAMERA_COLLIDE_MARGIN, но не ближе CAMERA_COLLIDE_MIN доли дистанции.
//    Подтягивание мгновенное (камера не должна быть в стене даже кадр), возврат плавный —
//    CAMERA_COLLIDE_RETURN (1/с). Дистанцию зума это не меняет: укорачивается только положение камеры.
//
// 2. ПОЛУПРОЗРАЧНЫЕ ЗАСЛОНЫ (fade). Отрезок камера → точка взгляда (толщина CAMERA_FADE_PAD) пересекает габарит
//    объекта — тот плавно растворяется до CAMERA_FADE_ALPHA и возвращается, когда уходит с линии.
//    Заслоны поставляет Location3D сам: КАЖДЫЙ инстанс пачки декора (деревья) растворяется отдельно, а не вся
//    пачка; объекты-меши — если у них metadata.cameraFade = true или fadeFilter(rec) вернул true. Свои меши игры —
//    camera.sight.add(mesh) или свой источник camera.sight.occluders = (eye, focus, pad) => [заслон, …].
//    Заслон — { key?, box: {x0,y0,z0,x1,y1,z1}, fade(alpha), release?(), alive?() } (CameraSight.meshOccluder).
//    КАК ЭТО РИСУЕТСЯ. Прозрачному мешу Babylon (visibility < 1) уходит из карты теней, а контур рёбер и обводка
//    силуэта ложатся вокруг невидимого. Поэтому на время растворения объект подменяется «призраком» — клоном
//    меша с общей геометрией и материалом, но без контура рёбер и без обводки (они исчезают в начале растворения
//    и возвращаются, когда объект снова непрозрачен); оригинал уходит из камеры (маска слоя Location3D.SHADOW_LAYER)
//    или, у инстанса пачки, из видеобуфера (Location3D.setInstanceHidden), но остаётся в карте теней: тень не мигает.
//    Не больше CAMERA_FADE_MAX призраков одновременно, ближайшие к камере — первыми. Призрак мешу-объекту ставится на
//    матрицу в момент создания: заслон должен стоять на месте (декор, колонны, арки), не ехать.
//
// 3. ПОСТАНОВКА (спавн, респаун, чекпоинт, смена карты). camera.snap() / camera.snap(x, y, h) / home() считают
//    столкновение и заслоны сразу и без сглаживания: первый же кадр камеры уже исправлен. Нулевой dt
//    (camera.update(0), так main.js ставит кадр после loadMap) — тоже мгновенный расчёт, как и два кадра после snap.
//
// Чистая логика без Babylon (тесты): CameraReach (доля дистанции со сглаживанием возврата), OccluderFader (состояние
// растворения по списку заслонов), CameraSight.bisect. Своя камера игры (не CameraController) берёт их по отдельности.

/** @typedef {{ x: number, y: number, z: number }} SightPoint */
/** @typedef {{ x0: number, y0: number, z0: number, x1: number, y1: number, z1: number }} SightBox */
/**
 * Заслон: то, что может встать между камерой и целью и стать полупрозрачным.
 * @typedef {object} Occluder
 * @property {any} [key] по нему хранится состояние растворения (по умолчанию сам объект)
 * @property {SightBox} box габарит в мире, px (X, высота, Z)
 * @property {(alpha: number) => void} fade 1 — как был, меньше — полупрозрачно (зовётся при смене значения)
 * @property {() => void} [release] перестали следить: вернуть объект как был (идемпотентно)
 * @property {() => boolean} [alive] false — объект снят со сцены, состояние забыть
 * @property {() => boolean} [ready] зовётся каждый кадр, пока заслон на линии и растворение не началось: готовит ресурсы
 *   (призраков, шейдеры) и сообщает, можно ли начинать; false — объект остаётся как был
 */

// --- Доля дистанции камеры: мгновенное подтягивание, плавный возврат ---------------------------------

class CameraReach {
    constructor() {
        this.value = 1;   // 1 — камера на полной дистанции, меньше — подтянута к цели
    }

    // Желаемая доля дистанции по ответу запроса: hit — расстояние до препятствия от точки взгляда (null,
    // не число или не меньше len — чисто), len — длина луча, margin — запас перед препятствием, min — нижний предел доли.
    static wanted(hit, len, margin, min) {
        if (!(len > 0) || typeof hit !== 'number' || !Number.isFinite(hit) || hit >= len) return 1;
        const lo = Math.max(0, Math.min(1, Number.isFinite(min) ? min : 0.2));
        return Math.max(lo, Math.min(1, (Math.max(0, hit) - Math.max(0, margin || 0)) / len));
    }

    // Один кадр: ближе — сразу, дальше — по экспоненте rate (1/с); instant — сразу в любую сторону.
    step(want, dt, rate, instant) {
        if (instant || want <= this.value || !(rate > 0)) {
            this.value = want;
        } else {
            this.value += (want - this.value) * (1 - Math.exp(-rate * Math.max(0, dt || 0)));
            if (want - this.value < 0.002) this.value = want;
        }
        return this.value;
    }

    reset() { this.value = 1; }
}

// --- Состояние растворения заслонов ---------------------------------------------------------------------

class OccluderFader {
    constructor() {
        /** @type {Map<any, { item: Occluder, p: number, a: number }>} */
        this.items = new Map();   // ключ -> { заслон, прогресс 0..1, последняя прозрачность }
    }

    get size() { return this.items.size; }

    // Прозрачность по прогрессу p (0 — как был, 1 — целиком растворён): сглаженный переход от 1 до alpha.
    static alphaOf(p, alpha) {
        const s = p * p * (3 - 2 * p);
        return 1 - (1 - alpha) * s;
    }

    // Доля t ∈ [0, 1] отрезка a→b, где он входит в габарит box (раздутый на pad; отрицательный pad сжимает),
    // или null. Заслоном не считается объект, центр которого дальше точки взгляда b: тот, что стоит позади цели,
    // цель не закрывает.
    static hit(box, a, b, pad) {
        const p = Number(pad) || 0;
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        let t0 = 0, t1 = 1;
        const slab = (o, d, lo, hi) => {
            lo -= p; hi += p;
            if (!(lo < hi)) return false;
            if (Math.abs(d) < 1e-9) return o >= lo && o <= hi;
            let u = (lo - o) / d, v = (hi - o) / d;
            if (u > v) { const s = u; u = v; v = s; }
            if (u > t0) t0 = u;
            if (v < t1) t1 = v;
            return t0 <= t1;
        };
        if (!slab(a.x, dx, box.x0, box.x1) || !slab(a.y, dy, box.y0, box.y1) || !slab(a.z, dz, box.z0, box.z1)) return null;
        const L2 = dx * dx + dy * dy + dz * dz;
        if (L2 > 1e-6) {
            const tc = ((box.x0 + box.x1) / 2 - a.x) * dx + ((box.y0 + box.y1) / 2 - a.y) * dy + ((box.z0 + box.z1) / 2 - a.z) * dz;
            if (tc / L2 > 1) return null;
        }
        return t0;
    }

    // Кадр. eye → focus — линия взгляда; list — кандидаты (годятся все: точный отбор здесь); o: { alpha, sec (растворение),
    // backSec (возврат), pad, max (призраков сразу), instant }. Ближайшие к камере занимают места первыми.
    update(dt, eye, focus, list, o) {
        /** @type {{ item: Occluder, key: any, t: number }[]} */
        const hits = [];
        for (const item of list) {
            if (!item || (item.alive && item.alive() === false)) continue;
            const t = OccluderFader.hit(item.box, eye, focus, o.pad);
            if (t !== null) hits.push({ item, key: item.key !== undefined ? item.key : item, t });
        }
        hits.sort((p, q) => p.t - q.t);
        const on = new Set();
        for (const h of hits) {
            if (!this.items.has(h.key)) {
                if (this.items.size >= Math.max(0, o.max)) continue;
                this.items.set(h.key, { item: h.item, p: 0, a: 1 });
            }
            on.add(h.key);
        }
        const dtIn = o.sec > 0 ? dt / o.sec : Infinity, dtOut = o.backSec > 0 ? dt / o.backSec : Infinity;
        for (const [key, st] of Array.from(this.items)) {
            if (st.item.alive && st.item.alive() === false) { this.items.delete(key); this._call(st.item, 'release'); continue; }
            const want = on.has(key);
            if (want && st.p <= 0 && st.item.ready && !this._ready(st.item)) continue;   // призраки ещё собираются: объект остаётся как был
            if (o.instant) st.p = want ? 1 : 0;
            else if (want) st.p = Math.min(1, st.p + dtIn);
            else st.p = Math.max(0, st.p - dtOut);
            if (!want && st.p <= 1e-6) {   // 1e-6: накопленная ошибка шагов dt не задерживает освобождение на кадр
                this.items.delete(key);
                this._call(st.item, 'fade', 1);
                this._call(st.item, 'release');
                continue;
            }
            const a = OccluderFader.alphaOf(st.p, o.alpha);
            if (a !== st.a) { st.a = a; this._call(st.item, 'fade', a); }
        }
    }

    // Вернуть все объекты как были и забыть их (выключили, режим редактора, смена карты).
    reset() {
        for (const st of this.items.values()) { this._call(st.item, 'fade', 1); this._call(st.item, 'release'); }
        this.items.clear();
    }

    // Готов ли заслон начинать (item.ready); ошибка чужого заслона не роняет кадр камеры — считаем готовым.
    _ready(item) {
        try { return !!item.ready(); } catch (e) { OccluderFader._warn('ready', e); return true; }
    }

    _call(item, method, arg) {
        try { if (typeof item[method] === 'function') item[method](arg); } catch (e) { OccluderFader._warn(method, e); }
    }

    static _warn(method, e) {
        if (OccluderFader._warned) return;
        OccluderFader._warned = true;
        console.warn('CameraSight: заслон не принял ' + method + ':', (e && e.message) || e);
    }
}
OccluderFader._warned = false;

// --- Камера ---------------------------------------------------------------------------------------------

class CameraSight {
    /** @param {CameraController} camera */
    constructor(camera) {
        this.cam = camera;
        this.reach = new CameraReach();
        this.fader = new OccluderFader();
        /** @type {((from: SightPoint, to: SightPoint, radius: number) => (number | null | undefined)) | null} */
        this.query = null;            // запрос геометрии игры; null — CameraSight.pickQuery по мешам cameraSolid
        /** @type {((mesh: any) => boolean) | null} */
        this.solid = null;            // свой отбор твёрдых мешей для запроса по умолчанию
        /** @type {((eye: SightPoint, focus: SightPoint, pad: number) => Occluder[]) | null} */
        this.occluders = null;        // свой источник заслонов
        /** @type {((rec: any) => boolean) | null} */
        this.fadeFilter = null;       // какие меши-объекты Location3D растворять (инстансы пачек — всегда)
        /** @type {any} */
        this.location = null;         // Location3D; null — view.location
        /** @type {Occluder[]} */
        this.extra = [];              // add(): заслоны игры
        this.hit = null;              // последний ответ запроса (расстояние до препятствия) — для отладки
        this._instant = 0;
        /** @type {any} */
        this._default = null;
        this._warned = false;
        this._from = { x: 0, y: 0, z: 0 };
        this._to = { x: 0, y: 0, z: 0 };
        this._eye = { x: 0, y: 0, z: 0 };
        /** @type {WeakMap<any, Occluder>} */
        this._items = new WeakMap();  // запись Location3D -> заслон (состояние живёт в нём)
        /** @type {WeakMap<any, any>} */
        this._no = new WeakMap();     // запись Location3D -> меш, для которого решено «не растворять»
        /** @type {Occluder[]} */
        this._list = [];
        /** @type {WeakSet<any>} */
        this._warmed = new WeakSet(); // пачки, для которых шейдеры призраков уже запущены
        /** @type {any[]} */
        this._warming = [];           // скрытые призраки-«прогрев»: ждут сборки шейдера, потом снимаются
    }

    // Нужна ли камере проверка: игровой режим, слежение и хотя бы один механизм включён.
    active() {
        const cam = this.cam, c = cam.c;
        return !cam.free && !!cam.followObj && (c.collide > 0 || c.fade > 0);
    }

    // Кадр: после слежения и зума, до применения камеры. dt = 0 — мгновенно (постановка, кадр после loadMap).
    update(dt) {
        const cam = this.cam, c = cam.c;
        if (!this.active()) {
            if (this.reach.value !== 1) this.reach.reset();
            if (this.fader.size) this.fader.reset();
            return;
        }
        const instant = !(dt > 0) || this._instant > 0;
        if (this._instant > 0 && dt > 0) this._instant--;
        const t = cam.target, from = this._from, to = cam._eyeAt(cam.distance(), this._to);
        from.x = t.x; from.y = t.h + c.sightLift; from.z = t.y;
        if (c.collide > 0) {
            const len = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
            this.hit = len > 1 ? this._cast(from, to, c.collideRadius) : null;
            this.reach.step(CameraReach.wanted(this.hit, len, c.collideMargin, c.collideMin), dt, c.collideReturn, instant);
        } else {
            this.hit = null;
            this.reach.reset();
        }
        if (c.fade > 0) {
            if (this._warming.length) this._warming = this._warming.filter(g => !(g.isReady(true) && (g.dispose(), true)));
            const eye = this._eye;
            eye.x = to.x; eye.y = to.y; eye.z = to.z;
            this.pull(eye);
            this.fader.update(dt, eye, from, this._candidates(eye, from, c.fadePad), {
                alpha: c.fadeAlpha, sec: c.fadeSec, backSec: c.fadeBackSec, pad: c.fadePad, max: c.fadeMax, instant
            });
        } else if (this.fader.size) {
            this.fader.reset();
        }
    }

    // Подтянуть желаемую позицию камеры e к точке взгляда на текущую долю (CameraController._syncCamera).
    pull(e) {
        const r = this.reach.value;
        if (!(r < 1) || !this.active()) return e;
        const t = this.cam.target, fy = t.h + this.cam.c.sightLift;
        e.x = t.x + (e.x - t.x) * r;
        e.y = fy + (e.y - fy) * r;
        e.z = t.y + (e.z - t.y) * r;
        return e;
    }

    // Мгновенная постановка: состояние сброшено и посчитано заново без сглаживания; два следующих кадра тоже мгновенные
    // (геометрия и пачки декора могут дойти кадром позже).
    snap() {
        this._instant = 2;
        this.reach.reset();
        this.update(0);
    }

    // Забыть всё: объекты вернуть как были, состояние сбросить (смена карты, выключение).
    reset() {
        this.fader.reset();
        this.reach.reset();
        this.hit = null;
        this._default = null;
        this._items = new WeakMap();
        this._no = new WeakMap();
        for (const g of this._warming) { try { g.dispose(); } catch (e) { /* уже снят вместе с картой */ } }
        this._warming = [];
        this._warmed = new WeakSet();
    }

    // Заслоны игры: меш (или массив мешей — одним заслоном) либо готовый Occluder.
    add(target, opts) {
        const item = (target && typeof target.fade === 'function') ? target : CameraSight.meshOccluder(target, opts);
        this.extra.push(item);
        try { if (item.ready) item.ready(); } catch (e) { /* первый кадр покажет */ }   // шейдеры призраков собираются заранее
        return item;
    }

    remove(target) {
        const i = this.extra.findIndex(it => it === target || it.key === target);
        if (i < 0) return false;
        const it = this.extra.splice(i, 1)[0];
        if (this.fader.items.delete(it.key !== undefined ? it.key : it)) {
            try { it.fade(1); if (it.release) it.release(); } catch (e) { /* объект уже снят со сцены */ }
        }
        return true;
    }

    // Твёрдые меши сцены пересканировать (флаги metadata.cameraSolid правили напрямую).
    invalidate() { CameraSight._ver++; }

    _cast(from, to, radius) {
        let q = this.query;
        if (!q) {
            const scene = this.cam.view && this.cam.view.scene;
            if (!scene) return null;
            q = this._default || (this._default = CameraSight.pickQuery(scene, { solid: (m) => (this.solid ? !!this.solid(m) : CameraSight.isSolid(m)) }));
        }
        try {
            const d = q(from, to, radius);
            return typeof d === 'number' && Number.isFinite(d) ? d : null;
        } catch (e) {
            if (!this._warned) { this._warned = true; console.warn('CameraSight: query бросил исключение, столкновение пропущено:', (e && e.message) || e); }
            return null;
        }
    }

    // Кандидаты в заслоны: Location3D (инстансы пачек, меши-объекты), заслоны игры и её источник.
    _candidates(eye, focus, pad) {
        const out = this._list;
        out.length = 0;
        const loc = this.location || (this.cam.view && /** @type {any} */ (this.cam.view).location);
        if (loc && loc.objects) this._fromLocation(loc, eye, focus, pad, out);
        for (const it of this.extra) out.push(it);
        if (typeof this.occluders === 'function') {
            const more = this.occluders(eye, focus, pad);
            if (more) for (const it of more) out.push(it);
        }
        return out;
    }

    // Инстансы пачек декора и меши-объекты Location3D. Инстансы отбираются по шару (радиус модели × масштаб) вокруг
    // отрезка — один проход по числам; заслон (с ghost-мешами) заводится только для попавших.
    _fromLocation(loc, eye, focus, pad, out) {
        if (typeof loc.setInstanceHidden !== 'function') return;
        const dx = focus.x - eye.x, dy = focus.y - eye.y, dz = focus.z - eye.z;
        const L2 = dx * dx + dy * dy + dz * dz || 1;
        for (const b of loc._batches.values()) {
            if (!b.parts || !b.n || !b.live || !b.pos3) continue;
            if (!this._warmed.has(b)) this._warm(b);
            const p3 = b.pos3, rad = b.rad, n = b.n;
            for (let i = 0; i < n; i++) {
                const px = p3[i * 3] - eye.x, py = p3[i * 3 + 1] - eye.y, pz = p3[i * 3 + 2] - eye.z;
                const k = Math.max(0, Math.min(1, (px * dx + py * dy + pz * dz) / L2));
                const ex = px - dx * k, ey = py - dy * k, ez = pz - dz * k, r = rad[i] + pad;
                if (ex * ex + ey * ey + ez * ez > r * r) continue;
                const rec = b.live[i];
                let item = this._items.get(rec);
                if (!item) { item = CameraSight.instanceOccluder(loc, b, rec); this._items.set(rec, item); }
                out.push(item);
            }
        }
        for (const rec of loc.objects) {
            if (rec.batch || !rec.mesh || rec.dead || rec.hidden || !this._fadable(loc, rec)) continue;
            let item = this._items.get(rec);
            if (!item) { item = CameraSight.meshOccluder(rec.mesh, { key: rec }); this._items.set(rec, item); }
            out.push(item);
        }
    }

    // Прогрев: призрак без инстансов — другой вариант шейдера, чем у пачки, и первая сборка занимает кадры. Скрытый призрак
    // каждой части заводится заранее (как только пачка появилась) и снимается, когда шейдер собран: к первому растворению
    // вариант уже в кэше движка.
    _warm(batch) {
        this._warmed.add(batch);
        for (const part of batch.parts) {
            const g = CameraSight.ghost(part.mesh, BABYLON.Matrix.Identity());
            if (g) this._warming.push(g);
        }
    }

    // Меш-объект Location3D растворяется: по fadeFilter, иначе по metadata.cameraFade, иначе — если это декор-подобная
    // модель (папка декора или opts.batchRepeated), не попавшая в пачку (одиночные фонари). Отрицательный ответ по
    // умолчанию помнится для меша: список объектов карты обходится каждый кадр.
    _fadable(loc, rec) {
        if (this.fadeFilter) return !!this.fadeFilter(rec);
        const md = rec.mesh.metadata;
        if (md && md.cameraFade != null) return !!md.cameraFade;
        if (this._no.get(rec) === rec.mesh) return false;
        const d = rec.def;
        const yes = d.kind === 'prop' && !d.anim && typeof d.model === 'string' &&
            (loc.isDecor(d) || [].concat(loc.opts.batchRepeated || []).some(/** @param {string} p */ p => d.model.indexOf(p) === 0));
        if (!yes) this._no.set(rec, rec.mesh);
        return yes;
    }

    // --- Твёрдая геометрия: запрос по умолчанию -------------------------------------------------------

    // Пометить меш (корень модели — со всеми частями) твёрдым для камеры или снять метку (on = false).
    static solid(target, on) {
        for (const m of [].concat(target)) {
            if (!m) continue;
            m.metadata = Object.assign(m.metadata || {}, { cameraSolid: on !== false });
        }
        CameraSight._ver++;
        return target;
    }

    // Меш твёрдый: ближайшая метка cameraSolid вверх по родителям (у части можно переопределить родителя).
    static isSolid(mesh) {
        for (let n = mesh; n; n = n.parent) {
            const md = n.metadata;
            if (md && md.cameraSolid != null) return !!md.cameraSolid;
        }
        return false;
    }

    // Запрос по умолчанию: пучок лучей Babylon (центральный и четыре по кругу радиуса radius, параллельные) по твёрдым мешам сцены.
    // opts: { solid?: (mesh) => boolean }. Список твёрдых мешей пересобирается при смене числа мешей сцены, invalidate() и раз
    // в пару секунд. Меши должны быть обычными (не инстансами) и не слишком тяжёлыми: лучи идут по треугольникам.
    static pickQuery(scene, opts) {
        const test = (opts && opts.solid) || CameraSight.isSolid;
        /** @type {any[]} */
        let list = [];
        let count = -1, ver = -1, age = 0;
        const origin = new BABYLON.Vector3(), dir = new BABYLON.Vector3();
        const ray = new BABYLON.Ray(origin, dir, 1);
        return (from, to, radius) => {
            if (count !== scene.meshes.length || ver !== CameraSight._ver || ++age > 120) {
                count = scene.meshes.length; ver = CameraSight._ver; age = 0;
                list = scene.meshes.filter(m => m.getTotalVertices() > 0 && test(m));
            }
            if (!list.length) return null;
            const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, len = Math.hypot(dx, dy, dz);
            if (!(len > 1e-3)) return null;
            const ux = dx / len, uy = dy / len, uz = dz / len;
            // Базис плоскости, перпендикулярной лучу: u = dir × вверх (вырождается у вертикального луча — берём X), v = dir × u.
            let ax = uz, az = -ux, al = Math.hypot(ax, az);
            if (al < 1e-4) { ax = 1; az = 0; al = 1; }
            ax /= al; az /= al;
            const bx = uy * az, by = uz * ax - ux * az, bz = -uy * ax;
            const r = Math.max(0, Number(radius) || 0);
            const offs = r > 0 ? [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]] : [[0, 0]];
            dir.set(ux, uy, uz);
            ray.length = len;
            let best = Infinity;
            for (const [s, t] of offs) {
                origin.set(from.x + ax * s + bx * t, from.y + by * t, from.z + az * s + bz * t);
                for (const m of list) {
                    if (!m.isEnabled()) continue;
                    const h = ray.intersectsMesh(m, false);
                    if (h && h.hit && h.distance < best) best = h.distance;
                }
            }
            return best < len ? best : null;
        };
    }

    // query из проверки «отрезок a→b свободен?» (isClear(a, b) -> boolean): половинное деление по длине. Для
    // Nav: CameraSight.bisect((a, b) => Nav.los(a.x, a.z, b.x, b.z)) — карта плоская, высоту Nav не знает.
    static bisect(isClear, steps) {
        const n = steps > 0 ? Math.floor(steps) : 8;
        return (from, to) => {
            if (isClear(from, to)) return null;
            const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, len = Math.hypot(dx, dy, dz);
            let lo = 0, hi = 1;
            for (let i = 0; i < n; i++) {
                const mid = (lo + hi) / 2;
                if (isClear(from, { x: from.x + dx * mid, y: from.y + dy * mid, z: from.z + dz * mid })) lo = mid; else hi = mid;
            }
            return lo * len;
        };
    }

    // --- Заслоны: меш и инстанс пачки ----------------------------------------------------------------------

    // Маска слоя «не для камеры, но для карты теней» (Location3D.SHADOW_LAYER).
    static hideLayer() {
        return typeof Location3D !== 'undefined' && Location3D.SHADOW_LAYER ? Location3D.SHADOW_LAYER : 0x10000000;
    }

    // Призрак меша: клон с общей геометрией и материалом, поставленный на матрицу matrix; создаётся скрытым (isVisible = false)
    // — показывает его заслон, когда шейдер готов. Без контура рёбер, обводки, тени-кастера и картинга; приёмник теней как оригинал.
    static ghost(src, matrix) {
        const g = src.clone(src.name + '/fade', null, true);
        if (!g) return null;
        g.parent = null;                      // клон наследует родителя оригинала; положение призрака — только его матрица
        g.metadata = { cameraGhost: true };   // у клона metadata общая с оригиналом — в обводку и контур призрак попасть не должен
        g.isPickable = false;
        g.isVisible = false;
        g.receiveShadows = src.receiveShadows;
        g.layerMask = src.layerMask;
        if (g.hasThinInstances) g.thinInstanceSetBuffer('matrix', null);
        if (g.edgesRenderer) g.disableEdgesRendering();
        g.freezeWorldMatrix(matrix);
        return g;
    }

    // Призраки готовы к показу: материал каждого собран (шейдер без инстансов отличается от шейдера пачки и компилируется
    // отдельно, асинхронно). Оригинал прячется только после этого, иначе объект на несколько кадров исчез бы совсем.
    static ghostsReady(list) {
        return list.every(/** @param {{ ghost: any }} p */ p => !p.ghost || p.ghost.isReady(true));
    }

    // Заслон из мешей (корень модели с частями или массив мешей): габарит — по иерархии; призраки частей, пока он
    // растворяется. opts: { key, dynamic } — dynamic пересчитывает габарит каждый кадр (объект ездит).
    static meshOccluder(target, opts) {
        const o = opts || {};
        /** @type {any[]} */
        const roots = [].concat(target).filter(Boolean);
        /** @type {SightBox | null} */
        let box = null;
        /** @type {{ src: any, ghost: any, mask: number }[] | null} */
        let parts = null;
        let shown = false;   // оригиналы спрятаны, призраки показаны
        const calc = () => {
            const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
            for (const r of roots) {
                const b = r.getHierarchyBoundingVectors(true);
                for (const [i, k] of /** @type {[number, 'x'|'y'|'z'][]} */ ([[0, 'x'], [1, 'y'], [2, 'z']])) {
                    lo[i] = Math.min(lo[i], b.min[k]);
                    hi[i] = Math.max(hi[i], b.max[k]);
                }
            }
            box = { x0: lo[0], y0: lo[1], z0: lo[2], x1: hi[0], y1: hi[1], z1: hi[2] };
        };
        const make = () => {
            const list = [];
            for (const r of roots) {
                for (const m of [r].concat(r.getChildMeshes(false))) {
                    if (!m.getTotalVertices || m.getTotalVertices() <= 0 || (m.metadata && m.metadata.cameraGhost)) continue;
                    m.computeWorldMatrix(true);
                    list.push({ src: m, ghost: CameraSight.ghost(m, m.getWorldMatrix().clone()), mask: m.layerMask });
                }
            }
            return list;
        };
        const release = () => {
            if (!parts) return;
            for (const p of parts) {
                if (shown && !p.src.isDisposed()) p.src.layerMask = p.mask;
                if (p.ghost) p.ghost.dispose();
            }
            parts = null;
            shown = false;
        };
        return {
            key: o.key !== undefined ? o.key : roots[0],
            get box() { if (!box || o.dynamic) calc(); return /** @type {SightBox} */ (box); },
            alive: () => roots.length > 0 && roots.every(r => !r.isDisposed()),
            ready() {
                if (!parts) parts = make();
                return CameraSight.ghostsReady(parts);
            },
            fade(a) {
                if (!(a < 1)) { release(); return; }
                if (!parts) parts = make();
                if (!shown) {
                    shown = true;
                    for (const p of parts) if (p.ghost) { p.ghost.isVisible = true; p.src.layerMask = CameraSight.hideLayer(); }
                }
                for (const p of parts) if (p.ghost) p.ghost.visibility = a;
            },
            release
        };
    }

    // Заслон — один инстанс пачки декора Location3D (дерево): габарит по границам модели и матрице инстанса; на время
    // растворения инстанс прячется из видеобуфера пачки (setInstanceHidden), а его место занимают призраки частей.
    static instanceOccluder(loc, batch, rec) {
        /** @type {{ src: any, ghost: any }[] | null} */
        let parts = null;
        let shown = false;
        /** @type {SightBox | null} */
        let box = null;
        const calc = () => {
            const m = loc._instanceMatrix(rec).m, lo = batch.min, hi = batch.max;
            if (!lo || !hi || !Number.isFinite(lo[0]) || !Number.isFinite(hi[0])) {
                const i = batch.live.indexOf(rec), r = batch.rad[i];
                box = { x0: m[12] - r, y0: m[13] - r, z0: m[14] - r, x1: m[12] + r, y1: m[13] + r, z1: m[14] + r };
                return;
            }
            const b = { x0: Infinity, y0: Infinity, z0: Infinity, x1: -Infinity, y1: -Infinity, z1: -Infinity };
            for (let k = 0; k < 8; k++) {
                const x = k & 1 ? hi[0] : lo[0], y = k & 2 ? hi[1] : lo[1], z = k & 4 ? hi[2] : lo[2];
                const wx = x * m[0] + y * m[4] + z * m[8] + m[12], wy = x * m[1] + y * m[5] + z * m[9] + m[13], wz = x * m[2] + y * m[6] + z * m[10] + m[14];
                if (wx < b.x0) b.x0 = wx; if (wx > b.x1) b.x1 = wx;
                if (wy < b.y0) b.y0 = wy; if (wy > b.y1) b.y1 = wy;
                if (wz < b.z0) b.z0 = wz; if (wz > b.z1) b.z1 = wz;
            }
            box = b;
        };
        const make = () => {
            const i = batch.live ? batch.live.indexOf(rec) : -1;
            if (i < 0 || !batch.parts) return [];
            return batch.parts.map(/** @param {any} part */ part => ({ src: part.mesh, ghost: CameraSight.ghost(part.mesh, BABYLON.Matrix.FromArray(part.full, i * 16)) }));
        };
        const release = () => {
            if (!parts) return;
            for (const p of parts) if (p.ghost) p.ghost.dispose();
            parts = null;
            if (shown) loc.setInstanceHidden(rec, false);
            shown = false;
        };
        return {
            key: rec,
            get box() { if (!box) calc(); return /** @type {SightBox} */ (box); },
            alive: () => !rec.dead && !rec.hidden && !!rec.batch && !!batch.parts,
            ready() {
                if (!parts) parts = make();
                return parts.length > 0 && CameraSight.ghostsReady(parts);
            },
            fade(a) {
                if (!(a < 1)) { release(); return; }
                if (!parts) parts = make();
                if (!parts.length) return;
                if (!shown) {
                    shown = true;
                    for (const p of parts) if (p.ghost) p.ghost.isVisible = true;
                    loc.setInstanceHidden(rec, true);
                }
                for (const p of parts) if (p.ghost) p.ghost.visibility = a;
            },
            release
        };
    }
}
CameraSight._ver = 0;   // растёт при CameraSight.solid / invalidate: пересканировать твёрдые меши
