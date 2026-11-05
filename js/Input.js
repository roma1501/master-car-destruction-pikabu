// Input.js — ввод игры по ДЕЙСТВИЯМ: клавиатура, мышь (pointer lock или ПКМ-драг), касания
// (плавающий стик слева, свайп-камера справа, контекстная кнопка) и геймпад (standard mapping).
// Модуль opt-in: игра 1.20, которая Input не зовёт, работает как раньше (2D-ввод World2D —
// app.input — это другой объект и от Input не зависит).
//
// ПОДКЛЮЧЕНИЕ (в Game.init(app)):
//   Input.init({ app, mouse: 'lock' });          // app: конец кадра зовётся сам (app.onFrame)
//   // в Game.update(dt):
//   const m = Input.move();                        // { x вправо, y вперёд }, длина 0..1: WASD + стик + геймпад
//   const look = Input.consumeLook();              // { dx, dy } px взгляда с прошлого кадра (мышь, свайп, правый стик)
//   if (Input.pressed('jump')) hero.jump();
//   if (Input.down('sprint')) …
//
// ДЕЙСТВИЯ. Игра описывает их сама: Input.init({ actions: { jump: { keys: ['Space'], pad: [0] }, … } });
// без `actions` берётся набор по умолчанию (Input.DEFAULTS: forward/back/left/right, jump, sprint,
// interact, attack, aim, crouch, pause); дополнить его — actions: { ...Input.DEFAULTS, dash: { keys: ['KeyQ'] } }.
// move() читает действия left/right/forward/back (свои имена — Input.init({ moveActions: { left: 'west', … } })).
// keys — коды клавиш (e.code не зависит от раскладки) и кнопок мыши 'Mouse0' (левая) / 'Mouse1' / 'Mouse2' (правая);
// pad — номера кнопок standard mapping
// (0 A, 1 B, 2 X, 3 Y, 4 LB, 5 RB, 6 LT, 7 RT, 8 Back, 9 Start, 10 L3, 11 R3, 12–15 крестовина).
//   Input.down(a)        действие зажато (клавиша, кнопка мыши, геймпад, экранная кнопка)
//   Input.pressed(a)     нажато В ЭТОМ КАДРЕ (рёбро); Input.released(a) — отпущено в этом кадре
//   Input.axis(a, b)     −1 / 0 / +1 по паре действий;  Input.key(code) / keyPressed(code) — «сырая» клавиша
//   Input.move(out?)     вектор движения;  Input.consumeLook(out?) — взгляд (обнуляет);  consumeWheel() — колесо
//   Input.endFrame()     конец кадра: сбросить рёбра. С `app` в init зовётся сам, без — звать вручную
// События ставятся в очередь и применяются при первом чтении кадра: нажатие, начавшееся и закончившееся
// между кадрами, не теряется (down() видит его ровно один кадр).
//
// ПЕРЕНАЗНАЧЕНИЕ. Привязки клавиш хранятся в Store (GAME_ID + '.binds'); у действия может быть до трёх клавиш.
//   Input.setBind(a, slot, code)   назначить; занятая другим действием клавиша меняется местами. Esc нельзя
//   Input.captureNext(cb)          ждать следующую клавишу/кнопку мыши (окно «Управление»); cb(code | null при Esc)
//   Input.resetBinds();  Input.binds — копия {действие: [источники]};  Input.rebindable() — список для окна
//   Input.label(code) → «E», «Пробел», «ЛКМ»;  Input.labelOf(a) — подпись под текущее устройство (клавиша / кнопка геймпада / '')
//
// УСТРОЙСТВО. Input.device = 'keyboard' | 'touch' | 'pad' — откуда пришёл последний ввод. Меняется на лету;
// Input.on('device', fn) и событие window 'lory-input-device' ({detail:{device}}) — для подсказок и HUD.
//
// МЫШЬ (Input.configure({ mouse })): 'drag' (по умолчанию) — взгляд при зажатой ПКМ, курсор виден;
// 'lock' — pointer lock для вида от первого лица: курсор скрыт и неподвижен, Esc отпускает (Input.on('unlock') /
// событие 'lory-input-unlock' — открыть паузу), клик по игре захватывает снова (после меню, паузы, возврата на
// вкладку; сам клик-захват в игру не засчитывается). Input.needsCapture — показать «Нажмите, чтобы управлять».
// Из меню по кнопке «Продолжить» зови Input.capture() (нужен жест игрока). Нет pointer lock (iframe) — сам
// переходит на 'drag'. Выбросы movementX/Y режутся до INPUT_LOOK_CLAMP_PX, первое событие после захвата отбрасывается.
// dragButton — кнопка взгляда в режиме 'drag': 2 (правая, по умолчанию), 0 (левая), -1 — левая ИЛИ правая.
//
// КАСАНИЯ. Только настоящий сенсорный ввод (pointerType 'touch') включает экранные элементы; на ПК их нет.
// Исключение — МЫШЬ КАК ПАЛЕЦ, Input.configure({ mouseTouch: true }) (YouTube Playables требует игру одной мышью; в Playables
// включается САМ, когда Platform.name === 'playables', игра может переопределить): левая кнопка мыши работает как палец —
// слева стик, справа взгляд, нажатие на контекстную кнопку; стик и кнопка видны и на ПК. Правая кнопка и колесо — как обычно
// (привязка jump: ['Space', 'Mouse2'] даёт прыжок ПКМ, в том числе поверх зажатой ЛКМ стика), клавиатура работает всегда;
// Input.device остаётся 'keyboard', подсказки обучения берут вариант 'mouse'. mouseTouch отключает pointer lock ('lock' → 'drag').
// Input.configure({ controls: false }) прячет стик и кнопку (меню): весь экран — свайп-взгляд; true возвращает.
// Левая половина экрана (INPUT_STICK_ZONE) — плавающий стик под пальцем (Input.stick), правая — свайп-взгляд.
// ПОЛЕ 2:1 (ViewCap.js, Playgama): координаты Input — в системе ПОЛЯ игры (pointer, consumeTaps, зона стика), нажатия вне
// поля (полосы по бокам) игнорируются.
// Кнопок как можно меньше: ОДНА контекстная кнопка, её значок и подпись меняет игра:
//   Input.setContext({ id: 'chest', label: 'Открыть', icon: '🔑' }, priority?)   показать кнопку (действие 'interact')
//   Input.clearContext('chest')  // убрать этот контекст; clearContext() — все
// Несколько систем ставят контексты по id; видна кнопка с наибольшим priority (при равенстве — последняя).
// Нажатие даёт Input.pressed(ctx.action || 'interact'), как клавиша E. Input.context — текущий контекст (HUD на
// ПК рисует подсказку «[E] Открыть» сам: Input.labelOf('interact')). icon: символ или путь к картинке в assets (литералом).
// Свои экранные кнопки игры: Input.setVirtual(action, on). Нет касаний — в DOM нет ничего лишнего.
//
// ГЕЙМПАД: опрашивается сам, раз в кадр при первом чтении; подходит только mapping 'standard' (Input.pad.unsupported — другой).
// ОСВОБОЖДЕНИЕ: на window 'lory-release-input', потере фокуса и любой паузе (Pause) всё отпускается —
// клавиши, мышь, стик, взгляд, очередь; ввод не залипает. Input.setEnabled(false) — то же для меню.
// КАМЕРА: Input.init({ app }) с app.camera подключает CameraController: пальцы и мышь, которыми владеет Input,
// камера не получает (camera.ignorePointer), а WASD/стрелки перестают двигать камеру. Не нужно —
// Input.init({ camera: false }) (камера остаётся со своим вводом); клавиши камеры оставить — cameraKeys: true.
// ЭКРАН: вёрстка кнопки — CSS-переменные --lory-input-* (цвета) и --hl-input-action-* / --hl-input-stick-*
// (если подключён HudLayout, он сам ставит их так, чтобы кнопка не пересекала HUD).
//
// Числа — Constants.js (INPUT_*). Тексты — LANG_STRINGS ('input.*'), добавляются сюда же, если ключа нет.

