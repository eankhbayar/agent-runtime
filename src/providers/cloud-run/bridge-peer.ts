// The sandbox's end of the stdio bridge. A Cloud Run sandbox started without
// --allow-egress has no network, and nothing the job listens on is reachable
// from it, but its own loopback works and so does a long-lived `sandbox exec`'s
// stdin and stdout. So this shim listens on 127.0.0.1:<port> in the sandbox and
// carries each connection to the job as frames (frames.ts) over its stdio; the
// job serves each one with its in-process gateway.
//
//   node bridge-peer.js <port>
//
// It prints `READY <port>` on stderr once it listens, writes only frames to
// stdout, and exits when its stdin ends. It runs from the installed package
// with plain node, so it uses Node built-ins only.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";

import { DATA, END, OPEN, encodeData, encodeFrame, readFrames } from "./frames.ts";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  console.error("usage: bridge-peer <port>");
  process.exit(2);
}

const pidFile = `/tmp/agent-runtime-bridge-${port}.pid`;
const sockets = new Map<number, Socket>();
const out = process.stdout;
out.setMaxListeners(0);
let next = 1;

function send(frame: Buffer, from?: Socket): void {
  if (!out.write(frame) && from && !from.isPaused()) {
    from.pause();
    out.once("drain", () => from.resume());
  }
}

readFrames(
  process.stdin,
  (type, id, payload) => {
    const socket = sockets.get(id);
    if (type === DATA) socket?.write(payload);
    else if (type === END) socket?.end();
  },
  (error) => {
    console.error(`bridge-peer: ${error.message}`);
    process.exit(1);
  },
);

// The job ended the bridge, or its `sandbox exec` went away.
process.stdin.on("end", () => {
  for (const socket of sockets.values()) socket.destroy();
  try {
    if (readFileSync(pidFile, "utf8") === String(process.pid)) rmSync(pidFile);
  } catch {}
  process.exit(0);
});

// Half-open, so a client that ends its request still gets the response.
const server = createServer({ allowHalfOpen: true, noDelay: true }, (socket) => {
  const id = next++;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    send(encodeFrame(END, id));
  };
  sockets.set(id, socket);
  send(encodeFrame(OPEN, id));
  socket.on("data", (chunk: Buffer) => send(encodeData(id, chunk), socket));
  socket.on("end", end);
  socket.on("error", () => {});
  socket.on("close", () => {
    end();
    sockets.delete(id);
  });
});

function listen(attempt: number): void {
  server.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EADDRINUSE" || attempt >= 20) {
      console.error(`bridge-peer: ${error.message}`);
      process.exit(1);
    }
    // A shim whose `sandbox exec` ended without stopping it still has the port.
    try {
      const old = Number(readFileSync(pidFile, "utf8"));
      if (old && old !== process.pid) process.kill(old, "SIGTERM");
    } catch {}
    setTimeout(() => listen(attempt + 1), 250);
  });
  server.listen(port, "127.0.0.1", () => {
    writeFileSync(pidFile, String(process.pid));
    console.error(`READY ${port}`);
  });
}

listen(0);
