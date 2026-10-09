import { describe, expect, it } from "vitest";

import { anthropicUsage, modelCost, openAiUsage, turnUsage } from "./usage.ts";

describe("usage", () => {
  it("splits OpenAI's reasoning tokens out of its completion tokens", () => {
    expect(
      openAiUsage({
        prompt_tokens: 1000,
        completion_tokens: 300,
        prompt_tokens_details: { cached_tokens: 400 },
        completion_tokens_details: { reasoning_tokens: 200 },
      }),
    ).toEqual({ inputTokens: 1000, outputTokens: 100, reasoningTokens: 200, cacheReadTokens: 400, cacheWriteTokens: 0 });
  });

  it("adds Anthropic's cache tokens to its input", () => {
    expect(
      anthropicUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }),
    ).toEqual({ inputTokens: 130, outputTokens: 5, reasoningTokens: 0, cacheReadTokens: 100, cacheWriteTokens: 20 });
  });

  it("counts missing or malformed fields as 0", () => {
    expect(openAiUsage(undefined)).toEqual(openAiUsage({}));
    expect(openAiUsage({ prompt_tokens: -1, completion_tokens: "9" }).inputTokens).toBe(0);
    expect(anthropicUsage(null).inputTokens).toBe(0);
  });

  it("prices output and reasoning at the output rate, as hk-legal's pay-as-you-go equivalent", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 400_000, reasoningTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const cost = modelCost(usage, { inputUsdPerMillionTokens: 0.2, outputUsdPerMillionTokens: 1.2 });
    expect(cost).toEqual({ input: 0.2, output: 0.6, cacheRead: 0, cacheWrite: 0, total: 0.8 });
  });

  it("gives a turn in pi's convention: input without the cache, output with reasoning", () => {
    const usage = { inputTokens: 1000, outputTokens: 100, reasoningTokens: 200, cacheReadTokens: 400, cacheWriteTokens: 0 };
    expect(turnUsage(usage)).toEqual({
      input: 600,
      output: 300,
      cacheRead: 400,
      cacheWrite: 0,
      totalTokens: 1300,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    const priced = turnUsage(usage, {
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 10,
      cacheReadUsdPerMillionTokens: 0.1,
    });
    expect(priced.cost).toEqual({ input: 0.0006, output: 0.003, cacheRead: 0.00004, cacheWrite: 0, total: 0.00364 });
  });
});
