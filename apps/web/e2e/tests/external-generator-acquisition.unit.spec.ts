/**
 * Pure model for the guided external-generator round trip (issue #411).
 *
 * Covers the two DOM-free pieces the ExternalGeneratorCard leans on:
 *   - EXPORT VALIDATION: type / size / dimension checks return actionable "how to fix it"
 *     messages (not bare rejections) so the DM learns about a bad export up front.
 *   - ACQUISITION PERSISTENCE: which generator the DM opened survives reload (per-campaign),
 *     is isolated between campaigns, and self-expires so a long-abandoned round trip doesn't
 *     resurrect the return checklist forever.
 */
import { expect, test } from '@playwright/test';

/** Minimal in-memory localStorage so the persistence helpers have a store in Node. */
class MemoryStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
  key(i: number): string | null {
    return Array.from(this.m.keys())[i] ?? null;
  }
}

// Install before importing the module under test (it reads the global `localStorage`).
(globalThis as unknown as { localStorage: Storage }).localStorage = new MemoryStorage() as unknown as Storage;

import {
  ACQUISITION_TTL_MS,
  MAX_EXPORT_BYTES,
  MIN_EXPORT_DIMENSION,
  MAX_EXPORT_DIMENSION,
  clearAcquisition,
  describeExportProblem,
  loadAcquisition,
  saveAcquisition,
} from '../../src/components/externalGeneratorAcquisition';

test.beforeEach(() => {
  (globalThis.localStorage as unknown as MemoryStorage).clear();
});

test.describe('describeExportProblem — issue #411 validation', () => {
  test('accepts a well-formed PNG/JPEG/WebP export', () => {
    expect(
      describeExportProblem({ type: 'image/png', size: 2_000_000, width: 1200, height: 880 }),
    ).toBeNull();
    expect(
      describeExportProblem({ type: 'image/jpeg', size: 500_000, width: 1024, height: 1024 }),
    ).toBeNull();
    expect(
      describeExportProblem({ type: 'image/webp', size: 10, width: 800, height: 600 }),
    ).toBeNull();
  });

  test('rejects a non-image type with export guidance', () => {
    const msg = describeExportProblem({ type: 'application/pdf', size: 1000 });
    expect(msg).toContain('PNG');
    expect(msg).toContain('application/pdf');
  });

  test('allows an empty browser-reported type (server sniffs the bytes)', () => {
    // Some platforms/browsers report an empty MIME for a valid image; don't fail fast here.
    expect(describeExportProblem({ type: '', size: 1000 })).toBeNull();
  });

  test('rejects an oversized export and suggests shrinking it', () => {
    const msg = describeExportProblem({ type: 'image/png', size: MAX_EXPORT_BYTES + 1 });
    expect(msg).toMatch(/limit/i);
    expect(msg).toMatch(/JPEG|WebP|smaller/i);
  });

  test('rejects an empty file', () => {
    expect(describeExportProblem({ type: 'image/png', size: 0 })).toMatch(/empty/i);
  });

  test('rejects a too-small image with the minimum spelled out', () => {
    const msg = describeExportProblem({
      type: 'image/png',
      size: 5000,
      width: 64,
      height: 64,
    });
    expect(msg).toContain(String(MIN_EXPORT_DIMENSION));
    expect(msg).toMatch(/too small/i);
  });

  test('rejects a too-large image with the maximum spelled out', () => {
    const msg = describeExportProblem({
      type: 'image/png',
      size: 5000,
      width: MAX_EXPORT_DIMENSION + 1,
      height: 1000,
    });
    expect(msg).toContain(String(MAX_EXPORT_DIMENSION));
  });

  test('skips dimension checks when they are unknown (not yet decoded)', () => {
    expect(describeExportProblem({ type: 'image/png', size: 1000 })).toBeNull();
  });
});

test.describe('acquisition persistence — issue #411', () => {
  test('round-trips an in-progress acquisition', () => {
    const now = 1_000_000;
    const saved = saveAcquisition(7, 'watabou-one-page-dungeon', now);
    expect(saved.sourceId).toBe('watabou-one-page-dungeon');
    const loaded = loadAcquisition(7, now + 5);
    expect(loaded).toEqual(saved);
  });

  test('is isolated per campaign', () => {
    saveAcquisition(1, 'watabou-one-page-dungeon', 1000);
    saveAcquisition(2, 'donjon-fantasy-maps', 1000);
    expect(loadAcquisition(1, 1001)?.sourceId).toBe('watabou-one-page-dungeon');
    expect(loadAcquisition(2, 1001)?.sourceId).toBe('donjon-fantasy-maps');
  });

  test('clearAcquisition forgets the round trip', () => {
    saveAcquisition(3, 'donjon-fantasy-maps', 1000);
    clearAcquisition(3);
    expect(loadAcquisition(3, 1001)).toBeNull();
  });

  test('expires a stale marker and clears it', () => {
    const openedAt = 1_000_000;
    saveAcquisition(4, 'watabou-one-page-dungeon', openedAt);
    // Just inside the TTL: still present.
    expect(loadAcquisition(4, openedAt + ACQUISITION_TTL_MS - 1)).not.toBeNull();
    // Past the TTL: gone (and cleared, so a subsequent in-window read is still null).
    expect(loadAcquisition(4, openedAt + ACQUISITION_TTL_MS + 1)).toBeNull();
    expect(loadAcquisition(4, openedAt + 1)).toBeNull();
  });

  test('returns null (and clears) for malformed stored JSON', () => {
    globalThis.localStorage.setItem('cf.mapAcquisition.9', '{not json');
    expect(loadAcquisition(9, 1_000_000)).toBeNull();
    expect(globalThis.localStorage.getItem('cf.mapAcquisition.9')).toBeNull();
  });

  test('returns null for a structurally-invalid marker', () => {
    globalThis.localStorage.setItem('cf.mapAcquisition.10', JSON.stringify({ sourceId: 5 }));
    expect(loadAcquisition(10, 1_000_000)).toBeNull();
  });
});
