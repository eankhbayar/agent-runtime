// One job execution works one run: hk-legal's Cloud Run Job started with a
// RESEARCH_RUN_ID, and HKJC's runs once they move to Cloud Run. The execution
// claims the run by id, beats while the app's work runs, finishes with the
// ending the work returns, and exits. The store owns every retry past the
// claim: a run the job loses or releases is given out again when its heartbeat
// lapses, and the app's dispatcher starts another execution for it.
//
// Nothing here knows about sandboxes or pi. HKJC's `work` calls executeRun
// with the claim as its sink; hk-legal's runs its attempt plan.
import { StoreUnreachableError, } from "../core/run-store.js";
/** As hk-legal waits: about seven seconds of retries before the execution gives up. */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
/** Leaves most of Cloud Run's ten seconds between SIGTERM and SIGKILL to the finish. */
const SHUTDOWN_BEAT_WAIT_MS = 1_000;
/**
 * Returned by `work` or `failed` instead of an ending: leave the run unfinished
 * and stop beating, so the store takes it back when its heartbeat lapses and
 * gives it out again. A run stopped by a shutdown usually wants this, since
 * the store then retries it as it would a crashed worker's; finishing it
 * would end it for good unless the ending is one the store retries.
 */
export const RELEASE = Symbol.for("@eankhbayar/agent-runtime/job.release");
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
/** `failed`'s default for a RunEnding. */
export function defaultFailed(error, stopped) {
    return stopped === "cancelled"
        ? { status: "cancelled" }
        : { status: "failed", error: message(error) };
}
function whenAborted(signal) {
    return new Promise((resolve) => {
        if (signal.aborted)
            return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
    });
}
function wait(ms, signal) {
    return new Promise((resolve) => {
        if (signal.aborted)
            return resolve();
        const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener("abort", done, { once: true });
    });
}
/**
 * Claims `runId`, works it and finishes it. Nothing is claimed once the job
 * has been told to stop. Only a claim that got no answer is retried, with the
 * same key, so one that landed comes back. Once claimed, the run is finished
 * with what the work returns, or what `failed` returns if it throws, unless
 * that is RELEASE; the signal the work gets may already be aborted.
 *
 * A claim's heartbeat should answer `gone` when the store refuses it (the
 * claim was lost: an expired or taken lease), not reject: a rejection reads
 * as the store being unreachable, and the work goes on.
 */
