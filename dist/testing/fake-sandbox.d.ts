export type FakeSandboxCli = {
    /** An executable to pass as `sandboxBin`. */
    bin: string;
    /** Where the fake keeps its sandboxes and call log. */
    root: string;
    /** A fresh directory for the provider's `stateDir`. */
    stateDir: string;
    /** The arguments of every call so far, oldest first. */
    calls: () => Promise<string[][]>;
    /** The names in the CLI's own environment, for every call so far. */
    cliEnvNames: () => Promise<string[][]>;
    /** Sandboxes the fake still has. */
    sandboxes: () => Promise<string[]>;
    /** The mounts and flags a sandbox was started with. */
    config: (id: string) => Promise<{
        binds: {
            source: string;
            destination: string;
            readonly: boolean;
        }[];
        flags: string[];
    }>;
    cleanup: () => Promise<void>;
};
export declare function createFakeSandboxCli(): Promise<FakeSandboxCli>;
