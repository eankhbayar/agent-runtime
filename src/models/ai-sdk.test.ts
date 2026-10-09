import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { afterEach, describe, expect, it } from "vitest";

import { startFakeUpstream, type FakeUpstream } from "../testing/fake-upstream.ts";

import { aiSdkProviderSettings, bodyRewritingFetch, createAiSdkModel } from "./ai-sdk.ts";
import { modelEndpoint } from "./endpoint.ts";

// The AI SDK packages are dev dependencies only: the adapter takes the app's
// own factories. These are the versions the apps resolve: HKJC pins
// @ai-sdk/openai-compatible 3.0.51; hk-legal's Convex takes @ai-sdk/openai
// ^4.0.45 (createOpenAI().chat) and @ai-sdk/anthropic ^4.0.40.

const KEY = "sk-test-key";
let upstream: FakeUpstream | undefined;

afterEach(async () => {
  await upstream?.close();
  upstream = undefined;
});

const factories = {
  openai: (settings: Parameters<typeof createOpenAICompatible>[0], id: string) =>
    createOpenAICompatible(settings).chatModel(id),
  anthropic: (settings: Parameters<typeof createAnthropic>[0], id: string) =>
    createAnthropic(settings).languageModel(id),
};

const prompt = [
  { role: "system" as const, content: "Answer briefly." },
  { role: "user" as const, content: [{ type: "text" as const, text: "Say hello." }] },
];

describe("createAiSdkModel", () => {
  it("builds an OpenAI-compatible model that calls the endpoint with the key", async () => {
    upstream = await startFakeUpstream({ apiKey: KEY });
    const endpoint = modelEndpoint({ format: "openai", url: upstream.baseUrl, model: "gpt-6-luna", provider: "hkjc-chat" });
    const model = createAiSdkModel(endpoint, factories, { apiKey: KEY });
    expect(model.provider).toBe("hkjc-chat.chat");
    expect(model.modelId).toBe("gpt-6-luna");
    const result = await model.doGenerate({ prompt, maxOutputTokens: 64 });
    expect(result.content).toEqual([{ type: "text", text: "Hello from the fake model." }]);
    const [request] = upstream.requests;
    expect(request!.path).toBe("/v1/chat/completions");
    expect(request!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(request!.body.model).toBe("gpt-6-luna");
  });

  it("builds an Anthropic model from the Messages endpoint, whichever form it was given in", async () => {
    upstream = await startFakeUpstream({ apiKey: KEY });
    const endpoint = modelEndpoint({ format: "messages", url: upstream.messagesUrl, model: "kimi-for-coding" });
    const model = createAiSdkModel(endpoint, factories, { apiKey: KEY });
    expect(model.provider).toBe("anthropic.messages");
    const result = await model.doGenerate({ prompt, maxOutputTokens: 64 });
    expect(result.content).toEqual([{ type: "text", text: "Hello from the fake model." }]);
    const [request] = upstream.requests;
    expect(request!.path).toBe("/v1/messages");
    expect(request!.headers["x-api-key"]).toBe(KEY);
  });

  it("builds hk-legal's createOpenAI().chat model the same way", async () => {
    upstream = await startFakeUpstream({ apiKey: KEY });
    const endpoint = modelEndpoint({ format: "openai", url: `${upstream.baseUrl}/chat/completions`, model: "gpt-6.1-sol", provider: "kimi" });
    const model = createAiSdkModel(endpoint, { openai: (settings, id) => createOpenAI(settings).chat(id) }, { apiKey: KEY });
    expect(model.provider).toBe("kimi.chat");
    const result = await model.doGenerate({ prompt, maxOutputTokens: 64 });
    expect(result.content).toEqual([{ type: "text", text: "Hello from the fake model." }]);
    expect(upstream.requests[0]!.path).toBe("/v1/chat/completions");
    expect(upstream.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("rewrites the body the SDK sends, as hk-legal's kimiFetch does", async () => {
    upstream = await startFakeUpstream({ apiKey: KEY });
    const endpoint = modelEndpoint({ format: "openai", url: upstream.baseUrl, model: "gpt-6-luna" });
    const model = createAiSdkModel(endpoint, factories, {
      apiKey: KEY,
      transformBody: (body) => ({ ...body, thinking: { type: "disabled" } }),
    });
    await model.doGenerate({ prompt, maxOutputTokens: 64 });
    expect(upstream.requests[0]!.body.thinking).toEqual({ type: "disabled" });
  });

  it("throws for a format the app gave no factory for", () => {
    const endpoint = modelEndpoint({ format: "anthropic", url: "https://x/v1", model: "m" });
    expect(() => createAiSdkModel(endpoint, { openai: factories.openai }, { apiKey: KEY })).toThrow(/anthropic/);
  });
});

describe("aiSdkProviderSettings", () => {
  it("names an OpenAI provider by default and an Anthropic one only after its endpoint", () => {
    const openai = modelEndpoint({ format: "openai", url: "https://x/v1/chat/completions", model: "m" });
    const anthropic = modelEndpoint({ format: "anthropic", url: "https://y/v1/messages", model: "m" });
    expect(aiSdkProviderSettings(openai, { apiKey: KEY })).toEqual({
      baseURL: "https://x/v1",
      apiKey: KEY,
      name: "openai-compatible",
    });
    expect(aiSdkProviderSettings(anthropic, { apiKey: KEY })).toEqual({ baseURL: "https://y/v1", apiKey: KEY });
    // An endpoint's provider names either format's provider.
    expect(aiSdkProviderSettings({ ...anthropic, provider: "kimi" }, { apiKey: KEY }).name).toBe("kimi");
    expect(() => aiSdkProviderSettings(openai, { apiKey: "" })).toThrow(/key/);
  });
});

describe("bodyRewritingFetch", () => {
  it("sends a body it cannot rewrite unchanged, and a request once", async () => {
    const sent: RequestInit["body"][] = [];
    const base: typeof fetch = async (_input, init) => {
      sent.push(init?.body);
      throw new TypeError("network down");
    };
    const rewriting = bodyRewritingFetch(() => {
      throw new Error("cannot");
    }, base);
    await expect(rewriting("https://x", { method: "POST", body: '{"a":1}' })).rejects.toThrow("network down");
    await expect(rewriting("https://x", { method: "POST", body: "not json" })).rejects.toThrow("network down");
    expect(sent).toEqual(['{"a":1}', "not json"]);
  });
});
