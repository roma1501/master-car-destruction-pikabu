// Humanoid.js — блочное человекоподобное тело (R15-подобное): 15 суставов, прямая кинематика (FK), IK ног,
// растяжение по росту и ширине, блочные меши и привязка к ригу Rig.js. Скелет — СВОИ суставы, а не Rig.js:
// позу каждый кадр пишет Motion Matching (MotionMatch.js) или рэгдолл (Ragdoll.js); потом поза уходит в вид —
// на меши, которые строит сам Humanoid (Humanoid.build), на меши игры (любой объект с apply(world, body)) или на
// узлы рига по именам (Humanoid.bindRig). Логика (FK, IK, поза) — чистая математика без Babylon (инвариант 4);
// Babylon нужен только build и bindRig.
//
// ТЕЛО (body). Humanoid.body(sh, sw) — запись размеров: длины костей, размеры и смещения частей. sh — рост,
// sw — ширина (1 = базовое тело ростом 184 px при 1 м = 100 px). Растяжение «Высокого Нуба»: голова почти не
// растёт, кисти и стопы — слабо, туловище, руки и ноги — целиком (таблица Humanoid.STRETCH: доли роста и ширины на
// группу). Запись содержит и множители, на которые FK умножает позу из базы движений: hx, hy, hz (таз), leg
// (длина ноги: шаг, корневое движение, запас до земли), wide (ширина). Humanoid.BODY1 — тело без растяжения.
// База движений синтезируется один раз для BODY1, а любое растяжение масштабируется рантаймом.
//
// ПОЗА. { hips: [x, y, z] — таз в системе корня (корень — точка на земле между стопами, курс персонажа),
//         rot: Float64Array(15·4) — локальные повороты суставов относительно родителя }.
// Покой (все повороты единичные) — персонаж стоит прямо, руки вдоль тела, нос по +X, правая рука +Z.
// Оси сустава совпадают с осями модели: поворот вокруг Z (+) уводит висящую конечность ВПЕРЁД (торс, который
// смотрит вверх, — НАЗАД); вокруг X (+) висящая конечность уходит влево (−Z); вокруг Y (+) — поворот влево.
// Мир (World): { pos: Float64Array(15·3), rot: Float64Array(15·4) } — мировые положения и повороты суставов в px.
//
// ВИД.
//   Свои меши:  const model = Humanoid.build(view, { colors: { skin: [230, 190, 160] }, face: true });
//               model.apply(world, body)  // части по мировым суставам; регистрирует World3D.addObject (инвариант 5)
//   Меши игры:  любой объект с методом apply(world, body) (model у MotionController) или чтение mm.world самому.
//   Риг Rig.js: const link = Humanoid.bindRig(rig, { bones: { Waist: 'Torso' }, scale: 1 }); link.apply(world, link.body)
//               — суставы пишутся в узлы рига по ИМЕНАМ. Нужны кости R15 (по узлу на сустав, имена Humanoid.NAMES или
//               карта opts.bones); оси костей — как в рецепте Blender (скилл world3d): поза покоя без вращения,
//               X вперёд, Y вверх, Z вправо. Размеры тела берутся из покоя рига (bodyFromRig), растяжение — только
//               общим масштабом (opts.scale = масштаб rig.root). Rig.updateAll() этих узлов больше не пишет.
//
// ВЫСОТА И ЕДИНИЦЫ: px мира (1 м = 100 px), рост тела 184 px, стопы — подошва на y = 0 корня.

