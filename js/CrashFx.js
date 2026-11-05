// CrashFx.js — зрелищные эффекты разрушения машин: искры, пыль, крошка, стекло, пар, дым, огонь, взрыв, декали на мире
// (трещины, сколы, борозды, опалины, лужи), мелкие обломки (thin instances) и звук ударов. Физика зовёт CrashFx, он про
// физику ничего не знает; координаты — мир Babylon, px (1 м = 100 px, y вверх). Контракт — docs/DESTRUCTION.md.
//
// УСТРОЙСТВО (почему так):
//   • Частицы — app.fx (ParticleFX). Систему на каждый удар создавать нельзя: FX_MAX_SYSTEMS = 48 общий на игру, а
//     удары идут десятками в секунду. Поэтому CrashFx.bindMap заводит ПУЛЫ — по 1–2 постоянные системы на тип (искры,
//     вспышка, пыль, крошка, осколки, дым, огонь, угольки), и каждый эффект — это «залп» (burst): позиция, направление,
//     скорость, размер, цвет, число частиц, которые записываются в систему перед её следующим кадром. Залпы копятся в
//     очереди без выделений, update() раз в кадр раздаёт их системам (одна система — один залп за кадр).
//   • Время: частицы идут со скоростью игрового времени (замедление): update() замеряет dt игры против реального и
//     выставляет updateSpeed систем перед отрисовкой частиц сцены. Задержки взрыва считаются игровым временем.
//   • Декали — один меш-квадов (кольцевой буфер), атлас assets/textures/decals.webp 2048×2048 (4×4 ячейки по 512;
//     генератор — tools/fx-gen/decals.py), без записи глубины, чуть над поверхностью, переполнение гасит самые старые плавно.
//   • Обломки — thin instances четырёх видов (кусок, осколок, полоса, стекло), простая баллистика со скоростью игры:
//     отскоки, трение, засыпание, плавное исчезновение; лимит CFX_DEBRIS_MAX (телефон — CFX_DEBRIS_MAX_MOBILE).
//   • Звук — Sound.play / Sound.loop: варианты по силе, дроссели по частоте, затухание по расстоянию до камеры;
//     молчит при Game.save.sfx === false и пока Sound не разблокирован жестом игрока.
//   • Всё безопасно до init, без ассетов и без 3D-вида: методы просто ничего не делают (инвариант 6).
//
// API (все координаты — мир, px; q, n, v — массивы [x, y, z]):
//   CrashFx.init(app)  CrashFx.bindMap(view)  CrashFx.clear()  CrashFx.update(dt, camX, camY, camZ)
//   CrashFx.impact(q, n, power01, surface)   CrashFx.scrape(key, q, n, v, power01, surface)   CrashFx.scrapeEnd(key)
//   CrashFx.glass(q, v, size01)   CrashFx.panelOff(q, v, kind)   CrashFx.wheelOff(q, v)   CrashFx.tireBurst(q)
//   CrashFx.leak(q, kind, power01)   CrashFx.scorch(q, n, size)   CrashFx.explosion(q, power01)
//   CrashFx.gear(q, v, n, color?)   CrashFx.decal(kind, q, n, size, rot, alpha)   CrashFx.emitter(follow) -> { set(steam, smoke, fire), stop() }
//   CrashFx.groundY(x, y, z) -> высота земли | null (подменяется игрой; по умолчанию GameWorld.heightAt и ObbyCourse.rayDown)
//   CrashFx.stats() — счётчики для отладки (fx-lab).

// ================================================================================================
// НАСТРОЙКА. Все числа эффектов — здесь.
// ================================================================================================
const CFX_TEX = {
    smoke: 'assets/fx/crash-smoke.webp',     // 2×2 по 256: дым
    dust: 'assets/fx/crash-dust.webp',       // 2×2 по 256: пыль
    fire: 'assets/fx/crash-fire.webp',       // 4×4 по 128: языки пламени (16 кадров)
    spark: 'assets/fx/crash-spark.webp',     // штрих-искра 32×128
    flash: 'assets/fx/crash-flash.webp',     // вспышка с лучами
    ring: 'assets/fx/crash-ring.webp',       // кольцо ударной волны
    glow: 'assets/fx/crash-glow.webp',       // мягкое свечение
    chips: 'assets/fx/crash-chips.webp',     // 4×4 по 64: крошка (8 острых + 8 комков)
    shards: 'assets/fx/crash-shards.webp',   // 4×2 по 64: осколки стекла
    decals: 'assets/textures/decals.webp',   // атлас декалей мира
};
const CFX_SND = {
    hitLight: ['assets/sounds/crash-hit-light-1.ogg', 'assets/sounds/crash-hit-light-2.ogg', 'assets/sounds/crash-hit-light-3.ogg', 'assets/sounds/crash-hit-light-4.ogg'],
    hitHeavy: ['assets/sounds/crash-hit-heavy-1.ogg', 'assets/sounds/crash-hit-heavy-2.ogg', 'assets/sounds/crash-hit-heavy-3.ogg', 'assets/sounds/crash-hit-heavy-4.ogg'],
    thud: ['assets/sounds/crash-thud-1.ogg', 'assets/sounds/crash-thud-2.ogg'],
    glass: ['assets/sounds/crash-glass-1.ogg', 'assets/sounds/crash-glass-2.ogg', 'assets/sounds/crash-glass-3.ogg'],
    tire: ['assets/sounds/crash-tire-burst.ogg'],
    panel: ['assets/sounds/crash-panel-1.ogg', 'assets/sounds/crash-panel-2.ogg', 'assets/sounds/crash-panel-3.ogg'],
    debris: ['assets/sounds/crash-debris-1.ogg', 'assets/sounds/crash-debris-2.ogg', 'assets/sounds/crash-debris-3.ogg'],
    boom: ['assets/sounds/crash-explosion-1.ogg', 'assets/sounds/crash-explosion-2.ogg'],
    scrape: 'assets/sounds/crash-scrape-loop.ogg',
    steam: 'assets/sounds/crash-steam-loop.ogg',
    fire: 'assets/sounds/crash-fire-loop.ogg',
};

const CFX_G = 980;                      // ускорение падения обломков и крошки, px/с²
const CFX_FAR_FX = 7500;                // дальше от камеры частицы и обломки не запускаются
const CFX_MID_FX = 3600;                // дальше — вдвое меньше частиц
const CFX_FAR_SND = 9500;               // дальше звук не играет
const CFX_SND_REF = 1500;               // на таком расстоянии громкость вдвое тише
const CFX_LQ = [0.5, 0.78, 1];          // доля частиц по Quality.level (низкий, средний, высокий)
const CFX_MOBILE_K = 0.8;               // и ещё на телефоне

const CFX_IMPACT_RATE = 16;             // визуальных ударов в секунду (запас CFX_IMPACT_BURST)
const CFX_IMPACT_BURST = 4;
const CFX_SND_GAP_HIT = 0.065;          // с между звуками ударов (сильнее на 0.2 — пробивает)
const CFX_SND_RATE_DEBRIS = 7;          // звуков падения обломков в секунду
const CFX_POOL_QUEUE = 28;              // залпов в очереди на тип
const CFX_POOL_STALE = 14;              // кадров: залп старше не запускается

const CFX_DEBRIS_MAX = 400;             // всех кусков вместе
const CFX_DEBRIS_MAX_MOBILE = 150;
const CFX_DEBRIS_SPLIT = [0.34, 0.26, 0.14, 0.26]; // доли лимита: кусок, осколок, полоса, стекло
const CFX_DEBRIS_LIFE = 24;             // с лежат
const CFX_DEBRIS_FADE = 3;              // с исчезают (уменьшение)
const CFX_DEBRIS_GROUND_EVERY = 2;      // опрос земли каждые N кадров на кусок

const CFX_DECAL_MAX = 720;              // декалей в буфере
const CFX_DECAL_MAX_MOBILE = 300;
const CFX_DECAL_LIFE = 300;             // с до начала угасания (долго)
const CFX_DECAL_FADE = 14;              // с угасания по времени
const CFX_DECAL_FADE_SLOTS = 30;        // сколько самых старых слотов гаснет заранее при переполнении
const CFX_DECAL_IMPACT_P = 0.42;        // сила удара, с которой стена получает трещины
const CFX_DECAL_SEG = 24;               // px между квадами борозды при scrape
const CFX_DECAL_ANISO = 4;

const CFX_FLARES = 8;                   // плоских вспышек и колец ударной волны одновременно
const CFX_EMITTERS_MAX = 7;             // постоянных источников дыма и огня с живыми системами
const CFX_WIND = [34, 12];              // px/с²: снос дыма и пара (x, z)
const CFX_SCRAPE_LOOPS = 3;             // громких петель скрежета одновременно
const CFX_SCRAPE_MIN_SPEED = 55;        // px/с: медленнее — трения нет

/** @type {Record<string, { sparks: number, dust: number[] | null, chip: number[] | null, furrow?: number[] }>} */
const CFX_SURF = {
    // sparks — сила искр (0 — без), dust и chip — цвета пыли и крошки (r, g, b 0..1) или null
    metal: { sparks: 1, dust: null, chip: null },
    car: { sparks: 0.8, dust: null, chip: null },
    concrete: { sparks: 0.55, dust: [0.66, 0.64, 0.6], chip: [0.78, 0.76, 0.72] },
    asphalt: { sparks: 0.5, dust: [0.36, 0.36, 0.38], chip: [0.24, 0.24, 0.26] },
    dirt: { sparks: 0, dust: [0.56, 0.43, 0.3], chip: [0.42, 0.31, 0.2], furrow: [0.42, 0.3, 0.2] },
    wood: { sparks: 0, dust: [0.62, 0.48, 0.3], chip: [0.7, 0.53, 0.32] },
    plastic: { sparks: 0.15, dust: null, chip: [0.25, 0.25, 0.28] },
    rock: { sparks: 0.45, dust: [0.5, 0.48, 0.45], chip: [0.55, 0.53, 0.5] },
    grass: { sparks: 0, dust: [0.36, 0.42, 0.24], chip: [0.3, 0.26, 0.16], furrow: [0.36, 0.3, 0.2] },
    sand: { sparks: 0, dust: [0.78, 0.68, 0.48], chip: [0.7, 0.6, 0.4], furrow: [0.62, 0.52, 0.34] },
};

// Ячейки атласа decals.webp (4×4): индекс = ряд * 4 + колонка
const CFX_CELLS = { crack: [0, 1, 2, 3], chip: [4, 5, 6, 7], gouge: [8, 9], scorch: [10, 11], oil: [12], coolant: [13], glass: [14], rubber: [15] };
const CFX_LIFT = { scorch: 0.5, oil: 0.7, fuel: 0.7, coolant: 0.85, gouge: 0.9, rubber: 1.0, crack: 1.1, chip: 1.2, glass: 1.35 };   // px над поверхностью: выше — рисуется поверх
const CFX_DECAL_TINT = { fuel: [1, 0.82, 0.5] };

// ================================================================================================
// Вспомогательное
// ================================================================================================
const cfxClamp = (/** @type {number} */ v, /** @type {number} */ a, /** @type {number} */ b) => (v < a ? a : v > b ? b : v);
const cfxRnd = (/** @type {number} */ a, /** @type {number} */ b) => a + Math.random() * (b - a);

/** Токен-ведро: true — действие разрешено. @param {{ t: number, tok: number }} g */
function cfxGate(g, now, rate, burst) {
    g.tok = Math.min(burst, g.tok + (now - g.t) * rate);
    g.t = now;
    if (g.tok < 1) return false;
    g.tok -= 1;
    return true;
}

// ================================================================================================
// Пулы частиц: постоянные системы ParticleFX + очередь залпов
// ================================================================================================
/** Определения пулов. n — сколько систем, opts — fx.create, setup — тонкая настройка Babylon-системы, grad — цвет задан градиентом (залп цвет не меняет). */
function cfxPoolDefs() {
    const BP = BABYLON.ParticleSystem;
    const rot = (/** @type {any} */ ps) => { ps.minInitialRotation = 0; ps.maxInitialRotation = Math.PI * 2; };
    return {
        // порядок — порядок рисования: сначала обычное смешивание (дым, пыль, крошка), затем свечение поверх
        dust: {
            n: 2, grad: false, opts: { texture: CFX_TEX.dust, blend: 'standard', capacity: 70, life: [0.6, 1.4], size: [1, 1], speed: [1, 1], gravity: [0, 18, 0],
                sizeGradient: [[0, 0.35], [0.25, 0.8], [1, 1.5]], sheet: { width: 256, height: 256, start: 0, end: 3, speed: 0, loop: false, randomStart: true } },
            setup: rot,
        },
        smoke: {
            n: 1, grad: false, opts: { texture: CFX_TEX.smoke, blend: 'standard', capacity: 220, life: [2, 4], size: [1, 1], speed: [1, 1], gravity: [CFX_WIND[0], 62, CFX_WIND[1]],
                sizeGradient: [[0, 0.3], [0.15, 0.7], [1, 1.7]], sheet: { width: 256, height: 256, start: 0, end: 3, speed: 0, loop: false, randomStart: true } },
            setup: rot, wind: true,
        },
        crumb: {
            n: 1, grad: false, opts: { texture: CFX_TEX.chips, blend: 'standard', capacity: 200, life: [0.5, 1.1], size: [1, 1], speed: [1, 1], gravity: [0, -CFX_G, 0],
                sizeGradient: [[0, 1], [0.7, 1], [1, 0.15]], sheet: { width: 64, height: 64, start: 0, end: 15, speed: 0, loop: false, randomStart: true } },
            setup: rot,
        },
        ball: {
            n: 1, grad: true, opts: { texture: CFX_TEX.smoke, capacity: 130, life: [0.6, 1.1], size: [1, 1], speed: [1, 1], gravity: [0, 55, 0],
                colorGradient: [[0, '#ffe8b0', 0], [0.06, '#ffd890', 0.85], [0.28, '#ff9a3c', 0.88], [0.62, '#dc4818', 0.6], [1, '#3a1208', 0]],
                sizeGradient: [[0, 0.45], [0.3, 1], [1, 1.5]], sheet: { width: 256, height: 256, start: 0, end: 3, speed: 0, loop: false, randomStart: true } },
            setup: rot,
        },
        fire: {
            n: 1, grad: true, opts: { texture: CFX_TEX.fire, capacity: 160, life: [0.5, 1], size: [1, 1], speed: [1, 1], gravity: [0, 90, 0],
                colorGradient: [[0, '#ffffff', 0], [0.08, '#fff6e0', 1], [0.45, '#ffc070', 0.85], [0.8, '#e0602a', 0.45], [1, '#40140a', 0]],
                sizeGradient: [[0, 0.55], [0.3, 1], [1, 0.7]], sheet: { width: 128, height: 128, start: 0, end: 15, speed: 1, loop: false, randomStart: false } },
            setup: null,
        },
        ember: {
            n: 1, grad: true, opts: { texture: CFX_TEX.glow, capacity: 110, life: [1, 2], size: [1, 1], speed: [1, 1], gravity: [0, 70, 0],
                colorGradient: [[0, '#fff0c0', 1], [0.3, '#ffae40', 0.9], [0.75, '#e0501a', 0.55], [1, '#401008', 0]], sizeGradient: [[0, 1], [1, 0.25]] },
            setup: null,
        },
        spark: {
            n: 2, grad: true, opts: { texture: CFX_TEX.spark, capacity: 150, life: [0.3, 0.7], size: [1, 1], speed: [1, 1], gravity: [0, -CFX_G * 0.85, 0],
                colorGradient: [[0, '#ffffff', 1], [0.18, '#fff0b0', 1], [0.5, '#ffa030', 0.95], [0.85, '#e0480e', 0.7], [1, '#601604', 0]], sizeGradient: [[0, 1], [0.7, 0.85], [1, 0.2]] },
            setup: (/** @type {any} */ ps) => { ps.billboardMode = BP.BILLBOARDMODE_STRETCHED; },
        },
        flash: {
            n: 1, grad: false, opts: { texture: CFX_TEX.flash, capacity: 12, life: [0.08, 0.2], size: [1, 1], speed: [0, 0], sizeGradient: [[0, 0.35], [0.25, 1], [1, 0.55]] },
            setup: rot,
        },
        shard: {
            n: 1, grad: false, opts: { texture: CFX_TEX.shards, capacity: 150, life: [0.7, 1.4], size: [1, 1], speed: [1, 1], gravity: [0, -CFX_G, 0], sizeGradient: [[0, 1], [0.75, 1], [1, 0.2]],
                sheet: { width: 64, height: 64, start: 0, end: 7, speed: 5, loop: true, randomStart: true } },
            setup: rot,
        },
    };
}

