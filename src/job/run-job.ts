// One job execution works one run: hk-legal's Cloud Run Job started with a
// RESEARCH_RUN_ID, and HKJC's runs once they move to Cloud Run. The execution
// claims the run by id, beats while the app's work runs, finishes with the
// ending the work returns, and exits. The store owns every retry past the
// claim: a run the job loses is given out again when its heartbeat lapses, and
// the app's dispatcher starts another execution for it.
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

/**
 * Why the work's signal was aborted: a beat said the run was cancelled, or
 * that it is gone (finished elsewhere, or given to another worker), or the
 * process is shutting down (Cloud Run sends SIGTERM at the task timeout and on
 * a cancelled execution, and SIGKILL ten seconds later).
 */
export type StopReason = "cancelled" | "gone" | "shutdown";

// Distributive, so a callback's literal endings are checked against the
// claim's own Ending rather than widened while the claim type is inferred.

/** Works the claimed run and returns how it ended. Returns soon after `signal` aborts. */
export type Work<Claim> = Claim extends unknown
  ? (claim: Claim, signal: AbortSignal) => Promise<EndingOf<Claim>>
  : never;

/** The ending for a run whose work threw. */
export type Failed<Claim> = Claim extends unknown
  ? (error: unknown, stopped: StopReason | undefined) => EndingOf<Claim>
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

/** How the execution went. Exit with `exitCode`. */
export type JobResult<Claim> =
  /** The run was not there to take: gone, finished, or held under another key. */
  | { kind: "idle"; exitCode: 0 }
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
 * Claims `runId`, works it and finishes it. Only a claim that got no answer is
 * retried, with the same key, so one that landed comes back. Once claimed the
 * run is always finished, with the ending from `failed` when the work throws,
 * including after a shutdown; the signal the work gets may already be aborted.
 */
export async function runJob<Claim extends ClaimedRun<unknown, never, unknown>>(
  store: RunStore<Claim>,
  options: JobOptions<Claim>,
): Promise<JobResult<Claim>> {
  // The claim's own types, which a body generic over Claim cannot see.
  const work = options.work as (claim: Claim, signal: AbortSignal) => Promise<EndingOf<Claim>>;
  const failed = (options.failed ?? defaultFailed) as (
    error: unknown,
    stopped: StopReason | undefined,
  ) => EndingOf<Claim>;
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
  const shutdown = () => halt("shutdown");
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
      try {
        claim = await store.claim({ runId: options.runId, idempotencyKey: key });
        break;
      } catch (error) {
        if (
          !(error instanceof StoreUnreachableError) ||
          retry >= delays.length ||
          stop.signal.aborted
        ) {
          return { kind: "unclaimed", error, exitCode: 1 };
        }
        log(`claim got no answer, retrying in ${delays[retry]} ms: ${message(error)}`);
        await wait(delays[retry]!, stop.signal);
        if (stop.signal.aborted) return { kind: "unclaimed", error, exitCode: 1 };
      }
    }
    if (!claim) return { kind: "idle", exitCode: 0 };
    const held = claim;
    log = options.log ?? ((m) => held.log(m));

    // A failed beat is only logged: the store decides when a quiet run is
    // lost, and the next beat that gets through says so.
    let beating = false;
    beat = setInterval(() => {
      if (beating) return;
      beating = true;
      void held
        .heartbeat()
        .then(
          (state) => {
            if (state.cancelled) halt("cancelled");
            else if (state.gone) halt("gone");
          },
          (error: unknown) => log(`heartbeat failed: ${message(error)}`),
        )
        .finally(() => {
          beating = false;
        });
    }, held.heartbeatMs);

    let ending: EndingOf<Claim>;
    let threw: { error: unknown } | undefined;
    try {
      ending = await work(held, stop.signal);
    } catch (error) {
      threw = { error };
      log(`work failed: ${message(error)}`);
      try {
        ending = failed(error, stopped);
      } catch (mapping) {
        return { kind: "unfinished", stopped, error: mapping, exitCode: 1 };
      }
    }
    clearInterval(beat);

    try {
      const settled = await finish(held, ending);
      return { kind: "finished", ending, settled, stopped, ...threw, exitCode: 0 };
    } catch (error) {
      log(`finish failed: ${message(error)}`);
      return { kind: "unfinished", ending, stopped, error, exitCode: 1 };
    }
  } finally {
    clearInterval(beat);
    for (const name of signals) process.removeListener(name, shutdown);
    options.signal?.removeEventListener("abort", shutdown);
  }
}
