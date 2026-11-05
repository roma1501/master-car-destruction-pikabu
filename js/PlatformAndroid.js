// PlatformAndroid.js — адаптер нативной Android-обёртки (WebView; RuStore и другие магазины) для Platform.js
// (name 'android'). Подключается ПОСЛЕ Platform.js; регистрирует себя сам (Platform.register). Это JS-сторона:
// нативная реклама (межстраничная и с вознаграждением), аппаратная «Назад», пауза от обёртки. Сама обёртка
// (Java/Kotlin, рекламный SDK магазина или сети) — отдельный проект игры; web-SDK у сборки нет:
// build.bat android собирает build/android/ (язык ru) — эту папку обёртка кладёт в assets и отдаёт WebView.
//
// === НАТИВНЫЙ API, который ждёт адаптер ===================================================================
// 1. Java-интерфейс в WebView: webView.addJavascriptInterface(мост, ИМЯ). ИМЯ — PLATFORM_ANDROID_BRIDGE из
//    Constants.js (по умолчанию 'AndroidAds'); есть интерфейс на странице — площадка 'android'. Методы моста
//    (@JavascriptInterface, один String-аргумент — id запроса, вызываются с потока JS: показ рекламы — на UI-потоке):
//      void showInterstitial(String id)       показать межстраничную рекламу
//      void showRewarded(String id)           показать рекламу с наградой
//      boolean supportsAd(String kind)        НЕОБЯЗАТЕЛЬНО: kind 'interstitial' | 'rewarded' — умеет ли обёртка формат
//                                             вообще (не «загружена ли сейчас»); нет метода — считается, что умеет.
//                                             false -> игра прячет предложения «за рекламу» (Platform.rewardedSupported())
// 2. Ответы — вызовом JS на странице (webView.evaluateJavascript), функции ставит адаптер в init():
//      window.__androidAdResult(id, ok)       итог показа с тем же id; ok — ТОЛЬКО литерал true или false.
//                                             Межстраничная: true — показ состоялся. С наградой: true — SDK рекламы
//                                             ПОДТВЕРДИЛ награду (onRewarded); закрыли раньше, ошибка, нет объявления,
//                                             кулдаун — false. Ответ обязателен на каждый id (на onDestroy — false);
//                                             не пришёл за AD_TIMEOUT мс — адаптер считает false и снимает паузу.
//      window.__androidPause(on)              true — обёртка свёрнута или поверх игры нативная реклама, false — снова
//                                             в игре (onPause/onResume, показ рекламы): Pause 'platform'
//      window.__androidBack()                 -> boolean: аппаратная «Назад». true — игра закрыла своё окно сама
//                                             (Platform.backHandler); false — обёртка спросит про выход сама
//    Перед вызовом проверять наличие: window.__androidPause&&window.__androidPause(true).
// 3. Частота рекламы (кулдаун, «не чаще раза в минуту») — дело обёртки: адаптер ответит false, игра пойдёт дальше.
//    Правило двух раундов остаётся у движка (Platform.ads.next); награду по true выдаёт игра один раз.
// Минимальный мост (Java):
//    final class AdsBridge {
//        @JavascriptInterface public void showInterstitial(String id) { runOnUiThread(() -> showInterstitialAd(id)); }
//        @JavascriptInterface public void showRewarded(String id)     { runOnUiThread(() -> showRewardedAd(id)); }
//    }   // итог: evaluateJavascript("window.__androidAdResult&&window.__androidAdResult(" + JSONObject.quote(id) + "," + ok + ")", null)
//    // onBackPressed: evaluateJavascript("window.__androidBack?window.__androidBack():false", r -> if (!"true".equals(r)) окно выхода)
// ==========================================================================================================
//
// Игра: Platform.backHandler = () => { if (окно открыто) { закрыть; return true; } return false; }.
// Сохранения — Store (DOM storage WebView включить: setDomStorageEnabled(true)). Язык — GAME_LANG сборки.

/** @satisfies {Record<string, any>} */
const PlatformAndroid = {
    BRIDGE: 'AndroidAds',      // запасное имя моста, если PLATFORM_ANDROID_BRIDGE не задан
    AD_TIMEOUT: 300000,        // мс: обёртка не прислала итог показа -> false (реклама не должна держать игру на паузе вечно)

    /** @type {Map<string, (ok: boolean) => void>} */
    _pending: new Map(),       // id запроса -> завершение показа
    _seq: 0,

    // Имя Java-интерфейса: PLATFORM_ANDROID_BRIDGE из Constants.js.
    _name() {
        return typeof PLATFORM_ANDROID_BRIDGE !== 'undefined' && PLATFORM_ANDROID_BRIDGE ? String(PLATFORM_ANDROID_BRIDGE) : this.BRIDGE;
    },

    // Объект моста или null (нет обёртки — обычный браузер).
    _native() {
        try {
            const o = /** @type {any} */ (window)[this._name()];
            return o && (typeof o === 'object' || typeof o === 'function') ? o : null;
        } catch (e) { return null; }
    },

    detect() { return !!this._native(); },

    init(P) {
        P.sdk = this._native();
        const w = /** @type {any} */ (window);
        w.__androidAdResult = (id, ok) => {
            const done = this._pending.get(String(id));
            if (done) done(ok === true);
        };
        w.__androidPause = (on) => Pause.set('platform', !!on);
        w.__androidBack = () => P.handleBack();
    },

    supports(kind) {
        const bridge = this._native();
        if (!bridge) return false;
        if (kind !== 'interstitial' && kind !== 'rewarded') return false;
        if (typeof bridge[kind === 'rewarded' ? 'showRewarded' : 'showInterstitial'] !== 'function') return false;
        try { return typeof bridge.supportsAd === 'function' ? !!bridge.supportsAd(kind) : true; } catch (e) { return false; }
    },

    interstitial() { return this._ad('interstitial'); },
    rewarded() { return this._ad('rewarded'); },

    // Показ через мост: true — ТОЛЬКО по ответу обёртки (__androidAdResult с ok === true). Исключение, нет метода,
    // молчание дольше AD_TIMEOUT — false.
    _ad(kind) {
        const bridge = this._native();
        const method = kind === 'rewarded' ? 'showRewarded' : 'showInterstitial';
        if (!bridge || typeof bridge[method] !== 'function') return Promise.resolve(false);
        return new Promise((resolve) => {
            const id = kind + '-' + (++this._seq);
            let timer = 0;
            const finish = (ok) => {
                clearTimeout(timer);
                if (this._pending.get(id) === finish) this._pending.delete(id);
                resolve(ok === true);
            };
            this._pending.set(id, finish);
            timer = setTimeout(() => finish(false), this.AD_TIMEOUT);
            try { bridge[method](id); } catch (e) { finish(false); }
        });
    },

    // Сохранения — Store (localStorage WebView).
    async load(P) { return Store.getJSON(P._storeKey(), null); },
    async save(data, json, obj, P) { return Store.set(P._storeKey(), json); },
};

Platform.register('android', PlatformAndroid);