/** Пустой залп (запись очереди). Поля заполняет вызывающий; значения по умолчанию ставит CfxPools.rec. */
function cfxNewBurst() {
    return { t: 0, n: 0, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 0, sx: 0, sy: 0, sz: 0, v0: 1, v1: 1, s0: 10, s1: 10, u0: 10, u1: 10, l0: 0.5, l1: 1,
        r1: 1, g1: 1, b1: 1, a1: 1, r2: 1, g2: 1, b2: 1, a2: 1, deadA: 0, w0: 0, w1: 0, bx: 0, by: 0, bz: 0 };
}

/** @satisfies {Record<string, any>} */
const CfxPools = {
    /** @type {Record<string, any>} */ pools: {},
    /** @type {any[]} */ all: [],           // все живые системы пулов (updateSpeed, ветер)
    /** @type {any} */ fx: null,
    builtAt: 0,

    build(/** @type {any} */ fx) {
        this.dispose();
        this.fx = fx;
        if (!fx) return;
        const defs = cfxPoolDefs();
        for (const name in defs) {
            const def = /** @type {any} */ (defs)[name];
            const pool = { name, def, items: /** @type {any[]} */ ([]), rr: 0, q: /** @type {any[]} */ ([]), qh: 0, qn: 0 };
            for (let i = 0; i < CFX_POOL_QUEUE; i++) pool.q.push(cfxNewBurst());
            for (let i = 0; i < def.n; i++) {
                const h = fx.create(Object.assign({}, def.opts, { name: 'cfx-' + name, position: [0, -90000, 0], rate: 0 }));
                if (!h) continue;
                const ps = h.system;
                if (def.setup) def.setup(ps);
                ps.manualEmitCount = 0;
                const item = { h, ps, dead: false };
                ps.onDisposeObservable.add(() => { item.dead = true; });
                pool.items.push(item);
                this.all.push(ps);
            }
            this.pools[name] = pool;
        }
        this.builtAt = performance.now();
    },

    dispose() {
        for (const name in this.pools) for (const it of this.pools[name].items) { try { it.h.dispose(); } catch (e) { /* уже */ } }
        this.pools = {}; this.all = [];
    },

    reset() {
        for (const name in this.pools) {
            const p = this.pools[name];
            p.qn = 0; p.qh = 0;
            for (const it of p.items) { if (!it.dead) { try { it.ps.reset(); it.ps.manualEmitCount = 0; } catch (e) { /* уже */ } } }
        }
    },

    /** Следующая запись залпа пула name (null — пул не создан или очередь полна). Все поля сброшены. */
    rec(name, /** @type {number} */ stamp) {
        const p = this.pools[name];
        if (!p || !p.items.length || p.qn >= CFX_POOL_QUEUE) return null;
        const b = p.q[(p.qh + p.qn) % CFX_POOL_QUEUE];
        p.qn++;
        b.t = stamp; b.n = 1; b.x = b.y = b.z = 0; b.dx = b.dy = b.dz = 0; b.sx = b.sy = b.sz = 0; b.v0 = b.v1 = 1;
        b.s0 = b.s1 = b.u0 = b.u1 = 10; b.l0 = 0.5; b.l1 = 1;
        b.r1 = b.g1 = b.b1 = b.a1 = b.r2 = b.g2 = b.b2 = b.a2 = 1; b.deadA = 0; b.w0 = b.w1 = 0; b.bx = b.by = b.bz = 0;
        return b;
    },

    /** Раз в кадр: очередь -> системы (по залпу на систему). */
    flush(/** @type {number} */ stamp) {
        for (const name in this.pools) {
            const p = this.pools[name];
            if (!p.qn) continue;
            const items = p.items;
            const live = items.length;
            if (!live) { p.qn = 0; continue; }
            let tries = 0;
            while (p.qn > 0 && tries < live) {
                const it = items[p.rr % live];
                p.rr++; tries++;
                if (it.dead) continue;
                const b = p.q[p.qh];
                p.qh = (p.qh + 1) % CFX_POOL_QUEUE; p.qn--;
                if (stamp - b.t > CFX_POOL_STALE) { tries--; continue; }
                this._arm(it.ps, b, p.def.grad);
            }
            // что не поместилось — старое отбрасываем, свежее остаётся на следующий кадр
            while (p.qn > 0 && stamp - p.q[p.qh].t > CFX_POOL_STALE) { p.qh = (p.qh + 1) % CFX_POOL_QUEUE; p.qn--; }
        }
    },

    _arm(/** @type {any} */ ps, /** @type {any} */ b, /** @type {boolean} */ grad) {
        ps.emitter.x = b.x; ps.emitter.y = b.y; ps.emitter.z = b.z;
        ps.direction1.set(b.dx - b.sx, b.dy - b.sy, b.dz - b.sz);
        ps.direction2.set(b.dx + b.sx, b.dy + b.sy, b.dz + b.sz);
        ps.minEmitBox.set(-b.bx, -b.by, -b.bz); ps.maxEmitBox.set(b.bx, b.by, b.bz);
        ps.minEmitPower = b.v0; ps.maxEmitPower = b.v1;
        ps.minLifeTime = b.l0; ps.maxLifeTime = b.l1;
        ps.minScaleX = b.s0; ps.maxScaleX = b.s1; ps.minScaleY = b.u0; ps.maxScaleY = b.u1;
        ps.minAngularSpeed = b.w0; ps.maxAngularSpeed = b.w1;
        if (!grad) {
            ps.color1.r = b.r1; ps.color1.g = b.g1; ps.color1.b = b.b1; ps.color1.a = b.a1;
            ps.color2.r = b.r2; ps.color2.g = b.g2; ps.color2.b = b.b2; ps.color2.a = b.a2;
            ps.colorDead.r = b.r1 * 0.55; ps.colorDead.g = b.g1 * 0.55; ps.colorDead.b = b.b1 * 0.55; ps.colorDead.a = b.deadA;
        }
        ps.manualEmitCount = Math.max(0, Math.floor(b.n));
    },
};

// ================================================================================================
// Декали мира: кольцевой буфер квадов в одном меше
// ================================================================================================
/** @satisfies {Record<string, any>} */
const CfxDecals = {
    /** @type {any} */ mesh: null,
    /** @type {any} */ view: null,
    /** @type {any} */ tex: null,
    N: 0, head: 0, t: 0, scanT: 0, used: 0, ready: false, dirtyP: false, dirtyU: false, dirtyC: false, dirtyN: false,
    /** @type {Float32Array | null} */ nrm: null,
    /** @type {Float32Array | null} */ pos: null,
    /** @type {Float32Array | null} */ uv: null,
    /** @type {Float32Array | null} */ col: null,
    /** @type {Float32Array | null} */ born: null,
    /** @type {Float32Array | null} */ base: null,
    /** @type {Float32Array | null} */ tint: null,
    /** @type {Float32Array | null} */ cen: null,        // центр и радиус слота (x, y, z, r) — для роста луж и проверки повторов
    scratch: new Float32Array(12),

    init(/** @type {any} */ view, /** @type {number} */ n) {
        const scene = view.scene || view;
        if (this.mesh && this.view === view && !this.mesh.isDisposed() && this.N === n) return;
        this.dispose();
        this.view = view;
        const N = this.N = n;
        this.pos = new Float32Array(N * 12); this.uv = new Float32Array(N * 8); this.col = new Float32Array(N * 16);
        this.nrm = new Float32Array(N * 12).map((_, i) => (i % 3 === 1 ? 1 : 0));
        this.born = new Float32Array(N).fill(-1e9); this.base = new Float32Array(N); this.tint = new Float32Array(N * 3).fill(1); this.cen = new Float32Array(N * 4);
        const idx = new Uint32Array(N * 6);
        for (let i = 0; i < N; i++) { const v = i * 4, k = i * 6; idx[k] = v; idx[k + 1] = v + 1; idx[k + 2] = v + 2; idx[k + 3] = v + 1; idx[k + 4] = v + 3; idx[k + 5] = v + 2; }
        const mesh = new BABYLON.Mesh('cfx-decals', scene);
        const vd = new BABYLON.VertexData();
        vd.positions = this.pos; vd.uvs = this.uv; vd.colors = this.col; vd.indices = idx;
        vd.normals = this.nrm;
        vd.applyToMesh(mesh, true);
        mesh.hasVertexAlpha = true;
        mesh.isPickable = false;
        mesh.alwaysSelectAsActiveMesh = true;
        mesh.receiveShadows = true;
        mesh.doNotSyncBoundingInfo = true;
        const mat = new BABYLON.StandardMaterial('cfx-decals-mat', scene);
        // освещается как поверхность под ней (то же солнце, тени и ступени toon): декаль не светится в тени и ночью
        mat.diffuseColor = new BABYLON.Color3(1, 1, 1);
        mat.specularColor = new BABYLON.Color3(0, 0, 0);
        mat.backFaceCulling = false;
        mat.disableDepthWrite = true;
        mat.zOffset = -3;
        mat.useAlphaFromDiffuseTexture = true;
        const tex = new BABYLON.Texture(CFX_TEX.decals, scene, false, false, BABYLON.Texture.TRILINEAR_SAMPLINGMODE, undefined, () => {
            console.warn('CrashFx: нет атласа декалей, рисую запасной');
            this.fallback(scene);
        });
        tex.hasAlpha = true;
        tex.anisotropicFilteringLevel = typeof IS_MOBILE !== 'undefined' && IS_MOBILE ? 2 : CFX_DECAL_ANISO;
        tex.wrapU = tex.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
        mat.diffuseTexture = tex;
        mat.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
        mesh.material = mat;
        this.mesh = mesh; this.tex = tex;
        this.head = 0; this.used = 0; this.ready = true;
    },

    /** Запасной атлас, если файла нет: мягкие тёмные пятна в 16 ячейках. */
    fallback(/** @type {any} */ scene) {
        if (!this.mesh) return;
        const S = 256, cv = new BABYLON.DynamicTexture('cfx-decals-fb', S, scene, true);
        const ctx = cv.getContext();
        ctx.clearRect(0, 0, S, S);
        for (let i = 0; i < 16; i++) {
            const cx = (i % 4) * 64 + 32, cy = Math.floor(i / 4) * 64 + 32;
            const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, 28);
            const c = i >= 12 ? '30,160,70' : '20,18,16';
            g.addColorStop(0, 'rgba(' + c + ',0.85)'); g.addColorStop(1, 'rgba(' + c + ',0)');
            ctx.fillStyle = g; ctx.fillRect(cx - 32, cy - 32, 64, 64);
        }
        cv.update(); cv.hasAlpha = true;
        this.mesh.material.diffuseTexture = cv;
    },

    dispose() {
        if (this.mesh && !this.mesh.isDisposed()) { try { this.mesh.material.dispose(); this.mesh.dispose(); } catch (e) { /* уже */ } }
        if (this.tex) { try { this.tex.dispose(); } catch (e) { /* уже */ } }
        this.mesh = null; this.tex = null; this.ready = false; this.N = 0;
    },

    clear() {
        if (!this.ready) return;
        this.pos.fill(0); this.col.fill(0); this.born.fill(-1e9); this.base.fill(0); this.head = 0; this.used = 0;
        this.dirtyP = this.dirtyU = this.dirtyC = true;
    },

    /** Занять следующий слот; при переполнении ближайшие к перезаписи гаснут заранее. */
    take() {
        const i = this.head;
        this.head = (this.head + 1) % this.N;
        if (this.used < this.N) this.used++;
        else {
            const F = Math.min(CFX_DECAL_FADE_SLOTS, this.N - 1), C = this.col;
            for (let k = 1; k <= F; k++) {
                const s = (this.head + k - 1) % this.N, a = this.base[s] * (k / (F + 1));
                for (let c = 0; c < 4; c++) C[s * 16 + c * 4 + 3] = Math.min(C[s * 16 + c * 4 + 3], a);
            }
            this.dirtyC = true;
        }
        return i;
    },

    /**
     * Квад декали: центр (cx, cy, cz), нормаль (nx, ny, nz), полуразмеры hx, hy, поворот rot вокруг нормали, ячейка атласа, отзеркаливание flip (1 — по U, 2 — по V).
     * conform — прижать углы к земле (CrashFx.groundY). Возвращает номер слота.
     */
    add(/** @type {number} */ cell, /** @type {number} */ flip, cx, cy, cz, nx, ny, nz, hx, hy, rot, alpha, lift, conform, /** @type {number[] | null} */ tint) {
        if (!this.ready) return -1;
        const i = this.take();
        const P = this.pos, U = this.uv, C = this.col;
        // базис плоскости: t — вправо по поверхности, b — «вверх»
        let tx, ty, tz;
        if (Math.abs(ny) > 0.98) { tx = 1; ty = 0; tz = 0; }
        else { tx = nz; ty = 0; tz = -nx; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l; }
        let bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
        const cr = Math.cos(rot), sr = Math.sin(rot);
        const rx = tx * cr + bx * sr, ry = ty * cr + by * sr, rz = tz * cr + bz * sr;
        const ux = -tx * sr + bx * cr, uy = -ty * sr + by * cr, uz = -tz * sr + bz * cr;
        const o = i * 12;
        const gl = lift;
        const ground = conform && ny > 0.8 && typeof CrashFx.groundY === 'function';
        for (let k = 0; k < 4; k++) {
            const sx = k & 1 ? 1 : -1, sy = k & 2 ? 1 : -1;
            let x = cx + rx * hx * sx + ux * hy * sy + nx * gl;
            let y = cy + ry * hx * sx + uy * hy * sy + ny * gl;
            let z = cz + rz * hx * sx + uz * hy * sy + nz * gl;
            if (ground) {
                const g = CrashFx.groundY(x, y, z);
                if (g !== null && g !== undefined && Math.abs(g - cy) < 36) y = g + gl;
            }
            P[o + k * 3] = x; P[o + k * 3 + 1] = y; P[o + k * 3 + 2] = z;
        }
        this.setUV(i, cell, flip);
        const a = cfxClamp(alpha, 0, 1);
        const tr = tint ? tint[0] : 1, tg = tint ? tint[1] : 1, tb = tint ? tint[2] : 1;
        for (let k = 0; k < 4; k++) { const c = i * 16 + k * 4; C[c] = tr; C[c + 1] = tg; C[c + 2] = tb; C[c + 3] = a; }
        this.base[i] = a; this.born[i] = this.t;
        this.setNormal(i, nx, ny, nz);
        const cc = i * 4;
        this.cen[cc] = cx; this.cen[cc + 1] = cy; this.cen[cc + 2] = cz; this.cen[cc + 3] = Math.max(hx, hy);
        this.dirtyP = this.dirtyU = this.dirtyC = true;
        return i;
    },

    setNormal(/** @type {number} */ i, nx, ny, nz) {
        const N = this.nrm, o = i * 12;
        for (let k = 0; k < 4; k++) { N[o + k * 3] = nx; N[o + k * 3 + 1] = ny; N[o + k * 3 + 2] = nz; }
        this.dirtyN = true;
    },

    setUV(/** @type {number} */ i, /** @type {number} */ cell, /** @type {number} */ flip, /** @type {number=} */ va, /** @type {number=} */ vb) {
        const U = this.uv, c = cell % 4, r = (cell / 4) | 0;
        let u0 = c * 0.25, u1 = u0 + 0.25, v0 = r * 0.25 + (va || 0) * 0.25, v1 = r * 0.25 + (vb === undefined ? 1 : vb) * 0.25;
        if (flip & 1) { const t = u0; u0 = u1; u1 = t; }
        if (flip & 2) { const t = v0; v0 = v1; v1 = t; }
        const o = i * 8;
        U[o] = u0; U[o + 1] = v1; U[o + 2] = u1; U[o + 3] = v1; U[o + 4] = u0; U[o + 5] = v0; U[o + 6] = u1; U[o + 7] = v0;
    },

    /** Четырёхугольник по четырём углам (борозды): a, b — левый/правый край в начале, c, d — в конце. */
    quad(/** @type {number} */ cell, /** @type {number} */ flip, /** @type {Float32Array | number[]} */ e, nx, ny, nz, alpha, lift, /** @type {number=} */ vStart, /** @type {number=} */ vEnd, /** @type {number[] | null=} */ tint) {
        if (!this.ready) return -1;
        const i = this.take(), P = this.pos, C = this.col, o = i * 12;
        for (let k = 0; k < 4; k++) {
            P[o + k * 3] = e[k * 3] + nx * lift; P[o + k * 3 + 1] = e[k * 3 + 1] + ny * lift; P[o + k * 3 + 2] = e[k * 3 + 2] + nz * lift;
        }
        this.setUV(i, cell, flip, vEnd, vStart);
        const a = cfxClamp(alpha, 0, 1);
        const tr = tint ? tint[0] : 1, tg = tint ? tint[1] : 1, tb = tint ? tint[2] : 1;
        for (let k = 0; k < 4; k++) { const c = i * 16 + k * 4; C[c] = tr; C[c + 1] = tg; C[c + 2] = tb; C[c + 3] = a; }
        this.base[i] = a; this.born[i] = this.t;
        this.setNormal(i, nx, ny, nz);
        const cc = i * 4;
        this.cen[cc] = (e[0] + e[9]) / 2; this.cen[cc + 1] = (e[1] + e[10]) / 2; this.cen[cc + 2] = (e[2] + e[11]) / 2; this.cen[cc + 3] = 20;
        this.dirtyP = this.dirtyU = this.dirtyC = true;
        return i;
    },

    /** Увеличить слот вокруг его центра (растекающаяся лужа). */
    grow(/** @type {number} */ i, /** @type {number} */ k, /** @type {number} */ maxR) {
        if (!this.ready || i < 0 || this.born[i] < -1e8) return;
        const cc = i * 4, P = this.pos, o = i * 12;
        const r = this.cen[cc + 3];
        if (r >= maxR) return;
        const f = Math.min(k, maxR / r), cx = this.cen[cc], cy = this.cen[cc + 1], cz = this.cen[cc + 2];
        for (let v = 0; v < 4; v++) {
            P[o + v * 3] = cx + (P[o + v * 3] - cx) * f; P[o + v * 3 + 1] = cy + (P[o + v * 3 + 1] - cy) * f; P[o + v * 3 + 2] = cz + (P[o + v * 3 + 2] - cz) * f;
        }
        this.cen[cc + 3] = r * f;
        this.dirtyP = true;
    },

    update(/** @type {number} */ dt) {
        if (!this.ready) return;
        this.t += dt;
        this.scanT += dt;
        if (this.scanT > 0.5) {
            this.scanT = 0;
            const C = this.col, N = this.N, life = CFX_DECAL_LIFE;
            for (let i = 0; i < N; i++) {
                const age = this.t - this.born[i];
                if (age < life || age > life + CFX_DECAL_FADE + 1) continue;
                const a = this.base[i] * Math.max(0, 1 - (age - life) / CFX_DECAL_FADE);
                for (let k = 0; k < 4; k++) C[i * 16 + k * 4 + 3] = a;
                this.dirtyC = true;
            }
        }
        const m = this.mesh;
        if (this.dirtyP) { m.updateVerticesData(BABYLON.VertexBuffer.PositionKind, this.pos); this.dirtyP = false; }
        if (this.dirtyU) { m.updateVerticesData(BABYLON.VertexBuffer.UVKind, this.uv); this.dirtyU = false; }
        if (this.dirtyC) { m.updateVerticesData(BABYLON.VertexBuffer.ColorKind, this.col); this.dirtyC = false; }
        if (this.dirtyN) { m.updateVerticesData(BABYLON.VertexBuffer.NormalKind, this.nrm); this.dirtyN = false; }
    },
};

