import type { ConditionInstance } from '@campfire/schema';

export type ConditionSourceOption = { id: number; name: string };
export type ConditionTiming = ConditionInstance['timing'];

export const CONDITION_TIMING_OPTIONS: Array<{ value: ConditionTiming; label: string }> = [
  { value: 'none', label: 'Manual / until removed' },
  { value: 'start-of-turn', label: 'Start of affected turn' },
  { value: 'end-of-turn', label: 'End of affected turn' },
];

export const SAVE_TIMING_OPTIONS: Array<{ value: ConditionTiming; label: string }> = [
  { value: 'none', label: 'No repeat save' },
  { value: 'start-of-turn', label: 'Start of affected turn' },
  { value: 'end-of-turn', label: 'End of affected turn' },
];

export type ConditionDraft = {
  name: string;
  source: string;
  sourceCombatantId: string;
  ruleEntryId: string;
  durationRounds: string;
  timing: ConditionTiming;
  saveTiming: ConditionTiming;
  saveAbility: string;
  saveDc: string;
  isConcentration: boolean;
  syncConcentration: boolean;
  stacks: string;
  notes: string;
};

export function emptyConditionDraft(sourceCombatantId: number | null): ConditionDraft {
  return {
    name: '',
    source: '',
    sourceCombatantId: sourceCombatantId == null ? '' : String(sourceCombatantId),
    ruleEntryId: '',
    durationRounds: '',
    timing: 'end-of-turn',
    saveTiming: 'none',
    saveAbility: '',
    saveDc: '',
    isConcentration: false,
    syncConcentration: true,
    stacks: '1',
    notes: '',
  };
}

export function conditionDraftFromInstance(instance: ConditionInstance): ConditionDraft {
  return {
    name: instance.name,
    source: instance.source ?? '',
    sourceCombatantId: instance.sourceCombatantId == null ? '' : String(instance.sourceCombatantId),
    ruleEntryId: instance.ruleEntryId == null ? '' : String(instance.ruleEntryId),
    durationRounds: instance.durationRounds == null ? '' : String(instance.durationRounds),
    timing: instance.timing,
    saveTiming: instance.saveTiming,
    saveAbility: instance.saveAbility ?? '',
    saveDc: instance.saveDc == null ? '' : String(instance.saveDc),
    isConcentration: instance.isConcentration,
    syncConcentration: false,
    stacks: String(instance.stacks),
    notes: instance.notes,
  };
}

function parseOptionalPositiveInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

function makeConditionInstanceId(name: string, existingIds: ReadonlySet<string>): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 18) || 'condition';
  const stamp = Date.now().toString(36).slice(-6);
  for (let i = 0; i < 100; i += 1) {
    const suffix = i === 0 ? stamp : `${stamp}_${i}`;
    const id = `ci_${slug}_${suffix}`.slice(0, 40);
    if (!existingIds.has(id)) return id;
  }
  return `ci_${slug}_${Math.random().toString(36).slice(2, 8)}`.slice(0, 40);
}

export function buildConditionInstance(
  draft: ConditionDraft,
  conditionSuggestions: readonly string[],
  existingInstances: readonly ConditionInstance[],
  existingId?: string,
): ConditionInstance | null {
  const name = draft.name.trim().slice(0, 40);
  if (!name) return null;
  const durationRounds = parseOptionalPositiveInt(draft.durationRounds);
  const sourceCombatantValue = Number(draft.sourceCombatantId);
  const ruleEntryValue = Number(draft.ruleEntryId);
  const saveDcValue = Number(draft.saveDc);
  const stacksValue = Number(draft.stacks);
  return {
    id: existingId ?? makeConditionInstanceId(name, new Set(existingInstances.map((i) => i.id))),
    name,
    ruleEntryId: Number.isInteger(ruleEntryValue) && ruleEntryValue > 0 ? ruleEntryValue : null,
    source: draft.source.trim() ? draft.source.trim().slice(0, 160) : null,
    sourceCombatantId: Number.isInteger(sourceCombatantValue) && sourceCombatantValue > 0 ? sourceCombatantValue : null,
    durationRounds,
    roundsRemaining: durationRounds,
    timing: durationRounds == null ? 'none' : draft.timing,
    saveTiming: draft.saveTiming,
    saveDc: Number.isInteger(saveDcValue) && saveDcValue > 0 ? saveDcValue : null,
    saveAbility: draft.saveAbility.trim() ? draft.saveAbility.trim().toUpperCase().slice(0, 24) : null,
    isConcentration: draft.isConcentration,
    stacks: Number.isInteger(stacksValue) ? Math.max(1, Math.min(99, stacksValue)) : 1,
    notes: draft.notes.trim().slice(0, 300),
    custom: !conditionSuggestions.some((s) => s.toLowerCase() === name.toLowerCase()),
  };
}

export function conditionSourceLabel(sourceCombatantId: number | null, options: readonly ConditionSourceOption[]): string | null {
  if (sourceCombatantId == null) return null;
  return options.find((o) => o.id === sourceCombatantId)?.name ?? `Combatant #${sourceCombatantId}`;
}
