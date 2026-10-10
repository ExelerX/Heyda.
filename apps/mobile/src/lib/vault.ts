import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { bytesToHex, bytesToUtf8, hexToBytes, randomBytes, utf8ToBytes } from '@noble/ciphers/utils.js';
import { File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';

/**
 * Local storage for everything the app knows (contacts, places, rules, chats).
 *
 * Files are encrypted with XChaCha20-Poly1305. The key lives in the OS keychain /
 * keystore, readable after the first unlock so background location tasks still work,
 * and never included in device backups ("this device only").
 */
export interface Vault {
  load<T>(name: string): Promise<T | undefined>;
  save(name: string, value: unknown): Promise<void>;
  /** The device's transport identity, created on first use. */
  secretKey(): Promise<Uint8Array>;
  /** Deletes all local data and keys. */
  wipe(names: string[]): Promise<void>;
}

const KEYCHAIN = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const STORAGE_KEY_ITEM = 'socialapp.storage-key.v1';
const IDENTITY_ITEM = 'socialapp.identity.v1';
const FORMAT_VERSION = 1;

async function getOrCreate(item: string): Promise<Uint8Array> {
  const existing = await SecureStore.getItemAsync(item, KEYCHAIN);
  if (existing) return hexToBytes(existing);
  const fresh = randomBytes(32);
  await SecureStore.setItemAsync(item, bytesToHex(fresh), KEYCHAIN);
  return fresh;
}

export class EncryptedFileVault implements Vault {
  private key: Promise<Uint8Array> | undefined;

  private storageKey(): Promise<Uint8Array> {
    this.key ??= getOrCreate(STORAGE_KEY_ITEM);
    return this.key;
  }

  private file(name: string): File {
    if (!/^[a-z0-9-]{1,40}$/.test(name)) throw new Error('invalid vault entry name');
    return new File(Paths.document, `${name}.bin`);
  }

  async load<T>(name: string): Promise<T | undefined> {
    const file = this.file(name);
    if (!file.exists) return undefined;
    const data = await file.bytes();
    if (data[0] !== FORMAT_VERSION || data.length < 1 + 24 + 16) throw new Error(`${name}: unknown format`);
    const nonce = data.subarray(1, 25);
    const plain = xchacha20poly1305(await this.storageKey(), nonce).decrypt(data.subarray(25));
    return JSON.parse(bytesToUtf8(plain)) as T;
  }

  async save(name: string, value: unknown): Promise<void> {
    const nonce = randomBytes(24);
    const sealed = xchacha20poly1305(await this.storageKey(), nonce).encrypt(utf8ToBytes(JSON.stringify(value)));
    const out = new Uint8Array(1 + nonce.length + sealed.length);
    out[0] = FORMAT_VERSION;
    out.set(nonce, 1);
    out.set(sealed, 1 + nonce.length);
    this.file(name).write(out);
  }

  secretKey(): Promise<Uint8Array> {
    return getOrCreate(IDENTITY_ITEM);
  }

  async wipe(names: string[]): Promise<void> {
    for (const n of names) {
      const f = this.file(n);
      if (f.exists) f.delete();
    }
    await SecureStore.deleteItemAsync(STORAGE_KEY_ITEM, KEYCHAIN);
    await SecureStore.deleteItemAsync(IDENTITY_ITEM, KEYCHAIN);
    this.key = undefined;
  }
}

/** For the web preview and demo mode: nothing is written anywhere. */
export class MemoryVault implements Vault {
  private readonly data = new Map<string, string>();
  private readonly key = randomBytes(32);

  async load<T>(name: string): Promise<T | undefined> {
    const raw = this.data.get(name);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }

  async save(name: string, value: unknown): Promise<void> {
    this.data.set(name, JSON.stringify(value));
  }

  async secretKey(): Promise<Uint8Array> {
    return this.key;
  }

  async wipe(): Promise<void> {
    this.data.clear();
  }
}
