// GameCars.js — машины гаража и уровни трасс: названия, характеристики, условия открытия, цены и награды.
// Размеры машин (база, колея, колёса, габарит) — из модели (js/GameCarModels.js, генерирует Blender-пайплайн
// art/blender/cars); здесь — только то, что задаёт игра. Множители stats умножают константы CAR_* (Constants.js):
// speed — предел скорости, accel — разгон, grip — сцепление, air — управление в полёте, inertia — «тяжесть»
// (вращение), susp — ход подвески, nitro — сила нитро, downforce — прижим. Полоски гаража считаются отсюда же.

/** Открытие: ads — сколько просмотров рекламы нужно (0 — машина доступна сразу), прогресс хранится в сохранении. */
/** @type {Array<{ id: string, name: { ru: string, en: string }, color: number, ads: number, stats: Record<string, number> }>} */
const GAME_CARS = [
    { id: 'pocket', name: { ru: 'Кроха', en: 'Pocket' }, color: 0x2ec4b6, ads: 0,
        stats: { speed: 0.9, accel: 1.05, grip: 1.04, air: 1.25, inertia: 0.85, susp: 1, nitro: 1, downforce: 1 } },
    { id: 'van', name: { ru: 'Фургон', en: 'Courier' }, color: 0xffd23f, ads: 1,
        stats: { speed: 0.9, accel: 0.9, grip: 1.0, air: 0.85, inertia: 1.15, susp: 1.1, nitro: 1.05, downforce: 1 } },
    { id: 'bus', name: { ru: 'Шаттл', en: 'Shuttle' }, color: 0x1fa3a3, ads: 1,
        stats: { speed: 0.86, accel: 0.82, grip: 1.05, air: 0.7, inertia: 1.2, susp: 1.15, nitro: 1.15, downforce: 1 } },
    { id: 'wedge', name: { ru: 'Клин', en: 'Wedge' }, color: 0xff4b2b, ads: 2,
        stats: { speed: 1.08, accel: 1.08, grip: 0.98, air: 1.0, inertia: 1.0, susp: 0.9, nitro: 1, downforce: 1.2 } },
    { id: 'buggy', name: { ru: 'Багги', en: 'Buggy' }, color: 0xff9f1c, ads: 3,
        stats: { speed: 0.98, accel: 1.1, grip: 1.02, air: 1.4, inertia: 0.9, susp: 1.35, nitro: 1, downforce: 0.8 } },
    { id: 'rally', name: { ru: 'Ралли', en: 'Rally' }, color: 0x1d4ed8, ads: 3,
        stats: { speed: 1.03, accel: 1.12, grip: 1.08, air: 1.2, inertia: 0.95, susp: 1.15, nitro: 1, downforce: 1 } },
    { id: 'brute', name: { ru: 'Громила', en: 'Brute' }, color: 0x6a3df0, ads: 4,
        stats: { speed: 1.07, accel: 1.22, grip: 0.95, air: 0.95, inertia: 1.05, susp: 0.95, nitro: 1.1, downforce: 1 } },
    { id: 'finny', name: { ru: 'Ракета-50', en: 'Jet-50' }, color: 0xff6f61, ads: 5,
        stats: { speed: 1.04, accel: 1.0, grip: 1.0, air: 1.15, inertia: 1.0, susp: 1.0, nitro: 1.2, downforce: 1 } },
    { id: 'pickup', name: { ru: 'Лесовоз', en: 'Lumberjack' }, color: 0x2d6a4f, ads: 6,
        stats: { speed: 1.0, accel: 1.08, grip: 1.05, air: 1.0, inertia: 1.1, susp: 1.4, nitro: 1.1, downforce: 0.9 } },
    { id: 'volt', name: { ru: 'Вольт', en: 'Volt' }, color: 0xc9d1d9, ads: 7,
        stats: { speed: 1.12, accel: 1.35, grip: 1.08, air: 1.1, inertia: 0.95, susp: 1.0, nitro: 1.15, downforce: 1.2 } },
    { id: 'cruiser', name: { ru: 'Круизёр', en: 'Cruiser' }, color: 0x16161d, ads: 8,
        stats: { speed: 1.15, accel: 1.15, grip: 1.02, air: 1.0, inertia: 1.1, susp: 1.0, nitro: 1.2, downforce: 1.1 } },
    { id: 'hyper', name: { ru: 'Гипер', en: 'Hyper' }, color: 0xb6f23a, ads: 10,
        stats: { speed: 1.25, accel: 1.45, grip: 1.15, air: 1.3, inertia: 0.92, susp: 0.95, nitro: 1.3, downforce: 1.5 } },
];

