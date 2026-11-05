// Lory Engine 1.40: Canvas 2D world. Coordinates are world pixels, origin top left.
class Input2D {
    constructor(canvas) {
        this.keys = new Set(); this.pressed = new Set(); this.virtual = new Map();
        this.pointer = { x: 0, y: 0, down: false }; this.listeners = []; this.controls = null;
        this.bind(window, 'keydown', e => {
            if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) || e.target?.isContentEditable) return;
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(e.code)) e.preventDefault();
            if (!this.keys.has(e.code)) this.pressed.add(e.code);
            this.keys.add(e.code);
        });
        this.bind(window, 'keyup', e => this.keys.delete(e.code));
        const pointer = e => { const r = canvas.getBoundingClientRect(); this.pointer.x = e.clientX - r.left; this.pointer.y = e.clientY - r.top; };
        this.bind(canvas, 'pointerdown', e => { pointer(e); this.pointer.down = true; canvas.setPointerCapture?.(e.pointerId); });
        this.bind(canvas, 'pointermove', pointer);
        this.bind(window, 'pointerup', () => { this.pointer.down = false; });
        this.bind(window, 'pointercancel', () => this.clear());
        this.bind(window, 'blur', () => this.clear());
        this.bind(window, 'lory-release-input', () => this.clear());
        this.unpause = typeof Pause !== 'undefined' ? Pause.onChange(active => { if (active) this.clear(); }) : null;
    }
    bind(target, event, fn) { target.addEventListener(event, fn); this.listeners.push(() => target.removeEventListener(event, fn)); }
    down(...codes) { return codes.some(code => this.keys.has(code) || [...this.virtual.values()].includes(code)); }
    justPressed(...codes) { return codes.some(code => this.pressed.has(code)); }
    axis(negative, positive) { return Number(this.down(...positive)) - Number(this.down(...negative)); }
    endFrame() { this.pressed.clear(); }
    clear() { this.keys.clear(); this.pressed.clear(); this.virtual.clear(); this.pointer.down = false; }
    // Pointer capture + per-pointer state allow moving and jumping together on touch screens.
    mountControls(buttons = [{ label: '◀', code: 'ArrowLeft' }, { label: '▶', code: 'ArrowRight' }, { label: '↑', code: 'Space' }]) {
        this.controls?.remove();
        const root = document.createElement('div'); root.className = 'lory-touch-controls';
        root.style.cssText = 'position:fixed;bottom:max(18px,env(safe-area-inset-bottom));left:0;right:0;display:flex;gap:12px;justify-content:center;z-index:20;pointer-events:none;';
        for (const item of buttons) {
            const button = document.createElement('button'); button.textContent = item.label; button.type = 'button';
            button.setAttribute('aria-label', item.label);
            button.style.cssText = 'width:64px;height:64px;border:2px solid #ffffff88;border-radius:18px;background:#152945c9;color:white;font:bold 26px system-ui;touch-action:none;pointer-events:auto;user-select:none;';
            this.bind(button, 'pointerdown', e => { e.preventDefault(); button.setPointerCapture(e.pointerId); this.virtual.set(e.pointerId, item.code); this.pressed.add(item.code); });
            for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) this.bind(button, event, e => this.virtual.delete(e.pointerId));
            root.appendChild(button);
        }
        document.body.appendChild(root); this.controls = root; return root;
    }
    dispose() { for (const unbind of this.listeners) unbind(); this.listeners.length = 0; this.unpause?.(); this.controls?.remove(); this.clear(); }
}

class Camera2D {
    constructor(world) { this.world = world; this.x = 0; this.y = 0; this.zoom = 1; this.target = null; }
    follow(target) { this.target = target; this.update(); }
    home() { this.x = this.world.width / 2; this.y = this.world.height / 2; this.update(); }
    update() {
        if (this.target) { this.x = this.target.x + (this.target.width || 0) / 2; this.y = this.target.y + (this.target.height || 0) / 2; }
        const w = this.world.width / this.zoom, h = this.world.height / this.zoom, map = this.world.map;
        if (map) {
            this.x = map.width < w ? map.width / 2 : Math.max(w / 2, Math.min(map.width - w / 2, this.x));
            this.y = map.height < h ? map.height / 2 : Math.max(h / 2, Math.min(map.height - h / 2, this.y));
        }
    }
}

