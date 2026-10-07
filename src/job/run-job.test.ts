import { afterEach, describe, expect, it, vi } from "vitest";

import { executeRun } from "../core/run.ts";
import { StoreUnreachableError } from "../core/run-store.ts";
import { FakeRunStore, type FakeClaim } from "../testing/fake-run-store.ts";
import { FakeSandboxProvider, line } from "../testing/fakes.ts";
import { runJob } from "./run-job.ts";

const NO_SIGNALS = { shutdownSignals: [] };
const QUICK = { ...NO_SIGNALS, retryDelaysMs: [1, 1, 1] };

/** Resolves once the signal aborts, with its reason. */
function aborted(signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(signal.reason);
    signal.addEventListener("abort", () => resolve(signal.reason), { once: true });
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runJob", () => {
  it("claims the run by id, works it and finishes with the work's ending", async () => {
    const store = new FakeRunStore({ run_1: { prompt: "Who won the Derby?" } });
    const work = vi.fn(async (claim: FakeClaim<{ prompt: string }>) => ({
      status: "succeeded" as const,
      answerText: `Answered: ${claim.payload.prompt}`,
    }));

    const result = await runJob(store, { ...QUICK, runId: "run_1", idempotencyKey: "k1", work });

    expect(work).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      kind: "finished",
      ending: { status: "succeeded", answerText: "Answered: Who won the Derby?" },
      settled: true,
      exitCode: 0,
    });
    const claim = store.claims.get("run_1")!;
    expect(claim.idempotencyKey).toBe("k1");
    expect(claim.ending).toEqual(result.kind === "finished" && result.ending);
  });

  it("types work and failed by the store's own claim", async () => {
    type Ending = { kind: "review" } | { kind: "abandon"; code: string };
    const store = new FakeRunStore<{ question: string }, Ending>({ run_1: { question: "?" } });

    const result = await runJob(store, {
      ...QUICK,
      runId: "run_1",
      // Literal endings, no annotations: both are checked against Ending.
      work: async (claim) =>
        claim.payload.question ? { kind: "review" } : { kind: "abandon", code: "empty" },
      failed: () => ({ kind: "abandon", code: "worker_attempt_unhandled" }),
    });

    expect(result).toMatchObject({ kind: "finished", ending: { kind: "review" } });
  });

  it("reports nothing to do when the run is not there to claim", async () => {
    const store = new FakeRunStore({});
    const work = vi.fn(async () => ({ status: "succeeded" as const }));

    expect(await runJob(store, { ...QUICK, runId: "run_1", work })).toEqual({
      kind: "idle",
      exitCode: 0,
    });
    expect(work).not.toHaveBeenCalled();
  });

  it("retries a claim that got no answer with the same key, and gets back one that landed", async () => {
    const store = new FakeRunStore({ run_1: {} });
    store.failNext = 1;
    store.loseNext = 1;
    const claim = vi.spyOn(store, "claim");

    const result = await runJob(store, {
      ...QUICK,
      runId: "run_1",
      work: async () => ({ status: "succeeded" }),
    });

    expect(result.kind).toBe("finished");
    expect(claim).toHaveBeenCalledTimes(3);
    const keys = new Set(claim.mock.calls.map(([request]) => request.idempotencyKey));
    expect(keys.size).toBe(1);
  });

  it("gives up after its last retry", async () => {
    const store = new FakeRunStore({ run_1: {} });
    store.failNext = 10;
    const claim = vi.spyOn(store, "claim");
    const logs: string[] = [];

    const result = await runJob(store, {
      ...NO_SIGNALS,
      runId: "run_1",
      retryDelaysMs: [1, 2],
      log: (m) => logs.push(m),
      work: async () => ({ status: "succeeded" }),
    });

    expect(result).toMatchObject({ kind: "unclaimed", exitCode: 1 });
    expect(result.kind === "unclaimed" && result.error).toBeInstanceOf(StoreUnreachableError);
    expect(claim).toHaveBeenCalledTimes(3);
    expect(logs).toEqual([
      "claim got no answer, retrying in 1 ms: connection lost",
      "claim got no answer, retrying in 2 ms: connection lost",
    ]);
  });

  it("does not retry a claim the store refused", async () => {
    const store = new FakeRunStore({ run_1: {} });
    const refusal = new Error("operation_rejected:corpus_release_not_ready_for_claim");
    store.refusal = refusal;
    const claim = vi.spyOn(store, "claim");

    const result = await runJob(store, {
      ...QUICK,
      runId: "run_1",
      work: async () => ({ status: "succeeded" }),
    });

    expect(result).toEqual({ kind: "unclaimed", error: refusal, exitCode: 1 });
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("stops retrying once it is told to stop", async () => {
    const store = new FakeRunStore({ run_1: {} });
    store.failNext = 10;
    const claim = vi.spyOn(store, "claim");
    const stop = new AbortController();

    const running = runJob(store, {
      ...NO_SIGNALS,
      runId: "run_1",
      retryDelaysMs: [60_000],
      signal: stop.signal,
      work: async () => ({ status: "succeeded" }),
    });
    await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(1));
    stop.abort();

    expect(await running).toMatchObject({ kind: "unclaimed", exitCode: 1 });
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("aborts the work when a beat says the run was cancelled, and finishes it", async () => {
    const store = new FakeRunStore({ run_1: {} });
    store.heartbeatMs = 5;
    let reason: unknown;

    const running = runJob(store, {
      ...QUICK,
      runId: "run_1",
      work: async (_claim, signal) => {
        reason = await aborted(signal);
        return { status: "cancelled" };
      },
    });
    await vi.waitFor(() => expect(store.claims.get("run_1")?.heartbeats).toBeGreaterThan(0));
    store.claims.get("run_1")!.state = { cancelled: true, gone: false };

    expect(await running).toMatchObject({
      kind: "finished",
      ending: { status: "cancelled" },
      stopped: "cancelled",
      exitCode: 0,
    });
    expect(reason).toBe("cancelled");
    expect(store.claims.get("run_1")!.ending).toEqual({ status: "cancelled" });
  });

  it("aborts the work when a beat says the run is gone", async () => {
    const store = new FakeRunStore({ run_1: {} });
    store.heartbeatMs = 5;

    const running = runJob(store, {
      ...QUICK,
      runId: "run_1",
      work: async (_claim, signal) => {
        await aborted(signal);
        throw new Error("stopped");
      },
    });
    await vi.waitFor(() => expect(store.claims.get("run_1")?.heartbeats).toBeGreaterThan(0));
    store.claims.get("run_1")!.state = { cancelled: false, gone: true };

    // The store already let the run go, so it keeps none of this ending.
    expect(await running).toMatchObject({ kind: "finished", stopped: "gone", settled: false });
  });

  it("keeps working through beats that fail", async () => {
    const store = new FakeRunStore({ run_1: {} });
    store.heartbeatMs = 2;
    const logs: string[] = [];
    let beats = 0;
    let signal: AbortSignal | undefined;

    const result = await runJob(store, {
      ...QUICK,
      runId: "run_1",
      log: (m) => logs.push(m),
      work: async (claim, workSignal) => {
        signal = workSignal;
        claim.heartbeat = async () => {
          beats += 1;
          throw new StoreUnreachableError("timed out");
        };
        await vi.waitFor(() => expect(beats).toBeGreaterThanOrEqual(3));
        return { status: "succeeded" };
      },
    });

    expect(result).toMatchObject({ kind: "finished", ending: { status: "succeeded" } });
    expect(signal!.aborted).toBe(false);
    expect(logs).toContain("heartbeat failed: timed out");
  });

  it("finishes a run whose work threw as failed, keeping what it threw", async () => {
    const store = new FakeRunStore({ run_1: {} });
    const boom = new Error("sandbox would not start");

    const result = await runJob(store, {
      ...QUICK,
      runId: "run_1",
      work: async () => {
        throw boom;
      },
    });

    expect(result).toEqual({
      kind: "finished",
      ending: { status: "failed", error: "sandbox would not start" },
      settled: true,
      error: boom,
      exitCode: 0,
    });
    expect(store.claims.get("run_1")!.ending).toEqual({
      status: "failed",
      error: "sandbox would not start",
    });
  });

  it("finishes a cancelled run whose work threw as cancelled", async () => {
    const store = new FakeRunStore({ run_1: {} });
    store.heartbeatMs = 5;
    const running = runJob(store, {
      ...QUICK,
      runId: "run_1",
      work: async (_claim, signal) => {
        await aborted(signal);
        throw new Error("aborted");
      },
    });
    await vi.waitFor(() => expect(store.claims.get("run_1")?.heartbeats).toBeGreaterThan(0));
    store.claims.get("run_1")!.state = { cancelled: true, gone: false };

    expect(await running).toMatchObject({ kind: "finished", ending: { status: "cancelled" } });
  });

  it("stops the work on a shutdown signal and still finishes, then stops listening", async () => {
    const store = new FakeRunStore({ run_1: {} });
    const before = process.listenerCount("SIGUSR2");
    let reason: unknown;

    const running = runJob(store, {
      ...QUICK,
      shutdownSignals: ["SIGUSR2"],
      runId: "run_1",
      work: async (_claim, signal) => {
        reason = await aborted(signal);
        return { status: "cancelled", error: "The job was stopped." };
      },
    });
    await vi.waitFor(() => expect(store.claims.has("run_1")).toBe(true));
    expect(process.listenerCount("SIGUSR2")).toBe(before + 1);
    process.emit("SIGUSR2", "SIGUSR2");

    expect(await running).toMatchObject({ kind: "finished", stopped: "shutdown", settled: true });
    expect(reason).toBe("shutdown");
    expect(store.claims.get("run_1")!.ending).toEqual({
      status: "cancelled",
      error: "The job was stopped.",
    });
    expect(process.listenerCount("SIGUSR2")).toBe(before);

    // And when no signal came.
    store.waiting.set("run_2", {});
    await runJob(store, {
      ...QUICK,
      shutdownSignals: ["SIGUSR2"],
      runId: "run_2",
      work: async () => ({ status: "succeeded" }),
    });
    expect(process.listenerCount("SIGUSR2")).toBe(before);
  });

  it("reports a run it could not finish", async () => {
    const store = new FakeRunStore({ run_1: {} });
    const lost = new StoreUnreachableError("finish got no answer");

    const result = await runJob(store, {
      ...QUICK,
      runId: "run_1",
      work: async (claim) => {
        claim.finish = async () => {
          throw lost;
        };
        return { status: "succeeded" };
      },
    });

    expect(result).toEqual({
      kind: "unfinished",
      ending: { status: "succeeded" },
      error: lost,
      exitCode: 1,
    });
  });

  it("clears its timers however the run ends", async () => {
    vi.useFakeTimers();
    const endings = [
      async () => ({ status: "succeeded" as const }),
      async () => {
        throw new Error("boom");
      },
    ];
    for (const work of endings) {
      const store = new FakeRunStore({ run_1: {} });
      await runJob(store, { ...QUICK, runId: "run_1", work });
      expect(vi.getTimerCount()).toBe(0);
    }
    const store = new FakeRunStore({ run_1: {} });
    await runJob(store, {
      ...QUICK,
      runId: "run_1",
      work: async (claim) => {
        claim.finish = async () => {
          throw new Error("refused");
        };
        return { status: "succeeded" };
      },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs executeRun with the claim as its sink", async () => {
    const store = new FakeRunStore({ run_1: { prompt: "How many winners?" } });

    const result = await runJob(store, {
      ...QUICK,
      runId: "run_1",
      work: async (claim, signal) => {
        const { status, error, answerText, usage } = await executeRun({
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
          limits: { wallClockMs: 60_000, cpus: 1, memoryMb: 512 },
          signal,
          batchMs: 10,
        });
        return { status, error, answerText, usage };
      },
    });

    expect(result).toMatchObject({
      kind: "finished",
      ending: { status: "succeeded", answerText: "52." },
    });
    expect(store.claims.get("run_1")!.sent.map((e) => e.seq)).toEqual([0, 1, 2]);
  });
});
