import { describe, expect, it } from "vitest";

import { FakeSandboxProvider } from "../pi/testing/fakes.ts";
import {
  ORPHAN_GRACE_MS,
  planReap,
  reapSandboxes,
  SANDBOX_TTL_MS,
  type ReapDeps,
  type SandboxRow,
} from "./sandbox-reaper.ts";
import type { SandboxInfo } from "./sandbox-provider.ts";

const NOW = Date.parse("2026-09-16T12:00:00Z");
const HOUR = 60 * 60_000;
const HOST = "fake-host";
const opts = { now: NOW, host: HOST };

const sandbox = (sandboxId: string, ageMs: number, status: SandboxInfo["status"] = "paused") => ({
  sandboxId,
  status,
  createdAt: NOW - ageMs,
});

const row = (sandboxId: string, idleMs: number, extra: Partial<SandboxRow> = {}): SandboxRow => ({
  sandboxId,
  provider: "docker",
  host: HOST,
  status: "paused",
  lastUsedAt: NOW - idleMs,
  runLive: false,
  ...extra,
});

describe("planReap", () => {
  it("keeps a thread's sandbox until its TTL, then expires it", () => {
    const plan = planReap(
      [sandbox("fresh", 30 * HOUR), sandbox("stale", 30 * HOUR)],
      [row("fresh", SANDBOX_TTL_MS - HOUR), row("stale", SANDBOX_TTL_MS + HOUR)],
      new Set(),
      opts,
    );
    expect(plan).toEqual({
      destroy: [{ sandboxId: "stale", reason: "expired" }],
      stop: [],
      gone: [],
    });
  });

  it("reaps a sandbox no row points at once it is past the grace period", () => {
    const plan = planReap(
      [
        sandbox("left-behind", ORPHAN_GRACE_MS + 1),
        sandbox("just-created", 60_000, "running"),
        // A network whose container was removed by hand still holds a subnet.
        sandbox("network-only", HOUR, "missing"),
      ],
      [],
      new Set(),
      opts,
    );
    expect(plan.destroy).toEqual([
      { sandboxId: "left-behind", reason: "orphaned" },
      { sandboxId: "network-only", reason: "orphaned" },
    ]);
  });

  it("treats a row already marked missing, or from another provider, as no row", () => {
    const plan = planReap(
      [sandbox("marked", HOUR), sandbox("elsewhere", HOUR)],
      [row("marked", 0, { status: "missing" }), row("elsewhere", 0, { provider: "e2b" })],
      new Set(),
      opts,
    );
    expect(plan.destroy.map((d) => d.reason)).toEqual(["orphaned", "orphaned"]);
  });

  it("reaps what is left of a sandbox whose container is gone, even with a fresh row", () => {
    const plan = planReap(
      [sandbox("no-container", HOUR, "missing")],
      [row("no-container", 0)],
      new Set(),
      opts,
    );
    expect(plan.destroy).toEqual([{ sandboxId: "no-container", reason: "orphaned" }]);
  });

  it("never touches a sandbox a run holds, here or on another dispatcher", () => {
    const plan = planReap(
      [
        sandbox("held-here", 48 * HOUR, "running"),
        sandbox("orphan-held-here", 48 * HOUR),
        sandbox("held-elsewhere", 48 * HOUR, "running"),
      ],
      [row("held-here", 48 * HOUR), row("held-elsewhere", 48 * HOUR, { runLive: true })],
      new Set(["held-here", "orphan-held-here"]),
      opts,
    );
    expect(plan).toEqual({ destroy: [], stop: [], gone: [] });
  });

  it("stops a sandbox left running with no run, and expires it once past the TTL", () => {
    const plan = planReap(
      [sandbox("stranded", 2 * HOUR, "running"), sandbox("abandoned", 30 * HOUR, "running")],
      [
        row("stranded", HOUR, { status: "running" }),
        row("abandoned", 25 * HOUR, { status: "running" }),
      ],
      new Set(),
      opts,
    );
    expect(plan.stop).toEqual(["stranded"]);
    expect(plan.destroy).toEqual([{ sandboxId: "abandoned", reason: "expired" }]);
  });

  it("marks rows gone only for sandboxes this host made", () => {
    const plan = planReap(
      [sandbox("present", HOUR)],
      [
        row("present", HOUR),
        row("vanished", HOUR),
        row("other-host", HOUR, { host: "another-daemon" }),
        // Written before hosts were recorded, so it could be anywhere.
        row("unknown-host", HOUR, { host: null }),
        row("in-flight", 0, { runLive: true }),
        row("held-here", 0),
        row("already-marked", HOUR, { status: "missing" }),
      ],
      new Set(["held-here"]),
      opts,
    );
    expect(plan.gone).toEqual(["vanished"]);
  });
});

function deps(
  provider: FakeSandboxProvider,
  rows: SandboxRow[],
  overrides: Partial<ReapDeps> = {},
) {
  const writes: { ids: string[]; status: string; destroyedSoFar: number }[] = [];
  const lines: string[] = [];
  const reapDeps: ReapDeps = {
    provider,
    rows: async () => rows,
    setStatus: async (ids, status) => {
      writes.push({ ids, status, destroyedSoFar: provider.destroyed.length });
    },
    inUse: () => new Set(),
    log: (m) => lines.push(m),
    ...overrides,
  };
  return { reapDeps, writes, lines };
}

