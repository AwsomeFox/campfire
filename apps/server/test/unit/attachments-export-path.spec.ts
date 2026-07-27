import fs from 'node:fs';
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

describe('AttachmentsService.exportPathIfPresent', () => {
  afterEach(() => jest.restoreAllMocks());

  function withSourcePath(): AttachmentsService {
    const attachments = service();
    jest.spyOn(attachments, 'filePath').mockReturnValue(SOURCE);
    return attachments;
  }

  it('returns the source for a present regular file', () => {
    const attachments = withSourcePath();
    jest.spyOn(fs, 'statSync').mockReturnValue({ isFile: () => true } as fs.Stats);

    expect(attachments.exportPathIfPresent(ROW)).toBe(SOURCE);
  });

  it('returns null only when the source is absent', () => {
    const attachments = withSourcePath();
    jest.spyOn(fs, 'statSync').mockImplementation(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });

    expect(attachments.exportPathIfPresent(ROW)).toBeNull();
  });

  it.each(['EACCES', 'EPERM'])('propagates %s from stat', (code) => {
    const attachments = withSourcePath();
    const error = Object.assign(new Error('access denied'), { code });
    jest.spyOn(fs, 'statSync').mockImplementation(() => { throw error; });

    expect(() => attachments.exportPathIfPresent(ROW)).toThrow(error);
  });
});
