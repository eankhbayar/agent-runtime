// Renders the runner's run events in a terminal. The dispatcher's stdout sink
// prints each batch it would otherwise have stored.
export function printRunEvent(event, elapsed) {
    const p = event.payload;
    switch (event.type) {
        case "text_delta":
            process.stdout.write(String(p.delta));
            break;
        case "tool_start":
            console.log(`\n\x1b[36m→ ${String(p.toolName)}\x1b[0m ${JSON.stringify(p.args).slice(0, 160)}`);
            break;
        case "tool_end": {
            const result = typeof p.result === "string" ? p.result : "";
            console.log(p.isError
                ? `\x1b[31m  ✗ ${result || "error"}\x1b[0m`.slice(0, 200)
                : `\x1b[32m  ✓\x1b[0m ${result.split("\n")[0]?.slice(0, 120) ?? ""}`);
            break;
        }
        case "artifact":
            console.log(`\n\x1b[35m■ artifact\x1b[0m ${String(p.kind)} ${String(p.path)} — ${String(p.caption)}`);
            break;
        default:
            console.log(`\n\x1b[2m[${elapsed()}] ${event.type} ${JSON.stringify(p)}\x1b[0m`);
    }
}
