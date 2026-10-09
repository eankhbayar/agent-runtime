// One chat call to an endpoint in either format, with fetch and nothing else:
// a system prompt and messages in, the text, usage and the endpoint's ids out.
// Streamed or not, with connection, progress and overall timeouts. Every
// failure is a ModelCallError carrying a fixed code; see errors.ts for what
// it may carry of the endpoint's answer.

import { endpointUrl, formatOf, type ModelEndpoint } from "./endpoint.ts";
import {
  codeFromProvider,
  httpErrorCode,
  ModelCallError,
  providerErrorInfo,
  retryAfterMs,
  type ModelErrorCode,
  type ProviderErrorInfo,
} from "./errors.ts";
import { anthropicUsage, emptyModelUsage, openAiUsage, type ModelUsage } from "./usage.ts";

export type ModelMessage = { role: "user" | "assistant"; content: string };

/** A JSON schema the answer must match (OpenAI's `response_format: json_schema`). */
export type StructuredOutput = {
  name: string;
  description?: string;
  strict?: boolean;
  schema: Readonly<Record<string, unknown>>;
};

/** Each optional; a route's `timeouts` with these names can be passed as it is. */
export type ModelTimeouts = {
  /** From sending the request to the response's headers. */
  connectionMs?: number;
  /** Longest gap between chunks of the response, once headers have arrived. */
  noProgressMs?: number;
  /** The whole call. */
  invocationMs?: number;
};

export type ModelCallRequest = {
  system?: string;
  messages: readonly ModelMessage[];
  maxOutputTokens: number;
  /** OpenAI's `reasoning_effort`. Not sent to an Anthropic endpoint; use `extraBody.thinking` there. */
  reasoningEffort?: string;
  /** OpenAI only: an Anthropic endpoint fails with `structured_output_unsupported`. */
  structuredOutput?: StructuredOutput;
  /** Stream the response (SSE). The result is the same either way; `onText` sees the text as it comes. */
  stream?: boolean;
  /** More top-level body fields the endpoint takes. The fields this call sets win over them. */
  extraBody?: Readonly<Record<string, unknown>>;
};

export type ModelCallOptions = {
  /** The provider key, sent as `Authorization: Bearer` (OpenAI) or `x-api-key` (Anthropic). */
  apiKey: string;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Aborting it fails the call with `cancelled`. */
  signal?: AbortSignal;
  timeouts?: ModelTimeouts;
  /** More request headers, e.g. `anthropic-beta`. Auth headers are always this call's own. */
  headers?: Readonly<Record<string, string>>;
  /** OpenAI: the field `maxOutputTokens` is sent as. Default `max_tokens`. */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /**
   * Picks the code for a refused request before the defaults do, e.g. from a
   * provider's own header. Return undefined to fall back to `httpErrorCode`.
   */
  classify?: (refusal: {
    status: number;
    headers: Headers;
    provider: ProviderErrorInfo;
  }) => ModelErrorCode | undefined;
  /** Called once the response's headers have arrived. */
  onConnected?: () => void;
  /** Called for every chunk of the response body. */
  onProgress?: () => void;
  /** Called with each piece of answer text as it arrives. */
  onText?: (delta: string) => void;
  now?: () => number;
};

export type ModelCallResult = {
  text: string;
  usage: ModelUsage;
  /** `finish_reason` or `stop_reason`, e.g. `stop`, `length`, `end_turn`, `max_tokens`. */
  stopReason: string | null;
  /** The model the endpoint says answered. */
  model: string | null;
  /** The `x-request-id` or `request-id` response header. */
  requestId?: string;
  /** The response's own id. */
  responseId?: string;
  /** OpenAI's `created`, in ms. */
  createdAt?: number;
  /** Until the response's headers. */
  connectionMs: number;
  durationMs: number;
};

/** A larger response is refused as `provider_response_invalid`. */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** How much of a refused request's body is read for its error identifiers. */
const MAX_ERROR_BYTES = 64 * 1024;

