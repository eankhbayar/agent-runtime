// Egress gateway: the only host a sandbox can reach. It holds the LLM provider
// key, accepts a per-run token in its place, and proxies Anthropic-format
// Messages API calls to one upstream endpoint.
//
//   UPSTREAM_MESSAGES_URL   full Messages endpoint, e.g. https://api.kimi.com/coding/v1/messages
//   UPSTREAM_API_KEY        the provider key, sent as x-api-key; never enters a sandbox
//   TOKEN_DIR               default /run/gateway/tokens
//   PORT                    default 8080
//
// The dispatcher grants a run token by writing a file named sha256(token)
// containing {"runId", "expiresAt"} into TOKEN_DIR (docker exec), and revokes
// it by deleting the file. Sandboxes cannot reach that directory.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";

const apiKey = process.env.UPSTREAM_API_KEY;
const messagesUrl = process.env.UPSTREAM_MESSAGES_URL;
if (!apiKey || !messagesUrl)
  throw new Error("UPSTREAM_API_KEY and UPSTREAM_MESSAGES_URL are required");
const tokenDir = process.env.TOKEN_DIR ?? "/run/gateway/tokens";
const port = Number(process.env.PORT ?? 8080);

// Sandbox clients use http://gateway:8080 as their base URL, so the SDK calls /v1/messages.
const UPSTREAM_BY_PATH = new Map([
  ["/v1/messages", messagesUrl],
  ["/v1/messages/count_tokens", `${messagesUrl}/count_tokens`],
]);
// Hop-by-hop and auth headers are never forwarded in either direction.
const DROP_REQUEST = new Set([
  "host",
  "connection",
  "content-length",
  "x-api-key",
  "authorization",
]);
const DROP_RESPONSE = new Set([
  "connection",
  "content-length",
  "content-encoding",
  "transfer-encoding",
]);

type Grant = { runId: string; expiresAt: string };

async function grantFor(token: string | undefined): Promise<Grant | null> {
  if (!token || !/^rt_[A-Za-z0-9_-]{32,}$/.test(token)) return null;
  const name = createHash("sha256").update(token).digest("hex");
  try {
    const grant = JSON.parse(await readFile(path.join(tokenDir, name), "utf8")) as Grant;
    return Date.parse(grant.expiresAt) > Date.now() ? grant : null;
  } catch {
    return null;
  }
}

function log(entry: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
}

function forwardHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || DROP_REQUEST.has(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  headers.set("x-api-key", apiKey!);
  return headers;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://gateway");
  if (req.method === "GET" && url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  const target = UPSTREAM_BY_PATH.get(url.pathname);
  if (req.method !== "POST" || !target) {
    res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not_found"}');
    return;
  }
  const grant = await grantFor(req.headers["x-api-key"] as string | undefined);
  if (!grant) {
    log({ path: url.pathname, status: 401, reason: "invalid_run_token" });
    res.writeHead(401, { "content-type": "application/json" }).end('{"error":"invalid_run_token"}');
    return;
  }

  const started = Date.now();
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  try {
    const upstreamRes = await fetch(`${target}${url.search}`, {
      method: "POST",
      headers: forwardHeaders(req),
      body: Readable.toWeb(req) as ReadableStream,
      duplex: "half",
      signal: abort.signal,
    });
    const headers: Record<string, string> = {};
    upstreamRes.headers.forEach((value, name) => {
      if (!DROP_RESPONSE.has(name)) headers[name] = value;
    });
    res.writeHead(upstreamRes.status, headers);
    if (upstreamRes.body) {
      Readable.fromWeb(upstreamRes.body as import("node:stream/web").ReadableStream).pipe(res);
      await new Promise((resolve) => res.on("close", resolve));
    } else {
      res.end();
    }
    log({
      runId: grant.runId,
      path: url.pathname,
      status: upstreamRes.status,
      ms: Date.now() - started,
    });
  } catch (error) {
    log({ runId: grant.runId, path: url.pathname, error: String(error), ms: Date.now() - started });
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end('{"error":"upstream_failed"}');
  }
});

server.listen(port, () => log({ listening: port, upstream: messagesUrl }));
