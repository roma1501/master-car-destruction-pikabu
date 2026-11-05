// Character.js — HumanoidCharacter: готовый физический персонаж «в одну строку». Склеивает модули:
//   Humanoid (тело, блочные меши или риг Rig.js) + CharacterPhysics (капсула, прыжок, ступени) +
//   MotionMatch (поза по базе движений, полёт, подъём) + Ragdoll (падение по удару).
// Игре остаётся: подать ввод, позвать update(dt) и решить, когда бить (knock). Ничего игрового тут нет: ни уровней,
// ни интерфейса, ни звуков — события отдаются подписчикам (on).
//
// ПРИМЕР (скилл world3d, «Персонаж: Motion Matching»):
//   await MotionDB.sharedAsync();                                          // база движений на загрузке (не подвешивает кадр)
//   const hero = HumanoidCharacter.create(app.location.view, { world: CharacterPhysics.navWorld(Nav), x: sp.x, y: sp.y, heading: 0 });
//   app.onUpdate((dt) => {
//       hero.control({ move: Input.move(), sprint: Input.down('sprint'), jump: Input.pressed('jump'), jumpHeld: Input.down('jump'), camYaw: app.camera.azimuth });
//       hero.update(dt);                                                   // капсула -> поза MM / полёт / подъём / рэгдолл -> меши
//       if (hitByTrap) hero.knock([vx, 520, vz], 'hit');                   // рэгдолл; сам поднимется через ~1.1 с
//   });
//   hero.on('step', (e) => Sound.play('step', ...)); hero.on('land', (e) => ...);
//
// КООРДИНАТЫ. place(x, y, …), x и y — карта (как маркеры и Nav); pos = [x, h, z] — мир (карта y = мир z), h — высота.
// Тело: height в px (184 — базовое; Humanoid.body растягивает), width — множитель ширины. Для рига Rig.js — opts.rig
// (bones, scale); растяжение ширины и роста для рига — только общим scale.

class HumanoidCharacter {
    // view — View3D (location.view). opts:
    //   world     CharacterWorld (CharacterPhysics.heightWorld / terrainWorld / navWorld / свой); по умолчанию ровная земля 0;
    //   x, y, heading, h   стартовая точка на карте и курс (h — высота; без неё — по опоре мира);
    //   height, width      px роста (184) и множитель ширины (1);
    //   colors, face, name, kind   блочные меши (Humanoid.build): палитра skin/top/bottom, лицо, имя, 'actor' | 'prop';
    //   rig, bones, scale  вместо мешей — риг Rig.js (Humanoid.bindRig);
    //   model              свой вид с apply(world, body); null — вида нет (логика без 3D);
    //   db, dbOptions      MotionDB или настройки общей базы (MotionDB.cfg); по умолчанию общая MotionDB.shared();
    //   motion, physics, ragdoll   поля MotionController.cfg() / CharacterPhysics.cfg() / Ragdoll.cfg();
    //   random             ГСЧ для закрутки рэгдолла (по умолчанию Math.random), on — { событие: fn }.
    constructor(view, opts) {
        const o = opts || {};
        this.view = view;
        this.world = o.world || CharacterPhysics.flatWorld(0);
        this.random = o.random || Math.random;
        this.c = HumanoidCharacter.cfg();
        /** @type {any} HumanoidRig | null */
        this.link = null;
        /** @type {any} вид: HumanoidModel | HumanoidRig | свой | null */
        this.model = null;
        this.ownModel = false;
        this.body = Humanoid.body((o.height || Humanoid.HEIGHT) / Humanoid.HEIGHT, o.width || 1);
        if (o.rig) {
            this.link = Humanoid.bindRig(o.rig, { bones: o.bones, scale: o.scale });
            this.model = this.link;
            this.body = this.link.body;
        } else if ('model' in o) {
            this.model = o.model || null;
        } else if (view) {
            this.model = Humanoid.build(view, { name: o.name, kind: o.kind, colors: o.colors, face: o.face });
            this.ownModel = true;
        }
        this.ch = new CharacterPhysics(this.world, { scale: this.body.height / Humanoid.HEIGHT, cfg: o.physics });
        this.mm = new MotionController(this.model, { db: o.db || (o.dbOptions ? MotionDB.shared(o.dbOptions) : undefined), body: this.body, cfg: o.motion });
        /** @type {Ragdoll | null} */
        this.rag = null;
        this.ragCfg = o.ragdoll || null;
        this.hold = false;                   // true — рэгдолл не поднимается сам (смерть, ожидание)
        this.locked = false;                 // true — ввод не доходит до капсулы (меню, ролик)
        this.in = { move: { x: 0, y: 0 }, mode: 'run', jump: false, jumpHeld: false, camYaw: 0, camPitch: 0 };
        /** @type {Record<string, ((e?: any) => void)[]>} */
        this.listeners = {};
        this._collider = Ragdoll.worldCollider(this.world, this.ch.k);
        this._tmp = { y: 0, n: [0, 1, 0], body: null, t: 0, moving: false };
        this._zero = { x: 0, y: 0 };
        if (o.on) for (const k of Object.keys(o.on)) this.on(k, o.on[k]);
        this.place(o.x || 0, o.y || 0, o.heading || 0, o.h);
    }