// ================================================================================================
// Мелкие обломки: thin instances с баллистикой
// ================================================================================================
const CFX_DF = 20;   // полей на кусок
// поля: 0 x, 1 y, 2 z, 3 vx, 4 vy, 5 vz, 6 ax, 7 ay, 8 az, 9 wx, 10 wy, 11 wz, 12 sx, 13 sy, 14 sz, 15 возраст, 16 состояние (0 нет, 1 летит, 2 лежит), 17 высота земли, 18 радиус, 19 упругость

/** @satisfies {Record<string, any>} */
const CfxDebris = {
    /** @type {any[]} */ kinds: [],
    /** @type {any} */ view: null,
    /** @type {any} */ mat: null,
    /** @type {any} */ matGlass: null,
    frame: 0, ready: false, live: 0, sndGate: { t: 0, tok: 2 },

    init(/** @type {any} */ view, /** @type {number} */ total) {
        const scene = view.scene || view;
        this.dispose();
        this.view = view;
        const mat = this.mat = new BABYLON.StandardMaterial('cfx-debris-mat', scene);
        mat.diffuseColor = new BABYLON.Color3(1, 1, 1);
        mat.specularColor = new BABYLON.Color3(0.28, 0.28, 0.3);
        mat.specularPower = 28;
        mat.backFaceCulling = false;
        const mg = this.matGlass = new BABYLON.StandardMaterial('cfx-debris-glass', scene);
        mg.diffuseColor = new BABYLON.Color3(1, 1, 1);
        mg.specularColor = new BABYLON.Color3(1, 1, 1);
        mg.specularPower = 90;
        mg.emissiveColor = new BABYLON.Color3(0.1, 0.14, 0.16);
        mg.alpha = 0.62;
        mg.backFaceCulling = false;
        const shape = (/** @type {number} */ k) => {
            if (k === 0) return CfxDebris.chunkMesh(scene);
            if (k === 1) return BABYLON.MeshBuilder.CreateCylinder('cfx-shard', { height: 0.07, diameter: 1, tessellation: 3 }, scene);
            if (k === 2) return BABYLON.MeshBuilder.CreateBox('cfx-strip', { width: 1, height: 0.1, depth: 0.2 }, scene);
            return BABYLON.MeshBuilder.CreateCylinder('cfx-glass', { height: 0.04, diameter: 1, tessellation: 3 }, scene);
        };
        for (let k = 0; k < 4; k++) {
            const cap = Math.max(8, Math.round(total * CFX_DEBRIS_SPLIT[k]));
            const mesh = shape(k);
            mesh.material = k === 3 ? mg : mat;
            mesh.isPickable = false; mesh.receiveShadows = false; mesh.alwaysSelectAsActiveMesh = true; mesh.doNotSyncBoundingInfo = true;
            const mats = new Float32Array(cap * 16), cols = new Float32Array(cap * 4).fill(1);
            mesh.thinInstanceSetBuffer('matrix', mats, 16, false);
            mesh.thinInstanceSetBuffer('color', cols, 4, false);
            mesh.thinInstanceCount = 0;
            this.kinds.push({ mesh, cap, mats, cols, d: new Float32Array(cap * CFX_DF), head: 0, hi: 0, dirty: false });
        }
        this.ready = true;
    },

    /** Кусок: коробка с неровными вершинами и плоским затенением. */
    chunkMesh(/** @type {any} */ scene) {
        const m = BABYLON.MeshBuilder.CreateBox('cfx-chunk', { width: 1, height: 0.3, depth: 0.74 }, scene);
        const p = m.getVerticesData(BABYLON.VertexBuffer.PositionKind), idx = m.getIndices();
        const q = Array.from(p);
        for (let i = 0; i < q.length; i++) q[i] += (Math.random() - 0.5) * 0.42;
        const nrm = [];
        BABYLON.VertexData.ComputeNormals(q, idx, nrm);
        m.updateVerticesData(BABYLON.VertexBuffer.PositionKind, q);
        m.updateVerticesData(BABYLON.VertexBuffer.NormalKind, nrm);
        return m;
    },

    dispose() {
        for (const k of this.kinds) { try { k.mesh.dispose(); } catch (e) { /* уже */ } }
        this.kinds = [];
        for (const m of [this.mat, this.matGlass]) if (m) { try { m.dispose(); } catch (e) { /* уже */ } }
        this.mat = this.matGlass = null; this.ready = false; this.live = 0;
    },

    clear() {
        for (const K of this.kinds) { K.d.fill(0); K.mats.fill(0); K.hi = 0; K.head = 0; K.mesh.thinInstanceCount = 0; K.mesh.thinInstanceBufferUpdated('matrix'); }
        this.live = 0;
    },

    /** Кусок вида kind (0 кусок, 1 осколок, 2 полоса, 3 стекло) с цветом (r, g, b), размером size (px). */
    spawn(/** @type {number} */ kind, x, y, z, vx, vy, vz, size, r, g, b) {
        const K = this.kinds[kind];
        if (!K) return;
        const i = K.head;
        K.head = (K.head + 1) % K.cap;
        if (i + 1 > K.hi) K.hi = i + 1;
        const d = K.d, o = i * CFX_DF;
        const s = size;
        d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = vx; d[o + 4] = vy; d[o + 5] = vz;
        d[o + 6] = cfxRnd(0, 6.28); d[o + 7] = cfxRnd(0, 6.28); d[o + 8] = cfxRnd(0, 6.28);
        const w = 6 + Math.hypot(vx, vy, vz) * 0.012;
        d[o + 9] = cfxRnd(-w, w); d[o + 10] = cfxRnd(-w, w); d[o + 11] = cfxRnd(-w, w);
        if (kind === 0) { d[o + 12] = s; d[o + 13] = s * cfxRnd(0.7, 1.1); d[o + 14] = s * cfxRnd(0.7, 1.1); d[o + 18] = s * 0.28; d[o + 19] = 0.38; }
        else if (kind === 2) { d[o + 12] = s * cfxRnd(1.6, 2.6); d[o + 13] = s * 0.8; d[o + 14] = s * 0.7; d[o + 18] = s * 0.08; d[o + 19] = 0.3; }
        else { d[o + 12] = s; d[o + 13] = s * cfxRnd(0.8, 1.2); d[o + 14] = s * cfxRnd(0.6, 1); d[o + 18] = s * 0.05; d[o + 19] = kind === 3 ? 0.22 : 0.3; }
        d[o + 15] = 0; d[o + 16] = 1; d[o + 17] = -1e9;
        const c = i * 4;
        K.cols[c] = r; K.cols[c + 1] = g; K.cols[c + 2] = b; K.cols[c + 3] = 1;
        K.dirty = true; K.colorDirty = true;
        this.live++;
    },

    update(/** @type {number} */ dt, /** @type {number} */ rt) {
        if (!this.ready) return;
        this.frame++;
        const gy = CrashFx.groundY, hasGround = typeof gy === 'function';
        const life = CFX_DEBRIS_LIFE, fade = CFX_DEBRIS_FADE;
        let live = 0, land = 0, landSpeed = 0, lx = 0, ly = 0, lz = 0;
        const drag = Math.max(0, 1 - 0.12 * dt), fr = Math.max(0, 1 - 7 * dt), flat = Math.min(1, 9 * dt);
        for (let ki = 0; ki < this.kinds.length; ki++) {
            const K = this.kinds[ki], d = K.d, M = K.mats;
            let upload = K.dirty, hi = 0;
            for (let i = 0; i < K.hi; i++) {
                const o = i * CFX_DF, st = d[o + 16];
                if (st === 0) continue;
                hi = i + 1;
                const age = d[o + 15] + dt;
                d[o + 15] = age;
                if (age > life + fade) { d[o + 16] = 0; this.writeZero(M, i); upload = true; continue; }
                live++;
                let x = d[o], y = d[o + 1], z = d[o + 2];
                const r = d[o + 18];
                let write = false;
                if (st === 1) {
                    let vx = d[o + 3] * drag, vy = d[o + 4] - CFX_G * dt, vz = d[o + 5] * drag;
                    x += vx * dt; y += vy * dt; z += vz * dt;
                    d[o + 6] += d[o + 9] * dt; d[o + 7] += d[o + 10] * dt; d[o + 8] += d[o + 11] * dt;
                    if (hasGround && (((this.frame + i) % CFX_DEBRIS_GROUND_EVERY) === 0 || d[o + 17] < -1e8 || y - r < d[o + 17] + 60)) {
                        const g = gy(x, y, z);
                        d[o + 17] = g === null || g === undefined ? -1e9 : g;
                    }
                    const gnd = d[o + 17];
                    if (gnd > -1e8 && y < gnd + r) {
                        y = gnd + r;
                        if (vy < -40) {
                            if (vy < -260 && land < 3) { land++; landSpeed = Math.max(landSpeed, -vy); lx = x; ly = y; lz = z; }
                            vy = -vy * d[o + 19];
                            vx *= 0.62; vz *= 0.62;
                            d[o + 9] *= -0.5; d[o + 10] *= 0.5; d[o + 11] *= -0.5;
                        } else vy = 0;
                        vx *= fr; vz *= fr;
                        if (vy < 70 && Math.hypot(vx, vz) < 110 + r * 3) { vx = vy = vz = 0; d[o + 16] = 2; }
                    } else if (y < gnd - 9000 || y < -60000) { d[o + 16] = 0; this.writeZero(M, i); upload = true; continue; }
                    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = vx; d[o + 4] = vy; d[o + 5] = vz;
                    write = true;
                } else {
                    // лежит: пластины и полосы ложатся плашмя; опору проверяем редко
                    if (ki !== 0) {
                        const a0 = d[o + 6], a2 = d[o + 8];
                        const t0 = Math.round(a0 / Math.PI) * Math.PI, t2 = Math.round(a2 / Math.PI) * Math.PI;
                        if (Math.abs(t0 - a0) > 0.004 || Math.abs(t2 - a2) > 0.004) { d[o + 6] = a0 + (t0 - a0) * flat; d[o + 8] = a2 + (t2 - a2) * flat; write = true; }
                    }
                    if (hasGround && ((this.frame + i) & 31) === 0) {
                        const g = gy(x, y, z);
                        if (g === null || g === undefined || g < y - r - 14) { d[o + 16] = 1; d[o + 17] = g === null || g === undefined ? -1e9 : g; }
                        else if (Math.abs(g + r - y) > 0.5) { d[o + 1] = y = g + r; d[o + 17] = g; write = true; }
                    }
                }
                const fading = age > life;
                if (write || fading) {
                    this.writeMatrix(M, i, d, o, x, y, z, fading ? Math.max(0, 1 - (age - life) / fade) : 1);
                    upload = true;
                }
            }
            K.hi = hi;
            if (upload) {
                K.mesh.thinInstanceCount = hi;
                K.mesh.thinInstanceBufferUpdated('matrix');
                K.dirty = false;
            }
            if (K.colorDirty) { K.mesh.thinInstanceBufferUpdated('color'); K.colorDirty = false; }
        }
        this.live = live;
        if (land > 0 && cfxGate(this.sndGate, rt, CFX_SND_RATE_DEBRIS, 3)) CrashFx.sfxAt(CFX_SND.debris, cfxClamp(landSpeed / 1100, 0.12, 0.45), 1, lx, ly, lz);
    },

    writeZero(/** @type {Float32Array} */ M, /** @type {number} */ i) { const o = i * 16; for (let k = 0; k < 16; k++) M[o + k] = 0; M[o + 15] = 1; },

    writeMatrix(/** @type {Float32Array} */ M, /** @type {number} */ i, /** @type {Float32Array} */ d, /** @type {number} */ o, x, y, z, fs) {
        const ca = Math.cos(d[o + 6]), sa = Math.sin(d[o + 6]), cb = Math.cos(d[o + 7]), sb = Math.sin(d[o + 7]), cc = Math.cos(d[o + 8]), sc = Math.sin(d[o + 8]);
        const sx = d[o + 12] * fs, sy = d[o + 13] * fs, sz = d[o + 14] * fs, m = i * 16;
        M[m] = cc * cb * sx; M[m + 1] = sc * cb * sx; M[m + 2] = -sb * sx; M[m + 3] = 0;
        M[m + 4] = (cc * sb * sa - sc * ca) * sy; M[m + 5] = (sc * sb * sa + cc * ca) * sy; M[m + 6] = cb * sa * sy; M[m + 7] = 0;
        M[m + 8] = (cc * sb * ca + sc * sa) * sz; M[m + 9] = (sc * sb * ca - cc * sa) * sz; M[m + 10] = cb * ca * sz; M[m + 11] = 0;
        M[m + 12] = x; M[m + 13] = y; M[m + 14] = z; M[m + 15] = 1;
    },
};

