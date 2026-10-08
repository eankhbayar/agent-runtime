import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { startFakeUpstream, type FakeUpstream } from "../testing/fake-upstream.ts";
import { createInProcessGateway, type InProcessGateway } from "./gateway.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

type Answer = { status: number; body: string; arrivals: number[] };

// One streamed text delta, in each format.
const MESSAGES_DELTA = /event: content_block_delta/g;
const CHAT_DELTA = /"delta":\{"content":"[^"]/g;

/** One POST, timing each text delta from the moment the response began. */
function post(
  target: { url: string } | { connect: () => Duplex },
  pathName: string,
  headers: Record<string, string>,
  body = '{"model":"m","stream":true,"messages":[]}',
  delta: RegExp = MESSAGES_DELTA,
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const base = "url" in target ? new URL(target.url) : null;
    const req = request(
      {
        method: "POST",
        path: pathName,
        headers: { "content-type": "application/json", host: "gateway", ...headers },
        ...(base
          ? { host: base.hostname, port: Number(base.port), agent: false }
          : { createConnection: (target as { connect: () => Duplex }).connect }),
      },
      (res) => {
        const started = Date.now();
        const arrivals: number[] = [];
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (d: string) => {
          for (const _ of d.matchAll(delta)) arrivals.push(Date.now() - started);
          text += d;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text, arrivals }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

let upstream: FakeUpstream | undefined;
let gateway: InProcessGateway | undefined;
afterEach(async () => {
  await gateway?.close();
  await upstream?.close();
  gateway = upstream = undefined;
});

async function setup(gapMs = 0, format: "anthropic" | "openai" = "anthropic") {
  upstream = await startFakeUpstream({ apiKey: "sk-provider", gapMs });
  const entries: Record<string, unknown>[] = [];
  gateway = createInProcessGateway({
    ...(format === "openai"
      ? { format, baseUrl: upstream.baseUrl }
      : { messagesUrl: upstream.messagesUrl }),
    apiKey: "sk-provider",
    log: (entry) => entries.push(entry),
  });
  const url = await gateway.listen();
  return { upstream, gateway, url, entries };
}

describe("createInProcessGateway", () => {
  it("swaps a run token for the provider key and streams the answer as it comes", async () => {
    const { upstream, gateway, url, entries } = await setup(80);
    const token = await gateway.grant("run_1", 60_000);
    const answer = await post({ url }, "/v1/messages", {
      "x-api-key": token,
      authorization: "Bearer should-not-pass",
    });

    expect(answer.status).toBe(200);
    expect(answer.body).toContain("event: message_stop");
    const seen = upstream.requests[0]!;
    expect(seen.headers["x-api-key"]).toBe("sk-provider");
    expect(seen.headers.authorization).toBeUndefined();
    expect(JSON.stringify(seen.headers)).not.toContain(token);
    // Five words 80 ms apart: buffered, they would all land together at the end.
    expect(answer.arrivals).toHaveLength(5);
    expect(answer.arrivals.at(-1)! - answer.arrivals[0]!).toBeGreaterThan(200);
    expect(entries.at(-1)).toMatchObject({ runId: "run_1", path: "/v1/messages", status: 200 });
  });

  it("survives an agent that hangs up in the middle of a streamed answer", async () => {
    const { gateway, url } = await setup(150);
    const token = await gateway.grant("run_1", 60_000);
    const crashes: unknown[] = [];
    const onCrash = (error: unknown) => crashes.push(error);
    process.on("uncaughtException", onCrash);
    try {
      await new Promise<void>((resolve, reject) => {
        const base = new URL(url);
        const req = request(
          {
            method: "POST",
            path: "/v1/messages",
            host: base.hostname,
            port: Number(base.port),
            agent: false,
            headers: { "content-type": "application/json", "x-api-key": token },
          },
          (res) => {
            // A cancelled or timed-out runner drops its connection mid-answer.
            res.once("data", () => {
              req.destroy();
              resolve();
            });
          },
        );
        req.on("error", () => {});
        req.end('{"model":"m","stream":true,"messages":[]}');
        setTimeout(() => reject(new Error("no answer")), 5_000);
      });
      // The upstream keeps sending for a while after the hang-up.
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(crashes).toEqual([]);
      // And the gateway still serves the next call.
      expect((await post({ url }, "/v1/messages", { "x-api-key": token })).status).toBe(200);
    } finally {
      process.off("uncaughtException", onCrash);
    }
  });

  it("refuses a missing, malformed, unknown, revoked or expired token", async () => {
    const { upstream, gateway, url } = await setup();
    const revoked = await gateway.grant("run_1", 60_000);
    await gateway.revoke(revoked);
    const expired = await gateway.grant("run_1", 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    for (const key of [undefined, "sk-provider", `rt_${"x".repeat(43)}`, revoked, expired]) {
      const answer = await post({ url }, "/v1/messages", key ? { "x-api-key": key } : {});
      expect(answer).toMatchObject({ status: 401, body: '{"error":"invalid_run_token"}' });
    }
    expect(upstream.requests).toEqual([]);
  });

  it("proxies count_tokens, answers its health check, and nothing else", async () => {
    const { gateway, url } = await setup();
    const token = await gateway.grant("run_1", 60_000);
    expect(await post({ url }, "/v1/messages/count_tokens", { "x-api-key": token })).toMatchObject({
      status: 200,
      body: '{"input_tokens":10}',
    });
    expect((await post({ url }, "/v1/complete", { "x-api-key": token })).status).toBe(404);
    const health = await fetch(`${url}/healthz`);
    expect(await health.text()).toBe("ok");
  });

  it("answers 502 when the upstream is down", async () => {
    const { gateway, url } = await setup();
    await upstream!.close();
    upstream = undefined;
    const token = await gateway.grant("run_1", 60_000);
    expect(await post({ url }, "/v1/messages", { "x-api-key": token })).toMatchObject({
      status: 502,
      body: '{"error":"upstream_failed"}',
    });
  });

  it("serves a stream handed to connect, with no socket in between", async () => {
    const { gateway } = await setup();
    const token = await gateway.grant("run_1", 60_000);
    const connect = () => {
      const up = new PassThrough();
      const down = new PassThrough();
      gateway.connect(Duplex.from({ readable: up, writable: down }));
      return Duplex.from({ readable: down, writable: up });
    };
    const answer = await post({ connect }, "/v1/messages", { "x-api-key": token });
    expect(answer.status).toBe(200);
    expect(answer.body).toContain("Hello ");
  });
});

describe("createInProcessGateway with an OpenAI-format upstream", () => {
  const chat = (url: string, headers: Record<string, string>) =>
    post({ url }, "/v1/chat/completions", headers, undefined, CHAT_DELTA);

  it("takes the run token as a bearer token, sends the key as one, and streams as it comes", async () => {
    const { upstream, gateway, url, entries } = await setup(80, "openai");
    const token = await gateway.grant("run_1", 60_000);
    const answer = await chat(url, {
      authorization: `Bearer ${token}`,
      "x-api-key": "should-not-pass",
      "openai-organization": "org-elsewhere",
      "openai-project": "proj-elsewhere",
      "x-client-request-id": "req-1",
    });

    expect(answer.status).toBe(200);
    expect(answer.body).toContain("data: [DONE]");
    const seen = upstream.requests[0]!;
    expect(seen.path).toBe("/v1/chat/completions");
    expect(seen.headers.authorization).toBe("Bearer sk-provider");
    expect(seen.headers["x-api-key"]).toBeUndefined();
    expect(seen.headers["openai-organization"]).toBeUndefined();
    expect(seen.headers["openai-project"]).toBeUndefined();
    expect(seen.headers["x-client-request-id"]).toBe("req-1");
    expect(JSON.stringify(seen.headers)).not.toContain(token);
    expect(seen.body).toMatchObject({ model: "m", stream: true });
    // Five words 80 ms apart: buffered, they would all land together at the end.
    expect(answer.arrivals).toHaveLength(5);
    expect(answer.arrivals.at(-1)! - answer.arrivals[0]!).toBeGreaterThan(200);
    expect(entries.at(-1)).toMatchObject({ runId: "run_1", path: "/v1/chat/completions", status: 200 });
    expect(JSON.stringify(entries)).not.toContain(token);
    expect(JSON.stringify(entries)).not.toContain("sk-provider");
  });

  it("refuses a token sent any other way, and every bad token", async () => {
    const { upstream, gateway, url, entries } = await setup(0, "openai");
    const token = await gateway.grant("run_1", 60_000);
    const revoked = await gateway.grant("run_1", 60_000);
    await gateway.revoke(revoked);
    const attempts: Record<string, string>[] = [
      {},
      { "x-api-key": token },
      { authorization: token },
      { authorization: `Basic ${token}` },
      { authorization: "Bearer sk-provider" },
      { authorization: `Bearer rt_${"x".repeat(43)}` },
      { authorization: `Bearer ${revoked}` },
    ];
    for (const headers of attempts) {
      expect(await chat(url, headers)).toMatchObject({ status: 401, body: '{"error":"invalid_run_token"}' });
    }
    expect(upstream.requests).toEqual([]);
    expect(JSON.stringify(entries)).not.toContain(token);
  });

  it("proxies chat completions only, not the Messages paths", async () => {
    const { upstream, gateway, url } = await setup(0, "openai");
    const token = await gateway.grant("run_1", 60_000);
    const bearer = { authorization: `Bearer ${token}` };
    const whole = await post({ url }, "/v1/chat/completions", bearer, '{"model":"m","messages":[]}');
    expect(whole.status).toBe(200);
    expect(JSON.parse(whole.body)).toMatchObject({ choices: [{ message: { content: "Hello from the fake model." } }] });
    for (const pathName of ["/v1/messages", "/v1/messages/count_tokens", "/v1/completions", "/chat/completions"]) {
      expect((await post({ url }, pathName, bearer)).status).toBe(404);
    }
    expect(upstream.requests).toHaveLength(1);
  });

  it("survives an agent that hangs up in the middle of a streamed answer", async () => {
    const { gateway, url } = await setup(150, "openai");
    const token = await gateway.grant("run_1", 60_000);
    const crashes: unknown[] = [];
    const onCrash = (error: unknown) => crashes.push(error);
    process.on("uncaughtException", onCrash);
    try {
      await new Promise<void>((resolve, reject) => {
        const base = new URL(url);
        const req = request(
          {
            method: "POST",
            path: "/v1/chat/completions",
            host: base.hostname,
            port: Number(base.port),
            agent: false,
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          },
          (res) => {
            res.once("data", () => {
              req.destroy();
              resolve();
            });
          },
        );
        req.on("error", () => {});
        req.end('{"model":"m","stream":true,"messages":[]}');
        setTimeout(() => reject(new Error("no answer")), 5_000);
      });
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(crashes).toEqual([]);
      expect((await chat(url, { authorization: `Bearer ${token}` })).status).toBe(200);
    } finally {
      process.off("uncaughtException", onCrash);
    }
  });

  it("joins the base URL and the path whatever slash the base ends with", async () => {
    upstream = await startFakeUpstream({ apiKey: "sk-provider" });
    gateway = createInProcessGateway({
      format: "openai",
      baseUrl: `${upstream.baseUrl}/`,
      apiKey: "sk-provider",
      log: () => {},
    });
    const url = await gateway.listen();
    const token = await gateway.grant("run_1", 60_000);
    expect((await chat(url, { authorization: `Bearer ${token}` })).status).toBe(200);
    expect(upstream.requests[0]!.path).toBe("/v1/chat/completions");
  });
});

describe("the gateway image's server", { timeout: 30_000 }, () => {
  it("runs the same handler as core, from a copy kept identical", async () => {
    const [core, copy] = await Promise.all([
      readFile(path.join(repo, "src/core/gateway-handler.ts"), "utf8"),
      readFile(path.join(repo, "gateway/gateway-handler.ts"), "utf8"),
    ]);
    expect(copy, "copy src/core/gateway-handler.ts to gateway/").toBe(core);
  });

  /** Starts gateway/server.ts with `env`, one valid token in its token directory. */
  async function startServer(env: Record<string, string>) {
    const tokenDir = await mkdtemp(path.join(tmpdir(), "agent-runtime-tokens-"));
    const token = `rt_${"t".repeat(43)}`;
    const hash = createHash("sha256").update(token).digest("hex");
    await writeFile(
      path.join(tokenDir, hash),
      JSON.stringify({ runId: "run_9", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    );
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((resolve) => probe.close(resolve));

    const server = spawn(process.execPath, [path.join(repo, "gateway/server.ts")], {
      env: { ...process.env, ...env, TOKEN_DIR: tokenDir, PORT: String(port) },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const listening = await new Promise<string>((resolve) =>
      server.stdout.once("data", (d: Buffer) => resolve(String(d))),
    );
    return { url: `http://127.0.0.1:${port}`, token, server, listening };
  }

  it("still checks token files and streams the upstream's answer", async () => {
    upstream = await startFakeUpstream({ apiKey: "sk-provider" });
    const { url, token, server, listening } = await startServer({
      UPSTREAM_MESSAGES_URL: upstream.messagesUrl,
      UPSTREAM_API_KEY: "sk-provider",
    });
    try {
      expect(JSON.parse(listening)).toMatchObject({ format: "anthropic", upstream: upstream.messagesUrl });
      const answer = await post({ url }, "/v1/messages", { "x-api-key": token });
      expect(answer.status).toBe(200);
      expect(answer.body).toContain("event: message_stop");
      expect(upstream.requests[0]!.headers["x-api-key"]).toBe("sk-provider");
      expect((await post({ url }, "/v1/messages", { "x-api-key": `rt_${"u".repeat(43)}` })).status).toBe(
        401,
      );
    } finally {
      server.kill();
    }
  });

  it("proxies chat completions with UPSTREAM_FORMAT=openai", async () => {
    upstream = await startFakeUpstream({ apiKey: "sk-provider" });
    const { url, token, server, listening } = await startServer({
      UPSTREAM_FORMAT: "openai",
      UPSTREAM_BASE_URL: upstream.baseUrl,
      UPSTREAM_API_KEY: "sk-provider",
    });
    try {
      expect(listening).not.toContain("sk-provider");
      expect(JSON.parse(listening)).toMatchObject({ format: "openai", upstream: upstream.baseUrl });
      const answer = await post({ url }, "/v1/chat/completions", { authorization: `Bearer ${token}` });
      expect(answer.status).toBe(200);
      expect(answer.body).toContain("data: [DONE]");
      expect(upstream.requests[0]!.headers.authorization).toBe("Bearer sk-provider");
      expect((await post({ url }, "/v1/messages", { "x-api-key": token })).status).toBe(404);
    } finally {
      server.kill();
    }
  });

  it("refuses to start without the upstream its format needs", async () => {
    for (const env of [
      { UPSTREAM_API_KEY: "sk-provider" },
      { UPSTREAM_API_KEY: "sk-provider", UPSTREAM_FORMAT: "openai", UPSTREAM_MESSAGES_URL: "http://x/v1/messages" },
      { UPSTREAM_API_KEY: "sk-provider", UPSTREAM_FORMAT: "gemini", UPSTREAM_BASE_URL: "http://x/v1" },
      { UPSTREAM_FORMAT: "openai", UPSTREAM_BASE_URL: "http://x/v1" },
    ]) {
      const server = spawn(process.execPath, [path.join(repo, "gateway/server.ts")], {
        env: {
          PATH: process.env.PATH ?? "",
          ...env,
          PORT: "0",
        },
        stdio: ["ignore", "ignore", "ignore"],
      });
      const code = await new Promise<number | null>((resolve) => server.once("exit", resolve));
      expect(code, JSON.stringify(env)).not.toBe(0);
    }
  });
});
