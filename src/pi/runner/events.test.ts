import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RunEvent } from "../contract/events.ts";
import { describe, expect, it } from "vitest";

import { createEmitter, forwardSessionEvent } from "./events.ts";

/** Collects what the runner would have written to stdout. */
function collect(...events: AgentSessionEvent[]): RunEvent[] {
  const lines: RunEvent[] = [];
  const emit = createEmitter((line) => lines.push(JSON.parse(line) as RunEvent));
  for (const event of events) forwardSessionEvent(event, emit);
  return lines;
}

const toolEnd = (result: unknown, isError = false) =>
  ({
    type: "tool_execution_end",
    toolCallId: "t1",
    toolName: "bash",
    result,
    isError,
  }) as unknown as AgentSessionEvent;

describe("forwardSessionEvent", () => {
  it("numbers events in order from zero", () => {
    const events = collect(
      { type: "auto_retry_start" } as unknown as AgentSessionEvent,
      { type: "compaction_start" } as unknown as AgentSessionEvent,
    );
    expect(events.map((e) => [e.seq, e.payload.kind])).toEqual([
      [0, "auto_retry_start"],
      [1, "compaction_start"],
    ]);
  });

  it("carries what a tool returned so the trace shows more than a tick", () => {
    const [event] = collect(toolEnd({ content: [{ type: "text", text: "52 rows" }], details: {} }));
    expect(event!.payload).toMatchObject({ toolName: "bash", isError: false, result: "52 rows" });
  });

  it("truncates a long tool result to keep the event log small", () => {
    const [event] = collect(toolEnd({ content: [{ type: "text", text: "x".repeat(5_000) }] }));
    const result = String(event!.payload.result);
    expect(result).toHaveLength(2_001);
    expect(result.endsWith("…")).toBe(true);
  });

  it("has no result for a tool that returned nothing readable", () => {
    expect(collect(toolEnd({ details: {} }))[0]!.payload.result).toBeUndefined();
  });

  it("keeps the whole usage object from a turn", () => {
    const usage = { input: 1200, output: 340, cacheRead: 900, reasoning: 64 };
    const [event] = collect({
      type: "turn_end",
      message: { role: "assistant", usage, stopReason: "end_turn" },
    } as unknown as AgentSessionEvent);
    expect(event!.payload.usage).toEqual(usage);
    expect(event!.payload.stopReason).toBe("end_turn");
  });
});
