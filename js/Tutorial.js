// Tutorial.js — обучение новичка по действиям поверх живой игры: короткие шаги, «Пропустить» на каждом
// шаге, повтор по «Как играть». Модуль opt-in: игра 1.20 без Tutorial.init работает как раньше.
// Правила — личный навык web-game-production, «Туториал для новичков».
//
// ПОДКЛЮЧЕНИЕ (Game.init, после Input.init):
//   Tutorial.init({
//       app,                                         // обновление само (app.onUpdate), проекции мира
//       steps: [ Tutorial.preset('move'), Tutorial.preset('look'),
//                { id: 'coin', title: 'tut.coin.t', hint: 'tut.coin.h', target: '#score' } ],
//       state: () => Game.save, field: 'tutorialDone',   // отметка — ПОЛЕ общего сохранения игры
//       persist: () => Platform.save(Game.save),         // игра сама пишет ВЕСЬ объект сохранения
//       onFinish: (reason) => Game.startRound(),         // done | skip | abort: снять заморозки, дать стартовые условия
//   });
//   Tutorial.autoStart();                            // «Играть»: если ещё не пройдено — начнётся
//   Tutorial.start({ replay: true });                // пункт «Как играть» (закрой пау́зу/меню перед этим)
//   Tutorial.complete('coin');                       // игрок выполнил действие шага coin (игра сообщает)
//
// ШАГ: { id, title, hint, keys, icons, target, world, …условие… }
//   title   заголовок: ключ LANG_STRINGS или готовый текст (жирный);  hint — строка | функция | по устройствам
//           { keyboard, touch, pad, mouse, any } (значение — ключ/текст/функция ctx => строка); подсказка меняется на лету,
//           когда игрок берётся за другое устройство. В тексте {keys} — на его месте клавиши (иначе клавиши перед текстом).
//           mouse — ПК, где мышь работает как палец (Input mouseTouch, Playables: на экране стик и кнопка): слова про мышь
//           и экранную кнопку; нет такого варианта — берётся keyboard (а для указателя target — touch)
//   keys    клавиши в подсказке по устройствам: { keyboard: ['forward','left'], pad: ['jump'] } — имена действий Input
//           (подпись берётся из ТЕКУЩЕЙ привязки, переназначение учтено) или коды ('KeyE'); '=Enter' — подпись как есть
//   icons   значки перед текстом: { touch: ['stick'] } — stick | tap | swipe | mouse | mouseR | pad
//   params  подстановки {имя} в тексте (объект или функция)
//   Условие завершения (любого достаточно; без условия шаг закрывает только Tutorial.complete(id)):
//   action  'jump' | ['a','b'] — Input.pressed(действие);  move: секунд движения (Input.move());  look: px взгляда;
//   check   (ctx) => true | число 0..1 (прогресс-полоска);  event: 'имя' — закрывается Tutorial.complete('имя')
//   skipIf  () => true — условие уже выполнено при входе, шаг пропускается;  delay — секунд «галочки» после шага
//   target  на что указать: '#селектор' | элемент | () => элемент | '@context' (экранная кнопка Input) | '@stick'
//           (можно по устройствам: { touch: '@context' }) — элемент подсвечивается, над ним стрелка
//   world   () => ({ x, y, h }) | null — указатель на точку мира (стрелка над ней; за кадром — стрелка у края экрана)
//   onEnter(ctx) / onExit(ctx, completed) — свои действия на входе и выходе (спавн цели, заморозка таймера)
//   ctx = { step, index, time (с в шаге), dt, device, Tutorial }.
//
// СОСТОЯНИЕ и API:
//   Tutorial.active          идёт обучение — Daily Gift, магазин и другие окна не всплывают (проверять !Tutorial.active)
//   Tutorial.whenIdle(fn)    выполнить fn, когда обучения нет (сразу, если его нет) — отложенные окна
//   Tutorial.roundCounts()   !active: обучение — не раунд, без ads.roundEnded(), рекорда и interstitial
//   Tutorial.step / index / total / replay;  Tutorial.skip();  Tutorial.finish(reason);  Tutorial.onLoad() — сохранение
//                            загружено/сброшено: идущее обучение прерывается без отметки
//   Tutorial.on(fn)          подписка на {type: start|step|complete|finish, step, index, reason}; то же — window 'lory-tutorial'
//   Tutorial.device          'keyboard' | 'touch' | 'pad' (Input.device, иначе свой учёт);  Tutorial.setDevice(d)
//   Tutorial.variant         вариант подсказки: device, а на ПК с Input.mouseTouch — 'mouse'
//   ПОЛЕ 2:1 (ViewCap.js, Playgama на десктопе): указатели ставятся в координатах поля игры (ViewCap.x)
//   Tutorial.preset(name, over?)  готовые шаги: move, look, jump, interact (тексты ru/en в комплекте)
//
// СОХРАНЕНИЕ. Tutorial НЕ вызывает Platform.save со своим объектом (он перезаписывает сохранение целиком).
// Отметка — поле state()[field] (по умолчанию 'tutorialDone'); persist() игра зовёт сама и пишет всё сохранение.
// Вместо state/field можно isDone() / markDone(reason). Без них отметка живёт до конца сессии.
// «Пропустить»: видна с первого шага (мышь и касание, один тап), клавиша skipKey ('Enter'; null — без неё; клавиша,
// занятая действием Input, игнорируется; без Input игра сама следит, чтобы её управление и пауза не жили на Enter). После пропуска: подсветка и указатели сняты, onFinish вызван, Pause не тронута.
// ПАУЗА. Tutorial не ставит пауз и не глушит ввод. Пока Pause.active, шаги стоят, карточка скрыта;
// на lory-release-input накопленное (секунды движения) сбрасывается.
// ВИД. Нейтральная карточка сверху по центру, оформляется переменными --tut-bg/--tut-fg/--tut-accent/--tut-border/
// --tut-font/--tut-radius/--tut-z или своим css в init({ css }). Подключён HudLayout — карточка занимает место 'tc',
// не пересекаясь с HUD; без него — у верхнего края. Нижняя часть экрана (стик, кнопка) не занята.
// Числа — Constants.js (TUTORIAL_*). Тексты — ключи 'tut.*' (LANG_STRINGS, ru/en); свои строки игра кладёт в Lang.js.

/** @typedef {{ id: string, title?: string, hint?: any, keys?: any, icons?: any, params?: any, action?: string | string[], move?: number, look?: number, check?: (ctx: any) => any, event?: string, skipIf?: () => boolean, delay?: number, target?: any, world?: any, onEnter?: (ctx: any) => void, onExit?: (ctx: any, completed: boolean) => void }} TutorialStep */

