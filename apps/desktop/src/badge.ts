// Generates the taskbar overlay icon (an anti-aliased red dot) as a PNG, so no binary asset is needed.
import { deflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RED: readonly [number, number, number] = [0xe5, 0x48, 0x4d];

export function redDotPng(size: number): Buffer {
  if (!Number.isInteger(size) || size < 1 || size > 256) throw new RangeError('size must be 1..256');
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(dotPixels(size))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function dotPixels(size: number): Buffer {
  const stride = size * 4 + 1; // +1: filter byte per row
  const pixels = Buffer.alloc(stride * size);
  const radius = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x + 0.5 - radius, y + 0.5 - radius);
      const coverage = Math.min(1, Math.max(0, radius - distance));
      const offset = y * stride + 1 + x * 4;
      pixels[offset] = RED[0];
      pixels[offset + 1] = RED[1];
      pixels[offset + 2] = RED[2];
      pixels[offset + 3] = Math.round(coverage * 255);
    }
  }
  return pixels;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(typeAndData.length + 8);
  out.writeUInt32BE(data.length, 0);
  typeAndData.copy(out, 4);
  out.writeUInt32BE(crc32(typeAndData), out.length - 4);
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
