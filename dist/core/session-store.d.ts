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
export declare function sessionFileName(key: string): string;
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
 * lost from the session, so a thread should not run twice at once. A save
 * refuses a directory holding anything but directories and regular files, and
 * a restore creates nothing else.
 */
export declare class DirectorySessionStore implements SessionStore {
    readonly rootDir: string;
    private readonly tarPath;
    constructor(rootDir: string, options?: DirectorySessionStoreOptions);
    /** Where the key's session is kept. */
    pathFor(key: string): string;
    save(key: string, from: string): Promise<void>;
    restore(key: string, into: string): Promise<boolean>;
}