// Тексты обучения (ключи 'tut.*'). Добавляются в LANG_STRINGS, если ключа там ещё нет — игра может переопределить.
const TUTORIAL_LANG = {
    ru: {
        'tut.skip': 'Пропустить', 'tut.howto': 'Как играть', 'tut.done': 'Обучение пройдено!', 'tut.step': '{n} из {m}',
        'tut.move.t': 'Двигайся', 'tut.move.keyboard': 'Нажимай {keys}, чтобы идти', 'tut.move.touch': 'Веди пальцем по левой половине экрана', 'tut.move.pad': 'Левый стик — идти',
        'tut.look.t': 'Осмотрись', 'tut.look.lock': 'Води мышью, чтобы оглядеться', 'tut.look.drag': 'Зажми правую кнопку мыши и води',
        'tut.look.touch': 'Води пальцем по правой половине экрана', 'tut.look.pad': 'Правый стик — камера',
        'tut.jump.t': 'Прыжок', 'tut.jump.keyboard': 'Нажми {keys}, чтобы прыгнуть', 'tut.jump.touch': 'Нажми кнопку прыжка', 'tut.jump.pad': 'Нажми {keys}, чтобы прыгнуть',
        'tut.interact.t': 'Действие', 'tut.interact.keyboard': 'Нажми {keys}', 'tut.interact.touch': 'Нажми кнопку действия', 'tut.interact.pad': 'Нажми {keys}',
        // ПК, где мышь работает как палец (mouseTouch, Playables): экранные стик и кнопка + мышь
        'tut.move.mouse': 'Нажимай {keys} или тяни мышью по левой половине экрана', 'tut.look.mouse': 'Тяни мышью по правой половине экрана',
        'tut.jump.mouse': 'Нажми {keys} или кнопку на экране', 'tut.jump.mouseR': 'Нажми {keys}, правую кнопку мыши или кнопку на экране',
        'tut.interact.mouse': 'Нажми {keys} или кнопку действия на экране',
    },
    en: {
        'tut.skip': 'Skip', 'tut.howto': 'How to play', 'tut.done': 'Tutorial complete!', 'tut.step': '{n} of {m}',
        'tut.move.t': 'Move around', 'tut.move.keyboard': 'Press {keys} to move', 'tut.move.touch': 'Drag your finger on the left half of the screen', 'tut.move.pad': 'Left stick to move',
        'tut.look.t': 'Look around', 'tut.look.lock': 'Move the mouse to look around', 'tut.look.drag': 'Hold the right mouse button and drag',
        'tut.look.touch': 'Drag your finger on the right half of the screen', 'tut.look.pad': 'Right stick to look',
        'tut.jump.t': 'Jump', 'tut.jump.keyboard': 'Press {keys} to jump', 'tut.jump.touch': 'Tap the jump button', 'tut.jump.pad': 'Press {keys} to jump',
        'tut.interact.t': 'Action', 'tut.interact.keyboard': 'Press {keys}', 'tut.interact.touch': 'Tap the action button', 'tut.interact.pad': 'Press {keys}',
        // PC where the mouse acts as a finger (mouseTouch, Playables): on-screen stick and button + mouse
        'tut.move.mouse': 'Press {keys} or drag the mouse on the left half of the screen', 'tut.look.mouse': 'Drag the mouse on the right half of the screen',
        'tut.jump.mouse': 'Press {keys} or the on-screen button', 'tut.jump.mouseR': 'Press {keys}, the right mouse button or the on-screen button',
        'tut.interact.mouse': 'Press {keys} or the on-screen action button',
    },
};
if (typeof LANG_STRINGS !== 'undefined') {
    for (const code of Object.keys(TUTORIAL_LANG)) {
        const dict = LANG_STRINGS[code] || (LANG_STRINGS[code] = {});
        for (const [key, text] of Object.entries(TUTORIAL_LANG[code])) if (!(key in dict)) dict[key] = text;
    }
}

// Значки подсказок: статичная разметка (не данные игры), рисуется currentColor.
const TUTORIAL_ICONS = {
    stick: '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="16" cy="16" r="5" fill="currentColor"/></svg>',
    tap: '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="5" fill="currentColor"/><circle cx="16" cy="16" r="11" fill="none" stroke="currentColor" stroke-width="2" opacity=".6"/></svg>',
    swipe: '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="8" cy="16" r="4" fill="currentColor"/><path d="M14 16h13m-5-5 5 5-5 5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    mouse: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="9" y="3" width="14" height="26" rx="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 3v9" stroke="currentColor" stroke-width="2"/></svg>',
    mouseR: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="9" y="3" width="14" height="26" rx="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 3v9M16 3a7 7 0 0 1 7 7v2h-7z" fill="currentColor" stroke="currentColor" stroke-width="2"/></svg>',
    pad: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M8 10h16a5 5 0 0 1 5 5l1 7a3 3 0 0 1-5 2l-3-3h-8l-3 3a3 3 0 0 1-5-2l1-7a5 5 0 0 1 5-5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
};