    static create(view, opts) { return new HumanoidCharacter(view, opts); }

    // База движений на загрузке без подвисания кадра, потом create. onProgress(0..1).
    static async spawn(view, opts, onProgress) {
        if (!(opts && opts.db)) await MotionDB.sharedAsync(opts && opts.dbOptions, onProgress);
        return new HumanoidCharacter(view, opts);
    }

    // Числа персонажа: константы RAGDOLL_* (Constants.js) с дефолтами.
    static cfg() {
        const U = 'undefined';
        return {
            getupDelay: typeof RAGDOLL_GETUP_DELAY !== U ? RAGDOLL_GETUP_DELAY : 1.1,
            getupMax: typeof RAGDOLL_GETUP_MAX !== U ? RAGDOLL_GETUP_MAX : 4.5,
            thudImpact: typeof RAGDOLL_THUD_IMPACT !== U ? RAGDOLL_THUD_IMPACT : 420,
            landSound: typeof CHAR_LAND_SOUND_SPEED !== U ? CHAR_LAND_SOUND_SPEED : 260,
        };
    }

    // ---- события -----------------------------------------------------------------------------
    // jump {}, land { impact }, step { side, x, y, z, speed }, ragdoll { reason, vel }, getup {}, thud { impact }.
    on(name, fn) { (this.listeners[name] || (this.listeners[name] = [])).push(fn); return this; }
    off(name, fn) { const l = this.listeners[name]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } return this; }
    emit(name, e) { const l = this.listeners[name]; if (l) for (const fn of l.slice()) fn(e); }

    // ---- положение -----------------------------------------------------------------------------
    get x() { return this.ch.pos[0]; }
    get y() { return this.ch.pos[2]; }
    get h() { return this.ch.pos[1]; }
    get pos() { return this.ch.pos; }
    get heading() { return this.mm.char.yaw; }
    get ragdolled() { return !!this.rag; }
    // 'mm' | 'air' | 'getup' | 'ragdoll'
    get mode() { return this.rag ? 'ragdoll' : this.mm.mode; }

    // Высота опоры мира в точке (карта x, y) — не выше yTop (по умолчанию: самая верхняя).
    groundAt(x, y, yTop) {
        const hit = this.world.ground(x, y, yTop != null ? yTop : 1e5, 2e5, this._tmp);
        return hit ? hit.y : 0;
    }

    // Точка, на которую смотрит камера: корень анимации, в рэгдолле — таз.
    focus(out) {
        const o = out || [0, 0, 0];
        if (this.rag) { const p = this.rag.pelvis(); GM.set(o, p[0], p[1] - 66 * this.ch.k, p[2]); }
        else GM.copy(o, this.mm.char.pos);
        return o;
    }

    // Телепорт (старт, респаун): карта x, y, курс; h — высота (без неё — по опоре мира). Рэгдолл сбрасывается.
    place(x, y, heading, h) {
        const gy = h != null ? h : this.groundAt(x, y);
        this.rag = null;
        this.ch.place(x, gy, y, heading);
        this.mm.reset(this.ch.pos, heading);
        this.mm.update(1 / 60, this.ch);   // поза и вид сразу на месте
    }

    // Рост и ширина на лету (растяжение): пересоздаёт тело только при заметной разнице. Для рига не работает.
    setBody(heightPx, width) {
        if (this.link) return;
        const sh = heightPx / Humanoid.HEIGHT, sw = width || 1;
        if (Math.abs(sh - this.body.sh) < 0.002 && Math.abs(sw - this.body.sw) < 0.002) return;
        this.body = Humanoid.body(sh, sw);
        this.mm.body = this.body;
        this.ch.setScale(this.body.height / Humanoid.HEIGHT);
        this._collider = Ragdoll.worldCollider(this.world, this.ch.k);
    }

    // ---- ввод ----------------------------------------------------------------------------------
    // input: { move: {x вправо, y вперёд} (Input.move()), sprint, walk, jump (нажат в этот кадр), jumpHeld, camYaw (camera.azimuth), camPitch }.
    control(input) {
        const i = input || {}, m = i.move || this._zero, c = this.in;
        c.move.x = m.x || 0; c.move.y = m.y || 0;
        c.mode = i.sprint ? 'sprint' : i.walk ? 'walk' : 'run';
        if (i.jump) c.jump = true;
        c.jumpHeld = !!i.jumpHeld;
        if (i.camYaw != null) c.camYaw = i.camYaw;
        if (i.camPitch != null) c.camPitch = i.camPitch;
    }

    // ---- рэгдолл -------------------------------------------------------------------------------
    // Падение: vel — куда летит тело (px/с), reason — 'hit' | 'fall' | 'manual' | своё (идёт в событие). Уже в рэгдолле — false.
    knock(vel, reason) {
        if (this.rag) return false;
        const ch = this.ch, v = vel || ch.vel, r = this.random;
        const spin = [(r() - 0.5) * 3, (r() - 0.5) * 2, (r() - 0.5) * 3];
        if (reason === 'manual') { spin[0] = 0; spin[2] = 0; }
        this.rag = new Ragdoll(this.mm.world, v, spin, this.body, { collide: this._collider, gravity: ch.gravity, cfg: this.ragCfg });
        ch.ragdoll = this.rag;
        ch.enabled = false;
        this.in.jump = false;
        if (this.model) this.model.apply(this.rag.world, this.body);
        this.emit('ragdoll', { reason: reason || 'hit', vel: v });
        return true;
    }

    // Удар извне с порогом: speed ниже CHAR_RAGDOLL_HIT_SPEED — не падает. true — упал.
    hit(vel, speed, reason) {
        if (speed < this.ch.c.hitRagdoll) return false;
        return this.knock(vel, reason || 'hit');
    }

    // Подняться из рэгдолла: капсула встаёт под таз, MM играет подъём.
    getUp() {
        const rag = this.rag;
        if (!rag) return;
        const ch = this.ch, info = rag.getupInfo(), p = rag.pelvis();
        const hit = this.world.ground(p[0], p[2], p[1] + 30 * ch.k, 500 * ch.k, this._tmp);
        const gy = hit ? hit.y : this.groundAt(p[0], p[2]);
        ch.place(p[0], gy, p[2], info.yaw);
        this.mm.enterGetup(ch, rag.world, info.faceDown, info.yaw);
        this.rag = null;
        ch.ragdoll = null;
        this.emit('getup', {});
    }

    // ---- кадр ----------------------------------------------------------------------------------
    update(dt) {
        const ch = this.ch, mm = this.mm, inp = this.in;
        const locked = this.locked || !!this.rag || mm.mode === 'getup';
        ch.setInput(locked ? this._zero : inp.move, inp.mode, !locked && inp.jump, !locked && inp.jumpHeld, inp.camYaw, inp.camPitch);
        inp.jump = false;
        ch.update(dt);
        const ev = ch.consumeEvents();
        if (this.rag) {
            const rag = this.rag;
            const impact = rag.update(dt);
            if (this.model) this.model.apply(rag.world, this.body);
            if (impact > this.c.thudImpact) this.emit('thud', { impact });
            if (!this.hold && rag.t > this.c.getupDelay && (rag.still > 0.35 || rag.t > this.c.getupMax)) this.getUp();
            return;
        }
        if (ev.hit && ev.hit.speed >= ch.c.hitRagdoll) this.knock(ev.hit.vel, 'hit');
        else if (ev.landed > ch.c.fallRagdoll) this.knock([ch.vel[0], -ev.landed * 0.25, ch.vel[2]], 'fall');
        else if (ev.landed > this.c.landSound) this.emit('land', { impact: ev.landed });
        if (ev.jumped) this.emit('jump', {});
        mm.update(dt, ch);
        for (const fe of mm.footEvents) this.emit('step', fe);
    }

    dispose() {
        if (this.link) this.link.unbind();
        if (this.ownModel && this.model && this.model.dispose) this.model.dispose();
        this.model = null;
        this.listeners = {};
    }
}
