// The stdio bridge's wire format, shared by the job side (bridge.ts) and the
// shim in the sandbox (bridge-peer.ts). One byte stream each way carries every
// tunnelled TCP connection as frames:
//
//   [type u8][stream u32][length u32][payload]
//
//   OPEN  the shim accepted a connection; the job opens a stream for it
//   DATA  bytes for the stream
//   END   the sender will write no more on the stream (a half close, or a reset)
//
// Node built-ins only: the shim runs from the installed package with plain node.

import type { Readable } from "node:stream";

export const OPEN = 1;
export const DATA = 2;
export const END = 3;

const HEADER = 9;

export function encodeFrame(type: number, id: number, payload?: Uint8Array): Buffer {
  const head = Buffer.alloc(HEADER);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(id, 1);
  head.writeUInt32BE(payload?.length ?? 0, 5);
  return payload?.length ? Buffer.concat([head, payload]) : head;
}

export type FrameHandler = (type: number, id: number, payload: Buffer) => void;

/** Calls `onFrame` for each whole frame, however the bytes were split. */
export function createFrameDecoder(onFrame: FrameHandler): (chunk: Buffer) => void {
  // Chunks are joined only once a whole header or frame has arrived, so many
  // small chunks cost no more than one large one.
  let chunks: Buffer[] = [];
  let size = 0;
  let need = HEADER;
  return (chunk) => {
    chunks.push(chunk);
    size += chunk.length;
    if (size < need) return;
    const pending = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, size);
    let offset = 0;
    while (pending.length - offset >= HEADER) {
      const length = pending.readUInt32BE(offset + 5);
      if (pending.length - offset < HEADER + length) break;
      // Copied, so a payload kept by a socket does not pin the whole chunk.
      onFrame(
        pending.readUInt8(offset),
        pending.readUInt32BE(offset + 1),
        Buffer.from(pending.subarray(offset + HEADER, offset + HEADER + length)),
      );
      offset += HEADER + length;
    }
    const rest = pending.subarray(offset);
    chunks = rest.length ? [rest] : [];
    size = rest.length;
    need = rest.length >= HEADER ? HEADER + rest.readUInt32BE(5) : HEADER;
  };
}

export function readFrames(input: Readable, onFrame: FrameHandler): void {
  input.on("data", createFrameDecoder(onFrame));
}
