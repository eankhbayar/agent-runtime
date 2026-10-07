import { Type } from "typebox";
import type { EmitRunEvent } from "../contract/events.ts";
/**
 * The tool an agent registers a result file with. It emits the `artifact` event
 * the dispatcher copies the file out on; `kinds` are the project's own.
 */
export declare function createSaveOutputTool(opts: {
    outputsDir: string;
    emit: EmitRunEvent;
    kinds: readonly [string, ...string[]];
    description?: string;
}): import("@earendil-works/pi-coding-agent").ToolDefinition<Type.TObject<{
    path: Type.TString;
    kind: Type.TUnion<Type.TLiteral<string>[]>;
    caption: Type.TString;
}>, {}, any> & import("@earendil-works/pi-coding-agent").ToolDefinition<any, any, any>;
