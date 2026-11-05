// CarLattice.js — собирает сетку узлов и балок (SoftBody) для любой машины гаража по её форме. Форма — CAR_HULLS (сечения
// кузова по длине, генерирует tools/car-hull.mjs из GLB), панели — метаданные модели CAR_MODELS[id].panels, мотор —
// CAR_MODELS[id].engine. Нет данных — обобщённая легковушка по габаритам (физика работает и без файлов).
//
// Каркас — шпангоуты поперёк машины: пол (лево, центр, право), пояс (лево, право), верх (лево, право) и хребет сверху;
// между шпангоутами — продольные и диагональные балки. Прочность зависит от места: нос и хвост мнутся (зоны смятия),
// салон держит, крыша слабее пола. Панели — свои лёгкие узлы и «ужесточитель» под ними, приклеены к каркасу петлями
// (прочно) и замками (слабо); колёса — ступицы на подвеске, которую можно загнуть и оторвать; мотор — тяжёлый блок.
// Единицы: px, кг, сила кг·px/с² (1 кН = 1e5). Устойчивость держит k/m (CARL_KM) при шаге SOFT_HZ.

const CARL_ZONE = { front: 0, rear: 1, left: 2, right: 3, roof: 4, engine: 5, wheels: 6, panels: 7 };

