/**
 * Pure aftermath builders (issue #473). Shared by REST, MCP, and unit tests.
 */
import type { Combatant, EncounterDifficulty, EncounterEvent, EncounterWithCombatants } from '@campfire/schema';
import { buildRecapDraft, type RecapDraftSource } from '../sessions/sessions.service';

export type AftermathCombatant = Pick<Combatant, 'name' | 'kind' | 'hpCurrent' | 'hpBand' | 'deathState'>;

function isDown(c: AftermathCombatant): boolean {
  return c.hpCurrent != null ? c.hpCurrent <= 0 : c.hpBand === 'down';
}

function isDead(c: AftermathCombatant): boolean {
  if (c.deathState === 'dead') return true;
  if (c.kind !== 'character' && isDown(c)) return true;
  return false;
}

function isDowned(c: AftermathCombatant): boolean {
  return c.kind === 'character' && isDown(c) && c.deathState !== 'dead';
}

export function aftermathOutcome<T extends AftermathCombatant>(
  combatants: T[],
  rounds: number,
): { dead: T[]; downed: T[]; survivors: T[]; rounds: number } {
  const dead = combatants.filter(isDead);
  const downed = combatants.filter(isDowned);
  const survivors = combatants.filter((c) => !isDead(c) && !isDowned(c));
  return { dead, downed, survivors, rounds };
}

/** Concise combat-log line for recap seeding (mirrors the web combat log wording). */
export function formatAftermathCombatLogLine(event: EncounterEvent): string {
  const detail = event.detail.trim();
  if (event.type === 'turn') {
    if (event.actor) {
      if (/^combat started$/i.test(detail)) return `Combat started — ${event.actor}'s turn`;
      return `${event.actor}'s turn`;
    }
    return detail || 'Turn changed';
  }
  const actor = event.actor?.trim() || null;
  const target = event.target?.trim() || null;
  const participants = actor && target && actor !== target ? `${actor} to ${target}` : target ?? actor;
  if (!participants) return detail || 'Combat log updated';
  if (target && !actor) return detail ? `${target} ${detail}` : target;
  return detail ? `${participants}: ${detail}` : participants;
}

/** Pick notable events for a recap appendix — deaths, notes, and the last few actions. */
export function selectCombatLogHighlights(events: EncounterEvent[], limit = 12): string[] {
  const notable = events.filter((e) => e.type === 'death' || e.type === 'note' || e.type === 'damage' || e.type === 'heal');
  const tail = (notable.length > 0 ? notable : events).slice(-limit);
  return tail.map((e) => {
    const round = e.round > 0 ? `R${e.round}: ` : '';
    return `- ${round}${formatAftermathCombatLogLine(e)}`;
  });
}

function outcomeLines(outcome: ReturnType<typeof aftermathOutcome>): string {
  const lines: string[] = [];
  lines.push(`- Rounds: ${outcome.rounds}`);
  if (outcome.dead.length) lines.push(`- Dead/defeated: ${outcome.dead.map((c) => c.name).join(', ')}`);
  if (outcome.downed.length) lines.push(`- Downed: ${outcome.downed.map((c) => c.name).join(', ')}`);
  if (outcome.survivors.length) lines.push(`- Survivors: ${outcome.survivors.map((c) => c.name).join(', ')}`);
  return lines.join('\n');
}

/**
 * Build a recap draft for a single ended encounter: shared scaffold + outcome tally +
 * combat-log highlights. Deterministic and unit-testable.
 */
export function buildEncounterAftermathRecapDraft(
  encounter: Pick<EncounterWithCombatants, 'name' | 'status' | 'combatants' | 'round'>,
  events: EncounterEvent[],
): { recapDraft: string; combatLogHighlights: string[] } {
  const source: RecapDraftSource = {
    resolvedInbox: [],
    encounters: [{ name: encounter.name, status: encounter.status, combatants: encounter.combatants, events }],
  };
  let draft = buildRecapDraft(source);
  const outcome = aftermathOutcome(encounter.combatants, encounter.round);
  const highlights = selectCombatLogHighlights(events);

  draft = draft.replace(
    '## Recap\n',
    `## Recap\n\n<!-- Encounter aftermath (issue #473) — review, edit, then delete this block. -->\n## Outcome\n${outcomeLines(outcome)}\n`,
  );

  if (highlights.length) {
    draft +=
      '\n\n---\n\n' +
      '<!-- Combat log highlights — weave notable moments into the recap, then delete this block. -->\n' +
      '## Combat highlights\n\n' +
      highlights.join('\n') +
      '\n';
  }

  return { recapDraft: draft, combatLogHighlights: highlights.map((h) => h.replace(/^- /, '')) };
}

export function suggestedXpFromDifficulty(
  difficulty: EncounterDifficulty,
  characterCombatantCount: number,
): {
  supported: boolean;
  suggestedPartyTotal: number | null;
  suggestedPerCharacter: number | null;
  undistributedXp: number | null;
  difficultyLabel: string;
  warnings: string[];
} {
  const warnings = [...difficulty.warnings];
  if (difficulty.status === 'unsupported') {
    return {
      supported: false,
      suggestedPartyTotal: null,
      suggestedPerCharacter: null,
      undistributedXp: null,
      difficultyLabel: difficulty.label,
      warnings,
    };
  }
  if (difficulty.status === 'unknown' || characterCombatantCount === 0) {
    if (characterCombatantCount === 0) warnings.push('No player characters were in this fight — adjust XP manually.');
    return {
      supported: difficulty.status === 'ok',
      suggestedPartyTotal: difficulty.status === 'ok' ? difficulty.totalMonsterXp : null,
      suggestedPerCharacter: null,
      undistributedXp: null,
      difficultyLabel: difficulty.label,
      warnings,
    };
  }
  // The encounter multiplier measures action-economy difficulty; 5e awards the
  // pre-multiplier monster XP total. Floor the split so the hand-off never awards
  // more XP than the encounter contains.
  const perCharacter = Math.floor(difficulty.totalMonsterXp / characterCombatantCount);
  const undistributedXp = difficulty.totalMonsterXp - perCharacter * characterCombatantCount;
  if (perCharacter === 0) {
    warnings.push('XP total is too small to split evenly across the party — award manually.');
    return {
      supported: true,
      suggestedPartyTotal: difficulty.totalMonsterXp,
      suggestedPerCharacter: null,
      undistributedXp,
      difficultyLabel: difficulty.label,
      warnings,
    };
  }
  return {
    supported: true,
    suggestedPartyTotal: difficulty.totalMonsterXp,
    suggestedPerCharacter: perCharacter,
    undistributedXp,
    difficultyLabel: difficulty.label,
    warnings,
  };
}
