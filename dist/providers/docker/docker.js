// Thin wrapper over the docker CLI. It targets whatever the current docker
// context points at (a Colima VM, say); DOCKER_CONTEXT or DOCKER_HOST override.
import { spawn } from "node:child_process";
export class DockerError extends Error {
    exitCode;
    stderr;
    constructor(args, exitCode, stderr) {
        super(`docker ${args[0]} failed (${exitCode}): ${stderr.trim()}`);
        this.exitCode = exitCode;
        this.stderr = stderr;
    }
}
export function docker(args, opts = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn("docker", args, {
            env: { ...process.env, ...opts.env },
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
        child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
        child.on("error", reject);
        child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new DockerError(args, code ?? -1, stderr)));
        child.stdin.end(opts.input ?? "");
    });
}
