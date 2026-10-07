import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { EmitRunEvent } from "../contract/events.ts";
export type { EmitRunEvent, RunEvent, RunEventType } from "../contract/events.ts";
export declare function createEmitter(write?: (line: string) => void): EmitRunEvent;
export declare function forwardSessionEvent(event: AgentSessionEvent, emit: EmitRunEvent): void;
