import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { FakeSandboxProvider, FakeSink, line, type FakeRun } from "../testing/fakes.ts";
import { executeRun, mediaTypeFor, type ExecuteRunOptions, type Mount } from "./run.ts";

const LIMITS = { wallClockMs: 60_000, cpus: 1.5, memoryMb: 1536 };
const COMMAND = ["node", "/opt/runner/runner.js"];
let mounts: Mount[] = [];

beforeAll(async () => {
  const localDir = await mkdtemp(path.join(tmpdir(), "agent-runtime-mount-"));
  await writeFile(path.join(localDir, "data.duckdb"), "rows");
  mounts = [{ localDir, remoteDir: "/data", verify: { "data.duckdb": "upload-hash" } }];
});

function start(run: FakeRun, overrides: Partial<ExecuteRunOptions> = {}) {
  const provider = new FakeSandboxProvider(run);
  const sink = new FakeSink();
  const outcome = executeRun({
    provider,
    sink,
    tokens: { grant: async () => "rt_test", revoke: async () => {} },
    runId: "run_1",
    prompt: "How many winners did Zac Purton ride?",
    command: COMMAND,
    mounts,
    image: "runner-image",
    limits: LIMITS,
    env: { LLM_MODEL: "kimi-for-coding" },
    batchMs: 20,
    retryMs: 1,
    ...overrides,
  });
  return { provider, sink, outcome };
}

const ANSWER: FakeRun = {
  chunkMs: 5,
  stdout: [
    line(0, "run_started", { model: "kimi-coding/kimi-for-coding" }),
    line(1, "text_delta", { delta: "Zac " }),
    line(2, "text_delta", { delta: "Purton " }),
    line(3, "text_delta", { delta: "won 52." }),
    line(4, "turn_end", {
      usage: {
        input: 1200,
        output: 340,
        cacheRead: 800,
        cacheWrite: 0,
        totalTokens: 2340,
        cost: { input: 0.0012, output: 0.0034, cacheRead: 0.0002, cacheWrite: 0, total: 0.0048 },
      },
    }),
    line(5, "run_finished", { status: "succeeded" }),
  ],
};

