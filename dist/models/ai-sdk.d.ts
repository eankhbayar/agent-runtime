import { type ModelEndpoint } from "./endpoint.ts";
/**
 * The settings `createOpenAICompatible`, `createOpenAI` and `createAnthropic`
 * all take. `name` is `options.name`, else the endpoint's `provider`; with
 * neither, OpenAI gets `openai-compatible` (`createOpenAICompatible` requires
 * a name) and Anthropic none, keeping the SDK's own, since the name is the
 * key a call's `providerOptions` sit under.
 */
export type AiSdkProviderSettings = {
    baseURL: string;
    apiKey: string;
    name?: string;
    headers?: Record<string, string>;
    fetch?: typeof fetch;
};
/** One factory per format the app supports; each builds the model from the settings and the model id. */
export type AiSdkModelFactories<Model> = {
    openai?: (settings: AiSdkProviderSettings & {
        name: string;
    }, modelId: string) => Model;
    anthropic?: (settings: AiSdkProviderSettings, modelId: string) => Model;
};
export type AiSdkModelOptions = {
    apiKey: string;
    /** The provider name. Default the endpoint's `provider`, then `openai-compatible` for OpenAI and none for Anthropic. */
    name?: string;
    headers?: Record<string, string>;
    /** The fetch the SDK calls; wrapped by `transformBody` when that is given. */
    fetch?: typeof fetch;
    /** Rewrites each JSON request body before it is sent; see `bodyRewritingFetch`. */
    transformBody?: (body: Record<string, unknown>) => Record<string, unknown>;
};
/**
 * A fetch that rewrites JSON request bodies. A body that is not a JSON object
 * string, or that `transform` throws on, is sent unchanged; a failed request
 * is never sent twice.
 */
export declare function bodyRewritingFetch(transform: (body: Record<string, unknown>) => Record<string, unknown>, base?: typeof fetch): typeof fetch;
/** The provider settings for an endpoint, for an app that calls the factory itself. */
export declare function aiSdkProviderSettings(endpoint: ModelEndpoint, options: AiSdkModelOptions): AiSdkProviderSettings;
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
export declare function createAiSdkModel<Model>(endpoint: ModelEndpoint, factories: AiSdkModelFactories<Model>, options: AiSdkModelOptions): Model;
