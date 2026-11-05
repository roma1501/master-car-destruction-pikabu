// Terrain3D.js — земля карты: поле высот из шума, одна сетка на прямоугольник
// [0..W]×[0..H] и грубое кольцо земли за краем (на низком угле камеры за краем
// иначе зияло бы небо). Поверх шума — ЗОНЫ рельефа, ПОКРАСКА земли и ВОДА из
// маркеров карты (ниже); без этих маркеров земля та же, что была.
//
// Высота — base + шум (SimplexNoise(seed), две октавы, амплитуда amp, размер
// холма scale) — рельеф карты (Maps.js: terrain, передаёт Location3D). heightAt()
// читает ТЕ ЖЕ треугольники, что рисует меш: объекты стоят ровно на
// поверхности. Не заменяй на билинейную интерполяцию — на склонах объекты
// начнут тонуть или висеть.
//
// ОГРОМНАЯ КАРТА: шаг сетки (и клетка кольца) растёт сам, чтобы узлов было не больше TERRAIN_MAX_CELLS
// (fitCell); heightAt и меш читают один и тот же шаг, объекты стоят на поверхности и там.
//
// Материал — тайл текстуры (setGroundImage), повтор каждые GROUND_TILE_SIZE px.
// UV у сетки и кольца одни — (x/W, y/H), поэтому тайл продолжается за край без
// шва. Кольцо красится WORLD3D_OUTER_TINT (меньше 1 — граница локации видна).
//
// ТЕРРЕЙН — КАРТИНКА. Логика игры высоту у 3D не спрашивает: клетка сетки
// зависит от устройства (мобильные — крупнее), и расчёт разошёлся бы между ними.
// Исключение — аналитика зон, она считается по маркерам карты, а не по картинке, и
// не зависит ни от клетки сетки, ни от разрешения красок:
//   groundTypeAt(x, y)  тип земли под точкой ('grass' | 'dirt' | …);
//   waterAt(x, y)       уровень воды под точкой или null;
//   fieldHeight(x, y)   высота поля (шум + холмы + ровные зоны) — одна на всех устройствах.
//
// МАРКЕРЫ-ЗОНЫ (Location3D кладёт их в cfg.markers; имена как у редактора: имя,
// имя-2, имя-3…). Фигура: круг радиуса scale[0]·100 px; если scale[2] ≠ scale[0] —
// прямоугольник полуразмеров scale[0]·100 × scale[2]·100, повёрнутый на rot[1]
// (курс, градусы). У zone-raise и water — только круг. Ось scale[1] не читается.
//   zone-flat   земля внутри фигуры ровная: высота шума (и холмов zone-raise) в
//               центре + h; за кромкой плавный спуск шириной TERRAIN_ZONE_BLEND ·
//               меньшая полуось (smoothstep). Ровные зоны применяются ПОСЛЕ
//               холмов — площадка на холме остаётся ровной.
//   zone-raise  купол радиуса R высотой h (минус — котловина), профиль smoothstep;
//               несколько зон складываются.
//   paint-<тип> покраска: dirt, path, sand, snow, rock, dark, grass2, lava (цвета —
//               Terrain3D.PAINT_COLORS; игра может дописать свои). Тот же круг/
//               прямоугольник, мягкий край внутри фигуры; следующие маркеры ложатся
//               поверх предыдущих.
//   water       плоскость воды: круг радиуса R, уровень = высота поля в центре + h.
// Во всех формулах высота — fieldHeight(x, y); сетка и кольцо берут её же.
//
// ПОКРАСКА. Карта красок — RGBA (premultiplied) на всю карту, 64…2048 px
// (TERRAIN_PAINT_*), считается на CPU без canvas. Шейдер плагина LoryPaint
// (StandardMaterial, как toon) берёт мировую позицию фрагмента: краска ложится на
// тайл травы, а светлота тайла (пятна, травинки) остаётся поверх краски — трава и
// земля не плоские. Текстура кладётся с CLAMP: кольцо за краем продолжает цвет
// на кромке карты (непокрашенный край — та же трава).
//
// ВОДА. Круг-меш на уровне воды + карта глубины (глубина со знаком из heightAt) и
// плагин LoryWater: цвет и прозрачность от глубины, пена у берега, дрейфующие
// блики, мягкий край круга. Свет, туман и toon — штатные (StandardMaterial).
//
// ЖИВАЯ ПРАВКА (редактор): Location3D сверяет подписи маркеров-зон и зовёт то, что
// изменилось, — buildTerrain (холмы и ровные зоны), setPaints, setWaters.

class Terrain3D {
    // cfg: { worldW, worldH, groundImage?, cell?, noise?: { amp, scale, seed, base },
    //        markers?: маркеры карты (зоны, покраска, вода), baseType?: 'grass' | 'sand' | 'snow' }
    constructor(view, cfg) {
        const U = 'undefined';
        this.view = view;
        this.scene = view.scene;
        this.worldW = Math.max(64, cfg.worldW);
        this.worldH = Math.max(64, cfg.worldH);
        this.cell = Math.max(4, cfg.cell || (typeof TERRAIN_CELL !== U ? TERRAIN_CELL : 8));
        if (IS_MOBILE) this.cell = Math.max(this.cell, 12);
        // Огромная карта (трассы на десятки тысяч px): шаг сетки растёт, чтобы узлов было не больше TERRAIN_MAX_CELLS.
        // Зависит только от размера карты и константы, не от устройства. 0 — без предела.
        this.maxCells = typeof TERRAIN_MAX_CELLS !== U ? TERRAIN_MAX_CELLS : 250000;
        this.cell = Terrain3D.fitCell(this.worldW, this.worldH, this.cell, this.maxCells);
        // Рельеф — карты (Location3D берёт его из Maps.js); без него — невысокие холмы.
        const nz = cfg.noise || {};
        this.noiseAmp = nz.amp != null ? nz.amp : 40;
        this.noiseScale = Math.max(40, nz.scale != null ? nz.scale : 800);
        this.noiseBase = nz.base != null ? nz.base : 0;
        this.noiseSeed = nz.seed != null ? nz.seed : 1;
        this._noise = (typeof SimplexNoise !== U) ? new SimplexNoise(String(this.noiseSeed)) : null;
        this.baseType = cfg.baseType || 'grass';
        // Ширину кольца читает предел наклона камеры: край кольца не должен попасть в кадр.
        this.outerRing = Terrain3D.OUTER_RING;
        this.meshes = [];
        this.texture = null;
        this.tileLum = 0.4;       // средняя светлота тайла — норма для детали под краской
        this.paintTexture = null;
        this._paintPlugins = [];
        /** @type {Water3D[]} */
        this.waters = [];
        this.waterDefs = [];
        this.paints = [];
        this._parseRelief(cfg.markers);
        this._buildMaterials();
        this._buildField();
        this._buildGeometry();
        this._buildOuterRing();
        this.paints = Terrain3D.paintZones(cfg.markers);
        this._buildPaint();
        this.waterDefs = Terrain3D.waterZones(cfg.markers);
        this._buildWaters();
        if (cfg.groundImage) this.setGroundImage(cfg.groundImage);
    }

