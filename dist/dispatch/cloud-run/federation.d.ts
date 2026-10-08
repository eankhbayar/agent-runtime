import { type Fetch } from "./http.ts";
/** `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>`. */
export declare function isWorkloadIdentityProvider(value: string): boolean;
export declare function isServiceAccountEmail(value: string): boolean;
export type FederatedAccessTokenOptions = {
    /** PKCS #8 PEM of the RSA key whose public JWKS the provider holds. */
    signingKeyPem: string;
    /** The workload identity provider's resource name, as isWorkloadIdentityProvider takes it. */
    provider: string;
    /** The `iss` the provider was created with. */
    issuer: string;
    /** The `sub` the provider's attribute condition accepts. */
    subject: string;
    /** The account to impersonate, by email. */
    serviceAccount: string;
    /** The JWT's `aud`. Defaults to `https://iam.googleapis.com/<provider>`, which a provider accepts unless given other audiences. */
    audience?: string;
    /** Defaults to cloud-platform; the account's roles are what limit it. */
    scope?: string;
    /** How long the subject JWT and the access token live. Defaults to 600. */
    lifetimeSeconds?: number;
    /** Per request. Defaults to 15 s. */
    timeoutMs?: number;
    fetchImpl?: Fetch;
    nowMs?: number;
};
export type SigningJwk = {
    kty: "RSA";
    alg: "RS256";
    use: "sig";
    kid: string;
    n: string;
    e: string;
};
/** The public JWKS to upload to the workload identity provider for this signing key. */
export declare function signingKeyJwks(signingKeyPem: string): Promise<{
    keys: SigningJwk[];
}>;
/**
 * Mints a short-lived access token for one service account without any Google
 * key: a self-signed JWT is exchanged at STS for a federated token, which then
 * impersonates that account.
 */
export declare function federatedAccessToken(options: FederatedAccessTokenOptions): Promise<string>;
