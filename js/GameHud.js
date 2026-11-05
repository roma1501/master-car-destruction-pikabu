// GameHud.js — интерфейс Master Car Destruction (DOM поверх #world3d). Образ: лаборатория краш-тестов — жёлто-чёрные мишени
// краш-теста (знак-четвертинка), разметка и трафарет, листы протокола испытаний, светодиодные индикаторы стенда, следы масла
// и сажи. Шрифт Rubik (assets/fonts/rubik-mcd.woff, OFL), все значки — SVG кодом, внешних ресурсов нет.
//
// Экраны: «журнал испытаний» (список трасс + лист выбранной трассы с контуром, режимы «заезд» / «свободный разгром»),
// гараж-бокс (подиум по центру, табличка характеристик с прочностью), HUD заезда (позиция, прогресс-лента, ущерб $,
// очки, спидометр со светодиодами, нитро, панель повреждений, всплывающий счёт удара, замедленная съёмка, кнопка «починиться»),
// экранные кнопки для телефона (Input.setVirtual), пауза, «протокол испытания» (результат со штампом), «Как играть»,
// подарок дня, колесо фортуны, рекорды. Тексты — Lang (ключи stm.* и mcd.* в js/Lang.js). Логики игры здесь нет:
// кнопки зовут обработчики Game (GameHud.init(handlers)).
//
// Контракт для Game.js (новое): setDamage, crash, slowmo, setDamageValue, setRepair, setMode, renderLevels(model с path/biome/mode),
// results(data с damage/peak/lost/wrecked/mode/time). Подробности — JSDoc у методов.

// --- числа настройки ---------------------------------------------------------------------------------------------
const MCD_SPEED_MAX = 260;            // км/ч, при которых светодиодная дуга спидометра полная
const MCD_SPEED_LEDS = 24;            // сегментов дуги скорости
const MCD_SPEED_RED = 4;              // последние сегменты дуги — красная зона
const MCD_NITRO_LEDS = 12;            // сегментов шкалы нитро
const MCD_DMG_LEDS = 10;              // сегментов общей шкалы повреждений
const MCD_ZONE_STEPS = 48;            // шаги цвета зоны (меньше шаг — не перекрашиваем)
const MCD_ZONE_JUMP = 0.05;           // скачок зоны, при котором она вспыхивает, а панель вздрагивает
const MCD_SHAKE_GAP_MS = 140;         // не чаще одной тряски панели за столько мс
const MCD_WHEEL_LOST = 0.98;          // колесо потеряно с этого значения
const MCD_SERIES_MS = 1900;           // удары чаще этого интервала складываются в серию
const MCD_CRASH_HOLD_MS = 1450;       // сколько держится плашка удара (плюс сила)
const MCD_CRASH_MIN_SCALE = 0.72;     // размер плашки при power 0
const MCD_CRASH_MAX_SCALE = 1.28;     // и при power 1
const MCD_POP_MAX = 3;                // сколько лент трюков видно сразу
const MCD_POP_MS = 1500;
const MCD_STAMP_MS = 1150;            // через сколько штамп ложится на протокол
const MCD_ROW_MS = 150;               // шаг печати строк протокола
const MCD_COUNT_UP_MS = 650;          // счёт цифр в протоколе
const MCD_SLOWMO_BAR = 0.075;         // высота чёрных полос кадра в долях высоты
const MCD_BIOMES = {
    proving: { c: '#ffc400', ic: 'proving' }, alpine: { c: '#8fd3f4', ic: 'alpine' }, highway: { c: '#4fcf7a', ic: 'highway' },
    city: { c: '#c68cff', ic: 'city' }, canyon: { c: '#ee7a3c', ic: 'canyon' },
};

// Тексты движковых модулей (Shop / DailyGift / Wheel): в игре «очки» и «машины», а не «монеты» — переопределяют заготовки модулей.
// Остальные ключи интерфейса (stm.*, mcd.*) — в js/Lang.js.
Object.assign(LANG_STRINGS.ru, {
    'reward.coins': 'Очки: {n}', 'reward.item': 'Машина: {name}', 'reward.randomItem': 'Случайная машина', 'reward.randomItems': 'Случайные машины: {n}',
    'reward.exclusive': 'Окраска «{name}»', 'reward.big': 'Крупная награда: {n} очков', 'reward.dup': 'Уже есть — очки: {n}',
    'daily.noX2': 'Эксклюзивная окраска выдаётся один раз, без удвоения', 'daily.exclusive': 'Эксклюзивная окраска', 'daily.exclusiveHint': 'Только в подарке 7-го дня',
    'wheel.ad': 'За рекламу: ещё вращение ({a} из {b})',
});
Object.assign(LANG_STRINGS.en, {
    'reward.coins': 'Points: {n}', 'reward.item': 'Car: {name}', 'reward.randomItem': 'Random car', 'reward.randomItems': 'Random cars: {n}',
    'reward.exclusive': 'Paint “{name}”', 'reward.big': 'Big reward: {n} points', 'reward.dup': 'Already owned — points: {n}',
    'daily.noX2': 'The exclusive paint is given once, no doubling', 'daily.exclusive': 'Exclusive paint', 'daily.exclusiveHint': 'Only as the day 7 gift',
    'wheel.ad': 'Watch ad: one more spin ({a} of {b})',
});

/** Стиль краш-теста: мишень-четвертинка, значки меню, кнопки экрана. Все рисуются кодом, цвет — currentColor. */
const MCD_ICONS = {
    /** Мишень краш-теста: чёрный круг, две жёлтые четвертинки по диагонали, жёлтое кольцо. */
    roundel: '<svg class="rd" viewBox="-12 -12 24 24"><circle r="11" fill="#14120d"/><path d="M0 0V-11A11 11 0 0 1 11 0ZM0 0V11A11 11 0 0 1-11 0Z" fill="#ffc400"/><circle r="10.4" fill="none" stroke="#ffc400" stroke-width="1.4"/><circle r="1.6" fill="#14120d"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M10.3 2h3.4l.5 2.6 1.9.8 2.2-1.5 2.4 2.4-1.5 2.2.8 1.9 2.6.5v3.4l-2.6.5-.8 1.9 1.5 2.2-2.4 2.4-2.2-1.5-1.9.8-.5 2.6h-3.4l-.5-2.6-1.9-.8-2.2 1.5-2.4-2.4 1.5-2.2-.8-1.9L2 13.7v-3.4l2.6-.5.8-1.9-1.5-2.2 2.4-2.4 2.2 1.5 1.9-.8z"/><circle cx="12" cy="12" r="3.2"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="5.5" y="4.5" width="4.5" height="15"/><rect x="14" y="4.5" width="4.5" height="15"/></svg>',
    wrench: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
    undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"><path d="M3 4v6h6"/><path d="M3.5 15a9 9 0 1 0 2.1-9.4L3 10"/></svg>',
    left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4.2" stroke-linejoin="miter" stroke-linecap="butt"><path d="M14 4l-8 8 8 8"/><path d="M21 4l-8 8 8 8" opacity=".55"/></svg>',
    right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4.2" stroke-linejoin="miter" stroke-linecap="butt"><path d="M10 4l8 8-8 8"/><path d="M3 4l8 8-8 8" opacity=".55"/></svg>',
    chevL: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="miter"><path d="M15 3L6 12l9 9"/></svg>',
    chevR: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="miter"><path d="M9 3l9 9-9 9"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linejoin="miter"><path d="M15 4L7 12l8 8"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4"><path d="M5 5l14 14M19 5L5 19"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linejoin="miter"><path d="M3.5 12.5l5.5 5.5L20.5 6"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="miter"><rect x="5" y="11" width="14" height="10" fill="currentColor" fill-opacity=".25"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 3.5l15 8.5-15 8.5z"/></svg>',
    go: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linejoin="miter"><path d="M4 4l8 8-8 8M12 4l8 8-8 8"/></svg>',
    /** Гайка — валюта «очки». */
    nut: '<svg viewBox="0 0 24 24"><path d="M12 1.8l8.8 5.1v10.2L12 22.2l-8.8-5.1V6.9z" fill="currentColor"/><circle cx="12" cy="12" r="4.2" fill="#14120d"/><path d="M12 1.8l8.8 5.1v10.2" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="1.2"/></svg>',
    gift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="miter"><rect x="3" y="8.5" width="18" height="4.5" fill="currentColor" fill-opacity=".3"/><rect x="4.5" y="13" width="15" height="8.5"/><path d="M12 8.5v13M12 8.5C8.5 8.5 6.5 5 8.5 3.8s3.5 4.7 3.5 4.7 1.5-5.9 3.5-4.7-1 4.7-3.5 4.7z"/></svg>',
    wheel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="13" r="8.6"/><circle cx="12" cy="13" r="2" fill="currentColor"/><path d="M12 4.4v17.2M3.4 13h17.2M6 7l12 12M18 7L6 19" stroke-width="1.6"/><path d="M9.5 1.5h5L12 6z" fill="currentColor" stroke="none"/></svg>',
    podium: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="9" y="9" width="6" height="12.5"/><rect x="2" y="13" width="6" height="8.5" opacity=".7"/><rect x="16" y="16" width="6" height="5.5" opacity=".5"/><path d="M12 2.2l1.2 2.6 2.8.3-2.1 1.9.6 2.8L12 8.4 9.5 9.8l.6-2.8L8 5.1l2.8-.3z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="13" r="8"/><path d="M12 8.5V13l3 2M9.5 2.5h5"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="miter"><path d="M12 2.5l8 3v6c0 5-3.4 8.8-8 10.5-4.6-1.7-8-5.5-8-10.5v-6z" fill="currentColor" fill-opacity=".22"/></svg>',
    burst: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 1.5l2.3 6.4 6.2-2.6-2.7 6.2 5.7 3.3-6.5.8 1.4 6.5-5.1-4.2-4.6 4.5.2-6.6-6.3-1.2 5.6-3.4-2.3-6.2 6.1 2.3z"/></svg>',
    flag: (px) => { let s = '<svg viewBox="0 0 24 24"><path d="M4.5 2v21" stroke="currentColor" stroke-width="2.4" fill="none"/>'; for (let j = 0; j < 4; j++) for (let i = 0; i < 5; i++) if ((i + j) % 2 === 0) s += `<rect x="${6 + i * 3.4}" y="${3 + j * 3.4}" width="3.4" height="3.4" fill="currentColor"/>`; return s + '<rect x="6" y="3" width="17" height="13.6" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>'; },
    gas: '<svg viewBox="0 0 24 24"><path d="M7.5 2.5h9l1.8 16.5a2.2 2.2 0 0 1-2.2 2.5H7.9a2.2 2.2 0 0 1-2.2-2.5z" fill="currentColor"/><path d="M8.5 7h7M8.2 10.5h7.6M7.9 14h8.2" stroke="#14120d" stroke-width="1.7"/></svg>',
    brake: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="2.2" fill="currentColor"/><path d="M6.5 9.5h11M6.5 12h11M6.5 14.5h11" stroke="#14120d" stroke-width="1.5"/></svg>',
    nitro: '<svg viewBox="0 0 24 24"><path d="M12.6 1.5c.9 4.4 6.9 6.6 6.9 13.1a7.5 7.5 0 0 1-15 0c0-3.4 2-5 3.6-7.9.9 1.2 1.4 2.4 1.5 3.7 1.7-2.1 3-5 3-8.9z" fill="currentColor"/><path d="M12 22a3.6 3.6 0 0 1-3.6-3.6c0-2 1.7-3 3.6-5.4 1.9 2.4 3.6 3.4 3.6 5.4A3.6 3.6 0 0 1 12 22z" fill="#14120d"/></svg>',
    hand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="5.6"/><path d="M12 9v3.6M12 15.2v.1M4.6 7.2a8.6 8.6 0 0 0 0 9.6M19.4 7.2a8.6 8.6 0 0 1 0 9.6"/></svg>',
    wrenchBig: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" fill="currentColor" fill-opacity=".2"/></svg>',
    engine: '<svg viewBox="0 0 40 34" class="en"><g fill="currentColor"><rect x="9" y="12" width="21" height="16" rx="2"/><rect x="13" y="7" width="12" height="5"/><rect x="3" y="16" width="6" height="7"/><rect x="30" y="14" width="6" height="11"/><rect x="15" y="3" width="3" height="4"/><rect x="21" y="3" width="3" height="4"/></g><path d="M13 18h13M13 22h13" stroke="#14120d" stroke-width="1.6"/></svg>',
    // пиктограммы биомов: полигон, горы, шоссе, город, каньон
    proving: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.4" fill="currentColor"/><path d="M12 1.5v5M12 17.5v5M1.5 12h5M17.5 12h5"/></svg>',
    alpine: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M1.5 20.5L9 6l4.2 7.4L15.6 10l7 10.5z"/><path d="M9 6l2.3 4.1-1.5-.8-1.4 1.2-1-1.6z" fill="#14120d" opacity=".45"/></svg>',
    highway: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.5 3h7l5 18h-17z" opacity=".95"/><path d="M12 5.2v3M12 11v3.4M12 17v3.4" stroke="#14120d" stroke-width="1.8"/></svg>',
    city: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M2 21.5V11h5V21.5zM8 21.5V4h7v17.5zM16 21.5V9h6v12.5z"/><path d="M10 7h3M10 10.4h3M10 13.8h3M10 17.2h3M18 12.4h2M18 15.8h2" stroke="#14120d" stroke-width="1.5"/></svg>',
    canyon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M1.5 21.5V13l3.6 0V8.5h4.6V12l3 0V5.8h5V11l3.8 0v10.5z"/><path d="M6 17h3M14 14.5h4" stroke="#14120d" stroke-width="1.5"/></svg>',
    /** Машина сбоку (приз подарка и колеса); color — кузов. */
    car: (color) => `<svg viewBox="0 0 64 36"><path d="M3 26l3.5-8.5c1-2.3 3-3.5 5.5-3.5h8.5l6.5-7.5h17c2.2 0 4 .9 5.2 2.7L55 14c4 .6 6.2 2.4 6.7 6l.3 6z" fill="${color || '#ffc400'}" stroke="#14120d" stroke-width="2" stroke-linejoin="round"/>`
        + '<path d="M26 7.5h13.8l3.4 6.5H22z" fill="#14120d" opacity=".78"/><circle cx="17" cy="27" r="6.2" fill="#14120d" stroke="#ebe5d1" stroke-width="2"/><circle cx="48" cy="27" r="6.2" fill="#14120d" stroke="#ebe5d1" stroke-width="2"/><circle cx="17" cy="27" r="2" fill="#ebe5d1"/><circle cx="48" cy="27" r="2" fill="#ebe5d1"/></svg>',
    /** Указатель колеса фортуны. */
    pointer: '<svg class="ptr" viewBox="0 0 34 44"><path d="M3 3h28L17 40z" fill="#ffc400" stroke="#14120d" stroke-width="3" stroke-linejoin="round"/><circle cx="17" cy="12.5" r="4.4" fill="#14120d"/></svg>',
};