    // --- Материал ------------------------------------------------------------------

    // Два материала на одну текстуру: сетка локации и кольцо за краем (у кольца
    // своя яркость). Пока текстуры нет — ровный зелёный.
    _buildMaterials() {
        const mat = new BABYLON.StandardMaterial('terrainMat', this.scene);
        mat.metadata = { toonGroup: 'ground' };
        mat.diffuseColor = new BABYLON.Color3(0.25, 0.4, 0.18);
        World3D.applyMaterialConstants(mat);
        this.material = mat;
        const outer = new BABYLON.StandardMaterial('terrainOuterMat', this.scene);
        outer.metadata = { toonGroup: 'ground' };
        outer.diffuseColor = new BABYLON.Color3(0.25, 0.4, 0.18);
        World3D.applyMaterialConstants(outer);
        this.outerMaterial = outer;
    }

    // Тайл текстуры земли (Image или Canvas). DynamicTexture с invertY = false:
    // V идёт вниз по карте, как y.
    setGroundImage(img) {
        if (!img || !(img.width > 0)) return;
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        c.getContext('2d').drawImage(img, 0, 0);
        const tex = new BABYLON.DynamicTexture('groundTile', c, this.scene, true,
            BABYLON.Texture.TRILINEAR_SAMPLINGMODE, BABYLON.Constants.TEXTUREFORMAT_RGBA, false);
        tex.update(false);
        tex.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
        tex.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
        tex.anisotropicFilteringLevel = IS_MOBILE ? 2 : 8;
        const old = this.texture;
        this.texture = tex;
        this.tileLum = Terrain3D.averageLuma(c);
        for (const p of this._paintPlugins) p.setTile(this.tileLum);
        this.applyTileSize();
        // С текстурой цвет материала — множитель: у сетки белый, у кольца — яркость
        // WORLD3D_OUTER_TINT (metadata.outer читает applyMaterialConstants).
        this.material.diffuseTexture = tex;
        this.material.diffuseColor = new BABYLON.Color3(1, 1, 1);
        this.outerMaterial.diffuseTexture = tex;
        this.outerMaterial.metadata.outer = true;
        World3D.applyMaterialConstants(this.outerMaterial);
        if (old) { try { old.dispose(); } catch (e) { /* ok */ } }
    }

    // Повтор тайла — масштабом текстуры: u' = (x/W)·(W/tile) = x/tile.
    // GROUND_TILE_SIZE сменился (редактор) — только это.
    applyTileSize() {
        if (!this.texture) return;
        const tile = Math.max(16, (typeof GROUND_TILE_SIZE !== 'undefined') ? GROUND_TILE_SIZE : 512);
        this.texture.uScale = this.worldW / tile;
        this.texture.vScale = this.worldH / tile;
    }

    // Средняя светлота картинки (0..1, значения как есть — без гаммы): 16×16 усреднением
    // браузера. Нет canvas (тесты) или картинка не читается — 0.4.
    static averageLuma(source) {
        try {
            const s = document.createElement('canvas');
            s.width = s.height = 16;
            const g = s.getContext('2d');
            g.drawImage(source, 0, 0, 16, 16);
            const d = g.getImageData(0, 0, 16, 16).data;
            let sum = 0;
            for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            return Math.max(0.05, sum / (d.length / 4) / 255);
        } catch (e) {
            return 0.4;
        }
    }

    // Шаг сетки (px) для поля worldW × worldH: не мельче cell и такой, чтобы узлов не было больше maxCells. Узлов
    // (⌈W/шаг⌉+1)·(⌈H/шаг⌉+1) — столько строит _buildField. maxCells ≤ 0 — предела нет; меньше 16 узлов не бывает.
    // Шаг, который уже укладывается в предел, не меняется.
    static fitCell(worldW, worldH, cell, maxCells) {
        const limit = Number(maxCells);
        if (!(limit > 0)) return cell;
        const cap = Math.max(16, Math.floor(limit));
        const nodes = (cs) => (Math.ceil(worldW / cs) + 1) * (Math.ceil(worldH / cs) + 1);
        let cs = cell;
        if (nodes(cs) <= cap) return cs;
        cs = Math.max(cs, Math.ceil(Math.sqrt(worldW * worldH / cap)));
        for (let guard = 0; nodes(cs) > cap && guard < 100000; guard++) cs++;   // у края +1 узел: первая оценка может не хватить
        return cs;
    }

    // --- Константы зон ----------------------------------------------------------------

    // Все числа читаются отсюда (в игре константы — лексические const, в редакторе —
    // window: только typeof по имени) с дефолтами на случай старого Constants.js.
    static cfg() {
        const U = 'undefined';
        return {
            blend: typeof TERRAIN_ZONE_BLEND !== U ? TERRAIN_ZONE_BLEND : 0.35,
            paintTexel: typeof TERRAIN_PAINT_TEXEL !== U ? TERRAIN_PAINT_TEXEL : 12,
            paintMax: typeof TERRAIN_PAINT_MAX !== U ? TERRAIN_PAINT_MAX : 2048,
            paintSoft: typeof TERRAIN_PAINT_SOFT !== U ? TERRAIN_PAINT_SOFT : 0.3,
            paintDetail: typeof TERRAIN_PAINT_DETAIL !== U ? TERRAIN_PAINT_DETAIL : 0.5,
            waterShallow: typeof WATER_SHALLOW_COLOR !== U ? WATER_SHALLOW_COLOR : 0x62dcd8,
            waterDeep: typeof WATER_DEEP_COLOR !== U ? WATER_DEEP_COLOR : 0x2a78d0,
            waterAlphaShallow: typeof WATER_ALPHA_SHALLOW !== U ? WATER_ALPHA_SHALLOW : 0.42,
            waterAlphaDeep: typeof WATER_ALPHA_DEEP !== U ? WATER_ALPHA_DEEP : 0.9,
            waterDepth: typeof WATER_DEPTH_FULL !== U ? WATER_DEPTH_FULL : 260,
            waveSpeed: typeof WATER_WAVE_SPEED !== U ? WATER_WAVE_SPEED : 1,
            foam: typeof WATER_FOAM !== U ? WATER_FOAM : 1
        };
    }

    // --- Зоны: разбор маркеров -----------------------------------------------------------

