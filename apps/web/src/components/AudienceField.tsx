/**
 * Creation-time Audience choice for prep entities (issue #754).
 * Defaults to DM-only so quick-create / AI / Preparing encounters never auto-reveal.
 * Choosing "Visible to players" shows a short consequence line before submit.
 */
export type AudienceValue = 'dm' | 'players';

export function audienceToHidden(audience: AudienceValue): boolean {
  return audience === 'dm';
}

export function AudienceField({
  value,
  onChange,
  entityLabel,
  name = 'audience',
}: {
  value: AudienceValue;
  onChange: (next: AudienceValue) => void;
  /** Short noun for copy — "NPC", "quest", "encounter", … */
  entityLabel: string;
  name?: string;
}) {
  return (
    <fieldset className="space-y-2" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="text-xs font-bold text-slate-500 uppercase tracking-wide">Audience</legend>
      <div className="flex flex-col gap-2">
        <label className="flex items-start gap-2 text-sm text-slate-300 cursor-pointer select-none">
          <input
            type="radio"
            name={name}
            value="dm"
            checked={value === 'dm'}
            onChange={() => onChange('dm')}
            className="mt-0.5"
          />
          <span>
            <strong className="text-slate-200">DM only</strong>
            <span className="block text-xs text-slate-500">Hidden from players until you reveal it. Default for prep.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm text-slate-300 cursor-pointer select-none">
          <input
            type="radio"
            name={name}
            value="players"
            checked={value === 'players'}
            onChange={() => onChange('players')}
            className="mt-0.5"
          />
          <span>
            <strong className="text-slate-200">Visible to players</strong>
            <span className="block text-xs text-slate-500">Appears in their lists, search, and links immediately.</span>
          </span>
        </label>
      </div>
      {value === 'players' && (
        <p
          role="note"
          data-testid="audience-public-warning"
          className="text-xs text-amber-400/90 border border-amber-500/30 bg-amber-500/10 rounded px-2.5 py-2"
        >
          Players will see this {entityLabel} as soon as you create it — including in lists, search, and shared links.
          You can hide it again right after if that was a mistake.
        </p>
      )}
    </fieldset>
  );
}
