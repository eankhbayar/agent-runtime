// Token counts from either format's usage object, their cost, and the
// per-turn usage shape the run trace sums (what pi reports on `turn_end`).

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

export function emptyModelUsage(): ModelUsage {
  return { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Chat Completions `usage`: `prompt_tokens` (cached tokens included, counted
 * in `prompt_tokens_details.cached_tokens`) and `completion_tokens`, of which
 * `completion_tokens_details.reasoning_tokens` were reasoning.
 */
export function openAiUsage(usage: unknown): ModelUsage {
  const root = record(usage);
  const prompt = record(root.prompt_tokens_details);
  const completion = record(root.completion_tokens_details);
  const inputTokens = count(root.prompt_tokens);
  const completionTokens = count(root.completion_tokens);
  const reasoningTokens = Math.min(completionTokens, count(completion.reasoning_tokens));
  return {
    inputTokens,
    outputTokens: completionTokens - reasoningTokens,
    reasoningTokens,
    cacheReadTokens: Math.min(inputTokens, count(prompt.cached_tokens)),
    cacheWriteTokens: 0,
  };
}

/**
 * Messages `usage`: `input_tokens` excludes the cache, so the cache reads and
 * writes are added to it. Reasoning is not reported apart from output.
 */
export function anthropicUsage(usage: unknown): ModelUsage {
  const root = record(usage);
  const cacheReadTokens = count(root.cache_read_input_tokens);
  const cacheWriteTokens = count(root.cache_creation_input_tokens);
  return {
    inputTokens: count(root.input_tokens) + cacheReadTokens + cacheWriteTokens,
    outputTokens: count(root.output_tokens),
    reasoningTokens: 0,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

export function addModelUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

const usd = (tokens: number, perMillion: number) => Number(((tokens * perMillion) / 1_000_000).toFixed(8));

/**
 * The call's cost in US dollars, each part rounded to eight places. Output is
 * priced over output and reasoning tokens together. With no cache rates this
 * is input × input rate + (output + reasoning) × output rate, which is
 * hk-legal's pay-as-you-go equivalent.
 */
export function modelCost(usage: ModelUsage, pricing: ModelPricing): TurnUsage["cost"] {
  const uncached = Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens);
  const input = usd(uncached, pricing.inputUsdPerMillionTokens);
  const output = usd(usage.outputTokens + usage.reasoningTokens, pricing.outputUsdPerMillionTokens);
  const cacheRead = usd(
    usage.cacheReadTokens,
    pricing.cacheReadUsdPerMillionTokens ?? pricing.inputUsdPerMillionTokens,
  );
  const cacheWrite = usd(
    usage.cacheWriteTokens,
    pricing.cacheWriteUsdPerMillionTokens ?? pricing.inputUsdPerMillionTokens,
  );
  return { input, output, cacheRead, cacheWrite, total: Number((input + output + cacheRead + cacheWrite).toFixed(8)) };
}

/**
 * The call as one turn of the run trace, in pi's convention: `input` without
 * the cache, `output` with reasoning, cost 0 without pricing. Pass it as a
 * pipeline's `usage`, or as a `turn_end`'s `usage` payload.
 */
export function turnUsage(usage: ModelUsage, pricing?: ModelPricing): TurnUsage {
  const input = Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens);
  const output = usage.outputTokens + usage.reasoningTokens;
  return {
    input,
    output,
    cacheRead: usage.cacheReadTokens,
    cacheWrite: usage.cacheWriteTokens,
    totalTokens: usage.inputTokens + output,
    cost: pricing
      ? modelCost(usage, pricing)
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
