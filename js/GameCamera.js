// GameCamera.js — камера погони за машиной (перенесена из Obby Car Master). В заезде камера сама плавно встаёт за
// машину по курсу скорости (в заносе смотрит туда, куда машина едет); игрок может осмотреться — перетаскиванием
// левой кнопкой мыши или пальцем по экрану (вне кнопок), через CAM_RETURN_SEC камера возвращается за машину.
// Камера не уходит сквозь трассу: луч от машины к камере (ObbyCourse.ray) укорачивает дистанцию. На скорости и с
// нитро обзор шире. Режимы: 'chase' — заезд, 'menu' и 'garage' — витрина (машина целиком в свободной части экрана,
// облёт пальцем), 'finish' — медленный облёт после финиша, 'fly' — пролёт над трассой перед стартом.

/** @satisfies {Record<string, any>} */
const Cam = {
    /** @type {any} */ view: null,
    /** @type {any} */ car: null,          // машина-цель (состояние GameCar)
    /** @type {'chase' | 'menu' | 'garage' | 'finish' | 'fly'} */ mode: 'menu',
    yaw: 0, pitch: 0.42, zoom: 1,
    /** @type {any} */ pos: null,
    /** @type {any} */ tgt: null,
    snapBlend: 0, ty: 0, fov: 60, shakeT: 0, shakeA: 0, snapNext: true, lookT: 99,
    /** @type {{ id: number, x: number, y: number } | null} */ drag: null,
    /** @type {(() => { x: number, y: number, w: number, h: number }) | null} */ freeArea: null,
    /** @type {any[]} */ flyPath: [],
    flyT: 0,
    /** @type {{ t: number, dur: number, x: number, y: number, z: number } | null} */ cine: null,

    init(app) {
        this.view = app.location.view;
        const cam = app.camera;
        if (cam) cam.update = (dt) => this.update(dt);   // свой ракурс вместо обзорной камеры движка
        this.pos = new BABYLON.Vector3(0, 0, 0);
        this.tgt = new BABYLON.Vector3(0, 0, 0);
        this._bind(/** @type {HTMLCanvasElement} */ (document.getElementById('world3d')));
    },

    // Перетаскивание мышью (левая кнопка): свои обработчики, захват указателя, сброс на любой потере.
    _bind(canvas) {
        if (!canvas) return;
        const end = () => {
            if (this.drag && canvas.hasPointerCapture && canvas.hasPointerCapture(this.drag.id)) { try { canvas.releasePointerCapture(this.drag.id); } catch (e) { /* уже */ } }
            this.drag = null;
        };
        canvas.addEventListener('pointerdown', (e) => {
            if (e.pointerType !== 'mouse' || e.button !== 0) return;      // пальцы — через Input (свайп-взгляд)
            if (typeof Input !== 'undefined' && Input.mouseTouch) return;  // Playables на ПК: мышь — как палец (взгляд ведёт Input)
            if (typeof Pause !== 'undefined' && Pause.active) return;
            this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
            try { canvas.setPointerCapture(e.pointerId); } catch (er) { /* без захвата тоже работает */ }
        });
        canvas.addEventListener('pointermove', (e) => {
            const d = this.drag;
            if (!d || e.pointerId !== d.id) return;
            if ((e.buttons & 1) === 0) { end(); return; }
            const dx = e.clientX - d.x, dy = e.clientY - d.y;
            d.x = e.clientX; d.y = e.clientY;
            const lim = 120;
            this.look(Math.max(-lim, Math.min(lim, dx)), Math.max(-lim, Math.min(lim, dy)), 'mouse');
        });
        for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(t, (e) => { if (this.drag && e.pointerId === this.drag.id) end(); });
        canvas.addEventListener('wheel', (e) => { if (this.mode !== 'chase' || !(typeof Pause !== 'undefined' && Pause.active)) this.wheel(e.deltaY); }, { passive: true });
        window.addEventListener('blur', end);
        window.addEventListener('lory-release-input', end);
        document.addEventListener('visibilitychange', () => { if (document.hidden) end(); });
    },

    setMode(mode) {
        if (mode === this.mode) return;
        const was = this.mode;
        this.mode = mode;
        if (mode === 'chase' && was !== 'finish') this.behind();
        if (mode === 'menu' || mode === 'garage') this.showcase();
        if (mode === 'finish') { this.lookT = 0; this.zoom = 1.1; }
    },

    /** Витрина: машина в три четверти спереди-справа, чуть сверху. */
    showcase() {
        const c = this.car;
        let yaw = (c ? c.yaw : 0) + 0.85 + Math.PI;
        // с той стороны подиума, где не упрёмся в здание
        if (c && typeof Track !== 'undefined' && Track.lods && Track.lods.length) {
            let best = yaw, free = -1;
            for (let k = 0; k < 16; k++) {
                const y = yaw + k / 16 * Math.PI * 2, f = Track.freeRange(c.c[0], c.c[1] + 80, c.c[2], -Math.cos(y), -Math.sin(y), 3400);
                if (f > free + (k ? 200 : 0)) { free = f; best = y; }
            }
            yaw = best;
        }
        this.yaw = yaw; this.pitch = 0.2; this.zoom = 1; this.snapNext = true;
    },

    /** Поставить камеру за машину (старт, возрождение). */
    behind() {
        const U = 'undefined', c = this.car;
        const h = typeof CAMERA_CHASE_HEIGHT !== U ? CAMERA_CHASE_HEIGHT : 260, d = typeof CAMERA_CHASE_DIST !== U ? CAMERA_CHASE_DIST : 760;
        this.yaw = c ? c.yaw : 0; this.pitch = Math.atan2(h, d); this.snapNext = true; this.lookT = 99; this.zoom = 1;
    },
    snap() { this.snapNext = true; },
    shake(amount, time) { this.shakeA = Math.max(this.shakeA, amount); this.shakeT = Math.max(this.shakeT, time || 0.3); },

    /**
     * Киношный кадр аварии: камера замирает сбоку от машины и смотрит на неё sec секунд реального времени.
     * side — с какой стороны от скорости (±1); свободная сторона выбирается сама.
     */
    crashShot(sec, side) {
        const b = this.car, view = this.view;
        if (!b || !view) return;
        const sp = Math.hypot(b.v[0], b.v[2]);
        let dx = Math.cos(b.yaw), dz = Math.sin(b.yaw);
        if (sp > 100) { dx = b.v[0] / sp; dz = b.v[2] / sp; }
        const dist = 430 + (b.spec ? b.spec.L * 0.55 : 240), up = 90 + Math.random() * 70;
        const W = typeof GameWorld !== 'undefined' && GameWorld.active ? GameWorld : null;
        for (const s of [side || 1, -(side || 1)]) {
            const ox = -dz * s * dist - dx * 180 + dx * sp * 0.05, oz = dx * s * dist - dz * 180 + dz * sp * 0.05;
            const x = b.c[0] + ox, z = b.c[2] + oz;
            const gy = W ? W.heightAt(x, z) : b.p[1];
            const y = Math.max(b.c[1] + up, gy + 60);
            const dy = y - b.c[1], len = Math.hypot(ox, dy, oz) || 1;
            const hit = ObbyCourse.ray(b.c[0], b.c[1], b.c[2], ox / len, dy / len, oz / len, len);
            if (hit) continue;
            this.cine = { t: 0, dur: sec, x, y, z };
            return;
        }
    },

    /** Пролёт над трассой перед стартом: точки [{x, y, z}] (мир Babylon), t секунд. */
    fly(points, t) { this.flyPath = points || []; this.flyT = 0; this.flyDur = t || 4; this.mode = 'fly'; this.snapNext = true; },

    /** Взгляд игрока: px перетаскивания. */
    look(dx, dy, src) {
        if (!dx && !dy) return;
        const k = src === 'mouse' ? 0.0055 : 0.006;
        this.lookT = 0;
        this.yaw += dx * k;
        this.pitch = Math.max(-0.12, Math.min(1.2, this.pitch + dy * k * 0.8));
    },

    wheel(delta) {
        if (!delta) return;
        this.zoom = Math.max(0.6, Math.min(1.8, this.zoom * Math.exp(delta * 0.0012)));
    },

    update(dt) {
        dt = Math.min(0.1, Math.max(0, dt || 0));
        const view = this.view, b = this.car;
        if (!view || !b) return;
        const cam = view.camera;
        const U = 'undefined';
        const dist0 = typeof CAMERA_CHASE_DIST !== U ? CAMERA_CHASE_DIST : 760;
        const fov0 = typeof CAMERA_CHASE_FOV !== U ? CAMERA_CHASE_FOV : 60;
        const snap = this.snapNext;
        this.snapNext = false;
        const k = (rate) => (snap ? 1 : 1 - Math.exp(-rate * dt));
        const cv = view.world && view.world.canvas;
        const garage = this.mode === 'garage', menu = this.mode === 'menu';

        if (this.mode === 'fly' && this.flyPath.length >= 2) {
            this.flyT += dt;
            const P = this.flyPath, u = Math.min(1, this.flyT / this.flyDur) * (P.length - 1);
            const i = Math.min(P.length - 2, Math.floor(u)), f = u - i, s = f * f * (3 - 2 * f);
            const a = P[i], c = P[i + 1];
            const x = a.x + (c.x - a.x) * s, y = a.y + (c.y - a.y) * s, z = a.z + (c.z - a.z) * s;
            const look = P[Math.min(P.length - 1, i + 1)];
            this.pos.set(x, y + 1400, z);
            this.tgt.set(look.x, look.y, look.z);
            cam.fov = 55 * Math.PI / 180;
            cam.position.copyFrom(this.pos);
            cam.setTarget(this.tgt);
            view.fitShadowFrustum(look.x, look.z, look.y, 2500);
            return;
        }
        this.lookT += dt;
        if (this.cine) {
            const C = this.cine;
            C.t += dt;
            if (C.t >= C.dur) { this.cine = null; this.snapBlend = 1; }
            else {
                cam.fov = 44 * Math.PI / 180;
                this.fov = 44;
                cam.position.set(C.x, C.y, C.z);
                const look = new BABYLON.Vector3(b.c[0], b.c[1], b.c[2]);
                this.tgt.copyFrom(look); this.pos.set(C.x, C.y, C.z);
                cam.setTarget(look);
                view.fitShadowFrustum(b.p[0], b.p[2], b.p[1], 1600);
                return;
            }
        }
        if (this.mode === 'chase' && !snap) {
            const back = typeof CAM_RETURN_SEC !== U ? CAM_RETURN_SEC : 1.4;
            const sp = Math.hypot(b.v[0], b.v[2]);
            if (this.lookT > back && sp > 120 && b.vf > -60) {
                const vy = Math.atan2(b.v[2], b.v[0]), w = Math.min(1, (sp - 120) / 900);
                let dyv = vy - b.yaw; dyv = Math.atan2(Math.sin(dyv), Math.cos(dyv));
                // в полёте с вращением — по скорости, а не по носу (сальто не крутит камеру)
                const want = b.grounded ? b.yaw + dyv * w * 0.6 : vy;
                let d = want - this.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
                const ramp = Math.min(1, (this.lookT - back) / 0.8);
                this.yaw += d * (1 - Math.exp(-(b.grounded ? 4.5 : 2.0) * ramp * dt));
                const h = typeof CAMERA_CHASE_HEIGHT !== U ? CAMERA_CHASE_HEIGHT : 260;
                const p0 = Math.atan2(h, dist0);
                this.pitch += (p0 - this.pitch) * (1 - Math.exp(-1.2 * ramp * dt));
            }
        } else if (this.mode === 'finish' && !snap) {
            this.yaw += dt * 0.35;
            this.pitch += (0.3 - this.pitch) * (1 - Math.exp(-1.5 * dt));
        }
        // цель — машина; по высоте сглажена (подвеска не трясёт кадр), падение догоняет быстро
        const lift = b.spec ? b.spec.H * 0.9 : 130;
        const ty = b.p[1] + (garage ? lift * 0.6 : lift);
        this.ty += (ty - this.ty) * (snap ? 1 : 1 - Math.exp(-(ty < this.ty - 250 ? 12 : 8) * dt));
        const big = b.spec ? Math.max(1, b.spec.L / 450) : 1;
        const W0 = (cv && cv.clientWidth) || 800, H0 = (cv && cv.clientHeight) || 600;
        const narrow = Math.max(1, Math.min(1.7, (H0 / W0) * 0.95));   // портрет: камера дальше, машина и дорога впереди целиком
        let dist = dist0 * this.zoom * (0.75 + 0.25 * big) * narrow;
        const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
        const rx = -sy, rz = cy;
        let goalTgt = new BABYLON.Vector3(b.p[0], this.ty, b.p[2]);
        if (menu || garage) {
            const W = (cv && cv.clientWidth) || 800, H = (cv && cv.clientHeight) || 600;
            let area = { x: 0, y: 0, w: W, h: H };
            if (this.freeArea) { const fa = this.freeArea(); if (fa && fa.w > 40 && fa.h > 40) area = fa; }
            const vf = (garage ? 46 : 52) * Math.PI / 180, th = Math.tan(vf / 2), aspect = W / H;
            const tall = (b.spec ? b.spec.H : 140) + 60, wide = (b.spec ? b.spec.L : 450) + 80;
            const dH = tall * H / (0.7 * area.h * 2 * th), dW = wide * W / (0.78 * area.w * 2 * th * aspect);
            dist = Math.max(300, dH, dW) * this.zoom;
            const halfH = dist * th, halfW = halfH * aspect;
            const fx = (area.x + area.w / 2) / W, fy = (area.y + area.h * 0.55) / H;
            const s = (fx - 0.5) * 2 * halfW, t = (0.5 - fy) * 2 * halfH;
            const c = { x: b.p[0], y: b.p[1] + tall * 0.42, z: b.p[2] };
            goalTgt = new BABYLON.Vector3(c.x - rx * s, c.y - t * cp, c.z - rz * s);
            this.ty = b.p[1] + lift;
        }
        const back = [-cy * cp, sp, -sy * cp];
        let reach = dist;
        const hit = !garage ? ObbyCourse.ray(goalTgt.x, goalTgt.y, goalTgt.z, back[0], back[1], back[2], dist) : null;
        if (hit) reach = Math.max(dist * 0.25, hit.t - 40);
        if ((menu || garage) && typeof Track !== 'undefined' && Track.lods && Track.lods.length) {
            const hl = Math.hypot(back[0], back[2]) || 1;
            reach = Math.max(280, Math.min(reach, Track.freeRange(goalTgt.x, goalTgt.y, goalTgt.z, back[0] / hl, back[2] / hl, reach) / hl - 60));
        }
        const goalPos = new BABYLON.Vector3(goalTgt.x + back[0] * reach, goalTgt.y + back[1] * reach, goalTgt.z + back[2] * reach);
        if (typeof GameWorld !== 'undefined' && GameWorld.active) {
            const floor = GameWorld.heightAt(goalPos.x, goalPos.z) + 45;       // камера не уходит под землю
            if (goalPos.y < floor) goalPos.y = floor;
        }
        const fast = Math.max(0, Math.min(1, (Math.abs(b.vf) - 1400) / 1600));
        const fov = garage ? 46 : menu ? 52 : fov0 + 12 * fast + (b.nitroOn || b.padBoost > 0 ? 7 : 0);
        if (this.snapBlend > 0) this.snapBlend = Math.max(0, this.snapBlend - dt * 1.6);
        const kp = k(this.mode === 'chase' ? (this.snapBlend > 0 ? 4 + (1 - this.snapBlend) * 26 : 30) : 8);
        this.pos.x += (goalPos.x - this.pos.x) * kp; this.pos.y += (goalPos.y - this.pos.y) * kp; this.pos.z += (goalPos.z - this.pos.z) * kp;
        this.tgt.x += (goalTgt.x - this.tgt.x) * kp; this.tgt.y += (goalTgt.y - this.tgt.y) * kp; this.tgt.z += (goalTgt.z - this.tgt.z) * kp;
        this.fov += (fov - this.fov) * k(4);
        let sx = 0, syy = 0, sz = 0;
        if (this.shakeT > 0) {
            this.shakeT -= dt;
            const a = this.shakeA * Math.min(1, this.shakeT / 0.15);
            sx = (Math.random() * 2 - 1) * a; syy = (Math.random() * 2 - 1) * a * 0.6; sz = (Math.random() * 2 - 1) * a;
            if (this.shakeT <= 0) this.shakeA = 0;
        }
        cam.fov = this.fov * Math.PI / 180;
        cam.position.set(this.pos.x + sx, this.pos.y + syy, this.pos.z + sz);
        cam.setTarget(new BABYLON.Vector3(this.tgt.x + sx, this.tgt.y + syy, this.tgt.z + sz));
        view.fitShadowFrustum(b.p[0], b.p[2], b.p[1], garage ? 900 : 1600);
    },
};
