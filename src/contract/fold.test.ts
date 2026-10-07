import { describe, expect, it } from "vitest";

import type { RunEvent } from "./events.ts";
import { answerText, foldRunEvents } from "./fold.ts";

function events(...list: [RunEvent["type"], Record<string, unknown>, number?][]): RunEvent[] {
  return list.map(([type, payload, ms], seq) => ({
    seq,
    type,
    payload,
    ts: new Date(Date.UTC(2026, 8, 14, 0, 0, 0, ms ?? seq * 100)).toISOString(),
  }));
}

describe("foldRunEvents", () => {
  it("merges text deltas until a tool call breaks the block", () => {
    const view = foldRunEvents(
      events(
        ["run_started", { model: "anthropic/claude-opus-5" }],
        ["text_delta", { delta: "Hello " }],
        ["text_delta", { delta: "there." }],
        ["tool_start", { toolCallId: "t1", toolName: "bash", args: { command: "ls" } }],
        ["text_delta", { delta: "Done." }],
      ),
      "running",
    );
    expect(view.model).toBe("anthropic/claude-opus-5");
    expect(view.items.map((i) => i.kind)).toEqual(["text", "tool", "text"]);
    expect(view.items[0]).toMatchObject({ text: "Hello there." });
  });

  it("closes tool calls with status, duration and result", () => {
    const view = foldRunEvents(
      events(
        ["tool_start", { toolCallId: "t1", toolName: "bash" }, 0],
        ["tool_end", { toolCallId: "t1", isError: true, result: "exit 1" }, 2500],
      ),
      "running",
    );
    expect(view.items[0]).toMatchObject({ status: "error", durationMs: 2500, result: "exit 1" });
  });

  it("marks tools still running as interrupted when the run was cancelled", () => {
    const view = foldRunEvents(
      events(["tool_start", { toolCallId: "t1", toolName: "bash" }]),
      "cancelled",
    );
    expect(view.items[0]).toMatchObject({ status: "interrupted" });
  });

  it("sums usage across turns and keeps the finish error", () => {
    const view = foldRunEvents(
      events(
        [
          "turn_end",
          {
            usage: {
              input: 1200,
              output: 300,
              cacheRead: 5000,
              cacheWrite: 400,
              totalTokens: 6900,
              cost: {
                input: 0.0036,
                output: 0.0045,
                cacheRead: 0.0015,
                cacheWrite: 0.0015,
                total: 0.0111,
              },
            },
          },
        ],
        // A provider that reports no cache or cost counts those as 0.
        ["turn_end", { usage: { input: 800, output: 100 } }],
        ["turn_end", {}],
        ["run_finished", { status: "failed", error: "limit" }],
      ),
      "failed",
    );
    expect(view.usage).toEqual({
      input: 2000,
      output: 400,
      cacheRead: 5000,
      cacheWrite: 400,
      totalTokens: 6900,
      cost: { input: 0.0036, output: 0.0045, cacheRead: 0.0015, cacheWrite: 0.0015, total: 0.0111 },
      turns: 2,
    });
    expect(view.error).toBe("limit");
  });

  it("drops runner diagnostics but shows known notices", () => {
    const view = foldRunEvents(
      events(["notice", { kind: "check", node: "v24" }], ["notice", { kind: "compaction_start" }]),
      "running",
    );
    expect(view.items).toHaveLength(1);
    expect(view.items[0]).toMatchObject({ kind: "notice", noticeKind: "compaction_start" });
  });

  it("folds events that arrive out of order by seq", () => {
    const [first, second] = events(
      ["text_delta", { delta: "one " }],
      ["text_delta", { delta: "two" }],
    );
    const view = foldRunEvents([second!, first!], "running");
    expect(view.items[0]).toMatchObject({ text: "one two" });
  });
});

describe("answerText", () => {
  it("joins the text blocks the agent wrote and drops everything else", () => {
    const view = foldRunEvents(
      events(
        ["text_delta", { delta: "  Zac Purton won 52. " }],
        ["tool_start", { toolCallId: "t1", toolName: "bash" }],
        ["tool_end", { toolCallId: "t1", isError: false, result: "ok" }],
        ["text_delta", { delta: "Karis Teetan was second." }],
        ["run_finished", { status: "succeeded" }],
      ),
      "succeeded",
    );
    expect(answerText(view)).toBe("Zac Purton won 52.\n\nKaris Teetan was second.");
  });

  it("is empty when the run produced no text", () => {
    expect(
      answerText(foldRunEvents(events(["run_finished", { status: "failed" }]), "failed")),
    ).toBe("");
  });
});
