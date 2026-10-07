// Runs one claimed run to completion in a sandbox and relays what happens to an
// EventSink. Everything platform-specific is injected — the sandbox provider,
// the run-token grant and the resource sampler — so the CLI prints to stdout,
// a service writes to its store, and the tests drive the whole loop with fakes.
//
// This file never calls docker, a store or the gateway directly.

import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createEventParser } from "../../contract/events.ts";
import type {
  FinalRunStatus,
  RunEvent,
  RunLimits,
  RunSample,
  RunUsage,
} from "../../contract/events.ts";
import { answerText, foldRunEvents } from "../../contract/fold.ts";

import type { SandboxProvider } from "./sandbox-provider.ts";

/** How the run looks to whoever is storing it, answered on every append. */
export type SinkState = {
  /** Someone asked for the run to stop. */
  cancelled: boolean;
  /** The run is no longer there to write to: deleted, or already finished. */
  gone: boolean;
};

export const LIVE: SinkState = { cancelled: false, gone: false };

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
  usage?: (sandboxId: string) => Promise<{ cpu: number; memoryMb: number } | null>;
  /** Cancels the run from outside, e.g. when the dispatcher is shutting down. */
  signal?: AbortSignal;
  batchMs?: number;
  batchEvents?: number;
  sampleMs?: number;
  /** How many times a failed batch is re-sent before the run is abandoned. */
  retries?: number;
  retryMs?: number;
};

const BATCH_MS = 150;
const BATCH_EVENTS = 25;
const SAMPLE_MS = 1000;
const SAMPLES_PER_FLUSH = 5;
const RETRIES = 4;
const RETRY_MS = 250;
const STDERR_TAIL = 2_000;

const MEDIA_TYPES: Record<string, string> = {
  ".csv": "text/csv",
  ".json": "application/json",
  ".md": "text/markdown",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".py": "text/x-python",
  ".sql": "application/sql",
};

