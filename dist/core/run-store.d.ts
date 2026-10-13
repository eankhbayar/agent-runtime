import type { FinalRunStatus, RunUsage } from "../contract/events.ts";
import type { EventSink, SinkState } from "./run.ts";
/**
 * How a run that answers a prompt ends. Pass these fields and no others: an
 * adapter may forward the ending as it is, and a store that validates its
 * arguments rejects the rest of a RunOutcome, such as its events.
 */
export type RunEnding = {
    status: FinalRunStatus;
    error?: string;
    answerText?: string;
    usage?: RunUsage;
};
export type ClaimRequest = {
    runId: string;
    /**
     * Sent again unchanged when a claim is retried, so a claim that landed but
     * whose answer was lost comes back instead of being refused.
     */
    idempotencyKey: string;
};
/**
 * The store gave no answer, so the request may or may not have landed. The
 * only rejection a claim is retried after, and then with the same key.
 */
export declare class StoreUnreachableError extends Error {
    constructor(message?: string, options?: {
        cause?: unknown;
    });
}
/** A run this worker holds. It is the run's EventSink, so executeRun writes to it. */
export type ClaimedRun<Payload, Ending = RunEnding, Settled = boolean> = EventSink & {
    runId: string;
    /** What the store handed over with the run: the prompt and whatever else the app needs. */
    payload: Payload;
    /** How often to beat so the store does not give the run to someone else. */
    heartbeatMs: number;
    /**
     * Keeps the claim and says whether the run is still wanted. A store that
     * refuses the beat because the claim is lost (hk-legal's rejected
     * renew_lease) answers `gone`, so the work stops; reject only when no answer
     * came back, which a harness tolerates.
     */
    heartbeat: () => Promise<SinkState>;
    /**
     * Ends the claim and answers with what the store settled on. By default a
     * boolean: false when the store kept an ending it already had, because the
     * run had finished or the claim was lost.
     */
    finish: (ending: Ending) => Promise<Settled>;
};
/** What `Claim` carries as its payload. */
export type PayloadOf<Claim> = Claim extends {
    payload: infer Payload;
} ? Payload : never;
/** What `Claim`'s `finish` takes. */
export type EndingOf<Claim> = Claim extends {
    finish: (ending: infer Ending) => unknown;
} ? Ending : never;
/** What `Claim`'s `finish` answers with. */
export type SettledOf<Claim> = Claim extends {
    finish: (ending: never) => Promise<infer Settled>;
} ? Settled : never;
export interface RunStore<Claim extends ClaimedRun<unknown, never, unknown> = ClaimedRun<unknown>> {
    /**
     * Takes one run. Null when it is not there to take: gone, finished, or held
     * under another key. Rejects with StoreUnreachableError when no answer came
     * back; retry that, with the same key. Any other rejection is the store
     * refusing the request (unauthorized, an unsupported version, a run this
     * worker cannot take), and a retry would be refused again.
     */
    claim(request: ClaimRequest): Promise<Claim | null>;
}
