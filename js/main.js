// main.js — точка входа Lory Engine: пауза и звук -> платформа (SDK) -> язык ->
// 3D-мир -> первая карта из Maps.js -> камера -> игра -> цикл кадров.
//
// ИГРА подключается файлом js/Game.js (скрипт перед main.js) с глобалом Game:
//   Game.firstMap()  — необязательно (может вернуть Promise): id карты, с которой начать (мир из сохранения), иначе первая в Maps.js
//   Game.init(app)   — один раз: мир и камера уже есть, карта грузится; меню, HUD, ввод
//   Game.ready()     — карта и init готовы; подготовить меню под экраном загрузки (может вернуть Promise)
//   Game.update(dt)  — каждый кадр до рендера, НЕ зовётся на паузе (Pause.js)
// window.app = { location, camera, maps, map, loadMap(id, { prepare, gameplay, label, cover }),
//   onUpdate(fn), onFrame(fn), platform, sound, pause, lang } — для игры и консоли.
// Карта игры — копия записи GAME_MAPS: правки во время игры не трогают данные.
// Пустой GAME_MAPS — игра без 3D-мира (2D на своём канвасе или DOM): location и
// camera — null, цикл идёт на requestAnimationFrame.

function updateLoadingProgress(percent) {
    LoadingScreen.set(percent);
}

// Экран загрузки уходит, когда карта готова.
function hideLoader() {
    LoadingScreen.hide();
}

function showBootError(text) {
    LoadingScreen.fail(text, () => window.location.reload());
}

// Первая карта: необязательный хук игры Game.firstMap() (может быть async) отдаёт id карты, с которой начать,
// например мир из сохранения. Звать его можно после Platform.init (Platform.load уже работает) и до Game.init:
// app ещё нет. Неизвестный id, ошибка или отказ хука — первая карта списка, загрузка не падает.
/** @template {{ id: string }} T @param {T[]} list @returns {Promise<T>} */
async function pickFirstMap(list) {
    let first = list[0];
    // Game объявляет js/Game.js игры (в чистом движке его нет); хук необязательный — тип any,
    // чтобы игра со строго типизированным Game без firstMap проходила tsc.
    // @ts-ignore
    const game = /** @type {any} */ (typeof Game !== 'undefined' ? Game : null);
    if (game && typeof game.firstMap === 'function') {
        try { const id = await game.firstMap(); first = list.find(m => m.id === id) || first; } catch (e) { console.warn('Game.firstMap:', e); }
    }
    return first;
}

