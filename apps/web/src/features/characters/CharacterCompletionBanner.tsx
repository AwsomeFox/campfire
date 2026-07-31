/**
 * Draft character completion checklist (issue #719).
 */
import type { Character, RuleSystemAdapter } from '@campfire/schema';
import { characterCompletionChecklist, isCharacterSheetComplete } from '@campfire/schema';
import { Card, Btn } from '../../components/ui';

export function CharacterCompletionBanner({
  character,
  adapter,
  canEdit,
  onMarkActive,
  markingActive,
}: {
  character: Character;
  adapter: RuleSystemAdapter;
  canEdit: boolean;
  onMarkActive: () => void;
  markingActive: boolean;
}) {
  if (character.status !== 'draft') return null;

  const checklist = characterCompletionChecklist(character, adapter);
  const complete = isCharacterSheetComplete(character, adapter);
  const doneCount = checklist.filter((item) => item.done).length;

  return (
    <Card className="space-y-3 border-amber-700/40 bg-amber-950/20 cf-print-hide" data-testid="character-draft-banner">
      <div className="space-y-1">
        <h2 className="font-bold text-amber-200 text-sm">Draft character</h2>
        <p className="text-xs text-amber-100/80">
          This sheet is still being built ({doneCount} of {checklist.length} essentials done). Draft characters stay off the
          party roster in new encounters until you mark them Active.
        </p>
      </div>
      <ul className="space-y-2 text-sm" aria-label="Character completion checklist">
        {checklist.map((item) => (
          <li key={item.id} className="flex gap-2 items-start">
            <span
              aria-hidden
              className={`mt-0.5 shrink-0 ${item.done ? 'text-emerald-400' : 'text-secondary'}`}
            >
              {item.done ? '✓' : '○'}
            </span>
            <span className={item.done ? 'text-slate-300' : 'text-slate-400'}>
              <strong className="font-semibold text-white">{item.label}</strong>
              <span className="block text-xs">{item.description}</span>
            </span>
          </li>
        ))}
      </ul>
      {canEdit && complete && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Btn type="button" onClick={onMarkActive} disabled={markingActive}>
            {markingActive ? 'Updating…' : 'Mark Active — ready for encounters'}
          </Btn>
          <p className="text-xs text-slate-400">Active characters can be auto-added when the DM creates a new encounter.</p>
        </div>
      )}
      {canEdit && !complete && (
        <p className="text-xs text-slate-400">Finish the items above on this sheet, then mark Active when you are ready to play.</p>
      )}
    </Card>
  );
}
