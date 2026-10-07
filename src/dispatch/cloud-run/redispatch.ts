// When to start a job for a claimable run, and when to start another. The app
// keeps one record per queue event (hk-legal keys it by run and queuedAt), so a
// run that is queued again starts with a fresh allowance. The store stays the
// authority: an execution that finds its run already claimed claims nothing.
//
// The app reads the record and writes what planDispatch returns in the same
// transaction, so a cron and a queue-time trigger that overlap cannot both
// start an execution for the same event.

/** A job that has not claimed its run by then is treated as lost and started again. */
export const REDISPATCH_AFTER_MS = 3 * 60_000;
export const MAX_DISPATCH_ATTEMPTS = 3;

/** What the app stores per queue event. */
export type DispatchAttempts = {
  /** Executions started, or being started, for this queue event. */
  attempts: number;
  lastDispatchedAt: number;
};

export type RedispatchPolicy = {
  redispatchAfterMs?: number;
  maxAttempts?: number;
};

/**
 * The record to write if an execution should start now, or null if not. A
 * first dispatch always starts; another starts once the last is
 * `redispatchAfterMs` old, until `maxAttempts` have started.
 */
export function planDispatch(
  existing: DispatchAttempts | null,
  now: number,
  policy: RedispatchPolicy = {},
): DispatchAttempts | null {
  if (!existing) return { attempts: 1, lastDispatchedAt: now };
  const due = now - existing.lastDispatchedAt >= (policy.redispatchAfterMs ?? REDISPATCH_AFTER_MS);
  if (!due || existing.attempts >= (policy.maxAttempts ?? MAX_DISPATCH_ATTEMPTS)) return null;
  return { attempts: existing.attempts + 1, lastDispatchedAt: now };
}

/**
 * The record to write when no execution started. The attempt is given back, so
 * a configuration mistake or a Google outage cannot use up a run's allowance;
 * `lastDispatchedAt` stays, so it is tried again after the usual interval.
 */
export function returnAttempt(record: DispatchAttempts): DispatchAttempts {
  return { ...record, attempts: Math.max(0, record.attempts - 1) };
}
