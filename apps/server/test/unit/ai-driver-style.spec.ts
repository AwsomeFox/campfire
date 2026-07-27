import {
  AI_DM_STYLE_PRESET_AXES,
  AI_DM_STYLE_PRESET_DEFAULTS,
  AI_DM_STYLE_PRESET_OPTIONS,
  AI_DM_PROMPT_HISTORY_MAX_TOKENS,
  AI_DM_STYLE_SECTION_MAX_TOKENS,
  AiDmCombatStyle,
  AiDmNpcDepth,
  AiDmPacing,
  AiDmStylePresets,
  AiDmTone,
  AiDmVerbosity,
  type AiDmStylePresets as StylePresets,
} from '@campfire/schema';
import { estimateTokens } from '../../src/modules/ai-dm/ai-dm.provider';
import {
  isDefaultStylePresets,
  renderTableStyleSection,
  TABLE_STYLE_HEADING,
} from '../../src/modules/ai-driver/driver-style';

/**
 * Structured table style (#1049).
 *
 * The seat's only steering was a freeform textarea, which is fine if you already know what to
 * write in it and useless otherwise. These presets make tone / pacing / verbosity / combat /
 * NPC depth discoverable.
 *
 * What these tests are really guarding is the two claims the feature makes about ITSELF:
 *   - it costs nothing until a DM opts in (an all-default seat renders no section at all), and
 *   - its cost is BOUNDED and known, which is what lets it share a system prompt with elastic
 *     consumers (live world state; the conversation history of #1038) without taking budget
 *     from them. A style block that could grow without limit would have to.
 */

function presets(overrides: Partial<StylePresets> = {}): StylePresets {
  return AiDmStylePresets.parse({ ...AI_DM_STYLE_PRESET_DEFAULTS, ...overrides });
}

describe('#1049 table style — costs nothing until asked for', () => {
  it('renders NOTHING when every axis is left on default', () => {
    // The shipped state. An existing campaign that never opens this control must produce the
    // exact system prompt it produced before #1049 — no section, no tokens, no behaviour change.
    expect(renderTableStyleSection(presets())).toBeNull();
    expect(isDefaultStylePresets(presets())).toBe(true);
  });

  it('treats a missing or empty preset object as "no preference"', () => {
    // A seat row that predates the migration decodes as '{}'. It must read as default rather
    // than throwing or inventing a style nobody chose.
    expect(renderTableStyleSection(null)).toBeNull();
    expect(renderTableStyleSection(undefined)).toBeNull();
    expect(renderTableStyleSection(AiDmStylePresets.parse({}))).toBeNull();
    expect(isDefaultStylePresets(null)).toBe(true);
  });

  it('renders only the axes that were actually set', () => {
    const section = renderTableStyleSection(presets({ tone: 'noir' }))!;
    expect(section.startsWith(TABLE_STYLE_HEADING)).toBe(true);
    expect(section).toContain('- Tone:');
    // Silence on an axis is a real answer: the model should not be told a pacing preference
    // the DM never expressed.
    expect(section).not.toContain('- Pacing:');
    expect(section).not.toContain('- NPCs:');
  });

  it('renders a line per axis when all five are set', () => {
    const section = renderTableStyleSection(
      presets({ tone: 'gritty', pacing: 'brisk', verbosity: 'concise', combatStyle: 'lethal', npcDepth: 'deep' }),
    )!;
    for (const label of ['- Tone:', '- Pacing:', '- Verbosity:', '- Combat:', '- NPCs:']) {
      expect(section).toContain(label);
    }
  });
});

describe('#1049 table style — subordination is stated, not implied', () => {
  it('names what outranks it, so its precedence does not depend on section order', () => {
    // Placement (right after `## DM steering`) puts style with the other standing preference,
    // ahead of the facts. That is a readability choice, and a later section could move things.
    // The guarantee that a tone preference never beats a correction has to live in the TEXT.
    const section = renderTableStyleSection(presets({ tone: 'gritty' }))!;
    expect(section).toContain('session-zero charter');
    expect(section).toContain('live game state');
    expect(section).toContain('correction');
    // And it says plainly which axis it operates on: voice, not truth.
    expect(section).toMatch(/never change what is true/i);
  });
});

