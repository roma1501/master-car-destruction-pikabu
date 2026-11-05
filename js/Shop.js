// Shop.js — магазин косметики: каталог, владение, надетое, валюта и прогресс «за рекламу».
// ЛОГИКА БЕЗ ИНТЕРФЕЙСА: окно, карточки, превью на персонаже у каждой игры свои — модуль отдаёт
// состояние и «модели вида» (карточка: состояние, подпись цены, прогресс, доступное действие).
// Опт-ин: пока игра не вызвала Shop.init, модуль ничего не делает и ни на что не влияет.
//
// ДАННЫЕ (задаёт игра, например js/GameShopData.js):
//   tabs:  [{ id, name }]                     5–6 вкладок; name — { ru, en } или ключ Lang
//   items: [{ id, tab, slot?, name, rarity,   slot — «куда надевается» (по умолчанию = tab)
//             price: { coins: 120 } | { ads: 3 },   ads — 1..5 просмотров; чем ценнее предмет, тем больше
//             exclusive?: 'daily',            никогда не продаётся (Daily Gift) и не выпадает на колесе
//             default?: true,                 выдан с начала и надет, пока нет другого в слоте
//             ...любые свои поля (модель, цвет, иконка) — карточка отдаёт их как card.item }]
//
// СОСТОЯНИЕ — один JSON-объект { v, coins, owned, equipped, ads } внутри ЕДИНОГО сохранения игры:
//   const save = (await Platform.load()) || {};
//   Shop.init({ tabs, items, state: save.shop, persist: () => Platform.save(save) });
//   save.shop = Shop.state;                   // тот же объект, модуль правит его на месте
// Своего Platform.save у модуля нет: после каждого изменения он зовёт persist(причина), игра
// сохраняет весь свой объект. Частые начисления: Shop.addCoins(n, { save: false }).
//
// API (мутации возвращают { ok, reason?, ... }):
//   Shop.init(cfg)                  cfg: tabs, items, state, persist, onChange, now, rng, rewarded,
//                                   adsAvailable, autoEquip (по умолчанию true: покупка надевает)
//   Shop.on(fn)                     события { type, ... } -> функция отписки. Типы: coins, grant, ad,
//                                   equip, unequip, preview — по ним игра меняет внешний вид
//   Shop.buy(id)                    за валюту; повторный клик -> reason 'owned'
//   await Shop.watchAd(id)          Platform.rewarded('shop-unlock'): +1 просмотр ТОЛЬКО по true, на
//                                   N-м — предмет открыт. Один запрос за раз, после неудачи — пауза
//                                   REWARDED_RETRY_SEC; прогресс никогда не уменьшается. Пока идёт общая пауза
//                                   между rewarded (Platform.rewardedCooldownLeft, REWARDED_COOLDOWN_SEC) карточка
//                                   неактивна, actionLabel / hint — «Через N с», card.adWait = N (reason 'cooldown')
//   Shop.equip(id) / unequip(slot)  надеть / снять; Shop.act(id) — основное действие карточки
//   Shop.addCoins(n, opts) / spend(n, opts)    валюта; Shop.coins
//   Shop.card(id) / cards(tab) / tabs()        модели вида
//   Shop.look() / preview(id) / clearPreview() что показывать на персонаже (надетое + примерка)
//   Shop.validate(catalog?)         правило пользователя: 5–6 вкладок, 20–50 предметов, ≈35/65
//   Shop.grant / owns / isExclusive / randomItem / exclusiveIds / name   — «приёмник наград» для
//                                   DailyGift и Wheel (можно подменить своим объектом с теми же методами)
// Реклама здесь — rewarded по правилам игры: id награды стабильный и без данных игрока, просмотры
// не раунды (Platform.ads.roundEnded не зовётся). Платформа не умеет сказать «рекламы нет заранее»:
// cfg.adsAvailable() — необязательная проверка игры (Playables: нет ytgame.ads — скрыть предложение).

/** @typedef {{ coins?: number, ads?: number }} ShopPrice */
/** @typedef {{ id: string, tab?: string, slot?: string, name?: any, price?: ShopPrice, rarity?: string, exclusive?: string, default?: boolean, [key: string]: any }} ShopItem */
/** @typedef {{ id: string, name?: any, [key: string]: any }} ShopTab */
/** @typedef {{ v: number, coins: number, owned: Record<string, number>, equipped: Record<string, string>, ads: Record<string, number> }} ShopState */

