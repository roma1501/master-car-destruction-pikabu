// DailyGift.js — ежедневный подарок на 7 дней: календарь, награды, «x2 за рекламу».
// ЛОГИКА БЕЗ ИНТЕРФЕЙСА: окно подарка, карточки дней и анимации рисует игра; модуль отдаёт
// DailyGift.view() — готовую модель окна. Опт-ин: пока нет DailyGift.init, ничего не делает.
//
// ПРАВИЛА (личные требования пользователя):
//   · цикл из 7 дней по ЛОКАЛЬНОЙ дате устройства; забрать можно один раз в календарный день;
//   · пропуск дня цикл НЕ сбрасывает: при следующем входе открывается следующий день;
//   · повтор защищён: дата получения ставится ДО выдачи, второй claim() в тот же день -> 'claimed';
//   · дни 1–6 — награды из данных игры (валюта и/или предметы), по нарастающей;
//   · «x2 за рекламу» (Platform.rewarded('daily-x2')): удвоение ТОЛЬКО после true; базовую награду
//     claim() можно забрать всегда, отказ/ошибка рекламы её не отнимают; на дне 7 удвоения нет;
//     пока идёт общая пауза между rewarded (Platform.rewardedCooldownLeft) кнопка x2 неактивна, на ней «Через N с»
//     (view().x2.label / hint, x2.adWait = N; claimX2() -> reason 'cooldown');
//   · день 7 — эксклюзивный скин (его нет в магазине и на колесе): следующий в очереди, которого у
//     игрока ещё нет; когда все получены — крупная награда валютой (DAILY_FALLBACK_COINS);
//   · пока идёт туториал (Tutorial.active), подарок не предлагается: shouldOffer() -> false.
//
// ПОДКЛЮЧЕНИЕ (после Shop.init; save — единый объект сохранения игры):
//   DailyGift.init({
//       rewards: [{ coins: 30 }, { coins: 50 }, { coins: 80 }, { coins: 120, randomItems: 1 }, { coins: 160 }, { coins: 250 }],
//       exclusive: ['skin_royal', 'skin_gold'],      // очередь скинов дня 7 (иначе — Shop.exclusiveIds('daily'))
//       rewardsSink: Shop,                           // addCoins / owns / grant / randomItem / name
//       state: save.daily, persist: () => Platform.save(save),
//   });
//   save.daily = DailyGift.state;
//   const v = DailyGift.view();                      // days[].state: claimed | today | tomorrow | locked
//   if (DailyGift.shouldOffer()) { openGiftWindow(); DailyGift.markOffered(); }
//   button «Забрать»:   DailyGift.claim();           // ok, day, mult, got[]
//   button «x2 за рекламу»:  await DailyGift.claimX2();
//
// ДАННЫЕ награды дня: { coins?, item?: 'id', randomItems?: n, maxRarity?, ...свои поля }. x2 удваивает
// coins и randomItems (конкретный item не удваивается). Для дней 1–6 держи coins > 0, чтобы x2 был.
// rewardsSink — объект с методами addCoins(n, { reason, save }), owns(id), grant(id, { reason, save }),
// randomItem({ rng, maxRarity }), name(id): Shop подходит как есть; без него модуль только считает, а
// игра применяет result.got сама. Уже имеющийся предмет заменяется валютой (DAILY_DUP_COINS).
// События (DailyGift.on): claim { day, cycle, mult, reward, got }, offer { day }.
// Состояние { v, day, cycle, last, offered, skin } — JSON внутри единого сохранения игры (save.daily).

/** @typedef {{ coins?: number, item?: string, randomItems?: number, maxRarity?: string, label?: any, [key: string]: any }} DailyReward */
/** @typedef {{ v: number, day: number, cycle: number, last: string, offered: string, skin: string }} DailyState */

