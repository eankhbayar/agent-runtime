/** A marker no command's output will contain by chance: `__AR_EXIT_<nonce>:`. */
export declare function newExitMarker(): string;
/**
 * Shell that prints the marker and the code in `$code`. It need not start a
 * line: the nonce makes it unique wherever it lands.
 */
export declare function printExitMarker(marker: string, codeVar?: string): string;
/**
 * Passes a command's stdout on as it arrives, minus the marker. Text that
 * might be the start of the marker is held until the next chunk says whether
 * it is; a newline never is, so a line the runner ends is passed on at once.
 */
export declare class ExitMarkerReader {
    private held;
    private code;
    private readonly marker;
    private readonly forward;
    constructor(marker: string, forward: (text: string) => void);
    push(chunk: string): void;
    /** Passes on anything held and returns the code, or null when no marker came. */
    end(): number | null;
    private emit;
}
/** Splits binary output from its trailing marker line. */
export declare function splitExitMarker(output: Buffer, marker: string): {
    body: Buffer;
    code: number | null;
};
