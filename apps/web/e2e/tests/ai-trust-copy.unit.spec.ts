/**
 * Policy-backed AI trust copy test (issue #752).
 *
 * The AI DM has two modes with materially different authority, and the trust copy must
 * not blur them:
 *   - Co-DM ONLY proposes — every change waits for a human DM to approve. It never writes
 *     to canon directly (co-dm.service.ts always files via the proposal queue).
 *   - Driver holds the DM seat and ACTS directly within its budget — narrating, rolling
 *     dice, applying HP/conditions, awarding XP, advancing turns, revealing map regions
 *     (the DRIVER_LIVE_PLAY_TOOLS allow-list in ai-driver.service.ts). Canon edits still
 *     become proposals in both modes.
 *
 * This test imports the ACTUAL copy sources (the i18n catalog — including the
 * `settings.aiDm.modeOptions.*.blurb` strings the settings card renders via `t()`,
 * the settings card MODES fallback constants, the login FEATURES) plus the canonical
 * `AI_DM_MODE_CAPABILITIES` manifest from @campfire/schema, and asserts:
 *   1. the dishonest blanket promise ("never touches canon without approval" applied to
 *      BOTH modes) is gone from every surface;
 *   2. every surface that mentions both modes keeps them distinct (Co-DM "proposes" /
 *      Driver "acts");
 *   3. each Driver direct-action capability keyword from the manifest appears in the
 *      Driver-facing copy, so a copy edit can't quietly drop a capability the seat has
 *      (or claim one it lacks);
 *   4. Co-DM copy never claims direct action, and Driver copy never claims canon changes
 *      apply without DM approval.
 *
 * This is a pure unit test — it touches no backend — so it runs under the same Playwright
 * runner as the other `.unit.spec.ts` files without needing the seeded server.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { AI_DM_MODE_CAPABILITIES } from '@campfire/schema';
import { MODES as AI_DM_CARD_MODES } from '../../src/features/settings/AiDmCard';
import { FEATURES as LOGIN_FEATURES } from '../../src/features/auth/LoginPage';
import aiOnboarding from '../../src/i18n/locales/en/aiOnboarding.json';
import settingsEn from '../../src/i18n/locales/en/settings.json';
import table from '../../src/i18n/locales/en/table.json';

const AR_SETTINGS_PATH = resolve(__dirname, '../../src/i18n/locales/ar/settings.json');
const settingsAr = existsSync(AR_SETTINGS_PATH)
  ? JSON.parse(readFileSync(AR_SETTINGS_PATH, 'utf8'))
  : settingsEn;

const ai = aiOnboarding.aiOnboarding;
const modeOptions = settingsEn.settings.aiDm.modeOptions;
const arModeOptions = settingsAr.settings.aiDm.modeOptions;

/**
 * English catalog blurbs the settings card actually renders via
 * `t('settings.aiDm.modeOptions.<mode>.blurb', { defaultValue: m.blurb })`.
 * Because the keys exist in `en/settings.json`, i18next returns these catalog
 * values - not the MODES fallback - for English users. #752 must guard these.
 */
const SETTINGS_CARD_CO_DM_BLURB = modeOptions.co_dm.blurb;
const SETTINGS_CARD_DRIVER_BLURB = modeOptions.driver.blurb;

