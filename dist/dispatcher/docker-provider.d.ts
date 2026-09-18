import type { ExecHandle, ExecOptions, SandboxInfo, SandboxLimits, SandboxProvider, SandboxStatus } from "./sandbox-provider.ts";
export type DockerSandboxOptions = {
    gatewayContainer: string;
    gatewayAlias: string;
    /**
     * Names this project's sandboxes (`<namespace>-sbx-<id>`) and labels them
     * (`<namespace>.sandbox=1`), so `list` and the reaper see no one else's.
     */
    namespace: string;
};
export declare class DockerSandboxProvider implements SandboxProvider {
    private readonly opts;
    constructor(opts: DockerSandboxOptions);
    create({ image, limits, labels, }: {
        image: string;
        limits: SandboxLimits;
        labels?: Record<string, string>;
    }): Promise<string>;
    upload(sandboxId: string, localDir: string, remoteDir: string): Promise<void>;
    download(sandboxId: string, remotePath: string, localPath: string): Promise<void>;
    exec(sandboxId: string, command: string[], opts?: ExecOptions): ExecHandle;
    pause(sandboxId: string): Promise<void>;
    resume(sandboxId: string): Promise<void>;
    stopCommands(sandboxId: string): Promise<void>;
    destroy(sandboxId: string): Promise<void>;
    status(sandboxId: string): Promise<SandboxStatus>;
    hostId(): Promise<string>;
    list(): Promise<SandboxInfo[]>;
}
