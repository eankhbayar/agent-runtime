export type RunEventType = "run_started" | "text_delta" | "tool_start" | "tool_end" | "turn_end" | "notice" | "artifact" | "run_finished";
export type RunEvent = {
    seq: number;
    ts: string;
    type: RunEventType;
    payload: Record<string, unknown>;
};
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
/** The statuses a run can end in; `finish` takes one of these. */
export type FinalRunStatus = Exclude<RunStatus, "queued" | "running">;
/** What a run is allowed to use, echoed in `run_started` so the trace can show it. */
export type RunLimits = {
    wallClockMs: number;
    cpus: number;
    memoryMb: number;
};
/** Sandbox CPU and memory, sampled beside the event log at Unix times in ms. */
export type RunSample = {
    atMs: number;
    cpu: number;
    memoryMb: number;
};
/**
 * Tokens and cost summed over a run's turns, from the `usage` pi reports on each
 * `turn_end`. Cost is in US dollars, priced from the model's per-million-token
 * rates; a model with no rates configured reports 0.
 */
export type RunUsage = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
    };
    /** Turns that reported usage. */
    turns: number;
};
export type EmitRunEvent = (type: RunEventType, payload: RunEvent["payload"]) => void;
export declare function createEmitter(write: (line: string) => void): EmitRunEvent;
export declare const MAX_ARG_CHARS = 2000;
/** Keeps a tool's arguments or result from filling the event log. */
export declare function truncate(value: unknown, max?: number): unknown;
/** Splits a byte stream of JSON lines into events, keeping a partial last line. */
export declare function createEventParser(onEvent: (event: RunEvent) => void, onText?: (line: string) => void): (chunk: string) => void;
