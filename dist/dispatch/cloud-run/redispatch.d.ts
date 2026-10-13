/** A job that has not claimed its run by then is treated as lost and started again. */
export declare const REDISPATCH_AFTER_MS: number;
export declare const MAX_DISPATCH_ATTEMPTS = 3;
/** What the app stores per queue event. */
export type DispatchAttempts = {
    /** Executions started, or being started, for this queue event. */
    attempts: number;
    lastDispatchedAt: number;
};
export type RedispatchPolicy = {
    redispatchAfterMs?: number;
    maxAttempts?: number;
};
/**
 * The record to write if an execution should start now, or null if not. A
 * first dispatch always starts; another starts once the last is
 * `redispatchAfterMs` old, until `maxAttempts` have started.
 */
export declare function planDispatch(existing: DispatchAttempts | null, now: number, policy?: RedispatchPolicy): DispatchAttempts | null;
/**
 * The record to write when no execution started. The attempt is given back, so
 * a configuration mistake or a Google outage cannot use up a run's allowance;
 * `lastDispatchedAt` stays, so it is tried again after the usual interval.
 */
export declare function returnAttempt(record: DispatchAttempts): DispatchAttempts;