// ================================================================================================
// Плоские вспышки и кольца ударной волны на земле (небольшой пул мешей)
// ================================================================================================
/** @satisfies {Record<string, any>} */
const CfxFlares = {
    /** @type {any[]} */ slots: [],
    next: 0, ready: false,
    /** @type {any} */ texRing: null,
    /** @type {any} */ texGlow: null,

    init(/** @type {any} */ view) {
        const scene = view.scene || view;
        this.dispose();
        this.texRing = new BABYLON.Texture(CFX_TEX.ring, scene, false, false, BABYLON.Texture.TRILINEAR_SAMPLINGMODE);
        this.texGlow = new BABYLON.Texture(CFX_TEX.glow, scene, false, false, BABYLON.Texture.TRILINEAR_SAMPLINGMODE);
        this.texRing.hasAlpha = this.texGlow.hasAlpha = true;
        for (let i = 0; i < CFX_FLARES; i++) {
            const mesh = BABYLON.MeshBuilder.CreatePlane('cfx-flare', { size: 1 }, scene);
            const mat = new BABYLON.StandardMaterial('cfx-flare-mat', scene);
            mat.disableLighting = true; mat.diffuseColor = new BABYLON.Color3(0, 0, 0); mat.specularColor = new BABYLON.Color3(0, 0, 0);
            mat.emissiveColor = new BABYLON.Color3(1, 1, 1);
            mat.useAlphaFromDiffuseTexture = true;
            mat.backFaceCulling = false; mat.disableDepthWrite = true; mat.zOffset = -4;
            mat.alphaMode = BABYLON.Engine.ALPHA_ADD;
            mat.metadata = { toon: false };
            mesh.material = mat;
            mesh.isPickable = false; mesh.receiveShadows = false; mesh.rotationQuaternion = new BABYLON.Quaternion();
            mesh.setEnabled(false);
            this.slots.push({ mesh, mat, t: 0, life: 0, r0: 0, r1: 0, a: 0, active: false, ease: 1 });
        }
        this.ready = true;
    },

    dispose() {
        for (const s of this.slots) { try { s.mat.dispose(); s.mesh.dispose(); } catch (e) { /* уже */ } }
        this.slots = [];
        for (const t of [this.texRing, this.texGlow]) if (t) { try { t.dispose(); } catch (e) { /* уже */ } }
        this.texRing = this.texGlow = null; this.ready = false;
    },

    clear() { for (const s of this.slots) { s.active = false; s.mesh.setEnabled(false); } },

    /** kind: 'ring' | 'glow'. Лежит на плоскости с нормалью (nx, ny, nz); радиус r0 -> r1 за life с, затухая от alpha. */
    spawn(/** @type {string} */ kind, x, y, z, nx, ny, nz, r0, r1, life, alpha, /** @type {number[]} */ color) {
        if (!this.ready) return;
        const s = this.slots[this.next];
        this.next = (this.next + 1) % this.slots.length;
        s.mat.diffuseTexture = kind === 'ring' ? this.texRing : this.texGlow;
        s.mat.emissiveColor.set(color[0], color[1], color[2]);
        s.mesh.position.set(x + nx * 2, y + ny * 2, z + nz * 2);
        BABYLON.Quaternion.FromUnitVectorsToRef(CfxFlares.up, new BABYLON.Vector3(nx, ny, nz), s.mesh.rotationQuaternion);
        s.t = 0; s.life = life; s.r0 = r0; s.r1 = r1; s.a = alpha; s.active = true; s.ease = kind === 'ring' ? 0.5 : 0.7;
        s.mesh.scaling.set(r0 * 2, r0 * 2, 1);
        s.mesh.visibility = alpha;
        s.mesh.setEnabled(true);
    },

    up: null,

    update(/** @type {number} */ dt) {
        for (const s of this.slots) {
            if (!s.active) continue;
            s.t += dt;
            const k = s.t / s.life;
            if (k >= 1) { s.active = false; s.mesh.setEnabled(false); continue; }
            const e = 1 - Math.pow(1 - k, 1 + s.ease * 2);
            const r = s.r0 + (s.r1 - s.r0) * e;
            s.mesh.scaling.x = s.mesh.scaling.y = r * 2;
            const fade = (1 - k);
            s.mesh.visibility = s.a * fade * fade;
        }
    },
};

// ================================================================================================
// Постоянный источник пара, дыма и огня у машины
// ================================================================================================
class CfxEmitter {
    constructor(/** @type {() => any} */ follow) {
        this.follow = follow;
        this.steam = 0; this.smoke = 0; this.fire = 0;
        this.k = { steam: 0, smoke: 0, fire: 0 };       // сглаженные уровни
        /** @type {Record<string, any>} */ this.h = { steam: null, smoke: null, flame: null, glow: null };
        this.idle = 0; this.stopped = false; this.dead = false;
        this.pos = { x: 0, y: 0, z: 0 };            // точка источника на этот кадр (follow() зовётся один раз)
        this.cached = () => this.pos;
        /** @type {any} */ this.loopSteam = null;
        /** @type {any} */ this.loopFire = null;
        this.volSteam = 0; this.volFire = 0; this.dist = 0;
    }

    set(/** @type {number} */ steam, /** @type {number} */ smoke, /** @type {number} */ fire) {
        if (this.stopped) return;
        this.steam = cfxClamp(+steam || 0, 0, 1); this.smoke = cfxClamp(+smoke || 0, 0, 1); this.fire = cfxClamp(+fire || 0, 0, 1);
        if (this.steam + this.smoke + this.fire > 0) this.idle = 0;
    }

    stop() {
        this.stopped = true; this.steam = this.smoke = this.fire = 0;
    }

    /** Создать систему слоя при первой нужде. */
    ensure(/** @type {string} */ name, /** @type {any} */ fx) {
        if (this.h[name]) return this.h[name];
        const follow = this.cached;
        let o = null;
        if (name === 'steam') {
            o = { texture: CFX_TEX.dust, blend: 'standard', rate: 0, capacity: 90, life: [0.9, 1.9], size: [1, 1], speed: [1, 1], follow,
                box: [[-8, 0, -8], [8, 6, 8]], direction: [[-20, 80, -20], [20, 170, 20]], gravity: [CFX_WIND[0] * 0.7, 36, CFX_WIND[1] * 0.7],
                sheet: { width: 256, height: 256, start: 0, end: 3, speed: 0, loop: false, randomStart: true },
                colorGradient: [[0, '#ffffff', 0], [0.1, '#ffffff', 0.7], [0.55, '#eef4fb', 0.38], [1, '#dde8f4', 0]], sizeGradient: [[0, 24], [0.3, 52], [1, 104]] };
        } else if (name === 'smoke') {
            o = { texture: CFX_TEX.smoke, blend: 'standard', rate: 0, capacity: 130, life: [2.2, 4], size: [1, 1], speed: [1, 1], follow,
                box: [[-10, 0, -10], [10, 8, 10]], direction: [[-26, 90, -26], [26, 190, 26]], gravity: [CFX_WIND[0], 54, CFX_WIND[1]],
                sheet: { width: 256, height: 256, start: 0, end: 3, speed: 0, loop: false, randomStart: true },
                colorGradient: [[0, '#8c8c92', 0], [0.08, '#7a7a80', 0.85], [0.35, '#4a4a50', 0.8], [0.7, '#202022', 0.6], [1, '#0c0c0e', 0]], sizeGradient: [[0, 26], [0.25, 62], [1, 170]] };
        } else if (name === 'flame') {
            o = { texture: CFX_TEX.fire, rate: 0, capacity: 80, life: [0.5, 0.95], size: [1, 1], speed: [1, 1], follow,
                box: [[-22, 0, -22], [22, 8, 22]], direction: [[-14, 70, -14], [14, 150, 14]], gravity: [0, 60, 0],
                sheet: { width: 128, height: 128, start: 0, end: 15, speed: 1, loop: false, randomStart: false },
                colorGradient: [[0, '#ffffff', 0], [0.1, '#fff3d8', 1], [0.5, '#ffb060', 0.85], [0.85, '#d85020', 0.4], [1, '#301008', 0]], sizeGradient: [[0, 90], [0.35, 150], [1, 80]] };
        } else if (name === 'glow') {
            o = { texture: CFX_TEX.glow, rate: 0, capacity: 60, life: [0.7, 1.6], size: [1, 1], speed: [1, 1], follow,
                box: [[-28, 4, -28], [28, 30, 28]], direction: [[-30, 50, -30], [30, 160, 30]], gravity: [0, 60, 0],
                colorGradient: [[0, '#fff0c0', 0], [0.12, '#ffc060', 0.9], [0.6, '#ff7a28', 0.5], [1, '#401008', 0]], sizeGradient: [[0, 14], [0.4, 28], [1, 6]] };
        }
        if (!o) return null;
        const h = fx.create(o);
        if (!h) return null;
        this.h[name] = h;
        CrashFx._emSystems.push(h.system);
        return h;
    }

    update(/** @type {number} */ dt, /** @type {any} */ fx, /** @type {number} */ dist, /** @type {number} */ lq) {
        const k = this.k, a = Math.min(1, dt * 5);
        k.steam += (this.steam - k.steam) * a; k.smoke += (this.smoke - k.smoke) * a; k.fire += (this.fire - k.fire) * a;
        const far = dist > CFX_FAR_FX ? 0 : dist > CFX_MID_FX ? 0.5 : 1;
        this.dist = dist;
        const s = k.steam, m = k.smoke, f = k.fire;
        const active = s > 0.015 || m > 0.015 || f > 0.015;
        if (!active) { this.idle += dt; if (this.idle > 3) this.release(); }
        const lvl = far * lq;
        if (s > 0.015 && lvl > 0) { const h = this.ensure('steam', fx); if (h) h.setRate((7 + 52 * s) * lvl); }
        else if (this.h.steam) this.h.steam.setRate(0);
        if (m > 0.015 && lvl > 0) { const h = this.ensure('smoke', fx); if (h) h.setRate((5 + 34 * m) * lvl); }
        else if (this.h.smoke) this.h.smoke.setRate(0);
        if (f > 0.015 && lvl > 0) {
            const h = this.ensure('flame', fx); if (h) h.setRate((8 + 46 * f) * lvl * (0.85 + Math.random() * 0.3));
            const g = this.ensure('glow', fx); if (g) g.setRate((6 + 40 * f) * lvl);
        } else { if (this.h.flame) this.h.flame.setRate(0); if (this.h.glow) this.h.glow.setRate(0); }
        // громкость петель (до отбора лучших)
        const dk = dist > CFX_FAR_SND ? 0 : 1 / (1 + Math.pow(dist / CFX_SND_REF, 1.2));
        this.volSteam = s > 0.05 ? Math.min(0.5, (0.12 + 0.4 * s) * dk) : 0;
        this.volFire = f > 0.05 ? Math.min(0.65, (0.18 + 0.5 * f) * dk) : 0;
        return this.stopped && !active && this.idle > 3.5;
    }

    release() {
        for (const n in this.h) {
            const h = this.h[n];
            if (!h) continue;
            h.setRate(0);
            const i = CrashFx._emSystems.indexOf(h.system);
            if (i >= 0) CrashFx._emSystems.splice(i, 1);
            h.stop();
            this.h[n] = null;
        }
        this.endLoops();
    }

    endLoops() {
        if (this.loopSteam) { this.loopSteam.fade(0.3); this.loopSteam = null; }
        if (this.loopFire) { this.loopFire.fade(0.3); this.loopFire = null; }
    }
}

// ================================================================================================
// CrashFx
// ================================================================================================
const CFX_EV = { FIRE2: 2, SMOKE: 3, COLUMN: 4, RING2: 5, SPARKS2: 6 };

