// The run trace for a pipeline: a trusted worker that runs its own steps
// rather than an agent in a sandbox (hk-legal's Research Worker under runJob)
// writes the same RunEvent stream the pi runner does, so an app renders both
// with foldRunEvents. A step is a tool call in the trace (tool_start and
// tool_end), a model call's usage is a turn_end, and the rest are the
// contract's own events. Events go to an EventSink, usually the run's claim,
// batched and in seq order as executeRun sends them.
import { truncate } from "../contract/events.js";
import { LIVE } from "./run.js";
const SAFE_CODE = /^[a-z][a-z0-9_.:-]{0,79}$/;
function defaultErrorResult(error) {
    const fields = (error ?? {});
    for (const value of [fields.safeCode, fields.code]) {
        if (typeof value === "string" && SAFE_CODE.test(value))
            return value;
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
export function createPipelineEvents(sink, options = {}) {
    const batchMs = options.batchMs ?? 150;
    const batchEvents = options.batchEvents ?? 25;
    const retries = options.retries ?? 4;
    const retryMs = options.retryMs ?? 250;
    const now = options.now ?? (() => new Date());
    let seq = options.firstSeq ?? 0;
    let state = LIVE;
    let gone = false;
    let finished = false;
    const events = [];
    let pending = [];
    let flushing = Promise.resolve();
    let timer;
    const send = async (batch) => {
        for (let attempt = 0;; attempt++) {
            try {
                const answer = await sink.events(batch);
                state = { cancelled: state.cancelled || answer.cancelled, gone: state.gone || answer.gone };
                if (answer.gone)
                    gone = true;
                return;
            }
            catch (cause) {
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
    const flush = () => {
        clearTimeout(timer);
        timer = undefined;
        // Taken now, so a batch never holds more than batchEvents however slow the sink is.
        const batch = pending;
        pending = [];
        flushing = flushing.then(async () => {
            if (batch.length === 0)
                return;
            if (gone)
                sink.log(`dropped ${batch.length} pipeline event(s): the run is gone`);
            else
                await send(batch);
        });
        return flushing.then(() => state);
    };
    const emit = (type, payload) => {
        if (finished) {
            sink.log(`dropped a ${type} event written after run_finished`);
            return undefined;
        }
        const event = { seq: seq++, ts: now().toISOString(), type, payload };
        events.push(event);
        pending.push(event);
        if (pending.length >= batchEvents)
            void flush();
        else
            timer ??= setTimeout(() => void flush(), batchMs);
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
        async step(name, work, stepOptions = {}) {
            // The tool_start's seq, unique in the run's log however many attempts write to it.
            const id = `step-${seq}`;
            let resultText;
            let resultSet = false;
            emit("tool_start", {
                toolCallId: id,
                toolName: name,
                ...(stepOptions.args !== undefined ? { args: truncate(stepOptions.args) } : {}),
            });
            const end = (isError, text) => emit("tool_end", {
                toolCallId: id,
                toolName: name,
                isError,
                ...(text !== undefined ? { result: truncate(text) } : {}),
            });
            let value;
            try {
                value = await work({
                    id,
                    setResult: (text) => {
                        resultText = text;
                        resultSet = true;
                    },
                });
            }
            catch (error) {
                end(true, (stepOptions.errorResult ?? defaultErrorResult)(error));
                throw error;
            }
            end(false, resultSet ? resultText : stepOptions.result?.(value));
            return value;
        },
        text(delta) {
            if (delta)
                emit("text_delta", { delta });
        },
        notice(kind, message, extra = {}) {
            emit("notice", { ...extra, kind, ...(message !== undefined ? { message } : {}) });
        },
        async artifact(artifact) {
            let artifactId = null;
            if (!("upload" in artifact))
                artifactId = artifact.artifactId;
            else {
                try {
                    artifactId = await sink.artifact(artifact.upload);
                }
                catch (cause) {
                    // As executeRun does: the event still lands, with no stored file behind it.
                    sink.log(`could not store ${artifact.upload.fileName}: ${String(cause)}`);
                }
            }
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
