import type { RunUsage } from "../contract/events.ts";
/**
 * One call's tokens, the same way round in both formats. `inputTokens` is
 * every prompt token, cache reads and writes included; `outputTokens` is the
 * visible output and `reasoningTokens` the reasoning the endpoint reported
 * separately, so the two add up to what the call billed as output.
 */
export type ModelUsage = {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    /** Of `inputTokens`, how many were read from the prompt cache. */
    cacheReadTokens: number;
    /** Of `inputTokens`, how many were written to the prompt cache (Anthropic). */
    cacheWriteTokens: number;
};
/** US dollars per million tokens. Cache rates default to the input rate. */
export type ModelPricing = {
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
    cacheReadUsdPerMillionTokens?: number;
    cacheWriteUsdPerMillionTokens?: number;
};
/** What one `turn_end` carries as `usage`: a RunUsage without `turns`. */
export type TurnUsage = Omit<RunUsage, "turns">;
export declare function emptyModelUsage(): ModelUsage;
/**
 * Chat Completions `usage`: `prompt_tokens` (cached tokens included, counted
 * in `prompt_tokens_details.cached_tokens`) and `completion_tokens`, of which
 * `completion_tokens_details.reasoning_tokens` were reasoning.
 */
export declare function openAiUsage(usage: unknown): ModelUsage;
/**
 * Messages `usage`: `input_tokens` excludes the cache, so the cache reads and
 * writes are added to it. Reasoning is not reported apart from output.
 *
 * hk-legal's kimi-provider.ts counts `input_tokens` alone. With prompt caching
 * in use, `inputTokens` here is larger, and so is anything budgeted on it.
 */
export declare function anthropicUsage(usage: unknown): ModelUsage;
export declare function addModelUsage(a: ModelUsage, b: ModelUsage): ModelUsage;
/**
 * The call's cost in US dollars. Output is priced over output and reasoning
 * tokens together. With no cache rates this is input × input rate +
 * (output + reasoning) × output rate, hk-legal's pay-as-you-go equivalent.
 *
 * Each part is rounded to eight places and `total` is their rounded sum,
 * where hk-legal's model-invocation.ts rounds only the total; totals can
 * differ from its figures in the eighth place.
 */
export declare function modelCost(usage: ModelUsage, pricing: ModelPricing): TurnUsage["cost"];
/**
 * The call as one turn of the run trace, in pi's convention: `input` without
 * the cache, `output` with reasoning, cost 0 without pricing. Pass it as a
 * pipeline's `usage`, or as a `turn_end`'s `usage` payload.
 */
export declare function turnUsage(usage: ModelUsage, pricing?: ModelPricing): TurnUsage;
