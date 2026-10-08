// Egress gateway: the only host a sandbox can reach. It holds the LLM provider
// key, accepts a per-run token in its place, and proxies model calls to one
// upstream: Anthropic Messages, or OpenAI Chat Completions.
//
//   UPSTREAM_FORMAT         anthropic (default) or openai
//   UPSTREAM_MESSAGES_URL   anthropic: full Messages endpoint, e.g. https://api.kimi.com/coding/v1/messages
//   UPSTREAM_BASE_URL       openai: the API base, e.g. https://api.openai.com/v1; calls go to <base>/chat/completions
//   UPSTREAM_API_KEY        the provider key, sent as x-api-key (anthropic) or
//                           Authorization: Bearer (openai); never enters a sandbox
//   TOKEN_DIR               default /run/gateway/tokens
//   PORT                    default 8080
//
// The dispatcher grants a run token by writing a file named sha256(token)
// containing {"runId", "expiresAt"} into TOKEN_DIR (docker exec), and revokes
// it by deleting the file. Sandboxes cannot reach that directory.
//
// The request handling is gateway-handler.ts, a copy of the package's
// src/core/gateway-handler.ts, which the in-job gateway serves too.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { createGatewayHandler, type GatewayGrant, type GatewayUpstream } from "./gateway-handler.ts";

function upstreamFromEnv(env: NodeJS.ProcessEnv): GatewayUpstream {
  const format = env.UPSTREAM_FORMAT || "anthropic";
  if (format === "openai") {
    if (!env.UPSTREAM_BASE_URL) throw new Error("UPSTREAM_BASE_URL is required when UPSTREAM_FORMAT=openai");
    return { format, baseUrl: env.UPSTREAM_BASE_URL };
  }
  if (format !== "anthropic") throw new Error("UPSTREAM_FORMAT must be anthropic or openai");
  if (!env.UPSTREAM_MESSAGES_URL) throw new Error("UPSTREAM_MESSAGES_URL is required");
  return { format, messagesUrl: env.UPSTREAM_MESSAGES_URL };
}

const apiKey = process.env.UPSTREAM_API_KEY;
if (!apiKey) throw new Error("UPSTREAM_API_KEY is required");
const upstream = upstreamFromEnv(process.env);
const tokenDir = process.env.TOKEN_DIR ?? "/run/gateway/tokens";
const port = Number(process.env.PORT ?? 8080);

async function grantFor(token: string): Promise<GatewayGrant | null> {
  const name = createHash("sha256").update(token).digest("hex");
  try {
    const grant = JSON.parse(await readFile(path.join(tokenDir, name), "utf8")) as {
      runId: string;
      expiresAt: string;
    };
    return Date.parse(grant.expiresAt) > Date.now() ? grant : null;
  } catch {
    return null;
  }
}

function log(entry: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
}

const server = createServer(createGatewayHandler({ ...upstream, apiKey, grantFor, log }));

server.listen(port, () =>
  log({
    listening: port,
    format: upstream.format,
    upstream: upstream.format === "openai" ? upstream.baseUrl : upstream.messagesUrl,
  }),
);
