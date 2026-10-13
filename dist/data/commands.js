// Data commands: the reads a project lets its agent make from the sandbox,
// declared once. The job serves them on the gateway's /data route
// (routes.ts), the `agent-data` CLI in the sandbox calls them (cli.ts), and
// the runner lists them in the agent's system prompt. Each call carries the
// run's token, so the project's handler knows which run is asking and answers
// for that run alone.
//
// Node-free, like ./models: a Convex function can import it to share a
// project's definitions.
const NAME = /^[a-z][a-z0-9-]{0,47}$/;
/** Checks a project's definitions once, where it declares them. */
export function defineDataCommands(commands) {
    for (const [name, spec] of Object.entries(commands)) {
        if (!NAME.test(name))
            throw new Error(`Data command "${name}" must be lower-case kebab-case`);
        if (!spec.description)
            throw new Error(`Data command "${name}" needs a description`);
        for (const [arg, argSpec] of Object.entries(spec.args ?? {})) {
            if (!NAME.test(arg))
                throw new Error(`${name}: argument "${arg}" must be lower-case kebab-case`);
            if (argSpec.default !== undefined && typeof argSpec.default !== argSpec.type) {
                throw new Error(`${name}: the default for "${arg}" is not a ${argSpec.type}`);
            }
        }
    }
    return commands;
}
export function describeDataCommands(commands) {
    return {
        commands: Object.entries(commands).map(([name, spec]) => ({
            name,
            description: spec.description,
            args: Object.entries(spec.args ?? {}).map(([arg, argSpec]) => ({ name: arg, ...argSpec })),
        })),
    };
}
function coerce(spec, value) {
    // The CLI sends every flag as a string, so strings are read as the declared type.
    if (spec.type === "string")
        return typeof value === "string" ? value : undefined;
    if (spec.type === "number") {
        const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
        return typeof n === "number" && Number.isFinite(n) ? n : undefined;
    }
    if (typeof value === "boolean")
        return value;
    if (value === "true")
        return true;
    if (value === "false")
        return false;
    return undefined;
}
/**
 * Validates one call's arguments against its command: unknown or mistyped
 * arguments are refused, missing ones take their default.
 */
export function parseDataArgs(spec, input) {
    if (input === undefined || input === null)
        input = {};
    if (typeof input !== "object" || Array.isArray(input)) {
        return { ok: false, error: "Arguments must be an object." };
    }
    const given = input;
    const specs = spec.args ?? {};
    for (const name of Object.keys(given)) {
        if (!Object.hasOwn(specs, name))
            return { ok: false, error: `Unknown argument --${name}.` };
    }
    const args = {};
    for (const [name, argSpec] of Object.entries(specs)) {
        if (given[name] === undefined) {
            if (argSpec.default !== undefined)
                args[name] = argSpec.default;
            else if (argSpec.required)
                return { ok: false, error: `--${name} is required.` };
            continue;
        }
        const value = coerce(argSpec, given[name]);
        if (value === undefined)
            return { ok: false, error: `--${name} must be a ${argSpec.type}.` };
        args[name] = value;
    }
    return { ok: true, args };
}
/** The system prompt's section on the commands; empty when there are none. */
export function dataPromptSection(list) {
    if (list.commands.length === 0)
        return "";
    const lines = [
        "## Live data",
        "",
        "Besides your files, you can read live data for this conversation with the `agent-data` CLI in bash. " +
            "It prints JSON. Run `agent-data --help` to see the commands again.",
        "",
    ];
    for (const command of list.commands) {
        const usage = command.args
            .map((arg) => {
            const flag = arg.type === "boolean" ? `--${arg.name}` : `--${arg.name} <${arg.type}>`;
            return arg.required ? flag : `[${flag}]`;
        })
            .join(" ");
        lines.push(`- \`agent-data ${command.name}${usage ? ` ${usage}` : ""}\`: ${command.description}`);
        for (const arg of command.args) {
            if (!arg.description)
                continue;
            const fallback = arg.default !== undefined ? ` (default ${String(arg.default)})` : "";
            lines.push(`  - \`--${arg.name}\`: ${arg.description}${fallback}`);
        }
    }
    return lines.join("\n");
}
