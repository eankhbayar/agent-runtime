// What every call to Google shares: a timeout, and errors that say what failed
// in a code of our own. Google's error bodies can quote the request, and the
// request can carry a token, so none of a body or a fetch error is kept.
export const REQUEST_TIMEOUT_MS = 15_000;
/** Carries only a stable code: Google error bodies and key material never leave this module. */
export class CloudRunJobDispatchError extends Error {
    safeCode;
    constructor(safeCode) {
        super(safeCode);
        this.safeCode = safeCode;
        this.name = "CloudRunJobDispatchError";
    }
}
export async function send(fetchImpl, url, init, timeoutMs, networkCode) {
    try {
        return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    }
    catch {
        throw new CloudRunJobDispatchError(networkCode);
    }
}
export async function jsonBody(response) {
    const body = await response.json().catch(() => null);
    return typeof body === "object" && body !== null ? body : null;
}
export async function stringField(response, field, invalidCode) {
    const value = (await jsonBody(response))?.[field];
    if (typeof value !== "string" || !value)
        throw new CloudRunJobDispatchError(invalidCode);
    return value;
}
