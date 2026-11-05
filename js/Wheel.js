// Wheel.js — колесо фортуны: секторы с весами, бесплатное вращение раз в день, вращения за рекламу.
// ЛОГИКА БЕЗ ИНТЕРФЕЙСА: диск, стрелку и анимацию рисует игра; модуль выбирает результат, отдаёт
// целевой угол и сектор и сам следит, чтобы приз был выдан ровно один раз. Опт-ин: до Wheel.init
// ничего не делает.
//
// ПРАВИЛА (личные требования пользователя):
//   · одно бесплатное вращение в календарный день устройства + WHEEL_AD_SPINS_PER_DAY за рекламу
//     (Platform.rewarded('wheel-spin'), считается только по true; запросы по одному); пока идёт общая пауза
//     между rewarded (Platform.rewardedCooldownLeft) вращение за рекламу неактивно, status().adLabel — «Через N с»
//     (adWait = N, spinAd() -> reason 'cooldown');
//   · результат выбирается ДО анимации (spinFree/spinAd), диск должен остановиться на нём: угол и
//     сектор возвращает вращение; приз выдаёт finish() — ровно один раз;
//   · вращение хранится в сохранении как «ожидающее» (state.pending): свернули вкладку или
//     перезагрузили страницу посреди вращения — при следующем Wheel.init приз выдаётся сам
//     (событие prize с recovered: true), второй раз — никогда. Нужен rewardsSink; без него (или с
//     recover: false) игра сама смотрит pendingSpin() и вызывает finish();
//   · призы: в основном валюта, реже предмет магазина; уже имеющийся предмет заменяется валютой
//     (WHEEL_DUP_COINS); эксклюзивный скин Daily Gift (Shop: exclusive) выпасть не может;
//   · до вращения видны все секторы и их призы (sectors()), на кнопке — доступность и таймер.
//
// ПОДКЛЮЧЕНИЕ (после Shop.init; save — единый объект сохранения игры):
//   Wheel.init({
//       sectors: [{ coins: 10, weight: 24 }, { coins: 25, weight: 20 }, { coins: 50, weight: 12 }, { coins: 150, weight: 3 },
//                 { randomItem: true, weight: 8 }, { item: 'hat_crown', weight: 2 }],
//       rewardsSink: Shop, state: save.wheel, persist: () => Platform.save(save),
//   });
//   save.wheel = Wheel.state;
//   const s = Wheel.status();                   // freeLabel / adLabel / canSpinFree / canSpinAd / pending
//   const r = Wheel.spinFree();                 // или await Wheel.spinAd(): { ok, sector, angle, prize, durationMs }
//   // анимация: диск (CSS rotate, по часовой) крутится до r.angle (или Wheel.angleFrom(текущий, r))
//   Wheel.finish();                             // по окончании анимации: начисляет приз, один раз
//
// СЕКТОР (данные игры): { weight, coins | item: 'id' | randomItem: true, maxRarity?, dupCoins?, ...свои поля }.
// randomItem — предмет магазина, выбранный раз в сутки (не эксклюзив, которого у игрока нет).
// Геометрия: секторы равны по углу (360 / число секторов), сектор 0 — под стрелкой сверху при
// угле 0, дальше по часовой. Угол диска — градусы по часовой (CSS rotate). Порядок обращений к rng:
// случайные предметы дня (по разу в сутки на сектор) -> сектор -> смещение внутри сектора.
// rewardsSink: addCoins(n, { reason, save }), owns(id), grant(id, { reason, save }), isExclusive(id),
// randomItem({ rng, maxRarity }), name(id), item(id) — Shop подходит как есть; без него модуль только считает.
// События (Wheel.on): spin { kind, sector, angle, prize, ... }, prize { prize, got, recovered }.
// Состояние { v, day, free, ads, banked, items, pending } — JSON внутри единого сохранения (save.wheel).

