import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';

/**
 * Password-protected backup file, e.g. for moving to a new phone.
 *
 * Layout: "HYB1" | logN | r | p | salt (16) | nonce (24) | XChaCha20-Poly1305 ciphertext.
 * The header is authenticated as associated data, so it cannot be altered unnoticed.
 * The key comes from scrypt; parameters read from a file are bounded so a crafted file
 * cannot make the app allocate gigabytes.
 */
const MAGIC = [0x48, 0x59, 0x42, 0x31]; // "HYB1"
const HEADER_LEN = 4 + 3 + 16 + 24;
export const BACKUP_MIN_PASSWORD = 10;
export const BACKUP_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_LOG_N = 15;

export interface BackupContents {
  format: 'heyda.backup';
  v: 1;
  createdAt: number;
  /** Hex secret key of the account. */
  identity: string;
  /** App data, as the app chooses to store it. */
  data: unknown;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

async function deriveKey(password: string, salt: Uint8Array, logN: number, r: number, p: number, onProgress?: (f: number) => void) {
  return scryptAsync(password.normalize('NFKC'), salt, { N: 2 ** logN, r, p, dkLen: 32, onProgress });
}

export async function encryptBackup(
  contents: BackupContents,
  password: string,
  options: { logN?: number; onProgress?: (fraction: number) => void } = {},
): Promise<Uint8Array> {
  if ([...password].length < BACKUP_MIN_PASSWORD) throw new RangeError(`Passwort: mindestens ${BACKUP_MIN_PASSWORD} Zeichen`);
  const logN = options.logN ?? DEFAULT_LOG_N;
  if (!Number.isInteger(logN) || logN < 14 || logN > 18) throw new RangeError('logN must be 14..18');
  const salt = randomBytes(16);
  const nonce = randomBytes(24);
  const header = new Uint8Array(HEADER_LEN);
  header.set(MAGIC, 0);
  header.set([logN, 8, 1], 4);
  header.set(salt, 7);
  header.set(nonce, 23);
  const key = await deriveKey(password, salt, logN, 8, 1, options.onProgress);
  const plain = new TextEncoder().encode(JSON.stringify(contents));
  const sealed = xchacha20poly1305(key, nonce, header).encrypt(plain);
  key.fill(0);
  const out = new Uint8Array(HEADER_LEN + sealed.length);
  out.set(header, 0);
  out.set(sealed, HEADER_LEN);
  if (out.length > BACKUP_MAX_BYTES) throw new RangeError('Backup ist zu groß');
  return out;
}

export type DecryptBackupResult = { ok: true; contents: BackupContents } | { ok: false; error: string };

export async function decryptBackup(
  file: Uint8Array,
  password: string,
  onProgress?: (fraction: number) => void,
): Promise<DecryptBackupResult> {
  if (file.length > BACKUP_MAX_BYTES) return { ok: false, error: 'Die Datei ist zu groß.' };
  if (file.length < HEADER_LEN + 16 || MAGIC.some((b, i) => file[i] !== b)) {
    return { ok: false, error: 'Das ist keine Heyda.-Sicherung.' };
  }
  const [logN, r, p] = [file[4]!, file[5]!, file[6]!];
  if (logN < 14 || logN > 18 || r !== 8 || p !== 1) return { ok: false, error: 'Unbekanntes Sicherungsformat.' };
  const header = file.subarray(0, HEADER_LEN);
  const salt = file.subarray(7, 23);
  const nonce = file.subarray(23, 47);
  const key = await deriveKey(password, salt, logN, r, p, onProgress);
  let plain: Uint8Array;
  try {
    plain = xchacha20poly1305(key, nonce, header).decrypt(file.subarray(HEADER_LEN));
  } catch {
    return { ok: false, error: 'Falsches Passwort oder beschädigte Datei.' };
  } finally {
    key.fill(0);
  }
  try {
    const json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)) as Partial<BackupContents>;
    if (json.format !== 'heyda.backup' || json.v !== 1 || typeof json.identity !== 'string' || !/^[0-9a-f]{64}$/.test(json.identity)) {
      return { ok: false, error: 'Unbekanntes Sicherungsformat.' };
    }
    return { ok: true, contents: json as BackupContents };
  } catch {
    return { ok: false, error: 'Die Sicherung ist beschädigt.' };
  }
}
