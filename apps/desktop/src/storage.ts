// File storage for the vault and for OS-encrypted secrets. Pure Node, unit-tested.
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const TEMP_SUFFIX = '.tmp';
// Antivirus scanners and the search indexer briefly lock files on Windows.
const RETRYABLE_FS_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);
const FS_ATTEMPTS = 5;

/**
 * Names are validated by the caller. The prefix keeps them clear of Windows device names
 * (CON, NUL, COM1, ...), which the bridge's name patterns would otherwise allow.
 */
export function storageFileName(name: string): string {
  return `h-${name}.bin`;
}

/** Writes via a temp file in the same directory and a rename, so readers never see partial data. */
export async function writeFileAtomic(file: string, data: Uint8Array): Promise<void> {
  const temp = `${file}.${randomBytes(6).toString('hex')}${TEMP_SUFFIX}`;
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await withRetry(() => fs.rename(temp, file));
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** One file per name in `dir`. Operations on the same name run strictly in call order. */
export class FileStore {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly dir: string) {}

  read(name: string): Promise<Buffer | null> {
    return this.exclusive(name, async () => {
      try {
        return await fs.readFile(this.file(name));
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return null;
        throw error;
      }
    });
  }

  write(name: string, data: Uint8Array): Promise<void> {
    return this.exclusive(name, async () => {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      await writeFileAtomic(this.file(name), data);
    });
  }

  delete(name: string): Promise<void> {
    return this.exclusive(name, () => withRetry(() => fs.rm(this.file(name), { force: true })));
  }

  /** Removes temp files left behind by a crash during a write. */
  async removeStaleTempFiles(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch {
      return;
    }
    const stale = entries.filter((entry) => entry.endsWith(TEMP_SUFFIX));
    await Promise.all(stale.map((entry) => fs.rm(path.join(this.dir, entry), { force: true }).catch(() => undefined)));
  }

  private file(name: string): string {
    return path.join(this.dir, storageFileName(name));
  }

  private exclusive<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(name) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(name, settled);
    void settled.then(() => {
      if (this.queues.get(name) === settled) this.queues.delete(name);
    });
    return result;
  }
}

export interface SecretCipher {
  encrypt(plainText: string): Buffer;
  decrypt(encrypted: Buffer): string;
}

/** Secrets are encrypted by the OS (safeStorage); this class never writes plaintext. */
export class SecretStore {
  constructor(
    private readonly files: FileStore,
    private readonly cipher: () => SecretCipher,
  ) {}

  async get(name: string): Promise<string | null> {
    const encrypted = await this.files.read(name);
    return encrypted === null ? null : this.cipher().decrypt(encrypted);
  }

  async set(name: string, value: string): Promise<void> {
    await this.files.write(name, this.cipher().encrypt(value));
  }

  delete(name: string): Promise<void> {
    return this.files.delete(name);
  }
}

async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= FS_ATTEMPTS || !RETRYABLE_FS_ERRORS.has(errorCode(error) ?? '')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}
