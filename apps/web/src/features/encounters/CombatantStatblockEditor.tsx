/**
 * Quick manual statblock editor (issue #425) — AC, abilities, actions with inline help.
 * Used in the add-combatant manual tab and inline on existing manual monsters.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CharacterAction, CombatantStatblock } from '@campfire/schema';
import {
  COMBATANT_STATBLOCK_HELP,
  defaultCombatantStatblock,
  isResolvableSpec,
  ruleSystemAdapter,
  statblockPresentation,
  STANDARD_D20_ABILITY_FIELDS,
} from '@campfire/schema';
import { Btn } from '../../components/ui';
import { parseLocalizedInteger } from '../../lib/i18nNumbers';

function emptyAction(targetAc = 'AC'): CharacterAction {
  return { name: '', kind: 'melee', toHit: '', damage: '', targetAc, notes: '' };
}

export function CombatantStatblockEditor({
  value,
  onChange,
  disabled = false,
  ruleSystem,
}: {
  value: CombatantStatblock | null;
  onChange: (next: CombatantStatblock) => void;
  disabled?: boolean;
  ruleSystem?: string | null;
}) {
  useTranslation();
  const statblock = useMemo(() => value ?? defaultCombatantStatblock(), [value]);
  const presentation = useMemo(() => statblockPresentation(ruleSystem), [ruleSystem]);
  const adapter = useMemo(() => ruleSystemAdapter(ruleSystem), [ruleSystem]);
  const abilityFields = useMemo(
    () => adapter.characterSheet?.abilityFields ?? STANDARD_D20_ABILITY_FIELDS,
    [adapter],
  );

  const patch = (partial: Partial<CombatantStatblock>) => onChange({ ...statblock, ...partial });

  const [acDraft, setAcDraft] = useState<string>(() => String(statblock.ac ?? 10));
  const [abilityDrafts, setAbilityDrafts] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const field of abilityFields) {
      initial[field.key] = String(statblock.abilityScores[field.key] ?? 10);
    }
    return initial;
  });

  useEffect(() => {
    setAcDraft(String(statblock.ac ?? 10));
    setAbilityDrafts(() => {
      const next: Record<string, string> = {};
      for (const field of abilityFields) {
        next[field.key] = String(statblock.abilityScores[field.key] ?? 10);
      }
      return next;
    });
  }, [statblock.ac, statblock.abilityScores, abilityFields]);

  const patchAction = (index: number, partial: Partial<CharacterAction>) => {
    const actions = [...statblock.actions];
    actions[index] = { ...actions[index], ...partial };
    patch({ actions });
  };

  const addAction = () => patch({ actions: [...statblock.actions, emptyAction(presentation.defense.short)] });
  const removeAction = (index: number) => patch({ actions: statblock.actions.filter((_, i) => i !== index) });

  return (
    <div className="flex flex-col gap-3" data-testid="combatant-statblock-editor">
      <label className="flex flex-col gap-1 text-sm">
        <span title={COMBATANT_STATBLOCK_HELP.ac}>{presentation.defense.full}</span>
        <input
          type="number"
          className="input"
          min={0}
          max={40}
          disabled={disabled}
          value={acDraft}
          onChange={(e) => {
            const raw = e.target.value;
            setAcDraft(raw);
            const parsed = parseLocalizedInteger(raw);
            if (parsed.ok) patch({ ac: parsed.value });
          }}
          onBlur={() => {
            const parsed = parseLocalizedInteger(acDraft);
            if (!parsed.ok) setAcDraft(String(statblock.ac ?? 10));
          }}
          aria-describedby="statblock-ac-help"
        />
        <span id="statblock-ac-help" className="text-[11px] text-muted m-0">
          {COMBATANT_STATBLOCK_HELP.ac}
        </span>
      </label>

      <fieldset className="border border-neutral-700 rounded-md p-2 m-0">
        <legend className="text-sm px-1" title={COMBATANT_STATBLOCK_HELP.abilityScores}>
          Abilities
        </legend>
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
          {abilityFields.map((field) => (
            <label key={field.key} className="flex flex-col gap-0.5 text-xs">
              <span>{field.label}</span>
              <input
                type="number"
                className="input !min-h-8"
                disabled={disabled}
                value={abilityDrafts[field.key] ?? String(statblock.abilityScores[field.key] ?? 10)}
                onChange={(e) => {
                  const raw = e.target.value;
                  setAbilityDrafts((prev) => ({ ...prev, [field.key]: raw }));
                  const parsed = parseLocalizedInteger(raw);
                  if (parsed.ok) {
                    patch({
                      abilityScores: { ...statblock.abilityScores, [field.key]: parsed.value },
                    });
                  }
                }}
                onBlur={() => {
                  const parsed = parseLocalizedInteger(abilityDrafts[field.key] ?? '');
                  if (!parsed.ok) {
                    setAbilityDrafts((prev) => ({ ...prev, [field.key]: String(statblock.abilityScores[field.key] ?? 10) }));
                  }
                }}
              />
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold" title={COMBATANT_STATBLOCK_HELP.actions}>
            Actions
          </span>
          <Btn type="button" ghost className="!min-h-8 text-xs" disabled={disabled} onClick={addAction}>
            Add action
          </Btn>
        </div>
        {statblock.actions.map((action, index) => (
          <div key={index} className="rounded-md border border-neutral-700 p-2 flex flex-col gap-2">
            <div className="flex gap-2 items-start">
              <label className="flex-1 flex flex-col gap-0.5 text-xs">
                <span title={COMBATANT_STATBLOCK_HELP.actionName}>Name</span>
                <input
                  className="input !min-h-8"
                  disabled={disabled}
                  value={action.name}
                  onChange={(e) => patchAction(index, { name: e.target.value })}
                />
              </label>
              <label className="w-24 flex flex-col gap-0.5 text-xs">
                <span title={COMBATANT_STATBLOCK_HELP.toHit}>To hit</span>
                <input
                  className="input !min-h-8"
                  disabled={disabled}
                  value={action.toHit}
                  onChange={(e) => patchAction(index, { toHit: e.target.value })}
                />
              </label>
              <label className="flex-1 flex flex-col gap-0.5 text-xs">
                <span title={COMBATANT_STATBLOCK_HELP.damage}>Damage</span>
                <input
                  className="input !min-h-8"
                  disabled={disabled}
                  value={action.damage}
                  onChange={(e) => patchAction(index, { damage: e.target.value })}
                />
              </label>
              {!disabled && (
                <button type="button" className="btn btn-ghost !min-h-8 text-xs mt-5" onClick={() => removeAction(index)}>
                  Remove
                </button>
              )}
            </div>
            <label className="flex flex-col gap-0.5 text-xs">
              <span title={COMBATANT_STATBLOCK_HELP.actionNotes}>Rules text</span>
              <textarea
                className="input min-h-[3rem]"
                disabled={disabled}
                value={action.notes}
                onChange={(e) => patchAction(index, { notes: e.target.value })}
              />
            </label>
            {action.spec && (
              <p className="text-[11px] text-muted m-0" title={COMBATANT_STATBLOCK_HELP.resolvable}>
                {isResolvableSpec(action.spec)
                  ? 'Resolver-ready — Use button available in combat.'
                  : 'Prose only — add to-hit or save DC for guided resolution.'}
              </p>
            )}
          </div>
        ))}
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span title={COMBATANT_STATBLOCK_HELP.notes}>DM notes</span>
        <textarea
          className="input min-h-[3rem]"
          disabled={disabled}
          value={statblock.notes}
          onChange={(e) => patch({ notes: e.target.value })}
        />
      </label>
    </div>
  );
}
