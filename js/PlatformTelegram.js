// PlatformTelegram.js — адаптер Telegram Mini App (глобал Telegram.WebApp) для Platform.js (name 'telegram').
// Подключается ПОСЛЕ Platform.js; регистрирует себя сам (Platform.register). Скрипт telegram-web-app.js
// вписывает сборка build.bat telegram ПЕРВЫМ скриптом страницы (единственный внешний ресурс; в исходниках
// его нет) и кладёт рядом с index.html картинку orientation-warning.png и _headers (запрет кэша страницы).
//
//   init       ready() и expand() сразу; вертикальные свайпы выключены (Bot API 7.7+); цвет шапки и фона —
//              TELEGRAM_BG_COLOR (6.1+). viewportChanged -> resize игры (World3D.resize слушает window resize);
//              safeAreaChanged / contentSafeAreaChanged -> то же. Приложение свёрнуто (deactivated, 8.0+) -> Pause
//              'platform', вернулось (activated) -> снята; на клиентах старше 8.0 то же делает автопауза Pause.js.
//   safe area  CSS-переменные --lory-safe-top|right|bottom|left (px): большее из env(safe-area-inset-*) и
//              --tg-safe-area-inset-* + --tg-content-safe-area-inset-* (Telegram 8.0+). HUD игры: padding:
//              var(--lory-safe-top, 0px). Холст #world3d и так занимает весь экран (index.html: inset 0).
//   реклама    нет: supports('interstitial' | 'rewarded') = false — игра прячет предложения «за рекламу»,
//              Platform.ads.next идёт без рекламы. Платежей, входа и данных пользователя адаптер не трогает.
//   сохранения только локально (Store по GAME_ID.save) — как у local; облако Telegram не используется.
//   язык       languageChoice: по умолчанию английский, игрок может выбрать русский (Platform.langSwitch +
//              Platform.setLanguage — переключатель в настройках игры; без галочки — English). Выбор хранится в
//              Store и применяется без перезапуска. Сборка ставит LANG_AUTO = 1.
//   ориентация TELEGRAM_LANDSCAPE_ONLY = 1: пока высота окна больше ширины, поверх страницы — картинка
//              orientation-warning.png (Rotate your device / The game only works in landscape mode), весь ввод
//              заблокирован, игра и звук на паузе (Pause 'orient'). Проверка: при старте, resize, orientationchange,
//              visualViewport.resize и viewportChanged. Игры без ограничения — TELEGRAM_LANDSCAPE_ONLY = 0.

