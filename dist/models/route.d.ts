/** A route an app pins: its own policy fields, plus an id, a model and the digest of the rest. */
export type ModelRoute<Policy extends object = {}> = Readonly<Policy & {
    id: string;
    /** The model id sent to the endpoint. */
    model: string;
    /** `manifestDigest` of every other field. */
    digest: string;
}>;
/**
 * JSON with object keys sorted at every level, so equal data always gives
 * the same text. Object properties whose value is undefined are left out, as
 * JSON.stringify does; anything JSON cannot carry exactly (undefined in an
 * array, a function, a bigint, a symbol, a non-finite number) throws.
 *
 * hk-legal's own `stable` (research-worker-contracts' tests, the worker's
 * model-invocation.ts) writes an undefined property as `"key":undefined`
 * instead. The two agree on every manifest without undefined fields, which
 * is all of hk-legal's pinned routes and bundles, and differ on any with
 * one: such a manifest digests differently here. Its invocation input
 * digests, which hash records with optional fields, are not this scheme's.
 */
export declare function stableJson(value: unknown): string;
/** Lowercase hex SHA-256 of a string's UTF-8 bytes, with Web Crypto. */
export declare function sha256Hex(text: string): Promise<string>;
/** The digest of a manifest: SHA-256 of `stableJson` of every field but `digest`. */
export declare function manifestDigest(manifest: object): Promise<string>;
/**
 * A deeply frozen copy of the manifest with its digest set. For writing a new
 * route: compute it once, then pin the printed digest in the app's manifest
 * so a later edit cannot change the route silently (`checkManifestDigest`).
 */
export declare function sealManifest<T extends object>(manifest: T): Promise<Readonly<Omit<T, "digest"> & {
    digest: string;
}>>;
/** Whether the manifest's `digest` is the digest of its other fields. */
export declare function checkManifestDigest<T extends {
    digest: string;
}>(manifest: T): Promise<boolean>;
