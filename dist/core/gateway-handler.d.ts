import type { IncomingMessage, ServerResponse } from "node:http";
/** Who a valid run token belongs to. */
export type GatewayGrant = {
    runId: string;
};
/** The model endpoint the gateway proxies to, and the format it speaks. */
export type GatewayUpstream = {
    /** Anthropic Messages: the agent calls `/v1/messages` with its run token as `x-api-key`. */
    format?: "anthropic";
    /** The full Messages endpoint, e.g. `https://api.kimi.com/coding/v1/messages`. */
    messagesUrl: string;
} | {
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
export declare const RUN_TOKEN_PATTERN: RegExp;
export declare function createGatewayHandler(options: GatewayHandlerOptions): GatewayHandler;
