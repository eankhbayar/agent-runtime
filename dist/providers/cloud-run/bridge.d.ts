import { Duplex, type Readable, type Writable } from "node:stream";
/** A running shim's stdio, from `sandbox exec <id> -- node <shim> <port>` or anything like it. */
export type BridgeProcess = {
    stdin: Writable;
    stdout: Readable;
    stderr: Readable;
    /** Resolves when the process has exited. */
    exited: Promise<unknown>;
    /** Stops the process from this side. */
    kill: () => void;
};
export type StartBridgeOptions = {
    /** Starts one shim with this command, e.g. a provider's `openStream(sandboxId, command)`. */
    open: (command: string[]) => BridgeProcess;
    /** The port the shim listens on inside the sandbox; the runner's base URL is `http://127.0.0.1:<port>`. */
    port: number;
    /** Serves one tunnelled connection, e.g. `gateway.connect`. */
    onConnection: (stream: Duplex) => void;
    /** How to run the shim, before the port. Default: this package's `bridge-peer.js` under the job's node. */
    command?: string[];
    /** How long a shim has to print READY. Default 15 s. */
    readyTimeoutMs?: number;
    /** Wait before the first restart, doubled for each restart in the last minute. Default 250 ms. */
    restartMs?: number;
    /**
     * Restarts allowed within a minute. Once a shim has been restarted this many
     * times in a minute the bridge stays down for the rest of the sandbox's life.
     * Default 10.
     */
    maxRestartsPerMinute?: number;
    /** Streams open at once; one more is a protocol error. Default 64. */
    maxStreams?: number;
    log?: (message: string) => void;
};
export type Bridge = {
    /** How many times the shim has been started again. */
    readonly restarts: number;
    /** Streams currently open. */
    readonly open: number;
    /** Stops the shim and ends every stream; the bridge does not start again. */
    close: () => Promise<void>;
};
/**
 * The command that runs the shim this package ships. A Cloud Run sandbox's
 * root is the job container's own filesystem, so the job's node and its
 * installed copy of this package are at the same paths inside the sandbox.
 */
export declare function defaultShimCommand(): string[];
/** Starts the shim and resolves once it listens in the sandbox. */
export declare function startBridge(options: StartBridgeOptions): Promise<Bridge>;
