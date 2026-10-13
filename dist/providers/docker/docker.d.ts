export declare class DockerError extends Error {
    readonly exitCode: number;
    readonly stderr: string;
    constructor(args: string[], exitCode: number, stderr: string);
}
export declare function docker(args: string[], opts?: {
    input?: string;
    env?: Record<string, string>;
}): Promise<string>;