/** Полоски гаража 0..1: скорость, разгон, сцепление, полёт. */
function carBars(id) {
    const c = GAME_CARS.find(x => x.id === id) || GAME_CARS[0], s = c.stats;
    const k = (v, lo, hi) => Math.max(0.08, Math.min(1, (v - lo) / (hi - lo)));
    return { speed: k(s.speed, 0.75, 1.3), accel: k(s.accel, 0.7, 1.5), grip: k(s.grip, 0.85, 1.2), air: k(s.air, 0.55, 1.45), durability: k(s.inertia * (s.durable || 1), 0.75, 1.35) };
}

// Трассы: карта, цена открытия (очки) или ads — сколько реклам открывает трассу вместо очков, очки за проезд. Название, длина,
// биом и контур — GAME_TRACKS (js/GameTrackData.js, собирает art/levels). Первая открыта сразу.
const MCD_LEVEL_TERMS = [
    { price: 0, ads: 0, points: 800 }, { price: 1800, ads: 2, points: 1200 }, { price: 4500, ads: 3, points: 1700 },
    { price: 9000, ads: 4, points: 2300 }, { price: 16000, ads: 5, points: 3000 },
];
/** @type {Array<any>} */
const GAME_LEVELS = (typeof GAME_TRACKS !== 'undefined' ? GAME_TRACKS : [{ id: 'track-1', n: 1, name: { ru: 'Трасса', en: 'Track' }, desc: { ru: '', en: '' }, km: 3, biome: 'proving', diff: 1, path: [] }])
    .map((t, i) => Object.assign({}, t, MCD_LEVEL_TERMS[Math.min(i, MCD_LEVEL_TERMS.length - 1)]));

// Эксклюзивные окраски — подарок 7-го дня Daily Gift (по очереди, одна за круг). Нигде больше их нет: ни на
// колесе, ни за рекламу. Красят белые части кузова любой машины игрока (выбор — в гараже); spec — блик,
// glow — лёгкое свечение краски.
/** @type {Array<{ id: string, name: { ru: string, en: string }, color: number, spec: number, power: number, glow?: number }>} */
const CAR_PAINTS = [
    { id: 'paint-gold', name: { ru: 'Золото', en: 'Gold' }, color: 0xf2b632, spec: 0xffd98a, power: 70 },
    { id: 'paint-chrome', name: { ru: 'Хром', en: 'Chrome' }, color: 0xd9e0e8, spec: 0xffffff, power: 120 },
    { id: 'paint-neon', name: { ru: 'Неон', en: 'Neon' }, color: 0xc5ef5c, spec: 0xeaffb0, power: 50, glow: 0x2e4208 },
    { id: 'paint-aurora', name: { ru: 'Аврора', en: 'Aurora' }, color: 0x8a4dff, spec: 0xd9c2ff, power: 60, glow: 0x1e0c40 },
];

// Daily Gift, дни 1–6 (очки по нарастающей; день 4 — ещё и случайная закрытая машина). День 7 — окраска CAR_PAINTS.
const STM_DAILY_REWARDS = [{ coins: 500 }, { coins: 800 }, { coins: 1200 }, { coins: 1500, randomItems: 1 }, { coins: 2500 }, { coins: 4000 }];

// Колесо фортуны: секторы по часовой от стрелки; в основном очки, реже — случайная закрытая машина.
const STM_WHEEL_SECTORS = [
    { coins: 300, weight: 22 }, { coins: 1500, weight: 10 }, { coins: 600, weight: 20 }, { randomItem: true, weight: 5 },
    { coins: 1000, weight: 15 }, { coins: 5000, weight: 3 }, { coins: 800, weight: 17 }, { coins: 2500, weight: 8 },
];
