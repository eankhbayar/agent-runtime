import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { FakeSandboxProvider, FakeSink, line, type FakeRun } from "../testing/fakes.ts";
import { executeRun, type ExecuteRunOptions } from "./run.ts";
import { DirectorySessionStore, type SessionStore } from "./session-store.ts";

const LIMITS = { wallClockMs: 60_000, cpus: 1, memoryMb: 1024 };

const ANSWER: FakeRun = {
  chunkMs: 2,
  stdout: [
    line(0, "run_started", {}),
    line(1, "text_delta", { delta: "52." }),
    line(2, "run_finished", { status: "succeeded" }),
  ],
};

/** A store in memory that records what happened to it, in order. */
class MemoryStore implements SessionStore {
  readonly saved = new Map<string, Record<string, string>>();
  readonly log: string[] = [];
  failRestore = false;

  async save(key: string, from: string): Promise<void> {
    this.log.push(`save ${key}`);
    const files: Record<string, string> = {};
    for (const name of await readdir(from)) files[name] = await readFile(path.join(from, name), "utf8");
    this.saved.set(key, files);
  }

  async restore(key: string, into: string): Promise<boolean> {
    this.log.push(`restore ${key}`);
    if (this.failRestore) throw new Error("bucket unreachable");
    const files = this.saved.get(key);
    if (!files) return false;
    for (const [name, body] of Object.entries(files)) await writeFile(path.join(into, name), body);
    return true;
  }
}

function start(provider: FakeSandboxProvider, store: SessionStore, overrides: Partial<ExecuteRunOptions> = {}) {
  const sink = new FakeSink();
  const outcome = executeRun({
    provider,
    sink,
    tokens: { grant: async () => "rt_test", revoke: async () => {} },
    runId: "run_1",
    prompt: "How many winners?",
    command: ["node", "runner.js"],
    image: "runner",
    limits: LIMITS,
    batchMs: 10,
    session: { store, key: "thread_1" },
    ...overrides,
  });
  return { sink, outcome };
}

