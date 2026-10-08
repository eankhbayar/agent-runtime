// A stand-in for Cloud Run's `sandbox` CLI, for testing CloudRunSandboxProvider
// without Cloud Run. It behaves as the probe saw the real one behave, where a
// test can tell:
//
// - `run <id> --detach … -- cmd` records the sandbox and its mounts; the command
//   is not run (sandboxes here only ever run `sleep infinity`).
// - `exec <id> -- cmd` runs cmd on this host with only HOME in its environment,
//   with each bind's destination (and /tmp, which is private to a sandbox)
//   rewritten to its source in the arguments. It exits 0 when the command
//   does and dies of SIGPIPE when it does not, losing the code. Killing it
//   leaves the command running. A sandbox that is not there is an error.
// - `delete <id> [--force]` kills what runs in it and forgets it, and succeeds
//   for a sandbox that is not there.
//
// Limits are recorded, not applied: each `ulimit` becomes a no-op. There is no
// network isolation either; a test checks the flags in the call log.
//
//   FAKE_SANDBOX_ROOT   where sandboxes and calls.jsonl are kept (required)

import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const root = process.env.FAKE_SANDBOX_ROOT;
if (!root) {
  console.error("FAKE_SANDBOX_ROOT is required");
  process.exit(2);
}
const argv = process.argv.slice(2);
mkdirSync(root, { recursive: true });
appendFileSync(path.join(root, "calls.jsonl"), `${JSON.stringify(argv)}\n`);

type Bind = { source: string; destination: string; readonly: boolean };
type Config = { id: string; binds: Bind[]; flags: string[] };

const dirOf = (id: string) => path.join(root, "sandboxes", id);
const configOf = (id: string): Config | null => {
  try {
    return JSON.parse(readFileSync(path.join(dirOf(id), "config.json"), "utf8")) as Config;
  } catch {
    return null;
  }
};

function fail(message: string, code = 1): never {
  console.error(`Error: ${message}`);
  process.exit(code);
}

/** Splits `[flags] -- command`; flags that take a value are listed. */
function parse(args: string[], valued: string[]) {
  const flags: string[] = [];
  const values: Record<string, string[]> = {};
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      i++;
      break;
    }
    const [name, inline] = arg.split(/=(.*)/s, 2) as [string, string | undefined];
    if (valued.includes(name)) {
      const value = inline ?? args[++i] ?? "";
      (values[name] ??= []).push(value);
    } else if (arg.startsWith("-")) {
      flags.push(arg);
    } else {
      break;
    }
  }
  return { flags, values, command: args.slice(i) };
}

function bindOf(spec: string): Bind {
  const fields = Object.fromEntries(
    spec.split(",").map((part) => {
      const [key, value] = part.split("=", 2) as [string, string | undefined];
      return [key, value ?? "true"];
    }),
  );
  if (fields.type !== "bind" || !fields.source || !fields.destination) {
    fail(`unsupported mount ${spec}`);
  }
  return { source: fields.source, destination: fields.destination, readonly: "readonly" in fields };
}

/** Rewrites sandbox paths in one argument to where they are on this host. */
function translate(arg: string, config: Config): string {
  const maps = [
    ...config.binds.map((b) => [b.destination, b.source] as const),
    ["/tmp", path.join(dirOf(config.id), "tmp")] as const,
  ].sort((a, b) => b[0].length - a[0].length);
  let out = arg;
  for (const [from, to] of maps) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(^|[\\s'"=:(])${escaped}(?=/|$|[\\s'";)])`, "g"), `$1${to}`);
  }
  // Limits are not applied here: a sandbox's would land on this host's user.
  return out.replace(/(^|[\s;&|(])ulimit /g, "$1: ulimit ");
}

const [verb, id, ...rest] = argv;

if (verb === "run") {
  if (!id) fail("a sandbox id is required");
  if (configOf(id)) fail(`sandbox ${id} already exists`);
  const { flags, values } = parse(rest, ["--mount", "-e", "--env", "-p", "--publish", "-w", "--workdir"]);
  const binds = (values["--mount"] ?? []).map(bindOf);
  for (const bind of binds) {
    if (!existsSync(bind.source)) fail(`mount source ${bind.source} does not exist`);
  }
  mkdirSync(path.join(dirOf(id), "tmp"), { recursive: true });
  mkdirSync(path.join(dirOf(id), "pids"), { recursive: true });
  writeFileSync(path.join(dirOf(id), "config.json"), JSON.stringify({ id, binds, flags }));
  console.log("Running in detached mode: stdin, stdout and stderr arguments are ignored.");
  process.exit(0);
}

if (verb === "exec") {
  if (!id) fail("a sandbox id is required");
  const config = configOf(id);
  if (!config) fail(`sandbox ${id} is not running`);
  const { values, command } = parse(rest, ["-e", "--env", "-w", "--workdir"]);
  if (command.length === 0) fail("a command is required");
  const env: Record<string, string> = { HOME: "/root" };
  for (const pair of [...(values["-e"] ?? []), ...(values["--env"] ?? [])]) {
    const [name, value] = pair.split(/=(.*)/s, 2) as [string, string | undefined];
    env[name] = value ?? "";
  }
  const workdir = (values["--workdir"] ?? values["-w"])?.at(-1);
  const cwd = workdir ? translate(workdir, config) : "/";
  const [file, ...args] = command.map((arg) => translate(arg, config));
  // Its own process group, so a signal to this CLI does not reach the command.
  const child = spawn(file!, args, {
    cwd: existsSync(cwd) ? cwd : "/",
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  const pidFile = path.join(dirOf(id), "pids", String(child.pid));
  writeFileSync(pidFile, "");
  process.stdin.pipe(child.stdin);
  child.stdin.on("error", () => {});
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.on("error", (error) => fail(String(error)));
  child.on("close", (code) => {
    rmSync(pidFile, { force: true });
    if (!configOf(id)) fail(`sandbox ${id} is not running`);
    // The real CLI loses a failing command's exit code the same way.
    if (code === 0) process.exit(0);
    dieOfSigpipe();
  });
} else if (verb === "delete") {
  if (!id) fail("a sandbox id is required");
  const pids = path.join(dirOf(id), "pids");
  for (const pid of existsSync(pids) ? readdirSync(pids) : []) {
    try {
      process.kill(-Number(pid), "SIGKILL");
    } catch {}
  }
  rmSync(dirOf(id), { recursive: true, force: true });
  process.exit(0);
} else if (verb !== "run") {
  fail(`unknown command ${verb ?? ""}`);
}

/** Node ignores SIGPIPE; removing a listener puts the default back, which ends the process. */
function dieOfSigpipe(): void {
  process.on("SIGPIPE", () => {});
  process.removeAllListeners("SIGPIPE");
  process.kill(process.pid, "SIGPIPE");
}
