# @eankhbayar/agent-runtime

Runtimes for running coding agents inside a sandbox and streaming what they do as a stable event log. One runtime today, `pi`; others sit beside it as they arrive. Extracted from the HKJC analysis runtime.

Each directory below is imported by its path under `src/`, e.g. `@eankhbayar/agent-runtime/providers/docker`:

```text
src/contract/           run events, the JSON-lines emitter and parser, and the fold into a view. No Node APIs, so a web app can import it.
src/core/               runs on the host, for every runtime: `executeRun`, `EventSink`, `RunStore`, the `SandboxProvider` interface, the reaper, `printRunEvent`
src/job/                `runJob`: one job execution claims, works and finishes one run
src/dispatch/cloud-run/ for an app's Convex: Google tokens without a key, starting a Cloud Run Job execution, the redispatch policy. No Node APIs.
src/providers/docker/   the Docker `SandboxProvider`, `docker stats` sampling, and gateway control (`createGateway`)
src/pi/runner/          runs in the sandbox: `runAgent`, the pi event adapter, the `save_output` tool
src/testing/            `FakeSandboxProvider`, `FakeSink` and `FakeRunStore`, to drive `executeRun` and a store in a project's tests
gateway/                egress gateway image, shared by every runtime: holds the provider key, proxies Anthropic-format Messages calls for valid run tokens
infra/cloud-run/        scripts that set up Convex's federation and deploy a Cloud Run Job
```

## Install

Releases are git tags that carry their built `dist/`. The repo is public, so installing one needs no credentials:

```json
{ "dependencies": { "@eankhbayar/agent-runtime": "github:eankhbayar/agent-runtime#v0.4.0" } }
```

`@earendil-works/pi-coding-agent` and `typebox` are peer dependencies, needed only where `./pi/runner` is imported.

## In the sandbox

```ts
import { createSaveOutputTool, runAgent } from "@eankhbayar/agent-runtime/pi/runner";

await runAgent({
  defaultModel: { provider: "kimi-coding", model: "kimi-for-coding" },
  systemPrompt: ({ outputsDir }) => `You analyse … Write results to ${outputsDir}.`,
  customTools: ({ outputsDir, emit }) => [
    createSaveOutputTool({ outputsDir, emit, kinds: ["table", "chart", "report"] }),
  ],
});
```

The runner reads `PROMPT`, `RUN_ID`, `LLM_*` and `RUN_LIMITS` from its environment and writes run events to stdout as JSON lines. `--check` validates the image without calling a model.

The sandbox image is the project's own. Node will not strip types from files under `node_modules`, which is why this package ships JavaScript; copy the installed package into the image's `node_modules` rather than installing it there, so the image runs the version the host's lockfile pinned and its build needs no git.

## On the host

```ts
import { executeRun } from "@eankhbayar/agent-runtime/core";
import { createGateway, DockerSandboxProvider, sampleUsage } from "@eankhbayar/agent-runtime/providers/docker";

const gateway = createGateway({ container: "myproject-egress-gateway" });
await gateway.ensure({ image: "myproject-egress-gateway", llm });
const provider = new DockerSandboxProvider({
  namespace: "myproject",
  gatewayContainer: gateway.container,
  gatewayAlias: gateway.alias,
});

const outcome = await executeRun({
  provider,
  sink,                       // where events, samples and artifacts go
  tokens: gateway,            // per-run tokens; the provider key never enters a sandbox
  runId,
  prompt,
  command: ["node", "/opt/runner/runner.js"],
  image: "myproject-runner",
  limits: { wallClockMs: 15 * 60_000, cpus: 1.5, memoryMb: 1536 },
  mounts: [{ localDir, remoteDir: "/data", verify: { "data.duckdb": sha256 } }],
  env: { LLM_PROVIDER: llm.provider, LLM_MODEL: llm.model, LLM_BASE_URL: gateway.url },
  usage: sampleUsage,
  keepSandbox: true,          // pause instead of destroy, so the thread's next run resumes the session
});
```

