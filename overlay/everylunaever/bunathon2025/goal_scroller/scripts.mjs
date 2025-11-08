/// @ts-check
/// <reference path="./index.d.ts" />

import * as crypto from "./crypto.mjs";
import config from "./config.json" with { type: 'json' };

'use strict';

const isDevelopment = location.host === '127.0.0.1:5500';

/** @type {{active: "active", upcoming: "upcoming", completed: "completed"}} */
const GoalStates = {
    active: "active",
    completed: "completed",
    upcoming: "upcoming",
};

/** @typedef {typeof config.goals[0]} Goal */
/** @typedef {Goal & { state: keyof GoalStates }} GoalWithState */

async function wait(/** @type {number} */ ms) {
    return new Promise(function (resolve) {
        setTimeout(resolve, ms);
    });
}

async function pageAutoRefresh() {
    // Automatic reload of page - checks config every minute
    let previousText = JSON.stringify(config);
    /** @type {string} */
    let previousEtag = '';
    while (true) {
        await wait(60000);

        try {
            const response = await fetch("./config.json");
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
            previousText = newText;
            window.location.replace(document.location.toString());
        } catch (err) {
            console.error("pageAutoRefresh", err);
            continue;
        }
    }
};

pageAutoRefresh();

async function createStateLoader() {
    async function tryLoadKeyFromSearch() {
        const base64 = new URLSearchParams(location.search).get('key');
        if (!base64 || base64.length < 43 || base64.length > 44)
            return;

        try {
            return await crypto.importKey(base64);
        } catch {

        }
    }

    // We don't want to have the bucket url public for everyone, because they could mess with our data.
    // So we protect it with a symmetric key, so only a limited group of user can access it.
    // This was created together with the key via crypto.initialize.
    const encryptedBucketUrl = config.encryptedBucketUrl;

    const key = await tryLoadKeyFromSearch();
    if (!key) return;

    const url = await crypto.decrypt(encryptedBucketUrl, key);

    return async function () {
        let fetchUrl = url;
        if (isDevelopment) {
            fetchUrl = './debug-points.json';
        }

        const response = await fetch(fetchUrl);
        if (!response.ok)
            return null;

        const body = /** @type {unknown} */(await response.json());
        if (!body
            || typeof body !== "object"
            || Array.isArray(body)
            || !('total' in body))
            return null;

        const total = body.total;
        if (typeof total !== "number")
            return null;

        return total;
    };
}

