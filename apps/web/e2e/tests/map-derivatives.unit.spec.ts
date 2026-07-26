/**
 * Responsive map delivery (issue #604).
 *
 * The map surfaces used to point an <img> straight at the original, so a phone
 * downloaded a full-resolution world/battle map to render a ~390px card. These
 * tests pin the descriptor maths that makes `srcset` pick a phone-sized rung, plus
 * the states where offering a srcset would be WRONG (nothing ready yet, or rungs
 * that have no bytes on disk).
 *
 * Pure module under test — no browser needed.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AttachmentDerivativeManifest } from '@campfire/schema';
import { buildSrcSet, encounterMapSrcSet } from '../../src/components/attachmentSrcSet';

const REGION_MAP = resolve(__dirname, '../../src/features/dashboard/RegionMap.tsx');
const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');

/** A landscape map whose rungs have the real (non-square) widths the server reports. */
function landscapeManifest(): AttachmentDerivativeManifest {
  return {
    attachmentId: 7,
    status: 'ready',
    stale: false,
    derivatives: [
      { variant: 'thumb', state: 'ready', width: 512, height: 288, bytes: 40_000, format: 'image/png', attempts: 1, lastError: '', stale: false },
      { variant: 'md', state: 'ready', width: 1280, height: 720, bytes: 210_000, format: 'image/png', attempts: 1, lastError: '', stale: false },
      { variant: 'lg', state: 'ready', width: 2560, height: 1440, bytes: 780_000, format: 'image/png', attempts: 1, lastError: '', stale: false },
    ],
  };
}

test.describe('map derivative srcset (issue #604)', () => {
  test('emits one w-descriptor per ready rung, using the real pixel width', () => {
    const srcset = buildSrcSet(landscapeManifest(), (variant) => `/img/${variant}`);
    expect(srcset).toBe('/img/thumb 512w, /img/md 1280w, /img/lg 2560w');
  });

  test('a PORTRAIT map does not claim the rung cap as its width', () => {
    // 1000x4000: the `md` rung is capped on the LONGEST edge, so it is 320 wide.
    // Claiming 1280w here would make a browser pick a rung four times too small.
    const portrait: AttachmentDerivativeManifest = {
      attachmentId: 8,
      status: 'ready',
      stale: false,
      derivatives: [
        { variant: 'md', state: 'ready', width: 320, height: 1280, bytes: 90_000, format: 'image/png', attempts: 1, lastError: '', stale: false },
      ],
    };
    expect(buildSrcSet(portrait, (v) => `/img/${v}`)).toBe('/img/md 320w');
  });

  test('a phone-sized slot is covered by the smallest rung', () => {
    // A 390px CSS slot at 1x needs >=390 real px; at 2x it needs >=780. The ladder
    // gives the browser a 512w option for the former and 1280w for the latter,
    // instead of the multi-thousand-pixel original both used to receive.
    const rungs = landscapeManifest().derivatives.map((d) => d.width);
    expect(rungs.some((w) => w >= 390 && w < 1000)).toBe(true);
    expect(Math.min(...rungs)).toBeLessThan(1000);
  });

  test('pending, failed and skipped rungs are never offered', () => {
    // Each of these would resolve to the ORIGINAL on the server, i.e. the browser
    // would silently download the largest possible image for the smallest slot.
    const mixed: AttachmentDerivativeManifest = {
      attachmentId: 9,
      status: 'processing',
      stale: false,
      derivatives: [
        { variant: 'thumb', state: 'pending', width: 0, height: 0, bytes: 0, format: '', attempts: 0, lastError: '', stale: false },
        { variant: 'md', state: 'failed', width: 0, height: 0, bytes: 0, format: '', attempts: 3, lastError: 'boom', stale: false },
        { variant: 'lg', state: 'skipped', width: 0, height: 0, bytes: 0, format: '', attempts: 0, lastError: '', stale: false },
      ],
    };
    expect(buildSrcSet(mixed, (v) => `/img/${v}`)).toBeUndefined();
  });

  test('no manifest yet means no srcset at all (plain src keeps working)', () => {
    expect(buildSrcSet(null, (v) => `/img/${v}`)).toBeUndefined();
  });

  test('encounter srcset stays on the role-safe map route and carries the revision', () => {
    const srcset = encounterMapSrcSet(42, '2026-01-02T03:04:05.000Z', landscapeManifest());
    expect(srcset).toBeTruthy();
    for (const entry of srcset!.split(', ')) {
      // #463: a player's responsive map must never reference /attachments/.
      expect(entry).toContain('/encounters/42/map?revision=');
      expect(entry).not.toContain('/attachments/');
    }
    expect(srcset).toContain('&size=thumb 512w');
    expect(srcset).toContain('&size=lg 2560w');
  });
});

test.describe('map surfaces consume the ladder (issue #604)', () => {
  test('the world map renders srcSet + sizes and offers a download-original link', () => {
    const src = readFileSync(REGION_MAP, 'utf8');
    expect(src).toContain('attachmentSrcSet');
    expect(src).toContain('srcSet={mapSrcSet}');
    expect(src).toContain('sizes={mapSrcSet ? mapSizes : undefined}');
    // Explicit original download for the DM must survive refactors of this card.
    expect(src).toContain('world-map-download-original');
    expect(src).toContain("download: '1'");
    // Processing / stale / error states.
    expect(src).toContain('world-map-derivative-status');
    expect(src).toContain('derivatives.retry()');
  });

  test('the battle map renders srcSet and a derivative status row', () => {
    const src = readFileSync(RUN_SESSION_PAGE, 'utf8');
    expect(src).toContain('encounterMapSrcSet');
    expect(src).toContain('srcSet={mapSrcSet}');
    expect(src).toContain('battle-map-derivative-status');
    // The manifest must be read through the encounter route, not the attachment
    // route — otherwise a player would 404 and lose responsive delivery (#463).
    expect(src).toContain('/map/derivatives');
  });
});