/** @satisfies {Record<string, any>} */
const Humanoid = {
    // Суставы: Hips, Waist, Neck, плечо/локоть/запястье левой и правой руки, бедро/колено/голеностоп ног.
    NAMES: ['Hips', 'Waist', 'Neck', 'ShoulderL', 'ElbowL', 'WristL', 'ShoulderR', 'ElbowR', 'WristR',
        'HipL', 'KneeL', 'AnkleL', 'HipR', 'KneeR', 'AnkleR'],
    PARENT: [-1, 0, 1, 1, 3, 4, 1, 6, 7, 0, 9, 10, 0, 12, 13],
    // Смещение сустава от родителя в покое базового тела (px, в осях родителя); у Hips — высота над корнем.
    OFFSET: [
        0, 74, 0,      // Hips (от корня; в позе — свой hips)
        0, 10, 0,      // Waist
        0, 56, 0,      // Neck
        0, 48, -52,    // ShoulderL
        0, -30, 0,     // ElbowL
        0, -28, 0,     // WristL
        0, 48, 52,     // ShoulderR
        0, -30, 0,     // ElbowR
        0, -28, 0,     // WristR
        0, -8, -17.5,  // HipL
        0, -27, 0,     // KneeL
        0, -29, 0,     // AnkleL
        0, -8, 17.5,   // HipR
        0, -27, 0,     // KneeR
        0, -29, 0,     // AnkleR
    ],
    J: { HIPS: 0, WAIST: 1, NECK: 2, SHL: 3, ELL: 4, WRL: 5, SHR: 6, ELR: 7, WRR: 8, HIPL: 9, KNL: 10, ANL: 11, HIPR: 12, KNR: 13, ANR: 14 },
    COUNT: 15,
    THIGH: 27, SHIN: 29,           // длины бедра и голени базового тела (px)
    HIP_HEIGHT: 66,                // высота тазобедренного сустава в покое (прямые ноги)
    // Стопа: от центра подошвы до голеностопа и до носка/пятки (px, в осях стопы).
    FOOT_ANKLE: [-4, 10, 0], FOOT_HALF: 19,
    HEIGHT: 184,

    // Части: имя, сустав, форма, размер [x, y, z], центр от сустава, ключ цвета (Humanoid.COLORS).
    PARTS: [
        ['LowerTorso', 0, 'box', [35, 14, 70], [0, 3, 0], 'top'],
        ['UpperTorso', 1, 'box', [35, 56, 70], [0, 28, 0], 'top'],
        ['Head', 2, 'head', [44, 44, 50], [0, 24, 0], 'skin'],
        ['UpperArmL', 3, 'box', [33, 38, 33], [0, -11, 0], 'skin'],
        ['LowerArmL', 4, 'box', [31, 28, 31], [0, -14, 0], 'skin'],
        ['HandL', 5, 'box', [29, 12, 29], [0, -6, 0], 'skin'],
        ['UpperArmR', 6, 'box', [33, 38, 33], [0, -11, 0], 'skin'],
        ['LowerArmR', 7, 'box', [31, 28, 31], [0, -14, 0], 'skin'],
        ['HandR', 8, 'box', [29, 12, 29], [0, -6, 0], 'skin'],
        ['UpperLegL', 9, 'box', [35, 31, 35], [0, -11.5, 0], 'bottom'],
        ['LowerLegL', 10, 'box', [33, 29, 33], [0, -14.5, 0], 'bottom'],
        ['FootL', 11, 'box', [38, 10, 33], [4, -5, 0], 'bottom'],
        ['UpperLegR', 12, 'box', [35, 31, 35], [0, -11.5, 0], 'bottom'],
        ['LowerLegR', 13, 'box', [33, 29, 33], [0, -14.5, 0], 'bottom'],
        ['FootR', 14, 'box', [38, 10, 33], [4, -5, 0], 'bottom'],
    ],
    // Нейтральная палитра (RGB 0..255); игра задаёт свою: build(view, { colors }) или model.setColor(ключ, цвет).
    COLORS: { skin: [226, 184, 150], top: [96, 112, 140], bottom: [64, 70, 88] },

    // Растяжение: доли роста и ширины, которые достаются группе частей: [рост, ширина]. 1 — тянется целиком.
    STRETCH: { torso: [1, 1], arm: [1, 0.8], leg: [1, 0.85], head: [0.12, 0.35], hand: [0.25, 0.6], foot: [0.3, 0.6] },

    // Карты «сустав -> имя узла рига» для bindRig. R15 — узлы названы как суставы. R6 (Roblox): шесть костей, узлов
    // для локтей, колен, запястий и стоп нет — их повороты теряются (для MM с IK ног нужен R15).
    BONES: {
        R15: { Hips: 'Hips', Waist: 'Waist', Neck: 'Neck', ShoulderL: 'ShoulderL', ElbowL: 'ElbowL', WristL: 'WristL',
            ShoulderR: 'ShoulderR', ElbowR: 'ElbowR', WristR: 'WristR', HipL: 'HipL', KneeL: 'KneeL', AnkleL: 'AnkleL',
            HipR: 'HipR', KneeR: 'KneeR', AnkleR: 'AnkleR' },
        R6: { Hips: 'Hips', Waist: 'Torso', Neck: 'Head', ShoulderL: 'Arm_L', ElbowL: '', WristL: '', ShoulderR: 'Arm_R', ElbowR: '', WristR: '',
            HipL: 'Leg_L', KneeL: '', AnkleL: '', HipR: 'Leg_R', KneeR: '', AnkleR: '' },
    },

    /** @type {any} */ BODY1: null,   // тело без растяжения (ставится после объекта)

    // Тело с ростом sh и шириной sw (растяжение): длины костей, размеры и смещения частей.
    body(sh, sw) {
        sh = sh || 1; sw = sw || 1;
        const S = this.STRETCH, k = (s, f) => 1 + (s - 1) * f;
        const tH = k(sh, S.torso[0]), tW = k(sw, S.torso[1]), aH = k(sh, S.arm[0]), aW = k(sw, S.arm[1]), lH = k(sh, S.leg[0]), lW = k(sw, S.leg[1]);
        const hdH = k(sh, S.head[0]), hdW = k(sw, S.head[1]), haH = k(sh, S.hand[0]), haW = k(sw, S.hand[1]), fH = k(sh, S.foot[0]), fW = k(sw, S.foot[1]);
        const sx = 35 * tW + 17 * aW;
        const off = new Float64Array([
            0, 56 * lH + 10 * fH + 8 * tH, 0,
            0, 10 * tH, 0,
            0, 56 * tH, 0,
            0, 48 * tH, -sx, 0, -30 * aH, 0, 0, -28 * aH, 0,
            0, 48 * tH, sx, 0, -30 * aH, 0, 0, -28 * aH, 0,
            0, -8 * tH, -17.5 * tW, 0, -27 * lH, 0, 0, -29 * lH, 0,
            0, -8 * tH, 17.5 * tW, 0, -27 * lH, 0, 0, -29 * lH, 0,
        ]);
        const ps = [[tW, tH, tW], [tW, tH, tW], [hdW, hdH, hdW], [aW, aH, aW], [aW, aH, aW], [haW, haH, haW], [aW, aH, aW], [aW, aH, aW], [haW, haH, haW],
            [lW, lH, lW], [lW, lH, lW], [fW, fH, fW], [lW, lH, lW], [lW, lH, lW], [fW, fH, fW]];
        const po = this.PARTS.map((p, i) => {
            const o = p[4], c = ps[i];
            return i === 2 ? [0, 22 * hdH + 2, 0] : [o[0] * c[0], o[1] * c[1], o[2] * c[2]];
        });
        return { sh, sw, off, partScale: ps, partOff: po, thigh: 27 * lH, shin: 29 * lH, footHalf: 19 * fW, footAnkle: [-4 * fW, 10 * fH, 0],
            hx: lH, hy: off[1] / 74, hz: tW, leg: lH, wide: tW, height: 184 * sh };
    },

    // Тело по смещениям суставов (Float64Array(45), как body().off): размеры из РИГА, а не из растяжения. Длины
    // ног и ширина таза дают множители шага (leg, wide, hx, hy, hz), как у растянутого тела. opts.foot — масштаб
    // стопы (по умолчанию — высота голеностопа над землёй / 10). Меши build к такому телу не подходят (там
    // partScale и partOff базового тела) — оно для ригов.
    bodyFromOffsets(off, opts) {
        const o = opts || {}, J = this.J;
        const len = (j) => Math.hypot(off[j * 3], off[j * 3 + 1], off[j * 3 + 2]);
        const thigh = len(J.KNL), shin = len(J.ANL);
        const leg = (thigh + shin) / (this.THIGH + this.SHIN);
        const wide = Math.abs(off[J.HIPR * 3 + 2]) / 17.5;
        const hy = off[1] / 74;
        const f = o.foot > 0 ? o.foot : o.ankleY > 0 ? o.ankleY / 10 : leg;
        const ps = this.PARTS.map(() => [1, 1, 1]);
        const po = this.PARTS.map((p) => p[4].slice());
        return { sh: hy, sw: wide, off, partScale: ps, partOff: po, thigh, shin, footHalf: 19 * f, footAnkle: [-4 * f, 10 * f, 0],
            hx: leg, hy, hz: wide, leg, wide, height: off[1] + off[4] + off[7] + 44 * hy };
    },

    newPose() {
        const rot = new Float64Array(this.COUNT * 4);
        for (let j = 0; j < this.COUNT; j++) rot[j * 4 + 3] = 1;
        return { hips: new Float64Array([0, 74, 0]), rot };
    },
    copyPose(o, a) { o.hips.set(a.hips); o.rot.set(a.rot); return o; },
    newWorld() { return { pos: new Float64Array(this.COUNT * 3), rot: new Float64Array(this.COUNT * 4) }; },

    // Прямая кинематика: поза + корень (позиция на земле, поворот) -> мировые суставы.
    fk(pose, rootPos, rootQ, w, body) {
        const B = body || this.BODY1, P = this.PARENT, O = B.off, wp = w.pos, wr = w.rot, lr = pose.rot;
        const q = this._fq, v = this._fv, pq = this._fpq;
        for (let j = 0; j < this.COUNT; j++) {
            const p = P[j];
            if (p < 0) {
                GM.qmul(q, rootQ, [lr[0], lr[1], lr[2], lr[3]]);
                const hv = this._fh; hv[0] = pose.hips[0] * B.hx; hv[1] = pose.hips[1] * B.hy; hv[2] = pose.hips[2] * B.hz;
                GM.qrot(v, rootQ, hv);
                wp[0] = rootPos[0] + v[0]; wp[1] = rootPos[1] + v[1]; wp[2] = rootPos[2] + v[2];
            } else {
                pq[0] = wr[p * 4]; pq[1] = wr[p * 4 + 1]; pq[2] = wr[p * 4 + 2]; pq[3] = wr[p * 4 + 3];
                const lq = this._flq; lq[0] = lr[j * 4]; lq[1] = lr[j * 4 + 1]; lq[2] = lr[j * 4 + 2]; lq[3] = lr[j * 4 + 3];
                GM.qmul(q, pq, lq);
                const off = this._fo; off[0] = O[j * 3]; off[1] = O[j * 3 + 1]; off[2] = O[j * 3 + 2];
                GM.qrot(v, pq, off);
                wp[j * 3] = wp[p * 3] + v[0]; wp[j * 3 + 1] = wp[p * 3 + 1] + v[1]; wp[j * 3 + 2] = wp[p * 3 + 2] + v[2];
            }
            GM.qnorm(q, q);
            wr[j * 4] = q[0]; wr[j * 4 + 1] = q[1]; wr[j * 4 + 2] = q[2]; wr[j * 4 + 3] = q[3];
        }
        return w;
    },
    _fh: [0, 0, 0], _fq: [0, 0, 0, 1], _fv: [0, 0, 0], _fpq: [0, 0, 0, 1], _flq: [0, 0, 0, 1], _fo: [0, 0, 0],

    getPos(w, j, o) { o[0] = w.pos[j * 3]; o[1] = w.pos[j * 3 + 1]; o[2] = w.pos[j * 3 + 2]; return o; },
    setPos(w, j, a) { w.pos[j * 3] = a[0]; w.pos[j * 3 + 1] = a[1]; w.pos[j * 3 + 2] = a[2]; },
    getRot(w, j, o) { o[0] = w.rot[j * 4]; o[1] = w.rot[j * 4 + 1]; o[2] = w.rot[j * 4 + 2]; o[3] = w.rot[j * 4 + 3]; return o; },
    setRot(w, j, q) { w.rot[j * 4] = q[0]; w.rot[j * 4 + 1] = q[1]; w.rot[j * 4 + 2] = q[2]; w.rot[j * 4 + 3] = q[3]; },
    getLocal(pose, j, o) { const r = pose.rot; o[0] = r[j * 4]; o[1] = r[j * 4 + 1]; o[2] = r[j * 4 + 2]; o[3] = r[j * 4 + 3]; return o; },
    setLocal(pose, j, q) { const r = pose.rot; r[j * 4] = q[0]; r[j * 4 + 1] = q[1]; r[j * 4 + 2] = q[2]; r[j * 4 + 3] = q[3]; },

    // Пересчитать потомков сустава j по их локальным поворотам (после правки мирового поворота/позиции j).
    fkChildren(pose, w, from, body) {
        const P = this.PARENT, O = (body || this.BODY1).off;
        const pq = this._fpq, lq = this._flq, q = this._fq, v = this._fv, off = this._fo;
        for (let j = from + 1; j < this.COUNT; j++) {
            let a = P[j], inside = false;
            while (a >= 0) { if (a === from) { inside = true; break; } a = P[a]; }
            if (!inside) continue;
            const p = P[j];
            this.getRot(w, p, pq); this.getLocal(pose, j, lq);
            GM.qmul(q, pq, lq); GM.qnorm(q, q); this.setRot(w, j, q);
            off[0] = O[j * 3]; off[1] = O[j * 3 + 1]; off[2] = O[j * 3 + 2];
            GM.qrot(v, pq, off);
            w.pos[j * 3] = w.pos[p * 3] + v[0]; w.pos[j * 3 + 1] = w.pos[p * 3 + 1] + v[1]; w.pos[j * 3 + 2] = w.pos[p * 3 + 2] + v[2];
        }
    },

    // Мировой поворот сустава -> локальный в позе (по мировому повороту родителя; корень — rootQ).
    storeLocal(pose, w, j, rootQ) {
        const p = this.PARENT[j], q = this._lq, pq = this._lpq;
        this.getRot(w, j, q);
        if (p < 0) GM.qinvmul(q, rootQ, q); else { this.getRot(w, p, pq); GM.qinvmul(q, pq, q); }
        GM.qabs(q, q);
        this.setLocal(pose, j, q);
    },
    _lq: [0, 0, 0, 1], _lpq: [0, 0, 0, 1],

    // Подошва стопы (центр, на земле) + курс стопы + тангаж (носок вниз > 0, поворот вокруг носка; < 0 — вокруг пятки)
    // -> мировой поворот стопы и положение голеностопа.
    footFrame(sole, heading, pitch, ground, outQ, outAnkle, body) {
        const B = body || this.BODY1;
        const qy = GM.qheading(this._ffq, heading), qp = GM.qz(this._ffp, -pitch);
        GM.qmul(outQ, qy, qp);
        if (ground) {   // наклон стопы по нормали земли
            const tilt = GM.qbetween(this._fft, [0, 1, 0], ground);
            GM.qmul(outQ, tilt, outQ);
        }
        const piv = this._ffv, tmp = this._ffw, H = B.footHalf;
        // опорная точка: носок или пятка (в осях стопы без тангажа), затем подошва поворачивается вокруг неё
        const s = pitch >= 0 ? H : -H;
        const base = ground ? GM.qmul(this._ffb, GM.qbetween(this._fft, [0, 1, 0], ground), qy) : qy;
        GM.qrot(piv, base, [s, 0, 0]); GM.add(piv, sole, piv);
        GM.qrot(tmp, outQ, [s, 0, 0]);
        const c = GM.sub(this._ffc, piv, tmp);   // центр подошвы после поворота
        GM.qrot(tmp, outQ, B.footAnkle);
        return GM.add(outAnkle, c, tmp);
    },
    _ffq: [0, 0, 0, 1], _ffp: [0, 0, 0, 1], _fft: [0, 0, 0, 1], _ffb: [0, 0, 0, 1], _ffv: [0, 0, 0], _ffw: [0, 0, 0], _ffc: [0, 0, 0],

    // IK ноги (два звена): бедро у сустава hip, голеностоп — в target, ось сгиба колена axis (мир, «вправо» ноги:
    // колено уходит вперёд от неё), стопа — мировой поворот footQ (null — оставить из FK). Пишет мир и локальные повороты.
    ikLeg(pose, w, side, target, axis, footQ, body) {
        const BD = body || this.BODY1;
        const J = this.J;
        const jh = side ? J.HIPR : J.HIPL, jk = jh + 1, ja = jh + 2;
        const H = this.getPos(w, jh, this._ih), A = this._ia;
        const l1 = BD.thigh, l2 = BD.shin;
        const d = GM.sub(this._id, target, H);
        let L = GM.len(d);
        const Lmax = l1 + l2 - 0.05, Lmin = Math.abs(l1 - l2) + 4;
        if (L < 1e-4) { GM.set(d, 0, -1, 0); L = 1e-4; } else GM.scale(d, d, 1 / L);
        L = GM.clamp(L, Lmin, Lmax);
        GM.adds(A, H, d, L);
        // направление колена: ось × нога (вперёд при оси «вправо» и ноге вниз)
        const b = GM.cross(this._ib, axis, d);
        if (GM.len(b) < 1e-4) GM.set(b, 1, 0, 0);
        GM.norm(b, b);
        const ca = GM.clamp((l1 * l1 + L * L - l2 * l2) / (2 * l1 * L), -1, 1), sa = Math.sqrt(1 - ca * ca);
        const K = this._ik;
        K[0] = H[0] + d[0] * l1 * ca + b[0] * l1 * sa; K[1] = H[1] + d[1] * l1 * ca + b[1] * l1 * sa; K[2] = H[2] + d[2] * l1 * ca + b[2] * l1 * sa;
        const up = this._iu, lo = this._il, dn = this._idn;
        GM.scale(dn, GM.sub(dn, K, H), 1 / l1);
        GM.qlimbZ(up, dn, axis);
        GM.scale(dn, GM.sub(dn, A, K), 1 / l2);
        GM.qlimbZ(lo, dn, axis);
        this.setRot(w, jh, up); this.setRot(w, jk, lo);
        this.setPos(w, jk, K); this.setPos(w, ja, A);
        if (footQ) this.setRot(w, ja, footQ);
        this.storeLocal(pose, w, jh, null); this.storeLocal(pose, w, jk, null); this.storeLocal(pose, w, ja, null);
    },
    // Ось сгиба колена: правая ось таза, к ней — правая ось стопы (колено над носком), но только пока стопа
    // сонаправлена с тазом: на развороте опорная стопа смотрит «по-старому», и смесь осей вырождалась бы.
    kneeAxis(o, footQ, hipsQ) {
        const a = GM.qrot(this._ka, footQ, [0, 0, 1]), b = GM.qrot(this._kb, hipsQ, [0, 0, 1]);
        const w = 0.65 * GM.smooth((a[0] * b[0] + a[2] * b[2] - 0.2) / 0.6);
        o[0] = a[0] * w + b[0] * (1 - w); o[1] = (a[1] * w + b[1] * (1 - w)) * 0.3; o[2] = a[2] * w + b[2] * (1 - w);
        return GM.norm(o, o);
    },
    _ka: [0, 0, 0], _kb: [0, 0, 0],
    _ih: [0, 0, 0], _ia: [0, 0, 0], _id: [0, 0, 0], _ib: [0, 0, 0], _ik: [0, 0, 0], _iu: [0, 0, 0, 1], _il: [0, 0, 0, 1], _idn: [0, 0, 0],

    // ---- меши ----------------------------------------------------------------------------------

    // Собрать тело в сцене: корень (единичный, в начале координат) + части-дети, мировые трансформы ставит
    // model.apply(). opts: { name?, kind?: 'actor' | 'prop', colors?: { skin, top, bottom }, face?: true | false |
    // (ctx, w, h) => void, emissive?: 0.16 }. Цвет — [r, g, b] 0..255, 0xRRGGBB или '#rrggbb'.
    build(view, opts) {
        const o = opts || {}, scene = view.scene;
        const root = new BABYLON.Mesh(o.name || 'humanoid', scene);
        const mats = {};
        const emissive = o.emissive != null ? o.emissive : 0.16;
        const palette = Object.assign({}, this.COLORS, o.colors || {});
        for (const key of Object.keys(palette)) {
            const m = new BABYLON.StandardMaterial('humanoid-' + key, scene);
            m.diffuseColor = this.color3(palette[key]);
            m.emissiveColor = m.diffuseColor.scale(emissive);   // мягкая подсветка: против солнца не сереет
            m.specularColor = new BABYLON.Color3(0.08, 0.08, 0.08);
            mats[key] = m;
        }
        const parts = [];
        let face = null;
        for (const [name, joint, kind, size, off, color] of this.PARTS) {
            let mesh;
            if (kind === 'head') {
                mesh = this.roundBox(scene, 'humanoid-' + name, size[0], size[1], size[2], 10, 3);
                if (o.face !== false) {
                    face = this.faceDecal(scene, 'humanoid-face', size[0] / 2 + 0.4, 18, -11, 9.25);   // 36×20 — холст 256×144
                    face.material = this.faceMaterial(scene, typeof o.face === 'function' ? o.face : null);
                    face.parent = mesh;
                    face.isPickable = false;
                }
            } else {
                mesh = this.roundBox(scene, 'humanoid-' + name, size[0], size[1], size[2], 3.2, 2);
            }
            mesh.material = mats[color] || mats.skin;
            mesh.parent = root;
            mesh.rotationQuaternion = new BABYLON.Quaternion();
            mesh.isPickable = false;
            parts.push({ mesh, joint, off, name });
        }
        World3D.addObject(view, root, o.kind === 'prop' ? 'prop' : 'actor');
        // у наклейки лица — без контура рёбер (иначе по её краю пошла бы рамка)
        if (face && face.edgesRenderer) face.disableEdgesRendering();
        return new HumanoidModel(view, root, parts, mats, face);
    },

    // [r, g, b] 0..255 | 0xRRGGBB | '#rrggbb' -> Color3.
    color3(c) {
        if (typeof c === 'string') return BABYLON.Color3.FromHexString(c);
        if (typeof c === 'number') return BABYLON.Color3.FromInts((c >> 16) & 255, (c >> 8) & 255, c & 255);
        return BABYLON.Color3.FromInts(c[0], c[1], c[2]);
    },

    // Лицо: прозрачный холст 256×144 (paint(ctx, w, h) рисует игра) на наклейке головы.
    faceMaterial(scene, paint) {
        const W = 256, H = 144;
        const tex = new BABYLON.DynamicTexture('humanoid-face-tex', { width: W, height: H }, scene, true);
        const ctx = /** @type {CanvasRenderingContext2D} */ (/** @type {any} */ (tex.getContext()));
        (paint || this.drawFace)(ctx, W, H);
        tex.hasAlpha = true;
        tex.update(true);
        const m = new BABYLON.StandardMaterial('humanoid-face', scene);
        m.diffuseTexture = tex;
        m.useAlphaFromDiffuseTexture = true;
        m.specularColor = new BABYLON.Color3(0, 0, 0);
        m.diffuseColor = new BABYLON.Color3(1, 1, 1);
        m.zOffset = -2;
        return m;
    },

    // Лицо по умолчанию: два глаза и улыбка (игра подменяет opts.face).
    drawFace(ctx, W, H) {
        ctx.clearRect(0, 0, W, H);
        const ink = '#2a2430';
        ctx.fillStyle = ink;
        for (const sx of [-1, 1]) { ctx.beginPath(); ctx.ellipse(W * (0.5 + sx * 0.17), H * 0.4, W * 0.04, H * 0.11, 0, 0, Math.PI * 2); ctx.fill(); }
        ctx.strokeStyle = ink; ctx.lineWidth = W * 0.026; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.arc(W * 0.5, H * 0.52, W * 0.15, Math.PI * 0.2, Math.PI * 0.8); ctx.stroke();
    },

    // Поставить части по мировым суставам (body — растяжение: смещения и масштаб частей).
    apply(model, w, body) {
        const B = body || this.BODY1, v = this._av, q = this._aq;
        for (let i = 0; i < model.parts.length; i++) {
            const p = model.parts[i], j = p.joint;
            this.getRot(w, j, q);
            GM.qrot(v, q, B.partOff[i]);
            p.mesh.position.set(w.pos[j * 3] + v[0], w.pos[j * 3 + 1] + v[1], w.pos[j * 3 + 2] + v[2]);
            p.mesh.rotationQuaternion.set(q[0], q[1], q[2], q[3]);
            const sc = B.partScale[i];
            p.mesh.scaling.set(sc[0], sc[1], sc[2]);
        }
    },
    _av: [0, 0, 0], _aq: [0, 0, 0, 1],

    // Привязать суставы к узлам рига Rig.js по именам -> HumanoidRig (apply(world, body), body, unbind()).
    // opts: { bones?: карта «сустав -> имя узла» поверх BONES.R15, scale?: масштаб (rig.root.scaling) }.
    bindRig(rig, opts) { return new HumanoidRig(rig, opts); },

    // ---- построитель мешей Babylon -------------------------------------------------------------

    _wind: 0,   // знак обхода лицевых граней Babylon (вычисляется один раз по эталонному кубу)

    // Обход граней Babylon в этой сцене: dot(cross(p1−p0, p2−p0), n) у его куба.
    winding(scene) {
        if (this._wind) return this._wind;
        const ref = BABYLON.MeshBuilder.CreateBox('humanoid-ref', { size: 1 }, scene);
        const p = ref.getVerticesData(BABYLON.VertexBuffer.PositionKind), n = ref.getVerticesData(BABYLON.VertexBuffer.NormalKind);
        const ix = ref.getIndices();
        const a = ix[0] * 3, b = ix[1] * 3, c = ix[2] * 3;
        const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]], e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
        const cr = GM.cross([0, 0, 0], e1, e2);
        this._wind = (cr[0] * n[a] + cr[1] * n[a + 1] + cr[2] * n[a + 2]) >= 0 ? 1 : -1;
        ref.dispose();
        return this._wind;
    },

    // Построитель: вершины + треугольники с правильным обходом (по нормали).
    builder(scene) {
        const w = this.winding(scene);
        const pos = [], nor = [], uv = [], idx = [];
        return {
            pos, nor, uv, idx,
            vert(x, y, z, nx, ny, nz, u, v) { pos.push(x, y, z); nor.push(nx, ny, nz); uv.push(u, v); return pos.length / 3 - 1; },
            tri(a, b, c) {
                const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
                const e1x = pos[b * 3] - ax, e1y = pos[b * 3 + 1] - ay, e1z = pos[b * 3 + 2] - az;
                const e2x = pos[c * 3] - ax, e2y = pos[c * 3 + 1] - ay, e2z = pos[c * 3 + 2] - az;
                const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
                const nx = nor[a * 3] + nor[b * 3] + nor[c * 3], ny = nor[a * 3 + 1] + nor[b * 3 + 1] + nor[c * 3 + 1], nz = nor[a * 3 + 2] + nor[b * 3 + 2] + nor[c * 3 + 2];
                const s = (cx * nx + cy * ny + cz * nz) >= 0 ? 1 : -1;
                if (s === w) idx.push(a, b, c); else idx.push(a, c, b);
            },
            quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); },
            mesh(name) {
                const m = new BABYLON.Mesh(name, scene);
                const vd = new BABYLON.VertexData();
                vd.positions = pos; vd.normals = nor; vd.uvs = uv; vd.indices = idx;
                vd.applyToMesh(m);
                return m;
            },
        };
    },

    // Скруглённая коробка (части тела): радиус r, m отсчётов на скругление.
    roundBox(scene, name, sx, sy, sz, r, m) {
        const B = this.builder(scene);
        const h = [sx / 2, sy / 2, sz / 2];
        r = Math.min(r, h[0] * 0.95, h[1] * 0.95, h[2] * 0.95);
        const inner = [h[0] - r, h[1] - r, h[2] - r];
        const samples = (k) => {    // координаты вдоль оси k: скругление, середина, скругление
            const out = [];
            for (let i = 0; i <= m; i++) out.push(-inner[k] - r * Math.cos(i * Math.PI / 2 / m));
            for (let i = 0; i <= m; i++) out.push(inner[k] + r * Math.sin(i * Math.PI / 2 / m));
            return out;
        };
        const S = [samples(0), samples(1), samples(2)];
        // грань: ось нормали a и знак, оси сетки b, c
        for (const [a, sgn, b, c] of [[0, 1, 2, 1], [0, -1, 2, 1], [1, 1, 0, 2], [1, -1, 0, 2], [2, 1, 0, 1], [2, -1, 0, 1]]) {
            const sb = S[b], sc = S[c], grid = [];
            for (let i = 0; i < sb.length; i++) {
                const row = [];
                for (let j = 0; j < sc.length; j++) {
                    const p = [0, 0, 0];
                    p[a] = sgn * h[a]; p[b] = sb[i]; p[c] = sc[j];
                    const cl = [GM.clamp(p[0], -inner[0], inner[0]), GM.clamp(p[1], -inner[1], inner[1]), GM.clamp(p[2], -inner[2], inner[2])];
                    const d = [p[0] - cl[0], p[1] - cl[1], p[2] - cl[2]];
                    GM.norm(d, d);
                    row.push(B.vert(cl[0] + d[0] * r, cl[1] + d[1] * r, cl[2] + d[2] * r, d[0], d[1], d[2], i / (sb.length - 1), j / (sc.length - 1)));
                }
                grid.push(row);
            }
            for (let i = 0; i < sb.length - 1; i++) for (let j = 0; j < sc.length - 1; j++) {
                B.quad(grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]);
            }
        }
        return B.mesh(name);
    },

    // Плоская наклейка лица на передней грани (+X): ширина ±hw по z, высота y0..y1; u слева направо для смотрящего в лицо.
    faceDecal(scene, name, x, hw, y0, y1) {
        const B = this.builder(scene);
        const a = B.vert(x, y0, hw, 1, 0, 0, 0, 0), b = B.vert(x, y0, -hw, 1, 0, 0, 1, 0);
        const c = B.vert(x, y1, -hw, 1, 0, 0, 1, 1), d = B.vert(x, y1, hw, 1, 0, 0, 0, 1);
        B.quad(a, b, c, d);
        return B.mesh(name);
    },
};
Humanoid.BODY1 = Humanoid.body(1, 1);

