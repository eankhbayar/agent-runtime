import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
export declare const DEFAULT_CONTEXT_WINDOW = 128000;
export declare const DEFAULT_MAX_TOKENS = 32768;
/** A model in pi's built-in catalog, or one the runner registers itself. */
export type RunnerModelConfig = {
    kind: "catalog";
    provider: string;
    model: string;
} | {
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
/** Reads the model's configuration from the environment; throws on anything unusable. */
export declare function resolveModelConfig(env: NodeJS.ProcessEnv, defaultModel: {
    provider: string;
    model: string;
}): RunnerModelConfig;
/** Registers a custom model's provider with pi; a catalog model needs nothing. */
export declare function registerModel(modelRuntime: ModelRuntime, config: RunnerModelConfig): void;
