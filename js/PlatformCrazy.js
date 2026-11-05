// PlatformCrazy.js — адаптер CrazyGames SDK v3 (глобал CrazyGames.SDK) для Platform.js (name 'crazygames').
// Подключается ПОСЛЕ Platform.js; регистрирует себя сам (Platform.register). SDK вписывает сборка
// build.bat crazygames первым скриптом страницы (единственный внешний ресурс; в исходниках его нет). Сверено
// с документацией CrazyGames (HTML5 SDK v3: game, ad, user, data — 2026-10); на самой площадке не проверялось.
//
//   init       await SDK.init() (раньше любого другого вызова SDK; не ответил — игра идёт локально); environment
//              'disabled' (чужой домен) — локально. Сразу loadingStart(); язык — user.systemInfo.locale (сборка
//              ставит LANG_AUTO = 1); звук — game.settings.muteAudio и подписка на её смену (Sound.setPlatformMuted);
//              hasAdblock() -> предложения «за рекламу» скрыты (игра должна работать и с блокировщиком).
//   ready      loadingStop() — один раз, после снятия экрана загрузки (Platform.ready).
//   gameplay   gameplayStart() / gameplayStop(): раунд, меню, пауза игрока, реклама. Фокус и уход со страницы ведёт
//              сам сайт («не вызывать при смене фокуса» — документация), поэтому причина паузы 'auto'
//              не считается остановкой (gameplayIgnore).
//   ads        ad.requestAd('midgame' | 'rewarded', { adStarted, adFinished, adError }). Пока идёт запрос — пауза 'adwait'
//              (игра стоит, звук играет, интерфейс закрыт прозрачным слоем), с adStarted — 'ad' (звук молчит); снимается
//              на adFinished / adError / таймауте. Это для midgame; rewarded по правилу пользователя игру не останавливает
//              (ADS_REWARDED_PAUSE = 0): запрос — только прозрачный слой, с adStarted — тишина игры (Sound.setAdMuted),
//              пауза идёт через P.adPause. interstitial уходит по правилу двух раундов (Platform.ads.next);
//              rewarded — true ТОЛЬКО по adFinished. Ошибки: adblock и adsDisabledBasicLaunch скрывают rewarded
//              насовсем; unfilled, adCooldown, other — false, игра идёт дальше.
//   аккаунт    user.isUserAccountAvailable -> authorized / canLogin / login (showAuthPrompt — только по кнопке игрока);
//              после входа SDK подтягивает облако — игре перечитать Platform.load().
//   сохранения модуль data (getItem/setItem, ключ 'save': гость — локально у SDK, вход — облако аккаунта), без
//              localStorage; лимит SDK 1 МБ JSON. Модуль выключен в настройках игры (dataModuleDisabled) — Store.
//              Ошибка загрузки блокирует запись (Platform.ensureLoaded).
// Не используется: баннеры, happytime, reportGameCompletedPercentage, setGameContext, мультиплеер.

