// `sandbox exec` loses the command's exit code: it exits 0 when the command
// does, and dies of SIGPIPE when it does not, whatever the code. So every
// command runs under a wrapper that prints a marker with the code as its last
// stdout line, and the job reads the code from it and strips it.

import { randomBytes } from "node:crypto";

/** A marker no command's output will contain by chance: `__AR_EXIT_<nonce>:`. */
export function newExitMarker(): string {
  return `__AR_EXIT_${randomBytes(8).toString("hex")}:`;
}

/**
 * Shell that prints the marker and the code in `$code`. It need not start a
 * line: the nonce makes it unique wherever it lands.
 */
export function printExitMarker(marker: string, codeVar = "code"): string {
  return `printf '%s%d\\n' '${marker}' "$${codeVar}"`;
}

/** The longest end of `text` that is a start of `marker`. */
function partialAt(text: string, marker: string): number {
  for (let keep = Math.min(marker.length - 1, text.length); keep > 0; keep--) {
    if (text.endsWith(marker.slice(0, keep))) return keep;
  }
  return 0;
}

/**
 * Passes a command's stdout on as it arrives, minus the marker. Text that
 * might be the start of the marker is held until the next chunk says whether
 * it is; a newline never is, so a line the runner ends is passed on at once.
 */
export class ExitMarkerReader {
  private held = "";
  private code: number | null = null;
  private readonly marker: string;
  private readonly forward: (text: string) => void;

  constructor(marker: string, forward: (text: string) => void) {
    this.marker = marker;
    this.forward = forward;
  }

  push(chunk: string): void {
    if (this.code !== null) return;
    const text = this.held + chunk;
    const at = text.indexOf(this.marker);
    if (at >= 0) {
      this.emit(text.slice(0, at));
      const line = /^(\d+)\n/.exec(text.slice(at + this.marker.length));
      if (line) this.code = Number(line[1]);
      // Otherwise the code has not all arrived yet.
      this.held = line ? "" : text.slice(at);
      return;
    }
    const keep = partialAt(text, this.marker);
    this.emit(text.slice(0, text.length - keep));
    this.held = text.slice(text.length - keep);
  }

  /** Passes on anything held and returns the code, or null when no marker came. */
  end(): number | null {
    if (this.code === null && this.held) this.emit(this.held);
    this.held = "";
    return this.code;
  }

  private emit(text: string): void {
    if (text) this.forward(text);
  }
}

/** Splits binary output from its trailing marker line. */
export function splitExitMarker(output: Buffer, marker: string): { body: Buffer; code: number | null } {
  const needle = Buffer.from(marker);
  const at = output.lastIndexOf(needle);
  if (at < 0) return { body: output, code: null };
  const line = /^(\d+)\n?$/.exec(output.subarray(at + needle.length).toString("latin1"));
  if (!line) return { body: output, code: null };
  return { body: output.subarray(0, at), code: Number(line[1]) };
}
