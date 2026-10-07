// A store of runs waiting to be claimed, for testing whatever claims, beats and
// finishes them. Each claim is a FakeSink, so it also records what the run wrote.

import type { SinkState } from "../core/run.ts";
import type { ClaimedRun, ClaimRequest, RunEnding, RunStore } from "../core/run-store.ts";

import { FakeSink } from "./fakes.ts";

export class FakeClaim<Payload, Ending = RunEnding>
  extends FakeSink
  implements ClaimedRun<Payload, Ending>
{
  readonly runId: string;
  readonly payload: Payload;
  readonly idempotencyKey: string;
  readonly heartbeatMs: number;
  heartbeats = 0;
  /** The ending the store kept; null until one is. */
  ending: Ending | null = null;

  constructor(runId: string, payload: Payload, idempotencyKey: string, heartbeatMs: number) {
    super();
    this.runId = runId;
    this.payload = payload;
    this.idempotencyKey = idempotencyKey;
    this.heartbeatMs = heartbeatMs;
  }

  heartbeat = async (): Promise<SinkState> => {
    this.heartbeats += 1;
    return this.state;
  };

  // A finished run is gone to its writer, as a store that ended it says on the next append.
  finish = async (ending: Ending): Promise<boolean> => {
    if (this.state.gone) return false;
    this.ending = ending;
    this.state = { ...this.state, gone: true };
    return true;
  };
}

export class FakeRunStore<Payload = unknown, Ending = RunEnding>
  implements RunStore<Payload, Ending>
{
  /** Runs not yet claimed, by id. */
  readonly waiting: Map<string, Payload>;
  /** Every claim that landed, by run id. Set a claim's `state` to cancel or lose it. */
  readonly claims = new Map<string, FakeClaim<Payload, Ending>>();
  /** Rejects this many of the next claims before they land, as a dropped connection does. */
  failNext = 0;
  heartbeatMs = 20_000;

  constructor(runs: Record<string, Payload> = {}) {
    this.waiting = new Map(Object.entries(runs));
  }

  async claim({ runId, idempotencyKey }: ClaimRequest): Promise<FakeClaim<Payload, Ending> | null> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("connection lost");
    }
    const held = this.claims.get(runId);
    if (held) return held.idempotencyKey === idempotencyKey && !held.state.gone ? held : null;
    if (!this.waiting.has(runId)) return null;
    const claim = new FakeClaim<Payload, Ending>(
      runId,
      this.waiting.get(runId)!,
      idempotencyKey,
      this.heartbeatMs,
    );
    this.waiting.delete(runId);
    this.claims.set(runId, claim);
    return claim;
  }
}