const MCD_CSS = String.raw`
@font-face{font-family:'Rubik MCD';font-weight:500 900;font-style:normal;font-display:swap;src:url('assets/fonts/rubik-mcd.woff') format('woff')}
:root{--stm-font:'Rubik MCD','Arial Narrow',Arial,sans-serif;--tut-bg:#14120d;--tut-fg:#f1ebd6;--tut-accent:#ffc400;--tut-border:#ffc400;--tut-radius:3px;--tut-font:var(--stm-font);--tut-accent-bg:rgba(255,196,0,.16)}
.lory-tut .lory-tut-card{box-shadow:0 5px 0 #000;border-width:3px;text-transform:none}
.lory-tut .lory-tut-title{text-transform:uppercase;letter-spacing:.05em}
.lory-tut .lory-tut-skip{border-radius:3px;text-transform:uppercase;letter-spacing:.06em}
.lory-tut-card:not([data-hl]){top:calc(var(--mcd-top,0px) + max(env(safe-area-inset-top,0px),8px))!important}
#stm{position:fixed;inset:0;pointer-events:none;z-index:20;font-family:var(--stm-font);color:var(--pa);user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;font-weight:600;
  --y:#ffc400;--y2:#d99e00;--y3:#8a6500;--k0:#0c0b08;--k1:#14120d;--k2:#1d1a13;--k3:#2a261b;--k4:#3d3827;--pa:#ece6d2;--pa2:#d9d2b9;--pa3:#b7ae92;--ink:#17140d;
  --red:#e5392d;--red2:#a3231a;--org:#ff7a1a;--grn:#55d476;--cy:#59d2ff;--mut:#a79f85;--pmut:#6d664d;
  --hz:repeating-linear-gradient(-45deg,var(--y) 0 9px,var(--k0) 9px 18px);--hzs:repeating-linear-gradient(-45deg,var(--y) 0 5px,var(--k0) 5px 10px);
  --grain:linear-gradient(transparent,transparent);--oil:linear-gradient(transparent,transparent);
  --s:1;--m:calc(var(--s)*12px);--sl:max(var(--lory-safe-left,0px),env(safe-area-inset-left,0px));--sr:max(var(--lory-safe-right,0px),env(safe-area-inset-right,0px));--st:max(var(--lory-safe-top,0px),env(safe-area-inset-top,0px));--sb:max(var(--lory-safe-bottom,0px),env(safe-area-inset-bottom,0px));
  --f0:max(9px,calc(var(--s)*10px));--f1:max(10px,calc(var(--s)*12px));--f2:max(11px,calc(var(--s)*14px));--f3:max(12px,calc(var(--s)*17px));--f4:max(14px,calc(var(--s)*22px));--f5:calc(var(--s)*30px);--f6:calc(var(--s)*44px);--f7:calc(var(--s)*64px);--f8:calc(var(--s)*96px);
  --topH:calc(var(--s)*54px);--barH:calc(var(--s)*66px);--pad:max(54px,calc(var(--s)*74px));--gap:calc(var(--s)*8px);--btn:max(40px,calc(var(--s)*46px))}
#stm *{box-sizing:border-box}
#stm svg{display:block}
#stm .scr{position:absolute;inset:0;display:none}
#stm .scr.on{display:block}
#stm button{font-family:inherit;color:inherit;border:0;background:none;cursor:pointer;pointer-events:auto;-webkit-tap-highlight-color:transparent;touch-action:manipulation;padding:0;margin:0}
#stm button[disabled]{cursor:default}
#stm b,#stm h1,#stm h2{font-weight:900}
#stm h1,#stm h2,#stm p{margin:0}
#stm small{font-size:var(--f1);font-weight:700;letter-spacing:.14em;text-transform:uppercase}
#stm [hidden]{display:none!important}
#stm .num{font-variant-numeric:tabular-nums;font-feature-settings:'tnum' 1}
/* --- материалы: тёмная плита, лист протокола, ткань шрифта, штамп --- */
#stm .plate{position:relative;background:var(--oil) 100% 100%/220px 220px no-repeat,var(--grain),linear-gradient(180deg,var(--k2),var(--k1));box-shadow:inset 0 0 0 2px var(--k0),inset 0 0 0 4px var(--k3),0 calc(var(--s)*5px) 0 var(--k0)}
#stm .plate::before{content:'';position:absolute;inset:0 0 auto 0;height:calc(var(--s)*7px);background:var(--hzs);opacity:.95;pointer-events:none}
#stm .paper{position:relative;color:var(--ink);background:var(--grain),repeating-linear-gradient(180deg,transparent 0 calc(var(--s)*23px),rgba(80,62,20,.1) calc(var(--s)*23px) calc(var(--s)*24px)),radial-gradient(ellipse 60% 40% at 88% 92%,rgba(60,40,10,.2),transparent 70%),var(--pa);box-shadow:0 calc(var(--s)*6px) 0 rgba(0,0,0,.6)}
#stm .paper::before,#stm .paper::after{content:'';position:absolute;top:calc(var(--s)*-9px);width:calc(var(--s)*54px);height:calc(var(--s)*17px);background:rgba(255,196,0,.82);box-shadow:0 1px 2px rgba(0,0,0,.35);pointer-events:none}
#stm .paper::before{left:calc(var(--s)*18px);transform:rotate(-5deg)}
#stm .paper::after{right:calc(var(--s)*18px);transform:rotate(4deg)}
#stm .stencil{-webkit-mask-image:linear-gradient(180deg,#000 0 47%,transparent 47% 52%,#000 52% 100%);mask-image:linear-gradient(180deg,#000 0 47%,transparent 47% 52%,#000 52% 100%)}
#stm .stamp{display:inline-block;color:var(--red);border:calc(var(--s)*4px) solid currentColor;outline:calc(var(--s)*1.5px) solid currentColor;outline-offset:calc(var(--s)*-9px);padding:.28em .6em;font-weight:900;font-size:var(--f4);line-height:1.05;letter-spacing:.07em;text-transform:uppercase;text-align:center;border-radius:5px;mix-blend-mode:multiply;filter:url(#mcd-rough);opacity:.93;transform:rotate(-7deg)}
#stm .stamp.ok{color:#1c7a3a}
#stm .hzbar{height:calc(var(--s)*8px);background:var(--hz)}
#stm .rivet{position:absolute;width:calc(var(--s)*9px);height:calc(var(--s)*9px);border-radius:50%;background:radial-gradient(circle at 35% 30%,#8c8368,#2a261b 70%);box-shadow:0 1px 0 rgba(255,255,255,.12)}
/* --- кнопки --- */
#stm .btn{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:.5em;min-height:var(--btn);padding:0 1.15em;font-weight:900;font-size:var(--f3);line-height:1;letter-spacing:.07em;text-transform:uppercase;color:var(--pa);background:var(--k3);border-radius:3px;
  box-shadow:inset 0 0 0 2px var(--k4),0 calc(var(--s)*4px) 0 var(--k0);transition:transform .07s,box-shadow .07s,filter .12s;white-space:nowrap;overflow:hidden}
#stm .btn svg{width:1.25em;height:1.25em;flex:none}
#stm .btn:hover:not([disabled]){filter:brightness(1.16)}
#stm .btn:active:not([disabled]){transform:translateY(calc(var(--s)*3px));box-shadow:inset 0 0 0 2px var(--k4),0 calc(var(--s)*1px) 0 var(--k0)}
#stm .btn.y{background:linear-gradient(180deg,#ffd21f,var(--y));color:var(--ink);box-shadow:inset 0 calc(var(--s)*-4px) 0 var(--y2),inset 0 0 0 2px #fff6,0 calc(var(--s)*4px) 0 var(--k0)}
#stm .btn.y::before,#stm .btn.y::after{content:'';position:absolute;top:0;bottom:0;width:calc(var(--s)*14px);background:var(--hzs);opacity:.9;pointer-events:none}
#stm .btn.y::before{left:0}#stm .btn.y::after{right:0}
#stm .btn.y>*{position:relative}
#stm .btn.big{min-height:calc(var(--btn)*1.3);font-size:var(--f4);padding:0 calc(var(--s)*30px)}
#stm .btn.ad{background:var(--k1);color:var(--y);box-shadow:inset 0 0 0 calc(var(--s)*3px) var(--y),0 calc(var(--s)*4px) 0 var(--k0)}
#stm .btn.ad svg{width:1em;height:1em}
#stm .btn[disabled]{filter:grayscale(.9) brightness(.62)}
#stm .btn.red{background:linear-gradient(180deg,#f0493a,var(--red));color:#fff;box-shadow:inset 0 calc(var(--s)*-4px) 0 var(--red2),inset 0 0 0 2px #fff4,0 calc(var(--s)*4px) 0 var(--k0)}
#stm .sq{width:var(--btn);height:var(--btn);display:inline-flex;align-items:center;justify-content:center;flex:none;background:var(--k2);border-radius:3px;box-shadow:inset 0 0 0 2px var(--k4),0 calc(var(--s)*4px) 0 var(--k0);transition:transform .07s,box-shadow .07s,filter .12s;color:var(--pa)}
#stm .sq svg{width:58%;height:58%}
#stm .sq:hover{filter:brightness(1.2)}
#stm .sq:active{transform:translateY(calc(var(--s)*3px));box-shadow:inset 0 0 0 2px var(--k4),0 calc(var(--s)*1px) 0 var(--k0)}
#stm .sq.y{background:var(--y);color:var(--ink);box-shadow:inset 0 calc(var(--s)*-3px) 0 var(--y2),0 calc(var(--s)*4px) 0 var(--k0)}
#stm .chip{display:inline-flex;align-items:center;gap:calc(var(--s)*7px);height:var(--btn);padding:0 calc(var(--s)*13px);background:var(--k0);border-radius:3px;box-shadow:inset 0 0 0 2px var(--k3);font-size:var(--f4);font-weight:900;letter-spacing:.03em;white-space:nowrap;pointer-events:auto}
#stm .chip svg{width:1.05em;height:1.05em;color:var(--y);flex:none}
#stm .chip.ad{font-size:var(--f2);letter-spacing:.06em;text-transform:uppercase;color:var(--y);box-shadow:inset 0 0 0 calc(var(--s)*2px) var(--y)}
#stm .chip.ad svg{width:.9em;height:.9em}
#stm .chip.ad[disabled]{color:var(--mut);box-shadow:inset 0 0 0 2px var(--k3)}
/* --- верхняя балка меню --- */
#stm .top{position:absolute;left:0;right:0;top:0;height:calc(var(--topH) + var(--st));padding:var(--st) calc(var(--m) + var(--sr)) 0 calc(var(--m) + var(--sl));display:flex;align-items:center;gap:calc(var(--s)*9px);background:var(--oil) 20% 0/220px 220px no-repeat,var(--grain),linear-gradient(180deg,var(--k0),var(--k1));pointer-events:none}
#stm .top::after{content:'';position:absolute;left:0;right:0;bottom:0;height:calc(var(--s)*6px);background:var(--hzs)}
#stm .top .sp{flex:1}
#stm .brand{display:flex;align-items:center;gap:calc(var(--s)*9px);min-width:0}
#stm .brand .rd{width:calc(var(--s)*34px);height:calc(var(--s)*34px);flex:none}
#stm .brand .wm{display:flex;flex-direction:column;line-height:.95;text-transform:uppercase;white-space:nowrap}
#stm .brand .wm small{font-size:var(--f1);letter-spacing:.34em;color:var(--y);font-weight:800}
#stm .brand .wm b{font-size:var(--f4);letter-spacing:.07em}
#stm .ttl{display:flex;flex-direction:column;line-height:.95;text-transform:uppercase}
#stm .ttl small{color:var(--y);letter-spacing:.3em}
#stm .ttl b{font-size:var(--f5);letter-spacing:.05em}
/* --- журнал испытаний: список трасс --- */
#stm .lv-list{position:absolute;left:calc(var(--m) + var(--sl));top:calc(var(--topH) + var(--st) + var(--m));bottom:calc(var(--barH) + var(--sb) + var(--m));width:clamp(176px,31%,calc(var(--s)*340px));display:flex;flex-direction:column;pointer-events:auto;padding:calc(var(--s)*16px) 0 0}
#stm .lv-hd{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:calc(var(--s)*8px) calc(var(--s)*12px) calc(var(--s)*6px);font-size:var(--f1);letter-spacing:.2em;text-transform:uppercase;color:var(--y);font-weight:800;flex:none}
#stm .lv-hd b{color:var(--mut);font-weight:700;letter-spacing:.1em}
#stm .lv-rows{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:0 calc(var(--s)*8px) calc(var(--s)*10px);display:flex;flex-direction:column;gap:calc(var(--s)*5px);scrollbar-width:thin;scrollbar-color:var(--y3) transparent}
#stm .ent{position:relative;display:grid;grid-template-columns:calc(var(--s)*40px) minmax(0,1fr) auto;align-items:center;gap:0 calc(var(--s)*9px);min-height:calc(var(--s)*54px);padding:calc(var(--s)*5px) calc(var(--s)*9px) calc(var(--s)*5px) 0;background:var(--k3);cursor:pointer;flex:none;transition:transform .09s,background .09s;box-shadow:inset 0 0 0 2px var(--k4)}
#stm .ent:hover{background:#3a3524}
#stm .ent .no{grid-row:1/3;align-self:stretch;display:flex;align-items:center;justify-content:center;font-size:var(--f4);font-weight:900;letter-spacing:.02em;color:var(--mut);background:var(--k1);box-shadow:inset -3px 0 0 var(--bc,var(--y3))}
#stm .ent .nm{font-size:var(--f3);font-weight:800;text-transform:uppercase;letter-spacing:.04em;overflow:hidden;line-height:1.08;align-self:end;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere;min-width:0}
#stm .ent .sb{display:flex;align-items:center;gap:calc(var(--s)*6px);font-size:var(--f1);font-weight:600;color:var(--mut);letter-spacing:.04em;white-space:nowrap;overflow:hidden;align-self:start;margin-top:calc(var(--s)*2px)}
#stm .ent .sb svg{width:1.3em;height:1.3em;flex:none;color:var(--bc,var(--y))}
#stm .ent .mini{grid-row:1/3;grid-column:3;width:calc(var(--s)*62px);height:calc(var(--s)*38px)}
#stm .ent .mini svg{width:100%;height:100%;overflow:visible}
#stm .ent .tg{position:absolute;right:calc(var(--s)*6px);top:calc(var(--s)*4px);display:flex;gap:4px}
#stm .ent .st{display:inline-flex;align-items:center;justify-content:center;height:calc(var(--s)*17px);min-width:calc(var(--s)*17px);padding:0 calc(var(--s)*4px);font-size:var(--f0);font-weight:900;background:var(--k0);color:var(--mut);border-radius:2px;gap:2px}
#stm .ent .st svg{width:1em;height:1em}
#stm .ent .st.done{background:var(--grn);color:var(--ink)}
#stm .ent.lock .nm{color:var(--mut)}
#stm .ent.lock .mini{opacity:.45}
#stm .ent.sel{background:var(--y);color:var(--ink);transform:translateX(calc(var(--s)*7px));box-shadow:inset 0 0 0 2px var(--y2),calc(var(--s)*-7px) 0 0 var(--k0)}
#stm .ent.sel .no{background:var(--ink);color:var(--y);box-shadow:none}
#stm .ent.sel .nm,#stm .ent.sel.lock .nm{color:var(--ink)}
#stm .ent.sel .sb{color:var(--ink)}
#stm .ent.sel .sb svg{color:var(--ink)}
#stm .ent.sel .st{background:var(--ink);color:var(--y)}
#stm .ent.sel .st.done{background:var(--ink);color:var(--grn)}
/* --- лист испытания (выбранная трасса) --- */
#stm .lv-sheet{position:absolute;right:calc(var(--m) + var(--sr));top:calc(var(--topH) + var(--st) + var(--m) + var(--s)*14px);bottom:calc(var(--barH) + var(--sb) + var(--m));width:clamp(224px,41%,calc(var(--s)*470px));pointer-events:auto;display:flex;flex-direction:column;gap:calc(var(--s)*8px);padding:calc(var(--s)*18px) calc(var(--s)*16px) calc(var(--s)*14px);overflow:hidden}
#stm .sh-hd{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:var(--f1);font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:var(--pmut)}
#stm .sh-hd b{color:var(--ink);font-size:var(--f3);letter-spacing:.06em}
#stm .sh-bio{display:inline-flex;align-items:center;gap:calc(var(--s)*6px);padding:calc(var(--s)*3px) calc(var(--s)*9px) calc(var(--s)*3px) calc(var(--s)*6px);background:var(--ink);color:var(--bc);letter-spacing:.12em;border-radius:2px}
#stm .sh-bio svg{width:calc(var(--s)*20px);height:calc(var(--s)*20px)}
#stm .sh-name{font-size:var(--f5);line-height:1;text-transform:uppercase;letter-spacing:.03em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink)}
#stm .sh-map{position:relative;flex:1 1 auto;min-height:calc(var(--s)*80px);background:linear-gradient(rgba(23,20,13,.07) 1px,transparent 1px) 0 0/calc(var(--s)*14px) calc(var(--s)*14px),linear-gradient(90deg,rgba(23,20,13,.07) 1px,transparent 1px) 0 0/calc(var(--s)*14px) calc(var(--s)*14px),var(--mb,#d8d1b8);box-shadow:inset 0 0 0 calc(var(--s)*2px) var(--ink);overflow:hidden}
#stm .sh-map svg.route{position:absolute;inset:0;width:100%;height:100%}
#stm .sh-map .km{position:absolute;right:calc(var(--s)*8px);bottom:calc(var(--s)*6px);padding:calc(var(--s)*2px) calc(var(--s)*8px);background:var(--ink);color:var(--y);font-size:var(--f2);font-weight:900;letter-spacing:.06em}
#stm .sh-map .scale{position:absolute;left:calc(var(--s)*8px);bottom:calc(var(--s)*6px);font-size:var(--f0);font-weight:800;letter-spacing:.12em;color:var(--ink);opacity:.7;text-transform:uppercase}
#stm .sh-desc{font-size:var(--f2);line-height:1.3;font-weight:600;color:#3a3422;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
#stm .sh-grid{display:grid;grid-template-columns:1.35fr 1fr 1fr;gap:0;border-top:calc(var(--s)*2px) solid var(--ink);margin:0}
#stm .sh-grid>div{padding:calc(var(--s)*6px) calc(var(--s)*8px) 0 0;min-width:0}
#stm .sh-grid dt{font-size:var(--f0);font-weight:800;letter-spacing:.06em;white-space:nowrap;color:var(--pmut);text-transform:uppercase}
#stm .sh-grid dd{margin:calc(var(--s)*2px) 0 0;font-size:var(--f3);font-weight:900;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:calc(var(--s)*3px)}
#stm .sh-grid dd svg{width:calc(var(--s)*15px);height:calc(var(--s)*15px);flex:none}
#stm .sh-grid dd .off{opacity:.22}
#stm .sh-stamp{position:absolute;left:calc(var(--s)*28px);top:calc(var(--s)*100px);font-size:var(--f3);z-index:2}
#stm .sh-lock{display:flex;align-items:center;gap:calc(var(--s)*9px);padding:calc(var(--s)*7px) calc(var(--s)*10px);background:var(--ink);color:var(--pa);font-size:var(--f2);font-weight:800;letter-spacing:.05em;text-transform:uppercase}
#stm .sh-lock svg{width:calc(var(--s)*20px);height:calc(var(--s)*20px);color:var(--y);flex:none}
#stm .sh-lock b{color:var(--y);margin-left:auto;display:inline-flex;align-items:center;gap:calc(var(--s)*5px);font-size:var(--f3)}
#stm .sh-lock b svg{width:1em;height:1em}
#stm .sh-lock .adleds{display:inline-flex;gap:3px;margin-left:calc(var(--s)*4px)}
#stm .sh-lock .adleds i{width:calc(var(--s)*9px);height:calc(var(--s)*12px);background:var(--k4)}
#stm .sh-lock .adleds i.on{background:var(--y)}
#stm .sh-stripe{height:calc(var(--s)*6px);background:var(--bc);margin:0 calc(var(--s)*-16px)}
/* --- нижняя панель меню --- */
#stm .bar{position:absolute;left:0;right:0;bottom:0;height:calc(var(--barH) + var(--sb));padding:calc(var(--s)*9px) calc(var(--m) + var(--sr)) calc(var(--s)*9px + var(--sb)) calc(var(--m) + var(--sl));display:flex;align-items:center;gap:calc(var(--s)*10px);background:var(--oil) 70% 100%/220px 220px no-repeat,var(--grain),linear-gradient(0deg,var(--k0),var(--k1));pointer-events:none}
#stm .bar::before{content:'';position:absolute;left:0;right:0;top:0;height:calc(var(--s)*6px);background:var(--hzs)}
#stm .dock{display:flex;gap:calc(var(--s)*8px);flex:none}
#stm .dk{position:relative;height:calc(var(--btn)*1.18);min-width:calc(var(--btn)*1.18);padding:0 calc(var(--s)*12px);display:inline-flex;align-items:center;justify-content:center;gap:calc(var(--s)*8px);background:var(--k3);border-radius:3px;box-shadow:inset 0 0 0 2px var(--k4),0 calc(var(--s)*4px) 0 var(--k0);font-size:var(--f1);font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--pa);transition:transform .07s,filter .12s}
#stm .dk svg{width:calc(var(--s)*26px);height:calc(var(--s)*26px);color:var(--y);flex:none}
#stm .dk:hover{filter:brightness(1.18)}#stm .dk:active{transform:translateY(calc(var(--s)*3px))}
#stm .dk .dot{position:absolute;top:calc(var(--s)*-5px);right:calc(var(--s)*-5px);width:calc(var(--s)*15px);height:calc(var(--s)*15px);border-radius:50%;background:var(--red);box-shadow:0 0 0 calc(var(--s)*3px) var(--k1);display:none}
#stm .dk.badge .dot{display:block;animation:mcd-pulse 1.1s steps(2) infinite}
@keyframes mcd-pulse{50%{transform:scale(1.28);background:#ff7a6e}}
#stm .bar .info{flex:1;min-width:0;font-size:var(--f2);color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
#stm .bar .info b{color:var(--pa);font-size:var(--f3);margin-right:calc(var(--s)*8px);letter-spacing:.05em;text-transform:uppercase}
#stm .modesw{display:inline-flex;flex:none;background:var(--k0);border-radius:3px;box-shadow:inset 0 0 0 2px var(--k3);padding:calc(var(--s)*4px);gap:calc(var(--s)*4px);pointer-events:auto}
#stm .modesw button{position:relative;display:inline-flex;align-items:center;gap:calc(var(--s)*8px);height:calc(var(--btn)*.98);padding:0 calc(var(--s)*14px) 0 calc(var(--s)*12px);font-size:var(--f2);font-weight:900;letter-spacing:.07em;text-transform:uppercase;color:var(--mut);background:var(--k2);border-radius:2px;transition:transform .07s,background .1s,color .1s}
#stm .modesw button svg{width:calc(var(--s)*20px);height:calc(var(--s)*20px);flex:none}
#stm .modesw button i{width:calc(var(--s)*9px);height:calc(var(--s)*9px);border-radius:50%;background:var(--k4);flex:none;box-shadow:inset 0 1px 2px #0008}
#stm .modesw button.on{background:var(--y);color:var(--ink);transform:translateY(calc(var(--s)*2px))}
#stm .modesw button.on i{background:#2c8a45;box-shadow:0 0 calc(var(--s)*8px) #55d476,inset 0 0 0 2px #1c5c2e}
#stm .bar .btn.big{flex:none}
/* --- гараж-бокс --- */
#stm .gar-light{position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse 34% 62% at 40% 0%,rgba(255,244,196,.30),transparent 74%),radial-gradient(ellipse 110% 90% at 42% 56%,transparent 52%,rgba(8,6,3,.66))}
#stm .gar-floor{position:absolute;left:0;right:0;bottom:0;height:calc(var(--s)*40px + var(--sb));display:flex;align-items:center;justify-content:center;pointer-events:none;background:linear-gradient(0deg,rgba(12,11,8,.9),transparent)}
#stm .gar-floor span{display:flex;align-items:center;gap:calc(var(--s)*12px);font-size:var(--f2);font-weight:900;letter-spacing:.42em;color:var(--y);text-transform:uppercase;opacity:.85;transform:perspective(220px) rotateX(38deg);padding-bottom:calc(var(--s)*4px)}
#stm .gar-floor span::before,#stm .gar-floor span::after{content:'';width:calc(var(--s)*80px);height:calc(var(--s)*5px);background:repeating-linear-gradient(90deg,var(--y) 0 calc(var(--s)*14px),transparent calc(var(--s)*14px) calc(var(--s)*24px))}
#stm .arrow{position:absolute;top:50%;margin-top:calc(var(--s)*-40px);width:calc(var(--s)*54px);height:calc(var(--s)*80px);display:flex;align-items:center;justify-content:center;pointer-events:auto;background:linear-gradient(180deg,var(--k2),var(--k0));color:var(--y);box-shadow:inset 0 0 0 2px var(--k3),0 calc(var(--s)*5px) 0 var(--k0);transition:transform .07s,filter .12s}
#stm .arrow svg{width:calc(var(--s)*30px);height:calc(var(--s)*30px)}
#stm .arrow::before{content:'';position:absolute;top:0;bottom:0;width:calc(var(--s)*9px);background:var(--hzs)}
#stm .arrow.l{left:calc(var(--m) + var(--sl))}#stm .arrow.l::before{left:0}#stm .arrow.l svg{margin-left:calc(var(--s)*6px)}
#stm .arrow.r{right:calc(var(--gpw) + var(--m)*2 + var(--sr))}#stm .arrow.r::before{right:0}#stm .arrow.r svg{margin-right:calc(var(--s)*6px)}
#stm .arrow:hover{filter:brightness(1.25)}#stm .arrow:active{transform:translateY(calc(var(--s)*3px))}
#stm .garage-scr{--gpw:clamp(210px,36%,calc(var(--s)*372px))}
#stm .gpanel{position:absolute;right:calc(var(--m) + var(--sr));top:calc(var(--topH) + var(--st) + var(--m));bottom:calc(var(--m) + var(--sb));width:var(--gpw);display:flex;flex-direction:column;gap:calc(var(--s)*8px);pointer-events:auto;padding:calc(var(--s)*22px) calc(var(--s)*16px) calc(var(--s)*14px);overflow:hidden}
#stm .gp-hd{display:flex;align-items:center;justify-content:space-between;font-size:var(--f1);font-weight:800;letter-spacing:.22em;text-transform:uppercase;color:var(--y)}
#stm .gp-hd b{color:var(--pa);letter-spacing:.1em;font-size:var(--f2)}
#stm .gp-name{font-size:var(--f6);line-height:1.12;text-transform:uppercase;letter-spacing:.03em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--pa);text-shadow:0 calc(var(--s)*3px) 0 #000}
#stm .gp-stats{display:flex;flex-direction:column;gap:calc(var(--s)*7px);border-top:calc(var(--s)*2px) solid var(--k4);padding-top:calc(var(--s)*10px)}
#stm .stat{display:grid;grid-template-columns:max(78px,calc(var(--s)*112px)) minmax(0,1fr) max(14px,calc(var(--s)*26px));align-items:center;gap:calc(var(--s)*8px);font-size:var(--f1);font-weight:800;letter-spacing:.1em;color:var(--mut);text-transform:uppercase}
#stm .stat>span{white-space:nowrap}
#stm .stat b{text-align:right;color:var(--pa);font-size:var(--f2)}
#stm .led{height:calc(var(--s)*13px);background:var(--k0);-webkit-mask-image:repeating-linear-gradient(90deg,#000 0 calc(10% - 3px),transparent calc(10% - 3px) 10%);mask-image:repeating-linear-gradient(90deg,#000 0 calc(10% - 3px),transparent calc(10% - 3px) 10%);position:relative;overflow:hidden}
#stm .led i{position:absolute;left:0;top:0;bottom:0;background:var(--y);transition:width .55s steps(10)}
#stm .stat.dur{color:var(--pa)}
#stm .stat.dur .led i{background:linear-gradient(90deg,var(--org),var(--y) 50%,#c4f060)}
#stm .stat.dur svg{display:inline-block;width:1.15em;height:1.15em;vertical-align:-.2em;margin-right:.35em;color:var(--org)}
#stm .gpanel .lk{display:flex;align-items:center;gap:calc(var(--s)*8px);flex-wrap:wrap;font-size:var(--f2);font-weight:700;color:var(--mut)}
#stm .gpanel .lk svg{width:calc(var(--s)*20px);height:calc(var(--s)*20px);color:var(--y)}
#stm .gpanel .lk.ok{color:var(--grn);font-weight:900;letter-spacing:.08em;text-transform:uppercase}
#stm .gpanel .lk.ok svg{color:var(--grn)}
#stm .gpanel .lk .adbar{flex-basis:100%;height:calc(var(--s)*8px);background:var(--k0);display:block}
#stm .gpanel .lk .adbar b{display:block;height:100%;background:var(--y)}
#stm .paints{display:flex;gap:calc(var(--s)*7px);flex-wrap:wrap;align-items:center}
#stm .paints .pl{font-size:var(--f1);letter-spacing:.18em;color:var(--mut);text-transform:uppercase;flex-basis:100%;font-weight:700}
#stm .paints button{position:relative;width:max(26px,calc(var(--s)*30px));height:max(26px,calc(var(--s)*30px));border-radius:3px;box-shadow:inset 0 0 0 2px rgba(0,0,0,.4),0 0 0 2px var(--k4)}
#stm .paints button.sel{box-shadow:inset 0 0 0 2px rgba(0,0,0,.4),0 0 0 calc(var(--s)*3px) var(--y)}
#stm .paints button.lock{filter:grayscale(.7) brightness(.5)}
#stm .paints button.lock::after{content:'7';position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:900;font-size:var(--f2)}
#stm .gpanel .sp{flex:1;min-height:0}
#stm .dots{display:flex;gap:calc(var(--s)*4px);flex-wrap:wrap}
#stm .dots i{width:calc(var(--s)*17px);height:calc(var(--s)*6px);background:var(--k4)}
#stm .dots i.on{background:var(--y)}
`;

