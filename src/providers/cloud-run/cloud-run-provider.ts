// SandboxProvider over the `sandbox` CLI that a Cloud Run job deployed with
// --sandbox-launcher has at /usr/local/gcp/bin/sandbox. Each sandbox is a
// gVisor sandbox inside the job's own instance, so it lives no longer than the
// execution. What the CLI does, as the probe in HKJC's
// spike/cloud-run-sandbox found it:
//
// - A sandbox's root is the job container's filesystem, read-only, with writes
//   kept in an overlay of its own and its own /tmp. It inherits no environment
//   (only HOME), and runs as a mapped uid 0 that may write a bind-mounted
//   directory only when it is root-owned 755 or open (777, 1777). The job has
//   to launch sandboxes as root.
// - Without --allow-egress it has no network at all: no DNS, no metadata
//   server, none of the job's listeners. The runner reaches the model through
//   the stdio bridge (bridge.ts) instead, so no sandbox is given egress or a
//   published port.
// - `sandbox exec` loses the exit code (exit-marker.ts), and killing it leaves
//   a command with children running, so commands are stopped through a pid file.
// - `ulimit` set by one exec holds for later ones in the same sandbox, and a
//   limit can only be lowered; memory is capped with `ulimit -v`, processes
//   with `ulimit -p`. There is no CPU limit, no pause and no list.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, rm, truncate } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";

import { extractPlainTar } from "../../core/plain-files.ts";
import type {
  BindMount,
  ExecHandle,
  ExecOptions,
  SandboxInfo,
  SandboxLimits,
  SandboxProvider,
  SandboxStatus,
} from "../../core/sandbox-provider.ts";

import { startBridge, type Bridge, type BridgeProcess } from "./bridge.ts";
import { ExitMarkerReader, newExitMarker, printExitMarker, splitExitMarker } from "./exit-marker.ts";

export const SANDBOX_BIN = "/usr/local/gcp/bin/sandbox";

const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/** The most a CLI call's output is held in memory; a download goes to disk instead. */
const MAX_CLI_OUTPUT = 16 * 1024 * 1024;
/** Linux refuses a single argument or environment string longer than this. */
const MAX_ARG_BYTES = 128 * 1024 - 1;

