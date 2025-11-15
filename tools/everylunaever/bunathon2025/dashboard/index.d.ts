declare var loadingState: HTMLSpanElement;

declare var openSubpageClicked: ((type: UISubpageType) => void) | undefined;

type TakeIfMatch<ToTake, TActual> = TActual extends ToTake ? ToTake : never;

type Config = typeof import('./config.json');

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

type DashboardEventWithoutCategory = Omit<EncryptedDashboardLiveJsonRaw['events'][0], 'category'>;

type DashboardEvent = Omit<
    DashboardEventWithoutCategory & {
        category: 'DONATION' | 'BITS' | 'SUBSCRIPTION1' | 'SUBSCRIPTION2' | 'SUBSCRIPTION3';
    },
    ''>;

type EncryptedDashboardLiveJsonRaw = typeof import('./debug-dashboard-live.json');

type DashboardEvents = EncryptedDashboardLiveJsonRaw['events'][0] extends DashboardEventWithoutCategory
    ? EncryptedDashboardLiveJsonRaw['events'][0]['category'] extends string ? DashboardEvent[]
    : never : never;

type EncryptedDashboardLiveJson =
    Omit<Omit<EncryptedDashboardLiveJsonRaw, 'leaderboards' | 'events'> & {
        leaderboards: {
            [K in LeaderboardKeys]: TakeIfMatch<LeaderboardGroup, EncryptedDashboardLiveJsonRaw['leaderboards'][K]>;
        };
        events: DashboardEvents;
    }, ''>;
type DecryptedDashboardLiveJson = Omit<EncryptedDashboardLiveJson, "encryptedSupporters" | "supporters">;

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
type SubgiftsPerUserEntry = {
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
    SubgiftsPerUserEntry &
    {
        'bits': number,
        'donations': number,
    };

type EncryptedDashboardDetailsJsonRaw = typeof import('./debug-dashboard-details.json');
type DashboardDetailsPerUserFields = 'bitsPerUser' | 'subbombsPerUser' | 'subgiftsPerUser' | 'donationsPerUser';
type DashboardDetailsEntries<
    TKey extends DashboardDetailsPerUserFields,
    TEntry> = EncryptedDashboardDetailsJsonRaw[TKey][0] extends TEntry ? TEntry[] : never;

type EncryptedDashboardDetailsJson = Omit<Omit<EncryptedDashboardDetailsJsonRaw, DashboardDetailsPerUserFields> & {
    bitsPerUser: DashboardDetailsEntries<'bitsPerUser', BitsPerUserEntry>;
    subbombsPerUser: DashboardDetailsEntries<'subbombsPerUser', SubbombsPerUserEntry>;
    subgiftsPerUser: DashboardDetailsEntries<'subgiftsPerUser', SubgiftsPerUserEntry>;
    donationsPerUser: DashboardDetailsEntries<'donationsPerUser', DonationsPerUserEntry>;
}, ''>;
type DecryptedDashboardDetailsJson = Omit<EncryptedDashboardDetailsJson, "encryptedSupporters" | "supporters">;

type UISubpageType = keyof DecryptedDashboardLiveJson & (
    'wheelSpins' |
    'postcards' |
    'namesOnArtwork' |
    'keychains'
) | 'allSupports';

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

type UIModel = {
    lastFetch: 'live' | 'details' | null,
    live: DecryptedDashboardLiveJson | null,
    details: DecryptedDashboardDetailsJson | null,
    nextDetailsUpdate: Date | null,
    subpage?: UISubpage,
};
