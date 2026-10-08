import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { assertPlainTree, extractPlainTar, readPlainFile } from "./plain-files.ts";

const temp = (name: string) => mkdtemp(path.join(tmpdir(), `agent-runtime-${name}-`));
const env = { ...process.env, COPYFILE_DISABLE: "1" };

/** Packs `dir` with the system tar, as a sandbox would. */
async function pack(dir: string, members: string[], format?: string): Promise<string> {
  const archive = path.join(await temp("archive"), "a.tar");
  const formatArgs = format ? [`--format=${format}`] : [];
  execFileSync("tar", [...formatArgs, "-C", dir, "-cf", archive, ...members], { env });
  return archive;
}

describe("extractPlainTar", () => {
  it("unpacks directories and regular files, long names included", async () => {
    const dir = await temp("src");
    const deep = path.join("a".repeat(60), "b".repeat(60), "c".repeat(60));
    await mkdir(path.join(dir, deep), { recursive: true });
    await writeFile(path.join(dir, deep, "file.jsonl"), "deep\n");
    await writeFile(path.join(dir, "top.txt"), "top\n");
    for (const format of [undefined, "pax", "ustar"]) {
      const into = await temp("into");
      // ustar cannot hold the 180-character directory, so it gets only the top file.
      const members = format === "ustar" ? ["top.txt"] : ["."];
      await extractPlainTar(await pack(dir, members, format), into, 1024 * 1024);
      expect(await readFile(path.join(into, "top.txt"), "utf8")).toBe("top\n");
      if (format !== "ustar") expect(await readFile(path.join(into, deep, "file.jsonl"), "utf8")).toBe("deep\n");
    }
  });

  it("refuses a symlink, whatever it points at", async () => {
    const dir = await temp("src");
    await symlink("/etc/passwd", path.join(dir, "leak.txt"));
    const into = await temp("into");
    await expect(extractPlainTar(await pack(dir, ["leak.txt"]), into, 1024)).rejects.toThrow(
      "leak.txt is a symlink",
    );
    expect(await readdir(into)).toEqual([]);
  });

  it("refuses a hard link", async () => {
    const dir = await temp("src");
    await writeFile(path.join(dir, "a"), "x");
    await link(path.join(dir, "a"), path.join(dir, "b"));
    await expect(extractPlainTar(await pack(dir, ["a", "b"]), await temp("into"), 1024)).rejects.toThrow(
      "is a hard link",
    );
  });

  it("refuses a path that leaves the directory", async () => {
    // A tar made by hand: one member named ../escaped.
    const header = Buffer.alloc(512);
    header.write("../escaped", 0);
    header.write("0000644\0", 100);
    header.write("00000000001\0", 124);
    header.write("0", 156);
    header.write("ustar\u000000", 257);
    header.fill(32, 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    const body = Buffer.alloc(512);
    body.write("x");
    const archive = path.join(await temp("archive"), "a.tar");
    await writeFile(archive, Buffer.concat([header, body, Buffer.alloc(1024)]));
    const into = await temp("into");
    await expect(extractPlainTar(archive, into, 1024)).rejects.toThrow("points outside the archive");
    expect(await readdir(path.dirname(into))).not.toContain("escaped");
  });

  it("stops at its size cap, and at an archive cut short", async () => {
    const dir = await temp("src");
    await writeFile(path.join(dir, "big"), Buffer.alloc(10_000));
    const archive = await pack(dir, ["big"]);
    await expect(extractPlainTar(archive, await temp("into"), 5_000)).rejects.toThrow("more than 5000 bytes");
    const whole = await readFile(archive);
    const cut = path.join(await temp("archive"), "cut.tar");
    await writeFile(cut, whole.subarray(0, 4096));
    await expect(extractPlainTar(cut, await temp("into"), 100_000)).rejects.toThrow("ends early");
  });
});

describe("readPlainFile and assertPlainTree", () => {
  it("read a regular file and refuse a symlink to one", async () => {
    const dir = await temp("files");
    await writeFile(path.join(dir, "ok.txt"), "fine");
    await symlink(path.join(dir, "ok.txt"), path.join(dir, "link.txt"));
    expect((await readPlainFile(path.join(dir, "ok.txt"), 100)).toString()).toBe("fine");
    await expect(readPlainFile(path.join(dir, "link.txt"), 100)).rejects.toThrow("is a symlink");
    await expect(readPlainFile(path.join(dir, "ok.txt"), 2)).rejects.toThrow("larger than 2 bytes");
    await expect(readPlainFile(dir, 100)).rejects.toThrow("not a regular file");
  });

  it("refuse a tree holding a symlink, or that is one", async () => {
    const dir = await temp("tree");
    await mkdir(path.join(dir, "sub"));
    await writeFile(path.join(dir, "sub", "a"), "a");
    await assertPlainTree(dir, 100);
    await symlink("/etc", path.join(dir, "sub", "etc"));
    await expect(assertPlainTree(dir, 100)).rejects.toThrow("sub/etc is not a regular file");
    const pointer = path.join(await temp("tree"), "sessions");
    await symlink(dir, pointer);
    await expect(assertPlainTree(pointer, 100)).rejects.toThrow("is not a regular file or directory");
    await expect(assertPlainTree(path.join(dir, "sub"), 0)).rejects.toThrow("more than 0 bytes");
  });
});
