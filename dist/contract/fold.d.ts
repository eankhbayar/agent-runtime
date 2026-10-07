import type { RunEvent, RunStatus, RunUsage } from "./events.ts";
export type ToolStatus = "running" | "done" | "error" | "interrupted";
export type RunItem = {
    kind: "text";
    id: string;
    text: string;
} | {
    kind: "tool";
    id: string;
    name: string;
    args: unknown;
    status: ToolStatus;
    durationMs: number | null;
    result: string | null;
} | {
    kind: "notice";
    id: string;
    noticeKind: string;
    message: string;
} | {
    kind: "artifact";
    id: string;
    artifactId: string | null;
    path: string;
    caption: string;
};
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
export declare function emptyUsage(): RunUsage;
export declare function foldRunEvents(events: readonly RunEvent[], status: RunStatus): RunView;
/** The answer as the agent wrote it: every text block, in order, as Markdown. */
export declare function answerText(view: RunView): string;
