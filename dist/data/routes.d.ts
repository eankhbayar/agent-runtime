import { type DataArgs, type DataCommandList, type DataCommands } from "./commands.ts";
/** The run a call comes from; the gateway's grant for the token. */
export type DataGrant = {
    runId: string;
};
/** A refusal the agent sees as the CLI's error, with the HTTP status sent. */
export declare class DataCommandError extends Error {
    readonly status: number;
    constructor(message: string, status?: number);
}
export type DataReply = {
    status: number;
    body: unknown;
};
/** What the gateway's `data` option takes. */
export type GatewayDataRoutes = {
    list: () => DataCommandList;
    call: (command: string, args: unknown, grant: DataGrant) => Promise<DataReply>;
};
export type DataRoutesOptions<T extends DataCommands> = {
    commands: T;
    /**
     * Answers one call. Whatever it returns is sent back as JSON; a
     * DataCommandError is sent as that error, and anything else thrown as a
     * generic failure, with the error logged and not shown to the agent.
     */
    handle: (command: keyof T & string, args: DataArgs, grant: DataGrant) => Promise<unknown>;
    /** Default 50 calls per run. */
    maxCallsPerRun?: number;
    /** Default 20 s. */
    timeoutMs?: number;
    /** The largest JSON result sent back, in characters. Default 256 KiB. */
    maxResultChars?: number;
    /** One entry per call. */
    log?: (entry: Record<string, unknown>) => void;
};
export declare function createDataRoutes<T extends DataCommands>(opts: DataRoutesOptions<T>): GatewayDataRoutes;
