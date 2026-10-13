export type ModelFormat = "openai" | "anthropic";
/** The URL half of an endpoint: GatewayUpstream's shape. */
export type ModelUpstream = {
    /** Anthropic Messages, sent with `x-api-key`. */
    format?: "anthropic";
    /** The full Messages endpoint, e.g. `https://api.kimi.com/coding/v1/messages`. */
    messagesUrl: string;
} | {
    /** OpenAI Chat Completions, sent with `Authorization: Bearer`. */
    format: "openai";
    /** The API base; calls go to `<baseUrl>/chat/completions`. */
    baseUrl: string;
};
export type ModelEndpoint = ModelUpstream & {
    /** The model id the endpoint expects, e.g. `gpt-6-luna`. */
    model: string;
    /** The environment variable that holds the key, e.g. `KIMI_API_KEY`. Never the key itself. */
    apiKeyEnv?: string;
    /** A name for logs, traces and an AI SDK provider, e.g. `kimi`. */
    provider?: string;
};
/**
 * `openai` or `anthropic` from a configured value, accepting the names the
 * apps' settings already use (`openai-compatible`, `chat-completions`,
 * `anthropic-compatible`, `messages`, pi's `openai-completions` and
 * `anthropic-messages`), in any case.
 */
export declare function parseModelFormat(value: string): ModelFormat;
export declare function formatOf(endpoint: ModelUpstream): ModelFormat;
export type ModelEndpointInput = {
    format: string;
    /**
     * Any form the apps configure. Anthropic: the Messages endpoint
     * (`…/v1/messages`), its `/v1` base, or a bare origin (`/v1/messages` is
     * added). OpenAI: the base (`…/v1`) or the full `…/chat/completions`.
     */
    url: string;
    model: string;
    apiKeyEnv?: string;
    provider?: string;
};
/** A normalised endpoint from loosely written configuration; throws on a bad format, URL or model. */
export declare function modelEndpoint(input: ModelEndpointInput): ModelEndpoint;
export type ModelEnvNames = {
    /** Holds the format, e.g. `KIMI_API_FORMAT`. */
    format?: string;
    /** Holds the URL, e.g. `KIMI_CODE_API_URL`. */
    url: string;
    /** Holds the model id, e.g. `MODEL_ID`. */
    model: string;
    /** Holds the key, e.g. `KIMI_API_KEY`. Recorded as `apiKeyEnv`; the key is not read. */
    apiKey?: string;
};
export type ModelEnvDefaults = {
    format?: string;
    url?: string;
    model?: string;
    provider?: string;
};
/**
 * An endpoint from environment variables the app names, falling back to its
 * defaults for unset or blank ones. Takes the environment as an argument, so
 * it works wherever the app gets its variables from (`process.env`, Convex's
 * `env`).
 */
export declare function modelEndpointFromEnv(env: Readonly<Record<string, string | undefined>>, names: ModelEnvNames, defaults?: ModelEnvDefaults): ModelEndpoint;
/** Where a call is posted: the Messages endpoint, or `<baseUrl>/chat/completions`. */
export declare function endpointUrl(endpoint: ModelUpstream): string;
/**
 * The base URL an SDK appends its own path to: the OpenAI base as it is, and
 * the Messages endpoint without `/messages` (the AI SDK's and Anthropic SDK's
 * `baseURL`, e.g. `https://api.kimi.com/coding/v1`).
 */
export declare function sdkBaseUrl(endpoint: ModelUpstream): string;
/** The key from the variable the endpoint names; throws, naming the variable, when it is unset. */
export declare function apiKeyFor(endpoint: Pick<ModelEndpoint, "apiKeyEnv">, env: Readonly<Record<string, string | undefined>>): string;
