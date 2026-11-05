// Sky3D.js — время суток и простая погода: день-ночь по часам, рассвет и закат, лунный свет,
// туман и тон неба в дождь, пасмурность, снег. Меняет только свет, небо и туман вида (те же
// ключи World3D.cfg(), что у констант) — купола, звёзд и облаков нет: небо в движке — цвет
// фона, одинаковый с туманом.
//
// ДЕНЬ — ЭТО КОНСТАНТЫ мира: в полдень видна ровно та картинка, что в редакторе
// (WORLD3D_SUN_*, WORLD3D_SKY*, WORLD3D_FOG_DENSITY). Сумерки и ночь — SKY_* из Constants.js
// (цвета и сила света луны, неба, тумана). Час 0..24: SKY_SUNRISE_HOUR — восход,
// SKY_SUNSET_HOUR — закат, SKY_TWILIGHT_HOURS — длительность рассвета и сумерек.
// Солнце идёт по дуге: высота от SKY_SUN_MIN_ELEVATION_DEG до WORLD3D_SUN_ELEVATION_DEG в
// полдень, направление тени за день поворачивается на SKY_SUN_SWEEP_DEG вокруг
// WORLD3D_SUN_AZIMUTH_DEG. Ночью свет — луна (SKY_MOON_ELEVATION_DEG), идёт тем же путём дальше: форма предметов читается.
//
// ПОДКЛЮЧЕНИЕ (игра): после создания карты —
//   Sky3D.init(app.location.view, { fx: app.fx });   // fx не обязателен: дождь и снег — частицами
//   app.onUpdate(dt => Sky3D.update(dt));            // на паузе не идёт — время стоит
//   Sky3D.setHour(7);  Sky3D.setWeather('rain');     // событие, меню отладки, сюжет
// Вид один на всю игру (смена карты его не пересоздаёт): init — один раз.
//
//   Sky3D.hour             час суток 0..24; Sky3D.day — номер суток; Sky3D.speed — множитель хода
//   Sky3D.frozen           true — время стоит (погода идёт); SKY_CYCLE_SECONDS = 0 — то же
//   Sky3D.daylight         0 ночь … 1 день;  Sky3D.isNight()
//   Sky3D.setHour(h) / skipTo(h)   час суток (skipTo заодно считает сутки)
//   Sky3D.setWeather(id)   'clear' | 'cloudy' | 'fog' | 'rain' | 'storm' | 'snow' — плавно, SKY_WEATHER_FADE с
//   Sky3D.flash(power, s)  вспышка света (молния, взрыв); в шторм бьёт сама, событие 'thunder'
//   Sky3D.on(event, fn)    'dawn' | 'day' | 'dusk' | 'night' | 'weather' | 'thunder'; возвращает отписку
//   Sky3D.state() / load(s)  { hour, day, weather } — в сохранение игры
//   Sky3D.look(hour, weather, base, c)  чистая функция: часы + погода -> ключи cfg (её гоняют тесты)
//   Sky3D.WEATHER          пресеты погоды — игра может дописать свои до init
// Pause: update не зовут на паузе — время и частицы стоят.

