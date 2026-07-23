import { expect, test } from '@playwright/test';
import { shareInFlightRef } from '../../src/lib/shareInFlight';

/**
 * Issue #691 — HandoutsCard `await load()` must share the in-flight attachments
 * promise so overlapping callers (reveal toggle, post-upload refresh) wait for
 * the active fetch instead of returning immediately with a stale list.
 */
test.describe('shareInFlightRef (issue #691)', () => {
  test('concurrent callers share one in-flight promise', async () => {
    const ref: { current: Promise<string> | null } = { current: null };
    let starts = 0;
    let resolve!: (value: string) => void;

    const load = () =>
      shareInFlightRef(ref, () => {
        starts += 1;
        return new Promise<string>((r) => {
          resolve = r;
        });
      });

    const first = load();
    const second = load();
    expect(starts).toBe(1);
    expect(second).toBe(first);
    expect(ref.current).toBe(first);

    resolve('ok');
    await expect(first).resolves.toBe('ok');
    await expect(second).resolves.toBe('ok');
    expect(ref.current).toBeNull();
  });

  test('a later call starts a fresh promise after the prior one settles', async () => {
    const ref: { current: Promise<number> | null } = { current: null };
    let starts = 0;

    const load = () =>
      shareInFlightRef(ref, async () => {
        starts += 1;
        return starts;
      });

    await expect(load()).resolves.toBe(1);
    await expect(load()).resolves.toBe(2);
    expect(starts).toBe(2);
  });
});
