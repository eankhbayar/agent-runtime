#!/usr/bin/env node
import type { DataCommandList } from "./commands.ts";
export type CliIo = {
    env: NodeJS.ProcessEnv;
    fetch: typeof fetch;
    out: (text: string) => void;
    err: (text: string) => void;
};
/** `<command> --a 1 --b=x --flag` as the command and its arguments, all strings. */
export declare function parseArgv(argv: readonly string[]): {
    command: string | null;
    args: Record<string, string>;
};
export declare function formatHelp(list: DataCommandList): string;
/** One invocation; resolves with the exit code. */
export declare function runCli(argv: readonly string[], io: CliIo): Promise<number>;
