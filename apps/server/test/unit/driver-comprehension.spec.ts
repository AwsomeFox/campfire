import {
  AI_DM_COMPREHENSION_PROFILE_AXES,
  AI_DM_COMPREHENSION_PROFILE_DEFAULTS,
  AI_DM_COMPREHENSION_PROFILE_OPTIONS,
  AI_DM_COMPREHENSION_SECTION_MAX_TOKENS,
  AI_DM_PROMPT_HISTORY_MAX_TOKENS,
  AI_DM_STYLE_SECTION_MAX_TOKENS,
  AiDmChoiceCount,
  AiDmComprehensionProfile,
  AiDmParagraphLength,
  AiDmReadingComplexity,
  AiDmSensoryIntensity,
  type AiDmComprehensionProfile as ComprehensionProfile,
} from '@campfire/schema';
import { estimateTokens } from '../../src/modules/ai-dm/ai-dm.provider';
import {
  COMPREHENSION_HEADING,
  isDefaultComprehensionProfile,
  renderComprehensionSection,
} from '../../src/modules/ai-driver/driver-comprehension';

/**
 * Comprehension profile (#874).
 *
 * AI Driver only ever said "Narrate vividly" and gave players a blank composer — no
 * reading-level/chunking guidance, no stated default ending shape, and no way to ask for a
 * turn again more simply. These tests guard the claims the feature makes about itself:
 *   - the BASELINE (chunking, the "What changed" / "What can you do" ending, non-exclusive
 *     suggestions offered alongside free text, rules kept apart from prose, and
 *     Simplify/Recap/Explain support) is the issue's stated DEFAULT and is present on every
 *     seat, configured or not — the opposite of #1049's "silent until asked for";
 *   - the OPTIONAL per-axis fine-tuning still costs nothing extra until a DM opts in, and its
 *     added cost is bounded and known, exactly like #1049's style section; and
 *   - none of the above ever tells the model to stop accepting free text — the issue's title
 *     constraint, checked in the rendered TEXT rather than assumed from the composer UI.
 */

function profile(overrides: Partial<ComprehensionProfile> = {}): ComprehensionProfile {
  return AiDmComprehensionProfile.parse({ ...AI_DM_COMPREHENSION_PROFILE_DEFAULTS, ...overrides });
}

describe('#874 comprehension profile — the baseline is the default, not an opt-in', () => {
  it('renders the fixed baseline even when every axis is left on default', () => {
    const section = renderComprehensionSection(profile());
    expect(section.startsWith(COMPREHENSION_HEADING)).toBe(true);
    expect(section).toContain('What changed');
    expect(section).toContain('What can you do');
    expect(section).toMatch(/2 to 4 NON-EXCLUSIVE suggestions/);
    expect(section).toMatch(/mechanical outcomes.*on their own line/i);
    expect(section).toMatch(/simplify/i);
    expect(section).toMatch(/recap/i);
    expect(section).toMatch(/explain/i);
    expect(isDefaultComprehensionProfile(profile())).toBe(true);
  });

  it('never returns null — unlike #1049s renderTableStyleSection, the baseline is never skipped', () => {
    expect(typeof renderComprehensionSection(profile())).toBe('string');
    expect(typeof renderComprehensionSection(null)).toBe('string');
    expect(typeof renderComprehensionSection(undefined)).toBe('string');
  });

  it('treats a missing or empty profile as "no ADDITIONAL preference" — still gets the baseline', () => {
    // A seat row that predates the migration decodes as '{}'. It must still read as the
    // baseline default rather than throwing or inventing a preference nobody chose.
    for (const value of [null, undefined, AiDmComprehensionProfile.parse({})]) {
      const section = renderComprehensionSection(value);
      expect(section).toContain(COMPREHENSION_HEADING);
      expect(section).toContain('What changed');
    }
    expect(isDefaultComprehensionProfile(null)).toBe(true);
    expect(isDefaultComprehensionProfile(undefined)).toBe(true);
  });

  it('the title constraint: freeform survives on every profile setting, stated in the text', () => {
    // Checked directly against the rendered prompt, not merely assumed from the composer UI
    // never changing shape — the model is repeatedly told the suggestions are illustrations.
    const configs = [
      profile(),
      profile({ readingComplexity: 'simple' }),
      profile({ choiceCount: 'two' }),
      profile({ readingComplexity: 'rich', paragraphLength: 'long', sensoryIntensity: 'vivid', choiceCount: 'four' }),
    ];
    for (const p of configs) {
      const section = renderComprehensionSection(p);
      expect(section).toMatch(/NEVER the only input/);
      expect(section).toMatch(/describe anything else in their own words/);
      expect(section).toMatch(/never present the suggestions as a menu that replaces free text/);
    }
  });
});

describe('#874 comprehension profile — the phase direction outranks the ending shape (review)', () => {
  it('names the lifecycle phases where the "What can you do" ending does not apply', () => {
    // The baseline mandates an ending shape written for a turn of PLAY, and the same prompt
    // carries PHASE_DIRECTION: wrap_up says not to ask the players anything, `ended` says
    // logistics only and do not narrate, greeting has nothing that "changed" yet. Without
    // this the prompt held a contradiction the model resolved on its own — possibly by
    // closing a session with a menu of next actions.
    const section = renderComprehensionSection(null);
    expect(section).toMatch(/unless the phase direction says otherwise/i);
    for (const phase of ['greeting', 'wrap-up', 'ended']) {
      expect(section.toLowerCase()).toContain(phase);
    }
  });

  it('subordinates ONLY the ending shape — the rest still applies on every turn', () => {
    // Gating the whole section on phase would drop chunking, plain-language mechanics and
    // simplify/recap/explain from exactly the turns (a wrap-up summary) that need them most.
    // The qualification therefore sits ON the ending-shape line, not on the section.
    const section = renderComprehensionSection(null);
    const endingLine = section.split('\n').find((l) => l.includes('What changed'));
    expect(endingLine).toMatch(/unless the phase direction says otherwise/i);
    for (const unqualified of [
      'Chunk narration into short, readable beats',
      'Keep mechanical outcomes',
      'Answer simplify/recap/explain',
    ]) {
      const line = section.split('\n').find((l) => l.includes(unqualified));
      expect(line).toBeDefined();
      expect(line).not.toMatch(/unless the phase direction/i);
    }
  });
});

