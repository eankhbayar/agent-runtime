// The data commands the job registered on the gateway, asked for once at the
// start of a run. When there are some, the runner lists them in the system
// prompt and points the `agent-data` CLI at the gateway; when the gateway has
// none (the Docker gateway, or a job that registered none) the run goes on
// without them.

import type { DataCommandList } from "../../data/commands.ts";

export type RunnerData = { list: DataCommandList; url: string; token: string };

function isCommandList(value: unknown): value is DataCommandList {
  const commands = (value as { commands?: unknown } | null)?.commands;
  return (
    Array.isArray(commands) &&
    commands.every(
      (c) =>
        typeof c?.name === "string" && typeof c?.description === "string" && Array.isArray(c?.args),
    )
  );
}

export async function loadDataCommands(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<RunnerData | null> {
  if (!env.LLM_BASE_URL || !env.LLM_API_KEY) return null;
  let url: string;
  try {
    url = new URL(env.LLM_BASE_URL).origin;
  } catch {
    return null;
  }
  try {
    const res = await fetchImpl(`${url}/data`, {
      headers: { authorization: `Bearer ${env.LLM_API_KEY}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const list: unknown = await res.json();
    if (!isCommandList(list) || list.commands.length === 0) return null;
    return { list, url, token: env.LLM_API_KEY };
  } catch {
    return null;
  }
}
