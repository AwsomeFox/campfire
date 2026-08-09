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
      { q: 'Homebrew Curse', campaignId: 10 },
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
      { q: 'nonexistent rule', campaignId: 10 },
      5,
      user,
    );
    expect(result.result).toContain('This campaign has no rule system configured');
  });

  it('attributes a supplemental top match to the pack that owns the entry', async () => {
    const campaigns: Pick<CampaignsService, 'getOrThrow'> = {
      getOrThrow: jest.fn().mockResolvedValue({
        id: 10,
        ruleSystem: 'core-rules',
        enabledPackSlugs: ['shared-bestiary'],
      }),
    };
    const basePack = {
      id: 1,
      slug: 'core-rules',
      name: 'Core Rules',
      license: 'OGL',
    };
    const supplementPack = {
      id: 2,
      slug: 'shared-bestiary',
      name: 'Shared Bestiary',
      license: 'CC-BY-4.0',
    };
    const rules: Pick<RulesService, 'getPackBySlug' | 'search'> = {
      getPackBySlug: jest.fn().mockImplementation(async (slug: string) =>
        slug === basePack.slug ? basePack : supplementPack,
      ),
      search: jest.fn().mockResolvedValue({
        items: [{ id: 201, packId: 2, name: 'Clockwork Owl', type: 'monster', body: 'A brass sentinel.' }],
        total: 1,
      }),
    };
    const audit: Pick<AuditService, 'log'> = { log: jest.fn().mockResolvedValue(undefined) };
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

    const result = await driver.rulesLookup(10, user, 'Clockwork Owl');

    expect(result.result).toContain('*Source: Shared Bestiary · CC-BY-4.0*');
    expect(result.result).not.toContain('*Source: Core Rules');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.stringContaining('(pack shared-bestiary)'),
    }));
  });

  it('audits an enabled-only lookup against its content pack instead of no rule system', async () => {
    const campaigns: Pick<CampaignsService, 'getOrThrow'> = {
      getOrThrow: jest.fn().mockResolvedValue({ id: 10, ruleSystem: '', enabledPackSlugs: ['shared-bestiary'] }),
    };
    const supplementPack = { id: 2, slug: 'shared-bestiary', name: 'Shared Bestiary', license: 'CC-BY-4.0' };
    const rules: Pick<RulesService, 'getPackBySlug' | 'search'> = {
      getPackBySlug: jest.fn().mockResolvedValue(supplementPack),
      search: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    };
    const audit: Pick<AuditService, 'log'> = { log: jest.fn().mockResolvedValue(undefined) };
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

    await driver.rulesLookup(10, user, 'missing');

    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.stringContaining('(pack shared-bestiary)'),
    }));
  });
});
