// Sound.js — звук игры на Web Audio: эффекты и музыка по путям assets/sounds/….
// Звуки берутся из библиотеки Sound Pack (в корне набора, в архив не едет):
// node tools/sounds.mjs find <слова> -> add "<путь в Sound Pack>" <имя> копирует
// файл в assets/sounds/ латинским именем. В коде путь — ЛИТЕРАЛОМ, иначе сборщик
// его не увидит (Sound.play с путём в кавычках — см. скилл game).
//
// Молчит, когда: игрок выключил звук (setMuted — хранится в Store), платформа
// выключила звук (Playables isAudioEnabled), идёт rewarded без паузы игры (setAdMuted), игра на любой паузе
// (Pause.js — вкладка скрыта, реклама, пауза платформы или игрока). На паузе контекст
// приостанавливается: музыка встаёт и продолжается с того же места.
// Обычный браузер пускает звук после жеста игрока: AudioContext создаётся на первом
// pointerdown / keydown, до него файлы декодирует OfflineAudioContext (буфер
// годится любому контексту), а музыка ждёт жеста и стартует сама.
// Громкость — SOUND_VOLUME и MUSIC_VOLUME (Constants.js, редактор), читается при
// каждом звуке.
//
// Сведение: master -> лимитер (DynamicsCompressor) -> выход: много одновременных звуков не
// клипуют. Музыка идёт через duckGain (приглушение), эффекты и циклы — прямо в master.
//   Sound.play(url, opts)      -> { stop(), fade(секунды) }: разовый эффект
//   Sound.play([url, url, …], opts)  ВАРИАНТЫ: частые звуки (прыжок, приземление, удар) — 2–4 файла; каждый раз
//                                 случайный, но не тот же, что в прошлый раз; небольшой разброс высоты и громкости
//                                 (SOUND_VARIANT_DETUNE / SOUND_VARIANT_VOLUME_JITTER; opts.detune / opts.volumeJitter
//                                 переопределяют, 0 — без разброса). Только массив литералов-путей в кавычках: сборщик
//                                 видит каждый путь. Файлы — jump-1.ogg, jump-2.ogg…; Sound.pick(список) — тот же выбор без звука
//   Sound.loop(url, opts)      -> { set(volume, rate), fade(секунды), stop() }: цикл с плавной
//                                 громкостью и скоростью (мотор, ветер, шаги); opts: { volume, rate }
//   Sound.makeBuffer(samples, rate) / putBuffer(имя, буфер): свой синтез; потом
//                                 Sound.play('synth:имя') и Sound.loop('synth:имя') без файла
//   Sound.duck(level, fadeIn, hold, fadeOut) / unduck(fadeOut): приглушить музыку (эффекты не трогает)
// Причина паузы 'adwait' (игра стоит, пока реклама запрашивается) звук НЕ глушит: он стихает
// только на причине 'ad' — когда ролик реально начался (см. _paused).
//   Sound.setAdMuted(on)       rewarded без паузы игры (Platform, ADS_REWARDED_PAUSE = 0): игра идёт, звук молчит
//                              до конца ролика (контекст не останавливается — музыка и эффекты просто не слышны)

