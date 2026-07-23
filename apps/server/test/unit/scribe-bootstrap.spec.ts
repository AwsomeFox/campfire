import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ScribeService } from '../../src/modules/scribe/scribe.service';

/** Minimal stub — only `sweep` is exercised by the bootstrap timer. */
function stubScribeService(): ScribeService {
  return {
    sweep: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
  } as unknown as ScribeService;
}

describe('ScribeService — onApplicationBootstrap (#316)', () => {
  const prev = process.env.SCRIBE_SWEEP_INTERVAL_MS;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    if (prev === undefined) delete process.env.SCRIBE_SWEEP_INTERVAL_MS;
    else process.env.SCRIBE_SWEEP_INTERVAL_MS = prev;
  });

  it('starts the periodic sweep when SCRIBE_SWEEP_INTERVAL_MS is a positive integer', async () => {
    process.env.SCRIBE_SWEEP_INTERVAL_MS = '60000';
    const svc = stubScribeService();
    const sweep = jest.spyOn(svc, 'sweep').mockResolvedValue([]);

    ScribeService.prototype.onApplicationBootstrap.call(svc);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(sweep).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it('does not start a timer when SCRIBE_SWEEP_INTERVAL_MS is unset', () => {
    delete process.env.SCRIBE_SWEEP_INTERVAL_MS;
    const svc = stubScribeService();
    const sweep = jest.spyOn(svc, 'sweep');

    ScribeService.prototype.onApplicationBootstrap.call(svc);

    jest.advanceTimersByTime(120_000);
    expect(sweep).not.toHaveBeenCalled();
  });
});
