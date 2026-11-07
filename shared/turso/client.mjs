// @ts-check
/// <reference path="./index.d.ts" />
//
// Turso Cloud access shared by the webapps (dashboard, goal widget).

'use strict';

/**
 * An error from the Turso access. `unrecoverable` true means: token wrong, expired or
 * permissions missing - retrying is pointless, the message should stay on screen.
 */
export class TursoError extends Error {
    /**
     * @param {string} message
     * @param {boolean} [unrecoverable]
     */
    constructor(message, unrecoverable) {
        super(message);
        this.name = 'TursoError';
        this.unrecoverable = !!unrecoverable;
    }
}

/**
 * Turso Cloud - "SQL over HTTP": one POST /v2/pipeline batches several SQLite queries
 * together. All values travel as typed placeholders, never as a concatenated SQL string.
 *
 * @param {DbConnectionInfo} connectionInfo
 * @returns {TursoClient}
 */
export function createTursoClient(connectionInfo) {
    const pipelineUrl = new URL('/v2/pipeline', connectionInfo.url).toString();

    /**
     * @param {TursoArgValue} value
     */
    function toArg(value) {
        if (value === null)
            return { type: /** @type {const} */('null'), value: null };
        if (typeof value === 'boolean')
            return { type: /** @type {const} */('integer'), value: value ? '1' : '0' };
        if (typeof value === 'number')
        {
            if (Number.isInteger(value)) {
                // Turso stores integers as Int64, but JSON only uses double, which
                // can't fit full range. So the API decided, to give an HTTP 400 for
                // integer numbers and force the caller to use string for integers.
                // The string can hold the full Int64 range, so nothing gets lost.
                return { type: /** @type {const} */('integer'), value: `${value}` };
            }

            // Turso float == JSON double. So we can encode them as is.
            return { type: /** @type {const} */('float'), value };
        }
        return { type: /** @type {const} */('text'), value };
    }

    /**
     * @param {TursoStatement[]} statements
     * @returns {Promise<TursoStatementResult[]>}
     */
    async function pipeline(statements) {
        const response = await fetch(pipelineUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${connectionInfo.token}`,
                'Content-Type': 'application/json',
            },
            cache: 'no-store',
            body: JSON.stringify({
                requests: statements.map(statement => ({
                    type: statement.type ?? 'execute',
                    want_rows: statement.wantRows ?? true,
                    stmt: {
                        sql: statement.sql,
                        args: (statement.args ?? []).map(toArg),
                    },
                })),
            }),
        });

        if (!response.ok) {
            const body = await response.text();
            throw new TursoError(
                `HTTP ${response.status} ${response.statusText} bei ${pipelineUrl}: ${body.substring(0, 300)}`,
                // 401/403/404: token missing, expired, or not allowed on that table -
                // once the token expires (1 year) only a new config.json helps.
                response.status === 401 || response.status === 403 || response.status === 404);
        }

        const document = /** @type {TursoPipelineResponse} */(await response.json());

        // Streamed responses (application/x-ndjson) are only requested with "stream": true
        // and are not intended to be used here.
        if (document.baton)
            throw new TursoError('Turso liefert eine gestreamte Antwort (baton), die diese Webapp nicht lesen kann.');

        return document.results.map(result => {
            if (result.type !== 'ok') {
                const code = result.error?.code ?? 'Unknown';
                throw new TursoError(
                    `Turso lehnt die Abfrage ab: ${code} - ${result.error?.message ?? JSON.stringify(result)}`,
                    code === 'Unauthorized' || code === 'Forbidden' || code === 'NotFound');
            }

            const statementResult = result.response?.result;
            const columns = (statementResult?.cols ?? []).map(column => column.name);

            return /** @type {TursoStatementResult} */({
                affectedRowCount: statementResult?.affected_row_count ?? 0,
                rows: (statementResult?.rows ?? []).map(row => Object.fromEntries(
                    row.map((cell, index) => [
                        columns[index] ?? `column_${index}`,
                        // integer/float come back as strings - without Number() the
                        // comparisons and the arithmetic would be wrong.
                        (cell.type === 'integer' || cell.type === 'float') && cell.value !== null
                            ? Number(cell.value)
                            : cell.value,
                    ])
                )),
            });
        });
    }

    return {
        pipeline,

        /**
         * @param {string} sql
         * @param {...TursoArgValue} args
         * @returns {Promise<TursoRow[]>}
         */
        async query(sql, ...args) {
            const [result] = await pipeline([{ sql, args }]);
            return result.rows;
        },

        /**
         * Changing query - only the tokens that own the table allow this (the dashboard
         * token may write goals, the goal widget's token may write nothing at all).
         * Returns the number of affected rows.
         * @param {string} sql
         * @param {...TursoArgValue} args
         * @returns {Promise<number>}
         */
        async execute(sql, ...args) {
            const [result] = await pipeline([{ sql, args, wantRows: false }]);
            return result.affectedRowCount;
        },
    };
}

/**
 * Reads one key from the json_basket table.
 *
 * The heavy content value (the details basket is well over 100 KB) is only transferred if
 * written_at or hash changed since the last call. That comparison runs over the index
 * json_basket_key_written_at_hash so that no content has to be read for it.
 * The written_at is ISO-8601 in UTC, which is why comparing it textually is fine.
 *
 * @param {TursoClient} turso
 * @param {BasketKey} basketKey
 * @returns {BasketReader}
 */
export function createBasketReader(turso, basketKey) {
    const sql = 'SELECT written_at, hash, content FROM json_basket INDEXED BY json_basket_key_written_at_hash WHERE "key" = ? AND (written_at > ? OR hash <> ?)';

    /** @type {{ writtenAt: string, hash: string } | null} */
    let last = null;

    return {
        async read() {
            const [row] = await turso.query(
                sql,
                basketKey,
                last?.writtenAt ?? '0000-01-01T00:00:00.000Z',
                last?.hash ?? ''
            );

            if (!row)
                // unchanged
                return null; 

            last = {
                writtenAt: String(row.written_at),
                hash: String(row.hash),
            };

            return /** @type {BasketContent} */({
                writtenAt: last.writtenAt,
                hash: last.hash,
                content: JSON.parse(String(row.content)),
            });
        },
        invalidate() {
            last = null;
        },
    };
}

/**
 * Reads the goals table.
 * @param {TursoClient} turso
 * @returns {GoalsReader}
 */
export function createGoalsReader(turso) {
    // The dashboard goals editor is the only place to change the goals.
    // For INSERT and UPDATE the written_at column gets updated for the affected rows by the editor.
    // But for DELETE we normally had a problem, because a vanished row can not bump written_at.
    // So the dashboard goals editor is updating written_at of the row with highest id, if the
    // save is only deleting rows. This simplifies the versionSql a lot and only causes one
    // row read per check. Normally you would have to check count(*) and max(id) too, if
    // there would be no other marker for "updated only by delete".
    const versionSql = 'SELECT MAX(written_at) AS last_written_at FROM goals';

    const selectSql = 'SELECT id, points, title, description, written_at FROM goals ORDER BY points, written_at';

    // null = never read yet, '' = the table was empty (MAX() over no rows is NULL).
    /** @type {string | null} */
    let lastWrittenAt = null;

    /** @param {Goal[]} goals */
    function versionOf(goals) {
        return goals.reduce((max, goal) => goal.written_at > max ? goal.written_at : max, '');
    }

    /** @param {TursoRow[]} rows */
    function toGoals(rows) {
        return rows.map(row => /** @type {Goal} */({
            id: Number(row.id),
            // NUMERIC affinity: integer cell for whole numbers, float cell for the rest -
            // createTursoClient already turns both into numbers, Number() only covers a
            // text cell (which a hand-written row in the shell could produce).
            points: Number(row.points),
            title: String(row.title ?? ''),
            description: String(row.description ?? ''),
            written_at: String(row.written_at ?? ''),
        }));
    }

    /** @returns {Promise<Goal[]>} */
    async function readNow() {
        const goals = toGoals(await turso.query(selectSql));
        lastWrittenAt = versionOf(goals);
        return goals;
    }

    return {
        /** @returns {Promise<Goal[] | null>} null if unchanged */
        async read() {
            const [probe] = await turso.query(versionSql);
            if (!probe)
                return null;

            const version = String(probe.last_written_at ?? '');
            if (lastWrittenAt !== null && version === lastWrittenAt)
                // unchanged
                return null;

            return readNow();
        },

        /** @returns {Promise<Goal[]>} */
        readNow,

        invalidate() {
            lastWrittenAt = null;
        },
    };
}
