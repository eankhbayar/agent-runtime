import type { DataCommandList } from "../../data/commands.ts";
export type RunnerData = {
    list: DataCommandList;
    url: string;
    token: string;
};
export declare function loadDataCommands(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<RunnerData | null>;