class World2D {
    constructor(canvas, options = {}) {
        this.canvas = canvas; this.ctx = canvas.getContext('2d');
        if (!this.ctx) throw new Error('Canvas 2D is unavailable');
        this.width = options.width || (typeof WORLD2D_WIDTH !== 'undefined' ? WORLD2D_WIDTH : 960);
        this.height = options.height || (typeof WORLD2D_HEIGHT !== 'undefined' ? WORLD2D_HEIGHT : 540);
        this.images = new Map(); this.pending = new Map(); this.sprites = []; this.solids = [];
        /** @type {GameMap2D | null} */ this.map = null;
        this.camera = new Camera2D(this); this.input = new Input2D(canvas);
        this.scale = 1; this.offsetX = 0; this.offsetY = 0; this.dpr = 1;
        this.onResize = () => this.resize(); window.addEventListener('resize', this.onResize); this.resize();
    }
    resize() {
        const r = this.canvas.getBoundingClientRect();
        this.cssWidth = Math.max(1, r.width); this.cssHeight = Math.max(1, r.height);
        this.dpr = Math.min(window.devicePixelRatio || 1, typeof WORLD2D_PIXEL_RATIO !== 'undefined' ? WORLD2D_PIXEL_RATIO : 2);
        this.canvas.width = Math.round(this.cssWidth * this.dpr); this.canvas.height = Math.round(this.cssHeight * this.dpr);
        this.scale = Math.min(this.cssWidth / this.width, this.cssHeight / this.height);
        this.offsetX = (this.cssWidth - this.width * this.scale) / 2; this.offsetY = (this.cssHeight - this.height * this.scale) / 2;
    }
    async preload(urls) {
        return Promise.all([...new Set(urls)].map(url => {
            if (this.images.has(url)) return this.images.get(url);
            if (this.pending.has(url)) return this.pending.get(url);
            const promise = new Promise(resolve => {
                const img = new Image(); let done = false;
                const finish = success => { if (done) return; done = true; clearTimeout(timer); img.onload = img.onerror = null; this.images.set(url, success ? img : null); resolve(success ? img : null); };
                const timer = setTimeout(() => finish(false), typeof LOADING_TIMEOUT_MS !== 'undefined' ? LOADING_TIMEOUT_MS : 45000);
                img.onload = () => finish(true); img.onerror = () => finish(false); img.src = url;
            });
            this.pending.set(url, promise); return promise;
        }));
    }
    /** @param {GameMap2D} source */
    async loadMap(source) {
        this.map = JSON.parse(JSON.stringify(source)); this.sprites.length = 0;
        this.solids = (this.map.solids || []).map(s => ({ ...s }));
        const urls = [...(this.map.assets || [])];
        for (const sprite of this.map.sprites || []) { this.addSprite(sprite); if (sprite.image) urls.push(sprite.image); }
        for (const tile of Object.values(this.map.tilemap?.palette || {})) if (tile.image) urls.push(tile.image);
        this.camera.target = null; this.camera.home(); await this.preload(urls);
    }
    markers(name) { return (this.map?.markers || []).filter(m => !name || m.name === name || m.name.startsWith(name + '-')); }
    marker(name) { return this.markers(name)[0] || null; }
    /** @param {Partial<Sprite2D>} options @returns {Sprite2D} */
    addSprite(options = {}) {
        const sprite = Object.assign({ x: 0, y: 0, width: 32, height: 32, vx: 0, vy: 0, z: 0, color: '#74d9bd', visible: true, rotation: 0, alpha: 1, flipX: false, grounded: false, time: 0 }, options);
        this.sprites.push(sprite); if (sprite.image) this.preload([sprite.image]); return sprite;
    }
    removeSprite(sprite) { const i = this.sprites.indexOf(sprite); if (i >= 0) this.sprites.splice(i, 1); }
    // 0xRRGGBB -> '#rrggbb' для контекста Canvas.
    static hex(value) { return '#' + ((Number(value) >>> 0) & 0xffffff).toString(16).padStart(6, '0'); }
    static overlaps(a, b) { return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y; }
    colliders(bounds) {
        const result = this.solids.slice(), tilemap = this.map?.tilemap;
        if (tilemap) {
            const size = tilemap.tileSize, solid = new Set(tilemap.solid || []), rows = tilemap.rows;
            const minX = Math.max(0, Math.floor(bounds.x / size)), maxX = Math.floor((bounds.x + bounds.width) / size);
            const minY = Math.max(0, Math.floor(bounds.y / size)), maxY = Math.min(rows.length - 1, Math.floor((bounds.y + bounds.height) / size));
            for (let y = minY; y <= maxY; y++) for (let x = minX; x <= Math.min(maxX, rows[y].length - 1); x++) {
                if (solid.has(rows[y][x])) result.push({ x: x * size, y: y * size, width: size, height: size });
            }
        }
        return result;
    }
    // Swept axis-aligned movement: thin walls cannot be skipped by a fast body.
    move(body, dx, dy) {
        const hits = { x: false, y: false }; body.grounded = false;
        for (const [axis, requested] of [['x', dx], ['y', dy]]) {
            let delta = Number(requested) || 0; if (!delta) continue;
            const horizontal = axis === 'x', other = horizontal ? 'y' : 'x', size = horizontal ? 'width' : 'height', otherSize = horizontal ? 'height' : 'width';
            const bounds = { x: body.x + Math.min(0, horizontal ? delta : 0), y: body.y + Math.min(0, horizontal ? 0 : delta), width: body.width + Math.abs(horizontal ? delta : 0), height: body.height + Math.abs(horizontal ? 0 : delta) };
            for (const solid of this.colliders(bounds)) {
                if (body[other] >= solid[other] + solid[otherSize] || body[other] + body[otherSize] <= solid[other]) continue;
                if (delta > 0 && body[axis] + body[size] <= solid[axis] && body[axis] + body[size] + delta >= solid[axis]) { delta = solid[axis] - body[axis] - body[size]; hits[axis] = true; }
                if (delta < 0 && body[axis] >= solid[axis] + solid[size] && body[axis] + delta <= solid[axis] + solid[size]) { delta = solid[axis] + solid[size] - body[axis]; hits[axis] = true; }
            }
            body[axis] += delta;
            if (hits[axis]) { body[horizontal ? 'vx' : 'vy'] = 0; if (!horizontal && Number(requested) > 0) body.grounded = true; }
        }
        return hits;
    }
    step(body, dt, options = {}) { body.vy += (options.gravity || 0) * dt; return this.move(body, body.vx * dt, body.vy * dt); }
    update(dt) { for (const sprite of this.sprites) sprite.time += dt; this.camera.update(); }
    screenToWorld(x, y) { const c = this.camera; return { x: ((x - this.offsetX) / this.scale - this.width / 2) / c.zoom + c.x, y: ((y - this.offsetY) / this.scale - this.height / 2) / c.zoom + c.y }; }
    worldToScreen(x, y) { const c = this.camera; return { x: ((x - c.x) * c.zoom + this.width / 2) * this.scale + this.offsetX, y: ((y - c.y) * c.zoom + this.height / 2) * this.scale + this.offsetY }; }
    drawSprite(sprite) {
        if (sprite.visible === false) return;
        const ctx = this.ctx, image = this.images.get(sprite.image), animation = sprite.animation;
        const frame = animation?.frames?.length ? animation.frames[Math.floor(sprite.time * animation.fps) % animation.frames.length] : sprite.frame;
        ctx.save(); ctx.globalAlpha = sprite.alpha ?? 1;
        ctx.translate(sprite.x + sprite.width / 2, sprite.y + sprite.height / 2); ctx.rotate(sprite.rotation || 0); ctx.scale(sprite.flipX ? -1 : 1, 1);
        if (image) {
            if (frame) ctx.drawImage(image, frame.x, frame.y, frame.width, frame.height, -sprite.width / 2, -sprite.height / 2, sprite.width, sprite.height);
            else ctx.drawImage(image, -sprite.width / 2, -sprite.height / 2, sprite.width, sprite.height);
        } else { ctx.fillStyle = sprite.color || '#74d9bd'; ctx.fillRect(-sprite.width / 2, -sprite.height / 2, sprite.width, sprite.height); }
        ctx.restore();
    }
    render() {
        const ctx = this.ctx, c = this.camera; c.update();
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        // Поля вокруг логической сцены: WORLD2D_LETTERBOX (цвет игры), а не служебный тёмный.
        ctx.fillStyle = World2D.hex(typeof WORLD2D_LETTERBOX !== 'undefined' ? WORLD2D_LETTERBOX : 0x101923);
        ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
        ctx.save(); ctx.translate(this.offsetX, this.offsetY); ctx.scale(this.scale, this.scale);
        ctx.beginPath(); ctx.rect(0, 0, this.width, this.height); ctx.clip();
        ctx.fillStyle = this.map?.background || '#163348'; ctx.fillRect(0, 0, this.width, this.height);
        ctx.translate(this.width / 2, this.height / 2); ctx.scale(c.zoom, c.zoom); ctx.translate(-c.x, -c.y);
        // WORLD2D_SMOOTH: 1 — мягкая графика (ImageGen, рисованные спрайты), 0 — пиксель-арт.
        ctx.imageSmoothingEnabled = (typeof WORLD2D_SMOOTH !== 'undefined' ? WORLD2D_SMOOTH : 0) > 0;
        const tilemap = this.map?.tilemap;
        if (tilemap) {
            const size = tilemap.tileSize, left = c.x - this.width / c.zoom / 2, top = c.y - this.height / c.zoom / 2;
            const minX = Math.max(0, Math.floor(left / size)), maxX = Math.ceil((left + this.width / c.zoom) / size);
            const minY = Math.max(0, Math.floor(top / size)), maxY = Math.min(tilemap.rows.length - 1, Math.ceil((top + this.height / c.zoom) / size));
            for (let y = minY; y <= maxY; y++) for (let x = minX; x <= Math.min(maxX, tilemap.rows[y].length - 1); x++) {
                const tile = tilemap.palette[tilemap.rows[y][x]]; if (tile) this.drawSprite({ ...tile, x: x * size, y: y * size, width: size, height: size });
            }
        }
        for (const solid of this.solids) if (solid.color) { ctx.fillStyle = solid.color; ctx.fillRect(solid.x, solid.y, solid.width, solid.height); }
        for (const sprite of [...this.sprites].sort((a, b) => a.z - b.z)) this.drawSprite(sprite);
        ctx.restore();
    }
    dispose() { this.input.dispose(); window.removeEventListener('resize', this.onResize); this.sprites.length = 0; this.images.clear(); }
}