describe('#1049 table style — bounded cost', () => {
  it('the WORST CASE stays under the declared ceiling', () => {
    // The whole reason the values are a closed enum rather than free text. Pick the longest
    // option on every axis and assert the declared constant still holds — if someone adds a
    // florid new preset, this fails here rather than silently eating another feature's budget.
    let worst = 0;
    for (const tone of AiDmTone.options) {
      for (const pacing of AiDmPacing.options) {
        for (const verbosity of AiDmVerbosity.options) {
          for (const combatStyle of AiDmCombatStyle.options) {
            for (const npcDepth of AiDmNpcDepth.options) {
              const section = renderTableStyleSection(
                presets({ tone, pacing, verbosity, combatStyle, npcDepth }),
              );
              worst = Math.max(worst, estimateTokens(section ?? ''));
            }
          }
        }
      }
    }
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThanOrEqual(AI_DM_STYLE_SECTION_MAX_TOKENS);
  });
});

/**
 * #1038 × #1049 — the combined system-prompt budget, CHECKED rather than deferred.
 *
 * When #1049 was written, #1553's `## Recent history` section was not yet on main, so the
 * contention between the two was prospective and flagged for whoever merged second. #1553 has
 * since landed and this branch merged after it, so the re-check is due here and this is it.
 *
 * BOTH consumers are bounded by EXPLICIT CONSTANTS, deliberately not by a fraction of the
 * model's context window (see the #1038 rationale in packages/schema): every token is paid on
 * every turn AND on every #1052 retry or fallback attempt, so the cost has to be legible rather
 * than scaling silently with whichever model a campaign is pointed at.
 *
 * They are ADDITIVE and neither knows about the other, which is precisely the contention that
 * was flagged. The answer is that both are hard ceilings rather than elastic fill-to-budget
 * consumers, so the combined worst case is a single number — asserted below — and it does not
 * move when a campaign changes model. A future third bounded section would repeat this
 * arithmetic by hand; that is a note for the next author, not a defect today.
 */
describe('#1038 × #1049 combined prompt budget', () => {
  it('the two bounded sections have a fixed, small combined ceiling', () => {
    const combined = AI_DM_STYLE_SECTION_MAX_TOKENS + AI_DM_PROMPT_HISTORY_MAX_TOKENS;
    expect(combined).toBe(1_750);

    // Sized against the SMALLEST context window the seat can realistically be pointed at — a
    // self-hosted 4k model — not against a frontier model's, so the bound holds for the worst
    // deployment rather than the best. 1,750 leaves the majority of even that window for the
    // rest of the system prompt, the turn, and the reserved output.
    const SMALLEST_REALISTIC_CONTEXT_WINDOW = 4_096;
    expect(combined).toBeLessThan(SMALLEST_REALISTIC_CONTEXT_WINDOW / 2);
  });

  it('neither section is elastic — both are constants, so the ceiling cannot drift', () => {
    // The property that makes the sum meaningful. If either became "fill the remaining
    // context", the combined figure above would stop being a bound and this assertion is what
    // would notice.
    expect(Number.isFinite(AI_DM_STYLE_SECTION_MAX_TOKENS)).toBe(true);
    expect(Number.isFinite(AI_DM_PROMPT_HISTORY_MAX_TOKENS)).toBe(true);
    expect(AI_DM_STYLE_SECTION_MAX_TOKENS).toBeGreaterThan(0);
    expect(AI_DM_PROMPT_HISTORY_MAX_TOKENS).toBeGreaterThan(0);
  });
});

describe('#1049 seat config surface', () => {
  it('offers a dropdown option for every accepted enum value, and vice versa', () => {
    // The form and the validator must not drift: an option the server rejects is a dead
    // control, and a value with no option is a setting nobody can reach.
    const enums = {
      tone: AiDmTone.options,
      pacing: AiDmPacing.options,
      verbosity: AiDmVerbosity.options,
      combatStyle: AiDmCombatStyle.options,
      npcDepth: AiDmNpcDepth.options,
    } as const;
    for (const axis of AI_DM_STYLE_PRESET_AXES) {
      const optionValues = AI_DM_STYLE_PRESET_OPTIONS[axis.key].map((o) => o.value);
      expect(optionValues).toEqual([...enums[axis.key]]);
      // `default` leads every axis because it is the shipped state.
      expect(optionValues[0]).toBe('default');
      expect(AI_DM_STYLE_PRESET_OPTIONS[axis.key].every((o) => o.label.length > 0)).toBe(true);
    }
    expect(AI_DM_STYLE_PRESET_AXES.map((a) => a.key).sort()).toEqual(
      Object.keys(AI_DM_STYLE_PRESET_DEFAULTS).sort(),
    );
  });

  it('rejects a value outside the enum instead of passing it to the prompt', () => {
    expect(() => AiDmStylePresets.parse({ tone: 'grimdark' })).toThrow();
  });
});
