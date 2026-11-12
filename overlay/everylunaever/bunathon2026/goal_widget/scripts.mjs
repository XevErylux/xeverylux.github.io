/// @ts-check
/// <reference path="./index.d.ts" />

import * as crypto from "../../../../shared/turso/crypto.mjs";
import {
    TursoError,
    createBasketReader,
    createGoalsReader,
    createTursoClient,
} from "../../../../shared/turso/client.mjs";
import { createGoalWidget } from "./widget.mjs";

'use strict';

const config = await (async function () {
    const response = await fetch('./config.json', {
        method: 'GET',
        // Ignoriere den Festplattencache und nutze nur die "304 Not Modified" Antwort
        cache: 'no-cache',
    });
    const json = await response.json();
    return /** @type {EncryptedConfig} */(json);
})();

const isDevelopment = location.host === '127.0.0.1:5500';

const parameters = new URLSearchParams(location.search);

/**
 * Aktiviere die Nutzung der debug-*.json Dateien, um das Widget 
 * besser testen zu können.
 */
const useDebugData = parameters.get('debug') === '1';

const settings = {
    // Ein C#-Programm hält den "points"-Korb aktuell.
    // Ohne Änderung, verwendet jede Abfrage nur eine Zeile aus dem Index.
    pointsFetchInterval: useDebugData ? 1000 : 15000,
    // Die Zieletabelle ändert sich nur, wenn das Team es im Dashboard ändert.
    goalsFetchInterval: useDebugData ? 5000 : 60000,
};

/** @param {number} ms */
async function wait(/** @type {number} */ ms) {
    return new Promise(function (resolve) {
        setTimeout(resolve, ms);
    });
}

async function pageAutoRefresh() {
    // Möglichkeit das Widget zu aktualisieren ohne den Stream zu unterbrechen
    let previousText = '';
    let previousEtag = '';
    while (true) {
        await wait(isDevelopment ? 1000 : 60000);

        try {
            const response = await fetch("./version.json", {
                method: 'GET',
                // Ignoriere den Festplattencache und nutze nur die "304 Not Modified" Antwort
                cache: 'no-cache',
            });
            if (!response.ok)
                continue;

            const newEtag = response.headers.get('ETag');
            if (previousEtag === newEtag)
                continue;

            previousEtag = newEtag ?? '';
            const newConfig = await response.json();
            const newText = JSON.stringify(newConfig);
            if (newText === previousText)
                continue;

            // Version geändert => Seite aktualisieren
            if (previousText === '') {
                previousText = newText;
                continue;
            }

            previousText = newText;
            window.location.replace(document.location.toString());
        } catch (err) {
            console.error("pageAutoRefresh", err);
            continue;
        }
    }
};

pageAutoRefresh();

async function tryLoadKeyFromSearch() {
    const base64 = new URLSearchParams(location.search).get('key');
    if (!base64 || base64.length < 43 || base64.length > 44)
        return;

    try {
        return await crypto.importKey(base64);
    } catch {

    }
}


/**
 * @param {unknown} content
 * @returns {number}
 */
function readTotal(/** @type {unknown} */ content) {
    const total = content && typeof content === 'object'
        ? /** @type {{ total?: unknown }} */(content).total
        : undefined;

    if (typeof total !== 'number' || !Number.isFinite(total)) {
        throw new TursoError(
            `Der Korb "points" enthält keine Zahl in "total": ${JSON.stringify(content)?.substring(0, 200)}`);
    }

    return total;
}

/**
 * Erstellt den Datenbankzugriff zur Turso-Datenbank.
 * Der Schlüssel wird für die config.json verwendet, um die URL und den Token zu erhalten.
 *
 * @param {CryptoKey} key
 * @returns {Promise<DataAccess>}
 */
async function createTursoDataAccess(
    /** @type {CryptoKey} */ key) {
    const connectionInfo = await crypto.decryptConnectionInfo(config.encryptedConnectionInfo, key);

    const turso = createTursoClient(connectionInfo);
    const pointsReader = createBasketReader(turso, 'points');
    const goalsReader = createGoalsReader(turso);

    return {
        async readPoints() {
            const basket = await pointsReader.read();
            if (!basket)
                // Punktestand unverändert
                return null;

            return readTotal(basket.content);
        },
        readGoals: () => goalsReader.read(),
        readGoalsNow: () => goalsReader.readNow(),
    };
}

/** @returns {Promise<Goal[]>} */
async function readDebugGoals() {
    const response = await fetch('./debug-goals.json', { cache: 'no-cache' });
    if (!response.ok)
        throw new Error(`debug-goals.json: HTTP ${response.status}`);

    /** @type {{ points: string | number, title: string, description?: string }[]} */
    const raw = await response.json();

    return raw.map((goal, index) => /** @type {Goal} */({
        id: index + 1,
        points: Number(goal.points),
        title: goal.title ?? '',
        description: goal.description ?? '',
        written_at: '',
    }));
}

/**
 * @returns {Promise<DataAccess>}
 */
