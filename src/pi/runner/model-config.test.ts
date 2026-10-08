import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import type { RunEvent } from "../../contract/events.ts";
import { createInProcessGateway, type InProcessGateway } from "../../core/gateway.ts";
import { startFakeUpstream, type FakeUpstream } from "../../testing/fake-upstream.ts";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, registerModel, resolveModelConfig } from "./model-config.ts";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/runner.ts");
const defaultModel = { provider: "kimi-coding", model: "kimi-for-coding" };
const openai = { LLM_API: "openai", LLM_MODEL: "gpt-6-luna", LLM_BASE_URL: "http://gateway:8080" };

describe("resolveModelConfig", () => {
  it("keeps to pi's catalog without LLM_API", () => {
    expect(resolveModelConfig({}, defaultModel)).toEqual({ kind: "catalog", ...defaultModel });
    expect(
      resolveModelConfig({ LLM_PROVIDER: "anthropic", LLM_MODEL: "claude-x", LLM_BASE_URL: "http://g" }, defaultModel),
    ).toEqual({ kind: "catalog", provider: "anthropic", model: "claude-x" });
  });

  it("describes an OpenAI-compatible model, with defaults for what is not set", () => {
    expect(resolveModelConfig(openai, defaultModel)).toEqual({
      kind: "custom",
      provider: "openai-compatible",
      model: "gpt-6-luna",
      api: "openai-completions",
      baseUrl: "http://gateway:8080/v1",
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
      reasoning: true,
    });
  });

  it("takes every setting from the environment", () => {
    expect(
      resolveModelConfig(
        {
          LLM_API: "openai-completions",
          LLM_PROVIDER: "lel190",
          LLM_MODEL: "gpt-6.1-sol",
          LLM_BASE_URL: "https://api.example.com/openai/v1/",
          LLM_CONTEXT_WINDOW: "400000",
          LLM_MAX_TOKENS: "64000",
          LLM_REASONING: "false",
          LLM_COMPAT: '{"supportsDeveloperRole":false,"maxTokensField":"max_tokens"}',
        },
        defaultModel,
      ),
    ).toEqual({
      kind: "custom",
      provider: "lel190",
      model: "gpt-6.1-sol",
      api: "openai-completions",
      baseUrl: "https://api.example.com/openai/v1",
      contextWindow: 400_000,
      maxTokens: 64_000,
      reasoning: false,
      compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
    });
  });

  it("adds /v1 to a bare origin for openai only", () => {
    const base = (api: string, url: string) =>
      resolveModelConfig({ ...openai, LLM_API: api, LLM_BASE_URL: url }, defaultModel);
    expect(base("openai", "http://127.0.0.1:8080/")).toMatchObject({ baseUrl: "http://127.0.0.1:8080/v1" });
    expect(base("openai", "http://127.0.0.1:8080/v1")).toMatchObject({ baseUrl: "http://127.0.0.1:8080/v1" });
    expect(base("anthropic", "http://127.0.0.1:8080/")).toMatchObject({
      provider: "anthropic-compatible",
      api: "anthropic-messages",
      baseUrl: "http://127.0.0.1:8080",
    });
  });

  it("refuses what it cannot use", () => {
    const bad: [Record<string, string>, RegExp][] = [
      [{ ...openai, LLM_API: "gemini" }, /LLM_API must be/],
      [{ ...openai, LLM_MODEL: "" }, /LLM_MODEL is required/],
      [{ ...openai, LLM_BASE_URL: "" }, /LLM_BASE_URL is required/],
      [{ ...openai, LLM_BASE_URL: "gateway:8080" }, /LLM_BASE_URL must be an http/],
      [{ ...openai, LLM_CONTEXT_WINDOW: "lots" }, /LLM_CONTEXT_WINDOW must be/],
      [{ ...openai, LLM_MAX_TOKENS: "-1" }, /LLM_MAX_TOKENS must be/],
      [{ ...openai, LLM_MAX_TOKENS: "1.5" }, /LLM_MAX_TOKENS must be/],
      [{ ...openai, LLM_REASONING: "maybe" }, /LLM_REASONING must be/],
      [{ ...openai, LLM_COMPAT: "[1]" }, /LLM_COMPAT must be/],
      [{ ...openai, LLM_COMPAT: "{" }, /LLM_COMPAT must be/],
    ];
    for (const [env, error] of bad) expect(() => resolveModelConfig(env, defaultModel), JSON.stringify(env)).toThrow(error);
  });
});

