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
//   LLM_API           optional: openai or anthropic, for a model outside pi's
//                     catalog; see model-config.ts for it and the LLM_* it reads
//   RUN_LIMITS        optional JSON {wallClockMs, cpus, memoryMb}, echoed in
//                     run_started so the trace can show usage against them
//
// When the gateway serves data commands (../../data), the runner lists them in
// the system prompt and sets AGENT_DATA_URL and AGENT_DATA_TOKEN for the
// `agent-data` CLI the agent calls them with, or, with `dataAccess: "tools"`,
// offers each as a typed tool (data-tools.ts).
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

import type { EmitRunEvent } from "../../contract/events.ts";
import { dataPromptSection } from "../../data/commands.ts";
import { loadDataCommands } from "./data.ts";
import { createDataTools, dataToolsPromptSection } from "./data-tools.ts";
import { createEmitter, forwardSessionEvent } from "./events.ts";
import { registerModel, resolveModelConfig } from "./model-config.ts";

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
  /** Used when LLM_PROVIDER and LLM_MODEL are not set (and LLM_API is not). */
  defaultModel: { provider: string; model: string };
  /** Extra `--check` probes; what it returns is added to the check notice. */
  check?: (ctx: RunnerContext) => Promise<Record<string, unknown>>;
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
  /** For the data command list; defaults to the global fetch. */
  fetch?: typeof fetch;
  /**
   * How the agent calls the gateway's data commands: `cli` (default) through
   * the `agent-data` CLI in bash, or `tools` as one typed tool per command,
   * for an agent without bash.
   */
  dataAccess?: "cli" | "tools";
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
  const modelConfig = resolveModelConfig(env, options.defaultModel);
  const { provider: providerId, model: modelId } = modelConfig;
  const thinkingLevel = (env.THINKING_LEVEL ?? "high") as "low" | "medium" | "high";
  const ctx: RunnerContext = { workspace, outputsDir, emit, env };

  await mkdir(outputsDir, { recursive: true });
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    // No models.json: the workspace is the agent's to write, so a file planted
    // there must not change the model, its limits or the headers sent with it.
    modelsPath: null,
  });
  registerModel(modelRuntime, modelConfig);
  const catalogModel = modelRuntime.getModel(providerId, modelId);

  if (argv.includes("--check")) {
    emit("notice", {
      kind: "check",
      node: process.version,
      model: catalogModel ? `${catalogModel.provider}/${catalogModel.id}` : null,
      ...(modelConfig.kind === "custom"
        ? {
            api: modelConfig.api,
            baseUrl: modelConfig.baseUrl,
            contextWindow: modelConfig.contextWindow,
            maxTokens: modelConfig.maxTokens,
          }
        : {}),
      ...(await options.check?.(ctx)),
    });
    if (!catalogModel) throw new Error(`Model ${providerId}/${modelId} not in pi's catalog`);
    return;
  }

  const prompt = env.PROMPT;
  if (!prompt) throw new Error("PROMPT is required");
  if (!catalogModel) throw new Error(`Model ${providerId}/${modelId} not in pi's catalog`);
  if (env.LLM_API_KEY) await modelRuntime.setRuntimeApiKey(providerId, env.LLM_API_KEY);
  // A custom model already carries its base URL.
  const model =
    modelConfig.kind === "catalog" && env.LLM_BASE_URL
      ? { ...catalogModel, baseUrl: env.LLM_BASE_URL }
      : catalogModel;

  const data = await loadDataCommands(env, options.fetch);
  const dataAsTools = options.dataAccess === "tools";
  // pi's bash tool runs commands with process.env, so the CLI finds these there.
  if (data && !dataAsTools) {
    process.env.AGENT_DATA_URL = data.url;
    process.env.AGENT_DATA_TOKEN = data.token;
  }
  const dataSection = !data ? "" : dataAsTools ? dataToolsPromptSection(data.list) : dataPromptSection(data.list);
  const systemPrompt = [options.systemPrompt(ctx), dataSection].filter(Boolean).join("\n\n");

  // No discovery: no AGENTS.md, skills, extensions or prompt templates from
  // the image or the workspace can change the agent's instructions.
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };

  const customTools = [
    ...(options.customTools?.(ctx) ?? []),
    ...(data && dataAsTools ? createDataTools(data, options.fetch) : []),
  ];
  const names = [...(options.builtinTools ?? BUILTIN_TOOLS), ...customTools.map((tool) => tool.name)];
  const clash = names.find((name, i) => names.indexOf(name) !== i);
  if (clash) throw new Error(`Two tools are named ${clash}`);
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
    tools: names,
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
    dataCommands: data?.list.commands.map((command) => command.name) ?? [],
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