/** @satisfies {Record<string, any>} */
const PlatformTelegram = {
    languageChoice: true,
    DEFAULT_LANG: 'en',                     // язык при первом запуске
    IMAGE: 'orientation-warning.png',       // картинка рядом с index.html (кладёт сборка telegram)
    BLOCKED_EVENTS: ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup', 'click', 'dblclick',
        'contextmenu', 'keydown', 'keyup', 'keypress', 'wheel', 'touchstart', 'touchmove', 'touchend'],

    /** @type {HTMLElement | null} */
    _lock: null,            // плашка ориентации
    _locked: false,         // сейчас портрет и ввод заблокирован
    _resizeQueued: false,

    detect: () => typeof Telegram !== 'undefined' && !!Telegram && !!Telegram.WebApp,

    async init(P) {
        const tg = Telegram.WebApp;
        P.sdk = tg;
        P.lang = this.DEFAULT_LANG;   // выбор игрока ядро наложит после init (languageChoice)
        const at = (version) => { try { return !!tg.isVersionAtLeast && !!tg.isVersionAtLeast(version); } catch (e) { return false; } };
        const safe = (fn, what) => { try { fn(); } catch (e) { console.warn('Telegram.' + what + ':', (e && e.message) || e); } };
        // События — ДО чтения начального состояния. Старые клиенты неизвестные события просто не шлют.
        const on = (name, fn) => safe(() => tg.onEvent(name, fn), 'onEvent ' + name);
        on('viewportChanged', () => this._resized());
        on('safeAreaChanged', () => this._resized());
        on('contentSafeAreaChanged', () => this._resized());
        on('deactivated', () => Pause.set('platform', true));
        on('activated', () => Pause.set('platform', false));
        if (tg.isActive === false) Pause.set('platform', true);

        safe(() => tg.ready(), 'ready');
        safe(() => tg.expand(), 'expand');
        if (at('7.7') && typeof tg.disableVerticalSwipes === 'function') safe(() => tg.disableVerticalSwipes(), 'disableVerticalSwipes');
        if (at('6.1')) {
            const color = this._color();
            safe(() => { tg.setHeaderColor(color); tg.setBackgroundColor(color); }, 'setHeaderColor');
        }
        this._safeVars();
        if ((typeof TELEGRAM_LANDSCAPE_ONLY !== 'undefined' ? TELEGRAM_LANDSCAPE_ONLY : 1) > 0) this._orientInit();
    },

    // TELEGRAM_BG_COLOR (0xRRGGBB) -> '#rrggbb'.
    _color() {
        const n = typeof TELEGRAM_BG_COLOR !== 'undefined' ? Number(TELEGRAM_BG_COLOR) : 0x101c22;
        return '#' + ((n >>> 0) & 0xffffff).toString(16).padStart(6, '0');
    },

    // --lory-safe-*: отступы безопасной зоны для HUD (системные вырезы + панель Telegram).
    _safeVars() {
        try {
            const style = document.documentElement.style;
            for (const side of ['top', 'right', 'bottom', 'left']) {
                style.setProperty('--lory-safe-' + side, 'max(env(safe-area-inset-' + side + ', 0px), calc(var(--tg-safe-area-inset-' + side +
                    ', 0px) + var(--tg-content-safe-area-inset-' + side + ', 0px)))');
            }
        } catch (e) { /* без DOM */ }
    },

    // Окно Telegram изменилось: resize игры (не чаще раза в кадр — viewportChanged идёт потоком) и ориентация.
    _resized() {
        if (this._resizeQueued) return;
        this._resizeQueued = true;
        const later = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
        later(() => {
            this._resizeQueued = false;
            try { window.dispatchEvent(new Event('resize')); } catch (e) { /* без window */ }
            this._orient();
        });
    },

    // --- Ориентация ---------------------------------------------------------------------

    _orientInit() {
        if (this._lock) return;
        const el = document.createElement('div');
        el.id = 'orient-lock';
        el.setAttribute('role', 'alert');
        el.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:none;touch-action:none;pointer-events:auto;' +
            'background:#2c2c2c url(' + this.IMAGE + ') center/cover no-repeat;';
        (document.body || document.documentElement).appendChild(el);
        this._lock = el;
        // Ввод до игры не доходит, пока плашка видна: перехват на window в фазе capture (как плашка паузы платформы).
        const block = (e) => {
            if (!this._locked) return;
            if (e.cancelable !== false) e.preventDefault();
            e.stopImmediatePropagation();
        };
        for (const type of this.BLOCKED_EVENTS) window.addEventListener(type, block, { capture: true, passive: false });
        const check = () => this._orient();
        window.addEventListener('resize', check);
        window.addEventListener('orientationchange', () => { check(); setTimeout(check, 250); });
        if (window.visualViewport) window.visualViewport.addEventListener('resize', check);
        check();
    },

    // Портрет = высота больше ширины (видимая область Telegram, а не экран).
    _orient() {
        const el = this._lock;
        if (!el) return;
        const vv = window.visualViewport;
        const w = vv && vv.width ? vv.width : window.innerWidth;
        const h = vv && vv.height ? vv.height : window.innerHeight;
        const portrait = h > w;
        if (portrait === this._locked) return;
        this._locked = portrait;
        el.style.display = portrait ? 'block' : 'none';
        try { el.setAttribute('aria-label', Lang.t('orientTitle') + '. ' + Lang.t('orientHint')); } catch (e) { /* без Lang */ }
        if (portrait) window.dispatchEvent(new Event('lory-release-input'));   // зажатые касания и клавиши не залипнут
        Pause.set('orient', portrait);
    },

    // --- Реклама: у Mini App её нет ------------------------------------------------------

    supports: (kind) => kind !== 'interstitial' && kind !== 'rewarded' && kind !== 'analytics',

    // --- Сохранения: только Store ----------------------------------------------------------

    async load(P) { return Store.getJSON(P._storeKey(), null); },
    async save(data, json, obj, P) { return Store.set(P._storeKey(), json); },
};

Platform.register('telegram', PlatformTelegram);
