// ParticleFX — bounded, pause-aware particle layers. Coordinates use Babylon x/y/z.
// Art textures and flipbooks are optional; the neutral radial sprite is a technical fallback.
class ParticleFX {
    constructor(scene) {
        this.scene = scene; this.effects = new Set(); this.textures = new Map(); this.recipes = new Map();
        this.clock = 0; this.disposed = false;
        this.unsubscribe = Pause.onChange(() => this.syncPause());
        this.observer = scene.onDisposeObservable.add(() => this.dispose());
        this.register('explosion', [
            { burst: 90, capacity: 100, life: [.25, .85], size: [3, 10], speed: [65, 220], color: '#ffbf48', gravity: [0, -90, 0] },
            { burst: 10, capacity: 16, life: [.12, .3], size: [25, 55], speed: [0, 12], color: '#fff0b0', sizeGradient: [[0, .3], [.3, 1], [1, 0]] },
            { delay: .08, burst: 22, capacity: 32, life: [1, 2.4], size: [12, 32], speed: [10, 35], direction: [[-.4, .2, -.4], [.4, 1, .4]], color: '#62616a', blend: 'standard', gravity: [0, 12, 0], sizeGradient: [[0, .3], [1, 2]] }
        ]);
        this.register('magic', [{ burst: 80, capacity: 100, life: [.5, 1.3], size: [2, 7], speed: [35, 100], color: '#83ffe4', gravity: [0, 15, 0] }]);
        this.register('trail', [{ rate: 90, capacity: 180, life: [.2, .8], size: [2, 5], speed: [0, 5], color: '#ccefff', sizeGradient: [[0, .2], [.4, 1], [1, 0]] }]);
        this.register('dust', [{ rate: 30, capacity: 160, life: [1, 3], size: [10, 30], speed: [2, 12], color: '#bda583', blend: 'standard', box: [[-60, 0, -60], [60, 10, 60]], direction: [[-.4, .2, -.4], [.4, 1, .4]] }]);
    }
    static vector(v) { return Array.isArray(v) ? new BABYLON.Vector3(v[0], v[1], v[2]) : new BABYLON.Vector3(v?.x || 0, v?.y || 0, v?.z || 0); }
    static color(hex, alpha = 1) { const c = BABYLON.Color3.FromHexString(hex || '#ffffff'); return new BABYLON.Color4(c.r, c.g, c.b, alpha); }
    cfg() {
        return {
            systems: typeof FX_MAX_SYSTEMS !== 'undefined' ? FX_MAX_SYSTEMS : 48,
            particles: typeof FX_MAX_PARTICLES !== 'undefined' ? FX_MAX_PARTICLES : 6000,
            quality: typeof IS_MOBILE !== 'undefined' && IS_MOBILE ? (typeof FX_MOBILE_SCALE !== 'undefined' ? FX_MOBILE_SCALE : .55) : 1,
        };
    }
    texture(url) {
        if (this.textures.has(url || '')) return this.textures.get(url || '');
        let tex;
        if (url) {
            tex = new BABYLON.Texture(url, this.scene, false, false, BABYLON.Texture.TRILINEAR_SAMPLINGMODE, undefined, () => {
                if (this.disposed) return;
                console.warn('ParticleFX: texture unavailable', url);
                for (const e of this.effects) if (e.system.particleTexture === tex) { e.system.particleTexture = this.texture(); e.system.isAnimationSheetEnabled = false; }
                this.textures.delete(url); tex.dispose();
            });
        } else {
            tex = new BABYLON.DynamicTexture('fx-radial', 64, this.scene, false);
            const ctx = tex.getContext(), gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
            gradient.addColorStop(0, 'rgba(255,255,255,1)'); gradient.addColorStop(.3, 'rgba(255,255,255,.8)'); gradient.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.clearRect(0, 0, 64, 64); ctx.fillStyle = gradient; ctx.fillRect(0, 0, 64, 64); tex.update();
        }
        tex.hasAlpha = true; this.textures.set(url || '', tex); return tex;
    }
    // Группа рендера частиц. В сцене World3D (там глубина слоя OVERLAY не сбрасывается) частицы
    // идут в World3D.LAYER.OVERLAY. Частица, нарисованная в группе объектов, переписывает их
    // трафарет, и HighlightLayer обводки заливает силуэт внутри свечения и вспышки. В OVERLAY слой
    // обводки уже наложен, а глубина мира цела — рельеф и стены прячут эффект как обычно.
    // В чужой сцене — группа 0, как у Babylon; create({ group }) задаёт группу явно.
    renderGroup() {
        if (typeof World3D === 'undefined' || !World3D.LAYER || typeof this.scene.getAutoClearDepthStencilSetup !== 'function') return 0;
        const setup = this.scene.getAutoClearDepthStencilSetup(World3D.LAYER.OVERLAY);
        return setup && setup.autoClear === false ? World3D.LAYER.OVERLAY : 0;
    }
    register(name, layers) { this.recipes.set(name, layers.map(layer => ({ ...layer }))); return this; }
    play(name, position, overrides = {}) {
        const layers = this.recipes.get(name); if (!layers) throw new Error('Unknown particle recipe: ' + name);
        const handles = layers.map(layer => this.create({ ...layer, ...overrides, position })).filter(Boolean);
        return { handles, stop: () => handles.forEach(h => h.stop()), dispose: () => handles.forEach(h => h.dispose()), setPosition: p => handles.forEach(h => h.setPosition(p)) };
    }
    create(options = {}) {
        if (this.disposed) return null;
        const o = options, cfg = this.cfg();
        const available = Math.max(0, Math.floor(cfg.particles * cfg.quality) - [...this.effects].reduce((n, e) => n + e.capacity, 0));
        const capacity = Math.min(available, Math.max(1, Math.floor((o.capacity || 160) * cfg.quality)));
        if (this.effects.size >= cfg.systems || capacity < 1) return null;
        const ps = new BABYLON.ParticleSystem(o.name || 'fx', capacity, this.scene, null, !!o.sheet);
        ps.particleTexture = this.texture(o.texture);
        ps.renderingGroupId = o.group ?? this.renderGroup();
        ps.emitter = ParticleFX.vector(o.position);
        const box = o.box || [[0, 0, 0], [0, 0, 0]], direction = o.direction || [[-1, -1, -1], [1, 1, 1]];
        ps.minEmitBox = ParticleFX.vector(box[0]); ps.maxEmitBox = ParticleFX.vector(box[1]);
        ps.direction1 = ParticleFX.vector(direction[0]); ps.direction2 = ParticleFX.vector(direction[1]);
        const life = o.life || [.3, 1], size = o.size || [2, 8], speed = o.speed || [10, 40];
        ps.minLifeTime = life[0]; ps.maxLifeTime = life[1]; ps.minSize = size[0]; ps.maxSize = size[1];
        ps.minEmitPower = speed[0]; ps.maxEmitPower = speed[1]; ps.gravity = ParticleFX.vector(o.gravity);
        ps.minAngularSpeed = o.spin?.[0] || 0; ps.maxAngularSpeed = o.spin?.[1] || 0;
        ps.color1 = ParticleFX.color(o.color, o.alpha ?? 1); ps.color2 = ParticleFX.color(o.color2 || o.color, o.alpha ?? 1);
        ps.colorDead = ParticleFX.color(o.color2 || o.color, 0);
        ps.blendMode = o.blend === 'standard' ? BABYLON.ParticleSystem.BLENDMODE_STANDARD : BABYLON.ParticleSystem.BLENDMODE_ADD;
        // sizeGradient — множитель размера по жизни частицы; Babylon ждёт абсолютный размер.
        for (const [t, s] of o.sizeGradient || []) ps.addSizeGradient(t, s * size[0], s * size[1]);
        for (const [t, color, alpha] of o.colorGradient || []) ps.addColorGradient(t, ParticleFX.color(color, alpha ?? 1));
        if (o.sheet) {
            ps.spriteCellWidth = o.sheet.width; ps.spriteCellHeight = o.sheet.height;
            ps.startSpriteCellID = o.sheet.start || 0; ps.endSpriteCellID = o.sheet.end;
            ps.spriteCellChangeSpeed = o.sheet.speed ?? 1; ps.spriteCellLoop = o.sheet.loop ?? false;
            ps.spriteRandomStartCell = !!o.sheet.randomStart;
        }
        const rate = (o.rate ?? 60) * cfg.quality, burst = o.burst == null ? null : Math.min(capacity, Math.ceil(o.burst * cfg.quality));
        ps.emitRate = burst == null ? rate : 0;
        const e = { system: ps, capacity, started: false, start: this.clock + (o.delay || 0), end: Infinity, stopAt: Infinity,
            follow: o.follow, offset: ParticleFX.vector(o.offset), rate, burst, life: ps.maxLifeTime, speed: 1 / 60, duration: o.duration };
        const dispose = () => { if (!this.effects.delete(e)) return; ps.dispose(false); };
        const stop = () => { if (!e.started) { dispose(); return; } ps.stop(); e.end = Math.min(e.end, this.clock + e.life + .1); };
        const handle = { system: ps, stop, dispose, setPosition: p => { ps.emitter = ParticleFX.vector(p); }, setRate: n => { e.rate = Math.max(0, n) * cfg.quality; if (burst == null) ps.emitRate = e.rate; } };
        this.effects.add(e); this.syncPause(); this.update(0); return handle;
    }
    syncPause() { for (const e of this.effects) e.system.updateSpeed = Pause.active ? 0 : e.speed; }
    update(dt) {
        if (this.disposed) return;
        this.syncPause(); if (Pause.active) return;
        this.clock += Math.max(0, Math.min(.1, dt));
        for (const e of this.effects) {
            if (e.follow) {
                const p = typeof e.follow === 'function' ? e.follow() : (e.follow.getAbsolutePosition ? e.follow.getAbsolutePosition() : e.follow.position || e.follow);
                if (p) e.system.emitter = ParticleFX.vector(p).add(e.offset);
            }
            if (!e.started && this.clock >= e.start) {
                e.started = true; e.system.start();
                if (e.burst != null) { e.system.manualEmitCount = e.burst; e.end = this.clock + e.life + .1; }
                else if (Number.isFinite(e.duration)) e.stopAt = this.clock + e.duration;
            }
            if (this.clock >= e.stopAt) { e.system.stop(); e.stopAt = Infinity; e.end = this.clock + e.life + .1; }
            if (this.clock >= e.end) { e.system.dispose(false); this.effects.delete(e); }
        }
    }
    clear() { for (const e of this.effects) e.system.dispose(false); this.effects.clear(); }
    dispose() {
        if (this.disposed) return; this.disposed = true; this.clear();
        for (const texture of this.textures.values()) texture.dispose(); this.textures.clear();
        this.unsubscribe(); this.scene.onDisposeObservable.remove(this.observer);
    }
}
