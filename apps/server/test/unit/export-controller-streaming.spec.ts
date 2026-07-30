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

// Issue #1527: `ExportController`'s constructor is typed against
// `Pick<RealService, ...methods it actually calls>` rather than the concrete class (see
// export.controller.ts). Because a `Pick<...>` is a plain structural type — not a class
// with a private-field brand — a double satisfying it can be passed here with NO unsafe
// cast at all, and the assignment is fully checked both ways:
//
//   - a double missing (or misspelling) a picked method fails to compile where it's
//     declared, not at runtime when the controller calls it (#1426's failure mode);
//   - if the controller starts calling a method outside this Pick list, that call fails
//     to compile IN export.controller.ts, forcing the Pick list to widen — and once
//     widened, every double here fails to compile until it supplies the new method too.
// This is the "no third method can sneak in silently" property a bare
// `Pick<Service, 'onlyWhatThisTestUses'>` on the double alone does not give you: that
// narrower form only catches renames/typos on the methods already listed, not a new
// method the production code starts requiring.
type ExportServiceDouble = Pick<
  ExportService,
  'exportFilename' | 'streamMarkdownZip' | 'buildExportInventory' | 'buildProfileExport' | 'buildMemberExport' | 'memberExportFilename'
>;
type CampaignAccessServiceDouble = Pick<CampaignAccessService, 'requireRole' | 'requireMember'>;
type CampaignsServiceDouble = Pick<CampaignsService, 'getOrThrow'>;

/** Full-shape export service double. Methods this file's tests don't exercise are
 * present (required by the type) but never expected to be called. */
function exportServiceDouble(overrides: Partial<ExportServiceDouble> = {}): ExportServiceDouble {
  return {
    exportFilename: jest.fn().mockReturnValue('campaign-backup.zip'),
    streamMarkdownZip: jest.fn(),
    buildExportInventory: jest.fn(),
    buildProfileExport: jest.fn(),
    buildMemberExport: jest.fn(),
    memberExportFilename: jest.fn(),
    ...overrides,
  };
}

function accessDouble(overrides: Partial<CampaignAccessServiceDouble> = {}): CampaignAccessServiceDouble {
  return {
    requireRole: jest.fn().mockResolvedValue(undefined),
    requireMember: jest.fn(),
    ...overrides,
  };
}

function controller(streamMarkdownZip: jest.Mock): ExportController {
  const exportService = exportServiceDouble({ streamMarkdownZip });
  const access = accessDouble();
  const campaigns: CampaignsServiceDouble = { getOrThrow: jest.fn().mockResolvedValue({ name: 'Campaign' }) };
  return new ExportController(exportService, access, campaigns);
}

describe('ExportController markdown ZIP streaming', () => {
  it('does not begin preliminary lookups for an already-ended response', async () => {
    const streamMarkdownZip = jest.fn();
    const access = accessDouble();
    const campaigns: CampaignsServiceDouble = { getOrThrow: jest.fn() };
    const exportService = exportServiceDouble({ streamMarkdownZip });
    const subject = new ExportController(exportService, access, campaigns);
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
    const exportService = exportServiceDouble({ streamMarkdownZip });
    const res = response();
    let onClose!: () => void;
    (res.once as unknown as jest.Mock).mockImplementation((event: string, listener: () => void) => {
      if (event === 'close') onClose = listener;
      return res;
    });
    const subject = new ExportController(
      exportService,
      accessDouble({ requireRole }),
      { getOrThrow },
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
