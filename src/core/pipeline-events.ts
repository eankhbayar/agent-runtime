// The run trace for a pipeline: a trusted worker that runs its own steps
// rather than an agent in a sandbox (hk-legal's Research Worker under runJob)
// writes the same RunEvent stream the pi runner does, so an app renders both
// with foldRunEvents. A step is a tool call in the trace (tool_start and
// tool_end), a model call's usage is a turn_end, and the rest are the
// contract's own events. Events go to an EventSink, usually the run's claim,
// batched and in seq order as executeRun sends them.

import { truncate, type RunEvent, type RunEventType, type RunUsage } from "../contract/events.ts";

import { LIVE, type ArtifactUpload, type EventSink, type SinkState } from "./run.ts";

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
export type PipelineArtifact =
  | { upload: ArtifactUpload; path?: string; caption?: string; kind?: string }
  | { artifactId: string | null; path: string; caption?: string; kind?: string };

/** One model call's usage: the fields of a RunUsage but `turns`, any of them left out counting 0. */
export type PipelineUsage = Partial<Omit<RunUsage, "turns" | "cost">> & {
  cost?: Partial<RunUsage["cost"]>;
};

export type PipelineEvents = {
  /** `run_started`. Once per run, on its first attempt; `model` is what the trace shows as the run's model. */
  start: (payload?: { model?: string } & Record<string, unknown>) => void;
  /**
   * Runs `work` as one step of the trace: `tool_start` before, `tool_end`
   * after, with `isError` when it throws, which it then rethrows. Steps may
   * nest or overlap; each has its own id.
   */
  step: <T>(
    name: string,
    work: (step: PipelineStep) => Promise<T> | T,
    options?: PipelineStepOptions<T>,
  ) => Promise<T>;
  /** `text_delta`: answer text, which `answerText` of the folded view returns. */
  text: (delta: string) => void;
  /** `notice`. Shown when it has a message, or a kind the trace knows. */
  notice: (kind: string, message?: string, extra?: Record<string, unknown>) => void;
  /** Stores the upload through the sink if there is one, then writes `artifact`. Resolves with its id. */
  artifact: (artifact: PipelineArtifact) => Promise<string | null>;
  /** `turn_end` carrying one model call's usage, which the trace sums. */
  usage: (usage: PipelineUsage, extra?: { model?: string; stopReason?: string; step?: string }) => void;
  /** `run_finished`, then sends what is left. Once per run, when it ends; not on a pause. */
  finish: (ending?: { error?: string; followUps?: readonly string[] }) => Promise<SinkState>;
  /** Sends what is pending and resolves with the sink's latest answer. */
  flush: () => Promise<SinkState>;
  /** The sink's latest answer: whether the run was cancelled or is gone. */
  readonly state: SinkState;
  /** Every event written so far, as the sink was sent them. */
  readonly events: readonly RunEvent[];
  /** The seq the next event gets. */
  readonly nextSeq: number;
};

const SAFE_CODE = /^[a-z][a-z0-9_.:-]{0,79}$/;

function defaultErrorResult(error: unknown): string {
  const fields = (error ?? {}) as { safeCode?: unknown; code?: unknown };
  for (const value of [fields.safeCode, fields.code]) {
    if (typeof value === "string" && SAFE_CODE.test(value)) return value;
  }
  return "failed";
}

/**
 * Writes a pipeline's trace to `sink`. Emitting never throws and never waits
 * for the sink: events are batched and sent one batch at a time, a rejected
 * batch is sent again unchanged (so a sink that dedupes on seq stores it once),
 * and once the retries run out or the sink answers `gone` the rest are dropped
 * and logged, as executeRun does. The pipeline's own work goes on either way;
 * read `state` to stop it on a cancel.
 */
