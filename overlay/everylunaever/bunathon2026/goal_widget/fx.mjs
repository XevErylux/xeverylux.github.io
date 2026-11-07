// @ts-check
// Einfaches Partikelmodul
// Damit zeichnen wir unsere Datenstaubpartikel, Explosionen, Punktflüsse und Ringe.

const TAU = Math.PI * 2;

/** @type {RGB[]} */
const MINT = [[70, 240, 188], [126, 236, 201], [184, 255, 240]];
/** @type {RGB[]} */
const ACCENT = [[233, 190, 78], [242, 145, 184], [141, 123, 218]];

/**
 * @param {RGB} c
 * @param {number} a
 */
function rgba(/** @type {RGB} */ c, /** @type {number} */ a) {
    return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

/**
 * Begrenzt einen Wert in den Bereich zwischen 0 und 1.
 * @param {number} value
 */
function clamp01(/** @type {number} */ value) {
    return value < 0 ? 0 : (value > 1 ? 1 : value);
}

/**
 * @param {number} min
 * @param {number} max
 */
function rand(/** @type {number} */ min, /** @type {number} */ max) {
    return min + Math.random() * (max - min);
}

/**
 * @template T
 * @param {T[]} arr
 */
function pick(/** @type {T[]} */ arr) {
    return arr[(Math.random() * arr.length) | 0];
}

/**
 * Erzeugt das Partikelfeld auf einem Canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {{ambient?: number, maxParticles?: number}} [options]
 */
export function createParticleField(canvas, options = {}) {
    const ctx = /** @type {CanvasRenderingContext2D} */(canvas.getContext('2d'));
    const settings = {
        ambient: 26,
        maxParticles: 320,
        ...options,
    };

    /** @type {Mote[]} */
    const motes = [];
    /** @type {Spark[]} */
    const sparks = [];
    /** @type {Stream[]} */
    const streams = [];
    /** @type {Ring[]} */
    const rings = [];

    let width = 0;
    let height = 0;
    let elapsed = 0;
    /** Leuchtstärke der Datenstaubpartikel */
    let energy = 0;
    let rafId = 0;
    let lastTime = 0;
    let running = false;
    /** Zuletzt verwendete DPR */
    let usedDpr = 0;
    /** Aus der `scale(var(--preview-scale))` */
    let visualScale = 1;

    /**
     * Bei dem Canvas unterscheidet sich gerne die angezeigte Größe von dem
     * über das Layout ermittelte Größe. Wir berechnen hier die visuelle
     * Skalierung, damit unser Canvas nicht mehr durch Browser-Zoom und andere
     * skalierende Gründe (DPI usw.) kaputt geht.
     * @returns {number}
     */
    function getVisualScale() {
        const layoutWidth = canvas.offsetWidth;
        if (!layoutWidth) {
            return visualScale || 1;
        }

        const scale = canvas.getBoundingClientRect().width / layoutWidth;
        return Number.isFinite(scale) && scale > 0 ? scale : (visualScale || 1);
    }

    function resize() {
        const layoutWidth = canvas.offsetWidth;
        const layoutHeight = canvas.offsetHeight;
        const box = canvas.getBoundingClientRect();

        const nextWidth = Math.max(1, layoutWidth || Math.round(box.width) || 1);
        const nextHeight = Math.max(1, layoutHeight || Math.round(box.height) || 1);
        const nextVisualScale = getVisualScale();
        const dpr = Math.min(window.devicePixelRatio || 1, 8);
        // Kombiniere unsere visuelle Skalierung mit der DPR-Skalierung
        const drawingScale = dpr * nextVisualScale;
        const targetDrawingWidth = Math.round(nextWidth * drawingScale);
        const targetDrawingHeight = Math.round(nextHeight * drawingScale);

        if (nextWidth === width && nextHeight === height
            && canvas.width === targetDrawingWidth && canvas.height === targetDrawingHeight
            && dpr === usedDpr && Math.abs(nextVisualScale - visualScale) < 0.001) {
            return;
        }

        width = nextWidth;
        height = nextHeight;
        usedDpr = dpr;
        visualScale = nextVisualScale;
        canvas.width = targetDrawingWidth;
        canvas.height = targetDrawingHeight;
        ctx.setTransform(drawingScale, 0, 0, drawingScale, 0, 0);
    }

    /**
     * Datenpartikel
     * @param {boolean} seededStart
     * @returns {Mote}
     */
    function createMote(/** @type {boolean} */ seededStart) {
        return {
            x: rand(6, width - 6),
            y: seededStart ? rand(4, height - 4) : height + rand(2, 26),
            vx: rand(-4, 4),
            vy: -rand(4, 15),
            size: rand(0.7, 2.3),
            alpha: rand(0.07, 0.32),
            phase: rand(0, TAU),
            wobble: rand(3, 12),
            freq: rand(0.35, 1.4),
            color: Math.random() < 0.85 ? pick(MINT) : pick(ACCENT),
            glyph: Math.random() < 0.15 ? (Math.random() < 0.5 ? '0' : '1') : null,
            twinkle: rand(0, TAU),
            twinkleSpeed: rand(0.5, 2.2),
        };
    }

    /**
     * Fülle Umgebung mit ganzen vielen Datenpartikeln.
     */
    function fillAmbient() {
        resize();
        while (motes.length < settings.ambient) {
            motes.push(createMote(true));
        }
    }

    /**
     * Funkenexplosionen für Punkteänderung und Zielabschluss.
     * @param {number} x
     * @param {number} y
     * @param {{count?: number, colors?: RGB[], speed?: [number, number], life?: [number, number],
     *          direction?: number, spread?: number, gravity?: number, size?: [number, number]}} [opts]
     */
    function burst(x, y, opts = {}) {
        const scale = getVisualScale();
        x = x / scale;
        y = y / scale;
        const count = opts.count ?? 24;
        const colors = opts.colors ?? MINT;
        const [minSpeed, maxSpeed] = opts.speed ?? [35, 190];
        const [minLife, maxLife] = opts.life ?? [0.35, 1.15];
        const [minSize, maxSize] = opts.size ?? [0.8, 2.4];
        const direction = opts.direction ?? -Math.PI / 2;
        const spread = opts.spread ?? TAU;

        for (let i = 0; i < count; i++) {
            if (sparks.length > settings.maxParticles) {
                break;
            }

            const angle = direction + rand(-spread / 2, spread / 2);
            const speed = rand(minSpeed, maxSpeed);

            sparks.push({
                x,
                y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                life: 0,
                maxLife: rand(minLife, maxLife),
                size: rand(minSize, maxSize),
                color: pick(colors),
                gravity: opts.gravity ?? 12,
                drag: rand(0.6, 1.6),
            });
        }
    }

    /**
     * Energiefluss von einem Punkt zu einem anderen.
     * @param {{x:number,y:number}} from
     * @param {{x:number,y:number}} to
     * @param {{count?: number, colors?: RGB[], duration?: [number, number], stagger?: number, curve?: number}} [opts]
     */
    function stream(from, to, opts = {}) {
        const scale = getVisualScale();
        from = { x: from.x / scale, y: from.y / scale };
        to = { x: to.x / scale, y: to.y / scale };
        const count = opts.count ?? 14;
        const colors = opts.colors ?? MINT;
        const [minDuration, maxDuration] = opts.duration ?? [0.35, 0.8];
        const stagger = opts.stagger ?? 0.05;
        const curve = opts.curve ?? 18;

        for (let i = 0; i < count; i++) {
            streams.push({
                fx: from.x,
                fy: from.y,
                tx: to.x,
                ty: to.y,
                cx: (from.x + to.x) / 2 + rand(-curve, curve),
                cy: (from.y + to.y) / 2 + rand(-curve, curve),
                t: 0,
                delay: i * rand(stagger * 0.4, stagger),
                duration: rand(minDuration, maxDuration),
                size: rand(0.9, 2.1),
                color: pick(colors),
            });
        }
    }

    /**
     * Expandierender Impuls-Ring.
     * @param {number} x
     * @param {number} y
     * @param {{color?: RGB, maxRadius?: number, duration?: number, width?: number, squash?: number}} [opts]
     */
    function ring(x, y, opts = {}) {
        const scale = getVisualScale();
        x = x / scale;
        y = y / scale;
        rings.push({
            x,
            y,
            t: 0,
            duration: opts.duration ?? 0.75,
            maxRadius: opts.maxRadius ?? 90,
            width: opts.width ?? 2,
            color: opts.color ?? MINT[0],
            squash: opts.squash ?? 1,
        });
    }

    /**kurzes Aufleben der Datenpartikel */
    function excite(/** @type {number} */ amount = 0.8) {
        energy = Math.min(1, energy + amount);
    }

    function clear() {
        sparks.length = 0;
        streams.length = 0;
        rings.length = 0;
    }

    /**
     * @param {number} dt
     */
    function step(/** @type {number} */ dt) {
        elapsed += dt;
        energy = Math.max(0, energy - dt * 0.55);

        const boost = 1 + energy * 1.8;

        // Datenpartikel
        for (const mote of motes) {
            mote.x += (mote.vx + Math.sin(mote.phase + elapsed * mote.freq) * mote.wobble) * dt;
            mote.y += mote.vy * boost * dt;

            if (mote.y < -12) {
                Object.assign(mote, createMote(false));
            } else if (mote.x < -12 || mote.x > width + 12) {
                mote.x = mote.x < 0 ? width + 8 : -8;
            }
        }

        // Funken als kurze Bahnen
        for (let i = sparks.length - 1; i >= 0; i--) {
            const p = sparks[i];
            p.life += dt;
            if (p.life >= p.maxLife) {
                sparks.splice(i, 1);
                continue;
            }

            const damping = Math.max(0, 1 - p.drag * dt);
            p.vx *= damping;
            p.vy = p.vy * damping + p.gravity * dt;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
        }

        // Punktenergieflüsse
        for (let i = streams.length - 1; i >= 0; i--) {
            const s = streams[i];
            if (s.delay > 0) {
                s.delay -= dt;
                continue;
            }

            s.t += dt / s.duration;
            if (s.t >= 1) {
                streams.splice(i, 1);
            }
        }

        // Impuls-Ringe
        for (let i = rings.length - 1; i >= 0; i--) {
            rings[i].t += dt;
            if (rings[i].t >= rings[i].duration) {
                rings.splice(i, 1);
            }
        }
    }

    function draw() {
        ctx.clearRect(0, 0, width, height);
        ctx.globalCompositeOperation = 'lighter';

        // Datenpartikel
        for (const mote of motes) {
            const twinkle = 0.65 + 0.35 * Math.sin(mote.twinkle + elapsed * mote.twinkleSpeed);
            const alpha = mote.alpha * twinkle * (1 + energy * 0.8);

            if (mote.glyph) {
                ctx.fillStyle = rgba(mote.color, alpha * 1.5);
                ctx.font = '8px "Share Tech Mono", monospace';
                ctx.fillText(mote.glyph, mote.x, mote.y);
            } else {
                ctx.fillStyle = rgba(mote.color, alpha);
                const s = mote.size * (1 + energy * 0.35);
                ctx.fillRect(mote.x - s / 2, mote.y - s / 2, s, s);
                ctx.fillStyle = rgba(mote.color, alpha * 0.25);
                ctx.fillRect(mote.x - s * 1.5, mote.y - s * 1.5, s * 3, s * 3);
            }
        }

        // Funken als kurze Bahnen
        for (const p of sparks) {
            const lifeRatio = 1 - p.life / p.maxLife;
            const alpha = lifeRatio * 0.9;
            const tail = 0.035;

            ctx.strokeStyle = rgba(p.color, alpha * 0.35);
            ctx.lineWidth = p.size * 2.2;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x - p.vx * tail, p.y - p.vy * tail);
            ctx.stroke();

            ctx.strokeStyle = rgba(p.color, alpha);
            ctx.lineWidth = p.size;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x - p.vx * tail, p.y - p.vy * tail);
            ctx.stroke();
        }

        // Punktenergieflüsse
        for (const s of streams) {
            if (s.delay > 0) {
                continue;
            }

            const t = s.t;
            const inv = 1 - t;
            const x = inv * inv * s.fx + 2 * inv * t * s.cx + t * t * s.tx;
            const y = inv * inv * s.fy + 2 * inv * t * s.cy + t * t * s.ty;
            const fade = Math.min(1, (1 - t) * 2.2) * Math.min(1, t * 8);
            const size = s.size * (1 + 0.6 * Math.sin(t * Math.PI));

            ctx.fillStyle = rgba(s.color, 0.22 * fade);
            ctx.fillRect(x - size * 1.6, y - size * 1.6, size * 3.2, size * 3.2);
            ctx.fillStyle = rgba(s.color, 0.85 * fade);
            ctx.fillRect(x - size / 2, y - size / 2, size, size);
        }

        // Impuls-Ringe
        for (const r of rings) {
            // Begrenze Werte zwischen 0 und 1, damit alpha nicht negativ werden kann.
            const t = clamp01(r.duration > 0 ? r.t / r.duration : 1);
            const radius = Math.max(0, r.maxRadius * (1 - Math.pow(1 - t, 2.4)));
            const alpha = (1 - t) * 0.75;

            if (radius <= 0) {
                continue;
            }

            ctx.strokeStyle = rgba(r.color, alpha * 0.35);
            ctx.lineWidth = Math.max(0.1, r.width * 3);
            ctx.beginPath();
            ctx.ellipse(r.x, r.y, radius, Math.max(0, radius * r.squash), 0, 0, TAU);
            ctx.stroke();

            ctx.strokeStyle = rgba(r.color, alpha);
            ctx.lineWidth = Math.max(0.4, r.width * (1 - t));
            ctx.beginPath();
            ctx.ellipse(r.x, r.y, radius, Math.max(0, radius * r.squash), 0, 0, TAU);
            ctx.stroke();
        }

        ctx.globalCompositeOperation = 'source-over';
    }

    /**
     * @param {number} now
     */
    function frame(/** @type {number} */ now) {
        // Verhindere negative Zeitstempel nach Neustarts
        const raw = lastTime > 0 ? (now - lastTime) / 1000 : 0.016;
        const dt = Number.isFinite(raw) ? Math.min(0.05, Math.max(0, raw)) : 0.016;
        lastTime = now;

        // Änderungen am devicePixelRatio (z. B. durch Zoom) ändert nicht
        // die Layoutgröße. Passe also unsere Zeichenfläche an, sobald
        // wir eine Änderung erkennen.
        if (Math.abs((window.devicePixelRatio || 1) - usedDpr) > 0.01
            || canvas.offsetWidth !== width) {
            resize();
        }

        step(dt);
        draw();

        rafId = requestAnimationFrame(frame);
    }

    function start() {
        if (running) {
            return;
        }

        running = true;
        fillAmbient();
        // 0 = "erster Frame setzt die Referenz", damit dt nie negativ wird.
        lastTime = 0;
        rafId = requestAnimationFrame(frame);
    }

    function stop() {
        running = false;
        cancelAnimationFrame(rafId);
    }

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            stop();
        } else {
            start();
        }
    });

    return {
        start,
        stop,
        resize: fillAmbient,
        burst,
        stream,
        ring,
        excite,
        clear,
        /** @returns {{width: number, height: number}} */
        get size() {
            resize();
            return { width, height };
        },
        palette: { MINT, ACCENT },
    };
}
