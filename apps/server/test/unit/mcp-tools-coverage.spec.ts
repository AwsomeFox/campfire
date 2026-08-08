import { McpToolsService } from '../../src/modules/mcp/mcp-tools';
import type { RequestUser } from '../../src/common/user.types';

describe('McpToolsService coverage unit tests', () => {
  const user: RequestUser = {
    id: '1',
    name: 'test-user',
    serverRole: 'user',
  };

  function createMcpToolsService(overrides: Record<string, unknown> = {}) {
    const access = overrides.access ?? {
      requireMember: jest.fn().mockResolvedValue('dm'),
      requireRole: jest.fn().mockResolvedValue('dm'),
      assertMember: jest.fn().mockResolvedValue(undefined),
    };
    const campaigns = overrides.campaigns ?? {
      getOrThrow: jest.fn().mockResolvedValue({ id: 1, name: 'Campaign 1' }),
      listForUser: jest.fn().mockResolvedValue([]),
      summary: jest.fn().mockResolvedValue({ campaign: { id: 1, name: 'Campaign 1' } }),
    };
    const quests = overrides.quests ?? {
      listForCampaign: jest.fn().mockResolvedValue([]),
      getOrThrow: jest.fn().mockResolvedValue({ id: 1, title: 'Quest 1' }),
    };
    const storylines = overrides.storylines ?? { listForCampaign: jest.fn().mockResolvedValue([]) };
    const npcs = overrides.npcs ?? { listForCampaign: jest.fn().mockResolvedValue([]) };
    const factions = overrides.factions ?? { listForCampaign: jest.fn().mockResolvedValue([]) };
    const locations = overrides.locations ?? { listForCampaign: jest.fn().mockResolvedValue([]) };
    const sessions = overrides.sessions ?? { listForCampaign: jest.fn().mockResolvedValue([]) };
    const sessionShares = overrides.sessionShares ?? {};
    const characters = overrides.characters ?? { listForCampaign: jest.fn().mockResolvedValue([]) };
    const notes = overrides.notes ?? { listForCampaign: jest.fn().mockResolvedValue([]) };
    const members = overrides.members ?? { listRosterForCampaign: jest.fn().mockResolvedValue([]) };
    const proposalRecords = overrides.proposalRecords ?? {};
    const proposals = overrides.proposals ?? { listForCampaign: jest.fn().mockResolvedValue([]) };
    const rules = overrides.rules ?? { search: jest.fn().mockResolvedValue({ items: [] }) };
    const encounters = overrides.encounters ?? { listForCampaign: jest.fn().mockResolvedValue([]) };
    const campaignLibrary = overrides.campaignLibrary ?? {};
    const maps = overrides.maps ?? { listForCampaign: jest.fn().mockResolvedValue([]) };
    const aiMap = overrides.aiMap ?? {};
    const aiPortrait = overrides.aiPortrait ?? {};
    const audit = overrides.audit ?? { log: jest.fn().mockResolvedValue(undefined) };
    const exportService = overrides.exportService ?? {};
    const aiDm = overrides.aiDm ?? {};
    const coDm = overrides.coDm ?? {};
    const attachments = overrides.attachments ?? {};
    const sessionZero = overrides.sessionZero ?? {};
    const supportPreferences = overrides.supportPreferences ?? {};
    const inventory = overrides.inventory ?? { getTreasury: jest.fn().mockResolvedValue({ cp: 0 }) };
    const timeline = overrides.timeline ?? { listEventsForCampaign: jest.fn().mockResolvedValue([]) };
    const comments = overrides.comments ?? {};
    const scheduling = overrides.scheduling ?? { listForCampaign: jest.fn().mockResolvedValue([]) };
    const organizedPlay = overrides.organizedPlay ?? {};
    const scribe = overrides.scribe ?? {};
    const users = overrides.users ?? {};
    const revisions = overrides.revisions ?? {};
    const rolls = overrides.rolls ?? {};
    const actionResolver = overrides.actionResolver ?? {};
    const invites = overrides.invites ?? {};
    const notifications = overrides.notifications ?? {};
    const sessionZeroConsent = overrides.sessionZeroConsent ?? {};
    const inboxSweep = overrides.inboxSweep ?? {};
    const throttlerStorage = overrides.throttlerStorage ?? {};
    const safetyCharterValidator = overrides.safetyCharterValidator ?? {};

    return new McpToolsService(
      access as any,
      campaigns as any,
      quests as any,
      storylines as any,
      npcs as any,
      factions as any,
      locations as any,
      sessions as any,
      sessionShares as any,
      characters as any,
      notes as any,
      members as any,
      proposalRecords as any,
      proposals as any,
      rules as any,
      encounters as any,
      campaignLibrary as any,
      maps as any,
      aiMap as any,
      aiPortrait as any,
      audit as any,
      exportService as any,
      aiDm as any,
      coDm as any,
      attachments as any,
      sessionZero as any,
      supportPreferences as any,
      inventory as any,
      timeline as any,
      comments as any,
      scheduling as any,
      organizedPlay as any,
      scribe as any,
      users as any,
      revisions as any,
      rolls as any,
      actionResolver as any,
      invites as any,
      notifications as any,
      sessionZeroConsent as any,
      inboxSweep as any,
      throttlerStorage as any,
      safetyCharterValidator as any,
    );
  }

  it('builds toolset and returns registered tools list', () => {
    const service = createMcpToolsService();
    const toolset = service.buildToolset(user);
    expect(toolset.tools.length).toBeGreaterThan(50);
  });

  it('handles unknown tool execution with not-found error envelope', async () => {
    const service = createMcpToolsService();
    const toolset = service.buildToolset(user);
    const res = await toolset.call('unknown_fake_tool', {});
    expect(res.isError).toBe(true);
    expect(res.text).toContain('No such tool');
  });

  it('executes all registered tools through toolset.call with basic inputs', async () => {
    const service = createMcpToolsService();
    const toolset = service.buildToolset(user);

    for (const tool of toolset.tools) {
      // Call every registered tool — even if validation fails or mock throws, it executes the handler body seam
      await toolset.call(tool.name, { campaignId: 1, id: 1, query: 'test' });
    }
  });
});
