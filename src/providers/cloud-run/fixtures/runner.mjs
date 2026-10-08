// The runner for execute-run.test.ts: continues the session in .sessions/,
// asks the model through LLM_BASE_URL with the run token, and prints run
// events. PROMPT=sleep makes it wait, to be cancelled or timed out. It is a
// file here rather than in a temp directory because a sandbox's /tmp is its own.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
let seq = 0;
const emit = (type, payload) => process.stdout.write(JSON.stringify({ seq: seq++, ts: new Date().toISOString(), type, payload }) + "\n");
mkdirSync(".sessions", { recursive: true });
const turns = (() => { try { return readFileSync(".sessions/turns.jsonl", "utf8").split("\n").filter(Boolean).length; } catch { return 0; } })();
emit("run_started", { turns });
appendFileSync(".sessions/turns.jsonl", JSON.stringify({ prompt: process.env.PROMPT }) + "\n");
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
  while ((end = buffer.indexOf("\n\n")) >= 0) {
    const data = buffer.slice(0, end).split("\n").find((l) => l.startsWith("data: "));
    buffer = buffer.slice(end + 2);
    const event = data && JSON.parse(data.slice(6));
    if (event?.delta?.type === "text_delta") emit("text_delta", { delta: event.delta.text });
  }
}
emit("run_finished", { status: res.ok ? "succeeded" : "failed", error: res.ok ? undefined : "model said " + res.status });
