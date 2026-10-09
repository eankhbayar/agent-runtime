// A failed model call as a fixed code. Nothing the endpoint wrote leaves this
// module but short, pattern-checked identifiers (its error type, code and
// param), and never a message, a body, a URL or a key, since they can quote
// the prompt or the request.
/** Worth retrying as they are, perhaps after `retryAfterMs`. hk-legal's transient failure codes. */
export const RETRYABLE_MODEL_ERRORS = [
    "connection_failure",
    "overload",
    "concurrency_throttle",
    "http_5xx",
    "connection_timeout",
    "no_progress_timeout",
    "invocation_timeout",
];
export class ModelCallError extends Error {
    code;
    retryable;
    /** From `retry-after`, for a retryable code. */
    retryAfterMs;
    /** The HTTP status, when there was a response. */
    status;
    provider;
    constructor(code, details = {}) {
        super(code);
        this.name = "ModelCallError";
        this.code = code;
        this.retryable = RETRYABLE_MODEL_ERRORS.includes(code);
        if (this.retryable && details.retryAfterMs !== undefined)
            this.retryAfterMs = details.retryAfterMs;
        if (details.status !== undefined)
            this.status = details.status;
        if (details.provider && Object.keys(details.provider).length > 0)
            this.provider = details.provider;
    }
}
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,80}$/;
/** A string the endpoint sent, kept only if it looks like an identifier. */
export function safeIdentifier(value) {
    return typeof value === "string" && IDENTIFIER.test(value) ? value : undefined;
}
/** `type`, `code` and `param` of an OpenAI `{ error }` or Anthropic `{ type: "error", error }` body. */
export function providerErrorInfo(body) {
    const error = body?.error;
    if (error === null || typeof error !== "object")
        return {};
    const fields = error;
    const info = {};
    const type = safeIdentifier(fields.type);
    const code = safeIdentifier(typeof fields.code === "number" ? String(fields.code) : fields.code);
    const param = safeIdentifier(fields.param);
    if (type)
        info.type = type;
    if (code)
        info.code = code;
    if (param)
        info.param = param;
    return info;
}
/** The milliseconds a `retry-after` header asks for, in seconds or as a date. */
export function retryAfterMs(headers, now = Date.now()) {
    const value = headers.get("retry-after")?.trim();
    if (!value)
        return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0)
        return Math.floor(seconds * 1_000);
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
const BY_PROVIDER_ID = {
    // Anthropic error types.
    authentication_error: "authentication_failed",
    permission_error: "permission_denied",
    rate_limit_error: "concurrency_throttle",
    overloaded_error: "overload",
    api_error: "http_5xx",
    request_too_large: "context_overflow",
    // OpenAI and compatible codes.
    insufficient_quota: "quota_exhausted",
    quota_exhausted: "quota_exhausted",
    subscription_required: "subscription_required",
    context_length_exceeded: "context_overflow",
    string_above_max_length: "context_overflow",
    rate_limit_exceeded: "concurrency_throttle",
    server_error: "http_5xx",
};
/** A code the endpoint's own identifiers name precisely, if any. */
export function codeFromProvider(info) {
    return (info.code && BY_PROVIDER_ID[info.code]) || (info.type && BY_PROVIDER_ID[info.type]) || undefined;
}
/** The code for a refused request, from its status and what the endpoint said. */
export function httpErrorCode(status, info = {}) {
    const named = codeFromProvider(info);
    if (named === "quota_exhausted" || named === "subscription_required" || named === "context_overflow") {
        return named;
    }
    if (status === 401)
        return "authentication_failed";
    if (status === 403)
        return "permission_denied";
    if (status === 408)
        return "connection_failure";
    if (status === 413)
        return "context_overflow";
    if (status === 429)
        return "concurrency_throttle";
    if (status === 529)
        return "overload";
    if (status >= 500)
        return named === "overload" ? "overload" : "http_5xx";
    return "invalid_request";
}
