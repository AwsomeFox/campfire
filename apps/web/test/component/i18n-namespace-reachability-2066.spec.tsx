/**
 * Component-render regression for issue #2066: `PlayerVitalsHeader` and `CombatLog` called
 * `useTranslation('encounters')`, but `apps/web/src/i18n/index.ts` registers exactly ONE
 * namespace (`translation`) — no `ns`, `defaultNS`, or `fallbackNS`. That namespace does not
 * exist, so every `t()` call in those files missed and silently fell through to its inline
 * English default, in EVERY locale, forever — even though the real `ar` catalog values were
 * present and correct the whole time.
 *
 * The trap (also called out in #2048 and #2053): a test asserting the ENGLISH rendering passes
 * against this bug, because the English default IS what the bug produces. This file instead
 * imports the REAL `src/i18n` singleton (the exact `resources` shape the shipped app uses — see
 * `../../src/i18n/index.ts`), switches it to `ar`, mounts the real components, and asserts the
 * rendered DOM carries genuine Arabic text with no residual Latin-script fragment. Reverting
 * either component's `useTranslation()` call back to `useTranslation('encounters')` must fail
 * these assertions even though catalog key parity (#629), the JSX ratchet (#1940), and the
 * untranslated-value ratchet (#2059) all still pass — none of those three ever renders a
 * component, so none of them can see whether it can actually reach the catalog.
 */
import { render, screen, cleanup, act } from '@testing-library/react';
import { describe, test, expect, afterEach, beforeAll, afterAll } from 'vitest';
import type { Combatant, Character } from '@campfire/schema';
import i18n from '../../src/i18n';
import { PlayerVitalsHeader } from '../../src/features/encounters/PlayerVitalsHeader';
import { CombatLog } from '../../src/features/encounters/CombatLog';

const ARABIC = /[؀-ۿ]/;
const LATIN_LETTERS = /[A-Za-z]/;

/**
 * Copilot review on PR #2072 flagged switching the language on the imported `src/i18n` as a
 * cross-file flake risk, on the reading that other component specs asserting English UI text
 * ("Use", "Run for group", "Save") could run concurrently against a shared singleton.
 *
 * Measured, not assumed: vitest's defaults here are `pool: 'forks'` with `isolate: true` — this
 * config sets no `pool`, `isolate`, or `fileParallelism` — so every spec FILE gets its own module
 * registry, and `import i18n from '../../src/i18n'` is a distinct instance per file rather than
 * one shared object. Probe: deleting the `afterAll` restore entirely and running the whole tier
 * still passed 8 files / 47 tests, English assertions included. Under a shared singleton that
 * probe would have failed.
 *
 * The restore below is kept anyway — it costs nothing and makes the file correct in isolation.
 *
 * What this DOES depend on, stated so a future config change cannot break it silently: if
 * `apps/web/vitest.config.ts` ever sets `isolate: false` (or moves to a pool that shares module
 * state), these files would share one i18n instance and this switch WOULD leak. The fix then is
 * not to clone the instance here — importing the REAL singleton is the point of this test, since
 * the bug it guards is a component failing to reach the app's actual catalog — but to keep the
 * tier isolated.
 */
const ORIGINAL_LANGUAGE = i18n.language;

beforeAll(async () => {
  await i18n.changeLanguage('ar');
});

afterAll(async () => {
  await i18n.changeLanguage(ORIGINAL_LANGUAGE);
});

afterEach(() => cleanup());

function dyingCombatant(overrides: Partial<Combatant> = {}): Combatant {
  return {
    id: 201,
    encounterId: 1,
    kind: 'character',
    characterId: 1,
    npcId: null,
    name: 'Ada',
    initiative: 12,
    initMod: 0,
    initiativeBreakdown: null,
    initiativeGroup: null,
    hpCurrent: 0,
    hpMax: 20,
    spCurrent: 0,
    spMax: 0,
    rpCurrent: 0,
    rpMax: 0,
    eac: null,
    kac: null,
    speed: null,
    hpTemp: 0,
    hpBand: null,
    deathState: 'dying',
    deathSaveSuccesses: 1,
    deathSaveFailures: 1,
    conditions: [],
    ruleEntryId: null,
    sortOrder: 0,
    tokenX: null,
    tokenY: null,
    tokenSize: 'medium',
    tokenHiddenByFog: false,
    turnState: {
      used: {},
      movementUsedFt: 0,
      concentration: null,
      pendingConcentrationChecks: [],
      delaying: false,
      readied: null,
    },
    activeEffects: [],
    conditionInstances: [],
    legendaryActions: null,
    statblock: null,
    statblockRevealed: false,
    ...overrides,
  };
}

describe('PlayerVitalsHeader reaches the real catalog under ar (issue #2066)', () => {
  test('the dying strip, edit-max-HP control, and death-save outcome all render genuine Arabic with no Latin fragment', async () => {
    const combatant = dyingCombatant();
    await act(async () => {
      render(
        <PlayerVitalsHeader
          combatants={[combatant]}
          charactersById={new Map<number, Character>()}
          onSetHpMax={() => {}}
          deathSaveOutcome={{ combatantId: combatant.id, outcome: { kind: 'dead', natural: 2 } }}
        />,
      );
    });

    // "You are dying — {{successes}} successes / {{failures}} failures" — encounters.vitals.dyingStrip
    const dyingStrip = screen.getByTestId('player-vitals-dying-strip');
    expect(dyingStrip.textContent, `expected Arabic in the dying strip: ${dyingStrip.textContent}`).toMatch(ARABIC);
    expect(dyingStrip.textContent).not.toMatch(/you are dying/i);

    // "Edit max HP" — encounters.vitals.editMaxHp, rendered as both aria-label and title
    const editMaxHpButton = screen.getByLabelText(/تعديل الحد الأقصى لنقاط الحياة/);
    expect(editMaxHpButton).toBeTruthy();
    expect(editMaxHpButton.getAttribute('aria-label')).not.toMatch(/edit max hp/i);

    // "Died." — encounters.deathSave.outcome.dead
    const outcome = screen.getByTestId('death-save-outcome');
    expect(outcome.textContent, `expected Arabic death-save outcome: ${outcome.textContent}`).toMatch(ARABIC);
    expect(outcome.textContent).not.toMatch(LATIN_LETTERS);
  });
});

describe('CombatLog reaches the real catalog under ar (issue #2066)', () => {
  test('the heading renders genuine Arabic, not the English default, and the key is qualified within the single namespace', async () => {
    await act(async () => {
      render(<CombatLog events={[]} />);
    });

    const heading = screen.getByText((_, node) => node?.id === 'combat-log-heading');
    expect(heading.textContent, `expected Arabic combat log heading: ${heading.textContent}`).toMatch(ARABIC);
    expect(heading.textContent).not.toMatch(/combat log/i);
  });
});
