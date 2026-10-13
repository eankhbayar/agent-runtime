import type { GatewayUpstream } from "../../core/gateway-handler.ts";
import type { TokenGrant } from "../../core/run.ts";
export type LlmConfig = GatewayUpstream & {
    provider: string;
    model: string;
    apiKey: string | undefined;
};
export type GatewayOptions = {
    /** Container name, e.g. `myproject-egress-gateway`. */
    container: string;
    /** The host name sandboxes reach the gateway by. Default `gateway`. */
    alias?: string;
};
export type Gateway = TokenGrant & {
    container: string;
    alias: string;
    /** The base URL a sandbox uses, e.g. `http://gateway:8080`. */
    url: string;
    ensure: (opts: {
        image: string;
        llm: LlmConfig;
        restart?: boolean;
    }) => Promise<"reused" | "started">;
};
export declare function createGateway(options: GatewayOptions): Gateway;
