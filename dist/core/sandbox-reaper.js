// Bounds the sandboxes the dispatcher keeps. A run pauses its sandbox so the
// thread's next question resumes the same agent session; this destroys the ones
// no question will come back to, stops the ones a dead dispatcher left running,
// and corrects rows whose sandbox is gone.
//
// It walks the provider's sandboxes, not only the deployment's `sandboxes` rows.
// A thread has one row, replaced whenever the thread moves to a new sandbox, so
// the sandbox it left has no row at all and only the provider still knows it.
/** How long a thread's sandbox is kept after its last run. */
export const SANDBOX_TTL_MS = 24 * 60 * 60_000;
/**
 * How old a sandbox with no row must be before it counts as orphaned. A run
 * writes its row once its mounts are uploaded; this covers that gap for runs
 * on another dispatcher sharing the same Docker host, which `inUse` cannot see.
 */
export const ORPHAN_GRACE_MS = 10 * 60_000;
/** What to do with each sandbox and row. Pure, so the rules can be tested alone. */
export function planReap(sandboxes, rows, inUse, opts) {
    const ttlMs = opts.ttlMs ?? SANDBOX_TTL_MS;
    const graceMs = opts.orphanGraceMs ?? ORPHAN_GRACE_MS;
    const providerName = opts.providerName ?? "docker";
    const ours = rows.filter((row) => row.provider === providerName && row.status !== "missing");
    const rowFor = new Map(ours.map((row) => [row.sandboxId, row]));
    const plan = { destroy: [], stop: [], gone: [] };
    for (const sandbox of sandboxes) {
        if (inUse.has(sandbox.sandboxId))
            continue;
        // Leftovers of a sandbox whose container is gone cannot be resumed either,
        // whatever its row still says.
        const row = sandbox.status === "missing" ? undefined : rowFor.get(sandbox.sandboxId);
        if (row) {
            // A run elsewhere may be using it; nothing here can tell otherwise.
            if (row.runLive)
                continue;
            // A thread's sandbox, kept for its next question until the TTL runs out.
            if (opts.now - row.lastUsedAt > ttlMs) {
                plan.destroy.push({ sandboxId: sandbox.sandboxId, reason: "expired" });
            }
            else if (sandbox.status === "running") {
                plan.stop.push(sandbox.sandboxId);
            }
            continue;
        }
        // Nothing can resume a sandbox no row points at. One whose creation time
        // could not be read never passes the grace period, so it is left alone.
        if (opts.now - sandbox.createdAt > graceMs) {
            plan.destroy.push({ sandboxId: sandbox.sandboxId, reason: "orphaned" });
        }
    }
    // A row is only judged against the host it was made on: a sandbox on another
    // Docker host is absent from this list without being gone. The rows were read
    // before the list, so a sandbox created in between cannot be mistaken for gone.
    const listed = new Set(sandboxes.map((s) => s.sandboxId));
    for (const row of ours) {
        if (row.host !== opts.host || row.runLive)
            continue;
        if (listed.has(row.sandboxId) || inUse.has(row.sandboxId))
            continue;
        plan.gone.push(row.sandboxId);
    }
    return plan;
}
/** One pass: destroys, stops and corrects as `planReap` decides, and reports what it did. */
export async function reapSandboxes(deps, opts) {
    // Rows before the list: see the comment on `gone` in planReap.
    const rows = await deps.rows();
    const sandboxes = await deps.provider.list();
    const plan = planReap(sandboxes, rows, deps.inUse(), opts);
    const report = { destroyed: [], stopped: [], gone: plan.gone };
    if (plan.gone.length > 0)
        await deps.setStatus(plan.gone, "missing");
    if (plan.destroy.length > 0) {
        // Rows first: once a row reads missing, a newly queued run will not be handed
        // the sandbox. If a destroy then fails, the next pass finds it again as an orphan.
        await deps.setStatus(plan.destroy.map((d) => d.sandboxId), "missing");
        for (const decision of plan.destroy) {
            // A run may have claimed it while the lists were being read.
            if (deps.inUse().has(decision.sandboxId))
                continue;
            try {
                await deps.provider.destroy(decision.sandboxId);
                report.destroyed.push(decision);
            }
            catch (cause) {
                deps.log(`could not destroy ${decision.reason} sandbox ${decision.sandboxId}: ${String(cause)}`);
            }
        }
    }
    for (const sandboxId of plan.stop) {
        if (deps.inUse().has(sandboxId))
            continue;
        try {
            await deps.provider.stopCommands(sandboxId);
            await deps.provider.pause(sandboxId);
            report.stopped.push(sandboxId);
        }
        catch (cause) {
            deps.log(`could not stop stranded sandbox ${sandboxId}: ${String(cause)}`);
        }
    }
    if (report.stopped.length > 0)
        await deps.setStatus(report.stopped, "paused");
    return report;
}
