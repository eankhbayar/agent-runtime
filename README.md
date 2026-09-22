# @eankhbayar/agent-runtime

Runtimes for running coding agents inside a sandbox and streaming what they do as a stable event log. One runtime today, `pi`; others sit beside it as they arrive. Extracted from the HKJC analysis runtime.

```text
src/pi/             the pi runtime, imported as @eankhbayar/agent-runtime/pi/<part>
  contract/         run events, the JSON-lines emitter and parser, and the fold into a view. No Node APIs, so a web app can import it.
  runner/           runs in the sandbox: `runAgent`, the pi event adapter, the `save_output` tool
  dispatcher/       runs on the host: `executeRun`, the `SandboxProvider` interface, the Docker provider, the reaper, gateway control
  testing/          `FakeSandboxProvider` and `FakeSink`, to drive `executeRun` in a project's tests
gateway/            egress gateway image, shared by every runtime: holds the provider key, proxies Anthropic-format Messages calls for valid run tokens
```

## Install

Releases are git tags that carry their built `dist/`:

```json
{ "dependencies": { "@eankhbayar/agent-runtime": "github:eankhbayar/agent-runtime#v0.2.0" } }
```

The repo is private, so whatever installs it needs read access: locally, git's credential helper (`gh auth setup-git`); in CI, a token, for example

```yaml
- run: git config --global url."https://x-access-token:${{ secrets.AGENT_RUNTIME_TOKEN }}@github.com/".insteadOf "https://github.com/"
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

The sandbox image is the project's own. Node will not strip types from files under `node_modules`, which is why this package ships JavaScript; copy the installed package into the image's `node_modules` rather than installing it there, so the image build needs no GitHub credentials.

## On the host

```ts
import { createGateway, DockerSandboxProvider, executeRun, sampleUsage } from "@eankhbayar/agent-runtime/pi/dispatcher";

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

   import { LIVE, printRunEvent, type EventSink } from "@eankhbayar/agent-runtime/pi/dispatcher";

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

## Develop

```bash
pnpm ready      # typecheck, test, build
pnpm release    # tag v<version> with dist/ and push
```
