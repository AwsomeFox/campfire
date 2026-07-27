import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import zlib from 'node:zlib';
import yauzl, { type ZipFile } from 'yauzl';
import { BadRequestException } from '@nestjs/common';
import { BackupArchiveReader, type BackupArchiveReaderLimits } from '../../src/modules/backup/backup-archive-reader';

type FixtureEntry = { name: string; data?: Buffer; declared?: number; method?: number; flags?: number };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-reader-test-'));
const low: Partial<BackupArchiveReaderLimits> = {
  maxCompressedBytes: 1024,
  maxEntries: 3,
  maxEntryUncompressedBytes: 8,
  maxTotalUncompressedBytes: 12,
};

function u16(value: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; }
function u32(value: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0); return b; }
function crc(data: Buffer): number {
  let value = 0xffffffff;
  for (const byte of data) { value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}

/** Minimal ZIP fixture writer: central metadata can intentionally disagree with payload. */
function zip(entries: FixtureEntry[]): string {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const input of entries) {
    const name = Buffer.from(input.name); const plain = input.data ?? Buffer.alloc(0);
    const method = input.method ?? 0; const payload = method === 8 ? zlib.deflateRawSync(plain) : plain;
    const declared = input.declared ?? plain.length; const flags = input.flags ?? 0;
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(flags), u16(method), u16(0), u16(0), u32(crc(plain)), u32(payload.length), u32(declared), u16(name.length), u16(0), name, payload]);
    locals.push(local);
    centrals.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(flags), u16(method), u16(0), u16(0), u32(crc(plain)), u32(payload.length), u32(declared), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const out = Buffer.concat([...locals, central, u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(central.length), u32(offset), u16(0)]);
  const file = path.join(tmp, `${crypto.randomUUID()}.zip`); fs.writeFileSync(file, out); return file;
}

async function rejects(file: string, limits = low): Promise<void> {
  await expect(BackupArchiveReader.open(file, undefined, limits)).rejects.toBeInstanceOf(BadRequestException);
}

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('BackupArchiveReader', () => {
  it('rejects duplicate, traversal, backslash, and NUL names', async () => {
    await rejects(zip([{ name: 'a' }, { name: 'a' }]));
    await rejects(zip([{ name: '../db' }]));
    await rejects(zip([{ name: 'uploads\\escape' }]));
    await rejects(zip([{ name: 'bad\0name' }]));
  });

  it('rejects encrypted and unsupported methods', async () => {
    await rejects(zip([{ name: 'a', flags: 1 }]));
    await rejects(zip([{ name: 'a', method: 12 }]));
  });

  it('enforces entry count and declared per-entry/total limits before extraction', async () => {
    await rejects(zip([{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }]));
    await rejects(zip([{ name: 'a', data: Buffer.alloc(9) }]));
    await rejects(zip([{ name: 'a', data: Buffer.alloc(7) }, { name: 'b', data: Buffer.alloc(7) }]));
  });

  it('enforces actual per-entry bytes and removes partial output', async () => {
    const file = zip([{ name: 'db', data: Buffer.alloc(16, 7), declared: 1, method: 8 }]);
    const reader = await BackupArchiveReader.open(file, undefined, low);
    const destination = path.join(tmp, `${crypto.randomUUID()}.db`);
    await expect(reader.extractToFile(reader.get('db')!, destination)).rejects.toBeInstanceOf(BadRequestException);
    expect(fs.existsSync(destination)).toBe(false);
    reader.close();
  });

  it('enforces actual total bytes across streamed entries', async () => {
    const file = zip([{ name: 'a', data: Buffer.alloc(7) }, { name: 'b', data: Buffer.alloc(7) }]);
    const reader = await BackupArchiveReader.open(file, undefined, { ...low, maxEntryUncompressedBytes: 8, maxTotalUncompressedBytes: 20 });
    // The reader's injected limits are deliberately mutable only in this test
    // after central-directory validation, simulating forged metadata that is
    // below the declared cap but exceeds the actual-byte cap while streaming.
    (reader as unknown as { limits: BackupArchiveReaderLimits }).limits.maxTotalUncompressedBytes = 12;
    await reader.readBuffer(reader.get('a')!, 8);
    await expect(reader.readBuffer(reader.get('b')!, 8)).rejects.toBeInstanceOf(BadRequestException);
    reader.close();
  });

  it('rejects malformed/truncated archives and honors abort before opening', async () => {
    const broken = path.join(tmp, `${crypto.randomUUID()}.zip`); fs.writeFileSync(broken, Buffer.from('PK\x03\x04'));
    await rejects(broken);
    const controller = new AbortController(); controller.abort();
    await expect(BackupArchiveReader.open(zip([{ name: 'a' }]), controller.signal, low)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reports the effective compressed-size override', async () => {
    const file = zip([{ name: 'a', data: Buffer.alloc(32) }]);
    await expect(BackupArchiveReader.open(file, undefined, { ...low, maxCompressedBytes: 1 })).rejects.toThrow(
      '1 byte compressed size limit',
    );
  });

  it('closes a stream opened after its cancellation signal fired', async () => {
    let opened: ((error: Error | null, stream?: PassThrough) => void) | undefined;
    const fakeZip = {
      openReadStream: jest.fn((_entry: unknown, callback: (error: Error | null, stream?: PassThrough) => void) => {
        opened = callback;
      }),
      close: jest.fn(),
    };
    const reader = new (BackupArchiveReader as unknown as new (
      zip: typeof fakeZip,
      entries: readonly unknown[],
      limits: BackupArchiveReaderLimits,
    ) => BackupArchiveReader)(fakeZip, [], {
      ...low,
      maxCompressedBytes: 1024,
      maxEntries: 3,
      maxEntryUncompressedBytes: 8,
      maxTotalUncompressedBytes: 12,
    });
    const controller = new AbortController();
    const pending = reader.readBuffer({ fileName: 'delayed' } as never, 8, controller.signal);
    controller.abort();
    const source = new PassThrough();
    opened!(null, source);
    await expect(pending).rejects.toBeInstanceOf(BadRequestException);
    expect(source.destroyed).toBe(true);
  });

  it('closes a ZIP opened after its cancellation signal fired', async () => {
    let opened: ((error: Error | null, zip?: ZipFile) => void) | undefined;
    const open = jest.spyOn(yauzl, 'open').mockImplementation(((
      _file: string,
      _options: yauzl.Options,
      callback: (error: Error | null, zip?: ZipFile) => void,
    ) => {
      opened = callback;
    }) as typeof yauzl.open);
    const close = jest.fn();
    const controller = new AbortController();
    try {
      const pending = BackupArchiveReader.open(zip([{ name: 'a' }]), controller.signal, low);
      while (!opened) await new Promise<void>((resolve) => setImmediate(resolve));
      controller.abort();
      opened(null, { close } as unknown as ZipFile);
      await expect(pending).rejects.toBeInstanceOf(BadRequestException);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
    }
  });
});
