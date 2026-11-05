// LoadingScreen — shared cover for boot and map changes. Game-specific art lives in index.html.
/** @satisfies {Record<string, any>} */
const LoadingScreen = {
    busy: false, progress: 0,
    // Два кадра экрана. В скрытой вкладке и фоновом iframe requestAnimationFrame не приходит
    // вовсе — тогда идём дальше по таймеру (LOADING_PAINT_MS): загрузка не должна висеть
    // из-за отсутствия кадров. Приход кадров таймер отменяет.
    paint() {
        return new Promise(resolve => {
            let done = false, timer = 0;
            const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(undefined); };
            timer = setTimeout(finish, typeof LOADING_PAINT_MS !== 'undefined' ? LOADING_PAINT_MS : 1000);
            if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(finish));
        });
    },
    // Заголовок экрана при смене карты: надпись игры (app.loadMap(id, { label })) или «Загрузка…».
    // Имя карты из Maps.js не показываем: оно не проходит через Lang и бывает не на языке игрока.
    caption(label) { return label ? String(label) : Lang.t('loading'); },
    async show(title) {
        this.progress = 0;
        const cover = document.getElementById('loading-screen');
        if (cover) { cover.style.display = 'flex'; cover.setAttribute('aria-busy', 'true'); }
        const heading = document.getElementById('loading-title');
        // Без заголовка — название игры на языке игрока: ключ Lang 'title' (игра описывает его по языкам; запись
        // GAME_TITLES площадки Lang подставляет сам), иначе GAME_TITLE — одна строка на все языки.
        const named = typeof Lang !== 'undefined' && Lang.has && Lang.has('title') ? Lang.t('title') : '';
        if (heading) heading.textContent = title || named || (typeof GAME_TITLE !== 'undefined' ? GAME_TITLE : '');
        const retry = document.getElementById('loading-retry'); if (retry) retry.hidden = true;
        const canvas = document.getElementById('world3d'); if (canvas) canvas.style.visibility = 'hidden';
        Pause.set('loading', true); this.set(0, 'loading');
        await this.paint();
    },
    set(percent, key = 'loading') {
        this.progress = Math.max(this.progress, Math.min(100, Math.max(0, Number(percent) || 0)));
        const bar = /** @type {HTMLElement} */ (document.querySelector('.loading-progress'));
        if (bar) bar.style.width = this.progress + '%';
        const meter = document.getElementById('loading-meter');
        if (meter) meter.setAttribute('aria-valuenow', String(Math.round(this.progress)));
        const value = document.getElementById('loading-percent'); if (value) value.textContent = Math.round(this.progress) + '%';
        const label = document.querySelector('.loading-text'); if (label) label.textContent = Lang.t(key);
    },
    async ready(scene) {
        this.set(95, 'loadingScene');
        let timer;
        try {
            if (scene) await Promise.race([
                scene.whenReadyAsync(true),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Scene readiness timeout')), typeof LOADING_TIMEOUT_MS !== 'undefined' ? LOADING_TIMEOUT_MS : 45000); })
            ]);
        } finally { clearTimeout(timer); }
        // The render loop remains active on pause. Present the complete frame behind the cover.
        const canvas = document.getElementById('world3d'); if (canvas) canvas.style.visibility = 'visible';
        await this.paint(); this.set(100, 'loadingReady'); await this.paint();
    },
    hide() {
        const cover = document.getElementById('loading-screen');
        if (cover) { cover.style.display = 'none'; cover.setAttribute('aria-busy', 'false'); }
        const canvas = document.getElementById('world3d'); if (canvas) canvas.style.visibility = 'visible';
        Pause.set('loading', false);
    },
    fail(error, retry) {
        console.error('Loading:', error);
        const label = document.querySelector('.loading-text'); if (label) label.textContent = Lang.t('loadingFailed');
        const button = document.getElementById('loading-retry');
        if (button) { button.hidden = !retry; button.textContent = Lang.t('loadingRetry'); button.onclick = retry || null; }
        const canvas = document.getElementById('world3d'); if (canvas) canvas.style.visibility = 'hidden';
    },
    async run(task, options = {}) {
        if (this.busy) throw new Error('A loading operation is already active');
        this.busy = true; Platform.gameplay(false);
        try {
            await this.show(options.title);
            const result = await task((value, key) => this.set(value, key));
            await this.ready(options.scene); this.hide();
            if (options.gameplay) Platform.gameplay(true);
            return result;
        } catch (error) {
            this.fail(error, () => { this.run(task, options).catch(() => {}); });
            throw error;
        } finally { this.busy = false; }
    },
};
