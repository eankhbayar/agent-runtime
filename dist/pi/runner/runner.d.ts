import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { EmitRunEvent } from "../../contract/events.ts";
export declare const BUILTIN_TOOLS: readonly ["read", "bash", "edit", "write", "grep", "find", "ls"];
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
    defaultModel: {
        provider: string;
        model: string;
    };
    /** Extra `--check` probes; what it returns is added to the check notice. */
    check?: (ctx: RunnerContext) => Promise<Record<string, unknown>>;
    env?: NodeJS.ProcessEnv;
    argv?: readonly string[];
};
/** The runner's whole `main`: a failure becomes a `run_finished` event and exit code 1. */
export declare function runAgent(options: RunnerOptions): Promise<void>;