/** Заезд: HUD на сетке (позиция, прогресс, ущерб, повреждения, скорость), удар, отсчёт, замедление, экранные кнопки. */
const MCD_CSS_RACE = String.raw`
#stm .rh{position:absolute;inset:0;display:grid;pointer-events:none;grid-template-columns:auto minmax(0,1fr) auto;grid-template-rows:auto minmax(0,1fr);grid-template-areas:"place prog board" "dmg . speed";
  column-gap:calc(var(--s)*10px);row-gap:calc(var(--s)*8px);padding:calc(var(--st) + var(--m)) calc(var(--sr) + var(--m)) calc(var(--sb) + var(--m) + var(--padz,0px)) calc(var(--sl) + var(--m))}
#stm .rh>*{pointer-events:none}
#stm .rh-place{grid-area:place;align-self:start;display:flex;align-items:center;gap:calc(var(--s)*10px);height:calc(var(--s)*64px);padding:calc(var(--s)*12px) calc(var(--s)*16px) calc(var(--s)*6px) calc(var(--s)*12px)}
#stm .rh-place .rd{width:calc(var(--s)*32px);height:calc(var(--s)*32px);flex:none}
#stm .rh-place div{display:flex;flex-direction:column;line-height:1}
#stm .rh-place small{color:var(--y);font-size:var(--f0);letter-spacing:.2em}
#stm .rh-place .pv{display:flex;align-items:baseline;gap:calc(var(--s)*4px)}
#stm .rh-place b{font-size:var(--f6);line-height:.92;color:var(--pa);text-shadow:0 calc(var(--s)*3px) 0 #000;min-width:.6em}
#stm .rh-place em{font-style:normal;font-size:var(--f3);color:var(--mut);font-weight:800}
#stm .rh-prog{grid-area:prog;align-self:start;justify-self:start;width:100%;max-width:calc(var(--s)*470px);height:calc(var(--s)*64px);padding:calc(var(--s)*14px) calc(var(--s)*26px) calc(var(--s)*7px) calc(var(--s)*14px);display:flex;flex-direction:column;justify-content:center;gap:calc(var(--s)*8px)}
#stm .rh-prog .ph{display:flex;justify-content:space-between;align-items:baseline;font-size:var(--f0);letter-spacing:.18em;color:var(--y);font-weight:800;text-transform:uppercase;line-height:1}
#stm .rh-prog .ph b{color:var(--pa);font-size:var(--f2);letter-spacing:.06em}
#stm .rh-prog .ph .pt{color:var(--mut)}
#stm .rh-prog .road{position:relative;height:calc(var(--s)*13px);background:linear-gradient(180deg,#26221a,#14120d);box-shadow:inset 0 0 0 2px var(--k0)}
#stm .rh-prog .road::before{content:'';position:absolute;left:0;right:0;top:50%;height:2px;margin-top:-1px;background:repeating-linear-gradient(90deg,rgba(255,196,0,.4) 0 calc(var(--s)*6px),transparent calc(var(--s)*6px) calc(var(--s)*12px))}
#stm .rh-prog .fill{position:absolute;left:0;top:0;bottom:0;width:0;background:repeating-linear-gradient(-45deg,var(--y) 0 calc(var(--s)*5px),#b88a00 calc(var(--s)*5px) calc(var(--s)*10px))}
#stm .rh-prog .tick{position:absolute;top:calc(var(--s)*-4px);bottom:calc(var(--s)*-4px);width:calc(var(--s)*3px);margin-left:calc(var(--s)*-1.5px);background:var(--pa);opacity:.85}
#stm .rh-prog .dot{position:absolute;top:50%;width:calc(var(--s)*10px);height:calc(var(--s)*10px);margin:calc(var(--s)*-5px) 0 0 calc(var(--s)*-5px);background:#e8e2cf;box-shadow:0 0 0 2px #000;transform:rotate(45deg)}
#stm .rh-prog .dot.me{width:calc(var(--s)*20px);height:calc(var(--s)*20px);margin:calc(var(--s)*-10px) 0 0 calc(var(--s)*-10px);border-radius:50%;transform:none;background:conic-gradient(var(--y) 0 25%,var(--k0) 0 50%,var(--y) 0 75%,var(--k0) 0);box-shadow:0 0 0 calc(var(--s)*2.5px) var(--y),0 0 0 calc(var(--s)*5px) #000;z-index:2}
#stm .rh-prog .fin{position:absolute;right:calc(var(--s)*-20px);top:calc(var(--s)*-12px);width:calc(var(--s)*26px);height:calc(var(--s)*26px);color:var(--pa)}
#stm .rh-free{grid-area:prog;align-self:start;justify-self:start;display:none;align-items:center;gap:calc(var(--s)*10px);height:calc(var(--s)*64px);padding:calc(var(--s)*12px) calc(var(--s)*18px) calc(var(--s)*6px) calc(var(--s)*12px);font-size:var(--f3);font-weight:900;letter-spacing:.1em;text-transform:uppercase;white-space:nowrap;line-height:1.05}
#stm .rh-free svg{width:calc(var(--s)*30px);height:calc(var(--s)*30px);color:var(--org);flex:none}
#stm .rh-free small{display:block;color:var(--y);letter-spacing:.2em;font-size:var(--f0);margin-bottom:calc(var(--s)*2px)}
#stm.free .rh-place,#stm.free .rh-prog{display:none}
#stm.free .rh-free{display:flex}
#stm .rh-board{grid-area:board;align-self:start;justify-self:end;display:flex;align-items:flex-start;gap:calc(var(--s)*8px)}
#stm .bd{display:flex;flex-direction:column;justify-content:center;height:calc(var(--s)*64px);padding:calc(var(--s)*12px) calc(var(--s)*14px) calc(var(--s)*6px);min-width:calc(var(--s)*112px);line-height:1}
#stm .bd small{font-size:var(--f0);color:var(--y);letter-spacing:.2em;margin-bottom:calc(var(--s)*3px)}
#stm .bd b{font-size:var(--f5);color:var(--pa);white-space:nowrap;text-shadow:0 calc(var(--s)*3px) 0 #000;display:inline-block;transform-origin:100% 50%}
#stm .bd.dm b{color:var(--y)}
#stm .bd.dm{min-width:calc(var(--s)*150px)}
#stm.free .bd.dm{min-width:calc(var(--s)*210px)}
#stm.free .bd.dm b{font-size:var(--f6)}
#stm .bd-btns{display:flex;gap:calc(var(--s)*8px);padding-top:calc(var(--s)*8px)}
#stm .bd-btns .sq{pointer-events:auto}
#stm .rh-dmg{grid-area:dmg;align-self:end;justify-self:start;width:calc(var(--s)*176px);display:flex;flex-direction:column;gap:calc(var(--s)*6px);padding:calc(var(--s)*15px) calc(var(--s)*11px) calc(var(--s)*9px)}
#stm .dm-h{display:flex;align-items:baseline;justify-content:space-between;line-height:1}
#stm .dm-h small{color:var(--y);font-size:var(--f0);letter-spacing:.16em}
#stm .dm-h em{font-style:normal;font-size:var(--f4);font-weight:900;color:var(--pa)}
#stm .dm-b{display:flex;gap:calc(var(--s)*8px);align-items:center;justify-content:space-between}
#stm .dm-b svg.car{width:calc(var(--s)*72px);height:calc(var(--s)*108px);flex:none;overflow:visible}
#stm .dm-b svg.car .z{transition:none;stroke:#0c0b08;stroke-width:1.6}
#stm .dm-b svg.car .w{stroke:#0c0b08;stroke-width:1.2}
#stm .dm-b svg.car .w.lost{fill:none;stroke:#e5392d;stroke-width:1.6;stroke-dasharray:3 2.4}
#stm .dm-r{flex:1;display:flex;flex-direction:column;align-items:center;gap:calc(var(--s)*3px);min-width:0}
#stm .eng{position:relative;display:flex;flex-direction:column;align-items:center;gap:calc(var(--s)*2px);color:#d6e0cb;width:100%}
#stm .eng svg.en{width:calc(var(--s)*58px);height:calc(var(--s)*49px);overflow:visible}
#stm .eng .sm,#stm .eng .fi,#stm .eng .xx{display:none}
#stm .eng .sm circle{fill:#bdb7a4;opacity:0;animation:mcd-rise 1.1s linear infinite}
#stm .eng .sm circle:nth-child(2){animation-delay:.35s}#stm .eng .sm circle:nth-child(3){animation-delay:.7s}
#stm .eng .fi path{transform-box:fill-box;transform-origin:50% 100%;animation:mcd-flick .22s steps(2) infinite}
#stm .eng .fi path:nth-child(2){animation-delay:.08s;animation-direction:reverse}
#stm .eng .xx{stroke:#e5392d;stroke-width:3.4;fill:none}
#stm .eng .es{font-size:var(--f0);font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:var(--grn);line-height:1;white-space:nowrap;display:flex;align-items:center;gap:calc(var(--s)*5px)}
#stm .eng .es i{width:calc(var(--s)*8px);height:calc(var(--s)*8px);border-radius:50%;background:currentColor;box-shadow:0 0 calc(var(--s)*7px) currentColor}
#stm .rh-dmg.st-smoke .eng .sm{display:block}#stm .rh-dmg.st-smoke .es{color:#ffd21f}
#stm .rh-dmg.st-fire .eng .fi{display:block}#stm .rh-dmg.st-fire .es{color:#ff5a3c}#stm .rh-dmg.st-fire .es i{animation:mcd-blink .3s steps(2) infinite}
#stm .rh-dmg.st-fire{box-shadow:inset 0 0 0 2px var(--k0),inset 0 0 0 4px var(--red2),0 calc(var(--s)*5px) 0 var(--k0)}
#stm .rh-dmg.st-dead .eng .xx{display:block}#stm .rh-dmg.st-dead .es{color:var(--mut)}#stm .rh-dmg.st-dead .es i{box-shadow:none;background:#3d3827}
#stm .rh-dmg .led{height:calc(var(--s)*9px);-webkit-mask-image:repeating-linear-gradient(90deg,#000 0 calc(10% - 2px),transparent calc(10% - 2px) 10%);mask-image:repeating-linear-gradient(90deg,#000 0 calc(10% - 2px),transparent calc(10% - 2px) 10%)}
#stm .rh-dmg .led i{transition:width .2s steps(6);background:linear-gradient(90deg,#d6e0cb,#ffd634 35%,#ff8a1a 65%,#d6281c)}
@keyframes mcd-rise{0%{transform:translateY(0) scale(.5);opacity:0}25%{opacity:.85}100%{transform:translateY(-16px) scale(1.5);opacity:0}}
@keyframes mcd-flick{0%{transform:scale(1,1)}100%{transform:scale(.86,1.22)}}
@keyframes mcd-blink{50%{opacity:.15}}
#stm .rh-speed{grid-area:speed;align-self:end;justify-self:end;width:calc(var(--s)*236px);display:flex;flex-direction:column;gap:calc(var(--s)*6px);padding:calc(var(--s)*17px) calc(var(--s)*14px) calc(var(--s)*10px)}
#stm .sp-leds{display:flex;gap:calc(var(--s)*2px);height:calc(var(--s)*15px)}
#stm .sp-leds i{flex:1;background:#2a261b;box-shadow:inset 0 -2px 0 rgba(0,0,0,.35)}
#stm .sp-leds i.on{background:var(--y);box-shadow:0 0 calc(var(--s)*6px) rgba(255,196,0,.55)}
#stm .sp-leds i.rz.on{background:var(--red);box-shadow:0 0 calc(var(--s)*6px) rgba(229,57,45,.7)}
#stm .sp-num{display:flex;align-items:baseline;justify-content:flex-end;gap:calc(var(--s)*1px);line-height:.88}
#stm .sp-num b{font-size:var(--f7);width:.6em;text-align:center;color:var(--pa);text-shadow:0 calc(var(--s)*4px) 0 #000;font-feature-settings:'tnum' 1,'zero' 1}
#stm .sp-num b.z{color:#3a3526}
#stm .sp-num small{margin-left:calc(var(--s)*8px);color:var(--y);font-size:var(--f1)}
#stm .nit{display:flex;align-items:center;gap:calc(var(--s)*8px)}
#stm .nit svg{width:calc(var(--s)*17px);height:calc(var(--s)*17px);color:var(--cy);flex:none}
#stm .nit .nl{display:flex;gap:calc(var(--s)*2px);flex:1;height:calc(var(--s)*11px)}
#stm .nit .nl i{flex:1;background:#2a261b}
#stm .nit .nl i.on{background:var(--cy);box-shadow:0 0 calc(var(--s)*6px) rgba(89,210,255,.5)}
#stm.nitro-on .nit svg{color:var(--org);animation:mcd-blink .18s steps(2) infinite}
#stm.nitro-on .nit .nl i.on{background:var(--org);box-shadow:0 0 calc(var(--s)*7px) rgba(255,122,26,.7)}
/* кнопка «починиться» */
#stm .rh-repair{position:absolute;left:50%;bottom:calc(var(--m) + var(--sb));transform:translateX(-50%);display:none;width:min(calc(var(--s)*500px),calc(100% - 2*var(--side,calc(var(--s)*250px))));z-index:2}
#stm.repair .rh-repair{display:block;animation:mcd-pop .3s cubic-bezier(.2,1.5,.4,1)}
#stm .rh-repair .btn{width:100%;min-height:calc(var(--btn)*1.5);flex-wrap:nowrap;white-space:normal;text-align:left;font-size:var(--f3);line-height:1.12;padding:0 calc(var(--s)*28px);justify-content:flex-start;gap:calc(var(--s)*12px);animation:mcd-attn .9s steps(2) infinite;pointer-events:auto}
#stm .rh-repair .btn svg{width:calc(var(--s)*32px);height:calc(var(--s)*32px)}
#stm .rh-repair .btn span{flex:1}
#stm .rh-repair kbd{font-family:inherit;display:none;align-items:center;justify-content:center;min-width:calc(var(--s)*32px);height:calc(var(--s)*32px);padding:0 calc(var(--s)*8px);background:var(--ink);color:var(--y);font-weight:900;font-size:var(--f3);border-radius:3px;flex:none;box-shadow:0 calc(var(--s)*3px) 0 #000}
#stm:not(.touchmode) .rh-repair kbd{display:inline-flex}
@keyframes mcd-attn{50%{box-shadow:inset 0 calc(var(--s)*-4px) 0 var(--y2),inset 0 0 0 2px #fff6,0 calc(var(--s)*4px) 0 var(--k0),0 0 0 calc(var(--s)*4px) var(--red)}}
@keyframes mcd-pop{from{transform:translateX(-50%) scale(.6);opacity:0}to{transform:translateX(-50%) scale(1);opacity:1}}
/* счёт удара */
#stm .crash{position:absolute;left:50%;top:max(38%,calc(var(--hudTop,60px) + var(--s)*100px));transform:translateX(-50%);display:none;pointer-events:none;z-index:4}
#stm .crash.on{display:block}
#stm .cr-in{display:flex;flex-direction:column;align-items:center;gap:calc(var(--s)*3px);--cs:1;transform-origin:50% 40%;will-change:transform}
#stm .cr-ser{display:none;align-items:center;gap:calc(var(--s)*8px);padding:calc(var(--s)*3px) calc(var(--s)*12px);background:var(--k0);color:var(--y);font-size:calc(var(--f3)*var(--cs));font-weight:900;letter-spacing:.12em;text-transform:uppercase;box-shadow:inset 0 0 0 2px var(--y)}
#stm .cr-ser.on{display:flex}
#stm .cr-ser b{color:var(--pa);font-size:1.18em}
#stm .cr-t{padding:calc(var(--s)*3px) calc(var(--s)*20px) calc(var(--s)*5px);background:var(--y);color:var(--ink);font-size:min(calc(var(--f5)*var(--cs)),calc(var(--vw)*7.2));font-weight:900;letter-spacing:.07em;text-transform:uppercase;white-space:nowrap;transform:skewX(-9deg);box-shadow:0 calc(var(--s)*6px) 0 var(--k0);line-height:1.04}
#stm .cr-v{font-size:min(calc(var(--f8)*var(--cs)*.82),calc(var(--vw)*14.5));line-height:1;font-weight:900;color:var(--pa);white-space:nowrap;letter-spacing:.01em;-webkit-text-stroke:calc(var(--s)*4px) #000;paint-order:stroke fill;text-shadow:0 calc(var(--s)*6px) 0 #000;font-feature-settings:'tnum' 1}
#stm .cr-v.hot{color:#ff6a3c}
#stm .cr-sum{display:none;padding:calc(var(--s)*3px) calc(var(--s)*14px);background:var(--k0);color:var(--pa);font-size:calc(var(--f3)*var(--cs));font-weight:900;letter-spacing:.08em;text-transform:uppercase}
#stm .cr-sum.on{display:block}
#stm .cr-sum b{color:var(--y)}
/* отсчёт */
#stm .count{position:absolute;left:50%;top:36%;transform:translate(-50%,-50%);display:none;flex-direction:column;align-items:center;gap:calc(var(--s)*10px);pointer-events:none;z-index:4}
#stm .count.on{display:flex}
#stm .lamps{display:flex;gap:calc(var(--s)*12px);padding:calc(var(--s)*9px) calc(var(--s)*16px);background:var(--k0);box-shadow:inset 0 0 0 2px var(--k3),0 calc(var(--s)*5px) 0 #000}
#stm .lamps i{width:calc(var(--s)*28px);height:calc(var(--s)*28px);border-radius:50%;background:#2a1210;box-shadow:inset 0 3px 5px #000}
#stm .lamps i.r{background:var(--red);box-shadow:0 0 calc(var(--s)*18px) var(--red),inset 0 0 0 3px rgba(255,255,255,.18)}
#stm .lamps i.g{background:var(--grn);box-shadow:0 0 calc(var(--s)*20px) var(--grn),inset 0 0 0 3px rgba(255,255,255,.22)}
#stm .cnum{font-size:var(--f8);line-height:.9;font-weight:900;color:var(--pa);-webkit-text-stroke:calc(var(--s)*5px) #000;paint-order:stroke fill;text-shadow:0 calc(var(--s)*8px) 0 #000;text-transform:uppercase;letter-spacing:.03em}
#stm .count.go .cnum{color:var(--y);font-size:calc(var(--f8)*.7)}
/* сообщения: замедление, плашка, ленты трюков */
#stm .msgs{position:absolute;left:50%;top:calc(var(--hudTop,60px) + var(--s)*6px + var(--tuth,0px));transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:calc(var(--s)*6px);pointer-events:none;width:max-content;max-width:calc(100% - 2*var(--m));z-index:5}
#stm .rec{display:none;align-items:center;gap:calc(var(--s)*9px);padding:calc(var(--s)*3px) calc(var(--s)*11px);background:rgba(0,0,0,.82);color:var(--pa);font-size:var(--f1);font-weight:800;letter-spacing:.14em;text-transform:uppercase;white-space:nowrap}
#stm.slowmo .rec{display:flex;animation:mcd-fade .2s}
#stm .rec i{width:calc(var(--s)*11px);height:calc(var(--s)*11px);border-radius:50%;background:var(--red);box-shadow:0 0 calc(var(--s)*8px) var(--red);animation:mcd-blink .7s steps(2) infinite}
#stm .rec b{color:var(--red);font-size:1.1em}
#stm .rec em{font-style:normal;color:var(--y)}
#stm .toast{display:none;padding:calc(var(--s)*6px) calc(var(--s)*26px);background:var(--y);color:var(--ink);font-size:var(--f3);font-weight:900;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap;box-shadow:0 calc(var(--s)*4px) 0 var(--k0);clip-path:polygon(0 0,100% 0,calc(100% - 9px) 50%,100% 100%,0 100%,9px 50%);max-width:100%;overflow:hidden;text-overflow:ellipsis}
#stm .toast.on{display:block;animation:mcd-tape .26s cubic-bezier(.2,1.4,.4,1)}
@keyframes mcd-tape{0%{transform:translateY(-130%) rotate(-3deg);opacity:0}100%{transform:none;opacity:1}}
#stm .pops{display:flex;flex-direction:column;align-items:center;gap:calc(var(--s)*4px)}
#stm .pop{display:flex;align-items:center;gap:calc(var(--s)*10px);padding:calc(var(--s)*3px) calc(var(--s)*14px);background:var(--k0);color:var(--y);font-size:var(--f3);font-weight:900;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap;box-shadow:inset 0 0 0 calc(var(--s)*2px) var(--y);animation:mcd-popin 1.5s linear forwards}
#stm .pop em{font-style:normal;background:var(--y);color:var(--ink);padding:0 calc(var(--s)*7px);margin-right:calc(var(--s)*-6px)}
@keyframes mcd-popin{0%{transform:translateX(-40px) skewX(-12deg);opacity:0}8%{transform:skewX(-8deg);opacity:1}16%{transform:skewX(-8deg) translateX(3px)}22%{transform:skewX(-8deg)}78%{opacity:1}100%{transform:skewX(-8deg) translateY(-14px);opacity:0}}
/* кадр замедленной съёмки и удар по экрану */
#stm .lbar{position:absolute;left:0;right:0;height:calc(100% * var(--lbh,.075));background:#000;pointer-events:none;transition:transform .34s cubic-bezier(.2,.8,.2,1)}
#stm .lbar.t{top:0;transform:translateY(-101%)}
#stm .lbar.b{bottom:0;transform:translateY(101%)}
#stm.slowmo .lbar{transform:none}
#stm .vig{position:absolute;inset:0;pointer-events:none;opacity:0;transition:opacity .28s;background:radial-gradient(ellipse at 50% 50%,transparent 38%,rgba(0,0,0,.62) 100%),linear-gradient(rgba(40,70,120,.10),rgba(40,70,120,.10))}
#stm.slowmo .vig{opacity:1}
#stm .hitfx{position:absolute;inset:0;pointer-events:none;opacity:0;background:radial-gradient(ellipse at 50% 50%,transparent 45%,rgba(229,57,45,.55) 100%)}
/* экранные кнопки */
#stm .touch{display:none}
#stm.touchmode .race.on .touch{display:block}
#stm.touchmode{--padz:calc(var(--pad)*2 + var(--gap));--side:calc(var(--s)*216px)}
#stm:not(.touchmode){--side:calc(var(--s)*250px)}
#stm .tb{position:absolute;pointer-events:auto;width:var(--pad);height:var(--pad);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:calc(var(--s)*2px);touch-action:none;color:var(--y);
  background:var(--grain),linear-gradient(180deg,var(--k3),var(--k1));border-radius:calc(var(--s)*6px);box-shadow:inset 0 0 0 calc(var(--s)*3px) var(--k0),inset 0 0 0 calc(var(--s)*5px) rgba(255,196,0,.28),0 calc(var(--s)*6px) 0 #000;transition:transform .05s,box-shadow .05s,filter .05s;-webkit-tap-highlight-color:transparent}
#stm .tb svg{width:48%;height:48%;pointer-events:none}
#stm .tb .cap{font-size:var(--f0);font-weight:900;letter-spacing:.12em;text-transform:uppercase;line-height:1;pointer-events:none}
#stm .tb.on{transform:translateY(calc(var(--s)*4px));filter:brightness(1.3);box-shadow:inset 0 0 0 calc(var(--s)*3px) var(--k0),inset 0 0 0 calc(var(--s)*5px) var(--y),0 calc(var(--s)*2px) 0 #000}
#stm .tb.gas{right:calc(var(--m) + var(--sr));bottom:calc(var(--m) + var(--sb));background:var(--grain),linear-gradient(180deg,#ffd21f,var(--y));color:var(--ink);box-shadow:inset 0 0 0 calc(var(--s)*3px) var(--k0),inset 0 calc(var(--s)*-6px) 0 var(--y2),0 calc(var(--s)*6px) 0 #000}
#stm .tb.brake{right:calc(var(--m) + var(--sr) + var(--pad) + var(--gap));bottom:calc(var(--m) + var(--sb));background:var(--grain),linear-gradient(180deg,#f0493a,var(--red2));color:#fff;box-shadow:inset 0 0 0 calc(var(--s)*3px) var(--k0),inset 0 calc(var(--s)*-6px) 0 #7a1710,0 calc(var(--s)*6px) 0 #000}
#stm .tb.nitro{right:calc(var(--m) + var(--sr));bottom:calc(var(--m) + var(--sb) + var(--pad) + var(--gap));color:var(--cy)}
#stm .tb.hand{right:calc(var(--m) + var(--sr) + var(--pad) + var(--gap));bottom:calc(var(--m) + var(--sb) + var(--pad) + var(--gap));color:var(--org)}
#stm .tb.left{left:calc(var(--m) + var(--sl));bottom:calc(var(--m) + var(--sb));width:calc(var(--pad)*1.1);height:calc(var(--pad)*1.1)}
#stm .tb.right{left:calc(var(--m) + var(--sl) + var(--pad)*1.1 + var(--gap));bottom:calc(var(--m) + var(--sb));width:calc(var(--pad)*1.1);height:calc(var(--pad)*1.1)}
#stm .tb.left svg,#stm .tb.right svg{width:56%;height:56%}
body.lory-paused #stm .race .touch{display:none!important}
`;

