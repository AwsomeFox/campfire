import {
  AiConsoleService,
  AI_CONSOLE_PROBE_TIMEOUT_MS,
  raceProbe,
} from '../../src/modules/ai-console/ai-console.service';
import type { AiProviderConfigService } from '../../src/modules/ai-provider-config/ai-provider-config.service';
import type { SettingsService } from '../../src/modules/settings/settings.service';
import type { AuditService } from '../../src/modules/audit/audit.service';
import type { DrizzleDb } from '../../src/db/db.module';

/**
 * Issue #1061 — AI Console testAll() must bound each provider probe so a hanging
 * connection cannot block the admin health endpoint indefinitely.
 */

describe('raceProbe (issue #1061)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it(`resolves { ok: false, error: 'timeout' } after ${AI_CONSOLE_PROBE_TIMEOUT_MS}ms when the probe hangs`, async () => {
    const hanging = new Promise<never>(() => {
      /* never settles */
    });
    const resultPromise = raceProbe(hanging, { providerType: 'openai', model: 'gpt-4o-mini' });

    await jest.advanceTimersByTimeAsync(AI_CONSOLE_PROBE_TIMEOUT_MS - 1);
    // Still pending — one ms shy of the deadline.
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    await expect(resultPromise).resolves.toEqual({
      ok: false,
      providerType: 'openai',
      model: 'gpt-4o-mini',
      error: 'timeout',
    });
  });

  it('returns the live probe result when it finishes before the deadline', async () => {
    const probe = Promise.resolve({
      ok: true,
      providerType: 'mock',
      model: 'mock-1',
      error: null,
    });
    const resultPromise = raceProbe(probe, { providerType: 'openai', model: 'fallback' });
    await expect(resultPromise).resolves.toEqual({
      ok: true,
      providerType: 'mock',
      model: 'mock-1',
      error: null,
    });
  });

  it('clears the timer when the probe wins the race (no leaked timeout resolution)', async () => {
    const probe = Promise.resolve({
      ok: false,
      providerType: 'anthropic',
      model: 'claude',
      error: 'auth failed',
    });
    const result = await raceProbe(probe, { providerType: 'anthropic', model: 'claude' });
    expect(result.error).toBe('auth failed');
    // Advancing past the timeout must not overwrite the settled result.
    await jest.advanceTimersByTimeAsync(AI_CONSOLE_PROBE_TIMEOUT_MS + 1_000);
    expect(result).toEqual({
      ok: false,
      providerType: 'anthropic',
      model: 'claude',
      error: 'auth failed',
    });
  });
});

describe('AiConsoleService.testAll — per-probe timeout (issue #1061)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function mockDb(overrides: Array<{
    campaignId: number | null;
    campaignName: string | null;
    providerType: string;
    model: string;
  }>) {
    return {
      select: () => ({
        from: () => ({
          leftJoin: () => ({
            where: async () => overrides,
          }),
        }),
      }),
    } as unknown as DrizzleDb;
  }

  it('times out a hanging server probe and continues to campaign overrides', async () => {
    const testConnection = jest.fn(async (campaignId: number | null) => {
      if (campaignId === null) {
        return new Promise(() => {
          /* hang forever */
        });
      }
      return {
        ok: true,
        providerType: 'mock',
        model: 'camp-mock',
        error: null,
      };
    });

    const providers = {
      getServerView: jest.fn(async () => ({
        providerType: 'openai',
        model: 'gpt-4o-mini',
      })),
      testConnection,
    } as unknown as AiProviderConfigService;

    const service = new AiConsoleService(
      mockDb([{ campaignId: 7, campaignName: 'Hang Camp', providerType: 'mock', model: 'camp-mock' }]),
      {} as SettingsService,
      providers,
      {} as AuditService,
    );

    const resultPromise = service.testAll();
    await jest.advanceTimersByTimeAsync(AI_CONSOLE_PROBE_TIMEOUT_MS);
    const out = await resultPromise;

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      scope: 'server',
      ok: false,
      error: 'timeout',
      providerType: 'openai',
      model: 'gpt-4o-mini',
    });
    expect(out[1]).toMatchObject({
      scope: 'campaign',
      campaignId: 7,
      campaignName: 'Hang Camp',
      ok: true,
      providerType: 'mock',
      model: 'camp-mock',
      error: null,
    });
    expect(testConnection).toHaveBeenCalledTimes(2);
  });

  it('times out a hanging campaign probe without blocking subsequent overrides', async () => {
    const testConnection = jest.fn(async (campaignId: number | null) => {
      if (campaignId === 1) {
        return new Promise(() => {
          /* hang */
        });
      }
      return {
        ok: true,
        providerType: 'mock',
        model: `m-${campaignId}`,
        error: null,
      };
    });

    const providers = {
      getServerView: jest.fn(async () => null),
      testConnection,
    } as unknown as AiProviderConfigService;

    const service = new AiConsoleService(
      mockDb([
        { campaignId: 1, campaignName: 'Stuck', providerType: 'openai', model: 'hang-model' },
        { campaignId: 2, campaignName: 'Ok', providerType: 'mock', model: 'm-2' },
      ]),
      {} as SettingsService,
      providers,
      {} as AuditService,
    );

    const resultPromise = service.testAll();
    // First (hanging) probe needs one full timeout; second resolves immediately after.
    await jest.advanceTimersByTimeAsync(AI_CONSOLE_PROBE_TIMEOUT_MS);
    const out = await resultPromise;

    expect(out).toEqual([
      {
        scope: 'campaign',
        campaignId: 1,
        campaignName: 'Stuck',
        ok: false,
        providerType: 'openai',
        model: 'hang-model',
        error: 'timeout',
      },
      {
        scope: 'campaign',
        campaignId: 2,
        campaignName: 'Ok',
        ok: true,
        providerType: 'mock',
        model: 'm-2',
        error: null,
      },
    ]);
  });
});
