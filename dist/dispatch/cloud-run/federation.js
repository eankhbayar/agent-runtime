// Google access tokens for a Convex deployment, which has no Google identity
// and, where the organization blocks service-account keys, cannot be given
// one. Convex is its own OIDC issuer instead: it signs a short JWT with an RSA
// key only it holds, Google's STS exchanges that for a federated token through
// a workload identity provider that holds the public JWKS and accepts one
// subject, and the federated token impersonates a service account that can do
// one thing (run a job, read a bucket). The key is useless for anything else.
import { CloudRunJobDispatchError, REQUEST_TIMEOUT_MS, send, stringField, } from "./http.js";
const STS_URL = "https://sts.googleapis.com/v1/token";
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const TOKEN_LIFETIME_SECONDS = 600;
const PROVIDER = /^projects\/\d+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/;
const SERVICE_ACCOUNT = /^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/;
/** `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>`. */
export function isWorkloadIdentityProvider(value) {
    return PROVIDER.test(value);
}
export function isServiceAccountEmail(value) {
    return SERVICE_ACCOUNT.test(value);
}
function base64Url(bytes) {
    let binary = "";
    for (const byte of bytes)
        binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64UrlJson(value) {
    return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}
// Not annotated: Node's types and a worker's disagree on what CryptoKey is.
async function importSigningKey(pem) {
    const body = pem
        .match(/-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/)?.[1]
        ?.replace(/\s+/g, "");
    if (!body)
        throw new CloudRunJobDispatchError("gcp_dispatch_signing_key_invalid");
    try {
        const pkcs8 = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
        return await crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["sign"]);
    }
    catch {
        throw new CloudRunJobDispatchError("gcp_dispatch_signing_key_invalid");
    }
}
async function publicJwk(key) {
    const { n, e } = await crypto.subtle.exportKey("jwk", key);
    if (!n || !e)
        throw new CloudRunJobDispatchError("gcp_dispatch_signing_key_invalid");
    // RFC 7638 thumbprint: required members only, in lexicographic order.
    const thumbprint = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ e, kty: "RSA", n })));
    return { kty: "RSA", alg: "RS256", use: "sig", kid: base64Url(new Uint8Array(thumbprint)), n, e };
}
/** The public JWKS to upload to the workload identity provider for this signing key. */
export async function signingKeyJwks(signingKeyPem) {
    return { keys: [await publicJwk(await importSigningKey(signingKeyPem))] };
}
async function subjectToken(options, lifetimeSeconds) {
    const key = await importSigningKey(options.signingKeyPem);
    const { kid } = await publicJwk(key);
    const issuedAt = Math.floor((options.nowMs ?? Date.now()) / 1_000);
    const unsigned = `${base64UrlJson({ alg: "RS256", typ: "JWT", kid })}.${base64UrlJson({
        iss: options.issuer,
        sub: options.subject,
        aud: options.audience ?? `https://iam.googleapis.com/${options.provider}`,
        iat: issuedAt,
        exp: issuedAt + lifetimeSeconds,
    })}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
    return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}
/**
 * Mints a short-lived access token for one service account without any Google
 * key: a self-signed JWT is exchanged at STS for a federated token, which then
 * impersonates that account.
 */
export async function federatedAccessToken(options) {
    // Checked before anything is signed: both go into a URL or a request body.
    if (!isWorkloadIdentityProvider(options.provider) ||
        !isServiceAccountEmail(options.serviceAccount)) {
        throw new CloudRunJobDispatchError("gcp_federation_configuration_invalid");
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const lifetimeSeconds = options.lifetimeSeconds ?? TOKEN_LIFETIME_SECONDS;
    const scope = options.scope ?? CLOUD_PLATFORM_SCOPE;
    const jwt = await subjectToken(options, lifetimeSeconds);
    const exchange = await send(fetchImpl, STS_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
            audience: `//iam.googleapis.com/${options.provider}`,
            scope,
            requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
            subjectToken: jwt,
            subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
        }),
    }, timeoutMs, "gcp_sts_network_failed");
    if (!exchange.ok)
        throw new CloudRunJobDispatchError(`gcp_sts_http_${exchange.status}`);
    const federatedToken = await stringField(exchange, "access_token", "gcp_sts_response_invalid");
    const impersonation = await send(fetchImpl, `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${options.serviceAccount}:generateAccessToken`, {
        method: "POST",
        headers: { authorization: `Bearer ${federatedToken}`, "content-type": "application/json" },
        body: JSON.stringify({ scope: [scope], lifetime: `${lifetimeSeconds}s` }),
    }, timeoutMs, "gcp_impersonation_network_failed");
    if (!impersonation.ok) {
        throw new CloudRunJobDispatchError(`gcp_impersonation_http_${impersonation.status}`);
    }
    return await stringField(impersonation, "accessToken", "gcp_impersonation_response_invalid");
}
