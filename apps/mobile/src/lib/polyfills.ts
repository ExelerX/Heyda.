// Must run before anything touches crypto: nostr-tools and @noble/* call
// crypto.getRandomValues, which React Native does not ship.
import 'react-native-get-random-values';

/**
 * Minimal UTF-8 TextEncoder/TextDecoder, installed only if the JS engine lacks them.
 * nostr-tools needs both; older Hermes builds only have TextEncoder.
 */
type Global = { TextEncoder?: unknown; TextDecoder?: unknown };
const g = globalThis as Global;

if (typeof g.TextEncoder === 'undefined') {
  g.TextEncoder = class {
    readonly encoding = 'utf-8';
    encode(input = ''): Uint8Array {
      const out: number[] = [];
      for (const ch of input) {
        const cp = ch.codePointAt(0)!;
        if (cp < 0x80) out.push(cp);
        else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
        else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      }
      return Uint8Array.from(out);
    }
  };
}

if (typeof g.TextDecoder === 'undefined') {
  g.TextDecoder = class {
    readonly encoding = 'utf-8';
    constructor(label = 'utf-8') {
      if (!/^utf-?8$/i.test(label)) throw new RangeError(`unsupported encoding ${label}`);
    }
    decode(input?: ArrayBuffer | ArrayBufferView): string {
      if (!input) return '';
      const bytes =
        input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      let out = '';
      let i = 0;
      while (i < bytes.length) {
        const b = bytes[i++]!;
        let cp: number;
        if (b < 0x80) cp = b;
        else if (b >= 0xc2 && b < 0xe0 && i < bytes.length) cp = ((b & 0x1f) << 6) | (bytes[i++]! & 0x3f);
        else if (b >= 0xe0 && b < 0xf0 && i + 1 < bytes.length)
          cp = ((b & 0x0f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f);
        else if (b >= 0xf0 && b < 0xf5 && i + 2 < bytes.length)
          cp = ((b & 0x07) << 18) | ((bytes[i++]! & 0x3f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f);
        else cp = 0xfffd; // invalid or truncated sequence
        out += String.fromCodePoint(cp);
      }
      return out;
    }
  };
}
