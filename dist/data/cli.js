#!/usr/bin/env node
// `agent-data`: the agent's way to the project's data commands from bash in
// the sandbox. It calls the gateway's /data route with the run's token and
// prints the JSON answer; the commands are whatever the job registered.
//
//   agent-data --help                    lists the commands
//   agent-data <command> [--arg value]   runs one; `--flag` alone means true
//
//   AGENT_DATA_URL     the gateway; the runner sets it, else LLM_BASE_URL's origin
//   AGENT_DATA_TOKEN   the run token; the runner sets it, else LLM_API_KEY
/** `<command> --a 1 --b=x --flag` as the command and its arguments, all strings. */
export function parseArgv(argv) {
    const args = {};
    let command = null;
    for (let i = 0; i < argv.length; i++) {
        const word = argv[i];
        if (!word.startsWith("--")) {
            if (command !== null)
                throw new Error(`Unexpected "${word}"; arguments are --name value.`);
            command = word;
            continue;
        }
        const eq = word.indexOf("=");
        if (eq > 2) {
            args[word.slice(2, eq)] = word.slice(eq + 1);
            continue;
        }
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
            args[word.slice(2)] = "true";
        }
        else {
            args[word.slice(2)] = next;
            i++;
        }
    }
    return { command, args };
}
export function formatHelp(list) {
    if (list.commands.length === 0)
        return "No data commands are available in this run.";
    const lines = ["Usage: agent-data <command> [--arg value]", "", "Commands:"];
    for (const command of list.commands) {
        lines.push(`  ${command.name}  ${command.description}`);
        for (const arg of command.args) {
            const notes = [
                arg.type,
                arg.required ? "required" : null,
                arg.default !== undefined ? `default ${String(arg.default)}` : null,
            ].filter(Boolean);
            lines.push(`      --${arg.name} (${notes.join(", ")})${arg.description ? `  ${arg.description}` : ""}`);
        }
    }
    return lines.join("\n");
}
function endpoint(env) {
    let base = env.AGENT_DATA_URL;
    if (!base && env.LLM_BASE_URL)
        base = new URL(env.LLM_BASE_URL).origin;
    const token = env.AGENT_DATA_TOKEN ?? env.LLM_API_KEY;
    if (!base || !token)
        throw new Error("No data gateway in this environment (AGENT_DATA_URL, AGENT_DATA_TOKEN).");
    return { base: base.replace(/\/+$/, ""), token };
}
async function readJson(res) {
    const text = await res.text();
    try {
        return JSON.parse(text);
    }
    catch {
        return { error: text || res.statusText };
    }
}
/** One invocation; resolves with the exit code. */
export async function runCli(argv, io) {
    try {
        const { command, args } = parseArgv(argv);
        const { base, token } = endpoint(io.env);
        const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
        if (command === null || command === "help" || args.help !== undefined) {
            const res = await io.fetch(`${base}/data`, { headers });
            const body = await readJson(res);
            if (!res.ok)
                throw new Error(errorOf(body, res.status));
            io.out(formatHelp(body));
            return 0;
        }
        const res = await io.fetch(`${base}/data/${encodeURIComponent(command)}`, {
            method: "POST",
            headers,
            body: JSON.stringify(args),
        });
        const body = await readJson(res);
        if (!res.ok)
            throw new Error(errorOf(body, res.status));
        io.out(JSON.stringify(body, null, 2));
        return 0;
    }
    catch (error) {
        io.err(`agent-data: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
    }
}
function errorOf(body, status) {
    const error = body?.error;
    return typeof error === "string" ? error : `the gateway answered ${status}`;
}
if (import.meta.main) {
    process.exitCode = await runCli(process.argv.slice(2), {
        env: process.env,
        fetch,
        out: (text) => process.stdout.write(`${text}\n`),
        err: (text) => process.stderr.write(`${text}\n`),
    });
}