export class SandboxCliError extends Error {
  readonly args: string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(args: string[], exitCode: number | null, signal: string | null, stderr: string) {
    super(
      `sandbox ${args[0]} failed (${exitCode ?? signal ?? "?"}): ${stderr.trim() || "no output"}`,
    );
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
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
   * read. `create` refuses to start a sandbox while the job has any other
   * FUSE mount that `hide` does not cover, since the sandbox could read it.
   */
  visibleMounts?: string[];
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

type Bind = { source: string; destination: string; readonly: boolean };

type Sandbox = {
  id: string;
  root: string;
  createdAt: number;
  binds: Bind[];
  limits: SandboxLimits;
  bridge: Bridge | null;
  /** CLI processes running commands in it. */
  children: Set<ChildProcess>;
};

type CliResult = { code: number | null; signal: string | null; stdout: Buffer; stderr: string };

function isWithin(dir: string, target: string): boolean {
  const relative = path.posix.relative(dir, target);
  return relative === "" || (!relative.startsWith("..") && !path.posix.isAbsolute(relative));
}

function mountSpec(bind: Bind): string {
  for (const value of [bind.source, bind.destination]) {
    if (!path.isAbsolute(value) || /[,\n]/.test(value)) {
      throw new Error(`Cannot bind ${value}: paths must be absolute, without commas`);
    }
  }
  return `type=bind,source=${bind.source},destination=${bind.destination}${bind.readonly ? ",readonly" : ""}`;
}

/**
 * The FUSE mounts (a Cloud Storage volume is one) in a `/proc/self/mounts`
 * table that no path in `covered` contains.
 */
export function exposedMounts(table: string, covered: readonly string[]): string[] {
  return table
    .split("\n")
    .map((line) => line.split(" "))
    // fuse or fuse.<name> (gcsfuse); not fusectl, the control filesystem.
    .filter(([, , type]) => type === "fuse" || type?.startsWith("fuse."))
    .map(([, point]) =>
      point!.replace(/\\([0-7]{3})/g, (_, code: string) => String.fromCharCode(Number.parseInt(code, 8))),
    )
    .filter((point) => !covered.some((dir) => isWithin(dir, point)));
}

export class CloudRunSandboxProvider implements SandboxProvider {
  private readonly opts: CloudRunSandboxOptions;
  private readonly bin: string;
  private readonly stateDir: string;
  private readonly workspace: string;
  private readonly sandboxes = new Map<string, Sandbox>();

  private mountsChecked = false;

  constructor(opts: CloudRunSandboxOptions) {
    this.opts = opts;
    this.bin = opts.sandboxBin ?? SANDBOX_BIN;
    this.stateDir = opts.stateDir ?? path.join(tmpdir(), "agent-runtime-sandboxes");
    this.workspace = opts.workspace ?? "/workspace";
  }

  /** The base URL a runner in one of these sandboxes reaches the bridge by, e.g. `http://127.0.0.1:8080`. */
  get bridgeUrl(): string {
    return `http://127.0.0.1:${this.opts.bridge?.port ?? 8080}`;
  }

  async create({
    limits,
    labels: _labels,
    binds = [],
  }: {
    image: string;
    limits: SandboxLimits;
    labels?: Record<string, string>;
    binds?: BindMount[];
  }): Promise<string> {
    // `image` is not used: the sandbox's root is this job's own image.
    await this.checkMounts();
    const id = `${this.opts.namespace}-sbx-${randomBytes(6).toString("hex")}`;
    const root = path.join(this.stateDir, id);
    const workspace = path.join(root, "workspace");
    const empty = path.join(root, "empty");
    await mkdir(workspace, { recursive: true });
    await mkdir(empty, { recursive: true });
    // The sandbox's root is mapped: it writes a root-owned 755 directory, or an open one.
    await chmod(workspace, process.getuid?.() === 0 ? 0o755 : 0o777);
    await chmod(empty, 0o555);

    const sandbox: Sandbox = {
      id,
      root,
      createdAt: Date.now(),
      limits,
      bridge: null,
      children: new Set(),
      binds: [
        { source: workspace, destination: this.workspace, readonly: false },
        ...binds.map((b) => ({ source: b.localDir, destination: b.remoteDir, readonly: true })),
        ...(this.opts.hide ?? []).map((p) => ({ source: empty, destination: p, readonly: true })),
      ],
    };
    this.sandboxes.set(id, sandbox);
    try {
      // No --allow-egress and no --publish: the bridge is the only way out.
      await this.cli([
        "run",
        id,
        "--detach",
        "--write",
        ...sandbox.binds.flatMap((bind) => ["--mount", mountSpec(bind)]),
        "--",
        "/bin/sleep",
        "infinity",
      ]);
      await this.waitReady(id);
      if (this.opts.bridge) {
        const bridge = this.opts.bridge;
        sandbox.bridge = await startBridge({
          open: (command) => this.openStream(id, command),
          port: bridge.port ?? 8080,
          onConnection: bridge.onConnection,
          command: bridge.command,
          log: bridge.log,
        });
      }
    } catch (error) {
      await this.destroy(id).catch(() => {});
      throw error;
    }
    return id;
  }

  async upload(sandboxId: string, localDir: string, remoteDir: string): Promise<void> {
    // Unpacked by tar inside the sandbox, never written through the shared
    // workspace from here: a symlink the sandbox made there would point the
    // job's write at the job's own files. The agent, root in its sandbox, can
    // change what it is given.
    const marker = newExitMarker();
    const script = `mkdir -p "$1" && tar -xf - -C "$1" --no-same-owner; code=$?; ${printExitMarker(marker)}`;
    const packed = spawn("tar", ["-C", localDir, "-cf", "-", "."], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...this.cliEnvironment(), COPYFILE_DISABLE: "1" },
    });
    let packError = "";
    packed.stderr.setEncoding("utf8").on("data", (d: string) => (packError = `${packError}${d}`.slice(-2_000)));
    const packedExit = new Promise<number | null>((resolve) => {
      packed.on("error", (error) => {
        packError += String(error);
        resolve(null);
      });
      packed.on("close", (code) => resolve(code));
    });
    const result = await this.cli(this.execArgs(sandboxId, ["/bin/sh", "-c", script, "sh", remoteDir]), {
      input: packed.stdout,
      check: false,
    });
    const packedCode = await packedExit;
    if (packedCode !== 0) throw new Error(`Could not pack ${localDir} (${packedCode}): ${packError.trim()}`);
    const code = splitExitMarker(result.stdout, marker).code;
    if (code !== 0) {
      throw new Error(`Could not upload ${localDir} to ${remoteDir} (${code ?? "no exit code"}): ${result.stderr.trim()}`);
    }
  }

