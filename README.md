# @eankhbayar/pi-runtime

Runs a [pi](https://github.com/earendil-works/pi) coding agent inside a sandbox and streams what it does as a stable event log. Extracted from the HKJC analysis runtime.

```text
src/contract/     run events, the JSON-lines emitter and parser, and the fold into a view. No Node APIs, so a web app can import it.
src/runner/       runs in the sandbox: `runAgent`, the pi event adapter, the `save_output` tool
src/dispatcher/   runs on the host: `executeRun`, the `SandboxProvider` interface, the Docker provider, the reaper, gateway control
src/testing/      `FakeSandboxProvider` and `FakeSink`, to drive `executeRun` in a project's tests
gateway/          egress gateway image: holds the provider key, proxies Anthropic-format Messages calls for valid run tokens
```

## Install

Releases are git tags that carry their built `dist/`:

```json
{ "dependencies": { "@eankhbayar/pi-runtime": "github:eankhbayar/pi-runtime#v0.1.0" } }
```

The repo is private, so whatever installs it needs read access: locally, git's credential helper (`gh auth setup-git`); in CI, a token, for example

```yaml
- run: git config --global url."https://x-access-token:${{ secrets.PI_RUNTIME_TOKEN }}@github.com/".insteadOf "https://github.com/"
```

`@earendil-works/pi-coding-agent` and `typebox` are peer dependencies, needed only where `./runner` is imported.

## In the sandbox

```ts
import { createSaveOutputTool, runAgent } from "@eankhbayar/pi-runtime/runner";

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
import { createGateway, DockerSandboxProvider, executeRun, sampleUsage } from "@eankhbayar/pi-runtime/dispatcher";

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

Build the gateway image from the installed package: `docker build -t myproject-egress-gateway node_modules/@eankhbayar/pi-runtime/gateway`.

A different sandbox platform is one more `SandboxProvider`; nothing else changes.

## Develop

```bash
pnpm ready      # typecheck, test, build
pnpm release    # tag v<version> with dist/ and push
```
