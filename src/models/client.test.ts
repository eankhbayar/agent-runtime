import { afterEach, describe, expect, it } from "vitest";

import { startFakeUpstream, type FakeUpstream, type FakeUpstreamOptions } from "../testing/fake-upstream.ts";

import { callModel, type ModelCallRequest } from "./client.ts";
import { modelEndpoint, type ModelEndpoint } from "./endpoint.ts";
import { ModelCallError } from "./errors.ts";

const KEY = "sk-test-key";
let upstream: FakeUpstream | undefined;

afterEach(async () => {
  await upstream?.close();
  upstream = undefined;
});

async function start(options: Partial<FakeUpstreamOptions> = {}) {
  upstream = await startFakeUpstream({ apiKey: KEY, ...options });
  return {
    openai: modelEndpoint({ format: "openai", url: upstream.baseUrl, model: "gpt-6-luna" }),
    anthropic: modelEndpoint({ format: "anthropic", url: upstream.messagesUrl, model: "kimi-for-coding" }),
  };
}

const ask: ModelCallRequest = {
  system: "Answer briefly.",
  messages: [{ role: "user", content: "Say hello." }],
  maxOutputTokens: 256,
};

async function failure(promise: Promise<unknown>): Promise<ModelCallError> {
  const error = await promise.then(
    () => {
      throw new Error("the call succeeded");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ModelCallError);
  return error as ModelCallError;
}

/** A fetch answering every call with one fixed response. */
function answering(body: string, init: ResponseInit): typeof fetch {
  return async () => new Response(body, init);
}

describe("callModel, OpenAI format", () => {
  it("sends one Chat Completions call and returns the text, usage and ids", async () => {
    const { openai } = await start();
    const result = await callModel(
      openai,
      {
        ...ask,
        reasoningEffort: "high",
        structuredOutput: { name: "answer", strict: true, schema: { type: "object" } },
        extraBody: { model: "not-this-one", temperature: 0 },
      },
      { apiKey: KEY, headers: { "x-api-key": "leak", authorization: "Bearer other", "x-trace": "1" } },
    );
    expect(result).toMatchObject({
      text: "Hello from the fake model.",
      usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0 },
      stopReason: "stop",
      model: "fake-model",
      responseId: "chatcmpl_fake",
      createdAt: 0,
    });
    const [request] = upstream!.requests;
    expect(request!.path).toBe("/v1/chat/completions");
    expect(request!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(request!.headers["x-api-key"]).toBeUndefined();
    expect(request!.headers["x-trace"]).toBe("1");
    expect(request!.body).toEqual({
      temperature: 0,
      model: "gpt-6-luna",
      messages: [
        { role: "system", content: "Answer briefly." },
        { role: "user", content: "Say hello." },
      ],
      max_tokens: 256,
      reasoning_effort: "high",
      response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema: { type: "object" } } },
      stream: false,
    });
  });

  it("streams, passing the text on as it comes and taking usage from the last chunk", async () => {
    const { openai } = await start({ reply: () => "one two three" });
    const deltas: string[] = [];
    let progress = 0;
    let connected = 0;
    const result = await callModel(openai, { ...ask, stream: true }, {
      apiKey: KEY,
      maxTokensField: "max_completion_tokens",
      onText: (delta) => deltas.push(delta),
      onProgress: () => progress++,
      onConnected: () => connected++,
    });
    expect(deltas.join("")).toBe("one two three");
    expect(deltas.length).toBe(3);
    expect(result.text).toBe("one two three");
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 3 });
    expect(result.stopReason).toBe("stop");
    expect(connected).toBe(1);
    expect(progress).toBeGreaterThan(0);
    expect(upstream!.requests[0]!.body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 256,
    });
  });

  it("reads a JSON answer when the endpoint ignored stream", async () => {
    const endpoint = modelEndpoint({ format: "openai", url: "https://model.invalid/v1", model: "m" });
    const body = JSON.stringify({ choices: [{ message: { content: "plain" }, finish_reason: "stop" }] });
    const result = await callModel(endpoint, { ...ask, stream: true }, {
      apiKey: KEY,
      fetch: answering(body, { headers: { "content-type": "application/json", "x-request-id": "req_1" } }),
    });
    expect(result).toMatchObject({ text: "plain", requestId: "req_1" });
  });
});

