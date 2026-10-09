import { describe, expect, expectTypeOf, it } from "vitest";

import type { GatewayUpstream } from "../core/gateway-handler.ts";
import type { LlmConfig } from "../providers/docker/gateway.ts";

import {
  apiKeyFor,
  endpointUrl,
  modelEndpoint,
  modelEndpointFromEnv,
  parseModelFormat,
  sdkBaseUrl,
  type ModelEndpoint,
  type ModelUpstream,
} from "./endpoint.ts";

describe("parseModelFormat", () => {
  it("accepts the names the apps configure", () => {
    for (const name of ["openai", "OpenAI-Compatible", "chat-completions", "openai-completions"]) {
      expect(parseModelFormat(name)).toBe("openai");
    }
    for (const name of ["anthropic", "anthropic-compatible", "messages", " Anthropic-Messages "]) {
      expect(parseModelFormat(name)).toBe("anthropic");
    }
    expect(() => parseModelFormat("gemini")).toThrow(/openai or anthropic/);
  });
});

describe("modelEndpoint", () => {
  it("takes an Anthropic URL as the endpoint, its /v1 base or a bare origin", () => {
    for (const url of [
      "https://api.kimi.com/coding/v1/messages",
      "https://api.kimi.com/coding/v1/",
      "https://api.kimi.com/coding",
    ]) {
      expect(modelEndpoint({ format: "anthropic", url, model: "kimi-for-coding" })).toEqual({
        format: "anthropic",
        messagesUrl: "https://api.kimi.com/coding/v1/messages",
        model: "kimi-for-coding",
      });
    }
  });

  it("takes an OpenAI URL as the base or the full chat completions endpoint", () => {
    for (const url of ["https://api.lel190.dev/v1", "https://api.lel190.dev/v1/chat/completions/"]) {
      expect(modelEndpoint({ format: "openai-compatible", url, model: " gpt-6-luna ", apiKeyEnv: "KIMI_API_KEY" })).toEqual({
        format: "openai",
        baseUrl: "https://api.lel190.dev/v1",
        model: "gpt-6-luna",
        apiKeyEnv: "KIMI_API_KEY",
      });
    }
  });

  it("refuses a URL that is not http(s), carries credentials, or a blank model", () => {
    expect(() => modelEndpoint({ format: "openai", url: "ftp://x", model: "m" })).toThrow(/http/);
    expect(() => modelEndpoint({ format: "openai", url: "https://k:s@x/v1", model: "m" })).toThrow(/credentials/);
    expect(() => modelEndpoint({ format: "openai", url: "https://x/v1", model: " " })).toThrow(/Model id/);
  });

  it("reads the variables an app names, with its defaults", () => {
    const names = { format: "MODEL_FORMAT", url: "MODEL_BASE_URL", model: "MODEL_ID", apiKey: "KIMI_API_KEY" };
    const defaults = { format: "openai", url: "https://api.lel190.dev/v1", model: "gpt-6-luna", provider: "hkjc-chat" };
    expect(modelEndpointFromEnv({ MODEL_ID: "gpt-6-sol", MODEL_BASE_URL: " " }, names, defaults)).toEqual({
      format: "openai",
      baseUrl: "https://api.lel190.dev/v1",
      model: "gpt-6-sol",
      apiKeyEnv: "KIMI_API_KEY",
      provider: "hkjc-chat",
    });
    expect(() => modelEndpointFromEnv({}, { format: "KIMI_API_FORMAT", url: "KIMI_CODE_API_URL", model: "M" })).toThrow(
      "KIMI_API_FORMAT is not configured",
    );
  });

  it("derives where calls go and the base an SDK wants", () => {
    const anthropic = modelEndpoint({ format: "anthropic", url: "https://api.kimi.com/coding/v1", model: "k" });
    const openai = modelEndpoint({ format: "openai", url: "https://api.lel190.dev/v1", model: "g" });
    expect(endpointUrl(anthropic)).toBe("https://api.kimi.com/coding/v1/messages");
    expect(sdkBaseUrl(anthropic)).toBe("https://api.kimi.com/coding/v1");
    expect(endpointUrl(openai)).toBe("https://api.lel190.dev/v1/chat/completions");
    expect(sdkBaseUrl(openai)).toBe("https://api.lel190.dev/v1");
    // A Messages endpoint without the format field is Anthropic, as for the gateway.
    expect(endpointUrl({ messagesUrl: "https://x/v1/messages" })).toBe("https://x/v1/messages");
  });

  it("reads the key from the variable the endpoint names", () => {
    expect(apiKeyFor({ apiKeyEnv: "KIMI_API_KEY" }, { KIMI_API_KEY: " sk-1 " })).toBe("sk-1");
    expect(() => apiKeyFor({ apiKeyEnv: "KIMI_API_KEY" }, {})).toThrow("KIMI_API_KEY is not set");
    expect(() => apiKeyFor({}, {})).toThrow(/apiKeyEnv/);
  });
});

describe("ModelEndpoint", () => {
  it("has the gateway's upstream shape, so it spreads into the gateway and a Docker LlmConfig", () => {
    expectTypeOf<ModelUpstream>().toEqualTypeOf<GatewayUpstream>();
    expectTypeOf<ModelEndpoint>().toExtend<GatewayUpstream>();
    const endpoint = modelEndpoint({ format: "openai", url: "https://x/v1", model: "m", provider: "p" });
    const llm: LlmConfig = { ...endpoint, provider: endpoint.provider ?? "p", apiKey: "k" };
    expect(llm).toMatchObject({ format: "openai", baseUrl: "https://x/v1", model: "m" });
  });
});
