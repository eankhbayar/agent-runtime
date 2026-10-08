import type { Duplex } from "node:stream";
import type { BindMount, ExecHandle, ExecOptions, SandboxInfo, SandboxLimits, SandboxProvider, SandboxStatus } from "../../core/sandbox-provider.ts";
import { type BridgeProcess } from "./bridge.ts";
export declare const SANDBOX_BIN = "/usr/local/gcp/bin/sandbox";
export declare class SandboxCliError extends Error {
    readonly args: string[];
    readonly exitCode: number | null;
    readonly stderr: string;
    constructor(args: string[], exitCode: number | null, signal: string | null, stderr: string);
}
export type CloudRunBridgeOptions = {
    /** Serves each connection the runner opens to `http://127.0.0.1:<port>`, e.g. the in-process gateway's `connect`. */
    onConnection: (stream: Duplex) => void;
    /** The port inside the sandbox. Default 8080. */
    port?: number;
    /** How to run the shim, before the port. Default: this package's `bridge-peer.js` under the job's node. */
    command?: string[];
    log?: (message: string) => void;
};
export type CloudRunSandboxOptions = {
    /** Names this provider's sandboxes `<namespace>-sbx-<id>`. */
    namespace: string;
    /** The CLI. Default `/usr/local/gcp/bin/sandbox`. */
    sandboxBin?: string;
    /** Where on the job each sandbox's workspace is kept. Default `<tmpdir>/agent-runtime-sandboxes`, which sandboxes cannot see. */
    stateDir?: string;
    /** Where the workspace is bound in the sandbox, and the working directory of every command. Default `/workspace`. */
    workspace?: string;
    /**
     * Starts the stdio bridge in each sandbox once it is created and stops it
     * when it is destroyed. Without it a sandbox has no way to reach a model.
     */
    bridge?: CloudRunBridgeOptions;
    /**
     * Paths of the job's filesystem to cover with an empty read-only directory
     * in every sandbox. A sandbox sees the job's whole filesystem, so list
     * anything the agent must not read: the sessions bucket's mount, a secret
     * mounted as a file, other runs' data.
     */
    hide?: string[];
    /**
     * FUSE mounts of the job (a Cloud Storage volume is one) that sandboxes may
     * read. Every other FUSE mount is covered like a `hide` path, so a volume
     * the job mounts stays out of its sandboxes unless it is listed here.
     */
    visibleMounts?: string[];
    /**
     * The job's mount table, in `/proc/self/mounts` format. Read from
     * `/proc/self/mounts` when omitted; tests pass one in.
     */
    mountTable?: string;
    /** Where the provider says which mounts it covered. */
    log?: (message: string) => void;
    /** The most `download` takes out of a sandbox. Default 512 MiB. */
    maxDownloadBytes?: number;
    /** Environment for the CLI itself, which gets only PATH and HOME otherwise. */
    cliEnv?: Record<string, string>;
    /**
     * Added to the run's memory limit to make the `ulimit -v` address-space cap
     * (Node reserves about 1.4 GiB of address space before it allocates
     * anything). Default 1536 MiB. `false` sets no memory limit.
     */
    memoryHeadroomMb?: number | false;
    /** `PATH` for every command, since a sandbox inherits no environment. */
    path?: string;
    /** Default: the Cloud Run execution, task and attempt this process runs in. */
    hostId?: string;
    /** How long a stopped command has after SIGTERM before SIGKILL. Default 10 s. */
    killGraceMs?: number;
};
/**
 * The FUSE mounts (a Cloud Storage volume is one) in a `/proc/self/mounts`
 * table that no path in `covered` contains, with their filesystem types.
 */
export declare function uncoveredFuseMounts(table: string, covered: readonly string[]): {
    point: string;
    type: string;
}[];
/** The mount points `uncoveredFuseMounts` finds. */
export declare function exposedMounts(table: string, covered: readonly string[]): string[];
export declare class CloudRunSandboxProvider implements SandboxProvider {
    private readonly opts;
    private readonly bin;
    private readonly stateDir;
    private readonly workspace;
    private readonly sandboxes;
    private covered;
    constructor(opts: CloudRunSandboxOptions);
    /** The base URL a runner in one of these sandboxes reaches the bridge by, e.g. `http://127.0.0.1:8080`. */
    get bridgeUrl(): string;
    create({ limits, labels: _labels, binds, }: {
        image: string;
        limits: SandboxLimits;
        labels?: Record<string, string>;
        binds?: BindMount[];
    }): Promise<string>;
    upload(sandboxId: string, localDir: string, remoteDir: string): Promise<void>;
    /**
     * Packed by tar inside the sandbox, where a symlink resolves in the
     * sandbox's own view and so cannot reach a hidden path or the job's files,
     * and unpacked here as directories and regular files only.
     */
    download(sandboxId: string, remotePath: string, localPath: string): Promise<void>;
    exec(sandboxId: string, command: string[], opts?: ExecOptions): ExecHandle;
    /**
     * Runs a command with its stdin and stdout piped and nothing in between: no
     * exit marker, no limits. For the bridge's shim, whose stdout is all frames.
     */
    openStream(sandboxId: string, command: string[]): BridgeProcess;
    /** Cloud Run cannot keep a sandbox past the execution; keep the session with `session` instead. */
    pause(_sandboxId: string): Promise<void>;
    /** Always fails, so executeRun builds a new sandbox and restores the session into it. */
    resume(sandboxId: string): Promise<void>;
    stopCommands(sandboxId: string): Promise<void>;
    destroy(sandboxId: string): Promise<void>;
    status(sandboxId: string): Promise<SandboxStatus>;
    list(): Promise<SandboxInfo[]>;
    hostId(): Promise<string>;
    /** `sandbox exec` arguments with a PATH, HOME and `env` set, since a sandbox inherits none. */
    private execArgs;
    /** The run's caps, set again by every command, since a limit can only be lowered. */
    private limitLines;
    /** The environment the CLI runs with: PATH, HOME and `cliEnv`, none of the job's secrets. */
    private cliEnvironment;
    /**
     * The paths every sandbox gets an empty read-only directory over: `hide`,
     * plus each FUSE mount of the job (a Cloud Storage volume, or one of the
     * platform's own such as Cloud Run's /var/log) that `visibleMounts` does
     * not name. The sandbox's root is the job's filesystem, so it would
     * otherwise read them. Worked out once per provider.
     */
    private coveredPaths;
    /** Signals a command started by `exec`, waiting briefly for its pid file. */
    private signal;
    /** Waits until a new sandbox runs commands. */
    private waitReady;
    private cli;
    /** Runs the CLI with its stdout going to `file`, killing it past `maxBytes`. */
    private cliToFile;
}