/** @satisfies {Record<string, any>} */
const Tutorial = {
    // --- состояние (только чтение) ---
    /** Идёт обучение: Daily Gift, магазин и прочие окна ждут (!Tutorial.active). */
    active: false,
    /** Запущено заново по «Как играть»: отметка в сохранении не меняется. */
    replay: false,
    /** id текущего шага ('' — обучения нет). */
    step: '',
    index: -1,
    /** @type {TutorialStep[]} */
    steps: [],
    opts: /** @type {Record<string, any>} */ ({}),

    // --- внутреннее ---
    _inited: false,
    /** 'step' — ждём действие; 'done' — «галочка» перед следующим. */
    _phase: 'step',
    _phaseT: 0,
    _time: 0,
    _acc: 0,
    _lookBase: 0,
    _progress: -1,
    _doneIds: new Set(),
    _doneLocal: false,
    _pendingMark: false,
    _device: 'keyboard',
    _sig: '',
    _uiT: 0,
    _edgeT: 0,
    _finalT: 0,
    /** @type {Function[]} */
    _subs: [],
    /** @type {Function[]} */
    _idle: [],
    /** @type {(() => void)[]} */
    _unbind: [],
    /** @type {LoryApp | null} */
    app: null,
    /** @type {any} */
    ui: null,
    /** @type {HTMLElement | null} */
    hlEl: null,
    /** @type {any} */
    _w: null,

    // =====================================================================================
    // Запуск
    // =====================================================================================

    cfg() {
        const U = 'undefined';
        return {
            delay: typeof TUTORIAL_STEP_DELAY !== U ? TUTORIAL_STEP_DELAY : 0.7,
            moveSeconds: typeof TUTORIAL_MOVE_SECONDS !== U ? TUTORIAL_MOVE_SECONDS : 1.2,
            lookPixels: typeof TUTORIAL_LOOK_PIXELS !== U ? TUTORIAL_LOOK_PIXELS : 260,
            finalSeconds: typeof TUTORIAL_FINAL_SECONDS !== U ? TUTORIAL_FINAL_SECONDS : 2.5,
        };
    },

    /**
     * Настройка. opts: { app, steps, state, field, persist, isDone, markDone, onStart, onFinish, skipKey,
     * finalText, css, hud: false, ui: false (без DOM — тесты и свой интерфейс), project: (x, y, h) => {x, y, visible, behind} }.
     */
    init(opts) {
        const o = opts || {};
        this.opts = o;
        this.app = o.app || (typeof window !== 'undefined' && window.app) || null;
        if (o.steps) this.setSteps(o.steps);
        if (this._inited) return this;
        this._inited = true;
        this._device = (typeof IS_MOBILE !== 'undefined' && IS_MOBILE) ? 'touch' : 'keyboard';
        this._bind();
        if (this.app && typeof this.app.onUpdate === 'function' && !o.manual) this.app.onUpdate(dt => this.update(dt));
        return this;
    },

    /** Заменить шаги (до start). Шаги без id или с повторным id отбрасываются с предупреждением. */
    setSteps(steps) {
        const seen = new Set();
        this.steps = [];
        for (const s of steps || []) {
            if (!s || typeof s.id !== 'string' || !s.id || seen.has(s.id)) { console.warn('Tutorial: шаг без id или с повторным id пропущен', s && s.id); continue; }
            seen.add(s.id);
            this.steps.push(s);
        }
        return this;
    },

    /** Снять подписки и интерфейс (перезапуск игры, тесты). */
    dispose() {
        for (const off of this._unbind) off();
        this._unbind.length = 0;
        this._teardownUi();
        this.active = false;
        this.step = ''; this.index = -1;
        this._inited = false;
        this._subs = []; this._idle = [];
    },

    // =====================================================================================
    // Отметка «пройдено» — поле общего сохранения игры
    // =====================================================================================

    _stateObj() {
        const f = this.opts.state;
        try { return typeof f === 'function' ? f() : (f || null); } catch (e) { return null; }
    },

    _field() { return this.opts.field || 'tutorialDone'; },

    /** Обучение уже пройдено или пропущено (по сохранению игры). */
    isDone() {
        const o = this.opts;
        if (typeof o.isDone === 'function') { try { return !!o.isDone(); } catch (e) { return false; } }
        const s = this._stateObj();
        if (s) return !!s[this._field()] || this._doneLocal;
        return this._doneLocal;
    },

    // Записать отметку в поле сохранения игры и попросить игру сохранить его целиком. Сами Platform.save не зовём.
    _markDone(reason) {
        const o = this.opts;
        this._doneLocal = true;
        if (typeof o.markDone === 'function') { try { o.markDone(reason); } catch (e) { console.error('Tutorial.markDone:', e); } return; }
        const s = this._stateObj();
        if (!s) { this._pendingMark = true; return; }   // сохранение ещё не загружено — запишем в onLoad / при следующем обращении
        this._pendingMark = false;
        if (!s[this._field()]) {
            s[this._field()] = true;
            if (typeof o.persist === 'function') { try { o.persist(reason); } catch (e) { console.error('Tutorial.persist:', e); } }
        }
    },

    /**
     * Сохранение загружено или сброшено (после Platform.load, «сбросить прогресс»): идущее обучение прерывается без отметки;
     * отметка, поставленная до загрузки, переносится в новый объект.
     */
    onLoad() {
        if (this.active) this.finish('abort');
        if (this._pendingMark && !this.replay) this._markDone('load');
    },

    // =====================================================================================
    // Запуск, пропуск, выход
    // =====================================================================================

    /** Первый запуск: начать, если обучение ещё не пройдено и не пропущено. true — началось. */
    autoStart() {
        if (this.active || this.isDone()) return false;
        return this.start({ replay: false });
    },

    /** Начать (или начать заново) с первого шага. replay — «Как играть»: отметка в сохранении не трогается. */
    start(opts) {
        if (!this.steps.length) return false;
        if (this.active) this.finish('abort');
        this.replay = !!(opts && opts.replay);
        this._doneIds.clear();
        this.active = true;
        this._phase = 'step';
        this._finalT = 0;
        this._sig = '';
        this._buildUi();
        if (this.ui) {
            this.ui.layer.hidden = false;
            this.ui.card.hidden = false;
            if (this.ui.final && this.ui.final.remove) this.ui.final.remove();
            this.ui.final = null;
        }
        if (typeof this.opts.onStart === 'function') { try { this.opts.onStart({ replay: this.replay }); } catch (e) { console.error('Tutorial.onStart:', e); } }
        this._emit('start', null, -1);
        this._enter(0);
        if (this.active) this._uiTick(0, true);   // карточка заполнена сразу, не со следующего кадра
        return this.active;
    },

    /** «Пропустить»: одно нажатие, сразу обычная игра; в сохранении — пройдено. */
    skip() {
        if (!this.active) return;
        this.finish('skip');
    },

    /** Выход: 'done' | 'skip' | 'abort' (abort — без отметки). Подсветка и указатели сняты, onFinish вызван одинаково. */
    finish(reason) {
        if (!this.active) return;
        const why = reason || 'done';
        const st = this.steps[this.index];
        const wasPhase = this._phase;
        this.active = false;
        this.step = ''; this.index = -1;
        if (st && st.onExit && wasPhase === 'step') { try { st.onExit(this._ctx(st, 0), false); } catch (e) { console.error('Tutorial.onExit:', e); } }
        this._clearPointers();
        if (this.ui) this.ui.card.hidden = true;
        const replay = this.replay;
        if (!replay && (why === 'done' || why === 'skip')) this._markDone(why);
        if (typeof this.opts.onFinish === 'function') { try { this.opts.onFinish(why, { replay }); } catch (e) { console.error('Tutorial.onFinish:', e); } }
        this._emit('finish', null, -1, why);
        if (why === 'done') this._showFinal();
        else if (this.ui) this.ui.layer.hidden = true;
        const q = this._idle.splice(0, this._idle.length);
        for (const fn of q) { try { fn(); } catch (e) { console.error('Tutorial.whenIdle:', e); } }
    },

    /** Выполнить fn, когда обучения нет (сразу, если оно не идёт): окна Daily Gift, магазина, колеса. */
    whenIdle(fn) {
        if (!this.active) fn(); else this._idle.push(fn);
    },

    /** Раунд ли это для рекламы и рекордов: обучение — нет (не звать ads.roundEnded, submitScore). */
    roundCounts() { return !this.active; },

    get total() { return this.steps.length; },

    /** Игрок выполнил действие шага. id — id или event шага; без id — текущий. Заранее выполненное будущее запоминается. */
    complete(id) {
        if (!this.active) return false;
        const cur = this.steps[this.index];
        const key = id === undefined ? (cur && cur.id) : id;
        if (!key) return false;
        this._doneIds.add(key);
        if (cur && this._phase === 'step' && (cur.id === key || cur.event === key)) { this._stepDone(); return true; }
        return false;
    },

    on(fn) {
        this._subs.push(fn);
        return () => { const i = this._subs.indexOf(fn); if (i >= 0) this._subs.splice(i, 1); };
    },

    _emit(type, step, index, reason) {
        const detail = { type, step: step ? step.id : this.step, index: index === undefined ? this.index : index, reason: reason || '' };
        for (const fn of this._subs.slice()) { try { fn(detail); } catch (e) { console.error('Tutorial.on:', e); } }
        if (typeof window !== 'undefined' && typeof Event === 'function' && window.dispatchEvent) {
            const ev = /** @type {any} */ (new Event('lory-tutorial'));
            ev.detail = detail;
            window.dispatchEvent(ev);
        }
    },

    // =====================================================================================
    // Шаги
    // =====================================================================================

    _ctx(st, dt) { return { step: st, index: this.index, time: this._time, dt, device: this.device, Tutorial: this }; },

    _skippable(st) {
        if (this._doneIds.has(st.id) || (st.event && this._doneIds.has(st.event))) return true;
        if (typeof st.skipIf === 'function') { try { return !!st.skipIf(); } catch (e) { return false; } }
        return false;
    },

    // Войти в шаг i (или в ближайший после него, не пропускаемый); шагов не осталось — обучение пройдено.
    _enter(i) {
        while (i < this.steps.length && this._skippable(this.steps[i])) i++;
        if (i >= this.steps.length) { this.finish('done'); return; }
        const st = this.steps[i];
        this.index = i;
        this.step = st.id;
        this._phase = 'step';
        this._time = 0;
        this._acc = 0;
        this._progress = -1;
        this._lookBase = this._input() ? Input.lookTotal : 0;
        this._sig = '';
        this._uiT = 0;
        if (typeof st.onEnter === 'function') { try { st.onEnter(this._ctx(st, 0)); } catch (e) { console.error('Tutorial.onEnter:', e); } }
        this._emit('step', st, i);
    },

    _stepDone() {
        const st = this.steps[this.index];
        if (!st || this._phase !== 'step') return;
        if (typeof st.onExit === 'function') { try { st.onExit(this._ctx(st, 0), true); } catch (e) { console.error('Tutorial.onExit:', e); } }
        this._emit('complete', st, this.index);
        const delay = typeof st.delay === 'number' ? st.delay : this.cfg().delay;
        if (delay <= 0) { this._enter(this.index + 1); return; }
        this._phase = 'done';
        this._phaseT = delay;
        this._clearPointers();
        this._sig = '';
    },

    _input() { return typeof Input !== 'undefined' && !!Input._inited; },

    // Условие шага: true | число 0..1 (прогресс) | -1 (нет прогресса)
    _eval(st, dt) {
        let progress = -1;
        const inp = this._input();
        if (st.action && inp) {
            for (const a of Array.isArray(st.action) ? st.action : [st.action]) if (Input.pressed(a)) return true;
        }
        if (st.move && inp) {
            const m = Input.move();
            if (Math.hypot(m.x, m.y) > 0.25) this._acc += dt;
            progress = Math.max(progress, this._acc / st.move);
        }
        if (st.look && inp) progress = Math.max(progress, (Input.lookTotal - this._lookBase) / st.look);
        if (typeof st.check === 'function') {
            let r = false;
            try { r = st.check(this._ctx(st, dt)); } catch (e) { console.error('Tutorial.check:', e); }
            if (r === true) return true;
            if (typeof r === 'number') progress = Math.max(progress, r);
        }
        return progress >= 1 ? true : progress;
    },

    /** Каждый кадр вне паузы (app.onUpdate зовёт сам): условие шага, «галочка», интерфейс. */
    update(dt) {
        if (this._finalT > 0) {
            this._finalT -= dt;
            if (this._finalT <= 0 && this.ui && !this.active) this.ui.layer.hidden = true;
        }
        if (!this.active) return;
        if (typeof Pause !== 'undefined' && Pause.active) return;
        this._time += dt;
        const st = this.steps[this.index];
        if (this._phase === 'done') {
            this._phaseT -= dt;
            if (this._phaseT <= 0) this._enter(this.index + 1);
        } else if (st) {
            if (this._doneIds.has(st.id) || (st.event && this._doneIds.has(st.event))) this._stepDone();
            else {
                const r = this._eval(st, dt);
                if (r === true) this._stepDone();
                else if (r >= 0) this._setProgress(r);
            }
        }
        if (this.active) this._uiTick(dt, false);
    },

    _setProgress(f) {
        const k = Math.round(Math.max(0, Math.min(1, f)) * 50);
        if (k === this._progress) return;
        this._progress = k;
        if (this.ui) { this.ui.bar.hidden = false; this.ui.barFill.style.width = (k * 2) + '%'; }
    },

    // =====================================================================================
    // Устройство ввода и тексты
    // =====================================================================================

    /** 'keyboard' | 'touch' | 'pad': Input.device, если Input запущен, иначе свой учёт касаний и клавиш. */
    get device() { return this._input() ? Input.device : this._device; },

    setDevice(d) { this._device = d; },

    /**
     * Вариант подсказки: 'keyboard' | 'touch' | 'pad' | 'mouse'. 'mouse' — ПК, где мышь работает как палец
     * (Input.configure({ mouseTouch: true }), Playables): на экране стик и кнопка, клавиатура тоже работает.
     * Шаг может задать подсказку, клавиши, значки и указатель отдельно для 'mouse'; нет — берётся 'keyboard'
     * (указатель — 'touch': стик и кнопка Input видны).
     */
    get variant() { return this.device === 'keyboard' && this._input() && Input.mouseTouch ? 'mouse' : this.device; },

    // Цепочка запасных вариантов подсказки. Указатель (target) у 'mouse' идёт через 'touch': экранные стик и кнопка те же.
    _chain(device, target) {
        if (device === 'mouse') return target ? ['mouse', 'touch', 'keyboard', 'any'] : ['mouse', 'keyboard', 'any'];
        return device === 'touch' ? ['touch', 'any'] : device === 'pad' ? ['pad', 'any', 'keyboard'] : ['keyboard', 'any'];
    },

    // Значение по устройствам: строка/функция/элемент — для всех; объект { keyboard, touch, pad, mouse, any } — по цепочке.
    _pick(spec, device, target) {
        if (spec === undefined || spec === null) return undefined;
        const plain = typeof spec !== 'object' || Array.isArray(spec) || spec.nodeType;
        if (plain) return spec;
        for (const k of this._chain(device, target)) if (spec[k] !== undefined) return spec[k];
        return undefined;
    },

    /** Текст: ключ LANG_STRINGS или готовая строка (Lang.t вернёт сам ключ, если ключа нет). */
    text(keyOrText, params) {
        if (keyOrText === undefined || keyOrText === null) return '';
        return typeof Lang !== 'undefined' ? Lang.t(String(keyOrText), params) : String(keyOrText).replace(/\{(\w+)\}/g, (m, k) => (params && k in params ? String(params[k]) : m));
    },

    // Подпись клавиши подсказки: действие Input (текущая привязка и устройство), код клавиши или '=как есть'.
    _keyLabel(entry, device) {
        const e = String(entry);
        if (e[0] === '=') return e.slice(1);
        if (this._input()) {
            if (Input._defs && Input._defs[e]) return Input.labelOf(e, device === 'touch' || device === 'mouse' ? 'keyboard' : device) || e;
            return Input.label(e);
        }
        const m = /^Key([A-Z])$/.exec(e);
        return m ? m[1] : e;
    },

    /**
     * Модель подсказки шага под устройство: { title, parts: [{ t: 'icon', name } | { t: 'key', label } | { t: 'text', text }], bar }.
     * Чистая функция от шага и устройства — по ней строится интерфейс и проверяется смена подсказки.
     */
    hintParts(st, device) {
        const ctx = this._ctx(st, 0);
        const dev = device || this.variant;
        const call = (v) => (typeof v === 'function' ? v(ctx) : v);
        let params = call(st.params) || {};
        const hint = call(this._pick(st.hint, dev));
        const raw = hint === undefined ? '' : this.text(hint, params);
        const keysSpec = this._pick(st.keys, dev), iconsSpec = this._pick(st.icons, dev);
        const keys = Array.isArray(keysSpec) ? keysSpec.map(k => this._keyLabel(k, dev)) : [];
        /** @type {{ t: string, name?: string, label?: string, text?: string }[]} */
        const parts = [];
        if (Array.isArray(iconsSpec)) for (const name of iconsSpec) parts.push({ t: 'icon', name });
        const i = raw.indexOf('{keys}');
        const caps = () => { for (const label of keys) parts.push({ t: 'key', label }); };
        if (i >= 0) {
            // пробелы вокруг {keys} сохраняются: подсказка течёт строкой, клавиши — вставки в тексте
            const before = raw.slice(0, i), after = raw.slice(i + 6);
            if (before.trim()) parts.push({ t: 'text', text: before });
            caps();
            if (after.trim()) parts.push({ t: 'text', text: after });
        } else {
            caps();
            if (raw) parts.push({ t: 'text', text: raw });
        }
        return { title: st.title ? this.text(st.title, params) : '', parts, bar: !!(st.move || st.look || st.progress === true) };
    },

    // =====================================================================================
    // Готовые шаги
    // =====================================================================================

    /** Готовый шаг: 'move' | 'look' | 'jump' | 'interact'. over поверх (id, тексты, условие). */
    preset(name, over) {
        const c = this.cfg();
        /** @type {Record<string, TutorialStep>} */
        const base = {
            // mouse — ПК с mouseTouch (мышь как палец, Playables): слова про мышь и экранные стик и кнопку; клавиши — как у keyboard
            move: {
                id: 'move', title: 'tut.move.t',
                hint: { keyboard: 'tut.move.keyboard', mouse: 'tut.move.mouse', touch: 'tut.move.touch', pad: 'tut.move.pad' },
                keys: { keyboard: ['forward', 'left', 'back', 'right'] }, icons: { touch: ['stick'], pad: ['pad'] },
                move: c.moveSeconds, target: { touch: '@stick' },
            },
            look: {
                id: 'look', title: 'tut.look.t',
                hint: { keyboard: () => (typeof Input !== 'undefined' && Input.mouseMode === 'lock' ? 'tut.look.lock' : 'tut.look.drag'), mouse: 'tut.look.mouse', touch: 'tut.look.touch', pad: 'tut.look.pad' },
                icons: { keyboard: ['mouse'], touch: ['swipe'], pad: ['pad'] },
                look: c.lookPixels,
            },
            jump: {
                id: 'jump', title: 'tut.jump.t',
                // на ПКМ прыжок только если игра привязала к jump 'Mouse2' (Input.init({ actions })): иначе подсказка не врёт
                hint: { keyboard: 'tut.jump.keyboard', mouse: () => (typeof Input !== 'undefined' && Input.hasKey('jump', 'Mouse2') ? 'tut.jump.mouseR' : 'tut.jump.mouse'), touch: 'tut.jump.touch', pad: 'tut.jump.pad' },
                keys: { keyboard: ['jump'], pad: ['jump'] }, action: 'jump', target: { touch: '@context' },
            },
            interact: {
                id: 'interact', title: 'tut.interact.t', hint: { keyboard: 'tut.interact.keyboard', mouse: 'tut.interact.mouse', touch: 'tut.interact.touch', pad: 'tut.interact.pad' },
                keys: { keyboard: ['interact'], pad: ['interact'] }, action: 'interact', target: { touch: '@context' },
            },
        };
        const s = base[name];
        if (!s) throw new Error('Tutorial.preset: нет заготовки «' + name + '»');
        return Object.assign({}, s, over || {});
    },

    // =====================================================================================
    // Обработчики
    // =====================================================================================

    _bind() {
        if (typeof window === 'undefined') return;
        const on = (t, type, fn, opt) => {
            if (!t || !t.addEventListener) return;
            t.addEventListener(type, fn, opt);
            this._unbind.push(() => t.removeEventListener(type, fn, opt));
        };
        on(window, 'lory-input-device', e => { if (e && e.detail && e.detail.device) this._device = e.detail.device; });
        // свой учёт устройства, если Input не запущен
        on(window, 'pointerdown', e => { if (!this._input()) this._device = e.pointerType === 'touch' ? 'touch' : 'keyboard'; }, true);
        on(window, 'keydown', e => this._onKey(e));
        on(window, 'lory-release-input', () => {
            // зажатое при потере ввода не считается: секунды движения набираются заново
            this._acc = 0;
            this._lookBase = this._input() ? Input.lookTotal : 0;
        });
        on(window, 'resize', () => { this._uiT = 0; });
        if (typeof Pause !== 'undefined' && Pause.onChange) this._unbind.push(Pause.onChange(() => this._syncPause()));
    },

    _onKey(e) {
        if (!this.active) { if (!this._input()) this._device = 'keyboard'; return; }
        if (!this._input()) this._device = 'keyboard';
        const key = this.opts.skipKey === undefined ? 'Enter' : this.opts.skipKey;
        if (!key || e.repeat || e.code !== key) return;
        const t = e.target;
        if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
        if (typeof Pause !== 'undefined' && Pause.active) return;
        if (this._input() && Input.isBound(key)) return;   // клавиша занята управлением
        if (e.preventDefault) e.preventDefault();
        this.skip();
    },

    _syncPause() {
        if (!this.ui) return;
        const paused = typeof Pause !== 'undefined' && Pause.active;
        this.ui.layer.classList.toggle('lory-tut-paused', paused);
    },

    // =====================================================================================
    // Интерфейс
    // =====================================================================================

    _css() {
        if (typeof document === 'undefined' || !document.head || document.getElementById('lory-tut-css')) return;
        const st = document.createElement('style');
        st.id = 'lory-tut-css';
        st.textContent = [
            '.lory-tut{position:fixed;inset:0;z-index:var(--tut-z,60);pointer-events:none;font-family:var(--tut-font,system-ui,sans-serif);-webkit-tap-highlight-color:transparent}',
            '.lory-tut[hidden],.lory-tut-card[hidden],.lory-tut-bar[hidden]{display:none}',
            '.lory-tut.lory-tut-paused{visibility:hidden}',
            '.lory-tut-card{position:absolute;box-sizing:border-box;display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:10px 14px;max-width:min(560px,calc(100vw - 20px));',
            'background:var(--tut-bg,rgba(16,24,40,.92));color:var(--tut-fg,#fff);border:2px solid var(--tut-border,rgba(255,255,255,.35));border-radius:var(--tut-radius,14px);box-shadow:0 4px 18px rgba(0,0,0,.35)}',
            '.lory-tut-card:not([data-hl]){left:50%;top:max(env(safe-area-inset-top,0px),8px);transform:translateX(-50%);width:max-content}',
            '.lory-tut-card.lory-tut-ok{border-color:var(--tut-accent,#7be07b)}',
            '.lory-tut-main{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 200px}',
            '.lory-tut-title{font-weight:900;font-size:clamp(17px,calc(var(--hl-fs,16px)*1.25),24px);line-height:1.1}',
            '.lory-tut-hint{display:block;font-weight:700;font-size:clamp(14px,var(--hl-fs,16px),19px);line-height:1.9}',
            '.lory-tut-hint>*{vertical-align:middle}',
            '.lory-tut-hint svg{display:inline-block;width:1.8em;height:1.8em;margin-right:.35em;vertical-align:middle}',
            '.lory-tut-key{display:inline-flex;align-items:center;justify-content:center;min-width:1.7em;height:1.7em;margin:0 .12em;padding:0 .4em;box-sizing:border-box;border-radius:.4em;',
            'background:var(--tut-fg,#fff);color:var(--tut-bg,#101828);font-family:inherit;font-weight:800;font-size:.95em;line-height:1;box-shadow:0 2px 0 rgba(0,0,0,.4)}',
            '.lory-tut-bar{height:8px;border-radius:99px;background:rgba(255,255,255,.2);overflow:hidden}',
            '.lory-tut-bar i{display:block;height:100%;width:0;background:var(--tut-accent,#7be07b);transition:width .15s linear}',
            '.lory-tut-side{display:flex;align-items:center;gap:10px;flex:0 0 auto;margin-left:auto}',
            '.lory-tut-skip{pointer-events:auto;cursor:pointer;display:inline-flex;align-items:center;gap:8px;min-height:36px;padding:6px 14px;border:2px solid var(--tut-border,rgba(255,255,255,.55));border-radius:999px;',
            'background:var(--tut-accent-bg,rgba(255,255,255,.12));color:inherit;font-family:inherit;font-weight:800;font-size:14px;line-height:1;touch-action:manipulation;-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none}',
            '.lory-tut-skip kbd{font-family:inherit;font-weight:700;font-size:11px;line-height:1;padding:2px 6px;border-radius:5px;background:var(--tut-fg,#fff);color:var(--tut-bg,#101828)}',
            '.lory-tut-touch .lory-tut-skip{min-height:44px;padding:8px 18px;font-size:15px}',
            '.lory-tut-dots{display:flex;gap:5px}',
            '.lory-tut-dots i{width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.25)}',
            '.lory-tut-dots i.done{background:var(--tut-accent,#7be07b)}',
            '.lory-tut-dots i.cur{background:var(--tut-fg,#fff);transform:scale(1.3)}',
            '.lory-tut-pointer,.lory-tut-edge{position:absolute;left:0;top:0;width:34px;height:40px;margin-left:-17px;display:none;will-change:transform;color:var(--tut-accent,#ffd84a);filter:drop-shadow(0 2px 2px rgba(0,0,0,.5))}',
            '.lory-tut-pointer.on,.lory-tut-edge.on{display:block}',
            '.lory-tut-pointer svg,.lory-tut-edge svg{display:block;width:100%;height:100%;animation:lory-tut-bob .6s ease-in-out infinite alternate}',
            '.lory-tut-pointer.below svg{transform:rotate(180deg)}',
            '.lory-tut-edge{width:40px;height:40px;margin:-20px 0 0 -20px}',
            '.lory-tut-final{position:absolute;left:50%;top:max(env(safe-area-inset-top,0px),8px);transform:translateX(-50%);padding:10px 18px;border-radius:var(--tut-radius,14px);',
            'background:var(--tut-bg,rgba(16,24,40,.92));color:var(--tut-fg,#fff);font-weight:900;font-size:clamp(15px,var(--hl-fs,16px),22px);border:2px solid var(--tut-accent,#7be07b);white-space:nowrap}',
            '.lory-tut-hl{outline:4px solid var(--tut-accent,#ffd84a);outline-offset:3px;animation:lory-tut-glow .75s ease-in-out infinite alternate}',
            '@keyframes lory-tut-bob{from{transform:translateY(-4px)}to{transform:translateY(6px)}}',
            '.lory-tut-pointer.below svg{animation-name:lory-tut-bob2}',
            '@keyframes lory-tut-bob2{from{transform:rotate(180deg) translateY(-4px)}to{transform:rotate(180deg) translateY(6px)}}',
            '@keyframes lory-tut-glow{from{outline-color:var(--tut-accent,#ffd84a)}to{outline-color:#fff}}',
            '@media (prefers-reduced-motion:reduce){.lory-tut-pointer svg,.lory-tut-edge svg,.lory-tut-hl{animation:none}}',
            '@media (max-height:420px){.lory-tut-card{padding:6px 10px;gap:8px}.lory-tut-dots{display:none}}',
        ].join('') + (this.opts.css || '');
        document.head.appendChild(st);
    },

    _buildUi() {
        if (this.ui || this.opts.ui === false || typeof document === 'undefined' || !document.body) return;
        this._css();
        const E = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; };
        const layer = E('div', 'lory-tut');
        layer.setAttribute('role', 'region');
        layer.setAttribute('aria-live', 'polite');
        const card = E('div', 'lory-tut-card');
        const main = E('div', 'lory-tut-main');
        const title = E('div', 'lory-tut-title'), hint = E('div', 'lory-tut-hint');
        const barFill = E('i'), bar = E('div', 'lory-tut-bar');
        bar.appendChild(barFill); bar.hidden = true;
        main.appendChild(title); main.appendChild(hint); main.appendChild(bar);
        const side = E('div', 'lory-tut-side');
        const skip = /** @type {HTMLButtonElement} */ (E('button', 'lory-tut-skip'));
        skip.type = 'button';
        skip.tabIndex = -1;       // Пробел и Enter управляют игрой — кнопка не должна забирать фокус клавиатуры
        const dots = E('div', 'lory-tut-dots');
        side.appendChild(skip); side.appendChild(dots);
        card.appendChild(main); card.appendChild(side);
        const pointer = E('div', 'lory-tut-pointer'), edge = E('div', 'lory-tut-edge');
        const arrow = '<svg viewBox="0 0 34 40" aria-hidden="true"><path d="M17 38 3 18h9V3h10v15h9z" fill="currentColor" stroke="#000" stroke-width="2" stroke-linejoin="round"/></svg>';
        pointer.innerHTML = arrow;
        edge.innerHTML = arrow;
        layer.appendChild(card); layer.appendChild(pointer); layer.appendChild(edge);
        document.body.appendChild(layer);
        skip.addEventListener('click', e => { e.preventDefault(); skip.blur(); this.skip(); });
        this.ui = { layer, card, title, hint, bar, barFill, skip, dots, pointer, edge, dotEls: [], final: null };
        if (typeof HudLayout !== 'undefined' && HudLayout._inited && this.opts.hud !== false) {
            HudLayout.block('tutorial', { dock: 'tc', w: 560, maxW: 560, minW: 260, h: 'auto', order: -5, el: card });
        }
        this._syncPause();
    },

    _teardownUi() {
        this._clearPointers();
        if (this.ui && this.ui.layer && this.ui.layer.remove) this.ui.layer.remove();
        this.ui = null;
        if (typeof HudLayout !== 'undefined' && HudLayout.remove) HudLayout.remove('tutorial');
    },

    _renderStep(st) {
        const ui = this.ui;
        if (!ui) return;
        const dev = this.device;
        const model = this.hintParts(st, this.variant);
        ui.title.textContent = model.title;
        ui.title.hidden = !model.title;
        ui.hint.textContent = '';
        for (const p of model.parts) {
            let el;
            if (p.t === 'icon') {
                el = document.createElement('span');
                el.innerHTML = TUTORIAL_ICONS[p.name] || '';
            } else if (p.t === 'key') {
                el = document.createElement('kbd');
                el.className = 'lory-tut-key';
                el.textContent = p.label;
            } else {
                el = document.createElement('span');
                el.textContent = p.text;
            }
            ui.hint.appendChild(el);
        }
        ui.bar.hidden = !model.bar;
        ui.barFill.style.width = '0%';
        this._progress = -1;
        // «Пропустить»: видна на каждом шаге; клавиша — только на ПК и если не занята управлением
        const skipKey = this.opts.skipKey === undefined ? 'Enter' : this.opts.skipKey;
        const label = this.text('tut.skip');
        ui.skip.textContent = '';
        const span = document.createElement('span');
        span.textContent = label;
        ui.skip.appendChild(span);
        if (skipKey && dev === 'keyboard' && !(this._input() && Input.isBound(skipKey))) {
            const k = document.createElement('kbd');
            k.textContent = this._keyLabel(skipKey, 'keyboard');
            ui.skip.appendChild(k);
        }
        ui.skip.setAttribute('aria-label', label);
        ui.layer.classList.toggle('lory-tut-touch', dev === 'touch');
        // точки прогресса
        if (ui.dotEls.length !== this.steps.length) {
            ui.dots.textContent = '';
            ui.dotEls = this.steps.map(() => ui.dots.appendChild(document.createElement('i')));
        }
        ui.dotEls.forEach((d, i) => { d.className = i < this.index ? 'done' : i === this.index ? 'cur' : ''; });
        ui.card.classList.remove('lory-tut-ok');
    },

    // Раз в кадр: подпись при смене шага / устройства / языка, указатели — 10 раз в секунду.
    _uiTick(dt, force) {
        const ui = this.ui;
        if (!ui || !this.active) return;
        const st = this.steps[this.index];
        if (!st) return;
        const dev = this.variant;
        const sig = st.id + '|' + this._phase + '|' + dev + '|' + (typeof Lang !== 'undefined' ? Lang.code : '');
        if (sig !== this._sig) {
            this._sig = sig;
            this._renderStep(st);
            if (this._phase === 'done') { ui.card.classList.add('lory-tut-ok'); ui.bar.hidden = true; }
        }
        if (this._phase === 'done') return;
        this._uiT -= dt;
        if (force || this._uiT <= 0) {
            this._uiT = 0.1;
            const el = this._targetEl(st, dev);
            this._highlight(el);
            this._placePointer(el);
            this._w = this._worldTarget(st, dev);
            if (!this._w) ui.edge.classList.remove('on');
        }
        if (this._w) {
            this._edgeT -= dt;
            if (this._edgeT <= 0 || force) { this._edgeT = 0.033; this._placeWorld(this._w); }
        }
    },

    // =====================================================================================
    // Указатели: подсветка элемента, стрелка над ним, цель в мире
    // =====================================================================================

    _shown(el) {
        if (!el || el.isConnected === false || el.hidden) return false;
        return typeof el.getClientRects === 'function' ? el.getClientRects().length > 0 : true;
    },

    _targetEl(st, dev) {
        let t = this._pick(st.target, dev, true);
        if (typeof t === 'function') { try { t = t(); } catch (e) { t = null; } }
        if (!t) return null;
        if (typeof t === 'string') {
            if (t[0] === '@') return this._input() ? Input.element(t.slice(1)) : null;
            t = typeof document !== 'undefined' ? document.querySelector(t) : null;
        }
        return this._shown(t) ? t : null;
    },

    _highlight(el) {
        if (el === this.hlEl) return;
        if (this.hlEl && this.hlEl.classList) this.hlEl.classList.remove('lory-tut-hl');
        this.hlEl = el;
        if (el && el.classList) el.classList.add('lory-tut-hl');
    },

    _placePointer(el) {
        const ui = this.ui;
        if (!ui) return;
        if (!el || typeof el.getBoundingClientRect !== 'function') { ui.pointer.classList.remove('on'); return; }
        const r = el.getBoundingClientRect();
        const cardBottom = ui.card.getBoundingClientRect ? ui.card.getBoundingClientRect().bottom || 0 : 0;
        const below = r.top < cardBottom + 50;           // у верхнего края и под карточкой — стрелка снизу, смотрит вверх
        ui.pointer.classList.toggle('below', below);
        ui.pointer.classList.add('on');
        const lx = typeof ViewCap !== 'undefined' ? ViewCap.x(r.left) : r.left;   // слой указателей — в координатах поля игры (ViewCap.js)
        ui.pointer.style.transform = 'translate(' + Math.round(lx + r.width / 2) + 'px,' + Math.round(below ? r.bottom + 6 : r.top - 44) + 'px)';
    },

    _worldTarget(st, dev) {
        let w = this._pick(st.world, dev);
        if (typeof w === 'function') { try { w = w(); } catch (e) { w = null; } }
        return w && typeof w.x === 'number' ? w : null;
    },

    /** Проекция точки мира на экран (CSS px): { x, y, visible, behind } или null. Своя — init({ project }). */
    project(x, y, h) {
        if (typeof this.opts.project === 'function') return this.opts.project(x, y, h);
        const app = this.app;
        if (!app) return null;
        if (app.location && app.location.view) return app.location.view.projectToScreen(x, y, h || 0);
        if (app.world2d) {
            const p = app.world2d.worldToScreen(x, y);
            return { x: p.x, y: p.y, behind: false, visible: p.x >= 0 && p.y >= 0 && p.x <= app.world2d.cssWidth && p.y <= app.world2d.cssHeight };
        }
        return null;
    },

    // Свободная зона для стрелок: под карточкой, над стиком и кнопкой.
    _safeRect() {
        const W = typeof ViewCap !== 'undefined' && ViewCap.on ? ViewCap.width() : (typeof window !== 'undefined' && window.innerWidth) || 800;
        const H = (typeof window !== 'undefined' && window.innerHeight) || 600;
        const ui = this.ui;
        const cardBottom = ui && ui.card.getBoundingClientRect ? ui.card.getBoundingClientRect().bottom || 0 : 0;
        const touch = this.variant === 'touch' || this.variant === 'mouse';   // внизу стик и кнопка Input
        return { L: 40, R: W - 40, T: Math.min(H * 0.6, cardBottom + 50), B: H - (touch ? 150 : 50) };
    },

    // Точка мира: стрелка над ней; если не видна (за спиной, за краем, под карточкой) — стрелка у границы безопасной зоны.
    _placeWorld(w) {
        const ui = this.ui;
        if (!ui) return;
        const p = this.project(w.x, w.y, w.h || 0);
        if (!p) { ui.pointer.classList.remove('on'); ui.edge.classList.remove('on'); return; }
        const s = this._safeRect();
        if (p.visible && !p.behind && p.x > s.L && p.x < s.R && p.y > s.T && p.y < s.B) {
            ui.edge.classList.remove('on');
            ui.pointer.classList.remove('below');
            ui.pointer.classList.add('on');
            ui.pointer.style.transform = 'translate(' + Math.round(p.x) + 'px,' + Math.round(p.y - 48) + 'px)';
            return;
        }
        ui.pointer.classList.remove('on');
        const cx = (s.L + s.R) / 2, cy = (s.T + s.B) / 2;
        let dx = p.x - cx, dy = p.y - cy;
        if (p.behind) { dx = -dx; dy = -dy; }
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) dy = 1;
        let k = Infinity;
        if (dx > 0) k = Math.min(k, (s.R - cx) / dx); else if (dx < 0) k = Math.min(k, (s.L - cx) / dx);
        if (dy > 0) k = Math.min(k, (s.B - cy) / dy); else if (dy < 0) k = Math.min(k, (s.T - cy) / dy);
        ui.edge.classList.add('on');
        // стрелка нарисована остриём вниз: поворот на угол направления минус 90°
        ui.edge.style.transform = 'translate(' + Math.round(cx + dx * k) + 'px,' + Math.round(cy + dy * k) + 'px) rotate(' + (Math.atan2(dy, dx) - Math.PI / 2).toFixed(3) + 'rad)';
    },

    _clearPointers() {
        this._highlight(null);
        this._w = null;
        if (this.ui) { this.ui.pointer.classList.remove('on'); this.ui.edge.classList.remove('on'); }
    },

    // Финальная фраза после прохождения: висит TUTORIAL_FINAL_SECONDS, ничего не блокирует; active уже false.
    _showFinal() {
        const sec = this.opts.finalText === null ? 0 : this.cfg().finalSeconds;
        const ui = this.ui;
        if (!ui || sec <= 0) { if (ui) ui.layer.hidden = true; return; }
        if (ui.final && ui.final.remove) ui.final.remove();
        const el = document.createElement('div');
        el.className = 'lory-tut-final';
        el.textContent = this.text(this.opts.finalText || 'tut.done');
        ui.layer.appendChild(el);
        ui.final = el;
        this._finalT = sec;
    },
};
