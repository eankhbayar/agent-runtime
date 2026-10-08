import { type IncomingMessage } from "node:http";
export type FakeUpstreamRequest = {
    path: string;
    headers: IncomingMessage["headers"];
    body: Record<string, unknown>;
};
export type FakeUpstreamOptions = {
    /** The key the gateway must send as x-api-key. */
    apiKey: string;
    /** The reply's text for a request. Default: "Hello from the fake model." */
    reply?: (body: Record<string, unknown>) => string;
    /** Milliseconds between streamed events. Default 0. */
    gapMs?: number;
};
export type FakeUpstream = {
    /** The Messages endpoint to give a gateway, e.g. `http://127.0.0.1:1234/v1/messages`. */
    messagesUrl: string;
    /** Every request that reached it, key checked or not. */
    requests: FakeUpstreamRequest[];
    close: () => Promise<void>;
};
/** The SSE events a streamed Messages response of `text` is made of. */
export declare function messagesEvents(text: string): string[];
export declare function startFakeUpstream(options: FakeUpstreamOptions): Promise<FakeUpstream>;