/** @satisfies {Record<string, any>} */
const CrashFx = {
    /** @type {any} */ app: null,
    /** @type {any} */ fx: null,
    /** @type {any} */ view: null,
    /** @type {any} */ scene: null,
    /** @type {any} */ _obs: null,
    ready: false, mapReady: false,
    camX: 0, camY: 0, camZ: 0,
    time: 0, rt: 0, dt: 0.016, frame: 0,
    timeScale: 1, _realLast: 0, _tsApplied: 1,
    debugDt: 0,        // стенд (fx-lab) с фиксированным шагом: «реальный» dt кадра, секунды; 0 — измерять
    lq: 1,
    mobile: false,
    windA: 0,
    gImpact: { t: 0, tok: 3 },
    gGlass: { t: 0, tok: 2 },
    gPanel: { t: 0, tok: 2 },
    gTire: { t: 0, tok: 2 },
    gBoom: { t: 0, tok: 1 },
    _hitT: -9, _hitP: 0, _panelT: -9, _glassT: -9,
    /** @type {Map<string, any>} */ _sc: new Map(),
    /** @type {CfxEmitter[]} */ _em: [],
    /** @type {any[]} */ _emSystems: [],
    /** @type {any[]} */ _evs: [],
    /** @type {number[][]} */ _recent: [],
    /** @type {any} */ _leak: null,
    /** @type {any} */ _lastScorch: null,
    /** @type {any[]} */ _loud: [],
    /** @type {any[]} */ _live: [],
    _snd: { preloaded: false },
    _rebuildT: 0,
    _scratchN: [0, 1, 0],
    _scratchV: [0, 0, 0],

    // ---- Жизненный цикл ----------------------------------------------------------------------

    /** Один раз при старте игры (app.fx уже есть; в 2D — null: частиц нет, остальное работает по мере возможности). */
    init(/** @type {any} */ app) {
        this.app = app || null;
        this.fx = (app && app.fx) || null;
        this.mobile = typeof IS_MOBILE !== 'undefined' && !!IS_MOBILE;
        this._applyQuality();
        this.ready = typeof BABYLON !== 'undefined';
        if (!this.ready) return;
        if (typeof Quality !== 'undefined' && Quality.onChange && !this._offQ) this._offQ = Quality.onChange(() => { this._applyQuality(); if (this.mapReady && this.view) this.bindMap(this.view); });
        CfxFlares.up = new BABYLON.Vector3(0, 0, 1);
        this._realLast = performance.now();
        if (typeof Sound !== 'undefined' && Sound.preload && !this._snd.preloaded) {
            this._snd.preloaded = true;
            Sound.preload([CFX_SND.hitLight, CFX_SND.hitHeavy, CFX_SND.thud, CFX_SND.glass, CFX_SND.tire, CFX_SND.panel, CFX_SND.debris, CFX_SND.boom, [CFX_SND.scrape, CFX_SND.steam, CFX_SND.fire]]);
        }
    },

    /** @type {any} */ _offQ: null,

    _applyQuality() {
        const lvl = typeof Quality !== 'undefined' && Number.isFinite(Quality.level) ? Quality.level : 2;
        this.lq = (CFX_LQ[cfxClamp(lvl | 0, 0, 2)] || 1) * (this.mobile ? CFX_MOBILE_K : 1);
    },

    /** На каждой карте под загрузкой: меши декалей и обломков, пулы частиц — в сцене карты. view — View3D (или сцена). */
    bindMap(/** @type {any} */ view) {
        if (!this.ready || !view) return;
        const scene = view.scene || view;
        if (!scene || typeof scene.render !== 'function') return;
        this.view = view; this.scene = scene;
        this.fx = (this.app && this.app.fx) || this.fx;
        this._applyQuality();
        try {
            CfxDecals.init(view, this.mobile ? CFX_DECAL_MAX_MOBILE : CFX_DECAL_MAX);
            CfxDebris.init(view, this.mobile ? CFX_DEBRIS_MAX_MOBILE : CFX_DEBRIS_MAX);
            CfxFlares.init(view);
            CfxPools.build(this.fx);
        } catch (e) { console.warn('CrashFx.bindMap:', e); }
        if (this._obs) { try { this._obsScene.onBeforeParticlesRenderingObservable.remove(this._obs); } catch (e) { /* сцена умерла */ } }
        this._obsScene = scene;
        this._obs = scene.onBeforeParticlesRenderingObservable.add(() => this._beforeParticles());
        this._sc.clear(); this._evs.length = 0; this._recent.length = 0; this._leak = null;
        this._em = this._em.filter(e => !e.dead);
        for (const e of this._em) { e.h = { steam: null, smoke: null, flame: null, glow: null }; e.loopSteam = e.loopFire = null; }
        this._emSystems.length = 0;
        this.mapReady = true;
    },

    /** @type {any} */ _obsScene: null,

    /** Новый заезд: убрать декали, обломки, залпы и задержанные события. */
    clear() {
        CfxDecals.clear(); CfxDebris.clear(); CfxFlares.clear(); CfxPools.reset();
        this._evs.length = 0; this._recent.length = 0; this._leak = null;
        for (const st of this._sc.values()) this._scEnd(st);
        this._sc.clear();
    },

    // Перед рисованием частиц сцены: скорость симуляции систем = скорость игрового времени.
    _beforeParticles() {
        const paused = typeof Pause !== 'undefined' && Pause.active;
        const speed = paused ? 0 : (1 / 60) * this.timeScale;
        this._tsApplied = speed;
        const a = CfxPools.all, b = this._emSystems;
        for (let i = 0; i < a.length; i++) a[i].updateSpeed = speed;
        for (let i = 0; i < b.length; i++) b[i].updateSpeed = speed;
    },

    /** Каждый кадр. dt — секунды игрового времени (с замедлением), камера — для отсечения по расстоянию. */
    update(/** @type {number} */ dt, /** @type {number} */ camX, /** @type {number} */ camY, /** @type {number} */ camZ) {
        if (!this.ready || !this.mapReady) return;
        if (typeof Pause !== 'undefined' && Pause.active) return;
        dt = cfxClamp(+dt || 0, 0, 0.1);
        const now = performance.now();
        const gap = this.debugDt > 0 ? this.debugDt : Math.max(0.0005, (now - this._realLast) / 1000);
        this._realLast = now;
        this.rt = now / 1000;
        // замедление игры = игровой dt против реального; кадр после затыка (gap > 0.12 с) ничего не говорит о замедлении
        if (gap <= 0.12) {
            const ts = dt > 0 ? cfxClamp(dt / gap, 0.04, 1) : 0.04;
            this.timeScale += (ts - this.timeScale) * 0.35;
            if (this.timeScale > 0.97) this.timeScale = 1;
        }
        this.dt = dt; this.time += dt; this.frame++;
        this.camX = camX || 0; this.camY = camY || 0; this.camZ = camZ || 0;
        // ветер плавно гуляет
        this.windA += dt * 0.15;
        const wk = 0.75 + 0.5 * Math.sin(this.windA), wx = CFX_WIND[0] * wk, wz = CFX_WIND[1] * Math.cos(this.windA * 0.7);
        const sm = CfxPools.pools.smoke;
        if (sm) for (const it of sm.items) if (!it.dead) { it.ps.gravity.x = wx; it.ps.gravity.z = wz; }
        // события взрыва
        for (let i = this._evs.length - 1; i >= 0; i--) {
            const e = this._evs[i];
            e.t -= dt;
            if (e.t <= 0) { this._evs.splice(i, 1); this._runEvent(e); }
        }
        this._updateScrape();
        this._updateEmitters(dt);
        CfxPools.flush(this.frame);
        CfxDecals.update(dt);
        CfxDebris.update(dt, this.rt);
        CfxFlares.update(dt);
        // пулы пережили fx.clear() (смена карты без bindMap) — пересоздаём
        if (this.fx && CfxPools.all.length && now - this._rebuildT > 2000) {
            this._rebuildT = now;
            const pools = CfxPools.pools;
            let alive = 0, total = 0;
            for (const n in pools) for (const it of pools[n].items) { total++; if (!it.dead) alive++; }
            if (total && !alive) CfxPools.build(this.fx);
        }
    },

    // ---- Запросы мира ------------------------------------------------------------------------

    /** Высота земли под (x, z) около высоты y; null — земли нет. Игра подменяет своей. */
    groundY(/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z) {
        let best = null;
        // @ts-ignore GameWorld (js/GameWorld.js) объявлен другой частью проекта
        const gw = typeof GameWorld !== 'undefined' ? GameWorld : null;
        if (gw && typeof gw.heightAt === 'function') { const h = gw.heightAt(x, z); if (typeof h === 'number' && Number.isFinite(h)) best = h; }
        if (typeof ObbyCourse !== 'undefined' && ObbyCourse && typeof ObbyCourse.rayDown === 'function') {
            const hit = ObbyCourse.rayDown(x, y + 40, z, 2600, 0.3, true);
            if (hit && (best === null || hit.y > best)) best = hit.y;
        }
        return best;
    },

    _d2(/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z) {
        const dx = x - this.camX, dy = y - this.camY, dz = z - this.camZ;
        return dx * dx + dy * dy + dz * dz;
    },

    /** Доля частиц по расстоянию и качеству (0 — не запускать). */
    _lod(/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z) {
        const d2 = this._d2(x, y, z);
        if (d2 > CFX_FAR_FX * CFX_FAR_FX) return 0;
        return this.lq * (d2 > CFX_MID_FX * CFX_MID_FX ? 0.5 : 1);
    },

    // ---- Звук --------------------------------------------------------------------------------

    sfxOn() {
        if (typeof Sound === 'undefined' || !Sound.ctx || Sound.silent) return false;
        // @ts-ignore Game — глобал игры, в чистом движке его нет
        const g = typeof Game !== 'undefined' ? Game : null;
        return !(g && g.save && g.save.sfx === false);
    },

    /** Разовый звук (путь или варианты), громкость vol 0..1, скорость rate. */
    sfx(/** @type {any} */ urls, /** @type {number} */ vol, /** @type {number} */ rate) {
        if (!this.sfxOn() || !(vol >= 0.01)) return null;     // NaN громкости роняет Web Audio
        return Sound.play(urls, { volume: cfxClamp(vol, 0, 1), rate: rate || 1 });
    },

    /** Звук в точке мира: громкость падает с расстоянием до камеры. */
    sfxAt(/** @type {any} */ urls, /** @type {number} */ vol, /** @type {number} */ rate, x, y, z) {
        const d = Math.sqrt(this._d2(x, y, z));
        if (d > CFX_FAR_SND) return null;
        return this.sfx(urls, vol / (1 + Math.pow(d / CFX_SND_REF, 1.2)), rate);
    },

    // ---- Залпы частиц: короткие обёртки ------------------------------------------------------

    /** Искры из точки по направлению (dx, dy, dz — скорость px/с) с разбросом sp. */
    _sparks(x, y, z, dx, dy, dz, sp, n, power) {
        const b = CfxPools.rec('spark', this.frame);
        if (!b || n < 1) return;
        b.n = n; b.x = x; b.y = y; b.z = z; b.dx = dx; b.dy = dy; b.dz = dz; b.sx = b.sy = b.sz = sp;
        b.v0 = 0.55; b.v1 = 1.15;
        b.s0 = 3.5; b.s1 = 6.5; b.u0 = 34 * (0.5 + power); b.u1 = 100 * (0.5 + power);
        b.l0 = 0.28; b.l1 = 0.62 + 0.3 * power;
    },

    _flash(x, y, z, size, life, /** @type {number[]} */ c, n) {
        const b = CfxPools.rec('flash', this.frame);
        if (!b) return;
        b.n = n || 1; b.x = x; b.y = y; b.z = z; b.s0 = size * 0.85; b.s1 = size; b.u0 = size * 0.85; b.u1 = size;
        b.l0 = life * 0.8; b.l1 = life; b.r1 = b.r2 = c[0]; b.g1 = b.g2 = c[1]; b.b1 = b.b2 = c[2]; b.a1 = b.a2 = 1; b.deadA = 0; b.w0 = -2; b.w1 = 2;
    },

    _dust(x, y, z, dx, dy, dz, sp, n, size, life, /** @type {number[]} */ c, alpha) {
        const b = CfxPools.rec('dust', this.frame);
        if (!b || n < 1) return;
        b.n = n; b.x = x; b.y = y; b.z = z; b.dx = dx; b.dy = dy; b.dz = dz; b.sx = b.sy = b.sz = sp;
        b.s0 = b.u0 = size * 0.7; b.s1 = b.u1 = size * 1.2; b.l0 = life * 0.6; b.l1 = life;
        b.r1 = c[0]; b.g1 = c[1]; b.b1 = c[2]; b.a1 = alpha; b.r2 = c[0] * 0.9; b.g2 = c[1] * 0.9; b.b2 = c[2] * 0.9; b.a2 = alpha * 0.8; b.deadA = 0;
        b.w0 = -1.2; b.w1 = 1.2; b.bx = 6; b.by = 2; b.bz = 6;
    },

    /** Вихрь пыли: залпы пыли с поворотом направления на каждом шаге — клубы закручиваются спиралью и поднимаются. */
    _swirl(x, y, z, /** @type {number} */ steps, size, /** @type {number[]} */ c, power, /** @type {number} */ a0) {
        for (let i = 0; i < steps; i++) {
            const b = CfxPools.rec('dust', this.frame);
            if (!b) return;
            const a = a0 + i * 2.2, v = 110 + 190 * power;
            b.n = 2 + ((Math.random() * 2) | 0); b.x = x; b.y = y + 4; b.z = z;
            b.dx = Math.cos(a) * v; b.dy = 80 + 140 * power; b.dz = Math.sin(a) * v; b.sx = b.sy = b.sz = 40;
            b.s0 = b.u0 = size * 0.7; b.s1 = b.u1 = size * 1.25; b.l0 = 1.0; b.l1 = 1.8;
            b.r1 = c[0]; b.g1 = c[1]; b.b1 = c[2]; b.a1 = 0.42 + 0.2 * power; b.r2 = c[0] * 0.9; b.g2 = c[1] * 0.9; b.b2 = c[2] * 0.9; b.a2 = 0.3 + 0.2 * power; b.deadA = 0;
            b.w0 = -2.4; b.w1 = 2.4; b.bx = 14; b.by = 3; b.bz = 14;
        }
    },

    _crumbs(x, y, z, dx, dy, dz, sp, n, size, /** @type {number[]} */ c, life) {
        const b = CfxPools.rec('crumb', this.frame);
        if (!b || n < 1) return;
        b.n = n; b.x = x; b.y = y; b.z = z; b.dx = dx; b.dy = dy; b.dz = dz; b.sx = b.sy = b.sz = sp;
        b.v0 = 0.5; b.v1 = 1.15; b.s0 = b.u0 = size * 0.6; b.s1 = b.u1 = size * 1.2; b.l0 = (life || 0.9) * 0.55; b.l1 = life || 0.9;
        const j = 0.85 + Math.random() * 0.3;
        b.r1 = c[0] * j; b.g1 = c[1] * j; b.b1 = c[2] * j; b.a1 = 1; b.r2 = c[0] * 1.1; b.g2 = c[1] * 1.1; b.b2 = c[2] * 1.1; b.a2 = 1; b.deadA = 1;
        b.w0 = -9; b.w1 = 9; b.bx = 5; b.by = 3; b.bz = 5;
    },

    _smoke(x, y, z, dx, dy, dz, sp, n, size, life, /** @type {number[]} */ c, alpha, up) {
        const b = CfxPools.rec('smoke', this.frame);
        if (!b || n < 1) return;
        b.n = n; b.x = x; b.y = y; b.z = z; b.dx = dx; b.dy = dy + (up || 0); b.dz = dz; b.sx = b.sy = b.sz = sp;
        b.s0 = b.u0 = size * 0.7; b.s1 = b.u1 = size * 1.15; b.l0 = life * 0.65; b.l1 = life;
        b.r1 = c[0]; b.g1 = c[1]; b.b1 = c[2]; b.a1 = alpha; b.r2 = c[0] * 0.8; b.g2 = c[1] * 0.8; b.b2 = c[2] * 0.8; b.a2 = alpha * 0.85; b.deadA = 0;
        b.w0 = -0.45; b.w1 = 0.45; b.bx = 10; b.by = 6; b.bz = 10;
    },

    _fire(x, y, z, dx, dy, dz, sp, n, size, life) {
        const b = CfxPools.rec('fire', this.frame);
        if (!b || n < 1) return;
        b.n = n; b.x = x; b.y = y; b.z = z; b.dx = dx; b.dy = dy; b.dz = dz; b.sx = b.sy = b.sz = sp;
        b.s0 = b.u0 = size * 0.7; b.s1 = b.u1 = size * 1.15; b.l0 = life * 0.6; b.l1 = life; b.bx = 14; b.by = 6; b.bz = 14;
    },

    _ball(x, y, z, dx, dy, dz, sp, n, size, life) {
        const b = CfxPools.rec('ball', this.frame);
        if (!b || n < 1) return;
        b.n = n; b.x = x; b.y = y; b.z = z; b.dx = dx; b.dy = dy; b.dz = dz; b.sx = b.sy = b.sz = sp;
        b.s0 = b.u0 = size * 0.75; b.s1 = b.u1 = size * 1.15; b.l0 = life * 0.6; b.l1 = life; b.w0 = -0.6; b.w1 = 0.6; b.bx = 22; b.by = 10; b.bz = 22;
    },

    _embers(x, y, z, dx, dy, dz, sp, n, size, life) {
        const b = CfxPools.rec('ember', this.frame);
        if (!b || n < 1) return;
        b.n = n; b.x = x; b.y = y; b.z = z; b.dx = dx; b.dy = dy; b.dz = dz; b.sx = b.sy = b.sz = sp;
        b.s0 = b.u0 = size * 0.5; b.s1 = b.u1 = size; b.l0 = life * 0.55; b.l1 = life; b.bx = 10; b.by = 5; b.bz = 10;
    },

    /** Горсть обломков: kinds — набор видов; цвет (r, g, b) или null (случайный из серой палитры). */
    _debris(x, y, z, vx, vy, vz, spread, n, /** @type {number[]} */ kinds, size, /** @type {number[] | null} */ color) {
        if (!CfxDebris.ready) return;
        for (let i = 0; i < n; i++) {
            const k = kinds[(Math.random() * kinds.length) | 0];
            let r, g, b;
            if (color) { const j = 0.8 + Math.random() * 0.35; r = color[0] * j; g = color[1] * j; b = color[2] * j; }
            else if (k === 3) { r = 0.78; g = 0.92; b = 1; }
            else if (k === 2) { const m = 0.55 + Math.random() * 0.3; r = m; g = m; b = m * 1.04; }
            else { const m = Math.random(); if (m < 0.62) { const t = 0.07 + Math.random() * 0.13; r = g = b = t; } else { const t = 0.34 + Math.random() * 0.26; r = g = b = t; } }
            const s = size * cfxRnd(0.35, 0.95);
            CfxDebris.spawn(k, x + cfxRnd(-6, 6), y + cfxRnd(0, 6), z + cfxRnd(-6, 6), vx + cfxRnd(-spread, spread), vy + cfxRnd(-spread * 0.4, spread), vz + cfxRnd(-spread, spread), s, r, g, b);
        }
    },

    // ---- Публичные события -------------------------------------------------------------------

    /** Удар: искры, вспышка, пыль, крошка, обломки, декали на статичной поверхности, звук по силе. */
    impact(/** @type {number[]} */ q, /** @type {number[]} */ n, /** @type {number} */ power01, /** @type {string} */ surface, /** @type {boolean=} */ noDecal) {
        if (!this.ready || !q) return;
        const p = cfxClamp(+power01 || 0, 0, 1);
        const x = q[0], y = q[1], z = q[2];
        const nx = n ? n[0] : 0, ny = n ? n[1] : 1, nz = n ? n[2] : 0;
        const s = CFX_SURF[surface] || CFX_SURF.concrete;
        this._impactSound(p, surface, x, y, z);
        const lod = this._lod(x, y, z);
        if (lod <= 0 || !this.mapReady) return;
        if (!cfxGate(this.gImpact, this.rt, CFX_IMPACT_RATE, CFX_IMPACT_BURST)) return;
        const px = x + nx * 2, py = y + ny * 2, pz = z + nz * 2;
        // искры
        if (s.sparks > 0 && p > 0.05) {
            const cnt = (4 + 36 * p) * s.sparks * lod;
            const v = 260 + 760 * p;
            this._sparks(px, py, pz, nx * v, ny * v + 160, nz * v, 330 + 520 * p, cnt, p);
        }
        // вспышка
        if (s.sparks > 0.4 && p > 0.2) this._flash(px, py, pz, 70 + 260 * p, 0.09 + 0.07 * p, [1, 0.93, 0.74], 1);
        // пыль и крошка
        if (s.dust && p > 0.1) this._dust(px, py, pz, nx * (50 + 170 * p), ny * (50 + 170 * p) + 25, nz * (50 + 170 * p), 120 + 180 * p, (2 + 7 * p) * lod, (62 + 82 * p), 0.8 + 0.9 * p, s.dust, 0.42 + 0.3 * p);
        if (p > 0.38 && (surface === 'dirt' || surface === 'grass' || surface === 'sand') && s.dust) this._swirl(px, py, pz, 3 + Math.round(5 * p * lod), 70 + 60 * p, s.dust, p, Math.random() * 6.28);
        if (s.chip && p > 0.14) this._crumbs(px, py, pz, nx * (260 + 640 * p), ny * (260 + 640 * p) + 120, nz * (260 + 640 * p), 360 + 480 * p, (3 + 24 * p) * lod, 6 + 8 * p, s.chip, 0.8);
        if (surface === 'wood' && p > 0.2) this._debris(px, py, pz, nx * 240, ny * 240 + 200, nz * 240, 230, Math.round((2 + 8 * p) * lod), [2], 12, [0.72, 0.55, 0.34]);
        if (p > 0.7 && s.dust) this._smoke(px, py, pz, nx * 40, ny * 40, nz * 40, 40, 1 + 2 * p, 110 + 70 * p, 1.6, [0.5, 0.5, 0.52], 0.5, 60);
        // обломки
        if (p > 0.3 && (surface === 'metal' || surface === 'car' || surface === 'concrete' || surface === 'plastic')) {
            const kinds = surface === 'concrete' ? [0] : surface === 'plastic' ? [0, 1] : [0, 2, 1];
            const col = surface === 'concrete' ? [0.62, 0.6, 0.57] : null;
            this._debris(px, py, pz, nx * (170 + 500 * p), ny * (170 + 500 * p) + 140, nz * (170 + 500 * p), 220 + 260 * p, Math.round((2 + 9 * p) * lod), kinds, 8 + 6 * p, col);
        }
        // декали статичной поверхности
        if (!noDecal && p >= CFX_DECAL_IMPACT_P && CfxDecals.ready && this._decalFree(x, y, z, 80)) {
            const size = 120 + 330 * p;
            if (surface === 'concrete') {
                this.decal('crack', q, n, size, cfxRnd(0, 6.28), 0.88);
                if (p > 0.6) this.decal('chip', q, n, size * 0.55, cfxRnd(0, 6.28), 0.95);
            } else if (surface === 'asphalt') {
                if (p > 0.5) this.decal('chip', q, n, size * 0.5, cfxRnd(0, 6.28), 0.9);
                if (p > 0.6) this.decal('crack', q, n, size * 0.7, cfxRnd(0, 6.28), 0.7);
            } else if (surface === 'metal') {
                this._scuff(q, nx, ny, nz, 70 + 150 * p, 0.8);
            } else if (surface === 'wood' && p > 0.55) {
                this.decal('chip', q, n, size * 0.4, cfxRnd(0, 6.28), 0.8);
            }
        }
    },

    _impactSound(p, surface, x, y, z) {
        if (!this.sfxOn()) return;
        if (this.rt - this._hitT < CFX_SND_GAP_HIT && p < this._hitP + 0.2) return;
        this._hitT = this.rt; this._hitP = p;
        const heavy = p > 0.6, mid = p > 0.32;
        const rate = 1.12 - 0.3 * p;
        if (surface === 'dirt') { this.sfxAt(CFX_SND.thud, 0.35 + 0.65 * p, 1.1 - 0.2 * p, x, y, z); return; }
        if (surface === 'wood') { this.sfxAt(CFX_SND.thud, 0.3 + 0.5 * p, 1.5, x, y, z); this.sfxAt(CFX_SND.hitLight, 0.2 + 0.4 * p, 0.8, x, y, z); return; }
        if (surface === 'plastic') { this.sfxAt(CFX_SND.hitLight, 0.2 + 0.7 * p, 1.35, x, y, z); return; }
        if (!mid) { this.sfxAt(CFX_SND.hitLight, 0.18 + 0.95 * p, rate, x, y, z); return; }
        this.sfxAt(CFX_SND.hitLight, 0.55, rate + 0.05, x, y, z);
        this.sfxAt(CFX_SND.hitHeavy, heavy ? 0.7 + 0.3 * p : (p - 0.3) * 2.2, rate, x, y, z);
        if (heavy && (surface === 'concrete' || surface === 'asphalt')) this.sfxAt(CFX_SND.thud, 0.55 + 0.35 * p, 1, x, y, z);
    },

    /** Нет ли рядом свежей декали удара (чтобы повторные удары не клали сотню трещин в одно место). */
    _decalFree(x, y, z, r) {
        const t = this.time, R = this._recent;
        for (let i = R.length - 1; i >= 0; i--) {
            const e = R[i];
            if (t - e[3] > 1.1) { R.splice(i, 1); continue; }
            if (Math.abs(e[0] - x) < r && Math.abs(e[1] - y) < r && Math.abs(e[2] - z) < r) return false;
        }
        R.push([x, y, z, t]);
        if (R.length > 12) R.shift();
        return true;
    },

    /** Царапина-«потёртость» на металле: короткая полоса вдоль поверхности. */
    _scuff(q, nx, ny, nz, len, alpha) {
        const ang = cfxRnd(0, 6.28);
        const sz = 22 + len * 0.18;
        CfxDecals.add(CFX_CELLS.gouge[(Math.random() * 2) | 0], (Math.random() * 2) | 0, q[0], q[1], q[2], nx, ny, nz, sz * 0.5, len * 0.5, ang, alpha, CFX_LIFT.gouge, false, null);
    },

    /**
     * Трение каждый кадр, пока оно есть: поток искр вдоль v, пыль, борозда-лента на поверхности, петля скрежета (key — своя на каждый источник).
     * Ничего не выделяет на горячем пути (после первого кадра на ключ).
     */
    scrape(/** @type {string} */ key, /** @type {number[]} */ q, /** @type {number[]} */ n, /** @type {number[]} */ v, /** @type {number} */ power01, /** @type {string} */ surface) {
        if (!this.ready || !q) return;
        let st = this._sc.get(key);
        if (!st) st = this._scNew(key);
        const p = cfxClamp(+power01 || 0, 0, 1);
        const vx = v ? v[0] : 0, vy = v ? v[1] : 0, vz = v ? v[2] : 0;
        const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
        st.t = this.rt; st.p = p; st.speed = speed; st.surf = surface; st.x = q[0]; st.y = q[1]; st.z = q[2];
        if (speed < CFX_SCRAPE_MIN_SPEED || p < 0.03 || !this.mapReady) { st.p = 0; return; }
        const lod = this._lod(q[0], q[1], q[2]);
        if (lod <= 0) return;
        const s = CFX_SURF[surface] || CFX_SURF.concrete;
        const nx = n ? n[0] : 0, ny = n ? n[1] : 1, nz = n ? n[2] : 0;
        const dt = Math.min(this.dt || 0.016, 0.05);
        const px = q[0] + nx * 2, py = q[1] + ny * 2, pz = q[2] + nz * 2;
        const sp = Math.min(1.5, speed / 700);
        // искры: летят вдоль движения, вверх от поверхности
        if (s.sparks > 0) {
            st.accS += (22 + 230 * p) * s.sparks * Math.max(0.2, sp) * lod * dt;
            const c = Math.floor(st.accS);
            if (c > 0) {
                st.accS -= c;
                const k = 0.55, up = 180 + 260 * p;
                this._sparks(px, py, pz, vx * k + nx * up, vy * k + ny * up, vz * k + nz * up, 150 + 260 * p, c, p);
            }
            if (p > 0.5 && Math.random() < 0.22 * dt * 60 * 0.25) this._flash(px, py, pz, 40 + 70 * p, 0.07, [1, 0.8, 0.5], 1);
        }
        // пыль и дымок по поверхности
        if (s.dust) {
            st.accD += (5 + 22 * p) * Math.max(0.25, sp) * lod * dt;
            const c = Math.floor(st.accD);
            if (c > 0) {
                st.accD -= c;
                if (surface === 'dirt' || surface === 'grass' || surface === 'sand') { st.swirl += 1.9; this._swirl(px, py, pz, 1, 60 + 60 * p, s.dust, p, st.swirl); }
                else this._dust(px, py, pz, vx * 0.25 + nx * 40, vy * 0.25 + ny * 40 + 20, vz * 0.25 + nz * 40, 90, c, 55 + 60 * p, 0.9, s.dust, 0.34 + 0.2 * p);
            }
        } else if (surface === 'car' || surface === 'metal') {
            st.accD += (3 + 8 * p) * Math.max(0.25, sp) * lod * dt;
            const c = Math.floor(st.accD);
            if (c > 0) { st.accD -= c; this._smoke(px, py, pz, vx * 0.1, vy * 0.1, vz * 0.1, 40, c, 50 + 40 * p, 1.3, [0.45, 0.45, 0.47], 0.3, 40); }
        }
        // борозда-лента: только по поверхностям, на которых остаётся след
        if (CfxDecals.ready && surface !== 'car' && surface !== 'plastic' && p > 0.12 && speed > 90) this._ribbon(st, q, nx, ny, nz, vx, vy, vz, p, surface);
    },

    /** Из-под колеса: пыль на грунте, гравии, траве, песке; дым шин на асфальте и бетоне. key — своё накопление у каждого колеса. */
    wheelFx(/** @type {string} */ key, /** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z, /** @type {number} */ vx, /** @type {number} */ vy, /** @type {number} */ vz, /** @type {number} */ power01, /** @type {string} */ surface) {
        if (!this.ready || !this.mapReady) return;
        const lod = this._lod(x, y, z);
        if (lod <= 0) return;
        const p = cfxClamp(power01, 0, 1), dt = Math.min(this.dt || 0.016, 0.05);
        const map = this._wh || (this._wh = new Map());
        let acc = (map.get(key) || 0) + (3 + 30 * p) * lod * dt;
        const c = Math.floor(acc);
        acc -= c;
        map.set(key, acc);
        if (c <= 0) return;
        const paved = surface === 'asphalt' || surface === 'concrete';
        const s = CFX_SURF[surface] || CFX_SURF.dirt;
        if (paved) this._smoke(x, y + 6, z, vx * 0.22, vy * 0.22 + 30, vz * 0.22, 50, c, 60 + 90 * p, 1.1, [0.78, 0.78, 0.8], 0.14 + 0.22 * p, 50);
        else if (s.dust) this._dust(x, y + 6, z, vx * 0.22, vy * 0.22 + 50, vz * 0.22, 80, c, 70 + 110 * p, 1.1, s.dust, 0.2 + 0.3 * p);
    },

    scrapeEnd(/** @type {string} */ key) {
        const st = this._sc.get(key);
        if (!st) return;
        this._scEnd(st);
        this._sc.delete(key);
    },

    _scNew(/** @type {string} */ key) {
        const st = {
            key, t: this.rt, p: 0, speed: 0, surf: 'metal', x: 0, y: 0, z: 0, accS: 0, accD: 0, swirl: Math.random() * 6.28,
            h: /** @type {any} */ (null), hv: 0, hr: 1, vol: 0, rate: 1,
            rl: false, rx: 0, ry: 0, rz: 0, sx: 0, sy: 0, sz: 0, flip: (Math.random() * 2) | 0, cell: CFX_CELLS.gouge[(Math.random() * 2) | 0], cx: 0, cy: 0, cz: 0,
            edge: new Float32Array(12), edge2: new Float32Array(12), v: Math.random(),
        };
        this._sc.set(key, st);
        return st;
    },

    _scEnd(/** @type {any} */ st) {
        if (st.h) { st.h.fade(0.14); st.h = null; }
        st.rl = false;
    },

    /** Лента борозды: новые квады между точками каждые CFX_DECAL_SEG px, стыкуются по общим краям. */
    _ribbon(/** @type {any} */ st, q, nx, ny, nz, vx, vy, vz, p, surface) {
        const x = q[0], y = q[1], z = q[2];
        if (!st.rl) { st.rl = true; st.rx = x; st.ry = y; st.rz = z; st.sx = 0; st.sy = 0; st.sz = 0; st.v = Math.random(); return; }
        const dx = x - st.rx, dy = y - st.ry, dz = z - st.rz;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > 420) { st.rx = x; st.ry = y; st.rz = z; st.sx = st.sy = st.sz = 0; return; }
        if (d < CFX_DECAL_SEG) return;
        // боковой вектор = n × направление
        let sx = ny * dz - nz * dy, sy = nz * dx - nx * dz, sz = nx * dy - ny * dx;
        const l = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
        const hw = (9 + 17 * p) * (surface === 'dirt' || surface === 'grass' || surface === 'sand' ? 1.3 : 1);
        sx = sx / l * hw; sy = sy / l * hw; sz = sz / l * hw;
        const e = st.edge;
        const has = st.sx !== 0 || st.sy !== 0 || st.sz !== 0;
        const ax = has ? st.sx : sx, ay = has ? st.sy : sy, az = has ? st.sz : sz;
        // порядок вершин квада: (-,-) (+,-) (-,+) (+,+) — «начало слева, начало справа, конец слева, конец справа»
        e[0] = st.rx - ax; e[1] = st.ry - ay; e[2] = st.rz - az;
        e[3] = st.rx + ax; e[4] = st.ry + ay; e[5] = st.rz + az;
        e[6] = x - sx; e[7] = y - sy; e[8] = z - sz;
        e[9] = x + sx; e[10] = y + sy; e[11] = z + sz;
        // узор ячейки тянется вдоль ленты непрерывно: фаза v растёт с пройденным путём, на границе ячейки квад режется надвое
        const E = st.edge2, lift = CFX_LIFT.gouge, al = 0.55 + 0.4 * p, tint = (CFX_SURF[surface] || CFX_SURF.concrete).furrow || null;
        const total = d / Math.max(60, hw * 5);
        let rest = total, t0 = 0, va = st.v;
        while (rest > 1e-4) {
            const step = Math.min(rest, 1 - va), t1 = t0 + step / total;
            for (let k = 0; k < 3; k++) {
                E[k] = e[k] + (e[6 + k] - e[k]) * t0; E[3 + k] = e[3 + k] + (e[9 + k] - e[3 + k]) * t0;
                E[6 + k] = e[k] + (e[6 + k] - e[k]) * t1; E[9 + k] = e[3 + k] + (e[9 + k] - e[3 + k]) * t1;
            }
            CfxDecals.quad(st.cell, st.flip, E, nx, ny, nz, al, lift, va, va + step, tint);
            rest -= step; t0 = t1; va += step;
            if (va >= 1 - 1e-4) va = 0;
        }
        st.v = va;
        st.rx = x; st.ry = y; st.rz = z; st.sx = sx; st.sy = sy; st.sz = sz;
    },

    _updateScrape() {
        const sc = this._sc;
        if (!sc.size) return;
        const loud = this._loud;
        loud.length = 0;
        for (const st of sc.values()) {
            if (this.rt - st.t > 0.14) { this._scEnd(st); sc.delete(st.key); continue; }
            const d = Math.sqrt(this._d2(st.x, st.y, st.z));
            const dk = d > CFX_FAR_SND ? 0 : 1 / (1 + Math.pow(d / CFX_SND_REF, 1.2));
            const sp = Math.min(1.4, st.speed / 800);
            const surfK = st.surf === 'dirt' ? 0.45 : st.surf === 'wood' ? 0.5 : st.surf === 'plastic' ? 0.4 : 1;
            st.vol = st.speed < CFX_SCRAPE_MIN_SPEED ? 0 : Math.min(0.85, (0.1 + 0.8 * st.p) * (0.35 + 0.65 * sp) * dk * surfK);
            st.rate = cfxClamp(0.72 + 0.5 * sp, 0.6, 1.5) * (st.surf === 'concrete' ? 0.9 : st.surf === 'asphalt' ? 1.05 : 1);
            loud.push(st);
        }
        const on = this.sfxOn();
        if (loud.length > CFX_SCRAPE_LOOPS) loud.sort((a, b) => b.vol - a.vol);
        for (let i = 0; i < loud.length; i++) {
            const st = loud[i];
            const want = on && i < CFX_SCRAPE_LOOPS ? st.vol : 0;
            if (want > 0.02) {
                if (!st.h) { st.h = Sound.loop(CFX_SND.scrape, { volume: want, rate: st.rate }); st.hv = want; st.hr = st.rate; }
                else if (Math.abs(want - st.hv) > 0.025 || Math.abs(st.rate - st.hr) > 0.025) { st.h.set(want, st.rate); st.hv = want; st.hr = st.rate; }
            } else if (st.h) { st.h.fade(0.12); st.h = null; }
        }
    },

    /** Стекло разбилось: осколки летят со скоростью v, блики, звон, крошка на земле. size01 — размер стекла 0..1. */
    glass(/** @type {number[]} */ q, /** @type {number[]} */ v, /** @type {number} */ size01) {
        if (!this.ready || !q) return;
        const s = cfxClamp(+size01 || 0.5, 0, 1);
        const x = q[0], y = q[1], z = q[2];
        if (this.sfxOn() && this.rt - this._glassT > 0.05) {
            this._glassT = this.rt;
            this.sfxAt(CFX_SND.glass, 0.4 + 0.6 * s, 1.15 - 0.3 * s, x, y, z);
        }
        const lod = this._lod(x, y, z);
        if (lod <= 0 || !this.mapReady) return;
        const vx = v ? v[0] : 0, vy = v ? v[1] : 0, vz = v ? v[2] : 0;
        const b = CfxPools.rec('shard', this.frame);
        if (b) {
            b.n = (16 + 70 * s) * lod; b.x = x; b.y = y; b.z = z; b.dx = vx * 0.7; b.dy = vy * 0.7 + 90; b.dz = vz * 0.7; b.sx = b.sy = b.sz = 190 + 240 * s;
            b.v0 = 0.6; b.v1 = 1.25; b.s0 = b.u0 = 8; b.s1 = b.u1 = 20 + 10 * s; b.l0 = 0.7; b.l1 = 1.4;
            b.r1 = b.r2 = 0.85; b.g1 = b.g2 = 0.96; b.b1 = b.b2 = 1; b.a1 = b.a2 = 0.95; b.deadA = 0.95; b.w0 = -7; b.w1 = 7; b.bx = 14; b.by = 12; b.bz = 14;
        }
        this._flash(x, y, z, 30 + 40 * s, 0.35, [0.9, 0.97, 1], 2 + Math.round(3 * s * lod));
        this._debris(x, y, z, vx * 0.6, vy * 0.6 + 80, vz * 0.6, 210 + 190 * s, Math.round((5 + 16 * s) * lod), [3, 3, 1], 9 + 6 * s, null);
        // крошка на земле под стеклом
        if (CfxDecals.ready) this._groundDecal('glass', x, y, z, 70 + 190 * s, 0.9);
    },

    /** Декаль на землю под точкой (x, y, z): ищет землю вниз. rot случайный. */
    _groundDecal(/** @type {string} */ kind, x, y, z, size, alpha) {
        const g = typeof this.groundY === 'function' ? this.groundY(x, y, z) : null;
        if (g === null || g === undefined) return -1;
        if (y - g > 520) return -1;
        const n = this._scratchN;
        n[0] = 0; n[1] = 1; n[2] = 0;
        // @ts-ignore GameWorld объявлен другой частью проекта
        const gw = typeof GameWorld !== 'undefined' ? GameWorld : null;
        if (gw && typeof gw.normalAt === 'function') { try { gw.normalAt(x, z, n); } catch (e) { n[0] = 0; n[1] = 1; n[2] = 0; } }
        return this._decal(kind, x, g, z, n[0], n[1], n[2], size, cfxRnd(0, 6.28), alpha);
    },

    /** Отвалилась панель: хруст, пыль и искры, щепотка обломков. kind: 'hood' | 'door' | 'bumper' | 'trunk' | 'wing' | 'mirror'. */
    panelOff(/** @type {number[]} */ q, /** @type {number[]} */ v, /** @type {string} */ kind) {
        if (!this.ready || !q) return;
        const x = q[0], y = q[1], z = q[2];
        const big = kind === 'hood' || kind === 'door' || kind === 'trunk' || kind === 'bumper';
        if (this.sfxOn() && cfxGate(this.gPanel, this.rt, 6, 2)) {
            this.sfxAt(CFX_SND.panel, big ? 0.9 : 0.55, kind === 'mirror' ? 1.4 : kind === 'wing' ? 1.1 : big ? 0.95 : 1.2, x, y, z);
            if (kind === 'door' || kind === 'hood') this.sfxAt(CFX_SND.hitHeavy, 0.5, 1.05, x, y, z);
        }
        const lod = this._lod(x, y, z);
        if (lod <= 0 || !this.mapReady) return;
        const vx = v ? v[0] : 0, vy = v ? v[1] : 0, vz = v ? v[2] : 0;
        this._sparks(x, y, z, vx * 0.2, vy * 0.2 + 120, vz * 0.2, 420, (big ? 24 : 9) * lod, 0.5);
        this._flash(x, y, z, big ? 120 : 70, 0.1, [1, 0.9, 0.7], 1);
        this._dust(x, y, z, vx * 0.1, vy * 0.1 + 30, vz * 0.1, 140, (big ? 5 : 2) * lod, 90, 1.1, [0.5, 0.5, 0.52], 0.4);
        this._debris(x, y, z, vx * 0.3, vy * 0.3 + 120, vz * 0.3, 260, Math.round((big ? 11 : 5) * lod), kind === 'mirror' ? [0, 3] : [0, 2, 1, 2], big ? 11 : 8, null);
    },

    /** Отвалилось колесо. */
    wheelOff(/** @type {number[]} */ q, /** @type {number[]} */ v) {
        if (!this.ready || !q) return;
        const x = q[0], y = q[1], z = q[2];
        if (this.sfxOn() && cfxGate(this.gPanel, this.rt, 6, 2)) {
            this.sfxAt(CFX_SND.panel, 0.85, 0.85, x, y, z);
            this.sfxAt(CFX_SND.hitHeavy, 0.8, 0.9, x, y, z);
        }
        const lod = this._lod(x, y, z);
        if (lod <= 0 || !this.mapReady) return;
        const vx = v ? v[0] : 0, vy = v ? v[1] : 0, vz = v ? v[2] : 0;
        this._sparks(x, y, z, vx * 0.25, vy * 0.25 + 150, vz * 0.25, 520, 32 * lod, 0.7);
        this._flash(x, y, z, 170, 0.12, [1, 0.88, 0.62], 1);
        this._dust(x, y, z, 0, 40, 0, 200, 5 * lod, 110, 1.2, [0.45, 0.44, 0.44], 0.5);
        this._smoke(x, y, z, 0, 0, 0, 60, 2, 90, 1.6, [0.3, 0.3, 0.32], 0.5, 70);
        this._debris(x, y, z, vx * 0.3, vy * 0.3 + 140, vz * 0.3, 300, Math.round(12 * lod), [0, 2, 1], 11, null);
    },

    /** Лопнула шина: хлопок, клочья резины, выдох воздуха и пыли, чёрные клочья на земле. */
    tireBurst(/** @type {number[]} */ q) {
        if (!this.ready || !q) return;
        const x = q[0], y = q[1], z = q[2];
        if (this.sfxOn() && cfxGate(this.gTire, this.rt, 5, 2)) this.sfxAt(CFX_SND.tire, 0.95, 1, x, y, z);
        const lod = this._lod(x, y, z);
        if (lod <= 0 || !this.mapReady) return;
        const black = [0.08, 0.08, 0.09];
        this._crumbs(x, y, z, 0, 220, 0, 520, 20 * lod, 13, black, 1.0);
        this._dust(x, y, z, 0, 60, 0, 260, 4 * lod, 90, 0.9, [0.62, 0.6, 0.57], 0.45);
        this._smoke(x, y, z, 0, 40, 0, 120, 2, 80, 1.3, [0.55, 0.55, 0.56], 0.45, 40);
        this._flash(x, y, z, 70, 0.08, [1, 0.95, 0.85], 1);
        this._debris(x, y, z, 0, 180, 0, 320, Math.round(7 * lod), [2, 0], 11, [0.06, 0.06, 0.07]);
        if (CfxDecals.ready) this._groundDecal('rubber', x, y, z, 120, 0.92);
    },

    /** След на земле под машиной: 'oil' | 'coolant' | 'fuel'. Повторные вызовы рядом растят лужу, редкие — оставляют новую. */
    leak(/** @type {number[]} */ q, /** @type {string} */ kind, /** @type {number} */ power01) {
        if (!this.ready || !q || !CfxDecals.ready) return;
        const p = cfxClamp(+power01 || 0.4, 0, 1);
        const x = q[0], y = q[1], z = q[2];
        const lod = this._lod(x, y, z);
        if (lod <= 0) return;
        const L = this._leak;
        if (L && L.kind === kind && this.time - L.t < 8 && Math.abs(L.x - x) < 70 && Math.abs(L.z - z) < 70 && CfxDecals.born[L.slot] > -1e8 && CfxDecals.cen[L.slot * 4 + 3] > 0) {
            CfxDecals.grow(L.slot, 1 + 0.06 * (0.4 + p), 120 + 70 * p);
            L.t = this.time;
        } else {
            const slot = this._groundDecal(kind, x, y, z, 40 + 36 * p, 0.92);
            if (slot >= 0) this._leak = { slot, kind, x, z, t: this.time };
        }
        // капли
        if (this.mapReady && Math.random() < 0.5 * lod) {
            const c = kind === 'coolant' ? [0.2, 0.85, 0.35] : kind === 'fuel' ? [0.75, 0.55, 0.2] : [0.05, 0.05, 0.06];
            this._crumbs(x, y, z, 0, -30, 0, 22, 1, 6, c, 0.7);
        }
        if (kind === 'coolant' && p > 0.5 && Math.random() < 0.3 * lod) this._smoke(x, y, z, 0, 40, 0, 20, 1, 40, 1.1, [0.95, 0.98, 1], 0.35, 30);
    },

    /** Опалина на поверхности. size — диаметр, px. */
    scorch(/** @type {number[]} */ q, /** @type {number[]} */ n, /** @type {number} */ size) {
        if (!this.ready || !q || !CfxDecals.ready) return;
        const L = this._lastScorch;
        if (L && this.time - L.t < 1.2 && Math.abs(L.x - q[0]) < 200 && Math.abs(L.z - q[2]) < 200 && (size || 160) < L.size * 1.6) return;
        this._lastScorch = { x: q[0], z: q[2], t: this.time, size: size || 160 };
        this._decal('scorch', q[0], q[1], q[2], n ? n[0] : 0, n ? n[1] : 1, n ? n[2] : 0, size || 160, cfxRnd(0, 6.28), 0.92, Math.random() < 0.4);
    },

    /** Взрыв: вспышка, огненный шар, чёрный клубящийся дым, кольцо ударной волны, искры, обломки, опалина, звук. */
    explosion(/** @type {number[]} */ q, /** @type {number} */ power01) {
        if (!this.ready || !q) return;
        const p = cfxClamp(+power01 || 0.7, 0, 1);
        const x = q[0], z = q[2];
        let y = q[1];
        if (this.sfxOn() && cfxGate(this.gBoom, this.rt, 3, 1)) this.sfxAt(CFX_SND.boom, 0.7 + 0.3 * p, 1.05 - 0.2 * p, x, y, z);
        const lod = this._lod(x, y, z);
        if (lod <= 0 || !this.mapReady) return;
        const k = 0.7 + 0.7 * p;
        // центр взрыва — на земле под машиной (если она не высоко в воздухе): кольца и пыль лежат на земле, огненный шар растёт от неё
        const g = typeof this.groundY === 'function' ? this.groundY(x, y, z) : null;
        if (g !== null && g !== undefined && y - g < 250 && y - g > -60) y = g;
        // мгновенное: вспышка, ядро огня, искры, ударная волна по земле, обломки, опалина
        this._flash(x, y + 40, z, 620 * k, 0.17, [1, 0.96, 0.8], 1);
        this._flash(x, y + 50, z, 330 * k, 0.28, [1, 0.8, 0.45], 1);
        // облака-спрайты режутся землёй по плоскости: большие начинаются выше, чтобы у огненного шара не было плоского низа
        this._ball(x, y + 150 * k, z, 0, 190, 0, 280, 12 * lod, 290 * k, 0.8);
        this._fire(x, y + 80 * k, z, 0, 240, 0, 190, 8 * lod, 190 * k, 0.7);
        this._sparks(x, y + 30, z, 0, 750, 0, 1100, 70 * lod, 1);
        this._embers(x, y + 30, z, 0, 140, 0, 330, 34 * lod, 36, 1.8);
        this._dust(x, y + 8, z, 0, 8, 0, 560, 15 * lod, 210 * k, 1.5, [0.58, 0.54, 0.48], 0.6);
        this._crumbs(x, y + 15, z, 0, 650, 0, 850, 30 * lod, 11, [0.3, 0.29, 0.28], 1.2);
        this._debris(x, y + 20, z, 0, 700, 0, 650, Math.round(28 * lod * (0.6 + 0.6 * p)), [0, 2, 1, 0, 2], 12, null);
        CfxFlares.spawn('ring', x, y, z, 0, 1, 0, 40, 600 * k, 0.65, 0.95, [1, 0.85, 0.6]);
        CfxFlares.spawn('glow', x, y, z, 0, 1, 0, 130, 480 * k, 0.5, 0.9, [1, 0.62, 0.25]);
        if (CfxDecals.ready) { this._lastScorch = { x, z, t: this.time, size: 330 * k }; this._groundDecal('scorch', x, y + 12, z, 330 * k, 0.95); }
        // с задержкой (игровое время — замедление растягивает и их)
        this._ev(0.05, CFX_EV.FIRE2, x, y, z, k);
        this._ev(0.12, CFX_EV.SMOKE, x, y, z, k);
        this._ev(0.16, CFX_EV.RING2, x, y, z, k);
        this._ev(0.28, CFX_EV.SPARKS2, x, y, z, k);
        const col = [0.2, 0.35, 0.55, 0.8, 1.05, 1.35, 1.7, 2.1, 2.6];
        for (let i = 0; i < col.length; i++) this._ev(col[i], CFX_EV.COLUMN, x, y, z, k * (1 - i * 0.045));
    },

    _ev(/** @type {number} */ t, /** @type {number} */ id, x, y, z, k) {
        if (this._evs.length > 40) return;
        this._evs.push({ t, id, x, y, z, k });
    },

    _runEvent(/** @type {any} */ e) {
        const lod = this._lod(e.x, e.y, e.z);
        if (lod <= 0) return;
        const k = e.k, x = e.x, y = e.y, z = e.z;
        switch (e.id) {
            case CFX_EV.FIRE2:
                this._ball(x, y + 200 * k, z, 0, 250, 0, 250, 11 * lod, 380 * k, 1.1);
                this._fire(x, y + 110 * k, z, 0, 280, 0, 200, 9 * lod, 240 * k, 1.0);
                this._smoke(x, y + 100 * k, z, 0, 180, 0, 150, 5 * lod, 170 * k, 2.6, [0.34, 0.3, 0.27], 0.85, 40);
                this._embers(x, y + 60, z, 0, 200, 0, 280, 18 * lod, 30, 2.2);
                break;
            case CFX_EV.SMOKE:
                this._smoke(x, y + 170 * k, z, 0, 150, 0, 200, 10 * lod, 260 * k, 3.6, [0.2, 0.18, 0.17], 0.92, 80);
                this._ball(x, y + 210 * k, z, 0, 230, 0, 200, 5 * lod, 320 * k, 0.95);
                this._fire(x, y + 110 * k, z, 0, 240, 0, 170, 6 * lod, 230 * k, 0.9);
                break;
            case CFX_EV.RING2:
                CfxFlares.spawn('ring', x, y, z, 0, 1, 0, 30, 380 * k, 0.55, 0.55, [1, 0.9, 0.75]);
                break;
            case CFX_EV.SPARKS2:
                this._sparks(x, y + 120, z, 0, 380, 0, 760, 22 * lod, 0.8);
                this._embers(x, y + 90, z, 0, 180, 0, 260, 14 * lod, 28, 2.4);
                break;
            case CFX_EV.COLUMN: {
                const h = 80 + 160 * (1 - k);
                this._smoke(x, y + 120 + h, z, 0, 130 + 60 * k, 0, 120, 4 * lod, 240 * k, 4.2, [0.12 + 0.05 * (1 - k), 0.11 + 0.05 * (1 - k), 0.11 + 0.05 * (1 - k)], 0.9, 70);
                if (k > 0.8) this._fire(x, y + 140, z, 0, 220, 0, 120, 4 * lod, 190 * k, 0.8);
                break;
            }
            default: break;
        }
    },

    /** Горсть мелких обломков (пластик, стекло, металл) без звука. color — [r, g, b] краски кузова (необязательно). */
    gear(/** @type {number[]} */ q, /** @type {number[]} */ v, /** @type {number | number[]} */ n, /** @type {number[]=} */ color) {
        if (!this.ready || !q) return;
        const lod = this._lod(q[0], q[1], q[2]);
        if (lod <= 0) return;
        let vx = v ? v[0] : 0, vy = v ? v[1] : 0, vz = v ? v[2] : 0;
        let count = 6;
        if (Array.isArray(n)) { vx += n[0] * 160; vy += n[1] * 160 + 60; vz += n[2] * 160; }   // третий аргумент — нормаль поверхности: обломки отлетают от неё
        else count = +n || 6;
        const c = Math.max(1, Math.round(count * lod));
        const body = color && color.length >= 3 ? color : null;
        const part = body ? Math.ceil(c * 0.4) : 0;
        if (body && part > 0) this._debris(q[0], q[1], q[2], vx, vy, vz, 210, part, [0, 1], 9, body);
        this._debris(q[0], q[1], q[2], vx, vy, vz, 210, c - part, [0, 0, 1, 2, 3], 9, null);
    },

    /**
     * Декаль мира: kind — 'crack' | 'chip' | 'gouge' | 'scorch' | 'oil' | 'coolant' | 'fuel' | 'glass' | 'rubber'; q — центр, n — нормаль поверхности,
     * size — поперечник (px), rot — поворот вокруг нормали, alpha 0..1. Возвращает номер слота буфера или -1.
     */
    decal(/** @type {string} */ kind, /** @type {number[]} */ q, /** @type {number[]} */ n, /** @type {number} */ size, /** @type {number=} */ rot, /** @type {number=} */ alpha) {
        if (!this.ready || !q || !CfxDecals.ready) return -1;
        return this._decal(kind, q[0], q[1], q[2], n ? n[0] : 0, n ? n[1] : 1, n ? n[2] : 0, size || 100, rot === undefined ? cfxRnd(0, 6.28) : rot, alpha === undefined ? 0.9 : alpha, Math.random() < 0.5);
    },

    _decal(/** @type {string} */ kind, x, y, z, nx, ny, nz, size, rot, alpha, /** @type {boolean=} */ mirror) {
        const cells = CFX_CELLS[/** @type {'crack'} */ (kind === 'fuel' ? 'oil' : kind)];
        if (!cells) return -1;
        const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        const cell = cells[(Math.random() * cells.length) | 0];
        const flip = mirror ? 1 + (Math.random() < 0.3 ? 2 : 0) : 0;
        const h = size * 0.5 * (kind === 'glass' || kind === 'rubber' ? 1.1 : 1);
        const lift = (CFX_LIFT[/** @type {'crack'} */ (kind)] || 1) + 0.1 * (CfxDecals.head % 5);
        return CfxDecals.add(cell, flip, x, y, z, nx / l, ny / l, nz / l, h, h, rot, alpha, lift, true, CFX_DECAL_TINT[/** @type {'fuel'} */ (kind)] || null);
    },

    // ---- Постоянные источники ----------------------------------------------------------------

    /** Источник машины: h.set(пар, дым, огонь) — уровни 0..1; h.stop(). follow() -> BABYLON.Vector3 (точка у капота). */
    emitter(/** @type {() => any} */ follow) {
        const e = new CfxEmitter(follow);
        if (this._em.length >= CFX_EMITTERS_MAX * 3) this._em = this._em.filter(x => !x.dead);
        this._em.push(e);
        return { set: (/** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ c) => e.set(a, b, c), stop: () => e.stop() };
    },

    _updateEmitters(/** @type {number} */ dt) {
        const list = this._em;
        if (!list.length || !this.fx) return;
        const live = this._live;
        live.length = 0;
        let sysBudget = CFX_EMITTERS_MAX;
        for (let i = list.length - 1; i >= 0; i--) {
            const e = list[i];
            let dist = 0;
            try { const p = e.follow(); if (p) { e.pos.x = p.x; e.pos.y = p.y; e.pos.z = p.z; dist = Math.sqrt(this._d2(p.x, p.y, p.z)); } } catch (er) { dist = 0; }
            const lq = sysBudget > 0 ? this.lq : 0;
            const done = e.update(dt, this.fx, dist, lq);
            if (e.h.steam || e.h.smoke || e.h.flame) sysBudget--;
            if (done) { e.release(); e.dead = true; list.splice(i, 1); continue; }
            live.push(e);
        }
        // петли пара и огня только у двух самых громких источников каждого вида
        const on = this.sfxOn();
        this._emLoops(live, on, 'volSteam', 'loopSteam', CFX_SND.steam, false);
        this._emLoops(live, on, 'volFire', 'loopFire', CFX_SND.fire, true);
    },

    _emLoops(/** @type {any[]} */ live, /** @type {boolean} */ on, /** @type {string} */ vol, /** @type {string} */ loop, /** @type {string} */ url, /** @type {boolean} */ flicker) {
        if (live.length > 2) live.sort((a, b) => b[vol] - a[vol]);
        for (let i = 0; i < live.length; i++) {
            const e = live[i];
            const want = on && i < 2 ? e[vol] : 0;
            if (want > 0.02) {
                if (!e[loop]) { e[loop] = Sound.loop(url, { volume: want, rate: 1 }); e[loop].hv = want; }
                else if (Math.abs(want - e[loop].hv) > 0.02) { e[loop].set(want, 0.96 + Math.random() * 0.08); e[loop].hv = want; }
                else if (flicker && this.frame % 7 === 0) e[loop].set(want * (0.9 + Math.random() * 0.2), null);
            } else if (e[loop]) { e[loop].fade(0.4); e[loop] = null; }
        }
    },

    // ---- Отладка -----------------------------------------------------------------------------

    stats() {
        let systems = 0, queued = 0;
        for (const n in CfxPools.pools) { systems += CfxPools.pools[n].items.length; queued += CfxPools.pools[n].qn; }
        let particles = 0;
        for (const ps of CfxPools.all) particles += ps.getActiveCount ? ps.getActiveCount() : 0;
        for (const ps of this._emSystems) particles += ps.getActiveCount ? ps.getActiveCount() : 0;
        return {
            poolSystems: systems, emitterSystems: this._emSystems.length, queued, particles,
            decals: CfxDecals.used, decalCap: CfxDecals.N, debris: CfxDebris.live, scrapes: this._sc.size, emitters: this._em.length,
            timeScale: +this.timeScale.toFixed(2), fxSystems: this.fx ? this.fx.effects.size : 0,
        };
    },
};
