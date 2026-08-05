/**
 * Comprehension profile → system-prompt section (#874). Pure rendering: no DB, no I/O.
 *
 * WHAT WAS MISSING. AI Driver only ever said "Narrate vividly" and gave players a blank
 * "Describe what you do" composer — no reading-level/chunking guidance, no stated default
 * ending shape, and no way for a player to ask for the turn again more simply. This is a
 * DIFFERENT axis from #1049's `## Table style`: style is a taste preference (voice, tone);
 * this is an ACCESSIBILITY preference — how readable a turn is for the humans at this table.
 *
 * WHAT THIS IS NOT — same caveat #1049 states for its own section. Every line below is a
 * REQUEST to a language model. The server does not check the narration that comes back against
 * it, cannot, and does not try. Anything that reads as enforcement here — in code comments, UI
 * copy, or the changelog — is overselling it.
 *
 * TWO PARTS, not one. Unlike `## Table style` (silent until a DM opts in), the FIRST part below
 * — chunking, the "What changed" / "What can you do" ending, non-exclusive suggestions offered
 * ALONGSIDE free text, keeping mechanical outcomes apart from prose, and honouring a player's
 * Simplify/Recap/turn-cue/Explain request — is the issue's stated DEFAULT and is therefore
 * ALWAYS rendered, independent of {@link AiDmComprehensionProfile}. The SECOND part is the
 * profile's own per-axis fine-tuning (reading complexity, paragraph length, sensory intensity,
 * choice count), which — exactly like #1049's style axes — adds a line only when a DM sets it
 * away from `'default'`.
 *
 * THE TITLE'S CONSTRAINT, enforced in the TEXT rather than assumed from the UI. "chunk narration
 * and offer supported choices without removing freeform input" is not merely true because the
 * composer never changed shape (see AiTablePage.tsx) — the prompt itself repeatedly tells the
 * model the suggestions are illustrations, never the only accepted input, so a model that only
 * reads this file's output still cannot conclude it may stop accepting free text.
 *
 * WHY CLOSED ENUMS for the optional axes — same reasoning as #1049: a bounded vocabulary gives
 * the section a known worst case, asserted by a unit test against
 * {@link AI_DM_COMPREHENSION_SECTION_MAX_TOKENS}, so it can share a prompt with elastic
 * consumers (live world state; the bounded conversation history of #1038) without taking their
 * budget. The FIXED baseline text below is part of that same measured worst case.
 */
import {
  AI_DM_COMPREHENSION_PROFILE_DEFAULTS,
  type AiDmChoiceCount,
  type AiDmComprehensionProfile,
  type AiDmParagraphLength,
  type AiDmReadingComplexity,
  type AiDmSensoryIntensity,
} from '@campfire/schema';

/** Section header, matching the `## Heading` convention the rest of the prompt uses. */
export const COMPREHENSION_HEADING = '## Comprehension';

/** Guidance per option, mirroring driver-style.ts's per-axis maps. `default` contributes nothing. */
const READING_COMPLEXITY: Record<Exclude<AiDmReadingComplexity, 'default'>, string> = {
  simple: 'Simple everyday words, short sentences.',
  standard: 'Everyday vocabulary, moderate sentences.',
  rich: 'Fuller vocabulary and longer sentences are fine.',
};

const PARAGRAPH_LENGTH: Record<Exclude<AiDmParagraphLength, 'default'>, string> = {
  short: 'One to two sentences per paragraph, one beat each.',
  standard: 'A few sentences per paragraph, one beat each.',
  long: 'Longer paragraphs combining several beats are fine.',
};

const SENSORY_INTENSITY: Record<Exclude<AiDmSensoryIntensity, 'default'>, string> = {
  minimal: 'Light — only the detail a player needs to act.',
  standard: 'Moderate — enough to set the scene, not overwhelm it.',
  vivid: 'Rich sensory detail — sight, sound, smell, texture.',
};

const CHOICE_COUNT: Record<Exclude<AiDmChoiceCount, 'default'>, string> = {
  two: 'Exactly two suggestions (still non-exclusive).',
  three: 'Exactly three suggestions (still non-exclusive).',
  four: 'Exactly four suggestions (still non-exclusive).',
};

/** Human-readable axis label used in the rendered line, mirroring driver-style.ts. */
const AXIS_LABEL = {
  readingComplexity: 'Reading complexity',
  paragraphLength: 'Paragraph length',
  sensoryIntensity: 'Sensory intensity',
  choiceCount: 'Suggested choices',
} as const;

/** True when the DM has expressed no per-axis preference at all — matches driver-style.ts. */
export function isDefaultComprehensionProfile(profile: AiDmComprehensionProfile | null | undefined): boolean {
  if (!profile) return true;
  return (Object.keys(AI_DM_COMPREHENSION_PROFILE_DEFAULTS) as (keyof AiDmComprehensionProfile)[]).every(
    (axis) => (profile[axis] ?? 'default') === 'default',
  );
}

/**
 * The FIXED baseline — the issue's stated default behaviour, unconditional on the profile. Kept
 * as its own constant (rather than inlined into {@link renderComprehensionSection}) so its exact
 * text is a stable, reviewable unit and so the worst-case token test can measure it in isolation.
 */
const BASELINE_LINES: readonly string[] = [
  'Readability structure, separate from voice/style above; a request, not enforced.',
  '- Chunk narration into short, readable beats rather than one long block.',
  '- End each turn with two labeled parts, in order: "What changed" then "What can you do".',
  '- Under "What can you do", give 2 to 4 NON-EXCLUSIVE suggestions with a one-line consequence each. NEVER the only input accepted — the player may always instead describe anything else in their own words, and never present the suggestions as a menu that replaces free text.',
  '- Keep mechanical outcomes (dice, DCs, damage, rule citations) on their own line, apart from prose.',
  '- Answer simplify/recap/explain instead of advancing: simplify = shorter, plainer; recap = recent events; explain = the rule just used; "whose turn" = restate the cue.',
];

/**
 * Render the `## Comprehension` section. Unlike {@link renderTableStyleSection}, this NEVER
 * returns null: the baseline lines above are the issue's stated default and apply to every
 * turn regardless of configuration. `profile` only controls whether any OPTIONAL per-axis line
 * is appended underneath that baseline.
 */
export function renderComprehensionSection(profile: AiDmComprehensionProfile | null | undefined): string {
  const lines: string[] = [];
  const push = (axis: keyof typeof AXIS_LABEL, guidance: string | undefined): void => {
    if (guidance) lines.push(`- ${AXIS_LABEL[axis]}: ${guidance}`);
  };
  if (profile) {
    push('readingComplexity', profile.readingComplexity === 'default' ? undefined : READING_COMPLEXITY[profile.readingComplexity]);
    push('paragraphLength', profile.paragraphLength === 'default' ? undefined : PARAGRAPH_LENGTH[profile.paragraphLength]);
    push('sensoryIntensity', profile.sensoryIntensity === 'default' ? undefined : SENSORY_INTENSITY[profile.sensoryIntensity]);
    push('choiceCount', profile.choiceCount === 'default' ? undefined : CHOICE_COUNT[profile.choiceCount]);
  }

  return [COMPREHENSION_HEADING, ...BASELINE_LINES, ...lines].join('\n');
}
