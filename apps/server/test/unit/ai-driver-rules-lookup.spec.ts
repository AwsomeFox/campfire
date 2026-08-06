import { AiDriverService } from '../../src/modules/ai-driver/ai-driver.service';
import type { CampaignsService } from '../../src/modules/campaigns/campaigns.service';
import type { RulesService } from '../../src/modules/rules/rules.service';
import type { AuditService } from '../../src/modules/audit/audit.service';
import type { RequestUser } from '../../src/common/user.types';

describe('AiDriverService.rulesLookup (issue #1967)', () => {
  const user = { id: 'user-42', isServerAdmin: false } as unknown as RequestUser;
  const aiDmMock = {
    registerDriverSessionTeardown: jest.fn(),
  };

  it('searches campaign homebrew when campaign has no rule system configured', async () => {
    const campaigns: Pick<CampaignsService, 'getOrThrow'> = {
      getOrThrow: jest.fn().mockResolvedValue({ id: 10, ruleSystem: '' }),
    };

    const rules: Pick<RulesService, 'getPackBySlug' | 'search'> = {
      getPackBySlug: jest.fn().mockResolvedValue(null),
      search: jest.fn().mockResolvedValue({
        items: [
          {
            id: 99,
            name: 'Homebrew Curse',
            type: 'condition',
            body: 'Target suffers disadvantage on all checks.',
            campaignId: 10,
          },
        ],
        total: 1,
      }),
    };

    const audit: Pick<AuditService, 'log'> = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    const driver = new AiDriverService(
      aiDmMock as any,
      {} as any,
      audit as unknown as AuditService,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      campaigns as unknown as CampaignsService,
      rules as unknown as RulesService,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const result = await driver.rulesLookup(10, user, 'Homebrew Curse');

    expect(rules.search).toHaveBeenCalledWith(
      { q: 'Homebrew Curse', pack: undefined, campaignId: 10 },
      5,
      user,
    );
    expect(result.result).not.toContain('no rule system configured');
    expect(result.result).toContain('Homebrew Curse');
    expect(result.result).toContain('*Source: Campaign homebrew*');
  });

  it('returns no rule system notice when campaign has no rule system and no homebrew entry matches', async () => {
    const campaigns: Pick<CampaignsService, 'getOrThrow'> = {
      getOrThrow: jest.fn().mockResolvedValue({ id: 10, ruleSystem: '' }),
    };

    const rules: Pick<RulesService, 'getPackBySlug' | 'search'> = {
      getPackBySlug: jest.fn().mockResolvedValue(null),
      search: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    };

    const audit: Pick<AuditService, 'log'> = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    const driver = new AiDriverService(
      aiDmMock as any,
      {} as any,
      audit as unknown as AuditService,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      campaigns as unknown as CampaignsService,
      rules as unknown as RulesService,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const result = await driver.rulesLookup(10, user, 'nonexistent rule');

    expect(rules.search).toHaveBeenCalledWith(
      { q: 'nonexistent rule', pack: undefined, campaignId: 10 },
      5,
      user,
    );
    expect(result.result).toContain('This campaign has no rule system configured');
  });
});
