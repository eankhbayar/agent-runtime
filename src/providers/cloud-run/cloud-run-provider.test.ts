import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createInProcessGateway } from "../../core/gateway.ts";
import { createFakeSandboxCli, type FakeSandboxCli } from "../../testing/fake-sandbox.ts";
import { startFakeUpstream } from "../../testing/fake-upstream.ts";
import { CloudRunSandboxProvider, exposedMounts, type CloudRunSandboxOptions } from "./cloud-run-provider.ts";

const LIMITS = { cpus: 1, memoryMb: 512, pids: 64 };

let cli: FakeSandboxCli;
beforeEach(async () => {
  cli = await createFakeSandboxCli();
});
afterEach(async () => {
  await cli.cleanup();
});

function provider(overrides: Partial<CloudRunSandboxOptions> = {}) {
  return new CloudRunSandboxProvider({
    namespace: "test",
    sandboxBin: cli.bin,
    stateDir: cli.stateDir,
    killGraceMs: 2_000,
    ...overrides,
  });
}

async function run(
  p: CloudRunSandboxProvider,
  id: string,
  command: string[],
  options: { env?: Record<string, string>; timeoutMs?: number } = {},
) {
  let stdout = "";
  let stderr = "";
  const code = await p.exec(id, command, {
    ...options,
    onStdout: (d) => (stdout += d),
    onStderr: (d) => (stderr += d),
  }).done;
  return { code, stdout, stderr };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe("CloudRunSandboxProvider", { timeout: 30_000 }, () => {
  it("starts a sandbox with no way out but its workspace, and binds mounts read-only", async () => {
    const data = await mkdtemp(path.join(tmpdir(), "agent-runtime-data-"));
    const sessions = await mkdtemp(path.join(tmpdir(), "agent-runtime-sessions-"));
    const p = provider({ hide: [sessions] });
    const id = await p.create({
      image: "ignored",
      limits: LIMITS,
      binds: [{ localDir: data, remoteDir: "/data/snapshot" }],
    });

    expect(id).toMatch(/^test-sbx-[0-9a-f]{12}$/);
    const runCall = (await cli.calls()).find((args) => args[0] === "run")!;
    expect(runCall).not.toContain("--allow-egress");
    expect(runCall.some((arg) => arg === "--publish" || arg === "-p")).toBe(false);
    const { binds } = await cli.config(id);
    expect(binds).toEqual([
      { source: path.join(cli.stateDir, id, "workspace"), destination: "/workspace", readonly: false },
      { source: data, destination: "/data/snapshot", readonly: true },
      // A sandbox's root is the job's filesystem, so what it must not read is covered over.
      { source: path.join(cli.stateDir, id, "empty"), destination: sessions, readonly: true },
    ]);
    expect(await p.status(id)).toBe("running");
    expect((await p.list()).map((s) => s.sandboxId)).toEqual([id]);
  });

  it("reads the exit code from the marker, which the CLI itself loses", async () => {
    const p = provider();
    const id = await p.create({ image: "", limits: LIMITS });

    const failed = await run(p, id, ["sh", "-c", "echo partial; echo oops >&2; exit 7"]);
    expect(failed).toEqual({ code: 7, stdout: "partial\n", stderr: "oops\n" });
    expect(await run(p, id, ["sh", "-c", "printf 'no newline'"])).toMatchObject({
      code: 0,
      stdout: "no newline",
    });
    expect((await run(p, id, ["no-such-command"])).code).toBe(127);
  });

  it("gives a command only the environment it is passed", async () => {
    process.env.AGENT_RUNTIME_TEST_SECRET = "must-not-reach-the-sandbox";
    try {
      const p = provider();
      const id = await p.create({ image: "", limits: LIMITS });
      const { stdout } = await run(p, id, ["sh", "-c", "env; pwd"], {
        env: { PROMPT: "line one\nline two", RUN_ID: "run_1" },
      });
      expect(stdout).not.toContain("AGENT_RUNTIME_TEST_SECRET");
      expect(stdout).toContain("PROMPT=line one\nline two");
      expect(stdout).toContain("RUN_ID=run_1");
      expect(stdout).toContain("PATH=/usr/local/sbin:");
      // The working directory is the workspace.
      expect(stdout.trim().split("\n").at(-1)).toContain(path.join(id, "workspace"));
      await expect(
        p.exec(id, ["true"], { env: { PROMPT: "x".repeat(200_000) } }).done,
      ).rejects.toThrow(/too long for sandbox exec/);
    } finally {
      delete process.env.AGENT_RUNTIME_TEST_SECRET;
    }
  });

  it("caps memory and processes in every command", async () => {
    const p = provider({ memoryHeadroomMb: 1024 });
    const id = await p.create({ image: "", limits: LIMITS });
    await run(p, id, ["true"]);
    const script = (await cli.calls()).filter((args) => args[0] === "exec").at(-1)!.join(" ");
    expect(script).toContain(`ulimit -v ${(512 + 1024) * 1024}`);
    expect(script).toContain("ulimit -p 64");
  });

  it("ends a command at its timeout with 124, and a killed one with 143", async () => {
    const p = provider();
    const id = await p.create({ image: "", limits: LIMITS });
    const started = Date.now();
    expect((await run(p, id, ["sleep", "30"], { timeoutMs: 300 })).code).toBe(124);
    expect(Date.now() - started).toBeLessThan(5_000);

    const workspace = path.join(cli.stateDir, id, "workspace");
    const handle = p.exec(id, ["sh", "-c", "echo $$ > /workspace/pid; exec sleep 30"]);
    for (let i = 0; i < 50 && !(await stat(path.join(workspace, "pid")).catch(() => null)); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await handle.kill();
    expect(await handle.done).toBe(143);
    // Killing the CLI alone would have left it running; the pid file reached the command.
    const pid = Number(await readFile(path.join(workspace, "pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("uploads and downloads through the shared workspace and through tar", async () => {
    const p = provider();
    const id = await p.create({ image: "", limits: LIMITS });
    const local = await mkdtemp(path.join(tmpdir(), "agent-runtime-upload-"));
    await mkdir(path.join(local, "sub"));
    await writeFile(path.join(local, "sub", "a.txt"), "alpha\n");

    await p.upload(id, local, "/workspace/in");
    expect(await readFile(path.join(cli.stateDir, id, "workspace", "in", "sub", "a.txt"), "utf8")).toBe(
      "alpha\n",
    );
    // Outside every bind, so it goes through tar over `sandbox exec`'s stdin.
    await p.upload(id, local, "/tmp/staged");
    expect((await run(p, id, ["cat", "/tmp/staged/sub/a.txt"])).stdout).toBe("alpha\n");

    const out = await mkdtemp(path.join(tmpdir(), "agent-runtime-download-"));
    await p.download(id, "/workspace/in/sub/a.txt", out);
    expect(await readFile(path.join(out, "a.txt"), "utf8")).toBe("alpha\n");
    await p.download(id, "/tmp/staged", out);
    expect(await readFile(path.join(out, "staged", "sub", "a.txt"), "utf8")).toBe("alpha\n");
    await expect(p.download(id, "/workspace/missing", out)).rejects.toThrow();
    await expect(p.download(id, "/tmp/missing", out)).rejects.toThrow();
  });

  it("cannot pause or resume, and forgets a destroyed sandbox", async () => {
    const p = provider();
    const id = await p.create({ image: "", limits: LIMITS });
    await expect(p.pause(id)).rejects.toThrow(/cannot be paused/);
    await expect(p.resume(id)).rejects.toThrow(/cannot be resumed/);
    await p.destroy(id);
    expect(await p.status(id)).toBe("missing");
    expect(await p.list()).toEqual([]);
    expect(await cli.sandboxes()).toEqual([]);
    expect(await stat(path.join(cli.stateDir, id)).catch(() => null)).toBeNull();
    // A second destroy, as executeRun's cleanup may do, is not an error.
    await p.destroy(id);
  });

  it("names the Cloud Run execution as its host", async () => {
    const saved = { ...process.env };
    Object.assign(process.env, {
      CLOUD_RUN_EXECUTION: "worker-abc12",
      CLOUD_RUN_TASK_INDEX: "0",
      CLOUD_RUN_TASK_ATTEMPT: "1",
    });
    try {
      expect(await provider().hostId()).toBe("worker-abc12/0/1");
      expect(await provider({ hostId: "fixed" }).hostId()).toBe("fixed");
    } finally {
      process.env = saved;
    }
  });

  it("bridges the sandbox's loopback to the in-process gateway, streaming as sent", async () => {
    const upstream = await startFakeUpstream({ apiKey: "sk-real", gapMs: 60 });
    const gateway = createInProcessGateway({ messagesUrl: upstream.messagesUrl, apiKey: "sk-real", log: () => {} });
    const port = await freePort();
    const p = provider({ bridge: { port, onConnection: gateway.connect } });
    const id = await p.create({ image: "", limits: LIMITS });
    try {
      const token = await gateway.grant("run_1", 60_000);
      // A client in the sandbox, as the runner's model client would be, timing each event.
      const client = `
        const started = Date.now();
        const res = await fetch(process.env.LLM_BASE_URL + "/v1/messages", {
          method: "POST",
          headers: { "x-api-key": process.env.LLM_API_KEY, "content-type": "application/json" },
          body: JSON.stringify({ model: "m", stream: true, messages: [] }),
        });
        const arrivals = [];
        let text = "";
        const decoder = new TextDecoder();
        for await (const chunk of res.body) {
          const s = decoder.decode(chunk);
          for (const _ of s.matchAll(/event: content_block_delta/g)) arrivals.push(Date.now() - started);
          text += s;
        }
        console.log(JSON.stringify({ status: res.status, arrivals, hello: text.includes('"text":"Hello "') }));
      `;
      const { code, stdout } = await run(
        p,
        id,
        [process.execPath, "--input-type=module", "-e", client],
        { env: { LLM_BASE_URL: p.bridgeUrl, LLM_API_KEY: token } },
      );
      expect(code).toBe(0);
      const result = JSON.parse(stdout) as { status: number; arrivals: number[]; hello: boolean };
      expect(result).toMatchObject({ status: 200, hello: true });
      // Five words 60 ms apart arrive spread out, not all at once at the end.
      expect(result.arrivals.length).toBe(5);
      expect(result.arrivals.at(-1)! - result.arrivals[0]!).toBeGreaterThan(150);
      // The upstream saw the provider key; the sandbox only ever had the run token.
      expect(upstream.requests[0]!.headers["x-api-key"]).toBe("sk-real");
      expect(token).not.toBe("sk-real");
    } finally {
      await p.destroy(id);
      await gateway.close();
      await upstream.close();
    }
  });

  it("starts the bridge's shim again when its exec ends", async () => {
    const port = await freePort();
    const seen: string[] = [];
    const echo = createServer((req, res) => {
      seen.push(req.url ?? "");
      res.end("pong");
    });
    const p = provider({
      bridge: { port, onConnection: (stream) => echo.emit("connection", stream) },
    });
    const id = await p.create({ image: "", limits: LIMITS });
    const ping = () =>
      new Promise<string>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path: `/ping-${seen.length}`, agent: false }, (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () => resolve(body));
        });
        req.on("error", reject);
        req.end();
      });
    try {
      expect(await ping()).toBe("pong");
      // The shim runs on this host under the fake, where its /tmp is this host's.
      const pidFile = `/tmp/agent-runtime-bridge-${port}.pid`;
      process.kill(Number(await readFile(pidFile, "utf8")), "SIGKILL");
      let answer = "";
      for (let i = 0; i < 40 && answer !== "pong"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        answer = await ping().catch(() => "");
      }
      expect(answer).toBe("pong");
    } finally {
      await p.destroy(id);
    }
  });
});