describe("registerModel", () => {
  it("makes a model pi does not know resolvable, with its limits", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agent-runtime-pi-"));
    const runtime = await ModelRuntime.create({
      authPath: path.join(dir, "auth.json"),
      modelsPath: path.join(dir, "models.json"),
    });
    const config = resolveModelConfig(
      { ...openai, LLM_PROVIDER: "lel190", LLM_COMPAT: '{"supportsStore":false}' },
      defaultModel,
    );
    expect(runtime.getModel("lel190", "gpt-6-luna")).toBeUndefined();
    registerModel(runtime, config);
    expect(runtime.getModel("lel190", "gpt-6-luna")).toMatchObject({
      provider: "lel190",
      id: "gpt-6-luna",
      api: "openai-completions",
      baseUrl: "http://gateway:8080/v1",
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
      reasoning: true,
      compat: { supportsStore: false },
    });
  });
});

/** Runs the fixture runner with `env` and collects the run events it prints. */
async function runRunner(env: Record<string, string>, args: string[] = []): Promise<{ code: number | null; events: RunEvent[] }> {
  const workspace = await mkdtemp(path.join(tmpdir(), "agent-runtime-ws-"));
  const child = spawn(process.execPath, [fixture, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: workspace, PI_OFFLINE: "1", WORKSPACE: workspace, ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  const events = out
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunEvent);
  return { code, events };
}

describe("runAgent with an OpenAI-compatible model", { timeout: 30_000 }, () => {
  let upstream: FakeUpstream | undefined;
  let gateway: InProcessGateway | undefined;
  afterEach(async () => {
    await gateway?.close();
    await upstream?.close();
    gateway = upstream = undefined;
  });

  it("validates the configuration with --check, calling no model", async () => {
    const { code, events } = await runRunner({ ...openai, LLM_PROVIDER: "lel190" }, ["--check"]);
    expect(code).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      kind: "check",
      model: "lel190/gpt-6-luna",
      api: "openai-completions",
      baseUrl: "http://gateway:8080/v1",
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    });
  });

  it("fails --check on a configuration it cannot use", async () => {
    const { code, events } = await runRunner({ ...openai, LLM_MAX_TOKENS: "zero" }, ["--check"]);
    expect(code).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: "run_finished",
      payload: { status: "failed", error: "LLM_MAX_TOKENS must be a positive integer" },
    });
  });

  it("answers through a gateway in openai format, the run token as its bearer key", async () => {
    upstream = await startFakeUpstream({ apiKey: "sk-provider" });
    gateway = createInProcessGateway({ format: "openai", baseUrl: upstream.baseUrl, apiKey: "sk-provider", log: () => {} });
    const url = await gateway.listen();
    const token = await gateway.grant("run_1", 60_000);

    const { code, events } = await runRunner({
      ...openai,
      LLM_BASE_URL: url,
      LLM_API_KEY: token,
      LLM_MAX_TOKENS: "4096",
      PROMPT: "Say hello.",
    });

    expect(code).toBe(0);
    expect(events[0]).toMatchObject({ type: "run_started", payload: { model: "openai-compatible/gpt-6-luna" } });
    const text = events.flatMap((e) => (e.type === "text_delta" ? [e.payload.delta] : [])).join("");
    expect(text).toBe("Hello from the fake model.");
    expect(events.at(-1)).toMatchObject({ type: "run_finished", payload: { status: "succeeded" } });
    const [seen] = upstream.requests;
    expect(seen).toMatchObject({ path: "/v1/chat/completions", headers: { authorization: "Bearer sk-provider" } });
    expect(seen!.body).toMatchObject({ model: "gpt-6-luna", stream: true, max_completion_tokens: 4096 });
  });
});
