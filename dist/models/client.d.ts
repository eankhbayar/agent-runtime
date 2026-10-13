import { type ModelEndpoint } from "./endpoint.ts";
import { type ModelErrorCode, type ProviderErrorInfo } from "./errors.ts";
import { type ModelUsage } from "./usage.ts";
export type ModelMessage = {
    role: "user" | "assistant";
    content: string;
};
/** A JSON schema the answer must match (OpenAI's `response_format: json_schema`). */
export type StructuredOutput = {
    name: string;
    description?: string;
    strict?: boolean;
    schema: Readonly<Record<string, unknown>>;
};
/** Each optional; a route's `timeouts` with these names can be passed as it is. */
export type ModelTimeouts = {
    /** From sending the request to the response's headers. */
    connectionMs?: number;
    /** Longest gap between chunks of the response, once headers have arrived. */
    noProgressMs?: number;
    /** The whole call. */
    invocationMs?: number;
};
export type ModelCallRequest = {
    system?: string;
    messages: readonly ModelMessage[];
    maxOutputTokens: number;
    /** OpenAI's `reasoning_effort`. Not sent to an Anthropic endpoint; use `extraBody.thinking` there. */
    reasoningEffort?: string;
    /** OpenAI only: an Anthropic endpoint fails with `structured_output_unsupported`. */
    structuredOutput?: StructuredOutput;
    /** Stream the response (SSE). The result is the same either way; `onText` sees the text as it comes. */
    stream?: boolean;
    /** More top-level body fields the endpoint takes. The fields this call sets win over them. */
    extraBody?: Readonly<Record<string, unknown>>;
};
export type ModelCallOptions = {
    /** The provider key, sent as `Authorization: Bearer` (OpenAI) or `x-api-key` (Anthropic). */
    apiKey: string;
    /** Defaults to the global fetch. */
    fetch?: typeof fetch;
    /** Aborting it fails the call with `cancelled`. */
    signal?: AbortSignal;
    timeouts?: ModelTimeouts;
    /** More request headers, e.g. `anthropic-beta`. Auth headers are always this call's own. */
    headers?: Readonly<Record<string, string>>;
    /** OpenAI: the field `maxOutputTokens` is sent as. Default `max_tokens`. */
    maxTokensField?: "max_tokens" | "max_completion_tokens";
    /**
     * Picks the code for a refused request before the defaults do, e.g. from a
     * provider's own header. Return undefined to fall back to `httpErrorCode`.
     */
    classify?: (refusal: {
        status: number;
        headers: Headers;
        provider: ProviderErrorInfo;
    }) => ModelErrorCode | undefined;
    /** Called once the response's headers have arrived. */
    onConnected?: () => void;
    /** Called for every chunk of the response body. */
    onProgress?: () => void;
    /** Called with each piece of answer text as it arrives. */
    onText?: (delta: string) => void;
    now?: () => number;
};
export type ModelCallResult = {
    text: string;
    usage: ModelUsage;
    /** `finish_reason` or `stop_reason`, e.g. `stop`, `length`, `end_turn`, `max_tokens`. */
    stopReason: string | null;
    /** The model the endpoint says answered. */
    model: string | null;
    /** The `x-request-id` or `request-id` response header. */
    requestId?: string;
    /** The response's own id. */
    responseId?: string;
    /** OpenAI's `created`, in ms. */
    createdAt?: number;
    /** Until the response's headers. */
    connectionMs: number;
    durationMs: number;
};
/** A larger response is refused as `provider_response_invalid`. */
export declare const MAX_RESPONSE_BYTES: number;
/**
 * Calls the endpoint once. Resolves with the answer, or rejects with a
 * ModelCallError; the call is never retried here, since whether to retry is
 * the caller's policy (`error.retryable`, `error.retryAfterMs`). An error
 * thrown by the app's own code (`onText`, `onProgress`, `onConnected`,
 * `classify`, an `extraBody` JSON cannot encode) is rethrown as it is, so an
 * app bug never reads as a retryable network failure.
 */
export declare function callModel(endpoint: ModelEndpoint, request: ModelCallRequest, options: ModelCallOptions): Promise<ModelCallResult>;
