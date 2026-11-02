import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { badRequest } from './errors.js';

/**
 * File storage port. Local disk for development; implement the same interface over
 * S3 / Azure Blob / GCS for production (only these three methods are needed).
 */
export interface FileStorage {
  put(buf: Buffer, ext: string): Promise<{ key: string; sha256: string }>;
  read(key: string): Readable;
  remove(key: string): Promise<void>;
}

export function localStorage(root: string): FileStorage {
  const abs = path.resolve(root);
  const resolveKey = (key: string) => {
    const p = path.resolve(abs, key);
    if (!p.startsWith(abs + path.sep)) throw badRequest('Invalid file key');
    return p;
  };
  return {
    async put(buf, ext) {
      const sha256 = createHash('sha256').update(buf).digest('hex');
      const key = `${new Date().toISOString().slice(0, 7)}/${randomUUID()}${ext}`;
      const target = resolveKey(key);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, buf, { flag: 'wx' });
      return { key, sha256 };
    },
    read: (key) => createReadStream(resolveKey(key)),
    remove: (key) => rm(resolveKey(key), { force: true }),
  };
}

/**
 * Detects the real file type from magic bytes — never trust the client's
 * Content-Type or file extension.
 */
export function sniffFileType(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length < 4) return null;
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', ext: '.pdf' };
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG') return { mime: 'image/png', ext: '.png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' };
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP')
    return { mime: 'image/webp', ext: '.webp' };
  return null;
}
