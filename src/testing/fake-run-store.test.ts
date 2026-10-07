import { describe, expect, it } from "vitest";

import { executeRun } from "../core/run.ts";
import { FakeRunStore } from "./fake-run-store.ts";
import { FakeSandboxProvider, line } from "./fakes.ts";

const LIMITS = { wallClockMs: 60_000, cpus: 1, memoryMb: 512 };

describe("FakeRunStore", () => {
  it("hands a waiting run to the first claim and to no one else", async () => {
    const store = new FakeRunStore({ run_1: { prompt: "Who won the Derby?" } });
    const claim = await store.claim({ runId: "run_1", idempotencyKey: "k1" });
    expect(claim).toMatchObject({ runId: "run_1", payload: { prompt: "Who won the Derby?" } });
    expect(await store.claim({ runId: "run_1", idempotencyKey: "k2" })).toBeNull();
    expect(await store.claim({ runId: "run_2", idempotencyKey: "k1" })).toBeNull();
  });

  it("returns a claim that landed to a retry with the same key", async () => {
    const store = new FakeRunStore({ run_1: {} });
    store.failNext = 1;
    await expect(store.claim({ runId: "run_1", idempotencyKey: "k1" })).rejects.toThrow();
    const first = await store.claim({ runId: "run_1", idempotencyKey: "k1" });
    // The answer was lost on the way back, so the worker asks again.
    const again = await store.claim({ runId: "run_1", idempotencyKey: "k1" });
    expect(again).toBe(first);
  });

  it("is the sink executeRun writes to, and keeps the outcome it finishes with", async () => {
    const store = new FakeRunStore({ run_1: { prompt: "How many winners?" } });
    const claim = (await store.claim({ runId: "run_1", idempotencyKey: "k1" }))!;
    const outcome = await executeRun({
      provider: new FakeSandboxProvider({
        stdout: [
          line(0, "run_started", {}),
          line(1, "text_delta", { delta: "52." }),
          line(2, "run_finished", { status: "succeeded" }),
        ],
      }),
      sink: claim,
      tokens: { grant: async () => "rt_test", revoke: async () => {} },
      runId: claim.runId,
      prompt: claim.payload.prompt,
      command: ["node", "runner.js"],
      image: "runner-image",
      limits: LIMITS,
      batchMs: 10,
    });

    expect(claim.sent.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(await claim.finish(outcome)).toBe(true);
    expect(claim.ending).toMatchObject({ status: "succeeded", answerText: "52." });
    // Finished, the run is gone to its writer, and no one can claim it again.
    expect(await claim.events([])).toMatchObject({ gone: true });
    expect(await store.claim({ runId: "run_1", idempotencyKey: "k1" })).toBeNull();
  });

  it("keeps the first ending and refuses one from a claim that was lost", async () => {
    const store = new FakeRunStore({ run_1: {}, run_2: {} });
    const done = (await store.claim({ runId: "run_1", idempotencyKey: "k1" }))!;
    expect(await done.finish({ status: "succeeded" })).toBe(true);
    expect(await done.finish({ status: "failed", error: "late" })).toBe(false);
    expect(done.ending).toEqual({ status: "succeeded" });

    const lost = (await store.claim({ runId: "run_2", idempotencyKey: "k2" }))!;
    lost.state = { cancelled: false, gone: true };
    expect(await lost.finish({ status: "succeeded" })).toBe(false);
    expect(lost.ending).toBeNull();
  });

  it("says on the next beat that the run was cancelled", async () => {
    const store = new FakeRunStore({ run_1: {} });
    const claim = (await store.claim({ runId: "run_1", idempotencyKey: "k1" }))!;
    expect(await claim.heartbeat()).toEqual({ cancelled: false, gone: false });
    store.claims.get("run_1")!.state = { cancelled: true, gone: false };
    expect(await claim.heartbeat()).toEqual({ cancelled: true, gone: false });
    expect(claim.heartbeats).toBe(2);
    expect(claim.heartbeatMs).toBe(store.heartbeatMs);
  });

  it("takes an app's own ending, such as a pause for review", async () => {
    type Ending = { kind: "review"; reviewType: "frame" } | { kind: "abandon"; code: string };
    const store = new FakeRunStore<{ question: string }, Ending>({ run_1: { question: "?" } });
    const claim = (await store.claim({ runId: "run_1", idempotencyKey: "k1" }))!;
    expect(await claim.finish({ kind: "review", reviewType: "frame" })).toBe(true);
    expect(claim.ending).toEqual({ kind: "review", reviewType: "frame" });
  });
});
