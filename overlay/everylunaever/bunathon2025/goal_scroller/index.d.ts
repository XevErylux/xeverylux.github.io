declare var counterValue: HTMLSpanElement;
declare var counterMaximum: HTMLSpanElement;
declare var goalEntryTemplate: HTMLTemplateElement;
declare var goalsContainer: HTMLDivElement;

type Config = typeof import('./config.json');

type GoalState = keyof {
    active: true,
    completed: true,
    upcoming: true,
};

type ScrollerAnimationVariant<TType extends string, TAdditional = {}> = {
    /** The direction where each goal element should be moving. */
    type: TType,
    doneIndex: number | null;
    activeTimeout?: number;
} & TAdditional;

type ScrollerAnimation =
    ScrollerAnimationVariant<"static">
    | ScrollerAnimationVariant<"upwards:begin">
    | ScrollerAnimationVariant<"upwards:moving">
    | ScrollerAnimationVariant<"upwards:end">
    | ScrollerAnimationVariant<"downwards:begin">
    | ScrollerAnimationVariant<"downwards:moving">
    | ScrollerAnimationVariant<"downwards:end">;

type GoalAnimation = "up" | "down" | "clear" | "no-box-shadow";

type Goal = {
    config: Config['goals'][0],
    element?: HTMLDivElement,
};

type UIModel = {
    totalPoints: number | null,
    goals: Goal[],
    animation: ScrollerAnimation,
};
