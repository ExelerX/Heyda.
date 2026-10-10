const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

/**
 * URL-safe random id from the platform CSPRNG.
 * React Native needs a `crypto.getRandomValues` polyfill (expo-crypto) loaded first;
 * there is deliberately no Math.random fallback.
 */
export function randomId(length = 22): string {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj?.getRandomValues) throw new Error('crypto.getRandomValues is not available');
  const bytes = new Uint8Array(length);
  cryptoObj.getRandomValues(bytes);
  let out = '';
  // 64 symbols divide 256 evenly, so `& 63` has no modulo bias.
  for (const b of bytes) out += ALPHABET[b & 63];
  return out;
}
