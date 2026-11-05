// Pause.js — пауза игры по причинам. Игра стоит, пока есть хоть одна причина:
//   'auto'     — вкладка скрыта или окно без фокуса (ставит и снимает сам Pause);
//   'manual'   — кнопка паузы игрока;
//   'ad'       — идёт реклама: interstitial всегда, rewarded — только при ADS_REWARDED_PAUSE = 1 (по умолчанию rewarded
//                игру не останавливает: молчит только её звук, Sound.setAdMuted; идёт ли реклама — Platform.adActive);
//   'platform' — пауза от платформы (Яндекс game_api_pause, Playables onPause, Telegram deactivated);
//   'adwait'   — реклама запрашивается (CrazyGames): игра стоит, звук играет; с началом ролика — 'ad';
//   'orient'   — Telegram: портретная ориентация, поверх страницы картинка «Поверните устройство»;
//   свои причины игры — любая строка.
// Снятие одной причины не снимает другие: вернулись на вкладку — снята только
// 'auto', ручная и рекламная пауза остаются. Звук молчит на любой паузе (Sound.js).
// main.js не зовёт Game.update и location.update на паузе, но кадр рисует (иначе
// в канвасе мусор: preserveDrawingBuffer false).
// При автопаузе — событие window 'lory-release-input': игра сбрасывает зажатые
// клавиши и касания, чтобы движение не залипло.
// Пауза платформы с platformOverlay = true (Playables; адаптер Platform.js с pauseOverlay): поверх игры
// плашка «Пауза» (Lang platformPaused) БЕЗ кнопки продолжения, весь ввод — игра, HUD, кнопки меню —
// заблокирован. Плашка уходит только по снятию причины 'platform', то есть по resume SDK.
// Своя реклама игры (Platform._showAd): SDK на время ролика тоже шлёт паузу площадки, а «Пауза» поверх ролика не нужна.
// Пока реклама на экране (причины 'ad' / 'adwait' или флаг Pause.adState(true) — его ставит Platform, в том числе на
// rewarded БЕЗ паузы игры) плашки нет: игра стоит по паузе SDK, ввод заблокирован, но «Пауза» не рисуется. После рекламы
// плашка появляется, только если пауза площадки держится ещё дольше PAUSE_AD_GRACE_MS (Constants.js): resume SDK приходит чуть
// позже конца ролика, и без отсрочки «Пауза» мигнула бы между роликом и игрой.

