import { BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import type { RequestUser } from '../../src/common/user.types';
import { ExportController } from '../../src/modules/export/export.controller';
import type { ExportService } from '../../src/modules/export/export.service';
import type { CampaignAccessService } from '../../src/modules/membership/campaign-access.service';
import type { CampaignsService } from '../../src/modules/campaigns/campaigns.service';

const USER = { id: 'dm', name: 'DM', serverRole: 'user' } as RequestUser;

function response(overrides: Partial<Response> = {}): Response {
  const res = {
    status: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    once: jest.fn().mockReturnThis(),
    off: jest.fn().mockReturnThis(),
    removeHeader: jest.fn().mockReturnThis(),
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    ...overrides,
  };
  return res as unknown as Response;
}

function controller(streamMarkdownZip: jest.Mock): ExportController {
  const exportService = {
    exportFilename: jest.fn().mockReturnValue('campaign-backup.zip'),
    streamMarkdownZip,
  } as unknown as ExportService;
  const access = {
    requireRole: jest.fn().mockResolvedValue(undefined),
  } as unknown as CampaignAccessService;
  const campaigns = {
    getOrThrow: jest.fn().mockResolvedValue({ name: 'Campaign' }),
  } as unknown as CampaignsService;
  return new ExportController(exportService, access, campaigns);
}

describe('ExportController markdown ZIP streaming', () => {
  it('clears attachment headers before rethrowing a pre-stream failure', async () => {
    const failure = new BadRequestException('projection failed');
    const res = response();

    await expect(
      controller(jest.fn().mockRejectedValue(failure)).export(
        1,
        'mdzip',
        undefined,
        undefined,
        undefined,
        undefined,
        USER,
        res,
      ),
    ).rejects.toBe(failure);

    expect(res.removeHeader).toHaveBeenCalledWith('Content-Type');
    expect(res.removeHeader).toHaveBeenCalledWith('Content-Disposition');
    expect(res.removeHeader).toHaveBeenCalledWith('X-Campfire-Export-Profile');
  });

  it('suppresses a post-stream failure without rewriting committed headers', async () => {
    const res = response({ headersSent: true });

    await expect(
      controller(jest.fn().mockRejectedValue(new Error('stream failed'))).export(
        1,
        'mdzip',
        undefined,
        undefined,
        undefined,
        undefined,
        USER,
        res,
      ),
    ).resolves.toBeUndefined();

    expect(res.removeHeader).not.toHaveBeenCalled();
  });
});
