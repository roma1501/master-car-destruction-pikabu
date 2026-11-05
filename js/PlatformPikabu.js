// PlatformPikabu.js — адаптер SDK Пикабу Игры (глобал PkbSDK) для Platform.js (name 'pikabu').
// Подключается ПОСЛЕ Platform.js; регистрирует себя сам (Platform.register). SDK вписывает сборка build.bat pikabu
// первым скриптом страницы (единственный внешний ресурс; в исходниках его нет). Сверено с документацией
// SDK Пикабу Игры (Подключение, Реклама, Облачные сохранения, Игрок, События — 2026-10).
//
//   init       await PkbSDK.init() один раз; вне площадки SDK не работает: отказ или таймаут — игра идёт локально.
//   ready      sdk.gameStarted() — один раз, после снятия экрана загрузки (Platform.ready). Preloader-реклама не используется.
//   ads        fullscreen и rewarded: перед КАЖДЫМ показом canShow(), затем show(). Требование площадки — при рекламе игра
//              стоит, поэтому rewarded тоже ставит паузу 'ad' (rewardedNoPause: false). Награда — только reward: true.
//              Fullscreen уходит по правилу двух раундов (Platform.ads.next), интервал 120 с держит сам SDK (canShow -> false).
//              Блокировщик: canShow() -> false; проверка раз в REWARDED_POLL мс (после gameStarted: раньше площадка
//              всегда отвечает false) прячет кнопки «за рекламу» (supports, событие 'lory-rewarded-change').
//   storage    sdk.storage, один ключ 'save': методы синхронные, сервер SDK догоняет сам с небольшой задержкой (лимит
//              200 КБ, 100 запросов за 5 минут — поэтому flush не зовём). Ошибка REVISION_CONFLICT (игра открыта во второй
//              вкладке или на другом устройстве) — событие окна 'lory-save-conflict' (cancelable): игра со своим окном
//              отменяет его, иначе адаптер сам ставит паузу и показывает окно «Перезагрузить».
//   аккаунт    sdk.player.isAuthorized, sdk.auth.openAuthDialog() (на время окна — пауза 'platform'). Вход с уже имеющимися
//              данными SDK сам перезагружает игру; гостевые данные переносит сам.
// Лидерборда у площадки нет. Покупки и проверка подписи (секретный ключ) не используются: в игре нет покупок.