  /**
   * Packed by tar inside the sandbox, where a symlink resolves in the
   * sandbox's own view and so cannot reach a hidden path or the job's files,
   * and unpacked here as directories and regular files only.
   */
  async download(sandboxId: string, remotePath: string, localPath: string): Promise<void> {
    const max = this.opts.maxDownloadBytes ?? 512 * 1024 * 1024;
    const marker = newExitMarker();
    const script = `cd "$(dirname "$1")" && tar -cf - "$(basename "$1")"; code=$?; ${printExitMarker(marker)}`;
    const dir = await mkdtemp(path.join(tmpdir(), "agent-runtime-download-"));
    try {
      const archive = path.join(dir, "download.tar");
      const { stderr } = await this.cliToFile(
        this.execArgs(sandboxId, ["/bin/sh", "-c", script, "sh", remotePath], { COPYFILE_DISABLE: "1" }),
        archive,
        max + 4096,
      );
      // The marker ends the output; read it from the tail and cut it off.
      const handle = await open(archive, "r");
      let size: number;
      let tail: Buffer;
      try {
        size = (await handle.stat()).size;
        const length = Math.min(size, 256);
        tail = Buffer.alloc(length);
        await handle.read(tail, 0, length, size - length);
      } finally {
        await handle.close();
      }
      const { body, code } = splitExitMarker(tail, marker);
      if (code !== 0) {
        throw new Error(`Could not download ${remotePath} (${code ?? "no exit code"}): ${stderr.trim()}`);
      }
      await truncate(archive, size - (tail.length - body.length));
      await extractPlainTar(archive, localPath, max);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  exec(sandboxId: string, command: string[], opts: ExecOptions = {}): ExecHandle {
    const sandbox = this.sandboxes.get(sandboxId);
    const nonce = randomBytes(6).toString("hex");
    const marker = newExitMarker();
    const pidFile = `/tmp/agent-runtime-exec-${nonce}.pid`;
    // The inner shell writes its pid and becomes the command, so a kill reaches
    // the command itself; the outer one outlives it to print the exit code.
    const script = [
      ...this.limitLines(sandbox?.limits),
      `pf=$1; shift`,
      `/bin/sh -c 'echo $$ > "$0"; exec "$@"' "$pf" "$@"`,
      `code=$?`,
      `rm -f "$pf"`,
      printExitMarker(marker),
    ].join("\n");

    let child: ChildProcess;
    try {
      child = spawn(
        this.bin,
        this.execArgs(sandboxId, ["/bin/sh", "-c", script, "sh", pidFile, ...command], opts.env),
        { stdio: ["ignore", "pipe", "pipe"], env: this.cliEnvironment() },
      );
    } catch (error) {
      return { done: Promise.reject(error), kill: async () => {} };
    }
    sandbox?.children.add(child);

    let killed = false;
    let timedOut = false;
    let finished = false;
    const timers: NodeJS.Timeout[] = [];
    const reader = new ExitMarkerReader(marker, (text) => opts.onStdout?.(text));
    child.stdout!.setEncoding("utf8").on("data", (d: string) => reader.push(d));
    child.stderr!.setEncoding("utf8").on("data", (d: string) => opts.onStderr?.(d));

    const done = new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (exitCode) => {
        finished = true;
        for (const timer of timers) clearTimeout(timer);
        sandbox?.children.delete(child);
        const code = reader.end();
        if (timedOut) resolve(124);
        else if (code !== null) resolve(code);
        else if (killed) resolve(143);
        // The CLI's own failure, such as a sandbox that is not running.
        else if (exitCode !== null && exitCode !== 0) resolve(exitCode);
        else {
          opts.onStderr?.("sandbox exec ended without the command's exit code\n");
          resolve(255);
        }
      });
    });

