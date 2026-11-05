// LiveWater3D.js — «живая вода»: поверхность с волнами Герстнера, рябь, берег по рельефу,
// плавучесть. Порт водной физики Valley Rushing Classic в движок: вода не знает ни про поле,
// ни про уток — области, препятствия и плавающие меши даёт игра (или маркеры карты `water`).
//
// ЧТО ЭТО
//   • Поверхность — сетка с шейдером (ShaderMaterial): сумма волн Герстнера, отражение неба по
//     Френелю, блик солнца, цвет от мелководья к глубине, пена у берега/препятствий/на гребнях,
//     туман сцены (EXP/EXP2/LINEAR), ступени toon, когда включён World3D.toon. Мелководье
//     полупрозрачно: видна земля под водой.
//   • Волны на GPU и CPU — ОДНИ формулы (waveOffset + invertOffset): высоту воды в точке
//     карты (heightAt/normalAt) игра берёт на CPU, и поплавок сидит на видимой поверхности.
//     CPU обращает горизонтальное смещение Герстнера (вершина едет по XZ), поэтому гребень на
//     экране и в расчёте — в одном месте. Волны — детерминированная математика (инвариант 4):
//     при одном наборе волн ответ не зависит от устройства. От качества и IS_MOBILE зависят
//     лишь сетка меша, клетка ряби и множитель амплитуды у берега, поэтому решения, которые
//     должны совпадать на всех устройствах, игра принимает по своим данным, а не по воде.
//   • Рябь — волновое уравнение на CPU-сетке (stepSim), скорость кругов LIVEWATER_RIPPLE_SPEED
//     px/с не зависит от клетки (шаг по времени = 0.7071·клетка/скорость). Стенки отражают:
//     суша выше воды, края области, препятствия. Спящая рябь не считается и не заливается.
//     Высота ряби уходит в шейдер текстурой (RGBA8: R — высота, G — стенка).
//   • Берег — карта 3 каналов из heightAt (bakeShore): R — глубина (уровень − земля, со
//     знаком), G — расстояние до суши, B — расстояние до препятствия. Глубина → цвет мелководья
//     и амплитуда волн у берега (затухают к нулю, вода не лезет на пляж), расстояние → пена.
//   • Плавучесть — stepFloater: пружина к поверхности с затуханием, наклон по уклону под
//     корпусом, дрейф по ряби и течению, отскок от берега (по полю «просвета» clearAt),
//     круги от собственных толчков. Меши даёт игра (addFloater); «рыбки» — addJumper.
//
// ОБЛАСТИ ВОДЫ. Игра передаёт areas: [{ x, y, r }] (круг) или [{ x, y, hx, hy, rot }]
// (прямоугольник, rot — курс в градусах) с уровнем level (или h над землёй в центре), либо
// маркеры карты `water`, `water-2`… (parseAreas, fromLocation): круг радиуса scale[0]·100 px,
// уровень = высота земли в центре + h маркера — как у плоской воды Terrain3D. Каждая область
// — отдельное тело (своя сетка, рябь и текстуры); волны общие, они считаются от мировых
// координат. Берег — из heightAt (террейн), препятствия — circle/rect из opts.obstacles или
// obstaclesFromObjects(location, filter).
//
// ПАУЗА И ЖИЗНЬ. Время волн идёт только в update(dt) и не идёт при Pause.active (pauseAware);
// камера, туман и свет шейдеру отдаются на каждой отрисовке, поэтому на паузе вид живой. Сцена
// остаётся при Location3D.loadMap, а вода привязана к террейну: fromLocation замечает смену
// карты/террейна и сама освобождается (opts.onStale), игра пересоздаёт её в prepare.
// dispose() идемпотентен и вешается на scene.onDisposeObservable.
//
// КАЧЕСТВО. opts.quality: 'low' | 'medium' | 'high' | 1..3 | 0 — авто (LIVEWATER_QUALITY,
// затем ПК — высокое, телефоны — среднее). Уровень задаёт сетку меша, размер сетки ряби,
// число волн, текстуру берега, ряби в пикселях (FRAGRIP), ambient-капли и число шагов
// симуляции за кадр; IS_MOBILE ужимает сетки ещё (×0.7). Бюджет кадра — LIVEWATER_BUDGET_MS:
// шаги ряби обрываются, как только он исчерпан. Нет vertex texture fetch у GPU — рябь рисуется
// только в пикселях (волны и берег работают).
//
// ПРИМЕР
//   const water = LiveWater3D.fromLocation(app.location, { quality: 'medium' }); // null без маркеров water
//   app.onUpdate(dt => water && water.update(dt));
//   water.addFloater(duckMesh, { radius: 38, draft: 6 });  // меш игры, рядом: World3D.addObject
//   water.splash(x, y, 1);  water.watch(playerRig, { reach: 55 });
//
// Объект мира (поплавок) регистрирует игра через World3D.addObject; сама вода в карту теней и
// в обводку не входит. Меш воды неподвижен (мировая позиция вершин), world-матрицу не трогать.

/**
 * @typedef {{ x: number, y: number, r?: number, hx?: number, hy?: number, a?: number, b?: number,
 *   rot?: number, level?: number, h?: number }} LiveWaterShape
 * Круг (r) или прямоугольник (hx — полуось вдоль курса, hy — поперёк); rot — курс, градусы.
 * В области level — уровень воды, h — над землёй в центре (если level не задан).
 *
 * @typedef {Object} LiveWaterOptions
 * @property {LiveWaterShape[]} [areas] области воды
 * @property {LiveWaterShape[]} [obstacles] твёрдые фигуры в воде (отражают рябь, пена, отскок)
 * @property {(x: number, y: number) => number} [heightAt] высота земли; без неё области — глубокий бассейн
 * @property {number} [level] общий уровень воды (для областей без своего)
 * @property {string|number} [quality] 'low' | 'medium' | 'high' | 1..3; 0 или нет — авто
 * @property {boolean} [pauseAware] не двигать время на Pause.active (по умолчанию да)
 * @property {number} [seed] зерно случайных дрейфа/капель/прыжков
 * @property {any} [fx] ParticleFX для брызг; false — без брызг; по умолчанию window.app.fx
 * @property {(x: number, y: number, power: number, quiet: boolean) => void} [onSplash] звук всплеска — забота игры
 * @property {(water: LiveWater3D) => void} [onStale] карта или террейн сменились: вода освобождена
 * @property {any} [waves] свои волны: [{ dir (°) | dx, dy, amp, len, speed }]
 * (а также любое имя из LiveWater3D.cfg(): waveHeight, deep, shallow, foam… — перекрывает константу)
 */

class LiveWater3D {
    /**
     * @param {any} view View3D (нужны scene и camera)
     * @param {LiveWaterOptions} [opts]
     */
    constructor(view, opts) {
        const o = this.opts = Object.assign({}, opts);
        this.view = view;
        this.scene = view.scene;
        this.disposed = false;
        this.stale = false;
        this.enabled = true;
        this.time = 0;
        this.c = LiveWater3D.config(o);
        this.quality = LiveWater3D.qualityLevel(o.quality != null ? o.quality : this.c.quality);
        this.q = LiveWater3D.qualityOf(this.quality);
        this._rnd = LiveWater3D.rng(o.seed != null ? o.seed : 7);
        this._o = { x: 0, y: 0, z: 0 };
        /** @type {LiveWaterBody[]} */
        this.bodies = [];
        /** @type {any[]} */
        this.floaters = [];
        /** @type {any[]} */
        this.jumpers = [];
        /** @type {any[]} */
        this.watchers = [];
        /** @type {LiveWaterShape[]} */
        this.obstacles = (o.obstacles || []).slice();
        /** @type {LiveWaterShape[]} */
        this.areas = (o.areas || []).slice();
        this.stats = { steps: 0, ms: 0, bodies: 0, floaters: 0 };
        this._ambientT = 0.5;
        this._hidden = [];
        /** @type {any} */
        this._loc = null;
        this._map = null;
        this._terrain = null;
        this._buildWaves();
        this._build();
        this._obs = this.scene.onDisposeObservable ? this.scene.onDisposeObservable.add(() => this.dispose()) : null;
    }

    // --- Константы и качество ---------------------------------------------------------

    // Все константы живой воды с дефолтами (Constants.js может быть старше кода). В игре
    // константы — лексические const: только typeof по идентификатору. Любое поле можно
    // перекрыть одноимённой опцией create/fromLocation.
    static cfg() {
        const U = 'undefined';
        return {
            quality: typeof LIVEWATER_QUALITY !== U ? LIVEWATER_QUALITY : 0,
            waveHeight: typeof LIVEWATER_WAVE_HEIGHT !== U ? LIVEWATER_WAVE_HEIGHT : 10,
            waveLength: typeof LIVEWATER_WAVE_LENGTH !== U ? LIVEWATER_WAVE_LENGTH : 1300,
            waveCount: typeof LIVEWATER_WAVE_COUNT !== U ? LIVEWATER_WAVE_COUNT : 4,
            waveDir: typeof LIVEWATER_WAVE_DIR_DEG !== U ? LIVEWATER_WAVE_DIR_DEG : 20,
            waveSpread: typeof LIVEWATER_WAVE_SPREAD_DEG !== U ? LIVEWATER_WAVE_SPREAD_DEG : 90,
            waveSpeed: typeof LIVEWATER_WAVE_SPEED !== U ? LIVEWATER_WAVE_SPEED : 1,
            waveFade: typeof LIVEWATER_WAVE_FADE !== U ? LIVEWATER_WAVE_FADE : 140,
            steep: typeof LIVEWATER_STEEPNESS !== U ? LIVEWATER_STEEPNESS : 0.55,
            rippleHeight: typeof LIVEWATER_RIPPLE_HEIGHT !== U ? LIVEWATER_RIPPLE_HEIGHT : 26,
            rippleSpeed: typeof LIVEWATER_RIPPLE_SPEED !== U ? LIVEWATER_RIPPLE_SPEED : 680,
            rippleDamp: typeof LIVEWATER_RIPPLE_DAMP !== U ? LIVEWATER_RIPPLE_DAMP : 0.986,
            rippleCell: typeof LIVEWATER_RIPPLE_CELL !== U ? LIVEWATER_RIPPLE_CELL : 32,
            ambient: typeof LIVEWATER_AMBIENT !== U ? LIVEWATER_AMBIENT : 1.5,
            grid: typeof LIVEWATER_GRID !== U ? LIVEWATER_GRID : 160,
            shallow: typeof LIVEWATER_SHALLOW_COLOR !== U ? LIVEWATER_SHALLOW_COLOR : 0x47d6dd,
            deep: typeof LIVEWATER_DEEP_COLOR !== U ? LIVEWATER_DEEP_COLOR : 0x137fa6,
            sky: typeof LIVEWATER_SKY_COLOR !== U ? LIVEWATER_SKY_COLOR : 0x4f9fe8,
            horizon: typeof LIVEWATER_HORIZON_COLOR !== U ? LIVEWATER_HORIZON_COLOR : 0xd4f1fd,
            foamColor: typeof LIVEWATER_FOAM_COLOR !== U ? LIVEWATER_FOAM_COLOR : 0xf7fcff,
            depthFull: typeof LIVEWATER_DEPTH_FULL !== U ? LIVEWATER_DEPTH_FULL : 260,
            alphaShallow: typeof LIVEWATER_ALPHA_SHALLOW !== U ? LIVEWATER_ALPHA_SHALLOW : 0.6,
            foam: typeof LIVEWATER_FOAM !== U ? LIVEWATER_FOAM : 1,
            foamWidth: typeof LIVEWATER_FOAM_WIDTH !== U ? LIVEWATER_FOAM_WIDTH : 70,
            glint: typeof LIVEWATER_GLINT !== U ? LIVEWATER_GLINT : 1,
            toon: typeof LIVEWATER_TOON !== U ? LIVEWATER_TOON : 1,
            floatSpring: typeof LIVEWATER_FLOAT_SPRING !== U ? LIVEWATER_FLOAT_SPRING : 26,
            floatDamp: typeof LIVEWATER_FLOAT_DAMP !== U ? LIVEWATER_FLOAT_DAMP : 5,
            floatMax: typeof LIVEWATER_FLOAT_MAX !== U ? LIVEWATER_FLOAT_MAX : 24,
            budget: typeof LIVEWATER_BUDGET_MS !== U ? LIVEWATER_BUDGET_MS : 2
        };
    }

