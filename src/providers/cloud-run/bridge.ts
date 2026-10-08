// The job's end of the stdio bridge (see bridge-peer.ts for the sandbox's).
// It keeps one shim running in the sandbox through a long-lived `sandbox exec`
// with stdin and stdout piped, turns each connection the shim accepts into a
// Duplex for `onConnection` (the in-process gateway's `connect`), starts the
// shim again if its exec ends, and stops it when the run is over.
//
// What arrives on the shim's stdout comes from the sandbox, so it is treated
// as hostile: frames are capped, streams are capped, a stream id is used
// once, and reading stops while the gateway is not keeping up. A shim that
// breaks the protocol is killed, and started again only a few times a minute.

import { Duplex, type Readable, type Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { DATA, END, OPEN, encodeData, encodeFrame, readFrames } from "./frames.ts";

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
  /** Wait before the first restart, doubled for each restart in the last minute. Default 250 ms. */
  restartMs?: number;
  /**
   * Restarts allowed within a minute. Once a shim has been restarted this many
   * times in a minute the bridge stays down for the rest of the sandbox's life.
   * Default 10.
   */
  maxRestartsPerMinute?: number;
  /** Streams open at once; one more is a protocol error. Default 64. */
  maxStreams?: number;
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
function attach(
  child: BridgeProcess,
  onConnection: (stream: Duplex) => void,
  maxStreams: number,
  violate: (reason: string) => void,
) {
  const streams = new Map<number, Duplex>();
  // Streams whose reader is behind; the shim's stdout is paused while any is.
  const behind = new Set<number>();
  // Ids only grow, so one number replaces a set of every id the shim used.
  let lastId = 0;
  const shimEnded = new Set<number>();
  let dead = false;
  const write = (frame: Buffer, done?: (error?: Error | null) => void) => {
    if (dead) return done?.(new Error("The bridge's shim has stopped"));
    child.stdin.write(frame, done);
  };
  const caughtUp = (id: number) => {
    if (behind.delete(id) && behind.size === 0 && !dead) child.stdout.resume();
  };
  const stop = (reason?: string) => {
    if (dead) return;
    dead = true;
    child.stdout.pause();
    for (const stream of streams.values()) stream.destroy();
    streams.clear();
    behind.clear();
    if (reason) violate(reason);
  };

  readFrames(
    child.stdout,
    (type, id, payload) => {
      if (dead) return;
      if (type === OPEN) {
        if (id <= lastId) return stop(`the shim reused stream ${id}`);
        if (streams.size >= maxStreams) return stop(`the shim opened more than ${maxStreams} streams`);
        lastId = id;
        let ended = false;
        const stream = new Duplex({
          allowHalfOpen: true,
          read() {
            caughtUp(id);
          },
          write(chunk: Buffer, _encoding, done) {
            write(encodeData(id, chunk), done);
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
            shimEnded.delete(id);
            caughtUp(id);
            done(error);
          },
        });
        streams.set(id, stream);
        onConnection(stream);
      } else if (type === DATA || type === END) {
        // A stream already closed on this side, or ended by the shim, may still
        // get a frame or two; they are dropped, never pushed after the end.
        const stream = streams.get(id);
        if (!stream || stream.destroyed || stream.readableEnded || shimEnded.has(id)) return;
        if (type === END) {
          shimEnded.add(id);
          stream.push(null);
        } else if (!stream.push(payload) && !behind.has(id)) {
          behind.add(id);
          child.stdout.pause();
        }
      } else {
        stop(`the shim sent a frame of unknown type ${type}`);
      }
    },
    (error) => stop(error.message),
  );
  child.stdin.on("error", () => {});

  return { streams, stop: () => stop() };
}

/** Starts the shim and resolves once it listens in the sandbox. */
export async function startBridge(options: StartBridgeOptions): Promise<Bridge> {
  const command = [...(options.command ?? defaultShimCommand()), String(options.port)];
  const readyTimeoutMs = options.readyTimeoutMs ?? 15_000;
  const restartMs = options.restartMs ?? 250;
  const maxRestarts = options.maxRestartsPerMinute ?? 10;
  const maxStreams = options.maxStreams ?? 64;
  const log = options.log ?? (() => {});
  let closed = false;
  let restarts = 0;
  // When recent restarts happened, for the backoff and the cap.
  let recent: number[] = [];
  let current: (ReturnType<typeof attach> & { child: BridgeProcess }) | null = null;
  let timer: NodeJS.Timeout | undefined;

  /** Starts one shim; resolves when it is ready, rejects (and kills it) if it is not. */
  const launch = (): Promise<void> => {
    const child = options.open(command);
    const link = {
      child,
      ...attach(child, options.onConnection, maxStreams, (reason) => {
        log(`bridge shim killed: ${reason}`);
        child.kill();
      }),
    };
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
      const now = Date.now();
      recent = recent.filter((at) => now - at < 60_000);
      if (recent.length >= maxRestarts) {
        log(`bridge shim restarted ${recent.length} times in a minute; not starting it again`);
        return;
      }
      const delayMs = Math.min(restartMs * 2 ** recent.length, 5_000);
      recent.push(now);
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
