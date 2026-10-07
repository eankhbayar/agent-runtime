import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { EmitRunEvent } from "../../contract/events.ts";

/**
 * The tool an agent registers a result file with. It emits the `artifact` event
 * the dispatcher copies the file out on; `kinds` are the project's own.
 */
export function createSaveOutputTool(opts: {
  outputsDir: string;
  emit: EmitRunEvent;
  kinds: readonly [string, ...string[]];
  description?: string;
}) {
  const { outputsDir, emit } = opts;
  return defineTool({
    name: "save_output",
    label: "Save output",
    description:
      opts.description ??
      `Register a file you wrote under ${outputsDir} as a result for the user.`,
    parameters: Type.Object({
      path: Type.String({ description: `Path of the file, inside ${outputsDir}` }),
      kind: Type.Union(opts.kinds.map((k) => Type.Literal(k))),
      caption: Type.String({ description: "One sentence describing what the file shows" }),
    }),
    execute: async (_toolCallId, params) => {
      const resolved = path.resolve(outputsDir, params.path);
      if (!resolved.startsWith(`${path.resolve(outputsDir)}${path.sep}`)) {
        throw new Error(`Outputs must be inside ${outputsDir}`);
      }
      const [bytes, info] = await Promise.all([readFile(resolved), stat(resolved)]);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      emit("artifact", {
        path: resolved,
        kind: params.kind,
        caption: params.caption,
        sha256,
        size: info.size,
      });
      return {
        content: [{ type: "text", text: `Saved ${resolved} (${info.size} bytes)` }],
        details: {},
      };
    },
  });
}
