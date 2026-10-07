// Starts the egress gateway container and grants or revokes run tokens in it.
// The image is built from this package's `gateway/` directory.
import { createHash, randomBytes } from "node:crypto";
import { docker, DockerError } from "./docker.js";
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
                [state, upstream] = (await docker([
                    "inspect",
                    "--format",
                    `{{.State.Status}} {{index .Config.Labels "${upstreamLabel}"}}`,
                    container,
                ]))
                    .trim()
                    .split(" ");
            }
            catch (error) {
                if (!(error instanceof DockerError))
                    throw error;
            }
            if (state === "running" && upstream === opts.llm.messagesUrl && !opts.restart) {
                return "reused";
            }
            if (state !== null)
                await docker(["rm", "--force", container]);
            if (!opts.llm.apiKey)
                throw new Error("The gateway needs the provider API key to start");
            // `-e NAME` without a value: docker reads the key from its env, so it stays out of argv.
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
                `${upstreamLabel}=${opts.llm.messagesUrl}`,
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "-e",
                "UPSTREAM_MESSAGES_URL",
                "-e",
                "UPSTREAM_API_KEY",
                opts.image,
            ], { env: { UPSTREAM_MESSAGES_URL: opts.llm.messagesUrl, UPSTREAM_API_KEY: opts.llm.apiKey } });
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
