export type ModelErrorCode = 
/** 401. */
"authentication_failed"
/** 403. */
 | "permission_denied"
/** Any other 4xx. */
 | "invalid_request"
/** 413, or the endpoint said the context is too long. */
 | "context_overflow"
/** 429. */
 | "concurrency_throttle"
/** The account is out of quota (the endpoint said so). */
 | "quota_exhausted"
/** The account needs a plan it lacks (the endpoint said so). */
 | "subscription_required"
/** 529, or the endpoint said it is overloaded. */
 | "overload"
/** 5xx. */
 | "http_5xx"
/** No response: DNS, TLS, a reset connection, or a body cut off. */
 | "connection_failure"
/** No response headers within `timeouts.connectionMs`. */
 | "connection_timeout"
/** Nothing new arrived for `timeouts.noProgressMs`. */
 | "no_progress_timeout"
/** The whole call took longer than `timeouts.invocationMs`. */
 | "invocation_timeout"
/** The caller's signal aborted. */
 | "cancelled"
/** A 2xx whose body was not a response of the format, or held no text. */
 | "provider_response_invalid"
/** Structured output was asked of an Anthropic endpoint. */
 | "structured_output_unsupported";
/** Worth retrying as they are, perhaps after `retryAfterMs`. hk-legal's transient failure codes. */
export declare const RETRYABLE_MODEL_ERRORS: readonly ModelErrorCode[];
/** The endpoint's own error identifiers, each at most 80 characters of `[A-Za-z0-9_.:-]`. */
export type ProviderErrorInfo = {
    type?: string;
    code?: string;
    param?: string;
};
export declare class ModelCallError extends Error {
    readonly code: ModelErrorCode;
    readonly retryable: boolean;
    /** From `retry-after`, for a retryable code. */
    readonly retryAfterMs?: number;
    /** The HTTP status, when there was a response. */
    readonly status?: number;
    readonly provider?: ProviderErrorInfo;
    constructor(code: ModelErrorCode, details?: {
        retryAfterMs?: number;
        status?: number;
        provider?: ProviderErrorInfo;
    });
}
/** A string the endpoint sent, kept only if it looks like an identifier. */
export declare function safeIdentifier(value: unknown): string | undefined;
/** `type`, `code` and `param` of an OpenAI `{ error }` or Anthropic `{ type: "error", error }` body. */
export declare function providerErrorInfo(body: unknown): ProviderErrorInfo;
/** The milliseconds a `retry-after` header asks for, in seconds or as a date. */
export declare function retryAfterMs(headers: Headers, now?: number): number | undefined;
/** A code the endpoint's own identifiers name precisely, if any. */
export declare function codeFromProvider(info: ProviderErrorInfo): ModelErrorCode | undefined;
/** The code for a refused request, from its status and what the endpoint said. */
export declare function httpErrorCode(status: number, info?: ProviderErrorInfo): ModelErrorCode;
