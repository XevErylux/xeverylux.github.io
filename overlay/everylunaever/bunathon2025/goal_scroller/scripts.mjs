/// @ts-check
/// <reference path="./index.d.ts" />

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

/** @type {Record<GoalState, GoalState> & {active: "active", upcoming: "upcoming", completed: "completed"}} */
const GoalStates = {
    active: "active",
    completed: "completed",
    upcoming: "upcoming",
};

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
        try {
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
        } catch (err) {
            console.error("Failed to fetch points value", err);
            return null;
        }
    };
}

/**
 * @returns {Goal[]}
 */
function loadGoalsFromConfig() {
    /** @type {Goal[]} */
    const goals = [];

    for (const goalConfig of config.goals) {
        /** @type {Goal} */
        const goal = {
            config: goalConfig,
        };

        goals.push(goal);
    }

    return goals;
}

/**
 * @param {number} points
 * @returns {number | null}
 */
function calculateDoneIndex(points) {
    const index = config.goals.findLastIndex(x => x.points <= points);
    return index < 0 ? null : index;
}

/**
 * @param {number} initialPoints
 * @returns {ScrollerAnimation}
 */
function initializeAnimation(initialPoints) {
    return {
        type: "static",
        doneIndex: calculateDoneIndex(initialPoints),
    };
}

function setTextContentIfChanged(
        /** @type {HTMLSpanElement} */ element,
        /** @type {string} */ text
) {
    if (element.textContent === text)
        return;

    element.textContent = text;
}