const ANTHROPIC_VERSION = "2023-06-01";

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ModelCallError("provider_response_invalid");
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requestBody(endpoint: ModelEndpoint, request: ModelCallRequest, options: ModelCallOptions) {
  const stream = request.stream === true;
  if (endpoint.format === "openai") {
    return {
      ...request.extraBody,
      model: endpoint.model,
      messages: [
        ...(request.system !== undefined ? [{ role: "system", content: request.system }] : []),
        ...request.messages.map(({ role, content }) => ({ role, content })),
      ],
      [options.maxTokensField ?? "max_tokens"]: request.maxOutputTokens,
      ...(request.reasoningEffort !== undefined ? { reasoning_effort: request.reasoningEffort } : {}),
      ...(request.structuredOutput
        ? { response_format: { type: "json_schema", json_schema: request.structuredOutput } }
        : {}),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : { stream: false }),
    };
  }
  return {
    ...request.extraBody,
    model: endpoint.model,
    max_tokens: request.maxOutputTokens,
    ...(request.system !== undefined ? { system: request.system } : {}),
    messages: request.messages.map(({ role, content }) => ({ role, content })),
    ...(stream ? { stream: true } : {}),
  };
}

function requestHeaders(endpoint: ModelEndpoint, options: ModelCallOptions): Headers {
  const headers = new Headers();
  if (endpoint.format !== "openai") headers.set("anthropic-version", ANTHROPIC_VERSION);
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
  headers.set("content-type", "application/json");
  headers.delete("authorization");
  headers.delete("x-api-key");
  if (endpoint.format === "openai") headers.set("authorization", `Bearer ${options.apiKey}`);
  else headers.set("x-api-key", options.apiKey);
  return headers;
}

/** What a response is assembled into while it is read. */
type Answer = {
  text: string;
  usage: ModelUsage;
  stopReason: string | null;
  model: string | null;
  responseId?: string;
  createdAt?: number;
};

function midStreamError(root: Record<string, unknown>): ModelCallError {
  const provider = providerErrorInfo(root);
  return new ModelCallError(codeFromProvider(provider) ?? "provider_response_invalid", { provider });
}

function openAiJson(value: unknown, answer: Answer): void {
  const root = record(value);
  if (root.error) throw midStreamError(root);
  const choice = record((Array.isArray(root.choices) ? root.choices : [])[0]);
  const message = record(choice.message);
  if (typeof message.content !== "string") throw new ModelCallError("provider_response_invalid");
  answer.text = message.content;
  answer.stopReason = str(choice.finish_reason) ?? null;
  answer.model = str(root.model) ?? null;
  answer.responseId = str(root.id);
  if (typeof root.created === "number") answer.createdAt = root.created * 1_000;
  answer.usage = openAiUsage(root.usage);
}

function openAiChunk(value: unknown, answer: Answer, onText?: (delta: string) => void): void {
  const root = record(value);
  if (root.error) throw midStreamError(root);
  if (typeof root.id === "string") answer.responseId = root.id;
  if (typeof root.model === "string") answer.model = root.model;
  if (typeof root.created === "number") answer.createdAt = root.created * 1_000;
  if (optionalRecord(root.usage)) answer.usage = openAiUsage(root.usage);
  const choice = optionalRecord((Array.isArray(root.choices) ? root.choices : [])[0]);
  if (!choice) return;
  const content = optionalRecord(choice.delta)?.content;
  if (typeof content === "string" && content) {
    answer.text += content;
    onText?.(content);
  }
  if (typeof choice.finish_reason === "string") answer.stopReason = choice.finish_reason;
}

