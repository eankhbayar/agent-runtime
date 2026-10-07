import { describe, expect, it } from "vitest";

import { FakeSink } from "../testing/fakes.ts";
import { LIVE } from "./run.ts";
import type {
  ClaimedRun,
  ClaimRequest,
  EndingOf,
  PayloadOf,
  RunStore,
  SettledOf,
} from "./run-store.ts";

// What a harness written against RunStore alone sees of an adapter's claim.

type Ending = { kind: "review" } | { kind: "suspend_for_corpus" };
type Settled = "review_paused" | "suspended";
type LegalClaim = ClaimedRun<{ question: string }, Ending, Settled> & {
  /** One of the adapter's own operations. */
  recordFindings: (count: number) => Promise<number>;
};

function legalStore(): RunStore<LegalClaim> {
  return {
    claim: async ({ runId }: ClaimRequest) =>
      Object.assign(new FakeSink(), {
        runId,
        payload: { question: "Is the clause enforceable?" },
        heartbeatMs: 5_000,
        heartbeat: async () => LIVE,
        finish: async (ending: Ending): Promise<Settled> =>
          ending.kind === "review" ? "review_paused" : "suspended",
        recordFindings: async (count: number) => count,
      }),
  };
}

/** A harness generic over the claim, as runJob is. */
async function claimFor<Claim extends ClaimedRun<unknown, never, unknown>>(
  store: RunStore<Claim>,
  runId: string,
): Promise<Claim> {
  const claim = await store.claim({ runId, idempotencyKey: "k1" });
  if (!claim) throw new Error(`${runId} was not there to claim`);
  return claim;
}

/** True when A and B are the same type. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe("RunStore", () => {
  it("names a claim's payload, ending and settlement for a harness's signature", () => {
    const named: [
      Same<PayloadOf<LegalClaim>, { question: string }>,
      Same<EndingOf<LegalClaim>, Ending>,
      Same<SettledOf<LegalClaim>, Settled>,
    ] = [true, true, true];
    expect(named).toEqual([true, true, true]);
  });

  it("hands a harness the adapter's own claim, methods and all", async () => {
    const claim = await claimFor(legalStore(), "run_1");
    expect(claim.payload.question).toBe("Is the clause enforceable?");
    expect(await claim.recordFindings(2)).toBe(2);
  });

  it("answers finish with what the app's store settled on", async () => {
    const claim = await claimFor(legalStore(), "run_1");
    const settled: Settled = await claim.finish({ kind: "suspend_for_corpus" });
    expect(settled).toBe("suspended");
  });
});
