/// @ts-check

import * as crypto from "./crypto.mjs";
import config from "./config.json" with { type: 'json' };

'use strict';


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
        if (location.host === '127.0.0.1:5500') {
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
    /** @type {{totalPoints: number | undefined | null}} */
    let model = { totalPoints: undefined };

    function setTotalPoints(/** @type {number | null} */ totalPoints) {
        model.totalPoints = totalPoints;
    }

    function render() {
        const totalPoints = model.totalPoints;
        if (totalPoints === undefined)
            counter.innerText = '...';
        else if (totalPoints === null)
            counter.innerText = 'Error';
        else
            counter.innerText = totalPoints.toLocaleString();
    }

    return {
        setTotalPoints,
        render,
    };
})();



async function main() {
    counter.innerText = "...";

    const fetchState = await createStateLoader();
    if (!fetchState) {
        counter.innerText = "Invalid key";
        return;
    }

    const fetchAndUpdate = async () => {
        const total = await fetchState();

        ui.setTotalPoints(total);
        ui.render();
    }

    await fetchAndUpdate();

    setInterval(fetchAndUpdate, 15000);
}

await main();
