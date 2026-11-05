// ObbyBots.js — боты, похожие на живых игроков, для обби: идут по трассе по маркерам route-N (доля скорости, прыжок,
// приземление), ошибаются по своему умению, падают и возрождаются на своём чекпоинте, радуются на финише, пишут в чат,
// «заходят» и «выходят» рядом с игроком, их можно сбить. Логика ЧИСТАЯ (без Babylon и DOM): тело и вид боту даёт игра.
//
// МАРШРУТ — ObbyCourse.route (маркеры route-1…N): x, y — точка на линии бега, h — верх опоры под ней, rot[1] — курс,
//   scale[0] — доля скорости 0.3..1, scale[1] — действие: 1 бежать, 2 прыгнуть здесь (точка отрыва — за ~30 px до края;
//   на батуте — в центре), 3 — приземление. Точки — через ~300-450 px, у поворотов гуще. Точки на движущейся или
//   вращающейся плите задают по её БАЗОВОЙ позе — бот сам пересчитывает их по времени. Нет маркеров — прямые между
//   этапами (ObbyCourse.fallbackRoute), бот чаще падает.
//
// ТЕЛО («актор») ПОДКЛЮЧАЕТ ИГРА — персонаж, велосипед, машина или свой контроллер; ObbyBody — эталон:
//   чтение:  x y z (ноги, мир Babylon: y вверх), yaw (атан2(dz, dx)), vx vy vz, speed (вдоль курса), grounded,
//            radius height (габарит, px); необязательно support (коллайдер под ногами, для плит)
//   метод:   place(x, y, z, yaw) — поставить (старт, возрождение, обнуляет скорость)
//            step(dt, cmd) — кадр физики; cmd = { dx, dz (желаемое направление, длина ≤ 1), yaw (желаемый курс),
//                            steer (−1..1, плюс — увеличить yaw), throttle (−1..1), speed (px/с, желаемая), jump (нажатие) }
//                            пеший актор читает dx, dz, speed, jump; байк и машина — steer, throttle, speed, jump
//            knock(vx, vy, vz) — сбит: вылет/падение, управление отключено до place()
//   вид (необязательно): pose(state, dt) — 'idle' | 'run' | 'air' | 'dead' | 'cheer'; setVisible(on); setShield(on) —
//            мигание после появления; dispose(); height — рост для таблички
//   Фабрика: createActor({ id, name, look, skill }) -> актор или Promise актора. look — внешность
//   { skin, shirt, pants, hair, hairColor, cap } (цвета 0xRRGGBB) — у каждого бота свой скин.
//
// ЗАПУСК:
//   ObbyBots.init({ course: ObbyCourse, createActor, getPlayer: () => ({ actor: body, stage, alive }),
//                   tags, onChat: (bot, text, cat) => hud.chat(bot.name, text), onEvent: (type, bot, data) => … });
//   await ObbyBots.build();                         // в prepare под экраном загрузки: маршрут, привязка этапов, боты
//   app.onUpdate(dt => ObbyBots.update(dt));        // после ObbyCourse.update и шага тела игрока
//   ObbyBots.playerCheckpoint(stage);               // игрок взял чекпоинт: соседи иногда хвалят
// События onEvent: 'join' 'leave' 'fall' (data.cause) 'checkpoint' (data.stage) 'finish' 'knock' (data.speed) 'respawn'.
// ЧИСЛА — Constants.js (OBBY_BOT_*): умение, скорость сбивания, дальности, «сессия», зерно RNG — opts.seed (тесты).
// ПРАВИЛО «ЖИВОГО СЕРВЕРА»: бот дальше OBBY_BOT_SIM_DIST от игрока не считается и не рисуется; дальше OBBY_BOT_LEAVE_DIST (или
// далеко позади по маршруту) дольше OBBY_BOT_LEAVE_SEC «выходит», на его место «заходит» новый бот с другим ником и скином
// рядом с игроком (не на нём). «Сессия» бота конечна (OBBY_BOT_LIFE_SEC), как у живого игрока.

