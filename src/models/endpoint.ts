// Where a model is called and in which format. The upstream half has the same
// shape as core's GatewayUpstream, so an endpoint can be spread into
// createInProcessGateway or a Docker LlmConfig as it is; the gateway keeps
// only the upstream's own fields.
//
// No Node APIs and no imports outside this directory, so Convex's default
// runtime can use it (see tsconfig.models.json).

export type ModelFormat = "openai" | "anthropic";

/** The URL half of an endpoint: GatewayUpstream's shape. */
export type ModelUpstream =
  | {
      /** Anthropic Messages, sent with `x-api-key`. */
      format?: "anthropic";
      /** The full Messages endpoint, e.g. `https://api.kimi.com/coding/v1/messages`. */
      messagesUrl: string;
    }
  | {
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

const FORMAT_ALIASES: Record<string, ModelFormat> = {
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
export function parseModelFormat(value: string): ModelFormat {
  const format = FORMAT_ALIASES[value.trim().toLowerCase()];
  if (!format) throw new Error(`Model format must be openai or anthropic, not ${JSON.stringify(value)}`);
  return format;
}

export function formatOf(endpoint: ModelUpstream): ModelFormat {
  return endpoint.format === "openai" ? "openai" : "anthropic";
}

function httpUrl(value: string, name: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${name} must be an http or https URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${name} must be an http or https URL`);
  }
  if (url.username || url.password) throw new Error(`${name} must not carry credentials`);
  return trimmed;
}

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
export function modelEndpoint(input: ModelEndpointInput): ModelEndpoint {
  const format = parseModelFormat(input.format);
  const model = input.model.trim();
  if (!model) throw new Error("Model id is required");
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
export function modelEndpointFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  names: ModelEnvNames,
  defaults: ModelEnvDefaults = {},
): ModelEndpoint {
  const read = (name: string | undefined, fallback: string | undefined, what: string): string => {
    const value = (name ? env[name]?.trim() : undefined) || fallback;
    if (!value) throw new Error(`${name ?? what} is not configured`);
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
export function endpointUrl(endpoint: ModelUpstream): string {
  return endpoint.format === "openai"
    ? `${endpoint.baseUrl.replace(/\/+$/, "")}/chat/completions`
    : endpoint.messagesUrl;
}

/**
 * The base URL an SDK appends its own path to: the OpenAI base as it is, and
 * the Messages endpoint without `/messages` (the AI SDK's and Anthropic SDK's
 * `baseURL`, e.g. `https://api.kimi.com/coding/v1`).
 */
export function sdkBaseUrl(endpoint: ModelUpstream): string {
  if (endpoint.format === "openai") return endpoint.baseUrl.replace(/\/+$/, "");
  const url = endpoint.messagesUrl.replace(/\/+$/, "");
  return url.endsWith("/messages") ? url.slice(0, -"/messages".length) : url;
}

/** The key from the variable the endpoint names; throws, naming the variable, when it is unset. */
export function apiKeyFor(
  endpoint: Pick<ModelEndpoint, "apiKeyEnv">,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (!endpoint.apiKeyEnv) throw new Error("The model endpoint names no apiKeyEnv");
  const key = env[endpoint.apiKeyEnv]?.trim();
  if (!key) throw new Error(`${endpoint.apiKeyEnv} is not set`);
  return key;
}
