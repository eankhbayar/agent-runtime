import type { FinalRunStatus, RunEvent, RunLimits, RunSample, RunUsage } from "../contract/events.ts";
import type { SandboxProvider } from "./sandbox-provider.ts";
/** How the run looks to whoever is storing it, answered on every append. */
export type SinkState = {
    /** Someone asked for the run to stop. */
    cancelled: boolean;
    /** The run is no longer there to write to: deleted, or already finished. */
    gone: boolean;
};
export declare const LIVE: SinkState;
/**
 * An output copied out of the sandbox. `kind` is whatever the agent declared,
 * so the sink checks it before storing; the author is always the agent.
 */
export type ArtifactUpload = {
    kind: string;
    fileName: string;
    caption: string;
    mediaType: string;
    sha256: string;
    size: number;
    bytes: Uint8Array;
};
/** A local directory pushed into a new sandbox, read-only to the agent. */
export type Mount = {
    localDir: string;
    remoteDir: string;
    /** Files to hash once uploaded: path inside `remoteDir` -> expected sha256. */
    verify?: Record<string, string>;
};
export type EventSink = {
    /** Stores a batch in seq order and says whether the run is still wanted. */
    events: (batch: RunEvent[]) => Promise<SinkState>;
    samples: (samples: RunSample[]) => Promise<void>;
    /** Stores an output file and returns its id, which goes into the artifact event. */
    artifact: (upload: ArtifactUpload) => Promise<string | null>;
    log: (message: string) => void;
};
/** Grants and revokes the run's egress-gateway token. */
export type TokenGrant = {
    grant: (runId: string, ttlMs: number) => Promise<string>;
    revoke: (token: string) => Promise<void>;
};
export type RunOutcome = {
    sandboxId: string;
    /** True when this run had to build a sandbox rather than resume one. */
    created: boolean;
    status: FinalRunStatus;
    error?: string;
    answerText: string;
    /** Tokens and cost summed over every turn. */
    usage: RunUsage;
    events: RunEvent[];
};
export type ExecuteRunOptions = {
    provider: SandboxProvider;
    sink: EventSink;
    tokens: TokenGrant;
    runId: string;
    prompt: string;
    /** The runner to start in the sandbox, e.g. `["node", "/opt/runner/runner.js"]`. */
    command: string[];
    image: string;
    limits: RunLimits;
    /** Pushed into a sandbox this run builds; a resumed sandbox already has them. */
    mounts?: Mount[];
    /** Extra labels on a sandbox this run builds. */
    labels?: Record<string, string>;
    /** LLM_PROVIDER, LLM_MODEL, LLM_BASE_URL and anything else the runner reads. */
    env?: Record<string, string>;
    /** A sandbox to continue, from this thread's `sandboxes` row. */
    resumeSandboxId?: string;
    /** Pause the sandbox instead of destroying it, so the thread can reuse it. */
    keepSandbox?: boolean;
    /** Called once the run has a sandbox ready, resumed or newly built, before the runner starts. */
    onSandbox?: (sandboxId: string, created: boolean) => void | Promise<void>;
    /** Reads the sandbox's CPU and memory; omit to store no samples. */
    usage?: (sandboxId: string) => Promise<{
        cpu: number;
        memoryMb: number;
    } | null>;
    /** Cancels the run from outside, e.g. when the dispatcher is shutting down. */
    signal?: AbortSignal;
    batchMs?: number;
    batchEvents?: number;
    sampleMs?: number;
    /** How many times a failed batch is re-sent before the run is abandoned. */
    retries?: number;
    retryMs?: number;
};
export declare function mediaTypeFor(fileName: string): string;
/** Merges consecutive text deltas, which the UI concatenates anyway. */
export declare function coalesce(batch: readonly RunEvent[]): RunEvent[];
export declare function executeRun(opts: ExecuteRunOptions): Promise<RunOutcome>;
