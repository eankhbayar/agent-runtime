import type { RunEvent, RunStatus, RunUsage } from "./events.ts";

// Folds a run's event log into the blocks the thread view renders and the
// answer text the dispatcher stores. Pure, so a reload that replays the stored
// events rebuilds exactly the same view the stream built.

export type ToolStatus = "running" | "done" | "error" | "interrupted";

export type RunItem =
  | { kind: "text"; id: string; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      args: unknown;
      status: ToolStatus;
      durationMs: number | null;
      result: string | null;
    }
  | { kind: "notice"; id: string; noticeKind: string; message: string }
  | { kind: "artifact"; id: string; artifactId: string | null; path: string; caption: string };

export type RunView = {
  items: RunItem[];
  model: string | null;
  startedAt: string | null;
  endedAt: string | null;
  usage: RunUsage;
  error: string | null;
  /** Follow-up questions the agent suggested when it finished. */
  followUps: string[];
};

const NOTICE_MESSAGES: Record<string, string> = {
  auto_retry_start: "Model request failed. Retrying.",
  compaction_start: "Compacting context to stay within the model's limit.",
};

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function emptyUsage(): RunUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    turns: 0,
  };
}

/** Adds one turn's reported usage; fields a provider leaves out count as 0. */
function addUsage(total: RunUsage, reported: unknown): void {
  if (typeof reported !== "object" || reported === null) return;
  const usage = reported as Record<string, unknown>;
  const cost = (usage.cost ?? {}) as Record<string, unknown>;
  total.input += num(usage.input);
  total.output += num(usage.output);
  total.cacheRead += num(usage.cacheRead);
  total.cacheWrite += num(usage.cacheWrite);
  total.totalTokens += num(usage.totalTokens);
  total.cost.input += num(cost.input);
  total.cost.output += num(cost.output);
  total.cost.cacheRead += num(cost.cacheRead);
  total.cost.cacheWrite += num(cost.cacheWrite);
  total.cost.total += num(cost.total);
  total.turns += 1;
}

export function foldRunEvents(events: readonly RunEvent[], status: RunStatus): RunView {
  const items: RunItem[] = [];
  const tools = new Map<string, { index: number; startedAt: number }>();
  const view: RunView = {
    items,
    model: null,
    startedAt: events[0]?.ts ?? null,
    endedAt: null,
    usage: emptyUsage(),
    error: null,
    followUps: [],
  };

  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const p = event.payload;
    switch (event.type) {
      case "run_started":
        view.model = str(p.model);
        break;
      case "text_delta": {
        const last = items.at(-1);
        const delta = str(p.delta) ?? "";
        if (last?.kind === "text") last.text += delta;
        else items.push({ kind: "text", id: `text-${event.seq}`, text: delta });
        break;
      }
      case "tool_start": {
        const id = str(p.toolCallId) ?? `tool-${event.seq}`;
        tools.set(id, { index: items.length, startedAt: Date.parse(event.ts) });
        items.push({
          kind: "tool",
          id,
          name: str(p.toolName) ?? "tool",
          args: p.args,
          status: "running",
          durationMs: null,
          result: null,
        });
        break;
      }
      case "tool_end": {
        const started = tools.get(str(p.toolCallId) ?? "");
        const item = started ? items[started.index] : undefined;
        if (item?.kind !== "tool") break;
        item.status = p.isError === true ? "error" : "done";
        item.durationMs = Date.parse(event.ts) - started!.startedAt;
        item.result = str(p.result);
        break;
      }
      case "turn_end":
        addUsage(view.usage, p.usage);
        break;
      case "notice": {
        const noticeKind = str(p.kind) ?? "notice";
        const message = str(p.message) ?? NOTICE_MESSAGES[noticeKind];
        // The runner's --check notice is diagnostics, not something to show.
        if (message) items.push({ kind: "notice", id: `notice-${event.seq}`, noticeKind, message });
        break;
      }
      case "artifact":
        items.push({
          kind: "artifact",
          id: `artifact-${event.seq}`,
          artifactId: str(p.artifactId),
          path: str(p.path) ?? "",
          caption: str(p.caption) ?? "",
        });
        break;
      case "run_finished":
        view.endedAt = event.ts;
        view.error = str(p.error);
        view.followUps = Array.isArray(p.followUps)
          ? p.followUps.filter((q): q is string => typeof q === "string")
          : [];
        break;
    }
  }

  if (status === "cancelled" || status === "failed") {
    for (const item of items) {
      if (item.kind === "tool" && item.status === "running") item.status = "interrupted";
    }
  }
  return view;
}

/** The answer as the agent wrote it: every text block, in order, as Markdown. */
export function answerText(view: RunView): string {
  return view.items
    .flatMap((item) => (item.kind === "text" ? [item.text.trim()] : []))
    .filter(Boolean)
    .join("\n\n");
}
