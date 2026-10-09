import { type Server } from "node:http";
import type { Duplex } from "node:stream";
import { type GatewayGrant, type GatewayUpstream } from "./gateway-handler.ts";
import type { TokenGrant } from "./run.ts";
/** Run tokens held in this process, for a gateway in this process. */
export declare class MemoryTokenGrant implements TokenGrant {
    private readonly grants;
    grant: (runId: string, ttlMs: number) => Promise<string>;
    revoke: (token: string) => Promise<void>;
    /** The token's run, or null once it is revoked or expired. */
    lookup: (token: string) => Promise<GatewayGrant | null>;
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
/**
 * The Docker gateway's handling (token check, key injection, unbuffered
 * streaming; Anthropic Messages or OpenAI Chat Completions) with tokens in
 * memory. Pass it as executeRun's `tokens`, and `connect` as the Cloud Run
 * provider's bridge.
 */
export declare function createInProcessGateway(options: InProcessGatewayOptions): InProcessGateway;
