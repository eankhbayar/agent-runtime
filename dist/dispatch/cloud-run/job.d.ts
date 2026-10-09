import { type Fetch } from "./http.ts";
/** `projects/<project>/locations/<region>/jobs/<job>`. */
export declare function isCloudRunJobName(value: string): boolean;
export declare function cloudRunJobName(job: {
    project: string;
    region: string;
    name: string;
}): string;
export type RunCloudRunJobOptions = {
    /** The job's resource name, as isCloudRunJobName takes it. */
    job: string;
    /** From federatedAccessToken, for an account allowed `run.jobs.runWithOverrides` on the job. */
    accessToken: string;
    /** Set on the job's container for this execution only, e.g. `{ RESEARCH_RUN_ID: runId }`. */
    env?: Record<string, string>;
    /** Per request. Defaults to 15 s. */
    timeoutMs?: number;
    fetchImpl?: Fetch;
};
/** Starts one single-task execution of the job and returns the execution's resource name. */
export declare function runCloudRunJob(options: RunCloudRunJobOptions): Promise<{
    executionName: string;
}>;
