// HudLayout.js — адаптивная раскладка HUD под любой размер окна: ПК, планшет, телефон в портрете и в
// альбомной ориентации, низкий iframe платформы (640×360, 568×320, Яндекс Игры с рекламной полосой).
// Модуль opt-in: игра, которая его не зовёт, расставляет HUD сама, как в 1.20.
//
// Идея. Игра регистрирует БЛОКИ HUD (счёт, цель, кнопка паузы, хотбар…) с «причалом» (dock) и базовым
// размером; HudLayout считает режим окна, безопасные поля и масштаб, раскладывает блоки так, чтобы они не
// пересекались, и публикует результат CSS-переменными на корневом элементе. Элементы, созданные позже,
// встают на место сами: достаточно data-hl="id" (или переменных в своём CSS).
//
//   HudLayout.init({ app })                          один раз (Game.init); app — пересчёт раз в HUDLAYOUT_REFRESH_SEC само
//   HudLayout.block('score', { dock: 'tr', w: 180, h: 44, el: '#score' })
//   HudLayout.block('goal',  { dock: 'tc', w: 420, h: 60, fill: true, el: '#goal' })
//   HudLayout.block('hint',  { dock: { tall: 'tc', default: 'bc' }, w: 320, h: 'auto', el: '#hint' })
//   HudLayout.remove('score');  HudLayout.refresh();  HudLayout.reserve({ bottom: 90 })   // своя полоса (баннер)
//
// БЛОК (def):
//   dock    куда причалить: 'tl' 'tr' 'bl' 'br' — углы (стопка: сверху вниз у верхних, снизу вверх у нижних),
//           'tc' 'bc' — верхний/нижний центр (занимает свободную ширину между боковыми колонками),
//           'ml' 'mr' — середина левого/правого края, 'c' — центр. Можно объектом по режимам:
//           { wide: 'tl', tall: 'tc', default: 'tl' }
//   w, h    базовый размер в px при масштабе 1 (число) или 'auto' — взять фактический размер элемента.
//           h: 'auto' у центрального блока (текст переносится): ширину ему считают по верхней полосе между
//           колонками, а высоту раскладка перемеряет после записи ширины
//   el      элемент или селектор (ищется при каждом пересчёте — можно создать позже); получает data-hl="id"
//   order   порядок в стопке и важность: меньше — ближе к углу и уступает последним (по умолчанию 0)
//   fill    для 'tc'/'bc': занять всю свободную ширину (до maxW), а не только w
//   maxW, minW   пределы ширины центрального блока (minW по умолчанию — половина w)
//   scale   false — не масштабировать (для 'auto' всегда false);  min — px: ниже этого размер при уменьшении не падает
//           (кнопки под палец)
//   visible bool | () => bool; без него, если есть el, — виден ли он на странице (скрытый не занимает места)
//   touchOnly  блок существует только при сенсорном вводе;  modes: ['wide', 'land'] — только в этих режимах
//
// РЕЖИМЫ (HudLayout.mode): 'wide' — ПК и большие планшеты в альбоме; 'land' — невысокое альбомное окно;
// 'low' — очень низкое (< HUDLAYOUT_LOW_HEIGHT: телефон в альбоме, iframe 640×360); 'tall' — портрет.
// Масштаб k (HudLayout.k) подбирается по режиму и сам уменьшается, пока всё не поместится (до HUDLAYOUT_SCALE_MIN);
// не поместилось — HudLayout.overflow = true (убрать блок или сократить HUD под этот режим: modes, visible).
//
// ПЕРЕМЕННЫЕ на корне (по умолчанию <html>), px: --hl-w --hl-h (окно) --hl-k (масштаб) --hl-m --hl-gap
// --hl-safe-t|r|b|l (вырезы + reserve) --hl-fs (базовый кегль) --hl-btn (минимальная цель касания) и для каждого блока
// --hl-<id>-x|y|w|h (слева-сверху) и --hl-<id>-r|b (отступ от правого/нижнего края). Классы: hl-wide|land|low|tall,
// hl-touch, hl-overflow. Для data-hl="id" HudLayout сам вписывает правило position:fixed + эти переменные.
// Слой HUD должен быть на весь экран (position:fixed; inset:0), иначе переменные — относительно окна, не слоя.
//
// ЧТЕНИЕ: HudLayout.rect(id) → {x,y,w,h} | null;  HudLayout.free — {l,t,r,b} центральная зона для меток мира
// (между верхним и нижним центром и боковыми колонками);  HudLayout.cols — {l, r} края колонок;  HudLayout.onChange(fn).
// СЕНСОР: touch берётся из Input (touchSeen и device 'touch', либо mouseTouch — Playables на ПК), без Input — из IS_MOBILE;
// своё — init({ touch: () => bool }).
// ПОЛЕ 2:1 (ViewCap.js, Playgama на десктопе): окно считается шириной поля, а не экрана — HUD не расползается по краям.
// Input при init сам заказывает места 'input-action' (контекстная кнопка) и 'input-stick' (стик) у нижних углов.
//
// Чистая часть: HudLayout.compute(view, blocks, cfg) — только числа, без DOM (тесты и свои расчёты).
// Числа — Constants.js (HUDLAYOUT_*). Если окно не поместило блоки даже при минимальном масштабе, пересечений
// не остаётся: блоки сдвигаются по стопке и выходят за край, overflow сообщает об этом.

