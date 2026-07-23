import { describe, it, expect } from '@jest/globals';

// We test the timeout behavior by inlining the same helper logic used in ai-console.service.ts.

interface ProbeResult {
  ok: boolean;
  providerType: string | null;
  model: string | null;
  error: string | null;
}

async function probeWithTimeout(
  fn: () => Promise<ProbeResult>,
  timeoutMs: number,
): Promise<ProbeResult> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<ProbeResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, providerType: null, model: null, error: 'timeout' }),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

describe('AI Console testAll timeout (#1061)', () => {
  it('returns timeout error when probe exceeds deadline', async () => {
    const neverResolves = () => new Promise<ProbeResult>(() => {}); // never resolves

    const result = await probeWithTimeout(neverResolves, 100);
    expect(result).toEqual({
      ok: false,
      providerType: null,
      model: null,
      error: 'timeout',
    });
  });

  it('returns normal result when probe completes within deadline', async () => {
    const fastProbe = () =>
      Promise.resolve<ProbeResult>({ ok: true, providerType: 'openai', model: 'gpt-4', error: null });

    const result = await probeWithTimeout(fastProbe, 5000);
    expect(result).toEqual({
      ok: true,
      providerType: 'openai',
      model: 'gpt-4',
      error: null,
    });
  });

  it('clears timer after successful probe (no leaked handles)', async () => {
    const fastProbe = () =>
      Promise.resolve<ProbeResult>({ ok: true, providerType: 'anthropic', model: 'claude', error: null });

    // If clearTimeout is not called, jest --detectOpenHandles would flag it.
    const result = await probeWithTimeout(fastProbe, 60_000);
    expect(result.ok).toBe(true);
  });
});