    const grace = this.opts.killGraceMs ?? 10_000;
    const kill = async () => {
      if (finished || killed) return;
      killed = true;
      timers.push(
        setTimeout(() => void this.signal(sandboxId, pidFile, "KILL"), grace),
        // A sandbox that no longer answers: give up on the command and free the CLI.
        setTimeout(() => child.kill("SIGKILL"), grace + 5_000),
      );
      await this.signal(sandboxId, pidFile, "TERM");
    };
    if (opts.timeoutMs) {
      timers.push(
        setTimeout(() => {
          timedOut = true;
          void kill();
        }, opts.timeoutMs),
      );
    }
    return { done, kill };
  }

  /**
   * Runs a command with its stdin and stdout piped and nothing in between: no
   * exit marker, no limits. For the bridge's shim, whose stdout is all frames.
   */
  openStream(sandboxId: string, command: string[]): BridgeProcess {
    const child = spawn(this.bin, this.execArgs(sandboxId, command), {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.cliEnvironment(),
    });
    const exited = new Promise<void>((resolve) => {
      child.on("close", () => resolve());
      child.on("error", () => resolve());
    });
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      exited,
      kill: () => child.kill("SIGTERM"),
    };
  }

  /** Cloud Run cannot keep a sandbox past the execution; keep the session with `session` instead. */
  async pause(_sandboxId: string): Promise<void> {
    throw new Error("Cloud Run sandboxes cannot be paused; use executeRun's session option");
  }

  /** Always fails, so executeRun builds a new sandbox and restores the session into it. */
  async resume(sandboxId: string): Promise<void> {
    throw new Error(`Cloud Run sandboxes cannot be resumed (${sandboxId})`);
  }

  async stopCommands(sandboxId: string): Promise<void> {
    await this.cli(
      this.execArgs(sandboxId, [
        "/bin/sh",
        "-c",
        'for f in /tmp/agent-runtime-exec-*.pid; do [ -s "$f" ] && kill -TERM "$(cat "$f")"; done; true',
      ]),
      { check: false },
    );
  }

  async destroy(sandboxId: string): Promise<void> {
    const sandbox = this.sandboxes.get(sandboxId);
    await sandbox?.bridge?.close().catch(() => {});
    // Deleting a missing sandbox succeeds, so any other failure is real, and
    // the sandbox may still be using its workspace: keep it, and keep it listed.
    await this.cli(["delete", sandboxId, "--force"]);
    for (const child of sandbox?.children ?? []) child.kill("SIGTERM");
    if (sandbox) await rm(sandbox.root, { recursive: true, force: true }).catch(() => {});
    this.sandboxes.delete(sandboxId);
  }

  async status(sandboxId: string): Promise<SandboxStatus> {
    const result = await this.cli(["exec", sandboxId, "--", "/bin/sh", "-c", "true"], { check: false });
    if (result.code === 0) return "running";
    if (/not running/.test(result.stderr)) return "missing";
    return "stopped";
  }

  // The CLI cannot list sandboxes; these are the ones this provider made and
  // has not destroyed. Every sandbox ends with the execution anyway.
  async list(): Promise<SandboxInfo[]> {
    return [...this.sandboxes.values()].map((s) => ({
      sandboxId: s.id,
      status: "running",
      createdAt: s.createdAt,
    }));
  }

  async hostId(): Promise<string> {
    if (this.opts.hostId) return this.opts.hostId;
    const { CLOUD_RUN_EXECUTION, CLOUD_RUN_TASK_INDEX, CLOUD_RUN_TASK_ATTEMPT } = process.env;
    if (CLOUD_RUN_EXECUTION) {
      return `${CLOUD_RUN_EXECUTION}/${CLOUD_RUN_TASK_INDEX ?? "0"}/${CLOUD_RUN_TASK_ATTEMPT ?? "0"}`;
    }
    return hostname();
  }

  /** `sandbox exec` arguments with a PATH, HOME and `env` set, since a sandbox inherits none. */
  private execArgs(sandboxId: string, command: string[], env: Record<string, string> = {}): string[] {
    const assignments = Object.entries({
      PATH: this.opts.path ?? DEFAULT_PATH,
      HOME: "/root",
      ...env,
    }).map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Bad environment name ${name}`);
      return `${name}=${value}`;
    });
    const args = [
      "exec",
      sandboxId,
      "--workdir",
      this.workspace,
      "--",
      "/usr/bin/env",
      ...assignments,
      ...command,
    ];
    for (const arg of args) {
      if (Buffer.byteLength(arg) > MAX_ARG_BYTES) {
        throw new Error(
          `An argument or environment value of ${Buffer.byteLength(arg)} bytes is too long for sandbox exec (${MAX_ARG_BYTES} at most): ${arg.slice(0, 40)}…`,
        );
      }
    }
    return args;
  }

  /** The run's caps, set again by every command, since a limit can only be lowered. */
  private limitLines(limits: SandboxLimits | undefined): string[] {
    if (!limits) return [];
    const lines: string[] = [];
    const headroom = this.opts.memoryHeadroomMb ?? 1536;
    if (headroom !== false) {
      const kb = Math.round((limits.memoryMb + headroom) * 1024);
      lines.push(`ulimit -v ${kb} 2>/dev/null || echo "agent-runtime: could not cap memory at ${kb} KiB" >&2`);
    }
    // dash calls the process limit -p, bash -u.
    lines.push(
      `ulimit -p ${limits.pids} 2>/dev/null || ulimit -u ${limits.pids} 2>/dev/null || echo "agent-runtime: could not cap processes at ${limits.pids}" >&2`,
    );
    return lines;
  }

  /** The environment the CLI runs with: PATH, HOME and `cliEnv`, none of the job's secrets. */
  private cliEnvironment(): Record<string, string> {
    return {
      PATH: process.env.PATH ?? DEFAULT_PATH,
      HOME: process.env.HOME ?? "/root",
      ...this.opts.cliEnv,
    };
  }

  /**
   * Refuses to start a sandbox while the job has a FUSE mount (a Cloud
   * Storage volume) that neither `hide` nor `visibleMounts` names: the
   * sandbox's root is the job's filesystem, so it could read the volume.
   */
  private async checkMounts(): Promise<void> {
    if (this.mountsChecked) return;
    const table = await readFile("/proc/self/mounts", "utf8").catch(() => null);
    if (table !== null) {
      const exposed = exposedMounts(table, [...(this.opts.hide ?? []), ...(this.opts.visibleMounts ?? [])]);
      if (exposed.length > 0) {
        throw new Error(
          `Sandboxes would see the job's mounted ${exposed.join(", ")}; add each to hide, or to visibleMounts if they may`,
        );
      }
    }
    this.mountsChecked = true;
  }

  /** Signals a command started by `exec`, waiting briefly for its pid file. */
  private async signal(sandboxId: string, pidFile: string, signal: "TERM" | "KILL"): Promise<void> {
    const script = `i=0; while [ ! -s "$1" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done; [ -s "$1" ] && kill -${signal} "$(cat "$1")"; true`;
    await this.cli(this.execArgs(sandboxId, ["/bin/sh", "-c", script, "sh", pidFile]), {
      check: false,
    }).catch(() => {});
  }

  /** Waits until a new sandbox runs commands. */
  private async waitReady(sandboxId: string): Promise<void> {
    const started = Date.now();
    for (;;) {
      const result = await this.cli(["exec", sandboxId, "--", "/bin/sh", "-c", "true"], { check: false });
      if (result.code === 0) return;
      if (Date.now() - started > 15_000) {
        throw new SandboxCliError(["exec"], result.code, result.signal, result.stderr);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private cli(
    args: string[],
    options: { input?: NodeJS.ReadableStream; check?: boolean } = {},
  ): Promise<CliResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, {
        stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
        env: this.cliEnvironment(),
      });
      const stdout: Buffer[] = [];
      let size = 0;
      let overflow = false;
      let stderr = "";
      // Piped above; the union-typed stdio hides that from the spawn overloads.
      child.stdout!.on("data", (d: Buffer) => {
        size += d.length;
        if (size > MAX_CLI_OUTPUT) {
          overflow = true;
          child.kill("SIGKILL");
        } else {
          stdout.push(d);
        }
      });
      child.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr = `${stderr}${d}`.slice(-16_384)));
      if (options.input && child.stdin) {
        child.stdin.on("error", () => {});
        options.input.pipe(child.stdin);
      }
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (overflow) {
          reject(new Error(`sandbox ${args[0]} wrote more than ${MAX_CLI_OUTPUT} bytes`));
          return;
        }
        const result = { code, signal, stdout: Buffer.concat(stdout), stderr };
        if (options.check !== false && code !== 0) {
          reject(new SandboxCliError(args, code, signal, stderr));
        } else {
          resolve(result);
        }
      });
    });
  }

  /** Runs the CLI with its stdout going to `file`, killing it past `maxBytes`. */
  private cliToFile(args: string[], file: string, maxBytes: number): Promise<{ stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, { stdio: ["ignore", "pipe", "pipe"], env: this.cliEnvironment() });
      const out = createWriteStream(file, { flags: "wx" });
      let size = 0;
      let overflow = false;
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => {
        size += d.length;
        if (size > maxBytes) {
          overflow = true;
          child.kill("SIGKILL");
        }
      });
      child.stdout.pipe(out);
      child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr = `${stderr}${d}`.slice(-16_384)));
      child.on("error", reject);
      const written = new Promise<void>((done, fail) => {
        out.on("finish", done);
        out.on("error", fail);
      });
      child.on("close", () => {
        written.then(
          () =>
            overflow
              ? reject(new Error(`The download is larger than ${maxBytes} bytes`))
              : resolve({ stderr }),
          reject,
        );
      });
    });
  }
}
