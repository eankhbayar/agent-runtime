// A stand-in for a model endpoint, for testing a gateway and the bridge
// without a real key. It speaks both formats a gateway proxies: Anthropic
// Messages at /v1/messages (key as x-api-key) and OpenAI Chat Completions at
// /v1/chat/completions (key as Authorization: Bearer). It checks the key,
// records each request, and streams its reply as SSE, one word per event,
// `gapMs` apart. `refuse` answers a request with an error instead, and
// `headerDelayMs` holds the response back, for testing a client's failures.

import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeUpstreamRequest = {
  path: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
};

export type FakeUpstreamOptions = {
  /** The key the gateway must send, as x-api-key or as a bearer token per format. */
  apiKey: string;
  /** The reply's text for a request. Default: "Hello from the fake model." */
  reply?: (body: Record<string, unknown>) => string;
  /** Milliseconds between streamed events. Default 0. */
  gapMs?: number;
  /** Milliseconds before any response is written, headers included. Default 0. */
  headerDelayMs?: number;
  /** An error to answer a request with, after the key check; undefined to answer normally. */
  refuse?: (request: FakeUpstreamRequest) => FakeUpstreamRefusal | undefined;
};

/** A refused request: the status, any headers (e.g. `retry-after`) and the body, JSON-encoded if not a string. */
export type FakeUpstreamRefusal = {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
};

export type FakeUpstream = {
  /** The Messages endpoint to give a gateway, e.g. `http://127.0.0.1:1234/v1/messages`. */
  messagesUrl: string;
  /** The OpenAI-format base URL to give a gateway, e.g. `http://127.0.0.1:1234/v1`. */
  baseUrl: string;
  /** Every request that reached it, key checked or not. */
  requests: FakeUpstreamRequest[];
  close: () => Promise<void>;
};

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** The SSE events a streamed Messages response of `text` is made of. */
export function messagesEvents(text: string): string[] {
  const words = text.split(/(?<= )/);
  return [
    sse("message_start", {
      type: "message_start",
      message: {
        id: "msg_fake",
        type: "message",
        role: "assistant",
        model: "fake-model",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    }),
    sse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    ...words.map((word) =>
      sse("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: word },
      }),
    ),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: words.length },
    }),
    sse("message_stop", { type: "message_stop" }),
  ];
}

/** The SSE events a streamed Chat Completions response of `text` is made of, `[DONE]` last. */
export function chatCompletionEvents(text: string): string[] {
  const words = text.split(/(?<= )/);
  const chunk = (choice: Record<string, unknown> | null, extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({
      id: "chatcmpl_fake",
      object: "chat.completion.chunk",
      created: 0,
      model: "fake-model",
      choices: choice ? [{ index: 0, ...choice }] : [],
      ...extra,
    })}\n\n`;
  return [
    chunk({ delta: { role: "assistant", content: "" }, finish_reason: null }),
    ...words.map((word) => chunk({ delta: { content: word }, finish_reason: null })),
    chunk({ delta: {}, finish_reason: "stop" }),
    chunk(null, {
      usage: { prompt_tokens: 10, completion_tokens: words.length, total_tokens: 10 + words.length },
    }),
    "data: [DONE]\n\n",
  ];
}

export async function startFakeUpstream(options: FakeUpstreamOptions): Promise<FakeUpstream> {
  const requests: FakeUpstreamRequest[] = [];
  const reply = options.reply ?? (() => "Hello from the fake model.");
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(raw || "{}") as Record<string, unknown>;
    } catch {}
    const url = new URL(req.url ?? "/", "http://upstream");
    const request = { path: url.pathname, headers: req.headers, body };
    requests.push(request);
    if (options.headerDelayMs) await new Promise((resolve) => setTimeout(resolve, options.headerDelayMs));
    if (res.destroyed) return;
    const openai = url.pathname === "/v1/chat/completions";
    const key = openai ? /^Bearer (.*)$/.exec(req.headers.authorization ?? "")?.[1] : req.headers["x-api-key"];
    if (key !== options.apiKey) {
      res.writeHead(401, { "content-type": "application/json" }).end('{"error":"bad key"}');
      return;
    }
    const refusal = options.refuse?.(request);
    if (refusal) {
      const text = typeof refusal.body === "string" ? refusal.body : JSON.stringify(refusal.body ?? {});
      res.writeHead(refusal.status, { "content-type": "application/json", ...refusal.headers }).end(text);
      return;
    }
    if (url.pathname === "/v1/messages/count_tokens") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":10}');
      return;
    }
    if (url.pathname !== "/v1/messages" && !openai) {
      res.writeHead(404).end();
      return;
    }
    const text = reply(body);
    if (openai && !body.stream) {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          id: "chatcmpl_fake",
          object: "chat.completion",
          created: 0,
          model: "fake-model",
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
      return;
    }
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          id: "msg_fake",
          type: "message",
          role: "assistant",
          model: "fake-model",
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    let stopped = false;
    res.on("close", () => (stopped = true));
    for (const event of openai ? chatCompletionEvents(text) : messagesEvents(text)) {
      if (stopped) return;
      res.write(event);
      if (options.gapMs) await new Promise((resolve) => setTimeout(resolve, options.gapMs));
    }
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    messagesUrl: `http://127.0.0.1:${port}/v1/messages`,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