function anthropicJson(value: unknown, answer: Answer): void {
  const root = record(value);
  if (root.type === "error") throw midStreamError(root);
  const content = Array.isArray(root.content) ? root.content : [];
  answer.text = content
    .map((part) => optionalRecord(part))
    .flatMap((part) => (part?.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("");
  answer.stopReason = str(root.stop_reason) ?? null;
  answer.model = str(root.model) ?? null;
  answer.responseId = str(root.id);
  answer.usage = anthropicUsage(root.usage);
}

function anthropicEvent(
  value: unknown,
  answer: Answer,
  raw: Record<string, unknown>,
  onText?: (delta: string) => void,
): void {
  const root = record(value);
  switch (root.type) {
    case "error":
      throw midStreamError(root);
    case "message_start": {
      const message = optionalRecord(root.message) ?? {};
      answer.responseId = str(message.id);
      answer.model = str(message.model) ?? null;
      Object.assign(raw, optionalRecord(message.usage));
      break;
    }
    case "content_block_delta": {
      const delta = optionalRecord(root.delta);
      if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
        answer.text += delta.text;
        onText?.(delta.text);
      }
      break;
    }
    case "message_delta": {
      const stop = str(optionalRecord(root.delta)?.stop_reason);
      if (stop) answer.stopReason = stop;
      // Counts here are cumulative, and replace message_start's.
      for (const [key, count] of Object.entries(optionalRecord(root.usage) ?? {})) {
        if (typeof count === "number") raw[key] = count;
      }
      break;
    }
  }
  answer.usage = anthropicUsage(raw);
}

/** The `data:` of one SSE event, or undefined for a comment, an empty event or `[DONE]`. */
function sseData(event: string): unknown {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") return undefined;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    throw new ModelCallError("provider_response_invalid");
  }
}

/**
 * Calls the endpoint once. Resolves with the answer, or rejects with a
 * ModelCallError; the call is never retried here, since whether to retry is
 * the caller's policy (`error.retryable`, `error.retryAfterMs`). An error
 * thrown by the app's own code (`onText`, `onProgress`, `onConnected`,
 * `classify`, an `extraBody` JSON cannot encode) is rethrown as it is, so an
 * app bug never reads as a retryable network failure.
 */