/** @satisfies {Record<string, any>} */
const PlatformPikabu = {
    SAVE_KEY: 'save',              // ключ sdk.storage: вся игра одним значением
    INIT_TIMEOUT: 15000,           // мс: PkbSDK.init не ответил -> локальный режим
    CAN_SHOW_TIMEOUT: 4000,        // мс: canShow не ответил -> показа не будет
    AD_OPEN_TIMEOUT: 180000,       // мс: show не вернулся -> считаем, что рекламы нет, игра идёт дальше
    REWARDED_POLL: 20000,          // мс: как часто проверять, доступна ли rewarded (кнопки «за рекламу»)
    rewardedNoPause: false,        // при рекламе игра стоит (Реклама: «Всегда ставьте игру на паузу»)

    /** @type {any} */
    _sdk: null,
    _rewardedOk: true,             // последняя проверка canShow: false — кнопки «за рекламу» скрыты

    detect: () => typeof PkbSDK !== 'undefined' && !!PkbSDK && typeof PkbSDK.init === 'function',

    // Промис с отказом по таймауту; поздний ответ исходного промиса не станет unhandled.
    _limit(promise, ms, what) {
        let timer = 0;
        const source = Promise.resolve(promise);
        source.catch(() => {});
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(what + ' timeout')), ms); });
        return Promise.race([source, timeout]).finally(() => clearTimeout(timer));
    },

    async init(P) {
        const sdk = await this._limit(PkbSDK.init(), this.INIT_TIMEOUT, 'PkbSDK.init');
        this._sdk = sdk;
        P.sdk = sdk;
        sdk.on('storageSaveError', (reason) => {
            console.warn('Pikabu: сохранение не удалось:', reason);
            if (reason !== 'REVISION_CONFLICT') return;
            // Игра со своим окном отменяет событие (preventDefault); иначе адаптер показывает простое окно сам.
            const ev = new Event('lory-save-conflict', { cancelable: true });
            if (window.dispatchEvent(ev) && !ev.defaultPrevented) this._conflictNotice();
        });
    },

    // Сохранения больше не пишутся (игра открыта во второй вкладке или на другом устройстве): игра на паузе, только перезагрузка.
    _conflictShown: false,
    _conflictNotice() {
        if (this._conflictShown) return;
        this._conflictShown = true;
        try { Pause.set('platform', true); } catch (e) { /* без паузы окно всё равно покажется */ }
        try {
            const box = document.createElement('div');
            box.id = 'pkb-conflict';
            box.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;'
                + 'background:rgba(0,0,0,.72);font:600 18px/1.35 system-ui,Arial,sans-serif;color:#fff;text-align:center';
            const card = document.createElement('div');
            card.style.cssText = 'max-width:min(420px,86vw);padding:24px 22px;border-radius:16px;background:#20232b;box-shadow:0 10px 40px rgba(0,0,0,.5)';
            const title = document.createElement('div');
            title.style.cssText = 'font-size:22px;margin-bottom:10px';
            title.textContent = 'Игра открыта ещё где-то';
            const text = document.createElement('div');
            text.style.cssText = 'font-weight:400;font-size:16px;opacity:.85;margin-bottom:18px';
            text.textContent = 'Прогресс изменился на другом устройстве или в другой вкладке. Перезагрузите игру, чтобы продолжить сохраняться.';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.style.cssText = 'padding:12px 28px;border:0;border-radius:10px;background:#4caf50;color:#fff;font:700 18px system-ui,Arial,sans-serif;cursor:pointer';
            btn.textContent = 'Перезагрузить';
            btn.addEventListener('click', () => location.reload());
            card.appendChild(title); card.appendChild(text); card.appendChild(btn); box.appendChild(card);
            document.body.appendChild(box);
        } catch (e) { console.warn('Pikabu: окно конфликта сохранений не показано:', e); }
    },

    // --- Жизненный цикл ------------------------------------------------------------

    // До gameStarted площадка отвечает на canShow() false — проверять рекламу можно только после него.
    ready(P) {
        this._sdk.gameStarted();
        this._checkRewarded();
        const poll = setInterval(() => { if (!P._adBusy) this._checkRewarded(); }, this.REWARDED_POLL);
        if (/** @type {any} */ (poll).unref) /** @type {any} */ (poll).unref();   // тесты в node: таймер не держит процесс
    },

    // --- Реклама ----------------------------------------------------------------------

    _ads(kind) { const ads = this._sdk && this._sdk.ads; return ads ? ads[kind] : null; },

    async _canShow(kind) {
        const ad = this._ads(kind);
        if (!ad || !ad.isSupported) return false;
        try { return (await this._limit(ad.canShow(), this.CAN_SHOW_TIMEOUT, 'canShow')) === true; } catch (e) { return false; }
    },

    // Изменилась доступность rewarded — событие окна 'lory-rewarded-change': игра обновляет кнопки «за рекламу».
    async _checkRewarded() {
        const ok = await this._canShow('rewarded');
        if (ok === this._rewardedOk) return;
        this._rewardedOk = ok;
        window.dispatchEvent(new Event('lory-rewarded-change'));
    },

    supports(kind) {
        if (kind === 'rewarded') { const ad = this._ads('rewarded'); return !!ad && !!ad.isSupported && this._rewardedOk; }
        if (kind === 'interstitial') { const ad = this._ads('fullscreen'); return !!ad && !!ad.isSupported; }
        return false;
    },

    // Показ: результат show() или null, если реклама сейчас недоступна. Отказ площадки — обычная ситуация, игра идёт дальше.
    async _show(kind) {
        if (!(await this._canShow(kind))) return null;
        const r = await this._limit(this._ads(kind).show(), this.AD_OPEN_TIMEOUT, 'show');
        if (r && r.rendered === false) console.warn('Pikabu: реклама не показана:', r.reason);
        return r || null;
    },

    async interstitial() {
        const r = await this._show('fullscreen');
        return !!(r && r.rendered);
    },

    async rewarded() {
        const r = await this._show('rewarded');
        if (!r) await this._checkRewarded();
        return !!(r && r.rendered && r.reward === true);
    },

    // --- Аккаунт ------------------------------------------------------------------------

    authorized() { return !!(this._sdk && this._sdk.player && this._sdk.player.isAuthorized); },
    canLogin() { return !!(this._sdk && this._sdk.auth) && !this.authorized(); },
    async login() {
        if (!this.canLogin()) return this.authorized();
        Pause.set('platform', true);
        try { await this._sdk.auth.openAuthDialog(); } catch (e) { /* окно закрыто с ошибкой: остаётся гость */ } finally { Pause.set('platform', false); }
        return this.authorized();
    },

    // --- Сохранения -----------------------------------------------------------------------

    async load(P) {
        if (!this._sdk) return Store.getJSON(P._storeKey(), null);
        const raw = this._sdk.storage.get(this.SAVE_KEY);
        return raw == null || raw === '' ? null : raw;
    },

    async save(data, json, obj, P) {
        await P.ensureLoaded();   // запись только после успешной загрузки
        if (!this._sdk) return Store.set(P._storeKey(), json);
        this._sdk.storage.set(this.SAVE_KEY, data);
        return true;
    },
};

Platform.register('pikabu', PlatformPikabu);
