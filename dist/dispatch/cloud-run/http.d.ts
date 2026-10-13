export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export declare const REQUEST_TIMEOUT_MS = 15000;
/** Carries only a stable code: Google error bodies and key material never leave this module. */
export declare class CloudRunJobDispatchError extends Error {
    readonly safeCode: string;
    constructor(safeCode: string);
}
export declare function send(fetchImpl: Fetch, url: string, init: RequestInit, timeoutMs: number, networkCode: string): Promise<Response>;
export declare function jsonBody(response: Response): Promise<Record<string, unknown> | null>;
export declare function stringField(response: Response, field: string, invalidCode: string): Promise<string>;