    // Константы с перекрытием опциями: одноимённое поле opts побеждает.
    /** @param {any} [o] */
    static config(o) {
        const c = LiveWater3D.cfg();
        if (o) for (const k of Object.keys(c)) if (o[k] != null) c[k] = o[k];
        return c;
    }

    // Уровень качества 1 (низкое) .. 3 (высокое). Без явного значения — авто: константа
    // LIVEWATER_QUALITY, затем уровень Quality.js, затем ПК — высокое, телефон — среднее.
    /** @param {any} [q] */
    static qualityLevel(q) {
        if (typeof q === 'string') q = { low: 1, medium: 2, mid: 2, high: 3 }[q.toLowerCase()] || 0;
        q = Math.round(Number(q) || 0);
        if (q >= 1 && q <= 3) return q;
        const U = 'undefined';
        const k = Math.round(Number(typeof LIVEWATER_QUALITY !== U ? LIVEWATER_QUALITY : 0) || 0);
        if (k >= 1 && k <= 3) return k;
        // Уровень графики игры (Quality.js: 0 низкий .. 2 высокий), если он уже определён.
        const Q = /** @type {any} */ (typeof Quality !== U ? Quality : null);
        if (Q && Q._inited && Q.level >= 0 && Q.level <= 2) return Q.level + 1;
        return typeof IS_MOBILE !== U && IS_MOBILE ? 2 : 3;
    }

    // Что даёт уровень: grid — доля сетки меша, vpw — вершин на самую короткую волну, waves —
    // потолок числа волн, simCell — множитель клетки ряби, simMax — клеток по большей стороне,
    // shoreTexel/shoreMax — тексель и размер карты берега, frag — рябь в пикселях, noise —
    // октав мелкой ряби, ambient — доля капель, steps — шагов симуляции за кадр.
    /** @param {number} level */
    static qualityOf(level) {
        const Q = LiveWater3D.QUALITY[Math.max(1, Math.min(3, level | 0))];
        const mobile = typeof IS_MOBILE !== 'undefined' && IS_MOBILE;
        return Object.assign({ mobile: mobile ? 0.7 : 1 }, Q);
    }

    // --- Волны Герстнера (чистая математика, без Babylon) ---------------------------

    // Набор волн из констант: убывающая геометрическая прогрессия высоты и длины,
    // направления разведены на spread°, скорость растёт к мелким волнам. Для 4 волн по
    // умолчанию получается набор Valley Rushing Classic.
    /** @param {any} c cfg @param {number} [count] */
    static defaultWaves(c, count) {
        const n = Math.max(1, Math.min(LiveWater3D.MAX_WAVES, Math.round(count || c.waveCount)));
        const OFFS = [0, 1, -0.8, 1.9, -1.6, 0.5];
        const out = [];
        for (let i = 0; i < n; i++) {
            out.push({
                dir: c.waveDir + c.waveSpread * OFFS[i % OFFS.length],
                amp: c.waveHeight * Math.pow(0.64, i),
                len: c.waveLength * Math.pow(0.57, i),
                speed: 0.55 + 0.12 * i
            });
        }
        return out;
    }

    // Волны для расчёта: dir (°) или dx/dy -> единичный вектор, k = 2π/длина, ω = k·c с
    // c = √(g/k)·speed (g = 981 px/с²: 1 px = 1 см), q — «острота» Герстнера:
    // сумма q·amp·k по волнам = steep (≤ 0.95, иначе гребни заворачиваются петлёй).
    /** @param {any[]} list @param {number} steep */
    static compileWaves(list, steep) {
        const n = Math.max(1, list.length), G = 981;
        const st = Math.max(0, Math.min(0.95, Number(steep) || 0));
        return list.slice(0, LiveWater3D.MAX_WAVES).map(w => {
            const len = Math.max(24, Number(w.len) || 600);
            const k = LiveWater3D.TAU / len;
            let dx, dy;
            if (w.dx != null || w.dy != null) { dx = Number(w.dx) || 0; dy = Number(w.dy) || 0; }
            else { const a = (Number(w.dir) || 0) * Math.PI / 180; dx = Math.cos(a); dy = Math.sin(a); }
            if (!dx && !dy) dx = 1;
            const l = Math.hypot(dx, dy);
            const amp = Math.max(0, Number(w.amp) || 0);
            const speed = w.speed != null ? Number(w.speed) : 1;
            return { dx: dx / l, dy: dy / l, amp, len, k, omega: k * Math.sqrt(G / k) * speed, q: st / (k * Math.max(amp, 0.05) * n) };
        });
    }

    // Фазы волн в момент t (с): ω·t по модулю 2π. Фаза уходит в шейдер готовой — на CPU и GPU
    // она одна и та же, а float32 не копит ошибку на долгой игре.
    /** @param {any[]} waves @param {number} t @param {Float64Array} out */
    static wavePhases(waves, t, out) {
        for (let i = 0; i < waves.length; i++) out[i] = (waves[i].omega * t) % LiveWater3D.TAU;
        return out;
    }

    // Смещение вершины, стоящей в (x, y) покоя: out.y — высота над уровнем, out.x/out.z —
    // горизонтальный сдвиг Герстнера. s — множитель амплитуды у берега (0..1).
    // ТЕ ЖЕ формулы, что в вершинном шейдере (vertexSource).
    /** @param {any[]} waves @param {ArrayLike<number>} ph @param {number} x @param {number} y @param {number} s @param {{x:number,y:number,z:number}} out */
    static waveOffset(waves, ph, x, y, s, out) {
        let dx = 0, dz = 0, h = 0;
        for (let i = 0; i < waves.length; i++) {
            const w = waves[i], a = w.amp * s, p = w.k * (w.dx * x + w.dy * y) - ph[i];
            const sn = Math.sin(p), cs = Math.cos(p), qa = w.q * a;
            dx += qa * w.dx * cs;
            dz += qa * w.dy * cs;
            h += a * sn;
        }
        out.x = dx; out.y = h; out.z = dz;
        return out;
    }

    // Нормаль геометрии (волны) в точке покоя (x, y): касательные tang/bino, как в шейдере.
    /** @param {any[]} waves @param {ArrayLike<number>} ph @param {number} x @param {number} y @param {number} s @param {{x:number,y:number,z:number}} out */
    static waveNormal(waves, ph, x, y, s, out) {
        let tx = 1, ty = 0, tz = 0, bx = 0, by = 0, bz = 1;
        for (let i = 0; i < waves.length; i++) {
            const w = waves[i], a = w.amp * s, p = w.k * (w.dx * x + w.dy * y) - ph[i];
            const sn = Math.sin(p), cs = Math.cos(p), qak = w.q * a * w.k, ak = a * w.k;
            tx -= qak * w.dx * w.dx * sn; ty += w.dx * ak * cs; tz -= qak * w.dx * w.dy * sn;
            bx -= qak * w.dx * w.dy * sn; by += w.dy * ak * cs; bz -= qak * w.dy * w.dy * sn;
        }
        // n = bino × tang
        let nx = by * tz - bz * ty, ny = bz * tx - bx * tz, nz = bx * ty - by * tx;
        const l = Math.hypot(nx, ny, nz) || 1;
        out.x = nx / l; out.y = ny / l; out.z = nz / l;
        return out;
    }

    // Точка покоя, которая после смещения Герстнера окажется в (x, y): p0 = (x, y) − D(p0),
    // неподвижная точка, сжатие с коэффициентом ≤ steep. sc(x, y) — множитель амплитуды у
    // берега (null — 1). Возвращает точку покоя в out.px/out.py и смещение — в out.
    /** @param {any[]} waves @param {ArrayLike<number>} ph @param {number} x @param {number} y @param {((x: number, y: number) => number) | null} sc @param {any} out @param {number} [iters] */
    static invertOffset(waves, ph, x, y, sc, out, iters) {
        let px = x, py = y;
        const n = iters == null ? LiveWater3D.INVERT_ITERS : iters;
        for (let i = 0; i < n; i++) {
            LiveWater3D.waveOffset(waves, ph, px, py, sc ? sc(px, py) : 1, out);
            px = x - out.x; py = y - out.z;
        }
        out.s = sc ? sc(px, py) : 1;
        LiveWater3D.waveOffset(waves, ph, px, py, out.s, out);
        out.px = px; out.py = py;
        return out;
    }

    // --- Фигуры, области, маркеры ---------------------------------------------------

    // Любая запись фигуры -> { kind: 'circle' | 'rect', x, y, a, b, cos, sin }: a/b — полуоси
    // (у круга обе = радиус), a вдоль курса rot (градусы). Как Terrain3D.shapeOf.
    /** @param {LiveWaterShape} d */
    static normalizeShape(d) {
        const rect = d.hx != null || d.hy != null || (d.b != null && d.a != null && d.b !== d.a && d.r == null);
        const a = Math.max(1, Number(rect ? (d.hx != null ? d.hx : d.a) : (d.r != null ? d.r : d.a)) || 1);
        const b = rect ? Math.max(1, Number(d.hy != null ? d.hy : d.b) || a) : a;
        const th = (Number(d.rot) || 0) * Math.PI / 180;
        return { kind: rect ? 'rect' : 'circle', x: Number(d.x) || 0, y: Number(d.y) || 0, a, b, cos: Math.cos(th), sin: Math.sin(th) };
    }

    // Расстояние от точки до кромки фигуры: меньше нуля — внутри.
    /** @param {any} s нормализованная фигура */
    static edgeDistance(s, px, py) {
        const dx = px - s.x, dy = py - s.y;
        if (s.kind !== 'rect') return Math.hypot(dx, dy) - s.a;
        const lx = Math.abs(dx * s.cos + dy * s.sin) - s.a;
        const lz = Math.abs(-dx * s.sin + dy * s.cos) - s.b;
        return Math.hypot(Math.max(lx, 0), Math.max(lz, 0)) + Math.min(Math.max(lx, lz), 0);
    }

    // Габарит фигуры в мире: { x0, y0, x1, y1 }.
    /** @param {any} s */
    static shapeBounds(s) {
        const hx = Math.abs(s.cos) * s.a + Math.abs(s.sin) * s.b;
        const hy = Math.abs(s.sin) * s.a + Math.abs(s.cos) * s.b;
        const kx = s.kind === 'rect' ? hx : s.a, ky = s.kind === 'rect' ? hy : s.a;
        return { x0: s.x - kx, y0: s.y - ky, x1: s.x + kx, y1: s.y + ky };
    }

    // Маркеры карты `water`, `water-2`… -> области. Круг радиуса scale[0]·100 px, уровень =
    // высота земли в центре + h маркера (или ctx.level, если задан). Чужие имена, например
    // `water-lily`, пропускаются. ctx: { heightAt?, level? }.
    /** @param {any[]} markers @param {{ heightAt?: (x: number, y: number) => number, level?: number }} [ctx] */
    static parseAreas(markers, ctx) {
        const out = [];
        const cx = ctx || {};
        for (const d of markers || []) {
            if (!d || !/^water(?:-\d+)?$/.test(String(d.name || ''))) continue;
            const sc = Array.isArray(d.scale) ? d.scale : [d.scale, d.scale, d.scale];
            const r = Math.max(1, (Number(sc[0]) > 0 ? Number(sc[0]) : 1) * 100);
            const x = Number(d.x) || 0, y = Number(d.y) || 0, h = Number(d.h) || 0;
            const ground = cx.heightAt ? Number(cx.heightAt(x, y)) || 0 : 0;
            out.push({ x, y, r, h, level: cx.level != null ? Number(cx.level) : ground + h });
        }
        return out;
    }

    // Препятствия из объектов карты: ось-выровненный прямоугольник по габариту меша.
    // filter(rec) — какие брать (например, по имени модели); маркеры пропускаются.
    /** @param {any} location @param {(rec: any) => boolean} [filter] */
    static obstaclesFromObjects(location, filter) {
        const out = [];
        for (const rec of (location && location.objects) || []) {
            if (!rec.mesh || (rec.def && rec.def.kind === 'marker') || (filter && !filter(rec))) continue;
            const bb = rec.mesh.getHierarchyBoundingVectors(true);
            out.push({ x: (bb.min.x + bb.max.x) / 2, y: (bb.min.z + bb.max.z) / 2, hx: (bb.max.x - bb.min.x) / 2, hy: (bb.max.z - bb.min.z) / 2 });
        }
        return out;
    }

    // --- Берег: карта глубины и расстояний --------------------------------------------