/** @satisfies {Record<string, any>} */
const Pause = {
    reasons: new Set(),
    _listeners: [],
    _hidden: false,
    _blurred: false,
    _inited: false,
    platformOverlay: false,   // true — плашка «Пауза» и блок ввода на паузе 'platform' (ставит адаптер площадки)
    /** @type {HTMLElement | null} */
    _overlay: null,
    adOverlayGraceMs: /** @type {number | null} */ (null),   // null — PAUSE_AD_GRACE_MS (Constants.js); число — своё (игра, тесты); 0 — без отсрочки
    _adFlag: false,           // реклама на экране по данным Platform (в том числе rewarded без паузы игры)
    _adLive: false,           // последнее вычисленное «реклама на экране» (флаг или причина 'ad' / 'adwait')
    /** @type {any} */
    _adTimer: 0,              // отсрочка плашки после рекламы

    get active() { return this.reasons.size > 0; },

    has(reason) { return this.reasons.has(reason); },

    // Поставить (on = true) или снять причину паузы.
    set(reason, on) {
        const had = this.reasons.has(reason);
        if (!!on === had) return;
        if (on) this.reasons.add(reason); else this.reasons.delete(reason);
        if (reason === 'ad' || reason === 'adwait') this._adTrack();
        if (reason === 'platform' || reason === 'ad' || reason === 'adwait') this._syncOverlay();
        if (on && (reason === 'auto' || reason === 'platform')) window.dispatchEvent(new Event('lory-release-input'));
        for (const fn of this._listeners) {
            try { fn(this.active, reason, !!on); } catch (e) { console.error('Pause listener:', e); }
        }
    },

    // --- Реклама и плашка ---------------------------------------------------------------

    // Отсрочка плашки после рекламы, мс.
    adGraceMs() {
        if (this.adOverlayGraceMs !== null && this.adOverlayGraceMs !== undefined) return Math.max(0, Number(this.adOverlayGraceMs) || 0);
        return Math.max(0, Number(typeof PAUSE_AD_GRACE_MS !== 'undefined' ? PAUSE_AD_GRACE_MS : 700) || 0);
    },

    // Реклама на экране: флаг от Platform (rewarded без паузы игры причины 'ad' не ставит) или своя причина паузы.
    _adNow() { return this._adFlag || this.reasons.has('ad') || this.reasons.has('adwait'); },

    // Зовёт Platform._showAd: реклама началась (on = true) / закончилась. Сама паузу не ставит.
    adState(on) {
        this._adFlag = !!on;
        this._adTrack();
        this._syncOverlay();
    },

    // Реклама только что кончилась — запустить отсрочку плашки; началась — отменить.
    _adTrack() {
        const live = this._adNow();
        if (live === this._adLive) return;
        this._adLive = live;
        if (this._adTimer) { clearTimeout(this._adTimer); this._adTimer = 0; }
        if (live) return;
        const ms = this.adGraceMs();
        if (!(ms > 0) || typeof setTimeout !== 'function') return;
        this._adTimer = setTimeout(() => { this._adTimer = 0; this._syncOverlay(); }, ms);
        if (this._adTimer && typeof this._adTimer.unref === 'function') this._adTimer.unref();   // Node (тесты): таймер не держит процесс
    },

    // Плашка паузы платформы: есть, пока причина 'platform' стоит и включён platformOverlay — кроме времени рекламы
    // и отсрочки после неё (см. шапку). Без DOM — тишина.
    _syncOverlay() {
        const want = this.platformOverlay && this.reasons.has('platform') && !this._adLive && !this._adTimer;
        try {
            if (!want) {
                if (this._overlay) { this._overlay.remove(); this._overlay = null; }
                return;
            }
            if (this._overlay || typeof document.createElement !== 'function' || !document.body) return;
            const el = document.createElement('div');
            el.id = 'platform-pause';
            el.setAttribute('role', 'status');
            el.setAttribute('aria-live', 'assertive');
            el.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;' +
                'background:rgba(0,0,0,.72);color:#fff;font:700 clamp(28px,7vw,56px) system-ui,sans-serif;text-align:center;' +
                'touch-action:none;user-select:none;-webkit-user-select:none;cursor:default';
            el.textContent = typeof Lang !== 'undefined' ? Lang.t('platformPaused') : 'Paused';
            document.body.appendChild(el);
            this._overlay = el;
        } catch (e) { console.warn('Pause overlay:', e); }
    },

    toggle(reason) { this.set(reason, !this.reasons.has(reason)); },

    // fn(active, reason, on) — после каждой смены причины.
    onChange(fn) { this._listeners.push(fn); return () => { const i = this._listeners.indexOf(fn); if (i >= 0) this._listeners.splice(i, 1); }; },

    // Автопауза: скрытая вкладка или потеря фокуса окна. Фокус при старте не
    // проверяется: в iframe платформы его нет до первого касания, игра стояла бы.
    init() {
        if (this._inited) return;
        this._inited = true;
        const playables = typeof ytgame !== 'undefined' && ytgame.IN_PLAYABLES_ENV;
        if (playables) this.platformOverlay = true;
        // Пауза платформы с плашкой: ввод не доходит ни до игры, ни до HUD и кнопок меню. Перехват на window
        // в фазе capture — раньше любых обработчиков игры; Escape остаётся хозяину (Playables).
        const block = e => {
            if (this.platformOverlay && this.has('platform')) {
                if (e.key !== 'Escape' && e.code !== 'Escape') e.preventDefault();
                e.stopImmediatePropagation();
            }
        };
        for (const type of ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'contextmenu',
            'keydown', 'keyup', 'keypress', 'wheel', 'touchstart', 'touchmove', 'touchend']) {
            window.addEventListener(type, block, { capture: true, passive: false });
        }
        // Playables owns lifecycle. Browser focus/visibility must not resume or pause it.
        if (playables) return;
        const sync = () => this.set('auto', this._hidden || this._blurred);
        document.addEventListener('visibilitychange', () => {
            this._hidden = document.hidden;
            if (!this._hidden) this._blurred = false;   // мобильные возвращают вкладку без focus
            sync();
        });
        window.addEventListener('blur', () => { this._blurred = true; sync(); });
        window.addEventListener('focus', () => { this._blurred = false; sync(); });
        window.addEventListener('pointerdown', () => { if (this._blurred) { this._blurred = false; sync(); } }, true);
        window.addEventListener('pagehide', () => { this._hidden = true; sync(); });
        window.addEventListener('pageshow', () => { this._hidden = document.hidden; sync(); });
    },
};
