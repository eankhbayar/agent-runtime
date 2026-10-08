// The smoke test's runner, run in the sandbox by executeRun. It continues the
// session in /workspace/.sessions, reports what the sandbox can reach, asks
// the model through LLM_BASE_URL with its run token, and prints run events.
//
//   PROMPT=sleep    waits a minute first, to be cancelled or timed out
//   PROMPT=exit:N   exits N without finishing, as a crashed runner does
//   WORKSPACE       default /workspace

import { lookup } from "node:dns/promises";
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";

import { createEmitter } from "@eankhbayar/agent-runtime/contract";

const emit = createEmitter((line) => process.stdout.write(line));
const prompt = process.env.PROMPT ?? "";
const sessions = `${process.env.WORKSPACE ?? "/workspace"}/.sessions`;
mkdirSync(sessions, { recursive: true });
const turns = (() => {
  try {
    return readFileSync(`${sessions}/turns.jsonl`, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
})();
emit("run_started", { runId: process.env.RUN_ID, turns });
appendFileSync(`${sessions}/turns.jsonl`, `${JSON.stringify({ prompt, at: new Date().toISOString() })}\n`);

const reach = async (url) => {
  try {
    const res = await fetch(url, { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(4000) });
    return `reached ${res.status}`;
  } catch (error) {
    return `blocked ${error.cause?.code ?? error.name}`;
  }
};
const limits = (() => {
  try {
    return readFileSync("/proc/self/limits", "utf8")
      .split("\n")
      .filter((l) => /address space|processes/i.test(l))
      .map((l) => l.replace(/\s+/g, " ").trim());
  } catch (error) {
    return String(error);
  }
})();
emit("notice", {
  kind: "isolation",
  envNames: Object.keys(process.env).sort(),
  internet: await reach("https://www.google.com"),
  metadata: await reach("http://metadata.google.internal/computeMetadata/v1/project/project-id"),
  metadataIp: await reach("http://169.254.169.254/computeMetadata/v1/project/project-id"),
  dns: await lookup("www.google.com").then((a) => `resolved ${a.address}`, (e) => `failed ${e.code}`),
  hiddenSessions: (() => {
    try {
      return readdirSync("/sessions");
    } catch (error) {
      return String(error);
    }
  })(),
  limits,
});

if (prompt === "sleep") await new Promise((resolve) => setTimeout(resolve, 60_000));
const exit = /^exit:(\d+)$/.exec(prompt);
if (exit) {
  console.error(`exiting ${exit[1]} as asked`);
  process.exit(Number(exit[1]));
}

const started = Date.now();
const res = await fetch(`${process.env.LLM_BASE_URL}/v1/messages`, {
  method: "POST",
  headers: { "x-api-key": process.env.LLM_API_KEY, "content-type": "application/json" },
  body: JSON.stringify({ model: "fake", stream: true, max_tokens: 64, messages: [{ role: "user", content: prompt }] }),
});
const arrivals = [];
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of res.body) {
  buffer += decoder.decode(chunk, { stream: true });
  let end;
  while ((end = buffer.indexOf("\n\n")) >= 0) {
    const data = buffer.slice(0, end).split("\n").find((l) => l.startsWith("data: "));
    buffer = buffer.slice(end + 2);
    const event = data && JSON.parse(data.slice(6));
    if (event?.delta?.type === "text_delta") {
      arrivals.push(Date.now() - started);
      emit("text_delta", { delta: event.delta.text });
    }
  }
}
emit("notice", { kind: "stream", status: res.status, arrivals });
emit("run_finished", { status: res.ok ? "succeeded" : "failed", error: res.ok ? undefined : `model answered ${res.status}` });
