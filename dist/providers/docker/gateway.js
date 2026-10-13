// Starts the egress gateway container and grants or revokes run tokens in it.
// The image is built from this package's `gateway/` directory.
import { createHash, randomBytes } from "node:crypto";
import { docker, DockerError } from "./docker.js";
/** What the gateway container is labelled with, so a changed upstream restarts it. */
function upstreamLabelValue(llm) {
    // An Anthropic upstream keeps the bare URL that 0.6 wrote, so upgrading reuses the container.
    return llm.format === "openai" ? `openai ${llm.baseUrl}` : llm.messagesUrl;
}
/** The gateway image's environment for an upstream (the key is added separately). */
function upstreamEnv(llm) {
    return llm.format === "openai"
        ? { UPSTREAM_FORMAT: "openai", UPSTREAM_BASE_URL: llm.baseUrl }
        : { UPSTREAM_MESSAGES_URL: llm.messagesUrl };
}
function tokenFile(token) {
    return `/run/gateway/tokens/${createHash("sha256").update(token).digest("hex")}`;
}
export function createGateway(options) {
    const container = options.container;
    const alias = options.alias ?? "gateway";
    const upstreamLabel = "agent-runtime.gateway.upstream";
    return {
        container,
        alias,
        url: `http://${alias}:8080`,
        async ensure(opts) {
            let state = null;
            let upstream = null;
            try {
                const inspected = (await docker([
                    "inspect",
                    "--format",
                    `{{.State.Status}} {{index .Config.Labels "${upstreamLabel}"}}`,
                    container,
                ])).trim();
                const space = inspected.indexOf(" ");
                [state, upstream] =
                    space === -1 ? [inspected, ""] : [inspected.slice(0, space), inspected.slice(space + 1)];
            }
            catch (error) {
                if (!(error instanceof DockerError))
                    throw error;
            }
            const label = upstreamLabelValue(opts.llm);
            if (state === "running" && upstream === label && !opts.restart) {
                return "reused";
            }
            if (state !== null)
                await docker(["rm", "--force", container]);
            if (!opts.llm.apiKey)
                throw new Error("The gateway needs the provider API key to start");
            // `-e NAME` without a value: docker reads the key from its env, so it stays out of argv.
            const env = { ...upstreamEnv(opts.llm), UPSTREAM_API_KEY: opts.llm.apiKey };
            await docker([
                "run",
                "--detach",
                "--name",
                container,
                "--restart",
                "unless-stopped",
                "--label",
                "agent-runtime.gateway=1",
                "--label",
                `${upstreamLabel}=${label}`,
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                ...Object.keys(env).flatMap((name) => ["-e", name]),
                opts.image,
            ], { env });
            return "started";
        },
        async grant(runId, ttlMs) {
            const token = `rt_${randomBytes(32).toString("base64url")}`;
            const grant = JSON.stringify({
                runId,
                expiresAt: new Date(Date.now() + ttlMs).toISOString(),
            });
            await docker(["exec", "-i", container, "sh", "-c", `umask 077 && cat > ${tokenFile(token)}`], { input: grant });
            return token;
        },
        async revoke(token) {
            await docker(["exec", container, "rm", "-f", tokenFile(token)]);
        },
    };
}
