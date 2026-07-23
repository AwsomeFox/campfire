/**
 * Issue #797 — PWA orientation: allow landscape for encounter maps, AI table,
 * and player display.
 *
 * The PWA manifest previously locked the installed app to portrait via
 * `orientation: "portrait"` in vite.config.ts. This blocked the wider layout
 * needed for encounter maps, AI table, and live-play player displays.
 *
 * The fix: change the manifest orientation to "any" so the OS and user control
 * rotation freely. Route-level fullscreen orientation requests remain
 * user-initiated and failure-tolerant.
 *
 * This spec validates that the vite PWA plugin config does NOT lock to portrait,
 * ensuring the regression cannot silently return.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Extract the manifest config object from vite.config.ts source text.
 * We parse the orientation value directly from the source to catch regressions
 * at the config level — before any build artifact is produced.
 */
function readOrientationFromViteConfig(): string | undefined {
  const configPath = resolve(__dirname, '../../vite.config.ts');
  const source = readFileSync(configPath, 'utf-8');

  // Match `orientation: "..."` or `orientation: '...'` in the manifest block.
  const match = source.match(/orientation:\s*["']([^"']+)["']/);
  return match?.[1];
}

test.describe('PWA manifest orientation (#797)', () => {
  test('manifest orientation is not locked to portrait', () => {
    const orientation = readOrientationFromViteConfig();
    // The orientation must NOT be "portrait" or "portrait-primary" —
    // either "any", "natural", or omitted entirely are acceptable.
    expect(orientation).not.toBe('portrait');
    expect(orientation).not.toBe('portrait-primary');
    expect(orientation).not.toBe('portrait-secondary');
  });

  test('manifest orientation is set to "any" to allow free rotation', () => {
    const orientation = readOrientationFromViteConfig();
    // We specifically chose "any" to give the OS and user full control.
    expect(orientation).toBe('any');
  });

  test('orientation value is a valid Web App Manifest orientation member', () => {
    const orientation = readOrientationFromViteConfig();
    // Valid values per W3C Web App Manifest spec §display-modes:
    const validOrientations = [
      'any',
      'natural',
      'landscape',
      'landscape-primary',
      'landscape-secondary',
      'portrait',
      'portrait-primary',
      'portrait-secondary',
    ];
    expect(orientation).toBeDefined();
    expect(validOrientations).toContain(orientation);
  });
});
