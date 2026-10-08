import { type ClaimedRun, type EndingOf, type RunEnding, type RunStore, type SettledOf } from "../core/run-store.ts";
/**
 * Returned by `work` or `failed` instead of an ending: leave the run unfinished
 * and stop beating, so the store takes it back when its heartbeat lapses and
 * gives it out again. A run stopped by a shutdown usually wants this, since
 * the store then retries it as it would a crashed worker's; finishing it
 * would end it for good unless the ending is one the store retries.
 */
export declare const RELEASE: unique symbol;
export type Release = typeof RELEASE;
/**
 * Why the work's signal was aborted: a beat said the run was cancelled, or
 * that it is gone (finished elsewhere, given to another worker, or no beat got
 * through for `maxQuietMs`), or the process is shutting down (Cloud Run sends
 * SIGTERM at the task timeout and on a cancelled execution, and SIGKILL ten
 * seconds later).
 */
export type StopReason = "cancelled" | "gone" | "shutdown";
/** Works the claimed run and returns how it ended. Returns soon after `signal` aborts. */
export type Work<Claim> = Claim extends unknown ? (claim: Claim, signal: AbortSignal) => Promise<EndingOf<Claim> | Release> : never;
/** The ending for a run whose work threw. */
export type Failed<Claim> = Claim extends unknown ? (error: unknown, stopped: StopReason | undefined) => EndingOf<Claim> | Release : never;
export type JobOptions<Claim> = {
    runId: string;
    /** Sent with every claim attempt. Defaults to a fresh UUID. */
    idempotencyKey?: string;
    work: Work<Claim>;
    /** Stops the job from outside, as a shutdown signal does. */
    signal?: AbortSignal;
    /** Process signals that stop the job while it runs. Defaults to SIGTERM and SIGINT. */
    shutdownSignals?: readonly NodeJS.Signals[];
    /** Waits between claims that got no answer. Defaults to 1 s, 2 s and 4 s. */
    retryDelaysMs?: readonly number[];
    /**
     * Once the job is shutting down, how long a beat in flight is waited for
     * before the run is finished. Defaults to 1 s, well inside the ten seconds
     * Cloud Run gives before SIGKILL; otherwise the wait is up to one interval.
     */
    shutdownBeatWaitMs?: number;
    /**
     * Stops the work as `gone` once no beat has got through for this long, as a
     * store that fails or reclaims quiet runs will have done. Off by default.
     * Raised to twice the claim's `heartbeatMs` when it is less, so a run is
     * stopped only after a beat had a whole interval to answer and did not.
     */
    maxQuietMs?: number;
    /** Defaults to the claim's own log once there is a claim, and to nowhere before. */
    log?: (message: string) => void;
} & (RunEnding extends EndingOf<Claim> ? {
    /** Defaults to `cancelled` after a cancel, else `failed` with the error's message. */
    failed?: Failed<Claim>;
} : {
    /** Required: there is no default for an ending of the app's own. */
    failed: Failed<Claim>;
});
/**
 * How the execution went. Exit with `exitCode`: 0 when there was nothing to do
 * or the run was finished, 1 when the run was left to the store.
 */
export type JobResult<Claim> = 
/** The run was not there to take: gone, finished, or held under another key. */
{
    kind: "idle";
    exitCode: 0;
}
/** Told to stop before the run was claimed, so it was not. */
 | {
    kind: "stopped";
    exitCode: 1;
}
/** The store refused the claim, or never answered. */
 | {
    kind: "unclaimed";
    error: unknown;
    exitCode: 1;
}
/** The store answered the finish with `settled`. `error` is what the work threw, if it did. */
 | {
    kind: "finished";
    ending: EndingOf<Claim>;
    settled: SettledOf<Claim>;
    stopped?: StopReason;
    error?: unknown;
    exitCode: 0;
}
/** The work or `failed` returned RELEASE; the store takes the run back when its heartbeat lapses. */
 | {
    kind: "released";
    stopped?: StopReason;
    error?: unknown;
    exitCode: 1;
}
/** The run was claimed but not finished; the store will reap it when its heartbeat lapses. */
 | {
    kind: "unfinished";
    ending?: EndingOf<Claim>;
    stopped?: StopReason;
    error: unknown;
    exitCode: 1;
};
/** `failed`'s default for a RunEnding. */
export declare function defaultFailed(error: unknown, stopped: StopReason | undefined): RunEnding;
/**
 * Claims `runId`, works it and finishes it. Nothing is claimed once the job
 * has been told to stop. Only a claim that got no answer is retried, with the
 * same key, so one that landed comes back. Once claimed, the run is finished
 * with what the work returns, or what `failed` returns if it throws, unless
 * that is RELEASE; the signal the work gets may already be aborted.
 *
 * A claim's heartbeat should answer `gone` when the store refuses it (the
 * claim was lost: an expired or taken lease), not reject: a rejection reads
 * as the store being unreachable, and the work goes on.
 */
export declare function runJob<Claim extends ClaimedRun<unknown, never, unknown>>(store: RunStore<Claim>, options: JobOptions<Claim>): Promise<JobResult<Claim>>;
