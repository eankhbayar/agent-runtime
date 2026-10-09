# @eankhbayar/agent-runtime

Runtimes for running coding agents inside a sandbox and streaming what they do as a stable event log. One runtime today, `pi`; others sit beside it as they arrive. Extracted from the HKJC analysis runtime.

Each directory below is imported by its path under `src/`, e.g. `@eankhbayar/agent-runtime/providers/docker`:

```text
src/contract/           run events, the JSON-lines emitter and parser, and the fold into a view. No Node APIs, so a web app can import it.
src/core/               runs on the host, for every runtime: `executeRun`, `EventSink`, `RunStore`, `SessionStore`, the `SandboxProvider` interface, the in-process gateway, the reaper, `printRunEvent`, `createPipelineEvents`
src/models/             model endpoints, one chat call in either format, usage and cost, route digests, an AI SDK adapter. No Node APIs, so Convex can import it.
src/job/                `runJob`: one job execution claims, works and finishes one run
src/dispatch/cloud-run/ for an app's Convex: Google tokens without a key, starting a Cloud Run Job execution, the redispatch policy. No Node APIs.
src/providers/docker/   the Docker `SandboxProvider`, `docker stats` sampling, and gateway control (`createGateway`)
src/providers/cloud-run/ the Cloud Run `SandboxProvider` for a job's `sandbox` CLI, and the stdio bridge with its in-sandbox shim
src/pi/runner/          runs in the sandbox: `runAgent`, the pi event adapter, the `save_output` tool
src/testing/            `FakeSandboxProvider`, `FakeSink`, `FakeRunStore`, a fake `sandbox` CLI and a fake model endpoint (Messages and Chat Completions), for a project's tests
gateway/                egress gateway image, shared by every runtime: holds the provider key, proxies Anthropic Messages or OpenAI Chat Completions calls for valid run tokens
infra/cloud-run/        scripts that set up Convex's federation and deploy a Cloud Run Job
```

## Install

Releases are git tags that carry their built `dist/`. The repo is public, so installing one needs no credentials:

```json
{ "dependencies": { "@eankhbayar/agent-runtime": "github:eankhbayar/agent-runtime#v0.8.0" } }
```

