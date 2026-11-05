// Lang.js — тексты интерфейса игры (I18N). Все видимые строки — ключами в
// LANG_STRINGS, в коде — Lang.t('ключ', { имя: значение }) с подстановкой {имя},
// в разметке — атрибуты data-t="ключ" (текст), data-t-title, data-t-placeholder
// (Lang.apply() проставляет их после init и смены языка).
//
// Язык — GAME_LANG (Constants.js): сборка ставит ru для Яндекса и en для Playables.
// Видимого переключателя языка нет. LANG_AUTO = 1 — язык платформы (Platform.lang),
// если он есть в словаре. Нет строки в языке — английская, нет и её — сам ключ.
// Новая строка = ключ в ОБОИХ словарях.

const LANG_STRINGS = {
    ru: {
        'loading': 'Загрузка…',
        'loadingScene': 'Готовим первый кадр…',
        'loadingReady': 'Готово',
        'loadingFailed': 'Не удалось загрузить. Попробуйте ещё раз.',
        'loadingRetry': 'Повторить',
        'no3d': '3D недоступен: браузер без WebGL',
        // --- платформа (Pause.js, Platform.js) ---
        'platformPaused': 'Пауза',
        // --- Telegram: предупреждение об ориентации (PlatformTelegram.js) ---
        'orientTitle': 'Поверните устройство',
        'orientHint': 'Игра работает только в горизонтальной ориентации',
        // --- сборка test: тестовое окно рекламы (PlatformTest.js) ---
        'testAdTag': 'ТЕСТОВАЯ РЕКЛАМА',
        'testAdInter': 'Реклама между раундами',
        'testAdInterHint': 'Так игра ведёт себя после двух раундов. Закройте окно, когда будет готово.',
        'testAdRewarded': 'Реклама за награду',
        'testAdHint': 'Дождитесь конца и заберите награду. Крестик — отказ: награды не будет.',
        'testAdWait': 'Подождите: {n} с',
        'testAdClaim': 'Получить награду',
        'testAdClose': 'Закрыть',
        'testAdSkip': 'Закрыть без награды',
        // --- Master Car Destruction: интерфейс (js/GameHud.js) ---
        'stm.levels': 'Трассы', 'stm.garage': 'Гараж', 'stm.track': 'Трасса', 'stm.select': 'Выбрать', 'stm.selected': 'Выбрана',
        'stm.buy': 'Открыть за {n}', 'stm.need': 'Нужно ещё {n}', 'stm.done': 'Пройдена', 'stm.next': 'Дальше', 'stm.go': 'Поехали!',
        'stm.locked': 'Закрыта', 'stm.adPoints': '+{n} за рекламу', 'stm.trackAds': 'Реклама {n} / {total}', 'stm.adWait': 'Реклама через {n} с', 'stm.adNone': 'Реклама недоступна',
        'stm.speed': 'Скорость', 'stm.accel': 'Разгон', 'stm.grip': 'Сцепление', 'stm.air': 'Полёт',
        'stm.carLock': 'Пройди трасс: {n}', 'stm.carFree': 'Доступна', 'stm.carAds': 'Открыть за рекламу: {n} / {total}', 'stm.watch': 'Реклама {n} / {total}', 'stm.carOpen': 'Машина открыта: {name}!', 'stm.place': 'Место', 'stm.kmh': 'км/ч', 'stm.nitro': 'Нитро',
        'stm.cp': 'Чекпоинт {n} из {total}', 'stm.paused': 'Пауза', 'stm.resume': 'Продолжить', 'stm.restart': 'Заново', 'stm.toCp': 'На дорогу',
        'stm.howto': 'Как играть', 'stm.menu': 'Меню', 'stm.sound': 'Звуки', 'stm.music': 'Музыка', 'stm.quality': 'Графика',
        'stm.q.auto': 'Авто', 'stm.q.low': 'Низкая', 'stm.q.medium': 'Средняя', 'stm.q.high': 'Высокая',
        'stm.finished': 'Испытание завершено!', 'stm.rTrack': 'Трасса', 'stm.rStunts': 'Трюки', 'stm.rPlace': 'Место {n}', 'stm.rTotal': 'Итого',
        'stm.nextLevel': 'Следующая', 'stm.toLevels': 'К трассам', 'stm.again': 'Ещё раз', 'stm.close': 'Понятно',
        'stm.diff': 'Сложность', 'stm.bought': 'Трасса открыта!', 'stm.newCar': 'Новая машина в гараже: {name}!',
        'stm.fall': 'Падение!', 'stm.crash': 'Авария!', 'stm.botFinish': '{name} финишировал {n}-м', 'stm.knock': 'Вы протаранили {name}!',
        'stm.air.t': 'Полёт', 'stm.flip': 'Сальто', 'stm.flip2': 'Двойное сальто', 'stm.spin': 'Вертушка', 'stm.landing': 'Чистая посадка', 'stm.drift': 'Дрифт',
        'stm.help.drive': 'Газ / тормоз и задний ход', 'stm.help.steer': 'Руль', 'stm.help.air': 'В полёте: W / S — сальто, A / D — разворот',
        'stm.help.nitro': 'Нитро', 'stm.help.hand': 'Ручник (занос)', 'stm.help.reset': 'Вернуться на дорогу и починиться', 'stm.help.pause': 'Пауза',
        'stm.help.goal': 'Гони по трассе и круши всё на пути: ущерб — это очки. Кузов мягкий: панели отлетают, мотор дымит и горит. Разбил машину — вернись на дорогу и почини. «Заезд» — финишируй раньше соперников, «Свободный разгром» — копи ущерб без финиша.',
        'stm.help.touch': 'Слева — руль, справа — газ, тормоз, ручник и нитро. Свайп по экрану — осмотреться.',
        'stm.tut.gas.t': 'Газ', 'stm.tut.gas.k': 'Жми W или ↑ — машина поедет', 'stm.tut.gas.m': 'Держи кнопку газа справа',
        'stm.tut.steer.t': 'Руль', 'stm.tut.steer.k': 'A / D или ← / → — поворот', 'stm.tut.steer.m': 'Кнопки ← → слева — поворот',
        'stm.tut.nitro.t': 'Нитро', 'stm.tut.nitro.k': 'Shift — ускорение, бак наполняется сам', 'stm.tut.nitro.m': 'Кнопка нитро — ускорение',
        'stm.tut.cp.t': 'Ворота чекпоинта', 'stm.tut.cp.h': 'Проедь через светящиеся ворота: после аварии вернёшься на дорогу сюда',
        'mcd.tut.crash.t': 'Первая авария', 'mcd.tut.crash.k': 'Въедь в отбойник или столб на скорости: кузов сомнётся, детали отлетят, ущерб пойдёт в счёт', 'mcd.tut.crash.m': 'Въедь в отбойник или столб на скорости: кузов сомнётся, детали отлетят, ущерб пойдёт в счёт',
        'stm.tut.air.t': 'Трамплин', 'stm.tut.air.k': 'В полёте W / S наклоняют машину — сделай сальто за очки', 'stm.tut.air.m': 'В полёте газ и тормоз наклоняют машину',
        'stm.loading.level': 'Трасса {n}',
        'stm.gift': 'Подарок', 'stm.wheel': 'Колесо', 'stm.records': 'Рекорды', 'stm.giftTitle': 'Ежедневный <b>подарок</b>', 'stm.wheelTitle': 'Колесо <b>фортуны</b>',
        'stm.noRecords': 'Пока нет лучших игроков', 'stm.login': 'Войдите в аккаунт', 'stm.wait': 'Загрузка…', 'stm.pts': 'очков',
        'stm.carPrize': 'Машина', 'stm.plusCar': '+ машина', 'stm.exclusive': 'Эксклюзив', 'stm.paint': 'Окраска', 'stm.paintFactory': 'Заводская',
        'stm.paintLocked': 'Эксклюзивная окраска — подарок 7-го дня', 'stm.gotPoints': '+{n} очков', 'stm.gotCar': 'Машина «{name}» открыта!',
        'stm.gotPaint': 'Окраска «{name}» уже на машине!', 'stm.win': 'Выигрыш!',
        // журнал испытаний (трассы)
        'mcd.log': 'Журнал испытаний', 'mcd.mode': 'Режим', 'mcd.mode.race': 'Заезд', 'mcd.mode.raceS': 'Заезд', 'mcd.mode.free': 'Свободный разгром', 'mcd.mode.freeS': 'Разгром',
        'mcd.freeHint': 'Без финиша — копи ущерб', 'mcd.km': 'км', 'mcd.trackNo': 'Трасса № {n}', 'mcd.scheme': 'Схема', 'mcd.difficulty': 'Сложность', 'mcd.best': 'Рекорд',
        'mcd.status': 'Допуск', 'mcd.open': 'Открыта',
        'mcd.biome.proving': 'Полигон', 'mcd.biome.alpine': 'Горы', 'mcd.biome.highway': 'Шоссе', 'mcd.biome.city': 'Город', 'mcd.biome.canyon': 'Каньон',
        // гараж-бокс
        'mcd.box': 'Бокс', 'mcd.spec': 'Техпаспорт', 'mcd.floor': 'Краш-тест · бокс', 'mcd.durability': 'Прочность',
        // HUD заезда
        'mcd.position': 'Позиция', 'mcd.progress': 'Трасса', 'mcd.points': 'Очки', 'mcd.damage': 'Повреждения', 'mcd.damageCost': 'Ущерб',
        'mcd.gas': 'Газ', 'mcd.brake': 'Тормоз', 'mcd.hand': 'Ручник',
        'mcd.eng.ok': 'Норма', 'mcd.eng.smoke': 'Дымит', 'mcd.eng.fire': 'Горит!', 'mcd.eng.dead': 'Убит',
        'mcd.repair': 'Вернуться на дорогу и починиться', 'mcd.slowmo': 'Замедленная съёмка', 'mcd.fps': '1000 к/с',
        'mcd.hit.front': 'Лобовой удар', 'mcd.hit.rear': 'Удар в корму', 'mcd.hit.side': 'Боковой удар', 'mcd.hit.roof': 'Удар в крышу', 'mcd.hit.car': 'Таран',
        'mcd.series': 'Серия ×{n}', 'mcd.seriesTotal': 'Итого',
        'mcd.on': 'Вкл', 'mcd.off': 'Выкл', 'mcd.help.crash': 'Сильные удары дают больше ущерба, серия ударов подряд множит счёт',
        // протокол испытания
        'mcd.protocol': 'Протокол испытания', 'mcd.no': '№ {n}', 'mcd.of': 'из {n}', 'mcd.rTime': 'Время', 'mcd.rDamage': 'Ущерб', 'mcd.rLost': 'Деталей потеряно',
        'mcd.rPeak': 'Рекордный удар', 'mcd.rPlaceBonus': 'За место', 'mcd.rTotal': 'Итого очков',
        'mcd.stamp.pass': 'Испытание пройдено', 'mcd.stamp.wreck': 'Машина разбита', 'mcd.stamp.free': 'Разгром завершён', 'mcd.stamp.place': 'Зачёт: {n} место',
    },
    en: {
        'loading': 'Loading…',
        'loadingScene': 'Preparing the first frame…',
        'loadingReady': 'Ready',
        'loadingFailed': 'Loading failed. Please try again.',
        'loadingRetry': 'Retry',
        'no3d': '3D is unavailable: no WebGL in this browser',
        // --- platform (Pause.js, Platform.js) ---
        'platformPaused': 'Paused',
        // --- Telegram: orientation warning (PlatformTelegram.js) ---
        'orientTitle': 'Rotate your device',
        'orientHint': 'The game only works in landscape mode',
        // --- test build: test ad window (PlatformTest.js) ---
        'testAdTag': 'TEST AD',
        'testAdInter': 'Interstitial ad',
        'testAdInterHint': 'This is what the game does after two rounds. Close the window when ready.',
        'testAdRewarded': 'Rewarded ad',
        'testAdHint': 'Wait for the end and claim the reward. The cross declines: no reward.',
        'testAdWait': 'Wait: {n} s',
        'testAdClaim': 'Claim reward',
        'testAdClose': 'Close',
        'testAdSkip': 'Close without reward',
        // --- Master Car Destruction: interface (js/GameHud.js) ---
        'stm.levels': 'Tracks', 'stm.garage': 'Garage', 'stm.track': 'Track', 'stm.select': 'Select', 'stm.selected': 'Selected',
        'stm.buy': 'Unlock for {n}', 'stm.need': '{n} more needed', 'stm.done': 'Cleared', 'stm.next': 'Next', 'stm.go': 'Let’s go!',
        'stm.locked': 'Locked', 'stm.adPoints': '+{n} for an ad', 'stm.trackAds': 'Ad {n} / {total}', 'stm.adWait': 'Ad in {n} s', 'stm.adNone': 'Ad unavailable',
        'stm.speed': 'Speed', 'stm.accel': 'Acceleration', 'stm.grip': 'Grip', 'stm.air': 'Air control',
        'stm.carLock': 'Clear tracks: {n}', 'stm.carFree': 'Available', 'stm.carAds': 'Unlock with ads: {n} / {total}', 'stm.watch': 'Watch ad {n} / {total}', 'stm.carOpen': 'Car unlocked: {name}!', 'stm.place': 'Place', 'stm.kmh': 'km/h', 'stm.nitro': 'Nitro',
        'stm.cp': 'Checkpoint {n} of {total}', 'stm.paused': 'Paused', 'stm.resume': 'Resume', 'stm.restart': 'Restart', 'stm.toCp': 'To the road',
        'stm.howto': 'How to play', 'stm.menu': 'Menu', 'stm.sound': 'Sounds', 'stm.music': 'Music', 'stm.quality': 'Graphics',
        'stm.q.auto': 'Auto', 'stm.q.low': 'Low', 'stm.q.medium': 'Medium', 'stm.q.high': 'High',
        'stm.finished': 'Test complete!', 'stm.rTrack': 'Track', 'stm.rStunts': 'Stunts', 'stm.rPlace': 'Place {n}', 'stm.rTotal': 'Total',
        'stm.nextLevel': 'Next track', 'stm.toLevels': 'Tracks', 'stm.again': 'Again', 'stm.close': 'Got it',
        'stm.diff': 'Difficulty', 'stm.bought': 'Track unlocked!', 'stm.newCar': 'New car in the garage: {name}!',
        'stm.fall': 'Fell off!', 'stm.crash': 'Crashed!', 'stm.botFinish': '{name} finished #{n}', 'stm.knock': 'You rammed {name}!',
        'stm.air.t': 'Airtime', 'stm.flip': 'Flip', 'stm.flip2': 'Double flip', 'stm.spin': 'Spin', 'stm.landing': 'Clean landing', 'stm.drift': 'Drift',
        'stm.help.drive': 'Gas / brake and reverse', 'stm.help.steer': 'Steer', 'stm.help.air': 'In the air: W / S — flip, A / D — turn',
        'stm.help.nitro': 'Nitro', 'stm.help.hand': 'Handbrake (drift)', 'stm.help.reset': 'Back on the road and repair', 'stm.help.pause': 'Pause',
        'stm.help.goal': 'Race the track and smash everything in your way: damage is score. The body is soft — panels fly off, the engine smokes and burns. Wrecked? Get back on the road and repair. “Race”: finish before your rivals; “Free smash”: no finish, just stack up damage.',
        'stm.help.touch': 'Left side — steering, right side — gas, brake, handbrake and nitro. Swipe the screen to look around.',
        'stm.tut.gas.t': 'Gas', 'stm.tut.gas.k': 'Press W or ↑ to drive', 'stm.tut.gas.m': 'Hold the gas button on the right',
        'stm.tut.steer.t': 'Steering', 'stm.tut.steer.k': 'A / D or ← / → to turn', 'stm.tut.steer.m': 'Use ← → on the left to turn',
        'stm.tut.nitro.t': 'Nitro', 'stm.tut.nitro.k': 'Shift — boost, the tank refills by itself', 'stm.tut.nitro.m': 'Nitro button — boost',
        'stm.tut.cp.t': 'Checkpoint gate', 'stm.tut.cp.h': 'Drive through the glowing gate: after a wreck you return to the road here',
        'mcd.tut.crash.t': 'First crash', 'mcd.tut.crash.k': 'Hit a guardrail or a pole at speed: the body crumples, parts fly off and the damage counts as score', 'mcd.tut.crash.m': 'Hit a guardrail or a pole at speed: the body crumples, parts fly off and the damage counts as score',
        'stm.tut.air.t': 'Ramp', 'stm.tut.air.k': 'In the air W / S tilt the car — flip it for points', 'stm.tut.air.m': 'In the air gas and brake tilt the car',
        'stm.loading.level': 'Track {n}',
        'stm.gift': 'Gift', 'stm.wheel': 'Wheel', 'stm.records': 'Leaderboard', 'stm.giftTitle': 'Daily <b>gift</b>', 'stm.wheelTitle': 'Wheel of <b>fortune</b>',
        'stm.noRecords': 'No top players yet', 'stm.login': 'Sign in', 'stm.wait': 'Loading…', 'stm.pts': 'points',
        'stm.carPrize': 'Car', 'stm.plusCar': '+ car', 'stm.exclusive': 'Exclusive', 'stm.paint': 'Paint', 'stm.paintFactory': 'Factory',
        'stm.paintLocked': 'Exclusive paint — the day 7 gift', 'stm.gotPoints': '+{n} points', 'stm.gotCar': 'Car “{name}” unlocked!',
        'stm.gotPaint': 'Paint “{name}” is on your car!', 'stm.win': 'You won!',
        // test log (tracks)
        'mcd.log': 'Test log', 'mcd.mode': 'Mode', 'mcd.mode.race': 'Race', 'mcd.mode.raceS': 'Race', 'mcd.mode.free': 'Free smash', 'mcd.mode.freeS': 'Smash',
        'mcd.freeHint': 'No finish — stack up damage', 'mcd.km': 'km', 'mcd.trackNo': 'Track #{n}', 'mcd.scheme': 'Layout', 'mcd.difficulty': 'Difficulty', 'mcd.best': 'Record',
        'mcd.status': 'Clearance', 'mcd.open': 'Open',
        'mcd.biome.proving': 'Proving ground', 'mcd.biome.alpine': 'Alpine', 'mcd.biome.highway': 'Highway', 'mcd.biome.city': 'City', 'mcd.biome.canyon': 'Canyon',
        // garage bay
        'mcd.box': 'Bay', 'mcd.spec': 'Spec plate', 'mcd.floor': 'Crash test · bay', 'mcd.durability': 'Durability',
        // race HUD
        'mcd.position': 'Position', 'mcd.progress': 'Track', 'mcd.points': 'Score', 'mcd.damage': 'Damage', 'mcd.damageCost': 'Damage',
        'mcd.gas': 'Gas', 'mcd.brake': 'Brake', 'mcd.hand': 'Hand',
        'mcd.eng.ok': 'OK', 'mcd.eng.smoke': 'Smoking', 'mcd.eng.fire': 'On fire!', 'mcd.eng.dead': 'Dead',
        'mcd.repair': 'Back on the road and repair', 'mcd.slowmo': 'Slow motion', 'mcd.fps': '1000 fps',
        'mcd.hit.front': 'Head-on hit', 'mcd.hit.rear': 'Rear hit', 'mcd.hit.side': 'Side hit', 'mcd.hit.roof': 'Roof hit', 'mcd.hit.car': 'Ram',
        'mcd.series': 'Chain ×{n}', 'mcd.seriesTotal': 'Total',
        'mcd.on': 'On', 'mcd.off': 'Off', 'mcd.help.crash': 'Harder hits cause more damage, back-to-back hits multiply the score',
        // test report
        'mcd.protocol': 'Test report', 'mcd.no': 'No. {n}', 'mcd.of': 'of {n}', 'mcd.rTime': 'Time', 'mcd.rDamage': 'Damage', 'mcd.rLost': 'Parts lost',
        'mcd.rPeak': 'Biggest hit', 'mcd.rPlaceBonus': 'Place bonus', 'mcd.rTotal': 'Total score',
        'mcd.stamp.pass': 'Test passed', 'mcd.stamp.wreck': 'Car wrecked', 'mcd.stamp.free': 'Smash complete', 'mcd.stamp.place': 'Ranked: place {n}',
    },
};

