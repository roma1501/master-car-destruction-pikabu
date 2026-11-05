// PlatformPlaygama.js — адаптер Playgama Bridge SDK (глобал bridge) для Platform.js (name 'playgama').
// Подключается ПОСЛЕ Platform.js; регистрирует себя сам (Platform.register). Bridge вписывает сборка
// build.bat playgama первым скриптом страницы (единственный внешний ресурс) и кладёт рядом с index.html
// playgama-bridge-config.json (шаблон — tools/playgama-bridge-config.json). Bridge внутри сам работает
// на любой площадке-хозяине (Playgama, Яндекс и др.) — игра видит один адаптер.
//
//   init       bridge.initialize() раньше любого другого вызова bridge.*; не ответил — игра идёт локально.
//              Язык — bridge.platform.language (запасной en; Lang при LANG_AUTO = 1). Пауза и звук площадки —
//              события (вкладка, окно, реклама): Pause 'platform' и Sound.setPlatformMuted; начальное
//              состояние звука и открытой при старте рекламы применяются руками (события о нём не придут).
//   ready      platform.sendMessage('game_ready') — один раз, после снятия экрана загрузки (Platform.ready).
//   gameplay   level_started / level_paused / level_resumed; итог раунда — ads.roundEnded(win) ->
//              level_completed / level_failed.
//   ads        bridge.advertisement: запрос, затем состояния событиями. interstitial уходит по правилу двух
//              раундов движка (Platform.ads.next); rewarded — true ТОЛЬКО при состоянии 'rewarded'.
//              Bridge сам пропускает показ чаще minimumDelayBetweenInterstitial: тишина — не реклама, игра дальше.
//   storage    bridge.storage, один ключ 'save', один вызов на все ключи; без localStorage. Ошибка загрузки
//              блокирует запись (Platform.ensureLoaded), как в Playables.
//   leaderboard setScore в лидерборд Score; таблица (getEntries) — только при leaderboards.type = in_game.
//   login      bridge.player.authorize() — по кнопке игрока, если площадка умеет.
//   analytics  bridge.analytics.send (Bridge 2.3+), без своих session_id.

