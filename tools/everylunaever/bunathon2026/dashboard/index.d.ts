/// <reference path="../../../../shared/turso/index.d.ts" />

declare var loadingState: HTMLSpanElement;

declare var openSubpageClicked: ((type: UISubpageType) => void) | undefined;

type EncryptedConfig = typeof import('./config.json');

/** completed: threshold reached, active: first open goal, upcoming: behind the active one. */
type GoalState = 'completed' | 'active' | 'upcoming';

/**
 * One row of the goal editor. id === null means "not in the table yet", baseline === null
 * is the same thing: it holds the table state this row was loaded with, which is what a
 * save compares against (optimistic concurrency, see docs/Turso/queries.sql).
 * points/title/description hold exactly what the input fields contain.
 */
type GoalDraft = {
    /** 'g<id>' for loaded rows, 'new<n>' for rows added in the editor */
    key: string,
    id: number | null,
    points: string,
    title: string,
    description: string,
    baseline: (GoalContent & { written_at: string }) | null,
};

type GoalsNoticeKind = 'conflict' | 'error' | 'saved' | 'info';

type GoalsNotice = {
    kind: GoalsNoticeKind,
    text: string,
    lines: string[],
};

type GoalsEditor = {
    drafts: GoalDraft[],
    /** rows the user removed - their written_at is needed for the DELETE guard */
    removed: Goal[],
    notice: GoalsNotice | null,
    /** draft keys of the rows that lost against an external change */
    conflictedKeys: string[],
    saving: boolean,
};

type DataAccess = {
    /** Raw client for custom queries, e.g. maintaining the goals. */
    turso: TursoClient,
    /** null if the basket has not changed since the previous call. */
    readLive(): Promise<DecryptedDashboardLiveJson | null>,
    readDetails(): Promise<DecryptedDashboardDetailsJson | null>,
    /** Read the details in full again next time (after the live data was rolled back). */
    invalidateDetails(): void,
    /** null if the goals table has not changed since the previous call. */
    readGoals(): Promise<Goal[] | null>,
    /** Always reads the whole goal list (before saving and when the editor is opened). */
    readGoalsNow(): Promise<Goal[]>,
};

type LeaderboardEntry = {
    supporter: string;
    points: number;
};

type LeaderboardGroup = {
    top1: LeaderboardEntry | null;
    top2: LeaderboardEntry | null;
    top3: LeaderboardEntry | null;
};

type LeaderboardKeys = 'donators' | 'subGifters' | 'bitsCheers' | 'overallSupporters';

type DashboardEventWithoutCategory = {
    timestamp: string;
    supporter: string;
    amount: number;
    points: number;
};

type DashboardEventCategory = 'DONATION' | 'BITS' | 'SUBSCRIPTION1' | 'SUBSCRIPTION2' | 'SUBSCRIPTION3';

type DashboardEvent = Omit<
    DashboardEventWithoutCategory & {
        category: DashboardEventCategory;
    },
    ''>;

type DashboardEvents = DashboardEvent[];

type EncryptedDashboardLiveJson = {
    leaderboards: {
        donators: LeaderboardGroup;
        subGifters: LeaderboardGroup;
        bitsCheers: LeaderboardGroup;
        overallSupporters: LeaderboardGroup;
    };
    events: DashboardEvents;
    hash: string;
    /**
     * The total points of the Bunathon - the same number that the 'points' basket holds
     * as { "total": ... }, but the dashboard loads the live basket anyway. Comes from
     * Postgres numeric, so the JSON may read 1410.90800000000000000000 (JSON.parse is
     * fine with that). See docs/Turso/Datenbank.md.
     */
    totalPoints: number;
    sportWheels: number;
    postcards: number;
    pins: number;
    encryptedSupporters: string;
    /** Decrypted client-side from encryptedSupporters (hash -> plain name). */
    supporters: Record<string, string>;
};
type DecryptedDashboardLiveJson = Omit<EncryptedDashboardLiveJson, "encryptedSupporters" | "supporters">;

/** The live basket after decryption; writtenAt comes from json_basket. */
type DashboardLiveJson = Omit<DecryptedDashboardLiveJson, "hash"> & {
    hash: string,
    supporters: Record<string, string>,
    writtenAt: Date,
};

type BitsPerUserEntry = {
    supporter: string;
    amount: number;
    points: number;
    reachedAt: string;
};
type SubbombsPerUserEntry = {
    timestamp: string;
    supporter: string;
    tier: number;
    subcount: number;
    points: number;
};
type SubsPerUserEntry = {
    supporter: string;
    tier1: number;
    tier2: number;
    tier3: number;
    total: number;
    points: number;
    reachedAt: string;
};
type DonationsPerUserEntry = {
    supporter: string;
    amount: number;
    points: number;
    reachedAt: string;
};

type AllSupportsPerUserEntry =
    SubsPerUserEntry &
    {
        'bits': number,
        'donations': number,
    };

type EncryptedDashboardDetailsJson = {
    bitsPerUser: BitsPerUserEntry[];
    subbombsPerUser: SubbombsPerUserEntry[];
    individualsubsPerUser: SubsPerUserEntry[];
    selfsubsPerUser: SubsPerUserEntry[];
    subgiftsPerUser: SubsPerUserEntry[];
    donationsPerUser: DonationsPerUserEntry[];
    hash: string;
    encryptedSupporters: string;
    supporters: Record<string, string>;
    latestEventAt: string;
};
type DecryptedDashboardDetailsJson = {
    hash: string;
    bitsPerUser: BitsPerUserEntry[];
    subbombsPerUser: SubbombsPerUserEntry[];
    individualsubsPerUser: SubsPerUserEntry[];
    selfsubsPerUser: SubsPerUserEntry[];
    subgiftsPerUser: SubsPerUserEntry[];
    donationsPerUser: DonationsPerUserEntry[];
    latestEventAt: string;
};

type UISubpageType = keyof DecryptedDashboardLiveJson & (
    'sportWheels' |
    'postcards' |
    'pins'
) | 'allSupports' | 'goals';

type SortDirection = 'ASC' | 'DESC';

type SortColumn = {
    name: string,
    direction: SortDirection,
};

type UISubpage = {
    type: UISubpageType;
    sortBy: SortColumn[];
    element?: HTMLDivElement;
};

type UIElementaryIncentive = {
    supporter: string,
    subcount: number,
    points: number,
    subtier: number,
    encryptedSupporters: string,
    supporters: Record<string, string>,
};

/** The details basket after decryption; writtenAt comes from json_basket. */
type DashboardDetailsJson = EncryptedDashboardDetailsJson & {
    writtenAt: Date,
};

type UIModel = {
    live: DecryptedDashboardLiveJson | null,
    details: DecryptedDashboardDetailsJson | null,
    nextDetailsUpdate: Date | null,
    /** null as long as the goals table has not been read */
    goals: Goal[] | null,
    nextGoalsUpdate: Date | null,
    subpage?: UISubpage,
};
