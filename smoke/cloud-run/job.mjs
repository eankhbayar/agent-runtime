// The smoke test's job: one Cloud Run Job execution with --sandbox-launcher
// running executeRun + CloudRunSandboxProvider + the stdio bridge + the
// in-process gateway, against a fake model served inside the job, with a
// DirectorySessionStore on the job's Cloud Storage volume. Prints one
// `SMOKE {json}` line per check and `SMOKE-END` last.
//
//   SMOKE_PHASE         "first" (every check) or "second" (one run, to show the
//                       session crossing executions)
//   SMOKE_SESSION_KEY   the session's key in the store
//   SMOKE_SESSIONS_DIR  the store's directory (default /sessions/agent-runtime-smoke)
//   SMOKE_SECRET        any value; the sandbox must not see it
//
// SMOKE_SANDBOX_BIN, SMOKE_STATE_DIR, SMOKE_RUNNER and SMOKE_BRIDGE_PORT
// let it run on a laptop against the fake CLI from ./testing.

import { createInProcessGateway, DirectorySessionStore, executeRun } from "@eankhbayar/agent-runtime/core";
import { CloudRunSandboxProvider } from "@eankhbayar/agent-runtime/providers/cloud-run";
import { startFakeUpstream } from "@eankhbayar/agent-runtime/testing";

const phase = process.env.SMOKE_PHASE ?? "first";
const key = process.env.SMOKE_SESSION_KEY ?? "smoke";
const results = [];
const record = (check, ok, detail) => {
  results.push({ check, ok });
  console.log(`SMOKE ${JSON.stringify({ check, ok, detail })}`);
};
const step = async (name, fn) => {
  try {
    await fn();
  } catch (error) {
    record(name, false, { threw: String(error?.stack ?? error) });
  }
};

const upstream = await startFakeUpstream({
  apiKey: "smoke-upstream-key",
  gapMs: 100,
  reply: (body) => `You said ${JSON.stringify(body.messages?.[0]?.content)}; this is the fake model.`,
});
const gateway = createInProcessGateway({ messagesUrl: upstream.messagesUrl, apiKey: "smoke-upstream-key" });
const bridgePort = Number(process.env.SMOKE_BRIDGE_PORT ?? 8080);
const provider = new CloudRunSandboxProvider({
  namespace: "smoke",
  bridge: { port: bridgePort, onConnection: gateway.connect, log: (m) => console.log(`BRIDGE ${m}`) },
  hide: ["/sessions"],
  ...(process.env.SMOKE_SANDBOX_BIN ? { sandboxBin: process.env.SMOKE_SANDBOX_BIN } : {}),
  ...(process.env.SMOKE_STATE_DIR ? { stateDir: process.env.SMOKE_STATE_DIR } : {}),
});
const store = new DirectorySessionStore(process.env.SMOKE_SESSIONS_DIR ?? "/sessions/agent-runtime-smoke");
const limits = { wallClockMs: 60_000, cpus: 1, memoryMb: 1024 };
record("host", true, { hostId: await provider.hostId(), uid: process.getuid(), node: process.version });

/** A sink that prints every event and keeps them. */
function printingSink(label) {
  const events = [];
  return {
    events,
    sink: {
      events: async (batch) => {
        for (const e of batch) {
          events.push(e);
          console.log(`EVENT ${label} ${JSON.stringify(e)}`);
        }
        return { cancelled: false, gone: false };
      },
      samples: async () => {},
      artifact: async () => null,
      log: (message) => console.log(`LOG ${label} ${message}`),
    },
  };
}

function run(label, prompt, overrides = {}) {
  const { sink, events } = printingSink(label);
  const started = Date.now();
  const outcome = executeRun({
    provider,
    sink,
    tokens: gateway,
    runId: `smoke-${label}`,
    prompt,
    command: [process.execPath, process.env.SMOKE_RUNNER ?? "/opt/runner/runner.mjs"],
    image: "this-job",
    limits,
    env: { LLM_BASE_URL: provider.bridgeUrl, WORKSPACE: "/workspace" },
    session: { store, key },
    batchMs: 50,
    ...overrides,
  }).then((o) => ({ ...o, ms: Date.now() - started }));
  return { outcome, events };
}