    // Дальность, на которой расстояния до берега и препятствий ещё кодируются: ~7.5 ширин пены.
    /** @param {number} foamWidth */
    static reachOf(foamWidth) {
        return Math.max(200, Math.min(800, foamWidth * LiveWater3D.SHORE.reachPerFoam));
    }

    // Карта берега по heightAt. Тексели — центры клеток габарита области:
    //   depth — уровень − высота земли (меньше нуля — суша), px;
    //   dist  — расстояние от воды до ближайшей суши, px (сумма двух проходов «фаски»),
    //           до reach; суша = 0;
    //   obst  — расстояние до ближайшего препятствия, px (внутри — 0), до reach.
    // s: { x0, y0, x1, y1, texel, maxN, level, heightAt, obstacles (нормализованные), reach }.
    /** @param {any} s */
    static bakeShore(s) {
        const W = s.x1 - s.x0, H = s.y1 - s.y0;
        const clampN = (v) => Math.max(8, Math.min(s.maxN, Math.ceil(v / s.texel)));
        const w = clampN(W), h = clampN(H), cx = W / w, cy = H / h, n = w * h, INF = 1e9;
        const depth = new Float32Array(n), dist = new Float32Array(n), obst = new Float32Array(n);
        const obs = s.obstacles || [];
        for (let j = 0; j < h; j++) {
            for (let i = 0; i < w; i++) {
                const k = j * w + i, x = s.x0 + (i + 0.5) * cx, y = s.y0 + (j + 0.5) * cy;
                let d = s.level - s.heightAt(x, y);
                if (!Number.isFinite(d)) d = -1;
                depth[k] = d;
                dist[k] = d <= 0 ? 0 : INF;
                let o = INF;
                for (const ob of obs) { const e = LiveWater3D.edgeDistance(ob, x, y); if (e < o) o = e; }
                obst[k] = o < 0 ? 0 : o;
            }
        }
        // Расстояние до суши: два прохода «фаски» (1 / √2 по клетке).
        const dg = Math.hypot(cx, cy);
        for (let j = 0; j < h; j++) {
            for (let i = 0; i < w; i++) {
                const k = j * w + i;
                let d = dist[k];
                if (d === 0) continue;
                if (i > 0) d = Math.min(d, dist[k - 1] + cx);
                if (j > 0) {
                    d = Math.min(d, dist[k - w] + cy);
                    if (i > 0) d = Math.min(d, dist[k - w - 1] + dg);
                    if (i < w - 1) d = Math.min(d, dist[k - w + 1] + dg);
                }
                dist[k] = d;
            }
        }
        for (let j = h - 1; j >= 0; j--) {
            for (let i = w - 1; i >= 0; i--) {
                const k = j * w + i;
                let d = dist[k];
                if (d === 0) continue;
                if (i < w - 1) d = Math.min(d, dist[k + 1] + cx);
                if (j < h - 1) {
                    d = Math.min(d, dist[k + w] + cy);
                    if (i < w - 1) d = Math.min(d, dist[k + w + 1] + dg);
                    if (i > 0) d = Math.min(d, dist[k + w - 1] + dg);
                }
                dist[k] = d;
            }
        }
        for (let k = 0; k < n; k++) {
            if (dist[k] > s.reach) dist[k] = s.reach;
            if (obst[k] > s.reach) obst[k] = s.reach;
        }
        return { w, h, x0: s.x0, y0: s.y0, cx, cy, depth, dist, obst, reach: s.reach };
    }

    // Карта берега -> RGBA8 для шейдера: R = 127.5 + 127.5·глубина/depthFull (со знаком),
    // G = расстояние до суши / reach, B = расстояние до препятствия / reach.
    /** @param {any} b bakeShore @param {number} depthFull */
    static encodeShore(b, depthFull) {
        const px = new Uint8Array(b.w * b.h * 4), D = Math.max(1, depthFull), R = Math.max(1, b.reach);
        const q = (v) => Math.max(0, Math.min(255, Math.floor(v)));
        for (let k = 0, p = 0; k < b.w * b.h; k++, p += 4) {
            px[p] = q(127.5 + 127.5 * Math.max(-1, Math.min(1, b.depth[k] / D)));
            px[p + 1] = q(255 * b.dist[k] / R + 0.5);
            px[p + 2] = q(255 * b.obst[k] / R + 0.5);
            px[p + 3] = 255;
        }
        return px;
    }

    static smoothstep(e0, e1, x) {
        const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
        return t * t * (3 - 2 * t);
    }

    // Классификация воды по глубине и расстоянию до суши — СТАТИЧЕСКАЯ часть шейдера (без
    // бегущих полос и шума): те же числа LiveWater3D.SHORE уходят в текст шейдера.
    //   zone: 'land' (земля выше воды) | 'surf' (прибой, пена) | 'shallow' | 'deep';
    //   cover — доля покрытия водой (мягкая линия берега), foam 0..1, shallow 0..1.
    // c: { depthFull, foamWidth, foam }.
    /** @param {number} depth @param {number} dist @param {{ depthFull: number, foamWidth: number, foam?: number }} c */
    static shoreClass(depth, dist, c) {
        const S = LiveWater3D.SHORE;
        const cover = LiveWater3D.smoothstep(-S.coverLo, S.coverHi, depth);
        if (depth <= 0) return { zone: 'land', cover, foam: 0, shallow: 0 };
        const reach = LiveWater3D.reachOf(c.foamWidth);
        const surf = 1 - LiveWater3D.smoothstep(0, c.foamWidth, dist);
        const foam = Math.max(0, Math.min(S.foamMax, surf * S.surfGain * (c.foam != null ? c.foam : 1)));
        const w = Math.min(depth / c.depthFull, dist / reach);
        const shallow = 1 - LiveWater3D.smoothstep(0, 1, Math.max(0, Math.min(1, w)));
        const zone = foam > S.foamZone ? 'surf' : shallow > 0.5 ? 'shallow' : 'deep';
        return { zone, cover, foam, shallow };
    }

    // --- Рябь: волновое уравнение на сетке ------------------------------------------

    // Сетка ряби. o: { x0, y0, w, h, cell, solid?, amp?, damp?, stepDt? }. cur/prev —
    // высота в долях amp (1 ↔ amp px); solid[k] = 1 — стенка (отражает, держит 0).
    /** @param {any} o */
    static makeSim(o) {
        const n = o.w * o.h;
        const px = new Uint8Array(n * 4);
        for (let k = 0; k < n; k++) { px[k * 4] = 128; px[k * 4 + 3] = 255; }
        return {
            x0: o.x0, y0: o.y0, w: o.w, h: o.h, cell: o.cell, amp: o.amp != null ? o.amp : 26, damp: o.damp != null ? o.damp : 0.986,
            stepDt: o.stepDt || 1 / 30, acc: 0, cur: new Float32Array(n), prev: new Float32Array(n),
            solid: o.solid || new Uint8Array(n), px, asleep: true, quiet: 0, peak: 0, dirty: true
        };
    }

    // Шаг: новое = (сумма четырёх соседей / 2 − прошлое) · затухание (число Куранта² = ½, на
    // пределе устойчивости); стенки — ноль, значения зажаты в ±3. Возвращает пик |значения|.
    // Тихая сетка (пик < SLEEP_PEAK три шага подряд) засыпает: обнуляется и не считается,
    // пока её не разбудит disturbSim.
    /** @param {any} s */
    static stepSim(s) {
        const w = s.w, h = s.h, cur = s.cur, prev = s.prev, solid = s.solid, damp = s.damp;
        let peak = 0;
        for (let j = 1; j < h - 1; j++) {
            let k = j * w + 1;
            for (let i = 1; i < w - 1; i++, k++) {
                if (solid[k]) { prev[k] = 0; continue; }
                let v = ((cur[k - 1] + cur[k + 1] + cur[k - w] + cur[k + w]) * 0.5 - prev[k]) * damp;
                v = v > 3 ? 3 : v < -3 ? -3 : v;
                prev[k] = v;
                const a = v < 0 ? -v : v;
                if (a > peak) peak = a;
            }
        }
        s.prev = cur; s.cur = prev;
        s.peak = peak;
        s.dirty = true;
        if (peak < LiveWater3D.SLEEP_PEAK) {
            if (++s.quiet >= 3) { s.cur.fill(0); s.prev.fill(0); s.asleep = true; s.peak = 0; }
        } else s.quiet = 0;
        return peak;
    }

    // Возмущение: гауссов горб радиусом r px (amount ~ 0.2 — рябь, 1 — всплеск), вниз.
    /** @param {any} s @param {number} x @param {number} y @param {number} amount @param {number} [r] */
    static disturbSim(s, x, y, amount, r) {
        const rc = Math.max(1, Math.ceil((r || 60) / s.cell));
        const ci = Math.floor((x - s.x0) / s.cell), cj = Math.floor((y - s.y0) / s.cell);
        let hit = false;
        for (let j = cj - rc; j <= cj + rc; j++) {
            for (let i = ci - rc; i <= ci + rc; i++) {
                if (i < 1 || j < 1 || i >= s.w - 1 || j >= s.h - 1) continue;
                const k = j * s.w + i;
                if (s.solid[k]) continue;
                const d2 = ((i - ci) * (i - ci) + (j - cj) * (j - cj)) / (rc * rc);
                if (d2 > 1) continue;
                s.cur[k] -= amount * Math.exp(-d2 * 3);
                hit = true;
            }
        }
        if (hit) { s.asleep = false; s.quiet = 0; s.dirty = true; }
        return hit;
    }

    // Высота ряби в точке (доли amp): билинейно по центрам клеток; вне сетки — 0.
    /** @param {any} s */
    static sampleSim(s, x, y) {
        const fx = (x - s.x0) / s.cell - 0.5, fy = (y - s.y0) / s.cell - 0.5;
        const i = Math.floor(fx), j = Math.floor(fy);
        if (i < 0 || j < 0 || i >= s.w - 1 || j >= s.h - 1) return 0;
        const tx = fx - i, ty = fy - j, a = s.cur, k = j * s.w + i;
        return (a[k] * (1 - tx) + a[k + 1] * tx) * (1 - ty) + (a[k + s.w] * (1 - tx) + a[k + s.w + 1] * tx) * ty;
    }

    // Сетка -> RGBA8 для шейдера: R = 128.5 + 90·высота (±1.41 amp), G = 255 у стенки.
    /** @param {any} s */
    static encodeSim(s) {
        const px = s.px, a = s.cur, solid = s.solid;
        for (let k = 0, p = 0; k < a.length; k++, p += 4) {
            const v = a[k] * 90 + 128.5;
            px[p] = v < 0 ? 0 : v > 255 ? 255 : v;
            px[p + 1] = solid[k] ? 255 : 0;
        }
        s.dirty = false;
        return px;
    }

    // --- Плавучесть ----------------------------------------------------------------------

