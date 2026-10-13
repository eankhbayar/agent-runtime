// The gateway's /data route for a project's data commands: arguments checked
// against the definitions, then the project's handler called with the run the
// token belongs to. Calls are capped per run, timed out and size-limited, so
// an agent in a loop cannot hammer the deployment or flood its own context.

import {
  describeDataCommands,
  parseDataArgs,
  type DataArgs,
  type DataCommandList,
  type DataCommands,
} from "./commands.ts";

/** The run a call comes from; the gateway's grant for the token. */
export type DataGrant = { runId: string };

/** A refusal the agent sees as the CLI's error, with the HTTP status sent. */
export class DataCommandError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export type DataReply = { status: number; body: unknown };

/** What the gateway's `data` option takes. */
export type GatewayDataRoutes = {
  list: () => DataCommandList;
  call: (command: string, args: unknown, grant: DataGrant) => Promise<DataReply>;
};

export type DataRoutesOptions<T extends DataCommands> = {
  commands: T;
  /**
   * Answers one call. Whatever it returns is sent back as JSON; a
   * DataCommandError is sent as that error, and anything else thrown as a
   * generic failure, with the error logged and not shown to the agent.
   */
  handle: (command: keyof T & string, args: DataArgs, grant: DataGrant) => Promise<unknown>;
  /** Default 50 calls per run. */
  maxCallsPerRun?: number;
  /** Default 20 s. */
  timeoutMs?: number;
  /** The largest JSON result sent back, in characters. Default 256 KiB. */
  maxResultChars?: number;
  /** One entry per call. */
  log?: (entry: Record<string, unknown>) => void;
};

const fail = (status: number, error: string): DataReply => ({ status, body: { error } });

export function createDataRoutes<T extends DataCommands>(opts: DataRoutesOptions<T>): GatewayDataRoutes {
  const maxCalls = opts.maxCallsPerRun ?? 50;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxChars = opts.maxResultChars ?? 256 * 1024;
  const log = opts.log ?? (() => {});
  const list = describeDataCommands(opts.commands);
  const calls = new Map<string, number>();

  return {
    list: () => list,

    async call(command, input, grant) {
      const started = Date.now();
      const done = (reply: DataReply, extra: Record<string, unknown> = {}): DataReply => {
        log({ runId: grant.runId, command, status: reply.status, ms: Date.now() - started, ...extra });
        return reply;
      };
      const spec = Object.hasOwn(opts.commands, command) ? opts.commands[command] : undefined;
      if (!spec) return done(fail(404, `No data command "${command}". Run agent-data --help.`));
      const count = (calls.get(grant.runId) ?? 0) + 1;
      calls.set(grant.runId, count);
      if (count > maxCalls) {
        return done(fail(429, `This run has used its ${maxCalls} data calls.`));
      }
      const parsed = parseDataArgs(spec, input);
      if (!parsed.ok) return done(fail(400, parsed.error));

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new DataCommandError(`${command} took longer than ${timeoutMs / 1000} s.`, 504)),
          timeoutMs,
        );
      });
      try {
        const result = await Promise.race([opts.handle(command, parsed.args, grant), timeout]);
        const json = JSON.stringify(result ?? null);
        if (json.length > maxChars) {
          return done(
            fail(413, `${command} returned more than ${maxChars} characters; ask for less.`),
            { chars: json.length },
          );
        }
        return done({ status: 200, body: result ?? null }, { chars: json.length });
      } catch (error) {
        if (error instanceof DataCommandError) return done(fail(error.status, error.message));
        return done(fail(502, `${command} failed.`), { error: String(error) });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
