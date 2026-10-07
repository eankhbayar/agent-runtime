export type SandboxLimits = {
    cpus: number;
    memoryMb: number;
    pids: number;
};
export type SandboxStatus = "running" | "paused" | "stopped" | "missing";
/** A sandbox as the platform reports it, whether or not anything still points at it. */
export type SandboxInfo = {
    sandboxId: string;
    /** `missing` when only leftovers remain, such as a network whose container is gone. */
    status: SandboxStatus;
    /** Unix ms. */
    createdAt: number;
};
/** A sandbox's CPU, in cores, and memory, in MiB, at one moment. */
export type Usage = {
    cpu: number;
    memoryMb: number;
};
/** Reads a sandbox's usage; null when it has none to give, such as when paused. */
export type SampleUsage = (sandboxId: string) => Promise<Usage | null>;
export type ExecOptions = {
    env?: Record<string, string>;
    timeoutMs?: number;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
};
export type ExecHandle = {
    done: Promise<number>;
    kill: () => Promise<void>;
};
export interface SandboxProvider {
    create(opts: {
        image: string;
        limits: SandboxLimits;
        labels?: Record<string, string>;
    }): Promise<string>;
    upload(sandboxId: string, localDir: string, remoteDir: string): Promise<void>;
    download(sandboxId: string, remotePath: string, localPath: string): Promise<void>;
    exec(sandboxId: string, command: string[], opts?: ExecOptions): ExecHandle;
    pause(sandboxId: string): Promise<void>;
    resume(sandboxId: string): Promise<void>;
    stopCommands(sandboxId: string): Promise<void>;
    destroy(sandboxId: string): Promise<void>;
    status(sandboxId: string): Promise<SandboxStatus>;
    list(): Promise<SandboxInfo[]>;
    hostId(): Promise<string>;
}
