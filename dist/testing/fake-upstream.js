// A stand-in for an Anthropic-format Messages endpoint, for testing a gateway
// and the bridge without a real key: it checks the key, records each request,
// and streams its reply as Messages SSE, one word per event, `gapMs` apart.
import { createServer } from "node:http";
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
/** The SSE events a streamed Messages response of `text` is made of. */
export function messagesEvents(text) {
    const words = text.split(/(?<= )/);
    return [
        sse("message_start", {
            type: "message_start",
            message: {
                id: "msg_fake",
                type: "message",
                role: "assistant",
                model: "fake-model",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 0 },
            },
        }),
        sse("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
        }),
        ...words.map((word) => sse("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: word },
        })),
        sse("content_block_stop", { type: "content_block_stop", index: 0 }),
        sse("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: words.length },
        }),
        sse("message_stop", { type: "message_stop" }),
    ];
}
export async function startFakeUpstream(options) {
    const requests = [];
    const reply = options.reply ?? (() => "Hello from the fake model.");
    const server = createServer(async (req, res) => {
        let raw = "";
        for await (const chunk of req)
            raw += String(chunk);
        let body = {};
        try {
            body = JSON.parse(raw || "{}");
        }
        catch { }
        const url = new URL(req.url ?? "/", "http://upstream");
        requests.push({ path: url.pathname, headers: req.headers, body });
        if (req.headers["x-api-key"] !== options.apiKey) {
            res.writeHead(401, { "content-type": "application/json" }).end('{"error":"bad key"}');
            return;
        }
        if (url.pathname === "/v1/messages/count_tokens") {
            res.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":10}');
            return;
        }
        if (url.pathname !== "/v1/messages") {
            res.writeHead(404).end();
            return;
        }
        const text = reply(body);
        if (!body.stream) {
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
                id: "msg_fake",
                type: "message",
                role: "assistant",
                model: "fake-model",
                content: [{ type: "text", text }],
                stop_reason: "end_turn",
                usage: { input_tokens: 10, output_tokens: 5 },
            }));
            return;
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        let stopped = false;
        res.on("close", () => (stopped = true));
        for (const event of messagesEvents(text)) {
            if (stopped)
                return;
            res.write(event);
            if (options.gapMs)
                await new Promise((resolve) => setTimeout(resolve, options.gapMs));
        }
        res.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    return {
        messagesUrl: `http://127.0.0.1:${port}/v1/messages`,
        requests,
        close: async () => {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(() => resolve()));
        },
    };
}
