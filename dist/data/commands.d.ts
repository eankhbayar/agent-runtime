export type DataArgSpec = {
    type: "string" | "number" | "boolean";
    description?: string;
    required?: boolean;
    default?: string | number | boolean;
};
export type DataCommandSpec = {
    /** One line for the agent: what the command returns and when to use it. */
    description: string;
    args?: Record<string, DataArgSpec>;
};
export type DataCommands = Record<string, DataCommandSpec>;
/** What GET /data returns: the commands, for `agent-data --help` and the prompt. */
export type DataCommandList = {
    commands: {
        name: string;
        description: string;
        args: (DataArgSpec & {
            name: string;
        })[];
    }[];
};
export type DataArgs = Record<string, string | number | boolean>;
/** Checks a project's definitions once, where it declares them. */
export declare function defineDataCommands<const T extends DataCommands>(commands: T): T;
export declare function describeDataCommands(commands: DataCommands): DataCommandList;
export type ParsedDataArgs = {
    ok: true;
    args: DataArgs;
} | {
    ok: false;
    error: string;
};
/**
 * Validates one call's arguments against its command: unknown or mistyped
 * arguments are refused, missing ones take their default.
 */
export declare function parseDataArgs(spec: DataCommandSpec, input: unknown): ParsedDataArgs;
/** The system prompt's section on the commands; empty when there are none. */
export declare function dataPromptSection(list: DataCommandList): string;
