import { describe, expect, it } from "vitest";

import {
  MAX_DISPATCH_ATTEMPTS,
  planDispatch,
  REDISPATCH_AFTER_MS,
  returnAttempt,
  type DispatchAttempts,
} from "./redispatch.ts";

const NOW = 1_790_000_000_000;

describe("planDispatch", () => {
  it("starts a queue event's first execution at once", () => {
    expect(planDispatch(null, NOW)).toEqual({ attempts: 1, lastDispatchedAt: NOW });
  });

  it("dispatches once per queue event, redispatches a lost execution, and stops at the cap", () => {
    let record = planDispatch(null, NOW)!;
    expect(planDispatch(record, NOW + 1_000)).toBeNull();
    let now = NOW;
    for (let attempt = 2; attempt <= MAX_DISPATCH_ATTEMPTS; attempt++) {
      now += REDISPATCH_AFTER_MS;
      record = planDispatch(record, now)!;
      expect(record).toEqual({ attempts: attempt, lastDispatchedAt: now });
    }
    expect(planDispatch(record, now + REDISPATCH_AFTER_MS)).toBeNull();
  });

  it("takes its interval and cap from the policy", () => {
    const policy = { redispatchAfterMs: 10_000, maxAttempts: 2 };
    const first = planDispatch(null, NOW, policy)!;
    expect(planDispatch(first, NOW + 9_999, policy)).toBeNull();
    const second = planDispatch(first, NOW + 10_000, policy)!;
    expect(second.attempts).toBe(2);
    expect(planDispatch(second, NOW + 60_000, policy)).toBeNull();
  });
});

describe("returnAttempt", () => {
  it("gives the attempt back, so failed starts never use up the allowance", () => {
    let record: DispatchAttempts | null = null;
    let now = NOW;
    for (let failure = 0; failure < MAX_DISPATCH_ATTEMPTS + 2; failure++) {
      const planned = planDispatch(record, now);
      expect(planned).not.toBeNull();
      record = returnAttempt(planned!);
      // Not before the usual interval, though.
      expect(planDispatch(record, now + 1_000)).toBeNull();
      now += REDISPATCH_AFTER_MS;
    }
  });

  it("never goes below zero", () => {
    expect(returnAttempt({ attempts: 0, lastDispatchedAt: NOW })).toEqual({
      attempts: 0,
      lastDispatchedAt: NOW,
    });
  });
});