const ui = (function () {
    const settings = {
        maxGoalsEntryCount: 3,
    };

    let maximum = config.goals.map(x => x.points).sort()[0];
    /** @type {{totalPoints: number | undefined | null}} */
    let model = { totalPoints: undefined };

    function setTotalPoints(/** @type {number | null} */ totalPoints) {
        model.totalPoints = totalPoints;
    }

    /**
     * @returns {GoalWithState[] | undefined}
     */
    function figureOutGoalEntries() {
        const totalPoints = model.totalPoints;
        if (typeof totalPoints !== "number")
            return;

        const doneGoals = config.goals.filter(x => x.points <= totalPoints).reverse();
        const incompleteGoals = config.goals.filter(x => x.points > totalPoints);

        const incompleteGoalsDisplayCount = Math.min(incompleteGoals.length, settings.maxGoalsEntryCount - Math.min(doneGoals.length, 1));
        const doneGoalsDisplayCount = settings.maxGoalsEntryCount - incompleteGoalsDisplayCount;

        const result = [];
        for (let i = Math.min(doneGoals.length, doneGoalsDisplayCount) - 1; i >= 0; i--) {
            result.push({ ...doneGoals[i], state: GoalStates.completed });
        }
        for (let i = 0; i < incompleteGoalsDisplayCount; i++) {
            result.push({ ...incompleteGoals[i], state: i == 0 ? GoalStates.active : GoalStates.upcoming });
        }
        return result;
    }

    function createNewGoalElement() {
        const result = /** @type {Element} */(goalEntryTemplate.content.cloneNode(true));
        return /** @type {HTMLDivElement} */(result.firstElementChild);
    }

    /**
     * 
     * @param {number} index 
     * @returns {HTMLDivElement}
     */
    function getOrCreateGoalElement(index) {
        if (index < 0)
            throw new Error('index was less than zero');

        let element;
        for (let i = goalsContainer.childElementCount; i <= index; i++) {
            element = createNewGoalElement();
            goalsContainer.appendChild(element);
        }

        if (!element)
            return /** @type {HTMLDivElement} */(goalsContainer.children[index]);

        return element;
    }

    function setTextContentIfChanged(
        /** @type {HTMLSpanElement} */ element,
        /** @type {string} */ text
    ) {
        if (element.textContent === text)
            return;

        element.textContent = text;
    }

    function renderGoal(
        /** @type {number} */ index,
        /** @type {GoalWithState} */ goal) {
        const element = getOrCreateGoalElement(index);
        element.setAttribute('data-points', `${goal.points}`);
        element.setAttribute('data-state', goal.state);

        /** @type {HTMLSpanElement | null} */
        const titleSpan = element.querySelector("span.title");
        if (titleSpan) {
            setTextContentIfChanged(titleSpan, goal.text);
        }

        /** @type {HTMLDivElement | null} */
        const titleContainer = element.querySelector("div.title-container");
        if (titleContainer) {
            if (titleContainer.scrollWidth > titleContainer.clientWidth) {
                titleContainer.style.setProperty('--scroll-width', `${titleContainer.scrollWidth}px`);
                titleContainer.style.setProperty('--client-width', `${titleContainer.clientWidth}px`);
                requestAnimationFrame(function () {
                    titleContainer.classList.add('marquee');
                });
            } else {
                titleContainer.classList.remove('marquee');
                titleContainer.style.removeProperty('--scroll-width');
                titleContainer.style.removeProperty('--client-width');
            }
        }

        /** @type {HTMLSpanElement | null} */
        const pointsSpan = element.querySelector("span.points");
        if (pointsSpan) {
            setTextContentIfChanged(pointsSpan, goal.points.toLocaleString());
        }

        /** @type {HTMLSpanElement | null} */
        const subtextSpan = element.querySelector("span.subtext");
        if (subtextSpan) {
            setTextContentIfChanged(subtextSpan, goal.subtext ?? '');
        }
    }

    function cleanupUnneededElements(/** @type {number} */ goalCount) {
        for (let i = goalsContainer.childElementCount - 1; i >= goalCount; i--) {
            const last = goalsContainer.lastElementChild;
            if (!last)
                break;

            goalsContainer.removeChild(last);
        }
    }

    function renderGoals() {
        const goalEntries = figureOutGoalEntries();
        if (!goalEntries)
            return;

        //console.log(goalEntries);
        for (let i = 0; i < goalEntries.length; i++) {
            renderGoal(i, goalEntries[i]);
        }

        cleanupUnneededElements(goalEntries.length);
    }

    function render() {
        const totalPoints = model.totalPoints;
        if (totalPoints === undefined)
            setTextContentIfChanged(counterValue, '...');
        else if (totalPoints === null)
            setTextContentIfChanged(counterValue, 'Error');
        else
            setTextContentIfChanged(counterValue, totalPoints.toLocaleString());

        counterMaximum.innerText = maximum.toLocaleString();

        renderGoals();
    }

    return {
        setTotalPoints,
        render,
    };
})();

async function main() {
    counterValue.innerText = "...";

    const fetchState = await createStateLoader();
    if (!fetchState) {
        counterValue.innerText = "Invalid key";
        return;
    }

    const fetchAndUpdate = async () => {
        const total = await fetchState();

        ui.setTotalPoints(total);
        ui.render();
    }

    await fetchAndUpdate();

    setInterval(fetchAndUpdate, isDevelopment ? 1000 : 15000);
}

await main();
