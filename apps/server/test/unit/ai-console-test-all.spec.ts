import { AiConsoleService } from '../../src/modules/ai-console/ai-console.service';

/**
 * Unit coverage for the per-probe timeout added in #1061: a hung or slow provider
 * must not stall the admin "test all" health readout. These tests drive the service
 * directly with lightweight mocks (no Nest bootstrap, no DB) and use fake timers so
 * the 15s ceiling can be exercised instantly.
 */
describe('AiConsoleService.testAll — bounded per-probe timeout (#1061)', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  /** Build a service whose campaign-override query resolves to `overrides`. */
  function makeService(providers: unknown, overrides: unknown[] = []) {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          leftJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue(overrides),
          }),
        }),
      }),
    };
    // settings + audit are unused by testAll; pass inert stand-ins.
    return new AiConsoleService(db as never, {} as never, providers as never, {} as never);
  }

  it('returns a {ok:false, error:"timeout"} entry when the server probe never settles', async () => {
    jest.useFakeTimers();
    const providers = {
      getServerView: jest.fn().mockResolvedValue({ providerType: 'openai' }),
      // Never resolves — simulates a hung provider.
      testConnection: jest.fn().mockReturnValue(new Promise<never>(() => {})),
    };
    const svc = makeService(providers);

    const pending = svc.testAll();
    await jest.advanceTimersByTimeAsync(PROBE_TIMEOUT());
    const result = await pending;

    expect(result).toEqual([
      {
        scope: 'server',
        campaignId: null,
        campaignName: null,
        ok: false,
        providerType: 'openai',
        model: '',
        error: 'timeout',
      },
    ]);
  });

  it('times out a hung per-campaign override probe, preserving the override providerType', async () => {
    jest.useFakeTimers();
    const providers = {
      getServerView: jest.fn().mockResolvedValue(null), // no server default
      testConnection: jest.fn().mockReturnValue(new Promise<never>(() => {})),
    };
    const svc = makeService(providers, [{ campaignId: 7, campaignName: 'Vale', providerType: 'anthropic' }]);

    const pending = svc.testAll();
    await jest.advanceTimersByTimeAsync(PROBE_TIMEOUT());
    const result = await pending;

    expect(result).toEqual([
      {
        scope: 'campaign',
        campaignId: 7,
        campaignName: 'Vale',
        ok: false,
        providerType: 'anthropic',
        model: '',
        error: 'timeout',
      },
    ]);
  });

  it('passes healthy probes through unchanged and clears the timer (no timeout)', async () => {
    const providers = {
      getServerView: jest.fn().mockResolvedValue({ providerType: 'openai' }),
      testConnection: jest
        .fn()
        // server probe
        .mockResolvedValueOnce({ ok: true, providerType: 'openai', model: 'gpt-4o-mini', error: null })
        // campaign probe
        .mockResolvedValueOnce({ ok: false, providerType: 'anthropic', model: 'claude', error: 'bad key' }),
    };
    const svc = makeService(providers, [{ campaignId: 7, campaignName: 'Vale', providerType: 'anthropic' }]);

    const result = await svc.testAll();

    expect(result).toEqual([
      { scope: 'server', campaignId: null, campaignName: null, ok: true, providerType: 'openai', model: 'gpt-4o-mini', error: null },
      { scope: 'campaign', campaignId: 7, campaignName: 'Vale', ok: false, providerType: 'anthropic', model: 'claude', error: 'bad key' },
    ]);
  });

  it('falls back to a synthesized campaign name when the join is missing', async () => {
    const providers = {
      getServerView: jest.fn().mockResolvedValue(null),
      testConnection: jest.fn().mockResolvedValue({ ok: true, providerType: 'mock', model: 'm', error: null }),
    };
    const svc = makeService(providers, [{ campaignId: 42, campaignName: null, providerType: 'mock' }]);

    const result = await svc.testAll();

    expect(result[0].campaignName).toBe('#42');
  });
});

/** The production ceiling, mirrored here so timer advancement matches the source. */
function PROBE_TIMEOUT(): number {
  return 15_000;
}
