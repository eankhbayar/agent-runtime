import { describe, expect, it, vi } from "vitest";

import { federatedAccessToken, signingKeyJwks } from "./federation.ts";
import { CloudRunJobDispatchError, type Fetch } from "./http.ts";

const PROVIDER =
  "projects/866539738015/locations/global/workloadIdentityPools/convex-dispatch/providers/convex";
const INVOKER = "research-job-invoker@hklegalapp.iam.gserviceaccount.com";
const ISSUER = "https://research-dispatch.hklegalapp.invalid";
const SUBJECT = "convex-research-dispatcher";

async function signingKey() {
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey)).toString(
    "base64",
  );
  return {
    publicKey: keys.publicKey,
    pem: `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function decodeSegment(segment: string) {
  return JSON.parse(Buffer.from(segment, "base64url").toString());
}

async function codeOf(promise: Promise<unknown>) {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CloudRunJobDispatchError);
  return error as CloudRunJobDispatchError;
}

const federation = {
  provider: PROVIDER,
  issuer: ISSUER,
  subject: SUBJECT,
  serviceAccount: INVOKER,
};

describe("signingKeyJwks", () => {
  it("publishes only the public half, identified by its RFC 7638 thumbprint", async () => {
    const { pem, publicKey } = await signingKey();
    const jwks = await signingKeyJwks(pem);

    expect(jwks.keys).toHaveLength(1);
    const [jwk] = jwks.keys;
    expect(Object.keys(jwk!).sort()).toEqual(["alg", "e", "kid", "kty", "n", "use"]);
    expect(jwk).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig" });
    const exported = await crypto.subtle.exportKey("jwk", publicKey);
    expect(jwk!.n).toBe(exported.n);
    const thumbprint = Buffer.from(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify({ e: exported.e, kty: "RSA", n: exported.n })),
      ),
    ).toString("base64url");
    expect(jwk!.kid).toBe(thumbprint);
  });
});

describe("federatedAccessToken", () => {
  it("exchanges a self-signed JWT at STS, then impersonates the account", async () => {
    const { pem, publicKey } = await signingKey();
    const fetchImpl = vi.fn<Fetch>(async (url) =>
      url === "https://sts.googleapis.com/v1/token"
        ? jsonResponse({ access_token: "federated-token", token_type: "Bearer", expires_in: 3600 })
        : jsonResponse({ accessToken: "ya29.invoker", expireTime: "2026-09-23T06:00:00Z" }),
    );

    const token = await federatedAccessToken({
      ...federation,
      signingKeyPem: pem,
      fetchImpl,
      nowMs: 1_790_000_000_000,
    });

    expect(token).toBe("ya29.invoker");
    const [[stsUrl, stsInit], [impersonateUrl, impersonateInit]] = fetchImpl.mock.calls as [
      [string, RequestInit],
      [string, RequestInit],
    ];
    expect(stsUrl).toBe("https://sts.googleapis.com/v1/token");
    const exchange = JSON.parse(String(stsInit.body));
    expect(exchange).toMatchObject({
      grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: `//iam.googleapis.com/${PROVIDER}`,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
      subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
    });
    const [header, claims, signature] = String(exchange.subjectToken).split(".") as [
      string,
      string,
      string,
    ];
    expect(decodeSegment(header)).toEqual({
      alg: "RS256",
      typ: "JWT",
      kid: (await signingKeyJwks(pem)).keys[0]!.kid,
    });
    expect(decodeSegment(claims)).toEqual({
      iss: ISSUER,
      sub: SUBJECT,
      aud: `https://iam.googleapis.com/${PROVIDER}`,
      iat: 1_790_000_000,
      exp: 1_790_000_600,
    });
    expect(
      await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        publicKey,
        Buffer.from(signature, "base64url"),
        new TextEncoder().encode(`${header}.${claims}`),
      ),
    ).toBe(true);

    expect(impersonateUrl).toBe(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${INVOKER}:generateAccessToken`,
    );
    expect(new Headers(impersonateInit.headers).get("authorization")).toBe(
      "Bearer federated-token",
    );
    expect(JSON.parse(String(impersonateInit.body))).toEqual({
      scope: ["https://www.googleapis.com/auth/cloud-platform"],
      lifetime: "600s",
    });
  });

  it("signs for the audience, scope and lifetime it is given", async () => {
    const { pem } = await signingKey();
    const fetchImpl = vi.fn<Fetch>(async (url) =>
      url.startsWith("https://sts.")
        ? jsonResponse({ access_token: "federated-token" })
        : jsonResponse({ accessToken: "ya29.reader" }),
    );

    await federatedAccessToken({
      ...federation,
      signingKeyPem: pem,
      audience: "convex-dispatch",
      scope: "https://www.googleapis.com/auth/devstorage.read_only",
      lifetimeSeconds: 300,
      fetchImpl,
      nowMs: 1_790_000_000_000,
    });

    const [[, stsInit], [, impersonateInit]] = fetchImpl.mock.calls as [
      [string, RequestInit],
      [string, RequestInit],
    ];
    const exchange = JSON.parse(String(stsInit.body));
    expect(exchange.scope).toBe("https://www.googleapis.com/auth/devstorage.read_only");
    expect(decodeSegment(String(exchange.subjectToken).split(".")[1]!)).toMatchObject({
      aud: "convex-dispatch",
      exp: 1_790_000_300,
    });
    expect(JSON.parse(String(impersonateInit.body))).toEqual({
      scope: ["https://www.googleapis.com/auth/devstorage.read_only"],
      lifetime: "300s",
    });
  });

  it("refuses a malformed signing key without echoing it", async () => {
    const fetchImpl = vi.fn<Fetch>();
    for (const pem of [
      "",
      "not a key",
      "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----",
    ]) {
      const error = await codeOf(
        federatedAccessToken({ ...federation, signingKeyPem: pem, fetchImpl }),
      );
      expect(error.safeCode).toBe("gcp_dispatch_signing_key_invalid");
      expect(String(error)).not.toContain("AAAA");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a malformed provider or account before signing anything", async () => {
    const { pem } = await signingKey();
    const fetchImpl = vi.fn<Fetch>();
    for (const bad of [{ provider: "convex" }, { serviceAccount: "invoker@evil.example/../" }]) {
      const error = await codeOf(
        federatedAccessToken({ ...federation, ...bad, signingKeyPem: pem, fetchImpl }),
      );
      expect(error.safeCode).toBe("gcp_federation_configuration_invalid");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports each failed exchange step by HTTP status only", async () => {
    const { pem } = await signingKey();
    const stsRefused = vi.fn<Fetch>(async () =>
      jsonResponse({ error: "invalid_grant", error_description: "secret detail" }, 400),
    );
    const impersonationRefused = vi.fn<Fetch>(async (url) =>
      url.startsWith("https://sts.")
        ? jsonResponse({ access_token: "federated-token" })
        : jsonResponse(
            { error: { message: "Permission iam.serviceAccounts.getAccessToken denied" } },
            403,
          ),
    );

    const stsError = await codeOf(
      federatedAccessToken({ ...federation, signingKeyPem: pem, fetchImpl: stsRefused }),
    );
    const impersonationError = await codeOf(
      federatedAccessToken({ ...federation, signingKeyPem: pem, fetchImpl: impersonationRefused }),
    );

    expect(stsError.safeCode).toBe("gcp_sts_http_400");
    expect(impersonationError.safeCode).toBe("gcp_impersonation_http_403");
    expect(String(stsError)).not.toContain("secret detail");
  });

  it("reports an unreadable answer and a dropped connection by code only", async () => {
    const { pem } = await signingKey();
    const garbled = vi.fn<Fetch>(async () => new Response("<html>", { status: 200 }));
    const dropped = vi.fn<Fetch>(async () => {
      throw new TypeError("getaddrinfo ENOTFOUND sts.googleapis.com");
    });

    expect(
      (
        await codeOf(
          federatedAccessToken({ ...federation, signingKeyPem: pem, fetchImpl: garbled }),
        )
      ).safeCode,
    ).toBe("gcp_sts_response_invalid");
    const error = await codeOf(
      federatedAccessToken({ ...federation, signingKeyPem: pem, fetchImpl: dropped }),
    );
    expect(error.safeCode).toBe("gcp_sts_network_failed");
    expect(String(error)).not.toContain("ENOTFOUND");
  });
});