export function createPipelineEvents(sink: EventSink, options: PipelineEventsOptions = {}): PipelineEvents {
  const batchMs = options.batchMs ?? 150;
  const batchEvents = options.batchEvents ?? 25;
  const retries = options.retries ?? 4;
  const retryMs = options.retryMs ?? 250;
  const now = options.now ?? (() => new Date());

  let seq = options.firstSeq ?? 0;
  let state: SinkState = LIVE;
  let gone = false;
  let finished = false;
  const events: RunEvent[] = [];
  let pending: RunEvent[] = [];
  let flushing: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const send = async (batch: RunEvent[]): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const answer = await sink.events(batch);
        state = { cancelled: state.cancelled || answer.cancelled, gone: state.gone || answer.gone };
        if (answer.gone) gone = true;
        return;
      } catch (cause) {
        if (attempt >= retries) {
          sink.log(`giving up on ${batch.length} pipeline event(s): ${String(cause)}`);
          gone = true;
          return;
        }
        sink.log(`retrying ${batch.length} pipeline event(s): ${String(cause)}`);
        await new Promise((resolve) => setTimeout(resolve, retryMs * 2 ** attempt));
      }
    }
  };

  const flush = (): Promise<SinkState> => {
    clearTimeout(timer);
    timer = undefined;
    // Taken now, so a batch never holds more than batchEvents however slow the sink is.
    const batch = pending;
    pending = [];
    flushing = flushing.then(async () => {
      if (batch.length > 0 && !gone) await send(batch);
    });
    return flushing.then(() => state);
  };

  const emit = (type: RunEventType, payload: RunEvent["payload"]): RunEvent | undefined => {
    if (finished) {
      sink.log(`dropped a ${type} event written after run_finished`);
      return undefined;
    }
    const event: RunEvent = { seq: seq++, ts: now().toISOString(), type, payload };
    events.push(event);
    pending.push(event);
    if (pending.length >= batchEvents) void flush();
    else timer ??= setTimeout(() => void flush(), batchMs);
    return event;
  };

  return {
    get state() {
      return state;
    },
    get events() {
      return events;
    },
    get nextSeq() {
      return seq;
    },

    start(payload = {}) {
      emit("run_started", { ...payload });
    },

    async step<T>(
      name: string,
      work: (step: PipelineStep) => Promise<T> | T,
      stepOptions: PipelineStepOptions<T> = {},
    ): Promise<T> {
      // The tool_start's seq, unique in the run's log however many attempts write to it.
      const id = `step-${seq}`;
      let resultText: string | undefined;
      let resultSet = false;
      emit("tool_start", {
        toolCallId: id,
        toolName: name,
        ...(stepOptions.args !== undefined ? { args: truncate(stepOptions.args) } : {}),
      });
      const end = (isError: boolean, text: string | undefined) =>
        emit("tool_end", {
          toolCallId: id,
          toolName: name,
          isError,
          ...(text !== undefined ? { result: truncate(text) } : {}),
        });
      let value: T;
      try {
        value = await work({
          id,
          setResult: (text) => {
            resultText = text;
            resultSet = true;
          },
        });
      } catch (error) {
        end(true, (stepOptions.errorResult ?? defaultErrorResult)(error));
        throw error;
      }
      end(false, resultSet ? resultText : stepOptions.result?.(value));
      return value;
    },

    text(delta) {
      if (delta) emit("text_delta", { delta });
    },

    notice(kind, message, extra = {}) {
      emit("notice", { ...extra, kind, ...(message !== undefined ? { message } : {}) });
    },

    async artifact(artifact) {
      const artifactId = "upload" in artifact ? await sink.artifact(artifact.upload) : artifact.artifactId;
      const path = artifact.path ?? ("upload" in artifact ? artifact.upload.fileName : "");
      const caption = artifact.caption ?? ("upload" in artifact ? artifact.upload.caption : "");
      const kind = artifact.kind ?? ("upload" in artifact ? artifact.upload.kind : undefined);
      emit("artifact", { artifactId, path, caption, ...(kind !== undefined ? { kind } : {}) });
      return artifactId;
    },

    usage(usage, extra = {}) {
      emit("turn_end", { usage: { ...usage, ...(usage.cost ? { cost: { ...usage.cost } } : {}) }, ...extra });
    },

    async finish(ending = {}) {
      emit("run_finished", {
        ...(ending.error !== undefined ? { error: ending.error } : {}),
        ...(ending.followUps ? { followUps: [...ending.followUps] } : {}),
      });
      finished = true;
      return await flush();
    },

    flush,
  };
}
