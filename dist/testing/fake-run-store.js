// A store of runs waiting to be claimed, for testing whatever claims, beats and
// finishes them. Each claim is a FakeSink, so it also records what the run wrote.
import { StoreUnreachableError, } from "../core/run-store.js";
import { FakeSink } from "./fakes.js";
export class FakeClaim extends FakeSink {
    runId;
    payload;
    idempotencyKey;
    heartbeatMs;
    heartbeats = 0;
    /** The ending the store kept; null until one is. */
    ending = null;
    constructor(runId, payload, idempotencyKey, heartbeatMs) {
        super();
        this.runId = runId;
        this.payload = payload;
        this.idempotencyKey = idempotencyKey;
        this.heartbeatMs = heartbeatMs;
    }
    heartbeat = async () => {
        this.heartbeats += 1;
        return this.state;
    };
    // A finished run is gone to its writer, as a store that ended it says on the next append.
    finish = async (ending) => {
        if (this.state.gone)
            return false;
        this.ending = ending;
        this.state = { ...this.state, gone: true };
        return true;
    };
}
export class FakeRunStore {
    /** Runs not yet claimed, by id. */
    waiting;
    /** Every claim that landed, by run id. Set a claim's `state` to cancel or lose it. */
    claims = new Map();
    /** Rejects this many of the next claims before they land, as a dropped connection does. */
    failNext = 0;
    /** Lets this many of the next claims land, then rejects them, as an answer lost on the way back. */
    loseNext = 0;
    /** Thrown by every claim while set, as a store that refuses the request does. */
    refusal = null;
    heartbeatMs = 20_000;
    constructor(runs = {}) {
        this.waiting = new Map(Object.entries(runs));
    }
    async claim(request) {
        if (this.refusal)
            throw this.refusal;
        if (this.failNext > 0) {
            this.failNext -= 1;
            throw new StoreUnreachableError("connection lost");
        }
        const claim = this.take(request);
        if (this.loseNext > 0) {
            this.loseNext -= 1;
            throw new StoreUnreachableError("answer lost");
        }
        return claim;
    }
    take({ runId, idempotencyKey }) {
        const held = this.claims.get(runId);
        if (held)
            return held.idempotencyKey === idempotencyKey && !held.state.gone ? held : null;
        if (!this.waiting.has(runId))
            return null;
        const claim = new FakeClaim(runId, this.waiting.get(runId), idempotencyKey, this.heartbeatMs);
        this.waiting.delete(runId);
        this.claims.set(runId, claim);
        return claim;
    }
}