describe("CloudRunSandboxProvider, guarding the job", { timeout: 30_000 }, () => {
  it("runs the CLI with PATH and HOME, not the job's environment", async () => {
    process.env.AGENT_RUNTIME_TEST_SECRET = "job-secret";
    try {
      const p = provider({ cliEnv: { EXTRA: "1" } });
      const id = await p.create({ image: "", limits: LIMITS });
      await run(p, id, ["true"]);
      await p.destroy(id);
      for (const names of await cli.cliEnvNames()) {
        expect(names.filter((n) => !["PWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING"].includes(n)).sort()).toEqual([
          "EXTRA",
          "HOME",
          "PATH",
        ]);
      }
    } finally {
      delete process.env.AGENT_RUNTIME_TEST_SECRET;
    }
  });

  it("fails an upload it could not pack, and a download over its cap", async () => {
    const p = provider({ maxDownloadBytes: 4_000 });
    const id = await p.create({ image: "", limits: LIMITS });
    await expect(p.upload(id, "/no/such/dir", "/tmp/x")).rejects.toThrow("Could not pack /no/such/dir");
    await run(p, id, ["sh", "-c", "head -c 100000 /dev/zero > /workspace/big"]);
    const out = await mkdtemp(path.join(tmpdir(), "agent-runtime-download-"));
    await expect(p.download(id, "/workspace/big", out)).rejects.toThrow(/larger than|more than/);
  });

  it("keeps a sandbox's workspace, and lists it, when deleting it failed", async () => {
    const failing = path.join(path.dirname(cli.bin), "failing-delete");
    await writeFile(failing, `#!/bin/sh\n[ "$1" = delete ] && { echo "Error: boom" >&2; exit 1; }\nexec ${JSON.stringify(cli.bin)} "$@"\n`);
    await chmod(failing, 0o755);
    const p = provider({ sandboxBin: failing });
    const id = await p.create({ image: "", limits: LIMITS });
    await expect(p.destroy(id)).rejects.toThrow("boom");
    expect(await stat(path.join(cli.stateDir, id, "workspace")).catch(() => null)).not.toBeNull();
    expect((await p.list()).map((s) => s.sandboxId)).toEqual([id]);
  });

  it("refuses to start a sandbox that could read a mounted volume nobody hid", () => {
    const table = [
      "overlay / overlay rw 0 0",
      "agent-sessions /sessions fuse rw,nosuid 0 0",
      "agent-data /snap\\040shots fuse.gcsfuse ro 0 0",
      "proc /proc proc rw 0 0",
    ].join("\n");
    expect(exposedMounts(table, [])).toEqual(["/sessions", "/snap shots"]);
    expect(exposedMounts(table, ["/sessions", "/snap shots"])).toEqual([]);
    expect(exposedMounts(table, ["/"])).toEqual([]);
    expect(exposedMounts(table, ["/sess"])).toEqual(["/sessions", "/snap shots"]);
  });
});
