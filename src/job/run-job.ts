// One job execution works one run: hk-legal's Cloud Run Job started with a
// RESEARCH_RUN_ID, and HKJC's runs once they move to Cloud Run. The execution
// claims the run by id, beats while the app's work runs, finishes with the
// ending the work returns, and exits. The store owns every retry past the
// claim: a run the job loses or releases is given out again when its heartbeat
// lapses, and the app's dispatcher starts another execution for it.
//
// Nothing here knows about sandboxes or pi. HKJC's `work` calls executeRun
// with the claim as its sink; hk-legal's runs its attempt plan.

import {
  StoreUnreachableError,
  type ClaimedRun,
  type EndingOf,
  type RunEnding,
  type RunStore,
  type SettledOf,
} from "../core/run-store.ts";

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
export const RELEASE: unique symbol = Symbol.for("@eankhbayar/agent-runtime/job.release");
export type Release = typeof RELEASE;

/**
 * Why the work's signal was aborted: a beat said the run was cancelled, or
 * that it is gone (finished elsewhere, given to another worker, or no beat got
 * through for `maxQuietMs`), or the process is shutting down (Cloud Run sends
 * SIGTERM at the task timeout and on a cancelled execution, and SIGKILL ten
 * seconds later).
 */
export type StopReason = "cancelled" | "gone" | "shutdown";

// Distributive, so a callback's literal endings are checked against the
// claim's own Ending rather than widened while the claim type is inferred.

/** Works the claimed run and returns how it ended. Returns soon after `signal` aborts. */
export type Work<Claim> = Claim extends unknown
  ? (claim: Claim, signal: AbortSignal) => Promise<EndingOf<Claim> | Release>
  : never;

/** The ending for a run whose work threw. */
export type Failed<Claim> = Claim extends unknown
  ? (error: unknown, stopped: StopReason | undefined) => EndingOf<Claim> | Release
  : never;

export type JobOptions<Claim> = {
  runId: string;
  /** Sent with every claim attempt. Defaults to a fresh UUID. */
  idempotencyKey?: string;
  work: Work<Claim>;
  /** Stops the job from outside, as a shutdown signal does. */
  signal?: AbortSignal;
  /** Process signals that stop the job while it runs. Defaults to SIGTERM and SIGINT. */
  shutdownSignals?: readonly NodeJS.Signals[];
  /** Waits between claims that got no answer. Defaults to 1 s, 2 s and 4 s. */
  retryDelaysMs?: readonly number[];
  /**
   * Once the job is shutting down, how long a beat in flight is waited for
   * before the run is finished. Defaults to 1 s, well inside the ten seconds
   * Cloud Run gives before SIGKILL; otherwise the wait is up to one interval.
   */
  shutdownBeatWaitMs?: number;
  /**
   * Stops the work as `gone` once no beat has got through for this long, as a
   * store that fails or reclaims quiet runs will have done. Off by default.
   * Raised to twice the claim's `heartbeatMs` when it is less, so a run is
   * stopped only after a beat had a whole interval to answer and did not.
   */
  maxQuietMs?: number;
  /** Defaults to the claim's own log once there is a claim, and to nowhere before. */
  log?: (message: string) => void;
} & (RunEnding extends EndingOf<Claim>
  ? {
      /** Defaults to `cancelled` after a cancel, else `failed` with the error's message. */
      failed?: Failed<Claim>;
    }
  : {
      /** Required: there is no default for an ending of the app's own. */
      failed: Failed<Claim>;
    });

/**
 * How the execution went. Exit with `exitCode`: 0 when there was nothing to do
 * or the run was finished, 1 when the run was left to the store.
 */
export type JobResult<Claim> =
  /** The run was not there to take: gone, finished, or held under another key. */
  | { kind: "idle"; exitCode: 0 }
  /** Told to stop before the run was claimed, so it was not. */
  | { kind: "stopped"; exitCode: 1 }
  /** The store refused the claim, or never answered. */
  | { kind: "unclaimed"; error: unknown; exitCode: 1 }
  /** The store answered the finish with `settled`. `error` is what the work threw, if it did. */
  | {
      kind: "finished";
      ending: EndingOf<Claim>;
      settled: SettledOf<Claim>;
      stopped?: StopReason;
      error?: unknown;
      exitCode: 0;
    }
  /** The work or `failed` returned RELEASE; the store takes the run back when its heartbeat lapses. */
  | { kind: "released"; stopped?: StopReason; error?: unknown; exitCode: 1 }
  /** The run was claimed but not finished; the store will reap it when its heartbeat lapses. */
  | {
      kind: "unfinished";
      ending?: EndingOf<Claim>;
      stopped?: StopReason;
      error: unknown;
      exitCode: 1;
    };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `failed`'s default for a RunEnding. */