/** Окна: пауза, настройки, протокол испытания, «Как играть», подарок дня, колесо, рекорды. */
const MCD_CSS_MODAL = String.raw`
#stm .modal{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:var(--grain),rgba(10,8,4,.74);pointer-events:auto;padding:calc(var(--m) + var(--st)) calc(var(--m) + var(--sr)) calc(var(--m) + var(--sb)) calc(var(--m) + var(--sl));z-index:8}
#stm .modal.on{display:flex;animation:mcd-fade .16s}
@keyframes mcd-fade{from{opacity:0}to{opacity:1}}
#stm .card{position:relative;width:min(calc(var(--s)*500px),100%);max-height:100%;overflow:auto;padding:calc(var(--s)*28px) calc(var(--s)*22px) calc(var(--s)*20px);display:flex;flex-direction:column;gap:calc(var(--s)*12px);animation:mcd-drop .34s cubic-bezier(.2,1.35,.4,1) both;scrollbar-width:thin;scrollbar-color:var(--y3) transparent}
@keyframes mcd-drop{0%{transform:translateY(-34px) scale(1.04);opacity:0}100%{transform:none;opacity:1}}
#stm .card.wide{width:min(calc(var(--s)*680px),100%)}
#stm .card h2{font-size:var(--f6);line-height:.95;text-transform:uppercase;letter-spacing:.04em;color:var(--pa);text-shadow:0 calc(var(--s)*3px) 0 #000}
#stm .card h2 b{color:var(--y)}
#stm .card .row{display:flex;gap:calc(var(--s)*10px);flex-wrap:wrap}
#stm .card .row .btn{flex:1 1 auto}
#stm .card p{font-size:var(--f2);line-height:1.4;color:var(--mut);font-weight:600}
#stm .card .hdr{display:flex;align-items:center;gap:calc(var(--s)*10px)}
#stm .card .hdr h2{flex:1;min-width:0;font-size:var(--f5);overflow-wrap:anywhere}
#stm .card .tgl{display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:var(--f3);font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:calc(var(--s)*6px) 0;border-bottom:2px dashed var(--k4)}
#stm .sw{display:inline-flex;align-items:center;gap:calc(var(--s)*9px);min-width:calc(var(--s)*118px);height:calc(var(--btn)*.92);padding:0 calc(var(--s)*14px);background:var(--k2);color:var(--mut);font-size:var(--f2);font-weight:900;letter-spacing:.08em;text-transform:uppercase;border-radius:3px;box-shadow:inset 0 0 0 2px var(--k4),0 calc(var(--s)*3px) 0 var(--k0);transition:transform .07s}
#stm .sw:active{transform:translateY(calc(var(--s)*2px))}
#stm .sw i{width:calc(var(--s)*10px);height:calc(var(--s)*10px);border-radius:50%;background:var(--k4);box-shadow:inset 0 1px 2px #0008}
#stm .sw.on{background:var(--y);color:var(--ink)}
#stm .sw.on i{background:#2c8a45;box-shadow:0 0 calc(var(--s)*8px) #55d476,inset 0 0 0 2px #1c5c2e}
#stm .keys{display:grid;grid-template-columns:auto 1fr;gap:calc(var(--s)*8px) calc(var(--s)*14px);align-items:center;font-size:var(--f2);font-weight:700}
#stm .kc{display:inline-flex;gap:calc(var(--s)*4px);flex-wrap:wrap}
#stm .kc kbd{font-family:inherit;min-width:calc(var(--s)*34px);height:calc(var(--s)*30px);padding:0 calc(var(--s)*8px);display:inline-flex;align-items:center;justify-content:center;background:var(--pa);color:var(--ink);box-shadow:0 calc(var(--s)*3px) 0 #000;border-radius:3px;font-size:var(--f2);font-weight:900}
#stm.touchmode .keys{display:none}
#stm:not(.touchmode) [data-k=htouch]{display:none}
#stm .keys .ic{display:inline-flex;align-items:center;justify-content:center;width:calc(var(--s)*34px);height:calc(var(--s)*30px);color:var(--y)}
#stm .keys .ic svg{width:80%;height:80%}
/* --- протокол испытания --- */
#stm .rs{width:min(calc(var(--s)*610px),100%);padding:calc(var(--s)*26px) calc(var(--s)*22px) calc(var(--s)*16px);gap:calc(var(--s)*10px);overflow:visible;animation:mcd-slam .46s cubic-bezier(.2,1.2,.35,1) both;max-height:none}
@keyframes mcd-slam{0%{transform:translateY(-130%) rotate(-4deg);opacity:0}55%{transform:translateY(3%) rotate(.8deg);opacity:1}78%{transform:translateY(-1.2%) rotate(-.3deg)}100%{transform:none}}
#stm .rs-hd{display:flex;justify-content:space-between;align-items:baseline;gap:10px;border-bottom:calc(var(--s)*3px) solid var(--ink);padding-bottom:calc(var(--s)*6px)}
#stm .rs-hd .t{font-size:var(--f4);font-weight:900;letter-spacing:.07em;text-transform:uppercase;line-height:1.05}
#stm .rs-hd .no{font-size:var(--f2);color:var(--pmut);letter-spacing:.1em;font-weight:800;white-space:nowrap}
#stm .rs-body{display:grid;grid-template-columns:minmax(0,.86fr) minmax(0,1.3fr);gap:calc(var(--s)*18px);align-items:start}
#stm .rs-place{display:flex;flex-direction:column;line-height:1}
#stm .rs-place small{color:var(--pmut)}
#stm .rs-place b{font-size:var(--f8);line-height:.9;color:var(--ink);margin-top:calc(var(--s)*2px);display:inline-block}
#stm .rs-place em{font-style:normal;font-weight:800;font-size:var(--f3);color:var(--pmut);margin-top:calc(var(--s)*4px);letter-spacing:.08em;text-transform:uppercase}
#stm .rs-place.p1 b{color:#a87500}#stm .rs-place.p4 b,#stm .rs-place.p5 b{color:#6d664d}
#stm .rs-place.free b{font-size:var(--f6);line-height:1;letter-spacing:.02em;text-transform:uppercase}
#stm .rs-stamp{position:relative;margin-top:calc(var(--s)*12px);min-height:calc(var(--s)*74px)}
#stm .rs-stamp .stamp{position:absolute;left:calc(var(--s)*2px);top:0;opacity:0;font-size:var(--f4);max-width:100%}
#stm .rs.stamped .rs-stamp .stamp{animation:mcd-stamp .3s cubic-bezier(.15,.9,.3,1.05) forwards}
@keyframes mcd-stamp{0%{opacity:0;transform:scale(2.9) rotate(-24deg)}68%{opacity:.96;transform:scale(.9) rotate(-7deg)}100%{opacity:.93;transform:scale(1) rotate(-7deg)}}
#stm .rs-rows{display:flex;flex-direction:column}
#stm .rw{display:flex;align-items:baseline;gap:calc(var(--s)*6px);padding:calc(var(--s)*5px) 0;font-size:var(--f3);animation:mcd-print .22s steps(5) both;animation-delay:calc(var(--i)*var(--rowms,150ms) + .3s)}
#stm .rw .k{font-weight:700;color:#3a3422;letter-spacing:.03em;white-space:nowrap}
#stm .rw i{flex:1;min-width:calc(var(--s)*10px);border-bottom:calc(var(--s)*2px) dotted rgba(23,20,13,.5);transform:translateY(calc(var(--s)*-3px))}
#stm .rw b{font-size:var(--f4);font-weight:900;font-feature-settings:'tnum' 1;white-space:nowrap}
#stm .rw.sm{padding:calc(var(--s)*2px) 0;font-size:var(--f2)}
#stm .rw.sm b{font-size:var(--f3)}
#stm .rw.hot b{color:var(--red2)}
#stm .rw.tot{border-top:calc(var(--s)*3px) solid var(--ink);margin-top:calc(var(--s)*4px);padding-top:calc(var(--s)*6px)}
#stm .rw.tot .k{font-weight:900;text-transform:uppercase;letter-spacing:.06em;font-size:var(--f3)}
#stm .rw.tot b{font-size:var(--f5)}
@keyframes mcd-print{from{clip-path:inset(0 100% 0 0);opacity:.15}to{clip-path:inset(0 0 0 0);opacity:1}}
#stm .rs-btns{display:flex;flex-direction:column;gap:calc(var(--s)*8px);margin-top:calc(var(--s)*4px)}
#stm .rs-btns .row{display:flex;gap:calc(var(--s)*8px)}
#stm .rs-btns .row .btn{flex:1;min-width:0;padding:0 calc(var(--s)*8px);font-size:var(--f2);white-space:normal;line-height:1.05;text-align:center}
#stm .rs .btn:not(.y){background:var(--ink);color:var(--pa);box-shadow:inset 0 0 0 2px #3d3827,0 calc(var(--s)*4px) 0 rgba(0,0,0,.6)}
/* --- подарок дня --- */
#stm .days{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:calc(var(--s)*8px)}
#stm .day{min-width:0;overflow:hidden;position:relative;display:flex;flex-direction:column;align-items:center;gap:calc(var(--s)*2px);padding:calc(var(--s)*8px) calc(var(--s)*4px) calc(var(--s)*7px);background:var(--grain),var(--pa);color:var(--ink);min-height:calc(var(--s)*108px);box-shadow:0 calc(var(--s)*4px) 0 #000}
#stm .day .dn{font-size:var(--f0);letter-spacing:.14em;color:var(--pmut);text-transform:uppercase;font-weight:800}
#stm .day .di{width:calc(var(--s)*46px);height:calc(var(--s)*46px);display:flex;align-items:center;justify-content:center;color:#8a6500}
#stm .day .di svg{width:100%;height:100%;object-fit:contain}
#stm .day .dv{font-size:var(--f4);font-weight:900;line-height:1.05;text-align:center}
#stm .day .dv small{display:block;font-size:var(--f0);color:var(--pmut);letter-spacing:.06em}
#stm .day.today{background:var(--grain),var(--y);box-shadow:0 calc(var(--s)*4px) 0 #000,0 0 0 calc(var(--s)*3px) #fff4}
#stm .day.today .dn,#stm .day.today .dv small{color:#4a3600}#stm .day.today .di{color:var(--ink)}
#stm .day.claimed>*{opacity:.28}
#stm .day.claimed::after{content:'';position:absolute;inset:18%;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M3.5 12.5l5.5 5.5L20.5 6' fill='none' stroke='%231c7a3a' stroke-width='3.6'/%3E%3C/svg%3E") center/contain no-repeat}
#stm .day.locked .di{filter:grayscale(.6) brightness(.85)}
#stm .day.d7{grid-column:span 2;flex-direction:row;gap:calc(var(--s)*12px);justify-content:flex-start;padding:calc(var(--s)*8px) calc(var(--s)*12px);background:linear-gradient(120deg,#33300f,#1d1a13 62%);color:var(--pa);box-shadow:inset 0 0 0 calc(var(--s)*3px) var(--y),0 calc(var(--s)*4px) 0 #000}
#stm .day.d7 .dn{color:var(--y)}
#stm .day.d7 .di{width:calc(var(--s)*84px);height:calc(var(--s)*54px);color:var(--y);flex:none}
#stm .day .dv,#stm .day.d7 .dt span{overflow-wrap:anywhere}
#stm[data-z=nar] .day.d7{flex-direction:column;align-items:flex-start;gap:calc(var(--s)*4px)}
#stm[data-z=nar] .day.d7 .di{width:calc(var(--s)*54px);height:calc(var(--s)*34px)}
#stm .day.d7 .dt{display:flex;flex-direction:column;align-items:flex-start;gap:calc(var(--s)*2px);min-width:0}
#stm .day.d7 .dv{text-align:left;font-size:var(--f4);color:var(--pa)}
#stm .day .ex{font-size:var(--f0);letter-spacing:.1em;background:var(--y);color:var(--ink);padding:1px calc(var(--s)*6px);text-transform:uppercase;font-weight:900}
#stm .day .dh{font-size:var(--f1);color:var(--mut)}
#stm .ghint{font-size:var(--f2);color:var(--mut);text-align:center;min-height:1.3em;font-weight:600}
/* --- колесо --- */
#stm .wwrap{display:flex;gap:calc(var(--s)*20px);align-items:center}
#stm .wbox{position:relative;width:min(calc(var(--s)*310px),calc(var(--vw)*40),58vh);aspect-ratio:1;flex:none;margin-top:calc(var(--s)*18px)}
#stm .wbox .dwrap{position:absolute;inset:0;overflow:hidden;border-radius:50%;box-shadow:0 calc(var(--s)*6px) 0 #000}
#stm .wbox .disk{width:100%;height:100%;display:block}
#stm .wbox .ptr{position:absolute;left:50%;top:calc(var(--s)*-18px);width:calc(var(--s)*36px);height:calc(var(--s)*46px);transform:translateX(-50%);filter:drop-shadow(0 calc(var(--s)*3px) 0 rgba(0,0,0,.6));z-index:2}
#stm .wside{flex:1;min-width:0;display:flex;flex-direction:column;gap:calc(var(--s)*10px)}
#stm .wside .btn{width:100%;white-space:normal;line-height:1.1;text-align:center}
#stm .wres{text-align:center;font-size:var(--f5);font-weight:900;color:var(--y);min-height:1.3em;text-transform:uppercase;line-height:1.05;text-shadow:0 calc(var(--s)*3px) 0 #000}
#stm .wres.pop{animation:mcd-wpop .5s cubic-bezier(.2,1.5,.4,1)}
@keyframes mcd-wpop{0%{transform:scale(.3);opacity:0}100%{transform:scale(1);opacity:1}}
/* --- рекорды --- */
#stm .lb{display:flex;flex-direction:column;gap:calc(var(--s)*4px)}
#stm .lb .lrow{display:grid;grid-template-columns:calc(var(--s)*40px) calc(var(--s)*34px) 1fr auto;align-items:center;gap:calc(var(--s)*10px);padding:calc(var(--s)*5px) calc(var(--s)*10px);background:var(--k3);font-size:var(--f3);font-weight:700}
#stm .lb .lrow.me{box-shadow:inset 0 0 0 2px var(--y)}
#stm .lb .rk{font-weight:900;color:var(--mut);font-size:var(--f4)}
#stm .lb .lrow.top .rk{color:var(--y)}
#stm .lb .av{width:calc(var(--s)*34px);height:calc(var(--s)*34px);object-fit:cover;background:var(--k0);display:flex;align-items:center;justify-content:center;font-weight:900;color:var(--y);border-radius:3px}
#stm .lb .nm{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#stm .lb .sc{color:var(--y);font-weight:900}
#stm .lb-empty{text-align:center;color:var(--mut);font-size:var(--f3);padding:calc(var(--s)*18px) 0;font-weight:700}
`;

