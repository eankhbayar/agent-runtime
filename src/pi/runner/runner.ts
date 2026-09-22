// Runs inside the sandbox: one pi session answering one prompt. The project
// supplies the system prompt and its own tools; configuration comes only from
// the environment, and this file never calls a sandbox provider API.
//
//   PROMPT            the user's message (required unless --check)
//   RUN_ID            run identifier, echoed in events
//   WORKSPACE         default /workspace
//   LLM_PROVIDER      pi provider id
//   LLM_MODEL         model id in that provider's catalog
//   THINKING_LEVEL    default high
//   LLM_BASE_URL      optional; the egress gateway
//   LLM_API_KEY       a run token or a placeholder the egress proxy replaces
//   RUN_LIMITS        optional JSON {wallClockMs, cpus, memoryMb}, echoed in
//                     run_started so the trace can show usage against them
//
// `--check` on the command line validates the image without calling a model.

import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { EmitRunEvent } from "../contract/events.ts";
import { createEmitter, forwardSessionEvent } from "./events.ts";

export const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

/** Where the agent works, handed to the project's prompt, tools and check. */
export type RunnerContext = {
  workspace: string;
  /** Files the user should see go here, registered with `save_output`. */
  outputsDir: string;
  emit: EmitRunEvent;
  env: NodeJS.ProcessEnv;
};

export type RunnerOptions = {
  systemPrompt: (ctx: RunnerContext) => string;
  /** The project's own tools; each is enabled alongside `builtinTools`. */
  customTools?: (ctx: RunnerContext) => ToolDefinition[];
  /** pi's built-in tools to enable. Default: all of `BUILTIN_TOOLS`. */
  builtinTools?: readonly string[];
  /** Used when LLM_PROVIDER and LLM_MODEL are not set. */
  defaultModel: { provider: string; model: string };
  /** Extra `--check` probes; what it returns is added to the check notice. */
  check?: (ctx: RunnerContext) => Promise<Record<string, unknown>>;
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
};

/** The limits the dispatcher gave this run, echoed back for the trace view. */
function runLimits(env: NodeJS.ProcessEnv): unknown {
  if (!env.RUN_LIMITS) return null;
  try {
    return JSON.parse(env.RUN_LIMITS);
  } catch {
    return null;
  }
}

async function run(options: RunnerOptions, emit: EmitRunEvent): Promise<void> {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv;
  const workspace = env.WORKSPACE ?? "/workspace";
  const outputsDir = path.join(workspace, "outputs");
  const agentDir = path.join(workspace, ".pi");
  const providerId = env.LLM_PROVIDER ?? options.defaultModel.provider;
  const modelId = env.LLM_MODEL ?? options.defaultModel.model;
  const thinkingLevel = (env.THINKING_LEVEL ?? "high") as "low" | "medium" | "high";
  const ctx: RunnerContext = { workspace, outputsDir, emit, env };

  await mkdir(outputsDir, { recursive: true });
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  });
  const catalogModel = modelRuntime.getModel(providerId, modelId);

  if (argv.includes("--check")) {
    emit("notice", {
      kind: "check",
      node: process.version,
      model: catalogModel ? `${catalogModel.provider}/${catalogModel.id}` : null,
      ...(await options.check?.(ctx)),
    });
    if (!catalogModel) throw new Error(`Model ${providerId}/${modelId} not in pi's catalog`);
    return;
  }

  const prompt = env.PROMPT;
  if (!prompt) throw new Error("PROMPT is required");
  if (!catalogModel) throw new Error(`Model ${providerId}/${modelId} not in pi's catalog`);
  if (env.LLM_API_KEY) await modelRuntime.setRuntimeApiKey(providerId, env.LLM_API_KEY);
  const model = env.LLM_BASE_URL ? { ...catalogModel, baseUrl: env.LLM_BASE_URL } : catalogModel;

  // No discovery: no AGENTS.md, skills, extensions or prompt templates from
  // the image or the workspace can change the agent's instructions.
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => options.systemPrompt(ctx),
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };

  const customTools = options.customTools?.(ctx) ?? [];
  // Session JSONL lives in the workspace so a paused sandbox keeps it and the
  // dispatcher can copy it out as a checkpoint.
  const sessionDir = path.join(workspace, ".sessions");
  const { session } = await createAgentSession({
    cwd: workspace,
    agentDir,
    model,
    thinkingLevel,
    modelRuntime,
    resourceLoader,
    tools: [...(options.builtinTools ?? BUILTIN_TOOLS), ...customTools.map((tool) => tool.name)],
    customTools,
    sessionManager: SessionManager.continueRecent(workspace, sessionDir),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 2 },
    }),
  });

  emit("run_started", {
    runId: env.RUN_ID ?? null,
    model: `${model.provider}/${model.id}`,
    sessionFile: session.sessionFile,
    limits: runLimits(env),
  });
  const unsubscribe = session.subscribe((event) => forwardSessionEvent(event, emit));
  try {
    await session.prompt(prompt);
    const error = session.agent.state.errorMessage;
    emit("run_finished", {
      status: error ? "failed" : "succeeded",
      error,
      sessionFile: session.sessionFile,
    });
  } finally {
    unsubscribe();
    session.dispose();
  }
}

/** The runner's whole `main`: a failure becomes a `run_finished` event and exit code 1. */
export async function runAgent(options: RunnerOptions): Promise<void> {
  const emit = createEmitter();
  try {
    await run(options, emit);
  } catch (error: unknown) {
    emit("run_finished", {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}
