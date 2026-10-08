import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DirectorySessionStore, sessionFileName } from "./session-store.ts";

const temp = (name: string) => mkdtemp(path.join(tmpdir(), `agent-runtime-${name}-`));

async function sessionDir(files: Record<string, string>): Promise<string> {
  const dir = await temp("session");
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), body);
  }
  return dir;
}

describe("DirectorySessionStore", () => {
  it("restores what was saved under a key, and says when nothing was", async () => {
    const store = new DirectorySessionStore(await temp("store"));
    const into = await temp("into");
    expect(await store.restore("thread_1", into)).toBe(false);
    expect(await readdir(into)).toEqual([]);

    await store.save("thread_1", await sessionDir({ "a.jsonl": "one\n", "nested/b.jsonl": "two\n" }));
    expect(await store.restore("thread_1", into)).toBe(true);
    expect(await readFile(path.join(into, "a.jsonl"), "utf8")).toBe("one\n");
    expect(await readFile(path.join(into, "nested", "b.jsonl"), "utf8")).toBe("two\n");
  });

  it("replaces a key's session whole, leaving no temporary files", async () => {
    const root = await temp("store");
    const store = new DirectorySessionStore(root);
    await store.save("thread_1", await sessionDir({ "old.jsonl": "old\n" }));
    await store.save("thread_1", await sessionDir({ "new.jsonl": "new\n" }));
    const into = await temp("into");
    await store.restore("thread_1", into);
    expect(await readdir(into)).toEqual(["new.jsonl"]);
    expect(await readdir(root)).toEqual(["thread_1.tar"]);
  });

  it("ends with one save or the other when two land at once", async () => {
    const root = await temp("store");
    const store = new DirectorySessionStore(root);
    const a = await sessionDir({ "s.jsonl": "a".repeat(100_000) });
    const b = await sessionDir({ "s.jsonl": "b".repeat(100_000) });
    await Promise.all([store.save("thread_1", a), store.save("thread_1", b)]);
    const into = await temp("into");
    await store.restore("thread_1", into);
    const body = await readFile(path.join(into, "s.jsonl"), "utf8");
    expect([..."ab"].some((c) => body === c.repeat(100_000))).toBe(true);
    expect(await readdir(root)).toEqual(["thread_1.tar"]);
  });

  it("keeps the stored session when a save fails", async () => {
    const root = await temp("store");
    const store = new DirectorySessionStore(root);
    await store.save("thread_1", await sessionDir({ "s.jsonl": "kept\n" }));
    await expect(store.save("thread_1", path.join(root, "missing"))).rejects.toThrow(
      "No session directory",
    );
    const broken = new DirectorySessionStore(root, { tar: "false" });
    await expect(broken.save("thread_1", await sessionDir({ "s.jsonl": "lost\n" }))).rejects.toThrow(
      "tar failed",
    );
    const into = await temp("into");
    await store.restore("thread_1", into);
    expect(await readFile(path.join(into, "s.jsonl"), "utf8")).toBe("kept\n");
    expect(await readdir(root)).toEqual(["thread_1.tar"]);
  });

  it("rejects a restore it could not read, rather than reporting no session", async () => {
    const root = await temp("store");
    await writeFile(path.join(root, "thread_1.tar"), "not a tar file");
    await expect(new DirectorySessionStore(root).restore("thread_1", await temp("into"))).rejects.toThrow(
      "the archive ends early",
    );
  });

  it("keeps every key inside its directory", () => {
    expect(sessionFileName("thread_abc-1.2")).toBe("thread_abc-1.2.tar");
    expect(sessionFileName("../../etc/passwd")).toBe("%2E.%2F..%2Fetc%2Fpasswd.tar");
    expect(sessionFileName("..")).toBe("%2E..tar");
    expect(sessionFileName("a/b")).toBe("a%2Fb.tar");
    expect(sessionFileName("線")).toBe("%E7%B7%9A.tar");
    expect(sessionFileName("a/b")).not.toBe(sessionFileName("a%2Fb"));
    expect(() => sessionFileName("")).toThrow();
  });
});
