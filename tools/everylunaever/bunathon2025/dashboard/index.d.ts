declare var loadingState: HTMLSpanElement;

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

type UIModel = {
    data: DecryptedDashboardLiveJson | null,
};