describe("callModel, Anthropic format", () => {
  it("sends one Messages call with the key as x-api-key", async () => {
    const { anthropic } = await start();
    const result = await callModel(anthropic, ask, { apiKey: KEY, headers: { "anthropic-beta": "b1" } });
    expect(result).toMatchObject({
      text: "Hello from the fake model.",
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: "end_turn",
      responseId: "msg_fake",
    });
    const [request] = upstream!.requests;
    expect(request!.path).toBe("/v1/messages");
    expect(request!.headers["x-api-key"]).toBe(KEY);
    expect(request!.headers.authorization).toBeUndefined();
    expect(request!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(request!.headers["anthropic-beta"]).toBe("b1");
    expect(request!.body).toEqual({
      model: "kimi-for-coding",
      max_tokens: 256,
      system: "Answer briefly.",
      messages: [{ role: "user", content: "Say hello." }],
    });
  });

  it("streams, with usage from message_start and message_delta", async () => {
    const { anthropic } = await start({ reply: () => "alpha beta" });
    const deltas: string[] = [];
    const result = await callModel(anthropic, { ...ask, stream: true }, { apiKey: KEY, onText: (d) => deltas.push(d) });
    expect(deltas).toEqual(["alpha ", "beta"]);
    expect(result).toMatchObject({
      text: "alpha beta",
      usage: { inputTokens: 10, outputTokens: 2 },
      stopReason: "end_turn",
      model: "fake-model",
    });
  });

  it("refuses structured output without calling the endpoint", async () => {
    const { anthropic } = await start();
    const error = await failure(
      callModel(anthropic, { ...ask, structuredOutput: { name: "x", schema: {} } }, { apiKey: KEY }),
    );
    expect(error.code).toBe("structured_output_unsupported");
    expect(upstream!.requests).toHaveLength(0);
  });

  it("fails with the error a stream sends partway", async () => {
    const endpoint = modelEndpoint({ format: "anthropic", url: "https://model.invalid", model: "m" });
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":3}}}\n\n',
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"busy with your prompt"}}\n\n',
    ].join("");
    const error = await failure(
      callModel(endpoint, { ...ask, stream: true }, {
        apiKey: KEY,
        fetch: answering(sse, { headers: { "content-type": "text/event-stream" } }),
      }),
    );
    expect(error).toMatchObject({ code: "overload", retryable: true, provider: { type: "overloaded_error" } });
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain("prompt");
  });
});

