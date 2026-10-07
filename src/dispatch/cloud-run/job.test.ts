import { describe, expect, it, vi } from "vitest";

import { CloudRunJobDispatchError, type Fetch } from "./http.ts";
import { cloudRunJobName, isCloudRunJobName, runCloudRunJob } from "./job.ts";

const JOB = "projects/hklegalapp/locations/asia-southeast1/jobs/hk-legal-research-worker";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function codeOf(promise: Promise<unknown>) {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CloudRunJobDispatchError);
  return (error as CloudRunJobDispatchError).safeCode;
}

describe("cloudRunJobName", () => {
  it("names a job by project, region and name", () => {
    const name = cloudRunJobName({
      project: "hklegalapp",
      region: "asia-southeast1",
      name: "hk-legal-research-worker",
    });
    expect(name).toBe(JOB);
    expect(isCloudRunJobName(name)).toBe(true);
    expect(isCloudRunJobName("hk-legal-research-worker")).toBe(false);
  });
});

describe("runCloudRunJob", () => {
  it("starts one task with the run's environment and returns the execution name", async () => {
    const fetchImpl = vi.fn<Fetch>(async () =>
      jsonResponse({
        name: "projects/hklegalapp/locations/asia-southeast1/operations/op-1",
        metadata: { name: `${JOB}/executions/hk-legal-research-worker-abc12` },
      }),
    );

    const result = await runCloudRunJob({
      job: JOB,
      env: { RESEARCH_RUN_ID: "jd7run123" },
      accessToken: "ya29.token",
      fetchImpl,
    });

    expect(result).toEqual({ executionName: `${JOB}/executions/hk-legal-research-worker-abc12` });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://run.googleapis.com/v2/${JOB}:run`);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer ya29.token");
    expect(JSON.parse(String(init.body))).toEqual({
      overrides: {
        containerOverrides: [{ env: [{ name: "RESEARCH_RUN_ID", value: "jd7run123" }] }],
        taskCount: 1,
      },
    });
  });

  it("falls back to the operation's name when it has no metadata", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => jsonResponse({ name: "operations/op-1" }));
    expect(await runCloudRunJob({ job: JOB, accessToken: "t", fetchImpl })).toEqual({
      executionName: "operations/op-1",
    });
  });

  it("refuses a malformed job name or environment before calling Google", async () => {
    const fetchImpl = vi.fn<Fetch>();
    expect(await codeOf(runCloudRunJob({ job: "../jobs/x", accessToken: "t", fetchImpl }))).toBe(
      "cloud_run_job_name_invalid",
    );
    expect(
      await codeOf(
        runCloudRunJob({ job: JOB, env: { "RUN ID": "x" }, accessToken: "t", fetchImpl }),
      ),
    ).toBe("cloud_run_job_env_invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a refused start by HTTP status only", async () => {
    const fetchImpl = vi.fn<Fetch>(async () =>
      jsonResponse({ error: { message: "Permission denied on job" } }, 403),
    );
    expect(await codeOf(runCloudRunJob({ job: JOB, accessToken: "t", fetchImpl }))).toBe(
      "cloud_run_job_http_403",
    );
  });

  it("reports an answer with no execution in it", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => jsonResponse({ done: false }));
    expect(await codeOf(runCloudRunJob({ job: JOB, accessToken: "t", fetchImpl }))).toBe(
      "cloud_run_job_response_invalid",
    );
  });

  it("reports a network failure without the underlying message", async () => {
    const fetchImpl = vi.fn<Fetch>(async () => {
      throw new TypeError("getaddrinfo ENOTFOUND run.googleapis.com");
    });
    expect(await codeOf(runCloudRunJob({ job: JOB, accessToken: "t", fetchImpl }))).toBe(
      "cloud_run_job_network_failed",
    );
  });

  it("gives up on a request that takes longer than its timeout", async () => {
    const fetchImpl = vi.fn<Fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), {
            once: true,
          });
        }),
    );
    expect(
      await codeOf(runCloudRunJob({ job: JOB, accessToken: "t", fetchImpl, timeoutMs: 5 })),
    ).toBe("cloud_run_job_network_failed");
  });
});
