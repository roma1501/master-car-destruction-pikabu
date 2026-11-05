// Telemetry.js — телеметрия игры для аналитики площадки (Platform.analytics: на Playgama —
// bridge.analytics.send, на остальных площадках — ничего, и модуль не работает вовсе).
// Контракт — руководство Playgama по телеметрии: стабильные имена событий, ограниченные значения,
// без личных данных, без своих session_id; сессию ведёт Bridge.
//
//   Telemetry.start(app)                 main.js после Platform.init: подписка на кадры (app.onFrame); сама ничего
//                                        не шлёт, пока идёт не активная игра. Не вызывать из игры.
//   Telemetry.progress(state, stepId, extra)  воронка прохождения: 'started' | 'completed' | 'failed' ->
//                                        progression_started / _completed / _failed { step_id, … }. stepId — стабильный
//                                        ограниченный id ('level_3', 'boss_forest'), а не счёт и не текст;
//                                        extra — плоские ограниченные поля (step_index, reason: 'timeout'…).
//   Platform.analytics(имя, данные)      любое другое событие игры (tutorial_completed, item_unlocked…)
//   Telemetry.isActive = () => boolean   необязательно: своё определение «идёт игра» вместо Platform.gameplay
//
// performance_sample — один агрегированный сэмпл за окно TELEMETRY_WINDOW_MS (Constants.js) АКТИВНОЙ игры:
// раунд идёт (Platform.gameplay(true)), вкладка видна, нет паузы (в том числе загрузки и рекламы). Разрыв
// из-за паузы или фона кадром не считается. Счётчики ошибок — только за окно, без текстов и адресов.
// Поля: target_fps, window_ms, active_ms, frame_count, fps_avg, fps_p10, frame_time_p50/p95/p99/max_ms,
// frames_over_50/100/250/500/1000ms, game_version, js_error_count, unhandled_rejection_count,
// webgl_context_loss_count.

/** @satisfies {Record<string, any>} */
const Telemetry = {
    running: false,
    /** @type {null | (() => boolean)} */
    isActive: null,
    /** @type {Float32Array | null} */
    _frames: null,
    // Числа Constants.js (читаются один раз в start): в игре — лексический const, без него — запасные значения.
    _c: { window: 30000, target: 60, minFrames: 30, maxFrames: 8192, maxFrame: 5000 },
    _n: 0,
    _activeMs: 0,
    _start: 0,        // начало окна (первый активный кадр)
    _last: 0,
    _gap: true,       // следующий кадр идёт после разрыва: его интервал не считается
    _errors: 0,
    _rejections: 0,
    _contextLost: 0,

    // main.js после Platform.init. true — телеметрия запущена (площадка принимает аналитику).
    start(app) {
        if (this.running || !Platform.analyticsSupported()) return false;
        this.running = true;
        this._c = {
            window: typeof TELEMETRY_WINDOW_MS !== 'undefined' ? TELEMETRY_WINDOW_MS : 30000,
            target: typeof TELEMETRY_TARGET_FPS !== 'undefined' ? TELEMETRY_TARGET_FPS : 60,
            minFrames: typeof TELEMETRY_MIN_FRAMES !== 'undefined' ? TELEMETRY_MIN_FRAMES : 30,
            maxFrames: typeof TELEMETRY_MAX_FRAMES !== 'undefined' ? TELEMETRY_MAX_FRAMES : 8192,
            maxFrame: typeof TELEMETRY_MAX_FRAME_MS !== 'undefined' ? TELEMETRY_MAX_FRAME_MS : 5000,
        };
        this._frames = new Float32Array(Math.max(1, Math.floor(this._c.maxFrames)));
        this._reset();
        const gap = () => { this._gap = true; };
        Pause.onChange(gap);
        document.addEventListener('visibilitychange', gap);
        window.addEventListener('error', () => { this._errors++; });
        window.addEventListener('unhandledrejection', () => { this._rejections++; });
        const canvas = document.getElementById('world3d');
        if (canvas) canvas.addEventListener('webglcontextlost', () => { this._contextLost++; });
        if (app && typeof app.onFrame === 'function') app.onFrame(() => this.frame(performance.now()));
        return true;
    },

    // Воронка: Platform.analytics('progression_<state>', { step_id, …extra }).
    progress(state, stepId, extra) {
        if (state !== 'started' && state !== 'completed' && state !== 'failed') return;
        Platform.analytics('progression_' + state, Object.assign({}, extra, { step_id: String(stepId == null ? '' : stepId) }));
    },

    // Идёт ли сейчас активная видимая игра: раунд, не пауза/загрузка/реклама, вкладка видна.
    _active() {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
        if (Pause.active) return false;
        return this.isActive ? !!this.isActive() : Platform.playing;
    },

    // Кадр цикла. now — performance.now() (для тестов — любое монотонное время, мс).
    frame(now) {
        const dt = this._last ? now - this._last : 0;
        this._last = now;
        if (!this._active()) { this._gap = true; return; }
        if (this._gap) { this._gap = false; return; }
        if (!(dt > 0) || dt > this._c.maxFrame) return;
        if (!this._start) this._start = now - dt;   // окно начинается с интервала первого учтённого кадра: active_ms <= window_ms
        this._frames[this._n++] = dt;
        this._activeMs += dt;
        const full = this._n >= this._frames.length;
        if (full || (now - this._start >= this._c.window && this._n >= this._c.minFrames)) this._flush(now);
    },

    _reset() {
        this._n = 0; this._activeMs = 0; this._start = 0;
        this._errors = 0; this._rejections = 0; this._contextLost = 0;
    },

    // Один агрегированный сэмпл за окно; счётчики — только за это окно.
    _flush(now) {
        const n = this._n;
        const ft = Array.from(this._frames.subarray(0, n)).sort((a, b) => a - b);
        const pct = (p) => ft[Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))))];
        const over = (ms) => { let c = 0; for (let i = n - 1; i >= 0 && ft[i] > ms; i--) c++; return c; };
        const r1 = (v) => Math.round(v * 10) / 10;
        /** @type {Record<string, string | number>} */
        const sample = {
            target_fps: this._c.target,
            window_ms: Math.round(now - this._start),
            active_ms: Math.round(this._activeMs),
            frame_count: n,
            fps_avg: r1(n / Math.max(0.001, this._activeMs / 1000)),
            fps_p10: r1(1000 / Math.max(0.001, pct(0.9))),
            frame_time_p50_ms: r1(pct(0.5)),
            frame_time_p95_ms: r1(pct(0.95)),
            frame_time_p99_ms: r1(pct(0.99)),
            frame_time_max_ms: r1(ft[n - 1]),
            frames_over_50ms: over(50),
            frames_over_100ms: over(100),
            frames_over_250ms: over(250),
            frames_over_500ms: over(500),
            frames_over_1000ms: over(1000),
            game_version: typeof GAME_VERSION !== 'undefined' ? String(GAME_VERSION) : '',
            js_error_count: this._errors,
            unhandled_rejection_count: this._rejections,
            webgl_context_loss_count: this._contextLost,
        };
        Platform.analytics('performance_sample', sample);
        this._reset();
    },
};
