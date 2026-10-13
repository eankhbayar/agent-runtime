// The gateway's /data route for a project's data commands: arguments checked
// against the definitions, then the project's handler called with the run the
// token belongs to. Calls are capped per run, timed out and size-limited, so
// an agent in a loop cannot hammer the deployment or flood its own context.
import { describeDataCommands, parseDataArgs, } from "./commands.js";
/** A refusal the agent sees as the CLI's error, with the HTTP status sent. */
export class DataCommandError extends Error {
    status;
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}
const fail = (status, error) => ({ status, body: { error } });
export function createDataRoutes(opts) {
    const maxCalls = opts.maxCallsPerRun ?? 50;
    const timeoutMs = opts.timeoutMs ?? 20_000;
    const maxChars = opts.maxResultChars ?? 256 * 1024;
    const log = opts.log ?? (() => { });
    const list = describeDataCommands(opts.commands);
    const calls = new Map();
    return {
        list: () => list,
        async call(command, input, grant) {
            const started = Date.now();
            const done = (reply, extra = {}) => {
                log({ runId: grant.runId, command, status: reply.status, ms: Date.now() - started, ...extra });
                return reply;
            };
            const spec = Object.hasOwn(opts.commands, command) ? opts.commands[command] : undefined;
            if (!spec)
                return done(fail(404, `No data command "${command}". Run agent-data --help.`));
            const count = (calls.get(grant.runId) ?? 0) + 1;
            calls.set(grant.runId, count);
            if (count > maxCalls) {
                return done(fail(429, `This run has used its ${maxCalls} data calls.`));
            }
            const parsed = parseDataArgs(spec, input);
            if (!parsed.ok)
                return done(fail(400, parsed.error));
            let timer;
            const timeout = new Promise((_, reject) => {
                timer = setTimeout(() => reject(new DataCommandError(`${command} took longer than ${timeoutMs / 1000} s.`, 504)), timeoutMs);
            });
            try {
                const result = await Promise.race([opts.handle(command, parsed.args, grant), timeout]);
                const json = JSON.stringify(result ?? null);
                if (json.length > maxChars) {
                    return done(fail(413, `${command} returned more than ${maxChars} characters; ask for less.`), { chars: json.length });
                }
                return done({ status: 200, body: result ?? null }, { chars: json.length });
            }
            catch (error) {
                if (error instanceof DataCommandError)
                    return done(fail(error.status, error.message));
                return done(fail(502, `${command} failed.`), { error: String(error) });
            }
            finally {
                clearTimeout(timer);
            }
        },
    };
}
