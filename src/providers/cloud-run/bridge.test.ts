import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { startBridge, type Bridge, type BridgeProcess } from "./bridge.ts";

// The shim runs on this host here, as it would in the sandbox: its loopback
// port stands for the sandbox's.

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const spawned: ReturnType<typeof spawn>[] = [];
function open(command: string[]): BridgeProcess {
  const child = spawn(command[0]!, command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
  spawned.push(child);
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    exited: new Promise((resolve) => child.on("close", resolve)),
    kill: () => child.kill("SIGKILL"),
  };
}

const big = Buffer.alloc(1024 * 1024);
for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 251;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Stands in for the gateway: a large body, an upload's hash, or paced SSE. */
function target(): Server {
  return createServer((req, res) => {
    if (req.url === "/big") return void res.end(big);
    if (req.url === "/echo") {
      const hash = createHash("sha256");
      req.on("data", (d: Buffer) => hash.update(d));
      req.on("end", () => res.end(hash.digest("hex")));
      return;
    }
    if (req.url === "/sse") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      let i = 0;
      const timer = setInterval(() => {
        res.write(`data: ${i}\n\n`);
        if (++i === 5) {
          clearInterval(timer);
          res.end();
        }
      }, 80);
      return;
    }
    res.end("pong");
  });
}

function call(port: number, path: string, body?: Buffer) {
  return new Promise<{ body: Buffer; arrivals: number[] }>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: body ? "POST" : "GET", agent: false },
      (res) => {
        const started = Date.now();
        const chunks: Buffer[] = [];
        const arrivals: number[] = [];
        res.on("data", (d: Buffer) => {
          chunks.push(d);
          arrivals.push(Date.now() - started);
        });
        res.on("end", () => resolve({ body: Buffer.concat(chunks), arrivals }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

let bridge: Bridge | undefined;
afterEach(async () => {
  await bridge?.close();
  bridge = undefined;
  for (const child of spawned.splice(0)) child.kill("SIGKILL");
});

describe("startBridge", { timeout: 30_000 }, () => {
  it("carries every byte both ways, several streams at once, and SSE as it is sent", async () => {
    const port = await freePort();
    const server = target();
    bridge = await startBridge({ open, port, onConnection: (s) => server.emit("connection", s) });

    expect((await call(port, "/ping")).body.toString()).toBe("pong");
    const [a, b, c, d] = await Promise.all([1, 2, 3, 4].map(() => call(port, "/big")));
    for (const r of [a, b, c, d]) expect(sha(r!.body)).toBe(sha(big));
    expect((await call(port, "/echo", big)).body.toString()).toBe(sha(big));
    const sse = await call(port, "/sse");
    expect(sse.body.toString().match(/data:/g)).toHaveLength(5);
    expect(sse.arrivals.at(-1)! - sse.arrivals[0]!).toBeGreaterThan(200);
  });

  it("starts the shim again when it dies, and stops it on close", async () => {
    const port = await freePort();
    const server = target();
    const lines: string[] = [];
    bridge = await startBridge({
      open,
      port,
      onConnection: (s) => server.emit("connection", s),
      restartMs: 50,
      log: (line) => lines.push(line),
    });
    spawned[0]!.kill("SIGKILL");
    let answer = "";
    for (let i = 0; i < 50 && answer !== "pong"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      answer = (await call(port, "/ping").catch(() => ({ body: Buffer.from("") }))).body.toString();
    }
    expect(answer).toBe("pong");
    expect(bridge.restarts).toBe(1);

    const last = spawned.at(-1)!;
    await bridge.close();
    // The shim exits on its own once its stdin ends.
    await new Promise((resolve) => (last.exitCode !== null ? resolve(null) : last.on("close", resolve)));
    expect(last.signalCode).toBeNull();
    await expect(call(port, "/ping")).rejects.toThrow();
  });

  it("fails when the shim cannot start", async () => {
    await expect(
      startBridge({
        open,
        port: await freePort(),
        onConnection: () => {},
        command: [process.execPath, "-e", "process.exit(3)"],
      }),
    ).rejects.toThrow("exited before it was ready");
  });
});
