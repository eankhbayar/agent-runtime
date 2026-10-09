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
// `--check` on the command line validates the image without calling a model.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager, } from "@earendil-works/pi-coding-agent";
import { createEmitter, forwardSessionEvent } from "./events.js";
import { registerModel, resolveModelConfig } from "./model-config.js";
export const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
/** The limits the dispatcher gave this run, echoed back for the trace view. */
function runLimits(env) {
    if (!env.RUN_LIMITS)
        return null;
    try {
        return JSON.parse(env.RUN_LIMITS);
    }
    catch {
        return null;
    }
}
async function run(options, emit) {
    const env = options.env ?? process.env;
    const argv = options.argv ?? process.argv;
    const workspace = env.WORKSPACE ?? "/workspace";
    const outputsDir = path.join(workspace, "outputs");
    const agentDir = path.join(workspace, ".pi");
    const modelConfig = resolveModelConfig(env, options.defaultModel);
    const { provider: providerId, model: modelId } = modelConfig;
    const thinkingLevel = (env.THINKING_LEVEL ?? "high");
    const ctx = { workspace, outputsDir, emit, env };
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
        if (!catalogModel)
            throw new Error(`Model ${providerId}/${modelId} not in pi's catalog`);
        return;
    }
    const prompt = env.PROMPT;
    if (!prompt)
        throw new Error("PROMPT is required");
    if (!catalogModel)
        throw new Error(`Model ${providerId}/${modelId} not in pi's catalog`);
    if (env.LLM_API_KEY)
        await modelRuntime.setRuntimeApiKey(providerId, env.LLM_API_KEY);
    // A custom model already carries its base URL.
    const model = modelConfig.kind === "catalog" && env.LLM_BASE_URL
        ? { ...catalogModel, baseUrl: env.LLM_BASE_URL }
        : catalogModel;
    // No discovery: no AGENTS.md, skills, extensions or prompt templates from
    // the image or the workspace can change the agent's instructions.
    const resourceLoader = {
        getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => options.systemPrompt(ctx),
        getSystemPromptSource: () => undefined,
        getAppendSystemPrompt: () => [],
        getAppendSystemPromptSources: () => [],
        extendResources: () => { },
        reload: async () => { },
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
    }
    finally {
        unsubscribe();
        session.dispose();
    }
}
/** The runner's whole `main`: a failure becomes a `run_finished` event and exit code 1. */
export async function runAgent(options) {
    const emit = createEmitter();
    try {
        await run(options, emit);
    }
    catch (error) {
        emit("run_finished", {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
        });
        process.exitCode = 1;
    }
}
