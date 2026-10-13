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
/**
 * A project's data commands, as ../data's createDataRoutes makes them:
 * the list for GET /data, and one call per POST /data/<command>.
 */
export type GatewayData = {
    list: () => unknown;
    call: (command: string, args: unknown, grant: GatewayGrant) => Promise<{
        status: number;
        body: unknown;
    }>;
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
    /** Serves these data commands at /data; without it /data is not found. */
    data?: GatewayData;
};
export type GatewayHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** What a run token looks like; anything else is refused without a lookup. */
export declare const RUN_TOKEN_PATTERN: RegExp;
export declare function createGatewayHandler(options: GatewayHandlerOptions): GatewayHandler;
