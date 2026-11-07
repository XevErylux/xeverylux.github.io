
/**
 * Turso Cloud "SQL over HTTP": one request in a single /v2/pipeline call.
 * args always travel as typed placeholders, never as a concatenated SQL string.
 */
type TursoArgValue = string | number | boolean | null;

type TursoStatement = {
    sql: string,
    args?: TursoArgValue[],
    /**
     * default: "execute". Measured against bunathon2026 (/v2/pipeline answers 400 with
     * "unknown variant ..., expected one of close, execute, batch, sequence, describe,
     * store_sql, close_sql, get_autocommit"): "read" and "write" do not exist, so only
     * "execute" is used here. "batch" exists but is not a transaction on this server and
     * "condition" is ignored - see docs/Turso/queries.sql, section 5.
     */
    type?: 'execute',
    /** default: true */
    wantRows?: boolean,
};

type TursoCell = {
    type: 'text' | 'integer' | 'float' | 'blob' | 'null',
    value: string | number | null,
};

type TursoClient = {
    pipeline(statements: TursoStatement[]): Promise<TursoStatementResult[]>,
    query(sql: string, ...args: TursoArgValue[]): Promise<TursoRow[]>,
    /** Allowed for goals only - the dashboard token may not write to json_basket. */
    execute(sql: string, ...args: TursoArgValue[]): Promise<number>,
};

/** A row as an object of column name -> value (integer/float are converted to number). */
type TursoRow = Record<string, string | number | null>;

type TursoStatementResult = {
    affectedRowCount: number,
    rows: TursoRow[],
};

type TursoPipelineResponse = {
    baton: string | null,
    base_url: string | null,
    results: {
        type: 'ok' | 'error',
        response?: {
            type: string,
            result?: {
                cols?: { name: string, decltype?: string }[],
                rows?: TursoCell[][],
                affected_row_count?: number,
            },
        },
        error?: { code: string, message: string, sql?: string },
    }[],
};

type DbConnectionInfo = {
    url: string,
    token: string
};

/** The three keys that the C# program writes into json_basket. */
type BasketKey = 'points' | 'dashboard-live' | 'dashboard-details';

type BasketContent<T = any> = {
    /** written_at from json_basket, ISO-8601 in UTC ("2026-10-18T12:56:04.900Z") */
    writtenAt: string,
    hash: string,
    content: T,
};

type BasketReader = {
    /** Returns null if the basket has not changed since the previous call. */
    read(): Promise<BasketContent | null>,
    /** Forgets the remembered written_at/hash so that the next read() fetches again. */
    invalidate(): void,
};

/**
 * A row of the goals table, as it is created in Turso (PRAGMA table_info(goals)):
 *   id INTEGER PRIMARY KEY AUTOINCREMENT, points NUMERIC CHECK (points >= 0),
 *   title TEXT, description TEXT DEFAULT '', written_at TEXT DEFAULT strftime(...)
 * Index: goals_points_written_at (points, written_at).
 * This is the goal list of the goal widget, now stored in the database.
 * The dashboard's incentives (postcards/artwork/keychains) have nothing to do with it,
 * their thresholds (50/100/200) stay hard-coded in the dashboard.
 * Values are normalized in createGoalsReader: Turso reports NUMERIC as an integer cell
 * for whole numbers and as a float cell otherwise, both are converted to number.
 */
type Goal = {
    id: number,
    points: number,
    title: string,
    description: string,
    written_at: string,
};

/**
 * The content of a goal. written_at is deliberately not part of it: it is the version
 * marker of the row ("has anybody touched this row?"), not user data, so two goals with
 * the same content compare equal even when one of them was written later.
 */
type GoalContent = {
    points: number,
    title: string,
    description: string,
};

type GoalsFingerprint = {
    count: number,
    lastWrittenAt: string,
    idSum: number,
};

type GoalsReader = {
    /** null if the goals table has not changed since the previous call. */
    read(): Promise<Goal[] | null>,
    /** Always reads the whole goal list (before saving and when the editor is opened). */
    readNow(): Promise<Goal[]>,
    invalidate(): void,
};