/** Every user-facing string that discusses the AI DM, gathered by surface. */
const TRUST_SURFACES: ReadonlyArray<{ name: string; text: string; mentionsBoth: boolean }> = [
  {
    name: 'login feature (AI Dungeon Master)',
    text: LOGIN_FEATURES.find((f) => f.title === 'An AI Dungeon Master')?.body ?? '',
    mentionsBoth: true,
  },
  {
    name: 'settings card — Co-DM blurb',
    text: SETTINGS_CARD_CO_DM_BLURB,
    mentionsBoth: false,
  },
  {
    name: 'settings card — Driver blurb',
    text: SETTINGS_CARD_DRIVER_BLURB,
    mentionsBoth: false,
  },
  {
    name: 'transparency note',
    text: ai.transparency.body,
    mentionsBoth: true,
  },
  {
    name: 'onboarding mode step (todo)',
    text: ai.checklist.steps.mode.todo,
    mentionsBoth: true,
  },
  {
    // The readiness checklist renders the server-side `mode` check through this key (#519),
    // so the copy a DM with an off seat actually sees carries the same both-modes honesty
    // as the step copy above.
    name: 'readiness mode check (off)',
    text: ai.checklist.checkDetails.mode.off,
    mentionsBoth: true,
  },
  {
    name: 'onboarding allDone Co-DM',
    text: ai.checklist.allDoneCoDm,
    mentionsBoth: false,
  },
  {
    name: 'onboarding allDone Driver',
    text: ai.checklist.allDoneDriver,
    mentionsBoth: false,
  },
  {
    name: 'dashboard hint',
    text: ai.dashboard.hintBody,
    mentionsBoth: true,
  },
  {
    name: 'gate seatDisabled',
    text: ai.gate.seatDisabled.body,
    mentionsBoth: true,
  },
  {
    name: 'table off hint',
    text: table.table.offHint,
    mentionsBoth: true,
  },
  {
    name: 'table co-DM hint',
    text: table.table.coDmHint,
    mentionsBoth: true,
  },
];

/** The dishonest phrase the login page used to apply to BOTH modes (issue #752 evidence). */
const RETIRED_BLANKET_PROMISE = 'never touches canon without approval';

const driverKeywords = AI_DM_MODE_CAPABILITIES.driver.directActions
  .map((c: { label: string; copyKeyword: string }) => c.copyKeyword)
  .filter((k: string): k is string => k.length > 0);

