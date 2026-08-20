import fs from 'node:fs';
import path from 'node:path';
import { getEnv } from '../config/env';
import { AppError } from '../lib/errors';

/**
 * Private file storage behind an adapter:
 *  - production: Replit App Storage (APP_STORAGE_BUCKET_ID). When it is not
 *    configured, uploads fail closed with STORAGE_NOT_CONFIGURED and the
 *    attachments UI stays hidden — nothing is faked and the ephemeral
 *    filesystem is never used for production documents.
 *  - development: local .attachments-dev directory (gitignored)
 *  - test: isolated .attachments-test directory, wiped per run
 */
export interface StorageAdapter {
  readonly mode: 'replit' | 'local' | 'test';
  readonly available: boolean;
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

class LocalDirAdapter implements StorageAdapter {
  readonly available = true;
  constructor(
    readonly mode: 'local' | 'test',
    private readonly dir: string,
  ) {}
  private resolve(key: string): string {
    if (!/^[a-f0-9]{32,64}$/.test(key)) throw AppError.badRequest('Invalid storage key');
    return path.join(this.dir, key);
  }
  async put(key: string, data: Buffer): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    await fs.promises.writeFile(this.resolve(key), data);
  }
  async get(key: string): Promise<Buffer> {
    try {
      return await fs.promises.readFile(this.resolve(key));
    } catch {
      throw AppError.notFound('Stored file not found');
    }
  }
  async remove(key: string): Promise<void> {
    await fs.promises.unlink(this.resolve(key)).catch(() => {});
  }
}

class ReplitAdapter implements StorageAdapter {
  readonly mode = 'replit' as const;
  readonly available = true;
  private clientPromise: Promise<{
    uploadFromBytes(key: string, data: Buffer): Promise<{ ok: boolean; error?: unknown }>;
    downloadAsBytes(key: string): Promise<{ ok: boolean; value?: Buffer[]; error?: unknown }>;
    delete(key: string): Promise<{ ok: boolean }>;
  }> | null = null;

  constructor(private readonly bucketId: string) {}

  private async client() {
    if (!this.clientPromise) {
      this.clientPromise = import('@replit/object-storage').then(
        (mod) => new mod.Client({ bucketId: this.bucketId }),
      );
    }
    return this.clientPromise;
  }
  async put(key: string, data: Buffer): Promise<void> {
    const c = await this.client();
    const result = await c.uploadFromBytes(key, data);
    if (!result.ok) throw AppError.internal('Storage upload failed');
  }
  async get(key: string): Promise<Buffer> {
    const c = await this.client();
    const result = await c.downloadAsBytes(key);
    if (!result.ok || !result.value?.[0]) throw AppError.notFound('Stored file not found');
    return result.value[0];
  }
  async remove(key: string): Promise<void> {
    const c = await this.client();
    await c.delete(key);
  }
}

const unavailableAdapter: StorageAdapter = {
  mode: 'replit',
  available: false,
  async put() {
    throw AppError.serviceUnavailable(
      'STORAGE_NOT_CONFIGURED',
      'File storage is not configured (APP_STORAGE_BUCKET_ID); attachments are unavailable',
    );
  },
  async get() {
    throw AppError.serviceUnavailable('STORAGE_NOT_CONFIGURED', 'File storage is not configured');
  },
  async remove() {
    throw AppError.serviceUnavailable('STORAGE_NOT_CONFIGURED', 'File storage is not configured');
  },
};

let adapter: StorageAdapter | null = null;

export function getStorage(): StorageAdapter {
  if (adapter) return adapter;
  const env = getEnv();
  if (env.NODE_ENV === 'test') {
    adapter = new LocalDirAdapter('test', path.resolve('.attachments-test'));
  } else if (env.NODE_ENV === 'production') {
    adapter = env.APP_STORAGE_BUCKET_ID
      ? new ReplitAdapter(env.APP_STORAGE_BUCKET_ID)
      : unavailableAdapter;
  } else {
    adapter = env.APP_STORAGE_BUCKET_ID
      ? new ReplitAdapter(env.APP_STORAGE_BUCKET_ID)
      : new LocalDirAdapter('local', path.resolve('.attachments-dev'));
  }
  return adapter;
}
