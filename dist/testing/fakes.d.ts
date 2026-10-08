import type { RunEvent, RunSample } from "../contract/events.ts";
import type { ExecHandle, ExecOptions, SandboxInfo, SandboxProvider, SandboxStatus } from "../core/sandbox-provider.ts";
import type { ArtifactUpload, EventSink, SinkState } from "../core/run.ts";
export type FakeRun = {
    /** What the runner writes to stdout, one chunk at a time. */
    stdout: string[];
    stderr?: string;
    exitCode?: number;
    /** Milliseconds between chunks, so a cancel can land mid-run. */
    chunkMs?: number;
    /** Files the sandbox holds, by the path an artifact event points at. */
    files?: Record<string, string>;
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
    private state;
    private next;
    private readonly run;
    constructor(run?: FakeRun);
    create(): Promise<string>;
    upload(): Promise<void>;
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
