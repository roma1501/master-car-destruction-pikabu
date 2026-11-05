// GameTurbines.js — ветряки-препятствия, как в Skill Test GTA: лопасти крутятся поперёк трассы и сбивают машину,
// башня — твёрдый столб (может стоять прямо на дороге). Объект карты с моделью props/turbine.glb и именем
// «turbine rpm=8 ph=0.25» (начало модели — ступица, нос гондолы — локальная +X, ротор — часть Rotor). Угол
// лопастей — чистая функция времени трассы ObbyCourse.time (боты предсказывают им будущее), вид — поворот части
// Rotor на тот же угол. Запросы — как у ObbyCourse.sphere: { col, n, depth, q } (col.hazard — лопасть, col.wall — башня).

const TURBINE_BLADE = 1950;       // px: длина лопасти при scale 1 (модель — 20 м)
const TURBINE_BLADE_R = 70;       // px: толщина лопасти (радиус капсулы) при scale 1
const TURBINE_TOWER_BACK = 420;   // px: ось башни позади ступицы при scale 1
const TURBINE_TOWER_R = 150;      // px: радиус башни у гондолы при scale 1
const TURBINE_TOWER_LEN = 12000;  // px: башня вниз от гондолы при scale 1

/** @satisfies {Record<string, any>} */
const Turbines = {
    /** @type {any[]} */ list: [],

    /** Ветряки из объектов карты (до или после Location3D — нужен только def). */
    build(map) {
        this.list = [];
        for (const def of (map && map.objects) || []) {
            if (def.kind === 'marker' || !/props\/turbine\.glb$/.test(String(def.model || ''))) continue;
            const prm = ObbyCourse.params(def.name);
            const s = Array.isArray(def.scale) ? Number(def.scale[0]) || 1 : 1;
            const yaw = (Array.isArray(def.rot) ? Number(def.rot[1]) || 0 : 0) * Math.PI / 180;
            const f = [Math.cos(yaw), 0, Math.sin(yaw)], r = [-Math.sin(yaw), 0, Math.cos(yaw)];
            const H = [Number(def.x) || 0, Number(def.h) || 0, Number(def.y) || 0];
            const t = { def, H, f, r, s, rpm: prm.rpm != null ? prm.rpm : 8, ph: prm.ph || 0, a0: Math.PI / 2,
                L: TURBINE_BLADE * s, br: TURBINE_BLADE_R * s, tower: [H[0] - f[0] * TURBINE_TOWER_BACK * s, H[1], H[2] - f[2] * TURBINE_TOWER_BACK * s], tr: TURBINE_TOWER_R * s,
                bottom: H[1] - TURBINE_TOWER_LEN * s, rec: null, rotor: null, q: null, axis: null };
            t.bb = [H[0] - t.L - 400, H[2] - t.L - 400, H[0] + t.L + 400, H[2] + t.L + 400];
            this.list.push(t);
        }
        return this.list;
    },

    /** Угол ротора в момент t (рад): по часовой, если смотреть с носа гондолы. */
    angle(T, t) { return -(T.rpm * Math.PI / 30) * t + T.ph * Math.PI * 2; },

    /** Лопасти в момент t: [{ a, b, r }] в мире. */
    bladesAt(T, t) {
        const out = [], A = this.angle(T, t);
        for (let k = 0; k < 3; k++) {
            const b = T.a0 + A + k * Math.PI * 2 / 3;
            // в плоскости ротора: вверх (cos) и вправо (sin)
            const d = [T.r[0] * Math.sin(b), Math.cos(b), T.r[2] * Math.sin(b)];
            const r0 = 120 * T.s;
            out.push({ a: [T.H[0] + d[0] * r0, T.H[1] + d[1] * r0, T.H[2] + d[2] * r0], b: [T.H[0] + d[0] * T.L, T.H[1] + d[1] * T.L, T.H[2] + d[2] * T.L], r: T.br, d });
        }
        return out;
    },

    /** Сфера против лопастей и башен рядом: fn(контакт) как у ObbyCourse.sphere. */
    sphere(x, y, z, rad, fn) {
        if (!this.list.length) return;
        const t = ObbyCourse.time;
        for (const T of this.list) {
            if (x < T.bb[0] || x > T.bb[2] || z < T.bb[1] || z > T.bb[3]) continue;
            // башня: вертикальная капсула
            if (y < T.H[1] + 200 && y > T.bottom) {
                const dx = x - T.tower[0], dz = z - T.tower[2], d = Math.hypot(dx, dz), R = T.tr + rad;
                if (d < R && d > 1e-3) fn({ col: { wall: true, turbine: T }, n: [dx / d, 0, dz / d], depth: R - d, q: [T.tower[0] + dx / d * T.tr, y, T.tower[2] + dz / d * T.tr] });
            }
            // лопасти
            if (Math.abs(y - T.H[1]) > T.L + rad) continue;
            for (const B of this.bladesAt(T, t)) {
                const abx = B.b[0] - B.a[0], aby = B.b[1] - B.a[1], abz = B.b[2] - B.a[2], L2 = abx * abx + aby * aby + abz * abz;
                let u = ((x - B.a[0]) * abx + (y - B.a[1]) * aby + (z - B.a[2]) * abz) / L2;
                u = Math.max(0, Math.min(1, u));
                const qx = B.a[0] + abx * u, qy = B.a[1] + aby * u, qz = B.a[2] + abz * u;
                const dx = x - qx, dy = y - qy, dz = z - qz, d = Math.hypot(dx, dy, dz), R = B.r + rad;
                if (d >= R) continue;
                const n = d > 1e-3 ? [dx / d, dy / d, dz / d] : [0, 1, 0];
                // скорость точки лопасти: ω × (q − ступица)
                const w = -(T.rpm * Math.PI / 30), ox = qx - T.H[0], oy = qy - T.H[1], oz = qz - T.H[2], f = T.f;
                const vel = [w * (f[1] * oz - f[2] * oy), w * (f[2] * ox - f[0] * oz), w * (f[0] * oy - f[1] * ox)];
                fn({ col: { hazard: true, turbine: T, vel }, n, depth: R - d, q: [qx + n[0] * B.r, qy + n[1] * B.r, qz + n[2] * B.r] });
            }
        }
    },

    /** Вид: ротор каждого ветряка — на угол логики (зовёт игра каждый кадр). */
    syncView(location) {
        const t = ObbyCourse.time;
        for (const T of this.list) {
            if (!T.rec) {
                T.rec = (location.objects || []).find(o => o.def === T.def || (o.def && o.def.x === T.def.x && o.def.y === T.def.y && o.def.h === T.def.h && o.def.model === T.def.model)) || null;
                if (!T.rec || !T.rec.mesh) { T.rec = null; continue; }
                const mesh = T.rec.mesh.getChildMeshes(true).find(m => m.metadata && m.metadata.part === 'Rotor');
                if (!mesh) continue;
                mesh.setPivotPoint(BABYLON.Vector3.FromArray(mesh.metadata.pivot || [0, 0, 0]));
                const ax = (mesh.metadata.axes && mesh.metadata.axes.x) || [1, 0, 0];
                T.rotor = mesh; T.axis = new BABYLON.Vector3(ax[0], ax[1], ax[2]); T.q = new BABYLON.Quaternion();
                // начальный угол лопасти модели: самая дальняя от ступицы вершина
                const pos = mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind), P = mesh.metadata.pivot || [0, 0, 0];
                let best = 0, by = 1, bz = 0;
                for (let i = 0; pos && i < pos.length; i += 3) { const yy = pos[i + 1] - P[1], zz = pos[i + 2] - P[2], dd = yy * yy + zz * zz; if (dd > best) { best = dd; by = yy; bz = zz; } }
                T.a0 = Math.atan2(bz, by);
            }
            if (!T.rotor) continue;
            BABYLON.Quaternion.RotationAxisToRef(T.axis, this.angle(T, t), T.q);
            T.rotor.rotationQuaternion = T.q;
        }
    },
};
