// Keeps an agent's session between runs on a platform that cannot keep the
// sandbox: a Cloud Run job's sandboxes end with the execution, so the thread's
// next run starts in a new one. executeRun restores the session directory into
// the sandbox before the runner starts and saves it after the runner exits.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Where sessions are kept, by key (usually the thread). Both sides are local
 * directories; executeRun copies them into and out of the sandbox.
 */
export interface SessionStore {
  /** Replaces whatever is stored under `key` with the contents of the directory `from`. */
  save(key: string, from: string): Promise<void>;
  /**
   * Fills the existing directory `into` with what is stored under `key`.
   * Resolves false when nothing is, as for a thread's first run; rejects when
   * the store could not be read, so a run does not start over by mistake.
   */
  restore(key: string, into: string): Promise<boolean>;
}

/** A key as a file name: letters, digits, `.`, `_` and `-` kept, anything else %-encoded. */
export function sessionFileName(key: string): string {
  if (!key) throw new Error("A session key cannot be empty");
  const safe = [...Buffer.from(key, "utf8")]
    .map((byte, i) => {
      const c = String.fromCharCode(byte);
      // A leading dot would hide the file, and a save's temporary file starts with one.
      const kept = /[A-Za-z0-9_-]/.test(c) || (c === "." && i > 0);
      return kept ? c : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
  return `${safe}.tar`;
}

function tar(args: string[], tarPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(tarPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`tar failed (${code}): ${stderr.trim()}`)),
    );
  });
}

export type DirectorySessionStoreOptions = {
  /** The tar binary; default `tar` on PATH. */
  tar?: string;
};

/**
 * One tar file per key under `rootDir`, which may be a Cloud Storage FUSE
 * mount (a job's sessions bucket, mounted read-write). A save writes a temporary
 * file and renames it over the key's, which replaces the object whole, so a
 * restore reads one save or another, never a mix. Two runs of the same key
 * that end together both save; the last rename wins and the other's turns are
 * lost from the session, so a thread should not run twice at once.
 */
export class DirectorySessionStore implements SessionStore {
  readonly rootDir: string;
  private readonly tarPath: string;

  constructor(rootDir: string, options: DirectorySessionStoreOptions = {}) {
    this.rootDir = rootDir;
    this.tarPath = options.tar ?? "tar";
  }

  /** Where the key's session is kept. */
  pathFor(key: string): string {
    return path.join(this.rootDir, sessionFileName(key));
  }

  async save(key: string, from: string): Promise<void> {
    const target = this.pathFor(key);
    if (!(await stat(from).catch(() => null))?.isDirectory()) {
      throw new Error(`No session directory at ${from}`);
    }
    await mkdir(this.rootDir, { recursive: true });
    const temp = path.join(
      this.rootDir,
      `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      await tar(["-C", from, "-cf", temp, "."], this.tarPath);
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async restore(key: string, into: string): Promise<boolean> {
    const source = this.pathFor(key);
    const found = await stat(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!found) return false;
    await tar(["-xf", source, "-C", into, "--no-same-owner"], this.tarPath);
    return true;
  }
}
