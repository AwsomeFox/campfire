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
import { buildSrcSet, encounterMapSrcSet, planEncounterMapResponsive } from '../../src/components/attachmentSrcSet';
import { isSensitiveApiPathname, matchApiJsonCache, matchNetworkOnlyApi } from '../../src/lib/pwaCachePolicy';

const REGION_MAP = resolve(__dirname, '../../src/features/dashboard/RegionMap.tsx');
const BATTLE_MAP = resolve(__dirname, '../../src/features/encounters/map/BattleMap.tsx');

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
    const src = readFileSync(BATTLE_MAP, 'utf8');
    expect(src).toContain('encounterMapSrcSet');
    expect(src).toContain('srcSet={mapSrcSet}');
    expect(src).toContain('battle-map-derivative-status');
    // The manifest must be read through the encounter route, not the attachment
    // route — otherwise a player would 404 and lose responsive delivery (#463).
    // The URL itself is minted by planEncounterMapResponsive (asserted below).
    expect(src).toContain('planEncounterMapResponsive');
  });
});

test.describe('cast displays get NO responsive delivery (issues #547 + #604)', () => {
  // The rule this suite exists for: a Player Display / TV authenticates with a
  // castToken in the URL, but the manifest and every srcset rung authenticate from
  // the session COOKIE. On a TV still carrying a DM's cookie, one srcset rung would
  // serve the DM's UNFOGGED SOURCE map — the exact fog leak #547 closed. So with a
  // castToken present, responsive delivery must be off in every respect.
  const base = { encounterId: 42, mapAttachmentId: 7, canDmWrite: true };

  test('a castToken disables the manifest fetch, the retry, AND the srcset', () => {
    const plan = planEncounterMapResponsive({ ...base, castToken: 'cast-abc123' });
    expect(plan.manifestUrl).toBeNull();
    expect(plan.retryUrl).toBeNull();
    expect(plan.responsive).toBe(false);
  });

  test('a cast display emits no srcset even with a fully ready ladder', () => {
    // The ladder being ready is precisely the dangerous case: buildSrcSet WOULD
    // happily produce rungs, so the guard — not an empty manifest — must be what
    // suppresses them.
    const plan = planEncounterMapResponsive({ ...base, castToken: 'cast-abc123' });
    const srcSet = plan.responsive
      ? encounterMapSrcSet(base.encounterId, '2026-01-02T03:04:05.000Z', landscapeManifest())
      : undefined;
    expect(srcSet).toBeUndefined();
    // Sanity: the same manifest DOES yield rungs once the cast guard is absent, so
    // this test cannot pass merely because the fixture is empty.
    expect(encounterMapSrcSet(base.encounterId, '2026-01-02T03:04:05.000Z', landscapeManifest())).toBeTruthy();
  });

  test('a normal session keeps responsive delivery on the role-safe route', () => {
    const plan = planEncounterMapResponsive({ ...base, castToken: null });
    expect(plan.responsive).toBe(true);
    expect(plan.manifestUrl).toContain('/encounters/42/map/derivatives');
    expect(plan.manifestUrl).not.toContain('/attachments/');
    expect(plan.retryUrl).toContain('/attachments/7/derivatives/retry');
  });

  test('a player (no DM write) gets the ladder but no regenerate URL', () => {
    const plan = planEncounterMapResponsive({ ...base, canDmWrite: false, castToken: null });
    expect(plan.responsive).toBe(true);
    expect(plan.manifestUrl).toContain('/encounters/42/map/derivatives');
    expect(plan.retryUrl).toBeNull();
  });

  test('an encounter with no map plans nothing', () => {
    const plan = planEncounterMapResponsive({ ...base, mapAttachmentId: null, castToken: null });
    expect(plan).toEqual({ manifestUrl: null, retryUrl: null, responsive: false });
  });
});

test.describe('the derivative manifest never enters Cache Storage (#463 + #604)', () => {
  // Regression for the CI failure this PR first shipped: `/map/derivatives` matched
  // the `encounters/:id/` JSON allowlist, so the service worker retained it in the
  // origin-wide `campfire-api-json` bucket — map data surviving on a shared device,
  // and a broken #463 invariant.
  const manifestPath = '/api/v1/encounters/9/map/derivatives';

  test('the manifest route is NetworkOnly, not JSON-cached', () => {
    const url = new URL(manifestPath, 'http://campfire.test');
    const request = new Request(url, { method: 'GET' });
    expect(matchNetworkOnlyApi({ url, request })).toBe(true);
    expect(matchApiJsonCache({ url, request })).toBe(false);
  });

  test('the whole /map subtree counts as sensitive for the logout/activate purge', () => {
    expect(isSensitiveApiPathname('/api/v1/encounters/9/map')).toBe(true);
    expect(isSensitiveApiPathname(manifestPath)).toBe(true);
  });

  test('every srcset rung stays NetworkOnly too', () => {
    for (const entry of encounterMapSrcSet(9, '2026-01-01T00:00:00.000Z', landscapeManifest())!.split(', ')) {
      const url = new URL(entry.split(' ')[0], 'http://campfire.test');
      const request = new Request(url, { method: 'GET' });
      expect(matchNetworkOnlyApi({ url, request })).toBe(true);
      expect(matchApiJsonCache({ url, request })).toBe(false);
    }
  });

  test('sibling encounter JSON reads are still cacheable (no over-broad exclusion)', () => {
    for (const path of ['/api/v1/encounters/9', '/api/v1/encounters/9/events']) {
      const url = new URL(path, 'http://campfire.test');
      const request = new Request(url, { method: 'GET' });
      expect(matchNetworkOnlyApi({ url, request })).toBe(false);
      expect(matchApiJsonCache({ url, request })).toBe(true);
    }
  });
});
