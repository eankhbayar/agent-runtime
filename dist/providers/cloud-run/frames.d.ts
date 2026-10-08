import type { Readable } from "node:stream";
export declare const OPEN = 1;
export declare const DATA = 2;
export declare const END = 3;
/** The largest payload either side sends or accepts; DATA is split to fit. */
export declare const MAX_FRAME_PAYLOAD: number;
export declare function encodeFrame(type: number, id: number, payload?: Uint8Array): Buffer;
/** DATA frames for a chunk of any size, each well under the cap. */
export declare function encodeData(id: number, chunk: Uint8Array): Buffer;
export type FrameHandler = (type: number, id: number, payload: Buffer) => void;
/**
 * Calls `onFrame` for each whole frame, however the bytes were split. A
 * frame longer than `maxPayload` calls `onError` once and ends decoding, so a
 * hostile sender cannot make it hold more than one frame's worth.
 */
export declare function createFrameDecoder(onFrame: FrameHandler, onError?: (error: Error) => void, maxPayload?: number): (chunk: Buffer) => void;
export declare function readFrames(input: Readable, onFrame: FrameHandler, onError?: (error: Error) => void): void;