/** @satisfies {Record<string, any>} */
const HudLayout = {
    // --- состояние (только чтение) ---
    mode: '',
    k: 1,
    touch: false,
    W: 0,
    H: 0,
    safe: { t: 0, r: 0, b: 0, l: 0 },
    /** Блоки не поместились даже при минимальном масштабе. */
    overflow: false,
    /** @type {Record<string, { x: number, y: number, w: number, h: number }>} */
    rects: {},
    free: { l: 0, t: 0, r: 0, b: 0 },
    cols: { l: 0, r: 0 },
    /** Свои полосы (баннер, панель платформы), px. */
    reserved: { t: 0, r: 0, b: 0, l: 0 },

    /** Размеры при k = 1, от которых считается масштаб режима: [ширина, высота] эталона. */
    REF: { wide: [1366, 768], land: [820, 470], low: [700, 400], tall: [430, 860] },

    // --- внутреннее ---
    _inited: false,
    /** @type {Record<string, any>} */
    _defs: {},
    _seq: 0,
    /** @type {HTMLElement | null} */
    _root: null,
    /** @type {HTMLElement | null} */
    _probe: null,
    /** @type {HTMLStyleElement | null} */
    _style: null,
    _vars: /** @type {Record<string, string>} */ ({}),
    _dirty: false,
    _t: 0,
    _raf: 0,
    /** @type {(() => boolean) | null} */
    _touchFn: null,
    /** @type {Function[]} */
    _subs: [],
    /** @type {(() => void)[]} */
    _unbind: [],

    // =====================================================================================
    // Запуск
    // =====================================================================================

    /** Числа Constants.js с дефолтами. */
    cfg() {
        const U = 'undefined';
        return {
            margin: typeof HUDLAYOUT_MARGIN !== U ? HUDLAYOUT_MARGIN : 10,
            gap: typeof HUDLAYOUT_GAP !== U ? HUDLAYOUT_GAP : 8,
            kMin: typeof HUDLAYOUT_SCALE_MIN !== U ? HUDLAYOUT_SCALE_MIN : 0.55,
            kMax: typeof HUDLAYOUT_SCALE_MAX !== U ? HUDLAYOUT_SCALE_MAX : 1.25,
            lowH: typeof HUDLAYOUT_LOW_HEIGHT !== U ? HUDLAYOUT_LOW_HEIGHT : 420,
            wideH: typeof HUDLAYOUT_WIDE_HEIGHT !== U ? HUDLAYOUT_WIDE_HEIGHT : 540,
            wideW: typeof HUDLAYOUT_WIDE_WIDTH !== U ? HUDLAYOUT_WIDE_WIDTH : 820,
            refresh: typeof HUDLAYOUT_REFRESH_SEC !== U ? HUDLAYOUT_REFRESH_SEC : 0.3,
        };
    },

    /** opts: { root, app, touch: () => bool, manual: true — не подписываться на app.onFrame }. */
    init(opts) {
        const o = opts || {};
        if (this._inited) return this;
        this._inited = true;
        this._root = o.root || (typeof document !== 'undefined' ? document.documentElement : null);
        if (typeof o.touch === 'function') this._touchFn = o.touch;
        this._bind();
        const app = o.app || (typeof window !== 'undefined' ? window.app : null);
        if (app && !o.manual && typeof app.onFrame === 'function') app.onFrame(dt => this.update(dt));
        this.refresh();
        return this;
    },

    /** Снять подписки и переменные (перезапуск игры, тесты). */
    dispose() {
        for (const off of this._unbind) off();
        this._unbind.length = 0;
        if (this._raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._raf);
        this._raf = 0;
        if (this._style && this._style.remove) this._style.remove();
        this._style = null;
        this._inited = false;
        this._subs = [];
    },

    // =====================================================================================
    // Блоки
    // =====================================================================================

    /** Зарегистрировать или обновить блок (поля def — в шапке файла). Повтор с тем же id заменяет только переданные поля. */
    block(id, def) {
        const old = this._defs[id];
        const d = Object.assign(old || { id, seq: ++this._seq, w: 0, h: 0, order: 0 }, def || {});
        d.id = id;
        this._defs[id] = d;
        this._css();
        this.schedule();
        return d;
    },

    /** Убрать блок. */
    remove(id) {
        if (!this._defs[id]) return;
        delete this._defs[id];
        delete this.rects[id];
        this._css();
        this.schedule();
    },

    /** Зарезервировать полосу у края окна: reserve({ bottom: 90 }) — блоки её обходят. Без аргумента — снять. */
    reserve(sides) {
        const s = sides || {};
        this.reserved = { t: s.top || 0, r: s.right || 0, b: s.bottom || 0, l: s.left || 0 };
        this.schedule();
    },

    /** Прямоугольник блока из последней раскладки или null (нет / скрыт). */
    rect(id) { return this.rects[id] || null; },

    /** Подписка на смену раскладки: fn(HudLayout). Возвращает отписку. */
    onChange(fn) {
        this._subs.push(fn);
        return () => { const i = this._subs.indexOf(fn); if (i >= 0) this._subs.splice(i, 1); };
    },

    // =====================================================================================
    // Чистый расчёт (без DOM)
    // =====================================================================================

    /** Режим окна по размеру: 'wide' | 'land' | 'low' | 'tall'. */
    modeFor(W, H, cfg) {
        const c = cfg || this.cfg();
        if (H > W) return 'tall';
        if (H < c.lowH) return 'low';
        return (H <= c.wideH || W <= c.wideW) ? 'land' : 'wide';
    },

    /** Масштаб блоков режима при k = 1 на эталонном окне REF[mode]. */
    scaleFor(mode, W, H, cfg) {
        const c = cfg || this.cfg(), ref = this.REF[mode] || this.REF.wide;
        let k = Math.min(W / ref[0], H / ref[1]);
        if (mode === 'wide') k = Math.max(0.86, Math.min(1.2, k));
        else if (mode === 'land') k = Math.max(0.62, Math.min(1, k));
        else if (mode === 'low') k = Math.max(0.55, Math.min(0.9, k));
        else k = Math.max(0.7, Math.min(1.25, k));
        return Math.max(c.kMin, Math.min(c.kMax, k));
    },

    /**
     * Раскладка. view: { W, H, safe: {t,r,b,l}, touch }. blocks: [{ id, dock, w, h, order, fill, maxW, minW, scale,
     * visible, touchOnly, modes }] — размеры при k = 1. Возвращает { mode, k, rects: {id: {x,y,w,h}}, overflow, free, cols }.
     */
    compute(view, blocks, cfg) {
        const c = cfg || this.cfg();
        const mode = this.modeFor(view.W, view.H, c);
        let k = this.scaleFor(mode, view.W, view.H, c);
        let res = this._layout(view, blocks, mode, k, c);
        for (let guard = 0; res.overflow && k > c.kMin + 1e-6 && guard < 14; guard++) {
            k = Math.max(c.kMin, k * 0.92);
            res = this._layout(view, blocks, mode, k, c);
        }
        res.mode = mode;
        res.k = k;
        return res;
    },

    _dockOf(b, mode) {
        const d = b.dock;
        if (d && typeof d === 'object') return d[mode] || d.default || 'tl';
        return d || 'tl';
    },

    _layout(view, blocks, mode, k, c) {
        const W = view.W, H = view.H, S = view.safe;
        const m = Math.max(4, Math.round(c.margin * k)), g = Math.max(3, Math.round(c.gap * k));
        const L = S.l + m, T = S.t + m, right = W - S.r - m, bottom = H - S.b - m;
        const cx = (L + right) / 2, areaW = Math.max(1, right - L);
        /** @type {Record<string, { x: number, y: number, w: number, h: number, dock: string }>} */
        const rects = {};

        // размеры блока при масштабе k: измеренные ('auto') не масштабируются
        const items = [];
        blocks.forEach((b, i) => {
            if (b.visible === false) return;
            if (b.touchOnly && !view.touch) return;
            if (b.modes && b.modes.indexOf(mode) < 0) return;
            const f = (b.scale === false || b.auto) ? 1 : k;
            const lo = f === 1 ? 1 : (b.min || 1);   // min — нижний предел размера при уменьшении (цель касания не мельче пальца)
            const w = Math.min(areaW, Math.max(lo, Math.round((b.w || 0) * f)));
            const h = Math.max(lo, Math.round((b.h || 0) * f));
            items.push({ b, i, w, h, dock: this._dockOf(b, mode), pri: b.order || 0 });
        });
        const inDock = (dock) => items.filter(it => it.dock === dock).sort((a, z) => (a.b.order || 0) - (z.b.order || 0) || a.i - z.i);
        const put = (it, x, y, w, h) => { rects[it.b.id] = { x, y, w, h, dock: it.dock }; };

        // углы: стопки от угла
        let y = T;
        for (const it of inDock('tl')) { put(it, L, y, it.w, it.h); y += it.h + g; }
        y = T;
        for (const it of inDock('tr')) { put(it, right - it.w, y, it.w, it.h); y += it.h + g; }
        y = bottom;
        for (const it of inDock('bl')) { y -= it.h; put(it, L, y, it.w, it.h); y -= g; }
        y = bottom;
        for (const it of inDock('br')) { y -= it.h; put(it, right - it.w, y, it.w, it.h); y -= g; }

        // центр сверху / снизу: ширина — свободное место между боковыми колонками в полосе блока
        const placed = () => Object.keys(rects).map(id => rects[id]);
        const centerBlock = (it, top, yy) => {
            const pw = it.b.fill ? Math.min(areaW, it.b.maxW ? it.b.maxW * k : areaW) : it.w;
            const minW = Math.min(pw, it.b.minW ? Math.round(it.b.minW * k) : Math.round(pw * 0.5));
            // у блока с авто-высотой ширина зависит от высоты (перенос текста), а высота — от ширины: чтобы не
            // зациклиться, ширину считаем по полосе у его края (одна строка HUD), высоту раскладка потом перемеряет
            const band = it.b.autoH ? Math.min(it.h, Math.max(24, Math.round(40 * k))) : it.h;
            let pos = yy;
            for (let n = 0; n < 16; n++) {
                const y0 = top ? pos : pos - it.h, y1 = top ? y0 + band : pos, ys = top ? y0 : y1 - band;
                let l = L, r = right, straddle = null, lowest = -Infinity, highest = Infinity;
                for (const q of placed()) {
                    if (q.y + q.h <= ys || q.y >= y1) continue;
                    lowest = Math.max(lowest, q.y + q.h); highest = Math.min(highest, q.y);
                    if (q.x + q.w <= cx) l = Math.max(l, q.x + q.w + g);
                    else if (q.x >= cx) r = Math.min(r, q.x - g);
                    else straddle = q;
                }
                const sym = 2 * Math.min(cx - l, r - cx), free = r - l;
                if (!straddle && sym >= minW) { const w = Math.min(pw, Math.round(sym)); return { x: Math.round(cx - w / 2), y: y0, w }; }
                if (!straddle && free >= minW) { const w = Math.min(pw, Math.round(free)); return { x: Math.round(Math.max(l, Math.min(r - w, cx - w / 2))), y: y0, w }; }
                // не помещается рядом с колонками: ниже (выше) самой нижней (верхней) помехи в полосе
                if (top) pos = (straddle ? Math.max(lowest, straddle.y + straddle.h) : lowest) + g;
                else pos = (straddle ? Math.min(highest, straddle.y) : highest) - g;
                if (!isFinite(pos)) break;
            }
            const y0 = top ? pos : pos - it.h;
            return { x: Math.round(cx - minW / 2), y: y0, w: minW };
        };
        y = T;
        for (const it of inDock('tc')) { const p = centerBlock(it, true, y); put(it, p.x, p.y, p.w, it.h); y = p.y + it.h + g; }
        y = bottom;
        for (const it of inDock('bc')) { const p = centerBlock(it, false, y); put(it, p.x, p.y, p.w, it.h); y = p.y - g; }

        // середина краёв: по вертикали между верхней и нижней стопками колонки
        for (const side of ['ml', 'mr']) {
            const col = inDock(side);
            if (!col.length) continue;
            const total = col.reduce((s, it) => s + it.h, 0) + g * (col.length - 1), wmax = col.reduce((s, it) => Math.max(s, it.w), 0);
            const x0 = side === 'ml' ? L : right - wmax;
            let top = T, bot = bottom;
            for (const q of placed()) {
                if (q.x + q.w <= x0 || q.x >= x0 + wmax) continue;
                if (q.y + q.h / 2 < H / 2) top = Math.max(top, q.y + q.h + g); else bot = Math.min(bot, q.y - g);
            }
            let yy = Math.round((top + bot) / 2 - total / 2);
            yy = Math.max(top, Math.min(yy, bot - total));
            for (const it of col) { put(it, side === 'ml' ? L : right - it.w, yy, it.w, it.h); yy += it.h + g; }
        }
        for (const it of inDock('c')) put(it, Math.round(cx - it.w / 2), Math.round((T + bottom) / 2 - it.h / 2), it.w, it.h);

        // пересечения: менее важный блок (больший order) уходит по своей стопке за более важный
        const byPri = items.slice().sort((a, z) => a.pri - z.pri || a.i - z.i);
        const bottomish = (d) => d === 'bl' || d === 'br' || d === 'bc';
        for (let pass = 0; pass < 40; pass++) {
            let moved = false;
            for (let i = 0; i < byPri.length; i++) {
                const a = rects[byPri[i].b.id];
                if (!a) continue;
                for (let j = i + 1; j < byPri.length; j++) {
                    const bb = rects[byPri[j].b.id];
                    if (!bb || !(a.x < bb.x + bb.w && a.x + a.w > bb.x && a.y < bb.y + bb.h && a.y + a.h > bb.y)) continue;
                    bb.y = bottomish(bb.dock) ? a.y - g - bb.h : a.y + a.h + g;
                    moved = true;
                }
            }
            if (!moved) break;
        }

        // итог: переполнение, свободная зона, края колонок
        let overflow = false;
        const ids = Object.keys(rects);
        for (const id of ids) {
            const r = rects[id];
            r.x = Math.round(r.x); r.y = Math.round(r.y);
            if (r.x < S.l || r.y < S.t || r.x + r.w > W - S.r || r.y + r.h > H - S.b) overflow = true;
        }
        for (let i = 0; i < ids.length && !overflow; i++) {
            for (let j = i + 1; j < ids.length; j++) {
                const a = rects[ids[i]], b = rects[ids[j]];
                if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) { overflow = true; break; }
            }
        }
        let fl = L, fr = right, ft = T, fb = bottom, colL = L, colR = right;
        for (const id of ids) {
            const r = rects[id], mid = r.x + r.w / 2;
            if (r.dock === 'tc') ft = Math.max(ft, r.y + r.h + g);
            else if (r.dock === 'bc') fb = Math.min(fb, r.y - g);
            else if (mid < cx) colL = Math.max(colL, r.x + r.w);
            else colR = Math.min(colR, r.x);
        }
        fl = Math.min(cx, colL + (colL > L ? g : 0)); fr = Math.max(cx, colR - (colR < right ? g : 0));
        /** @type {Record<string, { x: number, y: number, w: number, h: number }>} */
        const out = {};
        for (const id of ids) out[id] = { x: rects[id].x, y: rects[id].y, w: rects[id].w, h: rects[id].h };
        return { mode, k, rects: out, overflow, free: { l: fl, t: ft, r: fr, b: Math.max(ft, fb) }, cols: { l: colL, r: colR } };
    },

    // =====================================================================================
    // DOM: измерение, публикация переменных
    // =====================================================================================

    // Безопасные поля (вырезы, жесты): env() читается только из CSS — через пробный элемент.
    insets() {
        const r = this.reserved;
        const base = { t: 0, r: 0, b: 0, l: 0 };
        if (typeof document !== 'undefined' && document.body && typeof getComputedStyle === 'function') {
            let p = this._probe;
            if (!p) {
                p = this._probe = document.createElement('div');
                p.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
                document.body.appendChild(p);
            }
            const cs = getComputedStyle(p);
            base.t = parseFloat(cs.paddingTop) || 0; base.r = parseFloat(cs.paddingRight) || 0;
            base.b = parseFloat(cs.paddingBottom) || 0; base.l = parseFloat(cs.paddingLeft) || 0;
        }
        return { t: base.t + r.t, r: base.r + r.r, b: base.b + r.b, l: base.l + r.l };
    },

    // Размер видимой области: visualViewport точнее (адресная строка телефона), иначе размер документа / окна.
    viewport() {
        const vv = typeof window !== 'undefined' ? window.visualViewport : null;
        const de = typeof document !== 'undefined' ? document.documentElement : null;
        const W = (vv && vv.width) || (de && de.clientWidth) || (typeof window !== 'undefined' && window.innerWidth) || 1;
        const H = (vv && vv.height) || (de && de.clientHeight) || (typeof window !== 'undefined' && window.innerHeight) || 1;
        // ViewCap.js (десктоп, Playgama): на ультрашироком окне игра занимает поле не шире 2:1 — раскладка по нему
        const cap = typeof ViewCap !== 'undefined' && ViewCap.on ? ViewCap.width() : W;
        return { W: Math.max(1, Math.round(Math.min(W, cap))), H: Math.max(1, Math.round(H)) };
    },

    _isTouch() {
        if (this._touchFn) { try { return !!this._touchFn(); } catch (e) { return false; } }
        // mouseTouch (Playables на ПК): стик и кнопка Input видны всегда — им нужно место, как на телефоне
        if (typeof Input !== 'undefined' && Input._inited) return !!(Input.mouseTouch || (Input.touchSeen && Input.device === 'touch'));
        return typeof IS_MOBILE !== 'undefined' && !!IS_MOBILE;
    },

    _el(d) {
        let el = d.el;
        if (typeof el === 'string') el = typeof document !== 'undefined' ? document.querySelector(el) : null;
        if (el && el.setAttribute && el.getAttribute('data-hl') !== d.id) el.setAttribute('data-hl', d.id);
        return el || null;
    },

    _shown(el) {
        if (!el || el.isConnected === false || el.hidden) return false;
        if (typeof getComputedStyle === 'function' && getComputedStyle(el).display === 'none') return false;
        return typeof el.getClientRects === 'function' ? el.getClientRects().length > 0 : true;
    },

    // Блоки в виде для compute: видимость и фактические размеры 'auto' читаются из DOM.
    _blocks() {
        return Object.keys(this._defs).map(id => {
            const d = this._defs[id], el = this._el(d);
            let visible = true;
            if (typeof d.visible === 'function') { try { visible = !!d.visible(); } catch (e) { visible = false; } }
            else if (d.visible !== undefined) visible = !!d.visible;
            else if (d.el) visible = this._shown(el);
            const auto = d.w === 'auto' || d.h === 'auto';
            let w = d.w, h = d.h;
            if (auto) {
                const ew = el ? el.offsetWidth || 0 : 0, eh = el ? el.offsetHeight || 0 : 0;
                if (d.w === 'auto') w = ew || d.minW || 0;
                if (d.h === 'auto') h = eh || 0;
                if (visible && (!w || !h)) visible = false;
            }
            return { id, seq: d.seq, dock: d.dock, w, h, order: d.order || 0, fill: d.fill, maxW: d.maxW, minW: d.minW, min: d.min,
                scale: d.scale, auto, autoH: d.h === 'auto', el, visible, touchOnly: d.touchOnly, modes: d.modes };
        }).sort((a, z) => a.seq - z.seq);
    },

    /** Пересчёт и запись сейчас. */
    refresh() {
        this.apply();
    },

    /** Отложить пересчёт до кадра (много block()/событий подряд — один пересчёт). */
    schedule() {
        if (!this._inited) return;
        if (typeof requestAnimationFrame !== 'function') { this.apply(); return; }
        if (this._raf) return;
        this._raf = requestAnimationFrame(() => { this._raf = 0; this.apply(); });
    },

    /** Каждый кадр (app.onFrame зовёт сам): раз в HUDLAYOUT_REFRESH_SEC — пересчёт по содержимому. */
    update(dt) {
        this._t -= dt;
        if (this._t > 0) return;
        this._t = this.cfg().refresh;
        this.apply();
    },

    apply() {
        const c = this.cfg();
        const vp = this.viewport(), safe = this.insets(), touch = this._isTouch();
        const view = { W: vp.W, H: vp.H, safe, touch };
        const blocks = this._blocks();
        let res = this.compute(view, blocks, c);
        // Блоки с авто-высотой: ширину им даёт раскладка (по верхней полосе), а высота зависит от ширины (текст
        // переносится). Пишем раскладку, перемеряем высоту и пересчитываем: ширина от высоты не зависит — хватает прохода.
        for (let pass = 0; pass < 2 && blocks.some(b => b.autoH && b.visible); pass++) {
            this._publish(res, vp, safe, touch, c, false);
            let changed = false;
            for (const b of blocks) {
                const el = b.autoH && b.visible && res.rects[b.id] ? b.el : null;
                const h = el ? el.offsetHeight || 0 : 0;
                if (h && Math.abs(h - b.h) > 1) { b.h = h; changed = true; }
            }
            if (!changed) break;
            res = this.compute(view, blocks, c);
        }
        this._publish(res, vp, safe, touch, c, true);
    },

    // Записать результат: состояние модуля, переменные на корне (только изменившиеся), классы, подписчики.
    _publish(res, vp, safe, touch, c, notify) {
        const root = this._root;
        this.W = vp.W; this.H = vp.H; this.safe = safe; this.touch = touch;
        this.mode = res.mode; this.k = res.k; this.rects = res.rects; this.overflow = res.overflow;
        this.free = res.free; this.cols = res.cols;

        /** @type {Record<string, string>} */
        const V = {};
        const px = (n) => Math.round(n) + 'px';
        V['--hl-w'] = px(vp.W); V['--hl-h'] = px(vp.H); V['--hl-k'] = String(+res.k.toFixed(3));
        V['--hl-m'] = px(Math.max(4, c.margin * res.k)); V['--hl-gap'] = px(Math.max(3, c.gap * res.k));
        V['--hl-safe-t'] = px(safe.t); V['--hl-safe-r'] = px(safe.r); V['--hl-safe-b'] = px(safe.b); V['--hl-safe-l'] = px(safe.l);
        V['--hl-fs'] = px(Math.max(11, 16 * res.k));
        V['--hl-btn'] = px(Math.max(touch ? 40 : 28, 44 * res.k));
        for (const id of Object.keys(res.rects)) {
            const r = res.rects[id], n = '--hl-' + String(id).replace(/[^A-Za-z0-9_-]/g, '-');
            V[n + '-x'] = px(r.x); V[n + '-y'] = px(r.y); V[n + '-w'] = px(r.w); V[n + '-h'] = px(r.h);
            V[n + '-r'] = px(vp.W - r.x - r.w); V[n + '-b'] = px(vp.H - r.y - r.h);
        }
        let changed = false;
        for (const key of Object.keys(V)) {
            if (this._vars[key] === V[key]) continue;
            this._vars[key] = V[key];
            changed = true;
            if (root && root.style) root.style.setProperty(key, V[key]);
        }
        if (root && root.classList) {
            for (const m of ['wide', 'land', 'low', 'tall']) root.classList.toggle('hl-' + m, m === res.mode);
            root.classList.toggle('hl-touch', touch);
            root.classList.toggle('hl-overflow', res.overflow);
        }
        if (changed) this._dirty = true;
        if (notify && this._dirty) {
            this._dirty = false;
            for (const fn of this._subs.slice()) { try { fn(this); } catch (e) { console.error('HudLayout.onChange:', e); } }
        }
    },

    // Правила для элементов data-hl="id": position:fixed + переменные блока. Размер 'auto' не задаётся.
    _css() {
        if (typeof document === 'undefined' || !document.head) return;
        let st = this._style;
        if (!st) {
            st = this._style = /** @type {HTMLStyleElement} */ (document.createElement('style'));
            st.id = 'lory-hudlayout-css';
            document.head.appendChild(st);
        }
        const rules = [];
        for (const id of Object.keys(this._defs)) {
            const d = this._defs[id], n = '--hl-' + String(id).replace(/[^A-Za-z0-9_-]/g, '-');
            rules.push('[data-hl="' + String(id).replace(/"/g, '') + '"]{position:fixed;box-sizing:border-box;left:var(' + n + '-x);top:var(' + n + '-y);' +
                (d.w === 'auto' ? '' : 'width:var(' + n + '-w);') + (d.h === 'auto' ? '' : 'height:var(' + n + '-h);') + '}');
        }
        st.textContent = rules.join('\n');
    },

    _bind() {
        if (typeof window === 'undefined') return;
        const on = (t, type, fn) => {
            if (!t || !t.addEventListener) return;
            t.addEventListener(type, fn);
            this._unbind.push(() => t.removeEventListener(type, fn));
        };
        const now = () => this.schedule();
        on(window, 'resize', now);
        on(window, 'orientationchange', () => { now(); if (typeof setTimeout === 'function') setTimeout(() => this.schedule(), 250); });
        on(window, 'lory-input-device', now);
        if (typeof document !== 'undefined') on(document, 'fullscreenchange', now);
        if (window.visualViewport) on(window.visualViewport, 'resize', now);
    },
};