/** Раскладка по размеру окна: JS ставит data-o (l | p), data-z (low | nar | std) и --s. */
const MCD_CSS_LAYOUT = String.raw`
#stm[data-z=low]{--topH:max(46px,calc(var(--s)*54px));--barH:max(62px,calc(var(--s)*66px));--m:calc(var(--s)*11px)}
#stm[data-w=s] .dk span{display:none}
#stm[data-w=s] .dk{padding:0;min-width:calc(var(--btn)*1.18)}
#stm[data-w=s] .bar .info{display:none}
#stm[data-w=s] .modesw button .l{display:none}
#stm[data-w=s] .modesw button .sh{display:inline}
#stm .bar .btn.ad{flex:0 1 auto;min-width:calc(var(--s)*108px);white-space:normal;line-height:1.05;text-align:center}
#stm[data-z=low] .rh-free span{display:none}
#stm[data-z=low] .brand .wm small{display:none}
#stm[data-z=low] .brand .wm b{font-size:var(--f3)}
#stm[data-z=low] .sh-desc{display:none}
#stm[data-z=low] .bar .info{display:none}
#stm[data-z=low] .dk span{display:none}
#stm[data-z=low] .dk{padding:0;min-width:var(--btn);height:calc(var(--btn)*1.1)}
#stm[data-z=low] .dock{gap:calc(var(--s)*5px)}
#stm[data-z=low] .modesw button i{display:none}
#stm[data-z=low] .modesw button{padding:0 calc(var(--s)*10px)}
#stm[data-z=low] .bar{gap:calc(var(--s)*7px)}
#stm[data-z=low] .ent .sb{display:none}
#stm[data-z=low] .ent{min-height:calc(var(--s)*44px);grid-template-columns:calc(var(--s)*36px) minmax(0,1fr) auto}
#stm[data-z=low] .ent .nm{align-self:center}
#stm[data-z=low] .lv-hd{padding-top:calc(var(--s)*4px);white-space:nowrap}
#stm[data-z=low] .lv-list{width:clamp(200px,30%,264px)}
#stm[data-z=low] .ent .mini{width:calc(var(--s)*52px)}
#stm[data-z=low] .stat{grid-template-columns:max(74px,calc(var(--s)*100px)) minmax(0,1fr) max(14px,calc(var(--s)*20px))}
#stm[data-z=low] .stat.dur svg{display:none}
#stm[data-z=low] .rivet{display:none}
#stm[data-z=low] .gp-name{font-size:var(--f5)}
#stm[data-z=low] .gp-stats{padding-top:calc(var(--s)*6px);gap:calc(var(--s)*5px)}
#stm[data-z=low] .paints .pl,#stm[data-z=low] .gpanel .dots{display:none}
#stm[data-z=low] .gpanel{padding-top:calc(var(--s)*20px);gap:calc(var(--s)*6px)}
#stm[data-z=low] .rh-dmg .dm-h{display:none}
#stm[data-z=low] .rh-dmg{width:calc(var(--s)*244px)}
#stm[data-z=low] .dm-b svg.car{width:calc(var(--s)*92px);height:calc(var(--s)*138px)}
#stm[data-z=low] .eng svg.en{width:calc(var(--s)*76px);height:calc(var(--s)*64px)}
#stm[data-z=low] .eng .es{letter-spacing:.06em}
#stm[data-z=low] .rh-dmg{padding-top:calc(var(--s)*13px)}
#stm[data-z=low] .card{padding:calc(var(--s)*24px) calc(var(--s)*16px) calc(var(--s)*12px);gap:calc(var(--s)*8px)}
#stm[data-z=low] .card h2{font-size:var(--f5)}
#stm[data-z=low] .rs-place b{font-size:var(--f7)}
#stm[data-z=low] .rs-stamp{min-height:calc(var(--s)*58px);margin-top:calc(var(--s)*8px)}
#stm[data-z=low] .rs-btns{flex-direction:row;flex-wrap:wrap}
#stm[data-z=low] .rs-btns .row{display:contents}
#stm[data-z=low] .rs-btns .btn{flex:1 1 auto;min-height:40px}
#stm[data-z=low] .day{min-height:calc(var(--s)*74px);padding:calc(var(--s)*4px) calc(var(--s)*3px)}
#stm[data-z=low] .day .di{width:calc(var(--s)*34px);height:calc(var(--s)*34px)}
#stm[data-z=low] .wbox{width:min(calc(var(--s)*270px),calc(var(--vw)*40),62vh)}
#stm[data-z=low] .ghint{font-size:var(--f1);min-height:0}
#stm[data-z=low] .card p{font-size:var(--f1);line-height:1.3}
#stm[data-z=low] .keys{grid-template-columns:auto 1fr auto 1fr;gap:calc(var(--s)*5px) calc(var(--s)*10px);font-size:var(--f1)}
#stm[data-z=low] .kc kbd{min-width:calc(var(--s)*24px);height:calc(var(--s)*22px);font-size:var(--f1)}
#stm[data-z=low] .card .row .btn{min-height:40px}
#stm[data-z=low] .card .btn.big{min-height:44px}
#stm[data-z=low] .card .tgl{padding:calc(var(--s)*3px) 0}
#stm[data-z=low] .modesw button .l{display:none}
#stm[data-z=low] .bar .btn.ad{flex:0 1 auto;min-width:0;white-space:normal;line-height:1;text-align:center;padding:0 calc(var(--s)*10px);font-size:var(--f1)}
#stm[data-z=low] .bar .btn.big{padding:0 calc(var(--s)*14px);font-size:var(--f3)}
#stm .modesw button .sh{display:none}
#stm[data-z=low] .modesw button .sh{display:inline}
/* портрет */
#stm[data-o=p]{--barH:calc(var(--s)*140px)}
#stm[data-o=p] .top .brand .wm small{display:none}
#stm[data-o=p] .lv-list{left:calc(var(--m) + var(--sl));right:calc(var(--m) + var(--sr));top:calc(var(--topH) + var(--st) + var(--m));bottom:auto;width:auto;height:calc(var(--s)*92px);padding:0}
#stm[data-o=p] .lv-hd{display:none}
#stm[data-o=p] .lv-rows{flex-direction:row;overflow-x:auto;overflow-y:hidden;padding:calc(var(--s)*4px) calc(var(--s)*8px) calc(var(--s)*10px) 0;gap:calc(var(--s)*6px)}
#stm[data-o=p] .ent{display:flex;flex-direction:column;align-items:stretch;width:calc(var(--s)*78px);min-height:0;padding:0;gap:0}
#stm[data-o=p] .ent .no{height:calc(var(--s)*26px);box-shadow:inset 0 -3px 0 var(--bc,var(--y3))}
#stm[data-o=p] .ent .nm,#stm[data-o=p] .ent .sb{display:none}
#stm[data-o=p] .ent .mini{width:auto;flex:1;margin:calc(var(--s)*4px)}
#stm[data-o=p] .ent .tg{top:calc(var(--s)*4px);right:calc(var(--s)*4px)}
#stm[data-o=p] .ent.sel{transform:translateY(calc(var(--s)*-4px));box-shadow:inset 0 0 0 2px var(--y2),0 calc(var(--s)*4px) 0 var(--k0)}
#stm[data-o=p] .lv-sheet{left:calc(var(--m) + var(--sl));right:calc(var(--m) + var(--sr));width:auto;top:auto;bottom:calc(var(--barH) + var(--sb) + var(--m));height:calc(var(--s)*336px);max-height:calc(100% - var(--topH) - var(--s)*92px - var(--barH) - var(--st) - var(--sb) - var(--m)*3)}
#stm[data-o=p] .bar{flex-wrap:wrap;align-content:center;row-gap:calc(var(--s)*8px);height:calc(var(--barH) + var(--sb))}
#stm[data-o=p] .bar .info{display:block;flex:0 0 100%;height:0;margin:calc(var(--s)*-8px) 0 0;padding:0;overflow:hidden;order:0}
#stm[data-o=p] .dock{order:-2}
#stm[data-o=p] .modesw{flex:1 1 0;min-width:0;order:-1}
#stm[data-o=p] .modesw button{flex:1;justify-content:center;padding:0 calc(var(--s)*8px)}
#stm[data-o=p] .bar .btn.big{flex:1.2 1 0;min-width:0;padding:0 calc(var(--s)*10px);order:2;white-space:normal;line-height:1.05;font-size:var(--f3)}
#stm[data-o=p] .bar .btn.ad{flex:1 1 0;min-width:0;padding:0 calc(var(--s)*8px);order:1;white-space:normal;line-height:1.05;font-size:var(--f2)}
#stm[data-o=p] .garage-scr .arrow{top:34%}
#stm[data-o=p] .arrow.r{right:calc(var(--m) + var(--sr))}
#stm[data-o=p] .gpanel{left:calc(var(--m) + var(--sl));right:calc(var(--m) + var(--sr));width:auto;top:auto;max-height:54%}
#stm[data-o=p] .gar-floor{display:none}
#stm[data-o=p] .rh{grid-template-columns:auto minmax(0,1fr);grid-template-rows:auto auto minmax(0,1fr);grid-template-areas:"place board" "prog prog" "dmg speed"}
#stm[data-o=p] .rh-prog{max-width:none;justify-self:stretch}
#stm[data-o=p] .rh-free{justify-self:stretch}
#stm[data-o=p] .bd,#stm[data-o=p] .bd.dm{min-width:0;padding-left:calc(var(--s)*10px);padding-right:calc(var(--s)*10px)}
#stm[data-o=p] .bd b{font-size:var(--f4)}
#stm[data-z=nar] .bd b{font-size:var(--f3)}
#stm[data-o=p] .rh-place{padding-right:calc(var(--s)*10px);gap:calc(var(--s)*7px)}
#stm[data-o=p] .bd.pt{display:none}
#stm[data-o=p] .bd-btns{padding-top:calc(var(--s)*8px)}
#stm[data-o=p] .rh-speed{width:calc(var(--s)*204px)}
#stm[data-o=p] .rh-repair{width:calc(100% - 2*(var(--m) + var(--sl)));bottom:calc(var(--m) + var(--sb) + var(--padz,0px) + var(--s)*186px)}
#stm[data-o=p] .rs-body{grid-template-columns:1fr}
#stm[data-o=p] .wwrap{flex-direction:column}
#stm[data-o=p] .wbox{width:min(calc(var(--s)*300px),calc(var(--vw)*76),44vh)}
#stm[data-o=p] .wside{width:100%}
#stm[data-o=p] .card.wide .days{gap:calc(var(--s)*6px)}
#stm[data-o=p] .stat{grid-template-columns:max(78px,calc(var(--s)*112px)) minmax(0,1fr) max(14px,calc(var(--s)*26px))}
/* узкий телефон */
#stm[data-z=nar]{--pad:max(54px,calc(var(--s)*72px))}
#stm[data-z=nar] .brand .wm b{font-size:var(--f3)}
#stm[data-z=nar] .modesw button .l{display:none}
#stm[data-z=nar] .modesw button .sh{display:inline}
#stm[data-z=nar] .modesw button svg{display:none}
#stm[data-z=nar] .modesw button{padding:0 calc(var(--s)*6px)}
#stm[data-z=nar] .chip{padding:0 calc(var(--s)*9px);font-size:var(--f3)}
#stm[data-z=nar] .chip.ad .t{display:none}
#stm[data-z=nar] .dk span{display:none}
#stm[data-z=nar] .dk{padding:0}
#stm[data-z=nar] .card{padding-left:calc(var(--s)*16px);padding-right:calc(var(--s)*16px)}
#stm[data-z=nar] .rs{padding-left:calc(var(--s)*16px);padding-right:calc(var(--s)*16px)}
`;

/** Лист испытания: контур трассы, штампы. */
const MCD_CSS_SHEET = String.raw`
#stm .sh-map .k1{stroke-width:calc(var(--s)*17px)}
#stm .sh-map .k2{stroke-width:calc(var(--s)*12px)}
#stm .sh-map .k3{stroke-width:calc(var(--s)*2.4px);stroke-dasharray:calc(var(--s)*8px) calc(var(--s)*7px)}
#stm .sh-map .draw{stroke-dasharray:1;stroke-dashoffset:0}
#stm .lv-sheet.fresh .draw{animation:mcd-draw .85s steps(28) both}
@keyframes mcd-draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
#stm .lv-sheet.fresh .sh-name{animation:mcd-print .38s steps(9) both}
#stm .lv-sheet.fresh .sh-stamp .stamp{animation:mcd-stamp .3s cubic-bezier(.15,.9,.3,1.05) .8s both}
#stm .lv-sheet.fresh .sh-grid{animation:mcd-print .3s steps(8) .15s both}
#stm .eng .sm circle{transform-box:fill-box;transform-origin:50% 100%}
#stm .ent .mini svg path{vector-effect:non-scaling-stroke}
#stm .ent .mini svg path:first-child{stroke-width:calc(var(--s)*6px)}
#stm .ent .mini svg path:nth-child(2){stroke-width:calc(var(--s)*2.6px)}
`;

// --- утилиты -----------------------------------------------------------------------------------------------------
/** Число с группами разрядов (неразрывный пробел). */
const mcdNum = (n) => Math.floor(Math.max(0, Number(n) || 0)).toLocaleString('ru-RU').replace(/[  ]/g, ' ');
const mcdMoney = (n) => '$' + mcdNum(n);
const mcdPad = (n, w) => String(n).padStart(w || 2, '0');
const mcdClamp01 = (v) => (v > 1 ? 1 : v > 0 ? v : 0);
const mcdEsc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const mcdT = (key, params) => Lang.t(key, params);
const mcdTime = (sec) => { const s = Math.max(0, Number(sec) || 0), m = Math.floor(s / 60); return m + ':' + (s - m * 60).toFixed(1).padStart(4, '0'); };
/** Детерминированный генератор для зерна и пятен масла (одинаковый вид при каждом запуске). */
const mcdRng = (seed) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;
/** Цвет зоны: чистый — жёлтый — оранжевый — красный — чёрно-красный. */
const MCD_HEAT = [[0, 214, 224, 203], [0.25, 255, 214, 52], [0.5, 255, 138, 26], [0.75, 214, 40, 28], [1, 42, 8, 6]];
/** @type {string[]} */
const mcdHeatCache = [];
function mcdHeat(v) {
    const q = Math.round(mcdClamp01(v) * MCD_ZONE_STEPS);
    if (mcdHeatCache[q]) return mcdHeatCache[q];
    const x = q / MCD_ZONE_STEPS;
    let i = 1;
    while (i < MCD_HEAT.length - 1 && x > MCD_HEAT[i][0]) i++;
    const a = MCD_HEAT[i - 1], b = MCD_HEAT[i], k = (x - a[0]) / (b[0] - a[0]);
    return (mcdHeatCache[q] = `rgb(${Math.round(a[1] + (b[1] - a[1]) * k)},${Math.round(a[2] + (b[2] - a[2]) * k)},${Math.round(a[3] + (b[3] - a[3]) * k)})`);
}

/** Контур трассы 0..1 → путь SVG (viewBox 100×60), вписанный без искажений, со сглаживанием (Catmull-Rom). */
function mcdRoutePath(pts) {
    const src = (Array.isArray(pts) ? pts : []).filter((p) => p && isFinite(p[0]) && isFinite(p[1]));
    if (src.length < 2) return { d: 'M12 30L88 30', a: [12, 30], b: [88, 30] };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of src) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    const k = Math.min(86 / Math.max(1e-4, x1 - x0), 46 / Math.max(1e-4, y1 - y0));
    const ox = 50 - ((x0 + x1) / 2) * k, oy = 30 - ((y0 + y1) / 2) * k;
    const step = Math.max(1, Math.ceil(src.length / 110));
    const P = [];
    for (let i = 0; i < src.length; i += step) P.push([src[i][0] * k + ox, src[i][1] * k + oy]);
    const last = src[src.length - 1];
    if ((src.length - 1) % step !== 0) P.push([last[0] * k + ox, last[1] * k + oy]);
    const f = (n) => n.toFixed(1);
    let d = `M${f(P[0][0])} ${f(P[0][1])}`;
    if (P.length < 3 || P.length > 40) { for (let i = 1; i < P.length; i++) d += `L${f(P[i][0])} ${f(P[i][1])}`; }
    else for (let i = 0; i < P.length - 1; i++) {
        const p0 = P[i - 1] || P[i], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2] || p2;
        d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
    }
    return { d, a: P[0], b: P[P.length - 1] };
}

