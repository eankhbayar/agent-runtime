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

/** The largest payload either side sends or accepts; DATA is split to fit. */
export const MAX_FRAME_PAYLOAD = 1024 * 1024;
/** How much of a chunk goes in one DATA frame. */
const SLICE = 64 * 1024;

export function encodeFrame(type: number, id: number, payload?: Uint8Array): Buffer {
  const head = Buffer.alloc(HEADER);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(id, 1);
  head.writeUInt32BE(payload?.length ?? 0, 5);
  return payload?.length ? Buffer.concat([head, payload]) : head;
}

/** DATA frames for a chunk of any size, each well under the cap. */
export function encodeData(id: number, chunk: Uint8Array): Buffer {
  if (chunk.length <= SLICE) return encodeFrame(DATA, id, chunk);
  const frames: Buffer[] = [];
  for (let at = 0; at < chunk.length; at += SLICE) {
    frames.push(encodeFrame(DATA, id, chunk.subarray(at, at + SLICE)));
  }
  return Buffer.concat(frames);
}

export type FrameHandler = (type: number, id: number, payload: Buffer) => void;

/**
 * Calls `onFrame` for each whole frame, however the bytes were split. A
 * frame longer than `maxPayload` calls `onError` once and ends decoding, so a
 * hostile sender cannot make it hold more than one frame's worth.
 */
export function createFrameDecoder(
  onFrame: FrameHandler,
  onError: (error: Error) => void = () => {},
  maxPayload = MAX_FRAME_PAYLOAD,
): (chunk: Buffer) => void {
  // Chunks are joined only once a whole header or frame has arrived, so many
  // small chunks cost no more than one large one.
  let chunks: Buffer[] = [];
  let size = 0;
  let need = HEADER;
  let failed = false;
  const fail = (length: number) => {
    failed = true;
    chunks = [];
    size = 0;
    onError(new Error(`A tunnel frame of ${length} bytes is over the ${maxPayload} byte limit`));
  };
  return (chunk) => {
    if (failed) return;
    chunks.push(chunk);
    size += chunk.length;
    if (size < need) return;
    const pending = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, size);
    let offset = 0;
    while (pending.length - offset >= HEADER) {
      const length = pending.readUInt32BE(offset + 5);
      if (length > maxPayload) return fail(length);
      if (pending.length - offset < HEADER + length) break;
      // Copied, so a payload kept by a socket does not pin the whole chunk.
      onFrame(
        pending.readUInt8(offset),
        pending.readUInt32BE(offset + 1),
        Buffer.from(pending.subarray(offset + HEADER, offset + HEADER + length)),
      );
      if (failed) return;
      offset += HEADER + length;
    }
    const rest = pending.subarray(offset);
    chunks = rest.length ? [rest] : [];
    size = rest.length;
    need = rest.length >= HEADER ? HEADER + rest.readUInt32BE(5) : HEADER;
  };
}

export function readFrames(
  input: Readable,
  onFrame: FrameHandler,
  onError?: (error: Error) => void,
): void {
  input.on("data", createFrameDecoder(onFrame, onError));
}