    // Шаг поплавка f в среде env за dt. env: surfaceAt(x, y) -> высота воды | null,
    // rippleSlope(x, y, d) -> [gx, gy], clearAt(x, y) -> просвет до берега/препятствия,
    // clearNormal(x, y) -> [nx, ny] от стенки, disturb(x, y, amount, r).
    //   • высота: пружина f.spring к (поверхность − осадка) с затуханием f.damp;
    //   • наклон: нормаль (−dh/dx, 1, −dh/dz) по перепаду воды на радиусе f.radius, плавно;
    //   • дрейф: рябь толкает с гребня (f.push), течение f.drift, сопротивление f.drag;
    //   • берег: просвет < радиуса — вытолкнуть и отразить скорость (упругость f.restitution);
    //   • толчки: быстрое движение по высоте (|vh| > 70) рождает круги.
    // Вне воды (surfaceAt == null) поплавок не двигается. Возвращает true, если шаг сделан.
    /** @param {any} f @param {any} env @param {number} dt */
    static stepFloater(f, env, dt) {
        dt = Math.min(0.1, Math.max(0, dt));
        const r = f.radius, hs = env.surfaceAt(f.x, f.y);
        if (hs == null) return false;
        const S = (x, y) => { const v = env.surfaceAt(x, y); return v == null ? hs : v; };
        f.vh += ((hs - f.draft - f.h) * f.spring - f.vh * f.damp) * dt;
        f.h += f.vh * dt;
        const sx = (S(f.x + r, f.y) - S(f.x - r, f.y)) / (2 * r);
        const sy = (S(f.x, f.y + r) - S(f.x, f.y - r)) / (2 * r);
        const nl = Math.hypot(sx, 1, sy), kk = 1 - Math.pow(0.02, dt);
        f.nx += (-sx / nl - f.nx) * kk; f.ny += (1 / nl - f.ny) * kk; f.nz += (-sy / nl - f.nz) * kk;
        const ml = Math.hypot(f.nx, f.ny, f.nz) || 1;
        f.nx /= ml; f.ny /= ml; f.nz /= ml;
        const g = env.rippleSlope(f.x, f.y, 40);
        f.vx += (-g[0] * f.push + f.drift[0]) * dt;
        f.vy += (-g[1] * f.push + f.drift[1]) * dt;
        const drag = Math.pow(f.drag, dt);
        f.vx *= drag; f.vy *= drag;
        f.x += f.vx * dt; f.y += f.vy * dt;
        if (f.restitution >= 0) {
            const cl = env.clearAt(f.x, f.y);
            if (cl < r) {
                const n = env.clearNormal(f.x, f.y), push = Math.min(r - cl, r);
                f.x += n[0] * push; f.y += n[1] * push;
                const vn = f.vx * n[0] + f.vy * n[1];
                if (vn < 0) { f.vx -= (1 + f.restitution) * vn * n[0]; f.vy -= (1 + f.restitution) * vn * n[1]; }
            }
        }
        f.wakeT -= dt;
        if (f.wake && f.wakeT <= 0 && Math.abs(f.vh) > 70) { f.wakeT = 0.3; env.disturb(f.x, f.y, 0.08, r); }
        f.heading += f.spin * dt;
        if (f.align > 0 && Math.hypot(f.vx, f.vy) > 6) {
            let d = Math.atan2(f.vy, f.vx) - f.heading;
            d -= LiveWater3D.TAU * Math.round(d / LiveWater3D.TAU);
            f.heading += d * (1 - Math.pow(0.1, dt * f.align));
        }
        return true;
    }

    // Ориентация корпуса: нос вдоль курса heading (рад, atan2(vy, vx); rotation.y = −heading),
    // «верх» — по нормали воды. Кватернион [x, y, z, w] вращения базиса X→нос, Y→верх, Z→вбок.
    /** @param {number} heading @param {number} nx @param {number} ny @param {number} nz */
    static orientation(heading, nx, ny, nz) {
        const ul = Math.hypot(nx, ny, nz) || 1;
        const ux = nx / ul, uy = ny / ul, uz = nz / ul;
        let fx = Math.cos(heading), fy = 0, fz = Math.sin(heading);
        const d = fx * ux + fy * uy + fz * uz;
        fx -= d * ux; fy -= d * uy; fz -= d * uz;
        const fl = Math.hypot(fx, fy, fz) || 1;
        fx /= fl; fy /= fl; fz /= fl;
        // z = нос × верх (правая система)
        const zx = fy * uz - fz * uy, zy = fz * ux - fx * uz, zz = fx * uy - fy * ux;
        // Матрица с колонками (нос, верх, вбок) -> кватернион.
        const m00 = fx, m10 = fy, m20 = fz, m01 = ux, m11 = uy, m21 = uz, m02 = zx, m12 = zy, m22 = zz;
        const tr = m00 + m11 + m22;
        let x, y, z, w;
        if (tr > 0) {
            const s = Math.sqrt(tr + 1) * 2;
            w = 0.25 * s; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
        } else if (m00 > m11 && m00 > m22) {
            const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
            w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
        } else if (m11 > m22) {
            const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
            w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
        } else {
            const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
            w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
        }
        return [x, y, z, w];
    }

    // --- Утилиты ---------------------------------------------------------------------------