    // Имя маркера -> { kind: 'flat' | 'raise' | 'water' | 'paint', type? } или null.
    // Повторы редактор нумерует: имя, имя-2, имя-3…
    static zoneKind(name) {
        const n = String(name || '');
        let m = /^zone-(flat|raise)(?:-\d+)?$/.exec(n);
        if (m) return { kind: m[1] };
        m = /^paint-([a-z0-9]+)(?:-\d+)?$/.exec(n);
        if (m) return { kind: 'paint', type: m[1] };
        if (/^water(?:-\d+)?$/.test(n)) return { kind: 'water' };
        return null;
    }

    // Фигура маркера: центр, полуоси a (по курсу) и b (поперёк), поворот, h. Круг —
    // scale[2] равен scale[0] (или не задан); иначе прямоугольник.
    static shapeOf(def) {
        const sc = Array.isArray(def.scale) ? def.scale : [def.scale, def.scale, def.scale];
        const pos = (v) => (Number(v) > 0 ? Number(v) : 0);
        const a = Math.max(1, (pos(sc[0]) || 1) * 100);
        const b = pos(sc[2]) > 0 ? pos(sc[2]) * 100 : a;
        const r = Array.isArray(def.rot) ? def.rot : [0, def.rot, 0];
        const th = (Number(r[1]) || 0) * Math.PI / 180;
        return {
            x: Number(def.x) || 0, y: Number(def.y) || 0, h: Number(def.h) || 0,
            a, b, rect: Math.abs(b - a) > 1e-6, cos: Math.cos(th), sin: Math.sin(th),
            reach: 0
        };
    }

    // Расстояние от точки до кромки фигуры: меньше нуля — внутри (круг и прямоугольник).
    static edgeDistance(s, px, py) {
        const dx = px - s.x, dy = py - s.y;
        if (!s.rect) return Math.hypot(dx, dy) - s.a;
        // Локальные оси маркера: вдоль курса (cos, sin) и поперёк (−sin, cos).
        const lx = Math.abs(dx * s.cos + dy * s.sin) - s.a;
        const lz = Math.abs(-dx * s.sin + dy * s.cos) - s.b;
        return Math.hypot(Math.max(lx, 0), Math.max(lz, 0)) + Math.min(Math.max(lx, lz), 0);
    }

    static smooth(t) {
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        return t * t * (3 - 2 * t);
    }

    // Зоны рельефа из маркеров: холмы (круги) и ровные участки — в порядке карты.
    _parseRelief(markers) {
        const c = Terrain3D.cfg();
        this.raises = [];
        this.flats = [];
        for (const d of markers || []) {
            const k = Terrain3D.zoneKind(d.name);
            if (!k) continue;
            const s = Terrain3D.shapeOf(d);
            if (k.kind === 'raise') {
                s.rect = false;
                s.reach = s.a;
                this.raises.push(s);
            } else if (k.kind === 'flat') {
                s.blend = Math.max(1, Math.max(0, c.blend) * Math.min(s.a, s.b));
                s.reach = (s.rect ? Math.hypot(s.a, s.b) : s.a) + s.blend;
                this.flats.push(s);
            }
        }
        this.hasZones = this.raises.length + this.flats.length > 0;
        // Высота ровной зоны: шум и холмы в центре + h (холмы уже разобраны — _raiseSum).
        for (const z of this.flats) z.target = this.terrainNoise(z.x, z.y) + this._raiseSum(z.x, z.y) + z.h;
    }

    _raiseSum(x, y) {
        let h = 0;
        for (const z of this.raises) {
            const dx = x - z.x, dy = y - z.y;
            if (dx > z.a || dx < -z.a || dy > z.a || dy < -z.a) continue;
            const t = 1 - Math.hypot(dx, dy) / z.a;
            if (t > 0) h += z.h * t * t * (3 - 2 * t);
        }
        return h;
    }

    // --- Поле высот ------------------------------------------------------------------

    // Чистый шум карты (без зон): так же устроено кольцо без зон.
    terrainNoise(x, y) {
        if (!this._noise || !(this.noiseAmp > 0)) return this.noiseBase;
        const s = this.noiseScale;
        const n = this._noise.noise2D(x / s, y / s) * 0.72 +
                  this._noise.noise2D(x / s * 2.3 + 17.1, y / s * 2.3 - 9.7) * 0.28;
        return this.noiseBase + n * this.noiseAmp;
    }

    // Высота рельефа в любой точке: шум + холмы, затем ровные зоны (они главнее).
    // Узлы сетки и кольца — отсюда; без зон равна terrainNoise. Не зависит от клетки
    // сетки (телефон/ПК), поэтому годится для логики игры.
    fieldHeight(x, y) {
        let h = this.terrainNoise(x, y);
        if (!this.hasZones) return h;
        h += this._raiseSum(x, y);
        for (const z of this.flats) {
            if (x - z.x > z.reach || z.x - x > z.reach || y - z.y > z.reach || z.y - y > z.reach) continue;
            const d = Terrain3D.edgeDistance(z, x, y);
            if (d >= z.blend) continue;
            h += (z.target - h) * (d <= 0 ? 1 : 1 - Terrain3D.smooth(d / z.blend));
        }
        return h;
    }

