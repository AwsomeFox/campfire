import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { BadRequestException } from '@nestjs/common';

/** Limits are deliberately independent of Multer's compressed upload limit. */
export const MAX_ARCHIVE_COMPRESSED_BYTES = 1024 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 100_000;
export const MAX_ENTRY_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
export const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024;
/** Compact JSON budget for one checksum attachment record (ids, path, MIME, hash, and keys). */
export const MAX_MANIFEST_ATTACHMENT_RECORD_BYTES = 512;
/** Manifest metadata plus up to 500 reconciliation orphan paths. */
export const MAX_MANIFEST_FIXED_BYTES = 2 * 1024 * 1024;
/**
 * Supports the archive entry ceiling's full attachment scale while remaining a
 * bounded fraction of the 512 MiB per-entry and 4 GiB total archive limits.
 * The writer uses this exact value before appending manifest.json.
 */
export const MAX_MANIFEST_BYTES =
  MAX_MANIFEST_FIXED_BYTES + MAX_ARCHIVE_ENTRIES * MAX_MANIFEST_ATTACHMENT_RECORD_BYTES;
export const MAX_KEY_ENVELOPE_BYTES = 1024 * 1024;

function invalid(message: string): never {
  throw new BadRequestException(`Invalid backup archive — ${message}`);
}

function safeEntryName(name: string): void {
  // ZIP names always use '/', never platform path separators. Rejecting '\\'
  // keeps Windows restores safe too, rather than normalising an attacker input.
  if (!name || name.includes('\0') || name.includes('\\') || path.posix.isAbsolute(name)) {
    invalid('unsafe entry path');
  }
  const parts = name.split('/');
  // A ZIP directory entry may have one trailing slash. Every other segment
  // must be a real name so aliases such as `uploads//a` and `uploads/./a`
  // cannot bypass raw-name duplicate checks.
  const last = parts.length - 1;
  if (parts.some((part, index) => part === '..' || part === '.' || (part === '' && index !== last))) {
    invalid('unsafe entry path');
  }
}

function openZip(filePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) reject(err ?? new Error('Unable to open ZIP'));
      else resolve(zip);
    });
  });
}

/**
 * A file-backed ZIP reader. It reads only central-directory records during
 * construction; entry payloads are opened one at a time and never buffered by
 * this class. Callers must consume every wanted entry before close().
 */
export interface BackupArchiveReaderLimits {
  maxCompressedBytes: number;
  maxEntries: number;
  maxEntryUncompressedBytes: number;
  maxTotalUncompressedBytes: number;
}

const DEFAULT_LIMITS: BackupArchiveReaderLimits = Object.freeze({
  maxCompressedBytes: MAX_ARCHIVE_COMPRESSED_BYTES,
  maxEntries: MAX_ARCHIVE_ENTRIES,
  maxEntryUncompressedBytes: MAX_ENTRY_UNCOMPRESSED_BYTES,
  maxTotalUncompressedBytes: MAX_ARCHIVE_UNCOMPRESSED_BYTES,
});

const SYSTEM_IO_ERROR_CODES = new Set([
  'EACCES',
  'EBADF',
  'EIO',
  'EMFILE',
  'ENFILE',
  'ENOENT',
  'ENOSPC',
  'EPERM',
  'EROFS',
]);

function isSystemIoError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string' &&
    SYSTEM_IO_ERROR_CODES.has((err as NodeJS.ErrnoException).code!);
}

export class BackupArchiveReader {
  private actualTotal = 0;
  private constructor(
    private readonly zip: ZipFile,
    readonly entries: readonly Entry[],
    private readonly limits: BackupArchiveReaderLimits,
  ) {}

  private accountActual(bytes: number): boolean {
    this.actualTotal += bytes;
    return this.actualTotal <= this.limits.maxTotalUncompressedBytes;
  }

