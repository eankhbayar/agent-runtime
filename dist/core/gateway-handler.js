// The egress gateway's request handling: a per-run token in place of the
// provider key, the key added on the way out, and model calls proxied to one
// upstream with the response streamed back unbuffered. The upstream speaks
// either the Anthropic Messages format (`x-api-key`) or the OpenAI Chat
// Completions format (`Authorization: Bearer`). The Docker gateway image
// (gateway/server.ts) and the in-job gateway (gateway.ts) both serve it.
// Given a project's data commands (../data), it also serves them at
// GET /data and POST /data/<command>, for the `agent-data` CLI.
//
// This file imports nothing but Node, because gateway/gateway-handler.ts is a
// copy of it that the gateway image runs on its own. Edit this one; a test
// fails until the copy matches.
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
/** What a run token looks like; anything else is refused without a lookup. */
export const RUN_TOKEN_PATTERN = /^rt_[A-Za-z0-9_-]{32,}$/;
// Hop-by-hop and auth headers are never forwarded in either direction, nor
// headers that would let a sandbox pick which account the key bills.
const DROP_REQUEST = new Set([
    "host",
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authorization",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "content-length",
    "x-api-key",
    "authorization",
    "openai-organization",
    "openai-project",
]);
const DROP_RESPONSE = new Set([
    "connection",
    "content-length",
    "content-encoding",
    "transfer-encoding",
]);
/** The run token a request carries: `x-api-key` for Anthropic, `Authorization: Bearer` for OpenAI. */
function runTokenOf(req, openai) {
    if (!openai) {
        const key = req.headers["x-api-key"];
        return typeof key === "string" ? key : undefined;
    }
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "");
    return match?.[1];
}
/** The largest data call body read; arguments are a few flags. */
const MAX_DATA_BODY = 64 * 1024;
const DATA_COMMAND = /^\/data\/([a-z][a-z0-9-]*)$/;
function sendJson(res, status, body) {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}
/** The request body as text, or null once it passes `limit` bytes. */
async function readBody(req, limit) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit)
            return null;
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}
export function createGatewayHandler(options) {
    const { apiKey } = options;
    const log = options.log ?? (() => { });
    const upstreamFetch = options.fetch ?? fetch;
    const openai = options.format === "openai";
    // Sandbox clients use the gateway as their base URL, so the Anthropic SDK
    // calls /v1/messages, and an OpenAI client given <gateway>/v1 calls /v1/chat/completions.
    let upstreamByPath;
    if (options.format === "openai") {
        const baseUrl = options.baseUrl.replace(/\/+$/, "");
        upstreamByPath = new Map([["/v1/chat/completions", `${baseUrl}/chat/completions`]]);
    }
    else {
        const { messagesUrl } = options;
        upstreamByPath = new Map([
            ["/v1/messages", messagesUrl],
            ["/v1/messages/count_tokens", `${messagesUrl}/count_tokens`],
        ]);
    }
    const forwardHeaders = (req) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
            if (value === undefined || DROP_REQUEST.has(name))
                continue;
            headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        if (openai)
            headers.set("authorization", `Bearer ${apiKey}`);
        else
            headers.set("x-api-key", apiKey);
        return headers;
    };
    // The CLI sends its run token as a bearer token whichever format the model uses.
    const serveData = async (req, res, url) => {
        const data = options.data;
        const command = DATA_COMMAND.exec(url.pathname)?.[1];
        const listing = req.method === "GET" && url.pathname === "/data";
        if (!data || !(listing || (req.method === "POST" && command))) {
            sendJson(res, 404, { error: "not_found" });
            return;
        }
        const token = runTokenOf(req, true) ?? runTokenOf(req, false);
        const grant = typeof token === "string" && RUN_TOKEN_PATTERN.test(token)
            ? await options.grantFor(token).catch(() => null)
            : null;
        if (!grant) {
            log({ path: url.pathname, status: 401, reason: "invalid_run_token" });
            sendJson(res, 401, { error: "invalid_run_token" });
            return;
        }
        if (listing) {
            sendJson(res, 200, data.list());
            return;
        }
        const text = await readBody(req, MAX_DATA_BODY);
        if (text === null) {
            sendJson(res, 413, { error: "The arguments are too large." });
            return;
        }
        let args;
        try {
            args = text.trim() ? JSON.parse(text) : {};
        }
        catch {
            sendJson(res, 400, { error: "The arguments are not JSON." });
            return;
        }
        try {
            const reply = await data.call(command, args, grant);
            sendJson(res, reply.status, reply.body);
        }
        catch (error) {
            log({ runId: grant.runId, path: url.pathname, error: String(error) });
            if (!res.headersSent)
                sendJson(res, 502, { error: "data_failed" });
        }
    };
    return async (req, res) => {
        const url = new URL(req.url ?? "/", "http://gateway");
        if (req.method === "GET" && url.pathname === "/healthz") {
            res.writeHead(200, { "content-type": "text/plain" }).end("ok");
            return;
        }
        if (url.pathname === "/data" || url.pathname.startsWith("/data/")) {
            await serveData(req, res, url);
            return;
        }
        const target = upstreamByPath.get(url.pathname);
        if (req.method !== "POST" || !target) {
            res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not_found"}');
            return;
        }
        const token = runTokenOf(req, openai);
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