test.describe('AI trust copy — Co-DM proposals vs Driver direct authority (#752)', () => {
  test('en catalog mode blurbs stay equal to the MODES fallback constants', () => {
    // AiDmCard renders catalog values when the key exists; MODES is only the
    // `defaultValue` fallback / fixture. Keep them byte-identical so a catalog-only
    // edit cannot bypass the capability assertions below (#1579 / Devin review).
    for (const mode of AI_DM_CARD_MODES) {
      const catalog = modeOptions[mode.value as keyof typeof modeOptions];
      expect(catalog.label, `${mode.value} label catalog==MODES`).toBe(mode.label);
      expect(catalog.blurb, `${mode.value} blurb catalog==MODES`).toBe(mode.blurb);
    }

    // Arabic is intentionally not the English keyword policy source, but it must keep real
    // localized entries for the same rendered catalog keys instead of falling through to MODES.
    if (existsSync(AR_SETTINGS_PATH)) {
      for (const mode of ['co_dm', 'driver'] as const) {
        expect(arModeOptions[mode].blurb, `ar settings.aiDm.modeOptions.${mode}.blurb`).toBeTruthy();
        expect(arModeOptions[mode].blurb).not.toBe(modeOptions[mode].blurb);
      }
    }
  });

  test('no surface repeats the retired blanket "never touches canon" promise', () => {
    for (const surface of TRUST_SURFACES) {
      expect(
        surface.text,
        `${surface.name} must not reuse the blanket promise`,
      ).not.toContain(RETIRED_BLANKET_PROMISE);
    }
  });

  test('surfaces that mention both modes keep Co-DM "proposes" and Driver "acts" distinct', () => {
    const PROPOSES = /propos/;
    const ACTS = /\bacts\b|\bact directly\b|holds the DM seat|runs the session itself|running the session/i;
    for (const surface of TRUST_SURFACES) {
      if (!surface.mentionsBoth) continue;
      const proposes = PROPOSES.test(surface.text);
      const acts = ACTS.test(surface.text);
      // A both-modes surface must signal the distinction: at least one of the two modes'
      // verbs, and the two must not be collapsed into a single blanket claim. We require
      // EITHER both verbs present OR an explicit "Co-DM ... Driver" contrast pair.
      const hasContrast = /co-?dm[\s\S]{0,160}driver|driver[\s\S]{0,160}co-?dm/i.test(surface.text);
      expect(
        (proposes && acts) || hasContrast,
        `${surface.name} must distinguish Co-DM (proposes) from Driver (acts); got: ${surface.text}`,
      ).toBe(true);
    }
  });

  test('Co-DM copy never claims direct action on the table', () => {
    const coDmSurfaces = [
      ai.checklist.steps.mode.doneCoDm,
      ai.checklist.checkDetails.mode.coDm,
      ai.checklist.allDoneCoDm,
      table.table.coDmHint,
      SETTINGS_CARD_CO_DM_BLURB,
    ];
    for (const text of coDmSurfaces) {
      // Co-DM must be described as proposing/awaiting approval, never as acting directly.
      expect(
        /propos|approv|waits|never writes|only/.test(text),
        `Co-DM copy must frame proposing/approval, not direct action: ${text}`,
      ).toBe(true);
      expect(text, 'Co-DM copy must not claim it holds the DM seat').not.toMatch(
        /holds the DM seat|acts directly as the DM/i,
      );
    }
  });

  test('Driver copy claims direct authority (holds the DM seat / acts directly)', () => {
    const driverSurfaces = [
      { name: 'settings card Driver blurb', text: SETTINGS_CARD_DRIVER_BLURB },
      { name: 'allDone Driver', text: ai.checklist.allDoneDriver },
      { name: 'mode doneDriver', text: ai.checklist.steps.mode.doneDriver },
      { name: 'readiness mode check (driver)', text: ai.checklist.checkDetails.mode.driver },
      { name: 'badge driverAria', text: ai.badge.driverAria },
    ];
    // Driver must read as the AI acting AS the DM — holding the seat / running the table —
    // not as a passive assistant. Any of these phrasings counts.
    const directAuthority =
      /holds the DM seat|acts directly|running (?:the|this) (?:session|campaign)|runs the session|as the DM/i;
    for (const { name, text } of driverSurfaces) {
      expect(
        directAuthority.test(text),
        `${name} must state Driver's direct authority honestly: ${text}`,
      ).toBe(true);
    }
  });

  test('Driver copy names each direct-action capability from the canonical manifest', () => {
    // The settings card is the canonical Driver copy surface; it must enumerate the
    // representative direct actions the seat performs so a DM enables Driver mode with
    // accurate expectations. Keywords come from AI_DM_MODE_CAPABILITIES — the same
    // source the server's DRIVER_LIVE_PLAY_TOOLS concept backs.
    const driverCopy = SETTINGS_CARD_DRIVER_BLURB;
    const missing: string[] = [];
    for (const keyword of driverKeywords) {
      if (!driverCopy.toLowerCase().includes(keyword.toLowerCase())) {
        missing.push(keyword);
      }
    }
    expect(
      missing,
      `Driver settings copy must name every headline direct-action capability; missing: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  test('both modes still route canon edits through DM-approved proposals', () => {
    // The one thing the two modes SHARE: new canon (NPCs, quests, locations) always
    // becomes a proposal. The trust copy must keep this honest alongside Driver's
    // direct authority, so Driver never reads as "edits canon at will". The copy must
    // co-locate the words "canon" and "proposal" so a reader sees the boundary.
    const driverCard = SETTINGS_CARD_DRIVER_BLURB;
    const transparency = ai.transparency.body;
    expect(driverCard, 'Driver copy must disclose canon edits still become proposals').toMatch(
      /proposal/i,
    );
    expect(transparency, 'transparency note must mention both canon and proposal').toMatch(/canon/i);
    expect(transparency, 'transparency note must mention both canon and proposal').toMatch(
      /proposal/i,
    );
  });

  test('the canonical manifest matches the two-mode authority model', () => {
    // Guard against the manifest itself drifting away from the policy it documents.
    expect(AI_DM_MODE_CAPABILITIES.co_dm.proposes).toBe(true);
    expect(AI_DM_MODE_CAPABILITIES.co_dm.directActions).toEqual([]);
    expect(AI_DM_MODE_CAPABILITIES.co_dm.canonViaProposal).toBe(true);

    expect(AI_DM_MODE_CAPABILITIES.driver.proposes).toBe(true);
    expect(AI_DM_MODE_CAPABILITIES.driver.directActions.length).toBeGreaterThan(0);
    expect(AI_DM_MODE_CAPABILITIES.driver.canonViaProposal).toBe(true);

    expect(AI_DM_MODE_CAPABILITIES.off.proposes).toBe(false);
    expect(AI_DM_MODE_CAPABILITIES.off.directActions).toEqual([]);
  });
});