// Блочное тело в сцене (Humanoid.build): корень, части на суставах, материалы по ключам цвета.
class HumanoidModel {
    constructor(view, root, parts, mats, face) {
        this.view = view;
        /** @type {BABYLON.Mesh} */
        this.root = root;
        /** @type {{ mesh: BABYLON.Mesh, joint: number, off: number[], name: string }[]} */
        this.parts = parts;
        /** @type {Record<string, BABYLON.StandardMaterial>} */
        this.mats = mats;
        /** @type {BABYLON.Mesh | null} */
        this.face = face;
        this.disposed = false;
    }

    // Части по мировым суставам world (Humanoid.newWorld) для тела body.
    apply(world, body) { Humanoid.apply(this, world, body); }

    // Перекрасить группу (ключ skin | top | bottom | свой из opts.colors).
    setColor(key, color) {
        const m = this.mats[key];
        if (!m) return;
        m.diffuseColor = Humanoid.color3(color);
        m.emissiveColor = m.diffuseColor.scale(0.16);
    }

    // Часть по имени (Head, FootL, UpperTorso…): навесить предмет, спрятать.
    part(name) {
        const p = this.parts.find((q) => q.name === name);
        return p ? p.mesh : null;
    }

    setVisible(on) { this.root.setEnabled(!!on); }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        World3D.removeObject(this.view, this.root);
        for (const k of Object.keys(this.mats)) this.mats[k].dispose(false, false);
        if (this.face && this.face.material) this.face.material.dispose(false, true);
    }
}