/** @satisfies {Record<string, any>} */
const Lang = {
    code: 'ru',

    // platformLang — язык платформы (Platform.lang) или null.
    init(platformLang) {
        const def = typeof GAME_LANG !== 'undefined' ? GAME_LANG : 'ru';
        const auto = typeof LANG_AUTO !== 'undefined' ? LANG_AUTO : 0;
        const p = String(platformLang || '').toLowerCase().split(/[-_]/)[0];
        this.code = auto > 0 && p && LANG_STRINGS[p] ? p : (LANG_STRINGS[def] ? def : 'en');
        document.documentElement.lang = this.code;
    },

    has(key) {
        return !!((LANG_STRINGS[this.code] || {})[key] || LANG_STRINGS.en[key]);
    },

    t(key, params) {
        const s = (LANG_STRINGS[this.code] || {})[key] || LANG_STRINGS.en[key] || key;
        return params ? s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)) : s;
    },

    // Разметка: data-t, data-t-title, data-t-placeholder внутри root.
    apply(root) {
        const r = root || document;
        for (const el of /** @type {NodeListOf<HTMLElement>} */ (r.querySelectorAll('[data-t]'))) el.textContent = this.t(el.dataset.t);
        for (const el of /** @type {NodeListOf<HTMLElement>} */ (r.querySelectorAll('[data-t-title]'))) el.title = this.t(el.dataset.tTitle);
        for (const el of /** @type {NodeListOf<HTMLInputElement>} */ (r.querySelectorAll('[data-t-placeholder]'))) el.placeholder = this.t(el.dataset.tPlaceholder);
    },
};

// --- 1.40: название игры по площадке (отдельный блок: сливать как есть) ---
// GAME_TITLES (Constants.js) = { <сборка>: 'Название' | { ru, en } }. Сборка кладёт запись своей площадки в GAME_TITLE,
// <title> и ключ 'title' статических текстов; здесь тот же ключ получает рантайм: запись для GAME_PLATFORM перекрывает
// 'title' словаря на всех языках (иначе название из Lang.t('title') расходилось бы с <title>). Нет записи — ключ как у игры.
(() => {
    const table = typeof GAME_TITLES !== 'undefined' && GAME_TITLES && typeof GAME_TITLES === 'object' ? GAME_TITLES : null;
    const value = table && typeof GAME_PLATFORM !== 'undefined' ? table[GAME_PLATFORM] : null;
    if (!value) return;
    const text = (s) => (typeof s === 'string' ? s.trim() : '');
    const first = typeof value === 'string' ? text(value) : [value.en].concat(Object.values(value)).map(text).find(Boolean);
    const dict = /** @type {Record<string, Record<string, string>>} */ (LANG_STRINGS);
    for (const code of Object.keys(dict)) {
        const title = typeof value === 'string' ? first : (text(value[code]) || first);
        if (title) dict[code].title = title;
    }
})();
