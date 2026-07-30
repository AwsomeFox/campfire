import { BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import type { Role } from '@campfire/schema';
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

// Issue #1527: hand-rolled doubles are typed against `Pick<RealService, ...>` — the
// exact methods this file exercises — instead of a blind `{...} as unknown as X` with
// no shape check at all. A double missing (or misspelling) a method the real service
// requires is then a compile error here, not a runtime `TypeError` discovered only when
// the double is actually invoked (see #1426's SchedulingService.listForExport case).
// `ExportController`'s constructor still takes the concrete classes, so the final
// `as unknown as X` is unavoidable — these classes carry private constructor-injected
// fields, which no plain object literal can structurally satisfy — but everything up to
// that single, narrow cast is now checked.
type ExportServiceDouble = Pick<ExportService, 'exportFilename' | 'streamMarkdownZip'>;
type CampaignAccessServiceDouble = Pick<CampaignAccessService, 'requireRole'>;
type CampaignsServiceDouble = Pick<CampaignsService, 'getOrThrow'>;

function controller(streamMarkdownZip: jest.Mock): ExportController {
  const exportService: ExportServiceDouble = {
    exportFilename: jest.fn().mockReturnValue('campaign-backup.zip'),
    streamMarkdownZip,
  };
  const access: CampaignAccessServiceDouble = {
    requireRole: jest.fn().mockResolvedValue(undefined),
  };
  const campaigns: CampaignsServiceDouble = {
    getOrThrow: jest.fn().mockResolvedValue({ name: 'Campaign' }),
  };
  return new ExportController(
    exportService as unknown as ExportService,
    access as unknown as CampaignAccessService,
    campaigns as unknown as CampaignsService,
  );
}

describe('ExportController markdown ZIP streaming', () => {
  it('does not begin preliminary lookups for an already-ended response', async () => {
    const streamMarkdownZip = jest.fn();
    const access: CampaignAccessServiceDouble = { requireRole: jest.fn() };
    const campaigns: CampaignsServiceDouble = { getOrThrow: jest.fn() };
    const exportService: ExportServiceDouble = { exportFilename: jest.fn(), streamMarkdownZip };
    const subject = new ExportController(
      exportService as unknown as ExportService,
      access as unknown as CampaignAccessService,
      campaigns as unknown as CampaignsService,
    );
    const res = response({ destroyed: true, writableEnded: true });

    await expect(subject.export(1, 'mdzip', undefined, undefined, undefined, undefined, USER, res)).resolves.toBeUndefined();
    expect(access.requireRole).not.toHaveBeenCalled();
    expect(campaigns.getOrThrow).not.toHaveBeenCalled();
    expect(streamMarkdownZip).not.toHaveBeenCalled();
  });

  it('cancels before campaign lookup when the client closes during authorization', async () => {
    let releaseRole!: () => void;
    const requireRole = jest.fn(() => new Promise<Role>((resolve) => { releaseRole = () => resolve('dm'); }));
    const getOrThrow = jest.fn().mockResolvedValue({ name: 'Campaign' });
    const streamMarkdownZip = jest.fn();
    const exportService: ExportServiceDouble = { exportFilename: jest.fn(), streamMarkdownZip };
    const res = response();
    let onClose!: () => void;
    (res.once as unknown as jest.Mock).mockImplementation((event: string, listener: () => void) => {
      if (event === 'close') onClose = listener;
      return res;
    });
    const subject = new ExportController(
      exportService as unknown as ExportService,
      { requireRole } as CampaignAccessServiceDouble as unknown as CampaignAccessService,
      { getOrThrow } as CampaignsServiceDouble as unknown as CampaignsService,
    );

    const pending = subject.export(1, 'mdzip', undefined, undefined, undefined, undefined, USER, res);
    onClose();
    releaseRole();
    await expect(pending).resolves.toBeUndefined();
    expect(getOrThrow).not.toHaveBeenCalled();
    expect(streamMarkdownZip).not.toHaveBeenCalled();
    expect(res.off).toHaveBeenCalledWith('close', onClose);
  });

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
