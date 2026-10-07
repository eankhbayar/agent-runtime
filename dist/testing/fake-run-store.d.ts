import type { SinkState } from "../core/run.ts";
import { type ClaimedRun, type ClaimRequest, type RunEnding, type RunStore } from "../core/run-store.ts";
import { FakeSink } from "./fakes.ts";
export declare class FakeClaim<Payload, Ending = RunEnding> extends FakeSink implements ClaimedRun<Payload, Ending> {
    readonly runId: string;
    readonly payload: Payload;
    readonly idempotencyKey: string;
    readonly heartbeatMs: number;
    heartbeats: number;
    /** The ending the store kept; null until one is. */
    ending: Ending | null;
    constructor(runId: string, payload: Payload, idempotencyKey: string, heartbeatMs: number);
    heartbeat: () => Promise<SinkState>;
    finish: (ending: Ending) => Promise<boolean>;
}
export declare class FakeRunStore<Payload = unknown, Ending = RunEnding> implements RunStore<FakeClaim<Payload, Ending>> {
    /** Runs not yet claimed, by id. */
    readonly waiting: Map<string, Payload>;
    /** Every claim that landed, by run id. Set a claim's `state` to cancel or lose it. */
    readonly claims: Map<string, FakeClaim<Payload, Ending>>;
    /** Rejects this many of the next claims before they land, as a dropped connection does. */
    failNext: number;
    /** Lets this many of the next claims land, then rejects them, as an answer lost on the way back. */
    loseNext: number;
    /** Thrown by every claim while set, as a store that refuses the request does. */
    refusal: Error | null;
    heartbeatMs: number;
    constructor(runs?: Record<string, Payload>);
    claim(request: ClaimRequest): Promise<FakeClaim<Payload, Ending> | null>;
    private take;
}