    // Генератор псевдослучайных чисел (mulberry32): вода не трогает Math.random, чтобы
    // капли, прыжки и разброс были воспроизводимы по зерну.
    /** @param {number} seed */
    static rng(seed) {
        let s = (seed >>> 0) || 1;
        return () => {
            s = (s + 0x6D2B79F5) >>> 0;
            let t = s;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    // Цвет -> [r, g, b] 0..1: число 0xRRGGBB, строка '#rrggbb' или массив.
    /** @param {any} v */
    static rgb(v) {
        if (Array.isArray(v)) return [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0];
        if (typeof v === 'string') { const m = /^#?([0-9a-f]{6})$/i.exec(v.trim()); v = m ? parseInt(m[1], 16) : 0xffffff; }
        const n = (Number(v) >>> 0) & 0xffffff;
        return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    }

    // Билинейная выборка массива w×h: (ox, oy) — мир точки отсчёта (0,0), cx/cy — шаг,
    // half = 0.5, если отсчёты стоят в центрах клеток (карта берега), 0 — в узлах (сетка меша).
    // Край — повтор крайнего (CLAMP, как у текстуры).
    /** @param {ArrayLike<number>} a */
    static bilerp(a, w, h, ox, oy, cx, cy, half, x, y) {
        let fx = (x - ox) / cx - half, fy = (y - oy) / cy - half;
        fx = fx < 0 ? 0 : fx > w - 1 ? w - 1 : fx;
        fy = fy < 0 ? 0 : fy > h - 1 ? h - 1 : fy;
        const i = Math.min(w - 2, Math.floor(fx)), j = Math.min(h - 2, Math.floor(fy));
        const tx = fx - i, ty = fy - j, k = j * w + i;
        return (a[k] * (1 - tx) + a[k + 1] * tx) * (1 - ty) + (a[k + w] * (1 - tx) + a[k + w + 1] * tx) * ty;
    }

    static now() {
        return typeof performance !== 'undefined' ? performance.now() : Date.now();
    }

    // --- Фабрики -------------------------------------------------------------------------------

    // Вода на виде. Без областей — null (нечего рисовать). opts — LiveWaterOptions.
    /** @param {any} view @param {LiveWaterOptions} [opts] @returns {LiveWater3D | null} */
    static create(view, opts) {
        if (typeof BABYLON === 'undefined' || !view || !view.scene) return null;
        if (!(opts && opts.areas && opts.areas.length)) return null;
        try {
            const w = new LiveWater3D(view, opts);
            if (!w.bodies.length) { w.dispose(); return null; }
            return w;
        } catch (e) {
            console.warn('LiveWater3D: вода не собралась — ' + ((e && e.message) || e));
            return null;
        }
    }

    // Вода карты: маркеры `water` (location.markers) + опции areas/obstacles. Берег — из
    // location.terrain.heightAt. opts.obstacleFilter(rec) собирает препятствия из объектов
    // карты (obstaclesFromObjects). Плоская вода Terrain3D (terrain.waters[].mesh), если
    // она есть, скрывается, пока живая вода включена. Нет маркеров и областей — null.
    // Смена карты или террейна (loadMap) освобождает воду сама — игра пересоздаёт её в prepare.
    /** @param {any} location @param {LiveWaterOptions & { obstacleFilter?: (rec: any) => boolean }} [opts] @returns {LiveWater3D | null} */
    static fromLocation(location, opts) {
        if (!location || !location.view || !location.terrain || typeof location.markers !== 'function') return null;
        const o = Object.assign({}, opts);
        const terrain = location.terrain;
        const heightAt = (x, y) => terrain.heightAt(x, y);
        const areas = LiveWater3D.parseAreas(location.markers('water'), { heightAt, level: o.level });
        for (const a of o.areas || []) areas.push(a);
        o.areas = areas;
        o.heightAt = o.heightAt || heightAt;
        if (o.obstacleFilter) o.obstacles = (o.obstacles || []).concat(LiveWater3D.obstaclesFromObjects(location, o.obstacleFilter));
        const w = LiveWater3D.create(location.view, o);
        if (!w) return null;
        w._loc = location; w._map = location.map; w._terrain = terrain;
        w._hideFlat();
        return w;
    }

    // --- Сборка --------------------------------------------------------------------------------

    _buildWaves() {
        const c = this.c, o = this.opts;
        const cap = Math.min(LiveWater3D.MAX_WAVES, this.q.waves);
        const list = Array.isArray(o.waves) && o.waves.length ? o.waves.slice(0, cap) : LiveWater3D.defaultWaves(c, Math.min(c.waveCount, cap));
        /** @type {any[]} */
        this.waves = LiveWater3D.compileWaves(list, c.steep);
        this.phases = new Float64Array(this.waves.length);
        this._waveB = new Array(this.waves.length * 4).fill(0);
        this._waveA = [];
        this.waves.forEach((w, i) => {
            this._waveA.push(w.dx, w.dy, w.amp, w.k);
            this._waveB[i * 4] = w.q;
        });
        this.crestNorm = this.waves.reduce((s, w) => s + w.amp, 0) || 1;
        this._syncPhases();
    }

    _syncPhases() {
        const sp = Math.max(0, this.c.waveSpeed);
        LiveWater3D.wavePhases(this.waves, this.time * sp, this.phases);
        for (let i = 0; i < this.waves.length; i++) this._waveB[i * 4 + 1] = this.phases[i];
    }

    _build() {
        const maxBodies = LiveWater3D.MAX_BODIES;
        this.areas.slice(0, maxBodies).forEach((a, i) => {
            try { this.bodies.push(this._makeBody(a, i)); }
            catch (e) { console.warn('LiveWater3D: область ' + i + ' не собралась — ' + ((e && e.message) || e)); }
        });
        this.stats.bodies = this.bodies.length;
    }

    // Тело воды = одна область: сетка меша, карта берега, рябь, материал.
    /** @param {LiveWaterShape} area @param {number} index */
    _makeBody(area, index) {
        const c = this.c, Q = this.q, scene = this.scene;
        const shape = LiveWater3D.normalizeShape(area);
        const level = area.level != null ? Number(area.level) : (this.opts.level != null ? Number(this.opts.level) : 0);
        const ground = this.opts.heightAt || (() => level - c.depthFull);
        const ext = LiveWater3D.shapeBounds(shape);
        const W = ext.x1 - ext.x0, H = ext.y1 - ext.y0;
        const obstacles = this.obstacles.map(LiveWater3D.normalizeShape);
        const reach = LiveWater3D.reachOf(c.foamWidth);

        // Берег.
        const bake = LiveWater3D.bakeShore({
            x0: ext.x0, y0: ext.y0, x1: ext.x1, y1: ext.y1, texel: Q.shoreTexel / Q.mobile, maxN: Math.round(Q.shoreMax * Q.mobile),
            level, heightAt: ground, obstacles, reach
        });

        // Сетка меша: шаг не крупнее длины самой короткой волны / vpw, не больше потолка по стороне.
        const minLen = this.waves.length ? Math.min.apply(null, this.waves.map(w => w.len)) : 400;
        const maxSub = Math.max(8, Math.round(c.grid * Q.grid * Q.mobile));
        const sub = (len) => Math.max(4, Math.min(maxSub, Math.ceil(len / (minLen / Q.vpw))));
        const nx = sub(W), ny = sub(H), dx = W / nx, dy = H / ny, fade = Math.max(1, c.waveFade);
        const vx = nx + 1, vy = ny + 1;
        const pos = new Float32Array(vx * vy * 3), uvs = new Float32Array(vx * vy * 2), scale = new Float32Array(vx * vy);
        for (let j = 0; j < vy; j++) {
            for (let i = 0; i < vx; i++) {
                const k = j * vx + i, x = ext.x0 + i * dx, y = ext.y0 + j * dy;
                const d = level - ground(x, y);
                const s = d <= 0 || !Number.isFinite(d) ? 0 : LiveWater3D.smoothstep(0, fade, d);
                scale[k] = s;
                pos[k * 3] = x; pos[k * 3 + 1] = level; pos[k * 3 + 2] = y;
                uvs[k * 2] = s;
            }
        }
        const idx = new Uint16Array(nx * ny * 6);
        let p = 0;
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const a = j * vx + i, b = a + 1, cc = a + vx, d = cc + 1;
                idx[p++] = a; idx[p++] = d; idx[p++] = b; idx[p++] = a; idx[p++] = cc; idx[p++] = d;
            }
        }

        // Рябь: клетка по уровню качества; шаг по времени держит скорость кругов.
        const cell = Math.max(c.rippleCell * Q.simCell / Q.mobile, Math.max(W, H) / Math.max(24, Q.simMax * Q.mobile));
        const sx0 = ext.x0 - 2 * cell, sy0 = ext.y0 - 2 * cell;
        const sw = Math.ceil((W + 4 * cell) / cell), sh = Math.ceil((H + 4 * cell) / cell);
        const stepDt = Math.max(1 / 60, Math.min(1 / 12, 0.7071 * cell / Math.max(50, c.rippleSpeed)));
        const sim = LiveWater3D.makeSim({ x0: sx0, y0: sy0, w: sw, h: sh, cell, amp: c.rippleHeight, damp: c.rippleDamp, stepDt });

        const body = new LiveWaterBody({ shape, level, ext, grid: { nx: vx, ny: vy, x0: ext.x0, y0: ext.y0, dx, dy, scale }, shore: bake, obstacles, sim, index });
        // Стенки ряби: просвет меньше полуклетки (суша, края области, препятствия).
        for (let j = 0; j < sh; j++) {
            for (let i = 0; i < sw; i++) {
                if (body.clearAt(sx0 + (i + 0.5) * cell, sy0 + (j + 0.5) * cell) < LiveWater3D.WALL_PAD) sim.solid[j * sw + i] = 1;
            }
        }
        LiveWater3D.encodeSim(sim);

        if (typeof BABYLON === 'undefined') return body;   // расчётный режим: без графики
        this._makeMesh(body, pos, uvs, idx);
        return body;
    }

    // Меш, текстуры и материал тела.
    _makeMesh(body, pos, uvs, idx) {
        const scene = this.scene, c = this.c, B = BABYLON, sim = body.sim;
        const mesh = new B.Mesh('liveWater-' + body.index, scene);
        const vd = new B.VertexData();
        vd.positions = pos; vd.uvs = uvs; vd.indices = idx;
        vd.applyToMesh(mesh, false);
        mesh.isPickable = false;
        mesh.receiveShadows = false;
        // Рамка с запасом на волны и рябь: меш гасится вне кадра, а не «всегда активен».
        const pad = this.waves.reduce((s, w) => s + w.q * w.amp, 0) + 4, hz = this.crestNorm + c.rippleHeight * 1.5;
        mesh.setBoundingInfo(new B.BoundingInfo(
            new B.Vector3(body.ext.x0 - pad, body.level - hz, body.ext.y0 - pad),
            new B.Vector3(body.ext.x1 + pad, body.level + hz, body.ext.y1 + pad)));
        mesh.freezeWorldMatrix();
        body.mesh = mesh;

        const caps = this.scene.getEngine().getCaps ? this.scene.getEngine().getCaps() : null;
        const vtf = !caps || caps.maxVertexTextureImageUnits == null || caps.maxVertexTextureImageUnits > 0;
        const variant = { waves: this.waves.length, vtf, frag: this.q.frag || !vtf, noise: this.q.noise };
        const key = LiveWater3D.registerShader(variant);

        const RT = B.RawTexture, fmt = B.Constants.TEXTUREFORMAT_RGBA;
        body.rippleTex = new RT(sim.px, sim.w, sim.h, fmt, scene, false, false, B.Texture.BILINEAR_SAMPLINGMODE);
        body.rippleTex.wrapU = body.rippleTex.wrapV = B.Texture.CLAMP_ADDRESSMODE;
        const sh = body.shore;
        body.shoreTex = new RT(LiveWater3D.encodeShore(sh, c.depthFull), sh.w, sh.h, fmt, scene, false, false, B.Texture.BILINEAR_SAMPLINGMODE);
        body.shoreTex.wrapU = body.shoreTex.wrapV = B.Texture.CLAMP_ADDRESSMODE;

        const mat = new B.ShaderMaterial('liveWater-mat-' + body.index, scene, { vertex: key, fragment: key }, {
            attributes: ['position', 'uv'],
            uniforms: ['viewProjection', 'uWaveA', 'uWaveB', 'uMisc', 'uRippleRect', 'uRippleInfo', 'uTime', 'uCam', 'uSun', 'uSunColor',
                'uDeep', 'uShallow', 'uSky', 'uHorizon', 'uFoamColor', 'uFogColor', 'uFog', 'uShoreRect', 'uShoreInfo', 'uStyle', 'uToon', 'uArea', 'uAreaDir'],
            samplers: ['uRipples', 'uShore'],
            needAlphaBlending: true
        });
        mat.backFaceCulling = false;
        mat.setTexture('uRipples', body.rippleTex);
        mat.setTexture('uShore', body.shoreTex);
        mat.setArray4('uWaveA', this._waveA);
        mat.setArray4('uWaveB', this._waveB);
        mat.setVector4('uMisc', new B.Vector4(body.level, 1 / this.crestNorm, 0, 0));
        mat.setVector4('uRippleRect', new B.Vector4(sim.x0, sim.y0, sim.w * sim.cell, sim.h * sim.cell));
        mat.setVector4('uRippleInfo', new B.Vector4(sim.amp, 1 / sim.w, 1 / sim.h, 0));
        mat.setVector4('uShoreRect', new B.Vector4(sh.x0, sh.y0, sh.w * sh.cx, sh.h * sh.cy));
        mat.setVector4('uShoreInfo', new B.Vector4(c.depthFull, sh.reach, c.foamWidth, Math.max(0, c.foam)));
        mat.setVector4('uStyle', new B.Vector4(Math.max(0, Math.min(1, c.alphaShallow)), Math.max(0, c.glint), 40, 1));
        const sp = body.shape;
        mat.setVector4('uArea', new B.Vector4(sp.x, sp.y, sp.a, sp.b));
        mat.setVector4('uAreaDir', new B.Vector4(sp.cos, sp.sin, sp.kind === 'rect' ? 1 : 0, 0));
        const col = (name, v) => { const r = LiveWater3D.rgb(v); mat.setColor3(name, new B.Color3(r[0], r[1], r[2])); };
        col('uDeep', c.deep); col('uShallow', c.shallow); col('uSky', c.sky); col('uHorizon', c.horizon); col('uFoamColor', c.foamColor);
        mat.onBindObservable.add(() => this._bind(mat));
        mesh.material = mat;
        body.material = mat;
    }

    // Что меняется от кадра к кадру или от сцены: время, фазы, камера, туман, солнце, toon.
    // На каждой отрисовке (и на паузе): камера и свет живут, даже когда время стоит.
    _bind(mat) {
        const e = mat.getEffect();
        if (!e || this.disposed) return;
        const sc = this.scene, cam = sc.activeCamera || this.view.camera;
        e.setArray4('uWaveB', this._waveB);
        e.setFloat('uTime', this.time);
        if (cam) { const p = cam.globalPosition || cam.position; e.setFloat3('uCam', p.x, p.y, p.z); }
        const fog = sc.fogColor, mode = sc.fogEnabled ? sc.fogMode : 0;
        e.setFloat3('uFogColor', fog ? fog.r : 0.55, fog ? fog.g : 0.75, fog ? fog.b : 0.88);
        e.setFloat4('uFog', mode, sc.fogDensity, sc.fogStart, sc.fogEnd);
        const md = sc.metadata, sun = md && md.lorySun;
        if (sun) {
            e.setFloat3('uSun', sun.dir.x, sun.dir.y, sun.dir.z);
            const m = Math.max(sun.color.r, sun.color.g, sun.color.b, 1e-3);
            e.setFloat3('uSunColor', sun.color.r / m, sun.color.g / m, sun.color.b / m);
        } else {
            const d = typeof World3D !== 'undefined' ? World3D.sunDirection() : { x: -0.5, y: -0.7, z: -0.5 };
            const l = Math.hypot(d.x, d.y, d.z) || 1;
            e.setFloat3('uSun', -d.x / l, -d.y / l, -d.z / l);
            e.setFloat3('uSunColor', 1, 0.96, 0.86);
        }
        const T = typeof World3D !== 'undefined' && World3D.toon ? World3D.toon.s : null;
        e.setFloat4('uToon', this.c.toon > 0 && T && T.on ? 1 : 0, T ? Math.min(4, T.bands) : 3, T ? T.soft : 0.06, 0);
    }

    // --- Кадр ------------------------------------------------------------------------------------

    // Сменилась карта или террейн (Location3D.loadMap/buildTerrain), либо сцена умерла.
    isStale() {
        if (this._loc) {
            const l = this._loc;
            if (!l.view || l.view !== this.view || l.terrain !== this._terrain || l.map !== this._map) return true;
        }
        return !!(this.scene && typeof this.scene.isDisposed === 'function' && this.scene.isDisposed());
    }

    // Кадр воды. dt — секунды. На паузе (Pause.active, pauseAware) ничего не делает: время
    // волн и ряби стоит. Вызывать из игрового update (app.onUpdate) или каждый кадр (app.onFrame).
    /** @param {number} dt */
    update(dt) {
        if (this.disposed || !this.enabled) return;
        if (this.isStale()) {
            const cb = this.opts.onStale;
            this.stale = true;
            this.dispose();
            if (cb) { try { cb(this); } catch (e) { console.error('LiveWater3D onStale:', e); } }
            return;
        }
        if (this.opts.pauseAware !== false && typeof Pause !== 'undefined' && Pause.active) return;
        dt = Math.min(0.1, Math.max(0, Number(dt) || 0));
        if (!(dt > 0)) return;
        const t0 = LiveWater3D.now();
        this.time += dt;
        this._syncPhases();
        this._updateAmbient(dt);
        this._updateWatchers(dt);
        // Рябь: шаги по времени с потолком числа шагов и бюджетом кадра.
        let steps = 0;
        const limit = this.q.steps, budget = Math.max(0.2, this.c.budget);
        for (const b of this.bodies) {
            const s = b.sim;
            if (s.asleep) { s.acc = 0; } else {
                s.acc += dt;
                while (s.acc >= s.stepDt && steps < limit && !s.asleep) {
                    LiveWater3D.stepSim(s);
                    s.acc -= s.stepDt; steps++;
                    if (LiveWater3D.now() - t0 > budget) break;
                }
                if (s.acc > s.stepDt) s.acc = 0;
            }
            if (s.dirty && b.rippleTex) { LiveWater3D.encodeSim(s); b.rippleTex.update(s.px); }
        }
        this._updateFloaters(dt);
        this._updateJumpers(dt);
        this.stats.steps = steps;
        this.stats.ms = LiveWater3D.now() - t0;
        this.stats.floaters = this.floaters.length;
    }

    // Случайные капли по воде: редкие маленькие кольца (долю задаёт качество).
    _updateAmbient(dt) {
        const rate = this.c.ambient * this.q.ambient;
        if (!(rate > 0) || !this.bodies.length) return;
        this._ambientT -= dt;
        if (this._ambientT > 0) return;
        this._ambientT = (0.5 + this._rnd()) / rate;
        const p = this.randomPoint(0);
        if (p) this.disturb(p.x, p.y, 0.35 + this._rnd() * 0.4, 40);
    }

    // --- Запросы -------------------------------------------------------------------------------

    // Тело воды, в области которого стоит точка (над водой, не над сушей), или null.
    /** @param {number} x @param {number} y @returns {LiveWaterBody | null} */
    bodyAt(x, y) {
        for (const b of this.bodies) if (b.contains(x, y)) return b;
        return null;
    }

    // Над водой ли точка (остров-препятствие — не вода); с просветом r до берега, если r задан.
    /** @param {number} x @param {number} y @param {number} [r] */
    isWater(x, y, r) {
        const b = this.bodyAt(x, y);
        return !!b && !b.inObstacle(x, y) && (!r || b.clearAt(x, y) >= r);
    }

    // Глубина под точкой (уровень − земля), px, или null вне воды.
    /** @param {number} x @param {number} y */
    depthAt(x, y) {
        const b = this.bodyAt(x, y);
        return b ? b.depthAt(x, y) : null;
    }

    // Высота видимой поверхности (волны + рябь) в точке карты или null вне воды. Та же математика,
    // что у шейдера. Детерминирована: от качества зависит только рябь (клетка сетки).
    /** @param {number} x @param {number} y @returns {number | null} */
    heightAt(x, y) {
        const b = this.bodyAt(x, y);
        return b ? this._surface(b, x, y) : null;
    }

    surfaceAt(x, y) { return this.heightAt(x, y); }

    /** @param {LiveWaterBody} b */
    _surface(b, x, y) {
        const o = /** @type {any} */ (this._o);
        LiveWater3D.invertOffset(this.waves, this.phases, x, y, b.scaleFn, o);
        return b.level + o.y + LiveWater3D.sampleSim(b.sim, o.px, o.py) * b.sim.amp;
    }

    // Нормаль поверхности (единичный вектор { x, y, z }, Y вверх): волны + уклон ряби. null вне воды.
    /** @param {number} x @param {number} y @param {{x:number,y:number,z:number}} [out] */
    normalAt(x, y, out) {
        const b = this.bodyAt(x, y);
        if (!b) return null;
        const o = /** @type {any} */ (this._o), r = out || { x: 0, y: 1, z: 0 };
        LiveWater3D.invertOffset(this.waves, this.phases, x, y, b.scaleFn, o);
        LiveWater3D.waveNormal(this.waves, this.phases, o.px, o.py, o.s, r);
        // Рябь: физический уклон поверхности (в шейдере он усилен только для света).
        const s = b.sim, e = s.cell, A = s.amp;
        const gx = (LiveWater3D.sampleSim(s, o.px + e, o.py) - LiveWater3D.sampleSim(s, o.px - e, o.py)) * A / (2 * e);
        const gz = (LiveWater3D.sampleSim(s, o.px, o.py + e) - LiveWater3D.sampleSim(s, o.px, o.py - e)) * A / (2 * e);
        const nx = r.x - gx, ny = r.y, nz = r.z - gz, l = Math.hypot(nx, ny, nz) || 1;
        r.x = nx / l; r.y = ny / l; r.z = nz / l;
        return r;
    }

    // Уклон ряби (поле, не px) по центральной разности на расстоянии d — для дрейфа поплавков.
    /** @param {number} x @param {number} y @param {number} d */
    rippleSlope(x, y, d) {
        const b = this.bodyAt(x, y);
        if (!b) return [0, 0];
        const s = b.sim;
        return [LiveWater3D.sampleSim(s, x + d, y) - LiveWater3D.sampleSim(s, x - d, y),
            LiveWater3D.sampleSim(s, x, y + d) - LiveWater3D.sampleSim(s, x, y - d)];
    }

    // Просвет от точки до берега, края области и препятствий (px; < 0 — не в воде).
    clearAt(x, y) {
        const b = this.bodyAt(x, y);
        if (b) return b.clearAt(x, y);
        let best = -1;
        for (const t of this.bodies) best = Math.max(best, t.clearAt(x, y));
        return Math.min(best, 0);
    }

    // Единичное направление «от ближайшей стенки» в точке (градиент просвета).
    clearNormal(x, y) {
        const b = this.bodyAt(x, y) || this.bodies.reduce((m, t) => (!m || t.clearAt(x, y) > m.clearAt(x, y) ? t : m), null);
        return b ? b.clearNormal(x, y) : [0, 0];
    }

    // Случайная точка воды с просветом ≥ margin: поплавки, рыбки, капли. Детерминирована зерном.
    /** @param {number} [margin] */
    randomPoint(margin) {
        if (!this.bodies.length) return null;
        const m = margin || 0;
        for (let tries = 0; tries < 30; tries++) {
            const b = this.bodies[Math.min(this.bodies.length - 1, Math.floor(this._rnd() * this.bodies.length))];
            const x = b.ext.x0 + this._rnd() * (b.ext.x1 - b.ext.x0), y = b.ext.y0 + this._rnd() * (b.ext.y1 - b.ext.y0);
            if (b.contains(x, y) && b.clearAt(x, y) >= m) return { x, y, level: b.level };
        }
        return null;
    }

    // Ближайшая к (x, y) точка воды в пределах reach (для персонажа на берегу) или null.
    // Кольца радиусов reach/4…reach по 12 направлений, затем уточнение к кромке бисекцией.
    /** @param {number} x @param {number} y @param {number} [reach] */
    nearestWater(x, y, reach) {
        const R = reach || 70;
        if (this.isWater(x, y)) return { x, y };
        for (let ring = 1; ring <= 4; ring++) {
            const r = R * ring / 4;
            let best = null, bd = 1e9;
            for (let a = 0; a < 12; a++) {
                const px = x + Math.cos(a * Math.PI / 6) * r, py = y + Math.sin(a * Math.PI / 6) * r;
                if (!this.isWater(px, py)) continue;
                const d = Math.hypot(px - x, py - y);
                if (d < bd) { bd = d; best = { x: px, y: py }; }
            }
            if (best) {
                let lo = 0, hi = 1;   // от (x, y) к воде
                for (let i = 0; i < 4; i++) {
                    const m = (lo + hi) / 2;
                    if (this.isWater(x + (best.x - x) * m, y + (best.y - y) * m)) hi = m; else lo = m;
                }
                return { x: x + (best.x - x) * hi, y: y + (best.y - y) * hi };
            }
        }
        return null;
    }

    // --- Возмущения ------------------------------------------------------------------------------

    // Возмущение ряби: гауссов горб радиуса r px (amount ~ 0.2 — рябь, 1 — всплеск). true —
    // попало в воду. Без брызг и звука (см. splash).
    /** @param {number} x @param {number} y @param {number} amount @param {number} [r] */
    disturb(x, y, amount, r) {
        const b = this.bodyAt(x, y);
        return b ? LiveWater3D.disturbSim(b.sim, x, y, amount, r) : false;
    }

    // Всплеск: круги + брызги ParticleFX (opts.fx / window.app.fx) + opts.onSplash для звука.
    // power ~ 1 — удар, 0.3 — плюх; quiet — без звука для далёких мелочей. false — мимо воды.
    /** @param {number} x @param {number} y @param {number} [power] @param {boolean} [quiet] */
    splash(x, y, power, quiet) {
        if (this.disposed || !this.enabled) return false;
        const p = power == null ? 1 : power;
        if (!this.disturb(x, y, 1.1 * p, 50 + 40 * p)) return false;
        this._splashFx(x, y, p);
        const cb = this.opts.onSplash;
        if (cb) { try { cb(x, y, p, !!quiet); } catch (e) { console.error('LiveWater3D onSplash:', e); } }
        return true;
    }

    // Всплеск у кромки: событие персонажа на берегу (рывок, удар) — брызги в ближайшей воде.
    // o: { reach (по умолчанию 90), quiet }.
    /** @param {number} x @param {number} y @param {number} [power] @param {{ reach?: number, quiet?: boolean }} [o] */
    splashNear(x, y, power, o) {
        const w = this.nearestWater(x, y, (o && o.reach) || 90);
        return w ? this.splash(w.x, w.y, power, !!(o && o.quiet)) : false;
    }

    _splashFx(x, y, p) {
        if (typeof BABYLON === 'undefined' || this.opts.fx === false) return;
        const fx = this.opts.fx || (typeof window !== 'undefined' && /** @type {any} */ (window).app && /** @type {any} */ (window).app.fx);
        const b = this.bodyAt(x, y);
        if (!fx || typeof fx.create !== 'function' || !b) return;
        try {
            fx.create({ burst: Math.round(16 + 22 * p), capacity: 44, life: [0.45, 1], size: [7, 16], speed: [140 * p + 60, 320 * p + 80],
                color: '#ffffff', color2: '#bff1ff', position: new BABYLON.Vector3(x, b.level + 6, y), direction: [[-0.45, 1, -0.45], [0.45, 1, 0.45]],
                gravity: [0, -900, 0], blend: 'standard', sizeGradient: [[0, 1], [1, 0.4]] });
            fx.create({ burst: 1, capacity: 2, life: [0.45, 0.5], size: [60 * p + 40, 70 * p + 50], speed: [0, 0], color: '#ffffff',
                position: new BABYLON.Vector3(x, b.level + 8, y), blend: 'standard', sizeGradient: [[0, 0.4], [1, 1.6]] });
        } catch (e) { console.warn('LiveWater3D: брызги не созданы — ' + ((e && e.message) || e)); }
    }

    // --- Источники ряби: персонажи у берега -----------------------------------------------------

    // Следить за объектом: пока он быстро идёт у воды (в воде или не дальше reach от неё),
    // за бортом бегут круги. target — { x, y }, Babylon-узел (position.x, position.z) или
    // функция, возвращающая такое. o: { reach: 55, speedMin: 140 px/с, gain: 0.001 (сила на
    // px/с), maxPower: 0.6, radius: 45, interval: 0.12 }. Возвращает { remove() }.
    /** @param {any} target @param {{ reach?: number, speedMin?: number, gain?: number, maxPower?: number, radius?: number, interval?: number }} [o] */
    watch(target, o) {
        const w = Object.assign({ reach: 55, speedMin: 140, gain: 0.001, maxPower: 0.6, radius: 45, interval: 0.12 }, o);
        Object.assign(w, { target, t: 0, acc: 0, lx: null, ly: null });
        this.watchers.push(w);
        return { remove: () => { const i = this.watchers.indexOf(w); if (i >= 0) this.watchers.splice(i, 1); } };
    }

    static pointOf(t) {
        const v = typeof t === 'function' ? t() : t;
        if (!v) return null;
        if (v.position && v.position.x != null) return { x: v.position.x, y: v.position.z };
        return v.x != null ? { x: Number(v.x), y: Number(v.y) } : null;
    }

    _updateWatchers(dt) {
        for (const w of this.watchers) {
            w.acc += dt; w.t -= dt;
            if (w.t > 0) continue;
            const p = LiveWater3D.pointOf(w.target);
            if (!p) continue;
            const speed = w.lx == null ? 0 : Math.hypot(p.x - w.lx, p.y - w.ly) / Math.max(1e-3, w.acc);
            w.lx = p.x; w.ly = p.y; w.acc = 0; w.t = w.interval;
            if (speed < w.speedMin) continue;
            const hit = this.nearestWater(p.x, p.y, w.reach);
            if (hit) this.disturb(hit.x, hit.y, Math.min(w.maxPower, speed * w.gain), w.radius);
        }
    }

    // --- Поплавки ---------------------------------------------------------------------------------

    // Посадить меш игры на воду. Движок не создаёт предметы сам: утка, бочка, лист — меш игры
    // (регистрируйте World3D.addObject). Позиция — из mesh.position (x, z) или o.x/o.y. Меш
    // получает позицию (x, высота, y) и поворот; origin меша — на осадку ниже ватерлинии.
    // o: { x, y, radius: 40 (по ней уклон и отскок), draft: 10, heading, spin: 0 рад/с,
    // align: 0 (поворот по движению, 1/с), vx, vy, drift: [ax, ay] (течение, px/с²), push: 900,
    // drag: 0.55, bounce: 0.6 (упругость; −1 — без берега), wake: true (круги от качки),
    // tilt: true (наклон по волне), lift: 0 (поднять меш), spring, damp, ownsMesh }.
    // Возвращает запись поплавка или null (лимит LIVEWATER_FLOAT_MAX).
    /** @param {any} mesh @param {any} [o] */
    addFloater(mesh, o) {
        if (!mesh) return null;
        if (this.floaters.length >= Math.max(0, this.c.floatMax)) { console.warn('LiveWater3D: предел поплавков (LIVEWATER_FLOAT_MAX)'); return null; }
        o = o || {};
        const p = mesh.position || { x: 0, y: 0, z: 0 };
        const f = {
            mesh, x: o.x != null ? o.x : p.x, y: o.y != null ? o.y : p.z, h: p.y, vh: 0,
            vx: Number(o.vx) || 0, vy: Number(o.vy) || 0,
            heading: o.heading != null ? o.heading : (mesh.rotation ? -mesh.rotation.y : 0), spin: Number(o.spin) || 0, align: Number(o.align) || 0,
            nx: 0, ny: 1, nz: 0, radius: Math.max(1, Number(o.radius) || 40), draft: o.draft != null ? Number(o.draft) : 10,
            spring: o.spring != null ? o.spring : this.c.floatSpring, damp: o.damp != null ? o.damp : this.c.floatDamp,
            push: o.push != null ? o.push : 900, drift: o.drift || [0, 0], drag: o.drag != null ? o.drag : 0.55,
            restitution: o.bounce != null ? o.bounce : 0.6, wake: o.wake !== false, tilt: o.tilt !== false,
            lift: Number(o.lift) || 0, wakeT: 0, ownsMesh: !!o.ownsMesh
        };
        const s = this.heightAt(f.x, f.y);
        if (s != null) f.h = s - f.draft;
        this.floaters.push(f);
        return f;
    }

    // Снять поплавок (запись или меш). Меш остаётся игре, если не ownsMesh.
    /** @param {any} f */
    removeFloater(f) {
        const i = this.floaters.findIndex(t => t === f || t.mesh === f);
        if (i < 0) return false;
        const t = this.floaters[i];
        this.floaters.splice(i, 1);
        if (t.ownsMesh && t.mesh && !t.mesh.isDisposed()) t.mesh.dispose(false, false);
        return true;
    }

    _updateFloaters(dt) {
        for (const f of this.floaters) {
            if (!f.mesh || (f.mesh.isDisposed && f.mesh.isDisposed())) continue;
            if (!LiveWater3D.stepFloater(f, this, dt)) continue;
            f.mesh.position.set(f.x, f.h + f.lift, f.y);
            if (f.tilt && typeof BABYLON !== 'undefined') {
                const q = LiveWater3D.orientation(f.heading, f.nx, f.ny, f.nz);
                if (!f.mesh.rotationQuaternion) f.mesh.rotationQuaternion = new BABYLON.Quaternion();
                f.mesh.rotationQuaternion.set(q[0], q[1], q[2], q[3]);
            } else if (f.mesh.rotation) {
                f.mesh.rotationQuaternion = null;
                f.mesh.rotation.y = -f.heading;
            }
        }
    }

    // --- «Рыбки»: прыжки из воды ----------------------------------------------------------------------

    // Меш игры (рыбка, дельфин), который время от времени выпрыгивает из воды по дуге и плюхается
    // обратно. Меш скрыт между прыжками, нос — вдоль +X. o: { interval: [2.5, 6.5] с между
    // прыжками, distance: 170, height: 130, duration: 0.85, dip: 6, first: 2 с до первого, power: 0.55,
    // landPower: 0.7, quiet: true, onJump(x, y), ownsMesh }.
    /** @param {any} mesh @param {any} [o] */
    addJumper(mesh, o) {
        if (!mesh) return null;
        const j = Object.assign({ interval: [2.5, 6.5], distance: 170, height: 130, duration: 0.85, dip: 6, first: 2, power: 0.55, landPower: 0.7, quiet: true }, o);
        Object.assign(j, { mesh, t: -1, cool: j.first, x0: 0, y0: 0, x1: 0, y1: 0 });
        if (mesh.setEnabled) mesh.setEnabled(false);
        this.jumpers.push(j);
        return j;
    }

    removeJumper(j) {
        const i = this.jumpers.findIndex(t => t === j || t.mesh === j);
        if (i < 0) return false;
        const t = this.jumpers[i];
        this.jumpers.splice(i, 1);
        if (t.ownsMesh && t.mesh && !t.mesh.isDisposed()) t.mesh.dispose(false, false); else if (t.mesh && t.mesh.setEnabled) t.mesh.setEnabled(false);
        return true;
    }

    _updateJumpers(dt) {
        for (const j of this.jumpers) {
            if (!j.mesh || (j.mesh.isDisposed && j.mesh.isDisposed())) continue;
            if (j.t < 0) {
                j.cool -= dt;
                if (j.cool > 0) continue;
                const p = this.randomPoint(j.distance * 0.7);
                const a = this._rnd() * LiveWater3D.TAU;
                const x1 = p ? p.x + Math.cos(a) * j.distance : 0, y1 = p ? p.y + Math.sin(a) * j.distance : 0;
                if (!p || !this.isWater(x1, y1, 20)) continue;   // нет места — повтор на следующем кадре
                j.cool = j.interval[0] + this._rnd() * (j.interval[1] - j.interval[0]);
                Object.assign(j, { t: 0, x0: p.x, y0: p.y, x1, y1 });
                j.mesh.setEnabled(true);
                this.splash(p.x, p.y, j.power, j.quiet);
                if (j.onJump) { try { j.onJump(p.x, p.y); } catch (e) { console.error('LiveWater3D onJump:', e); } }
            }
            j.t += dt / Math.max(0.1, j.duration);
            const u = Math.min(1, j.t), x = j.x0 + (j.x1 - j.x0) * u, y = j.y0 + (j.y1 - j.y0) * u;
            const base = this.heightAt(x, y);
            const h = (base == null ? 0 : base) + Math.sin(u * Math.PI) * j.height - j.dip;
            j.mesh.position.set(x, h, y);
            if (j.mesh.rotation) j.mesh.rotation.set(0, -Math.atan2(j.y1 - j.y0, j.x1 - j.x0), Math.cos(u * Math.PI) * 0.9);
            if (u >= 1) {
                j.t = -1;
                j.mesh.setEnabled(false);
                this.splash(x, y, j.landPower, j.quiet);
            }
        }
    }

    // --- Жизнь --------------------------------------------------------------------------------------------

    // Включить/выключить: выключенная вода не рисуется и не считается, плоская вода Terrain3D
    // возвращается, меши поплавков и прыгунов игры прячутся. Настройка «живая вода» игры.
    /** @param {boolean} on */
    setEnabled(on) {
        on = !!on;
        if (on === this.enabled || this.disposed) return;
        this.enabled = on;
        for (const b of this.bodies) if (b.mesh) b.mesh.setEnabled(on);
        for (const f of this.floaters) if (f.mesh && f.mesh.setEnabled) f.mesh.setEnabled(on);
        if (!on) for (const j of this.jumpers) if (j.mesh && j.mesh.setEnabled) j.mesh.setEnabled(false);
        if (on) this._hideFlat(); else this._showFlat();
    }

    // Плоскую воду Terrain3D (terrain.waters[].mesh) прячем, пока живая вода включена.
    _hideFlat() {
        const T = /** @type {any} */ (this._terrain);
        for (const w of (T && T.waters) || []) {
            const m = w && w.mesh;
            if (m && !m.isDisposed() && m.isEnabled()) { m.setEnabled(false); this._hidden.push(m); }
        }
    }

    _showFlat() {
        for (const m of this._hidden) if (m && !m.isDisposed()) m.setEnabled(true);
        this._hidden = [];
    }

    // Пересобрать меши, текстуры и рябь (качество, константы, препятствия, правка рельефа).
    // Поплавки, прыгуны и наблюдатели остаются.
    rebuild() {
        if (this.disposed) return;
        this._disposeBodies();
        this._buildWaves();
        this._build();
        if (!this.enabled) for (const b of this.bodies) if (b.mesh) b.mesh.setEnabled(false);
    }

    /** @param {string|number} q */
    setQuality(q) {
        this.quality = LiveWater3D.qualityLevel(q);
        this.q = LiveWater3D.qualityOf(this.quality);
        this.rebuild();
    }

    // Константы Constants.js / опции перечитать (редактор): пересобирает воду.
    applyConstants() {
        this.c = LiveWater3D.config(this.opts);
        this.rebuild();
    }

    /** @param {LiveWaterShape} shape */
    addObstacle(shape) {
        this.obstacles.push(shape);
        this.rebuild();
    }

    _disposeBodies() {
        for (const b of this.bodies) b.dispose();
        this.bodies = [];
    }

    // Снять всё: меши, материалы, текстуры, плоская вода возвращается. Меши игры (поплавки,
    // прыгуны) остаются ей, кроме помеченных ownsMesh. Повторный вызов безопасен.
    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        if (this._obs && this.scene && this.scene.onDisposeObservable) { try { this.scene.onDisposeObservable.remove(this._obs); } catch (e) { /* сцена уже умирает */ } }
        this._obs = null;
        this._disposeBodies();
        this._showFlat();
        for (const f of this.floaters) if (f.ownsMesh && f.mesh && !f.mesh.isDisposed()) f.mesh.dispose(false, false);
        for (const j of this.jumpers) {
            if (!j.mesh || (j.mesh.isDisposed && j.mesh.isDisposed())) continue;
            if (j.ownsMesh) j.mesh.dispose(false, false); else if (j.mesh.setEnabled) j.mesh.setEnabled(false);
        }
        this.floaters = []; this.jumpers = []; this.watchers = [];
        this._loc = null; this._terrain = null; this._map = null;
    }