/** @typedef {{ id: string, label?: string, icon?: string, action?: string }} InputContext */

// Подписи действий по умолчанию (окно «Управление»); ключи добавляются в LANG_STRINGS, если их там нет.
const INPUT_LANG = {
    ru: {
        'input.action.forward': 'Вперёд', 'input.action.back': 'Назад', 'input.action.left': 'Влево', 'input.action.right': 'Вправо',
        'input.action.jump': 'Прыжок', 'input.action.sprint': 'Бег', 'input.action.interact': 'Действие', 'input.action.attack': 'Атака',
        'input.action.aim': 'Прицел', 'input.action.crouch': 'Присесть', 'input.action.pause': 'Пауза',
        'input.capture': 'Нажмите, чтобы управлять', 'input.pressKey': 'Нажмите клавишу…',
        'input.key.Space': 'Пробел', 'input.key.Mouse0': 'ЛКМ', 'input.key.Mouse1': 'СКМ', 'input.key.Mouse2': 'ПКМ',
    },
    en: {
        'input.action.forward': 'Forward', 'input.action.back': 'Back', 'input.action.left': 'Left', 'input.action.right': 'Right',
        'input.action.jump': 'Jump', 'input.action.sprint': 'Sprint', 'input.action.interact': 'Action', 'input.action.attack': 'Attack',
        'input.action.aim': 'Aim', 'input.action.crouch': 'Crouch', 'input.action.pause': 'Pause',
        'input.capture': 'Click to take control', 'input.pressKey': 'Press a key…',
        'input.key.Space': 'Space', 'input.key.Mouse0': 'LMB', 'input.key.Mouse1': 'MMB', 'input.key.Mouse2': 'RMB',
    },
};
if (typeof LANG_STRINGS !== 'undefined') {
    for (const code of Object.keys(INPUT_LANG)) {
        const dict = LANG_STRINGS[code] || (LANG_STRINGS[code] = {});
        for (const [key, text] of Object.entries(INPUT_LANG[code])) if (!(key in dict)) dict[key] = text;
    }
}

