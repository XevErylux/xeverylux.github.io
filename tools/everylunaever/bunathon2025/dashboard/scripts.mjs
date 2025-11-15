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

/** @returns {Promise<Record<string, string>>} */
async function decryptSupporters(
        /** @type {CryptoKey} */ key,
        /** @type {string} */ encryptedSupporters) {
    const plaintext = await crypto.decrypt(encryptedSupporters, key);
    return /** @type {Record<string, string>} */(JSON.parse(plaintext));
}

async function createLiveStateLoader(/** @type {CryptoKey} */ key) {
    // We don't want to have the basket url public for everyone, because they could mess with our data.
    // So we protect it with a symmetric key, so only a limited group of user can access it.
    // This was created together with the key via crypto.initialize.
    const encryptedBasketUrl = config.encryptedLiveBasketUrl;

    const url = isDevelopment ? './debug-dashboard-live.json'
        : await crypto.decrypt(encryptedBasketUrl, key);

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

            const supporters = await decryptSupporters(key, encrypted.encryptedSupporters);
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

async function createDetailsStateLoader(/** @type {CryptoKey} */ key) {
    // We don't want to have the basket url public for everyone, because they could mess with our data.
    // So we protect it with a symmetric key, so only a limited group of user can access it.
    // This was created together with the key via crypto.initialize.
    const encryptedBasketUrl = config.encryptedDetailsBasketUrl;

    const url = isDevelopment ? './debug-dashboard-details.json'
        : await crypto.decrypt(encryptedBasketUrl, key);

    function applySupporters(
        /** @type {Record<string, string>} */ supporters,
        /** @type {DecryptedDashboardDetailsJson} */ json) {
        for (const entry of json.subbombsPerUser) {
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

    return /** @returns {Promise<DecryptedDashboardDetailsJson | null>} */ async function () {
        try {
            const response = await fetch(url);
            if (!response.ok)
                return null;

            const encrypted = /** @type {EncryptedDashboardDetailsJson} */(await response.json());

            const supporters = await decryptSupporters(key, encrypted.encryptedSupporters);
            const result = /** @type {DecryptedDashboardDetailsJson} */(encrypted);
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

/** @param {PointerEvent} e */
function dialogClickHandler(e) {
    if (e.target && e.target instanceof HTMLDialogElement) {
        const rect = e.target.getBoundingClientRect();

        const clickedInDialog = (
            rect.top <= e.clientY &&
            e.clientY <= rect.top + rect.height &&
            rect.left <= e.clientX &&
            e.clientX <= rect.left + rect.width
        );

        if (clickedInDialog)
            return;

        e.target.close();
    }
}


const settings = {
    fetchInterval: isDevelopment ? 1000 : 15000,
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

    const fetchLive = await createLiveStateLoader(key);
    if (!fetchLive) {
        loadingState.innerText = "Invalid key";
        return;
    }

    const fetchDetails = await createDetailsStateLoader(key);
    if (!fetchDetails) {
        loadingState.innerText = "Invalid key";
        return;
    }

    let model = (/** @returns {UIModel} */ function () {
        return {
            live: null,
            details: null,
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
            /** @type {{ rowCells: { [x: string]: { sortValue: any; }; }; }} */ a,
            /** @type {{ rowCells: { [x: string]: { sortValue: any; }; }; }} */ b) {
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

    function handleModalClose(/** @type {Event} */ ev) {
        if (model.dialog) {
            if (model.dialog.element === ev.target) {
                model.dialog = undefined;
            }
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

            const dialog = model.dialog;
            if (!dialog)
                return;

            const index = dialog.sortBy.findIndex(x => x.name === className);
            if (index === 0) {
                const element = dialog.sortBy[0];
                element.direction = flipSortDirection(element.direction);
            } else {
                if (index > -1) {
                    dialog.sortBy.splice(index, 1);
                }

                dialog.sortBy.splice(0, 0, {
                    name: className,
                    direction: 'DESC',
                });
            }

            renderDialog();
        }
    }

    function directionToSymbol(/** @type {SortDirection} */ direction) {
        switch (direction) {
            case 'ASC': return '▲';
            case 'DESC': return '▼';
            default: throw unreachable(direction);
        }
    }

    function openDialog(/** @type {string} */ id) {
        const dialog = model.dialog;
        if (!dialog)
            return;

        const dialogElement = getElementById(id, 'dialog');
        if (!dialogElement)
            return;

        if (dialog.element && dialog.element !== dialogElement) {
            dialog.element.requestClose();
        }

        if (!dialogElement.open) {
            dialogElement.showModal();
            dialogElement.onclick = dialogClickHandler;
            dialogElement.onclose = handleModalClose;

            const tableElement = dialogElement.querySelector("table");
            if (tableElement) {
                tableElement.onclick = tableClickHandler;
            }
        }

        dialog.element = dialogElement;

        const activeSortingElement = dialogElement.querySelector("span.active-sorting");
        if (activeSortingElement) {
            /** @type {Record<string, string>} */
            const columnHeaders = {};
            for (const th of
                [.../** @type {NodeListOf<HTMLTableCellElement>} */(
                    dialogElement.querySelectorAll("table thead tr th")
                )]) {
                columnHeaders[th.className] = th.textContent;
            }
            const sortString = dialog.sortBy
                .map(c => {
                    const textContent = columnHeaders[c.name];
                    return `${textContent ?? name} ${directionToSymbol(c.direction)}`;
                })
                .join(", ");
            trySetTextContentIfChanged(activeSortingElement, sortString);
        }

        return dialogElement;
    }

    function buildAllSupports(
        /** @type {DecryptedDashboardDetailsJson} */ data
    ) {
        /** @type {(AllSupportsPerUserEntry)[]} */
        const allSupports = [];
        for (const subgift of data.subgiftsPerUser) {
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

    function renderDialog() {
        const dialog = model.dialog;
        if (!dialog)
            return;

        const data = model.details;
        if (!data)
            return;

        dialog.isDirty = false;

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        switch (dialog.type) {
            case "wheelSpins":
                {
                    const dialogElement = openDialog('wheel-spins-details');
                    if (!dialogElement)
                        return;

                    const rowTemplate = getElementById('wheel-spins-details-row-template', 'template');
                    if (!rowTemplate)
                        return;

                    const tableBody = dialogElement.querySelector('tbody');
                    if (!tableBody)
                        return;

                    renderTable(
                        dialog.sortBy,
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

            case "keychains":
            case "namesOnArtwork":
            case "postcards":
                {
                    const dialogElement = openDialog('subgifts-details');
                    if (!dialogElement)
                        return;

                    const [elementIdPrefix, minCount] = (function (type) {
                        switch (type) {
                            case "postcards": return ["postcards", 50];
                            case "namesOnArtwork": return ["artwork-names", 100];
                            case "keychains": return ["keychains", 200];
                            default: throw unreachable(type);
                        }
                    })(dialog.type);

                    const cardHeaderText = document.querySelector(`.summary .card#${elementIdPrefix}-card > h3`)?.textContent ?? '<unknown>';
                    const subgiftsDetailsTitle = getElementById('subgifts-details-title', 'h2');
                    if (subgiftsDetailsTitle) {
                        subgiftsDetailsTitle.textContent = cardHeaderText;
                    }

                    const rowTemplate = getElementById('subgifts-details-row-template', 'template');
                    if (!rowTemplate)
                        return;

                    const tableBody = dialogElement.querySelector('tbody');
                    if (!tableBody)
                        return;

                    renderTable(
                        dialog.sortBy,
                        data.subgiftsPerUser.filter(x => x.total >= minCount),
                        bomb => `${bomb.supporter}`,
                        rowTemplate,
                        tableBody,
                        (bomb) => ({
                            'rownum': {
                                text: index => `${index + 1}`,
                                sortValue: 0,
                            },
                            'reached-at': {
                                text: formatTimestamp(today, bomb.reachedAt),
                                sortValue: new Date(bomb.reachedAt).getTime(),
                            },
                            'supporter': {
                                text: bomb.supporter,
                                sortValue: bomb.supporter,
                            },
                            't1': {
                                text: `${bomb.tier1}`,
                                sortValue: bomb.tier1,
                            },
                            't2': {
                                text: `${bomb.tier2}`,
                                sortValue: bomb.tier2,
                            },
                            't3': {
                                text: `${bomb.tier3}`,
                                sortValue: bomb.tier3,
                            },
                            'amount': {
                                text: `${bomb.total}`,
                                sortValue: bomb.total,
                            },
                            'points': {
                                text: formatPoints(bomb.points),
                                sortValue: bomb.points,
                            },
                        }),
                    );
                }
                break;

            case "allSupports":
                {
                    const dialogElement = openDialog('all-supports');
                    if (!dialogElement)
                        return;

                    const rowTemplate = getElementById('all-supports-row-template', 'template');
                    if (!rowTemplate)
                        return;

                    const tableBody = dialogElement.querySelector('tbody');
                    if (!tableBody)
                        return;

                    const allSupports = buildAllSupports(data);

                    renderTable(
                        dialog.sortBy,
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

            default:
                throw unreachable(dialog.type);
        }
    }

    function render() {
        const data = model.live;
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

        // Fülle die Dialoge, falls geöffnet
        renderDialog();
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

                        if (liveEvent.amount >= 25) {
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

    const fetchAndUpdate = async () => {
        let isChanged = false;

        const live = await fetchLive();
        isChanged ||= !!live && live.hash != model.live?.hash;
        model.live = live;

        if (isChanged) {
            // Reset details, in case we revert the live data for some reason
            model.details = null;
        }

        if (model.dialog) {
            // Wait 2000ms, because some API servers do not like two requests in same second
            await wait(2000);
            const details = await fetchDetails();
            if (details?.hash !== model.details?.hash) {
                isChanged = true;
                model.details = details;
            }

            isChanged ||= model.dialog.isDirty;
        }

        if (!isChanged)
            return;

        updateDetailsWithLive();

        try {
            render();
        } catch (err) {
            console.log("Render failed with an exception", err);
        }
    }

    async function main() {
        await fetchAndUpdate();

        setInterval(fetchAndUpdate, settings.fetchInterval);
    }

    /** @returns {SortColumn[]} */
    function defaultDialogSorting(/** @type {UIDialogType} */ type) {
        switch (type) {
            case "allSupports": return [
                { name: "points", direction: 'DESC' },
                { name: 'supporter', direction: 'ASC' },
            ];
            case "keychains": return [{ name: "supporter", direction: 'DESC' }];
            case "namesOnArtwork": return [{ name: "supporter", direction: 'DESC' }];
            case "postcards": return [{ name: "supporter", direction: 'DESC' }];
            case "wheelSpins": return [{ name: "supporter", direction: 'DESC' }];
            default: throw unreachable(type);
        }
    }

    openDialogClicked = (function (type) {
        model.dialog = {
            isDirty: true,
            type: type,
            sortBy: defaultDialogSorting(type),
        };

        if (!model.dialog) {
            fetchAndUpdate();
        } else {
            renderDialog();
        }
    });

    return {
        main,
        render,
    };
})();

await app?.main();


