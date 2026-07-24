import { describe, it, expect, jest } from '@jest/globals';
import { AiDriverService } from '../../src/modules/ai-driver/ai-driver.service';
import {
  formatCalendarForPrompt,
  formatListForPrompt,
  formatLocationEnvironmentFromSummary,
} from '../../src/modules/ai-driver/world-state-prompt';

/**
 * #1048 — dynamic world-state sections in assembleSystemPrompt.
 * Drives AiDriverService with a stubbed mcpTools.buildToolset() (same private-method
 * cast pattern as ai-driver-secret-approval-bound.spec.ts).
 */
type Ctor = ConstructorParameters<typeof AiDriverService>;

describe('world-state prompt formatters (#1048)', () => {
  it('omits unset calendar defaults (empty date/note) and strips timestamps', () => {
    expect(
      formatCalendarForPrompt(
        JSON.stringify({
          campaignId: 1,
          currentDate: '',
          note: '',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      ),
    ).toBeNull();

    expect(
      formatCalendarForPrompt(
        JSON.stringify({
          campaignId: 1,
          currentDate: 'Day 12 of Harvestmoon',
          note: '  ',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      ),
    ).toBe(JSON.stringify({ campaignId: 1, currentDate: 'Day 12 of Harvestmoon' }));
  });

  it('treats [] / blank list payloads as empty for encounters and party', () => {
    expect(formatListForPrompt('[]')).toBeNull();
    expect(formatListForPrompt('  []  ')).toBeNull();
    expect(formatListForPrompt(null)).toBeNull();
    expect(formatListForPrompt('[{"id":1}]')).toBe('[{"id":1}]');
  });

  it('extracts location + dangerLevel from campaign summary JSON', () => {
    expect(formatLocationEnvironmentFromSummary(null)).toBeNull();
    expect(
      formatLocationEnvironmentFromSummary(
        JSON.stringify({ campaign: { dangerLevel: 'low' }, currentLocation: null }),
      ),
    ).toBeNull();

    const formatted = formatLocationEnvironmentFromSummary(
      JSON.stringify({
        campaign: { dangerLevel: 'high' },
        currentLocation: {
          id: 9,
          name: 'Goblin Warren',
          kind: 'dungeon',
          status: 'current',
          body: 'Narrow tunnels.',
          dmSecret: 'SHOULD_NOT_APPEAR',
          createdAt: 'x',
          updatedAt: 'y',
        },
      }),
    );
    expect(formatted).toBe(
      JSON.stringify({
        location: {
          id: 9,
          name: 'Goblin Warren',
          kind: 'dungeon',
          status: 'current',
          body: 'Narrow tunnels.',
        },
        dangerLevel: 'high',
      }),
    );
    expect(formatted).not.toContain('SHOULD_NOT_APPEAR');
  });
});

describe('AiDriverService.assembleSystemPrompt (#1048)', () => {
  const CAMPAIGN = 42;

  function makeService(toolResults: Record<string, { text: string; isError?: boolean }>) {
    const call = jest.fn(async (name: string, _args: Record<string, unknown>) => {
      const hit = toolResults[name];
      if (!hit) return { text: '', isError: true };
      return { text: hit.text, isError: Boolean(hit.isError) };
    });
    const mcpTools = {
      buildToolset: jest.fn(() => ({ call })),
    };
    const supportPreferences = {
      listForPublicAiNarration: jest.fn(async () => []),
    };
    const aiDm = { registerDriverSessionTeardown: jest.fn() };
    const svc = new AiDriverService(
      aiDm as unknown as Ctor[0],
      mcpTools as unknown as Ctor[1],
      undefined as unknown as Ctor[2],
      undefined as unknown as Ctor[3],
      undefined as unknown as Ctor[4],
      supportPreferences as unknown as Ctor[5],
      undefined as unknown as Ctor[6],
      undefined as unknown as Ctor[7],
      undefined as unknown as Ctor[8],
      undefined as unknown as Ctor[9], // encounters (#1048 ctor arity)
    );
    return { svc, call, mcpTools, supportPreferences };
  }

  async function assemble(svc: AiDriverService): Promise<string> {
    return (
      svc as unknown as {
        assembleSystemPrompt(campaignId: number, seat: { instructions: string | null }): Promise<string>;
      }
    ).assembleSystemPrompt(CAMPAIGN, { instructions: null });
  }

  it('injects calendar, encounters, party, and location sections from tool outputs', async () => {
    const { svc, call } = makeService({
      get_campaign_summary: {
        text: JSON.stringify({
          campaign: { id: CAMPAIGN, dangerLevel: 'moderate' },
          currentLocation: {
            id: 3,
            name: 'Market Square',
            kind: 'town',
            status: 'current',
            body: 'Crowded stalls.',
          },
        }),
      },
      get_session_zero: { text: '{"lines":[]}' },
      get_calendar: {
        text: JSON.stringify({
          campaignId: CAMPAIGN,
          currentDate: 'Midsummer',
          note: 'Festival',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
      list_encounters: { text: '[{"id":7,"name":"Ambush","status":"running"}]' },
      get_party: { text: '[{"id":1,"name":"Aria","hp":12,"conditions":["poisoned"]}]' },
    });

    const prompt = await assemble(svc);

    expect(prompt).toContain('## In-world calendar / time');
    expect(prompt).toContain('"currentDate":"Midsummer"');
    expect(prompt).not.toContain('createdAt');
    expect(prompt).toContain('## Running encounters');
    expect(prompt).toContain('"Ambush"');
    expect(prompt).toContain('## Party status');
    expect(prompt).toContain('"poisoned"');
    expect(prompt).toContain('## Current location / environment');
    expect(prompt).toContain('Market Square');
    expect(prompt).toContain('"dangerLevel":"moderate"');

    // Parallel world-state reads still happen (calendar + encounters + party).
    expect(call).toHaveBeenCalledWith('get_calendar', { campaignId: CAMPAIGN });
    expect(call).toHaveBeenCalledWith('list_encounters', { campaignId: CAMPAIGN, status: 'running' });
    expect(call).toHaveBeenCalledWith('get_party', { campaignId: CAMPAIGN });
  });

  it('omits empty/unset world-state sections (best-effort contract)', async () => {
    const { svc } = makeService({
      get_campaign_summary: {
        text: JSON.stringify({ campaign: { dangerLevel: 'low' }, currentLocation: null }),
      },
      get_session_zero: { text: '', isError: true },
      get_calendar: {
        text: JSON.stringify({
          campaignId: CAMPAIGN,
          currentDate: '',
          note: '',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
      list_encounters: { text: '[]' },
      get_party: { text: '[]' },
    });

    const prompt = await assemble(svc);

    expect(prompt).not.toContain('## In-world calendar / time');
    expect(prompt).not.toContain('## Running encounters');
    expect(prompt).not.toContain('## Party status');
    expect(prompt).not.toContain('## Current location / environment');
    expect(prompt).toContain('## Campaign context');
  });
});