/** @satisfies {Record<string, any>} */
const GameHud = {
    /** @type {HTMLElement | null} */ root: null,
    /** @type {Record<string, any>} */ h: {},
    /** @type {Record<string, HTMLElement>} */ el: {},
    screen: 'none',
    /** Режим заезда: 'race' | 'free' (ставит renderLevels, setMode). */
    mode: 'race',
    /** Для стенда: true / false — принудительно экранные кнопки; null — по устройству. */
    touchForce: null,
    /** Для стенда: масштаб интерфейса вручную (число) вместо расчёта по размеру окна. */
    scaleForce: null,
    _toastT: 0, _popN: 0,
    // состояние HUD заезда (обновляется только при заметных изменениях)
    _place: 0, _total: 0, _pts: -1, _dv: 0, _dvT: 0, _spd: -1, _spLit: 0, _nLit: -1, _nOn: false, _repair: false,
    _pg: -1, _pgKey: '', _pgRival: /** @type {number[]} */ ([]), _pgMe: -1,
    /** @type {HTMLElement[]} */ _sd: [], /** @type {HTMLElement[]} */ _spLeds: [], /** @type {HTMLElement[]} */ _nLeds: [],
    // повреждения
    /** @type {Record<string, SVGElement>} */ _zEl: {}, /** @type {SVGElement[]} */ _wEl: [],
    _zq: /** @type {Record<string, number>} */ ({}), _zb: /** @type {Record<string, { v: number, t: number }>} */ ({}),
    _wq: [-1, -1, -1, -1], _eq: -1, _dstate: '', _dpct: -1, _shakeT: 0,
    // удар
    _crN: 0, _crSum: 0, _crT: 0, _crTimer: 0, /** @type {any} */ _crAnim: null,
    _rsT: /** @type {any[]} */ ([]), _sheetId: '', _rowsKey: '', _garKey: '',
    /** @type {any} */ _diskKey: null, /** @type {any} */ _engG: null, _tuth: 0,

    init(handlers) {
        this.h = handlers || {};
        const st = document.createElement('style');
        st.id = 'mcd-css'; st.textContent = [MCD_CSS, MCD_CSS_RACE, MCD_CSS_MODAL, MCD_CSS_SHEET, MCD_CSS_LAYOUT].join('\n');
        document.head.appendChild(st);
        const r = document.createElement('div');
        r.id = 'stm';
        r.style.setProperty('--lbh', String(MCD_SLOWMO_BAR));
        r.innerHTML = this._markup();
        document.body.appendChild(r);
        this.root = r;
        r.querySelectorAll('[data-k]').forEach((e) => { this.el[/** @type {HTMLElement} */ (e).dataset.k] = /** @type {HTMLElement} */ (e); });
        this._textures();
        this._cacheRace();
        const on = (k, fn) => { const e = this.el[k]; if (e) e.addEventListener('click', (ev) => { ev.stopPropagation(); this.click(); fn(); }); };
        on('lgo', () => this.h.onLevelGo && this.h.onLevelGo());
        on('lad', () => this.h.onLevelAd && this.h.onLevelAd());
        on('ad', () => this.h.onAd && this.h.onAd());
        on('settings', () => this.settings(true));
        on('sclose', () => this.settings(false));
        on('shelp', () => { this.settings(false); this.help(true); });
        on('back', () => this.h.onBack && this.h.onBack());
        on('prev', () => this.h.onCar && this.h.onCar(-1));
        on('next', () => this.h.onCar && this.h.onCar(1));
        on('ggo', () => this.h.onGo && this.h.onGo());
        on('reset', () => this.h.onReset && this.h.onReset());
        on('repair', () => this.h.onReset && this.h.onReset());
        on('pause', () => this.h.onPause && this.h.onPause());
        on('resume', () => this.h.onPause && this.h.onPause());
        on('pcp', () => this.h.onReset && this.h.onReset(true));
        on('prestart', () => this.h.onRestart && this.h.onRestart());
        on('phow', () => this.help(true));
        on('pmenu', () => this.h.onMenu && this.h.onMenu());
        on('hclose', () => this.help(false));
        on('gift', () => this.h.onGift && this.h.onGift());
        on('wheel', () => this.h.onWheel && this.h.onWheel());
        on('rec', () => this.h.onRecords && this.h.onRecords());
        on('rlogin', () => this.h.onLogin && this.h.onLogin());
        on('gclaim', () => this.h.onClaim && this.h.onClaim(false));
        on('gx2', () => this.h.onClaim && this.h.onClaim(true));
        on('wfree', () => this.h.onSpin && this.h.onSpin('free'));
        on('wad', () => this.h.onSpin && this.h.onSpin('ad'));
        for (const [b, m] of [['gclose', 'mgift'], ['wclose', 'mwheel'], ['rclose', 'mrec']]) on(b, () => this.close(m));
        this.el.gpaints.addEventListener('click', (e) => {
            const b = /** @type {HTMLElement} */ (e.target).closest('[data-p]');
            if (!b) return;
            e.stopPropagation(); this.click();
            if (this.h.onPaint) this.h.onPaint(/** @type {HTMLElement} */ (b).dataset.p);
        });
        this.el.grid.addEventListener('click', (e) => {
            const row = /** @type {HTMLElement} */ (e.target).closest('.ent');
            if (!row) return;
            this.click();
            if (this.h.onLevelPick) this.h.onLevelPick(/** @type {HTMLElement} */ (row).dataset.id);
        });
        this.el.modesw.addEventListener('click', (e) => {
            const b = /** @type {HTMLElement} */ (e.target).closest('[data-m]');
            if (!b) return;
            e.stopPropagation(); this.click();
            const m = /** @type {HTMLElement} */ (b).dataset.m;
            this.setMode(m);
            if (this.h.onMode) this.h.onMode(m);
        });
        this._touch();
        Lang.apply();
        window.addEventListener('lory-input-device', () => this._syncTouch());
        window.addEventListener('lory-tutorial', () => requestAnimationFrame(() => this._tut()));
        window.addEventListener('resize', () => { this._layout(); this._tut(); });
        this._syncTouch();
        this._layout();
    },

    click() { try { Sound.play('assets/sounds/click.ogg', { volume: 0.5 }); } catch (e) { /* тихо */ } },
    _sfx(file, volume) { try { Sound.play('assets/sounds/' + file, { volume }); } catch (e) { /* тихо */ } },

    /** Экран: 'levels' | 'garage' | 'race' | 'none'. */
    show(name) {
        this.screen = name;
        const map = { levels: 'levels-scr', garage: 'garage-scr', race: 'race' };
        this.root.querySelectorAll('.scr').forEach((s) => s.classList.toggle('on', s.classList.contains(map[name] || '-')));
        this.root.classList.toggle('sc-race', name === 'race');
        if (name !== 'race') { this.el.crash.classList.remove('on'); this.setRepair({ show: false }); }
        this._syncTouch();
        this._layout();
    },

    _syncTouch() {
        const touch = this.touchForce != null ? this.touchForce
            : (typeof Input !== 'undefined' && (Input.device === 'touch' || Input.mouseTouch)) || (typeof IS_MOBILE !== 'undefined' && IS_MOBILE);
        this.root.classList.toggle('touchmode', !!touch);
        this._layout();
    },

    /** Размер, ориентация и «высота верхней полосы» (по ней встают сообщения и карточка обучения). */
    _layout() {
        const r = this.root;
        if (!r) return;
        const w = r.clientWidth || window.innerWidth, h = r.clientHeight || window.innerHeight;
        const port = h > w;
        const s = this.scaleForce != null ? this.scaleForce : port ? Math.max(0.8, Math.min(1.15, w / 430)) : Math.max(0.54, Math.min(1.3, h / 768));
        r.style.setProperty('--vw', (w / 100).toFixed(2) + 'px');
        r.dataset.w = w < 1180 ? 's' : 'l';
        r.dataset.o = port ? 'p' : 'l';
        r.dataset.z = !port && h < 470 ? 'low' : port && w < 420 ? 'nar' : 'std';
        r.style.setProperty('--s', s.toFixed(3));
        const q = this.screen === 'race' ? ['.rh-place', '.rh-prog', '.rh-free', '.rh-board'] : this.screen === 'none' ? [] : ['.top'];
        const rr = r.getBoundingClientRect();
        let top = 0;
        for (const sel of q) {
            const e = /** @type {HTMLElement | null} */ (r.querySelector(sel));
            if (e && e.offsetParent !== null) top = Math.max(top, e.getBoundingClientRect().bottom - rr.top);
        }
        r.style.setProperty('--hudTop', Math.round(top) + 'px');
        document.documentElement.style.setProperty('--mcd-top', this.screen === 'race' ? Math.round(top) + 'px' : '0px');
    },

    /** Карточка обучения лежит под верхней полосой: сообщения сдвигаются под неё. */
    _tut() {
        const c = /** @type {HTMLElement | null} */ (document.querySelector('.lory-tut-card:not([data-hl])'));
        const vis = !!c && !c.hidden && c.offsetParent !== null;
        const n = vis ? Math.round(c.offsetHeight + 8) : 0;
        if (n !== this._tuth) { this._tuth = n; this.root.style.setProperty('--tuth', n + 'px'); }
    },

    // Экранные кнопки: каждая — своё действие Input (setVirtual), мультитач, отпускание при уходе пальца и паузе.
    _touch() {
        const held = new Map();
        const virt = (v, on) => { if (typeof Input !== 'undefined' && Input.setVirtual) Input.setVirtual(v, on); };
        const release = (id) => { const k = held.get(id); if (!k) return; held.delete(id); if (![...held.values()].some(v => v.v === k.v)) { virt(k.v, false); k.el.classList.remove('on'); } };
        this.root.querySelectorAll('.tb').forEach((n) => {
            const el = /** @type {HTMLElement} */ (n), v = el.dataset.v;
            el.addEventListener('pointerdown', (e) => {
                e.preventDefault(); e.stopPropagation();
                try { el.setPointerCapture(e.pointerId); } catch (er) { /* без захвата */ }
                held.set(e.pointerId, { v, el });
                virt(v, true); el.classList.add('on');
                if (typeof Input !== 'undefined' && Input._setDevice) Input._setDevice('touch');
            });
            for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(t, (e) => release(/** @type {PointerEvent} */ (e).pointerId));
        });
        const all = () => { for (const id of [...held.keys()]) release(id); };
        window.addEventListener('lory-release-input', all);
        window.addEventListener('blur', all);
        if (typeof Pause !== 'undefined' && Pause.onChange) Pause.onChange(() => { if (Pause.active) all(); });
    },

    /** Свободная часть экрана для витрины гаража (камера ставит машину туда): между левой стрелкой и табличкой. */
    freeArea() {
        const r = this.root;
        const W = window.innerWidth, H = window.innerHeight;
        const p = r && r.querySelector('.gpanel');
        if (this.screen !== 'garage' || !p) return { x: 0, y: 0, w: W, h: H };
        const rr = r.getBoundingClientRect(), pb = p.getBoundingClientRect(), top = /** @type {HTMLElement} */ (r.querySelector('.garage-scr .top')).getBoundingClientRect().bottom;
        if (r.dataset.o === 'p') return { x: rr.left, y: top, w: rr.width, h: Math.max(80, pb.top - top) };
        const al = /** @type {HTMLElement} */ (this.el.prev).getBoundingClientRect(), ar = /** @type {HTMLElement} */ (this.el.next).getBoundingClientRect();
        const x = al.right + 6, x1 = ar.left - 6;
        return { x, y: top, w: Math.max(80, x1 - x), h: Math.max(80, rr.bottom - top - 40) };
    },

    /** Зерно бумаги и пятно масла: рисуются один раз и лежат в CSS-переменных. */
    _textures() {
        try {
            const mk = (w, h, fn) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); if (!x) return ''; fn(x, w, h); return `url(${c.toDataURL('image/png')})`; };
            const rnd = mcdRng(20261031);
            this.root.style.setProperty('--grain', mk(96, 96, (x, w, h) => {
                const im = x.createImageData(w, h);
                for (let i = 0; i < w * h; i++) { const v = rnd() < 0.5 ? 0 : 255; im.data[i * 4] = v; im.data[i * 4 + 1] = v; im.data[i * 4 + 2] = v; im.data[i * 4 + 3] = Math.floor(rnd() * rnd() * 46); }
                x.putImageData(im, 0, 0);
            }));
            this.root.style.setProperty('--oil', mk(220, 220, (x) => {
                const blob = (cx, cy, rx, ry, a) => { x.save(); x.translate(cx, cy); x.scale(rx, ry); const g = x.createRadialGradient(0, 0, 0, 0, 0, 1); g.addColorStop(0, `rgba(0,0,0,${a})`); g.addColorStop(0.6, `rgba(0,0,0,${a * 0.6})`); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.beginPath(); x.arc(0, 0, 1, 0, 6.3); x.fill(); x.restore(); };
                blob(188, 196, 74, 44, 0.5); blob(150, 214, 40, 22, 0.42); blob(210, 160, 26, 40, 0.38); blob(120, 218, 22, 12, 0.3);
                for (let i = 0; i < 9; i++) blob(100 + rnd() * 120, 120 + rnd() * 100, 2 + rnd() * 4, 2 + rnd() * 4, 0.35);
            }));
        } catch (e) { /* без текстур: плоские плиты */ }
    },

    // ---------------------------------------------------------------------------------------------
    // Разметка
    // ---------------------------------------------------------------------------------------------

    _markup() {
        const I = MCD_ICONS;
        const leds = (n, cls) => Array.from({ length: n }, (_, i) => `<i${cls && i >= n - MCD_SPEED_RED ? ' class="' + cls + '"' : ''}></i>`).join('');
        const car = `<svg class="car" viewBox="0 0 100 150" data-k="dcar"><defs><clipPath id="mcdBody"><path d="M32 10Q50 3 68 10L77 26 80 44V106L77 130Q50 148 23 130L20 106V44L23 26Z"/></clipPath></defs>
<rect class="w" x="8" y="94" width="12" height="25" rx="3"/><rect class="w" x="80" y="94" width="12" height="25" rx="3"/><rect class="w" x="8" y="26" width="12" height="25" rx="3"/><rect class="w" x="80" y="26" width="12" height="25" rx="3"/>
<g clip-path="url(#mcdBody)"><rect class="z" data-z="left" x="0" y="46" width="34" height="58"/><rect class="z" data-z="right" x="66" y="46" width="34" height="58"/><rect class="z" data-z="roof" x="34" y="46" width="32" height="58"/>
<rect class="z" data-z="front" x="0" y="0" width="100" height="46"/><rect class="z" data-z="rear" x="0" y="104" width="100" height="50"/></g>
<path d="M32 10Q50 3 68 10L77 26 80 44V106L77 130Q50 148 23 130L20 106V44L23 26Z" fill="none" stroke="#0c0b08" stroke-width="2.6"/>
<path d="M36 52H64L61 63H39Z M38 93H62L64 101H36Z" fill="rgba(12,11,8,.62)"/><path d="M34 63V93M66 63V93M50 10V44" stroke="rgba(12,11,8,.55)" stroke-width="1.4" fill="none"/>
<path d="M26 20L35 16.5V22.5L27 26ZM74 20L65 16.5V22.5L73 26Z" fill="#fff3b0"/><path d="M26 124H36V131H27ZM74 124H64V131H73Z" fill="#8a1d14"/></svg>`;
        const eng = `<svg class="en" viewBox="0 0 40 34" data-k="deng"><g class="eg" fill="currentColor"><rect x="9" y="12" width="21" height="16" rx="2"/><rect x="13" y="7" width="12" height="5"/><rect x="3" y="16" width="6" height="7"/><rect x="30" y="14" width="6" height="11"/><rect x="15" y="3" width="3" height="4"/><rect x="21" y="3" width="3" height="4"/></g><path d="M13 18h13M13 22h13" stroke="#14120d" stroke-width="1.6"/>
<g class="sm"><circle cx="14" cy="7" r="3"/><circle cx="20" cy="5" r="3.4"/><circle cx="26" cy="7" r="3"/></g>
<g class="fi"><path d="M11 12c1-3 3-4 3-8 3 2 4 5 3 8z" fill="#ff7a1a"/><path d="M19 12c1-4 4-6 3-11 4 3 6 7 4 11z" fill="#ffd21f"/><path d="M26 12c1-2 2-3 2-6 2 1 4 3 2 6z" fill="#ff5a3c"/></g><path class="xx" d="M8 4L32 30M32 4L8 30"/></svg>`;
        const pad = (v, cls, icon, capKey) => `<div class="tb ${cls}" data-v="${v}">${icon}${capKey ? `<span class="cap" data-t="${capKey}"></span>` : ''}</div>`;
        return `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><filter id="mcd-rough" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="2.4"/></filter></defs></svg>
<div class="vig"></div><div class="lbar t"></div><div class="lbar b"></div><div class="hitfx" data-k="hitfx"></div>
<div class="scr levels-scr">
  <header class="top"><div class="brand">${I.roundel}<div class="wm">${String(GAME_PLATFORM) === 'pikabu' ? '<small>МАСТЕР</small><b>АВАРИЙ</b>' : '<small>MASTER CAR</small><b>DESTRUCTION</b>'}</div></div><div class="sp"></div>
    <button class="chip ad" data-k="ad">${I.play}<span class="t"></span></button>
    <div class="chip pts">${I.nut}<span class="num" data-k="pts">0</span></div>
    <button class="sq" data-k="settings" aria-label="settings">${I.gear}</button></header>
  <section class="lv-list plate" aria-label="log"><div class="lv-hd"><span data-t="mcd.log"></span><b data-k="lvcount"></b></div><div class="lv-rows" data-k="grid"></div></section>
  <article class="lv-sheet paper" data-k="sheet"></article>
  <footer class="bar">
    <div class="dock">
      <button class="dk" data-k="gift">${I.gift}<span data-t="stm.gift"></span><i class="dot"></i></button>
      <button class="dk" data-k="wheel">${I.wheel}<span data-t="stm.wheel"></span><i class="dot"></i></button>
      <button class="dk" data-k="rec" style="display:none">${I.podium}<span data-t="stm.records"></span></button>
    </div>
    <div class="info" data-k="linfo"></div>
    <div class="modesw" data-k="modesw" role="group">
      <button data-m="race">${I.flag()}<span class="l" data-t="mcd.mode.race"></span><span class="sh" data-t="mcd.mode.raceS"></span><i></i></button>
      <button data-m="free">${I.burst}<span class="l" data-t="mcd.mode.free"></span><span class="sh" data-t="mcd.mode.freeS"></span><i></i></button>
    </div>
    <button class="btn ad" data-k="lad"></button><button class="btn y big" data-k="lgo"></button>
  </footer>
</div>
<div class="scr garage-scr">
  <div class="gar-light"></div>
  <header class="top"><button class="sq" data-k="back" aria-label="back">${I.back}</button><div class="ttl"><small data-t="mcd.box"></small><b data-k="gbox">№ 01</b></div><div class="sp"></div>
    <div class="chip pts">${I.nut}<span class="num" data-k="pts2">0</span></div></header>
  <button class="arrow l" data-k="prev" aria-label="prev">${I.chevL}</button>
  <button class="arrow r" data-k="next" aria-label="next">${I.chevR}</button>
  <aside class="gpanel plate">
    <i class="rivet" style="left:8px;top:14px"></i><i class="rivet" style="right:8px;top:14px"></i>
    <div class="gp-hd"><span data-t="mcd.spec"></span><b data-k="gcl"></b></div>
    <h2 class="gp-name" data-k="gname"></h2>
    <div class="gp-stats" data-k="gstats"></div>
    <div class="lk" data-k="glock"></div>
    <div class="paints" data-k="gpaints"></div>
    <div class="sp"></div>
    <div class="dots" data-k="gdots"></div>
    <button class="btn y big" data-k="ggo"></button>
  </aside>
  <div class="gar-floor"><span data-t="mcd.floor"></span></div>
</div>
<div class="scr race">
  <div class="rh">
    <div class="rh-place plate">${I.roundel}<div><small data-t="mcd.position"></small><span class="pv"><b class="num" data-k="place">1</b><em data-k="of">/5</em></span></div></div>
    <div class="rh-prog plate" data-k="prog"><div class="ph"><span data-t="mcd.progress"></span><b class="num" data-k="ppct">0%</b><span class="pt"><span data-t="mcd.points"></span> <b class="num" data-k="rpts">0</b></span></div>
      <div class="road"><i class="fill" data-k="pfill"></i>${I.flag().replace('<svg ', '<svg class="fin" ')}</div></div>
    <div class="rh-free plate">${I.burst}<div><small data-t="mcd.mode.free"></small><span data-t="mcd.freeHint"></span></div></div>
    <div class="rh-board">
      <div class="bd dm plate"><small data-t="mcd.damageCost"></small><b class="num" data-k="dval">$0</b></div>
      <div class="bd-btns"><button class="sq" data-k="reset" aria-label="reset">${I.undo}</button><button class="sq" data-k="pause" aria-label="pause">${I.pause}</button></div>
    </div>
    <aside class="rh-dmg plate" data-k="dmg">
      <div class="dm-h"><small data-t="mcd.damage"></small><em class="num" data-k="dpct">0%</em></div>
      <div class="dm-b">${car}<div class="dm-r"><div class="eng">${eng}<span class="es"><i></i><span data-k="dest"></span></span></div></div></div>
      <div class="led"><i data-k="dled" style="width:0"></i></div>
    </aside>
    <div class="rh-speed plate">
      <div class="sp-leds" data-k="spleds">${leds(MCD_SPEED_LEDS, 'rz')}</div>
      <div class="sp-num num"><b class="z">0</b><b class="z">0</b><b>0</b><small data-t="stm.kmh"></small></div>
      <div class="nit">${I.nitro}<div class="nl" data-k="nleds">${leds(MCD_NITRO_LEDS)}</div></div>
    </div>
  </div>
  <div class="rh-repair"><button class="btn y" data-k="repair">${I.wrenchBig}<span data-k="replabel"></span></button></div>
  <div class="count" data-k="count"><div class="lamps"><i></i><i></i><i></i></div><div class="cnum" data-k="cnum"></div></div>
  <div class="touch">
    ${pad('left', 'left', I.left)}${pad('right', 'right', I.right)}${pad('handbrake', 'hand', I.hand, 'mcd.hand')}${pad('brake', 'brake', I.brake, 'mcd.brake')}${pad('nitro', 'nitro', I.nitro, 'stm.nitro')}${pad('gas', 'gas', I.gas, 'mcd.gas')}
  </div>
</div>
<div class="crash" data-k="crash"><div class="cr-in" data-k="crin"><div class="cr-ser" data-k="crser"></div><div class="cr-t" data-k="crt"></div><div class="cr-v num" data-k="crv"></div><div class="cr-sum" data-k="crsum"></div></div></div>
<div class="msgs"><div class="rec"><i></i><b>REC</b><span data-t="mcd.slowmo"></span><em data-t="mcd.fps"></em></div><div class="toast" data-k="toast"></div><div class="pops" data-k="pops"></div></div>
<div class="modal" data-k="mpause"><div class="card plate">
  <h2 data-t="stm.paused"></h2>
  <button class="btn y big" data-k="resume" data-t="stm.resume"></button>
  <div class="row"><button class="btn" data-k="pcp" data-t="stm.toCp"></button><button class="btn" data-k="prestart" data-t="stm.restart"></button></div>
  <div class="row"><button class="btn" data-k="phow" data-t="stm.howto"></button><button class="btn" data-k="pmenu" data-t="stm.menu"></button></div>
  <div data-k="ptoggles"></div>
</div></div>
<div class="modal" data-k="msettings"><div class="card plate"><h2 data-t="stm.quality"></h2><div data-k="stoggles"></div>
  <div class="row"><button class="btn" data-k="shelp" data-t="stm.howto"></button><button class="btn y" data-k="sclose" data-t="stm.close"></button></div></div></div>
<div class="modal" data-k="mres"><div class="card rs paper" data-k="rescard"></div></div>
<div class="modal" data-k="mhelp"><div class="card plate">
  <h2 data-t="stm.howto"></h2><p data-t="stm.help.goal"></p>
  <div class="keys" data-k="hkeys"></div><p data-k="htouch" data-t="stm.help.touch"></p><p class="hc" data-t="mcd.help.crash"></p>
  <button class="btn y" data-k="hclose" data-t="stm.close"></button>
</div></div>
<div class="modal" data-k="mgift"><div class="card wide plate">
  <div class="hdr"><h2 data-k="gtitle"></h2><button class="sq" data-k="gclose" aria-label="close">${I.close}</button></div>
  <div class="days" data-k="gdays"></div>
  <div class="row"><button class="btn y big" data-k="gclaim"></button><button class="btn ad big" data-k="gx2"></button></div>
  <div class="ghint" data-k="ghint"></div>
</div></div>
<div class="modal" data-k="mwheel"><div class="card wide plate">
  <div class="hdr"><h2 data-k="wtitle"></h2><button class="sq" data-k="wclose" aria-label="close">${I.close}</button></div>
  <div class="wwrap">
    <div class="wbox"><div class="dwrap"><svg class="disk" data-k="wdisk" viewBox="-150 -150 300 300"></svg></div>${I.pointer}</div>
    <div class="wside"><div class="wres" data-k="wres"></div>
      <button class="btn y big" data-k="wfree"></button><button class="btn ad" data-k="wad"></button><div class="ghint" data-k="whint"></div></div>
  </div>
</div></div>
<div class="modal" data-k="mrec"><div class="card plate">
  <div class="hdr"><h2 data-t="stm.records"></h2><button class="sq" data-k="rclose" aria-label="close">${I.close}</button></div>
  <div class="lb" data-k="rlist"></div>
  <button class="btn y" data-k="rlogin" data-t="stm.login"></button>
</div></div>`;
    },

    // ---------------------------------------------------------------------------------------------
    // Трассы: журнал испытаний
    // ---------------------------------------------------------------------------------------------

    setPoints(n) {
        const s = mcdNum(n);
        if (this.el.pts && this.el.pts.textContent !== s) this.el.pts.textContent = s;
        if (this.el.pts2 && this.el.pts2.textContent !== s) this.el.pts2.textContent = s;
    },

    /** Кнопка «+N за рекламу»: state { show, enabled, label }. */
    setAd(state) {
        const b = /** @type {HTMLButtonElement} */ (this.el.ad);
        if (!b) return;
        b.style.display = state.show ? '' : 'none';
        b.disabled = !state.enabled;
        b.querySelector('.t').textContent = state.label;
    },

    /** Режим заезда: 'race' (соперники, финиш) или 'free' (свободный разгром, без финиша). */
    setMode(mode) {
        this.mode = mode === 'free' ? 'free' : 'race';
        this.root.classList.toggle('free', this.mode === 'free');
        this.root.querySelectorAll('.modesw [data-m]').forEach((b) => b.classList.toggle('on', /** @type {HTMLElement} */ (b).dataset.m === this.mode));
        this._layout();
    },

    _biome(it) { return MCD_BIOMES[it.biome] || MCD_BIOMES.proving; },

    /** Мини-схема трассы для строки журнала. */
    _mini(it) {
        const r = mcdRoutePath(it.path), c = this._biome(it).c;
        return `<svg viewBox="0 0 100 60" preserveAspectRatio="xMidYMid meet"><path d="${r.d}" fill="none" stroke="#0c0b08" stroke-width="7" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>`
            + `<path d="${r.d}" fill="none" stroke="${c}" stroke-width="3" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${r.a[0].toFixed(1)}" cy="${r.a[1].toFixed(1)}" r="4" fill="#ece6d2" stroke="#0c0b08" stroke-width="2"/></svg>`;
    },

    _rowHtml(it) {
        const bio = this._biome(it);
        const nm = it.name || (mcdT('stm.track') + ' ' + it.n);
        const km = it.km != null ? `${Number(it.km).toFixed(1)} ${mcdT('mcd.km')}` : mcdT('mcd.biome.' + (it.biome || 'proving'));
        const tag = it.done ? `<span class="st done">${MCD_ICONS.check}${it.place ? '#' + it.place : ''}</span>` : it.open ? '' : `<span class="st">${MCD_ICONS.lock}</span>`;
        return `<b class="no num">${mcdPad(it.n)}</b><span class="nm">${mcdEsc(nm)}</span><span class="sb">${MCD_ICONS[bio.ic]}${mcdEsc(km)}</span><span class="mini">${this._mini(it)}</span><span class="tg">${tag}</span>`;
    },

    /**
     * Журнал испытаний. model: { items: [{ id, n, name, desc, km, biome, path, diff, open, done, place, best, price, ads, seen, can, sel }],
     * points, info, action: { label, enabled }, adAction: { show, enabled, label }, mode: 'race' | 'free', scroll }.
     */
    renderLevels(model) {
        const g = this.el.grid;
        if (!g) return;
        const items = model.items || [];
        if (model.mode) this.setMode(model.mode);
        else if (!this.root.querySelector('.modesw .on')) this.setMode(this.mode);
        this.el.modesw.style.display = model.mode ? '' : 'none';
        const key = items.map((i) => i.id).join('|');
        const keep = g.scrollTop;
        if (this._rowsKey !== key) {
            g.innerHTML = '';
            for (const it of items) { const d = document.createElement('div'); d.dataset.id = it.id; g.appendChild(d); }
            this._rowsKey = key;
            g.scrollTop = keep;
        }
        items.forEach((it, i) => {
            const row = /** @type {HTMLElement} */ (g.children[i]);
            const cls = 'ent' + (it.open ? '' : ' lock') + (it.sel ? ' sel' : '') + (it.done ? ' done' : '') + (!it.open && !it.can ? ' cant' : '');
            if (row.className !== cls) row.className = cls;
            row.style.setProperty('--bc', this._biome(it).c);
            const html = this._rowHtml(it);
            if (/** @type {any} */ (row)._h !== html) { row.innerHTML = html; /** @type {any} */ (row)._h = html; }
        });
        this.el.lvcount.textContent = items.length ? `${items.filter((i) => i.done).length} / ${items.length}` : '';
        const sel = items.find((i) => i.sel) || items[0];
        if (sel) this._sheet(sel, items);
        this.setPoints(model.points);
        this.el.linfo.innerHTML = model.info || '';
        const go = /** @type {HTMLButtonElement} */ (this.el.lgo);
        go.innerHTML = (model.action && model.action.label) ? mcdEsc(model.action.label) : '';
        go.disabled = !(model.action && model.action.enabled);
        const ad = /** @type {HTMLButtonElement} */ (this.el.lad), a = model.adAction;
        ad.style.display = a && a.show ? '' : 'none';
        if (a && a.show) { ad.innerHTML = MCD_ICONS.play + '<span>' + mcdEsc(a.label) + '</span>'; ad.disabled = !a.enabled; }
        const selRow = /** @type {HTMLElement | null} */ (g.querySelector('.ent.sel'));
        if (selRow && model.scroll) selRow.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    },

    /** Лист испытания выбранной трассы: контур на миллиметровке, длина, сложность, рекорд, штамп или замок. */
    _sheet(it, items) {
        const sh = this.el.sheet, bio = this._biome(it);
        const fresh = this._sheetId !== it.id;
        this._sheetId = it.id;
        const r = mcdRoutePath(it.path);
        const nm = it.name || (mcdT('stm.track') + ' ' + it.n);
        const diff = Math.max(0, Math.min(5, it.diff || 0));
        const dots = Array.from({ length: 5 }, (_, i) => MCD_ICONS.roundel.replace('<svg ', `<svg class="${i < diff ? '' : 'off'}" `)).join('');
        const best = it.best != null && it.best !== 0 && it.best !== '' ? (typeof it.best === 'number' ? mcdMoney(it.best) : mcdEsc(it.best)) : '—';
        const sp = (svg, x, y, w) => svg.replace('<svg ', `<svg x="${(x - w / 2).toFixed(1)}" y="${(y - w / 2).toFixed(1)}" width="${w}" height="${w}" `);
        const route = `<svg class="route" viewBox="0 0 100 60" preserveAspectRatio="xMidYMid meet"><defs><mask id="mcdRm" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="60"><path class="draw" d="${r.d}" pathLength="1" fill="none" stroke="#fff" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/></mask></defs>`
            + `<g mask="url(#mcdRm)"><path class="k1" d="${r.d}" fill="none" stroke="#17140d" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>`
            + `<path class="k2" d="${r.d}" fill="none" stroke="#3b3626" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>`
            + `<path class="k3" d="${r.d}" fill="none" stroke="${bio.c}" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></g>`
            + sp(MCD_ICONS.roundel, r.a[0], r.a[1], 7.5) + sp(MCD_ICONS.flag().replace('currentColor', '#17140d'), r.b[0] + 2.4, r.b[1] - 2.6, 9) + '</svg>';
        let foot = '';
        if (!it.open) {
            const leds = it.ads ? `<span class="adleds">${Array.from({ length: Math.min(12, it.ads) }, (_, i) => `<i class="${i < (it.seen || 0) ? 'on' : ''}"></i>`).join('')}</span>` : '';
            foot = `<div class="sh-lock">${MCD_ICONS.lock}<span>${mcdT('stm.locked')}</span>${leds}<b>${MCD_ICONS.nut}${mcdNum(it.price || 0)}</b></div>`;
        }
        const stamp = it.done ? `<div class="sh-stamp"><span class="stamp ok slam">${it.place ? mcdT('stm.rPlace', { n: it.place }) : mcdT('stm.done')}</span></div>` : '';
        sh.style.setProperty('--bc', bio.c);
        sh.classList.toggle('fresh', fresh);
        sh.innerHTML = `<div class="sh-hd"><span>${mcdT('mcd.trackNo', { n: mcdPad(it.n) })}</span><span class="sh-bio">${MCD_ICONS[bio.ic]}${mcdT('mcd.biome.' + (it.biome || 'proving'))}</span></div>`
            + `<h2 class="sh-name stencil">${mcdEsc(nm)}</h2>`
            + `<div class="sh-map">${route}<span class="scale">${mcdT('mcd.scheme')}</span>${it.km != null ? `<span class="km">${Number(it.km).toFixed(1)} ${mcdT('mcd.km')}</span>` : ''}</div>`
            + (it.desc ? `<p class="sh-desc">${mcdEsc(it.desc)}</p>` : '')
            + `<div class="sh-grid"><div><dt>${mcdT('mcd.difficulty')}</dt><dd>${dots}</dd></div><div><dt>${mcdT('mcd.best')}</dt><dd class="num">${best}</dd></div>`
            + `<div><dt>${mcdT('mcd.status')}</dt><dd>${it.done ? mcdT('stm.done') : it.open ? mcdT('mcd.open') : mcdT('stm.locked')}</dd></div></div>${stamp}${foot}<div class="sh-stripe"></div>`;
        void items;
    },

    // ---------------------------------------------------------------------------------------------
    // Гараж-бокс
    // ---------------------------------------------------------------------------------------------

    /**
     * Табличка машины. model: { name, cls, bars: { speed, accel, grip, air, durability }, open, lockText, adProgress, index, total,
     * go: { label, enabled, ad }, paints }. bars.durability (0..1) — «прочность»; нет поля — строка не рисуется.
     */
    renderGarage(model) {
        const fresh = this._garKey !== model.name;
        this._garKey = model.name;
        this.el.gname.textContent = model.name;
        this.el.gcl.textContent = model.cls;
        this.el.gbox.textContent = '№ ' + mcdPad((model.index || 0) + 1);
        const b = model.bars || {};
        const dur = b.durability != null ? b.durability : b.armor != null ? b.armor : b.strength;
        const rows = [['speed', b.speed], ['accel', b.accel], ['grip', b.grip], ['air', b.air]];
        const row = (k, v, cls) => `<div class="stat ${cls || ''}"><span>${cls === 'dur' ? MCD_ICONS.shield : ''}${mcdT(k === 'durability' ? 'mcd.durability' : 'stm.' + k)}</span><div class="led"><i data-w="${Math.round(mcdClamp01(v) * 100)}" style="width:${fresh ? 0 : Math.round(mcdClamp01(v) * 100)}%"></i></div><b class="num">${Math.round(mcdClamp01(v) * 10)}</b></div>`;
        this.el.gstats.innerHTML = rows.map((x) => row(x[0], x[1] || 0)).join('') + (dur != null ? row('durability', dur, 'dur') : '');
        if (fresh) setTimeout(() => this.el.gstats.querySelectorAll('i[data-w]').forEach((e) => { /** @type {HTMLElement} */ (e).style.width = /** @type {HTMLElement} */ (e).dataset.w + '%'; }), 40);
        this.el.glock.className = 'lk' + (model.open ? ' ok' : '');
        this.el.glock.innerHTML = model.open ? MCD_ICONS.check + '<span>' + mcdT('stm.carFree') + '</span>'
            : `${MCD_ICONS.lock}<span>${mcdEsc(model.lockText)}</span><i class="adbar"><b style="width:${Math.round((model.adProgress || 0) * 100)}%"></b></i>`;
        this.el.gdots.innerHTML = Array.from({ length: model.total }, (_, i) => `<i class="${i === model.index ? 'on' : ''}"></i>`).join('');
        const go = /** @type {HTMLButtonElement} */ (this.el.ggo);
        go.className = 'btn big ' + (model.go.ad ? 'ad' : 'y');
        go.innerHTML = (model.go.ad ? MCD_ICONS.play : '') + '<span>' + mcdEsc(model.go.label) + '</span>';
        go.disabled = !model.go.enabled;
        const ps = model.paints || [], cur = ps.find((p) => p.sel);
        this.el.gpaints.innerHTML = ps.length ? `<span class="pl">${mcdT('stm.paint')}: ${mcdEsc(cur ? cur.name : '')}</span>`
            + ps.map((p) => `<button data-p="${mcdEsc(p.id)}" class="${p.sel ? 'sel' : ''}${p.owned ? '' : ' lock'}" style="background:${mcdEsc(p.color)}" title="${mcdEsc(p.name)}" aria-label="${mcdEsc(p.name)}"></button>`).join('') : '';
        if (fresh && this.el.gname.animate) this.el.gname.animate([{ transform: 'translateX(-14px)', opacity: 0 }, { transform: 'translateX(3px)', opacity: 1, offset: 0.55 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: 'steps(6)' });
    },

    // ---------------------------------------------------------------------------------------------
    // Меню: подарок дня, колесо фортуны, рекорды
    // ---------------------------------------------------------------------------------------------

    _num(n) { return mcdNum(n); },

    /** Красные точки на кнопках меню: { gift, wheel } — подарок можно забрать, бесплатное вращение готово. */
    setBadges(b) {
        this.el.gift.classList.toggle('badge', !!b.gift);
        this.el.wheel.classList.toggle('badge', !!b.wheel);
    },

    /** Кнопка «Рекорды» (только там, где есть лидерборд площадки). */
    setRecords(on) { this.el.rec.style.display = on ? '' : 'none'; },

    isOpen(k) { return !!(this.el[k] && this.el[k].classList.contains('on')); },

    close(k) {
        if (!this.isOpen(k)) return;
        this.el[k].classList.remove('on');
        if (this.h.onClosed) this.h.onClosed(k);
    },

    /** P или Tab: закрыть верхнее окно меню (рекорды, подарок, колесо, «Как играть», настройки). true — закрыто. */
    closeTop() {
        for (const k of ['mrec', 'mgift', 'mwheel', 'mhelp', 'msettings']) {
            if (!this.isOpen(k)) continue;
            if (k === 'mhelp') this.help(false);
            else if (k === 'msettings') this.settings(false);
            else this.close(k);
            return true;
        }
        return false;
    },

    /**
     * Окно подарка дня (null — закрыть). m: { days: [{ dayLabel, state, d7, kind: 'points' | 'car' | 'paint', amount, carToo,
     * color, title, tag, hint }], claim: { show, enabled, label }, x2: { show, enabled, label }, hint }.
     */
    gift(m) {
        if (!m) { this.close('mgift'); return; }
        this.el.gtitle.innerHTML = mcdT('stm.giftTitle');
        const icon = (d) => (d.kind === 'paint' ? MCD_ICONS.car(d.color) : d.kind === 'car' ? MCD_ICONS.car('') : MCD_ICONS.nut);
        this.el.gdays.innerHTML = m.days.map((d) => (d.d7
            ? `<div class="day d7 ${d.state}"><div class="di">${icon(d)}</div><div class="dt"><span class="dn">${d.dayLabel}</span>${d.tag ? `<span class="ex">${d.tag}</span>` : ''}<span class="dv">${d.title}</span><span class="dh">${d.hint}</span></div></div>`
            : `<div class="day ${d.state}"><span class="dn">${d.dayLabel}</span><div class="di">${icon(d)}</div><span class="dv num">${mcdNum(d.amount)}<small>${d.carToo ? mcdT('stm.plusCar') : mcdT('stm.pts')}</small></span></div>`)).join('');
        const c = /** @type {HTMLButtonElement} */ (this.el.gclaim), x = /** @type {HTMLButtonElement} */ (this.el.gx2);
        c.style.display = m.claim.show ? '' : 'none'; c.disabled = !m.claim.enabled; c.innerHTML = '<span>' + mcdEsc(m.claim.label) + '</span>';
        x.style.display = m.x2.show ? '' : 'none'; x.disabled = !m.x2.enabled; x.innerHTML = MCD_ICONS.play + '<span>' + mcdEsc(m.x2.label) + '</span>';
        this.el.ghint.textContent = m.hint || '';
        this.el.mgift.classList.add('on');
    },

    /**
     * Окно колеса (null — закрыть). m: { sectors: [{ kind: 'coins' | 'item', coins }], angle, spinning,
     * free: { enabled, label }, ad: { show, enabled, label }, hint }.
     */
    wheel(m) {
        if (!m) { this.close('mwheel'); return; }
        this.el.wtitle.innerHTML = mcdT('stm.wheelTitle');
        this._drawDisk(m.sectors);
        if (!m.spinning) this.wheelSpin(m.angle, 0);
        const f = /** @type {HTMLButtonElement} */ (this.el.wfree), a = /** @type {HTMLButtonElement} */ (this.el.wad);
        f.disabled = !m.free.enabled; f.innerHTML = '<span>' + mcdEsc(m.free.label) + '</span>';
        a.style.display = m.ad.show ? '' : 'none'; a.disabled = !m.ad.enabled; a.innerHTML = MCD_ICONS.play + '<span>' + mcdEsc(m.ad.label) + '</span>';
        this.el.whint.textContent = m.hint || '';
        if (!this.isOpen('mwheel')) this.el.wres.textContent = '';
        this.el.mwheel.classList.add('on');
    },

    /** Диск колеса: секторы равны, сектор 0 — под стрелкой сверху, дальше по часовой (как Wheel.js). */
    _drawDisk(sectors) {
        const key = sectors.map(x => x.kind + x.coins).join(',') + Lang.code;
        if (this._diskKey === key) return;
        this._diskKey = key;
        const n = sectors.length, step = 360 / n, R = 140;
        const pt = (deg, r) => { const a = deg * Math.PI / 180; return (Math.sin(a) * r).toFixed(2) + ' ' + (-Math.cos(a) * r).toFixed(2); };
        let out = '<circle r="149" fill="#0c0b08"/>';
        sectors.forEach((sc, i) => {
            const hot = sc.kind === 'item' || sc.coins >= 2500;
            out += `<path d="M0 0L${pt(i * step - step / 2, R)}A${R} ${R} 0 0 1 ${pt(i * step + step / 2, R)}Z" fill="${hot ? '#ffc400' : i % 2 ? '#2a261b' : '#1d1a13'}" stroke="#0c0b08" stroke-width="2"/>`;
            const ink = hot ? '#14120d' : '#ece6d2';
            const body = sc.kind === 'item'
                ? MCD_ICONS.car('#14120d').replace('<svg ', '<svg x="-24" y="-128" width="48" height="27" ') + `<text y="-72" text-anchor="middle" font-size="15" font-weight="900" fill="${ink}">${mcdT('stm.carPrize').toUpperCase()}</text>`
                : `<text y="-98" text-anchor="middle" font-size="27" font-weight="900" fill="${ink}">${mcdNum(sc.coins)}</text><text y="-80" text-anchor="middle" font-size="12" font-weight="800" fill="${hot ? '#14120d' : '#ffc400'}">${mcdT('stm.pts').toUpperCase()}</text>`;
            out += `<g transform="rotate(${i * step})">${body}</g>`;
        });
        out += `<circle r="${R}" fill="none" stroke="#ffc400" stroke-width="6"/>`;
        for (let i = 0; i < n; i++) out += `<circle transform="translate(${pt(i * step - step / 2, R)})" r="4" fill="#ece6d2"/>`;
        out += '<circle r="29" fill="#14120d" stroke="#ffc400" stroke-width="4"/><path d="M0 0V-26A26 26 0 0 1 26 0ZM0 0V26A26 26 0 0 1-26 0Z" fill="#ffc400"/><circle r="6" fill="#14120d"/>';
        this.el.wdisk.innerHTML = out;
    },

    /** Повернуть диск до angle градусов (по часовой) за ms; 0 — сразу. */
    wheelSpin(angle, ms) {
        const d = this.el.wdisk;
        d.style.transition = ms ? `transform ${ms}ms cubic-bezier(.12,.62,.1,1)` : 'none';
        d.style.transform = `rotate(${angle}deg)`;
        if (ms) this.el.wres.textContent = '';
    },

    wheelResult(text) {
        const r = this.el.wres;
        r.textContent = text;
        r.classList.remove('pop'); void r.offsetWidth; r.classList.add('pop');
        this._sfx('crash-thud-1.ogg', 0.5);
    },

    /** Окно рекордов: { loading } или { list: [{ rank, name, score, me, avatar? }], canLogin }. */
    records(m) {
        const list = m.list || [];
        this.el.rlist.innerHTML = m.loading ? `<div class="lb-empty">${mcdT('stm.wait')}</div>`
            : !list.length ? `<div class="lb-empty">${mcdT('stm.noRecords')}</div>`
                : list.map((r) => `<div class="lrow${r.me ? ' me' : ''}${r.rank <= 3 ? ' top' : ''}"><span class="rk">${mcdEsc(r.rank)}</span>`
                    + (r.avatar ? `<img class="av" src="${mcdEsc(r.avatar)}" alt="">` : `<span class="av">${mcdEsc(String(r.name || '?').slice(0, 1).toUpperCase())}</span>`)
                    + `<span class="nm">${mcdEsc(r.name || '—')}</span><span class="sc num">${mcdNum(Number(r.score) || 0)}</span></div>`).join('');
        this.el.rlogin.style.display = !m.loading && m.canLogin ? '' : 'none';
        this.el.mrec.classList.add('on');
    },

    // ---------------------------------------------------------------------------------------------
    // Заезд
    // ---------------------------------------------------------------------------------------------

    /** Ссылки на элементы, которые обновляются каждый кадр (чтобы не искать их в DOM). */
    _cacheRace() {
        const r = this.root;
        this._sd = /** @type {HTMLElement[]} */ ([...r.querySelectorAll('.sp-num b')]);
        this._spLeds = /** @type {HTMLElement[]} */ ([...this.el.spleds.children]);
        this._nLeds = /** @type {HTMLElement[]} */ ([...this.el.nleds.children]);
        for (const z of /** @type {SVGElement[]} */ ([...r.querySelectorAll('.car .z')])) this._zEl[/** @type {any} */ (z).dataset.z] = z;
        this._wEl = /** @type {SVGElement[]} */ ([...r.querySelectorAll('.car .w')]);
        this._engG = /** @type {any} */ (r.querySelector('.eg'));
        for (const k of ['front', 'rear', 'left', 'right', 'roof']) { this._zq[k] = -1; this._zb[k] = { v: 0, t: 0 }; }
        this.setDamage({ total: 0, zones: {}, wheels: [0, 0, 0, 0], engine: 0, state: 'ok' });
        this.setSpeed(0, 1, false);
        this.setMode('race');
        this.setRace(1, 1);
    },

    setRace(place, total) {
        if (place === this._place && total === this._total) return;
        const better = this._place && place < this._place, worse = this._place && place > this._place;
        this._place = place; this._total = total;
        this.el.place.textContent = String(place);
        this.el.of.textContent = '/' + total;
        const b = this.el.place;
        if ((better || worse) && b.animate) b.animate([{ transform: 'scale(1.7)', color: better ? '#55d476' : '#e5392d' }, { transform: 'scale(1)', color: '#ece6d2' }], { duration: 380, easing: 'steps(5)' });
    },

    setRunPoints(n) {
        const v = Math.floor(n);
        if (v === this._pts) return;
        this._pts = v;
        this.el.rpts.textContent = mcdNum(v);
    },

    /** Суммарный ущерб заезда ($) на счётчике HUD. */
    setDamageValue(n) {
        const v = Math.max(0, Math.floor(Number(n) || 0));
        if (v === this._dv) return;
        const up = v > this._dv;
        this._dv = v;
        this.el.dval.textContent = mcdMoney(v);
        const now = performance.now();
        if (up && now - this._dvT > 110 && this.el.dval.animate) {
            this._dvT = now;
            this.el.dval.animate([{ transform: 'scale(1.22)', color: '#ffffff' }, { transform: 'scale(1)', color: '#ffc400' }], { duration: 220, easing: 'steps(4)' });
        }
    },

    setSpeed(kmh, nitro, nitroOn) {
        const v = Math.max(0, Math.round(kmh));
        if (v !== this._spd) {
            this._spd = v;
            const txt = String(Math.min(999, v)), s = txt.padStart(3, '0');
            for (let i = 0; i < 3; i++) {
                const d = this._sd[i];
                if (d.textContent !== s[i]) d.textContent = s[i];
                d.classList.toggle('z', i < 3 - txt.length);
            }
            const lit = Math.min(MCD_SPEED_LEDS, Math.round(v / MCD_SPEED_MAX * MCD_SPEED_LEDS));
            if (lit !== this._spLit) {
                const a = Math.min(lit, this._spLit), b = Math.max(lit, this._spLit);
                for (let i = a; i < b; i++) this._spLeds[i].classList.toggle('on', lit > this._spLit);
                this._spLit = lit;
            }
        }
        const nl = Math.round(mcdClamp01(nitro) * MCD_NITRO_LEDS);
        if (nl !== this._nLit) {
            for (let i = 0; i < MCD_NITRO_LEDS; i++) this._nLeds[i].classList.toggle('on', i < nl);
            this._nLit = nl;
        }
        const on = !!nitroOn;
        if (on !== this._nOn) { this._nOn = on; this.root.classList.toggle('nitro-on', on); }
    },

    /** Прогресс: me 0..1, ticks — доли чекпоинтов, rivals — доли ботов. */
    setProgress(me, ticks, rivals) {
        const p = this.el.prog, road = /** @type {HTMLElement} */ (p.querySelector('.road'));
        const m = Math.round(mcdClamp01(me) * 1000);
        const rv = rivals.map((r) => Math.round(mcdClamp01(r) * 1000));
        if (m === this._pgMe && rv.length === this._pgRival.length && rv.every((x, i) => x === this._pgRival[i]) && String(ticks.length) === p.dataset.ticks) return;
        if (m !== this._pgMe) {
            this._pgMe = m;
            this.el.pfill.style.width = (m / 10).toFixed(1) + '%';
            this.el.ppct.textContent = Math.round(m / 10) + '%';
        }
        if (p.dataset.ticks !== String(ticks.length)) {
            road.querySelectorAll('.tick').forEach(n => n.remove());
            for (const t of ticks) { const n = document.createElement('i'); n.className = 'tick'; n.style.left = (t * 100) + '%'; road.appendChild(n); }
            p.dataset.ticks = String(ticks.length);
        }
        let dots = road.querySelectorAll('.dot:not(.me)');
        if (dots.length !== rivals.length || !road.querySelector('.dot.me')) {
            road.querySelectorAll('.dot').forEach(n => n.remove());
            for (let i = 0; i < rivals.length; i++) { const n = document.createElement('i'); n.className = 'dot'; road.appendChild(n); }
            const me2 = document.createElement('i'); me2.className = 'dot me'; road.appendChild(me2);
            dots = road.querySelectorAll('.dot:not(.me)');
        }
        rv.forEach((r, i) => { /** @type {HTMLElement} */ (dots[i]).style.left = (r / 10).toFixed(1) + '%'; });
        this._pgRival = rv;
        /** @type {HTMLElement} */ (road.querySelector('.dot.me')).style.left = (m / 10).toFixed(1) + '%';
    },

    /**
     * Панель повреждений: { total, zones: { front, rear, left, right, roof }, wheels: [rl, rr, fl, fr], engine, state: 'ok' | 'smoke' | 'fire' | 'dead' }.
     * Зоны и общий процент 0..1 (0 — чисто), колесо 1 — потеряно. Вызывается каждый кадр: DOM меняется только при заметных сдвигах.
     */
    setDamage(m) {
        if (!m) return;
        const now = performance.now(), Z = m.zones || {};
        let jump = false;
        for (const k of ['front', 'rear', 'left', 'right', 'roof']) {
            const raw = mcdClamp01(Number(Z[k]) || 0), b = this._zb[k];
            if (now - b.t > 240) { b.v = raw; b.t = now; }
            const q = Math.round(raw * MCD_ZONE_STEPS);
            if (q === this._zq[k]) continue;
            this._zq[k] = q;
            const el = this._zEl[k], col = mcdHeat(raw);
            el.style.fill = col;
            if (raw - b.v >= MCD_ZONE_JUMP) {
                jump = true; b.v = raw; b.t = now;
                if (el.animate) el.animate([{ fill: '#ffffff', strokeWidth: '3.6px' }, { fill: '#fff3b0', offset: 0.35 }, { fill: col, strokeWidth: '1.6px' }], { duration: 420, easing: 'steps(6)' });
            }
        }
        const W = m.wheels || [];
        for (let i = 0; i < 4; i++) {
            const v = mcdClamp01(Number(W[i]) || 0), q = Math.round(v * 8) + (v >= MCD_WHEEL_LOST ? 100 : 0);
            if (q === this._wq[i]) continue;
            this._wq[i] = q;
            const el = this._wEl[i], lost = v >= MCD_WHEEL_LOST;
            el.classList.toggle('lost', lost);
            el.style.fill = lost ? 'none' : v < 0.04 ? '#34302a' : mcdHeat(0.25 + v * 0.75);
            if (lost && el.animate) { jump = true; el.animate([{ opacity: 1, fill: '#fff' }, { opacity: 0.2 }, { opacity: 1 }], { duration: 360, easing: 'steps(5)' }); }
        }
        const eq = Math.round(mcdClamp01(Number(m.engine) || 0) * 16);
        if (eq !== this._eq) { this._eq = eq; this._engG.style.color = mcdHeat(eq / 16); }
        const st = m.state === 'smoke' || m.state === 'fire' || m.state === 'dead' ? m.state : 'ok';
        if (st !== this._dstate) {
            this._dstate = st;
            const d = this.el.dmg;
            d.classList.remove('st-smoke', 'st-fire', 'st-dead');
            if (st !== 'ok') d.classList.add('st-' + st);
            this.el.dest.textContent = mcdT('mcd.eng.' + st);
            if (st === 'fire' || st === 'dead') jump = true;
        }
        const pct = Math.round(mcdClamp01(Number(m.total) || 0) * 100);
        if (pct !== this._dpct) {
            this._dpct = pct;
            this.el.dpct.textContent = pct + '%';
            this.el.dled.style.width = pct + '%';
        }
        if (jump && now - this._shakeT > MCD_SHAKE_GAP_MS) {
            this._shakeT = now;
            const d = this.el.dmg;
            if (d.animate) d.animate([{ transform: 'translate(0,0)' }, { transform: 'translate(-4px,2px)' }, { transform: 'translate(4px,-3px)' }, { transform: 'translate(-3px,-1px)' }, { transform: 'translate(2px,2px)' }, { transform: 'translate(0,0)' }], { duration: 300, easing: 'steps(6)' });
        }
    },

    /** Кнопка «Вернуться на дорогу и починиться»: { show, label }. Колбэк — onReset (подсказка клавиши R видна на ПК). */
    setRepair(m) {
        const show = !!(m && m.show);
        if (m && m.label != null) this.el.replabel.textContent = m.label;
        else if (!this.el.replabel.textContent) this.el.replabel.textContent = mcdT('mcd.repair');
        if (show !== this._repair) { this._repair = show; this.root.classList.toggle('repair', show); }
    },

    /** Замедленная съёмка: чёрные полосы кадра, виньетка, плашка REC. */
    slowmo(on) { this.root.classList.toggle('slowmo', !!on); },

    /**
     * Всплывающий счёт удара: { title: 'ЛОБОВОЙ УДАР', value: ущерб $, power: 0..1 }. Удары подряд (< MCD_SERIES_MS) складываются в серию.
     */
    crash(m) {
        if (!m) return;
        const now = performance.now();
        const value = Math.max(0, Math.round(Number(m.value) || 0)), power = mcdClamp01(Number(m.power) || 0);
        if (now - this._crT < MCD_SERIES_MS && this._crN > 0) { this._crN++; this._crSum += value; } else { this._crN = 1; this._crSum = value; }
        this._crT = now;
        const n = this._crN, heavy = power > 0.62 || n >= 4;
        const scale = MCD_CRASH_MIN_SCALE + (MCD_CRASH_MAX_SCALE - MCD_CRASH_MIN_SCALE) * power + Math.min(4, n - 1) * 0.03;
        const cin = this.el.crin;
        cin.style.setProperty('--cs', scale.toFixed(3));
        this.el.crt.textContent = String(m.title || '');
        this.el.crt.style.background = n >= 5 ? '#e5392d' : heavy ? '#ff7a1a' : '';
        this.el.crt.style.color = n >= 5 ? '#fff' : '';
        this.el.crv.textContent = '−' + mcdMoney(value);
        this.el.crv.classList.toggle('hot', heavy);
        this.el.crser.classList.toggle('on', n > 1);
        this.el.crser.innerHTML = n > 1 ? mcdT('mcd.series', { n: '<b>' + n + '</b>' }) : '';
        this.el.crsum.classList.toggle('on', n > 1);
        this.el.crsum.innerHTML = n > 1 ? mcdT('mcd.seriesTotal') + ' <b>' + mcdMoney(this._crSum) + '</b>' : '';
        this.el.crash.classList.add('on');
        const hold = MCD_CRASH_HOLD_MS + power * 550, amp = 4 + power * 14, first = n === 1;
        clearTimeout(this._crTimer);
        if (this._crAnim) { try { this._crAnim.cancel(); } catch (e) { /* уже снята */ } }
        if (cin.animate) {
            const s0 = first ? 2.5 : 1.7;
            const anim = cin.animate([
                { transform: `scale(${s0}) rotate(-6deg)`, opacity: 0 },
                { transform: 'scale(.9) rotate(-1.5deg)', opacity: 1, offset: 0.13 },
                { transform: `translate(${amp}px,${-amp * 0.4}px) scale(1.07) rotate(1deg)`, offset: 0.2 },
                { transform: `translate(${-amp * 0.85}px,${amp * 0.3}px) scale(1)`, offset: 0.27 },
                { transform: `translate(${amp * 0.45}px,${amp * 0.1}px) scale(1)`, offset: 0.34 },
                { transform: `translate(${-amp * 0.2}px,0) scale(1)`, offset: 0.41 },
                { transform: 'translate(0,0) scale(1)', opacity: 1, offset: 0.48 },
                { transform: 'translate(0,0) scale(1)', opacity: 1, offset: 0.86 },
                { transform: 'translate(0,-20px) scale(.95)', opacity: 0 },
            ], { duration: hold, easing: 'linear' });
            this._crAnim = anim;
            anim.onfinish = () => { if (this._crAnim === anim) this.el.crash.classList.remove('on'); };
        } else this._crTimer = setTimeout(() => this.el.crash.classList.remove('on'), hold);
        if (power > 0.5 && this.el.hitfx.animate) this.el.hitfx.animate([{ opacity: 0.35 + power * 0.5 }, { opacity: 0 }], { duration: 340, easing: 'steps(5)' });
    },

    /** Всплывающий трюк: «САЛЬТО +60». */
    pop(text, pts) {
        const box = this.el.pops;
        if (!box) return;
        const n = document.createElement('div');
        n.className = 'pop';
        n.innerHTML = text + (pts ? `<em>+${pts}</em>` : '');
        box.appendChild(n);
        while (box.childElementCount > MCD_POP_MAX) box.firstChild.remove();
        setTimeout(() => n.remove(), MCD_POP_MS);
    },

    /** Отсчёт: 3, 2, 1, 'go' или null — убрать. Старт-огни как на стенде. */
    count(v) {
        const c = this.el.count;
        c.classList.remove('on', 'go');
        if (v == null) return;
        const lamps = c.querySelectorAll('.lamps i');
        const num = v === 'go' ? 3 : Math.max(1, Math.min(3, Number(v) || 1));
        lamps.forEach((l, i) => { l.className = v === 'go' ? 'g' : i < 4 - num ? 'r' : ''; });
        this.el.cnum.textContent = v === 'go' ? mcdT('stm.go') : String(v);
        c.classList.add('on');
        if (v === 'go') c.classList.add('go');
        if (this.el.cnum.animate) this.el.cnum.animate([{ transform: 'scale(2.3)', opacity: 0 }, { transform: 'scale(.9)', opacity: 1, offset: 0.28 }, { transform: 'scale(1)', opacity: 1 }], { duration: 340, easing: 'cubic-bezier(.2,1.2,.4,1)' });
    },

    toast(text, ms) {
        const t = this.el.toast;
        t.textContent = text;
        t.classList.remove('on'); void t.offsetWidth; t.classList.add('on');
        clearTimeout(this._toastT);
        this._toastT = setTimeout(() => t.classList.remove('on'), ms || 1800);
    },

    // ---------------------------------------------------------------------------------------------
    // Окна
    // ---------------------------------------------------------------------------------------------

    _toggles(box, opts) {
        const sw = (a, on, txt) => `<button class="sw${on ? ' on' : ''}" data-a="${a}"><i></i>${txt}</button>`;
        const q = opts.quality;
        box.innerHTML = `<div class="tgl"><span>${mcdT('stm.sound')}</span>${sw('sfx', opts.sfx, mcdT(opts.sfx ? 'mcd.on' : 'mcd.off'))}</div>
<div class="tgl"><span>${mcdT('stm.music')}</span>${sw('music', opts.music, mcdT(opts.music ? 'mcd.on' : 'mcd.off'))}</div>
<div class="tgl"><span>${mcdT('stm.quality')}</span>${sw('quality', true, mcdT('stm.q.' + q))}</div>`;
        box.querySelectorAll('button').forEach((b) => b.addEventListener('click', (e) => {
            e.stopPropagation(); this.click();
            if (this.h.onToggle) this.h.onToggle(/** @type {HTMLElement} */ (b).dataset.a);
        }));
    },

    pause(on, opts) {
        this.el.mpause.classList.toggle('on', !!on);
        if (on && opts) this._toggles(this.el.ptoggles, opts);
    },

    settings(on, opts) {
        this.el.msettings.classList.toggle('on', !!on);
        if (on) this._toggles(this.el.stoggles, opts || (this.h.toggleState ? this.h.toggleState() : { sfx: true, music: true, quality: 'auto' }));
    },

    refreshToggles(opts) {
        if (this.el.mpause.classList.contains('on')) this._toggles(this.el.ptoggles, opts);
        if (this.el.msettings.classList.contains('on')) this._toggles(this.el.stoggles, opts);
    },

    help(on) {
        this.el.mhelp.classList.toggle('on', !!on);
        if (!on) { if (this.h.onHelpClosed) this.h.onHelpClosed(); return; }
        const k = (...keys) => `<span class="kc">${keys.map(x => `<kbd>${x}</kbd>`).join('')}</span>`;
        const ru = Lang.code !== 'en';
        this.el.hkeys.innerHTML = [
            [k('W', 'S', '↑', '↓'), mcdT('stm.help.drive')], [k('A', 'D', '←', '→'), mcdT('stm.help.steer')],
            [k('Shift'), mcdT('stm.help.nitro')], [k(ru ? 'Пробел' : 'Space'), mcdT('stm.help.hand')],
            [k('P', 'Tab'), mcdT('stm.help.pause')],
            ].map(([a, b]) => `<div>${a}</div><div>${b}</div>`).join('');
    },

    /**
     * «Протокол испытания». data: { place, total, track, stunts, bonus, sum, hasNext, damage ($), peak ($), lost (деталей), wrecked,
     * mode: 'race' | 'free', time? (сек) }; on: { next, again, garage, levels }.
     */
    results(data, on) {
        this._clearRs();
        const c = this.el.rescard;
        const mode = data.mode || this.mode, free = mode === 'free', wrecked = !!data.wrecked;
        const place = Math.max(1, Number(data.place) || 1), total = Math.max(1, Number(data.total) || 1);
        const no = mcdPad(1000 + ((Math.floor(data.damage || 0) + Math.floor(data.sum || 0) + place * 37) % 9000), 4);
        const rows = [];
        const add = (cls, key, val, count, fmt) => rows.push({ cls, key, val, count, fmt });
        if (data.time != null && !free) add('', 'mcd.rTime', mcdTime(data.time));
        add(wrecked ? 'hot' : '', 'mcd.rDamage', mcdMoney(data.damage || 0), data.damage || 0, 'money');
        add('', 'mcd.rLost', String(data.lost || 0), data.lost || 0, 'int');
        add('', 'mcd.rPeak', mcdMoney(data.peak || 0), data.peak || 0, 'money');
        if (!free) add('sm', 'stm.rTrack', '+' + mcdNum(data.track || 0), data.track || 0, 'plus');
        add('sm', 'stm.rStunts', '+' + mcdNum(data.stunts || 0), data.stunts || 0, 'plus');
        if (!free) add('sm', 'mcd.rPlaceBonus', '+' + mcdNum(data.bonus || 0), data.bonus || 0, 'plus');
        add('tot', 'mcd.rTotal', '+' + mcdNum(data.sum || 0), data.sum || 0, 'plus');
        const stampKey = wrecked ? 'mcd.stamp.wreck' : free ? 'mcd.stamp.free' : place <= 3 ? 'mcd.stamp.place' : 'mcd.stamp.pass';
        const bad = wrecked || free;
        const left = free ? `<div class="rs-place free"><small>${mcdT('mcd.mode')}</small><b>${mcdT('mcd.mode.free')}</b></div>`
            : `<div class="rs-place p${place}"><small>${mcdT('stm.place')}</small><b class="num">${place}</b><em>${mcdT('mcd.of', { n: total })}</em></div>`;
        c.className = 'card rs paper';
        c.style.setProperty('--rowms', MCD_ROW_MS + 'ms');
        c.innerHTML = `<div class="rs-hd"><span class="t">${mcdT('mcd.protocol')}</span><span class="no">${mcdT('mcd.no', { n: no })}</span></div>
<div class="rs-body"><div>${left}<div class="rs-stamp"><span class="stamp${bad ? '' : ' ok'}">${mcdT(stampKey, { n: place })}</span></div></div>
<div class="rs-rows">${rows.map((r, i) => `<div class="rw ${r.cls}" style="--i:${i}"><span class="k">${mcdT(r.key)}</span><i></i><b class="num"${r.count != null ? ` data-count="${Math.floor(r.count)}" data-fmt="${r.fmt}"` : ''}>${r.count != null ? '' : r.val}</b></div>`).join('')}</div></div>
<div class="rs-btns">${data.hasNext ? `<button class="btn y big" data-r="next">${mcdT('stm.nextLevel')}</button>` : `<button class="btn y big" data-r="levels">${mcdT('stm.toLevels')}</button>`}
<div class="row"><button class="btn" data-r="again">${mcdT('stm.again')}</button><button class="btn" data-r="garage">${mcdT('stm.garage')}</button>${data.hasNext ? `<button class="btn" data-r="levels">${mcdT('stm.toLevels')}</button>` : ''}</div></div>`;
        c.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); this.click(); const fn = on && on[/** @type {HTMLElement} */ (b).dataset.r]; if (fn) fn(); }));
        this.el.mres.classList.add('on');
        // цифры набираются по строкам; штамп ложится после последней строки
        const fmt = { money: mcdMoney, int: (v) => String(Math.floor(v)), plus: (v) => '+' + mcdNum(v) };
        c.querySelectorAll('[data-count]').forEach((e) => {
            const el = /** @type {HTMLElement} */ (e), to = Number(el.dataset.count), f = fmt[el.dataset.fmt] || fmt.int, i = Number(/** @type {HTMLElement} */ (el.parentElement).style.getPropertyValue('--i'));
            el.textContent = f(0);
            this._rsT.push(setTimeout(() => this._tween(el, to, MCD_COUNT_UP_MS, f), 300 + i * MCD_ROW_MS));
        });
        const at = Math.max(MCD_STAMP_MS, 300 + rows.length * MCD_ROW_MS + 380);
        this._rsT.push(setTimeout(() => {
            c.classList.add('stamped');
            this._sfx(bad ? 'crash-hit-heavy-1.ogg' : 'crash-thud-2.ogg', 0.7);
            if (c.animate) c.animate([{ transform: 'translate(0,0)' }, { transform: 'translate(-5px,4px)' }, { transform: 'translate(5px,-3px)' }, { transform: 'translate(-3px,-2px)' }, { transform: 'translate(2px,1px)' }, { transform: 'translate(0,0)' }], { duration: 300, delay: 120, easing: 'steps(6)' });
        }, at));
    },

    /** Набор числа от нуля до значения (только пока открыт протокол). */
    _tween(el, to, ms, f) {
        const t0 = performance.now();
        const step = (now) => {
            const k = Math.min(1, (now - t0) / ms);
            el.textContent = f(to * (1 - Math.pow(1 - k, 3)));
            if (k < 1 && this.isOpen('mres')) requestAnimationFrame(step); else el.textContent = f(to);
        };
        requestAnimationFrame(step);
    },

    _clearRs() { for (const t of this._rsT) clearTimeout(t); this._rsT = []; },

    hideResults() { this._clearRs(); this.el.mres.classList.remove('on'); },
};
