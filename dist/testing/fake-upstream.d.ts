import { type IncomingMessage } from "node:http";
export type FakeUpstreamRequest = {
    path: string;
    headers: IncomingMessage["headers"];
    body: Record<string, unknown>;
};
export type FakeUpstreamOptions = {
    /** The key the gateway must send, as x-api-key or as a bearer token per format. */
    apiKey: string;
    /** The reply's text for a request. Default: "Hello from the fake model." */
    reply?: (body: Record<string, unknown>) => string;
    /** Milliseconds between streamed events. Default 0. */
    gapMs?: number;
    /** Milliseconds before any response is written, headers included. Default 0. */
    headerDelayMs?: number;
    /** An error to answer a request with, after the key check; undefined to answer normally. */
    refuse?: (request: FakeUpstreamRequest) => FakeUpstreamRefusal | undefined;
};
/** A refused request: the status, any headers (e.g. `retry-after`) and the body, JSON-encoded if not a string. */
export type FakeUpstreamRefusal = {
    status: number;
    headers?: Record<string, string>;
    body?: unknown;
};
export type FakeUpstream = {
    /** The Messages endpoint to give a gateway, e.g. `http://127.0.0.1:1234/v1/messages`. */
    messagesUrl: string;
    /** The OpenAI-format base URL to give a gateway, e.g. `http://127.0.0.1:1234/v1`. */
    baseUrl: string;
    /** Every request that reached it, key checked or not. */
    requests: FakeUpstreamRequest[];
    close: () => Promise<void>;
};
/** The SSE events a streamed Messages response of `text` is made of. */
export declare function messagesEvents(text: string): string[];
/** The SSE events a streamed Chat Completions response of `text` is made of, `[DONE]` last. */
export declare function chatCompletionEvents(text: string): string[];
export declare function startFakeUpstream(options: FakeUpstreamOptions): Promise<FakeUpstream>;