export function mediaTypeFor(fileName: string): string {
  return MEDIA_TYPES[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

/** Merges consecutive text deltas, which the UI concatenates anyway. */
export function coalesce(batch: readonly RunEvent[]): RunEvent[] {
  const out: RunEvent[] = [];
  for (const event of batch) {
    const last = out.at(-1);
    if (last?.type === "text_delta" && event.type === "text_delta") {
      last.payload = { delta: `${String(last.payload.delta)}${String(event.payload.delta)}` };
    } else {
      out.push({ ...event, payload: { ...event.payload } });
    }
  }
  return out;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Checked before anything is built, so a bad path costs nothing. */
async function checkMounts(mounts: readonly Mount[]): Promise<void> {
  for (const mount of mounts) {
    const info = await stat(mount.localDir).catch(() => null);
    if (!info?.isDirectory()) throw new Error(`Nothing to mount at ${mount.localDir}.`);
  }
}

/** Pushes a mount and fails loudly if an uploaded file differs. */
async function uploadMount(
  provider: SandboxProvider,
  sandboxId: string,
  mount: Mount,
): Promise<void> {
  await provider.upload(sandboxId, mount.localDir, mount.remoteDir);
  for (const [file, expected] of Object.entries(mount.verify ?? {})) {
    const remotePath = path.posix.join(mount.remoteDir, file);
    let sum = "";
    await provider.exec(sandboxId, ["sha256sum", remotePath], {
      timeoutMs: 60_000,
      onStdout: (d) => (sum += d),
    }).done;
    if (sum.trim().split(" ")[0] !== expected) {
      throw new Error(`${remotePath} did not upload intact`);
    }
  }
}

export async function executeRun(opts: ExecuteRunOptions): Promise<RunOutcome> {
  const { provider, sink, tokens, runId, limits } = opts;
  const batchMs = opts.batchMs ?? BATCH_MS;
  const batchEvents = opts.batchEvents ?? BATCH_EVENTS;
  const retries = opts.retries ?? RETRIES;
  const retryMs = opts.retryMs ?? RETRY_MS;

  const { sandboxId, created } = await openSandbox(opts);
  let status: FinalRunStatus = "failed";
  let error: string | undefined;
  const log: RunEvent[] = [];

  try {
    // Inside the try, so a failing hook still pauses or destroys the sandbox.
    await opts.onSandbox?.(sandboxId, created);
    const token = await tokens.grant(runId, limits.wallClockMs + 60_000);
    let cancelled = false;
    let gone = false;
    let pending: RunEvent[] = [];
    let lastFlush = Date.now();
    let flushing: Promise<void> = Promise.resolve();
    let lastSeq = -1;
    let stderr = "";

    const note = (state: SinkState) => {
      if (state.cancelled) cancelled = true;
      if (state.gone) gone = true;
    };

    // A batch that fails is re-sent unchanged, so its seqs repeat exactly and
    // a sink that dedupes on seq skips what it already stored. Giving up leaves
    // the run to its heartbeat, which the deployment's reaper will fail.
    const send = async (batch: RunEvent[]): Promise<void> => {
      for (let attempt = 0; ; attempt++) {
        try {
          note(await sink.events(batch));
          return;
        } catch (cause) {
          if (attempt >= retries) {
            sink.log(`giving up on ${batch.length} event(s): ${String(cause)}`);
            gone = true;
            return;
          }
          sink.log(`retrying ${batch.length} event(s): ${String(cause)}`);
          await new Promise((resolve) => setTimeout(resolve, retryMs * 2 ** attempt));
        }
      }
    };

    // One batch is in flight at a time, so events reach the sink in seq order.
    const flush = (): Promise<void> => {
      flushing = flushing.then(async () => {
        const batch = pending;
        pending = [];
        lastFlush = Date.now();
        if (batch.length > 0 && !gone) await send(coalesce(batch));
      });
      return flushing;
    };

    const add = (event: RunEvent) => {
      lastSeq = Math.max(lastSeq, event.seq);
      log.push(event);
      pending.push(event);
      if (pending.length >= batchEvents || Date.now() - lastFlush >= batchMs) void flush();
    };

    // An output is copied out and stored while the run continues; the event
    // then lands with its artifactId, still carrying the seq the runner gave
    // it, so the stored log stays in the order the agent produced it.
    let outputs: Promise<void> = Promise.resolve();
    const parse = createEventParser(
      (event) => {
        if (event.type !== "artifact") {
          add(event);
          return;
        }
        outputs = outputs.then(async () => {
          const artifactId = await upload(opts, sandboxId, event);
          add({ ...event, payload: { ...event.payload, artifactId } });
          await flush();
        });
      },
      (line) => sink.log(line),
    );

    const handle = provider.exec(sandboxId, opts.command, {
      env: {
        PROMPT: opts.prompt,
        RUN_ID: runId,
        RUN_LIMITS: JSON.stringify(limits),
        ...opts.env,
        LLM_API_KEY: token,
      },
      timeoutMs: limits.wallClockMs,
      onStdout: parse,
      onStderr: (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-STDERR_TAIL);
        sink.log(chunk.trimEnd());
      },
    });

    const stop = () => {
      cancelled = true;
      void handle.kill();
    };
    opts.signal?.addEventListener("abort", stop, { once: true });

    // The ticker does the work that cannot wait for the runner to write a line:
    // time-based flushes, resource samples, and noticing a cancel.
    const ticker = setInterval(() => {
      if (pending.length > 0 && Date.now() - lastFlush >= batchMs) void flush();
      if (cancelled) stop();
    }, batchMs);
    const sampler = startSampler(opts, sandboxId);

    try {
      const exitCode = await handle.done;
      clearInterval(ticker);
      await sampler.stop();
      await outputs;
      await flush();

      const finished = log.findLast((event) => event.type === "run_finished");
      if (cancelled) {
        status = "cancelled";
      } else if (finished) {
        status = (str(finished.payload.status) as FinalRunStatus | null) ?? "succeeded";
        error = str(finished.payload.error) ?? undefined;
      } else if (exitCode === 124) {
        status = "failed";
        error = `The run hit its ${Math.round(limits.wallClockMs / 60_000)} minute time limit.`;
      } else {
        status = "failed";
        error = stderr.trim().split("\n").at(-1) ?? `The runner exited with ${exitCode}.`;
      }
      // The runner cannot report its own cancel or crash, so the log gets the
      // ending the UI needs, numbered after whatever it did write.
      if (!finished || cancelled) {
        add({
          seq: lastSeq + 1,
          ts: new Date().toISOString(),
          type: "run_finished",
          payload: { status, error },
        });
      }
      await flush();
    } finally {
      clearInterval(ticker);
      await sampler.stop();
      opts.signal?.removeEventListener("abort", stop);
      await tokens.revoke(token).catch(() => {});
    }
  } finally {
    if (opts.keepSandbox) await provider.pause(sandboxId).catch(() => {});
    else await provider.destroy(sandboxId).catch(() => {});
  }

  const view = foldRunEvents(log, status);
  return {
    sandboxId,
    created,
    status,
    error,
    answerText: answerText(view),
    usage: view.usage,
    events: log,
  };
}

/** Continues the thread's sandbox when it is still there, or builds a new one. */
async function openSandbox(
  opts: ExecuteRunOptions,
): Promise<{ sandboxId: string; created: boolean }> {
  const { provider, sink } = opts;
  if (opts.resumeSandboxId) {
    try {
      await provider.resume(opts.resumeSandboxId);
      sink.log(`resumed sandbox ${opts.resumeSandboxId}`);
      return { sandboxId: opts.resumeSandboxId, created: false };
    } catch (cause) {
      sink.log(`sandbox ${opts.resumeSandboxId} could not be resumed: ${String(cause)}`);
    }
  }
  // Checked before creating anything: a run whose mounts this host does not
  // have must not cost a container.
  const mounts = opts.mounts ?? [];
  await checkMounts(mounts);
  const sandboxId = await provider.create({
    image: opts.image,
    limits: { cpus: opts.limits.cpus, memoryMb: opts.limits.memoryMb, pids: 512 },
    labels: opts.labels,
  });
  try {
    for (const mount of mounts) await uploadMount(provider, sandboxId, mount);
    sink.log(`created sandbox ${sandboxId}`);
  } catch (cause) {
    await provider.destroy(sandboxId).catch(() => {});
    throw cause;
  }
  return { sandboxId, created: true };
}

/** Copies one output out of the sandbox, stores it, and returns its id. */
async function upload(
  opts: ExecuteRunOptions,
  sandboxId: string,
  event: RunEvent,
): Promise<string | null> {
  const remotePath = str(event.payload.path);
  if (!remotePath) return null;
  const fileName = path.posix.basename(remotePath);
  try {
    const dir = await mkdtemp(path.join(tmpdir(), "agent-runtime-output-"));
    await opts.provider.download(sandboxId, remotePath, dir);
    const bytes = await readFile(path.join(dir, fileName));
    return await opts.sink.artifact({
      fileName,
      kind: str(event.payload.kind) ?? "report",
      caption: str(event.payload.caption) ?? "",
      mediaType: mediaTypeFor(fileName),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
      bytes,
    });
  } catch (cause) {
    // A missing file must not lose the run: the event still lands, undownloaded.
    opts.sink.log(`could not store ${remotePath}: ${String(cause)}`);
    return null;
  }
}

/** Samples the sandbox once a second and flushes in small batches. */
function startSampler(opts: ExecuteRunOptions, sandboxId: string): { stop: () => Promise<void> } {
  if (!opts.usage) return { stop: async () => {} };
  let buffer: RunSample[] = [];
  const send = async () => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    await opts.sink.samples(batch).catch(() => {});
  };
  const timer = setInterval(() => {
    void opts.usage?.(sandboxId).then(
      (sample) => {
        if (!sample) return;
        buffer.push({ atMs: Date.now(), ...sample });
        if (buffer.length >= SAMPLES_PER_FLUSH) void send();
      },
      () => {},
    );
  }, opts.sampleMs ?? SAMPLE_MS);
  return {
    stop: async () => {
      clearInterval(timer);
      await send();
    },
  };
}
