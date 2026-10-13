// An AI SDK language model for an endpoint, without this package depending on
// the AI SDK: the app passes the provider factories it already imports, and
// gets back whatever model type its own AI SDK version makes. What the
// package adds is the part both apps wrote by hand: the base URL each SDK
// wants from either form of endpoint, the key, and a body rewrite for an
// endpoint that needs one (hk-legal's kimiFetch).
import { formatOf, sdkBaseUrl } from "./endpoint.js";
/**
 * A fetch that rewrites JSON request bodies. A body that is not a JSON object
 * string, or that `transform` throws on, is sent unchanged; a failed request
 * is never sent twice.
 */
export function bodyRewritingFetch(transform, base = (input, init) => globalThis.fetch(input, init)) {
    return async (input, init) => {
        let body = init?.body;
        if (typeof body === "string") {
            try {
                const parsed = JSON.parse(body);
                if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
                    body = JSON.stringify(transform(parsed));
                }
            }
            catch {
                body = init?.body;
            }
        }
        return await base(input, body === init?.body ? init : { ...init, body });
    };
}
/** The provider settings for an endpoint, for an app that calls the factory itself. */
export function aiSdkProviderSettings(endpoint, options) {
    if (!options.apiKey)
        throw new TypeError("The AI SDK provider needs the provider key");
    const name = options.name ?? endpoint.provider ?? (formatOf(endpoint) === "openai" ? "openai-compatible" : undefined);
    const fetch = options.transformBody ? bodyRewritingFetch(options.transformBody, options.fetch) : options.fetch;
    return {
        baseURL: sdkBaseUrl(endpoint),
        apiKey: options.apiKey,
        ...(name ? { name } : {}),
        ...(options.headers ? { headers: { ...options.headers } } : {}),
        ...(fetch ? { fetch } : {}),
    };
}
/**
 * The endpoint's model, built by the app's factory for its format:
 *
 * ```ts
 * createAiSdkModel(endpoint, {
 *   openai: (settings, id) => createOpenAICompatible(settings).chatModel(id),
 *   anthropic: (settings, id) => createAnthropic(settings).languageModel(id),
 * }, { apiKey });
 * ```
 *
 * Throws when the app gave no factory for the endpoint's format.
 */
export function createAiSdkModel(endpoint, factories, options) {
    const settings = aiSdkProviderSettings(endpoint, options);
    if (endpoint.format === "openai") {
        if (!factories.openai)
            throw new Error("No AI SDK factory for an openai endpoint");
        return factories.openai({ ...settings, name: settings.name ?? "openai-compatible" }, endpoint.model);
    }
    if (!factories.anthropic)
        throw new Error("No AI SDK factory for an anthropic endpoint");
    return factories.anthropic(settings, endpoint.model);
}
