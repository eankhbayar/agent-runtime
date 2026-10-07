// One `docker stats` reading per sandbox, for the resource samples the trace
// view draws against the run's limits.

import type { Usage } from "../../core/sandbox-provider.ts";

import { docker } from "./docker.ts";

// Docker reports memory in binary units; a sandbox's limit is set in MiB too,
// so MiB is taken as the unit of memoryMb and the rest scale to it.
const UNITS: Record<string, number> = {
  b: 1 / (1024 * 1024),
  kib: 1 / 1024,
  kb: 1 / 1024,
  mib: 1,
  mb: 1,
  gib: 1024,
  gb: 1024,
};

/** Parses one `docker stats --format '{{json .}}'` line. CPU comes back as cores. */
export function parseDockerStats(line: string): Usage | null {
  let row: { CPUPerc?: string; MemUsage?: string };
  try {
    row = JSON.parse(line) as typeof row;
  } catch {
    return null;
  }
  const percent = Number.parseFloat(row.CPUPerc ?? "");
  const memory = /^([\d.]+)\s*([a-z]+)/i.exec((row.MemUsage ?? "").trim());
  if (!Number.isFinite(percent) || !memory) return null;
  const scale = UNITS[memory[2]!.toLowerCase()];
  if (scale === undefined) return null;
  return { cpu: percent / 100, memoryMb: Number(memory[1]) * scale };
}

export async function sampleUsage(sandboxId: string): Promise<Usage | null> {
  try {
    const out = await docker(["stats", "--no-stream", "--format", "{{json .}}", sandboxId]);
    return parseDockerStats(out.trim().split("\n")[0] ?? "");
  } catch {
    // A paused, stopped or vanished sandbox simply has no sample.
    return null;
  }
}
