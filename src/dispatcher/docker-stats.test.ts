import { describe, expect, it } from "vitest";

import { parseDockerStats } from "./docker-stats.ts";

describe("parseDockerStats", () => {
  it("reads CPU as cores in use and memory in MiB", () => {
    expect(
      parseDockerStats('{"CPUPerc":"148.35%","MemUsage":"412.3MiB / 1.5GiB","PIDs":"31"}'),
    ).toEqual({ cpu: 1.4835, memoryMb: 412.3 });
    expect(parseDockerStats('{"CPUPerc":"0.00%","MemUsage":"1.5GiB / 1.5GiB"}')).toEqual({
      cpu: 0,
      memoryMb: 1536,
    });
  });

  it("has no sample for a line it cannot read", () => {
    expect(parseDockerStats("")).toBeNull();
    expect(parseDockerStats('{"CPUPerc":"--","MemUsage":"-- / --"}')).toBeNull();
  });
});
