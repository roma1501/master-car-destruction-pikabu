// Quality.js — уровни графики: низкий / средний / высокий. Уровень определяется по
// устройству (телефон или ПК, ядра, память, видеокарта), игрок может выбрать свой —
// выбор хранится через Store (GAME_ID.quality) и сильнее автоопределения.
//
// Что меняет уровень (числа — в Constants.js, группа QUALITY_*; в редакторе — «Графика»):
//   • декор — доля деревьев и кустов из папки декора: низкий убирает ~75%, средний ~50%,
//     высокий ~30% (Location3D с opts.quality). Какие именно объекты остаются, решает
//     Location3D.decorRank — по модели и позиции, а не случайно: на каждой загрузке те же
//     деревья, и множество «низкого» входит в «среднее», а оно — в «высокое»;
//   • тени — нет / облегчённые (карта теней мельче) / полные (WORLD3D_SHADOWS через
//     World3D.setOverrides);
//   • контур рёбер и обводка силуэта — нет / главные объекты / как в WORLD3D_TOON_*;
//   • плотность пикселей рендера — потолок QUALITY_DPR_* и на телефонах бюджет кадра
//     QUALITY_PIXELS_* (мегапиксели), но не мельче QUALITY_SCALE_MIN от CSS-разрешения:
//     картинка не должна мылиться.
//
// ПОДКЛЮЧЕНИЕ (main.js): Quality.init() после World3D.init(canvas) и до создания Location3D
// (карта сразу строится с нужной густотой), в Location3D — opts.quality = true.
//   Quality.level            0 | 1 | 2 (низкий, средний, высокий) — действующий
//   Quality.name             'low' | 'medium' | 'high'
//   Quality.choice           выбор игрока: 'auto' | 'low' | 'medium' | 'high'
//   Quality.set(choice)      выбор игрока (меню настроек игры): применяется живо и запоминается
//   Quality.onChange(fn)     fn(level, name) при смене уровня; возвращает отписку
//   Quality.decorKeep(level) доля декора, которая остаётся
//   Quality.detect(env)      чистая эвристика: env — { mobile, cores, memory, gpu, saveData }
// Игра рисует выбор уровня в своём меню сама (интерфейс у каждой игры свой); Quality отвечает
// за уровни и сохранение. Игра может хранить выбор и в своём сохранении: Quality.init({ choice }).

