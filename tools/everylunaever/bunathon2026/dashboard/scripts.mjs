/// @ts-check
/// <reference path="./index.d.ts" />
/// <reference path="./globals.d.ts" />

import * as crypto from "../../../../shared/turso/crypto.mjs";
import {
    TursoError,
    createTursoClient,
    createBasketReader,
    createGoalsReader,
} from "../../../../shared/turso/client.mjs";

'use strict';

const config = await (async function () {
    const response = await fetch('./config.json', {
        method: 'GET',
        // Ignore the disk cache and rely on the 304 Not Modified response
        cache: 'no-cache',
    });
    const json = await response.json();
    return /** @type {EncryptedConfig} */(json);
})();

const isDevelopment = location.host === '127.0.0.1:5500';

function unreachable(/** @type {never} */ never) {
    return new Error(`Hit unreachable value: ${never}`);
}

async function wait(/** @type {number} */ ms) {
    return new Promise(function (resolve) {
        setTimeout(resolve, ms);
    });
}

async function pageAutoRefresh() {
    // Automatic reload of page - checks config every minute
    let previousText = '';
    let previousEtag = '';
    while (true) {
        await wait(isDevelopment ? 6000 : 60000);

        try {
            const response = await fetch("./version.json", {
                method: 'GET',
                // Ignore the disk cache and rely on the 304 Not Modified response
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

            // Config changed - refresh page
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

async function tryLoadKeyFromLocalStorage() {
    return localStorage.getItem('bunathon2026-dashboard-key');
}

async function tryLoadKeyFromSearch() {
    const base64 = new URLSearchParams(location.search).get('key')
        ?? await tryLoadKeyFromLocalStorage();
    if (!base64 || base64.length < 43 || base64.length > 44)
        return;

    try {
        const imported = await crypto.importKey(base64);
        localStorage.setItem('bunathon2026-dashboard-key', base64);
        if (location.search !== '') {
            const url = location.toString();
            location.replace(url.substring(0, url.indexOf('?')) + location.hash);
        }
        return imported;
    } catch {

    }
}

/**
 * The supporter names cannot be decrypted with this page's key. The basket was then
 * written with a different key than the one encrypted in config.json - that is a
 * configuration error, not a network problem.
 */
class SupporterDecryptError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = 'SupporterDecryptError';
    }
}

/** @returns {Promise<Record<string, string>>} */
async function decryptSupporters(
        /** @type {CryptoKey} */ key,
        /** @type {string} */ encryptedSupporters) {
    try {
        const plaintext = await crypto.decrypt(encryptedSupporters, key);
        return /** @type {Record<string, string>} */(JSON.parse(plaintext));
    } catch (err) {
        throw new SupporterDecryptError(
            `Die Unterstützer-Namen des Korbes passen nicht zum Schlüssel dieser Seite - `
            + `vermutlich schreibt das C#-Programm mit einem anderen Schlüssel als config.json verschlüsselt ist (${err instanceof Error ? err.message : err})`);
    }
}

/**
 * The dashboard's data access: read both json_basket keys and decrypt the supporter
 * names. `turso` is additionally there for custom queries, for example for editing the
 * goals later on.
 *
 * @param {CryptoKey} key
 * @returns {Promise<DataAccess>}
 */
async function createDataAccess(key) {
    // We want neither the URL nor the read token publicly in the repo. Both are stored
    // encrypted in config.json and only unlock with the page's ?key=...
    // (crypto.importKey). The C# program writes with its own token (writer.json).
    const connectionInfo = await crypto.decryptConnectionInfo(config.encryptedConnectionInfo, key);

    const turso = createTursoClient(connectionInfo);
    const liveReader = createBasketReader(turso, 'dashboard-live');
    const detailsReader = createBasketReader(turso, 'dashboard-details');
    const goalsReader = createGoalsReader(turso);

    function applyLiveSupporters(
        /** @type {Record<string, string>} */ supporters,
        /** @type {DecryptedDashboardLiveJson} */ json) {
        for (const event of json.events) {
            event.supporter = supporters[event.supporter] || '';
        }
        for (const leaderboard of Object.values(json.leaderboards)) {
            for (const place of Object.values(leaderboard)) {
                if (place) {
                    place.supporter = supporters[place.supporter] || '';
                }
            }
        }
    }

    function applyDetailsSupporters(
        /** @type {Record<string, string>} */ supporters,
        /** @type {DecryptedDashboardDetailsJson} */ json) {
        for (const entry of json.subbombsPerUser) {
            entry.supporter = supporters[entry.supporter] || '';
        }
        for (const entry of json.selfsubsPerUser) {
            entry.supporter = supporters[entry.supporter] || '';
        }
        for (const entry of json.individualsubsPerUser) {
            entry.supporter = supporters[entry.supporter] || '';
        }
        for (const entry of json.subgiftsPerUser) {
            entry.supporter = supporters[entry.supporter] || '';
        }
        for (const event of json.bitsPerUser) {
            event.supporter = supporters[event.supporter] || '';
        }
        for (const event of json.donationsPerUser) {
            event.supporter = supporters[event.supporter] || '';
        }
    }

    /**
     * @returns {Promise<DecryptedDashboardLiveJson | null>} null if unchanged
     */
    async function readLive() {
        const basket = await liveReader.read();
        if (!basket)
            return null;

        const encrypted = /** @type {EncryptedDashboardLiveJson} */(basket.content);

        // If a basket ever contains no encrypted names (encryptedSupporters empty),
        // the plain names are used straight from the document.
        const supporters = encrypted.encryptedSupporters
            ? await decryptSupporters(key, encrypted.encryptedSupporters)
            : /** @type {Record<string, string>} */(encrypted.supporters ?? {});
        const result = /** @type {DecryptedDashboardLiveJson} */(encrypted);
        delete /** @type {Record<string, unknown>} */(result)['encryptedSupporters'];
        delete /** @type {Record<string, unknown>} */(result)['supporters'];
        applyLiveSupporters(supporters, result);
        return result;
    }

    /**
     * @returns {Promise<DecryptedDashboardDetailsJson | null>} null if unchanged
     */
    async function readDetails() {
        const basket = await detailsReader.read();
        if (!basket)
            return null;

        const encrypted = /** @type {EncryptedDashboardDetailsJson} */(basket.content);

        const supporters = encrypted.encryptedSupporters
            ? await decryptSupporters(key, encrypted.encryptedSupporters)
            : /** @type {Record<string, string>} */(encrypted.supporters ?? {});
        const result = /** @type {DecryptedDashboardDetailsJson} */(encrypted);
        delete /** @type {Record<string, unknown>} */(result)['encryptedSupporters'];
        delete /** @type {Record<string, unknown>} */(result)['supporters'];
        applyDetailsSupporters(supporters, result);
        return result;
    }

    return {
        turso,
        readLive,
        readDetails,
        invalidateDetails: () => detailsReader.invalidate(),
        readGoals: () => goalsReader.read(),
        readGoalsNow: () => goalsReader.readNow(),
    };
}

function trySetTextContentIfChanged(
        /** @type {Element | null} */ element,
        /** @type {string} */ text
) {
    if (!element || element.textContent === text)
        return;

    element.textContent = text;
}

/**
 * @type {{<K extends keyof HTMLElementTagNameMap>(elementId: string, qualifiedName: K): HTMLElementTagNameMap[K] | null}} 
 * */
function getElementById(elementId, qualifiedName) {
    const element = document.getElementById(elementId);
    if (!element) return null;

    if (element.tagName !== qualifiedName.toUpperCase())
        return null;

    return /** @type {HTMLElementTagNameMap[typeof qualifiedName]} */(element);
}

const settings = {
    fetchInterval: 15000,
    // The goals table changes only when the team edits it, so a minute is enough -
    // opening the goal editor refreshes it immediately (see openSubpageClicked).
    goalsFetchInterval: 60000,
};

/** @type {(<TItem extends { supporter: string }>(array: TItem[], item: TItem) => void)} */
function addSortedBySupporter(array, item) {
    let low = 0;
    let high = array.length;

    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        const cmp = array[mid].supporter.localeCompare(item.supporter);

        if (cmp <= 0) {
            // <= means, we will go right ways and this causes to exit after existing entries
            low = mid + 1;
        } else {
            high = mid;
        }
    }

    array.splice(low, 0, item);
}

/**
 * @param {"SUBSCRIPTION1" | "SUBSCRIPTION2" | "SUBSCRIPTION3"} type
 */
function subscriptionToTier(type) {
    switch (type) {
        case "SUBSCRIPTION1": return "tier1";
        case "SUBSCRIPTION2": return "tier2";
        case "SUBSCRIPTION3": return "tier3";
        default: throw unreachable(type);
    }
};

/**
 * @param {"SUBSCRIPTION1" | "SUBSCRIPTION2" | "SUBSCRIPTION3"} type
 */
function subscriptionToTierNumber(type) {
    switch (type) {
        case "SUBSCRIPTION1": return 1;
        case "SUBSCRIPTION2": return 2;
        case "SUBSCRIPTION3": return 3;
        default: throw unreachable(type);
    }
};

function flipSortDirection(/** @type {SortDirection} */ dir) {
    switch (dir) {
        case "ASC": return "DESC";
        case "DESC": return "ASC";
        default: throw unreachable(dir);
    }
}

/** @returns {HTMLTableCellElement | null} */
function getTableCell(
    /** @type {HTMLTableRowElement} */ row,
    /** @type {string} */ className
) {
    return row.querySelector(`td.${className}`);
}

const app = await (async function () {

    const key = await tryLoadKeyFromSearch();
    if (!key) {
        loadingState.innerText = "Invalid key";
        return;
    }

    /** @type {DataAccess} */
    let data;
    try {
        data = await createDataAccess(key);
    } catch (err) {
        console.error("Data access setup failed", err);
        loadingState.innerText = err instanceof TursoError
            ? `Turso-Datenbank nicht erreichbar: ${err.message}`
            : "Die verschlüsselten Verbindungsinformationen aus config.json passen nicht zum Schlüssel.";
        return;
    }

    let model = (/** @returns {UIModel} */ function () {
        return {
            nextDetailsUpdate: null,
            live: null,
            details: null,
            goals: null,
            nextGoalsUpdate: null,
        };
    })();


    const leaderboardsJsonToCellMapping = (/** @returns {Record<keyof DecryptedDashboardLiveJson['leaderboards'], Record<keyof LeaderboardGroup, string>>} */function () {
        function buildGroup(/** @type {string} */ prefix) {
            return {
                top1: `${prefix}-1`,
                top2: `${prefix}-2`,
                top3: `${prefix}-3`,
            };
        }

        return {
            "donators": buildGroup('donor'),
            "subGifters": buildGroup('gifter'),
            "bitsCheers": buildGroup('bits'),
            "overallSupporters": buildGroup('supporter'),
        };
    })();

    function formatTimestamp(
        /** @type {Date} */ today,
        /** @type {string} */ timestampStr) {

        const date = new Date(timestampStr);
        if (today < date)
            return date.toLocaleTimeString();

        return `${date.getDate().toLocaleString(undefined, { minimumIntegerDigits: 2 })}.${date.getMonth() + 1}. ${date.toLocaleTimeString()}`;
    }

    function formatCategory(/** @type {DashboardEvent['category']} */ category) {
        switch (category) {
            case 'BITS': return 'Bits';
            case 'DONATION': return 'Dono';
            case 'SUBSCRIPTION1': return 'T1 Sub';
            case 'SUBSCRIPTION2': return 'T2 Sub';
            case 'SUBSCRIPTION3': return 'T3 Sub';
            default:
                throw unreachable(category);
        }
    }

    /**
     * @param {number | undefined} points
     */
    function formatPoints(points) {
        return points?.toLocaleString(undefined, { minimumFractionDigits: 3 }) ?? ''
    }

    function buildTableColumnSorter(
        /** @type {SortColumn[]} */ sortings
    ) {
        return function (
            /** @type {{ rowCells: { [x: string]: { sortValue: string | number; }; }; }} */ a,
            /** @type {{ rowCells: { [x: string]: { sortValue: string | number; }; }; }} */ b) {
            for (const { name, direction } of sortings) {
                const aVal = a.rowCells[name]?.sortValue;
                const bVal = b.rowCells[name]?.sortValue;

                // Missing values are always smaller
                if (aVal == null && bVal == null) continue;
                if (aVal == null) return direction === 'ASC' ? -1 : 1;
                if (bVal == null) return direction === 'ASC' ? 1 : -1;

                // Compare: numbers or strings
                let cmp = 0;
                if (typeof aVal === 'number' && typeof bVal === 'number') {
                    cmp = aVal - bVal;
                } else {
                    cmp = String(aVal).localeCompare(String(bVal));
                }

                if (cmp !== 0) {
                    return direction === 'ASC' ? cmp : -cmp;
                }
            }
            return 0; // all columns are same
        };
    }

    /**
     * @template T
     * @param {SortColumn[] | undefined} sortings
     * @param {T[]} rows
     * @param {{ (row: T): string; }} buildKey
     * @param {HTMLTemplateElement} rowTemplate
     * @param {HTMLTableSectionElement} targetTableBody
     * @param {(row: T) => Record<string, { text: string | ((index: number) => string), sortValue: string | number }>} buildRowCells
     */
    function renderTable(
        sortings,
        rows,
        buildKey,
        rowTemplate,
        targetTableBody,
        buildRowCells
    ) {
        let entries = rows.map((row) => ({
            rowCells: buildRowCells(row),
            key: buildKey(row),
        }));
        if (sortings) {
            entries.sort(
                buildTableColumnSorter(sortings)
            );
        }

        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const key = entry.key;
            let element = /** @type {HTMLTableRowElement | undefined} */(targetTableBody.children[i]);
            if (!element) {
                const result = /** @type {Element} */(rowTemplate.content.cloneNode(true));
                if (!(result.firstElementChild instanceof HTMLTableRowElement))
                    continue;

                element = result.firstElementChild;
                targetTableBody.appendChild(element);
                element.setAttribute('data-key', key);
            }
            else if (element.getAttribute('data-key') !== key) {
                const result = /** @type {Element} */(rowTemplate.content.cloneNode(true));
                if (!(result.firstElementChild instanceof HTMLTableRowElement))
                    continue;

                const newElement = result.firstElementChild;
                targetTableBody.insertBefore(newElement, element);
                element = newElement;
                element.setAttribute('data-key', key);
            }

            const rowCells = entry.rowCells;
            for (const rowCellName of Object.keys(rowCells)) {
                const rowCellValue = rowCells[rowCellName];
                trySetTextContentIfChanged(
                    getTableCell(element, rowCellName),
                    typeof rowCellValue.text === "function"
                        ? rowCellValue.text(i)
                        : rowCellValue.text
                );
            }
        }

        for (let i = targetTableBody.children.length - 1; i >= rows.length; i--) {
            targetTableBody.removeChild(targetTableBody.children[i]);
        }
    }

    function renderEvents(/** @type {DashboardEvents} */ events) {
        const eventRowTemplate = getElementById('event-row-template', 'template');
        if (!eventRowTemplate)
            return;

        const eventsTableBody = getElementById('event-table-body', 'tbody');
        if (!eventsTableBody)
            return;

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        renderTable(
            undefined,
            events,
            event => `${event.timestamp}-${event.supporter}-${event.category}`,
            eventRowTemplate,
            eventsTableBody,
            event => ({
                'timestamp': {
                    text: formatTimestamp(today, event.timestamp),
                    sortValue: new Date(event.timestamp).getTime(),
                },
                'supporter': {
                    text: event.supporter,
                    sortValue: event.supporter,
                },
                'category': {
                    text: formatCategory(event.category),
                    sortValue: formatCategory(event.category),
                },
                'amount': {
                    text: `${event.amount}`,
                    sortValue: event.amount,
                },
                'points': {
                    text: formatPoints(event.points),
                    sortValue: event.points,
                },
            })
        );
    }

    /**
     * -------------------------------------------------------------------
     * Ziele (goals table in Turso)
     *
     * The main page shows the total points (from the live basket) and the goal that is
     * currently open; the "Ziele bearbeiten" subpage edits the goals table. That table is
     * the one place the team maintains, so every write is guarded by the written_at the
     * row had when it was loaded (see docs/Turso/queries.sql: /v2/pipeline has no
     * transactions on this server, so optimistic guards plus a check afterwards is the
     * best that is possible).
     * -------------------------------------------------------------------
     */

    /** @type {Record<GoalState, string>} */
    const goalStateLabels = {
        'completed': '✅',
        'active': '🎯',
        'upcoming': '⏳',
    };

    /** @type {('points' | 'title' | 'description')[]} */
    const goalFieldNames = ['points', 'title', 'description'];

    /** @type {GoalsEditor | null} */
    let goalsEditor = null;
    let newGoalCounter = 0;

    /**
     * completed = Schwelle erreicht, active = erstes noch offenes Ziel, upcoming = dahinter.
     * @param {GoalContent[]} goals ascending by points - that is how the goals table arrives
     * @param {number | null} totalPoints
     * @returns {GoalState[]}
     */
    function determineGoalStates(
        /** @type {GoalContent[]} */ goals,
        /** @type {number | null} */ totalPoints) {

        if (totalPoints == null)
            return goals.map(() => /** @type {GoalState} */('upcoming'));

        const activeIndex = goals.findIndex(goal => goal.points > totalPoints);
        return goals.map((goal, index) => goal.points <= totalPoints
            ? /** @type {GoalState} */('completed')
            : index === activeIndex
                ? /** @type {GoalState} */('active')
                : /** @type {GoalState} */('upcoming'));
    }

    /**
     * The total points arrive as Postgres numeric (1410.90800000000000000000), so they are
     * displayed rounded instead of with all carried digits.
     * @param {number | null | undefined} points
     */
    function formatPointsValue(
        /** @type {number | null | undefined} */ points) {

        return points == null
            ? ''
            : Math.floor(points).toLocaleString();
    }

    /**
     * @param {GoalContent} a
     * @param {GoalContent} b
     */
    function sameGoalContent(
        /** @type {GoalContent} */ a,
        /** @type {GoalContent} */ b) {

        return a.points === b.points && a.title === b.title && a.description === b.description;
    }

    /**
     * @param {GoalContent} from
     * @param {GoalContent} to
     * @returns {string}
     */
    function describeGoalDifference(
        /** @type {GoalContent} */ from,
        /** @type {GoalContent} */ to) {

        /** @type {string[]} */
        const parts = [];
        if (from.points !== to.points)
            parts.push(`Punkte ${formatPointsValue(from.points)} → ${formatPointsValue(to.points)}`);
        if (from.title !== to.title)
            parts.push(`Titel „${from.title}“ → „${to.title}“`);
        if (from.description !== to.description)
            parts.push(`Beschreibung „${from.description}“ → „${to.description}“`);

        return parts.join(', ');
    }

    /**
     * What happened to the table between two reads - used for the "changed elsewhere"
     * hint while somebody is editing.
     * @param {Goal[]} previous
     * @param {Goal[]} current
     * @returns {string[]}
     */
    function describeGoalTableChanges(
        /** @type {Goal[]} */ previous,
        /** @type {Goal[]} */ current) {

        /** @type {string[]} */
        const lines = [];
        const previousById = new Map(previous.map(goal => /** @type {[number, Goal]} */([goal.id, goal])));
        const currentIds = new Set(current.map(goal => goal.id));

        for (const goal of current) {
            const before = previousById.get(goal.id);
            if (!before)
                lines.push(`neu angelegt: „${goal.title}“ (${formatPointsValue(goal.points)} Punkte)`);
            else if (!sameGoalContent(goal, before))
                lines.push(`geändert: „${goal.title}“ (#${goal.id}) - ${describeGoalDifference(before, goal)}`);
        }
        for (const goal of previous) {
            if (!currentIds.has(goal.id))
                lines.push(`gelöscht: „${goal.title}“ (${formatPointsValue(goal.points)} Punkte)`);
        }

        return lines;
    }

    /**
     * The card on the main page: total points plus the open goal and its progress.
     * If every goal is done, the last (highest) one is shown as the reached one.
     */
    function renderGoalSummary() {
        trySetTextContentIfChanged(
            getElementById('total-points-count', 'p'),
            formatPointsValue(model.live?.totalPoints));

        const titleElement = getElementById('active-goal-title', 'span');
        const descriptionElement = getElementById('active-goal-description', 'span');
        const progressFill = getElementById('active-goal-progress-fill', 'span');
        const progressTextElement = getElementById('active-goal-progress-text', 'p');

        /** @param {string} title @param {string} state */
        function clearDetails(/** @type {string} */ title, /** @type {string} */ state) {
            trySetTextContentIfChanged(titleElement, title);
            trySetTextContentIfChanged(descriptionElement, '');
            trySetTextContentIfChanged(progressTextElement, '');
            if (progressFill)
                progressFill.style.width = '0%';
        }

        const goals = model.goals;
        if (!goals) {
            clearDetails('Ziele werden abgerufen...', '');
            return;
        }
        if (goals.length === 0) {
            clearDetails('Es sind noch keine Ziele angelegt.', '');
            return;
        }

        const totalPoints = model.live?.totalPoints ?? null;
        const states = determineGoalStates(goals, totalPoints);
        const activeIndex = states.indexOf(/** @type {GoalState} */('active'));
        const allDone = activeIndex < 0;
        const previousGoalPoints = goals[(allDone ? goals.length - 1 : activeIndex) - 1]?.points ?? 0;
        const goal = goals[allDone ? goals.length - 1 : activeIndex];

        trySetTextContentIfChanged(titleElement, goal.title);
        trySetTextContentIfChanged(descriptionElement, goal.description);

        const reached = totalPoints ?? 0;
        const percent = goal.points > 0
            ? Math.min(100, Math.max(0, (reached - previousGoalPoints) / (goal.points - previousGoalPoints) * 100))
            : 100;
        if (progressFill)
            progressFill.style.width = `${percent}%`;

        trySetTextContentIfChanged(progressTextElement, allDone
            ? `${formatPointsValue(reached)} / ${formatPointsValue(goal.points)} Punkte - geschafft 🎉`
            : `${formatPointsValue(reached)} / ${formatPointsValue(goal.points)} Punkte (${percent.toLocaleString(undefined, { maximumFractionDigits: 1 })} %) - noch ${formatPointsValue(goal.points - reached)} Punkte`);
    }

    /* ---------------- editor state ---------------- */

    /** @param {Goal[]} goals */
    function buildGoalDrafts(/** @type {Goal[]} */ goals) {
        return goals.map(goal => /** @type {GoalDraft} */({
            key: `g${goal.id}`,
            id: goal.id,
            points: `${goal.points}`,
            title: goal.title,
            description: goal.description,
            baseline: {
                points: goal.points,
                title: goal.title,
                description: goal.description,
                written_at: goal.written_at,
            },
        }));
    }

    /**
     * @param {GoalDraft} draft
     * @returns {number | null} null when the field does not hold a usable number
     */
    function parseDraftPoints(/** @type {GoalDraft} */ draft) {
        const text = draft.points.trim();
        if (text === '')
            return null;

        // type="number" already normalizes the input, the comma is only a courtesy for
        // values that were pasted into the field.
        const value = Number(text.replace(',', '.'));
        return Number.isFinite(value) && value >= 0 ? value : null;
    }

    /** @param {GoalDraft} draft */
    function buildIntendedGoalContent(/** @type {GoalDraft} */ draft) {
        const points = parseDraftPoints(draft);
        if (points == null)
            return null;

        return /** @type {GoalContent} */({
            points,
            title: draft.title.trim(),
            description: draft.description.trim(),
        });
    }

    /** @param {GoalDraft} draft */
    function draftIsModified(/** @type {GoalDraft} */ draft) {
        if (!draft.baseline)
            return true; // a fresh row always has to be inserted

        const intended = buildIntendedGoalContent(draft);
        return !intended || !sameGoalContent(intended, draft.baseline);
    }

    function goalEditorIsDirty() {
        if (!goalsEditor)
            return false;

        // Rows the user removed are not part of drafts anymore, but they still have to be
        // deleted from the table.
        return goalsEditor.removed.length > 0 || goalsEditor.drafts.some(draftIsModified);
    }

    /** The number of rows a save would touch. */
    function countGoalChanges() {
        if (!goalsEditor)
            return 0;

        return goalsEditor.removed.length + goalsEditor.drafts.filter(draftIsModified).length;
    }

    /**
     * What the user wanted to change - shown in the conflict notice, because all of this
     * is discarded and has to be typed in again.
     * @returns {string[]}
     */
    function describeOwnGoalChanges() {
        const editor = goalsEditor;
        if (!editor)
            return [];

        /** @type {string[]} */
        const lines = [];
        for (const goal of editor.removed)
            lines.push(`entfernen: „${goal.title}“ (#${goal.id}, ${formatPointsValue(goal.points)} Punkte)`);

        for (const draft of editor.drafts) {
            if (!draftIsModified(draft))
                continue;

            const intended = buildIntendedGoalContent(draft);
            if (!draft.baseline) {
                lines.push(`neu: „${intended?.title ?? draft.title}“ (${formatPointsValue(intended?.points ?? 0)} Punkte)`);
                continue;
            }
            if (intended)
                lines.push(`„${draft.baseline.title}“ (#${draft.id}) - ${describeGoalDifference(draft.baseline, intended)}`);
            else
                lines.push(`„${draft.title}“ (#${draft.id}) - ungültige Punktzahl „${draft.points}“`);
        }

        return lines;
    }

    /** @returns {string[]} what the user has to fix before saving makes sense */
    function validateGoalDrafts() {
        /** @type {string[]} */
        const problems = [];
        for (const draft of goalsEditor?.drafts ?? []) {
            if (parseDraftPoints(draft) == null) {
                problems.push(`Zeile „${draft.title.trim() || '(ohne Titel)'}“: die Punktzahl muss eine Zahl größer oder gleich 0 sein.`);
            } else if (draft.title.trim() === '') {
                problems.push(`Zeile mit ${formatPointsValue(parseDraftPoints(draft))} Punkten: der Titel darf nicht leer sein.`);
            }
        }
        return problems;
    }

    /** Sorts the editor rows by their (new) points, ascending - incomplete rows stay last. */
    function sortGoalDrafts() {
        if (!goalsEditor)
            return;

        goalsEditor.drafts.sort((a, b) => {
            const pointsA = parseDraftPoints(a);
            const pointsB = parseDraftPoints(b);
            if (pointsA == null && pointsB == null)
                return 0;
            if (pointsA == null)
                return 1;
            if (pointsB == null)
                return -1;
            return pointsA - pointsB;
        });
    }

    /** @param {Element} rowElement */
    function findDraftForRow(/** @type {Element} */ rowElement) {
        const key = rowElement.getAttribute('data-key');
        return goalsEditor?.drafts.find(draft => draft.key === key) ?? null;
    }

    /** @param {HTMLTemplateElement} rowTemplate */
    function createGoalRowElement(/** @type {HTMLTemplateElement} */ rowTemplate) {
        const clone = /** @type {Element} */(rowTemplate.content.cloneNode(true));
        const element = clone.firstElementChild;
        if (!(element instanceof HTMLDivElement))
            return null;

        for (const fieldName of goalFieldNames) {
            const input = /** @type {HTMLInputElement | null} */(element.querySelector(`input.${fieldName}`));
            if (!input)
                continue;

            input.addEventListener('input', () => {
                const draft = findDraftForRow(element);
                if (!draft)
                    return;

                draft[fieldName] = input.value;
                refreshGoalEditor();
            });
        }

        // Sorting while typing would move the row under the cursor, so it happens on blur.
        const pointsInput = /** @type {HTMLInputElement | null} */(element.querySelector('input.points'));
        pointsInput?.addEventListener('change', () => {
            sortGoalDrafts();
            refreshGoalEditor();
        });

        const deleteButton = /** @type {HTMLButtonElement | null} */(element.querySelector('button.goal-delete'));
        deleteButton?.addEventListener('click', () => {
            const editor = goalsEditor;
            if (!editor || editor.saving)
                return;

            const index = editor.drafts.findIndex(draft => draft.key === element.getAttribute('data-key'));
            if (index < 0)
                return;

            const draft = editor.drafts[index];
            if (draft.baseline)
                editor.removed.push({
                    id: /** @type {number} */(draft.id),
                    points: draft.baseline.points,
                    title: draft.baseline.title,
                    description: draft.baseline.description,
                    written_at: draft.baseline.written_at,
                });

            editor.drafts.splice(index, 1);
            refreshGoalEditor();
        });

        return element;
    }

    /** @param {HTMLDivElement} container */
    function renderGoalRows(/** @type {HTMLDivElement} */ container) {
        const rowTemplate = getElementById('goal-row-template', 'template');
        const editor = goalsEditor;
        if (!rowTemplate || !editor)
            return;

        const drafts = editor.drafts;
        const totalPoints = model.live?.totalPoints ?? null;
        // The state is computed over what the list would look like after saving, so a new
        // row already shows "ausstehend" instead of nothing.
        const states = determineGoalStates(
            drafts.map(draft => /** @type {GoalContent} */({
                points: parseDraftPoints(draft) ?? Number.POSITIVE_INFINITY,
                title: '',
                description: '',
            })),
            totalPoints);

        for (let index = 0; index < drafts.length; index++) {
            const draft = drafts[index];

            let element = /** @type {HTMLDivElement | null} */(container.children.item(index));
            if (!element) {
                element = createGoalRowElement(rowTemplate);
                if (!element)
                    continue;
                container.appendChild(element);
                element.setAttribute('data-key', draft.key);
            } else if (element.getAttribute('data-key') !== draft.key) {
                const newElement = createGoalRowElement(rowTemplate);
                if (!newElement)
                    continue;
                container.insertBefore(newElement, element);
                element = newElement;
                element.setAttribute('data-key', draft.key);
            }

            // Never overwrite a field while the user is typing in it - the drafts are the
            // single source of truth, so a refresh from the table still arrives.
            for (const fieldName of goalFieldNames) {
                const input = /** @type {HTMLInputElement | null} */(element.querySelector(`input.${fieldName}`));
                if (input && input !== document.activeElement && input.value !== draft[fieldName])
                    input.value = draft[fieldName];
            }

            const state = states[index] ?? /** @type {GoalState} */('upcoming');
            element.setAttribute('data-goal-state', state);
            trySetTextContentIfChanged(
                element.querySelector('span.goal-state'),
                goalStateLabels[state]);

            element.toggleAttribute('data-modified', draftIsModified(draft));
            element.toggleAttribute('data-conflict', editor.conflictedKeys.includes(draft.key));
            element.toggleAttribute('data-invalid', parseDraftPoints(draft) == null || draft.title.trim() === '');
        }

        for (let index = container.children.length - 1; index >= drafts.length; index--)
            container.removeChild(container.children[index]);
    }

    /** @param {HTMLDivElement} noticeElement */
    function renderGoalsNotice(/** @type {HTMLDivElement} */ noticeElement) {
        const notice = goalsEditor?.notice;
        if (!notice) {
            noticeElement.setAttribute('hidden', '');
            noticeElement.replaceChildren();
            return;
        }

        noticeElement.removeAttribute('hidden');
        noticeElement.setAttribute('data-kind', notice.kind);

        const parts = /** @type {Element[]} */([]);
        parts.push(Object.assign(document.createElement('p'), { textContent: notice.text }));

        if (notice.lines.length > 0) {
            const list = document.createElement('ul');
            for (const line of notice.lines)
                list.appendChild(Object.assign(document.createElement('li'), { textContent: line }));
            parts.push(list);
        }

        const dismissButton = /** @type {HTMLButtonElement} */(Object.assign(document.createElement('button'), {
            type: 'button',
            textContent: 'Hinweis ausblenden',
        }));
        dismissButton.addEventListener('click', () => {
            if (goalsEditor)
                goalsEditor.notice = null;
            refreshGoalEditor();
        });
        parts.push(dismissButton);

        noticeElement.replaceChildren(...parts);
    }

    /** Redraws the goal editor (also the entry point after every live update). */
    function refreshGoalEditor() {
        const editor = goalsEditor;
        if (!editor)
            return;

        trySetTextContentIfChanged(
            getElementById('goals-total-points', 'strong'),
            formatPointsValue(model.live?.totalPoints ?? null));

        const listElement = getElementById('goals-list', 'div');
        if (listElement)
            renderGoalRows(listElement);

        const noticeElement = getElementById('goals-notice', 'div');
        if (noticeElement)
            renderGoalsNotice(noticeElement);

        const modifiedCount = countGoalChanges();

        const saveButton = getElementById('goals-save-button', 'button');
        if (saveButton) {
            saveButton.disabled = editor.saving || modifiedCount === 0;
            trySetTextContentIfChanged(
                saveButton,
                editor.saving ? '💾 Speichern läuft...' : `💾 Speichern${modifiedCount > 0 ? ` (${modifiedCount})` : ''}`);
        }

        const revertButton = getElementById('goals-revert-button', 'button');
        if (revertButton) {
            revertButton.disabled = editor.saving || modifiedCount === 0;
        }

        const addButton = getElementById('goals-add-button', 'button');
        if (addButton) {
            addButton.disabled = editor.saving;
        }
    }

    /**
     * Compares the freshly read table with the state the editor was built on and collects
     * everything somebody else changed. A change whose result equals what we are about to
     * write is deliberately not a conflict: two people applying the same change to the
     * same goal is fine, and so is deleting a goal that is already gone.
     *
     * @param {Goal[]} current
     * @returns {{ lines: string[], conflictedKeys: string[] }}
     */
    function findExternalGoalChanges(/** @type {Goal[]} */ current) {
        /** @type {string[]} */
        const lines = [];
        /** @type {string[]} */
        const conflictedKeys = [];

        const editor = goalsEditor;
        if (!editor)
            return { lines, conflictedKeys };

        /** @type {Map<number, GoalDraft>} */
        const draftById = new Map(editor.drafts
            .filter(draft => draft.id !== null && draft.baseline !== null)
            .map(draft => /** @type {[number, GoalDraft]} */([/** @type {number} */(draft.id), draft])));
        /** @type {Map<number, Goal>} */
        const removedById = new Map(editor.removed.map(goal => /** @type {[number, Goal]} */([goal.id, goal])));
        const currentById = new Map(current.map(goal => /** @type {[number, Goal]} */([goal.id, goal])));

        for (const row of current) {
            const draft = draftById.get(row.id) ?? null;
            const removed = removedById.get(row.id) ?? null;

            if (!draft && !removed) {
                lines.push(`Ziel „${row.title}“ (#${row.id}) wurde von anderer Seite neu angelegt.`);
                // The row is in the list, so it can be marked as part of the conflict.
                conflictedKeys.push(`g${row.id}`);
                continue;
            }

            const baseline = draft?.baseline ?? /** @type {Goal} */(removed);
            if (!baseline)
                continue;

            if (sameGoalContent(row, baseline))
                continue;

            const intended = draft ? buildIntendedGoalContent(draft) : null;
            if (intended && sameGoalContent(row, intended))
                continue; // both sides wanted the same new state

            const ownChange = draft && intended && !sameGoalContent(intended, baseline)
                ? ` Deine Änderung (${describeGoalDifference(baseline, intended)}) ist damit verworfen.`
                : '';
            lines.push(
                (draft
                    ? `Ziel „${row.title}“ (#${row.id}) wurde extern geändert: ${describeGoalDifference(baseline, row)}.`
                    : `Ziel „${row.title}“ (#${row.id}), das du entfernen wolltest, wurde extern geändert: ${describeGoalDifference(baseline, row)}.`)
                + (draft ? ownChange : ' Deine Änderung ist damit verworfen.'));

            if (draft)
                conflictedKeys.push(draft.key);
        }

        for (const [id, draft] of draftById) {
            if (currentById.has(id))
                continue;

            lines.push(`Ziel „${draft.baseline?.title ?? ''}“ (#${id}) wurde von anderer Seite gelöscht.`);
            conflictedKeys.push(draft.key);
        }

        // Rows in editor.removed that are no longer in the table: the wanted state is
        // already reached, so they are not reported.

        return { lines, conflictedKeys };
    }

    /**
     * @param {Goal[]} current the table as it is now
     * @param {{ lines: string[], conflictedKeys: string[] }} external
     */
    function discardGoalDrafts(
        /** @type {Goal[]} */ current,
        /** @type {{ lines: string[], conflictedKeys: string[] }} */ external) {

        const editor = goalsEditor;
        if (!editor)
            return;

        editor.notice = {
            kind: 'conflict',
            text: `Die Zieltabelle wurde seit dem Laden an ${external.lines.length} Stelle${external.lines.length === 1 ? '' : 'n'} geändert. ` +
                'Deine Änderungen wurden verworfen und müssen erneut vorgenommen werden:',
            lines: [...external.lines, ...describeOwnGoalChanges()],
        };
        editor.conflictedKeys = external.conflictedKeys;
        editor.drafts = buildGoalDrafts(current);
        editor.removed = [];
        model.goals = current;
    }

    /**
     * The table must look exactly like the drafts now - comparing the content is more
     * reliable than trusting affected_row_count, because an UPDATE that writes identical
     * values reports 0 on this server (docs/Turso/queries.sql, section 5).
     *
     * @param {GoalDraft[]} drafts
     * @param {Goal[]} after
     * @returns {string[]} expected contents that the table does not contain
     */
    function verifyGoalWrites(
        /** @type {GoalDraft[]} */ drafts,
        /** @type {Goal[]} */ after) {

        /** @param {GoalContent[]} contents */
        function toKeys(/** @type {GoalContent[]} */ contents) {
            return contents
                .map(content => `${content.points}\u0000${content.title}\u0000${content.description}`)
                .sort();
        }

        /** @type {GoalContent[]} */
        const expectedContents = [];
        for (const draft of drafts) {
            const intended = buildIntendedGoalContent(draft);
            if (intended)
                expectedContents.push(intended);
        }

        const expected = toKeys(expectedContents);
        const actual = toKeys(after);

        /** @type {string[]} */
        const problems = [];
        for (let index = 0; index < Math.max(expected.length, actual.length); index++) {
            if (expected[index] === actual[index])
                continue;
            problems.push(`erwartet: ${expected[index]?.replaceAll('\u0000', ' | ') ?? '(keine)'} - tatsächlich: ${actual[index]?.replaceAll('\u0000', ' | ') ?? '(keine)'}`);
        }

        return problems;
    }

    async function saveGoalEdits() {
        const editor = goalsEditor;
        if (!editor || editor.saving)
            return;

        if (!goalEditorIsDirty()) {
            editor.notice = { kind: 'info', text: 'Es gibt nichts zu speichern.', lines: [] };
            editor.conflictedKeys = [];
            refreshGoalEditor();
            return;
        }

        const problems = validateGoalDrafts();
        if (problems.length > 0) {
            editor.notice = {
                kind: 'error',
                text: 'Deine Eingaben sind unvollständig - es wurde nichts gespeichert:',
                lines: problems,
            };
            editor.conflictedKeys = [];
            refreshGoalEditor();
            return;
        }

        editor.saving = true;
        refreshGoalEditor();

        try {
            // Read the table again: everything that happened since the list was shown
            // (including our own minute poll) is compared against the editor's baseline.
            const current = await data.readGoalsNow();
            const external = findExternalGoalChanges(current);
            if (external.lines.length > 0) {
                discardGoalDrafts(current, external);
                render();
                return;
            }

            // Write. Every statement carries the written_at seen at read time as a
            // guard, written_at itself always comes from the database clock.
            const currentById = new Map(current.map(goal => /** @type {[number, Goal]} */([goal.id, goal])));
            /** @type {TursoStatement[]} */
            const statements = [];
            /** @type {string[]} */
            const statementLabels = [];
            
            // Both counters are used to detect a "DELETE ONLY" save.
            // These would not update MAX(written_at) which bump the latest existing row instead.
            let bumpsWrittenAt = 0;
            let deleteStatements = 0;

            for (const draft of editor.drafts) {
                const intended = buildIntendedGoalContent(draft);
                if (!intended)
                    // cannot happen, validateGoalDrafts checked it
                    continue; 

                if (draft.id === null) {
                    statements.push({
                        sql: "INSERT INTO goals (points, title, description, written_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                        args: [intended.points, intended.title, intended.description],
                        wantRows: false,
                    });
                    statementLabels.push(`Ziel „${intended.title}“ (${formatPointsValue(intended.points)} Punkte) anlegen`);
                    bumpsWrittenAt++;
                    continue;
                }

                const row = currentById.get(draft.id);
                if (!row || sameGoalContent(row, intended))
                    // unchanged, or the table already holds our new state
                    continue; 

                statements.push({
                    sql: "UPDATE goals SET points = ?, title = ?, description = ?, written_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND written_at = ?",
                    args: [intended.points, intended.title, intended.description, draft.id, row.written_at],
                    wantRows: false,
                });
                statementLabels.push(`Ziel „${intended.title}“ (#${draft.id}) ändern`);
                bumpsWrittenAt++;
            }

            for (const goal of editor.removed) {
                const row = currentById.get(goal.id);
                if (!row)
                    // already gone elsewhere: the wanted state exists
                    continue; 

                statements.push({
                    sql: 'DELETE FROM goals WHERE id = ? AND written_at = ?',
                    args: [goal.id, goal.written_at],
                    wantRows: false,
                });
                statementLabels.push(`Ziel „${goal.title}“ (#${goal.id}) entfernen`);
                deleteStatements++;
            }

            if (statements.length === 0) {
                editor.notice = { kind: 'info', text: 'Die Tabelle entspricht bereits deinen Eingaben - gespeichert wurde nichts.', lines: [] };
                editor.conflictedKeys = [];
                editor.drafts = buildGoalDrafts(current);
                editor.removed = [];
                applyGoals(current, true);
                return;
            }

            let markedByIndex = -1;
            if (deleteStatements > 0 && bumpsWrittenAt === 0) {
                markedByIndex = statements.length;
                // We only want to detect a goals refresh via MAX(written_at) in the
                // goals widget. If we only delete a statement, there is no row with
                // updated written_at. So we just bump the one with highest id.
                // If we delete all rows, the MAX(written_at) turns NULL.
                // This gives the needed notice to change detection and our regular
                // check only consumes one row read from contigent.
                // A very simple solution to make DELETE ONLY saves possible with
                // only one timestamp index.
                statements.push({
                    sql: "UPDATE goals SET written_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = (SELECT MAX(id) FROM goals)",
                    wantRows: false,
                });
                statementLabels.push('Löschung als Änderung markiert (ohne diesen Satz bliebe das entfernte Ziel im Widget stehen)');
            }

            const changeStatements = statements.length - (markedByIndex >= 0 ? 1 : 0);

            const results = await data.turso.pipeline(statements);

            /** @type {string[]} */
            const rejected = [];
            for (let index = 0; index < results.length; index++) {
                if (index === markedByIndex)
                    continue;                
                if (results[index].affectedRowCount > 0)
                    continue;
                // An UPDATE that would write exactly the same values also reports 0, but
                // such a statement is skipped above, so 0 here means the guard did not match.
                rejected.push(`${statementLabels[index]}: das Ziel wurde zwischenzeitlich geändert.`);
            }

            // Check what the table contains now.
            const after = await data.readGoalsNow();
            const verification = verifyGoalWrites(editor.drafts, after);

            editor.conflictedKeys = [];
            if (rejected.length > 0 || verification.length > 0) {
                editor.notice = {
                    kind: 'conflict',
                    text: 'Beim Speichern haben sich Ziele überschitten. Diese Änderungen sind nicht angekommen und müssen erneut vorgenommen werden:',
                    lines: [...rejected, ...verification],
                };
                // The table is the truth - the editor starts from it again, otherwise the
                // rows that did get through would keep looking "modified" and the next
                // save would report them as external changes.
                editor.drafts = buildGoalDrafts(after);
                editor.removed = [];
                applyGoals(after, true);
                render();
                return;
            }

            editor.notice = {
                kind: 'saved',
                text: `${changeStatements} Änderung${changeStatements === 1 ? '' : 'en'} gespeichert.`,
                lines: statementLabels,
            };
            // New baseline: what we just wrote is what the next save compares against.
            editor.drafts = buildGoalDrafts(after);
            editor.removed = [];
            applyGoals(after, true);
        } catch (err) {
            console.error('Saving goals failed', err);
            editor.notice = {
                kind: 'error',
                text: `Speichern fehlgeschlagen: ${err instanceof Error ? err.message : err} - deine Eingaben sind erhalten geblieben.`,
                lines: [],
            };
        } finally {
            editor.saving = false;
            render();
        }
    }

    /**
     * The table arrived in the model. While somebody edits the list, their input wins:
     * the drafts keep their baseline, because that is what a save compares against.
     * @param {Goal[]} goals
     * @param {boolean} [fromOwnSave] our own write must not look like an external change
     */
    function applyGoals(
        /** @type {Goal[]} */ goals,
        /** @type {boolean | undefined} */ fromOwnSave) {

        const previous = model.goals;
        model.goals = goals;

        if (!goalsEditor)
            return;

        if (!fromOwnSave && previous) {
            const changes = describeGoalTableChanges(previous, goals);
            if (changes.length > 0 && goalEditorIsDirty()) {
                goalsEditor.notice = {
                    kind: 'info',
                    text: 'Die Zieltabelle wurde zwischenzeitlich geändert. Deine offenen Änderungen bleiben erhalten - beim Speichern wird geprüft, ob sie davon betroffen sind:',
                    lines: changes,
                };
            }
        }

        if (!goalEditorIsDirty()) {
            goalsEditor.drafts = buildGoalDrafts(goals);
            goalsEditor.removed = [];
        }
    }

    function renderGoalsSubpage() {
        const subpageElement = openSubpage('goals-edit');
        if (!subpageElement)
            return;

        if (!model.goals) {
            subpageElement.setAttribute('data-loading', '');
            return;
        }
        subpageElement.removeAttribute('data-loading');

        if (!goalsEditor) {
            goalsEditor = {
                drafts: buildGoalDrafts(model.goals),
                removed: [],
                notice: null,
                conflictedKeys: [],
                saving: false,
            };
        }

        refreshGoalEditor();
    }

    function wireGoalEditor() {
        const addButton = getElementById('goals-add-button', 'button');
        if (addButton) {
            addButton.onclick = () => {
                const editor = goalsEditor;
                if (!editor || editor.saving)
                    return;

                editor.drafts.push({
                    key: `new-${++newGoalCounter}`,
                    id: null,
                    points: '',
                    title: '',
                    description: '',
                    baseline: null,
                });
                refreshGoalEditor();

                const titleInput = /** @type {HTMLInputElement | null} */(
                    getElementById('goals-list', 'div')?.lastElementChild?.querySelector('input.title'));
                titleInput?.focus();
            };
        }

        const saveButton = getElementById('goals-save-button', 'button');
        if (saveButton) {
            saveButton.onclick = () => { void saveGoalEdits(); };
        }

        const revertButton = getElementById('goals-revert-button', 'button');
        if (revertButton) {
            revertButton.onclick = () => {
                const editor = goalsEditor;
                if (!editor || editor.saving)
                    return;

                editor.drafts = buildGoalDrafts(model.goals ?? []);
                editor.removed = [];
                editor.notice = null;
                editor.conflictedKeys = [];
                refreshGoalEditor();
            };
        }
    }

    /** 
     *  @this {GlobalEventHandlers}
     *  @param {PointerEvent} ev
     */
    function tableClickHandler(ev) {
        if (ev.target && ev.target instanceof HTMLTableCellElement && ev.target.tagName === 'TH') {
            const className = ev.target.className;
            if (className === 'rownum')
                return;

            const subpage = model.subpage;
            if (!subpage)
                return;

            const index = subpage.sortBy.findIndex(x => x.name === className);
            if (index === 0) {
                const element = subpage.sortBy[0];
                element.direction = flipSortDirection(element.direction);
            } else {
                if (index > -1) {
                    subpage.sortBy.splice(index, 1);
                }

                subpage.sortBy.splice(0, 0, {
                    name: className,
                    direction: 'DESC',
                });
            }

            renderSubpage();
        }
    }

    function directionToSymbol(/** @type {SortDirection} */ direction) {
        switch (direction) {
            case 'ASC': return '▲';
            case 'DESC': return '▼';
            default: throw unreachable(direction);
        }
    }

    function openSubpage(/** @type {string} */ id) {
        const subpage = model.subpage;
        if (!subpage)
            return;

        const subpageElement = getElementById(id, 'div');
        if (!subpageElement)
            return;

        if (subpage.element && subpage.element !== subpageElement) {
            subpage.element.removeAttribute('open');
            subpage.element = undefined;
            location.hash = '';
        }

        if (!subpageElement.hasAttribute('open')) {
            subpageElement.setAttribute('open', '');
            location.hash = subpage.type;

            const tableElement = subpageElement.querySelector("table");
            if (tableElement) {
                tableElement.onclick = tableClickHandler;
            }
        }

        subpage.element = subpageElement;

        const activeSortingElement = subpageElement.querySelector("span.active-sorting");
        if (activeSortingElement) {
            /** @type {Record<string, string>} */
            const columnHeaders = {};
            for (const th of
                [.../** @type {NodeListOf<HTMLTableCellElement>} */(
                    subpageElement.querySelectorAll("table thead tr th")
                )]) {
                columnHeaders[th.className] = th.textContent;
            }
            const sortString = subpage.sortBy
                .map(c => {
                    const textContent = columnHeaders[c.name];
                    return `${textContent ?? name} ${directionToSymbol(c.direction)}`;
                })
                .join(", ");
            trySetTextContentIfChanged(activeSortingElement, sortString);
        }

        return subpageElement;
    }

    function buildAllSupports(
        /** @type {DecryptedDashboardDetailsJson} */ data
    ) {
        /** @type {(AllSupportsPerUserEntry)[]} */
        const allSupports = [];
        for (const subgifts of [
            data.selfsubsPerUser,
            data.subgiftsPerUser
        ]) {
            for (const subgift of subgifts) {
                const entry = allSupports.find(x => x.supporter === subgift.supporter);
                if (entry) {
                    entry.tier1 += subgift.tier1;
                    entry.tier2 += subgift.tier2;
                    entry.tier3 += subgift.tier3;
                    entry.total += subgift.total;
                    entry.points += subgift.points;
                    if (new Date(entry.reachedAt) < new Date(subgift.reachedAt)) {
                        entry.reachedAt = subgift.reachedAt;
                    }
                } else {
                    addSortedBySupporter(allSupports, {
                        supporter: subgift.supporter,
                        bits: 0,
                        donations: 0,
                        tier1: subgift.tier1,
                        tier2: subgift.tier2,
                        tier3: subgift.tier3,
                        total: subgift.total,
                        points: subgift.points,
                        reachedAt: subgift.reachedAt,
                    });
                }
            }
        }

        for (const bits of data.bitsPerUser) {
            const entry = allSupports.find(x => x.supporter === bits.supporter);
            if (entry) {
                entry.bits += bits.amount;
                entry.points += bits.points;
                if (new Date(entry.reachedAt) < new Date(bits.reachedAt)) {
                    entry.reachedAt = bits.reachedAt;
                }
            } else {
                addSortedBySupporter(allSupports, {
                    supporter: bits.supporter,
                    bits: bits.amount,
                    donations: 0,
                    tier1: 0,
                    tier2: 0,
                    tier3: 0,
                    total: 0,
                    points: bits.points,
                    reachedAt: bits.reachedAt,
                });
            }
        }

        for (const donation of data.donationsPerUser) {
            const entry = allSupports.find(x => x.supporter === donation.supporter);
            if (entry) {
                entry.donations += donation.amount;
                entry.points += donation.points;
                if (new Date(entry.reachedAt) < new Date(donation.reachedAt)) {
                    entry.reachedAt = donation.reachedAt;
                }
            } else {
                addSortedBySupporter(allSupports, {
                    supporter: donation.supporter,
                    bits: 0,
                    donations: donation.amount,
                    tier1: 0,
                    tier2: 0,
                    tier3: 0,
                    total: 0,
                    points: donation.points,
                    reachedAt: donation.reachedAt,
                });
            }
        }

        return allSupports;
    }

    function renderSubpage() {
        const subpage = model.subpage;
        if (!subpage)
            return;

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        switch (subpage.type) {
            case "sportWheels":
                {
                    const subpageElement = openSubpage('wheel-spins-details');
                    if (!subpageElement)
                        return;

                    const data = model.details;
                    if (!data) {
                        subpageElement.setAttribute('data-loading', '');
                        return;
                    } else {
                        subpageElement.removeAttribute('data-loading');
                    }

                    const rowTemplate = getElementById('wheel-spins-details-row-template', 'template');
                    if (!rowTemplate)
                        return;

                    const tableBody = subpageElement.querySelector('tbody');
                    if (!tableBody)
                        return;

                    renderTable(
                        subpage.sortBy,
                        data.subbombsPerUser,
                        bomb => `${bomb.supporter}-${bomb.timestamp}-tier${bomb.tier}-${bomb.subcount}`,
                        rowTemplate,
                        tableBody,
                        (bomb) => ({
                            'rownum': {
                                text: index => `${index + 1}`,
                                sortValue: 0,
                            },
                            'supporter': {
                                text: bomb.supporter,
                                sortValue: bomb.supporter,
                            },
                            'timestamp': {
                                text: formatTimestamp(today, bomb.timestamp),
                                sortValue: new Date(bomb.timestamp).getTime(),
                            },
                            'level': {
                                text: `${bomb.tier}`,
                                sortValue: bomb.tier,
                            },
                            'amount': {
                                text: `${bomb.subcount}`,
                                sortValue: bomb.subcount,
                            },
                            'points': {
                                text: formatPoints(bomb.points),
                                sortValue: bomb.points,
                            },
                        }),
                    );
                }
                break;

            case "pins":
            case "postcards":
                {
                    const subpageElement = openSubpage('subgifts-details');
                    if (!subpageElement)
                        return;

                    const data = model.details;
                    if (!data) {
                        subpageElement.setAttribute('data-loading', '');
                        return;
                    } else {
                        subpageElement.removeAttribute('data-loading');
                    }

                    const [elementIdPrefix, minCount] = (function (type) {
                        switch (type) {
                            case "postcards": return ["postcards", 50];
                            case "pins": return ["artwork-names", 100];
                            default: throw unreachable(type);
                        }
                    })(subpage.type);

                    const cardHeaderText = document.querySelector(`.summary .card#${elementIdPrefix}-card > h3`)?.textContent ?? '<unknown>';
                    const subgiftsDetailsTitle = getElementById('subgifts-details-title', 'h2');
                    if (subgiftsDetailsTitle) {
                        subgiftsDetailsTitle.textContent = cardHeaderText;
                    }

                    const rowTemplate = getElementById('subgifts-details-row-template', 'template');
                    if (!rowTemplate)
                        return;

                    const tableBody = subpageElement.querySelector('tbody');
                    if (!tableBody)
                        return;

                    const allSupports = buildAllSupports(data);

                    renderTable(
                        subpage.sortBy,
                        allSupports.filter(x => x.total >= minCount),
                        entry => `${entry.supporter}`,
                        rowTemplate,
                        tableBody,
                        (entry) => ({
                            'rownum': {
                                text: index => `${index + 1}`,
                                sortValue: 0,
                            },
                            'reached-at': {
                                text: formatTimestamp(today, entry.reachedAt),
                                sortValue: new Date(entry.reachedAt).getTime(),
                            },
                            'supporter': {
                                text: entry.supporter,
                                sortValue: entry.supporter,
                            },
                            'subs': {
                                text: `${entry.total}`,
                                sortValue: entry.total,
                            },
                            't1': {
                                text: `${entry.tier1}`,
                                sortValue: entry.tier1,
                            },
                            't2': {
                                text: `${entry.tier2}`,
                                sortValue: entry.tier2,
                            },
                            't3': {
                                text: `${entry.tier3}`,
                                sortValue: entry.tier3,
                            },
                            'bits': {
                                text: `${entry.bits}`,
                                sortValue: entry.bits,
                            },
                            'donations': {
                                text: entry.donations.toLocaleString(undefined, { minimumFractionDigits: 2 }),
                                sortValue: entry.donations,
                            },
                            'points': {
                                text: formatPoints(entry.points),
                                sortValue: entry.points,
                            },
                        }),
                    );
                }
                break;

            case "allSupports":
                {
                    const subpageElement = openSubpage('all-supports');
                    if (!subpageElement)
                        return;

                    const data = model.details;
                    if (!data) {
                        subpageElement.setAttribute('data-loading', '');
                        return;
                    } else {
                        subpageElement.removeAttribute('data-loading');
                    }

                    const rowTemplate = getElementById('all-supports-row-template', 'template');
                    if (!rowTemplate)
                        return;

                    const tableBody = subpageElement.querySelector('tbody');
                    if (!tableBody)
                        return;

                    const allSupports = buildAllSupports(data);

                    renderTable(
                        subpage.sortBy,
                        allSupports,
                        entry => `${entry.supporter}`,
                        rowTemplate,
                        tableBody,
                        (entry) => ({
                            'rownum': {
                                text: index => `${index + 1}`,
                                sortValue: 0,
                            },
                            'reached-at': {
                                text: formatTimestamp(today, entry.reachedAt),
                                sortValue: new Date(entry.reachedAt).getTime(),
                            },
                            'supporter': {
                                text: entry.supporter,
                                sortValue: entry.supporter,
                            },
                            'subs': {
                                text: `${entry.total}`,
                                sortValue: entry.total,
                            },
                            't1': {
                                text: `${entry.tier1}`,
                                sortValue: entry.tier1,
                            },
                            't2': {
                                text: `${entry.tier2}`,
                                sortValue: entry.tier2,
                            },
                            't3': {
                                text: `${entry.tier3}`,
                                sortValue: entry.tier3,
                            },
                            'bits': {
                                text: `${entry.bits}`,
                                sortValue: entry.bits,
                            },
                            'donations': {
                                text: entry.donations.toLocaleString(undefined, { minimumFractionDigits: 2 }),
                                sortValue: entry.donations,
                            },
                            'points': {
                                text: formatPoints(entry.points),
                                sortValue: entry.points,
                            },
                        }),
                    );
                }
                break;

            case "goals":
                renderGoalsSubpage();
                break;

            default:
                throw unreachable(subpage.type);
        }
    }

    function renderImpl() {
        const data = model.live;
        if (!data) {
            trySetTextContentIfChanged(loadingState,
                'Fetching data...');
            return;
        }

        trySetTextContentIfChanged(loadingState, '');

        trySetTextContentIfChanged(
            getElementById('sport-wheels-count', 'p'),
            `${data.sportWheels}`);
        trySetTextContentIfChanged(
            getElementById('postcards-count', 'p'),
            `${data.postcards}`);
        trySetTextContentIfChanged(
            getElementById('pins-count', 'p'),
            `${data.pins}`);

        // Set all leaderboard entries
        const leaderboards = data.leaderboards;
        for (const leaderboardKey of Object.keys(leaderboardsJsonToCellMapping)) {
            const leaderboard = leaderboards[leaderboardKey];
            const leaderboardJsonToCellMapping = leaderboardsJsonToCellMapping[leaderboardKey];
            for (const groupKey of Object.keys(leaderboardJsonToCellMapping)) {
                const group = leaderboard[groupKey];
                const cellPrefix = leaderboardJsonToCellMapping[groupKey];
                trySetTextContentIfChanged(
                    getElementById(`${cellPrefix}-name`, 'td'),
                    group?.supporter ?? '');
                trySetTextContentIfChanged(
                    getElementById(`${cellPrefix}-points`, 'td'),
                    formatPoints(group?.points));
            }
        }

        // Fill the goal summary (total points + the goal that is currently open)
        renderGoalSummary();

        // Fill the event list efficiently, keyed by the event's identity
        renderEvents(data.events);

        // Fill the subpages, if one is open
        renderSubpage();
    }

    function render() {
        try {
            renderImpl();
        } catch (err) {
            console.log("Render failed with an exception", err);
        }
    }

    render();

    function updateDetailsWithLive() {
        const live = model.live;
        const details = model.details;
        if (!live || !details)
            return;

        const latestLiveEvent = live.events[0];
        if (!latestLiveEvent
            || details.latestEventAt === latestLiveEvent.timestamp)
            return;

        const detailsLatestEventAtDate = new Date(details.latestEventAt);
        for (const liveEvent of live.events.toReversed()) {
            const liveEventDate = new Date(liveEvent.timestamp);
            if (liveEventDate <= detailsLatestEventAtDate)
                continue;

            switch (liveEvent.category) {
                case "BITS":
                    {
                        const entry = details.bitsPerUser.find(x => x.supporter === liveEvent.supporter);
                        if (entry) {
                            entry.amount += liveEvent.amount;
                            entry.points += liveEvent.points;
                            entry.reachedAt = liveEvent.timestamp;
                        } else {
                            addSortedBySupporter(details.bitsPerUser, {
                                supporter: liveEvent.supporter,
                                amount: liveEvent.amount,
                                points: liveEvent.points,
                                reachedAt: liveEvent.timestamp,
                            });
                        }
                    }
                    break;

                case "DONATION":
                    {
                        const entry = details.donationsPerUser.find(x => x.supporter === liveEvent.supporter);
                        if (entry) {
                            entry.amount += liveEvent.amount / 100;
                            entry.points += liveEvent.points;
                            entry.reachedAt = liveEvent.timestamp;
                        } else {
                            addSortedBySupporter(details.donationsPerUser, {
                                supporter: liveEvent.supporter,
                                amount: liveEvent.amount / 100,
                                points: liveEvent.points,
                                reachedAt: liveEvent.timestamp,
                            });
                        }
                    }
                    break;

                case "SUBSCRIPTION1":
                case "SUBSCRIPTION2":
                case "SUBSCRIPTION3":
                    {
                        {
                            const tier = subscriptionToTier(liveEvent.category);
                            const entry = details.subgiftsPerUser.find(x => x.supporter === liveEvent.supporter);
                            if (entry) {
                                entry[tier] += liveEvent.amount;
                                entry.total += liveEvent.amount;
                                entry.points += liveEvent.points;
                                entry.reachedAt = liveEvent.timestamp;
                            } else {
                                /** @type {typeof details.subgiftsPerUser[0]} */
                                const newEntry = {
                                    supporter: liveEvent.supporter,
                                    points: liveEvent.points,
                                    total: liveEvent.amount,
                                    tier1: 0,
                                    tier2: 0,
                                    tier3: 0,
                                    reachedAt: liveEvent.timestamp,
                                };
                                newEntry[tier] += liveEvent.amount;
                                addSortedBySupporter(details.subgiftsPerUser, newEntry);
                            }
                        }

                        if (liveEvent.amount >= 20) {
                            const tier = subscriptionToTierNumber(liveEvent.category);
                            addSortedBySupporter(details.subbombsPerUser, {
                                supporter: liveEvent.supporter,
                                tier,
                                points: liveEvent.points,
                                subcount: liveEvent.amount,
                                timestamp: liveEvent.timestamp,
                            });
                        }
                    }
                    break;

                default:
                    throw unreachable(liveEvent.category);
            }
        }

        details.latestEventAt = live.events[0].timestamp;
    }

    /**
     * A fetch failed. Unrecoverable errors (token expired, permissions missing, key does
     * not fit) must not silently disappear in the background.
     * @param {unknown} err
     */
    function reportFetchError(err) {
        console.error("Failed to fetch state", err);

        if (err instanceof SupporterDecryptError
            || (err instanceof TursoError && err.unrecoverable)) {
            loadingState.innerText = err.message;
        }
    }

    const fetchLiveAndUpdate = async function () {
        /** @type {DecryptedDashboardLiveJson | null} */
        let live;
        try {
            live = await data.readLive();
        } catch (err) {
            reportFetchError(err);
            return;
        }

        if (!live)
            return; // unchanged - see createBasketReader

        // Only change value, if we got a valid object, otherwise
        // we will clear UI when loosing connection.
        live.totalPoints = Math.floor(live.totalPoints);
        model.live = live;

        // Reset details, in case we revert the live data for some reason:
        // The details would then contain events that no longer exist in live.
        if (model.details
            && new Date(model.details.latestEventAt) > new Date(live.events[0]?.timestamp ?? 0)) {
            model.details = null;
            data.invalidateDetails();
        }

        updateDetailsWithLive();

        render();
    };

    const fetchDetailsAndUpdate = async function () {
        if (!model.subpage)
            return;

        const now = new Date();
        const nextDetailsUpdate = model.nextDetailsUpdate;
        if (model.details && nextDetailsUpdate && nextDetailsUpdate > now) {
            return;
        }

        model.nextDetailsUpdate = new Date(now.getTime() + 10 * 60000);

        /** @type {DecryptedDashboardDetailsJson | null} */
        let details;
        try {
            details = await data.readDetails();
        } catch (err) {
            reportFetchError(err);
            return;
        }

        if (!details)
            return; // unchanged - see createBasketReader

        model.details = details;

        updateDetailsWithLive();

        render();
    };

    const fetchGoalsAndUpdate = async function (
        /** @type {boolean} */ force) {

        const now = new Date();
        const nextGoalsUpdate = model.nextGoalsUpdate;
        if (!force && nextGoalsUpdate && nextGoalsUpdate > now) {
            return;
        }

        model.nextGoalsUpdate = new Date(now.getTime() + settings.goalsFetchInterval);

        /** @type {Goal[] | null} */
        let goals;
        try {
            // force is used when the editor is entered: there the current table matters,
            // not whatever the last minute poll saw (see settings.goalsFetchInterval).
            goals = force ? await data.readGoalsNow() : await data.readGoals();
        } catch (err) {
            reportFetchError(err);
            return;
        }

        if (!goals)
            return; // unchanged - see createGoalsReader

        applyGoals(goals);
        render();
    };

    const fetchAndUpdate = async () => {
        // The previous cloud storage provider had a very strong rate limiting.
        // Turso doesn't have this kind of rate limiting and does also
        // offer custom sql or batches, if we need a lot of baskets at once.
        await fetchLiveAndUpdate();
        // The goals belong to the main page (active goal + progress), the details basket
        // only to the subpages, so the goals come first.
        await fetchGoalsAndUpdate(false);
        await fetchDetailsAndUpdate();
    }

    async function main() {
        await fetchAndUpdate();

        setInterval(fetchAndUpdate, settings.fetchInterval);
    }

    /** @returns {SortColumn[]} */
    function defaultSubpageSorting(/** @type {UISubpageType} */ type) {
        switch (type) {
            case "allSupports": return [
                { name: "points", direction: 'DESC' },
                { name: 'supporter', direction: 'ASC' },
            ];
            case "pins": return [{ name: "supporter", direction: 'ASC' }];
            case "postcards": return [{ name: "supporter", direction: 'ASC' }];
            case "sportWheels": return [{ name: "supporter", direction: 'ASC' }];
            case "goals": return []; // the list is always sorted by points, ascending
            default: throw unreachable(type);
        }
    }

    openSubpageClicked = (function (/** @type {UISubpageType} */ type) {
        model.subpage = {
            type: type,
            sortBy: defaultSubpageSorting(type),
        };

        if (type === 'goals') {
            renderSubpage();
            // Entering the editor has to show the current table right away, not the one
            // the last minute poll brought in.
            void fetchGoalsAndUpdate(true);
            return;
        }

        if (!model.details) {
            renderSubpage();

            fetchDetailsAndUpdate();
        } else {
            renderSubpage();
        }
    });

    function openPageByHash(/** @type {UISubpageType | ''} */ hash) {
        if (!openSubpageClicked)
            return;

        switch (hash) {
            case 'allSupports':
            case 'pins':
            case 'postcards':
            case 'sportWheels':
            case 'goals':
                openSubpageClicked(hash);
                break;

            case '':
                document.querySelectorAll("[subpage][open]").forEach(subpage => {
                    model.subpage = undefined;
                    subpage.removeAttribute('open');
                });
                break;
        }
    }

    window.onhashchange = function () {
        const hash = /** @type {UISubpageType | ''} */(location.hash.substring(1));
        openPageByHash(hash);
    };

    wireGoalEditor();

    openPageByHash(/** @type {UISubpageType | ''} */(location.hash.substring(1)));

    return {
        main,
        render,
    };
})();

await app?.main();


