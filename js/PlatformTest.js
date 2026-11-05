// PlatformTest.js — адаптер тестовой сборки (build.bat test, GAME_PLATFORM = 'test') для Platform.js (name 'test').
// Подключается ПОСЛЕ Platform.js; регистрирует себя сам (Platform.register). Тестовая сборка открывается двойным
// кликом по index.html (file://) — адреса с ?mockads там не задать, поэтому реклама включена сразу:
//   interstitial  окно «тестовая реклама» на несколько секунд, затем «Закрыть» (так игра ведёт себя после двух раундов);
//   rewarded      окно с отсчётом; после него «Получить награду» -> true, крестик -> false: проверить обе ветки
//                 (награда выдаётся только по кнопке, отказ — без награды).
// Окно рисуется без CSS игры (стили в коде), тексты — Lang (testAd*). Межстраничная: игра и звук на время окна стоят (Pause 'ad');
// с наградой — игра идёт, звук молчит (правило ADS_REWARDED_PAUSE = 0).
// Язык: игрок выбирает сам (Platform.langSwitch / setLanguage — переключатель в настройках игры), пока выбора
// нет — язык браузера (русский или английский). Сохранения — только Store, как у local.

/** @satisfies {Record<string, any>} */
const PlatformTest = {
    languageChoice: true,
    TEST_AD_S: 3,                  // с: длительность тестовой рекламы с наградой (межстраничная — две трети)

    detect: () => typeof GAME_PLATFORM !== 'undefined' && String(GAME_PLATFORM) === 'test',

    init(P) {
        let nav = '';
        try { nav = String(navigator.language || '').toLowerCase(); } catch (e) { nav = ''; }
        P.lang = nav.indexOf('ru') === 0 ? 'ru' : 'en';   // выбор игрока ядро наложит после init
    },

    supports: (kind) => kind === 'interstitial' || kind === 'rewarded',

    interstitial() { return this._ad(false); },
    rewarded() { return this._ad(true); },

    // Окно тестовой рекламы. true — межстраничная закрыта или награда получена; false — отказ крестиком.
    _ad(reward) {
        return new Promise((resolve) => {
            const mk = (tag, css, text) => {
                const el = document.createElement(tag);
                el.style.cssText = css;
                if (text != null) el.textContent = text;
                return el;
            };
            const font = 'font-family:system-ui,sans-serif;';
            const root = mk('div', 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.82);');
            const card = mk('div', 'position:relative;box-sizing:border-box;width:min(420px,88vw);padding:26px 22px 22px;border-radius:10px;background:#1b2733;color:#eef3df;text-align:center;' + font);
            const cross = mk('button', 'position:absolute;top:8px;right:10px;border:0;background:none;color:#9fb3c2;font:20px system-ui,sans-serif;cursor:pointer;padding:6px 10px;', '✕');
            const bar = mk('div', 'height:8px;margin:18px 0 14px;border-radius:4px;background:#34434f;overflow:hidden;');
            const fill = mk('i', 'display:block;height:100%;width:0%;background:#75dbc0;');
            const go = mk('button', 'min-width:200px;padding:12px 24px;border:0;border-radius:6px;color:#10231e;font:700 16px system-ui,sans-serif;cursor:pointer;', '');
            cross.type = 'button';
            go.type = 'button';
            go.disabled = true;
            cross.setAttribute('aria-label', Lang.t('testAdSkip'));
            bar.appendChild(fill);
            card.appendChild(cross);
            card.appendChild(mk('div', 'font:700 12px system-ui,sans-serif;letter-spacing:.12em;color:#75dbc0;', Lang.t('testAdTag')));
            card.appendChild(mk('div', 'margin-top:10px;font:800 22px system-ui,sans-serif;', Lang.t(reward ? 'testAdRewarded' : 'testAdInter')));
            card.appendChild(mk('div', 'margin-top:8px;font:14px system-ui,sans-serif;color:#c8d0d8;', Lang.t(reward ? 'testAdHint' : 'testAdInterHint')));
            card.appendChild(bar);
            card.appendChild(go);
            root.appendChild(card);
            // События окна до игры не доходят (HUD и холст под ним остаются нетронутыми).
            for (const type of ['pointerdown', 'pointerup', 'click', 'touchstart', 'wheel']) root.addEventListener(type, (e) => e.stopPropagation());
            (document.body || document.documentElement).appendChild(root);

            const seconds = Math.max(0.01, this.TEST_AD_S * (reward ? 1 : 0.67));
            const t0 = Date.now();
            let done = false, timer = 0;
            const finish = (value) => {
                if (done) return;
                done = true;
                clearInterval(timer);
                root.remove();
                resolve(value);
            };
            const tick = () => {
                const k = Math.min(1, (Date.now() - t0) / (seconds * 1000));
                fill.style.width = Math.round(k * 100) + '%';
                if (k < 1) {
                    go.textContent = Lang.t('testAdWait', { n: Math.ceil(seconds * (1 - k)) });
                    go.style.background = '#3b4a55';
                    go.style.color = '#c8d0d8';
                    return;
                }
                clearInterval(timer);
                go.disabled = false;
                go.style.background = '#75dbc0';
                go.style.color = '#10231e';
                go.textContent = Lang.t(reward ? 'testAdClaim' : 'testAdClose');
            };
            tick();
            timer = setInterval(tick, 100);
            go.addEventListener('click', () => { if (!go.disabled) finish(true); });
            cross.addEventListener('click', () => finish(!reward));
        });
    },

    // --- Сохранения: только Store ----------------------------------------------------------

    async load(P) { return Store.getJSON(P._storeKey(), null); },
    async save(data, json, obj, P) { return Store.set(P._storeKey(), json); },
};

Platform.register('test', PlatformTest);
