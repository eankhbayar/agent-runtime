import { describe, expect, it } from "vitest";

import { answerText, foldRunEvents } from "../contract/fold.ts";
import { turnUsage } from "../models/usage.ts";
import { FakeSink } from "../testing/fakes.ts";

import { createPipelineEvents } from "./pipeline-events.ts";

/** A clock that moves on by `stepMs` each time it is read. */
function clock(stepMs = 1_000) {
  let ms = Date.UTC(2026, 9, 9, 0, 0, 0);
  return () => new Date((ms += stepMs));
}

const fast = { batchMs: 1, retryMs: 1 };

describe("createPipelineEvents", () => {
  it("writes a research pipeline's trace that foldRunEvents renders as its steps", async () => {
    const sink = new FakeSink();
    const trace = createPipelineEvents(sink, { ...fast, now: clock() });
    const pricing = { inputUsdPerMillionTokens: 0.2, outputUsdPerMillionTokens: 1.2 };

    trace.start({ model: "kimi/gpt-6.1-sol", pipeline: "research", stage: "framing" });
    const frame = await trace.step(
      "framing",
      async () => {
        trace.usage(
          turnUsage({ inputTokens: 1_000, outputTokens: 200, reasoningTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }, pricing),
          { model: "gpt-6.1-sol", step: "framing" },
        );
        return { issues: 3 };
      },
      { args: { question: "Is the clause enforceable?" }, result: (value) => `${value.issues} issues framed` },
    );
    expect(frame).toEqual({ issues: 3 });
    await trace.step("retrieval", async (step) => {
      step.setResult("12 passages from corpus 2026-10-01");
    });
    trace.notice("paused_for_review", "Waiting for the evidence review.");
    await trace.artifact({ artifactId: "memo-1", path: "research-memo.md", caption: "Draft memo", kind: "report" });
    trace.text("The clause is likely enforceable.");
    const state = await trace.finish();

    expect(state).toEqual({ cancelled: false, gone: false });
    expect(sink.sent).toEqual(trace.events);
    expect(sink.sent.map((e) => e.seq)).toEqual([...Array(sink.sent.length).keys()]);

    const view = foldRunEvents(sink.sent, "succeeded");
    expect(view.model).toBe("kimi/gpt-6.1-sol");
    expect(view.items).toEqual([
      {
        kind: "tool",
        id: "step-1",
        name: "framing",
        args: { question: "Is the clause enforceable?" },
        status: "done",
        durationMs: 2_000,
        result: "3 issues framed",
      },
      {
        kind: "tool",
        id: "step-4",
        name: "retrieval",
        args: undefined,
        status: "done",
        durationMs: 1_000,
        result: "12 passages from corpus 2026-10-01",
      },
      { kind: "notice", id: "notice-6", noticeKind: "paused_for_review", message: "Waiting for the evidence review." },
      { kind: "artifact", id: "artifact-7", artifactId: "memo-1", path: "research-memo.md", caption: "Draft memo" },
      { kind: "text", id: "text-8", text: "The clause is likely enforceable." },
    ]);
    expect(view.usage).toMatchObject({
      input: 1_000,
      output: 250,
      totalTokens: 1_250,
      turns: 1,
      cost: { input: 0.0002, output: 0.0003, total: 0.0005 },
    });
    expect(view.startedAt).toBe(sink.sent[0]!.ts);
    expect(view.endedAt).toBe(sink.sent.at(-1)!.ts);
    expect(view.error).toBeNull();
    expect(answerText(view)).toBe("The clause is likely enforceable.");
  });

  it("marks a step that threw as an error, showing a safe code and never the message", async () => {
    const sink = new FakeSink();
    const trace = createPipelineEvents(sink, fast);
    const failure = Object.assign(new Error("Kimi refused: prompt quoted the client's name"), { safeCode: "model_output_invalid" });
    await expect(trace.step("memo_drafting", async () => Promise.reject(failure))).rejects.toBe(failure);
    await expect(
      trace.step("source_audit", () => {
        throw new Error("secret detail");
      }),
    ).rejects.toThrow("secret detail");
    await expect(
      trace.step("verification", () => Promise.reject(new Error("x")), { errorResult: () => "fact check unavailable" }),
    ).rejects.toThrow();
    await trace.finish({ error: "model_output_invalid" });

    const view = foldRunEvents(sink.sent, "failed");
    expect(view.items.map((item) => item.kind === "tool" && [item.name, item.status, item.result])).toEqual([
      ["memo_drafting", "error", "model_output_invalid"],
      ["source_audit", "error", "failed"],
      ["verification", "error", "fact check unavailable"],
    ]);
    expect(view.error).toBe("model_output_invalid");
    expect(JSON.stringify(sink.sent)).not.toContain("secret");
    expect(JSON.stringify(sink.sent)).not.toContain("client's name");
  });

  it("leaves a step the worker never finished as interrupted once the run failed", async () => {
    const sink = new FakeSink();
    const trace = createPipelineEvents(sink, fast);
    void trace.step("retrieval", () => new Promise(() => {}));
    await trace.flush();
    expect(foldRunEvents(sink.sent, "running").items[0]).toMatchObject({ status: "running" });
    expect(foldRunEvents(sink.sent, "failed").items[0]).toMatchObject({ status: "interrupted" });
  });

  it("continues an earlier attempt's log from firstSeq", async () => {
    const sink = new FakeSink();
    const trace = createPipelineEvents(sink, { ...fast, firstSeq: 40 });
    await trace.step("evidence_analysis", () => "ok");
    expect(sink.sent.length).toBe(0);
    expect(trace.nextSeq).toBe(42);
    await trace.flush();
    expect(sink.sent.map((e) => [e.seq, e.payload.toolCallId])).toEqual([
      [40, "step-40"],
      [41, "step-40"],
    ]);
  });

  it("sends in batches, one at a time, and sends a rejected batch again unchanged", async () => {
    const sink = new FakeSink();
    sink.failNext = 1;
    const trace = createPipelineEvents(sink, { batchMs: 10_000, batchEvents: 3, retryMs: 1 });
    for (let i = 0; i < 7; i++) trace.notice("progress", `step ${i}`);
    await trace.flush();
    expect(sink.batches.map((batch) => batch.map((e) => e.seq))).toEqual([[0, 1, 2], [3, 4, 5], [6]]);
    expect(sink.lines).toEqual(["retrying 3 pipeline event(s): Error: connection lost"]);
  });

  it("sends what waits once batchMs has passed, without a flush", async () => {
    const sink = new FakeSink();
    const trace = createPipelineEvents(sink, { batchMs: 5 });
    trace.notice("progress", "started");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sink.sent).toHaveLength(1);
  });

  it("reports a cancel, and stops sending once the sink says the run is gone", async () => {
    const sink = new FakeSink();
    const trace = createPipelineEvents(sink, fast);
    sink.state = { cancelled: true, gone: false };
    trace.notice("progress", "one");
    expect(await trace.flush()).toEqual({ cancelled: true, gone: false });
    sink.state = { cancelled: false, gone: true };
    trace.notice("progress", "two");
    expect(await trace.flush()).toEqual({ cancelled: true, gone: true });
    trace.notice("progress", "three");
    await trace.flush();
    expect(sink.sent.map((e) => e.payload.message)).toEqual(["one", "two"]);
    expect(trace.state).toEqual({ cancelled: true, gone: true });
    expect(sink.lines).toEqual(["dropped 1 pipeline event(s): the run is gone"]);
  });

  it("drops the rest after the retries run out, and the pipeline goes on", async () => {
    const sink = new FakeSink();
    sink.failNext = 10;
    const trace = createPipelineEvents(sink, { ...fast, retries: 1 });
    expect(await trace.step("framing", () => 7)).toBe(7);
    await trace.flush();
    expect(sink.sent).toHaveLength(0);
    expect(sink.lines.at(-1)).toBe("giving up on 2 pipeline event(s): Error: connection lost");
    trace.notice("progress", "after");
    await trace.flush();
    expect(sink.lines.at(-1)).toBe("dropped 1 pipeline event(s): the run is gone");
  });

  it("writes the artifact with a null id when the sink cannot store it, and does not throw", async () => {
    const sink = new FakeSink();
    sink.artifact = async () => {
      throw new Error("bucket unavailable");
    };
    const trace = createPipelineEvents(sink, fast);
    const bytes = new TextEncoder().encode("# Memo");
    const id = await trace.artifact({
      upload: { kind: "report", fileName: "memo.md", caption: "Memo", mediaType: "text/markdown", sha256: "abc", size: bytes.length, bytes },
    });
    await trace.finish();
    expect(id).toBeNull();
    expect(sink.lines).toEqual(["could not store memo.md: Error: bucket unavailable"]);
    expect(foldRunEvents(sink.sent, "succeeded").items).toEqual([
      { kind: "artifact", id: "artifact-0", artifactId: null, path: "memo.md", caption: "Memo" },
    ]);
  });

  it("stores an upload through the sink and writes its id", async () => {
    const sink = new FakeSink();
    const trace = createPipelineEvents(sink, fast);
    const bytes = new TextEncoder().encode("# Memo");
    const id = await trace.artifact({
      upload: { kind: "report", fileName: "memo.md", caption: "Memo", mediaType: "text/markdown", sha256: "abc", size: bytes.length, bytes },
    });
    await trace.finish();
    expect(id).toBe("artifact-1");
    expect(sink.uploads).toHaveLength(1);
    expect(sink.sent[0]).toMatchObject({
      type: "artifact",
      payload: { artifactId: "artifact-1", path: "memo.md", caption: "Memo", kind: "report" },
    });
  });

  it("writes nothing after run_finished", async () => {
    const sink = new FakeSink();
    const trace = createPipelineEvents(sink, fast);
    await trace.finish({ followUps: ["Check the limitation period?"] });
    trace.notice("late", "too late");
    await trace.flush();
    expect(sink.sent.map((e) => e.type)).toEqual(["run_finished"]);
    expect(foldRunEvents(sink.sent, "succeeded").followUps).toEqual(["Check the limitation period?"]);
    expect(sink.lines).toEqual(["dropped a notice event written after run_finished"]);
  });
});