/** @satisfies {Record<string, any>} */
const Input = {
    // --- состояние (только чтение) ---
    /** 'keyboard' | 'touch' | 'pad' — устройство последнего ввода. */
    device: 'keyboard',
    /** Был настоящий сенсорный ввод: экранные элементы созданы и (при device 'touch') показаны. */
    touchSeen: false,
    enabled: true,
    /** Курсор захвачен (pointer lock). */
    locked: false,
    /** Захват курсора не удался (iframe без разрешения) — режим 'lock' заменён на 'drag'. */
    lockFailed: false,
    /** 'drag' | 'lock' | 'none' — схема мыши. */
    mouseMode: 'drag',
    /** Кнопка мыши, которой крутят взгляд в режиме 'drag': 2 — правая, 0 — левая, -1 — левая или правая. */
    dragButton: 2,
    /** Мышь как палец: ЛКМ слева — стик, справа — взгляд, экранные стик и кнопка видны и на ПК (configure({ mouseTouch })). */
    mouseTouch: false,
    /** Экранные стик и кнопка включены (false — в меню: их не видно, весь экран — свайп-взгляд). */
    controls: true,
    touchEnabled: true,
    padEnabled: true,
    /** Слабый круг-подсказка стика, пока палец не на экране (после первого касания). */
    stickIdle: true,
    /** Позиция указателя в CSS px окна (с ViewCap — в координатах поля игры). */
    pointer: { x: 0, y: 0, down: false, type: 'mouse' },
    /** Сенсорный стик: x вправо, y вперёд (вверх по экрану), длина 0..1. */
    stick: { x: 0, y: 0, active: false },
    /** Геймпад: стики с мёртвой зоной (ly > 0 — вниз). */
    pad: { on: false, lx: 0, ly: 0, rx: 0, ry: 0, unsupported: false },
    /** Накопленный взгляд за кадр (px, y вниз): читать consumeLook(). */
    look: { dx: 0, dy: 0 },
    /** Сколько px взгляда набрано за всё время (шаги обучения «осмотрись»). */
    lookTotal: 0,
    wheel: 0,
    /** @type {InputContext | null} */
    context: null,
    /** Какие действия дают движение (move()). */
    moveActions: { left: 'left', right: 'right', forward: 'forward', back: 'back' },

    /** Набор действий по умолчанию (keys — клавиши и кнопки мыши, pad — кнопки геймпада). */
    DEFAULTS: {
        forward: { keys: ['KeyW', 'ArrowUp'], pad: [12] },
        back: { keys: ['KeyS', 'ArrowDown'], pad: [13] },
        left: { keys: ['KeyA', 'ArrowLeft'], pad: [14] },
        right: { keys: ['KeyD', 'ArrowRight'], pad: [15] },
        jump: { keys: ['Space'], pad: [0] },
        sprint: { keys: ['ShiftLeft', 'ShiftRight'], pad: [10] },
        interact: { keys: ['KeyE'], pad: [2] },
        attack: { keys: ['Mouse0'], pad: [7] },
        aim: { keys: ['Mouse2'], pad: [6] },
        crouch: { keys: ['KeyC', 'ControlLeft'], pad: [1] },
        pause: { keys: ['KeyP'], pad: [9], rebind: false },
    },
    /** Названия кнопок геймпада standard mapping. */
    PAD_NAMES: ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'L3', 'R3', '↑', '↓', '←', '→'],

    // --- внутреннее ---
    _inited: false,
    /** @type {HTMLElement | null} */
    canvas: null,
    /** @type {LoryApp | null} */
    app: null,
    c: /** @type {Record<string, number>} */ ({}),
    /** @type {Record<string, { keys: string[], def: string[], pad: number[], rebind: boolean }>} */
    _defs: {},
    /** @type {Record<string, string[]>} */
    _src: {},
    /** @type {{ s: string, d: boolean }[]} */
    _queue: [],
    _down: new Set(),
    _pressed: new Set(),
    _released: new Set(),
    /** Источники, нажатые в этом кадре (короткое нажатие дожидается конца кадра). */
    _tapped: new Set(),
    _deferred: new Set(),
    _mouseHeld: new Set(),
    _polled: false,
    _padAt: 0,
    /** @type {Record<number, boolean>} */
    _padPrev: {},
    _claimed: new Set(),
    /** @type {{ id: number, nx: number, ny: number, cx: number, cy: number } | null} */
    _stick: null,
    /** @type {{ id: number, x: number, y: number, sx: number, sy: number, t: number } | null} */
    _lookP: null,
    /** @type {{ x: number, y: number, type: string }[]} */
    _taps: [],
    _skipMove: false,
    _lockErrors: 0,
    /** pointerId пальца/мыши, держащего контекстную кнопку, и действие, которое он нажал. */
    _held: -1,
    _ctxHeldAction: '',
    /** @type {((code: string | null) => void) | null} */
    _capture: null,
    /** @type {Map<string, { ctx: InputContext, priority: number, seq: number }>} */
    _ctxs: new Map(),
    _ctxSeq: 0,
    /** @type {Record<string, Function[]>} */
    _on: {},
    /** @type {(() => void)[]} */
    _unbind: [],
    ui: /** @type {{ layer: HTMLElement, stick: HTMLElement, knob: HTMLElement, btn: HTMLButtonElement, icon: HTMLElement, label: HTMLElement } | null} */ (null),

    // =====================================================================================
    // Запуск
    // =====================================================================================

    /** Числа Constants.js с дефолтами (в игре — лексические const, в редакторе — поля window). */
    cfg() {
        const U = 'undefined';
        return {
            lock: typeof INPUT_POINTER_LOCK !== U ? INPUT_POINTER_LOCK : 1,
            lookClamp: typeof INPUT_LOOK_CLAMP_PX !== U ? INPUT_LOOK_CLAMP_PX : 200,
            mouseScale: typeof INPUT_MOUSE_LOOK_SCALE !== U ? INPUT_MOUSE_LOOK_SCALE : 1,
            touchScale: typeof INPUT_TOUCH_LOOK_SCALE !== U ? INPUT_TOUCH_LOOK_SCALE : 1.35,
            padLook: typeof INPUT_PAD_LOOK_SPEED !== U ? INPUT_PAD_LOOK_SPEED : 1250,
            padDead: typeof INPUT_PAD_DEADZONE !== U ? INPUT_PAD_DEADZONE : 0.2,
            stickR: typeof INPUT_STICK_RADIUS !== U ? INPUT_STICK_RADIUS : 64,
            stickDead: typeof INPUT_STICK_DEADZONE !== U ? INPUT_STICK_DEADZONE : 0.12,
            stickZone: typeof INPUT_STICK_ZONE !== U ? INPUT_STICK_ZONE : 0.5,
            button: typeof INPUT_ACTION_BUTTON_SIZE !== U ? INPUT_ACTION_BUTTON_SIZE : 76,
        };
    },

    /**
     * Запуск. opts: { canvas, app, actions, mouse: 'drag'|'lock'|'none', touch, pad, stickIdle,
     * camera: false, cameraKeys: true, autoEnd: false, moveActions }. Повторный вызов — configure(opts).
     */
    init(opts) {
        const o = opts || {};
        if (this._inited) { this.configure(o); return this; }
        this._inited = true;
        this.c = this.cfg();
        // до первого ввода подсказки берут устройство по железу; экранные элементы появятся только после настоящего касания
        if (typeof IS_MOBILE !== 'undefined' && IS_MOBILE) this.device = 'touch';
        this.canvas = o.canvas || (typeof document !== 'undefined' ? document.getElementById('world3d') : null);
        this.app = o.app || (typeof window !== 'undefined' && window.app) || null;
        this.defineActions(o.actions || this.DEFAULTS);
        // YouTube Playables: игра должна проходиться одной мышью — мышь как палец включается сама (игра может отказаться: mouseTouch: false)
        const auto = o.mouseTouch === undefined && typeof Platform !== 'undefined' && Platform.name === 'playables';
        this.configure(auto ? { ...o, mouseTouch: true } : o);
        this._bind();
        this._css();
        if (this.canvas && this.canvas.style) this.canvas.style.touchAction = 'none';
        const app = this.app;
        if (app) {
            if (o.autoEnd !== false && typeof app.onFrame === 'function') app.onFrame(() => this.endFrame());
            if (o.camera !== false && app.camera) this._linkCamera(app.camera, o.cameraKeys === true);
        }
        this._hud();
        return this;
    },

    /** Настройки на ходу: mouse, touch, pad, stickIdle, dragButton, moveActions, mouseTouch, controls. */
    configure(o) {
        if (!o) return this;
        if (o.mouse) this.mouseMode = (o.mouse === 'lock' && (this.lockFailed || !this.c.lock)) ? 'drag' : o.mouse;
        if (o.touch !== undefined) { this.touchEnabled = !!o.touch; if (this.touchEnabled && this.touchSeen) this._ensureUi(); }
        if (o.pad !== undefined) this.padEnabled = !!o.pad;
        if (o.stickIdle !== undefined) this.stickIdle = !!o.stickIdle;
        if (o.controls !== undefined) {
            this.controls = !!o.controls;
            if (!this.controls) {   // экранное управление убрано: палец, ведущий стик, больше не двигает героя
                if (this._stick) this._endStick();
                this._held = -1;
                this._push('V:' + (this._ctxHeldAction || 'interact'), false);
            }
        }
        if (o.mouseTouch !== undefined) {
            const was = this.mouseTouch;
            this.mouseTouch = !!o.mouseTouch;
            if (was && !this.mouseTouch) { this._stick = null; this._lookP = null; this.stick.x = 0; this.stick.y = 0; this.stick.active = false; this._claimed.clear(); }
            if (this.mouseTouch) this._ensureUi();   // экранные элементы нужны сразу, не после первого касания
        }
        if (o.dragButton !== undefined) this.dragButton = o.dragButton;
        if (o.moveActions) Object.assign(this.moveActions, o.moveActions);
        this._syncUi();
        return this;
    },

    /** Снять все обработчики и экранные элементы (перезапуск игры, тесты). */
    dispose() {
        for (const off of this._unbind) off();
        this._unbind.length = 0;
        this.releaseAll();
        if (this.ui && this.ui.layer && this.ui.layer.remove) this.ui.layer.remove();
        this.ui = null;
        this._inited = false;
        this.mouseTouch = false;
        this.controls = true;
        this._on = {};
        this._ctxs.clear();
        this.context = null;
    },

    // =====================================================================================
    // Действия и привязки
    // =====================================================================================

    /** Задать набор действий (init делает это сам). Сохранённые привязки игрока накладываются поверх. */
    defineActions(map) {
        this._defs = {};
        for (const name of Object.keys(map)) {
            const d = map[name] || {};
            const keys = (d.keys || []).slice();
            this._defs[name] = { keys: keys.slice(), def: keys.slice(), pad: (d.pad || []).slice(), rebind: d.rebind !== false };
        }
        this.loadBinds();
    },

    _storeKey() { return (typeof GAME_ID !== 'undefined' ? GAME_ID : 'lory-game') + '.binds'; },

    /** Накладывает сохранённые привязки (Store) на действия с rebind. Битые записи игнорируются. */
    loadBinds() {
        const saved = typeof Store !== 'undefined' ? Store.getJSON(this._storeKey(), null) : null;
        if (saved) {
            for (const name of Object.keys(this._defs)) {
                const d = this._defs[name], v = saved[name];
                if (d.rebind && Array.isArray(v) && v.length >= 1 && v.length <= 3 && v.every(c => typeof c === 'string' && /^[A-Za-z0-9]{1,16}$/.test(c) && c !== 'Escape')) d.keys = v.slice();
            }
        }
        this._rebuild();
    },

    _saveBinds() {
        if (typeof Store === 'undefined') return;
        /** @type {Record<string, string[]>} */
        const out = {};
        for (const name of Object.keys(this._defs)) if (this._defs[name].rebind) out[name] = this._defs[name].keys;
        Store.set(this._storeKey(), JSON.stringify(out));
    },

    // Источники действия: клавиши/кнопки мыши, 'Pad<n>' и виртуальный 'V:<действие>'.
    _rebuild() {
        this._src = {};
        for (const name of Object.keys(this._defs)) {
            const d = this._defs[name];
            this._src[name] = d.keys.concat(d.pad.map(i => 'Pad' + i), ['V:' + name]);
        }
    },

    /** Копия привязок: { действие: [клавиши] }. */
    get binds() {
        /** @type {Record<string, string[]>} */
        const out = {};
        for (const name of Object.keys(this._defs)) out[name] = this._defs[name].keys.slice();
        return out;
    },

    /** Действия, которые игрок может переназначить (для окна «Управление»). */
    rebindable() { return Object.keys(this._defs).filter(n => this._defs[n].rebind); },

    /** Клавиша/кнопка мыши привязана к какому-нибудь действию? */
    isBound(code) {
        for (const name of Object.keys(this._defs)) if (this._defs[name].keys.indexOf(code) >= 0) return true;
        return false;
    },

    /** Действие привязано именно к этой клавише или кнопке мыши (jump и 'Mouse2' — прыжок на ПКМ). */
    hasKey(action, code) {
        const d = this._defs[action];
        return !!d && d.keys.indexOf(code) >= 0;
    },

    /**
     * Назначить code в слот slot (0 — основная, 1 — запасная) действия. Если клавишу занимало другое
     * действие, оно получает прежнюю клавишу этого слота (или теряет её, если у него есть другая).
     * Возвращает false: действие не переназначается, Esc, неверный код, или у другого действия не осталось бы клавиш.
     */
    setBind(action, slot, code) {
        const cur = this._defs[action];
        if (!cur || !cur.rebind || code === 'Escape' || typeof code !== 'string' || !/^[A-Za-z0-9]{1,16}$/.test(code)) return false;
        const prev = cur.keys[slot];
        for (const name of Object.keys(this._defs)) {
            if (name === action) continue;
            const other = this._defs[name], i = other.keys.indexOf(code);
            if (i < 0) continue;
            if (!other.rebind) return false;
            if (prev) other.keys[i] = prev;
            else if (other.keys.length > 1) other.keys.splice(i, 1);
            else return false;
        }
        const dup = cur.keys.indexOf(code);
        if (dup >= 0 && dup !== slot && cur.keys.length > 1) { cur.keys.splice(dup, 1); slot = Math.min(slot, cur.keys.length); }
        cur.keys[Math.min(slot, cur.keys.length)] = code;
        this._rebuild();
        this._saveBinds();
        return true;
    },

    /** Вернуть клавиши по умолчанию и забыть сохранённые. */
    resetBinds() {
        for (const name of Object.keys(this._defs)) this._defs[name].keys = this._defs[name].def.slice();
        if (typeof Store !== 'undefined') Store.remove(this._storeKey());
        this._rebuild();
    },

    /** Ждать следующую клавишу или кнопку мыши (для окна переназначения). cb(code) или cb(null) при Esc/cancel. */
    captureNext(cb) { this._capture = cb; },
    cancelCapture() { const f = this._capture; this._capture = null; if (f) f(null); },

    /** Читаемое имя клавиши: KeyE → «E», Space → «Пробел», Mouse0 → «ЛКМ». */
    label(code) {
        if (!code) return '—';
        const own = 'input.key.' + code;
        if (typeof Lang !== 'undefined' && Lang.has(own)) return Lang.t(own);
        let m = /^Key([A-Z])$/.exec(code); if (m) return m[1];
        m = /^Digit(\d)$/.exec(code); if (m) return m[1];
        m = /^Numpad(\d)$/.exec(code); if (m) return 'Num' + m[1];
        /** @type {Record<string, string>} */
        const names = {
            Space: 'Space', ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Ctrl', ControlRight: 'Ctrl', AltLeft: 'Alt', AltRight: 'Alt',
            Escape: 'Esc', Tab: 'Tab', Enter: 'Enter', NumpadEnter: 'Enter', Backspace: 'Bksp', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
            Backquote: '`', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\',
            Mouse0: 'LMB', Mouse1: 'MMB', Mouse2: 'RMB',
        };
        return names[code] || code;
    },

    /** Подпись действия под текущее устройство: клавиша, кнопка геймпада или '' (касания — кнопка на экране). */
    labelOf(action, device) {
        const d = this._defs[action], dev = device || this.device;
        if (!d) return '';
        if (dev === 'pad') return d.pad.length ? this.PAD_NAMES[d.pad[0]] || ('B' + d.pad[0]) : '';
        if (dev === 'touch') return '';
        return d.keys.length ? this.label(d.keys[0]) : '';
    },

    /** Все клавиши действия через « / » (окно «Управление»). */
    bindingsText(action) {
        const d = this._defs[action];
        return d ? d.keys.map(c => this.label(c)).join(' / ') : '';
    },

    // =====================================================================================
    // Чтение ввода (в Game.update)
    // =====================================================================================

    // Применить события очереди и опросить геймпад — раз в кадр, при первом чтении.
    _sync() {
        if (!this._polled) {
            this._polled = true;
            if (this.padEnabled) this._pollPad();
        }
        if (this._queue.length) this._flush();
    },

    _accepts() { return this.enabled && !(typeof Pause !== 'undefined' && Pause.active); },

    // Поставить событие источника s (down = нажат) в очередь. Очередь, которую никто не читает, сама применяется на лимите.
    _push(s, down) {
        if (this._queue.length >= 256) this._flush();
        this._queue.push({ s, d: down });
    },

    _flush() {
        const q = this._queue.splice(0, this._queue.length);
        const ok = this._accepts();
        for (const ev of q) {
            const s = ev.s;
            if (ev.d) {
                if (!ok) continue;
                if (!this._down.has(s)) this._pressed.add(s);
                this._down.add(s);
                this._tapped.add(s);
            } else {
                if (!this._down.has(s)) continue;          // отпускание без нажатия (нажали в меню, отпустили в игре)
                this._released.add(s);
                // нажали и отпустили между кадрами: клавиша остаётся «зажатой» до конца кадра
                if (this._tapped.has(s) && this._pressed.has(s)) this._deferred.add(s);
                else this._down.delete(s);
            }
        }
    },

    // Источники действия; у действия, которого нет в наборе, — только экранные нажатия (setVirtual, контекстная кнопка).
    _list(action) { return this._src[action] || (this._src[action] = ['V:' + action]); },

    /** Действие зажато. */
    down(action) {
        this._sync();
        for (const s of this._list(action)) if (this._down.has(s)) return true;
        return false;
    },

    /** Действие нажато именно в этом кадре. */
    pressed(action) {
        this._sync();
        for (const s of this._list(action)) if (this._pressed.has(s)) return true;
        return false;
    },

    /** Действие отпущено в этом кадре. */
    released(action) {
        this._sync();
        for (const s of this._list(action)) if (this._released.has(s)) return true;
        return false;
    },

    /** −1 / 0 / +1: positive зажато минус negative зажато. */
    axis(negative, positive) { return Number(this.down(positive)) - Number(this.down(negative)); },

    /** «Сырая» клавиша (или 'Mouse0', 'Pad0') зажата / нажата в этом кадре. */
    key(code) { this._sync(); return this._down.has(code); },
    keyPressed(code) { this._sync(); return this._pressed.has(code); },

    /** Вектор движения: x вправо, y вперёд, длина ≤ 1. Клавиши moveActions + сенсорный стик + левый стик геймпада. */
    move(out) {
        const o = out || { x: 0, y: 0 };
        o.x = 0; o.y = 0;
        if (!this._accepts()) return o;
        const M = this.moveActions;
        this._sync();
        let x = this.axis(M.left, M.right) + this.stick.x + this.pad.lx;
        let y = this.axis(M.back, M.forward) + this.stick.y - this.pad.ly;
        const len = Math.hypot(x, y);
        if (len > 1) { x /= len; y /= len; }
        o.x = x; o.y = y;
        return o;
    },

    /** Взгляд с прошлого вызова (px, y вниз): мышь в 'lock'/'drag', свайп справа, правый стик. Обнуляет накопленное. */
    consumeLook(out) {
        this._sync();
        const o = out || { dx: 0, dy: 0 };
        o.dx = this.look.dx; o.dy = this.look.dy;
        this.look.dx = 0; this.look.dy = 0;
        return o;
    },

    /** Колесо мыши: щелчки со знаком (вниз +). Обнуляет. */
    consumeWheel() { const w = this.wheel; this.wheel = 0; return w; },

    /** Нажатия/касания без движения (тап пальцем, клик в 'drag'): [{x, y, type}] окна. Обнуляет — для точного выбора объекта. */
    consumeTaps() { return this._taps.splice(0, this._taps.length); },

    /** Конец кадра: рёбра сброшены. Звать после чтения ввода (с `app` в init — само). */
    endFrame() {
        this._sync();
        this._pressed.clear();
        this._released.clear();
        this._tapped.clear();
        for (const s of this._deferred) this._down.delete(s);
        this._deferred.clear();
        this._polled = false;
    },

    /** Включить / выключить ввод игры (меню, диалоги). Выключение отпускает всё и отдаёт курсор. */
    setEnabled(on) {
        const was = this.enabled;
        this.enabled = !!on;
        if (!on && was) { this.releaseAll(); this.release(); }
        if (on && !was) this.capture();
    },

    /** Всё отпущено: клавиши, мышь, стик, взгляд, очередь, экранные нажатия. Событие 'release'. */
    releaseAll() {
        this._queue.length = 0;
        this._down.clear(); this._pressed.clear(); this._released.clear(); this._tapped.clear(); this._deferred.clear();
        this._mouseHeld.clear();
        this.look.dx = 0; this.look.dy = 0; this.wheel = 0;
        this._claimed.clear();
        this._stick = null; this._lookP = null;
        this.stick.x = 0; this.stick.y = 0; this.stick.active = false;
        this.pointer.down = false;
        this._syncUi();
        this._emit('release');
    },

    /** Нажать / отпустить действие снаружи: экранные кнопки игры. */
    setVirtual(action, on) { this._push('V:' + action, !!on); },

    // =====================================================================================
    // Контекстная кнопка
    // =====================================================================================

    /**
     * Показать контекстную кнопку: ctx { id, label, icon, action }. id — обязательный; label — ключ Lang или текст;
     * icon — символ или путь к картинке в assets (литералом); action — какое действие нажимает кнопка (по умолчанию 'interact').
     * priority: из нескольких контекстов виден больший (при равенстве — последний). Повтор с теми же полями — без работы.
     */
    setContext(ctx, priority) {
        if (!ctx || !ctx.id) return;
        const p = priority || 0, old = this._ctxs.get(ctx.id);
        if (old && old.priority === p && old.ctx.label === ctx.label && old.ctx.icon === ctx.icon && old.ctx.action === ctx.action) return;
        this._ctxs.set(ctx.id, { ctx: { id: ctx.id, label: ctx.label, icon: ctx.icon, action: ctx.action }, priority: p, seq: ++this._ctxSeq });
        this._pickContext();
    },

    /** Убрать контекст id (или все, если id не дан). */
    clearContext(id) {
        if (id === undefined) this._ctxs.clear(); else if (!this._ctxs.delete(id)) return;
        this._pickContext();
    },

    /** Действие, которое нажимает контекстная кнопка. */
    contextAction() { return (this.context && this.context.action) || 'interact'; },

    _pickContext() {
        let best = null;
        for (const e of this._ctxs.values()) if (!best || e.priority > best.priority || (e.priority === best.priority && e.seq > best.seq)) best = e;
        const next = best ? best.ctx : null, cur = this.context;
        if (cur === next || (cur && next && cur.id === next.id && cur.label === next.label && cur.icon === next.icon && cur.action === next.action)) return;
        this.context = next;
        this._renderContext();
        this._emit('context', next);
    },

    // =====================================================================================
    // События модуля
    // =====================================================================================

    /** Подписка: 'device' (device), 'context' (ctx | null), 'unlock', 'release'. Возвращает отписку. */
    on(type, fn) {
        (this._on[type] || (this._on[type] = [])).push(fn);
        return () => { const l = this._on[type], i = l ? l.indexOf(fn) : -1; if (i >= 0) l.splice(i, 1); };
    },

    _emit(type, arg) {
        for (const fn of (this._on[type] || []).slice()) {
            try { fn(arg); } catch (e) { console.error('Input.on(' + type + '):', e); }
        }
        // то же — событием window: HudLayout, Tutorial и платформенные модули подписываются без зависимости от Input
        if (typeof window !== 'undefined' && typeof Event === 'function' && window.dispatchEvent && (type === 'device' || type === 'unlock' || type === 'context')) {
            const ev = /** @type {any} */ (new Event('lory-input-' + type));
            ev.detail = type === 'device' ? { device: arg } : type === 'context' ? { context: arg } : {};
            window.dispatchEvent(ev);
        }
    },

    _setDevice(d) {
        if (this.device === d) return;
        this.device = d;
        this._syncUi();
        this._emit('device', d);
    },

    // =====================================================================================
    // Курсор: pointer lock
    // =====================================================================================

    /** Нужен ли захват курсора сейчас (режим 'lock', ввод включён, не пауза, не касания, не mouseTouch). */
    wantsLock() { return this.mouseMode === 'lock' && this._accepts() && this.device !== 'touch' && !this.mouseTouch; },

    /** Игра в режиме 'lock', курсор свободен: показать «Нажмите, чтобы управлять». */
    get needsCapture() { return this.wantsLock() && !this.locked; },

    /** Захватить курсор. Работает только по жесту игрока (клик, клавиша); иначе тихо ничего. */
    capture() {
        const cv = this.canvas;
        if (!cv || this.locked || !this.wantsLock() || typeof cv.requestPointerLock !== 'function') return false;
        try {
            // «сырое» движение без ускорения ОС: взгляд одинаков при любой настройке мыши
            const p = cv.requestPointerLock({ unadjustedMovement: true });
            if (p && p.catch) p.catch(() => {
                try { const q = cv.requestPointerLock(); if (q && q.catch) q.catch(() => { /* отказ — pointerlockerror */ }); } catch (e) { /* нет захвата */ }
            });
        } catch (e) { /* нет pointer lock */ }
        return true;
    },

    /** Отпустить курсор. */
    release() {
        try { if (typeof document !== 'undefined' && document.pointerLockElement) document.exitPointerLock(); } catch (e) { /* уже свободен */ }
    },

    _onLockChange() {
        const was = this.locked;
        this.locked = typeof document !== 'undefined' && !!this.canvas && document.pointerLockElement === this.canvas;
        this._skipMove = true;           // первое движение после смены захвата — выброс Chromium
        if (this.locked) { this._lockErrors = 0; return; }
        this._mouseHeld.clear();
        if (was) {
            // кнопки мыши, зажатые в захвате, отпускаются: mouseup мог уйти в никуда
            for (const s of ['Mouse0', 'Mouse1', 'Mouse2', 'Mouse3', 'Mouse4']) this._push(s, false);
            this._emit('unlock');
        }
    },

    _onLockError() {
        // iframe без allow-pointer-lock: после двух отказов подряд без единого захвата — ПКМ-драг
        if (++this._lockErrors >= 2 && !this.locked) {
            this.lockFailed = true;
            if (this.mouseMode === 'lock') this.mouseMode = 'drag';
        }
    },

    // =====================================================================================
    // Обработчики DOM
    // =====================================================================================

    _bind() {
        if (typeof window === 'undefined') return;
        /** @type {(t: any, type: string, fn: (e: any) => void, opt?: any) => void} */
        const on = (t, type, fn, opt) => {
            if (!t || !t.addEventListener) return;
            t.addEventListener(type, fn, opt);
            this._unbind.push(() => t.removeEventListener(type, fn, opt));
        };
        on(window, 'keydown', e => this._onKey(e, true), true);
        on(window, 'keyup', e => this._onKey(e, false), true);
        on(window, 'blur', () => this.releaseAll());
        on(window, 'lory-release-input', () => this.releaseAll());
        on(window, 'pointerdown', e => this._onPointerDown(e), true);
        on(window, 'pointermove', e => this._onPointerMove(e), true);
        on(window, 'pointerup', e => this._onPointerUp(e), true);
        on(window, 'pointercancel', e => this._onPointerUp(e), true);
        on(window, 'wheel', e => this._onWheel(e), { capture: true, passive: false });
        on(window, 'gamepadconnected', () => { this._padPrev = {}; });
        on(window, 'gamepaddisconnected', () => { this._padPrev = {}; this.pad.on = false; this.pad.lx = this.pad.ly = this.pad.rx = this.pad.ry = 0; });
        if (typeof document !== 'undefined') {
            on(document, 'mousemove', e => this._onMouseMove(e));
            on(document, 'pointerlockchange', () => this._onLockChange());
            on(document, 'pointerlockerror', () => this._onLockError());
        }
        if (typeof Pause !== 'undefined' && Pause.onChange) {
            this._unbind.push(Pause.onChange(active => { if (active) this.releaseAll(); }));
        }
    },

    _isField(t) { return !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable); },

    // Поверхность игры: канвас, body или элемент с data-input-surface. HUD-слой на весь экран — отметить атрибутом.
    _isSurface(t) {
        if (!t) return false;
        if (t === this.canvas) return true;
        if (typeof document !== 'undefined' && (t === document.body || t === document.documentElement)) return true;
        return !!(t.hasAttribute && t.hasAttribute('data-input-surface'));
    },

    _onKey(e, down) {
        const code = e.code;
        if (!code) return;
        if (down) {
            if (this._isField(e.target)) return;
            if (this._capture) {
                const f = this._capture;
                this._capture = null;
                e.preventDefault(); e.stopPropagation();
                f(code === 'Escape' ? null : code);
                return;
            }
            // Ctrl+W, Alt+Tab и подобное — не ввод игры (сами Ctrl/Alt/Shift при этом остаются клавишами)
            if ((e.ctrlKey || e.metaKey || e.altKey) && !/^(Control|Alt|Meta|Shift)/.test(code)) return;
            this._setDevice('keyboard');
            if (this._accepts() && /^(Space|Tab|Arrow(Up|Down|Left|Right))$/.test(code) && this.isBound(code)) e.preventDefault();
            this._push(code, true);
        } else {
            this._push(code, false);
        }
    },

    // Указатель ведёт ветка касаний (стик, взгляд): палец, а в режиме mouseTouch — левая кнопка мыши, начавшая нажатие;
    // продолжение того же указателя (движение, отпускание) — пока он держит стик или взгляд. Правая кнопка — обычная мышь.
    _asTouch(e) {
        if (e.pointerType === 'touch') return true;
        if (!this.mouseTouch || e.pointerType !== 'mouse') return false;
        if (e.type === 'pointerdown') return e.button === 0 && !this._capture;   // окно «Управление» ждёт кнопку мыши — это не палец
        const st = this._stick, lk = this._lookP;
        return !!((st && st.id === e.pointerId) || (lk && lk.id === e.pointerId));
    },

    // Кнопка мыши крутит взгляд в режиме 'drag': dragButton; -1 — левая или правая.
    _isDragButton(b) { return this.dragButton < 0 ? (b === 0 || b === 2) : b === this.dragButton; },
    _dragHeld() { return this.dragButton < 0 ? (this._mouseHeld.has(0) || this._mouseHeld.has(2)) : this._mouseHeld.has(this.dragButton); },

    // x окна -> x поля игры (ViewCap.js: на ультрашироком десктопе поле 2:1 по центру); без ViewCap x окна и есть x поля.
    _fx(x) { return typeof ViewCap !== 'undefined' && ViewCap.on ? ViewCap.x(x) : x; },

    // Нажатие вне поля игры (боковые полосы ViewCap) в игру не идёт.
    _outsideField(e) { return typeof ViewCap !== 'undefined' && ViewCap.on && typeof e.clientX === 'number' && !ViewCap.contains(e.clientX); },

    // Вторая кнопка мыши при зажатой ЛКМ-пальце (mouseTouch): браузер шлёт не pointerdown, а pointermove с новыми
    // e.buttons — следим за правой (2) и средней (4) кнопками, пока ЛКМ ведёт стик или взгляд. Так ПКМ-прыжок
    // работает поверх стика.
    _syncChord(e) {
        if (!this.mouseTouch || e.pointerType !== 'mouse' || typeof e.buttons !== 'number' || !(this._stick || this._lookP)) return;
        for (const [bit, b] of [[2, 2], [4, 1]]) {
            const held = (e.buttons & bit) !== 0;
            if (held === this._mouseHeld.has(b)) continue;
            if (held) { if (!this._accepts()) continue; this._mouseHeld.add(b); this._push('Mouse' + b, true); }
            else { this._mouseHeld.delete(b); this._push('Mouse' + b, false); }
        }
    },

    _onPointerDown(e) {
        if (this._outsideField(e)) return;
        const touch = this._asTouch(e);
        this.pointer.x = this._fx(e.clientX); this.pointer.y = e.clientY; this.pointer.down = true; this.pointer.type = touch ? 'touch' : 'mouse';
        if (touch) {
            if (e.pointerType === 'touch') {
                if (!this.touchSeen) { this.touchSeen = true; this._ensureUi(); }
                this._setDevice('touch');
            }
            if (this.touchEnabled && this._isSurface(e.target)) this._touchStart(e);
            return;
        }
        this._setDevice('keyboard');
        if (this._capture) {
            const f = this._capture;
            this._capture = null;
            e.preventDefault(); e.stopPropagation();
            f('Mouse' + e.button);
            return;
        }
        if (!this._isSurface(e.target) && !this.locked) return;
        this._mouseHeld.add(e.button);
        if (this.mouseMode !== 'none' && (this.mouseMode === 'lock' || this._isDragButton(e.button))) this._claimed.add(e.pointerId);
        if (this.mouseMode === 'lock' && !this.locked && this._accepts()) {
            // клик, захвативший курсор, в игру не засчитывается
            if (e.button === 0) { this.capture(); return; }
        }
        this._push('Mouse' + e.button, true);
    },

    _onPointerMove(e) {
        this._syncChord(e);
        if (this._asTouch(e)) {
            this.pointer.x = this._fx(e.clientX); this.pointer.y = e.clientY;
            const st = this._stick, lk = this._lookP;
            if (st && e.pointerId === st.id) this._stickMove(e.clientX, e.clientY);
            else if (lk && e.pointerId === lk.id) {
                const dx = (e.clientX - lk.x) * this.c.touchScale, dy = (e.clientY - lk.y) * this.c.touchScale;
                lk.x = e.clientX; lk.y = e.clientY;
                if (this._accepts()) { this.look.dx += dx; this.look.dy += dy; this.lookTotal += Math.abs(dx) + Math.abs(dy); }
            }
            return;
        }
        this.pointer.x = this._fx(e.clientX); this.pointer.y = e.clientY; this.pointer.type = 'mouse';
        this._setDevice('keyboard');
    },

    _onPointerUp(e) {
        const id = e.pointerId;
        const touch = this._asTouch(e);
        this._claimed.delete(id);
        this.pointer.down = false;
        if (touch) {
            const st = this._stick, lk = this._lookP;
            if (st && id === st.id) this._endStick();
            if (lk && id === lk.id) {
                if (e.type === 'pointerup' && Math.hypot(e.clientX - lk.sx, e.clientY - lk.sy) < 12 && this._now() - lk.t < 350 && this._accepts()) this._pushTap(this._fx(e.clientX), e.clientY, e.pointerType === 'touch' ? 'touch' : 'mouse');
                this._lookP = null;
            }
            return;
        }
        const was = this._mouseHeld.has(e.button);
        this._mouseHeld.delete(e.button);
        this._push('Mouse' + e.button, false);
        if (was && e.type === 'pointerup' && e.button === 0 && this.mouseMode !== 'lock' && this._accepts() && this._isSurface(e.target)) this._pushTap(this._fx(e.clientX), e.clientY, 'mouse');
    },

    _onMouseMove(e) {
        if (this._skipMove) { this._skipMove = false; return; }
        if (!this._accepts() || this.mouseMode === 'none') return;
        if (!(this.locked || (this.mouseMode === 'drag' && this._dragHeld()))) return;
        const k = this.c.lookClamp, s = this.c.mouseScale;
        const dx = Math.max(-k, Math.min(k, e.movementX || 0)) * s;
        const dy = Math.max(-k, Math.min(k, e.movementY || 0)) * s;
        this.look.dx += dx; this.look.dy += dy;
        this.lookTotal += Math.abs(dx) + Math.abs(dy);
    },

    _onWheel(e) {
        if (!this._isSurface(e.target) || !this._accepts()) return;
        this.wheel += Math.sign(e.deltaY || 0);
        if (e.cancelable && e.preventDefault) e.preventDefault();
    },

    _pushTap(x, y, type) {
        this._taps.push({ x, y, type });
        if (this._taps.length > 8) this._taps.shift();
    },

    _now() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); },
    // Ширина поля игры: окно, а при ViewCap (десктоп, Playgama) — поле не шире 2:1.
    _vw() { return typeof ViewCap !== 'undefined' && ViewCap.on ? ViewCap.width() : (typeof window !== 'undefined' && window.innerWidth) || 1; },
    _vh() { return (typeof window !== 'undefined' && window.innerHeight) || 1; },

    // =====================================================================================
    // Касания: стик слева, взгляд справа
    // =====================================================================================

    // Радиус хода стика: на маленьком экране меньше.
    _stickR() { return Math.round(this.c.stickR * Math.max(0.68, Math.min(1, Math.min(this._vw(), this._vh()) / 520))); },

    _touchStart(e) {
        const W = this._vw(), H = this._vh(), x = this._fx(e.clientX);
        this._claimed.add(e.pointerId);
        try { if (e.target && e.target.setPointerCapture) e.target.setPointerCapture(e.pointerId); } catch (err) { /* синтетическое событие */ }
        if (e.cancelable && e.preventDefault) e.preventDefault();
        if (!this._accepts()) return;
        // controls: false (меню) — стика нет, весь экран ведёт взгляд
        if (this.controls && x < W * this.c.stickZone) {
            if (this._stick) return;
            const R = this._stickR(), B = R * 1.3 + 8;
            // база рисуется внутри экрана, а нейтраль стика — сама точка касания
            const cx = Math.max(B, Math.min(W - B, x)), cy = Math.max(B, Math.min(H - B, e.clientY));
            this._stick = { id: e.pointerId, nx: e.clientX, ny: e.clientY, cx, cy };
            this.stick.active = true;
            this._stickMove(e.clientX, e.clientY);
        } else if (!this._lookP) {
            this._lookP = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: this._now() };
        }
        this._syncUi();
    },

    _stickMove(x, y) {
        const st = this._stick;
        if (!st) return;
        const R = this._stickR();
        let dx = x - st.nx, dy = y - st.ny;
        const d = Math.hypot(dx, dy);
        if (d > R) { dx *= R / d; dy *= R / d; }
        let vx = dx / R, vy = -dy / R;
        const len = Math.hypot(vx, vy), dead = this.c.stickDead;
        if (len < dead) { vx = 0; vy = 0; } else { const k = (len - dead) / (1 - dead) / len; vx *= k; vy *= k; }
        this.stick.x = vx; this.stick.y = vy;
        if (this.ui) this.ui.knob.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px)';
    },

    _endStick() {
        this._stick = null;
        this.stick.x = 0; this.stick.y = 0; this.stick.active = false;
        this._syncUi();
    },

    // =====================================================================================
    // Геймпад
    // =====================================================================================

    _pollPad() {
        if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return;
        const t = this._now(), dt = Math.min(0.1, Math.max(0, (t - this._padAt) / 1000));
        this._padAt = t;
        const P = this.pad;
        let gp = null, unsupported = false;
        try {
            for (const g of navigator.getGamepads()) {
                if (g && g.connected) { if (g.mapping === 'standard') { gp = g; break; } unsupported = true; }
            }
        } catch (e) { /* геймпад недоступен — как отключённый */ }
        P.unsupported = unsupported && !gp;
        if (!gp) {
            if (P.on) {
                P.on = false; P.lx = P.ly = P.rx = P.ry = 0;
                for (const k of Object.keys(this._padPrev)) if (this._padPrev[+k]) this._push('Pad' + k, false);
                this._padPrev = {};
            }
            return;
        }
        const dead = this.c.padDead;
        const dz = (v) => Math.abs(v) < dead ? 0 : (v - Math.sign(v) * dead) / (1 - dead);
        const ax = gp.axes || [], bt = gp.buttons || [];
        P.lx = dz(ax[0] || 0); P.ly = dz(ax[1] || 0); P.rx = dz(ax[2] || 0); P.ry = dz(ax[3] || 0);
        let active = !!(P.lx || P.ly || P.rx || P.ry);
        for (let i = 0; i < bt.length; i++) {
            const now = !!(bt[i] && (bt[i].pressed || bt[i].value > 0.5));
            if (now !== !!this._padPrev[i]) {
                this._padPrev[i] = now;
                this._push('Pad' + i, now);
                active = true;
            } else if (now) active = true;
        }
        if (active) { P.on = true; this._setDevice('pad'); }
        // правый стик — взгляд; квадратичный отклик: тонкая наводка у центра
        const m = Math.hypot(P.rx, P.ry);
        if ((P.rx || P.ry) && this._accepts()) {
            const k = this.c.padLook * dt * m;
            this.look.dx += P.rx * k; this.look.dy += P.ry * k * 0.8;
            this.lookTotal += Math.abs(P.rx * k) + Math.abs(P.ry * k * 0.8);
        }
    },

    // =====================================================================================
    // Камера движка
    // =====================================================================================

    // Камера не получает пальцы и мышь, которыми владеет Input; WASD/стрелки больше не двигают камеру.
    _linkCamera(cam, keepKeys) {
        const prev = cam.ignorePointer;
        cam.ignorePointer = (e) => this._claimed.has(e.pointerId) || (typeof prev === 'function' ? prev(e) : false);
        if (!keepKeys && typeof CameraController !== 'undefined' && CameraController.PAN_KEYS) /** @type {any} */ (CameraController).PAN_KEYS = {};
    },

    // =====================================================================================
    // HUD: место под кнопку и стик, если подключён HudLayout
    // =====================================================================================

    _hud() {
        if (typeof HudLayout === 'undefined' || typeof HudLayout.block !== 'function') return;
        const b = this.c.button, s = Math.round(this.c.stickR * 2.6);
        HudLayout.block('input-action', { dock: 'br', w: b, h: b, min: 48, order: -10, touchOnly: true });
        HudLayout.block('input-stick', { dock: 'bl', w: s, h: s, min: 80, order: -10, touchOnly: true });
    },

    // =====================================================================================
    // Экранные элементы (только после настоящего касания)
    // =====================================================================================

    _css() {
        if (typeof document === 'undefined' || !document.head || document.getElementById('lory-input-css')) return;
        const st = document.createElement('style');
        st.id = 'lory-input-css';
        st.textContent = [
            'html,body,canvas{-webkit-tap-highlight-color:transparent}',
            '.lory-input-layer{position:fixed;inset:0;z-index:var(--lory-input-z,30);pointer-events:none;-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none;touch-action:none}',
            '.lory-input-layer.lory-input-off{display:none}',
            '.lory-stick{position:fixed;width:var(--hl-input-stick-w,calc(var(--lory-stick-r,64px)*2.6));height:var(--hl-input-stick-h,calc(var(--lory-stick-r,64px)*2.6));box-sizing:border-box;border-radius:50%;',
            'border:3px solid var(--lory-input-fg,#fff);background:var(--lory-input-bg,rgba(20,30,50,.35));opacity:0;transition:opacity .2s;',
            'left:var(--hl-input-stick-x,calc(env(safe-area-inset-left,0px) + 28px));top:var(--hl-input-stick-y,auto);bottom:var(--hl-input-stick-b,calc(env(safe-area-inset-bottom,0px) + 28px))}',
            '.lory-stick.idle{opacity:.35}',
            '.lory-stick.on{opacity:.75;transform:translate(-50%,-50%);bottom:auto}',
            '.lory-stick i{position:absolute;left:50%;top:50%;width:46%;height:46%;margin:-23% 0 0 -23%;border-radius:50%;background:var(--lory-input-fg,#fff);opacity:.85}',
            '.lory-ctx{--lory-ctx-d:var(--hl-input-action-w,var(--lory-ctx-size,76px));position:fixed;pointer-events:auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:0;box-sizing:border-box;',
            'width:var(--lory-ctx-d);height:var(--lory-ctx-d);border-radius:50%;',
            'right:var(--hl-input-action-r,calc(env(safe-area-inset-right,0px) + 20px));bottom:var(--hl-input-action-b,calc(env(safe-area-inset-bottom,0px) + 24px));',
            'border:3px solid var(--lory-input-fg,#fff);background:var(--lory-input-accent,rgba(40,110,200,.85));color:var(--lory-input-fg,#fff);',
            'font:800 calc(var(--lory-ctx-d)*.17)/1 system-ui,sans-serif;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;outline:none;cursor:pointer;',
            'transition:opacity .15s,transform .08s}',
            '.lory-ctx[hidden]{display:none}',
            '.lory-ctx:active,.lory-ctx.held{transform:scale(.94)}',
            '.lory-ctx-icon{font-size:calc(var(--lory-ctx-d)*.36);line-height:1;pointer-events:none}',
            '.lory-ctx-icon img{width:calc(var(--lory-ctx-d)*.42);height:calc(var(--lory-ctx-d)*.42);object-fit:contain;display:block}',
            '.lory-ctx-label{pointer-events:none;max-width:90%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-shadow:0 1px 2px rgba(0,0,0,.6)}',
        ].join('');
        document.head.appendChild(st);
    },

    _ensureUi() {
        if (this.ui || typeof document === 'undefined' || !document.body || !this.touchEnabled) return;
        const E = (tag, cls) => { const el = document.createElement(tag); if (cls) el.className = cls; return el; };
        const layer = E('div', 'lory-input-layer lory-input-off');
        const stick = E('div', 'lory-stick'), knob = E('i');
        stick.appendChild(knob);
        const btn = /** @type {HTMLButtonElement} */ (E('button', 'lory-ctx'));
        btn.type = 'button';
        btn.hidden = true;
        const icon = E('span', 'lory-ctx-icon'), label = E('span', 'lory-ctx-label');
        btn.appendChild(icon); btn.appendChild(label);
        layer.appendChild(stick); layer.appendChild(btn);
        document.body.appendChild(layer);
        this.ui = { layer, stick, knob, btn, icon, label };
        // нажатие кнопки: у каждого пальца своя «захваченная» цель — стик и кнопка работают вместе
        const press = (e) => {
            e.preventDefault(); e.stopPropagation();
            try { btn.setPointerCapture(e.pointerId); } catch (err) { /* синтетическое событие */ }
            btn.classList.add('held');
            this._held = e.pointerId;
            this._push('V:' + this.contextAction(), true);
            this._ctxHeldAction = this.contextAction();
        };
        const lift = (e) => {
            if (this._held !== e.pointerId) return;
            this._held = -1;
            btn.classList.remove('held');
            this._push('V:' + (this._ctxHeldAction || this.contextAction()), false);
        };
        btn.addEventListener('pointerdown', press);
        for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) btn.addEventListener(ev, lift);
        btn.addEventListener('contextmenu', e => e.preventDefault());
        this._renderContext();
        this._syncUi();
    },

    // Содержимое кнопки: значок (символ или картинка) и подпись.
    _renderContext() {
        const ui = this.ui, ctx = this.context;
        if (!ui) return;
        ui.btn.hidden = !ctx;
        if (!ctx) return;
        const label = ctx.label ? (typeof Lang !== 'undefined' ? Lang.t(ctx.label) : ctx.label) : '';
        ui.label.textContent = label;
        ui.btn.setAttribute('aria-label', label || ctx.id);
        ui.icon.textContent = '';
        const ic = ctx.icon || '';
        if (/^assets\/|\.(png|webp|svg|jpg)$/i.test(ic)) {
            const img = document.createElement('img');
            img.alt = '';
            img.src = ic;
            img.onerror = () => { img.remove(); };   // нет файла — кнопка без значка, не ошибка
            ui.icon.appendChild(img);
        } else ui.icon.textContent = ic;
    },

    _syncUi() {
        const ui = this.ui;
        if (!ui) return;
        // mouseTouch: стик и кнопка видны и на ПК; controls: false (меню) — не видны нигде
        const visible = this.controls && this.touchEnabled && (this.mouseTouch || (this.touchSeen && this.device === 'touch'));
        ui.layer.classList.toggle('lory-input-off', !visible);
        const st = ui.stick;
        if (this.stick.active && this._stick) {
            st.classList.add('on'); st.classList.remove('idle');
            st.style.left = this._stick.cx + 'px'; st.style.top = this._stick.cy + 'px';
        } else {
            st.classList.remove('on');
            st.classList.toggle('idle', this.stickIdle);
            st.style.left = ''; st.style.top = '';
            ui.knob.style.transform = '';
        }
    },

    /** Экранный элемент для указателя обучения: 'context' (кнопка) или 'stick'. null — их нет (ПК, нет касаний). */
    element(name) {
        if (!this.ui) return null;
        return name === 'context' ? this.ui.btn : name === 'stick' ? this.ui.stick : null;
    },
};