  static async open(
    filePath: string,
    signal?: AbortSignal,
    overrides?: Partial<BackupArchiveReaderLimits>,
  ): Promise<BackupArchiveReader> {
    const limits = { ...DEFAULT_LIMITS, ...overrides };
    let stat: fs.Stats;
    try { stat = await fs.promises.stat(filePath); } catch { invalid('uploaded archive is unavailable'); }
    if (!stat.isFile() || stat.size > limits.maxCompressedBytes) {
      const limit = limits.maxCompressedBytes === DEFAULT_LIMITS.maxCompressedBytes
        ? '1 GiB'
        : `${limits.maxCompressedBytes} byte${limits.maxCompressedBytes === 1 ? '' : 's'}`;
      invalid(`archive exceeds the ${limit} compressed size limit`);
    }
    if (signal?.aborted) invalid('archive read was cancelled');
    let zip: ZipFile;
    try { zip = await openZip(filePath); } catch { invalid('not a readable zip file'); }
    if (signal?.aborted) {
      zip.close();
      invalid('archive read was cancelled');
    }
    const entries: Entry[] = [];
    const names = new Set<string>();
    let declaredTotal = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          signal?.removeEventListener('abort', abort);
          zip.removeListener('error', fail);
          zip.removeListener('entry', onEntry);
          zip.removeListener('end', onEnd);
        };
        const fail = (err: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        };
        const abort = () => fail(new Error('aborted'));
        const onEnd = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };
        const onEntry = (entry: Entry) => {
          try {
            const entryCount = entries.length + 1;
            if (entryCount > limits.maxEntries) invalid('too many entries');
            // yauzl may canonicalize a filename through Unicode metadata or
            // backslash normalization. Its canonical name is the one used for
            // lookup and restore, so apply both safety and uniqueness checks to
            // that name. Inspect the raw bytes separately for characters that
            // canonicalization must never be allowed to conceal.
            const rawName = (entry as Entry & { fileNameRaw?: Buffer }).fileNameRaw;
            if (rawName?.includes(0x00) || rawName?.includes(0x5c)) invalid('unsafe entry path');
            const canonicalName = entry.fileName;
            safeEntryName(canonicalName);
            if (names.has(canonicalName)) invalid('duplicate entry name');
            names.add(canonicalName);
            if ((entry.generalPurposeBitFlag & 0x1) !== 0) invalid('encrypted entries are not supported');
            if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) invalid('unsupported compression method');
            if (entry.uncompressedSize > limits.maxEntryUncompressedBytes) invalid('entry exceeds the uncompressed size limit');
            declaredTotal += entry.uncompressedSize;
            if (declaredTotal > limits.maxTotalUncompressedBytes) invalid('archive exceeds the total uncompressed size limit');
            entries.push(entry);
            zip.readEntry();
          } catch (err) { fail(err); }
        };
        signal?.addEventListener('abort', abort, { once: true });
        zip.once('error', fail);
        zip.on('entry', onEntry);
        zip.once('end', onEnd);
        zip.readEntry();
      });
      return new BackupArchiveReader(zip, entries, limits);
    } catch (err) {
      zip.close();
      if (err instanceof BadRequestException) throw err;
      invalid(signal?.aborted ? 'archive read was cancelled' : 'malformed or truncated zip file');
    }
  }

  get(name: string): Entry | undefined { return this.entries.find((entry) => entry.fileName === name); }

  async readBuffer(entry: Entry, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let actual = 0;
    await this.stream(entry, async (source) => {
      for await (const chunk of source) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        actual += bytes.length;
        if (!this.accountActual(bytes.length) || actual > maxBytes || actual > this.limits.maxEntryUncompressedBytes) throw new Error('entry limit exceeded');
        chunks.push(bytes);
      }
    }, signal);
    return Buffer.concat(chunks, actual);
  }

  async extractToFile(entry: Entry, destination: string, signal?: AbortSignal): Promise<{ bytes: number; sha256: string }> {
    await fs.promises.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    let actual = 0;
    const hash = createHash('sha256');
    try {
      await this.stream(entry, async (source) => {
        const limiter = new Transform({
          transform: (chunk: Buffer, _encoding, callback) => {
            actual += chunk.length;
            if (!this.accountActual(chunk.length) || actual > this.limits.maxEntryUncompressedBytes) {
              callback(new Error('entry limit exceeded'));
              return;
            }
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        // Create the destination only as pipeline takes ownership, after the
        // ZIP source has opened, so every filesystem error has a listener.
        await pipeline(
          source,
          limiter,
          fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
          { signal },
        );
      }, signal);
      return { bytes: actual, sha256: hash.digest('hex') };
    } catch (err) {
      await fs.promises.rm(destination, { force: true });
      throw err;
    }
  }

  /** Stream an entry through the archive limits and digest it without buffering it. */
  async hashEntry(entry: Entry, signal?: AbortSignal): Promise<{ bytes: number; sha256: string }> {
    let actual = 0;
    const hash = createHash('sha256');
    await this.stream(entry, async (source) => {
      for await (const chunk of source) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        actual += bytes.length;
        if (!this.accountActual(bytes.length) || actual > this.limits.maxEntryUncompressedBytes) {
          throw new Error('entry limit exceeded');
        }
        hash.update(bytes);
      }
    }, signal);
    return { bytes: actual, sha256: hash.digest('hex') };
  }

  private async stream(entry: Entry, consume: (source: Readable) => Promise<void>, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) invalid('archive read was cancelled');
    let source: Readable | null = null;
    const abort = () => source?.destroy(new Error('aborted'));
    try {
      source = await new Promise<Readable>((resolve, reject) => this.zip.openReadStream(entry, (err, stream) => err || !stream ? reject(err ?? new Error('Cannot open entry')) : resolve(stream)));
      signal?.addEventListener('abort', abort, { once: true });
      // Cancellation can occur while openReadStream's callback is pending. Abort
      // events are not replayed to a listener registered after they fire, so
      // close the newly opened source before any restore bytes are consumed.
      if (signal?.aborted) {
        source.destroy();
        invalid('archive read was cancelled');
      }
      await consume(source);
    }
    catch (err) {
      if (err instanceof BadRequestException) throw err;
      if (isSystemIoError(err)) throw err;
      invalid(signal?.aborted ? 'archive read was cancelled' : 'entry is malformed, truncated, or exceeds its size limit');
    } finally { signal?.removeEventListener('abort', abort); }
  }

  close(): void { this.zip.close(); }
}
