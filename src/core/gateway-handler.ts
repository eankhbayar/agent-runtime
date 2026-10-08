// The egress gateway's request handling: a per-run token in place of the
// provider key, the key added on the way out, and model calls proxied to one
// upstream with the response streamed back unbuffered. The upstream speaks
// either the Anthropic Messages format (`x-api-key`) or the OpenAI Chat
// Completions format (`Authorization: Bearer`). The Docker gateway image
// (gateway/server.ts) and the in-job gateway (gateway.ts) both serve it.
//
// This file imports nothing but Node, because gateway/gateway-handler.ts is a
// copy of it that the gateway image runs on its own. Edit this one; a test
// fails until the copy matches.

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

/** Who a valid run token belongs to. */
export type GatewayGrant = { runId: string };

/** The model endpoint the gateway proxies to, and the format it speaks. */
export type GatewayUpstream =
  | {
      /** Anthropic Messages: the agent calls `/v1/messages` with its run token as `x-api-key`. */
      format?: "anthropic";
      /** The full Messages endpoint, e.g. `https://api.kimi.com/coding/v1/messages`. */
      messagesUrl: string;
    }
  | {
      /** OpenAI Chat Completions: the agent calls `/v1/chat/completions` with `Authorization: Bearer <run token>`. */
      format: "openai";
      /** The API base the endpoint hangs off, e.g. `https://api.openai.com/v1`. */
      baseUrl: string;
    };

export type GatewayHandlerOptions = GatewayUpstream & {
  /** The provider key, sent as `x-api-key` or `Authorization: Bearer`. Never reaches a sandbox. */
  apiKey: string;
  /** Looks a well-formed run token up; null when it is unknown, revoked or expired. */
  grantFor: (token: string) => Promise<GatewayGrant | null>;
  /** One JSON-able entry per request. */
  log?: (entry: Record<string, unknown>) => void;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
};

export type GatewayHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** What a run token looks like; anything else is refused without a lookup. */
export const RUN_TOKEN_PATTERN = /^rt_[A-Za-z0-9_-]{32,}$/;

// Hop-by-hop and auth headers are never forwarded in either direction, nor
// headers that would let a sandbox pick which account the key bills.
const DROP_REQUEST = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "content-length",
  "x-api-key",
  "authorization",
  "openai-organization",
  "openai-project",
]);
const DROP_RESPONSE = new Set([
  "connection",
  "content-length",
  "content-encoding",
  "transfer-encoding",
]);

/** The run token a request carries: `x-api-key` for Anthropic, `Authorization: Bearer` for OpenAI. */
function runTokenOf(req: IncomingMessage, openai: boolean): string | undefined {
  if (!openai) {
    const key = req.headers["x-api-key"];
    return typeof key === "string" ? key : undefined;
  }
  const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "");
  return match?.[1];
}

export function createGatewayHandler(options: GatewayHandlerOptions): GatewayHandler {
  const { apiKey } = options;
  const log = options.log ?? (() => {});
  const upstreamFetch = options.fetch ?? fetch;
  const openai = options.format === "openai";
  // Sandbox clients use the gateway as their base URL, so the Anthropic SDK
  // calls /v1/messages, and an OpenAI client given <gateway>/v1 calls /v1/chat/completions.
  let upstreamByPath: Map<string, string>;
  if (options.format === "openai") {
    const baseUrl = options.baseUrl.replace(/\/+$/, "");
    upstreamByPath = new Map([["/v1/chat/completions", `${baseUrl}/chat/completions`]]);
  } else {
    const { messagesUrl } = options;
    upstreamByPath = new Map([
      ["/v1/messages", messagesUrl],
      ["/v1/messages/count_tokens", `${messagesUrl}/count_tokens`],
    ]);
  }

  const forwardHeaders = (req: IncomingMessage): Headers => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || DROP_REQUEST.has(name)) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    if (openai) headers.set("authorization", `Bearer ${apiKey}`);
    else headers.set("x-api-key", apiKey);
    return headers;
  };

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://gateway");
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    const target = upstreamByPath.get(url.pathname);
    if (req.method !== "POST" || !target) {
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not_found"}');
      return;
    }
    const token = runTokenOf(req, openai);
    const grant =
      typeof token === "string" && RUN_TOKEN_PATTERN.test(token)
        ? await options.grantFor(token).catch(() => null)
        : null;
    if (!grant) {
      log({ path: url.pathname, status: 401, reason: "invalid_run_token" });
      res
        .writeHead(401, { "content-type": "application/json" })
        .end('{"error":"invalid_run_token"}');
      return;
    }

    const started = Date.now();
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    try {
      const upstreamRes = await upstreamFetch(`${target}${url.search}`, {
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
        // Piped chunk by chunk, so a streamed response reaches the agent as it is sent.
        // An agent that hangs up mid-answer (a cancel, a timeout, a shutdown) aborts
        // the upstream call, which errors the body; that ends this pipeline, not the process.
        await pipeline(Readable.fromWeb(upstreamRes.body as WebReadableStream), res).catch(() => {});
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
  };
}