/** @satisfies {Record<string, any>} */
const CarLattice = {
    cfg() {
        const U = 'undefined';
        return {
            km: typeof CARL_KM !== U ? CARL_KM : 8e4,              // k/m балок (1/с²): запас устойчивости при 960 Гц
            zeta: typeof CARL_ZETA !== U ? CARL_ZETA : 0.09,       // демпфирование балок (доля критического)
            yield: typeof CARL_YIELD !== U ? CARL_YIELD : 1.0e6,   // текучесть балки каркаса в салоне, кг·px/с²
            step: typeof CARL_STATION_STEP !== U ? CARL_STATION_STEP : 52,  // px: шаг шпангоутов
            r: typeof CARL_NODE_R !== U ? CARL_NODE_R : 10,        // px: радиус контакта узла (узлы утоплены на него в обшивку)
            mass: typeof CARL_MASS !== U ? CARL_MASS : 1250,       // кг: масса машины 4.4×1.9 м
        };
    },

    /** Сечение кузова в точке x: { yb, yt, ym, wb, wm, wt }. */
    profile(spec, hull) {
        if (hull && hull.xs && hull.xs.length > 3) {
            const xs = hull.xs, st = hull.st, n = xs.length;
            return (x) => {
                let i = Math.floor((x - xs[0]) / (xs[1] - xs[0]));
                i = i < 0 ? 0 : i > n - 2 ? n - 2 : i;
                const t = Math.max(0, Math.min(1, (x - xs[i]) / (xs[i + 1] - xs[i])));
                const a = st[i], b = st[i + 1], L = (k) => a[k] + (b[k] - a[k]) * t;
                return { yb: L(0), yt: L(1), ym: L(2), wb: L(3), wm: L(4), wt: L(5) };
            };
        }
        // обобщённая машина: капот, салон, багажник
        const L = spec.L, W = spec.W, H = spec.H, R = spec.R;
        return (x) => {
            const a = Math.abs(x) / (L / 2), cab = x > -L * 0.32 && x < L * 0.15;
            const end = 1 - Math.pow(Math.max(0, a - 0.75) / 0.25, 2) * 0.25;
            return { yb: R * 0.6, yt: cab ? H : R + H * 0.3, ym: R + H * 0.28, wb: W * 0.44 * end, wm: W * 0.5 * end, wt: cab ? W * 0.38 : W * 0.42 * end };
        };
    },

    /**
     * Сетка машины. spec — carSpec (px), meta — CAR_MODELS[id] или {}, hull — CAR_HULLS[id] или null.
     * → def для SoftBody: nodes, beams, плюс hubs, engine, panels, stations.
     */
    build(spec, meta, hull) {
        const c = this.cfg(), L = spec.L, W = spec.W, r = c.r;
        const prof = this.profile(spec, hull);
        const sizeK = (L * W) / (440 * 190);
        const M = spec.mass || Math.max(700, Math.min(5200, c.mass * Math.pow(sizeK, 0.9) * Math.sqrt(spec.inertiaK || 1)));
        const S = M / c.mass;
        /** @type {any[]} */ const nodes = [];
        /** @type {any[]} */ const beams = [];
        const addNode = (x, y, z, m, rad, flags, opt) => { nodes.push(Object.assign({ x, y, z, m, r: rad, flags, core: false, part: 'frame' }, opt || {})); return nodes.length - 1; };
        const beamK = (ma, mb) => c.km * Math.min(ma, mb);
        const addBeam = (a, b, o) => {
            const ma = nodes[a].m, mb = nodes[b].m, k = o.k != null ? o.k : beamK(ma, mb) * (o.kK || 1);
            const mu = Math.min(ma, mb);
            beams.push({ a, b, k, c: o.c != null ? o.c : 2 * c.zeta * Math.sqrt(k * mu), yc: o.yc, yt: o.yt != null ? o.yt : o.yc * 1.3, brk: o.brk != null ? o.brk : 9, brc: o.brc || 0, zone: o.zone | 0 });
            return beams.length - 1;
        };

        // ---- шпангоуты
        const Lh = L / 2 - r * 0.9;
        const nSt = Math.max(6, Math.min(15, Math.round((2 * Lh) / c.step) + 1));
        const stations = [];
        const frameMass = M * 0.55;
        const stationsX = [];
        for (let i = 0; i < nSt; i++) stationsX.push(-Lh + (2 * Lh) * i / (nSt - 1));
        // оценка числа узлов для массы
        let weightSum = 0;
        const bottomK = 1.5;
        const plan = stationsX.map((x) => {
            const p = prof(x);
            const hasTop = p.yt - p.ym > 22;
            const w = (3 * bottomK) + 2 + (hasTop ? 2 : 0) + 1;
            weightSum += w;
            return { x, p, hasTop };
        });
        const unit = frameMass / Math.max(1, weightSum);
        const a = (x) => Math.abs(x) / (L / 2);
        const crumpleAt = (x) => {
            const t = Math.max(0, Math.min(1, (a(x) - 0.38) / 0.56));
            return 1 + (0.2 - 1) * t * t * (3 - 2 * t);     // 1 в салоне, 0.2 у торца
        };
        const cabinEdge = 0.42;
        for (const P of plan) {
            const { x, p, hasTop } = P;
            const inCabin = a(x) < cabinEdge;
            const Y = (v) => Math.max(r, v);
            const wb = Math.max(20, p.wb - r), wm = Math.max(24, p.wm - r), wt = Math.max(18, p.wt - r);
            const yb = Y(p.yb + r * 0.8), ym = Math.max(yb + 10, p.ym), yt = Math.max(ym + 6, p.yt - r);
            /** @type {Record<string, number>} */
            const s = {};
            const f = SOFT_HULL;
            s.bl = addNode(x, yb, -wb, unit * bottomK, r, f, { core: inCabin });
            s.bc = addNode(x, yb, 0, unit * bottomK, r, f, { core: inCabin });
            s.br = addNode(x, yb, wb, unit * bottomK, r, f, { core: inCabin });
            s.ml = addNode(x, ym, -wm, unit, r, f, { core: inCabin });
            s.mr = addNode(x, ym, wm, unit, r, f, { core: inCabin });
            if (hasTop) { s.tl = addNode(x, yt, -wt, unit, r, f); s.tr = addNode(x, yt, wt, unit, r, f); }
            s.tc = addNode(x, yt + (hasTop ? 0 : 0), 0, unit, r, f);
            stations.push({ x, s, hasTop });
        }
        const edgeZone = (x, z, top) => (top ? CARL_ZONE.roof : a(x) > 0.34 ? (x > 0 ? CARL_ZONE.front : CARL_ZONE.rear) : (z < 0 ? CARL_ZONE.left : CARL_ZONE.right));
        const ringEdges = [['bl', 'bc'], ['bc', 'br'], ['bl', 'ml'], ['br', 'mr'], ['ml', 'tl'], ['mr', 'tr'], ['tl', 'tc'], ['tc', 'tr'], ['ml', 'tc'], ['mr', 'tc']];
        const crossEdges = [['bl', 'br'], ['ml', 'mr'], ['tl', 'tr'], ['ml', 'bc'], ['mr', 'bc'], ['tc', 'bc'], ['tl', 'mr'], ['tr', 'ml']];
        const longNames = ['bl', 'bc', 'br', 'ml', 'mr', 'tl', 'tr', 'tc'];
        const isTop = (n) => n === 'tl' || n === 'tr' || n === 'tc';
        const Yf = c.yield * S;
        const strength = (x, u, v) => {
            let k = crumpleAt(x);
            const low = (u[0] === 'b' ? 1 : 0) + (v[0] === 'b' ? 1 : 0);
            if (low === 2) k *= 1.45;                 // пол и лонжероны
            else if (isTop(u) && isTop(v)) k *= 0.42;  // крыша
            else if (isTop(u) || isTop(v)) k *= 0.62; // стойки
            return k * Yf;
        };
        const brkOf = (x, u, v) => {
            if (u[0] === 'b' && v[0] === 'b') return 99;   // пол не рвётся: машина не разваливается пополам
            return 1.55 + (1 - crumpleAt(x)) * -0.15 + (a(x) < cabinEdge ? 0.3 : 0);
        };
        for (let i = 0; i < nSt; i++) {
            const st = stations[i], s = st.s, x = st.x;
            // шпангоут
            for (const [u, v] of ringEdges.concat(crossEdges)) {
                if (s[u] == null || s[v] == null) continue;
                addBeam(s[u], s[v], { yc: strength(x, u, v) * 0.9, brk: brkOf(x, u, v), zone: edgeZone(x, nodes[s[u]].z + nodes[s[v]].z, isTop(u) && isTop(v)) });
            }
            if (i + 1 >= nSt) continue;
            const nx = stations[i + 1], t = nx.s, xm = (x + nx.x) / 2;
            // продольные
            for (const u of longNames) {
                if (s[u] == null || t[u] == null) continue;
                addBeam(s[u], t[u], { yc: strength(xm, u, u), brk: brkOf(xm, u, u), zone: edgeZone(xm, nodes[s[u]].z, isTop(u)) });
            }
            // диагонали граней: держат форму на сдвиг
            for (const [u, v] of ringEdges) {
                if (s[u] != null && t[v] != null) addBeam(s[u], t[v], { yc: strength(xm, u, v), brk: brkOf(xm, u, v), zone: edgeZone(xm, nodes[s[u]].z + nodes[t[v]].z, isTop(u) && isTop(v)) });
                if (s[v] != null && t[u] != null) addBeam(s[v], t[u], { yc: strength(xm, u, v), brk: brkOf(xm, u, v), zone: edgeZone(xm, nodes[s[v]].z + nodes[t[u]].z, isTop(u) && isTop(v)) });
            }
            // длинные балки через шпангоут: жёсткость на изгиб
            if (i + 2 < nSt) {
                const w = stations[i + 2].s;
                for (const u of ['bl', 'br', 'ml', 'mr']) addBeam(s[u], w[u], { yc: strength(nx.x, u, u) * 1.1, brk: 99, zone: edgeZone(nx.x, nodes[s[u]].z, false), kK: 0.5 });
            }
        }
        const frameN = nodes.length;
        const frameIdx = []; for (let i = 0; i < frameN; i++) frameIdx.push(i);
        const nearest = (x, y, z, k, filter) => {
            const list = [];
            for (let i = 0; i < frameN; i++) {
                if (filter && !filter(nodes[i])) continue;
                const n = nodes[i], d = (n.x - x) ** 2 + (n.y - y) ** 2 + (n.z - z) ** 2;
                list.push([d, i]);
            }
            list.sort((p, q) => p[0] - q[0]);
            return list.slice(0, k).map(p => p[1]);
        };

        // ---- ступицы колёс: RL, RR, FL, FR
        const hubs = [];
        const hubMass = M * 0.024;
        const wheelBeams = [[], [], [], []];
        const wheelSpots = [[-spec.halfBase, -spec.halfTrack], [-spec.halfBase, spec.halfTrack], [spec.halfBase, -spec.halfTrack], [spec.halfBase, spec.halfTrack]];
        wheelSpots.forEach(([hx, hz], i) => {
            const n = addNode(hx, spec.R, hz, hubMass, Math.max(16, spec.R * 0.9), SOFT_WHEEL, { part: 'hub' + i });
            hubs.push(n);
            const side = hz < 0 ? -1 : 1;
            for (const k of nearest(hx, spec.R + 8, hz, 6, nd => nd.z * side > -8)) {
                wheelBeams[i].push(addBeam(n, k, { kK: 1, yc: Yf * 0.95, yt: Yf * 0.75, brk: 1.32, brc: 0.5, zone: CARL_ZONE.wheels }));
            }
        });

        // ---- мотор: два узла, тяжёлый блок на опорах
        const em = meta.engine;
        const ex = em && em.x != null ? em.x * 100 : L * 0.3;
        const eLen = em && em.len ? em.len * 100 : 60;
        const eH = em && em.z != null ? em.z * 100 : spec.R + spec.H * 0.15;
        const engine = [];
        const engMass = M * 0.075;
        for (const dx of [-eLen * 0.3, eLen * 0.3]) {
            const n = addNode(ex + dx, eH, 0, engMass, 18, SOFT_HULL, { part: 'engine' });
            engine.push(n);
            for (const k of nearest(ex + dx, eH, 0, 6)) addBeam(n, k, { yc: Yf * 0.75, yt: Yf * 0.6, brk: 99, zone: CARL_ZONE.engine });
        }
        addBeam(engine[0], engine[1], { yc: Yf * 6, brk: 99, zone: CARL_ZONE.engine });

        // ---- панели
        /** @type {Record<string, any>} */
        const panels = {};
        const Mp = M * 0.016;
        const metaPanels = meta.panels || {};
        for (const name of Object.keys(metaPanels)) {
            const pm = metaPanels[name], bb = pm.bbox;
            if (!Array.isArray(bb) || bb.length < 6) continue;
            const box = { x0: bb[0] * 100, x1: bb[1] * 100, z0: -bb[3] * 100, z1: -bb[2] * 100, y0: bb[4] * 100, y1: bb[5] * 100 };
            const kind = pm.kind || (name.includes('Door') ? 'door' : name.includes('Hood') ? 'hood' : name.includes('Trunk') ? 'trunk' : name.includes('Bumper') ? 'bumper' : name.includes('Mirror') ? 'mirror' : 'wing');
            panels[name] = this._panel(name, kind, pm.hinge, box, { addNode, addBeam, nodes, nearest, prof, Mp, Yf, r, c });
        }
        // ядро не пусто (короткая машина)
        if (!nodes.some(n => n.core)) for (let i = 0; i < frameN; i++) if (nodes[i].y < spec.R + 40) nodes[i].core = true;
        // поправка: центр масс в опорной точке
        return { nodes, beams, hubs, engine, panels, stations, frameIdx, wheelBeams, mass: M, zones: CARL_ZONE };
    },

    // Панель: узлы по поверхности, ужесточитель изнутри, крепление петлями и замками к ближайшему каркасу.
    _panel(name, kind, hinge, b, u) {
        const { addNode, addBeam, nodes, nearest, prof, Mp, Yf, r, c } = u;
        const list = [];
        const flags = SOFT_HULL, pr = Math.max(6, r * 0.7);
        const kK = 0.8;
        const midZ = (b.z0 + b.z1) / 2, midX = (b.x0 + b.x1) / 2, midY = (b.y0 + b.y1) / 2;
        let massK = 1, rigid = [midX, midY, midZ];
        /** @type {number[][]} */ const pts = [];
        /** @type {(p: number[]) => boolean} */
        let hingeTest = () => false;
        let hingeK = 0.62, latchK = 0.2, hingeBrk = 1.5, latchBrk = 1.28;
        if (kind === 'hood' || kind === 'trunk') {
            massK = kind === 'hood' ? 1 : 0.85;
            const dz = Math.min(b.z1 - midZ - 6, 90);
            const lenX = b.x1 - b.x0, lenY = b.y1 - b.y0;
            if (lenY > lenX * 1.1) {
                // вертикальная дверь багажника (хэтчбек, фургон): строки по высоте
                const x = midX, ys = [b.y0 + 6, midY, b.y1 - 6];
                for (const y of ys) for (const z of [midZ - dz, midZ, midZ + dz]) pts.push([x, y, z]);
                rigid = [x + (x > 0 ? -18 : 18), midY, midZ];
                const top = b.y1 - 6;
                hingeTest = (p) => Math.abs(p[1] - top) < 1;
            } else {
                const xs = [b.x0 + 6, midX, b.x1 - 6];
                for (const x of xs) for (const z of [midZ - dz, midZ, midZ + dz]) {
                    const p = prof(x);
                    pts.push([x, Math.min(b.y1, Math.max(b.y0, p.yt)) - pr * 0.6, z]);
                }
                rigid = [midX, Math.max(b.y0 - 14, midY - 22), midZ];
                const h = hinge || (kind === 'hood' ? 'rear' : 'front');
                const hx = h === 'rear' ? b.x0 : b.x1;
                hingeTest = (p) => Math.abs(p[0] - hx) < lenX * 0.2;
            }
        } else if (kind === 'door') {
            massK = 1.25;
            const side = midZ < 0 ? -1 : 1;
            const xs = [b.x0 + 5, midX, b.x1 - 5], ys = [b.y0 + 6, b.y1 - 6];
            for (const x of xs) for (const y of ys) {
                const p = prof(x);
                const z = side * Math.max(20, Math.min(Math.abs(side > 0 ? b.z1 : b.z0), p.wm) - pr * 0.8);
                pts.push([x, y, z]);
            }
            rigid = [midX, midY, midZ - side * 16];
            const hx = hinge === 'rear' ? b.x0 : b.x1;      // петли — у передней кромки двери
            hingeTest = (p) => Math.abs(p[0] - hx) < (b.x1 - b.x0) * 0.2;
            hingeK = 0.7; latchK = 0.26; latchBrk = 1.25;
        } else if (kind === 'bumper') {
            massK = 0.55;
            const nz = 5, front = midX > 0, xEdge = front ? b.x1 - pr : b.x0 + pr;
            for (let i = 0; i < nz; i++) {
                const z = b.z0 + 8 + (b.z1 - b.z0 - 16) * i / (nz - 1);
                const bow = Math.pow(Math.abs(z - midZ) / Math.max(1, (b.z1 - b.z0) / 2), 2) * (b.x1 - b.x0) * 0.5;
                for (const y of [b.y0 + 5, b.y1 - 5]) pts.push([xEdge + (front ? -bow : bow), y, z]);
            }
            rigid = [front ? b.x0 + 2 : b.x1 - 2, midY, midZ];
            hingeTest = () => false;
            latchK = 0.22; latchBrk = 1.32;
        } else if (kind === 'mirror') {
            massK = 0.1;
            pts.push([midX, midY, midZ]);
            rigid = null;
            hingeTest = () => false;
            latchK = 0.05; latchBrk = 1.2;
        } else {   // антикрыло, багажник
            massK = 0.35;
            for (const z of [b.z0 + 6, b.z1 - 6]) for (const x of [b.x0 + 4, b.x1 - 4]) pts.push([x, b.y1 - 3, z]);
            rigid = [midX, b.y0 + 2, midZ];
            latchK = 0.16; latchBrk = 1.25;
        }
        const mEach = Math.max(0.9, Mp * massK / (pts.length + (rigid ? 1 : 0)));
        for (const p of pts) list.push(addNode(p[0], p[1], p[2], mEach, pr, flags, { part: name }));
        let rig = -1;
        if (rigid) { rig = addNode(rigid[0], rigid[1], rigid[2], mEach, pr, 0, { part: name }); list.push(rig); }
        // лист: сетка узлов внутри панели
        const Ysheet = (kind === 'bumper' ? 1.6e5 : 1.15e5) * (Yf / c.yield);
        for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
            addBeam(list[i], list[j], { kK, yc: Ysheet, yt: Ysheet * 1.4, brk: 9, zone: CARL_ZONE.panels });
        }
        // крепление к каркасу
        const hingeBeams = [], latchBeams = [];
        pts.forEach((p, i) => {
            const n = list[i], isH = hingeTest(p);
            const cand = nearest(p[0], p[1], p[2], isH ? 3 : 2);
            for (const k of cand) {
                const b2 = addBeam(n, k, { kK, yc: Yf * (isH ? hingeK : latchK), yt: Yf * (isH ? hingeK : latchK), brk: isH ? hingeBrk : latchBrk, brc: isH ? 0.5 : 0.72, zone: CARL_ZONE.panels });
                (isH ? hingeBeams : latchBeams).push(b2);
            }
        });
        if (rig >= 0) {
            // ужесточитель панели держится за каркас мягко: чтобы форма листа не гуляла
            for (const k of nearest(rigid[0], rigid[1], rigid[2], 2)) latchBeams.push(addBeam(rig, k, { kK: 0.35, yc: Yf * latchK, yt: Yf * latchK, brk: latchBrk, brc: 0.72, zone: CARL_ZONE.panels }));
        }
        void nodes;
        return { name, kind, nodes: list, pts: pts.length, rigid: rig, hinge: hingeBeams, latch: latchBeams, state: 'on' };
    },
};