Build the gateway image from the installed package: `docker build -t myproject-egress-gateway node_modules/@eankhbayar/agent-runtime/gateway`.

## Run it in a project

Needs Docker (any context: Colima, Docker Desktop, a remote host) and a key for an Anthropic-format Messages endpoint.

1. **Install** the tag (see Install) and, in the project that holds the runner, `@earendil-works/pi-coding-agent` and `typebox`.
2. **Write the runner** (`runner.ts`, the "In the sandbox" snippet): the project's prompt, tools and default model.
3. **Build the sandbox image.** It needs Node 22.18+, whatever the agent's tools call (Python, DuckDB, ripgrep…), pi and typebox installed with npm, this package copied into `node_modules`, and the runner. It must run as a non-root user that owns `/workspace`:

   ```dockerfile
   FROM node:24-bookworm-slim
   COPY sandbox/package.json /opt/runner/package.json      # pi-coding-agent and typebox only
   RUN cd /opt/runner && npm install --omit=dev --ignore-scripts
   COPY .image/agent-runtime /opt/runner/node_modules/@eankhbayar/agent-runtime   # package.json + dist/, staged from the host's node_modules
   COPY runner.ts /opt/runner/runner.ts
   RUN mkdir -p /workspace && chown node:node /workspace
   USER node
   WORKDIR /workspace
   ENV PI_OFFLINE=1
   ```

4. **Build the gateway image:** `docker build -t myproject-egress-gateway node_modules/@eankhbayar/agent-runtime/gateway`.
5. **Write the host script** (the "On the host" snippet). The smallest sink prints to the terminal:

   ```ts
   import { writeFile } from "node:fs/promises";

   import { LIVE, printRunEvent, type EventSink } from "@eankhbayar/agent-runtime/core";

   const started = Date.now();
   const sink: EventSink = {
     events: async (batch) => {
       for (const event of batch) printRunEvent(event, () => `${((Date.now() - started) / 1000).toFixed(1)}s`);
       return LIVE;
     },
     samples: async () => {},
     artifact: async ({ fileName, bytes }) => {
       await writeFile(`out/${fileName}`, bytes);
       return fileName; // the id that lands in the artifact event
     },
     log: (message) => console.error(message),
   };
   ```

6. **Run it:** `PROVIDER_API_KEY=... node run.ts --prompt "..."`, passing the key as `llm.apiKey` to `gateway.ensure`. The key is needed only when the gateway container has to start; later runs reuse it. `gateway.ensure({ ..., restart: true })` after changing the key or the gateway image.

To check an image without calling a model: `docker run --rm myproject-runner node /opt/runner/runner.ts --check`.

After taking a new tag, rebuild both images. Sandboxes kept with `keepSandbox` stay on the image they were created from; `reapSandboxes` destroys idle ones.

A worked example is HKJC's `packages/analysis-runner`: `dispatcher/runtime.ts` (setup), `dispatcher/run-local.ts` (terminal CLI with isolation checks), `dispatcher/serve.ts` (a service with a Convex sink and the reaper), `scripts/stage-runtime.ts` (staging for the image build).

A different sandbox platform is one more `SandboxProvider`; nothing else changes.

## Stores

