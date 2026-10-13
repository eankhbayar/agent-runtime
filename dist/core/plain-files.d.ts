export declare class UnsafeFileError extends Error {
}
/** Reads a regular file, refusing a symlink (at the last component) or anything else. */
export declare function readPlainFile(file: string, maxBytes: number): Promise<Buffer>;
/**
 * Checks that `dir` and everything under it are plain directories and
 * regular files, at most `maxBytes` in all, without following anything.
 */
export declare function assertPlainTree(dir: string, maxBytes: number): Promise<void>;
/**
 * Extracts a tar archive into the existing directory `into`, creating only
 * directories and regular files (with O_EXCL and O_NOFOLLOW) and rejecting
 * links, devices, paths that leave `into`, and more than `maxBytes` of file
 * data. Reads GNU, ustar and pax archives.
 */
export declare function extractPlainTar(archive: string, into: string, maxBytes: number): Promise<void>;
