import { type RunEvent, type RunUsage } from "../contract/events.ts";
import { type ArtifactUpload, type EventSink, type SinkState } from "./run.ts";
export type PipelineEventsOptions = {
    /**
     * The first event's seq. A pipeline whose run spans several attempts (a
     * pause for review, a retry) continues the stored log from one past its
     * last seq, so the sink's dedupe on seq never drops a new event.
     */
    firstSeq?: number;
    /** Longest an event waits before its batch is sent. Default 150 ms. */
    batchMs?: number;
    /** A batch is sent once it has this many events. Default 25. */
    batchEvents?: number;
    /** Times a batch the sink rejected is sent again, unchanged, before the rest are dropped. Default 4. */
    retries?: number;
    /** The first wait before a retry, doubling each time. Default 250 ms. */
    retryMs?: number;
    /** Defaults to the current time. */
    now?: () => Date;
};
export type PipelineStep = {
    /** The step's `toolCallId` in the trace. */
    readonly id: string;
    /** The text the trace shows when the step ends, in place of `options.result`. */
    setResult: (text: string) => void;
};
export type PipelineStepOptions<T> = {
    /** Shown with the step, as a tool's arguments are. Truncated like them. */
    args?: unknown;
    /** The text shown as the step's result once it returns. Default none. */
    result?: (value: T) => string | undefined;
    /**
     * The text shown when the step throws. By default the error's `safeCode` or
     * `code` when it looks like an identifier, else `failed`: an error's message
     * can quote a provider or the matter, and the trace is shown to users.
     */
    errorResult?: (error: unknown) => string | undefined;
};
/** An output for the trace: one to store through the sink, or one already stored. */
export type PipelineArtifact = {
    upload: ArtifactUpload;
    path?: string;
    caption?: string;
    kind?: string;
} | {
    artifactId: string | null;
    path: string;
    caption?: string;
    kind?: string;
};
/** One model call's usage: the fields of a RunUsage but `turns`, any of them left out counting 0. */
export type PipelineUsage = Partial<Omit<RunUsage, "turns" | "cost">> & {
    cost?: Partial<RunUsage["cost"]>;
};
export type PipelineEvents = {
    /** `run_started`. Once per run, on its first attempt; `model` is what the trace shows as the run's model. */
    start: (payload?: {
        model?: string;
    } & Record<string, unknown>) => void;
    /**
     * Runs `work` as one step of the trace: `tool_start` before, `tool_end`
     * after, with `isError` when it throws, which it then rethrows. Steps may
     * nest or overlap; each has its own id.
     */
    step: <T>(name: string, work: (step: PipelineStep) => Promise<T> | T, options?: PipelineStepOptions<T>) => Promise<T>;
    /** `text_delta`: answer text, which `answerText` of the folded view returns. */
    text: (delta: string) => void;
    /** `notice`. Shown when it has a message, or a kind the trace knows. */
    notice: (kind: string, message?: string, extra?: Record<string, unknown>) => void;
    /**
     * Stores the upload through the sink if there is one, then writes
     * `artifact`, and resolves with the stored id. Never rejects: an upload the
     * sink fails is logged and the event written with a null id, as executeRun
     * does.
     */
    artifact: (artifact: PipelineArtifact) => Promise<string | null>;
    /** `turn_end` carrying one model call's usage, which the trace sums. */
    usage: (usage: PipelineUsage, extra?: {
        model?: string;
        stopReason?: string;
        step?: string;
    }) => void;
    /** `run_finished`, then sends what is left. Once per run, when it ends; not on a pause. */
    finish: (ending?: {
        error?: string;
        followUps?: readonly string[];
    }) => Promise<SinkState>;
    /** Sends what is pending and resolves with the sink's latest answer. */
    flush: () => Promise<SinkState>;
    /** The sink's latest answer: whether the run was cancelled or is gone. */
    readonly state: SinkState;
    /** Every event written so far, as the sink was sent them. */
    readonly events: readonly RunEvent[];
    /** The seq the next event gets. */
    readonly nextSeq: number;
};
/**
 * Writes a pipeline's trace to `sink`. Emitting never throws and never waits
 * for the sink: events are batched and sent one batch at a time, a rejected
 * batch is sent again unchanged (so a sink that dedupes on seq stores it once),
 * and once the retries run out or the sink answers `gone` the rest are dropped
 * and logged, as executeRun does. The pipeline's own work goes on either way;
 * read `state` to stop it on a cancel.
 */
export declare function createPipelineEvents(sink: EventSink, options?: PipelineEventsOptions): PipelineEvents;