/** @satisfies {Record<string, any>} */
const PlatformCrazy = {
    SAVE_KEY: 'save',              // ключ модуля data: вся игра одним значением
    INIT_TIMEOUT: 10000,           // мс: SDK.init не ответил -> локальный режим
    ADBLOCK_TIMEOUT: 3000,         // мс: hasAdblock не ответил -> считаем, что реклама есть
    AD_START_TIMEOUT: 15000,       // мс: запрос рекламы без adStarted -> показа не будет (false)
    AD_OPEN_TIMEOUT: 300000,       // мс: после adStarted ждём adFinished не дольше
    ownAdPause: true,              // пауза рекламы — 'adwait' -> 'ad' (ядро 'ad' заранее не ставит)
    gameplayIgnore: ['auto'],      // фокус ведёт сайт

    /** @type {any} */
    _sdk: null,
    /** @type {any} */
    _user: null,                   // игрок CrazyGames { username, profilePictureUrl } или null (гость)
    _accounts: false,              // аккаунты доступны (на чужих доменах — нет)
    _noAds: false,                 // блокировщик или Basic Launch: rewarded спрятан
    _dataOff: false,               // модуль data выключен для игры — сохранения в Store

    detect: () => typeof window !== 'undefined' && !!(/** @type {any} */ (window).CrazyGames && /** @type {any} */ (window).CrazyGames.SDK),

    // Промис с отказом по таймауту; поздний ответ исходного промиса не станет unhandled.
    _limit(promise, ms, what) {
        let timer = 0;
        const source = Promise.resolve(promise);
        source.catch(() => {});
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(what + ' timeout')), ms); });
        return Promise.race([source, timeout]).finally(() => clearTimeout(timer));
    },

    async init(P) {
        const sdk = /** @type {any} */ (window).CrazyGames.SDK;
        await this._limit(sdk.init(), this.INIT_TIMEOUT, 'CrazyGames.SDK.init');
        if (sdk.environment === 'disabled') throw new Error('CrazyGames SDK отключён на этом домене');
        this._sdk = sdk;
        P.sdk = sdk;
        try { sdk.game.loadingStart(); } catch (e) { /* старый SDK */ }
        try { const info = sdk.user.systemInfo; P.lang = (info && info.locale) || null; } catch (e) { P.lang = null; }
        // Настройки сайта: звук (приоритетнее настроек игры) — ДО чтения начального состояния подписка, затем значение.
        const settings = (s) => Sound.setPlatformMuted(!!(s && s.muteAudio));
        try { sdk.game.addSettingsChangeListener(settings); settings(sdk.game.settings); } catch (e) { /* настройки по умолчанию */ }
        try {
            const adblock = await this._limit(sdk.ad.hasAdblock(), this.ADBLOCK_TIMEOUT, 'CrazyGames.SDK.ad.hasAdblock');
            this._noAds = adblock === true;
        } catch (e) { /* неизвестно — считаем, что реклама есть */ }
        try {
            this._accounts = !!sdk.user.isUserAccountAvailable;
            if (this._accounts) {
                this._user = (await sdk.user.getUser()) || null;
                // Выход перезагружает страницу, вход — слушатель: обновить игрока.
                sdk.user.addAuthListener((user) => { this._user = user || null; });
            }
        } catch (e) { this._user = null; }
    },

    // --- Жизненный цикл ------------------------------------------------------------

    ready() { this._sdk.game.loadingStop(); },

    gameplay(want) {
        if (want) this._sdk.game.gameplayStart(); else this._sdk.game.gameplayStop();
    },

    // --- Реклама ----------------------------------------------------------------------

    supports(kind) {
        if (kind === 'rewarded') return !this._noAds;
        return kind === 'interstitial';
    },

    interstitial(P) { return this._ad('midgame', P); },
    rewarded(id, P) { return this._ad('rewarded', P); },

    // Прозрачный слой на время запроса: интерфейс игры не нажать, пока площадка готовит ролик.
    _blocker() {
        try {
            const el = document.createElement('div');
            el.style.cssText = 'position:fixed;inset:0;z-index:99998;background:transparent';
            document.body.appendChild(el);
            return el;
        } catch (e) { return null; }
    },

    // type: 'midgame' | 'rewarded'. true — adFinished; rewarded — награда подтверждена площадкой. Пауза 'adwait' на
    // запрос, 'ad' — с adStarted; всё снимается на любом исходе, включая таймаут и исключение SDK. Паузы идут через
    // P.adPause: midgame ставит их по-настоящему, rewarded без паузы игры (ADS_REWARDED_PAUSE = 0, по умолчанию) —
    // игра идёт, 'ad' глушит только звук, интерфейс на запрос закрыт прозрачным слоем.
    _ad(type, P) {
        const sdk = this._sdk;
        const pause = (reason, on) => { if (P && typeof P.adPause === 'function') P.adPause(reason, on); else Pause.set(reason, on); };
        return new Promise((resolve) => {
            let done = false, timer = 0;
            const block = this._blocker();
            pause('adwait', true);
            const finish = (ok) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                if (block) block.remove();
                pause('ad', false);
                pause('adwait', false);
                resolve(ok === true);
            };
            timer = setTimeout(() => finish(false), this.AD_START_TIMEOUT);
            try {
                sdk.ad.requestAd(type, {
                    adStarted: () => {
                        if (done) return;
                        pause('ad', true);
                        clearTimeout(timer);
                        timer = setTimeout(() => finish(false), this.AD_OPEN_TIMEOUT);
                    },
                    adFinished: () => finish(true),
                    adError: (err) => {
                        const code = err && err.code;
                        if (code === 'adblock' || code === 'adsDisabledBasicLaunch') this._noAds = true;
                        finish(false);
                    },
                });
            } catch (e) {
                finish(false);
            }
        });
    },

    // --- Аккаунт ------------------------------------------------------------------------

    authorized() { return !!this._user; },
    canLogin() { return this._accounts && !this._user && !!this._sdk.user.showAuthPrompt; },
    async login() {
        if (!this._accounts) return false;   // чужой домен: окно входа недоступно
        try { this._user = (await this._sdk.user.showAuthPrompt()) || null; } catch (e) { return false; }
        return !!this._user;
    },

    // --- Сохранения -----------------------------------------------------------------------

    _isCode(e, code) { return !!e && (e.code === code || String((e && e.message) || '').includes(code)); },

    // Модуль data. Ошибку нельзя превращать в null: следом save затёр бы сохранение пустой игрой. Исключение —
    // модуль выключен в настройках игры: сохранения идут в Store.
    async load(P) {
        const data = this._sdk && this._sdk.data;
        if (!this._dataOff && data) {
            try {
                const raw = await data.getItem(this.SAVE_KEY);
                return raw == null || raw === '' ? null : raw;
            } catch (e) {
                if (!this._isCode(e, 'dataModuleDisabled')) throw e;
                this._dataOff = true;
            }
        }
        return Store.getJSON(P._storeKey(), null);
    },

    async save(data, json, obj, P) {
        await P.ensureLoaded();   // запись только после успешной загрузки (см. load)
        const dm = this._sdk && this._sdk.data;
        if (!this._dataOff && dm) {
            try {
                await dm.setItem(this.SAVE_KEY, data);   // SDK сам склеивает частые записи (debounce)
                return true;
            } catch (e) {
                if (!this._isCode(e, 'dataModuleDisabled')) throw e;
                this._dataOff = true;
            }
        }
        return Store.set(P._storeKey(), json);
    },
};

Platform.register('crazygames', PlatformCrazy);
