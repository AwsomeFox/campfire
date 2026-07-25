/**
 * Loading skeleton contracts (issue #677).
 *
 * Persona-audit finding: a shared Skeleton existed but AI/provider settings
 * showed plain "Loading…" text and Attendance/Scribe returned null, causing
 * layout shift on slow networks. These specs pin the four geometry-preserving
 * variants and the conditional-region gate without a browser.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  conditionalRegionPhase,
  SKELETON_TEST_IDS,
} from '../../src/components/loadingSkeletonState';

const ROOT = resolve(__dirname, '../../src');
const UI = resolve(ROOT, 'components/ui.tsx');
const ROUTER = resolve(ROOT, 'app/router.tsx');
const AI_DM_CARD = resolve(ROOT, 'features/settings/AiDmCard.tsx');
const PROVIDER_FORM = resolve(ROOT, 'features/settings/ProviderForm.tsx');
const SESSIONS = resolve(ROOT, 'features/sessions/SessionsPage.tsx');
const SCRIBE = resolve(ROOT, 'features/sessions/ScribePanel.tsx');
const REDUCED_MOTION = resolve(__dirname, 'reduced-motion.unit.spec.ts');

test.describe('conditional region gate (issue #677)', () => {
  test('loading → placeholder, resolved-off → hidden, resolved-on → content', () => {
    expect(conditionalRegionPhase(true, false)).toBe('loading');
    expect(conditionalRegionPhase(true, true)).toBe('loading');
    expect(conditionalRegionPhase(false, false)).toBe('ready-hidden');
    expect(conditionalRegionPhase(false, true)).toBe('ready-visible');
  });
});

test.describe('skeleton variant surface area (issue #677)', () => {
  const ui = readFileSync(UI, 'utf8');

  test('exports route, card, inline, and conditional-region primitives', () => {
    for (const symbol of ['SkeletonRoute', 'SkeletonCard', 'SkeletonConditionalRegion']) {
      expect(ui, `${symbol} must be exported from ui.tsx`).toContain(`export function ${symbol}`);
    }
    expect(ui).toContain('export const SkeletonInline = Skeleton');
    expect(ui).toMatch(/animate-pulse/);
    expect(ui).toMatch(/SKELETON_TEST_IDS/);
    const state = readFileSync(resolve(ROOT, 'components/loadingSkeletonState.ts'), 'utf8');
    for (const testId of Object.values(SKELETON_TEST_IDS)) {
      expect(state).toContain(testId);
    }
  });

  test('every variant exposes non-motion-only status text', () => {
    expect(ui).toMatch(/role="status"/);
    expect(ui).toMatch(/sr-only/);
    expect(ui).toMatch(/Loading…/);
    expect(ui).toMatch(/Loading page…/);
    expect(ui).toMatch(/Loading AI scribe…/);
    expect(ui).toMatch(/Loading attendance…/);
    expect(ui).toMatch(/Loading provider settings…/);
  });

  test('lazy routes use the route skeleton fallback', () => {
    const router = readFileSync(ROUTER, 'utf8');
    expect(router).toMatch(/SkeletonRoute/);
    expect(router).not.toMatch(/Loading…/);
  });

  test('AI DM card and provider form use geometry-preserving placeholders', () => {
    expect(readFileSync(AI_DM_CARD, 'utf8')).toMatch(/SkeletonCard/);
    expect(readFileSync(PROVIDER_FORM, 'utf8')).toMatch(/SkeletonConditionalRegion preset="provider-form"/);
    expect(readFileSync(AI_DM_CARD, 'utf8')).not.toMatch(/Loading…/);
    expect(readFileSync(PROVIDER_FORM, 'utf8')).not.toMatch(/Loading…/);
  });

  test('sessions recap and attendance reserve space while loading', () => {
    const sessions = readFileSync(SESSIONS, 'utf8');
    expect(sessions).toMatch(/Skeleton lines=\{4\} label="Loading recap…"/);
    expect(sessions).toMatch(/SkeletonConditionalRegion preset="attendance"/);
    expect(sessions).not.toMatch(/Loading recap…<\/p>/);
  });

  test('scribe panel gates with conditional-region skeleton instead of null', () => {
    const scribe = readFileSync(SCRIBE, 'utf8');
    expect(scribe).toMatch(/conditionalRegionPhase/);
    expect(scribe).toMatch(/SkeletonConditionalRegion preset="scribe"/);
    expect(scribe).not.toMatch(/if \(seatQuery\.isLoading\) return null/);
  });
});

test.describe('reduced-motion skeleton policy stays pinned (issue #677)', () => {
  test('reduced-motion unit spec still asserts skeleton status contract', () => {
    const reduced = readFileSync(REDUCED_MOTION, 'utf8');
    expect(reduced).toMatch(/SKELETON_TEST_IDS/);
    expect(reduced).toMatch(/animate-pulse/);
  });
});
