// The store side of one run's life, whatever runs it: a dispatcher that picked
// the run off a queue, or a job started for that run alone. The worker claims
// the run by id, beats while it works, writes events, samples and artifacts
// through the claim as an EventSink, and finishes it. executeRun takes the
// claim as its sink but never beats or finishes; its caller does both.
//
// A store is typed by its claim, so a harness hands the app the adapter's own
// claim, extra methods and all, without a cast.
//
// What each app puts behind it:
//
// HKJC (apps/web/convex/dispatch.ts). `claim` is `dispatch.claim`; the
// dispatcher name, limits and model are the adapter's. The payload is what
// `queued` lists for the run: thread, snapshot, prompt and the thread's
// sandbox. `heartbeat` is `dispatch.heartbeat`, and `events`, `samples` and
// `artifact` are `appendEvents`, `putSamples` and `artifactUploadUrl` with
// `registerArtifact`, as convex-sink.ts does now. `finish` is `dispatch.finish`
// with the default RunEnding, settling to its boolean. `citedRows` and
// `capture` are methods on the adapter's claim. `claim` takes no key and
// answers only true or false today, so a job started with nothing but a run id
// needs it to record the key and return the run.
//
// hk-legal (protocol 5, research-worker-contracts). `claim` is the `claim`
// operation with `runId` set, which DurableResearchWorker.runOnce sends for the
// run JobWorkerLoop was started with; the worker id, lease length, checkpoint
// schema versions, model routes and corpus readiness are the adapter's. A
// claim with no answer is StoreUnreachableError, as WorkerClaimTransportError
// is now; a ResearchWorkerOperationError is a refusal and is thrown as it is.
// The payload is the claim result: run, attempt and checkpoint. The adapter
// keeps the lease token and expected revision to itself and derives
// `heartbeatMs` from `leaseExpiresAt`. `heartbeat` is `renew_lease`:
// `cancellationRequested` reads as cancelled, a rejected lease as gone.
// The Ending is wider than the worker's AttemptPlan. Besides the plan's
// checkpoint and terminal (`checkpoint`, `pause_for_review`, `complete`,
// `fail`, `abandon`), the worker decides some endings itself: `suspend_for_corpus`
// when the pinned corpus release is not ready, `abandon` with cancelled_by_user
// once it sees a cancel, and `fail` with worker_plan_invalid or
// worker_attempt_unhandled. `finish` settles to the run's status after the
// call (queued, review_paused, completed, blocked, failed, cancelled,
// suspended), which covers a checkpoint the store rejected. Protocol 5 has no
// event log, so until it does `events` answers with the last beat's state and
// `samples` and `artifact` store nothing. The model-invocation and
// prompt-injection operations are methods on the adapter's claim.

import type { FinalRunStatus, RunUsage } from "../contract/events.ts";

import type { EventSink, SinkState } from "./run.ts";

/**
 * How a run that answers a prompt ends. Pass these fields and no others: an
 * adapter may forward the ending as it is, and a store that validates its
 * arguments rejects the rest of a RunOutcome, such as its events.
 */
export type RunEnding = {
  status: FinalRunStatus;
  error?: string;
  answerText?: string;
  usage?: RunUsage;
};

export type ClaimRequest = {
  runId: string;
  /**
   * Sent again unchanged when a claim is retried, so a claim that landed but
   * whose answer was lost comes back instead of being refused.
   */
  idempotencyKey: string;
};

/**
 * The store gave no answer, so the request may or may not have landed. The
 * only rejection a claim is retried after, and then with the same key.
 */
export class StoreUnreachableError extends Error {
  constructor(message = "The store could not be reached.", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StoreUnreachableError";
  }
}

/** A run this worker holds. It is the run's EventSink, so executeRun writes to it. */
export type ClaimedRun<Payload, Ending = RunEnding, Settled = boolean> = EventSink & {
  runId: string;
  /** What the store handed over with the run: the prompt and whatever else the app needs. */
  payload: Payload;
  /** How often to beat so the store does not give the run to someone else. */
  heartbeatMs: number;
  /**
   * Keeps the claim and says whether the run is still wanted. A store that
   * refuses the beat because the claim is lost (hk-legal's rejected
   * renew_lease) answers `gone`, so the work stops; reject only when no answer
   * came back, which a harness tolerates.
   */
  heartbeat: () => Promise<SinkState>;
  /**
   * Ends the claim and answers with what the store settled on. By default a
   * boolean: false when the store kept an ending it already had, because the
   * run had finished or the claim was lost.
   */
  finish: (ending: Ending) => Promise<Settled>;
};

// Inside a function generic over a claim, `claim.finish` takes `never`, since
// the constraint is ClaimedRun<unknown, never, unknown>. These name the claim's
// own types, so a harness can say what its callbacks take and return.

/** What `Claim` carries as its payload. */
export type PayloadOf<Claim> = Claim extends { payload: infer Payload } ? Payload : never;
/** What `Claim`'s `finish` takes. */
export type EndingOf<Claim> = Claim extends { finish: (ending: infer Ending) => unknown }
  ? Ending
  : never;
/** What `Claim`'s `finish` answers with. */
export type SettledOf<Claim> = Claim extends { finish: (ending: never) => Promise<infer Settled> }
  ? Settled
  : never;

export interface RunStore<Claim extends ClaimedRun<unknown, never, unknown> = ClaimedRun<unknown>> {
  /**
   * Takes one run. Null when it is not there to take: gone, finished, or held
   * under another key. Rejects with StoreUnreachableError when no answer came
   * back; retry that, with the same key. Any other rejection is the store
   * refusing the request (unauthorized, an unsupported version, a run this
   * worker cannot take), and a retry would be refused again.
   */
  claim(request: ClaimRequest): Promise<Claim | null>;
}
