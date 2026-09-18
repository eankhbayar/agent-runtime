// Only an adapter behind this interface talks to a sandbox platform. The
// runner, the image and the run events must not depend on any one implementation.

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

export type ExecOptions = {
  // Passed to this command only, never stored in the sandbox's configuration.
  env?: Record<string, string>;
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

export type ExecHandle = {
  // Resolves with the exit code; a timeout exits 124, like coreutils timeout.
  done: Promise<number>;
  // Sends SIGTERM to the command inside the sandbox.
  kill: () => Promise<void>;
};

export interface SandboxProvider {
  // Creates and starts a sandbox whose only reachable host is the egress gateway.
  create(opts: {
    image: string;
    limits: SandboxLimits;
    labels?: Record<string, string>;
  }): Promise<string>;
  // Copies a local directory's contents into the sandbox, owned by root and
  // read-only to the command user.
  upload(sandboxId: string, localDir: string, remoteDir: string): Promise<void>;
  download(sandboxId: string, remotePath: string, localPath: string): Promise<void>;
  exec(sandboxId: string, command: string[], opts?: ExecOptions): ExecHandle;
  pause(sandboxId: string): Promise<void>;
  resume(sandboxId: string): Promise<void>;
  // Ends every command running in the sandbox, keeping its files, so a runner
  // whose dispatcher died stops working and the thread's session survives.
  stopCommands(sandboxId: string): Promise<void>;
  destroy(sandboxId: string): Promise<void>;
  status(sandboxId: string): Promise<SandboxStatus>;
  // Every sandbox this provider made that still holds resources, for the reaper.
  list(): Promise<SandboxInfo[]>;
  // Identifies where this provider's sandboxes live, so a sandbox missing from
  // `list` is known to be gone rather than on another host.
  hostId(): Promise<string>;
}
