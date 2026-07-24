/**
 * Issue #797 — PWA orientation must not lock the installed app.
 *
 * Persona-audit finding: `orientation: "portrait"` in the VitePWA manifest
 * blocked landscape layouts needed for encounter maps, AI table, and player
 * display. Acceptance: omit orientation or use `"any"`.
 *
 * This suite pins the source config (no build required). The emitted
 * `manifest.webmanifest` is additionally guarded by `scripts/check-pwa-dist.mjs`
 * under `npm run test:pwa`.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const VITE_CONFIG = fileURLToPath(new URL('../../vite.config.ts', import.meta.url));

/** Extract the object-literal body after `manifest: {` inside the VitePWA(...) call. */
function vitePwaManifestBlock(src: string): string {
  const vitePwaIdx = src.search(/VitePWA\s*\(/);
  expect(vitePwaIdx, 'VitePWA(...) call not found in vite.config.ts').toBeGreaterThanOrEqual(0);
  const fromVitePwa = src.slice(vitePwaIdx);

  const manifestKey = fromVitePwa.match(/\bmanifest\s*:\s*\{/);
  expect(manifestKey?.index, 'manifest: { not found inside VitePWA(...)').toBeDefined();
  const openBrace = manifestKey!.index! + manifestKey![0].lastIndexOf('{');

  let depth = 0;
  for (let i = openBrace; i < fromVitePwa.length; i++) {
    const ch = fromVitePwa[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return fromVitePwa.slice(openBrace + 1, i);
    }
  }
  throw new Error('unclosed VitePWA manifest object in vite.config.ts');
}

test.describe('PWA manifest orientation (#797)', () => {
  test('vite PWA manifest does not lock the installed app orientation', () => {
    const src = readFileSync(VITE_CONFIG, 'utf8');
    const manifestBlock = vitePwaManifestBlock(src);

    // Only inspect orientation inside the VitePWA manifest block — unrelated
    // orientation keys elsewhere in the file must not affect this guard.
    // Allow `"any"` or omitting the field; reject portrait* and landscape* locks.
    const orientationMatch = manifestBlock.match(/orientation\s*:\s*["']([^"']+)["']/);
    if (orientationMatch) {
      expect(orientationMatch[1]).toBe('any');
    }
  });
});