    // --- Шейдеры -------------------------------------------------------------------------------------------

    // Вариант шейдера -> имя в Effect.ShadersStore (регистрируется один раз на вариант).
    // variant: { waves, vtf, frag, noise }.
    /** @param {{ waves: number, vtf: boolean, frag: boolean, noise: number }} v */
    static registerShader(v) {
        const key = 'loryWater' + v.waves + (v.vtf ? 'V' : 'v') + (v.frag ? 'F' : 'f') + v.noise;
        const S = BABYLON.Effect.ShadersStore;
        if (!S[key + 'VertexShader']) {
            S[key + 'VertexShader'] = LiveWater3D.vertexSource(v);
            S[key + 'FragmentShader'] = LiveWater3D.fragmentSource(v);
        }
        return key;
    }

    static f(n) { return Number(n).toFixed(5); }

    static defines(v) {
        return '#define WAVES ' + v.waves + '\n' + (v.vtf ? '#define VTF\n' : '') + (v.frag ? '#define FRAGRIP\n' : '') + '#define NOISE ' + v.noise + '\n';
    }

    // Чтение высоты ряби из текстуры: R = 128.5 + 90·высота -> доли amp (±1.41).
    static get RIPPLE_GLSL() {
        return 'float rip(vec2 uv) {\n' +
            '    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;\n' +
            '    return (texture2D(uRipples, uv).r - 0.50196) * 2.83333;\n}\n';
    }

