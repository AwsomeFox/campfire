import { expect, test } from '@playwright/test';
import {
  consumeEncounterAftermathRecap,
  encounterAftermathRecapStorageKey,
  storeEncounterAftermathRecap,
} from '../../src/features/encounters/encounterAftermathHandoff';

/**
 * Node has no `sessionStorage`, and encounterAftermathHandoff wraps every access in
 * try/catch so a blocked store degrades to "the deep link still opens the recap form".
 * That is correct for production and fatal for this test: without a stub the round-trip
 * silently no-ops, `consume` returns null, and the spec would assert nothing. The bare
 * `sessionStorage.removeItem` this test used to open with sat outside that try/catch and
 * threw ReferenceError, which is the only reason the gap was visible at all.
 *
 * Installed and torn down per-file rather than at module scope: the unit tier runs every
 * spec in ONE worker process, so a permanent global here would silently change how any
 * later spec's modules detect storage availability.
 */
class MemorySessionStorage {
  private readonly m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  getItem(key: string): string | null {
    return this.m.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.m.set(key, String(value));
  }
  removeItem(key: string): void {
    this.m.delete(key);
  }
  clear(): void {
    this.m.clear();
  }
  key(i: number): string | null {
    return Array.from(this.m.keys())[i] ?? null;
  }
}

const HAD_SESSION_STORAGE = 'sessionStorage' in globalThis;
const PREVIOUS = (globalThis as { sessionStorage?: Storage }).sessionStorage;

test.beforeAll(() => {
  (globalThis as { sessionStorage?: Storage }).sessionStorage =
    new MemorySessionStorage() as unknown as Storage;
});

test.afterAll(() => {
  if (HAD_SESSION_STORAGE) (globalThis as { sessionStorage?: Storage }).sessionStorage = PREVIOUS;
  else delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
});

test.describe('encounter aftermath handoff storage (issue #473)', () => {
  test('stores and consumes a recap draft once', () => {
    const key = encounterAftermathRecapStorageKey(4, 99);
    sessionStorage.removeItem(key);
    storeEncounterAftermathRecap(4, 99, '## Recap\n- Fight happened');
    expect(sessionStorage.getItem(key)).toContain('Fight happened');
    expect(consumeEncounterAftermathRecap(4, 99)).toContain('Fight happened');
    expect(consumeEncounterAftermathRecap(4, 99)).toBeNull();
  });

  test('a blank recap is never stored', () => {
    const key = encounterAftermathRecapStorageKey(4, 100);
    storeEncounterAftermathRecap(4, 100, '   ');
    expect(sessionStorage.getItem(key)).toBeNull();
  });
});
