// Reading what a sandbox produced without trusting it. A sandbox can make
// symlinks, hard links and devices wherever it can write, and a path the job
// follows through one leads to the job's own files: a hidden secret, another
// thread's session, /proc/self/environ. So what comes out of a sandbox is
// taken as regular files and directories only, never followed, and capped.
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";
export class UnsafeFileError extends Error {
}
/** Reads a regular file, refusing a symlink (at the last component) or anything else. */
export async function readPlainFile(file, maxBytes) {
    let handle;
    try {
        handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    }
    catch (error) {
        if (error.code === "ELOOP") {
            throw new UnsafeFileError(`${path.basename(file)} is a symlink`);
        }
        throw error;
    }
    try {
        const info = await handle.stat();
        if (!info.isFile())
            throw new UnsafeFileError(`${path.basename(file)} is not a regular file`);
        if (info.size > maxBytes) {
            throw new UnsafeFileError(`${path.basename(file)} is larger than ${maxBytes} bytes`);
        }
        return await handle.readFile();
    }
    finally {
        await handle.close();
    }
}
/**
 * Checks that `dir` and everything under it are plain directories and
 * regular files, at most `maxBytes` in all, without following anything.
 */
export async function assertPlainTree(dir, maxBytes) {
    let total = 0;
    const walk = async (current) => {
        const info = await lstat(current);
        if (info.isDirectory()) {
            for (const name of await readdir(current))
                await walk(path.join(current, name));
        }
        else if (info.isFile()) {
            total += info.size;
            if (total > maxBytes)
                throw new UnsafeFileError(`more than ${maxBytes} bytes`);
        }
        else {
            throw new UnsafeFileError(`${path.relative(dir, current) || "."} is not a regular file or directory`);
        }
    };
    await walk(dir);
}
const BLOCK = 512;
function field(header, start, length) {
    const raw = header.subarray(start, start + length);
    const end = raw.indexOf(0);
    return raw.subarray(0, end < 0 ? length : end).toString("utf8");
}
function octal(header, start, length) {
    // GNU tar writes sizes of 8 GiB and up in base 256, high bit set.
    if (header[start] & 0x80) {
        let value = header[start] & 0x7f;
        for (let i = start + 1; i < start + length; i++)
            value = value * 256 + header[i];
        return value;
    }
    const text = field(header, start, length).trim();
    return text ? Number.parseInt(text, 8) : 0;
}
function checksumOk(header) {
    let sum = 0;
    for (let i = 0; i < BLOCK; i++)
        sum += i >= 148 && i < 156 ? 32 : header[i];
    return sum === octal(header, 148, 8);
}
function paxRecords(data) {
    const records = {};
    let offset = 0;
    while (offset < data.length) {
        const space = data.indexOf(32, offset);
        if (space < 0)
            break;
        const length = Number(data.subarray(offset, space).toString());
        if (!Number.isInteger(length) || length <= 0)
            throw new UnsafeFileError("bad pax header");
        const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
        const eq = record.indexOf("=");
        if (eq > 0)
            records[record.slice(0, eq)] = record.slice(eq + 1);
        offset += length;
    }
    return records;
}
/** A member's path inside `into`; throws for one that would leave it. */
function memberPath(into, name) {
    const parts = name.split("/").filter((part) => part !== "" && part !== ".");
    if (name.startsWith("/") || parts.includes("..")) {
        throw new UnsafeFileError(`${name} points outside the archive`);
    }
    return parts.length === 0 ? null : path.join(into, ...parts);
}
/**
 * Extracts a tar archive into the existing directory `into`, creating only
 * directories and regular files (with O_EXCL and O_NOFOLLOW) and rejecting
 * links, devices, paths that leave `into`, and more than `maxBytes` of file
 * data. Reads GNU, ustar and pax archives.
 */
export async function extractPlainTar(archive, into, maxBytes) {
    const handle = await open(archive, "r");
    try {
        const read = async (length, position) => {
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, position);
            if (bytesRead < length)
                throw new UnsafeFileError("the archive ends early");
            return buffer;
        };
        const size = (await handle.stat()).size;
        let position = 0;
        let total = 0;
        let longName = null;
        let pax = {};
        let ended = false;
        while (position + BLOCK <= size) {
            const header = await read(BLOCK, position);
            position += BLOCK;
            if (header.every((byte) => byte === 0)) {
                ended = true;
                break;
            }
            if (!checksumOk(header))
                throw new UnsafeFileError("the archive is corrupt");
            const type = String.fromCharCode(header[156]);
            const ustar = header.subarray(257, 263).toString("latin1") === "ustar\0";
            const prefix = ustar ? field(header, 345, 155) : "";
            let name = longName ?? pax.path ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
            const length = pax.size !== undefined ? Number(pax.size) : octal(header, 124, 12);
            if (!Number.isSafeInteger(length) || length < 0)
                throw new UnsafeFileError("bad member size");
            const padded = Math.ceil(length / BLOCK) * BLOCK;
            if (position + padded > size)
                throw new UnsafeFileError("the archive ends early");
            if (type === "L" || type === "x" || type === "g") {
                if (length > 1024 * 1024)
                    throw new UnsafeFileError("header too large");
                const data = await read(length, position);
                position += padded;
                if (type === "L")
                    longName = field(data, 0, data.length);
                else if (type === "x")
                    pax = paxRecords(data);
                continue;
            }
            longName = null;
            pax = {};
            name = name.replace(/\/+$/, "");
            if (type === "5") {
                const target = memberPath(into, name);
                if (target)
                    await mkdir(target, { recursive: true, mode: 0o755 });
                position += padded;
                continue;
            }
            if (type !== "0" && type !== "\0" && type !== "7") {
                const what = type === "2" ? "a symlink" : type === "1" ? "a hard link" : `of type ${JSON.stringify(type)}`;
                throw new UnsafeFileError(`${name} is ${what}`);
            }
            total += length;
            if (total > maxBytes)
                throw new UnsafeFileError(`more than ${maxBytes} bytes`);
            const target = memberPath(into, name);
            if (!target)
                throw new UnsafeFileError("a file with no name");
            await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
            const out = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
            try {
                for (let done = 0; done < length;) {
                    const chunk = await read(Math.min(1024 * 1024, length - done), position + done);
                    await out.write(chunk);
                    done += chunk.length;
                }
            }
            finally {
                await out.close();
            }
            position += padded;
        }
        // A cut-off archive would pass for a smaller session or output.
        if (!ended)
            throw new UnsafeFileError("the archive ends early");
    }
    finally {
        await handle.close();
    }
}
