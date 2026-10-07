// Thin wrapper over the docker CLI. It targets whatever the current docker
// context points at (a Colima VM, say); DOCKER_CONTEXT or DOCKER_HOST override.

import { spawn } from "node:child_process";

export class DockerError extends Error {
  readonly exitCode: number;
  readonly stderr: string;

  constructor(args: string[], exitCode: number, stderr: string) {
    super(`docker ${args[0]} failed (${exitCode}): ${stderr.trim()}`);
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export function docker(
  args: string[],
  opts: { input?: string; env?: Record<string, string> } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new DockerError(args, code ?? -1, stderr)),
    );
    child.stdin.end(opts.input ?? "");
  });
}