/** @satisfies {Record<string, any>} */
const PlatformPlaygama = {
    SAVE_KEY: 'save',           // ключ bridge.storage: вся игра одним значением
    INIT_TIMEOUT: 15000,        // мс: bridge.initialize не ответил -> локальный режим
    STORAGE_TIMEOUT: 10000,     // мс: storage.get не ответил -> ошибка загрузки (повтор), а не вечная загрузка
    AD_START_TIMEOUT: 4000,     // мс: interstitial без единого состояния -> показа не будет (интервал Bridge, нет объявления)
    REWARDED_START_TIMEOUT: 15000, // мс: то же для rewarded — игрок ждёт, даём площадке больше времени
    AD_LOAD_TIMEOUT: 15000,     // мс: после 'loading' ждём 'opened'
    AD_OPEN_TIMEOUT: 180000,    // мс: после 'opened' ждём закрытия
    AD_REWARD_GRACE: 4000,      // мс: после 'rewarded' ждём 'closed' не дольше — награда уже подтверждена
    scoreInterval: 1100,        // не чаще раза в секунду (ядро Platform.submitScore)

    /** @type {{ kind: string, onState: (state: string) => void } | null} */
    _wait: null,                // ожидаемая реклама
    _paused: false,             // gameplay остановлен паузой посреди раунда

    detect: () => typeof bridge !== 'undefined' && !!bridge && typeof bridge.initialize === 'function',

    // Промис с отказом по таймауту; поздний ответ исходного промиса не станет unhandled.
    _limit(promise, ms, what) {
        let timer = 0;
        const source = Promise.resolve(promise);
        source.catch(() => {});
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(what + ' timeout')), ms); });
        return Promise.race([source, timeout]).finally(() => clearTimeout(timer));
    },

    async init(P) {
        await this._limit(bridge.initialize(), this.INIT_TIMEOUT, 'bridge.initialize');
        P.sdk = bridge;
        const plat = bridge.platform, ev = bridge.EVENT_NAME || {};
        try { P.hostId = plat.id || null; } catch (e) { /* без id */ }
        let lang = null;
        try { lang = plat.language; } catch (e) { /* язык по умолчанию */ }
        P.lang = (typeof lang === 'string' && lang) ? lang.toLowerCase() : 'en';
        // Пауза и звук приходят от площадки на всё: вкладка, окно, реклама. Подписаться ДО чтения начального состояния.
        plat.on(ev.PAUSE_STATE_CHANGED || 'pause_state_changed', (paused) => Pause.set('platform', !!paused));
        plat.on(ev.AUDIO_STATE_CHANGED || 'audio_state_changed', (on) => Sound.setPlatformMuted(!on));
        Sound.setPlatformMuted(plat.isAudioEnabled === false);
        if (plat.isPaused === true) Pause.set('platform', true);
        const adv = bridge.advertisement;
        if (adv && typeof adv.on === 'function') {
            adv.on(ev.INTERSTITIAL_STATE_CHANGED || 'interstitial_state_changed', (st) => this._adState('interstitial', st));
            adv.on(ev.REWARDED_STATE_CHANGED || 'rewarded_state_changed', (st) => this._adState('rewarded', st));
            // Игра открылась поверх уже показанной рекламы: пауза сразу, снимет событие паузы площадки.
            if (adv.interstitialState === 'opened' || adv.rewardedState === 'opened') Pause.set('platform', true);
        }
    },

    // --- Жизненный цикл ------------------------------------------------------------

    // Сообщение площадке (game_ready, level_started…). Нужен Bridge с platform.sendMessage.
    _message(name, data) {
        const plat = bridge.platform;
        if (plat && typeof plat.sendMessage === 'function') {
            if (data) plat.sendMessage(name, data); else plat.sendMessage(name);
        }
    },

    ready() { this._message('game_ready'); },

    // level_started — раунд пошёл; level_paused / level_resumed — пауза площадки, меню или реклама посреди раунда.
    // Конец раунда (stop без паузы) сообщения не шлёт: итог отдаёт ads.roundEnded(win) -> levelEnd.
    gameplay(want, P) {
        if (want) this._message(this._paused ? 'level_resumed' : 'level_started');
        else if (P.playing) this._message('level_paused');
        this._paused = !want && P.playing;
    },

    levelEnd(win, level) {
        this._message(win ? 'level_completed' : 'level_failed', level ? { level } : undefined);
        this._paused = false;
    },

    // --- Реклама ----------------------------------------------------------------------

    supports(kind) {
        const adv = bridge.advertisement;
        if (kind === 'analytics') return !!(bridge.analytics && typeof bridge.analytics.send === 'function');
        if (!adv) return false;
        return !!(kind === 'rewarded' ? adv.isRewardedSupported : adv.isInterstitialSupported);
    },

    interstitial() { return this._show('interstitial'); },
    rewarded() { return this._show('rewarded'); },

    // Состояния рекламы: loading, opened, closed, rewarded, failed. interstitial: true — реклама открылась и закрылась;
    // rewarded: true — ТОЛЬКО если было состояние rewarded (закрытие и ошибка — false). Таймауты — в шапке полей.
    _show(kind) {
        const adv = bridge.advertisement;
        const rewarded = kind === 'rewarded';
        if (!this.supports(kind)) return Promise.resolve(false);
        return new Promise((resolve) => {
            let opened = false, got = false, done = false, timer = 0;
            const result = () => (rewarded ? got : opened);
            const finish = (ok) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                if (this._wait === wait) this._wait = null;
                resolve(!!ok);
            };
            const arm = (ms, ok) => { clearTimeout(timer); timer = setTimeout(() => finish(ok()), ms); };
            const wait = {
                kind,
                onState: (state) => {
                    if (state === 'loading') arm(this.AD_LOAD_TIMEOUT, result);
                    else if (state === 'opened') { opened = true; arm(this.AD_OPEN_TIMEOUT, result); }
                    else if (state === 'rewarded') { got = true; arm(this.AD_REWARD_GRACE, () => true); }
                    else if (state === 'closed') finish(result());
                    else if (state === 'failed') finish(rewarded ? got : false);
                },
            };
            this._wait = wait;
            arm(rewarded ? this.REWARDED_START_TIMEOUT : this.AD_START_TIMEOUT, () => false);
            try {
                const r = rewarded ? adv.showRewarded() : adv.showInterstitial();
                if (r && typeof r.catch === 'function') r.catch(() => finish(result()));
            } catch (e) {
                finish(false);
            }
        });
    },

    _adState(kind, state) {
        if (this._wait && this._wait.kind === kind) this._wait.onState(state);
    },

    // --- Рекорды и аккаунт -------------------------------------------------------------

    submitScore(v, P) {
        const board = bridge.leaderboards;
        if (!board || board.type === 'not_available' || typeof board.setScore !== 'function') return;   // на этой площадке рекордов нет
        Promise.resolve(board.setScore(P.LEADERBOARD, v)).catch((e) => console.warn('Platform.submitScore:', (e && e.message) || e));
    },

    // Таблицу рисует игра только при in_game; native и native_popup показывает сама площадка.
    async leaderboard(opts, P) {
        const board = bridge.leaderboards;
        if (!board || board.type !== 'in_game') return null;
        const entries = await board.getEntries(P.LEADERBOARD);
        let myId = '';
        try { myId = String((bridge.player && bridge.player.id) || ''); } catch (e) { /* аноним */ }
        return (entries || []).map((e) => {
            /** @type {Record<string, any>} */
            const entry = { rank: e.rank, score: e.score, name: e.name || '', me: !!(myId && e.id != null && String(e.id) === myId) };
            const photo = Array.isArray(e.photo) ? e.photo[e.photo.length - 1] : e.photo;
            if (photo) entry.avatar = String(photo);
            return entry;
        });
    },

    authorized: () => !!(bridge.player && bridge.player.isAuthorized),
    canLogin: () => !!(bridge.player && bridge.player.isAuthorizationSupported && typeof bridge.player.authorize === 'function'),
    async login() {
        await bridge.player.authorize();
        return this.authorized();
    },

    // --- Сохранения --------------------------------------------------------------------

    // Только bridge.storage. Ошибку нельзя превращать в null: следом save затёр бы облако пустой игрой.
    async load() {
        const got = await this._limit(bridge.storage.get([this.SAVE_KEY]), this.STORAGE_TIMEOUT, 'bridge.storage.get');
        const raw = Array.isArray(got) ? got[0] : (got && typeof got === 'object' ? got[this.SAVE_KEY] : got);
        return raw == null || raw === '' ? null : raw;
    },

    async save(data, json, obj, P) {
        await P.ensureLoaded();   // запись только после успешной загрузки (см. load)
        await bridge.storage.set([this.SAVE_KEY], [data]);
    },

    // --- Аналитика ---------------------------------------------------------------------

    analytics(name, data) {
        if (bridge.analytics && typeof bridge.analytics.send === 'function') bridge.analytics.send(name, data);
    },
};

Platform.register('playgama', PlatformPlaygama);