describe("callModel failures", () => {
  it("names a refusal by its status and keeps nothing of the body but identifiers", async () => {
    const { openai } = await start({
      refuse: () => ({
        status: 401,
        body: { error: { message: "bad key sk-live-123 for prompt 'Say hello.'", type: "invalid_request_error", code: "invalid_api_key" } },
      }),
    });
    const error = await failure(callModel(openai, ask, { apiKey: KEY }));
    expect(error).toMatchObject({
      code: "authentication_failed",
      retryable: false,
      status: 401,
      provider: { type: "invalid_request_error", code: "invalid_api_key" },
    });
    expect(error.message).toBe("authentication_failed");
    const everything = JSON.stringify({ ...error, message: error.message, stack: error.stack });
    expect(everything).not.toContain("sk-live-123");
    expect(everything).not.toContain("Say hello");
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain(upstream!.baseUrl);
  });

  it("is retryable after the time retry-after asks for on a 429", async () => {
    const { openai } = await start({ refuse: () => ({ status: 429, headers: { "retry-after": "2" } }) });
    const error = await failure(callModel(openai, ask, { apiKey: KEY }));
    expect(error).toMatchObject({ code: "concurrency_throttle", retryable: true, retryAfterMs: 2_000 });
  });

  it("reads what the endpoint names: an overflowing context, quota, overload", async () => {
    let refusal = { status: 400, body: { error: { code: "context_length_exceeded" } } as unknown };
    const { openai, anthropic } = await start({ refuse: () => refusal });
    expect((await failure(callModel(openai, ask, { apiKey: KEY }))).code).toBe("context_overflow");
    refusal = { status: 429, body: { error: { code: "insufficient_quota" } } };
    expect((await failure(callModel(openai, ask, { apiKey: KEY }))).code).toBe("quota_exhausted");
    refusal = { status: 529, body: { type: "error", error: { type: "overloaded_error" } } };
    expect((await failure(callModel(anthropic, ask, { apiKey: KEY }))).code).toBe("overload");
    refusal = { status: 503, body: "<html>down</html>" };
    expect((await failure(callModel(anthropic, ask, { apiKey: KEY })))).toMatchObject({ code: "http_5xx", retryable: true });
  });

  it("lets the app classify a refusal first, e.g. from a provider's own header", async () => {
    const { openai } = await start({
      refuse: () => ({ status: 403, headers: { "x-kimi-error-code": "QUOTA_EXHAUSTED" } }),
    });
    const error = await failure(
      callModel(openai, ask, {
        apiKey: KEY,
        classify: ({ headers }) =>
          headers.get("x-kimi-error-code")?.toLowerCase() === "quota_exhausted" ? "quota_exhausted" : undefined,
      }),
    );
    expect(error.code).toBe("quota_exhausted");
  });

  it("fails with the endpoint's own 401 for a wrong key", async () => {
    const { anthropic } = await start();
    expect((await failure(callModel(anthropic, ask, { apiKey: "sk-wrong" }))).code).toBe("authentication_failed");
  });

  it("times out waiting for headers", async () => {
    const { openai } = await start({ headerDelayMs: 500 });
    const error = await failure(callModel(openai, ask, { apiKey: KEY, timeouts: { connectionMs: 50 } }));
    expect(error).toMatchObject({ code: "connection_timeout", retryable: true });
  });

  it("times out when a stream stops making progress", async () => {
    const { openai } = await start({ gapMs: 500 });
    const error = await failure(
      callModel(openai, { ...ask, stream: true }, { apiKey: KEY, timeouts: { connectionMs: 1_000, noProgressMs: 100 } }),
    );
    expect(error.code).toBe("no_progress_timeout");
  });

  it("times out on the whole call even while it makes progress", async () => {
    const { anthropic } = await start({ gapMs: 40, reply: () => "a ".repeat(50) });
    const error = await failure(
      callModel(anthropic, { ...ask, stream: true }, { apiKey: KEY, timeouts: { noProgressMs: 1_000, invocationMs: 150 } }),
    );
    expect(error.code).toBe("invocation_timeout");
  });

  it("is cancelled by the caller's signal, before or during the call", async () => {
    const { openai } = await start({ gapMs: 50, reply: () => "a ".repeat(50) });
    const early = await failure(callModel(openai, ask, { apiKey: KEY, signal: AbortSignal.abort() }));
    expect(early).toMatchObject({ code: "cancelled", retryable: false });
    expect(upstream!.requests).toHaveLength(0);

    const controller = new AbortController();
    const call = callModel(openai, { ...ask, stream: true }, {
      apiKey: KEY,
      signal: controller.signal,
      onText: () => controller.abort(),
    });
    expect((await failure(call)).code).toBe("cancelled");
  });

  it("stops even when the fetch ignores its signal", async () => {
    const endpoint: ModelEndpoint = { format: "openai", baseUrl: "https://model.invalid/v1", model: "m" };
    const never: typeof fetch = () => new Promise(() => {});
    const error = await failure(callModel(endpoint, ask, { apiKey: KEY, fetch: never, timeouts: { connectionMs: 30 } }));
    expect(error.code).toBe("connection_timeout");
  });

  it("calls a network failure connection_failure and says nothing of the URL", async () => {
    const { openai } = await start();
    await upstream!.close();
    upstream = undefined;
    const error = await failure(callModel(openai, ask, { apiKey: KEY }));
    expect(error).toMatchObject({ code: "connection_failure", retryable: true });
    expect(error.message).toBe("connection_failure");
    expect(error.cause).toBeUndefined();
  });

  it("refuses a 200 that is not an answer, or holds no text", async () => {
    const endpoint: ModelEndpoint = { format: "openai", baseUrl: "https://model.invalid/v1", model: "m" };
    const json = { headers: { "content-type": "application/json" } };
    for (const body of ["not json", "{}", JSON.stringify({ choices: [{ message: { content: "  " } }] })]) {
      const error = await failure(callModel(endpoint, ask, { apiKey: KEY, fetch: answering(body, json) }));
      expect(error.code).toBe("provider_response_invalid");
    }
  });
});

