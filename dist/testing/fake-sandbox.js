// Sets up the fake `sandbox` CLI (fake-sandbox-cli.ts) for a test, so a
// CloudRunSandboxProvider can be driven without Cloud Run:
//
//   const cli = await createFakeSandboxCli();
//   const provider = new CloudRunSandboxProvider({ namespace: "test", sandboxBin: cli.bin, stateDir: cli.stateDir });
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
function quote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
export async function createFakeSandboxCli() {
    const base = await mkdtemp(path.join(tmpdir(), "agent-runtime-fake-sandbox-"));
    const root = path.join(base, "cli");
    const stateDir = path.join(base, "state");
    const self = import.meta.url;
    const script = fileURLToPath(new URL(self.endsWith(".ts") ? "./fake-sandbox-cli.ts" : "./fake-sandbox-cli.js", self));
    const bin = path.join(base, "sandbox");
    await writeFile(bin, `#!/bin/sh\nFAKE_SANDBOX_ROOT=${quote(root)} exec ${quote(process.execPath)} ${quote(script)} "$@"\n`);
    await chmod(bin, 0o755);
    return {
        bin,
        root,
        stateDir,
        calls: async () => (await readFile(path.join(root, "calls.jsonl"), "utf8").catch(() => ""))
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        cliEnvNames: async () => (await readFile(path.join(root, "env.jsonl"), "utf8").catch(() => ""))
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        sandboxes: async () => await readdir(path.join(root, "sandboxes")).catch(() => []),
        config: async (id) => JSON.parse(await readFile(path.join(root, "sandboxes", id, "config.json"), "utf8")),
        cleanup: async () => {
            await rm(base, { recursive: true, force: true });
        },
    };
}
