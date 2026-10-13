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
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, } from "node:fs";
import path from "node:path";
const root = process.env.FAKE_SANDBOX_ROOT;
if (!root) {
    console.error("FAKE_SANDBOX_ROOT is required");
    process.exit(2);
}
const argv = process.argv.slice(2);
mkdirSync(root, { recursive: true });
appendFileSync(path.join(root, "calls.jsonl"), `${JSON.stringify(argv)}\n`);
appendFileSync(path.join(root, "env.jsonl"), `${JSON.stringify(Object.keys(process.env).filter((name) => name !== "FAKE_SANDBOX_ROOT"))}\n`);
const dirOf = (id) => path.join(root, "sandboxes", id);
const configOf = (id) => {
    try {
        return JSON.parse(readFileSync(path.join(dirOf(id), "config.json"), "utf8"));
    }
    catch {
        return null;
    }
};
function fail(message, code = 1) {
    console.error(`Error: ${message}`);
    process.exit(code);
}
/** Splits `[flags] -- command`; flags that take a value are listed. */
function parse(args, valued) {
    const flags = [];
    const values = {};
    let i = 0;
    for (; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--") {
            i++;
            break;
        }
        const [name, inline] = arg.split(/=(.*)/s, 2);
        if (valued.includes(name)) {
            const value = inline ?? args[++i] ?? "";
            (values[name] ??= []).push(value);
        }
        else if (arg.startsWith("-")) {
            flags.push(arg);
        }
        else {
            break;
        }
    }
    return { flags, values, command: args.slice(i) };
}
function bindOf(spec) {
    const fields = Object.fromEntries(spec.split(",").map((part) => {
        const [key, value] = part.split("=", 2);
        return [key, value ?? "true"];
    }));
    if (fields.type !== "bind" || !fields.source || !fields.destination) {
        fail(`unsupported mount ${spec}`);
    }
    return { source: fields.source, destination: fields.destination, readonly: "readonly" in fields };
}
/** Rewrites sandbox paths in one argument to where they are on this host. */
function translate(arg, config) {
    const maps = new Map([
        ...config.binds.map((b) => [b.destination, b.source]),
        ["/tmp", path.join(dirOf(config.id), "tmp")],
    ]);
    const escape = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // One pass, longest path first, so a rewritten path is never rewritten again
    // (on Linux the sources are under /tmp themselves).
    const alternatives = [...maps.keys()].sort((a, b) => b.length - a.length).map(escape).join("|");
    const pattern = new RegExp(`(^|[\\s'"=:(])(${alternatives})(?=/|$|[\\s'";)])`, "g");
    const out = arg.replace(pattern, (_, before, from) => `${before}${maps.get(from)}`);
    // Limits are not applied here: a sandbox's would land on this host's user.
    return out.replace(/(^|[\s;&|(])ulimit /g, "$1: ulimit ");
}
const [verb, id, ...rest] = argv;
if (verb === "run") {
    if (!id)
        fail("a sandbox id is required");
    if (configOf(id))
        fail(`sandbox ${id} already exists`);
    const { flags, values } = parse(rest, ["--mount", "-e", "--env", "-p", "--publish", "-w", "--workdir"]);
    const binds = (values["--mount"] ?? []).map(bindOf);
    for (const bind of binds) {
        if (!existsSync(bind.source))
            fail(`mount source ${bind.source} does not exist`);
    }
    mkdirSync(path.join(dirOf(id), "tmp"), { recursive: true });
    mkdirSync(path.join(dirOf(id), "pids"), { recursive: true });
    writeFileSync(path.join(dirOf(id), "config.json"), JSON.stringify({ id, binds, flags }));
    console.log("Running in detached mode: stdin, stdout and stderr arguments are ignored.");
    process.exit(0);
}
if (verb === "exec") {
    if (!id)
        fail("a sandbox id is required");
    const config = configOf(id);
    if (!config)
        fail(`sandbox ${id} is not running`);
    const { values, command } = parse(rest, ["-e", "--env", "-w", "--workdir"]);
    if (command.length === 0)
        fail("a command is required");
    const env = { HOME: "/root" };
    for (const pair of [...(values["-e"] ?? []), ...(values["--env"] ?? [])]) {
        const [name, value] = pair.split(/=(.*)/s, 2);
        env[name] = value ?? "";
    }
    const workdir = (values["--workdir"] ?? values["-w"])?.at(-1);
    const cwd = workdir ? translate(workdir, config) : "/";
    const [file, ...args] = command.map((arg) => translate(arg, config));
    // Its own process group, so a signal to this CLI does not reach the command.
    const child = spawn(file, args, {
        cwd: existsSync(cwd) ? cwd : "/",
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
    });
    const pidFile = path.join(dirOf(id), "pids", String(child.pid));
    writeFileSync(pidFile, "");
    process.stdin.pipe(child.stdin);
    child.stdin.on("error", () => { });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.on("error", (error) => fail(String(error)));
    child.on("close", (code) => {
        rmSync(pidFile, { force: true });
        if (!configOf(id))
            fail(`sandbox ${id} is not running`);
        // The real CLI loses a failing command's exit code the same way.
        if (code === 0)
            process.exit(0);
        dieOfSigpipe();
    });
}
else if (verb === "delete") {
    if (!id)
        fail("a sandbox id is required");
    const pids = path.join(dirOf(id), "pids");
    for (const pid of existsSync(pids) ? readdirSync(pids) : []) {
        try {
            process.kill(-Number(pid), "SIGKILL");
        }
        catch { }
    }
    rmSync(dirOf(id), { recursive: true, force: true });
    process.exit(0);
}
else if (verb !== "run") {
    fail(`unknown command ${verb ?? ""}`);
}
/** Node ignores SIGPIPE; removing a listener puts the default back, which ends the process. */
function dieOfSigpipe() {
    process.on("SIGPIPE", () => { });
    process.removeAllListeners("SIGPIPE");
    process.kill(process.pid, "SIGPIPE");
}
