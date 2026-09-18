// SandboxProvider over the docker CLI: one container per sandbox on whatever
// the current docker context points at (a Colima VM, a remote host). Sandboxes
// share that host's kernel with each other.
//
// Each sandbox gets its own internal Docker network (no route out of it). The
// only other member is the egress gateway container, reachable as `gateway`.
// The container runs as the image's non-root user with every capability dropped.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { docker, DockerError } from "./docker.js";
/**
 * Reads a `{{json .Created}}` time. The plain template prints networks' times in
 * Go's layout ("2026-09-16 14:31:47.83 +0800 HKT"), which Date.parse cannot read.
 */
function createdAt(json) {
    try {
        return Date.parse(JSON.parse(json));
    }
    catch {
        return Number.NaN;
    }
}
function statusOf(state) {
    return state === "running" || state === "paused" ? state : "stopped";
}
/**
 * Inspects several objects at once. One that disappeared since it was listed
 * fails the whole call, so fall back to one at a time and skip the missing.
 */
async function inspectEach(kind, ids, format) {
    const inspect = (batch) => docker([kind, "inspect", "--format", format, ...batch]);
    if (ids.length === 0)
        return [];
    try {
        return (await inspect(ids)).split("\n").filter(Boolean);
    }
    catch (error) {
        if (!(error instanceof DockerError))
            throw error;
        const lines = [];
        for (const id of ids) {
            lines.push(...(await inspect([id]).catch(() => "")).split("\n").filter(Boolean));
        }
        return lines;
    }
}
export class DockerSandboxProvider {
    opts;
    constructor(opts) {
        this.opts = opts;
    }
    async create({ image, limits, labels = {}, }) {
        const id = `${this.opts.namespace}-sbx-${randomBytes(6).toString("hex")}`;
        const labelArgs = Object.entries({
            [`${this.opts.namespace}.sandbox`]: "1",
            ...labels,
        }).flatMap(([k, v]) => [
            "--label",
            `${k}=${v}`,
        ]);
        // Isolated gateway mode gives the bridge no address in the VM, so the sandbox
        // cannot reach the VM itself (sshd, published ports of other containers).
        await docker([
            "network",
            "create",
            "--internal",
            "--opt",
            "com.docker.network.bridge.gateway_mode_ipv4=isolated",
            ...labelArgs,
            id,
        ]);
        try {
            await docker([
                "network",
                "connect",
                "--alias",
                this.opts.gatewayAlias,
                id,
                this.opts.gatewayContainer,
            ]);
            await docker([
                "run",
                "--detach",
                "--init",
                "--name",
                id,
                "--hostname",
                "sandbox",
                "--network",
                id,
                ...labelArgs,
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--cpus",
                String(limits.cpus),
                "--memory",
                `${limits.memoryMb}m`,
                "--memory-swap",
                `${limits.memoryMb}m`,
                "--pids-limit",
                String(limits.pids),
                image,
                "sleep",
                "infinity",
            ]);
        }
        catch (error) {
            await this.destroy(id);
            throw error;
        }
        return id;
    }
    async upload(sandboxId, localDir, remoteDir) {
        // docker cp writes as root, so the image's non-root user can read but not change the files.
        await docker(["cp", `${localDir}/.`, `${sandboxId}:${remoteDir}`]);
    }
    async download(sandboxId, remotePath, localPath) {
        await docker(["cp", `${sandboxId}:${remotePath}`, localPath]);
    }
    exec(sandboxId, command, opts = {}) {
        const env = opts.env ?? {};
        const pidFile = `/tmp/exec-${randomBytes(6).toString("hex")}.pid`;
        const timed = opts.timeoutMs
            ? ["timeout", "--kill-after=10", `${Math.ceil(opts.timeoutMs / 1000)}`, ...command]
            : command;
        // Values stay out of argv: `-e NAME` makes docker read them from its own env.
        const args = [
            "exec",
            ...Object.keys(env).flatMap((name) => ["-e", name]),
            sandboxId,
            "sh",
            "-c",
            `echo $$ > ${pidFile}; exec "$@"`,
            "sh",
            ...timed,
        ];
        const child = spawn("docker", args, {
            env: { ...process.env, ...env },
            stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout.setEncoding("utf8").on("data", (d) => opts.onStdout?.(d));
        child.stderr.setEncoding("utf8").on("data", (d) => opts.onStderr?.(d));
        const done = new Promise((resolve, reject) => {
            child.on("error", reject);
            child.on("close", (code) => resolve(code ?? -1));
        });
        return {
            done,
            // Killing the local docker CLI would leave the process running in the sandbox.
            kill: async () => {
                await docker(["exec", sandboxId, "sh", "-c", `kill -TERM "$(cat ${pidFile})"`]).catch(() => { });
            },
        };
    }
    async pause(sandboxId) {
        await docker(["pause", sandboxId]);
    }
    async resume(sandboxId) {
        const status = await this.status(sandboxId);
        if (status === "paused")
            await docker(["unpause", sandboxId]);
        else if (status === "stopped")
            await docker(["start", sandboxId]);
        else if (status === "missing")
            throw new Error(`Sandbox ${sandboxId} does not exist`);
    }
    // A restart ends every docker exec in the container and brings back only its
    // `sleep infinity`; the filesystem, its mounts and the pi session stay.
    async stopCommands(sandboxId) {
        await docker(["restart", "--time", "5", sandboxId]);
    }
    async destroy(sandboxId) {
        const ignoreMissing = (error) => {
            if (!(error instanceof DockerError))
                throw error;
        };
        await docker(["rm", "--force", "--volumes", sandboxId]).catch(ignoreMissing);
        await docker(["network", "disconnect", "--force", sandboxId, this.opts.gatewayContainer]).catch(ignoreMissing);
        await docker(["network", "rm", sandboxId]).catch(ignoreMissing);
    }
    async status(sandboxId) {
        try {
            return statusOf((await docker(["inspect", "--format", "{{.State.Status}}", sandboxId])).trim());
        }
        catch (error) {
            if (error instanceof DockerError)
                return "missing";
            throw error;
        }
    }
    // The daemon's own id: the same for every dispatcher on this Docker host, and
    // different for any other Docker host.
    async hostId() {
        return (await docker(["info", "--format", "{{.ID}}"])).trim();
    }
    // A sandbox is its container and its network, both named by the sandbox id and
    // labelled at create. A network left without its container is still listed,
    // so the reaper can free the subnet.
    async list() {
        const found = new Map();
        const ids = async (args) => (await docker([
            ...args,
            "--quiet",
            "--no-trunc",
            "--filter",
            `label=${this.opts.namespace}.sandbox=1`,
        ]))
            .split("\n")
            .filter(Boolean);
        const containers = await ids(["ps", "--all"]);
        for (const line of await inspectEach("container", containers, "{{.Name}}\t{{.State.Status}}\t{{json .Created}}")) {
            const [name = "", state = "", created = ""] = line.split("\t");
            const sandboxId = name.replace(/^\//, "");
            found.set(sandboxId, { sandboxId, status: statusOf(state), createdAt: createdAt(created) });
        }
        const networks = await ids(["network", "ls"]);
        for (const line of await inspectEach("network", networks, "{{.Name}}\t{{json .Created}}")) {
            const [sandboxId = "", created = ""] = line.split("\t");
            if (found.has(sandboxId))
                continue;
            found.set(sandboxId, { sandboxId, status: "missing", createdAt: createdAt(created) });
        }
        return [...found.values()];
    }
}