    // Вершинный шейдер: Герстнер (те же формулы, что waveOffset/waveNormal), рябь по текстуре.
    /** @param {{ waves: number, vtf: boolean, frag: boolean, noise: number }} v */
    static vertexSource(v) {
        return LiveWater3D.defines(v) + `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 viewProjection;
uniform vec4 uWaveA[WAVES];
uniform vec4 uWaveB[WAVES];
uniform vec4 uMisc;
uniform vec4 uRippleRect;
uniform vec4 uRippleInfo;
#ifdef VTF
uniform sampler2D uRipples;
#endif
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vCR;
#ifdef VTF
${LiveWater3D.RIPPLE_GLSL}
#endif
void main(void) {
    vec2 p = position.xz;
    float sc = uv.x;
    vec3 disp = vec3(0.0);
    vec3 tang = vec3(1.0, 0.0, 0.0);
    vec3 bino = vec3(0.0, 0.0, 1.0);
    float crest = 0.0;
    for (int i = 0; i < WAVES; i++) {
        vec4 A = uWaveA[i];
        vec4 B = uWaveB[i];
        float a = A.z * sc;
        float ph = A.w * dot(A.xy, p) - B.y;
        float sn = sin(ph);
        float cs = cos(ph);
        float qa = B.x * a;
        float qak = qa * A.w;
        float ak = a * A.w;
        disp += vec3(qa * A.x * cs, a * sn, qa * A.y * cs);
        tang += vec3(-qak * A.x * A.x * sn, A.x * ak * cs, -qak * A.x * A.y * sn);
        bino += vec3(-qak * A.x * A.y * sn, A.y * ak * cs, -qak * A.y * A.y * sn);
        crest += max(0.0, sn) * a;
    }
    vec3 n = normalize(cross(bino, tang));
    float r = 0.0;
#ifdef VTF
    vec2 ruv = (p - uRippleRect.xy) / uRippleRect.zw;
    r = rip(ruv);
#ifndef FRAGRIP
    float tx = uRippleInfo.y;
    float tz = uRippleInfo.z;
    float rx = rip(ruv + vec2(tx, 0.0)) - rip(ruv - vec2(tx, 0.0));
    float rz = rip(ruv + vec2(0.0, tz)) - rip(ruv - vec2(0.0, tz));
    n = normalize(n + vec3(-rx * uRippleInfo.x / (2.0 * uRippleRect.z * tx), 0.0, -rz * uRippleInfo.x / (2.0 * uRippleRect.w * tz)) * 3.0);
#endif
#endif
    vec3 wp = vec3(p.x + disp.x, uMisc.x + disp.y + r * uRippleInfo.x, p.y + disp.z);
    vWorld = wp;
    vNormal = n;
    vCR = vec2(crest * uMisc.y, r);
    gl_Position = viewProjection * vec4(wp, 1.0);
}`;
    }