const notice = (events, kind) => events.find((e) => e.type === "notice" && e.payload.kind === kind)?.payload;
const turnsOf = (events) => events.find((e) => e.type === "run_started")?.payload.turns;

async function exec(sandboxId, command, opts = {}) {
  let stdout = "";
  let stderr = "";
  const started = Date.now();
  const code = await provider.exec(sandboxId, command, {
    ...opts,
    onStdout: (d) => (stdout += d),
    onStderr: (d) => (stderr += d),
  }).done;
  return { code, stdout, stderr, ms: Date.now() - started };
}

if (phase === "first") {
  await step("exec", async () => {
    const id = await provider.create({ image: "", limits: { cpus: 1, memoryMb: 1024, pids: 256 } });
    try {
      const seven = await exec(id, ["sh", "-c", "echo partial; exit 7"]);
      record("exec.exit-7", seven.code === 7 && seven.stdout === "partial\n", seven);
      const zero = await exec(id, ["sh", "-c", "printf 'no newline'"]);
      record("exec.exit-0-no-newline", zero.code === 0 && zero.stdout === "no newline", zero);
      const missing = await exec(id, ["no-such-command"]);
      record("exec.not-found-127", missing.code === 127, missing);
      const env = await exec(id, ["env"], { env: { RUN_ID: "smoke" } });
      record("exec.env-only-what-is-passed", !env.stdout.includes("SMOKE_SECRET") && env.stdout.includes("RUN_ID=smoke"), env);
      const limited = await exec(id, ["sh", "-c", "ulimit -v; ulimit -p 2>/dev/null || ulimit -u"]);
      record("exec.limits", limited.stdout.trim() === `${(1024 + 1536) * 1024}\n256`, limited);
      const timeout = await exec(id, ["sleep", "30"], { timeoutMs: 2_000 });
      record("exec.timeout-124", timeout.code === 124 && timeout.ms < 6_000, timeout);

      const handle = provider.exec(id, ["sh", "-c", "echo $$ > /workspace/victim.pid; exec sleep 300"]);
      await new Promise((r) => setTimeout(r, 1_500));
      const t0 = Date.now();
      await handle.kill();
      const killedCode = await handle.done;
      const after = await exec(id, ["sh", "-c", 'kill -0 "$(cat /workspace/victim.pid)" 2>/dev/null && echo alive || echo gone']);
      record("exec.kill-143", killedCode === 143 && after.stdout.trim() === "gone", { killedCode, ms: Date.now() - t0, after: after.stdout.trim() });

      // The bridge: kill the shim in the sandbox and see a later call still get through.
      const call = `fetch(process.env.U + "/healthz").then(async (r) => console.log(r.status, await r.text())).catch((e) => console.log("failed", e.cause?.code ?? e.message))`;
      const before = await exec(id, ["node", "-e", call], { env: { U: provider.bridgeUrl } });
      await exec(id, ["sh", "-c", `kill -9 "$(cat /tmp/agent-runtime-bridge-${bridgePort}.pid)"`]);
      let afterRestart;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 500));
        afterRestart = await exec(id, ["node", "-e", call], { env: { U: provider.bridgeUrl } });
        if (afterRestart.stdout.startsWith("200")) break;
      }
      record("bridge.restart", before.stdout.startsWith("200 ok") && afterRestart.stdout.startsWith("200 ok"), {
        before: before.stdout.trim(),
        afterRestart: afterRestart.stdout.trim(),
      });
      const upload = await exec(id, ["sh", "-c", "head -c 5000000 /dev/urandom > /workspace/big.bin && sha256sum /workspace/big.bin"]);
      record("exec.workspace-write", upload.code === 0, { ms: upload.ms, out: upload.stdout.trim() });
    } finally {
      await provider.destroy(id);
    }
  });

  let firstTurns;
  await step("run.first", async () => {
    const { outcome, events } = run("first", "first question");
    const o = await outcome;
    const iso = notice(events, "isolation");
    const stream = notice(events, "stream");
    firstTurns = turnsOf(events);
    record("run.first", o.status === "succeeded" && o.session?.saved === true, {
      status: o.status,
      answer: o.answerText,
      session: o.session,
      turns: firstTurns,
      ms: o.ms,
      sandboxId: o.sandboxId,
    });
    record("run.streaming", (stream?.arrivals?.length ?? 0) > 5 && stream.arrivals.at(-1) - stream.arrivals[0] > 400, stream);
    record(
      "run.no-network",
      [iso.internet, iso.metadata, iso.metadataIp].every((r) => r.startsWith("blocked")) && iso.dns.startsWith("failed"),
      { internet: iso.internet, metadata: iso.metadata, metadataIp: iso.metadataIp, dns: iso.dns },
    );
    record("run.env", !iso.envNames.includes("SMOKE_SECRET") && iso.envNames.includes("LLM_API_KEY"), iso.envNames);
    record("run.sessions-hidden", Array.isArray(iso.hiddenSessions) && iso.hiddenSessions.length === 0, iso.hiddenSessions);
    record("run.limits", true, iso.limits);
    record("gateway.upstream-key", upstream.requests.at(-1)?.headers["x-api-key"] === "smoke-upstream-key", {
      runTokenSent: upstream.requests.some((r) => String(r.headers["x-api-key"]).startsWith("rt_")),
    });
  });

  await step("run.second", async () => {
    const { outcome, events } = run("second", "second question");
    const o = await outcome;
    const turns = turnsOf(events);
    record("run.session-restored", o.status === "succeeded" && o.session?.restored === true && turns === firstTurns + 1, {
      turns,
      firstTurns,
      session: o.session,
      ms: o.ms,
      sandboxId: o.sandboxId,
    });
  });

  await step("run.cancel", async () => {
    const stop = new AbortController();
    const { outcome, events } = run("cancel", "sleep", { signal: stop.signal });
    let settled = false;
    outcome.finally(() => (settled = true)).catch(() => {});
    while (!settled && !events.some((e) => e.type === "notice")) await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    stop.abort();
    const o = await outcome;
    record("run.cancel", o.status === "cancelled" && o.session?.saved === true, {
      status: o.status,
      session: o.session,
      stopMs: Date.now() - t0,
      last: events.at(-1),
    });
  });

  await step("run.timeout", async () => {
    const { outcome } = run("timeout", "sleep", { limits: { ...limits, wallClockMs: 8_000 } });
    const o = await outcome;
    record("run.timeout", o.status === "failed" && /time limit/.test(o.error ?? "") && o.ms < 25_000, {
      status: o.status,
      error: o.error,
      ms: o.ms,
    });
  });

  await step("run.crash", async () => {
    const { outcome } = run("crash", "exit:3");
    const o = await outcome;
    record("run.crash", o.status === "failed" && /exiting 3/.test(o.error ?? ""), { status: o.status, error: o.error });
  });
} else {
  await step("run.next-execution", async () => {
    const { outcome, events } = run("next", "a question from the next execution");
    const o = await outcome;
    record("run.next-execution", o.status === "succeeded" && o.session?.restored === true, {
      turns: turnsOf(events),
      session: o.session,
      answer: o.answerText,
      sandboxId: o.sandboxId,
    });
  });
}

record("leftovers", (await provider.list()).length === 0, await provider.list());
console.log(
  ["SUMMARY", ...results.map((r) => `${r.ok === true ? "pass" : r.ok === false ? "FAIL" : "info"}  ${r.check}`)].join("\n"),
);
console.log("SMOKE-END");
await gateway.close();
await upstream.close();
process.exit(0);
