// The job's end of the stdio bridge (see bridge-peer.ts for the sandbox's).
// It keeps one shim running in the sandbox through a long-lived `sandbox exec`
// with stdin and stdout piped, turns each connection the shim accepts into a
// Duplex for `onConnection` (the in-process gateway's `connect`), starts the
// shim again if its exec ends, and stops it when the run is over.

import { Duplex, type Readable, type Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { DATA, END, OPEN, encodeFrame, readFrames } from "./frames.ts";

/** A running shim's stdio, from `sandbox exec <id> -- node <shim> <port>` or anything like it. */
export type BridgeProcess = {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  /** Resolves when the process has exited. */
  exited: Promise<unknown>;
  /** Stops the process from this side. */
  kill: () => void;
};

export type StartBridgeOptions = {
  /** Starts one shim with this command, e.g. a provider's `openStream(sandboxId, command)`. */
  open: (command: string[]) => BridgeProcess;
  /** The port the shim listens on inside the sandbox; the runner's base URL is `http://127.0.0.1:<port>`. */
  port: number;
  /** Serves one tunnelled connection, e.g. `gateway.connect`. */
  onConnection: (stream: Duplex) => void;
  /** How to run the shim, before the port. Default: this package's `bridge-peer.js` under the job's node. */
  command?: string[];
  /** How long a shim has to print READY. Default 15 s. */
  readyTimeoutMs?: number;
  /** Wait before starting a shim again, doubled per failure up to 5 s. Default 250 ms. */
  restartMs?: number;
  log?: (message: string) => void;
};

export type Bridge = {
  /** How many times the shim has been started again. */
  readonly restarts: number;
  /** Streams currently open. */
  readonly open: number;
  /** Stops the shim and ends every stream; the bridge does not start again. */
  close: () => Promise<void>;
};

/**
 * The command that runs the shim this package ships. A Cloud Run sandbox's
 * root is the job container's own filesystem, so the job's node and its
 * installed copy of this package are at the same paths inside the sandbox.
 */
export function defaultShimCommand(): string[] {
  const self = import.meta.url;
  const shim = new URL(self.endsWith(".ts") ? "./bridge-peer.ts" : "./bridge-peer.js", self);
  return [process.execPath, fileURLToPath(shim)];
}

/** One shim's streams: each connection the shim accepted, by its id. */
function attach(child: BridgeProcess, onConnection: (stream: Duplex) => void) {
  const streams = new Map<number, Duplex>();
  let dead = false;
  const write = (frame: Buffer, done?: (error?: Error | null) => void) => {
    if (dead) return done?.(new Error("The bridge's shim has stopped"));
    child.stdin.write(frame, done);
  };

  readFrames(child.stdout, (type, id, payload) => {
    if (type === OPEN) {
      let ended = false;
      const stream = new Duplex({
        allowHalfOpen: true,
        read() {},
        write(chunk: Buffer, _encoding, done) {
          write(encodeFrame(DATA, id, chunk), done);
        },
        final(done) {
          ended = true;
          write(encodeFrame(END, id));
          done();
        },
        destroy(error, done) {
          if (!ended) write(encodeFrame(END, id));
          ended = true;
          streams.delete(id);
          done(error);
        },
      });
      streams.set(id, stream);
      onConnection(stream);
    } else if (type === DATA) {
      streams.get(id)?.push(payload);
    } else if (type === END) {
      streams.get(id)?.push(null);
    }
  });
  child.stdin.on("error", () => {});

  return {
    streams,
    stop: () => {
      dead = true;
      for (const stream of streams.values()) stream.destroy();
      streams.clear();
    },
  };
}

/** Starts the shim and resolves once it listens in the sandbox. */
export async function startBridge(options: StartBridgeOptions): Promise<Bridge> {
  const command = [...(options.command ?? defaultShimCommand()), String(options.port)];
  const readyTimeoutMs = options.readyTimeoutMs ?? 15_000;
  const restartMs = options.restartMs ?? 250;
  const log = options.log ?? (() => {});
  let closed = false;
  let restarts = 0;
  // Shims in a row that never got ready, for the backoff.
  let failures = 0;
  let current: (ReturnType<typeof attach> & { child: BridgeProcess }) | null = null;
  let timer: NodeJS.Timeout | undefined;

  /** Starts one shim; resolves when it is ready, rejects (and kills it) if it is not. */
  const launch = (): Promise<void> => {
    const child = options.open(command);
    const link = { child, ...attach(child, options.onConnection) };
    current = link;
    let stderr = "";
    let exited = false;
    // Whenever it exits, its streams end and, unless the bridge is closed, another starts.
    void child.exited.then(() => {
      exited = true;
      link.stop();
      if (current === link) current = null;
      if (closed) return;
      log(`bridge shim ended: ${stderr.trim().split("\n").at(-1) ?? ""}`);
      const delayMs = Math.min(restartMs * 2 ** failures, 5_000);
      timer = setTimeout(() => {
        if (closed) return;
        restarts += 1;
        launch().then(
          () => log(`bridge shim started again (${restarts})`),
          (error: unknown) => log(String(error)),
        );
      }, delayMs);
    });
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        failures += 1;
        if (!exited) child.kill();
        reject(new Error(`${message}: ${stderr.trim()}`));
      };
      const timeout = setTimeout(
        () => fail(`The bridge's shim was not ready after ${readyTimeoutMs} ms`),
        readyTimeoutMs,
      );
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-2_000);
        if (!settled && stderr.includes(`READY ${options.port}`)) {
          settled = true;
          clearTimeout(timeout);
          failures = 0;
          resolve();
        }
      });
      void child.exited.then(() => fail("The bridge's shim exited before it was ready"));
    });
  };

  try {
    await launch();
  } catch (error) {
    closed = true;
    throw error;
  }

  return {
    get restarts() {
      return restarts;
    },
    get open() {
      return current?.streams.size ?? 0;
    },
    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      const running = current;
      current = null;
      if (!running) return;
      running.stop();
      // The shim exits when its stdin ends; the exec is killed only if it does not.
      running.child.stdin.end();
      const exited = await Promise.race([
        running.child.exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000).unref()),
      ]);
      if (!exited) running.child.kill();
    },
  };
}
