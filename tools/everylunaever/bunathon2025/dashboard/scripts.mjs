/// @ts-check
/// <reference path="./index.d.ts" />
/// <reference path="./globals.d.ts" />

import * as crypto from "./crypto.mjs";

'use strict';

const config = await (async function () {
    const response = await fetch('./config.json', {
        method: 'GET',
        // Ignore the disk cache and rely on the 304 Not Modified response
        cache: 'no-cache',
    });
    const json = await response.json();
    return /** @type {Config} */(json);
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
    return localStorage.getItem('bunathon2025-dashboard-key');
}

async function tryLoadKeyFromSearch() {
    const base64 = new URLSearchParams(location.search).get('key')
        ?? await tryLoadKeyFromLocalStorage();
    if (!base64 || base64.length < 43 || base64.length > 44)
        return;

    try {
        const imported = await crypto.importKey(base64);
        localStorage.setItem('bunathon2025-dashboard-key', base64);
        if (location.search !== '') {
            const url = location.toString();
            location.replace(url.substring(0, url.indexOf('?')));
        }
        return imported;
    } catch {

    }
}

async function createStateLoader(/** @type {CryptoKey} */ key) {
    // We don't want to have the bucket url public for everyone, because they could mess with our data.
    // So we protect it with a symmetric key, so only a limited group of user can access it.
    // This was created together with the key via crypto.initialize.
    const encryptedBucketUrl = config.encryptedBucketUrl;

    const url = isDevelopment ? './debug-dashboard-live.json'
        : await crypto.decrypt(encryptedBucketUrl, key);

    /** @returns {Promise<Record<string, string>>} */
    async function decryptSupporters(/** @type {string} */ encryptedSupporters) {
        const plaintext = await crypto.decrypt(encryptedSupporters, key);
        return /** @type {Record<string, string>} */(JSON.parse(plaintext));
    }

    function applySupporters(
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

    return /** @returns {Promise<DecryptedDashboardLiveJson | null>} */ async function () {
        try {
            const response = await fetch(url);
            if (!response.ok)
                return null;

            const encrypted = /** @type {EncryptedDashboardLiveJson} */(await response.json());

            const supporters = await decryptSupporters(encrypted.encryptedSupporters);
            const result = /** @type {DecryptedDashboardLiveJson} */(encrypted);
            delete /** @type {Record<string, unknown>} */(result)['encryptedSupporters'];
            delete /** @type {Record<string, unknown>} */(result)['supporters'];
            applySupporters(supporters, result);
            return result;
        } catch (err) {
            console.error("Failed to fetch state", err);
            return null;
        }
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
    fetchInterval: isDevelopment ? 1000 : 15000,
};

const app = await (async function () {

    const key = await tryLoadKeyFromSearch();
    if (!key) {
        loadingState.innerText = "Invalid key";
        return;
    }

    const fetchState = await createStateLoader(key);
    if (!fetchState) {
        loadingState.innerText = "Invalid key";
        return;
    }



    let model = (/** @returns {UIModel} */ function () {
        return {
            data: null,
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
            "bitsCheers": buildGroup('cheerer'),
            "overallSupporters": buildGroup('supporter'),
        };
    })();

    function formatTimestamp(
        /** @type {Date} */ today,
        /** @type {string} */ timestampStr) {

        const date = new Date(timestampStr);
        if (today < date)
            return date.toLocaleTimeString();

        return `${date.getDate().toLocaleString(undefined, {minimumIntegerDigits: 2})}.${date.getMonth() + 1}. ${date.toLocaleTimeString()}`;
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

    function renderEvents(/** @type {DashboardEvents} */ events) {
        const eventRowTemplate = getElementById('event-row-template', 'template');
        if (!eventRowTemplate)
            return;

        const eventsTableBody = getElementById('event-table-body', 'tbody');
        if (!eventsTableBody)
            return;

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        /** @returns {HTMLTableCellElement | null} */
        function getTableCell(
            /** @type {HTMLTableRowElement} */ row,
            /** @type {string} */ className
        ) {
            return row.querySelector(`td.${className}`);
        }

        for (let i = 0; i < events.length; i++) {
            const event = events[i];
            const key = `${event.timestamp}-${event.supporter}-${event.category}`;
            let element = /** @type {HTMLTableRowElement | undefined} */(eventsTableBody.children[i]);
            if (!element) {
                const result = /** @type {Element} */(eventRowTemplate.content.cloneNode(true));
                element = /** @type {HTMLTableRowElement} */(result.firstElementChild);
                eventsTableBody.appendChild(element);
                element.setAttribute('data-key', key);
            }
            else if (element.getAttribute('data-key') !== key) {
                // Probably an old event, create a new entry and move it above
                const result = /** @type {Element} */(eventRowTemplate.content.cloneNode(true));
                const newElement = /** @type {HTMLTableRowElement} */(result.firstElementChild);
                eventsTableBody.insertBefore(newElement, element);
                element = newElement;
                element.setAttribute('data-key', key);
            }

            trySetTextContentIfChanged(
                getTableCell(element, 'timestamp'),
                formatTimestamp(today, event.timestamp)
            );
            trySetTextContentIfChanged(
                getTableCell(element, 'viewer-name'),
                event.supporter
            );
            trySetTextContentIfChanged(
                getTableCell(element, 'category'),
                formatCategory(event.category)
            );
            trySetTextContentIfChanged(
                getTableCell(element, 'amount'),
                `${event.amount}`
            );
            trySetTextContentIfChanged(
                getTableCell(element, 'points'),
                formatPoints(event.points)
            );
        }

        for (let i = eventsTableBody.children.length - 1; i >= events.length; i--) {
            eventsTableBody.removeChild(eventsTableBody.children[i]);
        }
    }

    function render() {
        const data = model.data;
        if (!data) {
            trySetTextContentIfChanged(loadingState,
                'Fetching data...');
            return;
        }

        trySetTextContentIfChanged(loadingState, '');

        trySetTextContentIfChanged(
            getElementById('wheel-spins-count', 'p'),
            `${data.wheelSpins}`);
        trySetTextContentIfChanged(
            getElementById('postcards-count', 'p'),
            `${data.postcards}`);
        trySetTextContentIfChanged(
            getElementById('artwork-names-count', 'p'),
            `${data.namesOnArtwork}`);
        trySetTextContentIfChanged(
            getElementById('keychains-count', 'p'),
            `${data.keychains}`);

        // Setze alle Ranglisten-Einträge
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

        // Fülle die Ereignisliste effizient mit Schlüssel
        renderEvents(data.events);
    }

    render();

    async function main() {
        const fetchAndUpdate = async () => {
            const data = await fetchState();

            model.data = data;

            render();
        }

        await fetchAndUpdate();

        setInterval(fetchAndUpdate, settings.fetchInterval);
    }

    return {
        main,
        render,
    };
})();

await app?.main();


