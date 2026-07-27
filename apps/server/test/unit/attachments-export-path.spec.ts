import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { AuditService } from '../../src/modules/audit/audit.service';
import { AttachmentDerivativesService } from '../../src/modules/attachments/attachment-derivatives.service';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import { FsDeletionService } from '../../src/modules/attachments/fs-deletion.service';

const ROW = { campaignId: 1, id: 2, mime: 'image/png' };
const SOURCE = '/uploads/1/2.png';

function service(): AttachmentsService {
  return new AttachmentsService(
    {} as any,
    {} as AuditService,
    {} as FsDeletionService,
    {} as AttachmentDerivativesService,
  );
}

describe('AttachmentsService export source opening', () => {
  afterEach(() => jest.restoreAllMocks());

  function withSourcePath(): AttachmentsService {
    const attachments = service();
    jest.spyOn(attachments, 'filePath').mockReturnValue(SOURCE);
    return attachments;
  }

  it('opens without following symlinks, fstats the descriptor, and streams that descriptor', () => {
    const attachments = withSourcePath();
    const stream = new PassThrough() as unknown as fs.ReadStream;
    jest.spyOn(fs, 'openSync').mockReturnValue(42);
    jest.spyOn(fs, 'fstatSync').mockReturnValue({ isFile: () => true } as fs.Stats);
    const createStream = jest.spyOn(fs, 'createReadStream').mockReturnValue(stream);

    expect(attachments.openExportStreamIfPresent(ROW)).toBe(stream);
    expect(fs.openSync).toHaveBeenCalledWith(
      SOURCE,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    expect(createStream).toHaveBeenCalledWith(SOURCE, { fd: 42, autoClose: true });
  });

  it('probes a regular file and closes the validated descriptor', () => {
    const attachments = withSourcePath();
    jest.spyOn(fs, 'openSync').mockReturnValue(43);
    jest.spyOn(fs, 'fstatSync').mockReturnValue({ isFile: () => true } as fs.Stats);
    const close = jest.spyOn(fs, 'closeSync').mockImplementation(() => undefined);

    expect(attachments.hasExportFile(ROW)).toBe(true);
    expect(close).toHaveBeenCalledWith(43);
  });

  it.each(['ENOENT', 'ELOOP'])('returns null for %s while securely opening the source', (code) => {
    const attachments = withSourcePath();
    jest.spyOn(fs, 'openSync').mockImplementation(() => {
      throw Object.assign(new Error(code), { code });
    });

    expect(attachments.openExportStreamIfPresent(ROW)).toBeNull();
  });

  it('refuses an actual row-backed symlink', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-export-symlink-'));
    const target = path.join(dir, 'outside-secret');
    const link = path.join(dir, '2.png');
    fs.writeFileSync(target, 'secret');
    fs.symlinkSync(target, link, 'file');
    const attachments = service();
    jest.spyOn(attachments, 'filePath').mockReturnValue(link);
    try {
      expect(attachments.openExportStreamIfPresent(ROW)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('closes and rejects a descriptor that is not a regular file', () => {
    const attachments = withSourcePath();
    jest.spyOn(fs, 'openSync').mockReturnValue(44);
    jest.spyOn(fs, 'fstatSync').mockReturnValue({ isFile: () => false } as fs.Stats);
    const close = jest.spyOn(fs, 'closeSync').mockImplementation(() => undefined);

    expect(attachments.openExportStreamIfPresent(ROW)).toBeNull();
    expect(close).toHaveBeenCalledWith(44);
  });

  it('closes the descriptor when fstat fails', () => {
    const attachments = withSourcePath();
    const error = new Error('fstat failed');
    jest.spyOn(fs, 'openSync').mockReturnValue(45);
    jest.spyOn(fs, 'fstatSync').mockImplementation(() => { throw error; });
    const close = jest.spyOn(fs, 'closeSync').mockImplementation(() => undefined);

    expect(() => attachments.openExportStreamIfPresent(ROW)).toThrow(error);
    expect(close).toHaveBeenCalledWith(45);
  });

  it.each(['EACCES', 'EPERM'])('propagates %s from open', (code) => {
    const attachments = withSourcePath();
    const error = Object.assign(new Error('access denied'), { code });
    jest.spyOn(fs, 'openSync').mockImplementation(() => { throw error; });

    expect(() => attachments.openExportStreamIfPresent(ROW)).toThrow(error);
  });
});
