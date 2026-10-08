import type { RunEvent, RunSample } from "../contract/events.ts";
import type { BindMount, ExecHandle, ExecOptions, SandboxInfo, SandboxLimits, SandboxProvider, SandboxStatus } from "../core/sandbox-provider.ts";
import { type ArtifactUpload, type EventSink, type SinkState } from "../core/run.ts";
export type FakeRun = {
    /** What the runner writes to stdout, one chunk at a time. */
    stdout: string[];
    stderr?: string;
    exitCode?: number;
    /** Milliseconds between chunks, so a cancel can land mid-run. */
    chunkMs?: number;
    /** Files the sandbox holds, by path: what an artifact event points at, or a session the runner wrote. */
    files?: Record<string, string>;
};
/** What `create` was asked for. */
export type FakeCreate = {
    image: string;
    limits: SandboxLimits;
    labels?: Record<string, string>;
    binds?: BindMount[];
};
export declare class FakeSandboxProvider implements SandboxProvider {
    readonly calls: string[];
    readonly execs: string[][];
    killed: boolean;
    resumeFails: boolean;
    /** What `sha256sum` prints for every uploaded file a mount verifies. */
    uploadSha: string;
    /** What `list` reports, for the reaper tests. */
    sandboxes: SandboxInfo[];
    readonly destroyed: string[];
    /** The options of every `create`. */
    readonly creates: FakeCreate[];
    /**
     * The sandbox's files by path: `files` from the run, what `upload` copied
     * in, and a restored session. `download` copies from here.
     */
    readonly fs: Map<string, Buffer>;
    /** Makes the session restore command exit 1. */
    restoreFails: boolean;
    private state;
    private next;
    private readonly run;
    constructor(run?: FakeRun);
    create(opts?: FakeCreate): Promise<string>;
    upload(_sandboxId: string, localDir: string, remoteDir: string): Promise<void>;
    /** Copies a file, or a directory with everything under it, as `docker cp` does. */
    download(_sandboxId: string, remotePath: string, localPath: string): Promise<void>;
    exec(_sandboxId: string, command: string[], opts?: ExecOptions): ExecHandle;
    pause(sandboxId: string): Promise<void>;
    stopCommands(sandboxId: string): Promise<void>;
    hostId(): Promise<string>;
    private setListed;
    resume(sandboxId: string): Promise<void>;
    destroy(sandboxId: string): Promise<void>;
    status(): Promise<SandboxStatus>;
    list(): Promise<SandboxInfo[]>;
}
export declare class FakeSink implements EventSink {
    readonly batches: RunEvent[][];
    readonly storedSamples: RunSample[];
    readonly uploads: ArtifactUpload[];
    readonly lines: string[];
    state: SinkState;
    /** Rejects this many of the next `events` calls, as a dropped connection does. */
    failNext: number;
    /** Every event the run sent, in the order the sink saw it. */
    get sent(): RunEvent[];
    events: (batch: RunEvent[]) => Promise<SinkState>;
    samples: (samples: RunSample[]) => Promise<void>;
    artifact: (upload: ArtifactUpload) => Promise<string>;
    log: (message: string) => void;
}
/** One JSON line as the in-sandbox runner writes it. */
export declare function line(seq: number, type: RunEvent["type"], payload: Record<string, unknown>): string;
