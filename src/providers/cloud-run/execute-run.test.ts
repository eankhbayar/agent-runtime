// executeRun on the Cloud Run provider, the way a job wires it: the fake
// `sandbox` CLI, the stdio bridge, the in-process gateway in front of a fake
// model, and a DirectorySessionStore carrying the session between runs.

import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createInProcessGateway, type InProcessGateway } from "../../core/gateway.ts";
import { executeRun, type ExecuteRunOptions } from "../../core/run.ts";
import { DirectorySessionStore } from "../../core/session-store.ts";
import { createFakeSandboxCli, type FakeSandboxCli } from "../../testing/fake-sandbox.ts";
import { startFakeUpstream, type FakeUpstream } from "../../testing/fake-upstream.ts";
import { FakeSink } from "../../testing/fakes.ts";
import { CloudRunSandboxProvider } from "./cloud-run-provider.ts";

// The runner: continues the session in .sessions/, asks the model through
// LLM_BASE_URL with the run token, and prints run events. PROMPT=sleep makes
// it wait, to be cancelled or timed out.
const RUNNER = `
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
let seq = 0;
const emit = (type, payload) => process.stdout.write(JSON.stringify({ seq: seq++, ts: new Date().toISOString(), type, payload }) + "\\n");
mkdirSync(".sessions", { recursive: true });
const turns = (() => { try { return readFileSync(".sessions/turns.jsonl", "utf8").split("\\n").filter(Boolean).length; } catch { return 0; } })();
emit("run_started", { turns });
appendFileSync(".sessions/turns.jsonl", JSON.stringify({ prompt: process.env.PROMPT }) + "\\n");
if (process.env.PROMPT === "sleep") await new Promise((resolve) => setTimeout(resolve, 60_000));
const res = await fetch(process.env.LLM_BASE_URL + "/v1/messages", {
  method: "POST",
  headers: { "x-api-key": process.env.LLM_API_KEY, "content-type": "application/json" },
  body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: process.env.PROMPT }] }),
});
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of res.body) {
  buffer += decoder.decode(chunk, { stream: true });
  let end;
  while ((end = buffer.indexOf("\\n\\n")) >= 0) {
    const data = buffer.slice(0, end).split("\\n").find((l) => l.startsWith("data: "));
    buffer = buffer.slice(end + 2);
    const event = data && JSON.parse(data.slice(6));
    if (event?.delta?.type === "text_delta") emit("text_delta", { delta: event.delta.text });
  }
}
emit("run_finished", { status: res.ok ? "succeeded" : "failed", error: res.ok ? undefined : "model said " + res.status });
`;

let cli: FakeSandboxCli;
let upstream: FakeUpstream;
let gateway: InProcessGateway;
let runner: string;

beforeEach(async () => {
  cli = await createFakeSandboxCli();
  upstream = await startFakeUpstream({
    apiKey: "sk-provider",
    reply: (body) => `Turn for ${JSON.stringify((body.messages as { content: string }[])[0]?.content)}.`,
  });
  gateway = createInProcessGateway({ messagesUrl: upstream.messagesUrl, apiKey: "sk-provider", log: () => {} });
  runner = path.join(await mkdtemp(path.join(tmpdir(), "agent-runtime-runner-")), "runner.mjs");
  await writeFile(runner, RUNNER);
});

afterEach(async () => {
  await gateway.close();
  await upstream.close();
  await cli.cleanup();
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function setup() {
  const provider = new CloudRunSandboxProvider({
    namespace: "test",
    sandboxBin: cli.bin,
    stateDir: cli.stateDir,
    bridge: { port: await freePort(), onConnection: gateway.connect },
    killGraceMs: 2_000,
  });
  const store = new DirectorySessionStore(await mkdtemp(path.join(tmpdir(), "agent-runtime-sessions-")));
  const run = (prompt: string, overrides: Partial<ExecuteRunOptions> = {}) => {
    const sink = new FakeSink();
    const outcome = executeRun({
      provider,
      sink,
      tokens: gateway,
      runId: `run_${prompt}`,
      prompt,
      command: [process.execPath, runner],
      image: "unused",
      limits: { wallClockMs: 30_000, cpus: 1, memoryMb: 512 },
      env: { LLM_BASE_URL: provider.bridgeUrl },
      session: { store, key: "thread_1" },
      batchMs: 10,
      ...overrides,
    });
    return { sink, outcome };
  };
  return { provider, store, run };
}

// Each run starts real processes; under a full parallel test run that takes a while.
describe("executeRun on Cloud Run", { timeout: 60_000 }, () => {
  it("answers through the bridge and continues the session in the next run's new sandbox", async () => {
    const { run } = await setup();

    const first = await run("first").outcome;
    expect(first).toMatchObject({
      status: "succeeded",
      answerText: 'Turn for "first".',
      session: { restored: false, saved: true },
    });
    expect(first.events[0]).toMatchObject({ type: "run_started", payload: { turns: 0 } });

    const second = await run("second").outcome;
    expect(second).toMatchObject({
      status: "succeeded",
      answerText: 'Turn for "second".',
      session: { restored: true, saved: true },
    });
    // The new sandbox started from the first run's session.
    expect(second.events[0]).toMatchObject({ type: "run_started", payload: { turns: 1 } });
    expect(second.sandboxId).not.toBe(first.sandboxId);

    // Each sandbox and its bridge are gone once its run is.
    expect(await cli.sandboxes()).toEqual([]);
    // The model saw the provider key, never a run token; the runner never saw the key.
    expect(upstream.requests.map((r) => r.headers["x-api-key"])).toEqual(["sk-provider", "sk-provider"]);
    const runCalls = (await cli.calls()).filter((args) => args[0] === "run");
    expect(runCalls).toHaveLength(2);
    expect(runCalls.flat()).not.toContain("--allow-egress");
  });

  it("stops a cancelled run, and saves the session it had", async () => {
    const { run, store } = await setup();
    const stop = new AbortController();
    const { sink, outcome } = run("sleep", { signal: stop.signal });
    // Once the runner has started, and so written its turn to the session.
    while (!sink.sent.some((e) => e.type === "run_started")) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const stopped = Date.now();
    stop.abort();
    const result = await outcome;
    expect(result).toMatchObject({ status: "cancelled", session: { saved: true } });
    expect(Date.now() - stopped).toBeLessThan(10_000);

    const next = await run("after").outcome;
    expect(next.events[0]).toMatchObject({ payload: { turns: 1 } });
    expect(store.pathFor("thread_1")).toMatch(/thread_1\.tar$/);
  });

  it("fails a run at its time limit", async () => {
    const { run } = await setup();
    const result = await run("sleep", { limits: { wallClockMs: 1_500, cpus: 1, memoryMb: 512 } }).outcome;
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/time limit/);
  });
});
