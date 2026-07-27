/**
 * Structured table style → system-prompt section (#1049). Pure rendering: no DB, no I/O.
 *
 * WHAT WAS MISSING. The seat's only steering was `instructions`, a freeform textarea. That is
 * fine if you already know what to write in it, and useless otherwise — a blank box gives no
 * hint that pacing, verbosity or NPC depth were dials at all. These presets make the common
 * axes discoverable without taking the textarea away.
 *
 * WHAT THIS IS NOT. Every line below is a REQUEST to a language model. The server does not
 * check the narration that comes back against the preset, cannot, and does not try. A model
 * may ignore any of this. That framing is deliberate and matches how #598 describes its own
 * charter half: prompt text is a request, not a control. Anything that reads as enforcement
 * here — in code comments, UI copy, or the changelog — is overselling it.
 *
 * WHERE IT SITS IN THE PROMPT, AND WHY. Directly after `## DM steering`, forming one
 * "how this table is run" preference block ahead of any facts. Style is a different AXIS from
 * the truth ordering the rest of the prompt encodes (what is true → what was said → what a
 * human overruled); it answers "how should this sound", not "what happened". Splicing an
 * orthogonal concern into the middle of a factual sequence would muddy both, so it sits with
 * the other standing preference instead. Its subordination is asserted in the section text by
 * NAME — the session-zero charter, the live game state, and table corrections all outrank it —
 * rather than by position, so the claim stays true no matter where later sections are added.
 *
 * WHY CLOSED ENUMS. A bounded vocabulary gives the section a known worst-case size, asserted
 * by a unit test against AI_DM_STYLE_SECTION_MAX_TOKENS. That is what lets it coexist with
 * elastic consumers of the same prompt (live world state; the bounded conversation history of
 * #1038) without needing to take budget from them.
 */
import {
  AI_DM_STYLE_PRESET_DEFAULTS,
  type AiDmCombatStyle,
  type AiDmNpcDepth,
  type AiDmPacing,
  type AiDmStylePresets,
  type AiDmTone,
  type AiDmVerbosity,
} from '@campfire/schema';

/** Section header, matching the `## Heading` convention the rest of the prompt uses. */
export const TABLE_STYLE_HEADING = '## Table style';

/**
 * Guidance per option. `default` is absent from every map on purpose: choosing it states no
 * preference, so it contributes no line and an all-default seat renders no section at all.
 */
const TONE: Record<Exclude<AiDmTone, 'default'>, string> = {
  gritty: 'Gritty and grounded. Consequences bite, victories cost something, and the world is indifferent rather than cruel.',
  heroic: 'Heroic and bright. The party are capable people who can plausibly win; let their competence show.',
  whimsical: 'Whimsical and playful. Lean into the absurd and the charming without turning the table into a joke.',
  noir: 'Noir. Moral greys, tired people, rain-slick detail; trust is scarce and everyone wants something.',
  cozy: 'Cozy and low-stakes. Warmth, small problems, and community; danger is gentle and rarely lethal.',
};

const PACING: Record<Exclude<AiDmPacing, 'default'>, string> = {
  brisk: 'Move briskly. Cut straight to the consequential moment and skip travel or downtime unless a player asks for it.',
  deliberate: 'Take your time. Let scenes breathe, and give players room to look around before the next thing happens.',
};

const VERBOSITY: Record<Exclude<AiDmVerbosity, 'default'>, string> = {
  concise: 'Be brief. A short paragraph at most per turn; favour the single telling detail over a full description.',
  vivid: 'Be richly descriptive. Use sensory detail and atmosphere, while still ending on a clear prompt to act.',
};

const COMBAT: Record<Exclude<AiDmCombatStyle, 'default'>, string> = {
  tactical: 'Narrate combat tactically. Name positions, cover and opportunities so players can make informed choices.',
  cinematic: 'Narrate combat cinematically. Prioritise momentum and imagery over a blow-by-blow accounting.',
  lethal: 'Combat is dangerous. Enemies fight to win and use the terrain; do not soften outcomes to protect the party.',
  forgiving: 'Combat is forgiving. Favour setbacks, capture and escape over character death when the dice go badly.',
};

const NPC_DEPTH: Record<Exclude<AiDmNpcDepth, 'default'>, string> = {
  light: 'Keep NPCs light. A name and one distinguishing trait is enough; do not linger on their inner lives.',
  deep: 'Give NPCs depth. Distinct voices, motives of their own, and opinions that persist between scenes.',
};

/** Human-readable axis label used in the rendered line. */
const AXIS_LABEL = {
  tone: 'Tone',
  pacing: 'Pacing',
  verbosity: 'Verbosity',
  combatStyle: 'Combat',
  npcDepth: 'NPCs',
} as const;

/** True when the DM has expressed no preference at all — the section is skipped entirely. */
export function isDefaultStylePresets(presets: AiDmStylePresets | null | undefined): boolean {
  if (!presets) return true;
  return (Object.keys(AI_DM_STYLE_PRESET_DEFAULTS) as (keyof AiDmStylePresets)[]).every(
    (axis) => (presets[axis] ?? 'default') === 'default',
  );
}

/**
 * Render the `## Table style` section, or null when nothing is set.
 *
 * Returning null rather than an empty section is what makes #1049 free for tables that never
 * touch it: an unconfigured seat produces the exact prompt it produced before this feature.
 */
export function renderTableStyleSection(presets: AiDmStylePresets | null | undefined): string | null {
  if (isDefaultStylePresets(presets) || !presets) return null;

  const lines: string[] = [];
  const push = (axis: keyof typeof AXIS_LABEL, guidance: string | undefined): void => {
    if (guidance) lines.push(`- ${AXIS_LABEL[axis]}: ${guidance}`);
  };
  push('tone', presets.tone === 'default' ? undefined : TONE[presets.tone]);
  push('pacing', presets.pacing === 'default' ? undefined : PACING[presets.pacing]);
  push('verbosity', presets.verbosity === 'default' ? undefined : VERBOSITY[presets.verbosity]);
  push('combatStyle', presets.combatStyle === 'default' ? undefined : COMBAT[presets.combatStyle]);
  push('npcDepth', presets.npcDepth === 'default' ? undefined : NPC_DEPTH[presets.npcDepth]);
  if (lines.length === 0) return null;

  return [
    TABLE_STYLE_HEADING,
    'How the DM of this table wants the game narrated. These shape VOICE and PACING only — they',
    'never change what is true. The session-zero charter, the live game state, and any table',
    'correction all outrank them: if a preference would conflict with one of those, follow the',
    'other and drop the preference.',
    ...lines,
  ].join('\n');
}
