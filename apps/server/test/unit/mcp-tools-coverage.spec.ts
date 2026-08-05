import { McpToolsService } from '../../src/modules/mcp/mcp-tools';
import type { RequestUser } from '../../src/common/user.types';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

  /**
   * Issue #1928 review (Codex, three separate rounds on this one sentence). An AI caller reads
   * `resolve_action`'s description to decide how much to trust a result. `systemMathSupported:
   * false` marks the system UNAUDITED end-to-end — it does not say which maths ran. OSR and Open
   * Legend supply their own `resolveAttack` (descending-AC comparison, exploding dice pools) and
   * are still reported unsupported because the combined attack/save profile is unaudited, so a
   * blanket "the numbers are 5e-shaped" claim is false for exactly the systems the flag is meant
   * to protect — and would push an agent to discount a result that was right for the table.
   *
   * This pins the correction rather than banning the phrase: the description legitimately says
   * "5e-shaped" in a clause conditioned on `mathProfile` naming the 5e profile.
   */
  it('resolve_action does not tell callers the unsupported flag means 5e math ran', () => {
    const service = createMcpToolsService();
    const toolset = service.buildToolset(user);
    const resolveAction = toolset.tools.find((t) => t.name === 'resolve_action');
    expect(resolveAction).toBeDefined();
    const description = resolveAction!.description ?? '';

    // The corrective statement must be present...
    expect(description).toMatch(/does NOT mean 5e math was necessarily used/);
    expect(description).toMatch(/OSR, Open Legend/);
    // ...and the flag must never be described as meaning the numbers ARE 5e-shaped.
    expect(description).not.toMatch(/only flags that the numbers are 5e-shaped/);
  });

  /**
   * Issue #1928 review (Codex, fourth round). The mirror-image error on the generator side:
   * `difficultySupport: 'heuristic'` does NOT mean the reported difficulty is a 5e-shaped
   * RATING — for a registered non-5e system the reported difficulty is `unsupported` with a
   * null band, i.e. the absence of a rating. Only the roster-SIZING pass is 5e-shaped. A
   * description that attaches "5e-shaped" to the reported difficulty invites an AI caller to
   * report a band the payload does not contain. `generate_encounter` already got this right;
   * `preview_encounter` did not, so both are pinned here rather than only the one that broke.
   */
  /**
   * Issue #1928, fifth round on this one claim. The first four corrections each fixed the
   * copy that was quoted and left another surface behind: the web catalog, the component's
   * inline fallback, `resolve_action`'s description, `preview_encounter`'s. The fifth was
   * the SCHEMA JSDoc — the thing a downstream TypeScript consumer actually reads on hover,
   * and the one surface no test looked at. Pin it here alongside the tool descriptions so
   * "the docs and the registered descriptions agree" is one assertion, not a habit.
   */
  it('the ActionResolveResult schema docs do not claim the unsupported flag means 5e math ran', () => {
    const source = readFileSync(
      resolve(__dirname, '../../../../packages/schema/src/action-resolver.ts'),
      'utf8',
    );
    const block = source.slice(
      source.indexOf('Issue #1928: whether the resolver'),
      source.indexOf('systemMathSupported: z.boolean()'),
    );
    expect(block.length).toBeGreaterThan(200);
    // Whitespace-tolerant: this is a JSDoc block, so any phrase can be split across a line
    // wrap by ` * `. A literal-space regex here would fail on formatting rather than meaning.
    expect(block).toMatch(/UNAUDITED[\s*]+end-to-end/);
    expect(block).toMatch(/OSR|Open Legend/);
    expect(block).not.toMatch(/it only tells a caller the numbers it\s*\n?\s*\*?\s*just got are 5e-shaped/);
  });

  it.each(['generate_encounter', 'preview_encounter'])(
    '%s does not describe the reported difficulty itself as 5e-shaped',
    (toolName) => {
      const service = createMcpToolsService();
      const toolset = service.buildToolset(user);
      const tool = toolset.tools.find((t) => t.name === toolName);
      expect(tool).toBeDefined();
      const description = tool!.description ?? '';

      // "5e-shaped" is legal, but only ever attached to the sizing/heuristic pass.
      for (const match of description.match(/[^.;]*5e-shaped[^.;]*/g) ?? []) {
        expect(match).toMatch(/siz(e|ed|ing)|heuristic/i);
      }
      // ...and the unsupported difficulty must be described as absent, not as a 5e rating.
      expect(description).toMatch(/unsupported/);
      expect(description).not.toMatch(/reported difficulty is 5e-shaped/);
    },
  );
});
