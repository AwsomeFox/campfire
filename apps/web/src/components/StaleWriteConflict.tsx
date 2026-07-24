import { useMemo, useState } from 'react';
import { Btn } from './ui';

export interface ConflictField<T extends object> {
  key: keyof T;
  label: string;
  /** Text and string-array fields can be combined with a conservative 3-way merge. */
  merge?: boolean;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function display(value: unknown): string {
  if (Array.isArray(value)) return value.join('\n') || '(empty)';
  if (value === '' || value == null) return '(empty)';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function mergeConflictValue(base: unknown, mine: unknown, theirs: unknown): unknown {
  if (same(mine, base)) return theirs;
  if (same(theirs, base) || same(mine, theirs)) return mine;
  if (Array.isArray(mine) && Array.isArray(theirs)) {
    return [...theirs, ...mine.filter((item) => !theirs.some((other) => same(item, other)))];
  }
  if (typeof mine === 'string' && typeof theirs === 'string') {
    if (!mine.trim()) return theirs;
    if (!theirs.trim() || mine.includes(theirs)) return mine;
    if (theirs.includes(mine)) return theirs;
    return `${theirs.trimEnd()}\n\n${mine.trimStart()}`;
  }
  return mine;
}

/**
 * Shared field-level stale-write UI. The owning editor keeps its draft mounted,
 * replaces individual values through onResolve, and retries with the server's new
 * revision token only after the user reviews the collision.
 */
export function StaleWriteConflict<T extends object>({
  base,
  mine,
  theirs,
  fields,
  onResolve,
  onReloadAll,
}: {
  base: T;
  mine: T;
  theirs: T;
  fields: Array<ConflictField<T>>;
  onResolve: (key: keyof T, value: T[keyof T]) => void;
  onReloadAll: () => void;
}) {
  const [choices, setChoices] = useState<Record<string, string>>({});
  const changed = useMemo(
    () => fields.filter((field) => !same(mine[field.key], theirs[field.key])),
    [fields, mine, theirs],
  );

  return (
    <section
      className="rounded-lg border border-amber-500/50 bg-amber-950/30 p-3 space-y-3"
      role="alert"
      aria-live="assertive"
      aria-label="Conflicting edits"
    >
      <div className="space-y-1">
        <p className="font-bold text-amber-200 text-sm m-0">Someone saved a newer version</p>
        <p className="text-xs text-amber-100/80 m-0">
          Your draft is still here. Resolve each changed field, then save again; another intervening edit will be checked again.
        </p>
      </div>
      {changed.map((field) => {
        const key = String(field.key);
        const mergeable = field.merge &&
          ((typeof mine[field.key] === 'string' && typeof theirs[field.key] === 'string') ||
            (Array.isArray(mine[field.key]) && Array.isArray(theirs[field.key])));
        return (
          <fieldset key={key} className="border-t border-amber-800/50 pt-2 space-y-2 min-w-0">
            <legend className="text-xs font-bold text-amber-100 px-1">{field.label}</legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              <div className="min-w-0">
                <div className="text-amber-200/70 font-bold mb-1">Latest</div>
                <pre className="whitespace-pre-wrap break-words max-h-28 overflow-auto m-0 font-sans">{display(theirs[field.key])}</pre>
              </div>
              <div className="min-w-0">
                <div className="text-amber-200/70 font-bold mb-1">Your draft</div>
                <pre className="whitespace-pre-wrap break-words max-h-28 overflow-auto m-0 font-sans">{display(mine[field.key])}</pre>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Btn
                ghost
                className="!min-h-0 !py-1 text-xs"
                aria-label={`${field.label}: Reload latest`}
                onClick={() => {
                  onResolve(field.key, theirs[field.key]);
                  setChoices((value) => ({ ...value, [key]: 'Reloaded latest' }));
                }}
              >
                Reload
              </Btn>
              <Btn
                ghost
                className="!min-h-0 !py-1 text-xs"
                aria-label={`${field.label}: Keep mine`}
                onClick={() => setChoices((value) => ({ ...value, [key]: 'Keeping your draft' }))}
              >
                Keep mine
              </Btn>
              {mergeable && (
                <Btn
                  ghost
                  className="!min-h-0 !py-1 text-xs"
                  aria-label={`${field.label}: Merge edits`}
                  onClick={() => {
                    onResolve(field.key, mergeConflictValue(base[field.key], mine[field.key], theirs[field.key]) as T[keyof T]);
                    setChoices((value) => ({ ...value, [key]: 'Merged both edits' }));
                  }}
                >
                  Merge
                </Btn>
              )}
              {choices[key] && <span className="self-center text-amber-200/70" role="status">{choices[key]}</span>}
            </div>
          </fieldset>
        );
      })}
      <Btn ghost className="!min-h-0 !py-1 text-xs" onClick={onReloadAll}>Reload all fields</Btn>
    </section>
  );
}
