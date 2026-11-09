// Minimal PNG writer for the static pictures the export composites (rounded cards, corner masks).
import zlib from "node:zlib";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 8-bit PNG from raw pixels: 1 channel = grayscale, 4 = RGBA. */
export function encodePng(width: number, height: number, channels: 1 | 4, pixels: Uint8Array): Buffer {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 1 ? 0 : 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Anti-aliased coverage (0–255) of a w×h rectangle with corner radius r, row by row. */
export function roundedRectCoverage(w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const rad = Math.min(r, w / 2, h / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Signed distance from the pixel centre to the rounded rectangle's edge.
      const qx = Math.abs(x + 0.5 - w / 2) - (w / 2 - rad);
      const qy = Math.abs(y + 0.5 - h / 2) - (h / 2 - rad);
      const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad;
      out[y * w + x] = Math.round(Math.min(1, Math.max(0, 0.5 - d)) * 255);
    }
  }
  return out;
}

/** A filled rounded card: RGBA PNG in `hex` at `opacity`. */
export function roundedCardPng(w: number, h: number, r: number, hex: string, opacity: number): Buffer {
  const cover = roundedRectCoverage(w, h, r);
  const [red, green, blue] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < cover.length; i++) {
    px.set([red, green, blue, Math.round(cover[i] * opacity)], i * 4);
  }
  return encodePng(w, h, 4, px);
}

/** White RGBA picture whose alpha is the rounded shape: multiplied into a picture's own alpha. */
export function roundedMaskPng(w: number, h: number, r: number): Buffer {
  return roundedCardPng(w, h, r, "#ffffff", 1);
}
