export type Usage = {
    cpu: number;
    memoryMb: number;
};
/** Parses one `docker stats --format '{{json .}}'` line. CPU comes back as cores. */
export declare function parseDockerStats(line: string): Usage | null;
export declare function sampleUsage(sandboxId: string): Promise<Usage | null>;
