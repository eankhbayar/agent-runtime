// A sandbox is hostile. These attacks come from inside one, through the fake
// CLI, and must get nothing of the job's: no file outside the sandbox stored
// as an output, no other thread's session saved as this one's.

import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeRun } from "../../core/run.ts";
import { DirectorySessionStore } from "../../core/session-store.ts";
import { createFakeSandboxCli, type FakeSandboxCli } from "../../testing/fake-sandbox.ts";
import { FakeSink } from "../../testing/fakes.ts";
import { CloudRunSandboxProvider } from "./cloud-run-provider.ts";

const runner = fileURLToPath(new URL("./fixtures/hostile-runner.mjs", import.meta.url));
const b64 = (value: string) => Buffer.from(value).toString("base64");

let cli: FakeSandboxCli;
beforeEach(async () => {
  cli = await createFakeSandboxCli();
});
afterEach(async () => {
  await cli.cleanup();
});

/** Runs the hostile runner with a job secret and another thread's session to aim at. */
async function attack() {
  const secretDir = await mkdtemp(path.join(tmpdir(), "agent-runtime-secret-"));
  const secretFile = path.join(secretDir, "key");
  await writeFile(secretFile, "PROVIDER_API_KEY=sk-live-secret\n");
  const sessionsRoot = await mkdtemp(path.join(tmpdir(), "agent-runtime-sessions-"));
  const store = new DirectorySessionStore(sessionsRoot);
  const other = await mkdtemp(path.join(tmpdir(), "agent-runtime-other-"));
  await writeFile(path.join(other, "chat.jsonl"), "another thread's private session\n");
  await store.save("thread_other", other);

  const provider = new CloudRunSandboxProvider({
    namespace: "test",
    sandboxBin: cli.bin,
    stateDir: cli.stateDir,
    hide: [secretDir, sessionsRoot],
    killGraceMs: 1_000,
  });
  const sink = new FakeSink();
  const outcome = await executeRun({
    provider,
    sink,
    tokens: { grant: async () => "rt_test", revoke: async () => {} },
    runId: "run_1",
    prompt: "…",
    command: [process.execPath, runner],
    image: "unused",
    limits: { wallClockMs: 20_000, cpus: 1, memoryMb: 256 },
    env: { SECRET_FILE: b64(secretFile), SESSIONS_ROOT: b64(sessionsRoot) },
    session: { store, key: "thread_me" },
    batchMs: 10,
  });
  return { outcome, sink, store, sessionsRoot };
}

describe("a hostile sandbox", { timeout: 60_000 }, () => {
  it("cannot have a job file it symlinked stored as an output", async () => {
    const { outcome, sink } = await attack();
    // The output event lands, with nothing stored for it.
    expect(sink.uploads).toEqual([]);
    expect(outcome.events.find((e) => e.type === "artifact")?.payload.artifactId).toBeNull();
    expect(sink.lines.some((l) => /could not store \/workspace\/outputs\/leak.txt: .*symlink/.test(l))).toBe(true);
  });

  it("cannot have other threads' sessions saved as its own by symlinking its session directory", async () => {
    const { outcome, store, sessionsRoot } = await attack();
    expect(outcome.session).toEqual({ restored: false, saved: false });
    expect((await readdir(sessionsRoot)).sort()).toEqual(["thread_other.tar"]);
    const members = execFileSync("tar", ["-tf", store.pathFor("thread_other")]).toString();
    expect(members).toContain("chat.jsonl");
  });
});