/** @satisfies {Record<string, any>} */
const Quality = {
    LEVELS: ['low', 'medium', 'high'],
    /** Действующий уровень: 0 низкий, 1 средний, 2 высокий. */
    level: 2,
    /** Выбор игрока: 'auto' | 'low' | 'medium' | 'high'. */
    choice: 'auto',
    /** Что дало автоопределение по устройству. */
    detected: 2,
    _inited: false,
    _ratio: 0,
    /** @type {Array<(level: number, name: string) => void>} */
    _subs: [],

    get name() { return this.LEVELS[this.level] || 'high'; },

    // Константы с дефолтами (в игре они — лексические const: только typeof по имени).
    cfg() {
        const U = 'undefined';
        return {
            auto: typeof QUALITY_AUTO !== U ? QUALITY_AUTO : 1,
            def: typeof QUALITY_DEFAULT !== U ? QUALITY_DEFAULT : 2,
            decor: [
                typeof QUALITY_DECOR_LOW !== U ? QUALITY_DECOR_LOW : 0.25,
                typeof QUALITY_DECOR_MEDIUM !== U ? QUALITY_DECOR_MEDIUM : 0.5,
                typeof QUALITY_DECOR_HIGH !== U ? QUALITY_DECOR_HIGH : 0.7
            ],
            shadows: [
                typeof QUALITY_SHADOWS_LOW !== U ? QUALITY_SHADOWS_LOW : 0,
                typeof QUALITY_SHADOWS_MEDIUM !== U ? QUALITY_SHADOWS_MEDIUM : 1,
                typeof QUALITY_SHADOWS_HIGH !== U ? QUALITY_SHADOWS_HIGH : 2
            ],
            shadowLite: typeof QUALITY_SHADOW_LITE_SCALE !== U ? QUALITY_SHADOW_LITE_SCALE : 0.5,
            outline: [
                typeof QUALITY_OUTLINE_LOW !== U ? QUALITY_OUTLINE_LOW : 0,
                typeof QUALITY_OUTLINE_MEDIUM !== U ? QUALITY_OUTLINE_MEDIUM : 1,
                typeof QUALITY_OUTLINE_HIGH !== U ? QUALITY_OUTLINE_HIGH : 2
            ],
            dpr: [
                typeof QUALITY_DPR_LOW !== U ? QUALITY_DPR_LOW : 1.25,
                typeof QUALITY_DPR_MEDIUM !== U ? QUALITY_DPR_MEDIUM : 1.5,
                typeof QUALITY_DPR_HIGH !== U ? QUALITY_DPR_HIGH : 2
            ],
            pixels: [
                typeof QUALITY_PIXELS_LOW !== U ? QUALITY_PIXELS_LOW : 0.55,
                typeof QUALITY_PIXELS_MEDIUM !== U ? QUALITY_PIXELS_MEDIUM : 0.85,
                typeof QUALITY_PIXELS_HIGH !== U ? QUALITY_PIXELS_HIGH : 1.4
            ],
            scaleMin: typeof QUALITY_SCALE_MIN !== U ? QUALITY_SCALE_MIN : 0.87
        };
    },

    // --- Чистая логика (её гоняют тесты) --------------------------------------------------

    // Номер уровня по имени или числу ('low' | 'medium' | 'high' | 0 | 1 | 2); -1 — не уровень.
    levelOf(v) {
        if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v <= 2 ? v : -1;
        return this.LEVELS.indexOf(String(v));
    },

    // Уровень по устройству. env: { mobile, cores, memory (ГБ, 0 — неизвестно), gpu (строка
    // видеокарты, '' — неизвестно), saveData }. Баллы: ПК начинает с высокого, телефон — со среднего;
    // мало ядер или памяти, слабая или программная видеокарта, экономия трафика — минус, мощный
    // телефон (много памяти, современный Adreno / Mali / Apple GPU) — плюс. Программный рендер — всегда низкий.
    /** @param {{ mobile?: boolean, cores?: number, memory?: number, gpu?: string, saveData?: boolean }} env @returns {number} */
    detect(env) {
        const e = env || {}, gpu = String(e.gpu || ''), mobile = !!e.mobile;
        if (/swiftshader|llvmpipe|software|basic render|microsoft/i.test(gpu)) return 0;
        const cores = Number(e.cores) || 0, mem = Number(e.memory) || 0;
        let pts = mobile ? 1 : 2;
        if (cores > 0 && cores <= 2) pts--;
        else if (mobile && cores > 0 && cores <= 4) pts--;
        if (mem > 0 && mem <= 2) pts--;
        else if (mobile && mem > 0 && mem <= 3) pts--;
        else if (mobile && mem >= 6) pts++;
        if (mobile) {
            if (/mali-4|mali-t|adreno \(tm\) [2-4]\d\d|powervr|sgx/i.test(gpu)) pts--;
            else if (/adreno \(tm\) [7-9]\d\d|apple gpu|mali-g7\d\d|mali-g[89]\d|immortalis|xclipse/i.test(gpu)) pts++;
        } else if (/intel/i.test(gpu) && !/arc/i.test(gpu)) {
            pts--;
        }
        if (e.saveData) pts--;
        return Math.max(0, Math.min(2, pts));
    },

    // Плотность пикселей рендера (пикселей на CSS px) для уровня. env: { dpr, width, height (CSS px),
    // mobile }. Потолок QUALITY_DPR_*; на телефонах и планшетах ещё и бюджет кадра QUALITY_PIXELS_*;
    // но не мельче QUALITY_SCALE_MIN (если устройство само не плотнее него): рендер не должен мылиться.
    /** @param {number} level @param {{ dpr?: number, width?: number, height?: number, mobile?: boolean }} env @param {any} [c] @returns {number} */
    pixelRatio(level, env, c) {
        c = c || this.cfg();
        const L = Math.max(0, Math.min(2, level | 0)), dpr = Math.max(0.25, Number(env.dpr) || 1);
        let r = Math.min(dpr, c.dpr[L]);
        if (env.mobile) {
            const css = Math.max(1, Number(env.width) || 1) * Math.max(1, Number(env.height) || 1);
            r = Math.min(r, Math.sqrt(c.pixels[L] * 1e6 / css));
        }
        r = Math.max(r, Math.min(dpr, c.scaleMin));
        return Math.round(r * 1000) / 1000;
    },

    // Доля декора, которая остаётся на сцене на уровне level (по умолчанию — действующем).
    /** @param {number} [level] */
    decorKeep(level) {
        const L = level == null ? this.level : Math.max(0, Math.min(2, level | 0));
        return Math.max(0, Math.min(1, this.cfg().decor[L]));
    },

    // Остаётся ли объект декора на уровне level: место объекта в порядке Location3D.decorRank против доли.
    /** @param {LocationObjectDef} def @param {number} [level] */
    keepDecor(def, level) {
        return typeof Location3D === 'undefined' || Location3D.decorRank(def) < this.decorKeep(level);
    },

    // Все настройки уровня разом (для меню игры и отладки).
    /** @param {number} [level] */
    settings(level) {
        const c = this.cfg(), L = level == null ? this.level : Math.max(0, Math.min(2, level | 0));
        return { level: L, name: this.LEVELS[L], decorKeep: this.decorKeep(L), shadows: c.shadows[L], outline: c.outline[L], dpr: c.dpr[L], pixels: c.pixels[L] };
    },

    // --- Среда и состояние -----------------------------------------------------------------

    // Устройство: что отдаёт браузер. Видеокарта — от движка (World3D.init уже был), иначе пусто.
    environment() {
        const nav = /** @type {any} */ (typeof navigator !== 'undefined' ? navigator : {});
        const win = /** @type {any} */ (typeof window !== 'undefined' ? window : {});
        let gpu = '';
        try {
            const eng = typeof World3D !== 'undefined' ? World3D.engine : null;
            const info = eng && typeof eng.getGlInfo === 'function' ? eng.getGlInfo() : null;
            gpu = info ? String(info.renderer || '') : '';
        } catch (e) { /* без рендерера */ }
        return {
            mobile: typeof IS_MOBILE !== 'undefined' && IS_MOBILE,
            cores: Number(nav.hardwareConcurrency) || 0,
            memory: Number(nav.deviceMemory) || 0,
            gpu,
            saveData: !!(nav.connection && nav.connection.saveData),
            dpr: Number(win.devicePixelRatio) || 1,
            width: Number(win.innerWidth) || 0,
            height: Number(win.innerHeight) || 0
        };
    },

    _key() { return (typeof GAME_ID !== 'undefined' ? GAME_ID : 'lory-game') + '.quality'; },

    // Уровень из выбора игрока и автоопределения.
    _resolve() {
        const c = this.cfg(), L = this.levelOf(this.choice);
        this.level = L >= 0 ? L : (c.auto > 0 ? this.detected : Math.max(0, Math.min(2, Math.round(c.def))));
        return this.level;
    },

    // После World3D.init и до Location3D. opts.choice — выбор игрока из сохранения игры (иначе Store).
    /** @param {{ choice?: string | number }} [opts] @returns {number} */
    init(opts) {
        const o = opts || {};
        if (this._inited) return this.level;
        this._inited = true;
        const stored = o.choice != null ? o.choice : (typeof Store !== 'undefined' ? Store.get(this._key()) : null);
        const L = this.levelOf(/^\d$/.test(String(stored)) ? Number(stored) : stored);
        this.choice = L >= 0 ? this.LEVELS[L] : 'auto';
        this.detected = this.detect(this.environment());
        this._resolve();
        this.apply();
        if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('resize', () => this.applyPixelRatio());
        return this.level;
    },

    // Выбор игрока: 'auto' | 'low' | 'medium' | 'high' (или 0..2). Применяется живо, запоминается;
    // подписчики (onChange) узнают, если уровень сменился. Возвращает действующий уровень.
    /** @param {string | number} choice */
    set(choice) {
        const L = this.levelOf(choice);
        this.choice = L >= 0 ? this.LEVELS[L] : 'auto';
        if (typeof Store !== 'undefined') {
            if (this.choice === 'auto') Store.remove(this._key());
            else Store.set(this._key(), this.choice);
        }
        const was = this.level;
        this._resolve();
        if (this.level !== was) {
            this.apply();
            for (const fn of this._subs.slice()) { try { fn(this.level, this.name); } catch (e) { console.error('Quality:', e); } }
        }
        return this.level;
    },

    /** @param {(level: number, name: string) => void} fn @returns {() => void} */
    onChange(fn) {
        this._subs.push(fn);
        return () => { const i = this._subs.indexOf(fn); if (i >= 0) this._subs.splice(i, 1); };
    },

    // Уровень -> настройки мира: тени, контур, плотность пикселей. Декор не здесь —
    // Location3D (applyDecor) сам подписан на смену уровня.
    apply() {
        if (typeof World3D === 'undefined' || !World3D.setOverrides) return;
        const c = this.cfg(), L = this.level, base = World3D.baseCfg();
        const shadows = c.shadows[L];
        const cap = Math.max(0, Math.min(2, c.outline[L]));
        World3D.setOverrides({
            shadows: shadows > 0 ? null : 0,
            shadowMap: shadows === 1 ? Math.max(256, Math.round(base.shadowMap * c.shadowLite)) : null,
            outline: cap < base.outline ? cap : null,
            ink: cap < base.ink ? cap : null
        });
        this.applyPixelRatio();
    },

    // Плотность пикселей: зависит ещё и от размера окна (поворот телефона меняет бюджет).
    applyPixelRatio() {
        if (typeof World3D === 'undefined' || !World3D.setPixelRatio || !World3D.engine) return;
        const r = this.pixelRatio(this.level, this.environment());
        if (r === this._ratio) return;
        this._ratio = r;
        World3D.setPixelRatio(r);
    }
};
