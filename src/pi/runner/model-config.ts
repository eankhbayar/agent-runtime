// Which model the runner talks to, from its environment. Without LLM_API the
// model is one in pi's built-in catalog, as before. With LLM_API the runner
// registers a provider of its own for a model pi does not know, such as one
// behind an OpenAI-compatible endpoint, so no models.json is read or written.
//
//   LLM_API              openai (Chat Completions) or anthropic (Messages);
//                        pi's names openai-completions and anthropic-messages also work
//   LLM_PROVIDER         the provider id to register; default openai-compatible
//                        or anthropic-compatible
//   LLM_MODEL            the model id sent to the endpoint (required)
//   LLM_BASE_URL         the endpoint, normally the egress gateway (required). For
//                        openai, a bare origin gets /v1 added, so the gateway's
//                        base URL works unchanged in both formats.
//   LLM_CONTEXT_WINDOW   tokens, default 128000
//   LLM_MAX_TOKENS       output tokens per call, default 32768
//   LLM_REASONING        true (default) or false: whether the model takes a
//                        reasoning effort (THINKING_LEVEL)
//   LLM_COMPAT           optional JSON object, pi's per-model `compat` settings

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 32_768;

/** A model in pi's built-in catalog, or one the runner registers itself. */
export type RunnerModelConfig =
  | { kind: "catalog"; provider: string; model: string }
  | {
      kind: "custom";
      provider: string;
      model: string;
      api: "openai-completions" | "anthropic-messages";
      baseUrl: string;
      contextWindow: number;
      maxTokens: number;
      reasoning: boolean;
      compat?: Record<string, unknown>;
    };

const APIS: Record<string, "openai-completions" | "anthropic-messages"> = {
  openai: "openai-completions",
  "openai-completions": "openai-completions",
  anthropic: "anthropic-messages",
  "anthropic-messages": "anthropic-messages",
};

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function flag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${name} must be true or false`);
}

function compatOf(env: NodeJS.ProcessEnv): Record<string, unknown> | undefined {
  if (!env.LLM_COMPAT) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(env.LLM_COMPAT);
  } catch {
    throw new Error("LLM_COMPAT must be a JSON object");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("LLM_COMPAT must be a JSON object");
  }
  return value as Record<string, unknown>;
}

/**
 * LLM_BASE_URL without a trailing slash. The OpenAI client posts to
 * `<baseUrl>/chat/completions`, so for openai a bare origin gets the /v1 the
 * gateway serves; the Anthropic client adds /v1/messages itself.
 */
function baseUrlOf(raw: string, openai: boolean): string {
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch {}
  if (url?.protocol !== "http:" && url?.protocol !== "https:") {
    throw new Error("LLM_BASE_URL must be an http or https URL");
  }
  const trimmed = raw.replace(/\/+$/, "");
  return openai && url.pathname === "/" ? `${trimmed}/v1` : trimmed;
}

/** Reads the model's configuration from the environment; throws on anything unusable. */
export function resolveModelConfig(
  env: NodeJS.ProcessEnv,
  defaultModel: { provider: string; model: string },
): RunnerModelConfig {
  if (!env.LLM_API) {
    return {
      kind: "catalog",
      provider: env.LLM_PROVIDER ?? defaultModel.provider,
      model: env.LLM_MODEL ?? defaultModel.model,
    };
  }
  const api = APIS[env.LLM_API.toLowerCase()];
  if (!api) throw new Error("LLM_API must be openai or anthropic");
  if (!env.LLM_MODEL) throw new Error("LLM_MODEL is required with LLM_API");
  if (!env.LLM_BASE_URL) throw new Error("LLM_BASE_URL is required with LLM_API");
  const openai = api === "openai-completions";
  const compat = compatOf(env);
  return {
    kind: "custom",
    provider: env.LLM_PROVIDER || (openai ? "openai-compatible" : "anthropic-compatible"),
    model: env.LLM_MODEL,
    api,
    baseUrl: baseUrlOf(env.LLM_BASE_URL, openai),
    contextWindow: positiveInteger(env, "LLM_CONTEXT_WINDOW", DEFAULT_CONTEXT_WINDOW),
    maxTokens: positiveInteger(env, "LLM_MAX_TOKENS", DEFAULT_MAX_TOKENS),
    reasoning: flag(env, "LLM_REASONING", true),
    ...(compat ? { compat } : {}),
  };
}

/** Registers a custom model's provider with pi; a catalog model needs nothing. */
export function registerModel(modelRuntime: ModelRuntime, config: RunnerModelConfig): void {
  if (config.kind === "catalog") return;
  modelRuntime.registerProvider(config.provider, {
    baseUrl: config.baseUrl,
    api: config.api,
    models: [
      {
        id: config.model,
        name: config.model,
        reasoning: config.reasoning,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: config.contextWindow,
        maxTokens: config.maxTokens,
        ...(config.compat ? { compat: config.compat as never } : {}),
      },
    ],
  });
}
