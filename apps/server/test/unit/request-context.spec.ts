import {
  bindRequestContext,
  createRequestContext,
  getRequestId,
  patchRequestContext,
  runWithRequestContext,
} from '../../src/common/request-context';

describe('request-context (#684)', () => {
  it('propagates requestId through async continuations', async () => {
    const ctx = createRequestContext({ transport: 'rest' });
    await runWithRequestContext(ctx, async () => {
      expect(getRequestId()).toBe(ctx.requestId);
      await Promise.resolve();
      expect(getRequestId()).toBe(ctx.requestId);
    });
  });

  it('patchRequestContext merges actor/campaign/tool onto the active store', () => {
    const ctx = createRequestContext({ transport: 'mcp' });
    runWithRequestContext(ctx, () => {
      patchRequestContext({ actor: 'dev-user', campaignId: 7, tool: 'list_quests' });
      expect(getRequestId()).toBe(ctx.requestId);
      patchRequestContext({ tool: 'update_quest' });
      // requestId unchanged; tool updated
      expect(getRequestId()).toBe(ctx.requestId);
    });
  });

  it('nested runWithRequestContext scopes do not leak outward', () => {
    const outer = createRequestContext({ inboundHeader: 'outer-id', transport: 'rest' });
    const inner = createRequestContext({ inboundHeader: 'inner-id', transport: 'rest' });
    runWithRequestContext(outer, () => {
      expect(getRequestId()).toBe('outer-id');
      runWithRequestContext(inner, () => {
        expect(getRequestId()).toBe('inner-id');
      });
      expect(getRequestId()).toBe('outer-id');
    });
  });

  it('concurrent contexts stay isolated under Promise.all', async () => {
    const a = createRequestContext({ inboundHeader: 'req-a', transport: 'rest' });
    const b = createRequestContext({ inboundHeader: 'req-b', transport: 'rest' });
    const seen = await Promise.all([
      runWithRequestContext(a, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return getRequestId();
      }),
      runWithRequestContext(b, async () => {
        await new Promise((r) => setTimeout(r, 1));
        return getRequestId();
      }),
    ]);
    expect(seen).toEqual(['req-a', 'req-b']);
  });

  it('bindRequestContext preserves requestId for callbacks with parameters', () => {
    const ctx = createRequestContext({ inboundHeader: 'timer-corr', transport: 'rest' });
    runWithRequestContext(ctx, () => {
      const onTimeout = bindRequestContext((id: string, n: number) => {
        expect(getRequestId()).toBe('timer-corr');
        expect(id).toBe('x');
        expect(n).toBe(2);
      });
      onTimeout('x', 2);
    });
  });
});