describe("executeRun with a session store", () => {
  it("saves the session after a run and restores it into the next run's new sandbox", async () => {
    const store = new MemoryStore();
    const first = new FakeSandboxProvider({
      ...ANSWER,
      files: { "/workspace/.sessions/s.jsonl": '{"turn":1}\n' },
    });
    const one = await start(first, store).outcome;
    expect(one.session).toEqual({ restored: false, saved: true });
    expect(store.saved.get("thread_1")).toEqual({ "s.jsonl": '{"turn":1}\n' });

    const second = new FakeSandboxProvider(ANSWER);
    const two = await start(second, store).outcome;
    expect(two.session).toEqual({ restored: true, saved: true });
    // In place before the runner started: the restore's exec comes before the runner's.
    expect(second.fs.get("/workspace/.sessions/s.jsonl")?.toString()).toBe('{"turn":1}\n');
    expect(second.execs.at(-1)).toEqual(["node", "runner.js"]);
    expect(second.execs.findIndex((c) => c[0] === "sh")).toBeLessThan(second.execs.length - 1);
    expect(store.log).toEqual(["restore thread_1", "save thread_1", "restore thread_1", "save thread_1"]);
  });

  it("saves the session of a run that was cancelled or failed", async () => {
    for (const run of [
      { ...ANSWER, chunkMs: 40, cancel: true },
      { stdout: [line(0, "run_started", {})], stderr: "boom\n", exitCode: 1, cancel: false },
    ]) {
      const store = new MemoryStore();
      const provider = new FakeSandboxProvider({
        ...run,
        files: { "/workspace/.sessions/s.jsonl": "partial\n" },
      });
      const stop = new AbortController();
      const { outcome } = start(provider, store, { signal: stop.signal });
      if (run.cancel) setTimeout(() => stop.abort(), 20);
      const result = await outcome;
      expect(result.status).toBe(run.cancel ? "cancelled" : "failed");
      expect(result.session?.saved).toBe(true);
      expect(store.saved.get("thread_1")).toEqual({ "s.jsonl": "partial\n" });
      // Saved before the sandbox went.
      expect(provider.calls.indexOf("download /workspace/.sessions")).toBeLessThan(
        provider.calls.indexOf("destroy"),
      );
    }
  });

  it("saves nothing when the runner wrote no session", async () => {
    const store = new MemoryStore();
    const provider = new FakeSandboxProvider({ stdout: [], exitCode: 1, stderr: "no pi\n" });
    const { sink, outcome } = start(provider, store);
    const result = await outcome;
    expect(result.session).toEqual({ restored: false, saved: false });
    expect(store.log).toEqual(["restore thread_1"]);
    expect(sink.lines.some((l) => l.startsWith("no session to save at /workspace/.sessions"))).toBe(true);
  });

  it("fails the run, and builds no runner, when the store cannot be read", async () => {
    const store = new MemoryStore();
    store.failRestore = true;
    const provider = new FakeSandboxProvider(ANSWER);
    await expect(start(provider, store).outcome).rejects.toThrow("bucket unreachable");
    // Not started over and then saved over the thread's longer session.
    expect(store.log).toEqual(["restore thread_1"]);
    expect(provider.execs).toEqual([]);
    expect(provider.calls).toContain("destroy");
  });

  it("fails the run when the restored session cannot be put in place", async () => {
    const store = new MemoryStore();
    store.saved.set("thread_1", { "s.jsonl": "x\n" });
    const provider = new FakeSandboxProvider(ANSWER);
    provider.restoreFails = true;
    await expect(start(provider, store).outcome).rejects.toThrow("Restoring the session exited 1");
    expect(store.log).toEqual(["restore thread_1"]);
  });

  it("does not restore into a resumed sandbox, which still has its session", async () => {
    const store = new MemoryStore();
    store.saved.set("thread_1", { "s.jsonl": "stored\n" });
    const provider = new FakeSandboxProvider({
      ...ANSWER,
      files: { "/workspace/.sessions/s.jsonl": "live\n" },
    });
    const result = await start(provider, store, { resumeSandboxId: "sbx-thread", keepSandbox: true }).outcome;
    expect(result).toMatchObject({ created: false, session: { restored: false, saved: true } });
    expect(store.saved.get("thread_1")).toEqual({ "s.jsonl": "live\n" });
  });

  it("round-trips through a DirectorySessionStore", async () => {
    const store = new DirectorySessionStore(await mkdtemp(path.join(tmpdir(), "agent-runtime-sessions-")));
    await start(
      new FakeSandboxProvider({ ...ANSWER, files: { "/workspace/.sessions/a/s.jsonl": "turn 1\n" } }),
      store,
    ).outcome;
    const next = new FakeSandboxProvider(ANSWER);
    expect((await start(next, store).outcome).session?.restored).toBe(true);
    expect(next.fs.get("/workspace/.sessions/a/s.jsonl")?.toString()).toBe("turn 1\n");
  });
});

describe("executeRun with a mounted directory", () => {
  it("binds it when the sandbox is created instead of uploading it, and still verifies it", async () => {
    const localDir = await mkdtemp(path.join(tmpdir(), "agent-runtime-mounted-"));
    const provider = new FakeSandboxProvider(ANSWER);
    await executeRun({
      provider,
      sink: new FakeSink(),
      tokens: { grant: async () => "rt_test", revoke: async () => {} },
      runId: "run_1",
      prompt: "…",
      command: ["node", "runner.js"],
      image: "runner",
      limits: LIMITS,
      mounts: [{ localDir, remoteDir: "/data", mounted: true, verify: { "data.duckdb": "upload-hash" } }],
    });
    expect(provider.creates[0]?.binds).toEqual([{ localDir, remoteDir: "/data" }]);
    expect(provider.calls).not.toContain("upload");
    expect(provider.execs[0]).toEqual(["sha256sum", "/data/data.duckdb"]);
  });

  it("gives create no binds when nothing is mounted, as before", async () => {
    const provider = new FakeSandboxProvider(ANSWER);
    await executeRun({
      provider,
      sink: new FakeSink(),
      tokens: { grant: async () => "rt_test", revoke: async () => {} },
      runId: "run_1",
      prompt: "…",
      command: ["node", "runner.js"],
      image: "runner",
      limits: LIMITS,
    });
    expect(provider.creates[0]).not.toHaveProperty("binds");
  });
});
