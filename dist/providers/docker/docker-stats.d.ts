import type { Usage } from "../../core/sandbox-provider.ts";
/** Parses one `docker stats --format '{{json .}}'` line. CPU comes back as cores. */
export declare function parseDockerStats(line: string): Usage | null;
export declare function sampleUsage(sandboxId: string): Promise<Usage | null>;
