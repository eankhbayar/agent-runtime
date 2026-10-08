import { describe, expect, it } from "vitest";

import { createFrameDecoder, DATA, encodeData, encodeFrame, END, MAX_FRAME_PAYLOAD, OPEN } from "./frames.ts";
import { ExitMarkerReader, newExitMarker, splitExitMarker } from "./exit-marker.ts";

function read(chunks: string[], marker: string) {
  let out = "";
  const forwarded: string[] = [];
  const reader = new ExitMarkerReader(marker, (text) => {
    out += text;
    forwarded.push(text);
  });
  for (const chunk of chunks) reader.push(chunk);
  return { code: reader.end(), out, forwarded };
}

describe("ExitMarkerReader", () => {
  const marker = newExitMarker();
  const stream = `{"seq":0}\n{"seq":1}\n${marker}7\n`;

  it("strips the marker and reads the code, however the output is split", () => {
    for (let at = 0; at <= stream.length; at++) {
      for (let second = at; second <= stream.length; second += 7) {
        const chunks = [stream.slice(0, at), stream.slice(at, second), stream.slice(second)];
        expect(read(chunks, marker)).toMatchObject({ code: 7, out: '{"seq":0}\n{"seq":1}\n' });
      }
    }
  });

  it("finds the marker after output that did not end its line", () => {
    expect(read([`partial${marker}0\n`], marker)).toMatchObject({ code: 0, out: "partial" });
  });

  it("passes a finished line on at once, holding back only what could be the marker", () => {
    const { forwarded } = read(['{"seq":0}\n', "__AR", "_ not it\n"], marker);
    expect(forwarded).toEqual(['{"seq":0}\n', "__AR_ not it\n"]);
  });

  it("has no code when no marker came, and loses none of the output", () => {
    expect(read(["out", "put __AR_EXIT"], marker)).toEqual({
      code: null,
      out: "output __AR_EXIT",
      forwarded: ["out", "put ", "__AR_EXIT"],
    });
  });

  it("ignores another command's marker", () => {
    expect(read([`${newExitMarker()}3\n`, `${marker}4\n`], marker).code).toBe(4);
  });
});

describe("splitExitMarker", () => {
  it("splits binary output from its marker", () => {
    const marker = newExitMarker();
    const body = Buffer.from([0, 1, 2, 255, 10]);
    expect(splitExitMarker(Buffer.concat([body, Buffer.from(`${marker}0\n`)]), marker)).toEqual({
      body,
      code: 0,
    });
    expect(splitExitMarker(body, marker)).toEqual({ body, code: null });
  });
});

describe("tunnel frames", () => {
  it("decodes frames however the bytes are split", () => {
    const frames = Buffer.concat([
      encodeFrame(OPEN, 1),
      encodeFrame(DATA, 1, Buffer.from("hello")),
      encodeFrame(DATA, 2, Buffer.alloc(70_000, 7)),
      encodeFrame(END, 1),
    ]);
    for (const size of [1, 5, 9, 4096, frames.length]) {
      const seen: [number, number, number][] = [];
      const decode = createFrameDecoder((type, id, payload) => seen.push([type, id, payload.length]));
      for (let i = 0; i < frames.length; i += size) decode(frames.subarray(i, i + size));
      expect(seen).toEqual([
        [OPEN, 1, 0],
        [DATA, 1, 5],
        [DATA, 2, 70_000],
        [END, 1, 0],
      ]);
    }
  });

  it("refuses a frame over the limit as soon as its header arrives, and splits large data to fit", () => {
    const errors: string[] = [];
    const seen: number[] = [];
    const decode = createFrameDecoder((type) => seen.push(type), (e) => errors.push(e.message));
    const head = Buffer.alloc(9);
    head.writeUInt8(DATA, 0);
    head.writeUInt32BE(1, 1);
    head.writeUInt32BE(MAX_FRAME_PAYLOAD + 1, 5);
    decode(Buffer.concat([encodeFrame(OPEN, 1), head]));
    decode(encodeFrame(END, 1));
    expect(seen).toEqual([OPEN]);
    expect(errors).toHaveLength(1);

    const frames: number[] = [];
    const ok = createFrameDecoder((_t, _i, payload) => frames.push(payload.length));
    ok(encodeData(2, Buffer.alloc(3 * MAX_FRAME_PAYLOAD)));
    expect(frames.reduce((a, b) => a + b, 0)).toBe(3 * MAX_FRAME_PAYLOAD);
    expect(Math.max(...frames)).toBeLessThanOrEqual(MAX_FRAME_PAYLOAD);
  });
});