// Привязка суставов Humanoid к узлам рига Rig.js (Humanoid.bindRig). rig.root остаётся в начале координат без
// поворота (масштаб — opts.scale): мировые положения и повороты суставов пишутся в узлы, поэтому один и тот же
// apply работает и для Motion Matching, и для рэгдолла. Положение пишется только верхним привязанным узлам (таз),
// у остальных остаётся поза покоя рига — пропорции берёт bodyFromRig. Rig.updateAll эти узлы больше не трогает
// (они вынуты из _active рига); узлы без привязки (предметы, плащ) анимируются клипами как обычно.
class HumanoidRig {
    constructor(rig, opts) {
        const o = opts || {}, H = Humanoid, prep = rig.prep, N = prep.N;
        this.rig = rig;
        this.scale = Number(o.scale) > 0 ? Number(o.scale) : 1;
        this.map = Object.assign({}, H.BONES.R15, o.bones || {});
        /** @type {Int16Array} узел рига -> сустав (−1) */
        this.joint = new Int16Array(N).fill(-1);
        /** @type {Int32Array} сустав -> узел рига (−1) */
        this.node = new Int32Array(H.COUNT).fill(-1);
        const missing = [];
        for (let j = 0; j < H.COUNT; j++) {
            const name = this.map[H.NAMES[j]];
            const i = name && prep.byName.has(name) ? prep.byName.get(name) : -1;
            if (i >= 0 && this.joint[i] < 0) { this.node[j] = i; this.joint[i] = j; } else missing.push(H.NAMES[j]);
        }
        this.ok = this.node[H.J.HIPS] >= 0;
        if (!this.ok) Rig.warnOnce('humanoid|' + rig.name, 'Humanoid.bindRig: у рига нет узла таза «' + this.map.Hips + '» — привязка не работает');
        else if (missing.length) Rig.warnOnce('humanoid-miss|' + rig.name, 'Humanoid.bindRig: у рига «' + rig.name + '» нет узлов ' + missing.join(', ') + ' — эти суставы не двигаются (для IK ног нужны бедро, колено, стопа)');
        // Покой: локальные и мировые повороты узлов, положение родителя.
        const ST = Rig.STRIDE, rest = prep.rest;
        this.restQ = new Float64Array(N * 4);
        this.restW = new Float64Array(N * 4);
        this.parent = new Int32Array(N);
        this.parentPos = new Float64Array(N * 3);
        this.top = new Uint8Array(N);
        for (const i of prep.order) {
            const p = prep.nodes[i].parent;
            this.parent[i] = p >= 0 && p < N ? p : -1;
            for (let k = 0; k < 4; k++) this.restQ[i * 4 + k] = rest[i * ST + 3 + k];
            if (this.parent[i] >= 0) {
                Rig.mul(this.restW, this.parent[i] * 4, this.restQ, i * 4, this.restW, i * 4);   // мир = мир родителя · локальный
                const m = prep.world[this.parent[i]].m;
                this.parentPos[i * 3] = m[12]; this.parentPos[i * 3 + 1] = m[13]; this.parentPos[i * 3 + 2] = m[14];
            } else {
                for (let k = 0; k < 4; k++) this.restW[i * 4 + k] = this.restQ[i * 4 + k];
            }
        }
        for (let i = 0; i < N; i++) {
            if (this.joint[i] < 0) continue;
            let top = 1;
            for (let a = this.parent[i], d = 0; a >= 0 && d < 64; a = this.parent[a], d++) if (this.joint[a] >= 0) { top = 0; break; }
            this.top[i] = top;
        }
        this.act = new Float64Array(N * 4);
        this._q = [0, 0, 0, 1]; this._qp = [0, 0, 0, 1]; this._p = [0, 0, 0]; this._v = [0, 0, 0];
        this.body = this.measure();
        // Rig.updateAll не пишет привязанные узлы; корень — в начало координат.
        this._active = rig._active;
        rig._active = Int32Array.from(Array.from(rig._active).filter((i) => this.joint[i] < 0));
        rig.root.position.set(0, 0, 0);
        rig.root.rotationQuaternion = null;
        rig.root.rotation.set(0, 0, 0);
        rig.root.scaling.set(this.scale, this.scale, this.scale);
    }