    // Фрагментный шейдер: цвет по глубине и расстояниям, Френель, блик, пена, туман, ступени toon.
    // Числа берега/пены — из LiveWater3D.SHORE (те же в shoreClass).
    /** @param {{ waves: number, vtf: boolean, frag: boolean, noise: number }} v */
    static fragmentSource(v) {
        const S = LiveWater3D.SHORE, F = LiveWater3D.f;
        return LiveWater3D.defines(v) + `
precision highp float;
uniform float uTime;
uniform vec3 uCam;
uniform vec3 uSun;
uniform vec3 uSunColor;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uSky;
uniform vec3 uHorizon;
uniform vec3 uFoamColor;
uniform vec3 uFogColor;
uniform vec4 uFog;
uniform vec4 uShoreRect;
uniform vec4 uShoreInfo;
uniform vec4 uStyle;
uniform vec4 uToon;
uniform vec4 uArea;
uniform vec4 uAreaDir;
uniform vec4 uRippleRect;
uniform vec4 uRippleInfo;
uniform sampler2D uShore;
#ifdef FRAGRIP
uniform sampler2D uRipples;
#endif
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vCR;
#ifdef FRAGRIP
${LiveWater3D.RIPPLE_GLSL}
#endif
float areaDist(vec2 p) {
    vec2 d = p - uArea.xy;
    if (uAreaDir.z < 0.5) return length(d) - uArea.z;
    vec2 l = vec2(d.x * uAreaDir.x + d.y * uAreaDir.y, -d.x * uAreaDir.y + d.y * uAreaDir.x);
    vec2 q = abs(l) - uArea.zw;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float bandQ(float x, float bands, float soft) {
    float t = clamp(x, 0.0, 1.0) * (bands - 1.0);
    float k = floor(t + 0.5);
    float d = t - k;
    float s = max(1e-3, soft);
    float q = k + smoothstep(0.5 - s, 0.5 + s, d) - smoothstep(0.5 - s, 0.5 + s, -d);
    return clamp(q / (bands - 1.0), 0.0, 1.0);
}
float fogF(float d) {
    if (uFog.x < 0.5) return 1.0;
    if (uFog.x < 1.5) return exp(-d * uFog.y);
    if (uFog.x < 2.5) return exp(-(d * uFog.y) * (d * uFog.y));
    return (uFog.w - d) / max(1e-3, uFog.w - uFog.z);
}
void main(void) {
    vec2 p = vWorld.xz;
    float soft = max(1.0, uStyle.z);
    float edge = 1.0 - smoothstep(-soft, 0.0, areaDist(p));
    vec4 S = texture2D(uShore, (p - uShoreRect.xy) / uShoreRect.zw);
    float depth = (S.r * 2.0 - 1.0) * uShoreInfo.x;
    float dist = S.g * uShoreInfo.y;
    float obst = S.b * uShoreInfo.y;
    float cover = smoothstep(${F(-S.coverLo)}, ${F(S.coverHi)}, depth) * edge;
    if (cover < 0.01) discard;
    bool toon = uToon.x > 0.5;
    float t = uTime;
    vec2 q = p * 0.012;
    float n1 = noise(q + vec2(t * 0.35, t * 0.21));
#if NOISE > 1
    float n2 = noise(q * 2.3 - vec2(t * 0.28, -t * 0.4));
#else
    float n2 = n1;
#endif
    vec3 geo = vNormal;
    float rv = vCR.y;
#ifdef FRAGRIP
    vec2 ruv = (p - uRippleRect.xy) / uRippleRect.zw;
    float tx = uRippleInfo.y;
    float tz = uRippleInfo.z;
    rv = rip(ruv);
    float rx = rip(ruv + vec2(tx, 0.0)) - rip(ruv - vec2(tx, 0.0));
    float rz = rip(ruv + vec2(0.0, tz)) - rip(ruv - vec2(0.0, tz));
    geo = normalize(geo + vec3(-rx * uRippleInfo.x / (2.0 * uRippleRect.z * tx), 0.0, -rz * uRippleInfo.x / (2.0 * uRippleRect.w * tz)) * 3.0);
#endif
    vec3 N = normalize(geo + vec3((n1 - 0.5) * 0.22 + (n2 - 0.5) * 0.12, 0.0, (n2 - 0.5) * 0.22 - (n1 - 0.5) * 0.1));
    vec3 V = normalize(uCam - vWorld);
    float fres = 0.06 + 0.9 * pow(1.0 - max(dot(N, V), 0.0), 4.0);
    vec3 R = reflect(-V, N);
    vec3 sky = mix(uHorizon, uSky, clamp(R.y * 1.8, 0.0, 1.0));
    float dn = clamp(depth / uShoreInfo.x, 0.0, 1.0);
    float dd = clamp(dist / uShoreInfo.y, 0.0, 1.0);
    float shallow = 1.0 - smoothstep(0.0, 1.0, min(dn, dd));
    float ndl = max(dot(N, uSun), 0.0);
    if (toon) {
        shallow = bandQ(shallow, uToon.y, uToon.z);
        ndl = bandQ(ndl, uToon.y, uToon.z);
    }
    vec3 water = mix(uDeep, uShallow, shallow);
    water *= 0.85 + 0.15 * ndl;
    vec3 col = mix(water, sky, fres);
    float sd = max(dot(R, uSun), 0.0);
    float spec = pow(sd, 260.0) * 2.2 + pow(sd, 40.0) * 0.12;
    if (toon) spec = smoothstep(0.996, 0.998, sd) * 1.2 + smoothstep(0.975, 0.985, sd) * 0.1;
    col += uSunColor * spec * uStyle.y;
    float W = max(1.0, uShoreInfo.z);
    float surf = 1.0 - smoothstep(0.0, W, dist + sin(t * 1.6 + (p.x + p.y) * 0.018) * 12.0 + n1 * 22.0);
    float band = smoothstep(0.75, 1.0, sin(dist * 0.05 - t * 2.2) * 0.5 + 0.5) * (1.0 - smoothstep(W * ${F(S.bandNear)}, W * ${F(S.bandFar)}, dist));
    float foam = surf * ${F(S.surfGain)} + band * ${F(S.bandGain)} * n2;
    float osurf = 1.0 - smoothstep(0.0, W, obst + sin(t * 1.4 + (p.x - p.y) * 0.02) * 10.0 + n2 * 18.0);
    float oband = smoothstep(0.75, 1.0, sin(obst * 0.05 - t * 2.0) * 0.5 + 0.5) * (1.0 - smoothstep(W * ${F(S.bandNear)}, W * ${F(S.bandFar)}, obst));
    foam += osurf * ${F(S.surfGain)} + oband * ${F(S.bandGain)} * n1;
    foam += smoothstep(0.82, 1.05, vCR.x + n1 * 0.12) * 0.25;
    foam += smoothstep(0.35, 0.9, abs(rv)) * 0.55 * uStyle.w;
    foam = clamp(foam * uShoreInfo.w, 0.0, ${F(S.foamMax)});
    // Светлая кромка кругов: слабее пены, но видна и при небольшой высоте ряби.
    float ring = smoothstep(${F(S.ringLo)}, ${F(S.ringHi)}, abs(rv)) * ${F(S.ringGain)} * uStyle.w * uShoreInfo.w;
    if (toon) {
        foam = smoothstep(0.3, 0.34, foam) * ${F(S.foamMax)};
        ring = smoothstep(${F(S.ringLo)}, ${F(S.ringLo + 0.03)}, abs(rv)) * ${F(S.ringGain)} * uStyle.w * uShoreInfo.w;
    }
    col = mix(col, uFoamColor, max(foam, ring));
    float alpha = mix(uStyle.x, 1.0, smoothstep(0.0, 0.5, dn));
    alpha = clamp(max(max(alpha, fres), max(foam, ring)), 0.0, 1.0) * cover;
    float f = clamp(fogF(length(uCam - vWorld)), 0.0, 1.0);
    col = mix(uFogColor, col, f);
    gl_FragColor = vec4(col, alpha);
}`;
    }
}

// Уровни качества (см. qualityOf).
LiveWater3D.QUALITY = {
    1: { grid: 0.4, vpw: 3, waves: 3, simCell: 1.6, simMax: 96, shoreTexel: 22, shoreMax: 128, frag: false, noise: 1, ambient: 0, steps: 2 },
    2: { grid: 0.7, vpw: 5, waves: 4, simCell: 1.25, simMax: 144, shoreTexel: 14, shoreMax: 192, frag: false, noise: 2, ambient: 1, steps: 3 },
    3: { grid: 1, vpw: 8, waves: 6, simCell: 1, simMax: 192, shoreTexel: 10, shoreMax: 256, frag: true, noise: 2, ambient: 1, steps: 3 }
};
// Числа берега и пены: одни и те же в shoreClass и в тексте шейдера.
LiveWater3D.SHORE = {
    coverLo: 4,          // px глубины ниже нуля, где вода ещё чуть видна (линия берега мягкая)
    coverHi: 6,          // px глубины, на которой вода полностью покрывает дно
    surfGain: 0.8,       // сила прибоя у кромки
    bandGain: 0.28,      // сила бегущих полос
    bandNear: 0.7,       // полосы: полная сила до bandNear·ширина пены
    bandFar: 2.85,       // ...и нет вовсе дальше bandFar·ширина пены
    foamMax: 0.85,       // верхний предел пены (прозрачность белого)
    ringLo: 0.1,         // высота ряби (доли amp), с которой круги получают светлую кромку
    ringHi: 0.32,        // ...и полную кромку
    ringGain: 0.3,       // сила светлой кромки кругов
    foamZone: 0.25,      // пена гуще этого — зона 'surf'
    reachPerFoam: 7.5    // дальность расстояний = ширина пены × это
};
LiveWater3D.TAU = Math.PI * 2;
LiveWater3D.MAX_WAVES = 6;        // предел шейдера (uWaveA/uWaveB)
LiveWater3D.MAX_BODIES = 6;       // областей воды на экземпляр
LiveWater3D.INVERT_ITERS = 4;     // итераций обратного смещения Герстнера на CPU
LiveWater3D.WALL_PAD = 8;         // px: просвет, меньше которого клетка ряби — стенка
LiveWater3D.SLEEP_PEAK = 0.004;   // пик ряби, ниже которого сетка засыпает

// Тело воды: одна область = меш, карта берега, рябь, материал. Запросы CPU (просвет, глубина,
// поправка амплитуды у берега) читают те же массивы, из которых собраны меш и текстуры.
class LiveWaterBody {
    /** @param {any} s */
    constructor(s) {
        this.shape = s.shape;
        this.level = s.level;
        this.ext = s.ext;
        this.grid = s.grid;
        this.shore = s.shore;
        this.obstacles = s.obstacles;
        this.sim = s.sim;
        this.index = s.index;
        /** @type {any} */
        this.mesh = null;
        /** @type {any} */
        this.material = null;
        /** @type {any} */
        this.rippleTex = null;
        /** @type {any} */
        this.shoreTex = null;
        const g = this.grid;
        this.scaleFn = (x, y) => LiveWater3D.bilerp(g.scale, g.nx, g.ny, g.x0, g.y0, g.dx, g.dy, 0, x, y);
    }

    // Точка внутри области и над водой (земля ниже уровня).
    contains(x, y) {
        return LiveWater3D.edgeDistance(this.shape, x, y) < 0 && this.depthAt(x, y) > 0;
    }

    // Точка внутри препятствия (остров, скала).
    inObstacle(x, y) {
        for (const o of this.obstacles) if (LiveWater3D.edgeDistance(o, x, y) < 0) return true;
        return false;
    }

    depthAt(x, y) {
        const b = this.shore;
        return LiveWater3D.bilerp(b.depth, b.w, b.h, b.x0, b.y0, b.cx, b.cy, 0.5, x, y);
    }

    // Просвет: до края области, суши (карта расстояний) и препятствий; меньше нуля — вне воды.
    clearAt(x, y) {
        let c = -LiveWater3D.edgeDistance(this.shape, x, y);
        if (c <= 0) return c;
        const b = this.shore;
        const sd = LiveWater3D.bilerp(b.dist, b.w, b.h, b.x0, b.y0, b.cx, b.cy, 0.5, x, y);
        if (sd < c) c = sd;
        for (const o of this.obstacles) { const e = LiveWater3D.edgeDistance(o, x, y); if (e < c) c = e; }
        return c;
    }

    // Направление «от стенки» — градиент просвета; в тупике — к центру области.
    clearNormal(x, y) {
        const e = Math.max(4, Math.min(this.shore.cx, this.shore.cy) * 0.75);
        let gx = this.clearAt(x + e, y) - this.clearAt(x - e, y), gy = this.clearAt(x, y + e) - this.clearAt(x, y - e);
        let l = Math.hypot(gx, gy);
        if (l < 1e-6) { gx = this.shape.x - x; gy = this.shape.y - y; l = Math.hypot(gx, gy) || 1; }
        return [gx / l, gy / l];
    }

    dispose() {
        for (const o of [this.mesh, this.material, this.rippleTex, this.shoreTex]) {
            if (!o) continue;
            try { if (!(o.isDisposed && o.isDisposed())) o.dispose(false, false); } catch (e) { /* сцена уже умирает */ }
        }
        this.mesh = this.material = this.rippleTex = this.shoreTex = null;
    }
}
