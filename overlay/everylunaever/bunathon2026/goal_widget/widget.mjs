// @ts-check

import { createParticleField } from './fx.mjs';

const numberFormat = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const SCRAMBLE_CHARS = '▚▞▓▒░#@$%&*+=<>/\\|[]{}0123456789ABCDEFXZ';
/** Wenn der Balken fast voll ist, wäre der Abschluss sehr langsam */
const MIN_COUNTER_SPEED = 40;

/**
 * @param {number} ms
 */
function wait(/** @type {number} */ ms) {
    return new Promise(/** @type {(resolve: (value: unknown) => void) => void} */(resolve) => { setTimeout(() => { resolve(null); }, ms); });
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
function clamp(/** @type {number} */ value, /** @type {number} */ min, /** @type {number} */ max) {
    return value < min ? min : value > max ? max : value;
}

/**
 * @param {string} text
 */
function format(/** @type {number} */ text) {
    return numberFormat.format(Math.round(text));
}

/**
 * @typedef {{points: number, title: string, description: string}} GoalEntry
 */

/**
 * @param {HTMLElement} root .widget
 * @param {{goals?: GoalEntry[], scrambleMs?: number}} [options]
 */
export function createGoalWidget(root, options = {}) {
    /** @type {(selector: string) => unknown} */
    const query = (selector) => root.querySelector(selector);

    const el = {
        conduit: /** @type {HTMLElement} */ (query('.layer.conduit')),
        content: /** @type {HTMLElement} */ (query('#content')),
        total: /** @type {HTMLElement} */ (query('#total')),
        delta: /** @type {HTMLElement} */ (query('#delta')),
        goalRow: /** @type {HTMLElement} */ (query('#goal-row')),
        chip: /** @type {HTMLElement} */ (query('#goal-row .target-chip')),
        activePoints: /** @type {HTMLElement} */ (query('#active-points')),
        activeTitle: /** @type {HTMLElement} */ (query('#active-title')),
        activeDesc: /** @type {HTMLElement} */ (query('#active-desc')),
        titleLine: /** @type {HTMLElement} */ (query('#goal-row .title-line')),
        status: /** @type {HTMLElement} */(query('#status-value')),
        progress: /** @type {HTMLElement} */ (query('#progress')),
        fill: /** @type {HTMLElement} */ (query('#progress-fill')),
        head: /** @type {HTMLElement} */ (query('#progress-head')),
        remaining: /** @type {HTMLElement} */ (query('#remaining')),
        pct: /** @type {HTMLElement} */ (query('#pct')),
        nextRow: /** @type {HTMLElement} */ (query('#next-row')),
        nextPoints: /** @type {HTMLElement} */ (query('#next-points')),
        nextTitle: /** @type {HTMLElement} */ (query('#next-title')),
        banner: /** @type {HTMLElement} */ (query('#banner')),
        bannerText: /** @type {HTMLElement} */ (query('#banner-text')),
        fxBack: /** @type {HTMLCanvasElement} */ (query('#fx-back')),
        fxFront: /** @type {HTMLCanvasElement} */ (query('#fx-front')),
    };

    el.conduit.onanimationstart = (/** @type {AnimationEvent} */ ev) => {
        if (ev.animationName !== "conduit-flow-boost") return;

        el.conduit.classList.add("boosting");
    };
    el.conduit.onanimationiteration = (/** @type {AnimationEvent} */ ev) => {
        if (ev.animationName !== "conduit-flow-boost") return;

        if (!root.classList.contains("boost")) {
            if (el.conduit.classList.contains("boosting")) {
                el.conduit.classList.remove("boosting");
            }
        }
    };

    const fxBack = createParticleField(el.fxBack, { ambient: 20 });
    const fxFront = createParticleField(el.fxFront, { ambient: 8, maxParticles: 400 });
    const { MINT, ACCENT } = fxFront.palette;

    /** @type {GoalEntry[]} */
    let goals = (options.goals ?? []).map((goal) => ({
        points: Number(goal.points),
        title: String(goal.title ?? ''),
        description: String(goal.description ?? ''),
    })).sort((a, b) => a.points - b.points);

    /** echter Punktestand */
    let points = 0;
    /** angezeigter (interpolierter) Punktestand */
    let displayed = 0;
    /** noch nicht aufgenommener Delta-Anteil */
    let pendingDelta = 0;
    /** Anzahl der Ziele, deren Übergang schon gezeigt wurde */
    let crossed = 0;
    /** true, solange die Übergangsanimation läuft (Zähler steht still) */
    let transitioning = false;
    /** kennzeichnet den zuletzt gestarteten Übergang (für dessen Aufräumphase) */
    let transitionToken = 0;

    /**
     * Stufe des Widgets: Anzahl der Ziele, die bereits als erreicht gezeigt
     * wurden. Ein Ziel, das exakt auf der Schwelle steht, zählt noch nicht als
     * erreicht - der Balken bleibt voll, bis der Wechsel durchgelaufen ist.
     * @returns {number}
     */
    function completed() {
        if (points < displayed) {
            // Punkte wurden zurückgenommen: Stufe richtet sich nach dem echten Stand
            return countCompleted(points);
        }

        return Math.max(crossed, countCompleted(displayed));
    }

    /** Synchronisiert die Stufe mit einem sprunghaft gesetzten Zählerstand. */
    function syncStage() {
        crossed = countCompleted(displayed);
    }

    let deltaVisible = false;
    let deltaHideTimer = 0;
    let lastFrame = performance.now();
    let lastErrorAt = -1e9;

    /**
     * Melde Fehler, aber maximal einmal pro Sekunde
     * @param {string} where
     * @param {unknown} err
     */
    function reportError(/** @type {string} */ where, /** @type {unknown} */ err) {
        const at = performance.now();
        if (at - lastErrorAt < 1000) {
            return;
        }

        lastErrorAt = at;
        console.error(where, err);
    }
    let marqueeTimer = 0;

    // ------- Geometrie -------

    /**
     * Position eines Elementes relativ zum Widget. Wird für Partikel verwendet.
     * @param {HTMLElement} target
     * @returns {{x: number, y: number, width: number, height: number}}
     */
    function localRect(target) {
        const a = target.getBoundingClientRect();
        const b = root.getBoundingClientRect();
        return {
            x: a.left - b.left,
            y: a.top - b.top,
            width: a.width,
            height: a.height,
        };
    }

    /**
     * Position des Balken-Vorderkante.
     * @param {number} ratio
     */
    function barHead(/** @type {number} */ ratio) {
        const track = localRect(el.progress);
        return {
            x: track.x + track.width * clamp(ratio, 0, 1),
            y: track.y + track.height / 2,
        };
    }

    // -------- Ziele -------

    /** @returns {number} Index des aktiven Zieles, -1 wenn alles erreicht */
    function activeIndex() {
        const cv = completed();
        return cv >= goals.length ? -1 : cv;
    }

    /**
     * Anzahl der Ziele, deren Schwelle eindeutig unterschritten ist. Ein Ziel
     * auf exakt 100 % gilt noch als aktiv (siehe completed()).
     * @param {number} value
     */
    function countCompleted(/** @type {number} */ value) {
        let count = 0;
        for (const goal of goals) {
            if (goal.points < value) {
                count++;
            }
        }
        return count;
    }

    /**
     * @param {number} value
     * @param {number} index
     */
    function progressRatio(/** @type {number} */ value, /** @type {number} */ index) {
        if (index < 0) {
            return value <= 0 ? 0 : 1;
        }

        const previous = index > 0 ? goals[index - 1].points : 0;
        const target = goals[index].points;
        if (target <= previous) {
            return 1;
        }

        return clamp((value - previous) / (target - previous), 0, 1);
    }

    // ------- Rendern -------

    function updateCounter() {
        el.total.textContent = format(displayed);
    }

    function updateProgress() {
        const index = activeIndex();
        const ratio = progressRatio(displayed, index);

        el.fill.style.width = `${(ratio * 100).toFixed(2)}%`;
        el.head.style.left = `${(ratio * 100).toFixed(2)}%`;
        el.progress.classList.toggle('started', ratio > 0.005);
        el.pct.textContent = `${Math.round(ratio * 100)}%`;

        if (index < 0) {
            el.remaining.textContent = ratio > 0 ? '✓ komplett' : '-';
            return;
        }

        const missing = goals[index].points - displayed;
        el.remaining.textContent = missing > 0.5 ? `noch ${format(missing)}` : 'erreicht';
    }

    /** @type {number} Index der gerade angezeigten Zielzeile */
    let renderedIndex = 0;

    /** Chat fragt doch so gerne nach weiteren Zielen. So wo sind sie denn? */
    const keineWeiterenZieleText = 'Wo weitere Ziele?';

    /**
     * @param {{promote?: boolean}} [opts]
     */
    function renderGoalRows(/** @type {{promote?: boolean}} */ opts = {}) {
        const index = activeIndex();        
        if (index < 0 && displayed === 0)
            return;
        
        renderedIndex = index;
        const goal = index >= 0 ? goals[index] : null;
        const next = index >= 0 && index + 1 < goals.length ? goals[index + 1] : null;
        
        if (!goal) {
            el.chip.classList.add('all-done');
            el.activePoints.textContent = '✓';
            el.activeTitle.textContent = 'Alle Ziele erreicht';
            el.activeDesc.textContent = 'Vielen Dank!';
            el.nextPoints.textContent = '–';
            el.nextTitle.textContent = goals.length === 0 ? '' : keineWeiterenZieleText;
            return;
        }

        el.chip.classList.remove('all-done');

        if (opts.promote) {
            scrambleText(el.activeTitle, goal.title, options.scrambleMs ?? 700);
            scrambleText(el.nextTitle, next ? next.title : keineWeiterenZieleText, 450);
            el.chip.classList.remove('flip');
            void el.chip.offsetWidth;
            el.chip.classList.add('flip');
            el.goalRow.classList.add('rematerialize');
            el.goalRow.classList.remove('complete');
            el.nextRow.classList.add('enter');
            setTimeout(() => {
                el.goalRow.classList.remove('rematerialize');
                el.nextRow.classList.remove('enter');
                el.chip.classList.remove('flip');
            }, 1100);
        } else {
            el.activeTitle.textContent = goal.title;
            el.nextTitle.textContent = next ? next.title : 'Keine weiteren Ziele';
        }

        el.activePoints.textContent = format(goal.points);
        el.activeDesc.textContent = goal.description;
        el.nextPoints.textContent = next ? format(next.points) : '–';

        scheduleMarquee();
    }

    function scheduleMarquee() {
        clearTimeout(marqueeTimer);
        el.titleLine.classList.remove('marquee');

        // Laufbreite messen und ggf. Lauftext starten
        marqueeTimer = setTimeout(() => {
            if (el.titleLine.scrollWidth > el.titleLine.clientWidth + 1) {
                el.titleLine.style.setProperty('--scroll-width', `${el.titleLine.scrollWidth}px`);
                el.titleLine.style.setProperty('--client-width', `${el.titleLine.clientWidth}px`);
                el.titleLine.classList.add('marquee');
            }
        }, 2600);
    }

    /**
     * Decodier-Effekt für Beschriftungen.
     * @param {HTMLElement} target
     * @param {string} text
     * @param {number} duration
     */
    function scrambleText(target, text, duration) {
        const start = performance.now();
        const length = text.length;

        /**
         * @param {number} now
         */
        function tick(/** @type {number} */ now) {
            const t = (now - start) / duration;

            if (t >= 1) {
                target.textContent = text;
                return;
            }

            const revealed = Math.floor(t * length * 1.3);
            let out = '';
            for (let i = 0; i < length; i++) {
                const char = text[i];
                if (i < revealed || char === ' ') {
                    out += char;
                } else {
                    out += SCRAMBLE_CHARS[(Math.random() * SCRAMBLE_CHARS.length) | 0];
                }
            }

            target.textContent = out;
            requestAnimationFrame(tick);
        }

        target.textContent = text === '' ? '' : SCRAMBLE_CHARS[(Math.random() * SCRAMBLE_CHARS.length) | 0].repeat(Math.min(length, 60));
        requestAnimationFrame(tick);
    }

    // ------- Punktzahlen -------

    function showDelta() {
        clearTimeout(deltaHideTimer);
        el.delta.classList.remove('consumed');
        el.delta.classList.toggle('neg', false);
        el.delta.classList.add('show');
        deltaVisible = true;

        deltaHideTimer = setTimeout(hideDelta, deltaLifetime());
    }

    /**
     * Berechne die Zeit, bis der offenen Betrag aufgenommen wurde.
     * @returns {number}
     */
    function deltaLifetime() {
        const travel = Math.abs(pendingDelta) / MIN_COUNTER_SPEED * 1000;
        return Math.max(3000, travel + 2500);
    }

    function hideDelta() {
        if (!deltaVisible) {
            return;
        }

        clearTimeout(deltaHideTimer);
        deltaVisible = false;
        el.delta.classList.add('consumed');
        el.delta.classList.remove('show');
        deltaHideTimer = setTimeout(() => {
            el.delta.classList.remove('consumed');
        }, 650);
    }

    let pointEnergyBoostTimer = 0;

    /**
     * @param {number} value
     */
    function emitPointEnergy(/** @type {number} */ value) {
        const ratio = progressRatio(displayed, activeIndex());
        const head = barHead(ratio);
        const totalRect = localRect(el.total);
        const deltaRect = localRect(el.delta);
        const strength = clamp(Math.abs(value) / 900, 0.15, 1);

        fxFront.excite(0.55 + strength * 0.45);
        fxBack.excite(0.35 + strength * 0.4);

        // Funken an der Balkenvorderkante
        fxFront.burst(head.x, head.y, {
            count: Math.round(6 + strength * 16),
            colors: MINT,
            speed: [25, 70 + strength * 120],
            life: [0.3, 0.9],
            direction: -Math.PI / 2,
            spread: Math.PI * 1.4,
            gravity: -14,
        });

        // Energie vom Delta-Wert in den Zähler und von dort in den Balken
        if (deltaRect.width > 0) {
            fxFront.stream(
                { x: deltaRect.x + deltaRect.width * 0.5, y: deltaRect.y + deltaRect.height * 0.5 },
                { x: totalRect.x + totalRect.width * 0.5, y: totalRect.y + totalRect.height * 0.6 },
                { count: Math.round(6 + strength * 10), colors: MINT, stagger: 0.045, curve: 10 },
            );
        }

        fxFront.stream(
            { x: totalRect.x + totalRect.width * 0.5, y: totalRect.y + totalRect.height },
            head,
            { count: Math.round(5 + strength * 9), colors: MINT, stagger: 0.05, curve: 26 },
        );

        // Wellen-/Leuchtsignal auf dem Balken
        el.progress.classList.remove('wave-soft');
        el.progress.classList.remove('wave');
        void el.progress.offsetWidth;
        el.progress.classList.add('wave');

        el.total.classList.remove('bump');
        void el.total.offsetWidth;
        el.total.classList.add('bump');

        root.classList.add('boost');
        clearTimeout(pointEnergyBoostTimer);
        pointEnergyBoostTimer = setTimeout(() => root.classList.remove('boost'), 900);
    }

    /**
     * Neuer Gesamtpunktestand.
     * @param {number} nextPoints
     */
    function setPoints(/** @type {number} */ nextPoints) {
        if (!Number.isFinite(nextPoints)) {
            return;
        }

        const delta = nextPoints - points;
        points = nextPoints;

        if (delta !== 0) {
            pendingDelta += delta;
            showDelta();
            emitPointEnergy(delta);
        }
    }

    // ------- Goal-Wechsel -------

    /**
     * Übergangsanimation für ein erreichtes Ziel. Der Zähler steht währenddessen
     * still, nach dem Nachrücken des nächsten Ziels läuft er wieder los.
     * @param {number} index
     */
    async function playCompletion(/** @type {number} */ index) {
        const token = ++transitionToken;
        transitioning = true;

        try {
            await runCompletion(index);
        } catch (err) {
            reportError('Zielübergang', err);
        } finally {
            // Immer freigeben, um das dauerhafte Einfrieren vom Zähler
            // zu vermeiden, wenn Delta schon auf 0 steht.
            transitioning = false;

            if (token === transitionToken) {
                root.classList.remove('flash', 'glitch', 'boost');
                el.goalRow.classList.remove('complete');
                el.progress.classList.remove('overcharge', 'recharge');
                el.banner.classList.remove('show');
            }
        }
    }

    /**
     * Der eigentliche Übergang; {@link transitioning} wird vom Aufrufer in jedem
     * Fall wieder freigegeben.
     * @param {number} index
     */
    async function runCompletion(/** @type {number} */ index) {
        const head = barHead(1);
        const center = localRect(el.content);

        root.classList.add('flash', 'boost');
        el.goalRow.classList.add('complete');
        el.progress.classList.add('overcharge');

        fxFront.excite(1);
        fxBack.excite(1);

        el.bannerText.textContent = 'Ziel erreicht';
        el.banner.classList.remove('show');
        void el.banner.offsetWidth;
        el.banner.classList.add('show');

        await wait(340);

        fxFront.ring(head.x, head.y, { maxRadius: 240, duration: 1.1, width: 2.5, color: MINT[0], squash: 0.55 });
        fxFront.ring(head.x, head.y, { maxRadius: 150, duration: 0.8, width: 1.5, color: ACCENT[0], squash: 0.5 });
        fxFront.burst(head.x, head.y, {
            count: 50,
            colors: [...MINT, ...ACCENT],
            speed: [50, 330],
            life: [0.4, 1.6],
            spread: Math.PI * 2,
            gravity: -18,
            size: [0.9, 2.8],
        });
        fxBack.burst(head.x, head.y, {
            count: 22,
            colors: MINT,
            speed: [20, 120],
            life: [0.8, 1.8],
            gravity: -22,
        });

        root.classList.add('glitch');

        await wait(550);

        // Nächstes Ziel rückt nach, der Zähler wird wieder freigegeben
        crossed = Math.max(crossed, index + 1);
        el.progress.classList.add('instant');
        renderGoalRows({ promote: true });
        updateProgress();

        fxFront.burst(center.x + center.width * 0.5, center.y + center.height * 0.45, {
            count: 26,
            colors: [...MINT, ACCENT[2]],
            speed: [30, 180],
            life: [0.3, 1.1],
            gravity: -10,
        });

        await wait(60);
        el.progress.classList.remove('instant');
        el.progress.classList.add('recharge');

        await wait(900);
    }

    // ------- Ticker/Zähler -------

    /**
     * Obergrenze für den angezeigten Zähler.
     * Der echte Punktestand begrenzt auf das aktuelle Ziel.
     * @returns {number}
     */
    function displayTarget() {
        const index = activeIndex();
        if (index < 0) {
            return points;
        }

        return Math.min(points, goals[index].points);
    }

    function stepCounter(/** @type {number} */ now) {
        const dt = Math.min(0.05, (now - lastFrame) / 1000 || 0.016);
        lastFrame = now;

        if (!transitioning) {
            const target = displayTarget();
            const diff = target - displayed;
            let stageChanged = false;

            if (diff !== 0) {
                // weiche Annäherung, aber mit Mindesttempo
                const ease = diff * (1 - Math.exp(-3.4 * dt));
                // Das Mindesttempo vermeidet das langsame Auffüllen am Ende.
                const minStep = MIN_COUNTER_SPEED * dt;
                const step = Math.abs(ease) >= minStep ? ease
                    : (diff > 0 ? Math.min(diff, minStep) : Math.max(diff, -minStep));
                const snapped = Math.abs(diff) <= 0.75 
                    // Bei geringer FPS (kleiner 53) kann diff über 0.75 sein,
                    // obwohl wir schon am Ende sind.
                    || Math.abs(step) >= Math.abs(diff);

                displayed = snapped ? target : displayed + step;
                updateCounter();
                updateProgress();

                if (deltaVisible) {
                    // Delta wird sichtbar konsumiert
                    const remaining = points - displayed;
                    el.delta.textContent = `${remaining >= 0 ? '+' : '−'}${format(Math.abs(remaining))}`;
                    el.delta.classList.toggle('neg', remaining < 0);
                }

                if (snapped && displayed === points) {
                    pendingDelta = 0;
                    hideDelta();

                    const settled = countCompleted(displayed);
                    if (settled !== crossed) {
                        crossed = settled;
                        stageChanged = true;
                    }
                }
            }

            // Stufe hat sich ohne Übergang geändert (z. B. Punkte zurückgenommen)
            if (activeIndex() !== renderedIndex) {
                renderGoalRows();
                stageChanged = true;
            }

            if (stageChanged) {
                updateProgress();
            }

            // Am Rand des aktuellen Zieles angekommen und der echte Stand liegt
            // darüber (oder darauf): Übergang zeigen, danach weiter auffüllen.
            const index = activeIndex();
            if (index >= 0 && points >= goals[index].points && displayed >= goals[index].points - 1e-6) {
                void playCompletion(index);
            }

            // Automatische Korrektur, sollte aus irgendeinem Grund
            // der Delta noch zu sehen sein.
            if (deltaVisible && displayed === points) {
                pendingDelta = 0;
                hideDelta();
            }
        }
    }

    /**
     * Ein Frame des Zähler-Ticks. Der Nachschub läuft in jedem Fall weiter -
     * sonst würde eine einzige Ausnahme die Anzeige für immer einfrieren.
     * @param {number} now
     */
    function tick(/** @type {number} */ now) {
        try {
            stepCounter(now);
        } catch (err) {
            reportError('Zähler-Tick', err);
        }

        requestAnimationFrame(tick);
    }

    // ------- Idle-Lebenszeichen -------

    function startIdlePing() {
        setTimeout(/** @type {() => void} */ function ping() {
            if (!root.classList.contains('waiting') && !transitioning) {
                const head = barHead(progressRatio(displayed, activeIndex()));

                el.progress.classList.remove('wave');
                el.progress.classList.remove('wave-soft');
                void el.progress.offsetWidth;
                el.progress.classList.add('wave-soft');

                fxBack.ring(head.x, head.y, { maxRadius: 70, duration: 1.5, width: 1, color: MINT[0], squash: 0.4 });
                fxBack.burst(head.x, head.y, {
                    count: 4,
                    colors: MINT,
                    speed: [10, 45],
                    life: [0.8, 1.7],
                    gravity: -16,
                });
            }

            setTimeout(ping, 6500 + Math.random() * 6000);
        }, 5000 + Math.random() * 5000);
    }

    fxBack.start();
    fxFront.start();
    updateCounter();
    renderGoalRows();
    updateProgress();
    startIdlePing();
    requestAnimationFrame(tick);

    window.addEventListener('resize', () => {
        fxBack.resize();
        fxFront.resize();
        scheduleMarquee();
    });

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            return;
        }
        
        // rAF wird pausiert, solange die Seite nicht gerendert wird
        lastFrame = performance.now();

        if (displayed === points) {
            hideDelta();
        }
    });

    // ------- Public API -------

    return {
        setPoints,
        getPoints: () => points,
        getCompleted: () => completed(),

        /**
         * @param {GoalEntry[]} nextGoals
         */
        setGoals(/** @type {GoalEntry[]} */ nextGoals) {
            const previousPoints = points;
            const lastGoal = goals[goals.length - 1];
            if (lastGoal && lastGoal.points < previousPoints) {
                points = lastGoal.points;
                displayed = lastGoal.points;
                updateCounter();
            }

            goals = nextGoals.map((goal) => ({
                points: Number(goal.points),
                title: String(goal.title ?? ''),
                description: String(goal.description ?? ''),
            })).sort((a, b) => a.points - b.points);

            syncStage();
            renderGoalRows();
            updateProgress();

            setPoints(previousPoints);
        },

        /** Signalisiert fehlende Daten. */
        setWaiting(/** @type {boolean} */ waiting) {
            root.classList.toggle('waiting', waiting);
            if (waiting) {
                el.total.textContent = '-';
                el.activeTitle.textContent = 'Bitte warten';
                el.activeDesc.textContent = 'Punktestand und Ziele werden abgerufen...';
                el.status.textContent = 'startet';

                displayed = 0;
                points = 0;
                crossed = 0;
                transitioning = false;
                transitionToken++;
                hideDelta();

                root.classList.remove('flash', 'glitch', 'boost');
                el.goalRow.classList.remove('complete');
                el.progress.classList.remove('overcharge', 'recharge');
                el.banner.classList.remove('show');
            }
        },

        /** Startpunkt ohne Animation setzen. */
        setPointsImmediate(/** @type {number} */ value) {
            points = value;
            displayed = value;
            pendingDelta = 0;
            syncStage();
            hideDelta();
            updateCounter();
            renderGoalRows();
            updateProgress();
        },

        /**
         * Hilfsfunktion um Punktestand festzulegen, um das Design zu testen.
         * @param {number} value
         */
        debugAtGoalLine(/** @type {number} */ value) {
            points = value;
            displayed = value;
            syncStage();
            updateCounter();
            renderGoalRows();
            updateProgress();
        },
    };
}
