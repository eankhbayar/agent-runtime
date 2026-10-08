// Starts the egress gateway container and grants or revokes run tokens in it.
// The image is built from this package's `gateway/` directory.

import { createHash, randomBytes } from "node:crypto";

import { docker, DockerError } from "./docker.ts";
import type { GatewayUpstream } from "../../core/gateway-handler.ts";
import type { TokenGrant } from "../../core/run.ts";

// The model endpoint. The gateway proxies either the Anthropic Messages format
// (`messagesUrl`, x-api-key auth) or, with `format: "openai"`, the OpenAI Chat
// Completions format (`baseUrl`, bearer auth), and nothing else.
export type LlmConfig = GatewayUpstream & {
  provider: string;
  model: string;
  apiKey: string | undefined;
};

/** What the gateway container is labelled with, so a changed upstream restarts it. */
function upstreamLabelValue(llm: GatewayUpstream): string {
  // An Anthropic upstream keeps the bare URL that 0.6 wrote, so upgrading reuses the container.
  return llm.format === "openai" ? `openai ${llm.baseUrl}` : llm.messagesUrl;
}

/** The gateway image's environment for an upstream (the key is added separately). */
function upstreamEnv(llm: GatewayUpstream): Record<string, string> {
  return llm.format === "openai"
    ? { UPSTREAM_FORMAT: "openai", UPSTREAM_BASE_URL: llm.baseUrl }
    : { UPSTREAM_MESSAGES_URL: llm.messagesUrl };
}

export type GatewayOptions = {
  /** Container name, e.g. `myproject-egress-gateway`. */
  container: string;
  /** The host name sandboxes reach the gateway by. Default `gateway`. */
  alias?: string;
};

export type Gateway = TokenGrant & {
  container: string;
  alias: string;
  /** The base URL a sandbox uses, e.g. `http://gateway:8080`. */
  url: string;
  ensure: (opts: {
    image: string;
    llm: LlmConfig;
    restart?: boolean;
  }) => Promise<"reused" | "started">;
};

function tokenFile(token: string): string {
  return `/run/gateway/tokens/${createHash("sha256").update(token).digest("hex")}`;
}

export function createGateway(options: GatewayOptions): Gateway {
  const container = options.container;
  const alias = options.alias ?? "gateway";
  const upstreamLabel = "agent-runtime.gateway.upstream";

  return {
    container,
    alias,
    url: `http://${alias}:8080`,

    async ensure(opts) {
      let state: string | null = null;
      let upstream: string | null = null;
      try {
        const inspected = (
          await docker([
            "inspect",
            "--format",
            `{{.State.Status}} {{index .Config.Labels "${upstreamLabel}"}}`,
            container,
          ])
        ).trim();
        const space = inspected.indexOf(" ");
        [state, upstream] =
          space === -1 ? [inspected, ""] : [inspected.slice(0, space), inspected.slice(space + 1)];
      } catch (error) {
        if (!(error instanceof DockerError)) throw error;
      }
      const label = upstreamLabelValue(opts.llm);
      if (state === "running" && upstream === label && !opts.restart) {
        return "reused";
      }
      if (state !== null) await docker(["rm", "--force", container]);

      if (!opts.llm.apiKey) throw new Error("The gateway needs the provider API key to start");
      // `-e NAME` without a value: docker reads the key from its env, so it stays out of argv.
      const env = { ...upstreamEnv(opts.llm), UPSTREAM_API_KEY: opts.llm.apiKey };
      await docker(
        [
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
        ],
        { env },
      );
      return "started";
    },

    async grant(runId, ttlMs) {
      const token = `rt_${randomBytes(32).toString("base64url")}`;
      const grant = JSON.stringify({
        runId,
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      });
      await docker(
        ["exec", "-i", container, "sh", "-c", `umask 077 && cat > ${tokenFile(token)}`],
        { input: grant },
      );
      return token;
    },

    async revoke(token) {
      await docker(["exec", container, "rm", "-f", tokenFile(token)]);
    },
  };
}
