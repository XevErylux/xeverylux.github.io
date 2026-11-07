// @ts-check
/// <reference path="./index.d.ts" />
//
// Turso Cloud access shared by the webapps (dashboard, goal widget).
// Everything below was measured against the running bunathon2026 database -
// the surprises are documented in docs/Turso/queries.sql (section 5) and
// docs/Turso/Datenbank.md.

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
 * Which statements the token allows is decided by its Fine-Grained Permissions
 * (docs/Turso/token-*.sh): the goal widget's token may only read json_basket and goals,
 * the dashboard's token may change the goals table completely.
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
            // Measured against the running server (docs/Turso/queries.sql, section 5):
            // an integer value has to travel as a string ({"value":41} gives HTTP 400
            // "expected a borrowed string"), a float value has to travel as a JSON number
            // ({"value":"41.25"} gives "expected f64"). Exactly the other way round than
            // one would guess - and the reason why goals with fractional points work.
            return Number.isInteger(value)
                ? { type: /** @type {const} */('integer'), value: `${value}` }
                : { type: /** @type {const} */('float'), value };
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
 * written_at or hash changed since the last call; that comparison runs over the index
 * json_basket_key_written_at_hash so that no content has to be read for it (see
 * docs/Turso/queries.sql, "change check"). written_at is ISO-8601 in
 * UTC, which is why comparing it textually is fine.
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
                return null; // unchanged

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
 *
 * Same idea as the basket reader: before the list is transferred, a cheap probe asks
 * whether anything changed at all. COUNT(*), MAX(written_at) and SUM(id) together see
 * INSERT, UPDATE and DELETE, and they return zero rows when the table is untouched.
 * That only works because every write sets written_at from the database clock
 * (strftime(...,'now')) instead of the client clock - a device with a wrong clock would
 * silently break MAX(written_at) as a version marker.
 *
 * @param {TursoClient} turso
 * @returns {GoalsReader}
 */
export function createGoalsReader(turso) {
    const probeSql = 'WITH state AS (SELECT COUNT(*) AS n, COALESCE(MAX(written_at), \'\') AS last_written_at, COALESCE(SUM(id), 0) AS id_sum FROM goals) SELECT n, last_written_at, id_sum FROM state WHERE n <> ? OR last_written_at <> ? OR id_sum <> ?';
    const selectSql = 'SELECT id, points, title, description, written_at FROM goals ORDER BY points, written_at';

    /** @type {GoalsFingerprint | null} */
    let last = null;

    /** @param {Goal[]} goals */
    function fingerprintOf(goals) {
        return /** @type {GoalsFingerprint} */({
            count: goals.length,
            lastWrittenAt: goals.reduce((max, goal) => goal.written_at > max ? goal.written_at : max, ''),
            idSum: goals.reduce((sum, goal) => sum + goal.id, 0),
        });
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

    return {
        /** @returns {Promise<Goal[] | null>} null if unchanged */
        async read() {
            const [probe] = await turso.query(
                probeSql,
                last?.count ?? -1,
                last?.lastWrittenAt ?? '',
                last?.idSum ?? -1);

            if (!probe)
                return null; // unchanged

            const goals = toGoals(await turso.query(selectSql));
            last = fingerprintOf(goals);
            return goals;
        },

        /** @returns {Promise<Goal[]>} */
        async readNow() {
            const goals = toGoals(await turso.query(selectSql));
            last = fingerprintOf(goals);
            return goals;
        },

        invalidate() {
            last = null;
        },
    };
}
