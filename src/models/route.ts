// Immutable model routes, identified by a digest of everything they pin. The
// package fixes only what every route has (an id, a model, a digest); an app
// adds its own policy fields and keeps its own manifests, approvals and
// prompt bundles. The digest is SHA-256 over a canonical JSON form with keys
// sorted, the scheme hk-legal's research-worker-contracts uses for its Model
// Routes and Prompt Bundles, so their digests come out the same.

/** A route an app pins: its own policy fields, plus an id, a model and the digest of the rest. */
export type ModelRoute<Policy extends object = {}> = Readonly<
  Policy & {
    id: string;
    /** The model id sent to the endpoint. */
    model: string;
    /** `manifestDigest` of every other field. */
    digest: string;
  }
>;

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
export function stableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("stableJson cannot encode a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => {
        if (item === undefined) throw new TypeError("stableJson cannot encode undefined in an array");
        return stableJson(item);
      })
      .join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`stableJson cannot encode a ${typeof value}`);
}

/** Lowercase hex SHA-256 of a string's UTF-8 bytes, with Web Crypto. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The digest of a manifest: SHA-256 of `stableJson` of every field but `digest`. */
export async function manifestDigest(manifest: object): Promise<string> {
  const { digest: _ignored, ...rest } = manifest as Record<string, unknown>;
  return await sha256Hex(stableJson(rest));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * A deeply frozen copy of the manifest with its digest set. For writing a new
 * route: compute it once, then pin the printed digest in the app's manifest
 * so a later edit cannot change the route silently (`checkManifestDigest`).
 */
export async function sealManifest<T extends object>(
  manifest: T,
): Promise<Readonly<Omit<T, "digest"> & { digest: string }>> {
  const copy = JSON.parse(stableJson(manifest)) as Record<string, unknown>;
  delete copy.digest;
  const digest = await manifestDigest(copy);
  return deepFreeze({ ...copy, digest }) as Readonly<Omit<T, "digest"> & { digest: string }>;
}

/** Whether the manifest's `digest` is the digest of its other fields. */
export async function checkManifestDigest<T extends { digest: string }>(manifest: T): Promise<boolean> {
  return (await manifestDigest(manifest)) === manifest.digest;
}