/** @satisfies {Record<string, any>} */
const Shop = {
    /** Тексты по умолчанию. При загрузке дополняют LANG_STRINGS (не затирая ключи игры); без Lang берутся отсюда. */
    TEXT: {
        ru: {
            'shop.adProgress': 'За рекламу {a}/{b}',
            'shop.watch': 'Посмотреть рекламу',
            'shop.buy': 'Купить',
            'shop.equip': 'Надеть',
            'shop.unequip': 'Снять',
            'shop.owned': 'Куплено',
            'shop.equipped': 'Надето',
            'shop.locked': 'Закрыто',
            'shop.exclusive': 'Эксклюзив',
            'shop.exclusive.daily': 'Подарок дня',
            'shop.noCoins': 'Не хватает монет: {n}',
            'shop.adUnavailable': 'Реклама сейчас недоступна. Попробуйте позже: прогресс сохранён.',
            'shop.adIn': 'Через {n} с',
            'shop.rarity.common': 'Обычный',
            'shop.rarity.uncommon': 'Необычный',
            'shop.rarity.rare': 'Редкий',
            'shop.rarity.epic': 'Эпический',
            'shop.rarity.legendary': 'Легендарный',
        },
        en: {
            'shop.adProgress': 'Watch ad {a}/{b}',
            'shop.watch': 'Watch ad',
            'shop.buy': 'Buy',
            'shop.equip': 'Equip',
            'shop.unequip': 'Take off',
            'shop.owned': 'Owned',
            'shop.equipped': 'Equipped',
            'shop.locked': 'Locked',
            'shop.exclusive': 'Exclusive',
            'shop.exclusive.daily': 'Daily Gift',
            'shop.noCoins': 'Not enough coins: {n}',
            'shop.adUnavailable': 'No ad right now. Try again later: your progress is saved.',
            'shop.adIn': 'In {n} s',
            'shop.rarity.common': 'Common',
            'shop.rarity.uncommon': 'Uncommon',
            'shop.rarity.rare': 'Rare',
            'shop.rarity.epic': 'Epic',
            'shop.rarity.legendary': 'Legendary',
        },
    },
    /** Редкости от обычной к легендарной (порядок = ценность). */
    RARITIES: ['common', 'uncommon', 'rare', 'epic', 'legendary'],
    /** Вес редкости в Shop.randomItem: обычное выпадает чаще. Данные, не настройка баланса. */
    RARITY_WEIGHT: { common: 8, uncommon: 5, rare: 3, epic: 1.5, legendary: 0.6 },

    /** @type {any} */
    _cfg: {},
    /** @type {ShopTab[]} */
    _tabs: [],
    /** @type {ShopItem[]} */
    _items: [],
    /** @type {Map<string, ShopItem>} */
    _byId: new Map(),
    /** @type {Array<(e: any) => void>} */
    _listeners: [],
    /** Примерка без покупки: слот -> id. Не сохраняется. @type {Record<string, string>} */
    _preview: {},
    _adBusy: false,
    _adRetryAt: 0,
    /** Сохраняемое состояние: кладётся в единое сохранение игры (save.shop = Shop.state). @type {ShopState} */
    state: { v: 1, coins: 0, owned: {}, equipped: {}, ads: {} },

    // =============================================================================================
    // Запуск и состояние
    // =============================================================================================

    /**
     * Подключить каталог и состояние. state — объект из сохранения игры (или undefined у нового
     * игрока): модуль приводит его к допустимому виду НА МЕСТЕ; после init он же — Shop.state.
     * @param {{ tabs?: ShopTab[], items?: ShopItem[], state?: any, persist?: (reason: string) => any, onChange?: (e: any) => void,
     *   now?: () => number, rng?: () => number, rewarded?: (id: string) => Promise<boolean>, adsAvailable?: () => boolean, autoEquip?: boolean }} [cfg]
     */
    init(cfg) {
        const c = cfg || {};
        this._cfg = c;
        this._listeners = typeof c.onChange === 'function' ? [c.onChange] : [];
        this._preview = {};
        this._adBusy = false;
        this._adRetryAt = 0;
        this._items = [];
        this._byId = new Map();
        for (const raw of Array.isArray(c.items) ? c.items : []) {
            if (!raw || typeof raw.id !== 'string' || !raw.id) { console.warn('Shop: предмет без id пропущен'); continue; }
            if (this._byId.has(raw.id)) { console.warn('Shop: повтор id «' + raw.id + '» пропущен'); continue; }
            const item = { ...raw };
            this._items.push(item);
            this._byId.set(item.id, item);
        }
        this._tabs = Array.isArray(c.tabs) && c.tabs.length ? c.tabs.map((t) => ({ ...t })) : this._deriveTabs(this._items);
        this.state = this._normalize(c.state);
        return this;
    },

    /** Привести сохранение к каталогу: надето только своё и в своём слоте, прогресс рекламы — только у закрытых предметов за рекламу. */
    _normalize(raw) {
        const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
        const dict = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
        s.v = 1;
        s.coins = this._int(s.coins);
        s.owned = dict(s.owned);
        s.equipped = dict(s.equipped);
        s.ads = dict(s.ads);
        // Неизвестные id владения (предмет убрали из каталога) не трогаем: вернётся — вернётся и владение.
        for (const it of this._items) if (it.default) s.owned[it.id] = 1;
        for (const slot of Object.keys(s.equipped)) {
            const it = this._byId.get(s.equipped[slot]);
            if (!it || !s.owned[it.id] || this.slotOf(it) !== slot) delete s.equipped[slot];
        }
        for (const it of this._items) {
            const slot = this.slotOf(it);
            if (it.default && !s.equipped[slot]) s.equipped[slot] = it.id;
        }
        for (const id of Object.keys(s.ads)) {
            const it = this._byId.get(id);
            const need = it ? this._int(it.price && it.price.ads) : 0;
            if (!it || !need || s.owned[id]) { delete s.ads[id]; continue; }
            const v = Math.min(this._int(s.ads[id]), need - 1);   // последний просмотр сразу открывает предмет
            if (v >= 1) s.ads[id] = v; else delete s.ads[id];
        }
        return s;
    },

    _deriveTabs(items) {
        const seen = new Set();
        const tabs = [];
        for (const it of items) {
            const id = it.tab || '';
            if (!seen.has(id)) { seen.add(id); tabs.push({ id }); }
        }
        return tabs;
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

    _rewarded(id) {
        if (typeof this._cfg.rewarded === 'function') return Promise.resolve(this._cfg.rewarded(id));
        return typeof Platform !== 'undefined' ? Platform.rewarded(id) : Promise.resolve(false);
    },

    /** Подписка на события; возвращает функцию отписки. */
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
            try { fn(e); } catch (err) { console.error('Shop: обработчик события «' + type + '»:', err); }
        }
    },

    /** Состояние изменилось — игра сохраняет свой объект целиком. */
    _save(reason) {
        const f = this._cfg.persist;
        if (typeof f !== 'function') return;
        try {
            const r = f(reason);
            if (r && typeof r.catch === 'function') r.catch((e) => console.warn('Shop: сохранение не удалось:', (e && e.message) || e));
        } catch (e) {
            console.warn('Shop: сохранение не удалось:', (e && e.message) || e);
        }
    },

    _fail(reason, id, extra) { return { ok: false, reason, id, ...extra }; },

    // =============================================================================================
    // Тексты
    // =============================================================================================

    _lang() {
        return typeof Lang !== 'undefined' ? Lang.code : (typeof GAME_LANG !== 'undefined' ? GAME_LANG : 'ru');
    },

    has(key) {
        return (typeof Lang !== 'undefined' && Lang.has(key)) || !!(this.TEXT[this._lang()] || this.TEXT.en)[key] || !!this.TEXT.en[key];
    },

    /** Строка по ключу Lang (с подстановкой {имя}); без Lang — из Shop.TEXT. */
    t(key, params) {
        if (typeof Lang !== 'undefined' && Lang.has(key)) return Lang.t(key, params);
        const s = (this.TEXT[this._lang()] || this.TEXT.en)[key] || this.TEXT.en[key] || key;
        return params ? s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)) : s;
    },

    /** Текст из данных игры: { ru, en } по языку сборки, ключ Lang — через Lang, иначе строка как есть. */
    text(value, fallback = '') {
        if (value == null) return fallback;
        if (typeof value === 'object') return String(value[this._lang()] || value.en || value.ru || fallback);
        const s = String(value);
        return typeof Lang !== 'undefined' && Lang.has(s) ? Lang.t(s) : s;
    },

    // =============================================================================================
    // Запросы
    // =============================================================================================

    get coins() { return this.state.coins; },

    /** Предмет каталога (копия данных игры) или undefined. */
    item(id) { return this._byId.get(id); },
    /** Все предметы каталога, по вкладке — если tab задана. */
    items(tab) { return tab == null ? this._items.slice() : this._items.filter((it) => it.tab === tab); },
    slotOf(it) { return it.slot || it.tab || ''; },
    owns(id) { return !!this.state.owned[id]; },
    equippedId(slot) { return this.state.equipped[slot] || null; },
    isEquipped(id) {
        const it = this._byId.get(id);
        return !!it && this.state.equipped[this.slotOf(it)] === id;
    },
    isExclusive(id) { const it = this._byId.get(id); return !!(it && it.exclusive); },
    /** id эксклюзивных предметов вида kind ('daily') в порядке каталога — очередь скинов дня 7. */
    exclusiveIds(kind = 'daily') { return this._items.filter((it) => it.exclusive === kind).map((it) => it.id); },
    /** Нужно просмотров рекламы для предмета (0 — предмет не за рекламу). */
    need(id) { const it = this._byId.get(id); return it ? this._int(it.price && it.price.ads) : 0; },
    /** Засчитанные просмотры (у купленного — все). */
    progress(id) {
        const need = this.need(id);
        if (!need) return 0;
        return this.state.owned[id] ? need : Math.min(need, this._int(this.state.ads[id]));
    },
    /** Название предмета на языке сборки. */
    name(id) {
        const it = this._byId.get(id);
        return it ? this.text(it.name, it.id) : String(id);
    },
    _defaultOf(slot) { return this._items.find((it) => it.default && this.slotOf(it) === slot) || null; },

    // =============================================================================================
    // Валюта
    // =============================================================================================

    /** Начислить валюту (заработок в раундах). opts: { reason, save: false } — не сохранять сразу. Возвращает баланс. */
    addCoins(n, opts) {
        const d = Math.floor(Number(n));
        if (!(d > 0)) return this.state.coins;
        this.state.coins = Math.min(this.state.coins + d, Number.MAX_SAFE_INTEGER);
        this._emit('coins', { coins: this.state.coins, delta: d, reason: (opts && opts.reason) || 'earn' });
        if (!opts || opts.save !== false) this._save('coins');
        return this.state.coins;
    },

    /** Потратить валюту не на предмет магазина. true — списано. */
    spend(n, opts) {
        const d = Math.floor(Number(n));
        if (!(d > 0) || this.state.coins < d) return false;
        this.state.coins -= d;
        this._emit('coins', { coins: this.state.coins, delta: -d, reason: (opts && opts.reason) || 'spend' });
        if (!opts || opts.save !== false) this._save('coins');
        return true;
    },

    // =============================================================================================
    // Владение и надетое
    // =============================================================================================

    _own(it, via) {
        this.state.owned[it.id] = 1;
        delete this.state.ads[it.id];
        this._emit('grant', { id: it.id, slot: this.slotOf(it), tab: it.tab, via });
    },

    /** Надеть без сохранения; снимает примерку слота. */
    _equip(it) {
        const slot = this.slotOf(it);
        const prev = this.state.equipped[slot] || null;
        if (slot in this._preview) {
            delete this._preview[slot];
            this._emit('preview', { slot, id: null });
        }
        if (prev === it.id) return { ok: true, id: it.id, slot, prev, changed: false };
        this.state.equipped[slot] = it.id;
        this._emit('equip', { id: it.id, slot, prev });
        return { ok: true, id: it.id, slot, prev, changed: true };
    },

    /**
     * Выдать предмет в обход цены (Daily Gift, колесо, туториал). true — выдан впервые; false — уже
     * есть или такого нет. Не надевает. opts: { reason, save: false }.
     */
    grant(id, opts) {
        const it = this._byId.get(id);
        if (!it || this.state.owned[id]) return false;
        this._own(it, (opts && opts.reason) || 'grant');
        if (!opts || opts.save !== false) this._save('grant');
        return true;
    },

    /** Купить за валюту. reason: unknown | owned | exclusive | notForSale | noCoins (+ missing). */
    buy(id) {
        const it = this._byId.get(id);
        if (!it) return this._fail('unknown', id);
        if (this.state.owned[id]) return this._fail('owned', id);
        if (it.exclusive) return this._fail('exclusive', id);
        const price = this._int(it.price && it.price.coins);
        if (!price) return this._fail('notForSale', id);
        if (this.state.coins < price) return this._fail('noCoins', id, { missing: price - this.state.coins });
        this.state.coins -= price;
        this._own(it, 'buy');
        this._emit('coins', { coins: this.state.coins, delta: -price, reason: 'buy', id });
        if (this._cfg.autoEquip !== false) this._equip(it);
        this._save('buy');
        return { ok: true, id, price, coins: this.state.coins };
    },

    /** Надеть купленное. reason: unknown | locked. changed: false — уже было надето. */
    equip(id) {
        const it = this._byId.get(id);
        if (!it) return this._fail('unknown', id);
        if (!this.state.owned[id]) return this._fail('locked', id);
        const r = this._equip(it);
        if (r.changed) this._save('equip');
        return r;
    },

    /** Снять предмет из слота; в слоте с предметом default вместо пустоты надевается он. */
    unequip(slot) {
        const prev = this.state.equipped[slot] || null;
        if (!prev) return { ok: false, reason: 'empty', slot };
        const def = this._defaultOf(slot);
        if (def && def.id === prev) return { ok: false, reason: 'default', slot };
        if (def) return this.equip(def.id);
        delete this.state.equipped[slot];
        if (slot in this._preview) delete this._preview[slot];
        this._emit('unequip', { slot, prev });
        this._save('unequip');
        return { ok: true, slot, prev, id: null, changed: true };
    },

    /** Основное действие карточки (card.action): надеть, снять, купить или посмотреть рекламу. Всегда await. */
    async act(id) {
        const c = this.card(id);
        if (!c) return this._fail('unknown', id);
        if (c.action === 'equip') return this.equip(id);
        if (c.action === 'unequip') return this.unequip(c.slot);
        if (c.action === 'buy') return this.buy(id);
        if (c.action === 'watch') return this.watchAd(id);
        return this._fail('none', id);
    },

    // =============================================================================================
    // Реклама за предмет
    // =============================================================================================

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
        return n > 0 ? this.t('shop.adIn', { n }) : '';
    },

    _adFail(reason, it) { return this._fail(reason, it.id, { progress: this.progress(it.id), need: this.need(it.id) }); },

    /**
     * Просмотр рекламы за предмет. ok: true — просмотр засчитан (progress/need, unlocked — открыт).
     * reason при ok: false: unknown | notAd | owned | busy | cooldown | adUnavailable | adFailed.
     * Прогресс не теряется ни при каком отказе; открытие — ровно один раз, на последнем просмотре.
     */
    async watchAd(id) {
        const it = this._byId.get(id);
        if (!it) return this._fail('unknown', id);
        if (it.exclusive || !this.need(id)) return this._fail('notAd', id);
        if (this.state.owned[id]) return this._adFail('owned', it);
        const block = this._adBlock();
        if (block) return this._adFail(block === 'unavailable' ? 'adUnavailable' : block, it);
        this._adBusy = true;
        let ok = false;
        try { ok = (await this._rewarded('shop-unlock')) === true; } catch (e) { ok = false; } finally { this._adBusy = false; }
        if (!ok) {
            this._adRetryAt = this._now() + this._retryMs();
            return this._adFail('adFailed', it);
        }
        this._adRetryAt = 0;
        return this.addAdView(id);   // за время рекламы предмет могли получить иначе — тогда просмотр не нужен
    },

    /** Один подтверждённый просмотр (после true от SDK). Свой рекламный поток игры зовёт это напрямую. */
    addAdView(id) {
        const it = this._byId.get(id);
        if (!it) return this._fail('unknown', id);
        const need = this.need(id);
        if (it.exclusive || !need) return this._fail('notAd', id);
        if (this.state.owned[id]) return this._adFail('owned', it);
        const p = Math.min(need, this.progress(id) + 1);
        if (p >= need) {
            this._own(it, 'ad');
            if (this._cfg.autoEquip !== false) this._equip(it);
            this._save('ad');
            return { ok: true, id, progress: need, need, unlocked: true };
        }
        this.state.ads[id] = p;
        this._emit('ad', { id, progress: p, need });
        this._save('ad');
        return { ok: true, id, progress: p, need, unlocked: false };
    },

    // =============================================================================================
    // Модели вида
    // =============================================================================================

    /**
     * Карточка предмета для интерфейса игры.
     *   state: 'locked' | 'owned' | 'equipped';  kind: 'coins' | 'ads' | 'exclusive' | 'free'
     *   priceLabel: «120» | «За рекламу 2/5» | «Подарок дня» | «Куплено» | «Надето»
     *   action: 'equip' | 'unequip' | 'buy' | 'watch' | 'none';  enabled — можно ли выполнить сейчас;
     *   actionLabel — текст кнопки; hint — почему действие недоступно (пусто, если доступно)
     *   adWait — секунд до новой попытки рекламы (0 — можно; общая пауза между rewarded или пауза после неудачи),
     *   busy — реклама сейчас идёт. Общая пауза: enabled = false, actionLabel и hint — «Через N с»
     */
    card(id) {
        const it = this._byId.get(id);
        if (!it) return null;
        const slot = this.slotOf(it);
        const owned = !!this.state.owned[id];
        const equipped = this.state.equipped[slot] === id;
        const coins = this._int(it.price && it.price.coins);
        const need = this.need(id);
        const kind = it.exclusive ? 'exclusive' : coins > 0 ? 'coins' : need > 0 ? 'ads' : 'free';
        const progress = this.progress(id);
        const block = kind === 'ads' && !owned ? this._adBlock() : null;
        const exKey = 'shop.exclusive.' + it.exclusive;
        const exLabel = this.has(exKey) ? this.t(exKey) : this.t('shop.exclusive');
        let action = 'none';
        let enabled = false;
        let hint = '';
        if (owned) {
            if (!equipped) { action = 'equip'; enabled = true; }
            else {
                const def = this._defaultOf(slot);
                if (!(def && def.id === id)) { action = 'unequip'; enabled = true; }
            }
        } else if (kind === 'coins') {
            action = 'buy';
            enabled = this.state.coins >= coins;
            if (!enabled) hint = this.t('shop.noCoins', { n: coins - this.state.coins });
        } else if (kind === 'ads') {
            action = 'watch';
            enabled = !block;
            // общая пауза между rewarded дольше паузы после неудачи — «Через N с»; иначе «реклама сейчас недоступна»
            if (block === 'cooldown' && this._globalWaitSec() > this._retryWaitSec()) hint = this.adWaitLabel();
            else if (block === 'cooldown' || block === 'unavailable') hint = this.t('shop.adUnavailable');
        } else if (kind === 'exclusive') {
            hint = exLabel;
        }
        const priceLabel = owned ? this.t(equipped ? 'shop.equipped' : 'shop.owned')
            : kind === 'coins' ? String(coins)
            : kind === 'ads' ? this.t('shop.adProgress', { a: progress, b: need })
            : kind === 'exclusive' ? exLabel : '';
        const actionLabel = action === 'equip' ? this.t('shop.equip')
            : action === 'unequip' ? this.t('shop.unequip')
            : action === 'buy' ? this.t('shop.buy')
            : action === 'watch' ? (block === 'cooldown' && this._globalWaitSec() > this._retryWaitSec() ? this.adWaitLabel() : this.t('shop.watch'))
            : equipped ? this.t('shop.equipped') : '';
        return {
            id, tab: it.tab, slot, item: it,
            name: this.name(id),
            rarity: it.rarity || '',
            rarityLabel: this.rarityLabel(it.rarity),
            exclusive: it.exclusive || '',
            kind,
            state: owned ? (equipped ? 'equipped' : 'owned') : 'locked',
            owned, equipped,
            price: coins, need, progress,
            priceLabel, action, actionLabel, enabled, hint,
            affordable: kind === 'coins' ? this.state.coins >= coins : false,
            busy: this._adBusy,
            adWait: block === 'cooldown' ? this.adWaitSec() : 0,
        };
    },

    /** Карточки вкладки в порядке каталога. opts.lockedExclusive: false — спрятать эксклюзивы, которых ещё нет. */
    cards(tab, opts) {
        const showLocked = !opts || opts.lockedExclusive !== false;
        return this._items
            .filter((it) => it.tab === tab && (showLocked || !it.exclusive || this.state.owned[it.id]))
            .map((it) => this.card(it.id));
    },

    /** Вкладки: { id, name, count, owned, data } — data это запись вкладки из данных игры. */
    tabs() {
        return this._tabs.map((t) => {
            const list = this._items.filter((it) => it.tab === t.id);
            return { id: t.id, name: this.text(t.name, t.id), count: list.length, owned: list.filter((it) => this.state.owned[it.id]).length, data: t };
        });
    },

    rarityLabel(rarity) {
        if (!rarity) return '';
        const key = 'shop.rarity.' + rarity;
        return this.has(key) ? this.t(key) : String(rarity);
    },

    /** Примерить предмет (любой, даже закрытый) на персонаже; не сохраняется. null — снять примерку слота предмета. */
    preview(id) {
        const it = this._byId.get(id);
        if (!it) return false;
        const slot = this.slotOf(it);
        this._preview[slot] = id;
        this._emit('preview', { slot, id });
        return true;
    },

    /** Снять примерку слота (без аргумента — всех слотов). */
    clearPreview(slot) {
        const slots = slot == null ? Object.keys(this._preview) : [slot];
        for (const s of slots) {
            if (!(s in this._preview)) continue;
            delete this._preview[s];
            this._emit('preview', { slot: s, id: null });
        }
    },

    /** Что показывать на персонаже: { слот: id | null } — надетое, поверх него примерка. */
    look() {
        const out = {};
        for (const it of this._items) out[this.slotOf(it)] = null;
        for (const slot of Object.keys(out)) out[slot] = this._preview[slot] || this.state.equipped[slot] || null;
        return out;
    },

    // =============================================================================================
    // Награды из магазина (для DailyGift и Wheel)
    // =============================================================================================

    /**
     * Случайный предмет, который игрок может получить из магазина (не эксклюзив, с ценой): id или null.
     * opts: { notOwned (true), maxRarity, tab, rng }. Обычные редкости выпадают чаще (RARITY_WEIGHT).
     */
    randomItem(opts) {
        const o = opts || {};
        const maxRank = this.RARITIES.indexOf(o.maxRarity) >= 0 ? this.RARITIES.indexOf(o.maxRarity) : this.RARITIES.length - 1;
        const weights = this._cfg.rarityWeight || this.RARITY_WEIGHT;
        const pool = this._items.filter((it) => !it.exclusive && !it.default
            && (this._int(it.price && it.price.coins) > 0 || this.need(it.id) > 0)
            && (o.tab == null || it.tab === o.tab)
            && Math.max(0, this.RARITIES.indexOf(it.rarity)) <= maxRank
            && (o.notOwned === false || !this.state.owned[it.id]));
        if (!pool.length) return null;
        const rng = typeof o.rng === 'function' ? o.rng : () => this._rng();
        const w = (it) => (weights[it.rarity] > 0 ? weights[it.rarity] : 1);
        let total = 0;
        for (const it of pool) total += w(it);
        let r = Math.min(0.999999999, Math.max(0, rng())) * total;
        for (const it of pool) { r -= w(it); if (r < 0) return it.id; }
        return pool[pool.length - 1].id;
    },

    // =============================================================================================
    // Проверка каталога
    // =============================================================================================

    _limits() {
        const U = 'undefined';
        return {
            tabsMin: typeof SHOP_TABS_MIN !== U ? SHOP_TABS_MIN : 5,
            tabsMax: typeof SHOP_TABS_MAX !== U ? SHOP_TABS_MAX : 6,
            itemsMin: typeof SHOP_ITEMS_MIN !== U ? SHOP_ITEMS_MIN : 20,
            itemsMax: typeof SHOP_ITEMS_MAX !== U ? SHOP_ITEMS_MAX : 50,
            coinsShare: typeof SHOP_COINS_SHARE !== U ? SHOP_COINS_SHARE : 35,
            tolerance: typeof SHOP_SHARE_TOLERANCE !== U ? SHOP_SHARE_TOLERANCE : 10,
            adsMin: typeof SHOP_ADS_MIN !== U ? SHOP_ADS_MIN : 1,
            adsMax: typeof SHOP_ADS_MAX !== U ? SHOP_ADS_MAX : 5,
        };
    },

    /**
     * Сверить каталог с правилом пользователя: 5–6 вкладок, 20–50 предметов в каждой, ≈35% за
     * валюту и ≈65% за рекламу (1–5 просмотров). catalog — { tabs, items } (по умолчанию — подключённый).
     * Возвращает { ok, tabs, items, perTab: [{ id, items, priced, coins, ads, coinsPct, adsPct }],
     * problems: [{ code, message, tab?, id? }], warnings: [...] } — отчёт для проверки данных игры.
     */
    validate(catalog) {
        const cat = catalog || { tabs: this._tabs, items: this._items };
        const items = Array.isArray(cat.items) ? cat.items : [];
        const tabs = Array.isArray(cat.tabs) && cat.tabs.length ? cat.tabs : this._deriveTabs(items);
        const L = this._limits();
        /** @type {Array<{ code: string, message: string, tab?: string, id?: string }>} */
        const problems = [];
        /** @type {Array<{ code: string, message: string, tab?: string, id?: string }>} */
        const warnings = [];
        const seen = new Set();
        const tabIds = new Set(tabs.map((t) => t.id));
        const int = (v) => Math.max(0, Math.floor(Number(v)) || 0);

        if (tabs.length < L.tabsMin || tabs.length > L.tabsMax) {
            problems.push({ code: 'tabs', message: 'Вкладок ' + tabs.length + ', нужно ' + L.tabsMin + '–' + L.tabsMax });
        }
        for (const it of items) {
            if (seen.has(it.id)) problems.push({ code: 'duplicateId', id: it.id, message: 'Повтор id «' + it.id + '»' });
            seen.add(it.id);
            if (!tabIds.has(it.tab)) problems.push({ code: 'unknownTab', id: it.id, tab: it.tab, message: 'Предмет «' + it.id + '»: вкладки «' + it.tab + '» нет' });
            const coins = int(it.price && it.price.coins), ads = int(it.price && it.price.ads);
            if (it.price && it.price.coins != null && !coins) problems.push({ code: 'price', id: it.id, message: 'Предмет «' + it.id + '»: цена в валюте должна быть больше нуля' });
            if (ads && (ads < L.adsMin || ads > L.adsMax)) {
                problems.push({ code: 'adsRange', id: it.id, message: 'Предмет «' + it.id + '»: просмотров рекламы ' + ads + ', нужно ' + L.adsMin + '–' + L.adsMax });
            }
            if (it.price && it.price.ads != null && !ads) problems.push({ code: 'price', id: it.id, message: 'Предмет «' + it.id + '»: число просмотров рекламы должно быть больше нуля' });
            if (coins && ads) warnings.push({ code: 'bothPrices', id: it.id, message: 'Предмет «' + it.id + '»: задана и валюта, и реклама (считается валюта)' });
            if (it.exclusive && (coins || ads)) warnings.push({ code: 'exclusivePrice', id: it.id, message: 'Предмет «' + it.id + '»: эксклюзив с ценой — он всё равно не продаётся' });
            if (!it.exclusive && !it.default && !coins && !ads) warnings.push({ code: 'noPrice', id: it.id, message: 'Предмет «' + it.id + '»: без цены, купить его нельзя' });
            if (it.rarity && this.RARITIES.indexOf(it.rarity) < 0) warnings.push({ code: 'rarity', id: it.id, message: 'Предмет «' + it.id + '»: неизвестная редкость «' + it.rarity + '»' });
        }
        const perTab = tabs.map((t) => {
            const list = items.filter((it) => it.tab === t.id);
            let coins = 0, ads = 0;
            for (const it of list) {
                if (it.exclusive || it.default) continue;
                if (int(it.price && it.price.coins) > 0) coins++;
                else if (int(it.price && it.price.ads) > 0) ads++;
            }
            const priced = coins + ads;
            const coinsPct = priced ? Math.round((coins / priced) * 100) : 0;
            const row = { id: t.id, items: list.length, priced, coins, ads, coinsPct, adsPct: priced ? 100 - coinsPct : 0 };
            if (list.length < L.itemsMin || list.length > L.itemsMax) {
                problems.push({ code: 'tabItems', tab: t.id, message: 'Вкладка «' + t.id + '»: предметов ' + list.length + ', нужно ' + L.itemsMin + '–' + L.itemsMax });
            }
            if (!priced || Math.abs(coinsPct - L.coinsShare) > L.tolerance) {
                problems.push({ code: 'split', tab: t.id, message: 'Вкладка «' + t.id + '»: за валюту ' + coinsPct + '%, за рекламу ' + (priced ? 100 - coinsPct : 0) + '%, нужно около ' + L.coinsShare + '% / ' + (100 - L.coinsShare) + '% (допуск ±' + L.tolerance + ')' });
            }
            return row;
        });
        return { ok: problems.length === 0, tabs: tabs.length, items: items.length, perTab, problems, warnings };
    },
};

// Тексты по умолчанию кладём в LANG_STRINGS, не затирая то, что игра уже задала в своём Lang.js.
if (typeof LANG_STRINGS !== 'undefined') {
    for (const code of Object.keys(Shop.TEXT)) {
        const dict = LANG_STRINGS[code];
        if (!dict) continue;
        for (const key of Object.keys(Shop.TEXT[code])) if (!(key in dict)) dict[key] = Shop.TEXT[code][key];
    }
}
