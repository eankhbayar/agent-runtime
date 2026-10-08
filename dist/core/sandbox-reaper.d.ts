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
export type ReapDecision = {
    sandboxId: string;
    reason: ReapReason;
};
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
export declare const SANDBOX_TTL_MS: number;
/**
 * How old a sandbox with no row must be before it counts as orphaned. A run
 * writes its row once its mounts are uploaded; this covers that gap for runs
 * on another dispatcher sharing the same Docker host, which `inUse` cannot see.
 */
export declare const ORPHAN_GRACE_MS: number;
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
export declare function planReap(sandboxes: readonly SandboxInfo[], rows: readonly SandboxRow[], inUse: ReadonlySet<string>, opts: ReapOptions): ReapPlan;
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
export declare function reapSandboxes(deps: ReapDeps, opts: ReapOptions): Promise<ReapReport>;