export function defaultFailed(error: unknown, stopped: StopReason | undefined): RunEnding {
  return stopped === "cancelled"
    ? { status: "cancelled" }
    : { status: "failed", error: message(error) };
}

function whenAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
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
export async function runJob<Claim extends ClaimedRun<unknown, never, unknown>>(
  store: RunStore<Claim>,
  options: JobOptions<Claim>,
): Promise<JobResult<Claim>> {
  // The claim's own types, which a body generic over Claim cannot see.
  const work = options.work as (
    claim: Claim,
    signal: AbortSignal,
  ) => Promise<EndingOf<Claim> | Release>;
  const failed = (options.failed ?? defaultFailed) as (
    error: unknown,
    stopped: StopReason | undefined,
  ) => EndingOf<Claim> | Release;
  // Called on the claim, for an adapter whose finish is a method.
  const finish = (claim: Claim, ending: EndingOf<Claim>) =>
    (claim.finish as (ending: EndingOf<Claim>) => Promise<SettledOf<Claim>>).call(claim, ending);

  const stop = new AbortController();
  let stopped: StopReason | undefined;
  const halt = (reason: StopReason) => {
    if (stop.signal.aborted) return;
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
  for (const name of signals) process.once(name, shutdown);
  options.signal?.addEventListener("abort", shutdown, { once: true });
  if (options.signal?.aborted) shutdown();

  let log = options.log ?? (() => {});
  let beat: ReturnType<typeof setInterval> | undefined;
  try {
    const key = options.idempotencyKey ?? crypto.randomUUID();
    const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
    let claim: Claim | null;
    for (let retry = 0; ; retry++) {
      if (stop.signal.aborted) return { kind: "stopped", exitCode: 1 };
      try {
        claim = await store.claim({ runId: options.runId, idempotencyKey: key });
        break;
      } catch (error) {
        if (!(error instanceof StoreUnreachableError) || retry >= delays.length) {
          return { kind: "unclaimed", error, exitCode: 1 };
        }
        if (stop.signal.aborted) return { kind: "stopped", exitCode: 1 };
        log(`claim got no answer, retrying in ${delays[retry]} ms: ${message(error)}`);
        await wait(delays[retry]!, stop.signal);
      }
    }
    if (!claim) return { kind: "idle", exitCode: 0 };
    const held = claim;
    log = options.log ?? ((m) => held.log(m));

    // A failed beat is only logged: the store decides when a quiet run is
    // lost, and the next beat that gets through says so. One beat at a time,
    // and the last is awaited, for up to an interval (or shutdownBeatWaitMs
    // once shutting down), before the run is finished or released, so a late
    // beat does not race the store's ending.
    let inFlight: Promise<void> | undefined;
    let lastBeat = Date.now();
    // Quiet time counts from the claim and the first beat goes out an interval
    // in, so a limit of one interval or less would stop a healthy run.
    const maxQuietMs =
      options.maxQuietMs === undefined
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
      if (inFlight) return;
      inFlight = held
        .heartbeat()
        .then(
          (state) => {
            lastBeat = Date.now();
            if (state.cancelled) halt("cancelled");
            else if (state.gone) halt("gone");
          },
          (error: unknown) => log(`heartbeat failed: ${message(error)}`),
        )
        .finally(() => {
          inFlight = undefined;
        });
    }, held.heartbeatMs);

    let ending: EndingOf<Claim> | Release | undefined;
    let threw: { error: unknown } | undefined;
    let unmapped: { error: unknown } | undefined;
    try {
      ending = await work(held, stop.signal);
    } catch (error) {
      threw = { error };
      log(`work failed: ${message(error)}`);
      try {
        ending = failed(error, stopped);
      } catch (mapping) {
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
      whenAborted(AbortSignal.any([shuttingDown.signal, settle.signal])).then(() =>
        wait(shutdownWait, settle.signal),
      ),
    ]);
    settle.abort();

    if (unmapped) return { kind: "unfinished", stopped: workStopped, ...unmapped, exitCode: 1 };
    if (ending === RELEASE) {
      log("released the run to the store");
      return { kind: "released", stopped: workStopped, ...threw, exitCode: 1 };
    }
    const kept = ending as EndingOf<Claim>;
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
    } catch (error) {
      log(`finish failed: ${message(error)}`);
      return { kind: "unfinished", ending: kept, stopped: workStopped, error, exitCode: 1 };
    }
  } finally {
    clearInterval(beat);
    for (const name of signals) process.removeListener(name, shutdown);
    options.signal?.removeEventListener("abort", shutdown);
  }
}