    // Размеры тела по покою рига: положение суставов в px × масштаб -> смещения -> Humanoid.bodyFromOffsets.
    measure() {
        const H = Humanoid, J = H.J, prep = this.rig.prep, s = this.scale;
        const wp = (j) => {
            const i = this.node[j];
            if (i < 0) return null;
            const m = prep.world[i].m;
            return [m[12] * s, m[13] * s, m[14] * s];
        };
        const pos = [];
        for (let j = 0; j < H.COUNT; j++) pos[j] = wp(j);
        const hips = pos[J.HIPS] || [0, 74 * s, 0];
        const f = hips[1] / 74;   // недостающие суставы — по базовому телу в масштабе таза
        const off = new Float64Array(H.COUNT * 3);
        for (let j = 0; j < H.COUNT; j++) {
            const p = H.PARENT[j];
            for (let a = 0; a < 3; a++) {
                if (p < 0) off[a] = hips[a];
                else off[j * 3 + a] = pos[j] && pos[p] ? pos[j][a] - pos[p][a] : H.OFFSET[j * 3 + a] * f;
            }
        }
        const ank = pos[J.ANL] || pos[J.ANR];
        return H.bodyFromOffsets(off, { ankleY: ank ? ank[1] : 0 });
    }

    // Суставы -> узлы. world — Humanoid.newWorld() (fk или Ragdoll.world); body нужен лишь для единообразия вызова.
    apply(world, body) {
        if (!this.ok) return;
        const rig = this.rig, wr = world.rot, wpos = world.pos, act = this.act;
        const q = this._q, qp = this._qp, p = this._p, v = this._v, s = 1 / this.scale;
        const order = rig.prep.order;
        for (let k = 0; k < order.length; k++) {
            const i = order[k], par = this.parent[i], j = this.joint[i];
            const ai = i * 4, ap = par * 4;
            if (j >= 0) Rig.mul(wr, j * 4, this.restW, ai, act, ai);              // мир узла = поворот сустава · покой
            else if (par >= 0) Rig.mul(act, ap, this.restQ, ai, act, ai);        // без привязки — в покое относительно родителя
            else for (let a = 0; a < 4; a++) act[ai + a] = this.restQ[ai + a];
            if (j < 0) continue;
            const tn = rig._tn[i];
            if (!tn) continue;
            // локальный поворот = мир родителя⁻¹ · мир узла
            if (par >= 0) {
                qp[0] = -act[ap]; qp[1] = -act[ap + 1]; qp[2] = -act[ap + 2]; qp[3] = act[ap + 3];
                Rig.mul(qp, 0, act, ai, q, 0);
            } else for (let a = 0; a < 4; a++) q[a] = act[ai + a];
            Rig.norm4(q, 0);
            tn.rotationQuaternion.set(q[0], q[1], q[2], q[3]);
            if (this.top[i]) {
                // таз: мировая точка (в единицах рига) относительно родителя, повёрнутая в его оси
                p[0] = wpos[j * 3] * s - this.parentPos[i * 3]; p[1] = wpos[j * 3 + 1] * s - this.parentPos[i * 3 + 1]; p[2] = wpos[j * 3 + 2] * s - this.parentPos[i * 3 + 2];
                if (par >= 0) GM.qrot(v, qp, p); else GM.copy(v, p);   // qp = мир родителя⁻¹ (считан выше)
                tn.position.set(v[0], v[1], v[2]);
            }
        }
        void body;
    }

    // Отвязать: Rig.updateAll снова пишет узлы (по клипам).
    unbind() {
        this.rig._active = this._active;
    }
}