    // Высоты в узлах сетки [0..W]×[0..H] с шагом cell. Последняя клетка может
    // выйти за край (UV там > 1 — тайл просто продолжается).
    _buildField() {
        const cs = this.cell;
        this.nx = Math.ceil(this.worldW / cs) + 1;
        this.ny = Math.ceil(this.worldH / cs) + 1;
        const nx = this.nx, ny = this.ny;
        const H = new Float32Array(nx * ny);
        let lo = Infinity, hi = -Infinity;
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const h = this.fieldHeight(i * cs, j * cs);
                H[j * nx + i] = h;
                if (h < lo) lo = h;
                if (h > hi) hi = h;
            }
        }
        this.hgrid = H;
        // Диапазон высот — для луча указателя (View3D.pointerToGround) и предела камеры.
        this.hMin = lo;
        this.hMax = hi;
    }

    // Высота поверхности под точкой — ровно та, что рисуется: клетка разбита
    // диагональю (i,j)-(i+1,j+1) на треугольники (00,10,11) и (00,11,01), как в
    // меше. За краем сетки — поле высот, как у кольца.
    heightAt(x, y) {
        const cs = this.cell, n = this.nx;
        const fx = x / cs, fy = y / cs;
        if (fx < 0 || fy < 0 || fx > n - 1 || fy > this.ny - 1) return this.fieldHeight(x, y);
        const i = Math.min(n - 2, Math.floor(fx)), j = Math.min(this.ny - 2, Math.floor(fy));
        const tx = fx - i, ty = fy - j;
        const g = this.hgrid;
        const h00 = g[j * n + i], h10 = g[j * n + i + 1];
        const h01 = g[(j + 1) * n + i], h11 = g[(j + 1) * n + i + 1];
        if (tx >= ty) return h00 + (h10 - h00) * tx + (h11 - h10) * ty;
        return h00 + (h01 - h00) * ty + (h11 - h01) * tx;
    }

    // Наклон поверхности вдоль курса (рад): продольный и поперечный уклон по
    // четырём точкам базы объекта — для тангажа и крена корпуса.
    tiltAt(x, y, headingRad, halfLen, halfWid) {
        const cx = Math.cos(headingRad), sy = Math.sin(headingRad);
        const hf = this.heightAt(x + cx * halfLen, y + sy * halfLen);
        const hb = this.heightAt(x - cx * halfLen, y - sy * halfLen);
        const hl = this.heightAt(x - sy * halfWid, y + cx * halfWid);
        const hr = this.heightAt(x + sy * halfWid, y - cx * halfWid);
        return {
            pitch: Math.atan2(hf - hb, halfLen * 2),   // нос выше кормы -> положительный
            roll: Math.atan2(hl - hr, halfWid * 2)     // левый борт выше -> положительный
        };
    }

    // --- Сетки --------------------------------------------------------------------

    // Индексы регулярной сетки nx×ny: треугольники (a,b,d)(a,d,c) по диагонали
    // a-d; swap — обратный обход.
    static gridIndices(nx, ny, swap) {
        const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
        let p = 0;
        for (let j = 0; j < ny - 1; j++) {
            for (let i = 0; i < nx - 1; i++) {
                const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
                if (swap) { idx[p++] = a; idx[p++] = d; idx[p++] = b; idx[p++] = a; idx[p++] = c; idx[p++] = d; }
                else { idx[p++] = a; idx[p++] = b; idx[p++] = d; idx[p++] = a; idx[p++] = d; idx[p++] = c; }
            }
        }
        return idx;
    }

    // Сетка локации. ОРИЕНТАЦИЯ: земле нужна нормаль +Y. ComputeNormals берёт
    // нормаль грани (p1−p2)×(p3−p2) — по ней выбирается обход, а страховка
    // после ComputeNormals переворачивает его, если движок посчитал иначе. Не
    // «чинить» порядок вручную: правосторонняя сцена уже стоила итерации.
    _buildGeometry() {
        const nx = this.nx, ny = this.ny, cs = this.cell, NV = nx * ny, H = this.hgrid;
        const W = this.worldW, HH = this.worldH;
        const pos = new Float32Array(NV * 3), uvs = new Float32Array(NV * 2);
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const k = j * nx + i, x = i * cs, y = j * cs;
                pos[k * 3] = x; pos[k * 3 + 1] = H[k]; pos[k * 3 + 2] = y;
                uvs[k * 2] = x / W; uvs[k * 2 + 1] = y / HH;
            }
        }
        // Нормаль первого треугольника (a, b, d): (a − b) × (d − b), компонента Y.
        const b = 3, d = (nx + 1) * 3;
        const ax = pos[0] - pos[b], az = pos[2] - pos[b + 2];
        const qx = pos[d] - pos[b], qz = pos[d + 2] - pos[b + 2];
        let swap = (az * qx - ax * qz) < 0;
        let idx = Terrain3D.gridIndices(nx, ny, swap);
        const normals = new Float32Array(pos.length);
        BABYLON.VertexData.ComputeNormals(pos, idx, normals);
        if (normals[1] < 0) {
            swap = !swap;
            idx = Terrain3D.gridIndices(nx, ny, swap);
            BABYLON.VertexData.ComputeNormals(pos, idx, normals);
        }
        this._swap = swap;   // тот же обход — у кольца

        const mesh = new BABYLON.Mesh('terrain', this.scene);
        const vd = new BABYLON.VertexData();
        vd.positions = pos;
        vd.indices = idx;
        vd.normals = normals;
        vd.uvs = uvs;
        vd.applyToMesh(mesh, false);
        mesh.receiveShadows = true;
        mesh.isPickable = false;
        mesh.freezeWorldMatrix();
        mesh.material = this.material;
        this.mesh = mesh;
        this.triangles = idx.length / 3;
        this.meshes.push(mesh);
    }

    // Кольцо земли вокруг локации: поле высот, клетка RING_CELL. Дыра в нём —
    // сетка локации; клетки кольца у её края остаются и лежат на 1 px НИЖЕ (под
    // сеткой, не дальше полутора клеток) — T-стык грубой и мелкой сеток не светит небом.
    _buildOuterRing() {
        const W = this.worldW, H = this.worldH;
        // Клетка кольца тоже растёт на огромной карте: сетка кольца охватывает всю карту, 64 px дали бы миллион узлов.
        const extent = this.outerRing, cell = Terrain3D.fitCell(W + 2 * extent, H + 2 * extent, Terrain3D.RING_CELL, this.maxCells);
        const x0 = -extent, y0 = -extent;
        const nx = Math.ceil((W + 2 * extent) / cell) + 1, ny = Math.ceil((H + 2 * extent) / cell) + 1;
        const positions = new Float32Array(nx * ny * 3), uvs = new Float32Array(nx * ny * 2);
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const k = j * nx + i, x = x0 + i * cell, y = y0 + j * cell;
                positions[k * 3] = x; positions[k * 3 + 1] = this.fieldHeight(x, y) - 1; positions[k * 3 + 2] = y;
                uvs[k * 2] = x / W; uvs[k * 2 + 1] = y / H;
            }
        }
        // Клетки — только вне сетки локации (с запасом в клетку у её края).
        const X1 = (this.nx - 1) * this.cell, Y1 = (this.ny - 1) * this.cell;
        const inside = (x, y) => x > 0 && x < X1 && y > 0 && y < Y1;
        const indices = [];
        for (let j = 0; j < ny - 1; j++) {
            for (let i = 0; i < nx - 1; i++) {
                const cx = x0 + (i + 0.5) * cell, cy = y0 + (j + 0.5) * cell;
                if (inside(cx, cy) && inside(cx - cell, cy - cell) && inside(cx + cell, cy + cell)) continue;
                const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
                if (this._swap) indices.push(a, d, b, a, c, d); else indices.push(a, b, d, a, d, c);
            }
        }
        const normals = new Float32Array(positions.length);
        BABYLON.VertexData.ComputeNormals(positions, indices, normals);
        const mesh = new BABYLON.Mesh('terrainOuter', this.scene);
        const vd = new BABYLON.VertexData();
        vd.positions = positions;
        vd.indices = indices;
        vd.normals = normals;
        vd.uvs = uvs;
        vd.applyToMesh(mesh, false);
        mesh.isPickable = false;
        mesh.receiveShadows = true;
        mesh.freezeWorldMatrix();
        mesh.material = this.outerMaterial;
        this.outer = mesh;
        this.meshes.push(mesh);
    }

    // --- Покраска земли ----------------------------------------------------------------

    // Краска по умолчанию — Terrain3D.PAINT_COLORS (ниже). Маркеры paint-<тип> -> зоны
    // [{ ...фигура, type, color: [r, g, b] 0..255, feather }] в порядке карты; неизвестный
    // тип пропускается.
    static paintZones(markers) {
        const out = [];
        const soft = Math.max(0, Terrain3D.cfg().paintSoft);
        for (const d of markers || []) {
            const k = Terrain3D.zoneKind(d.name);
            if (!k || k.kind !== 'paint') continue;
            const hex = Terrain3D.PAINT_COLORS[k.type];
            if (hex == null) continue;
            const s = Terrain3D.shapeOf(d);
            const minR = Math.min(s.a, s.b);
            s.type = k.type;
            s.color = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
            // Мягкий край — внутрь фигуры: не уже 24 px и не шире 90% меньшей полуоси.
            s.feather = Math.max(1, Math.min(minR * 0.9, Math.max(24, Math.min(400, soft * minR))));
            s.reach = s.rect ? Math.hypot(s.a, s.b) : s.a;
            out.push(s);
        }
        return out;
    }

    // Покрытие краской в точке 0..1. n01 — шум 0..1 (кромка неровная на ±0.25 ширины
    // края); 0.5 — без шума (groundTypeAt).
    static paintCover(z, x, y, n01) {
        const t = -Terrain3D.edgeDistance(z, x, y) / z.feather + (0.5 - n01) * 0.5;
        return Terrain3D.smooth(t);
    }

    // Целочисленный хэш -> 0..1 (детерминированный: карта красок не зависит от запуска).
    static hash2(ix, iy, seed) {
        let h = (Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    }

    // Value-noise 0..1 с плавной интерполяцией.
    static vnoise(x, y, seed) {
        const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
        const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
        const a = Terrain3D.hash2(ix, iy, seed), b = Terrain3D.hash2(ix + 1, iy, seed);
        const c = Terrain3D.hash2(ix, iy + 1, seed), d = Terrain3D.hash2(ix + 1, iy + 1, seed);
        return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
    }

    // Размер карты красок: сторона — степень двойки около (размер карты / TERRAIN_PAINT_TEXEL),
    // 64…TERRAIN_PAINT_MAX; телефоны — вдвое грубее и не больше 1024.
    static paintSize(worldW, worldH) {
        const c = Terrain3D.cfg();
        const texel = Math.max(1, c.paintTexel) * (IS_MOBILE ? 2 : 1);
        const cap = Math.max(64, IS_MOBILE ? Math.min(1024, c.paintMax) : c.paintMax);
        const side = (len) => Math.max(64, Math.min(cap, Math.pow(2, Math.round(Math.log2(Math.max(1, len / texel))))));
        return { w: side(worldW), h: side(worldH) };
    }

    // Карта красок RGBA (premultiplied) tw × th на всю карту: каждый текcель — центр клетки
    // мира; зоны ложатся «поверх» по порядку. К цвету типа — крупное и мелкое зерно,
    // кромка — неровная (paintCover). Чистая функция: без canvas, считается и в тестах.
    static paintRaster(paints, worldW, worldH, tw, th, seed) {
        const out = new Uint8Array(tw * th * 4);
        const sx = worldW / tw, sy = worldH / th, sd = (seed | 0) * 7919 + 13;
        for (let zi = 0; zi < paints.length; zi++) {
            const z = paints[zi];
            const i0 = Math.max(0, Math.floor((z.x - z.reach) / sx)), i1 = Math.min(tw - 1, Math.ceil((z.x + z.reach) / sx));
            const j0 = Math.max(0, Math.floor((z.y - z.reach) / sy)), j1 = Math.min(th - 1, Math.ceil((z.y + z.reach) / sy));
            const zs = sd + zi * 131;
            for (let j = j0; j <= j1; j++) {
                const py = (j + 0.5) * sy;
                for (let i = i0; i <= i1; i++) {
                    const px = (i + 0.5) * sx;
                    if (Terrain3D.edgeDistance(z, px, py) > 0) continue;
                    const a = Terrain3D.paintCover(z, px, py, Terrain3D.vnoise(px / 170, py / 170, zs));
                    if (a <= 0.004) continue;
                    const shade = 1 + (Terrain3D.vnoise(px / 320, py / 320, zs + 5) - 0.5) * 0.2 +
                        (Terrain3D.hash2(i, j, zs + 9) - 0.5) * 0.05;
                    const o = (j * tw + i) * 4, k = 1 - a;
                    for (let c = 0; c < 3; c++) {
                        out[o + c] = Math.min(255, Math.round(z.color[c] * shade * a + out[o + c] * k));
                    }
                    out[o + 3] = Math.round(255 * (a + out[o + 3] / 255 * k));
                }
            }
        }
        return out;
    }

    // Тип земли под точкой для логики игры: 'dirt' | 'path' | 'sand' | 'snow' | 'rock' |
    // 'dark' | 'grass2' | 'lava' (и свои типы из PAINT_COLORS) по маркерам paint-<тип>
    // (верхний слой, середина мягкого края — граница), иначе основа карты ('grass' |
    // 'sand' | 'snow'). Не зависит от клетки сетки и разрешения красок.
    groundTypeAt(x, y) {
        for (let i = this.paints.length - 1; i >= 0; i--) {
            const z = this.paints[i];
            if (x - z.x > z.reach || z.x - x > z.reach || y - z.y > z.reach || z.y - y > z.reach) continue;
            if (Terrain3D.paintCover(z, x, y, 0.5) >= 0.5) return z.type;
        }
        return this.baseType;
    }

    // Карта красок и плагины шейдера (на материалы сетки и кольца).
    _buildPaint() {
        this._disposePaint();
        if (!this.paints.length || typeof BABYLON === 'undefined' || !BABYLON.RawTexture) {
            // Краски нет, а тайла тоже (картинка не загрузилась): снова ровный зелёный цвет материала.
            if (this._paintPlugins.length && !this.texture) {
                for (const m of [this.material, this.outerMaterial]) m.diffuseColor = new BABYLON.Color3(0.25, 0.4, 0.18);
                this.outerMaterial.metadata.outer = false;
            }
            return;
        }
        const size = Terrain3D.paintSize(this.worldW, this.worldH);
        const data = Terrain3D.paintRaster(this.paints, this.worldW, this.worldH, size.w, size.h, this.noiseSeed);
        const tex = BABYLON.RawTexture.CreateRGBATexture(data, size.w, size.h, this.scene, true, false,
            BABYLON.Texture.TRILINEAR_SAMPLINGMODE);
        tex.wrapU = BABYLON.Texture.CLAMP_ADDRESSMODE;
        tex.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
        tex.anisotropicFilteringLevel = IS_MOBILE ? 1 : 4;
        this.paintTexture = tex;
        if (!this._paintPlugins.length) {
            const Plugin = Terrain3D.paintPlugin();
            if (!Plugin) return;
            // Основа без плагина — зелёный diffuseColor; под краской нужен белый множитель света.
            for (const m of [this.material, this.outerMaterial]) {
                this._paintPlugins.push(new Plugin(m));
                m.diffuseColor = new BABYLON.Color3(1, 1, 1);
            }
            this.outerMaterial.metadata.outer = true;
            World3D.applyMaterialConstants(this.outerMaterial);
        }
        const c = Terrain3D.cfg();
        for (const p of this._paintPlugins) p.setPaint(tex, this.worldW, this.worldH, this.tileLum, c.paintDetail);
    }

    _disposePaint() {
        for (const p of this._paintPlugins) p.setPaint(null);
        if (this.paintTexture) { try { this.paintTexture.dispose(); } catch (e) { /* ok */ } this.paintTexture = null; }
    }

    // Только покраска (маркеры paint-* правили): без пересборки сетки.
    setPaints(markers) {
        this.paints = Terrain3D.paintZones(markers);
        this._buildPaint();
    }

    // Класс плагина покраски — создаётся при первом использовании: скрипт грузится и без
    // Babylon (тесты), а BABYLON.MaterialPluginBase нужен только здесь.
    static paintPlugin() {
        if (Terrain3D._PaintPlugin) return Terrain3D._PaintPlugin;
        if (typeof BABYLON === 'undefined' || !BABYLON.MaterialPluginBase) return null;
        class LoryPaintPlugin extends BABYLON.MaterialPluginBase {
            constructor(material) {
                super(material, 'LoryPaint', 520, { LORYPAINT: false }, true, true);
                this.texture = null;
                this.info = [1, 1, 0.4, 0.5];
                const mat = /** @type {BABYLON.StandardMaterial} */ (material);
                const c = mat.diffuseColor;   // основа без тайла — цвет материала до перекраски в белый
                this.base = [0.25, 0.4, 0.18];
                if (c) this.base = [c.r, c.g, c.b];
            }
            getClassName() { return 'LoryPaintPlugin'; }
            // texture = null — покраски нет (шейдер без define).
            setPaint(texture, worldW, worldH, tileLum, detail) {
                this.texture = texture;
                if (texture) this.info = [1 / worldW, 1 / worldH, tileLum || 0.4, detail != null ? detail : 0.5];
                this.markAllDefinesAsDirty();
            }
            setTile(tileLum) { this.info[2] = tileLum || 0.4; }
            prepareDefines(defines) { defines.LORYPAINT = !!this.texture; }
            isReadyForSubMesh() { return !this.texture || this.texture.isReady(); }
            hasTexture(texture) { return !!this.texture && texture === this.texture; }
            getActiveTextures(list) { if (this.texture) list.push(this.texture); }
            getSamplers(samplers) { samplers.push('loryPaintSampler'); }
            getUniforms() {
                return {
                    ubo: [{ name: 'loryPaintInfo', size: 4, type: 'vec4' }, { name: 'loryPaintBase', size: 4, type: 'vec4' }],
                    fragment: '#ifdef LORYPAINT\nuniform vec4 loryPaintInfo;\nuniform vec4 loryPaintBase;\n#endif'
                };
            }
            bindForSubMesh(ubo) {
                if (!this.texture) return;
                const i = this.info, b = this.base;
                ubo.updateFloat4('loryPaintInfo', i[0], i[1], i[2], i[3]);
                ubo.updateFloat4('loryPaintBase', b[0], b[1], b[2], 0);
                ubo.setTexture('loryPaintSampler', this.texture);
            }
            getCustomCode(shaderType) {
                return shaderType === 'fragment' ? LoryPaintPlugin.CODE : null;
            }
        }
        // Краска premultiplied: base·(1−a) + краска·(светлота тайла / его средняя). Мировая
        // позиция фрагмента даёт UV карты красок (CLAMP: за краем — цвет кромки).
        LoryPaintPlugin.CODE = {
            CUSTOM_FRAGMENT_DEFINITIONS: '#ifdef LORYPAINT\nuniform sampler2D loryPaintSampler;\n#endif',
            CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `
#ifdef LORYPAINT
{
    vec4 loryP = texture2D(loryPaintSampler, vPositionW.xz * loryPaintInfo.xy);
#ifndef DIFFUSE
    baseColor.rgb = loryPaintBase.rgb;
#endif
    float loryL = dot(baseColor.rgb, vec3(0.299, 0.587, 0.114));
    float loryK = clamp(loryL / max(loryPaintInfo.z, 0.05), 0.6, 1.4);
    // Светлая краска (снег, песок) темнеет от пятен тайла грязно — рисунка у неё меньше.
    float loryPL = dot(loryP.rgb, vec3(0.299, 0.587, 0.114)) / max(loryP.a, 0.02);
    float loryW = loryPaintInfo.w * mix(1.0, 0.4, smoothstep(0.5, 0.85, loryPL));
    baseColor.rgb = baseColor.rgb * (1.0 - loryP.a) + loryP.rgb * mix(1.0, loryK, loryW);
}
#endif
`
        };
        Terrain3D._PaintPlugin = LoryPaintPlugin;
        return LoryPaintPlugin;
    }

    // --- Вода -----------------------------------------------------------------------------

    // Маркеры water -> [{ x, y, R, h, level }]: уровень = высота поля в центре + h.
    // level ставит _buildWaters (fieldHeight не зависит от клетки сетки).
    static waterZones(markers) {
        const out = [];
        for (const d of markers || []) {
            const k = Terrain3D.zoneKind(d.name);
            if (k && k.kind === 'water') {
                const s = Terrain3D.shapeOf(d);
                s.rect = false;
                s.R = s.a;
                s.reach = s.a;
                out.push(s);
            }
        }
        return out;
    }

    // Уровень воды в точке или null: точка в круге воды и поле высот под ней ниже уровня
    // (остров или берег — не вода). Несколько озёр — самый высокий уровень. Считается по
    // fieldHeight, а не по сетке: на телефоне и на ПК ответ один.
    waterAt(x, y) {
        let best = null;
        for (const w of this.waterDefs) {
            const dx = x - w.x, dy = y - w.y;
            if (dx * dx + dy * dy > w.R * w.R) continue;
            if (this.fieldHeight(x, y) < w.level && (best === null || w.level > best)) best = w.level;
        }
        return best;
    }

    _buildWaters() {
        this._disposeWaters();
        for (const w of this.waterDefs) w.level = this.fieldHeight(w.x, w.y) + w.h;
        if (typeof BABYLON === 'undefined' || !this.waterDefs.length) return;
        for (const w of this.waterDefs) {
            try { this.waters.push(new Water3D(this, w)); } catch (e) { console.warn('Terrain3D: вода не собралась — ' + ((e && e.message) || e)); }
        }
    }

    _disposeWaters() {
        for (const w of this.waters) w.dispose();
        this.waters = [];
    }

    // Только вода (маркеры water правили, рельеф тот же).
    setWaters(markers) {
        this.waterDefs = Terrain3D.waterZones(markers);
        this._buildWaters();
    }

    // Время воды — раз в кадр вне паузы (Location3D.update).
    update(dt) {
        if (!this.waters.length) return;
        const k = Math.max(0, Terrain3D.cfg().waveSpeed) * Math.max(0, dt || 0);
        for (const w of this.waters) w.time += k;
    }

    dispose() {
        this._disposeWaters();
        this._disposePaint();
        for (const m of this.meshes) { try { m.dispose(false, false); } catch (e) { /* ok */ } }
        this.meshes = [];
        this.mesh = null;
        this.outer = null;
        for (const mat of [this.material, this.outerMaterial]) {
            if (mat) { try { mat.dispose(false, false); } catch (e) { /* ok */ } }
        }
        if (this.texture) { try { this.texture.dispose(); } catch (e) { /* ok */ } this.texture = null; }
    }

    // Класс плагина воды (создаётся при первом использовании, как у покраски).
    static waterPlugin() {
        if (Terrain3D._WaterPlugin) return Terrain3D._WaterPlugin;
        if (typeof BABYLON === 'undefined' || !BABYLON.MaterialPluginBase) return null;
        class LoryWaterPlugin extends BABYLON.MaterialPluginBase {
            /** @param {BABYLON.Material} material @param {Water3D} water */
            constructor(material, water) {
                super(material, 'LoryWater', 530, { LORYWATER: false }, true, true);
                this.water = water;
            }
            getClassName() { return 'LoryWaterPlugin'; }
            prepareDefines(defines) { defines.LORYWATER = true; }
            isReadyForSubMesh() { return this.water.texture.isReady(); }
            hasTexture(texture) { return texture === this.water.texture; }
            getActiveTextures(list) { list.push(this.water.texture); }
            getSamplers(samplers) { samplers.push('loryWaterSampler'); }
            getUniforms() {
                return {
                    ubo: [
                        { name: 'loryWaterInfo', size: 4, type: 'vec4' }, { name: 'loryWaterA', size: 4, type: 'vec4' },
                        { name: 'loryWaterShallow', size: 4, type: 'vec4' }, { name: 'loryWaterDeep', size: 4, type: 'vec4' }
                    ],
                    fragment: '#ifdef LORYWATER\nuniform vec4 loryWaterInfo;\nuniform vec4 loryWaterA;\nuniform vec4 loryWaterShallow;\nuniform vec4 loryWaterDeep;\n#endif'
                };
            }
            bindForSubMesh(ubo) {
                const w = this.water, c = w.style;
                ubo.updateFloat4('loryWaterInfo', w.x, w.y, w.R, w.time);
                ubo.updateFloat4('loryWaterA', c.depth, c.foam, c.alphaShallow, c.alphaDeep);
                ubo.updateFloat4('loryWaterShallow', c.shallow[0], c.shallow[1], c.shallow[2], 0);
                ubo.updateFloat4('loryWaterDeep', c.deep[0], c.deep[1], c.deep[2], 0);
                ubo.setTexture('loryWaterSampler', w.texture);
            }
            getCustomCode(shaderType) {
                return shaderType === 'fragment' ? LoryWaterPlugin.CODE : null;
            }
        }
        // Карта глубины: R = 0.5 + 0.5·глубина/D (со знаком: суша < 0.5, D — WATER_DEPTH_FULL),
        // UV — от центра круга. Рисунок: две дрейфующие сетки бликов (искажённые синусы),
        // пена у берега с «дыханием», мягкий край круга.
        LoryWaterPlugin.CODE = {
            CUSTOM_FRAGMENT_DEFINITIONS: '#ifdef LORYWATER\nuniform sampler2D loryWaterSampler;\n#endif',
            CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `
#ifdef LORYWATER
{
    vec2 loryQ = vPositionW.xz - loryWaterInfo.xy;
    float loryRim = length(loryQ) / loryWaterInfo.z;
    float loryS = (texture2D(loryWaterSampler, loryQ / (2.0 * loryWaterInfo.z) + 0.5).r - 0.5) * 2.0 * loryWaterA.x;
    float loryDepth = max(loryS, 0.0);
    float loryDt = smoothstep(0.0, 1.0, loryDepth / loryWaterA.x);
    float loryT = loryWaterInfo.w;
    vec2 loryP = vPositionW.xz * 0.0055;
    float loryA = sin(loryP.x * 2.4 + loryT * 0.55 + sin(loryP.y * 1.7 - loryT * 0.4) * 1.3);
    float loryB = sin(loryP.y * 2.8 - loryT * 0.5 + sin(loryP.x * 2.2 + loryT * 0.35) * 1.2);
    float loryC = sin((loryP.x - loryP.y) * 1.9 + loryT * 0.3 + loryA * 0.9);
    float loryLines = 1.0 - smoothstep(0.0, 0.2, abs(loryA * loryB + 0.35 * loryC));
    float loryLines2 = 1.0 - smoothstep(0.0, 0.14, abs(sin(loryP.x * 5.1 + loryT * 0.8 + loryB * 1.4) * sin(loryP.y * 4.7 - loryT * 0.7 + loryA * 1.2)));
    vec3 loryCol = mix(loryWaterShallow.rgb, loryWaterDeep.rgb, loryDt);
    loryCol += (loryLines * 0.2 + loryLines2 * 0.12) * (1.0 - 0.5 * loryDt);
    float loryFoamW = 26.0 * (0.65 + 0.35 * loryA);
    float loryFoam = (1.0 - smoothstep(0.0, loryFoamW, loryDepth)) * (0.7 + 0.3 * sin(loryT * 1.3 + loryC * 2.0)) * loryWaterA.y;
    loryCol = mix(loryCol, vec3(1.0), clamp(loryFoam, 0.0, 1.0));
    float loryAlpha = mix(loryWaterA.z, loryWaterA.w, loryDt);
    loryAlpha *= smoothstep(0.0, 18.0, loryDepth + 2.0);
    loryAlpha = max(loryAlpha, loryFoam * 0.9);
    loryAlpha *= 1.0 - smoothstep(0.86, 1.0, loryRim);
    baseColor = vec4(loryCol, 1.0);
    alpha *= loryAlpha;
}
#endif
`
        };
        Terrain3D._WaterPlugin = LoryWaterPlugin;
        return LoryWaterPlugin;
    }
}