/** @satisfies {Record<string, any>} */
const Sound = {
    /** @type {AudioContext | null} */
    ctx: null,
    /** @type {GainNode | null} */
    master: null,
    /** @type {GainNode | null} */
    musicGain: null,
    /** @type {GainNode | null} */
    duckGain: null,         // музыка -> duckGain -> master (duck / unduck)
    /** @type {DynamicsCompressorNode | null} */
    limiter: null,          // master -> limiter -> выход; null — у браузера нет DynamicsCompressor
    /** @type {{ level: number, end: number } | null} */
    _duck: null,            // текущее приглушение: уровень и конец удержания (ctx.currentTime)
    /** @type {any[]} */
    _loops: [],             // живые циклы Sound.loop (стартуют после первого жеста)
    /** @type {BaseAudioContext | null} */
    _decoder: null,
    buffers: new Map(),     // url -> Promise<AudioBuffer | null>
    muted: false,           // игрок
    platformMuted: false,   // платформа (Playables)
    adMuted: false,         // идёт rewarded без паузы игры (Platform, ADS_REWARDED_PAUSE = 0)
    rng: Math.random,       // источник случайного для вариантов и разброса (тесты подменяют)
    /** @type {Map<string, number>} */
    _lastVariant: new Map(),   // список вариантов (url через |) -> индекс прошлого выбора
    _music: null,           // { url, opts, source, gain }
    _inited: false,

    init() {
        if (this._inited) return;
        this._inited = true;
        this.muted = Store.get(this._key('muted')) === '1';
        const unlock = () => {
            if (!this._ensure()) return;
            this._sync();
            this._startPending();
        };
        for (const type of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(type, unlock, true);
        Pause.onChange(() => this._sync());
    },

    _key(name) {
        return (typeof GAME_ID !== 'undefined' ? GAME_ID : 'lory-game') + '.' + name;
    },

    // Живой контекст — только после жеста (зовёт unlock).
    _ensure() {
        if (this.ctx) return this.ctx;
        const AC = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
        if (!AC) return null;
        try { this.ctx = new AC(); } catch (e) { return null; }
        this.master = this.ctx.createGain();
        // Лимитер на выходе: одновременные удары, шаги и фон не клипуют микс.
        if (typeof this.ctx.createDynamicsCompressor === 'function') {
            const limiter = this.limiter = this.ctx.createDynamicsCompressor();
            limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 12;
            limiter.attack.value = 0.003; limiter.release.value = 0.18;
            this.master.connect(limiter); limiter.connect(this.ctx.destination);
        } else this.master.connect(this.ctx.destination);
        this.duckGain = this.ctx.createGain();
        this.duckGain.connect(this.master);
        this.musicGain = this.ctx.createGain();
        this.musicGain.connect(this.duckGain);
        return this.ctx;
    },

    // То, что ждало разрешения на звук (жест игрока или платформа): музыка и циклы.
    _startPending() {
        if (this._music && !this._music.gain) this._startTrack(this._music, 0.6);
        for (const h of this._loops.slice()) this._startLoop(h);
    },

    get unlocked() { return !!this.ctx; },
    get silent() { return this.muted || this.platformMuted || this.adMuted || this._paused(); },

    // Пауза глушит звук — кроме причины 'adwait': игра стоит, пока платформа готовит рекламу,
    // а звук умолкает, только когда ролик начался (причина 'ad'). Запрос мог и не дойти до показа.
    _paused() {
        if (!Pause.active) return false;
        if (!Pause.reasons) return true;
        for (const reason of Pause.reasons) if (reason !== 'adwait') return true;
        return false;
    },

    // Громкость и приостановка контекста по состоянию.
    _sync() {
        const ctx = this.ctx;
        if (!ctx) return;
        const t = ctx.currentTime;
        this.master.gain.cancelScheduledValues(t);
        this.master.gain.setTargetAtTime(this.muted || this.platformMuted || this.adMuted ? 0 : 1, t, 0.03);
        this.musicGain.gain.setTargetAtTime(this._volume('music'), t, 0.05);
        if (this._paused()) { if (ctx.state === 'running') ctx.suspend().catch(() => {}); }
        else if (ctx.state !== 'running') ctx.resume().catch(() => {});
    },

    _volume(kind) {
        const v = kind === 'music'
            ? (typeof MUSIC_VOLUME !== 'undefined' ? MUSIC_VOLUME : 0.5)
            : (typeof SOUND_VOLUME !== 'undefined' ? SOUND_VOLUME : 0.8);
        return Math.max(0, Math.min(1, Number(v) || 0));
    },

    // Декодер до жеста: OfflineAudioContext не требует разрешения на звук.
    _decodeWith() {
        if (this.ctx) return this.ctx;
        if (!this._decoder) {
            const OAC = window.OfflineAudioContext || /** @type {any} */ (window).webkitOfflineAudioContext;
            try { this._decoder = OAC ? new OAC(1, 1, 44100) : null; } catch (e) { this._decoder = null; }
        }
        return this._decoder;
    },

    // url -> Promise<AudioBuffer | null>: грузится и декодируется раз на страницу.
    // Файла нет или формат не читается — null и предупреждение, игра не падает.
    load(url) {
        let p = this.buffers.get(url);
        if (!p && /^synth:/.test(url)) {
            // Синтез не грузится из сети: буфер кладёт putBuffer. Нет буфера — тишина.
            console.warn('Sound: нет синтезированного буфера ' + url + ' (Sound.putBuffer)');
            p = Promise.resolve(null);
            this.buffers.set(url, p);
        }
        if (!p) {
            const dec = this._decodeWith();
            p = !dec ? Promise.resolve(null) : fetch(url)
                .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
                .then(buf => new Promise((resolve, reject) => dec.decodeAudioData(buf, resolve, reject)))
                .catch(e => { console.warn('Sound: не загрузился ' + url + ' — ' + ((e && e.message) || e)); return null; });
            this.buffers.set(url, p);
        }
        return p;
    },

    // Список вариантов тоже годится: загружаются все (вложенные массивы раскрываются).
    preload(urls) {
        return Promise.all((urls || []).flat().map(u => this.load(u)));
    },

    // --- Варианты ------------------------------------------------------------------
    // pick(список) -> один url: случайный, но не тот же, что при прошлом выборе из ЭТОГО списка (список —
    // по составу, а не по ссылке на массив: Sound.play([...]) с новым литералом при каждом вызове работает так же).
    // Строка вместо списка возвращается как есть; пустой список — ''. Повторы url в списке схлопываются.
    pick(list) {
        if (!Array.isArray(list)) return list;
        const urls = [...new Set(list.flat().filter(u => typeof u === 'string' && u))];
        if (!urls.length) return '';
        if (urls.length === 1) return urls[0];
        const key = urls.join('|');
        const prev = this._lastVariant.get(key);
        const r = Math.min(0.999999, Math.max(0, Number(this.rng()) || 0));
        // из n-1 вариантов (без прошлого): номер среди оставшихся, затем перескок через прошлый
        let i = Math.floor(r * (prev === undefined ? urls.length : urls.length - 1));
        if (prev !== undefined && i >= prev) i++;
        this._lastVariant.set(key, i);
        return urls[i];
    },

    // Разброс для списка вариантов: SOUND_VARIANT_DETUNE (± доля скорости) и SOUND_VARIANT_VOLUME_JITTER (± доля громкости).
    _variantJitter() {
        const num = (v, d) => Math.max(0, Number(v === undefined ? d : v) || 0);
        return {
            detune: num(typeof SOUND_VARIANT_DETUNE !== 'undefined' ? SOUND_VARIANT_DETUNE : undefined, 0.04),
            volume: num(typeof SOUND_VARIANT_VOLUME_JITTER !== 'undefined' ? SOUND_VARIANT_VOLUME_JITTER : undefined, 0.08),
        };
    },

    // Эффект. url — путь или СПИСОК вариантов (см. выше). opts: { volume: 0..1 (× SOUND_VOLUME), rate: скорость
    // (1 — как есть), detune: разброс скорости ±доля (0.05 — живее повторы), volumeJitter: разброс громкости ±доля;
    // у списка вариантов разброс по умолчанию из Constants.js, у одиночного звука — нет }. На паузе, без звука и
    // до первого жеста не играет (вариант при этом не «тратится»). Возвращает { url, stop(), fade(секунды) } или null.
    play(url, opts) {
        const o = opts || {};
        const ctx = this.ctx;
        if (!ctx || this.silent) return null;
        const many = Array.isArray(url);
        if (many) url = this.pick(url);
        if (!url) return null;
        const jit = many ? this._variantJitter() : { detune: 0, volume: 0 };
        const detune = o.detune != null ? o.detune : jit.detune;
        const volJit = o.volumeJitter != null ? o.volumeJitter : jit.volume;
        const handle = {
            url, source: null, gain: null, stopped: false,
            stop() { this.stopped = true; if (this.source) try { this.source.stop(); } catch (e) { /* уже стоит */ } },
            // Плавно убрать за seconds и остановить; ещё не зазвучавший эффект не зазвучит.
            fade(seconds) {
                const s = Math.max(0.01, seconds == null ? 0.3 : seconds);
                if (!this.gain || !this.source) { this.stop(); return; }
                this.stopped = true;
                const g = this.gain.gain, t = ctx.currentTime;
                g.cancelScheduledValues(t);
                g.setValueAtTime(g.value, t);
                g.linearRampToValueAtTime(0, t + s);
                try { this.source.stop(t + s + 0.02); } catch (e) { /* уже стоит */ }
            },
        };
        this.load(url).then(buf => {
            if (!buf || handle.stopped || this.silent) return;
            const src = ctx.createBufferSource();
            src.buffer = buf;
            const rate = (o.rate || 1) * (detune ? 1 + (this.rng() * 2 - 1) * detune : 1);
            src.playbackRate.value = Math.max(0.1, rate);
            const g = ctx.createGain();
            const jv = volJit ? 1 + (this.rng() * 2 - 1) * volJit : 1;
            g.gain.value = this._volume('sfx') * (o.volume == null ? 1 : o.volume) * Math.max(0, jv);
            src.connect(g);
            g.connect(this.master);
            src.start();
            handle.source = src;
            handle.gain = g;
        });
        return handle;
    },

    // --- Свой синтез -------------------------------------------------------------
    // makeBuffer(samples, rate) — моно-буфер из массива/Float32Array отсчётов (-1..1),
    // rate — частота дискретизации (по умолчанию 44100); null, если буфер не собрать.
    // putBuffer(имя, буфер) кладёт его под url 'synth:имя' (префикс можно не писать) и возвращает
    // этот url: дальше Sound.play('synth:имя') и Sound.loop('synth:имя') как с файлом.
    // Работает до первого жеста: буфер годится любому контексту.
    makeBuffer(samples, rate) {
        const dec = this._decodeWith();
        if (!dec || !samples || !samples.length) return null;
        try {
            const buf = dec.createBuffer(1, samples.length, rate || 44100);
            buf.getChannelData(0).set(samples);
            return buf;
        } catch (e) { return null; }
    },

    putBuffer(name, buf) {
        const url = /^synth:/.test(name) ? String(name) : 'synth:' + name;
        this.buffers.set(url, Promise.resolve(buf || null));
        return url;
    },

    // --- Циклы -------------------------------------------------------------------
    // h = Sound.loop(url, { volume: 0..1 (× SOUND_VOLUME), rate }) — звук по кругу (мотор, ветер,
    // шаги). Громкость и скорость меняются плавно: h.set(volume, rate) — null не меняет;
    // h.fade(секунды) убирает и останавливает, h.stop() — сразу. Цикл с нулевой громкостью не
    // запускается, пока её не поднимут. До жеста игрока цикл ждёт и стартует сам; выключенный звук
    // и пауза держат его на месте (контекст стоит), а не сбрасывают. Всегда возвращает handle.
    loop(url, opts) {
        const o = opts || {};
        if (Array.isArray(url)) url = this.pick(url);   // список вариантов: один на весь цикл
        const h = {
            url, volume: o.volume == null ? 1 : o.volume, rate: o.rate || 1,
            source: null, gain: null, started: false, stopped: false,
            set(volume, rate) {
                if (volume != null) this.volume = volume;
                if (rate != null) this.rate = rate;
                Sound._applyLoop(this);
            },
            fade(seconds) { Sound._endLoop(this, seconds == null ? 0.3 : seconds); },
            stop() { Sound._endLoop(this, 0); },
        };
        this._loops.push(h);
        if (h.volume > 0) this.load(url);   // декодируется заранее, пока ждёт жеста
        this._startLoop(h);
        return h;
    },

    _startLoop(h) {
        const ctx = this.ctx;
        if (!ctx || h.started || h.stopped || !(h.volume > 0)) return;
        h.started = true;
        this.load(h.url).then(buf => {
            if (!buf || h.stopped) return;
            const src = ctx.createBufferSource();
            src.buffer = buf; src.loop = true;
            src.playbackRate.value = Math.max(0.1, h.rate);
            const g = ctx.createGain();
            g.gain.value = 0;
            src.connect(g); g.connect(this.master);
            src.start();
            h.source = src; h.gain = g;
            this._applyLoop(h);
        });
    },

    // Плавно привести громкость и скорость цикла к h.volume / h.rate.
    _applyLoop(h) {
        if (!h.started) this._startLoop(h);
        if (!h.gain || !this.ctx || h.stopped) return;
        const t = this.ctx.currentTime;
        h.gain.gain.setTargetAtTime(this._volume('sfx') * Math.max(0, h.volume), t, 0.08);
        if (h.source) h.source.playbackRate.setTargetAtTime(Math.max(0.1, h.rate), t, 0.1);
    },

    // seconds = 0 — остановить сразу, иначе плавно убрать и остановить по часам аудио.
    _endLoop(h, seconds) {
        const i = this._loops.indexOf(h);
        if (i >= 0) this._loops.splice(i, 1);
        if (h.stopped) return;
        h.stopped = true;
        const src = h.source, ctx = this.ctx;
        if (!src || !ctx) return;
        try {
            if (seconds > 0 && h.gain) {
                const g = h.gain.gain, t = ctx.currentTime;
                g.cancelScheduledValues(t);
                g.setValueAtTime(g.value, t);
                g.linearRampToValueAtTime(0, t + seconds);
                src.stop(t + seconds + 0.02);
            } else src.stop();
        } catch (e) { /* уже стоит */ }
    },

    // --- Приглушение музыки -------------------------------------------------------
    // duck(level, fadeIn, hold, fadeOut): музыка (эффекты и циклы не трогает) до level (0..1)
    // за fadeIn с, держать hold с (Infinity — до unduck), вернуть за fadeOut с. Наложение вызовов:
    // глубже из уровней, держится до более позднего конца. На паузе контекст стоит — приглушение
    // тоже. До первого жеста — ничего. Громкость музыки (MUSIC_VOLUME) приглушению не мешает.
    duck(level, fadeIn, hold, fadeOut) {
        const ctx = this.ctx;
        if (!ctx || !this.duckGain) return;
        const t = ctx.currentTime;
        const fi = Math.max(0.01, fadeIn == null ? 0.1 : fadeIn), fo = Math.max(0.01, fadeOut == null ? 0.6 : fadeOut);
        let lv = Math.max(0, Math.min(1, level == null ? 0.3 : level));
        let end = hold === Infinity ? Infinity : t + fi + Math.max(0, Number(hold) || 0);
        const d = this._duck;
        if (d && t < d.end) { lv = Math.min(lv, d.level); end = Math.max(end, d.end); }
        this._duck = { level: lv, end };
        const g = this.duckGain.gain;
        g.cancelScheduledValues(t);
        g.setValueAtTime(g.value, t);
        g.linearRampToValueAtTime(lv, t + fi);
        if (end === Infinity) return;   // держим до unduck
        g.setValueAtTime(lv, end);
        g.linearRampToValueAtTime(1, end + fo);
    },

    // Снять приглушение раньше срока: музыка вернётся за fadeOut с (по умолчанию 0.5).
    unduck(fadeOut) {
        const ctx = this.ctx;
        const was = this._duck;
        this._duck = null;
        if (!ctx || !this.duckGain || !was) return;
        const t = ctx.currentTime, g = this.duckGain.gain;
        g.cancelScheduledValues(t);
        g.setValueAtTime(g.value, t);
        g.linearRampToValueAtTime(1, t + Math.max(0.01, fadeOut == null ? 0.5 : fadeOut));
    },

    // Музыка по кругу; другая дорожка сменяет прежнюю плавно, null — выключить.
    // До первого жеста игрока дорожка ждёт и стартует сама.
    // opts: { volume: 0..1 (× MUSIC_VOLUME), fade: секунды смены }.
    music(url, opts) {
        const o = opts || {};
        const old = this._music;
        if (old ? old.url === url : !url) return;
        this._music = url ? { url, opts: o, source: null, gain: null } : null;
        const fade = o.fade == null ? 0.6 : o.fade;
        if (old) this._stopTrack(old, fade);
        if (url) this.load(url);   // декодируется заранее, пока ждёт жеста
        if (this._music && this.ctx) this._startTrack(this._music, fade);
    },

    stopMusic() { this.music(null); },

    _startTrack(rec, fade) {
        const ctx = this.ctx;
        rec.gain = ctx.createGain();
        rec.gain.gain.value = 0;
        rec.gain.connect(this.musicGain);
        this.load(rec.url).then(buf => {
            if (!buf || this._music !== rec) return;
            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.loop = true;
            src.connect(rec.gain);
            src.start();
            rec.source = src;
            rec.gain.gain.setTargetAtTime(rec.opts.volume == null ? 1 : rec.opts.volume, ctx.currentTime, Math.max(0.01, fade / 3));
        });
    },

    _stopTrack(rec, fade) {
        if (!rec.gain || !this.ctx) return;
        rec.gain.gain.setTargetAtTime(0, this.ctx.currentTime, Math.max(0.01, fade / 3));
        setTimeout(() => { if (rec.source) try { rec.source.stop(); } catch (e) { /* уже стоит */ } }, fade * 1000 + 100);
    },

    // Звук игрока (кнопка в меню) — запоминается.
    setMuted(on) {
        this.muted = !!on;
        Store.set(this._key('muted'), this.muted ? '1' : '0');
        this._sync();
    },

    toggleMuted() { this.setMuted(!this.muted); return this.muted; },

    // Идёт реклама, а игра не на паузе (Platform: rewarded при ADS_REWARDED_PAUSE = 0): только тишина, контекст не
    // останавливается. Снимается по концу ролика (Platform сама, в finally — и при ошибке).
    setAdMuted(on) {
        this.adMuted = !!on;
        this._sync();
    },

    // Платформа выключила звук (Playables: кнопка звука YouTube).
    setPlatformMuted(on) {
        this.platformMuted = !!on;
        // Playables may grant audio focus without an in-game gesture. Try now;
        // browsers with gesture restrictions still use init()'s unlock fallback.
        if (!this.platformMuted && !this.muted) this._ensure();
        this._sync();
        if (!this.platformMuted && this.ctx) this._startPending();
    },
};