describe("callModel and the app's own errors", () => {
  it("rethrows what the app's callbacks throw as it is, never as a retryable code", async () => {
    const { openai } = await start();
    const bug = new Error("app bug");
    for (const options of [
      { onText: () => { throw bug; } },
      { onProgress: () => { throw bug; } },
      { onConnected: () => { throw bug; } },
    ]) {
      await expect(callModel(openai, { ...ask, stream: true }, { apiKey: KEY, ...options })).rejects.toBe(bug);
    }
  });

  it("rethrows what classify throws as it is", async () => {
    const { openai } = await start({ refuse: () => ({ status: 500 }) });
    const bug = new Error("app bug");
    await expect(callModel(openai, ask, { apiKey: KEY, classify: () => { throw bug; } })).rejects.toBe(bug);
  });

  it("rethrows an extraBody JSON cannot encode without calling the endpoint", async () => {
    const { anthropic } = await start();
    const error = await callModel(anthropic, { ...ask, extraBody: { seed: 1n } }, { apiKey: KEY }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(ModelCallError);
    expect(upstream!.requests).toHaveLength(0);
  });
});

describe("callModel and an unread body", () => {
  /** A fetch that ignores its signal, answering with a stream that sends `chunks` and then hangs. */
  function hanging(chunks: string[]) {
    const state = { cancelled: false };
    const fetch: typeof globalThis.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          },
          cancel() {
            state.cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    return { fetch, state };
  }
  const endpoint: ModelEndpoint = { format: "openai", baseUrl: "https://model.invalid/v1", model: "m" };
  const chunk = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

  it("cancels the body when a timeout stops the call", async () => {
    const { fetch, state } = hanging([chunk("partial")]);
    const error = await failure(
      callModel(endpoint, { ...ask, stream: true }, { apiKey: KEY, fetch, timeouts: { noProgressMs: 30 } }),
    );
    expect(error.code).toBe("no_progress_timeout");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.cancelled).toBe(true);
  });

  it("cancels the body when an event cannot be parsed", async () => {
    const { fetch, state } = hanging(["data: {not json\n\n"]);
    expect((await failure(callModel(endpoint, { ...ask, stream: true }, { apiKey: KEY, fetch }))).code).toBe(
      "provider_response_invalid",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.cancelled).toBe(true);
  });

  it("cancels the body when an app callback throws", async () => {
    const { fetch, state } = hanging([chunk("partial")]);
    const bug = new Error("app bug");
    await expect(
      callModel(endpoint, { ...ask, stream: true }, { apiKey: KEY, fetch, onText: () => { throw bug; } }),
    ).rejects.toBe(bug);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.cancelled).toBe(true);
  });
});