async function createDebugDataAccess() {
    /** @type {number | null} */
    let lastTotal = null;
    let lastGoalsText = '';

    return {
        async readPoints() {
            const response = await fetch('./debug-points.json', { cache: 'no-cache' });
            if (!response.ok)
                throw new Error(`debug-points.json: HTTP ${response.status}`);

            const total = readTotal(await response.json());
            if (total === lastTotal)
                return null;

            lastTotal = total;
            return total;
        },

        async readGoals() {
            const goals = await readDebugGoals();
            const text = JSON.stringify(goals);
            if (text === lastGoalsText)
                return null;

            lastGoalsText = text;
            return goals;
        },

        async readGoalsNow() {
            const goals = await readDebugGoals();
            lastGoalsText = JSON.stringify(goals);
            return goals;
        },
    };
}

const widgetRoot = /** @type {HTMLElement} */(document.getElementById('widget'));
const titleElement = /** @type {HTMLSpanElement} */(document.getElementById('active-title'));
const descElement = /** @type {HTMLSpanElement} */(document.getElementById('active-desc'));
const statusElement = /** @type {HTMLSpanElement} */(document.getElementById('status-value'));

const widget = createGoalWidget(widgetRoot);

/** Für den Zustand solange wir keine Daten haben */
let havePoints = false;

/**
 * Ändert den Status abhängig von der Erreichbarkeit von Turso.
 */
function setOnline(/** @type {boolean} */ online) {
    widgetRoot.classList.toggle('offline', !online);
    statusElement.textContent = online ? 'live' : 'offline';
}

/**
 * Melde Verbindungsprobleme zu Turso.
 *
 * @param {string} title
 * @param {string} message
 */
function showMessage(
    /** @type {string} */ title,
    /** @type {string} */ message) {
    console.error(title, message);

    widgetRoot.classList.add('waiting', 'offline');
    titleElement.textContent = title;
    descElement.textContent = '';
    statusElement.textContent = 'Fehler';

    // Protokolliere die Nachricht nur, da wir nicht wissen
    // welche Nachrichten von Turso sonst live zu sehen sind.
    console.error("showMessage", title, message);
}

/**
 * @param {Goal[]} goals
 */
function applyGoals(/** @type {Goal[]} */ goals) {
    if (goals.length === 0) {
        console.warn("Die goals-Tabelle ist leer - das letzte bekannte Ziel bleibt sichtbar.");
        return;
    }

    widget.setGoals(goals.map(goal => ({
        points: goal.points,
        title: goal.title,
        description: goal.description,
    })));
}

/**
 * @param {number} total
 * @param {boolean} [immediate] Deaktiviert die Zähleranimation (z. B. für den ersten Wert)
 */
function applyPoints(
    /** @type {number} */ total,
    /** @type {boolean | undefined} */ immediate
) {
    if (immediate) {
        widget.setPointsImmediate(total);
    } else {
        widget.setPoints(total);
    }

    havePoints = true;
    widget.setWaiting(false);
}

/**
 * @param {DataAccess} data
 * @returns {Promise<boolean>} Bei false muss die Schleife gestoppt werden (z. B. Token abgelaufen)
 */
async function refreshPoints(/** @type {DataAccess} */ data) {
    try {
        let total = await data.readPoints();
        if (total !== null)
        {
            total = Math.floor(total);
            applyPoints(total, !havePoints);
        }

        setOnline(true);
        return true;
    } catch (err) {
        console.error("Punktestand", err);
        setOnline(false);

        if (err instanceof TursoError && err.unrecoverable) {
            showMessage('Datenbank', err.message);
            return false;
        }

        return true;
    }
}

/**
 * @param {DataAccess} data
 * @returns {Promise<boolean>} Bei false muss die Schleife gestoppt werden (z. B. Token abgelaufen)
 */
async function refreshGoals(/** @type {DataAccess} */ data) {
    try {
        const goals = await data.readGoals();
        if (goals !== null)
            applyGoals(goals);

        setOnline(true);
        return true;
    } catch (err) {
        console.error("Ziele", err);
        setOnline(false);

        if (err instanceof TursoError && err.unrecoverable) {
            showMessage('Datenbank', err.message);
            return false;
        }

        return true;
    }
}

async function main() {
    // Verwende Wartemodus, um nicht falsche Daten anzuzeigen während wir laden
    widget.setWaiting(true);

    const key = await tryLoadKeyFromSearch();
    if (!key && !useDebugData) {
        showMessage('Kein Schlüssel', 'Das Widget braucht ?key=... in der URL, sonst sind die Zugangsdaten unlesbar.');
        return;
    }

    /** @type {DataAccess} */
    let data;
    try {
        data = useDebugData
            ? await createDebugDataAccess()
            : await createTursoDataAccess(/** @type {CryptoKey} */(key));
    } catch (err) {
        console.error("Data access setup failed", err);

        // Die DOMException aus AES-GCM Entschlüsselung hat keine eigene Nachricht.
        const message = err instanceof Error && err.message
            ? err.message
            : 'Die verschlüsselten Verbindungsinformationen aus config.json passen nicht zum Schlüssel.';
        showMessage('Verbindung', message);
        return;
    }

    void (async function goalsLoop() {
        while (true) {
            if (!await refreshGoals(data))
                return;

            await wait(settings.goalsFetchInterval);
        }
    })();

    void (async function pointsLoop() {
        while (true) {
            if (!await refreshPoints(data))
                return;

            await wait(settings.pointsFetchInterval);
        }
    })();
}

await main();