async function startGame() {
    if (window.app) return;                 // защита от повторного запуска
    if (typeof GAME_TITLE !== 'undefined') document.title = GAME_TITLE;
    Pause.init();
    Sound.init();
    // Язык сборки (GAME_LANG) — до первого текста экрана загрузки; язык платформы — ниже, после её SDK.
    Lang.init(null);
    Lang.apply();
    await LoadingScreen.show();
    Platform.firstFrame();                  // экран загрузки уже на экране
    updateLoadingProgress(15);
    await Platform.init();
    Lang.init(Platform.lang);
    Lang.apply();
    updateLoadingProgress(30);

    const maps = typeof GAME_MAPS !== 'undefined' && Array.isArray(GAME_MAPS) ? GAME_MAPS : [];
    const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('world3d'));
    const mode = typeof GAME_MODE !== 'undefined' ? String(GAME_MODE) : '3d';
    const maps2d = typeof GAME_MAPS_2D !== 'undefined' ? GAME_MAPS_2D : [];
    let location = null, camera = null, world2d = null;
    if (mode === '2d') {
        world2d = new World2D(canvas);
        if (maps2d.length) await world2d.loadMap(await pickFirstMap(maps2d));
    } else if (maps.length) {
        if (typeof SimplexNoise === 'undefined') { showBootError('Нет libs/simplex-noise.js'); return; }
        if (!World3D.init(canvas)) { showBootError(Lang.t('no3d')); return; }
        if (typeof Quality !== 'undefined') Quality.init();   // уровень графики по устройству или выбору игрока — до карты (густота декора)
        location = new Location3D({ map: Location3D.copyMap(await pickFirstMap(maps)), batchDecor: true, quality: true, onProgress: (done, total) => LoadingScreen.set(30 + 45 * done / Math.max(1, total)) });
        camera = new CameraController(location.view, {
            terrain: location.terrain,
            bounds: { w: location.width, h: location.height }
        });
        camera.attach(canvas);
    } else if (canvas) {
        canvas.style.display = 'none';
    }

    const updates = [], frames = [];
    const fx = location ? new ParticleFX(location.view.scene) : null;
    /** @type {LoryApp} */
    const app = window.app = {
        location, camera, maps, fx, loading: LoadingScreen, mode, world2d,
        input: world2d ? world2d.input : null,
        get map2d() { return world2d ? world2d.map : null; },
        get map() { return location ? location.map : null; },
        // Сменить карту по id: земля и объекты новой карты, камера — в её центр
        // (или за follow-объектом). Промис — карта готова. options:
        //   prepare  — подготовка уровня под экраном загрузки (повторяемая);
        //   gameplay — после загрузки сообщить платформе о начале раунда;
        //   label    — заголовок экрана загрузки; по умолчанию Lang «Загрузка…» (имя карты
        //              из Maps.js не показывается: оно не переводится);
        //   cover    — false (только 2D): без экрана загрузки, когда всё уже в кэше и карта
        //              меняется между кадрами. Сбой — та же смена под экраном с «Повторить».
        loadMap(id, options = {}) {
            const title = LoadingScreen.caption(options.label);
            if (world2d) {
                const src2d = maps2d.find(m => m.id === id);
                if (!src2d) return Promise.reject(new Error('нет 2D карты ' + id));
                const fill = async (/** @type {(percent: number) => void} */ progress) => {
                    await world2d.loadMap(src2d); progress(80);
                    if (options.prepare) await options.prepare(app);
                    if (!Pause.has('platform')) world2d.render();
                };
                if (options.cover === false) return (async () => {
                    if (LoadingScreen.busy) throw new Error('A loading operation is already active');
                    LoadingScreen.busy = true;
                    let failed = null;
                    try { await fill(() => {}); } catch (error) { failed = error; } finally { LoadingScreen.busy = false; }
                    if (failed) {
                        console.warn('loadMap без экрана загрузки не удался, повтор под экраном:', (failed && failed.message) || failed);
                        return app.loadMap(id, { ...options, cover: true });
                    }
                    if (options.gameplay) Platform.gameplay(true);
                })();
                return LoadingScreen.run(fill, { title, gameplay: !!options.gameplay });
            }
            const src = maps.find(m => m.id === id);
            if (!src || !location) return Promise.reject(new Error('нет карты ' + id));
            return LoadingScreen.run(async progress => {
                if (fx) fx.clear();
                location.opts.onProgress = (done, total) => progress(10 + 65 * done / Math.max(1, total));
                try {
                    const ready = location.loadMap(Location3D.copyMap(src));
                    camera.setTerrain(location.terrain, { w: location.width, h: location.height }); camera.home();
                    await ready; progress(80);
                    if (options.prepare) await options.prepare(app);
                    camera.update(0); progress(92);
                } finally { location.opts.onProgress = null; }
            }, { title, scene: location.view.scene, gameplay: !!options.gameplay });
        },
        onUpdate(fn) { updates.push(fn); },   // каждый кадр вне паузы: fn(dt)
        onFrame(fn) { frames.push(fn); },     // каждый кадр всегда (анимация меню): fn(dt)
        platform: Platform, sound: Sound, pause: Pause, lang: Lang,
    };
    // Game объявляет js/Game.js игры (в чистом движке его нет); хук необязательный — тип any,
    // чтобы игра со строго типизированным Game без firstMap проходила tsc.
    // @ts-ignore
    const game = /** @type {any} */ (typeof Game !== 'undefined' ? Game : null);
    if (typeof Telemetry !== 'undefined') Telemetry.start(app);   // performance_sample для аналитики площадки (Telemetry.js)
    console.log(ENGINE_NAME + ' ' + ENGINE_VERSION + ': ' + (location
        ? 'карта «' + location.map.name + '», объектов ' + location.objects.length
        : world2d ? 'Canvas 2D' : 'без 3D-мира') + ', платформа ' + Platform.name + '.');

    let last = performance.now();
    const frame = () => {
        const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        if (Pause.has('platform')) { if (world2d) world2d.input.clear(); return; }
        if (!Pause.active) {
            if (location) location.update(dt);
            if (game && typeof game.update === 'function') game.update(dt);
            for (const fn of updates) fn(dt);
            if (world2d) world2d.update(dt);
        }
        for (const fn of frames) fn(dt);
        if (fx) fx.update(dt);
        if (camera) camera.update(dt);
        if (location) World3D.renderFrame();   // и на паузе: пропущенный кадр — мусор в канвасе
        if (world2d) { world2d.render(); world2d.input.endFrame(); }
    };
    let raf = 0;
    const loop = () => { raf = 0; if (Pause.has('platform')) return; frame(); raf = requestAnimationFrame(loop); };
    const startLoop = () => { last = performance.now(); if (location) World3D.engine.runRenderLoop(frame); else if (!raf) raf = requestAnimationFrame(loop); };
    Pause.onChange(() => {
        if (Pause.has('platform')) {
            if (location) World3D.engine.stopRenderLoop(frame);
            if (raf) { cancelAnimationFrame(raf); raf = 0; }
        } else { startLoop(); }
    });
    if (location) {
        window.addEventListener('resize', () => World3D.resize());
    }
    if (!Pause.has('platform')) startLoop();
    // Render first, then await asynchronous hooks; shaders can compile behind the cover.
    await Promise.resolve(location ? location.ready : null);
    if (location) location.opts.onProgress = null;
    LoadingScreen.set(80);
    if (game && typeof game.init === 'function') await game.init(app);
    if (game && typeof game.ready === 'function') await game.ready();
    await LoadingScreen.ready(location ? location.view.scene : null);
    hideLoader(); Platform.ready();
}

window.onload = () => { startGame().catch(e => showBootError(String((e && e.message) || e))); };
