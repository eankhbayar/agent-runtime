// Test doubles for the dispatcher: a sandbox whose runner is a script of stdout
// lines, and a sink that records what a run would have written.

import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { RunEvent, RunSample } from "../../contract/events.ts";

import type {
  ExecHandle,
  ExecOptions,
  SandboxInfo,
  SandboxProvider,
  SandboxStatus,
} from "../dispatcher/sandbox-provider.ts";
import type { ArtifactUpload, EventSink, SinkState } from "../dispatcher/run.ts";

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

export class FakeSandboxProvider implements SandboxProvider {
  readonly calls: string[] = [];
  readonly execs: string[][] = [];
  killed = false;
  resumeFails = false;
  /** What `sha256sum` prints for every uploaded file a mount verifies. */
  uploadSha = "upload-hash";
  /** What `list` reports, for the reaper tests. */
  sandboxes: SandboxInfo[] = [];
  readonly destroyed: string[] = [];
  private state: SandboxStatus = "running";
  private next = 0;
  private readonly run: FakeRun;

  constructor(run: FakeRun = { stdout: [] }) {
    this.run = run;
  }

  async create(): Promise<string> {
    this.calls.push("create");
    this.state = "running";
    return `sbx-${++this.next}`;
  }

  async upload(): Promise<void> {
    this.calls.push("upload");
  }

  async download(_sandboxId: string, remotePath: string, localPath: string): Promise<void> {
    this.calls.push(`download ${remotePath}`);
    const body = this.run.files?.[remotePath];
    if (body === undefined) throw new Error(`No such file: ${remotePath}`);
    await writeFile(path.join(localPath, path.posix.basename(remotePath)), body);
  }

  exec(_sandboxId: string, command: string[], opts: ExecOptions = {}): ExecHandle {
    this.execs.push(command);
    if (command[0] === "sha256sum") {
      opts.onStdout?.(`${this.uploadSha}  ${command[1]}\n`);
      return { done: Promise.resolve(0), kill: async () => {} };
    }
    let stopped = false;
    const done = (async () => {
      for (const chunk of this.run.stdout) {
        if (stopped) break;
        await new Promise((resolve) => setTimeout(resolve, this.run.chunkMs ?? 0));
        if (stopped) break;
        opts.onStdout?.(chunk);
      }
      if (this.run.stderr) opts.onStderr?.(this.run.stderr);
      return stopped ? 143 : (this.run.exitCode ?? 0);
    })();
    return {
      done,
      kill: async () => {
        this.killed = true;
        stopped = true;
      },
    };
  }

  async pause(sandboxId: string): Promise<void> {
    this.calls.push("pause");
    this.setListed(sandboxId, "paused");
    this.state = "paused";
  }

  async stopCommands(sandboxId: string): Promise<void> {
    this.calls.push(`stop ${sandboxId}`);
  }

  async hostId(): Promise<string> {
    return "fake-host";
  }

  private setListed(sandboxId: string, status: SandboxStatus): void {
    this.sandboxes = this.sandboxes.map((s) => (s.sandboxId === sandboxId ? { ...s, status } : s));
  }

  async resume(sandboxId: string): Promise<void> {
    this.calls.push(`resume ${sandboxId}`);
    if (this.resumeFails) throw new Error("sandbox is gone");
    this.state = "running";
  }

  async destroy(sandboxId: string): Promise<void> {
    this.calls.push("destroy");
    this.destroyed.push(sandboxId);
    this.sandboxes = this.sandboxes.filter((s) => s.sandboxId !== sandboxId);
    this.state = "missing";
  }

  async status(): Promise<SandboxStatus> {
    return this.state;
  }

  async list(): Promise<SandboxInfo[]> {
    return this.sandboxes;
  }
}

export class FakeSink implements EventSink {
  readonly batches: RunEvent[][] = [];
  readonly storedSamples: RunSample[] = [];
  readonly uploads: ArtifactUpload[] = [];
  readonly lines: string[] = [];
  state: SinkState = { cancelled: false, gone: false };
  /** Rejects this many of the next `events` calls, as a dropped connection does. */
  failNext = 0;

  /** Every event the run sent, in the order the sink saw it. */
  get sent(): RunEvent[] {
    return this.batches.flat();
  }

  events = async (batch: RunEvent[]): Promise<SinkState> => {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("connection lost");
    }
    this.batches.push(batch);
    return this.state;
  };

  samples = async (samples: RunSample[]): Promise<void> => {
    this.storedSamples.push(...samples);
  };

  artifact = async (upload: ArtifactUpload): Promise<string> => {
    this.uploads.push(upload);
    return `artifact-${this.uploads.length}`;
  };

  log = (message: string): void => {
    this.lines.push(message);
  };
}

/** One JSON line as the in-sandbox runner writes it. */
export function line(
  seq: number,
  type: RunEvent["type"],
  payload: Record<string, unknown>,
): string {
  return `${JSON.stringify({ seq, ts: new Date(Date.UTC(2026, 8, 16, 0, 0, seq)).toISOString(), type, payload })}\n`;
}
