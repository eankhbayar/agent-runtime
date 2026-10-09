// Where a model is called and in which format. The upstream half has the same
// shape as core's GatewayUpstream, so an endpoint can be spread into
// createInProcessGateway or a Docker LlmConfig as it is; the gateway keeps
// only the upstream's own fields.
//
// No Node APIs and no imports outside this directory, so Convex's default
// runtime can use it (see tsconfig.models.json).
const FORMAT_ALIASES = {
    openai: "openai",
    "openai-compatible": "openai",
    "openai-completions": "openai",
    "chat-completions": "openai",
    anthropic: "anthropic",
    "anthropic-compatible": "anthropic",
    "anthropic-messages": "anthropic",
    messages: "anthropic",
};
/**
 * `openai` or `anthropic` from a configured value, accepting the names the
 * apps' settings already use (`openai-compatible`, `chat-completions`,
 * `anthropic-compatible`, `messages`, pi's `openai-completions` and
 * `anthropic-messages`), in any case.
 */
export function parseModelFormat(value) {
    const format = FORMAT_ALIASES[value.trim().toLowerCase()];
    if (!format)
        throw new Error(`Model format must be openai or anthropic, not ${JSON.stringify(value)}`);
    return format;
}
export function formatOf(endpoint) {
    return endpoint.format === "openai" ? "openai" : "anthropic";
}
function httpUrl(value, name) {
    const trimmed = value.trim().replace(/\/+$/, "");
    let url;
    try {
        url = new URL(trimmed);
    }
    catch {
        throw new Error(`${name} must be an http or https URL`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error(`${name} must be an http or https URL`);
    }
    if (url.username || url.password)
        throw new Error(`${name} must not carry credentials`);
    return trimmed;
}
/** A normalised endpoint from loosely written configuration; throws on a bad format, URL or model. */
export function modelEndpoint(input) {
    const format = parseModelFormat(input.format);
    const model = input.model.trim();
    if (!model)
        throw new Error("Model id is required");
    const url = httpUrl(input.url, "Model URL");
    const extra = {
        model,
        ...(input.apiKeyEnv ? { apiKeyEnv: input.apiKeyEnv } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
    };
    if (format === "openai") {
        const baseUrl = url.endsWith("/chat/completions") ? url.slice(0, -"/chat/completions".length) : url;
        return { format, baseUrl, ...extra };
    }
    const messagesUrl = url.endsWith("/messages")
        ? url
        : url.endsWith("/v1")
            ? `${url}/messages`
            : `${url}/v1/messages`;
    return { format, messagesUrl, ...extra };
}
/**
 * An endpoint from environment variables the app names, falling back to its
 * defaults for unset or blank ones. Takes the environment as an argument, so
 * it works wherever the app gets its variables from (`process.env`, Convex's
 * `env`).
 */
export function modelEndpointFromEnv(env, names, defaults = {}) {
    const read = (name, fallback, what) => {
        const value = (name ? env[name]?.trim() : undefined) || fallback;
        if (!value)
            throw new Error(`${name ?? what} is not configured`);
        return value;
    };
    return modelEndpoint({
        format: read(names.format, defaults.format, "the model format"),
        url: read(names.url, defaults.url, "the model URL"),
        model: read(names.model, defaults.model, "the model id"),
        apiKeyEnv: names.apiKey,
        provider: defaults.provider,
    });
}
/** Where a call is posted: the Messages endpoint, or `<baseUrl>/chat/completions`. */
export function endpointUrl(endpoint) {
    return endpoint.format === "openai"
        ? `${endpoint.baseUrl.replace(/\/+$/, "")}/chat/completions`
        : endpoint.messagesUrl;
}
/**
 * The base URL an SDK appends its own path to: the OpenAI base as it is, and
 * the Messages endpoint without `/messages` (the AI SDK's and Anthropic SDK's
 * `baseURL`, e.g. `https://api.kimi.com/coding/v1`).
 */
export function sdkBaseUrl(endpoint) {
    if (endpoint.format === "openai")
        return endpoint.baseUrl.replace(/\/+$/, "");
    const url = endpoint.messagesUrl.replace(/\/+$/, "");
    return url.endsWith("/messages") ? url.slice(0, -"/messages".length) : url;
}
/** The key from the variable the endpoint names; throws, naming the variable, when it is unset. */
export function apiKeyFor(endpoint, env) {
    if (!endpoint.apiKeyEnv)
        throw new Error("The model endpoint names no apiKeyEnv");
    const key = env[endpoint.apiKeyEnv]?.trim();
    if (!key)
        throw new Error(`${endpoint.apiKeyEnv} is not set`);
    return key;
}
