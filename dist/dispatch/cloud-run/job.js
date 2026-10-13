// Starts one execution of a Cloud Run Job, with environment overrides that say
// which run it is for. The job's own entrypoint claims that run; starting an
// execution decides nothing, so starting one too many costs a container start
// and a null claim.
import { CloudRunJobDispatchError, jsonBody, REQUEST_TIMEOUT_MS, send, } from "./http.js";
const JOB = /^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/jobs\/[a-z0-9-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** `projects/<project>/locations/<region>/jobs/<job>`. */
export function isCloudRunJobName(value) {
    return JOB.test(value);
}
export function cloudRunJobName(job) {
    return `projects/${job.project}/locations/${job.region}/jobs/${job.name}`;
}
/** Starts one single-task execution of the job and returns the execution's resource name. */
export async function runCloudRunJob(options) {
    if (!isCloudRunJobName(options.job)) {
        throw new CloudRunJobDispatchError("cloud_run_job_name_invalid");
    }
    const env = Object.entries(options.env ?? {});
    if (env.some(([name]) => !ENV_NAME.test(name))) {
        throw new CloudRunJobDispatchError("cloud_run_job_env_invalid");
    }
    const response = await send(options.fetchImpl ?? fetch, `https://run.googleapis.com/v2/${options.job}:run`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${options.accessToken}`,
            "content-type": "application/json",
        },
        body: JSON.stringify({
            overrides: {
                containerOverrides: [{ env: env.map(([name, value]) => ({ name, value })) }],
                taskCount: 1,
            },
        }),
    }, options.timeoutMs ?? REQUEST_TIMEOUT_MS, "cloud_run_job_network_failed");
    if (!response.ok)
        throw new CloudRunJobDispatchError(`cloud_run_job_http_${response.status}`);
    // The answer is a long-running operation; its metadata is the execution.
    const operation = await jsonBody(response);
    const metadata = operation?.metadata;
    const executionName = typeof metadata?.name === "string"
        ? metadata.name
        : typeof operation?.name === "string"
            ? operation.name
            : "";
    if (!executionName)
        throw new CloudRunJobDispatchError("cloud_run_job_response_invalid");
    return { executionName };
}