// Ширина кольца земли за краем локации (px) и его клетка.
Terrain3D.OUTER_RING = 2400;
Terrain3D.RING_CELL = 64;

// Цвета покраски (маркеры paint-<тип>), 0xRRGGBB. lava — только цвет земли: лаву-плоскости
// с эмиссией делает игра. Игра может дописать свой тип до загрузки карты:
// Terrain3D.PAINT_COLORS.mud = 0x5a3b22 — и ставить маркеры paint-mud.
/** @type {Record<string, number>} */
Terrain3D.PAINT_COLORS = {
    dirt: 0x7a3a1c, path: 0x9a6a3a, sand: 0xe8cf8a, snow: 0xf2f6ff,
    rock: 0x8a8f96, dark: 0x3a2d2a, grass2: 0x2f9a35, lava: 0xff5a1a
};

// Кэш классов плагинов (Terrain3D.paintPlugin / waterPlugin).
Terrain3D._PaintPlugin = null;
Terrain3D._WaterPlugin = null;

// Одна плоскость воды: круг-меш на уровне воды, карта глубины и материал с плагином
// LoryWater. Принадлежит Terrain3D (waters): умирает и пересобирается с ним.
class Water3D {
    // terrain: Terrain3D; def: зона { x, y, R, level } из Terrain3D.waterZones.
    constructor(terrain, def) {
        const scene = terrain.scene;
        const c = Terrain3D.cfg();
        this.terrain = terrain;
        this.x = def.x;
        this.y = def.y;
        this.R = def.R;
        this.level = def.level;
        this.time = 0;
        const hex = (v) => { const n = (v >>> 0) & 0xffffff; return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
        this.style = {
            shallow: hex(c.waterShallow), deep: hex(c.waterDeep),
            alphaShallow: c.waterAlphaShallow, alphaDeep: c.waterAlphaDeep,
            depth: Math.max(8, c.waterDepth), foam: Math.max(0, Math.min(1, c.foam))
        };
        this.texture = this._depthTexture(scene);
        this.mesh = this._buildMesh(scene);
        const mat = new BABYLON.StandardMaterial('water', scene);
        mat.metadata = { toonGroup: 'ground' };
        mat.diffuseColor = new BABYLON.Color3(1, 1, 1);
        mat.specularColor = new BABYLON.Color3(0, 0, 0);
        mat.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
        mat.disableDepthWrite = true;
        World3D.applyMaterialConstants(mat);
        const Plugin = Terrain3D.waterPlugin();
        if (Plugin) this.plugin = new Plugin(mat, this);
        this.material = mat;
        this.mesh.material = mat;
    }

    // Глубина со знаком (уровень − земля) на сетке n×n по кругу воды -> RGBA, R — см. LoryWaterPlugin.
    // Земля — как её рисует меш (heightAt): линия берега совпадает с картинкой. Клетка карты глубины
    // не крупнее ~24 px мира: линия берега по сетке террейна (клетка 96) не «плывёт».
    _depthTexture(scene) {
        const n = Math.max(32, Math.min(256, Math.pow(2, Math.ceil(Math.log2(2 * this.R / 24)))));
        const D = this.style.depth, data = new Uint8Array(n * n * 4), t = this.terrain;
        for (let j = 0; j < n; j++) {
            for (let i = 0; i < n; i++) {
                const x = this.x + ((i + 0.5) / n - 0.5) * 2 * this.R, y = this.y + ((j + 0.5) / n - 0.5) * 2 * this.R;
                const s = this.level - t.heightAt(x, y);
                const o = (j * n + i) * 4;
                data[o] = Math.max(0, Math.min(255, Math.round((0.5 + 0.5 * s / D) * 255)));
                data[o + 3] = 255;
            }
        }
        const tex = BABYLON.RawTexture.CreateRGBATexture(data, n, n, scene, false, false, BABYLON.Texture.BILINEAR_SAMPLINGMODE);
        tex.wrapU = BABYLON.Texture.CLAMP_ADDRESSMODE;
        tex.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
        return tex;
    }

    // Диск из колец: центр + RINGS колец × SEGS сегментов. Нормаль +Y: обход проверяется
    // по ComputeNormals, как у земли.
    _buildMesh(scene) {
        const RINGS = 8, SEGS = 64, R = this.R;
        const pos = new Float32Array((1 + RINGS * SEGS) * 3);
        pos[0] = this.x; pos[1] = this.level; pos[2] = this.y;
        for (let r = 1; r <= RINGS; r++) {
            for (let s = 0; s < SEGS; s++) {
                const k = 1 + (r - 1) * SEGS + s, a = s / SEGS * Math.PI * 2, rr = R * r / RINGS;
                pos[k * 3] = this.x + Math.cos(a) * rr;
                pos[k * 3 + 1] = this.level;
                pos[k * 3 + 2] = this.y + Math.sin(a) * rr;
            }
        }
        const build = (flip) => {
            const idx = [];
            for (let s = 0; s < SEGS; s++) {
                const a = 1 + s, b = 1 + (s + 1) % SEGS;
                if (flip) idx.push(0, b, a); else idx.push(0, a, b);
                for (let r = 1; r < RINGS; r++) {
                    const i0 = 1 + (r - 1) * SEGS, i1 = 1 + r * SEGS;
                    const p = i0 + s, q = i0 + (s + 1) % SEGS, u = i1 + s, v = i1 + (s + 1) % SEGS;
                    if (flip) idx.push(p, q, v, p, v, u); else idx.push(p, v, q, p, u, v);
                }
            }
            return idx;
        };
        let idx = build(false);
        const normals = new Float32Array(pos.length);
        BABYLON.VertexData.ComputeNormals(pos, idx, normals);
        if (normals[1] < 0) {
            idx = build(true);
            BABYLON.VertexData.ComputeNormals(pos, idx, normals);
        }
        const mesh = new BABYLON.Mesh('water', scene);
        const vd = new BABYLON.VertexData();
        vd.positions = pos;
        vd.indices = idx;
        vd.normals = normals;
        vd.applyToMesh(mesh, false);
        mesh.isPickable = false;
        mesh.receiveShadows = true;
        mesh.freezeWorldMatrix();
        return mesh;
    }

    dispose() {
        for (const o of [this.mesh, this.material, this.texture]) {
            if (o) { try { o.dispose(false, false); } catch (e) { /* ok */ } }
        }
        this.mesh = this.material = this.texture = null;
    }
}