/** @typedef {{ weight?: number, coins?: number, item?: string, randomItem?: boolean, maxRarity?: string, dupCoins?: number, [key: string]: any }} WheelSector */
/** @typedef {{ v: number, day: string, free: number, ads: number, banked: number, items: Record<string, string>, pending: any }} WheelState */

/** @satisfies {Record<string, any>} */
const Wheel = {
    /** Тексты по умолчанию. При загрузке дополняют LANG_STRINGS (не затирая ключи игры); без Lang берутся отсюда. */
    TEXT: {
        ru: {
            'wheel.free': 'Крутить бесплатно',
            'wheel.freeIn': 'Бесплатно через {t}',
            'wheel.ad': 'За рекламу: ещё вращение (осталось {a} из {b})',
            'wheel.noSpins': 'Вращения на сегодня закончились. Приходи завтра!',
            'wheel.spinning': 'Крутится…',
            'wheel.adUnavailable': 'Реклама сейчас недоступна. Попробуйте позже.',
            'wheel.adIn': 'Через {n} с',
            'wheel.win': 'Выигрыш!',
            'reward.coins': 'Монеты: {n}',
            'reward.item': 'Предмет: {name}',
            'reward.dup': 'Такой предмет уже есть, монеты: {n}',
        },
        en: {
            'wheel.free': 'Spin for free',
            'wheel.freeIn': 'Free in {t}',
            'wheel.ad': 'Watch ad: spin again ({a} of {b} left)',
            'wheel.noSpins': 'No spins left today. Come back tomorrow!',
            'wheel.spinning': 'Spinning…',
            'wheel.adUnavailable': 'No ad right now. Try again later.',
            'wheel.adIn': 'In {n} s',
            'wheel.win': 'You won!',
            'reward.coins': 'Coins: {n}',
            'reward.item': 'Item: {name}',
            'reward.dup': 'You already have this item, coins: {n}',
        },
    },

    /** @type {any} */
    _cfg: {},
    /** @type {WheelSector[]} */
    _sectors: [],
    /** @type {Array<(e: any) => void>} */
    _listeners: [],
    _adBusy: false,
    _adRetryAt: 0,
    /** Сохраняемое состояние. pending — вращение, чей приз ещё не выдан: { kind, sector, offset, turns, prize, at }. @type {WheelState} */
    state: { v: 1, day: '', free: 0, ads: 0, banked: 0, items: {}, pending: null },

    // =============================================================================================
    // Запуск и состояние
    // =============================================================================================

    /**
     * @param {{ sectors?: WheelSector[], rewardsSink?: any, state?: any, persist?: (reason: string) => any, onChange?: (e: any) => void,
     *   now?: () => number, rng?: () => number, rewarded?: (id: string) => Promise<boolean>, adsAvailable?: () => boolean,
     *   adSpinsPerDay?: number, turns?: number, dupCoins?: number, recover?: boolean }} [cfg]
     * recover: false — ожидающий приз не выдавать в init, а показать игре (pendingSpin) и вызвать finish() самой.
     */
    init(cfg) {
        const c = cfg || {};
        this._cfg = c;
        this._listeners = typeof c.onChange === 'function' ? [c.onChange] : [];
        this._adBusy = false;
        this._adRetryAt = 0;
        this._sectors = (Array.isArray(c.sectors) ? c.sectors : []).map((raw) => this._sector(raw));
        if (this._sectors.length < 2) console.warn('Wheel: для колеса нужно хотя бы два сектора');
        this.state = this._normalize(c.state);
        this._sync();
        if (this.state.pending && c.recover !== false && this._sink()) this.finish({ recovered: true });
        return this;
    },

    _sector(raw) {
        const r = raw && typeof raw === 'object' ? { ...raw } : {};
        r.weight = r.weight == null ? 1 : Math.max(0, Number(r.weight) || 0);
        r.coins = this._int(r.coins);
        r.item = typeof r.item === 'string' ? r.item : '';
        r.randomItem = !!r.randomItem;
        return r;
    },

    _normalize(raw) {
        const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
        s.v = 1;
        s.day = typeof s.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.day) ? s.day : '';
        s.free = s.free ? 1 : 0;
        s.ads = this._int(s.ads);
        s.banked = this._int(s.banked);
        s.items = s.items && typeof s.items === 'object' && !Array.isArray(s.items) ? s.items : {};
        s.pending = this._pendingOf(s.pending);
        return s;
    },

    /** Ожидающее вращение из сохранения: целое или null (повреждённая запись не должна ни выдать мусор, ни заблокировать колесо). */
    _pendingOf(p) {
        if (!p || typeof p !== 'object' || !p.prize || typeof p.prize !== 'object') return null;
        const t = p.prize.type;
        if (t !== 'coins' && t !== 'item') return null;
        if (t === 'coins' && !(Number(p.prize.amount) >= 0)) return null;
        if (t === 'item' && (typeof p.prize.id !== 'string' || !p.prize.id)) return null;
        const last = Math.max(0, this._sectors.length - 1);
        return {
            kind: p.kind === 'ad' ? 'ad' : 'free',
            sector: Math.min(last, this._int(p.sector)),
            offset: Number.isFinite(Number(p.offset)) ? Number(p.offset) : 0,
            turns: this._int(p.turns),
            prize: p.prize,
            at: Number.isFinite(Number(p.at)) ? Number(p.at) : 0,
        };
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

    /** Вращений за рекламу в день. */
    adLimit() {
        return this._int(this._cfg.adSpinsPerDay != null ? this._cfg.adSpinsPerDay : (typeof WHEEL_AD_SPINS_PER_DAY !== 'undefined' ? WHEEL_AD_SPINS_PER_DAY : 3));
    },
    _turns() { return this._int(this._cfg.turns != null ? this._cfg.turns : (typeof WHEEL_TURNS !== 'undefined' ? WHEEL_TURNS : 6)); },
    _spinMs() { return (typeof WHEEL_SPIN_SEC !== 'undefined' ? WHEEL_SPIN_SEC : 5.5) * 1000; },
    _spread() { return typeof WHEEL_LAND_SPREAD !== 'undefined' ? WHEEL_LAND_SPREAD : 0.32; },
    _dupCoins(sec) {
        if (sec && sec.dupCoins != null) return this._int(sec.dupCoins);
        return this._int(this._cfg.dupCoins != null ? this._cfg.dupCoins : (typeof WHEEL_DUP_COINS !== 'undefined' ? WHEEL_DUP_COINS : 75));
    },

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
            try { fn(e); } catch (err) { console.error('Wheel: обработчик события «' + type + '»:', err); }
        }
    },

    _save(reason) {
        const f = this._cfg.persist;
        if (typeof f !== 'function') return;
        try {
            const r = f(reason);
            if (r && typeof r.catch === 'function') r.catch((e) => console.warn('Wheel: сохранение не удалось:', (e && e.message) || e));
        } catch (e) {
            console.warn('Wheel: сохранение не удалось:', (e && e.message) || e);
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

    /** «ЧЧ:ММ:СС» из миллисекунд (таймер до бесплатного вращения). */
    formatTime(ms) {
        const sec = Math.max(0, Math.ceil(ms / 1000));
        const p = (n) => (n < 10 ? '0' : '') + n;
        return p(Math.floor(sec / 3600)) + ':' + p(Math.floor((sec % 3600) / 60)) + ':' + p(sec % 60);
    },

    itemName(id) {
        const sink = this._sink();
        return sink && typeof sink.name === 'function' ? sink.name(id) : String(id);
    },

    /** Подпись приза: «Монеты: 50», «Предмет: Корона», «Такой предмет уже есть, монеты: 75». */
    prizeLabel(prize) {
        if (prize.type === 'item') return this.t('reward.item', { name: this.itemName(prize.id) });
        return this.t(prize.converted ? 'reward.dup' : 'reward.coins', { n: prize.amount });
    },

    // =============================================================================================
    // Календарь: одно бесплатное вращение в календарный день (локальная дата устройства)
    // =============================================================================================

    dateKey(ms) {
        const d = new Date(ms == null ? this._now() : ms);
        const p = (n, w) => String(n).padStart(w, '0');
        return p(d.getFullYear(), 4) + '-' + p(d.getMonth() + 1, 2) + '-' + p(d.getDate(), 2);
    },
    today() { return this.dateKey(); },
    /** Миллисекунд до ближайшей локальной полуночи — когда вернётся бесплатное вращение. */
    msToNextDay(ms) {
        const d = new Date(ms == null ? this._now() : ms);
        return Math.max(0, new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - d.getTime());
    },

    /** Новые сутки — счётчики дня и предметы секторов сбрасываются. Ожидающий приз и оплаченные вращения остаются. */
    _sync() {
        const today = this.today();
        const s = this.state;
        if (s.day === today) return;
        s.day = today;
        s.free = 0;
        s.ads = 0;
        s.items = {};
    },

    // =============================================================================================
    // Секторы и геометрия
    // =============================================================================================

    /** Угол одного сектора, градусы. */
    step() { return 360 / Math.max(1, this._sectors.length); },

    /** Угол диска (по часовой), при котором под стрелкой оказывается точка sector + offset (offset — доля сектора). Диапазон 0..360. */
    landing(sector, offset = 0) {
        return ((-(sector + offset) * this.step()) % 360 + 360) % 360;
    },

    /** Сектор под стрелкой при повороте диска на angle градусов по часовой. */
    sectorAt(angle) {
        const a = (((-angle) % 360) + 360) % 360;
        return Math.floor((a + this.step() / 2) / this.step()) % Math.max(1, this._sectors.length);
    },

    /**
     * Целевой угол для анимации от текущего угла диска: не меньше turns оборотов вперёд и ровно на
     * результате. res — ответ spinFree()/spinAd() или pendingSpin().
     */
    angleFrom(current, res) {
        const base = -(res.sector + res.offset) * this.step();
        const min = current + res.turns * 360;
        return base + Math.ceil((min - base) / 360) * 360;
    },

    /** Предмет сектора «случайный предмет магазина» на сегодня: выбирается один раз в сутки и хранится в сохранении. '' — нечего выдать. */
    _dayItem(i) {
        const s = this.state;
        if (s.items[i] == null) {
            const sink = this._sink();
            let id = '';
            if (sink && typeof sink.randomItem === 'function') id = sink.randomItem({ notOwned: true, maxRarity: this._sectors[i].maxRarity, rng: () => this._rng() }) || '';
            s.items[i] = id || '-';
        }
        return s.items[i] === '-' ? '' : s.items[i];
    },

    _isExclusive(id) {
        const sink = this._sink();
        return !!(sink && typeof sink.isExclusive === 'function' && sink.isExclusive(id));
    },

    _owns(id) {
        const sink = this._sink();
        return !!(sink && typeof sink.owns === 'function' && sink.owns(id));
    },

    /** Предмет есть в каталоге приёмника наград (если приёмник умеет отвечать на item(id)); иначе выдать его всё равно нечем. */
    _known(id) {
        const sink = this._sink();
        return !(sink && typeof sink.item === 'function') || !!sink.item(id);
    },

    /** Приз сектора на сейчас: предмет или валюта; имеющийся, эксклюзивный и неизвестный каталогу предмет заменён валютой. */
    _resolve(i) {
        const sec = this._sectors[i];
        if (!sec.item && !sec.randomItem) return { type: 'coins', amount: sec.coins };
        const id = sec.randomItem ? this._dayItem(i) : sec.item;
        if (id && !this._isExclusive(id) && !this._owns(id) && this._known(id)) return { type: 'item', id };
        return { type: 'coins', amount: this._dupCoins(sec), converted: true, fromItem: id || '' };
    },

    /**
     * Все секторы для отрисовки: { index, angle (центр сектора), weight, chance (%), prize, kind, itemId,
     * coins, converted, label, data (запись сектора из данных игры) } — со вчерашним/сегодняшним
     * состоянием: сектор с уже имеющимся предметом показывается как валюта.
     */
    sectors() {
        this._sync();
        let total = 0;
        for (const sec of this._sectors) total += sec.weight;
        return this._sectors.map((sec, i) => {
            const prize = this._resolve(i);
            return {
                index: i, angle: i * this.step(), weight: sec.weight,
                chance: total > 0 ? (sec.weight / total) * 100 : 0,
                prize, kind: prize.type, itemId: prize.type === 'item' ? prize.id : '',
                coins: prize.type === 'coins' ? prize.amount : 0,
                converted: !!prize.converted, label: this.prizeLabel(prize), data: sec,
            };
        });
    },

    /** Сектор по весам: rng() в [0, 1); сектор с нулевым весом не выпадает. */
    _pick() {
        const list = this._sectors;
        let total = 0;
        for (const sec of list) total += sec.weight;
        if (!(total > 0)) return 0;
        let r = Math.min(0.999999999999, Math.max(0, this._rng())) * total;
        let lastPositive = 0;
        for (let i = 0; i < list.length; i++) {
            if (list[i].weight <= 0) continue;
            lastPositive = i;
            r -= list[i].weight;
            if (r < 0) return i;
        }
        return lastPositive;
    },

    // =============================================================================================
    // Вращения
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
        return n > 0 ? this.t('wheel.adIn', { n }) : '';
    },

    _fail(reason, extra) { return { ok: false, reason, ...extra }; },

    /** Бесплатное вращение (раз в календарный день). reason: noSectors | pending | noFree (+ nextFreeMs). */
    spinFree() {
        this._sync();
        const s = this.state;
        if (this._sectors.length < 2) return this._fail('noSectors');
        if (s.pending) return this._fail('pending', { pending: this.pendingSpin() });
        if (s.free) return this._fail('noFree', { nextFreeMs: this.msToNextDay() });
        s.free = 1;
        return this._start('free');
    },

    /**
     * Вращение за рекламу: Platform.rewarded('wheel-spin'), вращение — только после true. Лимит в день —
     * WHEEL_AD_SPINS_PER_DAY. reason: noSectors | pending | limit | busy | cooldown | adUnavailable |
     * adFailed. Просмотренная реклама не пропадает: если вращение не началось, оно ждёт в state.banked.
     */
    async spinAd() {
        this._sync();
        const s = this.state;
        if (this._sectors.length < 2) return this._fail('noSectors');
        if (s.pending) return this._fail('pending', { pending: this.pendingSpin() });
        if (s.banked > 0) { s.banked--; return this._start('ad'); }   // оплаченное, но не начатое вращение — без новой рекламы
        if (s.ads >= this.adLimit()) return this._fail('limit');
        const block = this._adBlock();
        if (block) return this._fail(block === 'unavailable' ? 'adUnavailable' : block);
        this._adBusy = true;
        let ok = false;
        try { ok = (await this._rewarded('wheel-spin')) === true; } catch (e) { ok = false; } finally { this._adBusy = false; }
        if (!ok) {
            this._adRetryAt = this._now() + this._retryMs();
            return this._fail('adFailed');
        }
        this._adRetryAt = 0;
        this._sync();   // пока шла реклама, могли начаться новые сутки
        s.ads++;
        if (s.pending) {   // вращение уже идёт (интерфейс не заблокировал кнопку): просмотр запоминаем
            s.banked++;
            this._save('banked');
            return this._fail('pending', { banked: true, pending: this.pendingSpin() });
        }
        return this._start('ad');
    },

    /** Выбрать результат и запомнить его ДО анимации. Вызывается после списания вращения. */
    _start(kind) {
        const s = this.state;
        for (let i = 0; i < this._sectors.length; i++) if (this._sectors[i].randomItem) this._dayItem(i);
        const sector = this._pick();
        const offset = (this._rng() * 2 - 1) * this._spread();
        const prize = this._resolve(sector);
        s.pending = { kind, sector, offset, turns: this._turns(), prize, at: this._now() };
        const result = this._spinView(s.pending);
        this._emit('spin', result);
        this._save('spin');
        return result;
    },

    /** Вид вращения для интерфейса: куда крутить диск и что выпало. */
    _spinView(p) {
        const landing = this.landing(p.sector, p.offset);
        const durationMs = this._spinMs();
        const elapsedMs = Math.max(0, this._now() - p.at);
        return {
            ok: true, kind: p.kind, sector: p.sector, offset: p.offset, turns: p.turns,
            angle: p.turns * 360 + landing, landing, durationMs,
            prize: { ...p.prize }, label: this.prizeLabel(p.prize),
            startedAt: p.at, elapsedMs, stale: elapsedMs >= durationMs,
        };
    },

    /** Вращение, приз которого ещё не выдан (анимация идёт или вкладку закрыли), или null. stale — по времени анимация уже кончилась. */
    pendingSpin() {
        return this.state.pending ? this._spinView(this.state.pending) : null;
    },

    /** Приз через приёмник; got — что получил игрок. Предмет, который уже есть (или эксклюзив), становится валютой. */
    _grant(prize) {
        const sink = this._sink();
        const got = [];
        const coins = (n, extra) => {
            if (sink && typeof sink.addCoins === 'function') sink.addCoins(n, { reason: 'wheel', save: false });
            got.push({ type: 'coins', amount: n, ...extra });
        };
        try {
            if (prize.type === 'item') {
                const ok = !this._isExclusive(prize.id) && !this._owns(prize.id)
                    && !!(sink && typeof sink.grant === 'function' && sink.grant(prize.id, { reason: 'wheel', save: false }));
                if (ok) got.push({ type: 'item', id: prize.id });
                else coins(this._dupCoins(null), { converted: true, fromItem: prize.id });
            } else {
                coins(this._int(prize.amount), prize.converted ? { converted: true, fromItem: prize.fromItem || '' } : null);
            }
        } catch (e) {
            console.error('Wheel: приз выдан не полностью:', e);
        }
        return got;
    },

    /**
     * Анимация закончена (или страница загружена с ожидающим призом): начислить приз. Идемпотентна:
     * ожидающее вращение снимается ДО выдачи, поэтому второй вызов вернёт { ok: false, reason: 'none' }.
     * Приз и снятие вращения сохраняются одним persist — после сбоя между ними приз либо выдан, либо ещё ждёт.
     */
    finish(opts) {
        const s = this.state;
        const p = s.pending;
        if (!p) return this._fail('none');
        s.pending = null;
        const got = this._grant(p.prize);
        const result = { ok: true, kind: p.kind, sector: p.sector, prize: { ...p.prize }, label: this.prizeLabel(p.prize), got, recovered: !!(opts && opts.recovered) };
        this._emit('prize', result);
        this._save('prize');
        return result;
    },

    // =============================================================================================
    // Модель кнопок
    // =============================================================================================

    /** Красная точка на кнопке колеса: 1 — бесплатное вращение готово. */
    badge() {
        this._sync();
        return !this.state.free && !this.state.pending ? 1 : 0;
    },

    /**
     * Доступность вращений для кнопок.
     *   freeAvailable, nextFreeMs/nextFreeLabel — таймер до бесплатного вращения (0 — уже можно)
     *   adLimit, adUsed, adLeft, banked — вращения за рекламу; canSpinFree / canSpinAd — можно ли сейчас
     *   freeLabel — «Крутить бесплатно» | «Бесплатно через 05:12:33»; adLabel — «За рекламу: ещё вращение (осталось 2 из 3)»
     *   hint — пояснение, почему кнопка недоступна; pending — идущее вращение (pendingSpin) или null
     */
    status() {
        this._sync();
        const s = this.state;
        const limit = this.adLimit();
        const freeAvailable = !s.free;
        const nextFreeMs = freeAvailable ? 0 : this.msToNextDay();
        const adLeft = Math.max(0, limit - s.ads);
        const block = adLeft > 0 && s.banked === 0 ? this._adBlock() : null;
        const ready = this._sectors.length >= 2 && !s.pending;
        const canSpinAd = ready && (s.banked > 0 || (adLeft > 0 && !block));
        // общая пауза между rewarded дольше паузы после неудачи: на кнопке «Через N с»
        const waiting = block === 'cooldown' && this._globalWaitSec() > this._retryWaitSec();
        let hint = '';
        if (s.pending) hint = this.t('wheel.spinning');
        else if (!freeAvailable && adLeft === 0 && s.banked === 0) hint = this.t('wheel.noSpins');
        else if (waiting) hint = this.adWaitLabel();
        else if (block === 'cooldown' || block === 'unavailable') hint = this.t('wheel.adUnavailable');
        return {
            today: s.day, freeAvailable, nextFreeMs, nextFreeLabel: freeAvailable ? '' : this.formatTime(nextFreeMs),
            adLimit: limit, adUsed: s.ads, adLeft, banked: s.banked,
            canSpinFree: ready && freeAvailable, canSpinAd,
            freeLabel: freeAvailable ? this.t('wheel.free') : this.t('wheel.freeIn', { t: this.formatTime(nextFreeMs) }),
            adLabel: waiting ? this.adWaitLabel() : adLeft > 0 || s.banked > 0 ? this.t('wheel.ad', { a: adLeft + s.banked, b: limit }) : this.t('wheel.noSpins'),
            adWait: block === 'cooldown' ? this.adWaitSec() : 0,
            busy: this._adBusy, hint,
            pending: this.pendingSpin(),
        };
    },

    /**
     * Проверка секторов: { ok, problems: [{ code, message, sector? }] } — не меньше двух секторов, вес
     * больше нуля, у каждого сектора есть приз, в секторах нет эксклюзивных предметов Daily Gift.
     */
    validate() {
        /** @type {Array<{ code: string, message: string, sector?: number }>} */
        const problems = [];
        if (this._sectors.length < 2) problems.push({ code: 'sectors', message: 'Секторов ' + this._sectors.length + ', нужно не меньше двух' });
        let total = 0;
        this._sectors.forEach((sec, i) => {
            total += sec.weight;
            if (!(sec.weight > 0)) problems.push({ code: 'weight', sector: i, message: 'Сектор ' + i + ': вес должен быть больше нуля' });
            if (!sec.item && !sec.randomItem && !(sec.coins > 0)) problems.push({ code: 'prize', sector: i, message: 'Сектор ' + i + ': нет приза (coins, item или randomItem)' });
            if (sec.item && this._isExclusive(sec.item)) problems.push({ code: 'exclusive', sector: i, message: 'Сектор ' + i + ': «' + sec.item + '» — эксклюзив Daily Gift, на колесе его быть не может' });
        });
        if (this._sectors.length >= 2 && !(total > 0)) problems.push({ code: 'total', message: 'Сумма весов секторов равна нулю' });
        return { ok: problems.length === 0, sectors: this._sectors.length, problems };
    },
};

// Тексты по умолчанию кладём в LANG_STRINGS, не затирая то, что игра уже задала в своём Lang.js.
if (typeof LANG_STRINGS !== 'undefined') {
    for (const code of Object.keys(Wheel.TEXT)) {
        const dict = LANG_STRINGS[code];
        if (!dict) continue;
        for (const key of Object.keys(Wheel.TEXT[code])) if (!(key in dict)) dict[key] = Wheel.TEXT[code][key];
    }
}
