// The pi adapter for the shared run contract: it turns pi's session events into
// the stable run_events shapes in ../contract. The runner, the
// dispatcher and the web app depend on the contract, never on pi's own types.
import { createEmitter as createContractEmitter, truncate } from "../contract/events.js";
// Events go to stdout as JSON lines. The dispatcher reads them from the
// sandbox command stream, so the runner needs no outbound event endpoint.
export function createEmitter(write = (l) => process.stdout.write(l)) {
    return createContractEmitter(write);
}
/** pi hands a tool's result back as content blocks; the log keeps their text. */
function resultText(result) {
    if (typeof result === "string")
        return result;
    const content = result?.content;
    if (!Array.isArray(content))
        return undefined;
    const text = content
        .flatMap((part) => {
        const block = part;
        return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
    })
        .join("\n");
    return text || undefined;
}
export function forwardSessionEvent(event, emit) {
    switch (event.type) {
        case "message_update":
            if (event.assistantMessageEvent.type === "text_delta") {
                emit("text_delta", { delta: event.assistantMessageEvent.delta });
            }
            break;
        case "tool_execution_start":
            emit("tool_start", {
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: truncate(event.args),
            });
            break;
        case "tool_execution_end": {
            const text = resultText(event.result);
            emit("tool_end", {
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                isError: event.isError,
                // What the tool actually returned, so the trace shows more than a tick.
                result: text === undefined ? undefined : truncate(text),
            });
            break;
        }
        case "turn_end": {
            const message = event.message;
            if (message.role === "assistant") {
                // The whole usage object: the trace reads input and output, and the
                // rest (cache reads, reasoning tokens) is worth keeping as it comes.
                emit("turn_end", {
                    usage: message.usage,
                    stopReason: message.stopReason,
                    error: message.errorMessage,
                });
            }
            break;
        }
        case "auto_retry_start":
        case "compaction_start":
            emit("notice", { kind: event.type });
            break;
    }
}