describe('#874 comprehension profile — optional per-axis fine-tuning', () => {
  it('renders only the axes that were actually set', () => {
    const section = renderComprehensionSection(profile({ readingComplexity: 'simple' }));
    expect(section).toContain('- Reading complexity:');
    // Silence on an axis is a real answer: the model should not be told a preference the DM
    // never expressed.
    expect(section).not.toContain('- Paragraph length:');
    expect(section).not.toContain('- Sensory intensity:');
    expect(section).not.toContain('- Suggested choices:');
  });

  it('renders a line per axis when all four are set', () => {
    const section = renderComprehensionSection(
      profile({ readingComplexity: 'rich', paragraphLength: 'long', sensoryIntensity: 'vivid', choiceCount: 'four' }),
    );
    for (const label of ['- Reading complexity:', '- Paragraph length:', '- Sensory intensity:', '- Suggested choices:']) {
      expect(section).toContain(label);
    }
  });
});

describe('#874 comprehension profile — bounded cost', () => {
  it('the WORST CASE (fixed baseline + every axis at its longest option) stays under the declared ceiling', () => {
    let worst = 0;
    for (const readingComplexity of AiDmReadingComplexity.options) {
      for (const paragraphLength of AiDmParagraphLength.options) {
        for (const sensoryIntensity of AiDmSensoryIntensity.options) {
          for (const choiceCount of AiDmChoiceCount.options) {
            const section = renderComprehensionSection(
              profile({ readingComplexity, paragraphLength, sensoryIntensity, choiceCount }),
            );
            worst = Math.max(worst, estimateTokens(section));
          }
        }
      }
    }
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThanOrEqual(AI_DM_COMPREHENSION_SECTION_MAX_TOKENS);
  });

  it('the baseline itself (all-default) is comfortably inside the ceiling on its own', () => {
    // Sanity check: the fixed cost must not already consume most of the budget before any
    // per-axis line is even added, or the ceiling would be meaningless headroom.
    const baseline = estimateTokens(renderComprehensionSection(profile()));
    expect(baseline).toBeGreaterThan(0);
    expect(baseline).toBeLessThan(AI_DM_COMPREHENSION_SECTION_MAX_TOKENS);
  });
});

/**
 * #1038 × #1049 × #874 — the combined system-prompt budget, extended to the new section.
 *
 * Same reasoning as the #1038 × #1049 check in ai-driver-style.spec.ts: both consumers are
 * bounded by EXPLICIT CONSTANTS rather than a fraction of the model's context window, because
 * every token is paid on every turn and every #1052 retry/fallback attempt. `## Comprehension`
 * joins them as a THIRD additive, unrelated bounded section.
 */
describe('#1038 x #1049 x #874 combined prompt budget', () => {
  it('the three bounded sections have a fixed, small combined ceiling', () => {
    const combined = AI_DM_STYLE_SECTION_MAX_TOKENS + AI_DM_PROMPT_HISTORY_MAX_TOKENS + AI_DM_COMPREHENSION_SECTION_MAX_TOKENS;
    // Sized against the smallest context window the seat can realistically be pointed at — a
    // self-hosted 4k model — not against a frontier model's, so the bound holds for the worst
    // deployment rather than the best.
    const SMALLEST_REALISTIC_CONTEXT_WINDOW = 4_096;
    expect(combined).toBeLessThan(SMALLEST_REALISTIC_CONTEXT_WINDOW / 2);
  });

  it('the new section is a constant too — the ceiling cannot drift silently', () => {
    expect(Number.isFinite(AI_DM_COMPREHENSION_SECTION_MAX_TOKENS)).toBe(true);
    expect(AI_DM_COMPREHENSION_SECTION_MAX_TOKENS).toBeGreaterThan(0);
  });
});

describe('#874 seat config surface', () => {
  it('offers a dropdown option for every accepted enum value, and vice versa', () => {
    const enums = {
      readingComplexity: AiDmReadingComplexity.options,
      paragraphLength: AiDmParagraphLength.options,
      sensoryIntensity: AiDmSensoryIntensity.options,
      choiceCount: AiDmChoiceCount.options,
    } as const;
    for (const axis of AI_DM_COMPREHENSION_PROFILE_AXES) {
      const optionValues = AI_DM_COMPREHENSION_PROFILE_OPTIONS[axis.key].map((o) => o.value);
      expect(optionValues).toEqual([...enums[axis.key]]);
      // `default` leads every axis because it is the shipped state.
      expect(optionValues[0]).toBe('default');
      expect(AI_DM_COMPREHENSION_PROFILE_OPTIONS[axis.key].every((o) => o.label.length > 0)).toBe(true);
    }
    expect(AI_DM_COMPREHENSION_PROFILE_AXES.map((a) => a.key).sort()).toEqual(
      Object.keys(AI_DM_COMPREHENSION_PROFILE_DEFAULTS).sort(),
    );
  });

  it('rejects a value outside the enum instead of passing it to the prompt', () => {
    expect(() => AiDmComprehensionProfile.parse({ readingComplexity: 'grimdark' })).toThrow();
  });
});