export async function runJob(store, options) {
    // The claim's own types, which a body generic over Claim cannot see.
    const work = options.work;
    const failed = (options.failed ?? defaultFailed);
    // Called on the claim, for an adapter whose finish is a method.
    const finish = (claim, ending) => claim.finish.call(claim, ending);
    const stop = new AbortController();
    let stopped;
    const halt = (reason) => {
        if (stop.signal.aborted)
            return;
        stopped = reason;
        stop.abort(reason);
    };
    // Kept apart from `stopped`, which holds only the first reason, so a
    // shutdown after a cancel still shortens the wait for a beat in flight.
    const shuttingDown = new AbortController();
    const shutdown = () => {
        shuttingDown.abort();
        halt("shutdown");
    };
    const signals = options.shutdownSignals ?? ["SIGTERM", "SIGINT"];
    // `once`, so a second Ctrl-C while the run is finishing kills the process.
    for (const name of signals)
        process.once(name, shutdown);
    options.signal?.addEventListener("abort", shutdown, { once: true });
    if (options.signal?.aborted)
        shutdown();
    let log = options.log ?? (() => { });
    let beat;
    try {
        const key = options.idempotencyKey ?? crypto.randomUUID();
        const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
        let claim;
        for (let retry = 0;; retry++) {
            if (stop.signal.aborted)
                return { kind: "stopped", exitCode: 1 };
            try {
                claim = await store.claim({ runId: options.runId, idempotencyKey: key });
                break;
            }
            catch (error) {
                if (!(error instanceof StoreUnreachableError) || retry >= delays.length) {
                    return { kind: "unclaimed", error, exitCode: 1 };
                }
                if (stop.signal.aborted)
                    return { kind: "stopped", exitCode: 1 };
                log(`claim got no answer, retrying in ${delays[retry]} ms: ${message(error)}`);
                await wait(delays[retry], stop.signal);
            }
        }
        if (!claim)
            return { kind: "idle", exitCode: 0 };
        const held = claim;
        log = options.log ?? ((m) => held.log(m));
        // A failed beat is only logged: the store decides when a quiet run is
        // lost, and the next beat that gets through says so. One beat at a time,
        // and the last is awaited, for up to an interval (or shutdownBeatWaitMs
        // once shutting down), before the run is finished or released, so a late
        // beat does not race the store's ending.
        let inFlight;
        let lastBeat = Date.now();
        // Quiet time counts from the claim and the first beat goes out an interval
        // in, so a limit of one interval or less would stop a healthy run.
        const maxQuietMs = options.maxQuietMs === undefined
            ? undefined
            : Math.max(options.maxQuietMs, 2 * held.heartbeatMs);
        if (maxQuietMs !== undefined && maxQuietMs !== options.maxQuietMs) {
            log(`maxQuietMs ${options.maxQuietMs} is under two beats; using ${maxQuietMs} ms`);
        }
        beat = setInterval(() => {
            const quiet = Date.now() - lastBeat;
            if (maxQuietMs !== undefined && quiet >= maxQuietMs && !stop.signal.aborted) {
                log(`no beat got through for ${maxQuietMs} ms`);
                halt("gone");
            }
            if (inFlight)
                return;
            inFlight = held
                .heartbeat()
                .then((state) => {
                lastBeat = Date.now();
                if (state.cancelled)
                    halt("cancelled");
                else if (state.gone)
                    halt("gone");
            }, (error) => log(`heartbeat failed: ${message(error)}`))
                .finally(() => {
                inFlight = undefined;
            });
        }, held.heartbeatMs);
        let ending;
        let threw;
        let unmapped;
        try {
            ending = await work(held, stop.signal);
        }
        catch (error) {
            threw = { error };
            log(`work failed: ${message(error)}`);
            try {
                ending = failed(error, stopped);
            }
            catch (mapping) {
                unmapped = { error: mapping };
            }
        }
        // What stopped the work, not a beat that lands after it.
        const workStopped = stopped;
        clearInterval(beat);
        // Bounded, so a beat that never answers cannot keep the run from ending,
        // and more tightly after a shutdown, even one that comes while waiting,
        // so the finish goes out before SIGKILL.
        const settle = new AbortController();
        const shutdownWait = options.shutdownBeatWaitMs ?? SHUTDOWN_BEAT_WAIT_MS;
        await Promise.race([
            inFlight,
            wait(held.heartbeatMs, settle.signal),
            whenAborted(AbortSignal.any([shuttingDown.signal, settle.signal])).then(() => wait(shutdownWait, settle.signal)),
        ]);
        settle.abort();
        if (unmapped)
            return { kind: "unfinished", stopped: workStopped, ...unmapped, exitCode: 1 };
        if (ending === RELEASE) {
            log("released the run to the store");
            return { kind: "released", stopped: workStopped, ...threw, exitCode: 1 };
        }
        const kept = ending;
        try {
            const settled = await finish(held, kept);
            return {
                kind: "finished",
                ending: kept,
                settled,
                stopped: workStopped,
                ...threw,
                exitCode: 0,
            };
        }
        catch (error) {
            log(`finish failed: ${message(error)}`);
            return { kind: "unfinished", ending: kept, stopped: workStopped, error, exitCode: 1 };
        }
    }
    finally {
        clearInterval(beat);
        for (const name of signals)
            process.removeListener(name, shutdown);
        options.signal?.removeEventListener("abort", shutdown);
    }
}
