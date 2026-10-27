import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32, redDotPng } from './badge';

function chunks(png: Buffer): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    expect(png.readUInt32BE(offset + 8 + length)).toBe(crc32(png.subarray(offset + 4, offset + 8 + length)));
    result.set(type, data);
    offset += length + 12;
  }
  return result;
}

describe('redDotPng', () => {
  it('is a valid RGBA PNG with an opaque red center and transparent corners', () => {
    const size = 32;
    const png = redDotPng(size);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const parts = chunks(png);
    const header = parts.get('IHDR')!;
    expect(header.readUInt32BE(0)).toBe(size);
    expect(header.readUInt32BE(4)).toBe(size);
    expect(header[9]).toBe(6);
    expect(parts.has('IEND')).toBe(true);

    const pixels = inflateSync(parts.get('IDAT')!);
    const stride = size * 4 + 1;
    expect(pixels.length).toBe(stride * size);
    const pixel = (x: number, y: number) => [...pixels.subarray(y * stride + 1 + x * 4, y * stride + 5 + x * 4)];
    expect(pixel(16, 16)).toEqual([0xe5, 0x48, 0x4d, 255]);
    expect(pixel(0, 0)[3]).toBe(0);
    expect(pixel(31, 31)[3]).toBe(0);
  });

  it('computes the standard CRC-32', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('rejects silly sizes', () => {
    expect(() => redDotPng(0)).toThrow(RangeError);
    expect(() => redDotPng(1.5)).toThrow(RangeError);
  });
});
