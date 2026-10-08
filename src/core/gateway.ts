// The egress gateway served from the process that runs executeRun, for a
// platform with no gateway container: a Cloud Run job, whose sandboxes have no
// network and reach it over the stdio bridge. Run tokens live in memory, and
// the provider key stays in the job's own environment.

import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import { createGatewayHandler, type GatewayGrant, type GatewayUpstream } from "./gateway-handler.ts";
import type { TokenGrant } from "./run.ts";

/** Run tokens held in this process, for a gateway in this process. */
export class MemoryTokenGrant implements TokenGrant {
  private readonly grants = new Map<string, { runId: string; expiresAt: number }>();

  grant = async (runId: string, ttlMs: number): Promise<string> => {
    const token = `rt_${randomBytes(32).toString("base64url")}`;
    this.grants.set(token, { runId, expiresAt: Date.now() + ttlMs });
    return token;
  };

  revoke = async (token: string): Promise<void> => {
    this.grants.delete(token);
  };

  /** The token's run, or null once it is revoked or expired. */
  lookup = async (token: string): Promise<GatewayGrant | null> => {
    const grant = this.grants.get(token);
    if (!grant) return null;
    if (grant.expiresAt <= Date.now()) {
      this.grants.delete(token);
      return null;
    }
    return { runId: grant.runId };
  };
}

/**
 * `{ messagesUrl }` for an Anthropic Messages upstream, or
 * `{ format: "openai", baseUrl }` for an OpenAI Chat Completions one.
 */
export type InProcessGatewayOptions = GatewayUpstream & {
  /** The provider key. */
  apiKey: string;
  /** One entry per request; by default a JSON line on stderr. */
  log?: (entry: Record<string, unknown>) => void;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
};

export type InProcessGateway = TokenGrant & {
  /** Serves one connection, such as a stream the bridge opened, with no socket in between. */
  connect: (stream: Duplex) => void;
  /** Also listens on TCP, e.g. for a sandbox on this host. Resolves with the base URL. */
  listen: (port?: number, host?: string) => Promise<string>;
  /** Stops listening and ends every connection. */
  close: () => Promise<void>;
  server: Server;
};

// Only the upstream's own fields, so nothing else in the options rides along.
function upstreamOf(options: GatewayUpstream): GatewayUpstream {
  return options.format === "openai"
    ? { format: "openai", baseUrl: options.baseUrl }
    : { format: "anthropic", messagesUrl: options.messagesUrl };
}

function defaultLog(entry: Record<string, unknown>): void {
  process.stderr.write(
    `${JSON.stringify({ ts: new Date().toISOString(), component: "gateway", ...entry })}\n`,
  );
}

/**
 * The Docker gateway's handling (token check, key injection, unbuffered
 * streaming; Anthropic Messages or OpenAI Chat Completions) with tokens in
 * memory. Pass it as executeRun's `tokens`, and `connect` as the Cloud Run
 * provider's bridge.
 */
export function createInProcessGateway(options: InProcessGatewayOptions): InProcessGateway {
  if (!options.apiKey) throw new Error("The gateway needs the provider API key");
  const tokens = new MemoryTokenGrant();
  const server = createServer(
    createGatewayHandler({
      ...upstreamOf(options),
      apiKey: options.apiKey,
      grantFor: tokens.lookup,
      log: options.log ?? defaultLog,
      fetch: options.fetch,
    }),
  );
  const streams = new Set<Duplex>();

  return {
    server,
    grant: tokens.grant,
    revoke: tokens.revoke,

    connect(stream) {
      streams.add(stream);
      stream.once("close", () => streams.delete(stream));
      server.emit("connection", stream);
    },

    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          const address = server.address() as AddressInfo;
          resolve(`http://${host}:${address.port}`);
        });
      });
    },

    async close() {
      for (const stream of streams) stream.destroy();
      streams.clear();
      if (!server.listening) return;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
