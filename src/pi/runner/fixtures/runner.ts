// A minimal runner for tests: runAgent with a fixed prompt and no tools of its
// own. Its environment picks the model.
import { runAgent } from "../runner.ts";

await runAgent({
  defaultModel: { provider: "kimi-coding", model: "kimi-for-coding" },
  systemPrompt: () => "You are a test agent.",
  builtinTools: [],
});