export async function callModel(
  endpoint: ModelEndpoint,
  request: ModelCallRequest,
  options: ModelCallOptions,
): Promise<ModelCallResult> {
  if (!options.apiKey) throw new TypeError("callModel needs the provider key");
  const openai = formatOf(endpoint) === "openai";
  if (request.structuredOutput && !openai) throw new ModelCallError("structured_output_unsupported");
  const now = options.now ?? Date.now;
  const timeouts = options.timeouts ?? {};
  const startedAt = now();

  // Whatever stops the call first names the failure; the race makes a fetch
  // that ignores its signal stop too.
  const controller = new AbortController();
  let stopCode: ModelErrorCode | undefined;
  let rejectStopped: (error: ModelCallError) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectStopped = reject;
  });
  stopped.catch(() => {});
  const stop = (code: ModelErrorCode) => {
    if (stopCode) return;
    stopCode = code;
    controller.abort(code);
    rejectStopped(new ModelCallError(code));
  };
  const race = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, stopped]);
  const timer = (ms: number | undefined, code: ModelErrorCode) =>
    ms !== undefined && ms > 0 ? setTimeout(() => stop(code), ms) : undefined;

  const connectionTimer = timer(timeouts.connectionMs, "connection_timeout");
  const invocationTimer = timer(timeouts.invocationMs, "invocation_timeout");
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  const progressed = () => {
    clearTimeout(progressTimer);
    progressTimer = timer(timeouts.noProgressMs, "no_progress_timeout");
  };
  const cancel = () => stop("cancelled");
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener("abort", cancel, { once: true });

  /**
   * A fetch or a body read. Its own rejection is the network's (DNS, TLS, a
   * reset, a body cut off), or the abort a stop caused; neither is kept,
   * since fetch's errors can quote the URL. Only these become
   * `connection_failure`: an error the app's callbacks throw is the app's,
   * and is rethrown as it is rather than turned into a retryable code.
   */
  const network = async <T>(promise: Promise<T>): Promise<T> => {
    try {
      return await race(promise);
    } catch (error) {
      if (error instanceof ModelCallError) throw error;
      throw new ModelCallError(stopCode ?? "connection_failure");
    }
  };

  /** The body as text, chunk by chunk, up to `limit` bytes. */
  const readBody = async (
    response: Response,
    limit: number,
    onChunk?: (text: string) => void,
  ): Promise<string> => {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    let finished = false;
    try {
      for (;;) {
        const { done, value } = await network(reader.read());
        if (done) {
          finished = true;
          break;
        }
        progressed();
        options.onProgress?.();
        bytes += value.byteLength;
        if (bytes > limit) throw new ModelCallError("provider_response_invalid");
        const piece = decoder.decode(value, { stream: true });
        if (onChunk) onChunk(piece);
        else text += piece;
      }
    } finally {
      // A stop, a bad event or an app callback left the body unread: close
      // it, even when the fetch ignored its signal.
      if (!finished) void reader.cancel().catch(() => {});
    }
    const rest = decoder.decode();
    if (onChunk) {
      if (rest) onChunk(rest);
    } else {
      text += rest;
    }
    return text;
  };

  try {
    if (stopCode) throw new ModelCallError(stopCode);
    const body = JSON.stringify(requestBody(endpoint, request, options));
    const fetchModel = options.fetch ?? globalThis.fetch;
    const response = await network(
      fetchModel(endpointUrl(endpoint), {
        method: "POST",
        headers: requestHeaders(endpoint, options),
        body,
        signal: controller.signal,
      }),
    );
    clearTimeout(connectionTimer);
    const connectionMs = now() - startedAt;
    options.onConnected?.();
    progressed();

    if (!response.ok) {
      let text = "";
      try {
        text = await readBody(response, MAX_ERROR_BYTES);
      } catch (error) {
        // A body too large or cut off still fails with the status; a stop or an app error does not.
        if (!(error instanceof ModelCallError) || stopCode) throw error;
      }
      let provider: ProviderErrorInfo = {};
      try {
        provider = providerErrorInfo(JSON.parse(text) as unknown);
      } catch {
        // An unreadable body still fails with the status.
      }
      const code =
        options.classify?.({ status: response.status, headers: response.headers, provider }) ??
        httpErrorCode(response.status, provider);
      throw new ModelCallError(code, {
        status: response.status,
        provider,
        retryAfterMs: retryAfterMs(response.headers, now()),
      });
    }

    const answer: Answer = { text: "", usage: emptyModelUsage(), stopReason: null, model: null };
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      let buffer = "";
      const anthropicRaw: Record<string, unknown> = {};
      const consume = (event: string) => {
        const value = sseData(event);
        if (value === undefined) return;
        if (openai) openAiChunk(value, answer, options.onText);
        else anthropicEvent(value, answer, anthropicRaw, options.onText);
      };
      await readBody(response, MAX_RESPONSE_BYTES, (piece) => {
        buffer += piece;
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";
        for (const event of events) consume(event);
      });
      if (buffer.trim()) consume(buffer);
    } else {
      const text = await readBody(response, MAX_RESPONSE_BYTES);
      let value: unknown;
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        throw new ModelCallError("provider_response_invalid");
      }
      if (openai) openAiJson(value, answer);
      else anthropicJson(value, answer);
      if (answer.text) options.onText?.(answer.text);
    }
    if (!answer.text.trim()) throw new ModelCallError("provider_response_invalid");

    const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id");
    return {
      text: answer.text,
      usage: answer.usage,
      stopReason: answer.stopReason,
      model: answer.model,
      ...(requestId ? { requestId } : {}),
      ...(answer.responseId ? { responseId: answer.responseId } : {}),
      ...(answer.createdAt !== undefined ? { createdAt: answer.createdAt } : {}),
      connectionMs,
      durationMs: now() - startedAt,
    };
  } finally {
    clearTimeout(connectionTimer);
    clearTimeout(invocationTimer);
    clearTimeout(progressTimer);
    options.signal?.removeEventListener("abort", cancel);
    // Releases the connection of a call that did not read its body to the end.
    if (!controller.signal.aborted) controller.abort();
  }
}