`@earendil-works/pi-coding-agent` and `typebox` are peer dependencies, needed only where `./pi/runner` is imported. `./models` needs no AI SDK package; an app that wants an AI SDK model passes in the factories it already imports (see [Models](#models)).

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

The runner reads `PROMPT`, `RUN_ID`, `LLM_*` and `RUN_LIMITS` from its environment and writes run events to stdout as JSON lines. `--check` validates the image without calling a model. `LLM_PROVIDER` and `LLM_MODEL` name a model in pi's built-in catalog; for one outside it, such as a model behind an OpenAI-compatible endpoint, see [OpenAI-compatible models](#openai-compatible-models).

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

Needs Docker (any context: Colima, Docker Desktop, a remote host) and a key for an Anthropic Messages or OpenAI Chat Completions endpoint.

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

## OpenAI-compatible models

The gateway and the runner speak either of two formats. The default is Anthropic Messages, as before: the gateway proxies `/v1/messages` and sends the key as `x-api-key`, and the runner takes a model from pi's catalog. With the `openai` format the gateway proxies OpenAI Chat Completions, and the runner registers a model pi does not know, so any endpoint that serves `POST <base>/chat/completions` with `Authorization: Bearer <key>` works, such as the one hk-legal uses.

**The gateway.** In `openai` format it proxies `POST /v1/chat/completions` to `<baseUrl>/chat/completions` and nothing else (no `/v1/messages`, no `/v1/models`). The agent sends its run token as `Authorization: Bearer rt_…`, the way an OpenAI client sends a key; the gateway drops the client's `authorization`, `x-api-key`, `openai-organization` and `openai-project` and sends `Authorization: Bearer <provider key>`. The token check, unbuffered SSE, the hang-up handling and the logs (no keys, no tokens) are the same as for Messages.

On Docker, give `LlmConfig` the format and the base URL in place of `messagesUrl`:

```ts
const llm: LlmConfig = {
  format: "openai",
  baseUrl: "https://api.example.com/v1",   // calls go to <baseUrl>/chat/completions
  provider: "example",                      // what the runner registers the model under
  model: "gpt-6-luna",
  apiKey: process.env.PROVIDER_API_KEY,
};
await gateway.ensure({ image: "myproject-egress-gateway", llm });
```

The gateway image reads its upstream from its environment, which `ensure` sets:

| Variable | |
|---|---|
| `UPSTREAM_FORMAT` | `anthropic` (default) or `openai` |
| `UPSTREAM_MESSAGES_URL` | `anthropic`: the full Messages endpoint |
| `UPSTREAM_BASE_URL` | `openai`: the API base; calls go to `<base>/chat/completions` |
| `UPSTREAM_API_KEY` | the provider key, as `x-api-key` or as a bearer token |

A container started for a different format or URL is replaced on the next `ensure`. In a job, the in-process gateway takes the same choice:

```ts
const gateway = createInProcessGateway({
  format: "openai",
  baseUrl: "https://api.example.com/v1",
  apiKey: process.env.PROVIDER_API_KEY!,
});
```

**The runner.** `LLM_API=openai` makes `runAgent` register a provider of its own with pi (`ModelRuntime.registerProvider`, in memory, with pi's `openai-completions` API) holding the one model `LLM_MODEL`, so the model need not be in pi's catalog and no `models.json` is read or written. Give the runner:

| Variable | |
|---|---|
| `LLM_API` | `openai` (pi's `openai-completions`); `anthropic` (`anthropic-messages`) registers a Messages model outside the catalog the same way |
| `LLM_MODEL` | the model id the endpoint expects (required) |
| `LLM_BASE_URL` | the gateway (required): `gateway.url` or `provider.bridgeUrl`, as for Messages. A bare origin gets `/v1` added, so the same value works in both formats |
| `LLM_API_KEY` | the run token, which `executeRun` sets |
| `LLM_PROVIDER` | the provider id to register; default `openai-compatible` |
| `LLM_CONTEXT_WINDOW` | tokens, default 128000; compaction works from it |
| `LLM_MAX_TOKENS` | output tokens per call (reasoning included, for OpenAI reasoning models), default 32768 |
| `LLM_REASONING` | `true` (default): `THINKING_LEVEL` is sent as `reasoning_effort`. `false` for a model that takes none |
| `LLM_COMPAT` | optional JSON object of pi's `compat` settings for the model, e.g. `{"supportsDeveloperRole":false,"maxTokensField":"max_tokens"}` for a server that wants a `system` message and `max_tokens` |

```ts
env: {
  LLM_API: "openai",
  LLM_PROVIDER: llm.provider,
  LLM_MODEL: llm.model,
  LLM_BASE_URL: gateway.url,   // or provider.bridgeUrl in a Cloud Run job
},
```

Without `LLM_API` nothing changes: `LLM_PROVIDER` and `LLM_MODEL` (or `defaultModel`) name a catalog model. `--check` resolves the model as a run would, without calling it, and fails on a missing model or base URL or a value it cannot parse; for a custom model its notice also carries `api`, `baseUrl`, `contextWindow` and `maxTokens`.

pi's defaults for an OpenAI-compatible endpoint are OpenAI's own: the system prompt as a `developer` message, `store: false`, `max_completion_tokens`, `reasoning_effort` and `stream_options.include_usage`. `https://api.lel190.dev/v1`, hk-legal's endpoint, accepts them as they are (checked with `gpt-6-luna`).

## Models

`./models` is the model layer an app's host code calls directly, outside any sandbox: a Convex action, a pipeline worker, a script. It uses only `fetch`, `TextDecoder`, timers and Web Crypto, so it runs in Convex's default runtime as well as in Node (`tsconfig.models.json` typechecks it without Node's globals, and a test keeps it from importing anything but itself and the contract). It holds what every app needs to call a model the same way; policy stays in the app: which routes exist and who approved them, prompt bundles, budgets, retries, output validation.

**Endpoints.** A `ModelEndpoint` is where a model is called, in which format, and which variable holds the key. Its URL half has the same shape as the gateway's `GatewayUpstream`, so an endpoint spreads into `createInProcessGateway({ ...endpoint, apiKey })` or a Docker `LlmConfig` as it is.

```ts
import { modelEndpoint, modelEndpointFromEnv } from "@eankhbayar/agent-runtime/models";

// { format: "openai", baseUrl: "https://api.lel190.dev/v1", model: "gpt-6-luna", apiKeyEnv: "KIMI_API_KEY" }
const endpoint = modelEndpointFromEnv(process.env, {
  format: "MODEL_FORMAT", url: "MODEL_BASE_URL", model: "MODEL_ID", apiKey: "KIMI_API_KEY",
}, { format: "openai", url: "https://api.lel190.dev/v1", model: "gpt-6-luna" });
```

`modelEndpoint({ format, url, model })` takes the loose forms the apps configure: the format as `openai`, `openai-compatible`, `chat-completions`, `anthropic`, `anthropic-compatible` or `messages` (any case); an OpenAI URL as the base or the full `…/chat/completions`; an Anthropic URL as the Messages endpoint, its `/v1` base, or a bare origin (which gets `/v1/messages`). `endpointUrl` is where calls are posted, `sdkBaseUrl` the `baseURL` an SDK wants, and `apiKeyFor(endpoint, env)` reads the key from `apiKeyEnv`, naming the variable if it is unset. The key itself is never part of an endpoint.

**One call.** `callModel(endpoint, request, options)` makes one chat call in the endpoint's format, streamed (SSE) or not, and resolves with the same result either way:

```ts
import { apiKeyFor, callModel } from "@eankhbayar/agent-runtime/models";

const result = await callModel(endpoint, {
  system: "…",
  messages: [{ role: "user", content: question }],
  maxOutputTokens: 6_000,
  reasoningEffort: "low",                        // OpenAI's reasoning_effort
  structuredOutput: { name: "memo", strict: true, schema },   // OpenAI's response_format: json_schema
  stream: true,
}, {
  apiKey: apiKeyFor(endpoint, process.env),
  signal,                                        // aborting fails the call with `cancelled`
  timeouts: { connectionMs: 30_000, noProgressMs: 90_000, invocationMs: 600_000 },
  onText: (delta) => …,                          // the answer as it arrives
});
// result: { text, usage, stopReason, model, requestId?, responseId?, createdAt?, connectionMs, durationMs }
```

Stream calls that run under a route's timeouts. A non-streamed call gets its headers only once the whole answer is generated, so a long answer can fail with `connection_timeout` while the provider is still working; a streamed one gets its headers at once, and `noProgressMs` then watches the tokens arrive. hk-legal's worker streams its OpenAI calls for this reason.

`extraBody` adds top-level fields the endpoint takes (`temperature`, `thinking`); the fields the call sets win over it. `headers` adds request headers (`anthropic-beta`); the auth header is always the call's own: `Authorization: Bearer` for OpenAI, `x-api-key` with `anthropic-version: 2023-06-01` for Anthropic. `maxTokensField: "max_completion_tokens"` is for an OpenAI endpoint that wants it instead of `max_tokens`. An Anthropic endpoint cannot take `structuredOutput` (`structured_output_unsupported`) and is not sent `reasoningEffort`. `onConnected` fires when the headers arrive and `onProgress` on each chunk, for an app that keeps its own lifecycle record. A server that ignores `stream` and answers with JSON is read as JSON.

The call is never retried here. Every failure of the call itself is a `ModelCallError` whose `message` is its `code`, with `retryable`, `retryAfterMs` (from `retry-after`, for a retryable code), `status`, and `provider`: the endpoint's own error `type`, `code` and `param`, each kept only if it is a short identifier. Nothing else of a response, no message, body, URL or key, and no `cause`, leaves the module, since a provider's message can quote the prompt. An error the app's own code throws (`onText`, `onProgress`, `onConnected`, `classify`, an `extraBody` JSON cannot encode) is rethrown as it is, never turned into a retryable code, so an app bug cannot set off a paid retry. Only fetch's own failures and a body cut off become `connection_failure`. However a call ends, a body left unread is cancelled, even when the `fetch` ignores its signal.

| `code` | when | retryable |
|---|---|---|
| `authentication_failed`, `permission_denied` | 401, 403 | no |
| `invalid_request` | any other 4xx | no |
| `context_overflow` | 413, or the endpoint says the context is too long | no |
| `quota_exhausted`, `subscription_required` | the endpoint says so | no |
| `concurrency_throttle` | 429 | yes |
| `overload` | 529, or an overloaded error, also mid-stream | yes |
| `http_5xx` | 5xx | yes |
| `connection_failure` | no response: DNS, TLS, a reset, a body cut off | yes |
| `connection_timeout`, `no_progress_timeout`, `invocation_timeout` | `timeouts.connectionMs`, `noProgressMs`, `invocationMs` ran out | yes |
| `cancelled` | the caller's signal aborted | no |
| `provider_response_invalid` | a 2xx that is not an answer of the format, holds no text, or exceeds 32 MiB | no |
| `structured_output_unsupported` | structured output asked of an Anthropic endpoint | no |

These are hk-legal's provider codes, with the same retryable set. `classify` picks the code for a refusal before the defaults do, for a provider that signals in its own way (hk-legal's `x-kimi-error-code` header); return undefined to fall back.

**Usage and cost.** `ModelUsage` is the same way round in both formats: `inputTokens` counts every prompt token (Anthropic's cache reads and writes are added to its `input_tokens`), `outputTokens` the visible output, `reasoningTokens` what OpenAI reports as reasoning (taken out of `completion_tokens`), `cacheReadTokens` and `cacheWriteTokens` the cached part of the input. `openAiUsage` and `anthropicUsage` read a usage object of either format, for code that gets one elsewhere. `modelCost(usage, pricing)` prices it in US dollars from per-million rates (`inputUsdPerMillionTokens`, `outputUsdPerMillionTokens`, optional cache rates), output and reasoning at the output rate; without cache rates that is hk-legal's pay-as-you-go equivalent. Two differences from hk-legal's own code are deliberate, and can move its figures a little on adoption. Its `kimi-provider.ts` counts Anthropic's `input_tokens` alone, so with prompt caching in use `inputTokens` here is larger, and so is anything budgeted on it. Its `model-invocation.ts` rounds only the total cost to eight places, where `modelCost` rounds each part and sums those, so totals can differ in the eighth place. `turnUsage(usage, pricing?)` gives the call as one turn of the run trace, in pi's convention (`input` without the cache, `output` with reasoning), for a pipeline's `usage` or a `turn_end`.

**Routes.** A route is an app's immutable record of how a model is called, pinned by a digest of every field. The package fixes only `ModelRoute<Policy>`: an id, a model, a digest, and the app's own `Policy` fields, which it names as it likes. `manifestDigest(manifest)` is SHA-256 over `stableJson` (keys sorted at every level) of every field but `digest`, the scheme hk-legal uses, so its Model Route and Prompt Bundle digests come out the same (a test pins one of each). One difference: `stableJson` leaves out a property whose value is undefined, as `JSON.stringify` does, where hk-legal's local `stable` writes `"key":undefined`. None of hk-legal's pinned manifests has an undefined field, but a manifest that does digests differently here, and so do records with optional fields such as hk-legal's invocation input digests, which should stay on its own function. `sealManifest(draft)` returns a frozen copy with its digest, for writing a new route; `checkManifestDigest(route)` says whether a pinned digest still matches. The manifests, their registry, promotion evidence and prompt bundles stay in the app.

**The AI SDK.** `createAiSdkModel(endpoint, factories, { apiKey })` builds an AI SDK model with the factories the app already imports, so this package depends on no AI SDK version and the result is the app's own model type:

```ts
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { apiKeyFor, createAiSdkModel } from "@eankhbayar/agent-runtime/models";

const model = createAiSdkModel(endpoint, {
  openai: (settings, id) => createOpenAICompatible(settings).chatModel(id),
  anthropic: (settings, id) => createAnthropic(settings).languageModel(id),
}, { apiKey: apiKeyFor(endpoint, process.env) });
```

The settings carry `baseURL` (`sdkBaseUrl`), `apiKey`, `headers`, a `fetch`, and a `name`: `options.name`, else the endpoint's `provider`, in either format. With neither, OpenAI gets `openai-compatible` (`createOpenAICompatible` requires a name) and Anthropic gets none and keeps the SDK's own (`anthropic.messages`). Since the name is the key a call's `providerOptions` sit under, leave `provider` off an Anthropic endpoint whose calls pass options under `anthropic`. `transformBody` rewrites each JSON request body before it is sent, as hk-legal's `kimiFetch` does (`bodyRewritingFetch` is the wrapper on its own); a body it cannot parse or rewrite goes unchanged, and a failed request is not sent twice. `aiSdkProviderSettings` returns the settings for an app that calls a factory itself (`createOpenAI(settings).chat(id)`). It is tested against `@ai-sdk/openai-compatible` 3.0.51 (HKJC pins it), `@ai-sdk/openai` 4.0.72 with `createOpenAI(settings).chat(id)` and `@ai-sdk/anthropic` 4.0.59 (hk-legal's Convex takes `^4.0.45` and `^4.0.40`), all as dev dependencies.

## Stores

`EventSink` is all `executeRun` writes to. A worker that claims runs itself, such as a job started for one run, uses a `RunStore`: `claim({ runId, idempotencyKey })` returns a `ClaimedRun` that is the run's sink, with the app's payload, `heartbeat()` and `finish(ending)`. `executeRun` never beats or finishes, so its caller does both, usually through `runJob` (see Jobs); a store fails a run that goes quiet (HKJC's after 90 s).

A claim rejects with `StoreUnreachableError` when no answer came back; retry that with the same key, so a claim that landed comes back. Any other rejection is the store refusing, and is not retried. An app with endings of its own (a pause for review, say), a richer answer from `finish`, or methods of its own on the claim types the store by its claim: `RunStore<MyClaim>`, where `MyClaim` extends `ClaimedRun<Payload, Ending, Settled>`. `PayloadOf`, `EndingOf` and `SettledOf` name a claim's types in code generic over it. How HKJC's Convex functions and hk-legal's protocol 5 map onto it is at the top of `src/core/run-store.ts`.

## Jobs

`runJob` from `./job` is one job execution working one run, as a Cloud Run Job started for that run does. It claims the run, retrying only `StoreUnreachableError`, with the same key, after 1, 2 and 4 s, and claims nothing once it has been told to stop. While the work runs it beats at `claim.heartbeatMs` and aborts the work's signal when a beat says the run was cancelled or is gone. A failed beat is only logged, since the store decides when a quiet run is lost (`maxQuietMs` stops the work sooner, and is raised to twice `claim.heartbeatMs` if less, since quiet time counts from the claim), so a heartbeat whose store refused it answers `gone` rather than rejecting. It finishes with the ending the work returns, or, if the work throws, with what `failed` returns: by default `failed` with the error's message, or `cancelled` after a cancel.

SIGTERM, which Cloud Run sends at the task timeout and on a cancelled execution, ten seconds before SIGKILL, aborts the work with the reason `shutdown`. Finishing the run then ends it for good unless the store retries that ending, so a job whose store requeues a run when its lease lapses returns `RELEASE` from `work` or `failed` instead: the job stops beating and leaves the run to the store, as a crashed worker would. Before finishing, the job waits for a beat in flight for up to one interval, but once it is shutting down for only `shutdownBeatWaitMs` (1 s by default), so the finish goes out before SIGKILL.

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

## Pipeline run events

A pipeline is a run whose work is the app's own code rather than an agent in a sandbox: hk-legal's Research Worker, which runs its stages under `runJob` against its own store. `createPipelineEvents(sink)` from `./core` lets it write the same `RunEvent` stream the pi runner writes, so an app shows both kinds of run with `foldRunEvents` and one trace view. The sink is usually the run's claim, as for `executeRun`.

```ts
import { createPipelineEvents } from "@eankhbayar/agent-runtime/core";
import { callModel, turnUsage } from "@eankhbayar/agent-runtime/models";

work: async (claim, signal) => {
  const firstSeq = claim.payload.nextEventSeq;   // the app's store says where the run's log ends: 0 on its first attempt
  const trace = createPipelineEvents(claim, { firstSeq });
  if (firstSeq === 0) trace.start({ model: `${endpoint.provider}/${endpoint.model}` });
  const frame = await trace.step("framing", async () => {
    const result = await callModel(endpoint, request, { apiKey, signal });
    trace.usage(turnUsage(result.usage, pricing), { model: endpoint.model, step: "framing" });
    return parseFrame(result.text);
  }, { args: { question }, result: (f) => `${f.issues.length} issues` });
  …
  await trace.finish();
  return ending;
}
```

How a pipeline maps onto the trace:

| the pipeline | writes | the folded view shows |
|---|---|---|
| begins the run (its first attempt only) | `start({ model, ... })`: `run_started` | the run's model and start time |
| runs a stage or sub-step | `step(name, work, { args, result })`: `tool_start`, then `tool_end` | a tool item named for the step, with its arguments, duration, result, and `done` or `error` |
| calls a model | `usage(turnUsage(result.usage, pricing), { model, step })`: `turn_end` | tokens and cost summed into `usage`, one turn per call |
| reaches a state worth a line (paused for review, suspended for the corpus, retrying) | `notice(kind, message)` | a notice with the message |
| produces an output | `artifact({ artifactId, path, caption })`, or `{ upload }` to store it through the sink first | an artifact item |
| writes answer text | `text(delta)`: `text_delta` | a text item; `answerText` joins them |
| ends the run | `finish({ error?, followUps? })`: `run_finished`, then a flush | the end time, the error, follow-ups |

A step that throws ends as an error and the error is rethrown. What it shows is `errorResult(error)`, by default the error's `safeCode` or `code` when it looks like an identifier and otherwise `failed`, never the message, since the trace is shown to users and a message can quote a provider or the matter. A step still running when the run fails or is cancelled folds as `interrupted`. Steps may nest or overlap; each step's id is its `tool_start`'s seq.

Write `start` once and `finish` once per run, not per attempt: a pause for review or a released attempt is a `notice`, and the run's next attempt continues the same log with `firstSeq` set one past the stored log's last seq, so a sink that dedupes on seq keeps every new event. Events after `finish` are dropped and logged. The store needs an event log for any of this to reach a user: hk-legal's protocol 5 has none yet, so its claim's `events` stores nothing (see the top of `src/core/run-store.ts`) until it gains an append operation that dedupes on seq.

Emitting never throws and never waits. Events are batched (`batchMs`, 150 ms, or `batchEvents`, 25) and sent one batch at a time in seq order; a batch the sink rejects is sent again unchanged up to `retries` (4) times, and then, as when the sink answers `gone`, every later batch is dropped and logged. An upload the sink fails to store is logged and its `artifact` event still written, with a null id, as `executeRun` does; `artifact()` never rejects. The pipeline's work goes on regardless, since the trace is not its record of the run; `flush()` sends what is waiting and resolves with the sink's answer, and `state` holds the latest one, so a pipeline can stop on a cancel the sink reports. `events` is everything written, to fold locally.

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
- `deploy-job.sh`: builds the image for linux/amd64, pushes it, deploys the job by digest and lets each `--invoker` run it with overrides. `--sandbox-launcher` lets the job start sandboxes, and `--mount-bucket-rw` mounts a bucket read-write. Relative paths are the repository's. An image built from uncommitted sources is tagged `<commit>-wip-<time>`. Configuration reaches gcloud in a mode-600 file; secrets come from Secret Manager (`--secret`), and `--env-from` keeps a value out of argv.

```bash
bash node_modules/@eankhbayar/agent-runtime/infra/cloud-run/deploy-job.sh \
  --project myproject --region asia-southeast1 --job myapp-worker \
  --image asia-southeast1-docker.pkg.dev/myproject/myapp/worker --dockerfile worker/Dockerfile \
  --service-account myapp-worker@myproject.iam.gserviceaccount.com \
  --invoker myapp-job-invoker@myproject.iam.gserviceaccount.com \
  --env WORKER_MODE=job --secret PROVIDER_API_KEY=PROVIDER_API_KEY --mount-bucket myapp-data:/data
```

## Sandboxes on Cloud Run

A Cloud Run Job deployed with `--sandbox-launcher` can start gVisor sandboxes inside its own instance with the `sandbox` CLI at `/usr/local/gcp/bin/sandbox`. `./providers/cloud-run` runs a run's agent in one, so a job started for a run needs no Docker host. What it relies on, as the probe in HKJC's `spike/cloud-run-sandbox` found it:

- A sandbox's root is the job container's own filesystem, read-only, with its writes in an overlay and its own `/tmp`. So the job image is the sandbox image: whatever the runner needs is installed in the job's image, and the job's node and its copy of this package are at the same paths inside the sandbox. It also means the sandbox can read every file the job can. So every FUSE mount of the job, a Cloud Storage volume or one of the platform's own such as Cloud Run's `/var/log`, gets an empty read-only directory over it in each sandbox unless it is listed in `visibleMounts`, and the provider logs (through `log`) which it covered. List anything else it must not read in `hide`, and give the job its secrets as environment variables, which a sandbox does not inherit, not as files. The `sandbox` CLI itself gets only `PATH` and `HOME`, plus `cliEnv`.
- Without `--allow-egress` a sandbox has no network at all: no DNS, no metadata server, none of the job's listeners. The provider never passes `--allow-egress` or `--publish`. The runner reaches the model over the stdio bridge.
- The job must run as root to start sandboxes. Each sandbox runs as a mapped root that may write a bind-mounted directory only when it is root-owned 755 or open, so the provider makes each sandbox's workspace that way, under `stateDir` (in the job's `/tmp`, which sandboxes cannot see).
- `sandbox exec` loses the exit code, and killing it leaves a command with children running. Every command runs under a wrapper that prints the code after a marker and records a pid file; `kill` and timeouts signal the pid, and a timeout exits 124 as on Docker.
- There is no CPU limit, no pause and no list. Memory is capped with `ulimit -v` at the run's `memoryMb` plus `memoryHeadroomMb` (1536 by default, since Node reserves about 1.4 GiB of address space before allocating anything) and processes with `ulimit -p`. A limit one command sets holds for the rest of the sandbox and can only be lowered, so every command sets the same ones. The cap is per process, and a sandbox's memory is the job instance's: size the job for the sandbox and itself, since a sandbox that exhausts the instance takes the job down.
- `pause` and `resume` fail, so `executeRun` builds a new sandbox each run; with `session` it carries the agent's session from one to the next.

### The bridge and the in-process gateway

The shim `dist/providers/cloud-run/bridge-peer.js` runs in the sandbox under plain node, listens on `127.0.0.1:<port>` and carries each connection to the job as frames over a long-lived `sandbox exec`'s stdin and stdout (about 40 MB/s in the probe, SSE events arriving as sent). On the job's side, `startBridge` hands each connection to `onConnection`, usually the in-process gateway's `connect`. With the `bridge` option the provider starts the shim once a sandbox exists, starts it again if its exec ends, and stops it on `destroy`.

`createInProcessGateway({ messagesUrl, apiKey })` is the gateway image's handling (run token check, provider key injection, unbuffered streaming) in the job's process, with run tokens in memory. Pass it as `executeRun`'s `tokens`, and give the runner `LLM_BASE_URL` set to `provider.bridgeUrl` (`http://127.0.0.1:8080` by default). The pi runner needs no change. `listen()` serves it on TCP as well, for anything not behind the bridge. For an OpenAI-compatible upstream pass `{ format: "openai", baseUrl, apiKey }` instead (see [OpenAI-compatible models](#openai-compatible-models)).

### Sessions

`SessionStore` is `save(key, fromDir)` and `restore(key, intoDir)`. `DirectorySessionStore(rootDir)` keeps one tar per key and replaces it by rename, so it works on a Cloud Storage FUSE volume the job mounts read-write (it needs `tar` on the job's PATH). With `session: { store, key }`, `executeRun` restores the session into a sandbox it builds before the runner starts, and saves it once the runner has exited, whether it finished, failed, timed out or was stopped. A store that cannot be read fails the run rather than letting it start over and then save a shorter session over the thread's. `remoteDir` defaults to `/workspace/.sessions`, where the pi runner keeps its session. `RunOutcome.session` says whether one was restored and whether it was saved. Two runs of the same key that end together both save and the last one wins, so do not run a thread twice at once.

### A job

```ts
import { createInProcessGateway, DirectorySessionStore, executeRun } from "@eankhbayar/agent-runtime/core";
import { runJob } from "@eankhbayar/agent-runtime/job";
import { CloudRunSandboxProvider } from "@eankhbayar/agent-runtime/providers/cloud-run";

const gateway = createInProcessGateway({ messagesUrl: llm.messagesUrl, apiKey: process.env.PROVIDER_API_KEY! });
const provider = new CloudRunSandboxProvider({
  namespace: "myproject",
  bridge: { port: 8080, onConnection: gateway.connect },
  hide: ["/sessions", "/snapshots"],     // other threads' sessions; the snapshot is bound where the run needs it
});
const sessions = new DirectorySessionStore("/sessions");

const result = await runJob(store, {
  runId: process.env.RUN_ID!,
  work: async (claim, signal) => {
    const { status, error, answerText, usage } = await executeRun({
      provider,
      tokens: gateway,
      sink: claim,
      runId: claim.runId,
      prompt: claim.payload.prompt,
      signal,
      command: ["node", "/opt/runner/runner.js"],
      image: "unused",                 // the sandbox runs the job's own image
      limits: { wallClockMs: 15 * 60_000, cpus: 1.5, memoryMb: 1536 },
      mounts: [{ localDir: `/snapshots/${claim.payload.release}`, remoteDir: "/data", mounted: true }],
      env: { LLM_PROVIDER: llm.provider, LLM_MODEL: llm.model, LLM_BASE_URL: provider.bridgeUrl },
      session: { store: sessions, key: claim.payload.threadId },
    });
    return { status, error, answerText, usage };
  },
});
process.exit(result.exitCode);
```

Deploy it with `infra/cloud-run/deploy-job.sh ... --sandbox-launcher --mount-bucket-rw <sessions-bucket>:/sessions --mount-bucket <snapshots-bucket>:/snapshots --secret PROVIDER_API_KEY=...`. The job image must not set `USER`, since only root can start sandboxes. `smoke/cloud-run/` is a complete example, run against Cloud Run with a fake model in the job.

A `mounted` mount is bound read-only when the sandbox is created rather than copied in, for a snapshot on the job's Cloud Storage volume; `verify` still hashes it. Since the snapshot volume itself is covered in the sandbox, the bind's destination must be outside it (`/data`, not under `/snapshots`). Other mounts are copied in through tar on a `sandbox exec`'s stdin. The agent is root in its sandbox, so a copied mount is writable to it; only a `mounted` one is read-only.

### What comes out of a sandbox

Everything a sandbox leaves behind is treated as hostile. `download` runs `tar` inside the sandbox, so links resolve in the sandbox's own view, streams the archive to the job under `maxDownloadBytes` (512 MiB by default), and unpacks it with `extractPlainTar`, which creates only directories and regular files and refuses links, devices, `..` or absolute paths and cut-off archives. On every provider, Docker included, `executeRun` stores an output only if it is a regular file (opened without following links), saves a session only if it is plain files and directories, and caps each at 256 MiB; anything else is logged and left out. The bridge takes frames of at most 1 MiB, at most 64 streams at once, ids that only grow, and kills a shim that breaks any of that; it stops reading a shim whose streams' readers are behind.

### Testing

`createFakeSandboxCli()` from `./testing` writes an executable that behaves as the real CLI does where a test can tell (it loses exit codes, keeps a command running when killed, records every call), to pass as `sandboxBin`; commands run on the test's host with paths inside binds rewritten, and limits are recorded but not applied. `startFakeUpstream({ apiKey })` is a model endpoint that checks the key and streams its reply as SSE: Messages at its `messagesUrl` (key as `x-api-key`), and Chat Completions under its `baseUrl` (key as a bearer token), or answers with JSON when the request does not ask to stream. `refuse` answers a request with a status, headers and body of the test's choosing, and `headerDelayMs` holds every response back, for testing a client's errors and timeouts.

## Upgrading from 0.7

Nothing changes for code that does not use the new parts. New: `./models` (see [Models](#models)), and `createPipelineEvents` with its types in `./core` (see [Pipeline run events](#pipeline-run-events)). `startFakeUpstream` takes two new options, `refuse` and `headerDelayMs`, and exports `FakeUpstreamRefusal`; without them it behaves as before. The AI SDK packages are dev dependencies only, so installing the tag pulls in nothing new.

## Upgrading from 0.6

Nothing changes at run time unless you ask for the new format. `LlmConfig`, `createInProcessGateway` and `createGatewayHandler` take `{ messagesUrl }` as before, or `{ format: "openai", baseUrl }`; the gateway image still reads `UPSTREAM_MESSAGES_URL`, with `UPSTREAM_FORMAT` and `UPSTREAM_BASE_URL` new and optional. A container started by 0.6's `createGateway` carries the same label and is reused.

One type-level change: `LlmConfig` is now a union, so code that reads `llm.messagesUrl` from a value typed `LlmConfig` no longer compiles until it checks `llm.format !== "openai"` first. In HKJC that breaks `dispatcher/job.ts`, `dispatcher/serve.ts` and `dispatcher/run-local.ts` (two places), which read `llm.messagesUrl` and must narrow first or pass the whole upstream. To hand the upstream to the in-process gateway whatever its format, spread the config; the gateway keeps only the upstream's own fields:

```ts
const gateway = createInProcessGateway({ ...llm, apiKey: process.env.PROVIDER_API_KEY! });
```

Rebuild the gateway image from the new tag before using the `openai` format, since an old image ignores `UPSTREAM_FORMAT` and would refuse to start without `UPSTREAM_MESSAGES_URL`.

The runner reads `LLM_API` and the variables it brings (see [OpenAI-compatible models](#openai-compatible-models)); without it, it behaves as 0.6. The gateway now also drops `openai-organization` and `openai-project` from requests in both formats. New exports: `GatewayUpstream` from `./core`; `resolveModelConfig`, `registerModel`, `RunnerModelConfig`, `DEFAULT_CONTEXT_WINDOW` and `DEFAULT_MAX_TOKENS` from `./pi/runner`; `chatCompletionEvents` and `FakeUpstream.baseUrl` from `./testing`.

## Upgrading from 0.6.0

0.6.1 fixes a crash in the gateway handler. When an agent hung up in the middle of a streamed answer (a cancelled, timed-out or shut-down run), the aborted upstream body emitted an unhandled `error` and took down the process serving the gateway: the job process with `createInProcessGateway`, or the gateway container under Docker. Take the tag and rebuild the gateway image.

## Upgrading from 0.5

Nothing is renamed or removed. On Docker the one change is that outputs and sessions containing symlinks or other non-regular files are now refused (logged), and each is capped at 256 MiB. New: `./providers/cloud-run`, `createInProcessGateway` and `MemoryTokenGrant`, `createGatewayHandler`, `SessionStore` and `DirectorySessionStore`, `executeRun`'s `session` option and `RunOutcome.session`, `Mount.mounted`, `extractPlainTar`, and `SandboxProvider.create`'s optional `binds`, which `DockerSandboxProvider` refuses. A provider of a project's own needs no change unless it wants to support `mounted`. `FakeSandboxProvider` now keeps files in `fs` (seeded from `files`), and `download` copies directories from it.

The gateway image now copies `gateway-handler.ts` beside `server.ts`; rebuild it from the new tag as usual, with the same command.

## Upgrading from 0.4

`RunOutcome.sandboxId` is now `string | null`, which breaks code that reads it. It is null when `executeRun`'s signal had already aborted and there was no `resumeSandboxId`, where 0.4 returned `""`; skip recording the sandbox or asking the provider about it then. HKJC's `dispatcher/serve.ts` passes `outcome.sandboxId` to `provider.status` and `dispatch.upsertSandbox` after the finish, and must do that only when it is not null.

`runJob` raises a `maxQuietMs` below twice the claim's `heartbeatMs` to that, and after a shutdown waits at most `shutdownBeatWaitMs` (new, 1 s by default) for a beat in flight rather than a whole interval.

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
