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
//
// The request handling is gateway-handler.ts, a copy of the package's
// src/core/gateway-handler.ts, which the in-job gateway serves too.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { createGatewayHandler, type GatewayGrant } from "./gateway-handler.ts";

const apiKey = process.env.UPSTREAM_API_KEY;
const messagesUrl = process.env.UPSTREAM_MESSAGES_URL;
if (!apiKey || !messagesUrl)
  throw new Error("UPSTREAM_API_KEY and UPSTREAM_MESSAGES_URL are required");
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

const server = createServer(createGatewayHandler({ messagesUrl, apiKey, grantFor, log }));

server.listen(port, () => log({ listening: port, upstream: messagesUrl }));