/** @satisfies {Record<string, any>} */
const Sky3D = {
    /** @type {View3D | null} */
    view: null,
    /** @type {any} */
    fx: null,
    /** Час суток 0..24. */
    hour: 11,
    day: 1,
    speed: 1,
    frozen: false,
    /** 0 ночь … 1 день. */
    daylight: 1,
    /** Погода, к которой идём. Текущая смесь пресетов (_w) плавно догоняет её за SKY_WEATHER_FADE секунд. */
    weatherId: 'clear',
    /** Текущая смесь: множители света и тумана, обесцвечивание, тон (rgb 0..1) и его доля. @type {any} */
    _w: { sun: 1, sky: 1, fog: 1, grey: 0, tintAmt: 0, tint: [0.6, 0.65, 0.71] },
    /** Смесь в момент смены погоды и ход перехода 0..1. @type {any} */
    _from: null,
    _t: 1,
    flashK: 0,
    flashRate: 6,
    _applied: -1,
    _dirty: true,
    _thunderIn: 0,
    _rng: 12345,
    /** @type {any} */
    _precip: null,
    _precipKind: '',
    _precipCheck: 0,
    /** @type {Record<string, Array<(arg?: any) => void>>} */
    _subs: {},

    // Пресеты погоды: множители света (sun — солнца, sky — неба), густоты тумана (fog), доля
    // обесцвечивания (grey), тон тумана и неба (tint, tintAmt — на сколько он заменяет цвет неба),
    // precip — частицы (rain | snow; rate и capacity — для ParticleFX), lightning — бьёт молния.
    WEATHER: {
        clear: { sun: 1, sky: 1, fog: 1, grey: 0, tint: 0x9aa6b4, tintAmt: 0 },
        cloudy: { sun: 0.55, sky: 1.1, fog: 1.3, grey: 0.35, tint: 0xa9b3bf, tintAmt: 0.35 },
        fog: { sun: 0.45, sky: 1.15, fog: 6, grey: 0.5, tint: 0xc3cad0, tintAmt: 0.8 },
        rain: { sun: 0.4, sky: 1, fog: 2.4, grey: 0.5, tint: 0x7f8c9c, tintAmt: 0.6, precip: { kind: 'rain', rate: 520, capacity: 900 } },
        storm: { sun: 0.25, sky: 0.9, fog: 3, grey: 0.65, tint: 0x4d5868, tintAmt: 0.7, lightning: 1, precip: { kind: 'rain', rate: 760, capacity: 1300 } },
        snow: { sun: 0.65, sky: 1.15, fog: 3, grey: 0.45, tint: 0xdfe6ee, tintAmt: 0.6, precip: { kind: 'snow', rate: 170, capacity: 500 } }
    },

    // Константы неба с дефолтами (в игре они — лексические const: только typeof по имени).
    cfg() {
        const U = 'undefined';
        return {
            cycle: typeof SKY_CYCLE_SECONDS !== U ? SKY_CYCLE_SECONDS : 480,
            start: typeof SKY_START_HOUR !== U ? SKY_START_HOUR : 11,
            rise: typeof SKY_SUNRISE_HOUR !== U ? SKY_SUNRISE_HOUR : 6,
            set: typeof SKY_SUNSET_HOUR !== U ? SKY_SUNSET_HOUR : 18,
            twilight: typeof SKY_TWILIGHT_HOURS !== U ? SKY_TWILIGHT_HOURS : 1.5,
            sweep: typeof SKY_SUN_SWEEP_DEG !== U ? SKY_SUN_SWEEP_DEG : 140,
            minEl: typeof SKY_SUN_MIN_ELEVATION_DEG !== U ? SKY_SUN_MIN_ELEVATION_DEG : 8,
            moonEl: typeof SKY_MOON_ELEVATION_DEG !== U ? SKY_MOON_ELEVATION_DEG : 38,
            twiSun: typeof SKY_TWILIGHT_SUN_COLOR !== U ? SKY_TWILIGHT_SUN_COLOR : 0xffa464,
            twiSky: typeof SKY_TWILIGHT_SKY_COLOR !== U ? SKY_TWILIGHT_SKY_COLOR : 0xf0a37c,
            nightSky: typeof SKY_NIGHT_SKY_COLOR !== U ? SKY_NIGHT_SKY_COLOR : 0x0c1630,
            nightSun: typeof SKY_NIGHT_SUN_COLOR !== U ? SKY_NIGHT_SUN_COLOR : 0xa8b8ea,
            nightSunI: typeof SKY_NIGHT_SUN_INTENSITY !== U ? SKY_NIGHT_SUN_INTENSITY : 0.5,
            nightSkyLight: typeof SKY_NIGHT_SKYLIGHT_COLOR !== U ? SKY_NIGHT_SKYLIGHT_COLOR : 0x8d9fd6,
            nightSkyI: typeof SKY_NIGHT_SKYLIGHT_INTENSITY !== U ? SKY_NIGHT_SKYLIGHT_INTENSITY : 0.55,
            nightGround: typeof SKY_NIGHT_GROUNDLIGHT_COLOR !== U ? SKY_NIGHT_GROUNDLIGHT_COLOR : 0x3f4a68,
            nightShadow: typeof SKY_NIGHT_SHADOW !== U ? SKY_NIGHT_SHADOW : 0.5,
            nightFog: typeof SKY_NIGHT_FOG !== U ? SKY_NIGHT_FOG : 1.6,
            fade: typeof SKY_WEATHER_FADE !== U ? SKY_WEATHER_FADE : 6
        };
    },

    // --- Чистая логика (её гоняют тесты) ---------------------------------------------------

    smooth(t) { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); },
    /** @param {number} h */
    wrap(h) { return ((h % 24) + 24) % 24; },

    // Светлота 0 (ночь) … 1 (день): подъём за SKY_TWILIGHT_HOURS вокруг восхода, спад вокруг заката.
    /** @param {number} hour @param {any} [c] */
    daylightAt(hour, c) {
        c = c || this.cfg();
        const h = this.wrap(hour), tw = Math.max(0.1, c.twilight);
        const up = this.smooth((h - (c.rise - tw / 2)) / tw);
        const down = 1 - this.smooth((h - (c.set - tw / 2)) / tw);
        return Math.max(0, Math.min(up, down));
    },

    // Вес сумерек 0..1: максимум в момент восхода и заката, спад за SKY_TWILIGHT_HOURS в обе стороны.
    /** @param {number} hour @param {any} [c] */
    twilightAt(hour, c) {
        c = c || this.cfg();
        const h = this.wrap(hour), tw = Math.max(0.1, c.twilight);
        const near = (m) => this.smooth(1 - Math.abs(h - m) / tw);
        return Math.max(near(c.rise), near(c.set));
    },

    /** @param {number} hex @returns {number[]} */
    rgb(hex) { const n = (hex >>> 0) & 0xffffff; return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; },
    /** @param {number[]} c */
    hex(c) {
        const b = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
        return (b(c[0]) << 16) | (b(c[1]) << 8) | b(c[2]);
    },
    /** @param {number[]} a @param {number[]} b @param {number} t */
    mixRgb(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; },
    /** @param {number[]} c @param {number} t */
    greyRgb(c, t) { const l = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]; return this.mixRgb(c, [l, l, l], t); },

    // Направление света в этот час (углы cfg, градусы). Днём — солнце по дуге: азимут тени за день
    // поворачивается на SKY_SUN_SWEEP_DEG, высота от SKY_SUN_MIN_ELEVATION_DEG до высоты констант в полдень.
    // Ночью — луна: азимут продолжает путь от заката к восходу (остальные градусы круга за ночь), высота —
    // SKY_MOON_ELEVATION_DEG; на рассвете и закате высота плавно переходит между ними, азимут не скачет.
    // base — World3D.baseCfg(): полдень = его sunEl и sunAz.
    /** @param {number} hour @param {any} base @param {any} [c] */
    sunAngles(hour, base, c) {
        c = c || this.cfg();
        const h = this.wrap(hour), day = Math.max(0.5, c.set - c.rise);
        const p = Math.max(0, Math.min(1, (h - c.rise) / day));
        const elSun = c.minEl + (Math.max(c.minEl, base.sunEl) - c.minEl) * Math.sin(Math.PI * p);
        let az = base.sunAz + c.sweep * (p - 0.5);
        if (h > c.set || h < c.rise) {
            const night = 24 - day, q = (h >= c.set ? h - c.set : h + 24 - c.set) / night;
            az = base.sunAz + c.sweep / 2 + (360 - c.sweep) * q;
        }
        const t = this.smooth((this.daylightAt(h, c) - 0.05) / 0.9);
        return { az, el: c.moonEl + (elSun - c.moonEl) * t };
    },

    // Свет, небо и туман на час суток под погодой -> ключи World3D.cfg() (числа; цвета — 0xRRGGBB).
    // base — World3D.baseCfg() (значения констант: «день»), weather — смесь пресетов
    // { sun, sky, fog, grey, tint, tintAmt }. Возвращает ключи и daylight / twilight для проверки.
    /** @param {number} hour @param {any} weather @param {any} base @param {any} [c] */
    look(hour, weather, base, c) {
        c = c || this.cfg();
        const d = this.daylightAt(hour, c), w = this.twilightAt(hour, c), M = (a, b, t) => this.mixRgb(a, b, t);
        const col = (day, night, twi, amt) => {
            let v = M(this.rgb(night), this.rgb(day), d);
            if (twi != null) v = M(v, this.rgb(twi), w * (amt == null ? 1 : amt));
            return v;
        };
        let sky = col(base.sky, c.nightSky, c.twiSky);
        let sun = col(base.sunColor, c.nightSun, c.twiSun);
        let skyLight = col(base.skyLight, c.nightSkyLight, null);
        let ground = col(base.groundLight, c.nightGround, null);
        const W = weather || {};
        const grey = Number(W.grey) || 0;
        if (grey > 0) { sky = this.greyRgb(sky, grey); sun = this.greyRgb(sun, grey); skyLight = this.greyRgb(skyLight, grey); ground = this.greyRgb(ground, grey); }
        // Тон погоды (rgb 0..1 или 0xRRGGBB) заменяет цвет неба и тумана; ночью тон темнее (светлота от дня).
        const amt = Number(W.tintAmt) || 0;
        if (amt > 0) {
            const tint = Array.isArray(W.tint) ? W.tint : this.rgb(Number(W.tint));
            sky = M(sky, tint.map(v => v * (0.2 + 0.8 * d)), amt);
        }
        const at = this.sunAngles(hour, base, c);
        const mix = (night, day) => night + (day - night) * d;
        return {
            sunAz: at.az,
            sunEl: at.el,
            sunColor: this.hex(sun),
            sunIntensity: mix(c.nightSunI, base.sunIntensity) * (W.sun != null ? Number(W.sun) : 1),
            skyLight: this.hex(skyLight),
            skyIntensity: mix(c.nightSkyI, base.skyIntensity) * (W.sky != null ? Number(W.sky) : 1),
            groundLight: this.hex(ground),
            sky: this.hex(sky),
            fog: base.fog * mix(c.nightFog, 1) * (W.fog != null ? Number(W.fog) : 1),
            shadowStrength: base.shadowStrength * mix(c.nightShadow, 1),
            daylight: d,
            twilight: w
        };
    },

    // --- Состояние -----------------------------------------------------------------------

    // Один раз после создания вида. opts: { hour?, fx?: ParticleFX (дождь и снег частицами) }.
    /** @param {View3D} [view] @param {{ hour?: number, fx?: any }} [opts] */
    init(view, opts) {
        const o = opts || {};
        this.view = view || World3D.view || null;
        this.fx = o.fx || null;
        this.hour = this.wrap(o.hour != null ? Number(o.hour) : this.cfg().start);
        this.day = 1;
        this.flashK = 0;
        this._dirty = true;
        this._applied = -1;
        this._subs = this._subs || {};
        this.apply();
        return this;
    },

    // Снять управление: константы мира возвращаются, частицы гаснут.
    stop() {
        this._stopPrecip();
        World3D.setLighting({ sunAz: null, sunEl: null, sunColor: null, sunIntensity: null, skyLight: null, skyIntensity: null,
            groundLight: null, sky: null, fog: null, shadowStrength: null }, this.view);
        this.view = null;
    },

    isNight() { return this.daylight < 0.35; },

    // Часы:минуты для HUD ('07:30').
    clock() {
        const h = this.wrap(this.hour), m = Math.floor((h % 1) * 60);
        return String(Math.floor(h)).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    },

    /** @param {number} h */
    setHour(h) {
        this.hour = this.wrap(Number(h) || 0);
        this._dirty = true;
        this.apply();
    },

    // Перемотать до часа h: если час уже прошёл сегодня — наступят следующие сутки.
    /** @param {number} h */
    skipTo(h) {
        const to = this.wrap(Number(h) || 0);
        if (to <= this.wrap(this.hour)) { this.day++; this._emit('day-number', this.day); }
        this.setHour(to);
    },

    /** @param {string} id */
    setWeather(id) {
        if (!this.WEATHER[id]) return false;
        if (id === this.weatherId) return true;
        this._from = this._copyW(this._w);   // переход идёт от того, что сейчас на экране
        this._t = 0;
        this.weatherId = id;
        this._thunderIn = 3 + this._random() * 4;
        this._emit('weather', id);
        return true;
    },

    // Пресет -> смесь: тон — rgb 0..1.
    /** @param {any} p */
    _copyW(p) {
        return { sun: Number(p.sun), sky: Number(p.sky), fog: Number(p.fog), grey: Number(p.grey) || 0, tintAmt: Number(p.tintAmt) || 0,
            tint: Array.isArray(p.tint) ? p.tint.slice() : this.rgb(Number(p.tint)) };
    },

    // Вспышка света (молния, взрыв): добавка к свету неба, гаснет за seconds.
    /** @param {number} [power] @param {number} [seconds] */
    flash(power, seconds) {
        const p = Math.max(0, Math.min(1.6, power == null ? 0.8 : power));
        if (p < this.flashK) return;
        this.flashK = p;
        this.flashRate = 4 / Math.max(0.06, seconds || 0.4);
        this._dirty = true;
    },

    /** @param {string} event @param {(arg?: any) => void} fn @returns {() => void} */
    on(event, fn) {
        (this._subs[event] || (this._subs[event] = [])).push(fn);
        return () => { const l = this._subs[event]; const i = l ? l.indexOf(fn) : -1; if (i >= 0) l.splice(i, 1); };
    },

    _emit(event, arg) {
        for (const fn of (this._subs[event] || []).slice()) { try { fn(arg); } catch (e) { console.error('Sky3D:', e); } }
    },

    // Свой маленький детерминированный генератор: молнии не зависят от Math.random (тесты, повторы).
    _random() {
        this._rng = (Math.imul(this._rng, 1664525) + 1013904223) >>> 0;
        return this._rng / 4294967296;
    },

    state() { return { hour: this.hour, day: this.day, weather: this.weatherId }; },

    /** @param {{ hour?: number, day?: number, weather?: string } | null} s */
    load(s) {
        if (!s) return;
        if (Number.isFinite(s.hour)) this.hour = this.wrap(Number(s.hour));
        if (Number.isFinite(s.day)) this.day = Math.max(1, Math.round(Number(s.day)));
        if (s.weather && this.WEATHER[s.weather]) { this.weatherId = s.weather; this._w = this._copyW(this.WEATHER[s.weather]); this._t = 1; }
        this._dirty = true;
        this.apply();
    },

    // --- Кадр ---------------------------------------------------------------------------------

    // Раз в кадр вне паузы: время суток, плавная смена погоды, вспышки, молнии шторма.
    /** @param {number} dt */
    update(dt) {
        if (!this.view || !this.view.scene) return;
        dt = Math.min(0.1, Math.max(0, dt || 0));
        const c = this.cfg();
        if (!this.frozen && c.cycle > 0 && dt > 0) {
            const before = this.hour;
            let h = before + dt * this.speed * 24 / c.cycle;
            if (h >= 24) { h -= 24; this.day++; this._emit('day-number', this.day); }
            this.hour = h;
            this._events(before, h, c);
        }
        if (this._fadeWeather(dt, c)) this._dirty = true;
        const W = this.WEATHER[this.weatherId];
        if (W && W.lightning && this._weatherReached()) {
            this._thunderIn -= dt;
            if (this._thunderIn <= 0) {
                this._thunderIn = 5 + this._random() * 9;
                this.flash(0.7 + this._random() * 0.6, 0.35);
                this._emit('thunder', this.flashK);
            }
        }
        if (this.flashK > 0.003) { this.flashK *= Math.exp(-dt * this.flashRate); this._dirty = true; }
        else if (this.flashK) { this.flashK = 0; this._dirty = true; }
        this._precipCheck -= dt;
        if (this._precipCheck <= 0) { this._precipCheck = 0.5; this._syncPrecip(); }
        // Свет пересчитывается, когда что-то заметно сдвинулось: ~0.02 часа — доли градуса дуги солнца.
        if (this._dirty || Math.abs(this.hour - this._applied) >= 0.02) this.apply();
    },

    // События суток: границы рассвета, дня, заката, ночи (по краям SKY_TWILIGHT_HOURS).
    _events(a, b, c) {
        const tw = c.twilight / 2;
        const cross = (x) => { const m = this.wrap(x); return a <= b ? a < m && b >= m : (a < m || b >= m); };
        if (cross(c.rise - tw)) this._emit('dawn', this.day);
        if (cross(c.rise + tw)) this._emit('day', this.day);
        if (cross(c.set - tw)) this._emit('dusk', this.day);
        if (cross(c.set + tw)) this._emit('night', this.day);
    },

    // Смесь пресетов идёт от прежней погоды к выбранной за SKY_WEATHER_FADE секунд (плавно, smoothstep);
    // true — что-то сдвинулось.
    _fadeWeather(dt, c) {
        if (this._t >= 1) return false;
        this._t = c.fade > 0 ? Math.min(1, this._t + dt / c.fade) : 1;
        const from = this._from || this._w, to = this._copyW(this.WEATHER[this.weatherId] || this.WEATHER.clear), k = this.smooth(this._t);
        const w = this._w;
        for (const key of ['sun', 'sky', 'fog', 'grey', 'tintAmt']) w[key] = from[key] + (to[key] - from[key]) * k;
        // Тон: у погоды без тона (ясно) цвет не меняется — исчезает только его доля.
        const toTint = to.tintAmt > 0 ? to.tint : from.tint, fromTint = from.tintAmt > 0 ? from.tint : toTint;
        w.tint = this.mixRgb(fromTint, toTint, k);
        return true;
    },

    // Погода установилась наполовину: молнии бьют и частицы идут, когда небо уже потемнело.
    _weatherReached() {
        return this._t >= 0.5;
    },

    // Свет мира под часы и погоду. Пишет только в переопределения cfg() (Constants.js не трогает).
    apply() {
        if (!this.view || !this.view.scene) return;
        const c = this.cfg(), base = World3D.baseCfg();
        const L = this.look(this.hour, this._w, base, c);
        this.daylight = L.daylight;
        const f = this.flashK;
        World3D.setLighting({
            sunAz: L.sunAz,
            sunEl: L.sunEl,
            sunColor: L.sunColor,
            sunIntensity: L.sunIntensity + f * 0.5,
            skyLight: L.skyLight,
            skyIntensity: L.skyIntensity + f * 1.5,
            groundLight: L.groundLight,
            sky: L.sky,
            fog: L.fog,
            shadowStrength: L.shadowStrength
        }, this.view);
        this._applied = this.hour;
        this._dirty = false;
    },

    // --- Дождь и снег (ParticleFX) ----------------------------------------------------------

    // Частицы выбранной погоды: запускаются, когда погода почти установилась, и гаснут вместе с ней.
    // Эффекты живут в ParticleFX (fx.clear() при смене карты их снимает — здесь они пересоздаются).
    _syncPrecip() {
        const fx = this.fx, t = this.WEATHER[this.weatherId], spec = t && t.precip;
        const want = fx && spec && this._weatherReached() ? spec : null;
        const alive = this._precip && this._precipAlive();
        if (!want) { if (this._precip) this._stopPrecip(); return; }
        if (alive && this._precipKind === want.kind + ':' + want.rate) return;
        this._stopPrecip();
        this._startPrecip(want);
    },

    _precipAlive() {
        const fx = this.fx, h = this._precip;
        if (!fx || !h || !fx.effects) return false;
        for (const e of fx.effects) if (e.system === h.system) return true;
        return false;
    },

    /** @param {{ kind: string, rate: number, capacity: number }} spec */
    _startPrecip(spec) {
        const fx = this.fx, view = this.view;
        if (!fx || !view) return;
        const follow = () => view.camera.getTarget();
        const box = [[-1100, 350, -1100], [1100, 800, 1100]];
        const rain = spec.kind === 'rain';
        const h = fx.create(rain
            ? { name: 'sky-rain', rate: spec.rate, capacity: spec.capacity, life: [0.45, 0.7], size: [4, 6], speed: [1300, 1750],
                color: '#e6f0ff', alpha: 0.7, blend: 'standard', box, direction: [[-0.06, -1, -0.05], [0.06, -1, 0.05]], follow }
            : { name: 'sky-snow', rate: spec.rate, capacity: spec.capacity, life: [3, 5], size: [5, 9], speed: [40, 90],
                color: '#ffffff', alpha: 0.85, blend: 'standard', gravity: [0, -12, 0], box, direction: [[-0.3, -1, -0.3], [0.3, -0.6, 0.3]], follow });
        if (!h) return;
        if (rain && h.system && typeof BABYLON !== 'undefined') {
            h.system.billboardMode = BABYLON.ParticleSystem.BILLBOARDMODE_STRETCHED;   // капля — штрих по скорости
            h.system.minScaleY = 8;
            h.system.maxScaleY = 11;
        }
        this._precip = h;
        this._precipKind = spec.kind + ':' + spec.rate;
    },

    _stopPrecip() {
        if (this._precip) { try { this._precip.stop(); } catch (e) { /* уже снят вместе с картой */ } }
        this._precip = null;
        this._precipKind = '';
    }
};
