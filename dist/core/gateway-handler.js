// The egress gateway's request handling: a per-run token in place of the
// provider key, the key added on the way out, and Anthropic-format Messages
// calls proxied to one upstream endpoint with the response streamed back
// unbuffered. The Docker gateway image (gateway/server.ts) and the in-job
// gateway (gateway.ts) both serve it.
//
// This file imports nothing but Node, because gateway/gateway-handler.ts is a
// copy of it that the gateway image runs on its own. Edit this one; a test
// fails until the copy matches.
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
/** What a run token looks like; anything else is refused without a lookup. */
export const RUN_TOKEN_PATTERN = /^rt_[A-Za-z0-9_-]{32,}$/;
// Hop-by-hop and auth headers are never forwarded in either direction.
const DROP_REQUEST = new Set(["host", "connection", "content-length", "x-api-key", "authorization"]);
const DROP_RESPONSE = new Set([
    "connection",
    "content-length",
    "content-encoding",
    "transfer-encoding",
]);
export function createGatewayHandler(options) {
    const { apiKey, messagesUrl } = options;
    const log = options.log ?? (() => { });
    const upstreamFetch = options.fetch ?? fetch;
    // Sandbox clients use the gateway as their base URL, so the SDK calls /v1/messages.
    const upstreamByPath = new Map([
        ["/v1/messages", messagesUrl],
        ["/v1/messages/count_tokens", `${messagesUrl}/count_tokens`],
    ]);
    const forwardHeaders = (req) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
            if (value === undefined || DROP_REQUEST.has(name))
                continue;
            headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        headers.set("x-api-key", apiKey);
        return headers;
    };
    return async (req, res) => {
        const url = new URL(req.url ?? "/", "http://gateway");
        if (req.method === "GET" && url.pathname === "/healthz") {
            res.writeHead(200, { "content-type": "text/plain" }).end("ok");
            return;
        }
        const target = upstreamByPath.get(url.pathname);
        if (req.method !== "POST" || !target) {
            res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not_found"}');
            return;
        }
        const token = req.headers["x-api-key"];
        const grant = typeof token === "string" && RUN_TOKEN_PATTERN.test(token)
            ? await options.grantFor(token).catch(() => null)
            : null;
        if (!grant) {
            log({ path: url.pathname, status: 401, reason: "invalid_run_token" });
            res
                .writeHead(401, { "content-type": "application/json" })
                .end('{"error":"invalid_run_token"}');
            return;
        }
        const started = Date.now();
        const abort = new AbortController();
        res.on("close", () => abort.abort());
        try {
            const upstreamRes = await upstreamFetch(`${target}${url.search}`, {
                method: "POST",
                headers: forwardHeaders(req),
                body: Readable.toWeb(req),
                duplex: "half",
                signal: abort.signal,
            });
            const headers = {};
            upstreamRes.headers.forEach((value, name) => {
                if (!DROP_RESPONSE.has(name))
                    headers[name] = value;
            });
            res.writeHead(upstreamRes.status, headers);
            if (upstreamRes.body) {
                // Piped chunk by chunk, so a streamed response reaches the agent as it is sent.
                // An agent that hangs up mid-answer (a cancel, a timeout, a shutdown) aborts
                // the upstream call, which errors the body; that ends this pipeline, not the process.
                await pipeline(Readable.fromWeb(upstreamRes.body), res).catch(() => { });
            }
            else {
                res.end();
            }
            log({
                runId: grant.runId,
                path: url.pathname,
                status: upstreamRes.status,
                ms: Date.now() - started,
            });
        }
        catch (error) {
            log({ runId: grant.runId, path: url.pathname, error: String(error), ms: Date.now() - started });
            if (!res.headersSent)
                res.writeHead(502, { "content-type": "application/json" });
            res.end('{"error":"upstream_failed"}');
        }
    };
}
