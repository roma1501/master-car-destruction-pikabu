// ViewCap.js — поле игры на десктопе не шире 2:1. На ультрашироком или очень низком окне поле стоит по
// центру, по бокам — фон, а не растянутая полоса (требование Playgama). На телефонах и планшетах не
// действует — там игра на весь экран.
//
// КАК. Класс vcap на <html> сужает <body> до H × VIEWCAP_RATIO по центру; transform на body делает его
// опорным блоком для position: fixed, поэтому холст, HUD, экран загрузки и плашки движка ужимаются вместе
// с ним — игре ничего менять не нужно. CSS модуль вписывает сам (<style id="lory-viewcap-css">); цвет полос —
// переменная --vcap-bg на <html> (по умолчанию чёрный).
//
// КОГДА. VIEWCAP_MODE (Constants.js): 0 — выключен; 1 — по умолчанию только сборка playgama (GAME_PLATFORM);
// 2 — на любой площадке. VIEWCAP_RATIO — наибольшая ширина / высота поля (по умолчанию 2). Игра может переопределить:
// ViewCap.override = true | false (null — по константам), затем ViewCap.apply().
//
// КООРДИНАТЫ. Всё, что рисуется внутри поля (HUD, слои, указатели обучения), стоит в координатах ПОЛЯ:
// position: fixed считается от body. Всё, что приходит из окна (clientX события, getBoundingClientRect элемента),
// переводится так:
//   ViewCap.width()       ширина поля игры, px (без сужения — innerWidth)
//   ViewCap.x(clientX)    x окна -> x поля;  ViewCap.toWindowX(x) — обратно
//   ViewCap.contains(cx)  clientX внутри поля (нажатия на боковых полосах игра не получает)
//   ViewCap.on / left     поле сужено / px окна слева от поля
// Подключены: HudLayout (размер окна — ширина поля), Input (стик, зона стика, тапы, нажатия вне поля), Tutorial
// (указатели). Своему коду игры, который ставит элементы по clientX, — ViewCap.x(). 100vw в CSS игры — это
// ширина ОКНА, а не поля: брать 100% родителя или var(--vcap-w). Событие window 'lory-viewcap' ({ detail: { on, left, width } })
// — поле сменилось (кроме resize, который уже идёт).
// Скрипт идёт сразу после Constants.js: обработчик resize ставится раньше обработчиков движка.

/** @satisfies {Record<string, any>} */
const ViewCap = {
    on: false,                      // поле сужено прямо сейчас
    left: 0,                        // px окна слева от поля
    w: 0,                           // ширина поля, px
    override: /** @type {boolean | null} */ (null),   // true / false — вместо VIEWCAP_MODE; null — по константам
    _css: false,

    cfg() {
        const U = 'undefined';
        return {
            mode: typeof VIEWCAP_MODE !== U ? Number(VIEWCAP_MODE) : 1,
            ratio: typeof VIEWCAP_RATIO !== U && Number(VIEWCAP_RATIO) > 0 ? Number(VIEWCAP_RATIO) : 2,
        };
    },

    // Включён ли модуль настройками: override, иначе VIEWCAP_MODE (1 — только playgama).
    enabled() {
        if (this.override !== null) return !!this.override;
        const mode = this.cfg().mode;
        if (mode >= 2) return true;
        if (mode === 1) return typeof GAME_PLATFORM !== 'undefined' && String(GAME_PLATFORM) === 'playgama';
        return false;
    },

    _style() {
        if (this._css || typeof document === 'undefined' || !document.head || typeof document.createElement !== 'function') return;
        this._css = true;
        try {
            const st = document.createElement('style');
            st.id = 'lory-viewcap-css';
            st.textContent = 'html.vcap{background:var(--vcap-bg,#000)}' +
                'html.vcap body{width:var(--vcap-w);margin:0 auto;position:relative;transform:translateZ(0)}';
            document.head.appendChild(st);
        } catch (e) { /* без стилей поле не сужается, игра работает как раньше */ }
    },

    // Пересчитать по окну (resize ставит сам; звать после смены override / констант).
    apply() {
        if (typeof window === 'undefined') return;
        const W = window.innerWidth || 1, H = window.innerHeight || 1;
        const mobile = typeof IS_MOBILE !== 'undefined' && !!IS_MOBILE;
        const on = this.enabled() && !mobile && W > H * this.cfg().ratio + 2;
        const w = on ? Math.round(H * this.cfg().ratio) : W;
        const left = on ? Math.floor((W - w) / 2) : 0;
        const changed = on !== this.on || (on && (w !== this.w || left !== this.left));   // без сужения ширина окна не событие
        this.on = on; this.w = w; this.left = left;
        if (!changed) return;
        if (on) this._style();
        try {
            const de = document.documentElement;
            de.classList.toggle('vcap', on);
            de.style.setProperty('--vcap-w', w + 'px');
        } catch (e) { /* без DOM (тесты) */ }
        try {
            if (typeof Event === 'function' && window.dispatchEvent) {
                const ev = /** @type {any} */ (new Event('lory-viewcap'));
                ev.detail = { on, left, width: w };
                window.dispatchEvent(ev);
            }
        } catch (e) { /* событие не обязательно */ }
    },

    // Ширина поля игры, px.
    width() { return this.on ? this.w : ((typeof window !== 'undefined' && window.innerWidth) || 1); },

    // x окна (clientX, rect.left) -> x внутри поля.
    x(v) { return this.on ? v - this.left : v; },

    // x поля -> x окна.
    toWindowX(v) { return this.on ? v + this.left : v; },

    // clientX внутри поля (без сужения — всегда да).
    contains(clientX) { return !this.on || (clientX >= this.left && clientX <= this.left + this.w); },
};

ViewCap.apply();
if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('resize', () => ViewCap.apply());
