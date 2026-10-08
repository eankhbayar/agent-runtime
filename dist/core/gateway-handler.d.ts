import type { IncomingMessage, ServerResponse } from "node:http";
/** Who a valid run token belongs to. */
export type GatewayGrant = {
    runId: string;
};
export type GatewayHandlerOptions = {
    /** The full Messages endpoint, e.g. `https://api.kimi.com/coding/v1/messages`. */
    messagesUrl: string;
    /** The provider key, sent as `x-api-key`. Never reaches a sandbox. */
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
