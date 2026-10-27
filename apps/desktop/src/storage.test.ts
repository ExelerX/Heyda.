import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStore, SecretStore, storageFileName, writeFileAtomic } from './storage';
import type { SecretCipher } from './storage';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'heyda-store-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  it('replaces the file and leaves no temp files', async () => {
    const file = path.join(dir, 'x.bin');
    await writeFileAtomic(file, Buffer.from('one'));
    await writeFileAtomic(file, Buffer.from('two'));
    expect(await readFile(file, 'utf8')).toBe('two');
    expect(await readdir(dir)).toEqual(['x.bin']);
  });
});

describe('FileStore', () => {
  it('reads what it wrote and returns null for missing names', async () => {
    const store = new FileStore(path.join(dir, 'vault'));
    expect(await store.read('state')).toBeNull();
    await store.write('state', Buffer.from([1, 2, 3]));
    expect(await store.read('state')).toEqual(Buffer.from([1, 2, 3]));
  });

  it('deletes idempotently', async () => {
    const store = new FileStore(dir);
    await store.write('state', Buffer.from('x'));
    await store.delete('state');
    await store.delete('state');
    expect(await store.read('state')).toBeNull();
  });

  it('keeps Windows device names away from the file system', async () => {
    const store = new FileStore(dir);
    await store.write('con', Buffer.from('x'));
    expect(storageFileName('con')).toBe('h-con.bin');
    expect(await readdir(dir)).toEqual(['h-con.bin']);
  });

  it('applies concurrent operations on one name in call order', async () => {
    const store = new FileStore(dir);
    const big = Buffer.alloc(4 * 1024 * 1024, 1);
    const writes = [store.write('state', big), store.write('state', Buffer.from('last'))];
    const readAfter = store.read('state');
    await Promise.all(writes);
    expect((await readAfter)?.toString()).toBe('last');
    expect(await readdir(dir)).toEqual(['h-state.bin']);
  });

  it('cleans up after a failed write and keeps serving the name', async () => {
    const store = new FileStore(dir);
    await expect(store.write('state', null as unknown as Uint8Array)).rejects.toThrow();
    await store.write('state', Buffer.from('ok'));
    expect((await store.read('state'))?.toString()).toBe('ok');
    expect(await readdir(dir)).toEqual(['h-state.bin']);
  });

  it('removes temp files left by a crash', async () => {
    const store = new FileStore(dir);
    await store.write('state', Buffer.from('x'));
    await writeFile(path.join(dir, 'h-state.bin.0a1b2c.tmp'), 'partial');
    await store.removeStaleTempFiles();
    expect(await readdir(dir)).toEqual(['h-state.bin']);
  });
});

describe('SecretStore', () => {
  const reversingCipher: SecretCipher = {
    encrypt: (plain) => Buffer.from(`enc:${[...plain].reverse().join('')}`),
    decrypt: (data) => {
      const text = data.toString();
      if (!text.startsWith('enc:')) throw new Error('bad data');
      return [...text.slice(4)].reverse().join('');
    },
  };

  it('stores only encrypted bytes', async () => {
    const files = new FileStore(dir);
    const secrets = new SecretStore(files, () => reversingCipher);
    await secrets.set('nostr.key', 'top-secret');
    expect(await secrets.get('nostr.key')).toBe('top-secret');
    const raw = await readFile(path.join(dir, storageFileName('nostr.key')), 'utf8');
    expect(raw).not.toContain('top-secret');
    await secrets.delete('nostr.key');
    expect(await secrets.get('nostr.key')).toBeNull();
  });

  it('writes nothing when encryption is unavailable', async () => {
    const secrets = new SecretStore(new FileStore(dir), () => {
      throw new Error('safeStorage unavailable');
    });
    await expect(secrets.set('nostr.key', 'top-secret')).rejects.toThrow('safeStorage unavailable');
    expect(await readdir(dir)).toEqual([]);
  });
});
