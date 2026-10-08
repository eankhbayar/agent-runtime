// Test doubles for executeRun: a sandbox whose runner is a script of stdout
// lines, and a sink that records what a run would have written.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SESSION_RESTORE_SCRIPT } from "../core/run.js";
/** Every file under a local directory, by its path relative to it. */
async function walk(dir, prefix = "") {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const relative = path.posix.join(prefix, entry.name);
        const full = path.join(dir, entry.name);
        if (entry.isDirectory())
            out.push(...(await walk(full, relative)));
        else
            out.push([relative, await readFile(full)]);
    }
    return out;
}
export class FakeSandboxProvider {
    calls = [];
    execs = [];
    killed = false;
    resumeFails = false;
    /** What `sha256sum` prints for every uploaded file a mount verifies. */
    uploadSha = "upload-hash";
    /** What `list` reports, for the reaper tests. */
    sandboxes = [];
    destroyed = [];
    /** The options of every `create`. */
    creates = [];
    /**
     * The sandbox's files by path: `files` from the run, what `upload` copied
     * in, and a restored session. `download` copies from here.
     */
    fs;
    /** Makes the session restore command exit 1. */
    restoreFails = false;
    state = "running";
    next = 0;
    run;
    constructor(run = { stdout: [] }) {
        this.run = run;
        this.fs = new Map(Object.entries(run.files ?? {}).map(([p, body]) => [p, Buffer.from(body)]));
    }
    async create(opts) {
        this.calls.push("create");
        if (opts)
            this.creates.push(opts);
        this.state = "running";
        return `sbx-${++this.next}`;
    }
    async upload(_sandboxId, localDir, remoteDir) {
        this.calls.push("upload");
        for (const [relative, body] of await walk(localDir)) {
            this.fs.set(path.posix.join(remoteDir, relative), body);
        }
    }
    /** Copies a file, or a directory with everything under it, as `docker cp` does. */
    async download(_sandboxId, remotePath, localPath) {
        this.calls.push(`download ${remotePath}`);
        const target = path.join(localPath, path.posix.basename(remotePath));
        const file = this.fs.get(remotePath);
        if (file !== undefined) {
            await writeFile(target, file);
            return;
        }
        const under = [...this.fs].filter(([p]) => p.startsWith(`${remotePath}/`));
        if (under.length === 0)
            throw new Error(`No such file: ${remotePath}`);
        for (const [p, body] of under) {
            const local = path.join(target, path.posix.relative(remotePath, p));
            await mkdir(path.dirname(local), { recursive: true });
            await writeFile(local, body);
        }
    }
    exec(_sandboxId, command, opts = {}) {
        this.execs.push(command);
        if (command[0] === "sha256sum") {
            opts.onStdout?.(`${this.uploadSha}  ${command[1]}\n`);
            return { done: Promise.resolve(0), kill: async () => { } };
        }
        // executeRun moving a restored session from where it was uploaded into place.
        if (command[2] === SESSION_RESTORE_SCRIPT) {
            const [staged, sessionDir] = command.slice(4);
            if (this.restoreFails)
                return { done: Promise.resolve(1), kill: async () => { } };
            for (const [p, body] of [...this.fs]) {
                if (!p.startsWith(`${staged}/`))
                    continue;
                this.fs.delete(p);
                this.fs.set(path.posix.join(sessionDir, path.posix.relative(staged, p)), body);
            }
            return { done: Promise.resolve(0), kill: async () => { } };
        }
        let stopped = false;
        const done = (async () => {
            for (const chunk of this.run.stdout) {
                if (stopped)
                    break;
                await new Promise((resolve) => setTimeout(resolve, this.run.chunkMs ?? 0));
                if (stopped)
                    break;
                opts.onStdout?.(chunk);
            }
            if (this.run.stderr)
                opts.onStderr?.(this.run.stderr);
            return stopped ? 143 : (this.run.exitCode ?? 0);
        })();
        return {
            done,
            kill: async () => {
                this.killed = true;
                stopped = true;
            },
        };
    }
    async pause(sandboxId) {
        this.calls.push("pause");
        this.setListed(sandboxId, "paused");
        this.state = "paused";
    }
    async stopCommands(sandboxId) {
        this.calls.push(`stop ${sandboxId}`);
    }
    async hostId() {
        return "fake-host";
    }
    setListed(sandboxId, status) {
        this.sandboxes = this.sandboxes.map((s) => (s.sandboxId === sandboxId ? { ...s, status } : s));
    }
    async resume(sandboxId) {
        this.calls.push(`resume ${sandboxId}`);
        if (this.resumeFails)
            throw new Error("sandbox is gone");
        this.state = "running";
    }
    async destroy(sandboxId) {
        this.calls.push("destroy");
        this.destroyed.push(sandboxId);
        this.sandboxes = this.sandboxes.filter((s) => s.sandboxId !== sandboxId);
        this.state = "missing";
    }
    async status() {
        return this.state;
    }
    async list() {
        return this.sandboxes;
    }
}
export class FakeSink {
    batches = [];
    storedSamples = [];
    uploads = [];
    lines = [];
    state = { cancelled: false, gone: false };
    /** Rejects this many of the next `events` calls, as a dropped connection does. */
    failNext = 0;
    /** Every event the run sent, in the order the sink saw it. */
    get sent() {
        return this.batches.flat();
    }
    events = async (batch) => {
        if (this.failNext > 0) {
            this.failNext -= 1;
            throw new Error("connection lost");
        }
        this.batches.push(batch);
        return this.state;
    };
    samples = async (samples) => {
        this.storedSamples.push(...samples);
    };
    artifact = async (upload) => {
        this.uploads.push(upload);
        return `artifact-${this.uploads.length}`;
    };
    log = (message) => {
        this.lines.push(message);
    };
}
/** One JSON line as the in-sandbox runner writes it. */
export function line(seq, type, payload) {
    return `${JSON.stringify({ seq, ts: new Date(Date.UTC(2026, 8, 16, 0, 0, seq)).toISOString(), type, payload })}\n`;
}
