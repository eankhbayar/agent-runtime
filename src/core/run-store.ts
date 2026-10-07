// The store side of one run's life, whatever runs it: a dispatcher that picked
// the run off a queue, or a job started for that run alone. The worker claims
// the run by id, beats while it works, writes events, samples and artifacts
// through the claim as an EventSink, and finishes it. executeRun takes the
// claim as its sink and needs nothing more of it.
//
// What each app puts behind it:
//
// HKJC (apps/web/convex/dispatch.ts). `claim` is `dispatch.claim`; the
// dispatcher name, limits and model are the adapter's. The payload is what
// `queued` lists for the run: thread, snapshot, prompt and the thread's
// sandbox. `heartbeat` is `dispatch.heartbeat`, and `events`, `samples` and
// `artifact` are `appendEvents`, `putSamples` and `artifactUploadUrl` with
// `registerArtifact`, as convex-sink.ts does now. `finish` is `dispatch.finish`
// with the default RunEnding; a RunOutcome is one. `claim` takes no key and
// answers only true or false today, so a job started with nothing but a run id
// needs it to record the key and return the run.
//
// hk-legal (protocol 5, research-worker-contracts). `claim` is the `claim`
// operation with `runId` set, as JobWorkerLoop sends it; the worker id, lease
// length, checkpoint schema versions, model routes and corpus readiness are the
// adapter's. The payload is the claim result: run, attempt and checkpoint. The
// adapter keeps the lease token and expected revision to itself and derives
// `heartbeatMs` from `leaseExpiresAt`. `heartbeat` is `renew_lease`:
// `cancellationRequested` reads as cancelled, a rejected lease as gone. The
// Ending is the worker's AttemptPlan, which `finish` sends as `checkpoint`,
// `pause_for_review`, `complete`, `fail`, `abandon` or `suspend_for_corpus`.
// Protocol 5 has no event log, so until it does `events` answers with the last
// beat's state and `samples` and `artifact` store nothing. The other leased
// operations (model invocations, prompt-injection findings) are methods the
// adapter adds to its claim, as HKJC's sink adds citedRows and capture.

import type { FinalRunStatus, RunUsage } from "../contract/events.ts";

import type { EventSink, SinkState } from "./run.ts";

/** How a run that answers a prompt ends, as executeRun's outcome reports it. */
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

/** A run this worker holds. It is the run's EventSink, so executeRun writes to it. */
export type ClaimedRun<Payload, Ending = RunEnding> = EventSink & {
  runId: string;
  /** What the store handed over with the run: the prompt and whatever else the app needs. */
  payload: Payload;
  /** How often to beat so the store does not give the run to someone else. */
  heartbeatMs: number;
  /** Keeps the claim and says whether the run is still wanted. */
  heartbeat: () => Promise<SinkState>;
  /**
   * Ends the claim. False when the store kept an ending it already had: the
   * run had finished, or the claim was lost.
   */
  finish: (ending: Ending) => Promise<boolean>;
};

export interface RunStore<Payload, Ending = RunEnding> {
  /**
   * Takes one run. Null when it is not there to take: gone, finished, or held
   * under another key. Rejects when the store could not be reached or refused
   * the request; retrying with the same key is safe either way.
   */
  claim(request: ClaimRequest): Promise<ClaimedRun<Payload, Ending> | null>;
}
