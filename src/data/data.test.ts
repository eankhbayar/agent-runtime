import { readdir, readFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { createInProcessGateway, type InProcessGateway } from "../core/gateway.ts";
import { loadDataCommands } from "../pi/runner/data.ts";
import { formatHelp, parseArgv, runCli } from "./cli.ts";
import {
  dataPromptSection,
  defineDataCommands,
  describeDataCommands,
  parseDataArgs,
} from "./commands.ts";
import { createDataRoutes, DataCommandError } from "./routes.ts";

const commands = defineDataCommands({
  "thread-history": {
    description: "Earlier questions and answers in this thread",
    args: {
      limit: { type: "number", default: 10, description: "How many turns" },
      full: { type: "boolean" },
    },
  },
  race: {
    description: "One race card",
    args: { date: { type: "string", required: true } },
  },
});

describe("defineDataCommands", () => {
  it("refuses names the CLI cannot call and defaults of the wrong type", () => {
    expect(() => defineDataCommands({ Bad_Name: { description: "x" } })).toThrow(/kebab-case/);
    expect(() => defineDataCommands({ ok: { description: "" } })).toThrow(/description/);
    expect(() =>
      defineDataCommands({ ok: { description: "x", args: { n: { type: "number", default: "1" } } } }),
    ).toThrow(/default/);
  });
});

describe("parseDataArgs", () => {
  const spec = commands["thread-history"];

  it("fills defaults and reads the CLI's strings as the declared types", () => {
    expect(parseDataArgs(spec, {})).toEqual({ ok: true, args: { limit: 10 } });
    expect(parseDataArgs(spec, { limit: "3", full: "true" })).toEqual({
      ok: true,
      args: { limit: 3, full: true },
    });
  });

  it("refuses unknown, mistyped and missing arguments", () => {
    expect(parseDataArgs(spec, { since: "x" })).toEqual({ ok: false, error: "Unknown argument --since." });
    expect(parseDataArgs(spec, { limit: "many" })).toEqual({ ok: false, error: "--limit must be a number." });
    expect(parseDataArgs(spec, { limit: "" })).toMatchObject({ ok: false });
    expect(parseDataArgs(spec, [])).toMatchObject({ ok: false });
    expect(parseDataArgs(commands.race, {})).toEqual({ ok: false, error: "--date is required." });
    // An inherited name is not an argument.
    expect(parseDataArgs(spec, { constructor: "x" })).toMatchObject({ ok: false });
  });
});

describe("dataPromptSection", () => {
  it("shows each command's usage and its arguments", () => {
    const section = dataPromptSection(describeDataCommands(commands));
    expect(section).toContain("`agent-data thread-history [--limit <number>] [--full]`");
    expect(section).toContain("`--limit`: How many turns (default 10)");
    expect(section).toContain("`agent-data race --date <string>`");
  });

  it("is empty with no commands", () => {
    expect(dataPromptSection({ commands: [] })).toBe("");
  });
});

describe("createDataRoutes", () => {
  const grant = { runId: "run_1" };

  it("calls the handler with checked arguments and the run", async () => {
    const seen: unknown[] = [];
    const routes = createDataRoutes({
      commands,
      handle: async (command, args, g) => {
        seen.push([command, args, g.runId]);
        return { turns: [] };
      },
    });
    expect(await routes.call("thread-history", { limit: "2" }, grant)).toEqual({
      status: 200,
      body: { turns: [] },
    });
    expect(seen).toEqual([["thread-history", { limit: 2 }, "run_1"]]);
    expect((await routes.call("nope", {}, grant)).status).toBe(404);
    expect((await routes.call("race", {}, grant)).status).toBe(400);
  });

  it("caps calls per run, times out, and refuses oversized results", async () => {
    const routes = createDataRoutes({
      commands,
      maxCallsPerRun: 2,
      timeoutMs: 20,
      maxResultChars: 50,
      handle: async (command) => {
        if (command === "race") return new Promise(() => {});
        return { text: "x".repeat(100) };
      },
    });
    expect((await routes.call("race", { date: "d" }, grant)).status).toBe(504);
    expect((await routes.call("thread-history", {}, grant)).status).toBe(413);
    expect(await routes.call("thread-history", {}, grant)).toEqual({
      status: 429,
      body: { error: "This run has used its 2 data calls." },
    });
    // Another run has its own allowance.
    expect((await routes.call("thread-history", {}, { runId: "run_2" })).status).toBe(413);
  });

  it("shows a DataCommandError and hides any other failure", async () => {
    const logged: Record<string, unknown>[] = [];
    const routes = createDataRoutes({
      commands,
      log: (entry) => logged.push(entry),
      handle: async (command) => {
        if (command === "race") throw new DataCommandError("No races that day.", 404);
        throw new Error("secret connection string");
      },
    });
    expect(await routes.call("race", { date: "d" }, grant)).toEqual({
      status: 404,
      body: { error: "No races that day." },
    });
    const failed = await routes.call("thread-history", {}, grant);
    expect(failed).toEqual({ status: 502, body: { error: "thread-history failed." } });
    expect(logged.at(-1)).toMatchObject({ runId: "run_1", status: 502 });
  });
});

describe("parseArgv", () => {
  it("reads a command and its flags", () => {
    expect(parseArgv(["thread-history", "--limit", "3", "--full", "--x=a b"])).toEqual({
      command: "thread-history",
      args: { limit: "3", full: "true", x: "a b" },
    });
    expect(parseArgv([])).toEqual({ command: null, args: {} });
    expect(() => parseArgv(["a", "b"])).toThrow(/Unexpected/);
  });
});

describe("the gateway's /data route, through the CLI", () => {
  let gateway: InProcessGateway | undefined;
  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
  });

  async function start(withData = true) {
    gateway = createInProcessGateway({
      format: "openai",
      baseUrl: "http://upstream.invalid/v1",
      apiKey: "provider-key",
      log: () => {},
      ...(withData
        ? {
            data: createDataRoutes({
              commands,
              handle: async (command, args, grant) => ({ command, args, runId: grant.runId }),
            }),
          }
        : {}),
    });
    const url = await gateway.listen();
    const token = await gateway.grant("run_7", 60_000);
    return { url, token };
  }

  function cli(argv: string[], env: NodeJS.ProcessEnv) {
    const out: string[] = [];
    const err: string[] = [];
    return runCli(argv, { env, fetch, out: (t) => out.push(t), err: (t) => err.push(t) }).then(
      (code) => ({ code, out: out.join("\n"), err: err.join("\n") }),
    );
  }

  it("runs a command for the token's run and lists the commands", async () => {
    const { url, token } = await start();
    const env = { LLM_BASE_URL: `${url}/v1`, LLM_API_KEY: token };
    const ran = await cli(["thread-history", "--limit", "4"], env);
    expect(ran.code).toBe(0);
    expect(JSON.parse(ran.out)).toEqual({ command: "thread-history", args: { limit: 4 }, runId: "run_7" });

    const help = await cli(["--help"], { AGENT_DATA_URL: url, AGENT_DATA_TOKEN: token });
    expect(help.out).toBe(formatHelp(describeDataCommands(commands)));
    expect(help.out).toContain("--date (string, required)");
  });

  it("says what went wrong on a bad call, a bad token, or no data commands", async () => {
    const { url, token } = await start();
    const missing = await cli(["race"], { AGENT_DATA_URL: url, AGENT_DATA_TOKEN: token });
    expect(missing).toMatchObject({ code: 1, err: "agent-data: --date is required." });

    const revoked = await cli(["race", "--date", "d"], {
      AGENT_DATA_URL: url,
      AGENT_DATA_TOKEN: `rt_${"x".repeat(40)}`,
    });
    expect(revoked).toMatchObject({ code: 1, err: "agent-data: invalid_run_token" });

    const none = await cli([], {});
    expect(none.err).toMatch(/No data gateway/);
  });

  it("is not found on a gateway without data commands", async () => {
    const { url, token } = await start(false);
    const res = await fetch(`${url}/data`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(404);
    expect(await loadDataCommands({ LLM_BASE_URL: `${url}/v1`, LLM_API_KEY: token })).toBeNull();
  });

  it("refuses an oversized or malformed body", async () => {
    const { url, token } = await start();
    const headers = { authorization: `Bearer ${token}` };
    const big = await fetch(`${url}/data/race`, {
      method: "POST",
      headers,
      body: JSON.stringify({ date: "x".repeat(70_000) }),
    });
    expect(big.status).toBe(413);
    const bad = await fetch(`${url}/data/race`, { method: "POST", headers, body: "{" });
    expect(bad.status).toBe(400);
    const path = await fetch(`${url}/data/race/../x`, { method: "POST", headers, body: "{}" });
    expect(path.status).toBe(404);
  });

  it("gives the runner the commands, the gateway URL and the token", async () => {
    const { url, token } = await start();
    const loaded = await loadDataCommands({ LLM_BASE_URL: `${url}/v1`, LLM_API_KEY: token });
    expect(loaded).toEqual({ list: describeDataCommands(commands), url, token });
    expect(await loadDataCommands({ LLM_BASE_URL: `${url}/v1` })).toBeNull();
    expect(await loadDataCommands({ LLM_BASE_URL: "http://127.0.0.1:1", LLM_API_KEY: token })).toBeNull();
  });
});

// Convex can import the definitions to share them, so they stay off Node.
describe("the data module's shared files", () => {
  it("import nothing but each other", async () => {
    const dir = new URL(".", import.meta.url);
    const shared = (await readdir(dir)).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "cli.ts",
    );
    expect(shared.sort()).toEqual(["commands.ts", "index.ts", "routes.ts"]);
    for (const file of shared) {
      const text = await readFile(new URL(file, dir), "utf8");
      for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
        expect(m[1], `${file} imports ${m[1]}`).toMatch(/^\.\/[^/]+\.ts$/);
      }
    }
  });
});