describe("executeRun", () => {
  it("relays a run, folds its answer and keeps the sandbox for the thread", async () => {
    const { provider, sink, outcome } = start(ANSWER, { keepSandbox: true });
    const result = await outcome;

    expect(result.status).toBe("succeeded");
    expect(result.answerText).toBe("Zac Purton won 52.");
    // The whole of pi's usage is kept, cost and cache included, not just token totals.
    expect(result.usage).toMatchObject({
      input: 1200,
      output: 340,
      cacheRead: 800,
      totalTokens: 2340,
      cost: { total: 0.0048 },
      turns: 1,
    });
    expect(result.created).toBe(true);
    expect(provider.calls).toContain("pause");
    expect(provider.calls).not.toContain("destroy");
    // The runner's numbering is kept, so a re-sent batch is a no-op in Convex.
    const seqs = sink.sent.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(sink.sent.at(0)).toMatchObject({ seq: 0, type: "run_started" });
    expect(sink.sent.at(-1)).toMatchObject({ seq: 5, type: "run_finished" });
  });

  it("merges the text deltas that share a batch", async () => {
    const { sink, outcome } = start({ ...ANSWER, chunkMs: 0 }, { batchMs: 10_000 });
    await outcome;
    const deltas = sink.sent.filter((e) => e.type === "text_delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.payload.delta).toBe("Zac Purton won 52.");
  });

  it("stores an output and puts its id in the artifact event", async () => {
    const { sink, outcome } = start({
      chunkMs: 2,
      files: { "/workspace/outputs/wins.csv": "jockey,wins\nPurton,52\n" },
      stdout: [
        line(0, "run_started", { model: "kimi-coding/kimi-for-coding" }),
        line(1, "artifact", {
          path: "/workspace/outputs/wins.csv",
          kind: "table",
          caption: "Wins by jockey",
        }),
        line(2, "text_delta", { delta: "See the table." }),
        line(3, "run_finished", { status: "succeeded" }),
      ],
    });
    await outcome;

    expect(sink.uploads).toHaveLength(1);
    expect(sink.uploads[0]).toMatchObject({
      fileName: "wins.csv",
      kind: "table",
      mediaType: "text/csv",
      size: 22,
    });
    const artifact = sink.sent.find((e) => e.type === "artifact");
    expect(artifact?.payload.artifactId).toBe("artifact-1");
    expect(artifact?.seq).toBe(1);
  });

  it("keeps the run when an output cannot be copied out", async () => {
    const { sink, outcome } = start({
      chunkMs: 2,
      stdout: [
        line(0, "artifact", { path: "/workspace/outputs/gone.csv", kind: "table", caption: "x" }),
        line(1, "text_delta", { delta: "Done." }),
        line(2, "run_finished", { status: "succeeded" }),
      ],
    });
    const result = await outcome;
    expect(result.status).toBe("succeeded");
    expect(sink.sent.find((e) => e.type === "artifact")?.payload.artifactId).toBeNull();
  });

  it("stops the runner when the run is cancelled and ends the log itself", async () => {
    const provider = new FakeSandboxProvider({ ...ANSWER, chunkMs: 40 });
    const sink = new FakeSink();
    // The first append answers that someone pressed stop.
    sink.state = { cancelled: true, gone: false };
    const result = await executeRun({
      provider,
      sink,
      tokens: { grant: async () => "rt_test", revoke: async () => {} },
      runId: "run_1",
      prompt: "…",
      command: COMMAND,
      mounts,
      image: "runner-image",
      limits: LIMITS,
      env: {},
      batchMs: 10,
      retryMs: 1,
    });

    expect(provider.killed).toBe(true);
    expect(result.status).toBe("cancelled");
    const last = sink.sent.at(-1)!;
    expect(last.type).toBe("run_finished");
    expect(last.payload.status).toBe("cancelled");
    // Numbered after whatever the runner managed to write.
    expect(last.seq).toBeGreaterThan(sink.sent.at(-2)!.seq);
    expect(sink.sent.filter((e) => e.type === "run_finished")).toHaveLength(1);
  });

  it("stops a run whose signal aborted before the runner started", async () => {
    // As a job's work signal is when the shutdown came while the claim was in flight.
    const { provider, outcome } = start(
      { ...ANSWER, chunkMs: 40 },
      { signal: AbortSignal.abort() },
    );
    const result = await outcome;

    expect(provider.killed).toBe(true);
    expect(result.status).toBe("cancelled");
  });

  it("fails a run whose runner crashes without finishing", async () => {
    const { sink, outcome } = start({
      chunkMs: 0,
      stdout: [line(0, "run_started", { model: "kimi-coding/kimi-for-coding" })],
      stderr: "Traceback\nduckdb.IOException: no such table\n",
      exitCode: 1,
    });
    const result = await outcome;
    expect(result.status).toBe("failed");
    expect(result.error).toBe("duckdb.IOException: no such table");
    expect(sink.sent.at(-1)).toMatchObject({ type: "run_finished" });
  });

  it("says so when the run hits its time limit", async () => {
    const { outcome } = start({ chunkMs: 0, stdout: [], exitCode: 124 });
    const result = await outcome;
    expect(result.status).toBe("failed");
    expect(result.error).toBe("The run hit its 1 minute time limit.");
  });

  it("resumes the thread's sandbox instead of rebuilding it", async () => {
    const opened: [string, boolean][] = [];
    const { provider, sink, outcome } = start(ANSWER, {
      resumeSandboxId: "sbx-old",
      keepSandbox: true,
      onSandbox: (id, created) => {
        // Reported before the runner writes anything.
        expect(sink.sent).toEqual([]);
        opened.push([id, created]);
      },
    });
    const result = await outcome;
    expect(result.sandboxId).toBe("sbx-old");
    expect(result.created).toBe(false);
    expect(opened).toEqual([["sbx-old", false]]);
    expect(provider.calls).toEqual(["resume sbx-old", "pause"]);
    // No mount upload, so the sandbox keeps the agent's session.
    expect(provider.execs.some((c) => c[0] === "sha256sum")).toBe(false);
  });

  it("builds a fresh sandbox when the thread's one has gone", async () => {
    const provider = new FakeSandboxProvider(ANSWER);
    provider.resumeFails = true;
    const sink = new FakeSink();
    const result = await executeRun({
      provider,
      sink,
      tokens: { grant: async () => "rt_test", revoke: async () => {} },
      runId: "run_1",
      prompt: "…",
      command: COMMAND,
      mounts,
      image: "runner-image",
      limits: LIMITS,
      env: {},
      resumeSandboxId: "sbx-old",
      batchMs: 20,
      retryMs: 1,
    });
    expect(result.created).toBe(true);
    expect(result.sandboxId).toBe("sbx-1");
    expect(provider.calls).toContain("upload");
  });

  it("still pauses the sandbox when the onSandbox hook fails", async () => {
    const { provider, outcome } = start(ANSWER, {
      keepSandbox: true,
      onSandbox: async () => {
        throw new Error("deployment unreachable");
      },
    });
    await expect(outcome).rejects.toThrow("deployment unreachable");
    expect(provider.calls).toEqual(["create", "upload", "pause"]);
  });

  it("re-sends a batch unchanged after a dropped connection", async () => {
    const { sink, outcome } = start(ANSWER, { batchMs: 10_000 });
    sink.failNext = 2;
    const result = await outcome;
    expect(result.status).toBe("succeeded");
    // The whole run arrived once, with the seqs it was first sent under, so
    // appendEvents stores each event exactly once however often it is re-sent.
    expect(sink.batches).toHaveLength(1);
    expect(sink.sent.map((e) => e.seq)).toEqual([0, 1, 4, 5]);
    expect(sink.sent[1]!.payload.delta).toBe("Zac Purton won 52.");
  });

  it("gives up on a sink that never comes back, leaving the run to the reaper", async () => {
    const { sink, outcome } = start(ANSWER, { retries: 1 });
    sink.failNext = 99;
    const result = await outcome;
    expect(sink.sent).toHaveLength(0);
    expect(result.status).toBe("succeeded");
  });

  it("samples the sandbox while the run works", async () => {
    const { sink, outcome } = start(
      { ...ANSWER, chunkMs: 12 },
      { sampleMs: 5, usage: async () => ({ cpu: 1.2, memoryMb: 512 }) },
    );
    await outcome;
    expect(sink.storedSamples.length).toBeGreaterThan(0);
    expect(sink.storedSamples[0]).toMatchObject({ cpu: 1.2, memoryMb: 512 });
  });

  it("destroys a sandbox that is not being kept", async () => {
    const { provider, outcome } = start(ANSWER);
    await outcome;
    expect(provider.calls).toContain("destroy");
  });

  it("passes the run's limits and token into the sandbox", async () => {
    const { provider, outcome } = start(ANSWER);
    await outcome;
    expect(provider.execs.at(-1)).toEqual(COMMAND);
  });

  it("refuses a mount this host does not have, without building anything", async () => {
    const { provider, sink, outcome } = start(ANSWER, {
      mounts: [{ localDir: "/no/such/dir", remoteDir: "/data" }],
    });
    await expect(outcome).rejects.toThrow("Nothing to mount at /no/such/dir.");
    // A run whose data we lack must not cost a container.
    expect(provider.calls).toEqual([]);
    expect(sink.sent).toEqual([]);
  });

  it("destroys a new sandbox whose mount did not upload intact", async () => {
    const provider = new FakeSandboxProvider(ANSWER);
    provider.uploadSha = "something-else";
    const outcome = executeRun({
      provider,
      sink: new FakeSink(),
      tokens: { grant: async () => "rt_test", revoke: async () => {} },
      runId: "run_1",
      prompt: "…",
      command: COMMAND,
      mounts,
      image: "runner-image",
      limits: LIMITS,
    });
    await expect(outcome).rejects.toThrow("/data/data.duckdb did not upload intact");
    expect(provider.calls).toEqual(["create", "upload", "destroy"]);
  });
});

describe("mediaTypeFor", () => {
  it("names the types the workspace can render, and falls back otherwise", () => {
    expect(mediaTypeFor("wins.csv")).toBe("text/csv");
    expect(mediaTypeFor("chart.PNG")).toBe("image/png");
    expect(mediaTypeFor("report.md")).toBe("text/markdown");
    expect(mediaTypeFor("model.pkl")).toBe("application/octet-stream");
  });
});