const ui = (function () {
    const settings = {
        maxGoalsEntryCount: 3,
        // The CSS Animation is exactly 2s. Give it additional 50ms, so its definitely done.
        scrollAnimationDuration: 2050,
    };

    const maximum = Math.max(...config.goals.map(x => x.points));

    let model = (/** @returns {UIModel} */ function () {
        const initialTotalPoints = isDevelopment ? 0 : 0;
        return {
            totalPoints: initialTotalPoints,
            goals: loadGoalsFromConfig(),
            animation: initializeAnimation(initialTotalPoints),
        };
    })();

    function setTotalPoints(/** @type {number | null} */ totalPoints) {
        model.totalPoints = totalPoints;
    }

    function updateScrollerAnimation() {
        let animation = model.animation;
        if (animation.activeTimeout)
            return;

        let totalPoints = model.totalPoints;
        if (typeof totalPoints !== "number")
            return;

        const currentDoneIndex = animation.doneIndex;
        const targetDoneIndex = calculateDoneIndex(totalPoints);

        function setAnimation(/** @type {ScrollerAnimation} */ updated) {
            model.animation = animation = updated;
        }

        function startAnimation() {
            if ((currentDoneIndex ?? -1) > (targetDoneIndex ?? -1)) {
                // Probably the calculation was improved which resulted to revert
                // an already done goal?
                setAnimation({
                    type: "downwards:begin",
                    doneIndex: currentDoneIndex,
                });
            } else {
                // Finish next goal
                setAnimation({
                    type: "upwards:begin",
                    doneIndex: (currentDoneIndex ?? -1) + 1,
                });
            }
        }

        // Write out every possible state, to be easier to reason about
        switch (animation.type) {
            case "static":
                if (currentDoneIndex === targetDoneIndex)
                    // Already on correct index
                    return;

                startAnimation();
                break;

            case "upwards:end":
                setAnimation({
                    type: "static",
                    doneIndex: animation.doneIndex,
                });
                if (currentDoneIndex === targetDoneIndex)
                    return;

                break;
            case "downwards:end":
                setAnimation({
                    type: "static",
                    doneIndex: animation.doneIndex,
                });
                if (currentDoneIndex === targetDoneIndex)
                    return;

                break;

            case "upwards:begin":
                setAnimation({
                    type: "upwards:moving",
                    doneIndex: animation.doneIndex,
                });
                break;

            case "upwards:moving":
                setAnimation({
                    type: "upwards:end",
                    doneIndex: animation.doneIndex,
                });
                break;

            case "downwards:begin":
                setAnimation({
                    type: "downwards:moving",
                    doneIndex: animation.doneIndex,
                });
                break;

            case "downwards:moving":
                setAnimation({
                    type: "downwards:end",
                    doneIndex: animation.doneIndex === null || animation.doneIndex === 0 ? null : animation.doneIndex - 1,
                });
                break;

            default:
                throw unreachable(animation);
        }

        // Automatically proceed after the timeout with our state machine.
        animation.activeTimeout = setTimeout(function () {
            animation.activeTimeout = undefined;

            renderGoals();
        }, settings.scrollAnimationDuration);
    }

    function createNewGoalElement() {
        const result = /** @type {Element} */(goalEntryTemplate.content.cloneNode(true));
        return /** @type {HTMLDivElement} */(result.firstElementChild);
    }

    /** @returns {{state: GoalState, position: number, animation?: GoalAnimation} | undefined} */
    function determineGoalInfo(
        /** @type {number} */ index,
        /** @type {Goal} */ goal
    ) {
        const scrollAnimation = model.animation;
        const position = index - (scrollAnimation.doneIndex ?? 0);
        if (position < -2)
            return;

        const remaining = model.goals.length - (scrollAnimation.doneIndex ?? 0);
        const levels = (/** @returns {GoalState[] | undefined} */ function () {
            switch (remaining) {
                case 1:
                    return ["completed", "completed", "completed", "completed"];

                case 2:
                    return ["completed", "completed", "completed", "active"];

                case 3:
                    return ["completed", "completed", "active", "upcoming"];
            }

            if (scrollAnimation.doneIndex === null && scrollAnimation.type === "downwards:end") {
                return ["active", "active", "upcoming", "upcoming"];
            }
        })();

        const elementAnimation = (/** @returns {{covered: GoalAnimation | undefined, others: GoalAnimation | undefined}} */ function () {
            switch (scrollAnimation.type) {
                case "static":
                    return { covered: undefined, others: "clear" };

                case "upwards:begin":
                    return { covered: undefined, others: undefined };

                case "upwards:moving":
                    return { covered: undefined, others: scrollAnimation.doneIndex === 0 || remaining <= 2 ? undefined : "up" };

                case "upwards:end":
                    return { covered: "no-box-shadow", others: scrollAnimation.doneIndex === 0 || remaining <= 2 ? undefined : "up" };

                // Note: truthy of scrollAnimation.doneIndex is the same as 'scrollAnimation.doneIndex !== null && scrollAnimation.doneIndex !== 0'
                case "downwards:begin":
                    return { covered: "no-box-shadow", others: scrollAnimation.doneIndex && remaining > 2 ? "down" : undefined };

                case "downwards:moving":
                    return { covered: undefined, others: scrollAnimation.doneIndex && remaining > 2 ? "down" : undefined };

                case "downwards:end":
                    return { covered: "no-box-shadow", others: scrollAnimation.doneIndex && remaining > 2 ? "clear" : undefined };

                default:
                    throw unreachable(scrollAnimation);
            }
        })();

        const picker = position + (remaining <= 3 ? 3 - remaining : 0);
        const positionOffset = (scrollAnimation.doneIndex ?? -1) >= 1 && remaining >= 3 ? 1 : 0;

        switch (scrollAnimation.type) {
            case "static":
                if (scrollAnimation.doneIndex === null) {
                    switch (picker) {
                        case 0: return { state: levels?.[picker + 1] ?? "active", position: picker, animation: elementAnimation.others };
                        case 1: return { state: levels?.[picker + 1] ?? "upcoming", position: picker, animation: elementAnimation.others };
                        case 2: return { state: levels?.[picker + 1] ?? "upcoming", position: picker, animation: elementAnimation.others };
                        default: return;
                    }
                } else {
                    switch (picker) {
                        case 0: return { state: levels?.[picker + 1] ?? "completed", position: picker, animation: elementAnimation.others };
                        case 1: return { state: levels?.[picker + 1] ?? "active", position: picker, animation: elementAnimation.others };
                        case 2: return { state: levels?.[picker + 1] ?? "upcoming", position: picker, animation: elementAnimation.others };
                        default: return;
                    }
                }

            case "upwards:begin":
            case "upwards:moving":
            case "upwards:end":
            case "downwards:begin":
            case "downwards:moving":
            case "downwards:end":
                switch (picker) {
                    case -1:
                        if (remaining <= 2) return;
                        return { state: levels?.[picker + 1] ?? "completed", position: picker + positionOffset, animation: elementAnimation.covered };
                    case 0:
                        return { state: levels?.[picker + 1] ?? "completed", position: picker + positionOffset, animation: elementAnimation.others };

                    case 1: return { state: levels?.[picker + 1] ?? "active", position: picker + positionOffset, animation: elementAnimation.others };
                    case 2: return { state: levels?.[picker + 1] ?? "upcoming", position: picker + positionOffset, animation: elementAnimation.others };
                    default: return;
                }


            default:
                throw unreachable(scrollAnimation);
        }
    }

    function placeGoal(
        /** @type {HTMLDivElement} */
        element,
        /** @type {number} */
        position,
    ) {
        const currentElement = goalsContainer.children[position];
        if (currentElement == element)
            return;

        if (!currentElement) {
            goalsContainer.appendChild(element);
        } else {
            goalsContainer.insertBefore(element, currentElement);
        }

        element.setAttribute('data-active-transition', '');
    }

    function renderGoal(
        /** @type {number} */ index) {
        const goal = model.goals[index];
        const goalConfig = goal.config;
        const info = determineGoalInfo(index, goal);

        if (info === undefined) {
            if (goal.element) {
                if (goalsContainer.contains(goal.element)) {
                    goalsContainer.removeChild(goal.element);
                }
            }
            return;
        }

        if (!goal.element) {
            const element = createNewGoalElement();;
            element.setAttribute('data-points', `${goal.config.points}`);
            goal.element = element;
        }

        const element = goal.element;
        element.setAttribute('data-state', info.state);
        placeGoal(element, info.position);
        if (info.animation) {
            element.setAttribute('data-move', info.animation);
        } else {
            element.removeAttribute('data-move');
        }

        /** @type {HTMLSpanElement | null} */
        const titleSpan = element.querySelector("span.title");
        if (titleSpan) {
            setTextContentIfChanged(titleSpan, goalConfig.text);
        }

        /** @type {HTMLDivElement | null} */
        const titleContainer = element.querySelector("div.title-container");
        if (titleContainer) {
            if (titleContainer.scrollWidth > titleContainer.clientWidth) {
                titleContainer.style.setProperty('--scroll-width', `${titleContainer.scrollWidth}px`);
                titleContainer.style.setProperty('--client-width', `${titleContainer.clientWidth}px`);
                // animation-delay does not work properly. Apply it with setTimeout instead.
                setTimeout(function () {
                    if (titleContainer.scrollWidth > titleContainer.clientWidth) {
                        titleContainer.classList.add('marquee');
                    }
                }, 4000);
            } else {
                titleContainer.classList.remove('marquee');
                titleContainer.style.removeProperty('--scroll-width');
                titleContainer.style.removeProperty('--client-width');
            }
        }

        /** @type {HTMLSpanElement | null} */
        const pointsSpan = element.querySelector("span.points");
        if (pointsSpan) {
            setTextContentIfChanged(pointsSpan, goalConfig.points.toLocaleString());
        }

        /** @type {HTMLSpanElement | null} */
        const subtextSpan = element.querySelector("span.subtext");
        if (subtextSpan) {
            setTextContentIfChanged(subtextSpan, goalConfig.subtext ?? '');
        }

        element.style.setProperty('--client-height', `${element.clientHeight}px`);
    }

    function renderGoals() {
        updateScrollerAnimation();

        goalsContainer.setAttribute('data-scroll-state', model.animation.type);

        const goals = model.goals.length;
        for (let i = 0; i < goals; i++) {
            renderGoal(i);
        }
    }

    function render() {
        const totalPoints = model.totalPoints;
        if (totalPoints === undefined)
            setTextContentIfChanged(counterValue, '...');
        else if (totalPoints === null)
            setTextContentIfChanged(counterValue, 'Error');
        else
            setTextContentIfChanged(counterValue, Math.floor(totalPoints).toLocaleString());

        setTextContentIfChanged(counterMaximum, maximum.toLocaleString());

        renderGoals();
    }

    render();

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
