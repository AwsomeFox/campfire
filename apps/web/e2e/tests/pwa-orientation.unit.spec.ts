/**
 * Issue #797 — PWA orientation must not lock the installed app to portrait.
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
import { resolve } from 'node:path';

const VITE_CONFIG = resolve(__dirname, '../../vite.config.ts');

test.describe('PWA manifest orientation (#797)', () => {
  test('vite PWA manifest does not portrait-lock the installed app', () => {
    const src = readFileSync(VITE_CONFIG, 'utf8');

    // Reject the pre-fix portrait lock if it returns (quoted string form used
    // in vite.config.ts). Allow `"any"` or omitting the field entirely.
    expect(src).not.toMatch(/orientation\s*:\s*["']portrait["']/);
    expect(src).not.toMatch(/orientation\s*:\s*["']portrait-/);

    const orientationMatch = src.match(/orientation\s*:\s*["']([^"']+)["']/);
    if (orientationMatch) {
      const value = orientationMatch[1];
      expect(value).toBe('any');
    }
  });
});
