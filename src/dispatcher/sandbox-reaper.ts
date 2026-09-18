// Bounds the sandboxes the dispatcher keeps. A run pauses its sandbox so the
// thread's next question resumes the same agent session; this destroys the ones
// no question will come back to, stops the ones a dead dispatcher left running,
// and corrects rows whose sandbox is gone.
//
// It walks the provider's sandboxes, not only the deployment's `sandboxes` rows.
// A thread has one row, replaced whenever the thread moves to a new sandbox, so
// the sandbox it left has no row at all and only the provider still knows it.

import type { SandboxInfo, SandboxProvider } from "./sandbox-provider.ts";

/** A thread's sandbox as the caller's store records it. */
export type SandboxRow = {
  sandboxId: string;
  provider: string;
  /** The host the sandbox was made on; null on rows written before hosts were recorded. */
  host: string | null;
  status: "running" | "paused" | "stopped" | "missing";
  lastUsedAt: number;
  /** A run on the thread is running, so its sandbox is in use wherever that run is. */
  runLive: boolean;
};

export type ReapReason = "expired" | "orphaned";

export type ReapDecision = { sandboxId: string; reason: ReapReason };

export type ReapPlan = {
  /** Sandboxes to destroy, containers and networks both. */
  destroy: ReapDecision[];
  /**
   * Sandboxes still running although no run is: a dispatcher died mid-run and its
   * runner may still be calling the model. Stopped and paused, not destroyed, so
   * the thread keeps its session.
   */
  stop: string[];
  /** Rows pointing at a sandbox this host no longer has. */
  gone: string[];
};

/** How long a thread's sandbox is kept after its last run. */
export const SANDBOX_TTL_MS = 24 * 60 * 60_000;

/**
 * How old a sandbox with no row must be before it counts as orphaned. A run
 * writes its row once its mounts are uploaded; this covers that gap for runs
 * on another dispatcher sharing the same Docker host, which `inUse` cannot see.
 */
export const ORPHAN_GRACE_MS = 10 * 60_000;

export type ReapOptions = {
  now: number;
  /** The provider's `hostId`. Rows from other hosts are never judged gone. */
  host: string;
  ttlMs?: number;
  orphanGraceMs?: number;
  /** The provider name rows carry for sandboxes this provider made. */
  providerName?: string;
};

/** What to do with each sandbox and row. Pure, so the rules can be tested alone. */
export function planReap(
  sandboxes: readonly SandboxInfo[],
  rows: readonly SandboxRow[],
  inUse: ReadonlySet<string>,
  opts: ReapOptions,
): ReapPlan {
  const ttlMs = opts.ttlMs ?? SANDBOX_TTL_MS;
  const graceMs = opts.orphanGraceMs ?? ORPHAN_GRACE_MS;
  const providerName = opts.providerName ?? "docker";
  const ours = rows.filter((row) => row.provider === providerName && row.status !== "missing");
  const rowFor = new Map(ours.map((row) => [row.sandboxId, row]));
  const plan: ReapPlan = { destroy: [], stop: [], gone: [] };

  for (const sandbox of sandboxes) {
    if (inUse.has(sandbox.sandboxId)) continue;
    // Leftovers of a sandbox whose container is gone cannot be resumed either,
    // whatever its row still says.
    const row = sandbox.status === "missing" ? undefined : rowFor.get(sandbox.sandboxId);
    if (row) {
      // A run elsewhere may be using it; nothing here can tell otherwise.
      if (row.runLive) continue;
      // A thread's sandbox, kept for its next question until the TTL runs out.
      if (opts.now - row.lastUsedAt > ttlMs) {
        plan.destroy.push({ sandboxId: sandbox.sandboxId, reason: "expired" });
      } else if (sandbox.status === "running") {
        plan.stop.push(sandbox.sandboxId);
      }
      continue;
    }
    // Nothing can resume a sandbox no row points at. One whose creation time
    // could not be read never passes the grace period, so it is left alone.
    if (opts.now - sandbox.createdAt > graceMs) {
      plan.destroy.push({ sandboxId: sandbox.sandboxId, reason: "orphaned" });
    }
  }

  // A row is only judged against the host it was made on: a sandbox on another
  // Docker host is absent from this list without being gone. The rows were read
  // before the list, so a sandbox created in between cannot be mistaken for gone.
  const listed = new Set(sandboxes.map((s) => s.sandboxId));
  for (const row of ours) {
    if (row.host !== opts.host || row.runLive) continue;
    if (listed.has(row.sandboxId) || inUse.has(row.sandboxId)) continue;
    plan.gone.push(row.sandboxId);
  }
  return plan;
}

export type ReapDeps = {
  provider: SandboxProvider;
  /** The deployment's sandbox rows. */
  rows: () => Promise<SandboxRow[]>;
  /** Records what happened to these sandboxes on their rows. */
  setStatus: (sandboxIds: string[], status: "paused" | "missing") => Promise<unknown>;
  /** Sandboxes a run on this dispatcher holds right now; read again before each change. */
  inUse: () => ReadonlySet<string>;
  log: (message: string) => void;
};

export type ReapReport = {
  destroyed: ReapDecision[];
  /** Stranded sandboxes whose commands were stopped and which were paused. */
  stopped: string[];
  /** Rows marked missing because their sandbox was already gone. */
  gone: string[];
};

/** One pass: destroys, stops and corrects as `planReap` decides, and reports what it did. */
export async function reapSandboxes(deps: ReapDeps, opts: ReapOptions): Promise<ReapReport> {
  // Rows before the list: see the comment on `gone` in planReap.
  const rows = await deps.rows();
  const sandboxes = await deps.provider.list();
  const plan = planReap(sandboxes, rows, deps.inUse(), opts);
  const report: ReapReport = { destroyed: [], stopped: [], gone: plan.gone };

  if (plan.gone.length > 0) await deps.setStatus(plan.gone, "missing");

  if (plan.destroy.length > 0) {
    // Rows first: once a row reads missing, a newly queued run will not be handed
    // the sandbox. If a destroy then fails, the next pass finds it again as an orphan.
    await deps.setStatus(
      plan.destroy.map((d) => d.sandboxId),
      "missing",
    );
    for (const decision of plan.destroy) {
      // A run may have claimed it while the lists were being read.
      if (deps.inUse().has(decision.sandboxId)) continue;
      try {
        await deps.provider.destroy(decision.sandboxId);
        report.destroyed.push(decision);
      } catch (cause) {
        deps.log(
          `could not destroy ${decision.reason} sandbox ${decision.sandboxId}: ${String(cause)}`,
        );
      }
    }
  }

  for (const sandboxId of plan.stop) {
    if (deps.inUse().has(sandboxId)) continue;
    try {
      await deps.provider.stopCommands(sandboxId);
      await deps.provider.pause(sandboxId);
      report.stopped.push(sandboxId);
    } catch (cause) {
      deps.log(`could not stop stranded sandbox ${sandboxId}: ${String(cause)}`);
    }
  }
  if (report.stopped.length > 0) await deps.setStatus(report.stopped, "paused");

  return report;
}
