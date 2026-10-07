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
/**
 * The store gave no answer, so the request may or may not have landed. The
 * only rejection a claim is retried after, and then with the same key.
 */
export class StoreUnreachableError extends Error {
    constructor(message = "The store could not be reached.", options) {
        super(message, options);
        this.name = "StoreUnreachableError";
    }
}