/** @satisfies {Record<string, any>} */
const ObbyBots = {
    NAMES: {
        ru: ['Вжух', 'Колёсико', 'Шустрик', 'Кексик', 'Молния', 'ДимаПро', 'Сашка_2013', 'Котлетка', 'Ёжик_Лес', 'Турбо', 'Пушистик', 'Рыжик',
            'Бублик', 'Скорость', 'Ниндзя', 'Зайка', 'Гонщик77', 'Тимоха', 'Ласточка', 'Кирюха', 'Пельмешка', 'Оладушек', 'Вася_Ракета',
            'Колян', 'Мармеладка', 'Шторм', 'Пломбир', 'Прыгун', 'СоняКот', 'Лисёнок'],
        en: ['Zoomer', 'Pedalz', 'SpeedyKid', 'Wheelie', 'Turbo', 'Biscuit', 'Flash', 'MaxPro', 'Rocket_Ray', 'Noodle', 'Pickles', 'Nova',
            'Bolt', 'Sprinkles', 'Ziggy', 'Comet', 'Pixel', 'Muffin', 'Blaze', 'Skippy', 'Jumpy', 'Cookie_X', 'Ninja2010', 'Waffle', 'Sunny',
            'Rocko', 'Pogo', 'MiaFox', 'Hopper', 'Toast'],
    },
    SKINS: [0xf4d6b0, 0xe8b98f, 0xc98e63, 0x9c6a45, 0x6d4630, 0xffe0c2],
    SHIRTS: [0x3e7bfa, 0xe5484d, 0x30a46c, 0xf5a524, 0x8e4ec6, 0x12a594, 0xf76b15, 0xd6409f, 0x1c1c28, 0xeef0f5],
    PANTS: [0x2a2f45, 0x1b3a6b, 0x3b2f2a, 0x20603d, 0x4a4560, 0x5c5c66],
    HAIRS: ['short', 'spiky', 'long', 'none'],
    HAIR_COLORS: [0x3b2a1a, 0x16110c, 0xb5651d, 0xe3c35a, 0xc23b22, 0x7a7a8a],

    /** @type {any} */ course: null,
    /** @type {any[]} */ list: [],
    /** @type {any[]} */ pending: [],
    /** @type {any[][]} */ haz: [],
    /** @type {any[]} */ onPiece: [],
    /** @type {any} */ opts: {},
    /** @type {any} */ createActor: null,
    /** @type {any} */ getPlayer: null,
    /** @type {any} */ tags: null,
    lang: 'en',
    count: 0,
    time: 0,
    _seed: 1,
    _id: 0,
    _joining: 0,
    _joinT: 0,
    _chatT: 5,
    _lastSay: -10,
    /** @type {Set<string>} */ _used: new Set(),

    // ---------------------------------------------------------------------------------------------
    // Числа
    // ---------------------------------------------------------------------------------------------

    cfg() {
        const U = 'undefined';
        const mobile = typeof IS_MOBILE !== U && IS_MOBILE;
        let count = mobile ? (typeof OBBY_BOTS_MOBILE !== U ? OBBY_BOTS_MOBILE : 3) : (typeof OBBY_BOTS !== U ? OBBY_BOTS : 5);
        if (typeof Quality !== U && Quality.level === 0) count = Math.min(count, 3);
        return {
            count,
            skillMin: typeof OBBY_BOT_SKILL_MIN !== U ? OBBY_BOT_SKILL_MIN : 0.55,
            skillMax: typeof OBBY_BOT_SKILL_MAX !== U ? OBBY_BOT_SKILL_MAX : 0.95,
            knock: typeof OBBY_BOT_KNOCK_SPEED !== U ? OBBY_BOT_KNOCK_SPEED : 420,
            sim: typeof OBBY_BOT_SIM_DIST !== U ? OBBY_BOT_SIM_DIST : 9000,
            leave: typeof OBBY_BOT_LEAVE_DIST !== U ? OBBY_BOT_LEAVE_DIST : 15000,
            leaveSec: typeof OBBY_BOT_LEAVE_SEC !== U ? OBBY_BOT_LEAVE_SEC : 6,
            life: typeof OBBY_BOT_LIFE_SEC !== U ? OBBY_BOT_LIFE_SEC : 240,
            shield: typeof OBBY_BOT_SPAWN_SHIELD !== U ? OBBY_BOT_SPAWN_SHIELD : 3,
            skipAfter: typeof OBBY_BOT_SKIP_AFTER !== U ? OBBY_BOT_SKIP_AFTER : 5,
            chat: typeof OBBY_BOT_CHAT_SEC !== U ? OBBY_BOT_CHAT_SEC : 8,
            run: typeof OBBY_RUN_SPEED !== U ? OBBY_RUN_SPEED : 620,
            jump: typeof OBBY_JUMP_SPEED !== U ? OBBY_JUMP_SPEED : 1120,
            gravity: typeof OBBY_GRAVITY !== U ? OBBY_GRAVITY : 3000,
        };
    },

    /** Генератор mulberry32: seed -> () => [0, 1). Детерминирован — тесты и повторы. */
    rngFrom(seed) {
        let s = seed >>> 0;
        return () => {
            s = (s + 0x6D2B79F5) >>> 0;
            let t = s;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    },

    _rng: null,
    rnd() { return (this._rng || (this._rng = this.rngFrom(this._seed)))(); },

    // ---------------------------------------------------------------------------------------------
    // Запуск и сборка
    // ---------------------------------------------------------------------------------------------

    /** Настроить (один раз на игру). opts: course, createActor, getPlayer, tags, onChat, onEvent, seed, lang, count, names. */
    init(opts) {
        const o = opts || {};
        this.opts = o;
        this.course = o.course || (typeof ObbyCourse !== 'undefined' ? ObbyCourse : null);
        this.createActor = o.createActor || null;
        this.getPlayer = o.getPlayer || null;
        this.tags = o.tags || null;
        this._seed = (o.seed != null ? o.seed : (Date.now() & 0xffffff) || 1) >>> 0;
        this._rng = this.rngFrom(this._seed);
        this.lang = ObbyChat.lang(o.lang || (typeof Lang !== 'undefined' ? Lang.code : (typeof GAME_LANG !== 'undefined' ? GAME_LANG : 'en')));
        this.count = o.count != null ? o.count : this.cfg().count;
        this.clear();
        return this;
    },

    /**
     * Под экраном загрузки трассы: привязка маршрута, опасности у точек и первые боты. Повторный вызов (смена карты)
     * убирает прежних. Промис: боты созданы.
     */
    async build() {
        this.clear();
        this.bind();
        const jobs = [];
        for (let i = 0; i < this.count; i++) jobs.push(this._spawn(i, true));
        await Promise.all(jobs);
        return this.list.length;
    },

    /** Опасности и подвижные опоры у точек маршрута (по базовым позам деталей). */
    bind() {
        const C = this.course, R = C.route;
        this.haz = R.map(() => null);
        this.onPiece = R.map(() => null);
        for (const p of C.pieces) {
            if (!p.dynamic || !p.base) continue;
            const O = p.base.O;
            if (p.role === 'spinner' || p.role === 'hammer') {
                const reach = p.role === 'spinner' ? p.sx / 2 + 140 : p.sy + p.sx / 2 + 160;
                // огибающая: капсулы-ловушки в 24 моментах периода — где эта деталь может ударить
                p.env = [];
                const T = C.period(p);
                for (let k = 0; k < 24; k++) for (const c of C.capsulesAt(p, T * k / 24)) p.env.push(c);
                let near = Infinity;
                p.routeI = 0;
                for (let i = 0; i < R.length; i++) {
                    const q = R[i], d = Math.hypot(q.x - O[0], q.z - O[2]);
                    if (d < near && Math.abs(q.y - O[1]) < 700) { near = d; p.routeI = i; }
                    if (d > reach || Math.abs(q.y - O[1]) > 700) continue;
                    (this.haz[i] || (this.haz[i] = [])).push(p);
                }
            } else if (p.role === 'move' || p.role === 'spin') {
                const base = C.basePose(p);
                for (let i = 0; i < R.length; i++) {
                    const q = R[i];
                    if (!this.onPiece[i] && Math.abs(q.y - O[1]) < 110 && C.coversPose(p, base, q.x, q.z, 60)) this.onPiece[i] = p;
                }
            }
        }
    },

    clear() {
        for (const b of this.list.slice()) this._dispose(b);
        this.list = []; this.pending = []; this._used = new Set(); this._joining = 0; this.time = 0;
        this._joinT = 3 + this.rnd() * 3; this._chatT = 4 + this.rnd() * 4; this._lastSay = -10;
        if (this.tags && this.tags.clear) this.tags.clear();
    },

    _dispose(b) {
        try { if (b.actor && b.actor.dispose) b.actor.dispose(); } catch (e) { /* уже снят */ }
        if (this.tags && this.tags.remove) this.tags.remove(b.id);
        this._used.delete(b.name);
    },

    // ---------------------------------------------------------------------------------------------
    // Ник, внешность, появление
    // ---------------------------------------------------------------------------------------------

    pickName() {
        const pool = (this.opts.names && this.opts.names[this.lang]) || this.NAMES[this.lang] || this.NAMES.en;
        const free = pool.filter(n => !this._used.has(n));
        const name = free.length ? free[Math.floor(this.rnd() * free.length)] : pool[Math.floor(this.rnd() * pool.length)] + (10 + Math.floor(this.rnd() * 89));
        this._used.add(name);
        return name;
    },

    randomLook() {
        const pick = (a) => a[Math.floor(this.rnd() * a.length)];
        return { skin: pick(this.SKINS), shirt: pick(this.SHIRTS), pants: pick(this.PANTS), hair: pick(this.HAIRS), hairColor: pick(this.HAIR_COLORS), cap: this.rnd() < 0.3 ? pick(this.SHIRTS) : -1 };
    },

    randomSkill() {
        const c = this.cfg();
        return c.skillMin + this.rnd() * Math.max(0, c.skillMax - c.skillMin);
    },

    /**
     * Точка маршрута для появления рядом с игроком: от 700 px до ~0.45·OBBY_BOT_SIM_DIST от него (впереди или позади),
     * с опорой под ногами — не на самом игроке. k разводит ботов, заходящих подряд.
     */
    joinIndex(k) {
        const C = this.course, R = C.route;
        if (!R.length) return -1;
        const pl = this.getPlayer ? this.getPlayer() : null;
        if (!pl || !pl.actor) return this.safeIndex(Math.min(R.length - 2, Math.floor(this.rnd() * 14) + (k % 3) * 3));
        const st = Math.max(0, Math.min(C.stageRoute.length - 1, pl.stage | 0));
        let base = C.stageRoute[st] || 0;
        let best = Infinity;   // ближайшая точка маршрута к игроку, начиная с точки его этапа
        for (let i = base; i < Math.min(R.length, base + 60); i++) {
            const d = (R[i].x - pl.actor.x) ** 2 + (R[i].z - pl.actor.z) ** 2;
            if (d < best) { best = d; base = i; }
        }
        const max = Math.min(this.cfg().sim * 0.45, 4200);
        const cand = [];
        for (let i = Math.max(0, base - 24); i < Math.min(R.length - 1, base + 24); i++) {
            const d = Math.hypot(R[i].x - pl.actor.x, R[i].z - pl.actor.z);
            if (d >= 700 && d <= max && this.safeIndex(i) === i) cand.push(i);
        }
        if (cand.length) return cand[Math.floor(this.rnd() * cand.length)];
        return this.safeIndex(Math.max(0, Math.min(R.length - 2, base - 3 - (k % 3))));
    },

    /** Ближайшая назад по маршруту точка, под которой есть опора (не лава, не падающая плита). */
    safeIndex(ri) {
        const C = this.course, R = C.route;
        for (let i = Math.max(0, Math.min(R.length - 1, ri)); i >= 0; i--) {
            const p = R[i], g = C.groundAt(p.x, p.z, p.y + 60, 160);
            if (g == null || Math.abs(g - p.y) > 50) continue;
            const hit = C.rayDown(p.x, p.y + 60, p.z, 160, 0.45, true);
            if (hit && !(hit.col.piece && hit.col.piece.role === 'fall')) return i;
        }
        return 0;
    },

    /** Этап, который уже взят у точки маршрута ri. */
    stageAt(ri) {
        const sr = this.course.stageRoute;
        let st = 0;
        for (let i = 0; i < sr.length; i++) if (sr[i] <= ri) st = i;
        return st;
    },

    async _spawn(k, quiet) {
        if (!this.createActor || !this.course || !this.course.route.length) return null;
        this._joining++;
        const spec = { id: ++this._id, name: this.pickName(), look: this.randomLook(), skill: this.randomSkill() };
        try {
            const actor = await this.createActor(spec);
            if (!actor) { this._used.delete(spec.name); return null; }
            const b = {
                id: spec.id, name: spec.name, look: spec.look, skill: spec.skill, actor,
                state: 'wait', ri: 0, stage: 0, deadT: 0, waitT: 0, cheerT: 0, invT: 0, stuckT: 0, bestD: Infinity, turnT: 0, waited: 0,
                recklessT: 0, jumpedAt: -1, fails: 0, lastStage: -1, noise: this.rnd() * 10, plan: {}, life: 0, leaving: false, far: 0,
                rash: false, reckless: false, lateral: 0, frozen: false, leaveT: 0,
            };
            b.rash = this.rnd() < (1 - b.skill) * 0.5;
            b.reckless = b.rash;
            b.life = this.cfg().life * (0.5 + this.rnd());
            if (this.tags && this.tags.add) this.tags.add(b.id, b.name);
            this.list.push(b);
            this._place(b, this.joinIndex(k || 0), true);
            this._event('join', b);
            if (!quiet) {
                if (this.rnd() < 0.6) this.say(b, 'hi', 1.2 + this.rnd());
                const o = this._other(b);
                if (o && this.rnd() < 0.5) this.say(o, 'hiReply', 3 + this.rnd() * 1.5);
            }
            return b;
        } finally { this._joining--; }
    },

    /** Поставить бота на точку маршрута ri (старт, «заход»), этап — по ней. */
    _place(b, ri, join) {
        const C = this.course, R = C.route;
        ri = Math.max(0, Math.min(R.length - 1, ri));
        const p = R[ri], nx = R[Math.min(R.length - 1, ri + 1)];
        const yaw = nx !== p ? Math.atan2(nx.z - p.z, nx.x - p.x) : p.yaw;
        const lift = C.cfg().lift;
        b.actor.place(p.x, p.y + lift, p.z, yaw);
        b.ri = ri;
        if (join) b.stage = this.stageAt(ri);
        this._reset(b);
    },

    /** Возродить бота на его этапе: позиция чекпоинта игры, маршрут — от привязанной точки. */
    _respawn(b) {
        const C = this.course;
        const r = C.respawn(b.stage);
        const ri = this.safeIndex(C.stageRoute[b.stage] || 0);
        const rr = C.route[ri];
        // этап 0 или чекпоинт без привязки — по точке маршрута; иначе — точка чекпоинта, чуть разведя ботов
        const spread = b.stage > 0 ? 36 : 0;
        const a = this.rnd() * Math.PI * 2, d = this.rnd() * spread;
        const nx = C.route[Math.min(C.route.length - 1, ri + 1)];
        const yaw = nx ? Math.atan2(nx.z - rr.z, nx.x - rr.x) : r.yaw;
        b.actor.place(r.x + Math.cos(a) * d, r.y, r.z + Math.sin(a) * d, b.stage > 0 ? yaw : r.yaw);
        b.ri = ri;
        this._reset(b);
        this._event('respawn', b);
    },

    _reset(b) {
        b.state = 'wait';
        b.waitT = 0.4 + this.rnd() * 2.2;       // как живой игрок: стартует не сразу
        b.invT = this.cfg().shield;
        b.stuckT = 0; b.bestD = Infinity; b.turnT = 0; b.waited = 0; b.recklessT = 0; b.jumpedAt = -1; b.plan = {};
        b.reckless = b.rash; b.far = 0; b.leaveT = 0;
        if (b.actor.setShield) b.actor.setShield(true);
        if (b.actor.pose) b.actor.pose('idle', 0);
    },

    _event(type, b, data) {
        if (this.opts.onEvent) this.opts.onEvent(type, b, data || {});
    },

    // ---------------------------------------------------------------------------------------------
    // Кадр
    // ---------------------------------------------------------------------------------------------

    /** Кадр ботов: после ObbyCourse.update и шага тела игрока. dt ограничен 0.1 с. */
    update(dt) {
        dt = Math.min(0.1, Math.max(0, dt || 0));
        if (!this.course || !this.course.route.length) return;
        this.time += dt;
        const cfg = this.cfg();
        const pl = this.getPlayer ? this.getPlayer() : null;
        const P = pl && pl.actor ? pl.actor : null;
        for (const b of this.list.slice()) {
            const A = b.actor;
            if (!A) continue;
            b.life -= dt;
            const d2 = P ? (A.x - P.x) ** 2 + (A.z - P.z) ** 2 : 0;
            // далеко от игрока (по карте или позади по маршруту) — «выходит», рядом заходит новый
            if (this.shouldLeave(b, pl, d2, cfg, dt)) { this.leave(b, true); continue; }
            if (b.leaving) { b.leaveT -= dt; if (b.leaveT <= 0) { this.remove(b); continue; } }
            const near = !P || d2 < cfg.sim * cfg.sim;
            if (!near) {
                if (!b.frozen) { b.frozen = true; if (A.setVisible) A.setVisible(false); if (this.tags && this.tags.hide) this.tags.hide(b.id); }
                continue;
            }
            if (b.frozen) { b.frozen = false; if (A.setVisible) A.setVisible(true); }
            if (b.invT > 0) { b.invT -= dt; if (b.invT <= 0 && A.setShield) A.setShield(false); }
            if (b.state === 'wait') {
                b.waitT -= dt;
                this._step(b, dt, { dx: 0, dz: 0, speed: 0 });
                if (b.waitT <= 0) b.state = 'run';
            } else if (b.state === 'run') this._drive(b, dt);
            else if (b.state === 'dead') {
                b.deadT -= dt;
                A.step(dt, {});
                if (A.pose) A.pose('dead', dt);
                if (b.deadT <= 0) {
                    // как живой игрок: застрял на одном этапе — «пропускает» его до следующего чекпоинта
                    b.fails = b.lastStage === b.stage ? b.fails + 1 : 1;
                    b.lastStage = b.stage;
                    if (b.fails >= cfg.skipAfter && b.stage < this.course.stages.length - 1) {
                        b.fails = 0; b.stage++; b.lastStage = b.stage;
                    }
                    this._respawn(b);
                }
            } else if (b.state === 'finish') {
                b.cheerT -= dt;
                this._step(b, dt, { dx: 0, dz: 0, speed: 0 });
                if (b.cheerT <= 0) this.leave(b, true);
            }
            if (P && pl.alive !== false && (b.state === 'run' || b.state === 'wait')) this._contact(b, P, cfg);
            this._tag(b);
        }
        this._population(dt);
        this._chat(dt, cfg);
    },

    /** Политика «выхода»: далеко от игрока достаточно долго, далеко позади по маршруту, или «сессия» кончилась. */
    shouldLeave(b, pl, d2, cfg, dt) {
        if (b.leaving) return false;
        if (b.life <= 0 && b.state !== 'dead' && b.state !== 'finish') return true;
        if (!pl || !pl.actor) return false;
        const far = d2 > cfg.leave * cfg.leave;
        let behind = false;
        if (!far && d2 > cfg.sim * cfg.sim && this.course.stages.length > 1) {
            const bp = this.course.progress(b.stage, b.actor.x, b.actor.y, b.actor.z);
            const pp = this.course.progress(pl.stage | 0, pl.actor.x, pl.actor.y, pl.actor.z);
            behind = pp - bp > 0.3;
        }
        if (far || behind) { b.far += dt; return b.far > cfg.leaveSec; }
        b.far = 0;
        return false;
    },

    /** Бот уходит: вежливо (иногда с прощанием — реплика, через ~1.6 с исчезает) или сразу. */
    leave(b, polite) {
        if (b.leaving) return;
        if (polite && !b.frozen && this.rnd() < 0.5) {
            this.say(b, 'bye', 0);
            b.leaving = true; b.leaveT = 1.6;
        } else this.remove(b);
    },

    remove(b) {
        const i = this.list.indexOf(b);
        if (i < 0) return;
        this.list.splice(i, 1);
        this.pending = this.pending.filter(q => q.bot !== b);
        this._dispose(b);
        this._event('leave', b);
    },

    // Следим за числом ботов: недостающие «заходят» раз в 4-10 с.
    _population(dt) {
        this._joinT -= dt;
        if (this._joinT > 0) return;
        this._joinT = 4 + this.rnd() * 6;
        const active = this.list.filter(b => !b.leaving).length + this._joining;
        if (active < this.count) this._spawn(Math.floor(this.rnd() * 3), false);
    },

    /** Сменить число ботов на ходу (уровень графики): лишние выходят. */
    setCount(n) {
        this.count = Math.max(0, n | 0);
        const extra = this.list.filter(b => !b.leaving).slice(this.count);
        for (const b of extra) this.leave(b, false);
    },

    _tag(b) {
        if (!this.tags || !this.tags.place) return;
        const A = b.actor;
        this.tags.place(b.id, A.x, A.y + (A.height || 180) + 40, A.z, !b.frozen);
    },

    _step(b, dt, cmd) {
        const A = b.actor;
        A.step(dt, cmd);
        if (A.pose) {
            const st = b.state === 'finish' ? 'cheer' : !A.grounded ? 'air' : Math.abs(A.speed || 0) > 60 ? 'run' : 'idle';
            A.pose(st, dt);
        }
    },

    // ---------------------------------------------------------------------------------------------
    // Автопилот
    // ---------------------------------------------------------------------------------------------

    // Точка маршрута j в момент t: на движущейся плите — со сдвигом по её позе.
    _pt(j, t) {
        const q = this.course.route[j], p = this.onPiece[j];
        if (!p) return q;
        const w = this.course.fromBase(p, [q.x, q.y, q.z], t);
        return { x: w[0], y: w[1], z: w[2], s: q.s, f: q.f, yaw: q.yaw };
    },

    // Время полёта прыжка из точки a в точку b, с.
    _air(a, b) {
        const c = this.cfg();
        const dh = b.y - a.y, disc = c.jump * c.jump - 2 * c.gravity * dh;
        return (c.jump + Math.sqrt(Math.max(0, disc))) / c.gravity;
    },

    _planJump(b) {
        let err = (this.rnd() * 2 - 1) * (1 - b.skill) * 55;
        if (this.rnd() < (1 - b.skill) * 0.28) err += (this.rnd() < 0.5 ? -1 : 1) * (70 + this.rnd() * 70);   // промах: рано или поздно
        return { err };
    },

    // Расстояние (px, по земле) от точки (x, z) до места, куда деталь может ударить за период, за вычетом радиуса тела:
    // < 0 — точка в зоне удара. Капсулы вне высоты тела [y, y + h] не считаются.
    _dEnv(p, x, z, y, r, h) {
        let best = Infinity;
        for (const c of p.env) {
            if (Math.max(c.a[1], c.b[1]) + c.r < y || Math.min(c.a[1], c.b[1]) - c.r > y + h) continue;
            const abx = c.b[0] - c.a[0], abz = c.b[2] - c.a[2], L2 = abx * abx + abz * abz;
            const k = L2 > 1e-9 ? Math.max(0, Math.min(1, ((x - c.a[0]) * abx + (z - c.a[2]) * abz) / L2)) : 0;
            const d = Math.hypot(x - (c.a[0] + abx * k), z - (c.a[2] + abz * k)) - c.r - r;
            if (d < best) best = d;
        }
        return best;
    },

    // Впереди вертушка или молот: бот стоит у границы зоны удара, пока проход всей зоны (точки маршрута и промежутки
    // между ними, шаг ~60 px) по прогнозу заденет. Не ждёт: уже в зоне (стоять там опаснее), на падающей плите, если до
    // зоны ещё прыжок (подождёт после приземления) и если зона позади. Время прихода — по скорости ~0.9 бега, запас ±0.15 с.
    _hazardWait(b) {
        const C = this.course, R = C.route, A = b.actor, t = C.time;
        if (A.support && A.support.piece && A.support.piece.role === 'fall') return false;
        // ближайшие детали впереди (не дальше 450 px от зоны удара): дальние оценим, когда подойдём
        const set = new Set();
        let dmin = Infinity, jFirst = Infinity, jLast = 0;
        for (let j = b.ri; j < Math.min(R.length, b.ri + 14); j++) for (const p of this.haz[j] || []) {
            if (set.has(p) || b.ri > p.routeI) continue;
            const d = this._dEnv(p, A.x, A.z, A.y, A.radius, A.height);
            if (d < 0) return false;                                  // уже в зоне — только вперёд
            if (d > 450) continue;
            set.add(p);
            dmin = Math.min(dmin, d); jFirst = Math.min(jFirst, p.routeI); jLast = Math.max(jLast, p.routeI);
        }
        if (!set.size || dmin > 150) return false;                    // зона ещё далеко
        for (let j = b.ri; j < jFirst; j++) if (R[j].f === 2) return false;   // сначала прыжок
        const run = this.cfg().run, kv = 0.78 + 0.22 * b.skill;
        let d = 0, tt = A.speed < 200 ? 0.15 : 0, px = A.x, pz = A.z;                     // время идёт по скорости каждого отрезка маршрута
        for (let j = b.ri; j <= Math.min(R.length - 1, jLast + 2); j++) {
            const q = R[j], seg = Math.hypot(q.x - px, q.z - pz), n = Math.max(1, Math.ceil(seg / 60));
            const v = Math.max(0.3, Math.min(1, q.s)) * kv * run;
            for (let s = 1; s <= n; s++) {
                const f = s / n, x = px + (q.x - px) * f, z = pz + (q.z - pz) * f, ta = t + tt + seg * f / v;
                for (const p of set) for (const dtw of [-0.15, 0, 0.15]) {
                    if (C.trapHits(p, ta + dtw, x, q.y, z, A.radius, A.height, 14)) return true;
                }
            }
            d += seg; tt += seg / v; px = q.x; pz = q.z;
        }
        return false;
    },

    _drive(b, dt) {
        const C = this.course, R = C.route, A = b.actor, cfg = this.cfg();
        const t = C.time;
        const P = (i) => this._pt(i, t);
        const d2 = (i) => { const q = P(i); return (q.x - A.x) ** 2 + (q.z - A.z) ** 2; };
        // вдоль маршрута вперёд
        const ri0 = b.ri;
        while (b.ri < R.length - 1 && (d2(b.ri + 1) < d2(b.ri) || d2(b.ri) < 90 * 90)) b.ri++;
        if (b.ri !== ri0) { b.bestD = Infinity; b.stuckT = 0; }
        // этапы по месту (как у игрока)
        if (A.grounded) b.flight = -1;
        if (A.grounded) {
            const ns = C.reached(A.x, A.y, A.z, b.stage);
            if (ns > b.stage) this._stageUp(b, ns);
            if (b.state !== 'run') return;
        }
        const last = R.length - 1;
        if (!C.finish && b.ri >= last - 1 && d2(last) < 400 * 400) { this._finish(b); return; }
        const next = Math.min(last, b.ri + 1);
        const dn = Math.sqrt(d2(next));
        if (dn < b.bestD - 40) { b.bestD = dn; b.stuckT = 0; } else b.stuckT += dt;
        if (b.stuckT > 4) { this._respawn(b); return; }
        // точка, к которой идём: чуть впереди, с рысканием по неумению
        let ti = b.ri;
        const look = 110 + Math.max(0, A.speed || 0) * 0.08;
        while (ti < last && d2(ti) < look * look) ti++;
        const T0 = P(ti);
        b.noise += dt * 0.7;
        // неумелый рыскает поперёк линии бега (у точек отрыва — меньше: край не промахнуть)
        const nearJump = R.slice(Math.max(0, b.ri - 1), b.ri + 3).some(q => q.f === 2);
        const lateral = Math.sin(b.noise * 1.7) * (1 - b.skill) * (nearJump ? 8 : 30);
        const sx = R[next].x - R[b.ri].x, sz = R[next].z - R[b.ri].z, sl = Math.hypot(sx, sz) || 1;
        const T = { x: T0.x - sz / sl * lateral, z: T0.z + sx / sl * lateral, y: T0.y };
        let want = Math.atan2(T.z - A.z, T.x - A.x);
        // в полёте после своего прыжка: на точку приземления с такой скоростью, чтобы прилететь в неё, а не мимо
        let airSpeed = -1;
        if (!A.grounded && b.flight >= 0 && b.flight < R.length) {
            const g = cfg.gravity, vy = A.vy || 0, land = R[b.flight].y;
            const disc = vy * vy + 2 * g * (A.y - land);
            const tRem = Math.max(0.05, (vy + Math.sqrt(Math.max(0, disc))) / g);
            const Lp = this._pt(b.flight, t + tRem);
            const dx = Lp.x - A.x, dz = Lp.z - A.z;
            want = Math.atan2(dz, dx);
            airSpeed = Math.max(0.12 * cfg.run, Math.min(cfg.run, Math.hypot(dx, dz) / tRem));
        }
        let a = want - A.yaw;
        a = Math.atan2(Math.sin(a), Math.cos(a));
        if (Math.abs(a) > 2.2) b.turnT += dt; else b.turnT = 0;
        if (b.turnT > 2.5) { this._respawn(b); return; }
        const wobble = Math.sin(b.noise * 2.3) * (1 - b.skill) * 0.25;
        const steer = Math.max(-1, Math.min(1, a * 2.6 + wobble));
        // скорость: доля маршрута × умение; под прыжок — чтобы долететь, а не перелететь
        const run = cfg.run;
        let tgt = Math.max(0.3 * run, run * Math.min(R[b.ri].s, R[ti].s + 0.15) * (0.78 + 0.22 * b.skill));
        for (let k = Math.max(0, b.ri - 1); A.grounded && k <= Math.min(R.length - 2, b.ri + 3); k++) {      // в воздухе скорость не трогаем
            if (R[k].f !== 2 || b.jumpedAt === k) continue;
            if (d2(k) > 520 * 520) break;                                                                      // дальний прыжок — когда подойдём
            const air = this._air(R[k], R[k + 1]);
            const Lp = this._pt(k + 1, t + air), Kp = P(k);
            const L = Math.hypot(Lp.x - Kp.x, Lp.z - Kp.z);
            const need = Math.max(0.3 * run, Math.min(run, (L + 100) / Math.max(0.3, air)));
            tgt = Math.min(Math.max(tgt, 0.55 * run), need * (0.97 + 0.06 * Math.sin(b.noise + k)));
            break;
        }
        // прыжок у точки отрыва (с ошибкой по умению); подвижную цель — выждать
        let jump = false, hold = false;
        for (let k = Math.max(0, b.ri - 2); k <= Math.min(last - 1, b.ri + 2); k++) {
            if (R[k].f !== 2 || b.jumpedAt === k) continue;
            const plan = b.plan[k] || (b.plan[k] = this._planJump(b));
            const q = P(k), fx = Math.cos(A.yaw), fz = Math.sin(A.yaw);
            const ahead = (q.x - A.x) * fx + (q.z - A.z) * fz;           // > 0 — точка ещё впереди
            const lead = 28 + Math.max(0, A.speed || 0) * 0.035 + plan.err;
            if (d2(k) < 280 * 280 && ahead < lead && A.grounded) {
                const air = this._air(R[k], R[k + 1]);
                const Lp = this._pt(k + 1, t + air);
                const dist = Math.hypot(Lp.x - A.x, Lp.z - A.z);
                const moving = !!(this.onPiece[k + 1] || this.onPiece[k]);
                if (moving && dist > run * air * 0.95 && !b.reckless) hold = true;   // плита ещё далеко: ждём
                else { jump = true; b.jumpedAt = k; b.flight = k + 1; }
            }
            break;
        }
        // впереди обрыв, а f=2 не стоит — умелый прыгает сам, как человек
        if (!jump && !hold && A.grounded && b.skill > 0.65 && Math.abs(a) < 0.25 && !R.slice(Math.max(0, b.ri - 2), b.ri + 4).some(q => q.f === 2)) {
            const fx = Math.cos(A.yaw), fz = Math.sin(A.yaw), ahead = 30 + Math.max(0, A.speed || 0) * 0.04;
            const g = C.groundAt(A.x + fx * ahead, A.z + fz * ahead, A.y + 120, 420);
            const nxt = R[next];
            if (g == null && nxt.y > A.y - 250) jump = true;
        }
        // вертушка или молот — выждать окно
        b.hzT = (b.hzT || 0) - dt;
        if (b.hzT <= 0) { b.hzT = 0.08; b.hzWait = !b.reckless && this._hazardWait(b); }
        if ((b.hzWait || hold) && A.grounded) {      // в воздухе не тормозим: недолёт
            b.waited += dt;
            if (b.waited > 6) { b.reckless = true; b.recklessT = 2; b.waited = 0; }
            tgt = 0; b.bestD = Infinity; b.stuckT = 0; jump = false;
        } else b.waited = 0;
        if (b.recklessT > 0) { b.recklessT -= dt; if (b.recklessT <= 0) b.reckless = b.rash; }
        if (airSpeed >= 0) tgt = airSpeed;
        const cmd = { dx: Math.cos(want), dz: Math.sin(want), yaw: want, steer, throttle: tgt > 0 ? Math.max(0.15, Math.min(1, tgt / run)) : -0.7, speed: tgt, jump };
        this._step(b, dt, cmd);
        // смерть: лава, вода, ловушка, пустота
        const cause = C.killCause(A.x, A.y, A.z, (A.radius || 28) * 0.9, A.height || 180);
        if (cause) this.kill(b, cause);
    },

    _stageUp(b, ns) {
        b.stage = ns;
        b.fails = 0;
        this._event('checkpoint', b, { stage: ns });
        if (ns >= this.course.stages.length - 1 && this.course.finish) { this._finish(b); return; }
        if (this.rnd() < 0.3) this.say(b, 'checkpoint', 0.2 + this.rnd());
    },

    _finish(b) {
        b.state = 'finish';
        b.cheerT = 3.5 + this.rnd() * 2.5;
        this._event('finish', b);
        if (this.rnd() < 0.9) this.say(b, 'win', 0.3);
    },

    /** Бот погиб (лава, вода, ловушка, пустота, удар): через ~1.5 с возродится на своём чекпоинте. */
    kill(b, cause) {
        if (b.state === 'dead' || b.state === 'finish') return;
        b.state = 'dead';
        b.deadT = 1.3 + this.rnd() * 0.8;
        if (cause === 'trap' && b.actor.knock) b.actor.knock((this.rnd() * 2 - 1) * 500, 600, (this.rnd() * 2 - 1) * 500);
        this._event('fall', b, { cause });
        if (this.rnd() < 0.38) this.say(b, ObbyChat.categoryFor(cause), 0.6);
    },

    // ---------------------------------------------------------------------------------------------
    // Игрок: сбить или растолкать
    // ---------------------------------------------------------------------------------------------

    // Касание с телом игрока: быстрее OBBY_BOT_KNOCK_SPEED (скорость сближения по нормали) — бот слетает; медленнее —
    // расталкиваются без потери управления.
    _contact(b, P, cfg) {
        const A = b.actor;
        const reach = (A.radius || 28) + (P.radius || 28) + 12;
        const dx = A.x - P.x, dz = A.z - P.z, dy = A.y - P.y;
        const d = Math.hypot(dx, dz);
        if (d > reach || d < 1e-3 || Math.abs(dy) > Math.max(A.height || 180, P.height || 180) * 0.8) return;
        const nx = dx / d, nz = dz / d;
        const rel = ((P.vx || 0) - (A.vx || 0)) * nx + ((P.vz || 0) - (A.vz || 0)) * nz;
        if (rel > cfg.knock && !(b.invT > 0)) {
            const k = 0.9;
            A.knock(nx * rel * k + (P.vx || 0) * 0.3, 500 + rel * 0.3, nz * rel * k + (P.vz || 0) * 0.3);
            P.vx *= 0.85; P.vz *= 0.85;
            b.state = 'dead'; b.deadT = 1.4 + this.rnd() * 0.8;
            this._event('knock', b, { speed: rel });
            if (this.rnd() < 0.6) this.say(b, 'knocked', 0.5 + this.rnd() * 0.5);
            return;
        }
        const over = reach - d;
        A.x += nx * over * 0.55; A.z += nz * over * 0.55;
        P.x -= nx * over * 0.45; P.z -= nz * over * 0.45;
        if (rel > 0) { A.vx += nx * rel * 0.4; A.vz += nz * rel * 0.4; }
    },

    // ---------------------------------------------------------------------------------------------
    // Чат
    // ---------------------------------------------------------------------------------------------

    _other(b) {
        const l = this.list.filter(o => o !== b && o.state !== 'dead' && !o.leaving);
        return l.length ? l[Math.floor(this.rnd() * l.length)] : null;
    },

    /** Реплика бота через delay с; category — из ObbyChat; {n} — этап бота. Очередь идёт по времени ботов (детерминированно). */
    say(b, category, delay, vars) {
        this.pending.push({ at: this.time + (delay || 0), bot: b, cat: category, vars });
    },

    _emit(q) {
        const b = q.bot;
        const text = ObbyChat.pick(this.lang, q.cat, () => this.rnd(), Object.assign({ n: b.stage, name: '' }, q.vars || {}));
        if (!text) return;
        this._lastSay = this.time;
        if (this.tags && this.tags.say) this.tags.say(b.id, text, 4.5);
        if (this.opts.onChat) this.opts.onChat(b, text, q.cat);
    },

    _chat(dt, cfg) {
        // очередь: не чаще одной реплики за 0.8 с
        this.pending.sort((a, b) => a.at - b.at);
        while (this.pending.length && this.pending[0].at <= this.time) {
            if (this.time - this._lastSay < 0.8) { this.pending[0].at = this._lastSay + 0.8; break; }
            const q = this.pending.shift();
            if (this.list.includes(q.bot)) this._emit(q);
        }
        if (cfg.chat <= 0 || !this.list.length) return;
        this._chatT -= dt;
        if (this._chatT > 0) return;
        this._chatT = cfg.chat * (0.5 + this.rnd());
        this.chatter();
    },

    /** Болтовня: вопрос про этап (отвечают другие), просьба о помощи (советуют) или просто реплика. */
    chatter() {
        const live = this.list.filter(o => o.state !== 'dead' && !o.leaving);
        if (!live.length) return null;
        const bot = live[Math.floor(this.rnd() * live.length)];
        const r = this.rnd();
        if (r < 0.12) {
            this.say(bot, 'ask', 0);
            const used = new Set([bot]);
            const n = 1 + Math.floor(this.rnd() * 3);
            for (let i = 0; i < n; i++) {
                const o = live.find(x => !used.has(x) && this.rnd() < 0.7);
                if (!o) break;
                used.add(o);
                this.say(o, 'answer', 1.4 + i * 1.3 + this.rnd());
            }
        } else if (r < 0.22) {
            this.say(bot, 'help', 0);
            const o = this._other(bot);
            if (o) this.say(o, 'helpReply', 1.8 + this.rnd() * 1.5);
        } else if (r < 0.32) this.say(bot, 'funny', 0);
        else this.say(bot, 'talk', 0);
        return bot;
    },

    /** Игрок взял чекпоинт: боты рядом по этапу иногда хвалят. */
    playerCheckpoint(stage) {
        const near = this.list.filter(b => Math.abs(b.stage - stage) <= 2 && b.state !== 'dead' && !b.leaving);
        if (near.length && this.rnd() < 0.35) this.say(near[Math.floor(this.rnd() * near.length)], 'playerCheckpoint', 0.8 + this.rnd());
    },

    /** Список для таблички «игроки на сервере»: ник и этап. */
    roster() { return this.list.map(b => ({ name: b.name, stage: b.stage, state: b.state })); },
};