/** @satisfies {Record<string, any>} */
const DailyGift = {
    /** Тексты по умолчанию. При загрузке дополняют LANG_STRINGS (не затирая ключи игры); без Lang берутся отсюда. */
    TEXT: {
        ru: {
            'daily.day': 'День {n}',
            'daily.today': 'Сегодня',
            'daily.tomorrow': 'Завтра',
            'daily.claim': 'Забрать',
            'daily.claimX2': 'x2 за рекламу',
            'daily.claimed': 'Получено',
            'daily.nextIn': 'Следующий подарок через {t}',
            'daily.noX2': 'Эксклюзивный скин выдаётся один раз, без удвоения',
            'daily.adUnavailable': 'Реклама сейчас недоступна. Награду можно забрать и без неё.',
            'daily.adIn': 'Через {n} с',
            'daily.exclusive': 'Эксклюзивный скин',
            'daily.exclusiveHint': 'Нигде больше не продаётся',
            'reward.coins': 'Монеты: {n}',
            'reward.item': 'Предмет: {name}',
            'reward.randomItem': 'Случайный предмет',
            'reward.randomItems': 'Случайные предметы: {n}',
            'reward.exclusive': 'Эксклюзив: {name}',
            'reward.big': 'Крупная награда: монеты {n}',
            'reward.dup': 'Такой предмет уже есть, монеты: {n}',
        },
        en: {
            'daily.day': 'Day {n}',
            'daily.today': 'Today',
            'daily.tomorrow': 'Tomorrow',
            'daily.claim': 'Claim',
            'daily.claimX2': 'x2: watch ad',
            'daily.claimed': 'Claimed',
            'daily.nextIn': 'Next gift in {t}',
            'daily.noX2': 'The exclusive skin is given once, no doubling',
            'daily.adUnavailable': 'No ad right now. You can still claim the reward without one.',
            'daily.adIn': 'In {n} s',
            'daily.exclusive': 'Exclusive skin',
            'daily.exclusiveHint': 'Not sold anywhere else',
            'reward.coins': 'Coins: {n}',
            'reward.item': 'Item: {name}',
            'reward.randomItem': 'Random item',
            'reward.randomItems': 'Random items: {n}',
            'reward.exclusive': 'Exclusive: {name}',
            'reward.big': 'Big reward: {n} coins',
            'reward.dup': 'You already have this item, coins: {n}',
        },
    },

    /** @type {any} */
    _cfg: {},
    /** Награды дней 1..6 (нормализованные). @type {DailyReward[]} */
    _rewards: [],
    /** @type {Array<(e: any) => void>} */
    _listeners: [],
    _adBusy: false,
    _adRetryAt: 0,
    /** Сохраняемое состояние: day — последний полученный день круга (0..7), cycle — пройдено кругов. @type {DailyState} */
    state: { v: 1, day: 0, cycle: 0, last: '', offered: '', skin: '' },

    // =============================================================================================
    // Запуск и состояние
    // =============================================================================================

    /**
     * @param {{ rewards?: DailyReward[], exclusive?: string[], rewardsSink?: any, state?: any, persist?: (reason: string) => any,
     *   onChange?: (e: any) => void, now?: () => number, rng?: () => number, rewarded?: (id: string) => Promise<boolean>,
     *   adsAvailable?: () => boolean, fallbackCoins?: number, dupCoins?: number }} [cfg]
     */
    init(cfg) {
        const c = cfg || {};
        this._cfg = c;
        this._listeners = typeof c.onChange === 'function' ? [c.onChange] : [];
        this._adBusy = false;
        this._adRetryAt = 0;
        this._rewards = [];
        for (let i = 0; i < this.cycleDays() - 1; i++) this._rewards.push(this._reward(c.rewards && c.rewards[i]));
        this.state = this._normalize(c.state);
        return this;
    },

    _reward(raw) {
        const r = raw && typeof raw === 'object' ? { ...raw } : {};
        r.coins = this._int(r.coins);
        r.randomItems = this._int(r.randomItems);
        r.item = typeof r.item === 'string' ? r.item : '';
        return r;
    },

    _normalize(raw) {
        const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
        const date = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');
        s.v = 1;
        s.day = Math.min(this.cycleDays(), this._int(s.day));
        s.cycle = this._int(s.cycle);
        s.last = date(s.last);
        s.offered = date(s.offered);
        s.skin = typeof s.skin === 'string' ? s.skin : '';
        return s;
    },

    _int(v) { return Math.max(0, Math.floor(Number(v)) || 0); },
    _now() { return typeof this._cfg.now === 'function' ? this._cfg.now() : Date.now(); },
    _rng() { return typeof this._cfg.rng === 'function' ? this._cfg.rng() : Math.random(); },
    _retryMs() { return (typeof REWARDED_RETRY_SEC !== 'undefined' ? REWARDED_RETRY_SEC : 4) * 1000; },
    /** Секунд до конца общей паузы между rewarded (Platform.rewardedCooldownLeft; cfg.cooldownLeft() подменяет); 0 — можно. */
    _globalWaitSec() {
        try {
            const f = this._cfg.cooldownLeft;
            const v = typeof f === 'function' ? f() : (typeof Platform !== 'undefined' && typeof Platform.rewardedCooldownLeft === 'function' ? Platform.rewardedCooldownLeft() : 0);
            return Math.max(0, Math.ceil(Number(v) || 0));
        } catch (e) { return 0; }
    },
    _sink() { return this._cfg.rewardsSink || null; },

    /** Дней в круге (DAILY_CYCLE_DAYS, по правилу пользователя — 7). */
    cycleDays() { return Math.max(2, this._int(typeof DAILY_CYCLE_DAYS !== 'undefined' ? DAILY_CYCLE_DAYS : 7)); },

    on(fn) {
        if (typeof fn !== 'function') return () => {};
        this._listeners.push(fn);
        return () => {
            const i = this._listeners.indexOf(fn);
            if (i >= 0) this._listeners.splice(i, 1);
        };
    },

    _emit(type, data) {
        const e = { type, ...data };
        for (const fn of this._listeners.slice()) {
            try { fn(e); } catch (err) { console.error('DailyGift: обработчик события «' + type + '»:', err); }
        }
    },

    _save(reason) {
        const f = this._cfg.persist;
        if (typeof f !== 'function') return;
        try {
            const r = f(reason);
            if (r && typeof r.catch === 'function') r.catch((e) => console.warn('DailyGift: сохранение не удалось:', (e && e.message) || e));
        } catch (e) {
            console.warn('DailyGift: сохранение не удалось:', (e && e.message) || e);
        }
    },

    _rewarded(id) {
        if (typeof this._cfg.rewarded === 'function') return Promise.resolve(this._cfg.rewarded(id));
        return typeof Platform !== 'undefined' ? Platform.rewarded(id) : Promise.resolve(false);
    },

    // =============================================================================================
    // Тексты
    // =============================================================================================

    _lang() {
        return typeof Lang !== 'undefined' ? Lang.code : (typeof GAME_LANG !== 'undefined' ? GAME_LANG : 'ru');
    },

    t(key, params) {
        if (typeof Lang !== 'undefined' && Lang.has(key)) return Lang.t(key, params);
        const s = (this.TEXT[this._lang()] || this.TEXT.en)[key] || this.TEXT.en[key] || key;
        return params ? s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)) : s;
    },

    /** «ЧЧ:ММ:СС» из миллисекунд (таймер до следующего подарка). */
    formatTime(ms) {
        const sec = Math.max(0, Math.ceil(ms / 1000));
        const p = (n) => (n < 10 ? '0' : '') + n;
        return p(Math.floor(sec / 3600)) + ':' + p(Math.floor((sec % 3600) / 60)) + ':' + p(sec % 60);
    },

    // =============================================================================================
    // Календарь (локальная дата устройства; часы подменяются cfg.now)
    // =============================================================================================

    /** Дата «ГГГГ-ММ-ДД» по локальному времени устройства. */
    dateKey(ms) {
        const d = new Date(ms == null ? this._now() : ms);
        const p = (n, w) => String(n).padStart(w, '0');
        return p(d.getFullYear(), 4) + '-' + p(d.getMonth() + 1, 2) + '-' + p(d.getDate(), 2);
    },
    today() { return this.dateKey(); },
    /** Миллисекунд до ближайшей локальной полуночи (смена даты, декабрь -> январь и переход на летнее время учтены Date). */
    msToNextDay(ms) {
        const d = new Date(ms == null ? this._now() : ms);
        return Math.max(0, new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - d.getTime());
    },

    /** Подарок на сегодня ещё не получен? Пропущенные дни не важны: важно только «не сегодня». */
    canClaim() { return this.state.last !== this.today(); },
    /** День круга (1..7), который выдаётся следующим: сегодня, если подарок доступен, иначе завтра. */
    nextDay() { return this.state.day % this.cycleDays() + 1; },

    // =============================================================================================
    // Награды
    // =============================================================================================

    /** Очередь эксклюзивных скинов дня 7: cfg.exclusive или эксклюзивы 'daily' приёмника наград. */
    exclusiveList() {
        if (Array.isArray(this._cfg.exclusive)) return this._cfg.exclusive.filter((id) => typeof id === 'string' && id);
        const sink = this._sink();
        return sink && typeof sink.exclusiveIds === 'function' ? sink.exclusiveIds('daily') : [];
    },

    _owns(id) {
        const sink = this._sink();
        return !!(sink && typeof sink.owns === 'function' && sink.owns(id));
    },

    /** Скин, который достанется на дне 7 (цель, видна в окне), или null — получены все. */
    goalSkin() {
        for (const id of this.exclusiveList()) if (!this._owns(id)) return id;
        return null;
    },

    _fallbackCoins() { return this._int(this._cfg.fallbackCoins != null ? this._cfg.fallbackCoins : (typeof DAILY_FALLBACK_COINS !== 'undefined' ? DAILY_FALLBACK_COINS : 600)); },
    _dupCoins() { return this._int(this._cfg.dupCoins != null ? this._cfg.dupCoins : (typeof DAILY_DUP_COINS !== 'undefined' ? DAILY_DUP_COINS : 50)); },

    /**
     * Награда дня как данные (без случайности): { coins?, item?, randomItems?, ... } для дней 1–6,
     * { exclusive: id } для дня 7 (или { coins, big: true }, когда скины кончились).
     * @returns {DailyReward}
     */
    rewardFor(day) {
        if (day < this.cycleDays()) return { ...(this._rewards[day - 1] || this._reward(null)) };
        const goal = this.goalSkin();
        return goal ? { exclusive: goal } : { coins: this._fallbackCoins(), big: true };
    },

    /** Есть ли что удваивать в награде: валюта или случайные предметы. */
    _doubles(reward) { return reward.coins > 0 || reward.randomItems > 0; },

    itemName(id) {
        const sink = this._sink();
        return sink && typeof sink.name === 'function' ? sink.name(id) : String(id);
    },

    /** Подпись награды: «Монеты: 120 + Случайный предмет». mult 2 — с удвоением. */
    rewardLabel(reward, mult = 1) {
        const parts = [];
        if (reward.exclusive) parts.push(this.t('reward.exclusive', { name: this.itemName(reward.exclusive) }));
        if (reward.coins > 0) parts.push(this.t(reward.big ? 'reward.big' : 'reward.coins', { n: reward.coins * mult }));
        if (reward.item) parts.push(this.t('reward.item', { name: this.itemName(reward.item) }));
        if (reward.randomItems > 0) {
            const n = reward.randomItems * mult;
            parts.push(n === 1 ? this.t('reward.randomItem') : this.t('reward.randomItems', { n }));
        }
        return parts.join(' + ');
    },

    /** Выдать награду через приёмник; got — что получил игрок (а не что обещано): coins | item | exclusive. */
    _grant(reward, mult) {
        const sink = this._sink();
        const got = [];
        const coins = (n, extra) => {
            if (!(n > 0)) return;
            if (sink && typeof sink.addCoins === 'function') sink.addCoins(n, { reason: 'daily', save: false });
            got.push({ type: 'coins', amount: n, ...extra });
        };
        const give = (id) => !!(sink && typeof sink.grant === 'function' && sink.grant(id, { reason: 'daily', save: false }));
        try {
            if (reward.exclusive) {
                if (!this._owns(reward.exclusive) && give(reward.exclusive)) got.push({ type: 'exclusive', id: reward.exclusive });
                else coins(this._fallbackCoins(), { big: true, converted: true, fromItem: reward.exclusive });
            }
            coins(reward.coins * mult, reward.big ? { big: true } : null);
            if (reward.item) {
                if (!this._owns(reward.item) && give(reward.item)) got.push({ type: 'item', id: reward.item });
                else coins(this._dupCoins(), { converted: true, fromItem: reward.item });
            }
            for (let i = 0; i < reward.randomItems * mult; i++) {
                const id = sink && typeof sink.randomItem === 'function' ? sink.randomItem({ notOwned: true, maxRarity: reward.maxRarity, rng: () => this._rng() }) : null;
                if (id && give(id)) got.push({ type: 'item', id });
                else coins(this._dupCoins(), { converted: true });
            }
        } catch (e) {
            console.error('DailyGift: награда выдана не полностью:', e);
        }
        return got;
    },

    // =============================================================================================
    // Получение подарка
    // =============================================================================================

    /** Забрать подарок дня без рекламы. ok: false -> reason 'claimed' (уже сегодня). */
    claim() { return this._claim(1); },

    _claim(mult) {
        const s = this.state;
        const today = this.today();
        if (s.last === today) return { ok: false, reason: 'claimed' };
        const last = this.cycleDays();
        const day = this.nextDay();
        const cycle = s.cycle;
        const m = day === last ? 1 : mult;
        const reward = this.rewardFor(day);
        // Отметка ДО выдачи: повторный вызов (двойной клик, второй обработчик) уже ничего не выдаст.
        s.day = day;
        s.last = today;
        if (day === last) { s.cycle = cycle + 1; s.skin = reward.exclusive || ''; }
        const got = this._grant(reward, m);
        const result = { ok: true, day, cycle, mult: m, reward, got };
        this._emit('claim', result);
        this._save('claim');
        return result;
    },

    /** Почему рекламу сейчас просить нельзя: 'busy' | 'cooldown' | 'unavailable' | null. */
    _adBlock() {
        if (this._adBusy) return 'busy';
        if (this._now() < this._adRetryAt || this._globalWaitSec() > 0) return 'cooldown';
        const f = this._cfg.adsAvailable;
        if (typeof f === 'function') {
            try { if (!f()) return 'unavailable'; } catch (e) { return 'unavailable'; }
        } else if (!this._cfg.rewarded && typeof Platform !== 'undefined' && typeof Platform.rewardedSupported === 'function') {
            // По умолчанию — площадка: нет rewarded (Telegram, Playables без ytgame.ads) — предложение прячется.
            try { if (!Platform.rewardedSupported()) return 'unavailable'; } catch (e) { /* площадка не ответила — не прячем */ }
        }
        return null;
    },

    /** Секунд до следующей попытки: пауза после неудачной рекламы или общая пауза между rewarded (что дольше). */
    adWaitSec() { return Math.max(this._retryWaitSec(), this._globalWaitSec()); },

    _retryWaitSec() { return Math.max(0, Math.ceil((this._adRetryAt - this._now()) / 1000)); },

    /** Подпись «Через N с» / «In N s» для общей паузы между rewarded (пусто, если паузы нет). */
    adWaitLabel() {
        const n = this._globalWaitSec();
        return n > 0 ? this.t('daily.adIn', { n }) : '';
    },

    /**
     * «x2 за рекламу»: Platform.rewarded('daily-x2'); подарок забирается с удвоением ТОЛЬКО после true.
     * Отказ/ошибка/закрытие рекламы -> ok: false, reason 'adFailed', подарок остаётся доступным
     * (его даёт claim()). reason: claimed | noX2 (день 7 или нечего удваивать) | busy | cooldown |
     * adUnavailable | adFailed.
     */
    async claimX2() {
        const s = this.state;
        if (s.last === this.today()) return { ok: false, reason: 'claimed' };
        const day = this.nextDay();
        if (day === this.cycleDays() || !this._doubles(this.rewardFor(day))) return { ok: false, reason: 'noX2' };
        const block = this._adBlock();
        if (block) return { ok: false, reason: block === 'unavailable' ? 'adUnavailable' : block };
        this._adBusy = true;
        let ok = false;
        try { ok = (await this._rewarded('daily-x2')) === true; } catch (e) { ok = false; } finally { this._adBusy = false; }
        if (!ok) {
            this._adRetryAt = this._now() + this._retryMs();
            return { ok: false, reason: 'adFailed' };
        }
        this._adRetryAt = 0;
        // За время рекламы подарок могли забрать иначе — тогда 'claimed'; удвоение действует только на тот день, под который смотрели.
        if (this.nextDay() !== day) return { ok: false, reason: 'claimed' };
        return this._claim(2);
    },

    /**
     * Проверка данных подарка: награды на дни 1–6, цель 7-го дня. problems — ошибки данных,
     * warnings — советы (нечего удваивать, награды не нарастают, нет эксклюзивных скинов).
     * Вызывать после Shop.init, чтобы проверить и предметы наград.
     * @returns {{ ok: boolean, problems: Array<{ code: string, message: string, day?: number }>, warnings: Array<{ code: string, message: string, day?: number }> }}
     */
    validate() {
        const problems = [];
        const warnings = [];
        const sink = this._sink();
        const known = (id) => !(sink && typeof sink.item === 'function') || !!sink.item(id);
        const need = this.cycleDays() - 1;
        const given = Array.isArray(this._cfg.rewards) ? this._cfg.rewards.length : 0;
        if (given !== need) problems.push({ code: 'rewards', message: 'Наград для дней 1–' + need + ': ' + given + ', нужно ' + need });
        let prev = 0;
        this._rewards.forEach((r, i) => {
            const day = i + 1;
            if (!(r.coins > 0 || r.item || r.randomItems > 0)) { problems.push({ code: 'empty', day, message: 'День ' + day + ': пустая награда' }); return; }
            if (r.item && !known(r.item)) problems.push({ code: 'unknownItem', day, message: 'День ' + day + ': предмета «' + r.item + '» нет в каталоге' });
            if (r.item && sink && typeof sink.isExclusive === 'function' && sink.isExclusive(r.item)) warnings.push({ code: 'exclusiveReward', day, message: 'День ' + day + ': «' + r.item + '» — эксклюзив для 7-го дня' });
            if (!this._doubles(r)) warnings.push({ code: 'noX2', day, message: 'День ' + day + ': нечего удваивать, кнопки x2 не будет (добавь coins)' });
            if (r.coins > 0 && r.coins < prev) warnings.push({ code: 'notGrowing', day, message: 'День ' + day + ': валюты меньше, чем днём раньше (награды должны нарастать)' });
            if (r.coins > 0) prev = r.coins;
        });
        const list = this.exclusiveList();
        if (!list.length) warnings.push({ code: 'noExclusive', message: 'Нет эксклюзивных скинов: 7-й день всегда будет крупной наградой валютой' });
        for (const id of list) if (!known(id)) problems.push({ code: 'unknownSkin', message: 'Эксклюзивного скина «' + id + '» нет в каталоге' });
        return { ok: problems.length === 0, problems, warnings };
    },

    // =============================================================================================
    // Предложение игроку и модель окна
    // =============================================================================================

    /** Идёт ли туториал (Tutorial.active): подарок в это время не предлагается. */
    tutorialActive() {
        // @ts-ignore — Tutorial.js опционален: без него обучения нет
        const T = typeof Tutorial !== 'undefined' ? Tutorial : null;
        return !!(T && T.active);
    },

    /** Можно ли сейчас само открыть окно: подарок доступен, туториал не идёт, сегодня ещё не предлагали. */
    shouldOffer() {
        return this.canClaim() && !this.tutorialActive() && this.state.offered !== this.today();
    },

    /** Запомнить, что сегодня окно уже показали (не навязывать повторно в тот же день). */
    markOffered() {
        if (this.state.offered === this.today()) return;
        this.state.offered = this.today();
        this._emit('offer', { day: this.nextDay() });
        this._save('offer');
    },

    /** Красная точка на кнопке: 1 — подарок можно забрать. */
    badge() { return this.canClaim() ? 1 : 0; },

    /** Коротко: можно ли забрать, какой день, сколько до следующего. */
    status() {
        const s = this.state;
        const can = this.canClaim();
        const ms = can ? 0 : this.msToNextDay();
        return {
            today: this.today(), canClaim: can, claimedToday: !can,
            day: s.day, cycle: s.cycle, nextDay: this.nextDay(),
            tutorialActive: this.tutorialActive(), offerable: this.shouldOffer(),
            msToNext: ms, nextLabel: can ? '' : this.t('daily.nextIn', { t: this.formatTime(ms) }),
        };
    },

    /**
     * Модель окна подарка.
     *   days[]: { day, state: 'claimed' | 'today' | 'tomorrow' | 'locked', exclusive, reward, label,
     *             doubles, skin, dayLabel, stateLabel }
     *   claim: { enabled, label }   x2: { available, enabled, label, rewardLabel, hint, adWait, busy }
     *   goal — id скина дня 7 (виден заранее как цель) или null
     */
    view() {
        const s = this.state;
        const st = this.status();
        const last = this.cycleDays();
        // Новый круг начинается со следующего входа после дня 7: сегодня до получения — все карточки закрыты.
        const claimedCount = s.day === last && st.canClaim ? 0 : s.day;
        const days = [];
        for (let d = 1; d <= last; d++) {
            const state = d <= claimedCount ? 'claimed' : d === claimedCount + 1 ? (st.canClaim ? 'today' : 'tomorrow') : 'locked';
            let reward = this.rewardFor(d);
            if (d === last && state === 'claimed') reward = s.skin ? { exclusive: s.skin } : { coins: this._fallbackCoins(), big: true };
            days.push({
                day: d, state, exclusive: d === last, reward,
                label: this.rewardLabel(reward),
                doubles: d !== last && this._doubles(reward),
                skin: reward.exclusive || '',
                dayLabel: this.t('daily.day', { n: d }),
                stateLabel: state === 'today' ? this.t('daily.today') : state === 'tomorrow' ? this.t('daily.tomorrow') : state === 'claimed' ? this.t('daily.claimed') : '',
            });
        }
        const today = days.find((d) => d.state === 'today') || null;
        const block = today && today.doubles ? this._adBlock() : null;
        // общая пауза между rewarded дольше паузы после неудачи: на кнопке «Через N с»
        const waiting = block === 'cooldown' && this._globalWaitSec() > this._retryWaitSec();
        const x2 = {
            available: !!(today && today.doubles),
            enabled: !!(today && today.doubles && !block),
            label: waiting ? this.adWaitLabel() : this.t('daily.claimX2'),
            rewardLabel: today && today.doubles ? this.rewardLabel(today.reward, 2) : '',
            hint: today && !today.doubles && today.exclusive ? this.t('daily.noX2')
                : waiting ? this.adWaitLabel()
                : block === 'cooldown' || block === 'unavailable' ? this.t('daily.adUnavailable') : '',
            adWait: block === 'cooldown' ? this.adWaitSec() : 0,
            busy: this._adBusy,
        };
        return {
            ...st,
            days,
            claim: { enabled: st.canClaim, label: this.t('daily.claim') },
            x2,
            goal: this.goalSkin(),
        };
    },
};

// Тексты по умолчанию кладём в LANG_STRINGS, не затирая то, что игра уже задала в своём Lang.js.
if (typeof LANG_STRINGS !== 'undefined') {
    for (const code of Object.keys(DailyGift.TEXT)) {
        const dict = LANG_STRINGS[code];
        if (!dict) continue;
        for (const key of Object.keys(DailyGift.TEXT[code])) if (!(key in dict)) dict[key] = DailyGift.TEXT[code][key];
    }
}