`EventSink` is all `executeRun` writes to. A worker that claims runs itself, such as a job started for one run, uses a `RunStore`: `claim({ runId, idempotencyKey })` returns a `ClaimedRun` that is the run's sink, with the app's payload, `heartbeat()` and `finish(ending)`. `executeRun` never beats or finishes, so its caller does both, usually through `runJob` (see Jobs); a store fails a run that goes quiet (HKJC's after 90 s).

A claim rejects with `StoreUnreachableError` when no answer came back; retry that with the same key, so a claim that landed comes back. Any other rejection is the store refusing, and is not retried. An app with endings of its own (a pause for review, say), a richer answer from `finish`, or methods of its own on the claim types the store by its claim: `RunStore<MyClaim>`, where `MyClaim` extends `ClaimedRun<Payload, Ending, Settled>`. `PayloadOf`, `EndingOf` and `SettledOf` name a claim's types in code generic over it. How HKJC's Convex functions and hk-legal's protocol 5 map onto it is at the top of `src/core/run-store.ts`.

## Jobs

`runJob` from `./job` is one job execution working one run, as a Cloud Run Job started for that run does. It claims the run, retrying only `StoreUnreachableError`, with the same key, after 1, 2 and 4 s, and claims nothing once it has been told to stop. While the work runs it beats at `claim.heartbeatMs` and aborts the work's signal when a beat says the run was cancelled or is gone. A failed beat is only logged, since the store decides when a quiet run is lost (`maxQuietMs` stops the work sooner), so a heartbeat whose store refused it answers `gone` rather than rejecting. It finishes with the ending the work returns, or, if the work throws, with what `failed` returns: by default `failed` with the error's message, or `cancelled` after a cancel.

SIGTERM, which Cloud Run sends at the task timeout and on a cancelled execution, ten seconds before SIGKILL, aborts the work with the reason `shutdown`. Finishing the run then ends it for good unless the store retries that ending, so a job whose store requeues a run when its lease lapses returns `RELEASE` from `work` or `failed` instead: the job stops beating and leaves the run to the store, as a crashed worker would.

```ts
import { executeRun } from "@eankhbayar/agent-runtime/core";
import { runJob } from "@eankhbayar/agent-runtime/job";

const result = await runJob(store, {
  runId: process.env.RUN_ID!,
  work: async (claim, signal) => {
    const { status, error, answerText, usage } = await executeRun({
      ...options, sink: claim, runId: claim.runId, prompt: claim.payload.prompt, signal,
    });
    return { status, error, answerText, usage }; // not the whole outcome: a store's validator rejects its events
  },
});
if (result.kind === "unclaimed" || result.kind === "unfinished") console.error(String(result.error));
process.exit(result.exitCode); // so a lingering socket cannot hold the execution open
```

The store comes first so that the work and `failed` are typed by its claim: with an ending of the app's own, the work returns it as a literal with no annotation, and `failed: (error, stopped) => ending` is required. `result.kind` is `idle` (nothing to claim) or `finished` (the store answered the finish, whatever the ending), which exit 0, or one that leaves the run to the store and exits 1: `stopped` (told to stop before claiming), `unclaimed` (refused, or never answered), `released`, or `unfinished` (the finish failed; the store reaps the run). The work's signal may already be aborted when the work starts; its `reason` is `cancelled`, `gone` or `shutdown`.

## Cloud Run

An app's Convex starts one execution of a Cloud Run Job per claimable run, with the run's id in the execution's environment, and the job's entrypoint calls `runJob`. `./dispatch/cloud-run` is the Google half of starting it. It uses only `fetch` and Web Crypto, so it runs in Convex's default runtime, and it needs no Google key: Convex signs its own JWT, Google's STS exchanges it through a workload identity provider that holds the public key and accepts one subject, and the federated token impersonates an invoker that can do nothing but run the job. Errors are a `CloudRunJobDispatchError` whose `safeCode` (`gcp_sts_http_403`, `cloud_run_job_network_failed`, …) is all that leaves the module: no Google error body, no key material.

The Convex functions stay in the app. hk-legal's dispatch action, for the runs its mutation reserved:

```ts
import { CloudRunJobDispatchError, federatedAccessToken, runCloudRunJob } from "@eankhbayar/agent-runtime/dispatch/cloud-run";

const accessToken = await federatedAccessToken({
  signingKeyPem: env.GCP_DISPATCH_SIGNING_KEY,
  provider: env.GCP_WORKLOAD_IDENTITY_PROVIDER, // projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<id>
  issuer: "https://research-dispatch.hklegalapp.invalid",
  subject: "convex-research-dispatcher",
  serviceAccount: env.GCP_RESEARCH_JOB_INVOKER,
});
for (const { dispatchId, runId } of reservations) {
  const { executionName } = await runCloudRunJob({
    job: env.GCP_RESEARCH_JOB_NAME, // projects/<project>/locations/<region>/jobs/<job>
    accessToken,
    env: { RESEARCH_RUN_ID: runId },
  });
  // record executionName; on a CloudRunJobDispatchError, record error.safeCode and returnAttempt
}
```

Which runs get an execution is the app's mutation, using `planDispatch`. It keeps one `{ attempts, lastDispatchedAt }` record per queue event, so a run queued again starts afresh. The app asks only about runs still waiting to be claimed. A new event dispatches at once; another execution starts once the last is `REDISPATCH_AFTER_MS` (3 min) old, since a job that has not claimed its run by then is taken to be lost, up to `MAX_DISPATCH_ATTEMPTS` (3). When no execution started, `returnAttempt` gives the attempt back, so a Google outage cannot use up a run's allowance. Read and write the record in the one mutation, so overlapping sweeps cannot both dispatch:

```ts
const next = planDispatch(existing, now); // null: leave the run alone
if (next) reserve(run, next);
```

`signingKeyJwks(pem)` is the public JWKS for the provider; `isCloudRunJobName`, `isWorkloadIdentityProvider` and `isServiceAccountEmail` check configuration before anything is signed.

`infra/cloud-run/` sets it up. Every name is a flag; `--help` lists them and `--dry-run` prints the commands without calling Google or Docker:

- `setup-dispatch-federation.sh`, once per project: the signing key, the pool and provider, and the accounts the subject may impersonate (`--account`), with bucket reads (`--read-bucket`). Give Convex the key, the provider's name and the issuer and subject it prints. It needs Node and the package's `dist/`, which a tag has.
- `deploy-job.sh`: builds the image for linux/amd64, pushes it, deploys the job by digest and lets each `--invoker` run it with overrides. Relative paths are the repository's. An image built from uncommitted sources is tagged `<commit>-wip-<time>`. Configuration reaches gcloud in a mode-600 file; secrets come from Secret Manager (`--secret`), and `--env-from` keeps a value out of argv.

```bash
bash node_modules/@eankhbayar/agent-runtime/infra/cloud-run/deploy-job.sh \
  --project myproject --region asia-southeast1 --job myapp-worker \
  --image asia-southeast1-docker.pkg.dev/myproject/myapp/worker --dockerfile worker/Dockerfile \
  --service-account myapp-worker@myproject.iam.gserviceaccount.com \
  --invoker myapp-job-invoker@myproject.iam.gserviceaccount.com \
  --env WORKER_MODE=job --secret PROVIDER_API_KEY=PROVIDER_API_KEY --mount-bucket myapp-data:/data
```

## Upgrading from 0.3

Nothing is renamed; `./job`, `./dispatch/cloud-run` and `infra/` are new. `executeRun` with a signal that has already aborted now returns `cancelled` without building, resuming or starting anything, and one that aborts while the sandbox is being made stops the runner; before, both ran to the time limit.

## Upgrading from 0.2

`./pi/runner` is unchanged. The other `./pi/*` paths are gone:

```text
pi/contract     -> contract
pi/testing      -> testing
pi/dispatcher   -> core               executeRun, EventSink, SinkState, LIVE, TokenGrant, Mount, ArtifactUpload, RunOutcome, SandboxProvider and its types, Usage, the reaper, printRunEvent
                -> providers/docker   docker, DockerError, DockerSandboxProvider, sampleUsage, parseDockerStats, createGateway, Gateway, LlmConfig
```

## Develop

```bash
pnpm ready      # typecheck, test, build
pnpm release    # tag v<version> with dist/ and push
```
