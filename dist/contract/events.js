// The stable run_events shape.
// The in-sandbox runner, the dispatcher and the web app all depend on this and
// never on pi's internal event types or on a store's schema.
// Events go to stdout as JSON lines. The dispatcher reads them from the
// sandbox command stream, so the runner needs no outbound event endpoint.
export function createEmitter(write) {
    let seq = 0;
    return (type, payload) => {
        const event = { seq: seq++, ts: new Date().toISOString(), type, payload };
        write(`${JSON.stringify(event)}\n`);
    };
}
export const MAX_ARG_CHARS = 2_000;
/** Keeps a tool's arguments or result from filling the event log. */
export function truncate(value, max = MAX_ARG_CHARS) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}…` : value;
}
/** Splits a byte stream of JSON lines into events, keeping a partial last line. */
export function createEventParser(onEvent, onText) {
    let buffer = "";
    return (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (line.trim() === "")
                continue;
            let event;
            try {
                event = JSON.parse(line);
            }
            catch {
                onText?.(line);
                continue;
            }
            onEvent(event);
        }
    };
}