describe("reapSandboxes", () => {
  it("marks rows missing, then destroys through the provider", async () => {
    const provider = new FakeSandboxProvider();
    provider.sandboxes = [
      sandbox("expired", 30 * HOUR),
      sandbox("orphan", HOUR),
      sandbox("kept", HOUR),
    ];
    const { reapDeps, writes } = deps(provider, [row("expired", 25 * HOUR), row("kept", HOUR)]);
    const report = await reapSandboxes(reapDeps, opts);

    expect(report.destroyed).toEqual([
      { sandboxId: "expired", reason: "expired" },
      { sandboxId: "orphan", reason: "orphaned" },
    ]);
    expect(writes).toEqual([{ ids: ["expired", "orphan"], status: "missing", destroyedSoFar: 0 }]);
    expect(provider.destroyed).toEqual(["expired", "orphan"]);
    expect((await provider.list()).map((s) => s.sandboxId)).toEqual(["kept"]);
  });

  it("stops a stranded sandbox's commands, pauses it and records it paused", async () => {
    const provider = new FakeSandboxProvider();
    provider.sandboxes = [sandbox("stranded", HOUR, "running")];
    const { reapDeps, writes } = deps(provider, [row("stranded", HOUR, { status: "running" })]);
    const report = await reapSandboxes(reapDeps, opts);

    expect(report.stopped).toEqual(["stranded"]);
    expect(provider.calls).toEqual(["stop stranded", "pause"]);
    expect((await provider.list())[0]?.status).toBe("paused");
    expect(writes).toEqual([{ ids: ["stranded"], status: "paused", destroyedSoFar: 0 }]);
    expect(provider.destroyed).toEqual([]);
  });

  it("marks a row missing when its sandbox is already gone from this host", async () => {
    const provider = new FakeSandboxProvider();
    const { reapDeps, writes } = deps(provider, [row("vanished", HOUR)]);
    const report = await reapSandboxes(reapDeps, opts);
    expect(report.gone).toEqual(["vanished"]);
    expect(writes).toEqual([{ ids: ["vanished"], status: "missing", destroyedSoFar: 0 }]);
  });

  it("reads the rows before listing the sandboxes", async () => {
    const provider = new FakeSandboxProvider();
    const order: string[] = [];
    const list = provider.list.bind(provider);
    provider.list = async () => {
      order.push("list");
      return list();
    };
    const { reapDeps } = deps(provider, [], {
      rows: async () => {
        order.push("rows");
        return [];
      },
    });
    await reapSandboxes(reapDeps, opts);
    expect(order).toEqual(["rows", "list"]);
  });

  it("skips a sandbox a run picked up while the lists were read", async () => {
    const provider = new FakeSandboxProvider();
    provider.sandboxes = [sandbox("a", HOUR), sandbox("b", HOUR), sandbox("c", HOUR, "running")];
    const inUse = new Set<string>();
    const { reapDeps } = deps(provider, [row("c", HOUR)], {
      setStatus: async () => {
        inUse.add("a");
        inUse.add("c");
      },
      inUse: () => inUse,
    });
    const report = await reapSandboxes(reapDeps, opts);
    expect(report.destroyed.map((d) => d.sandboxId)).toEqual(["b"]);
    expect(report.stopped).toEqual([]);
    expect(provider.destroyed).toEqual(["b"]);
  });

  it("does nothing, not even a write, when there is nothing to reap", async () => {
    const provider = new FakeSandboxProvider();
    provider.sandboxes = [sandbox("kept", HOUR)];
    const { reapDeps, writes } = deps(provider, [row("kept", HOUR)]);
    await reapSandboxes(reapDeps, opts);
    expect(writes).toEqual([]);
  });

  it("logs a destroy or stop that fails and carries on", async () => {
    const provider = new FakeSandboxProvider();
    provider.sandboxes = [
      sandbox("stuck", HOUR),
      sandbox("fine", HOUR),
      sandbox("frozen", HOUR, "running"),
    ];
    const destroy = provider.destroy.bind(provider);
    provider.destroy = async (id: string) => {
      if (id === "stuck") throw new Error("device busy");
      await destroy(id);
    };
    provider.stopCommands = async () => {
      throw new Error("restart timed out");
    };
    const { reapDeps, writes, lines } = deps(provider, [row("frozen", HOUR)]);
    const report = await reapSandboxes(reapDeps, opts);
    expect(report.destroyed.map((d) => d.sandboxId)).toEqual(["fine"]);
    expect(report.stopped).toEqual([]);
    // Nothing is recorded paused that was not stopped.
    expect(writes.map((w) => w.status)).toEqual(["missing"]);
    expect(lines).toEqual([
      expect.stringContaining("could not destroy orphaned sandbox stuck"),
      expect.stringContaining("could not stop stranded sandbox frozen"),
    ]);
  });
});
