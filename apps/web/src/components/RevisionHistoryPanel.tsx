import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { EntityRevision, RevisionEntityType } from '@campfire/schema';
import { api, API } from '../lib/api';
import { Btn, Card, ErrorNote, Skeleton } from './ui';
import { Markdown } from './Markdown';
import { useDialog } from './useDialog';

type Snapshot = Record<string, string>;
type DialogStep = 'inspect' | 'confirm';

const FIELD_LABELS: Partial<Record<RevisionEntityType, Record<string, string>>> = {
  session: { recap: 'Recap' },
  quest: { body: 'Quest description' },
  npc: { body: 'NPC description' },
  location: { body: 'Location description' },
  faction: { body: 'Faction description' },
  note: { body: 'Note' },
};

const MARKDOWN_FIELDS = new Set(['body', 'recap', 'summary', 'description', 'dmSecret']);

function fieldLabel(entityType: RevisionEntityType, field: string): string {
  const known = FIELD_LABELS[entityType]?.[field];
  if (known) return known;
  const words = field
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[._\s-]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  if (words.length === 0) return 'Legacy field';
  return words.map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word)).join(' ');
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString();
}

function revisionAuthor(revision: EntityRevision): string {
  return revision.authorName.trim() || 'Unknown author';
}

function snapshotFields(selected: Snapshot, current: Snapshot): string[] {
  const fields = new Set([...Object.keys(selected), ...Object.keys(current)]);
  return [...fields].sort((a, b) => {
    const aKnown = a === 'body' || a === 'recap' ? 0 : 1;
    const bKnown = b === 'body' || b === 'recap' ? 0 : 1;
    return aKnown - bKnown || a.localeCompare(b);
  });
}

function restorableField(entityType: RevisionEntityType): 'body' | 'recap' {
  return entityType === 'session' ? 'recap' : 'body';
}

function valuesMatch(entityType: RevisionEntityType, selected: Snapshot, current: Snapshot): boolean {
  const field = restorableField(entityType);
  return field in selected && selected[field] === current[field];
}

function PreviewValue({ field, value, missing }: { field: string; value: string; missing: boolean }) {
  if (missing) return <p className="text-sm italic text-slate-400">Not recorded in this version.</p>;
  if (value === '') return <p className="text-sm italic text-slate-400">(empty)</p>;
  if (MARKDOWN_FIELDS.has(field)) return <Markdown className="break-words">{value}</Markdown>;
  return <p className="whitespace-pre-wrap break-words text-sm text-slate-300">{value}</p>;
}

function RevisionDialog({
  revision,
  entityType,
  currentSnapshot,
  step,
  restoring,
  restoreError,
  onStepChange,
  onRestore,
  onClose,
}: {
  revision: EntityRevision;
  entityType: RevisionEntityType;
  currentSnapshot: Snapshot;
  step: DialogStep;
  restoring: boolean;
  restoreError: string | null;
  onStepChange: (step: DialogStep) => void;
  onRestore: () => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const cancelRestoreRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useDialog<HTMLDivElement>({
    onClose,
    disabled: restoring,
    autoFocus: false,
    inertBackground: true,
  });
  const fields = useMemo(
    () => snapshotFields(revision.snapshot, currentSnapshot),
    [revision.snapshot, currentSnapshot],
  );
  const author = revisionAuthor(revision);
  const timestamp = formatDate(revision.createdAt);
  const restoreField = restorableField(entityType);
  const canRestore = restoreField in revision.snapshot;

  useEffect(() => {
    if (step === 'confirm') cancelRestoreRef.current?.focus();
    else closeRef.current?.focus();
  }, [step]);

  return (
    <div
      className="dialog-backdrop z-50 !items-end !p-0 sm:!place-items-center sm:!p-4"
      onClick={() => !restoring && onClose()}
    >
      <div
        ref={dialogRef}
        className="dialog max-h-[calc(100dvh-0.75rem)] !w-full !max-w-5xl overflow-y-auto !rounded-b-none sm:max-h-[calc(100dvh-2rem)] sm:!rounded-lg"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={restoring || undefined}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="space-y-1">
          <h2 className="dialog-title" id={titleId}>
            {step === 'confirm' ? 'Restore this version?' : 'Inspect historical version'}
          </h2>
          <p id={descriptionId} className="text-sm text-slate-400">
            Saved {timestamp} by {author}.
          </p>
        </div>

        {step === 'inspect' ? (
          <>
            {fields.length === 0 ? (
              <div className="cf-inset p-4 text-sm text-slate-400">
                This legacy revision has no readable fields. It can still be retained in history, but there is nothing to preview.
              </div>
            ) : (
              <div className="space-y-3" aria-label="Current and selected version comparison">
                {fields.map((field) => {
                  const selectedMissing = !(field in revision.snapshot);
                  const currentMissing = !(field in currentSnapshot);
                  const changed = revision.snapshot[field] !== currentSnapshot[field];
                  const historicalOnly = field !== restoreField;
                  const notRecorded = !historicalOnly && selectedMissing;
                  return (
                    <section key={field} className="cf-inset overflow-hidden p-3 sm:p-4" aria-label={fieldLabel(entityType, field)}>
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-bold text-slate-200">{fieldLabel(entityType, field)}</p>
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                            historicalOnly || notRecorded
                              ? 'border-slate-400/40 text-slate-300'
                              : changed
                              ? 'border-amber-400/40 text-amber-300'
                              : 'border-emerald-400/35 text-emerald-300'
                          }`}
                        >
                          {historicalOnly ? 'Historical only' : notRecorded ? 'Not recorded' : changed ? 'Changed' : 'Unchanged'}
                        </span>
                      </div>
                      {historicalOnly && (
                        <p className="mb-3 text-xs text-slate-400">
                          This legacy field is shown for reference and is not changed by restore.
                        </p>
                      )}
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        <div className="min-w-0 rounded-md border border-slate-700/70 p-3">
                          <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-300">Current</p>
                          <PreviewValue field={field} value={currentSnapshot[field] ?? ''} missing={currentMissing} />
                        </div>
                        <div className="min-w-0 rounded-md border border-[var(--cf-accent)]/35 bg-[var(--cf-accent)]/5 p-3">
                          <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-violet-300">
                            Selected version
                          </p>
                          <PreviewValue field={field} value={revision.snapshot[field] ?? ''} missing={selectedMissing} />
                        </div>
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Btn ghost ref={closeRef} onClick={onClose} className="w-full sm:w-auto">
                Close preview
              </Btn>
              <Btn
                onClick={() => onStepChange('confirm')}
                disabled={!canRestore}
                className="w-full sm:w-auto"
              >
                Restore this version
              </Btn>
            </div>
          </>
        ) : (
          <>
            <div className="space-y-3 text-sm text-slate-300">
              <p>
                You’re restoring the version saved <strong>{timestamp}</strong> by <strong>{author}</strong>.
              </p>
              <p className="cf-inset p-3">
                Restore creates a new revision from the current content before applying this version. Nothing in the history is erased, so this change can be reversed later.
              </p>
              {restoreError && <ErrorNote message={restoreError} />}
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Btn
                ghost
                ref={cancelRestoreRef}
                onClick={() => onStepChange('inspect')}
                disabled={restoring}
                className="w-full sm:w-auto"
              >
                Cancel restore
              </Btn>
              <Btn danger onClick={onRestore} busy={restoring} className="w-full sm:w-auto">
                {restoring ? 'Restoring…' : restoreError ? 'Try restore again' : 'Restore version'}
              </Btn>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Reusable prose revision history with full snapshot inspection, a current-versus-selected
 * comparison, and a reversible restore confirmation. The server still owns access control
 * and restore semantics; consumers provide only the live fields needed to explain the diff.
 */
export function RevisionHistoryPanel({
  entityType,
  entityId,
  currentSnapshot,
  reloadNonce,
  onRestored,
  label = 'Edit history',
}: {
  entityType: RevisionEntityType;
  entityId: number;
  /** Current restorable fields, keyed the same way as the server snapshot. */
  currentSnapshot: Snapshot;
  /** Bump to force a refetch after an out-of-band save (e.g. the owning editor saved). */
  reloadNonce?: number;
  /** Called after a successful restore so the parent can reload the live prose. */
  onRestored?: () => void;
  label?: string;
}) {
  const regionId = useId();
  const [open, setOpen] = useState(false);
  const [revisions, setRevisions] = useState<EntityRevision[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<EntityRevision | null>(null);
  const [dialogStep, setDialogStep] = useState<DialogStep>('inspect');
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    api
      .get<EntityRevision[]>(`${API}/revisions/${entityType}/${entityId}`)
      .then((rows) => {
        if (!cancelled) setRevisions(rows);
      })
      .catch(() => {
        if (!cancelled) setLoadError("Couldn't load revision history. Check your connection and try again.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, entityType, entityId, reloadNonce, loadAttempt]);

  function inspect(revision: EntityRevision) {
    setSelected(revision);
    setDialogStep('inspect');
    setRestoreError(null);
  }

  function closeDialog() {
    if (restoring) return;
    setSelected(null);
    setDialogStep('inspect');
    setRestoreError(null);
  }

  async function restore() {
    if (!selected || restoring) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      const res = await api.post<{ revisions: EntityRevision[] }>(
        `${API}/revisions/${entityType}/${entityId}/${selected.id}/restore`,
      );
      if (res?.revisions) setRevisions(res.revisions);
      const restoredLabel = formatDate(selected.createdAt);
      setSelected(null);
      setDialogStep('inspect');
      setRestoreError(null);
      setAnnouncement(`Restored the version from ${restoredLabel}. The previous content remains in revision history.`);
      onRestored?.();
    } catch {
      setRestoreError("Couldn't restore this version. Your current content was not changed. Try again.");
    } finally {
      setRestoring(false);
    }
  }

  return (
    <Card className="!p-4 sm:!p-5">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left text-xs font-bold uppercase tracking-wide text-slate-500"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span>{label}</span>
      </button>

      {open && (
        <div id={regionId} className="mt-3 space-y-3">
          {announcement && (
            <p role="status" className="cf-inset p-3 text-sm text-emerald-300">
              {announcement}
            </p>
          )}
          {loading && revisions.length > 0 && (
            <p role="status" className="text-xs text-slate-400">
              Refreshing revision history…
            </p>
          )}
          {loadError && <ErrorNote message={loadError} onRetry={() => setLoadAttempt((attempt) => attempt + 1)} />}
          {loading && revisions.length === 0 ? (
            <div role="status" aria-live="polite" className="space-y-2">
              <span className="sr-only">Loading revision history…</span>
              <Skeleton lines={3} />
            </div>
          ) : loadError && revisions.length === 0 ? null : revisions.length === 0 ? (
            <p className="text-sm text-slate-600">No earlier versions yet — edits are recorded here from now on.</p>
          ) : (
            <ul className="divide-y divide-slate-800" aria-label={`${label} versions`}>
              {revisions.map((revision) => {
                const fields = snapshotFields(revision.snapshot, currentSnapshot);
                const previewField = fields.find((field) => field in revision.snapshot);
                const prior = previewField ? revision.snapshot[previewField] ?? '' : '';
                const preview = prior.replace(/\s+/g, ' ').trim().slice(0, 120);
                const author = revisionAuthor(revision);
                const timestamp = formatDate(revision.createdAt);
                const restoreField = restorableField(entityType);
                const restoreLabel = fieldLabel(entityType, restoreField);
                const restoreFieldRecorded = restoreField in revision.snapshot;
                const unchanged = valuesMatch(entityType, revision.snapshot, currentSnapshot);
                return (
                  <li key={revision.id} className="flex flex-col gap-2 py-3 first:pt-0 sm:flex-row sm:items-start">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-muted">
                        <span>{author}</span> · <time dateTime={revision.createdAt}>{timestamp}</time>
                      </p>
                      <p className="mt-0.5 line-clamp-2 break-words text-[13px] text-slate-400">{preview || '(empty)'}</p>
                      <p
                        className={`mt-1 text-[11px] font-semibold ${
                          !restoreFieldRecorded ? 'text-slate-400' : unchanged ? 'text-emerald-300' : 'text-amber-300'
                        }`}
                      >
                        {!restoreFieldRecorded
                          ? `${restoreLabel} was not recorded in this version`
                          : `${restoreLabel} ${unchanged ? 'matches' : 'differs from'} current content`}
                      </p>
                    </div>
                    <Btn
                      ghost
                      className="!min-h-0 w-full shrink-0 !py-1 text-xs sm:w-auto"
                      onClick={() => inspect(revision)}
                      aria-label={`Preview version from ${timestamp} by ${author}`}
                    >
                      Preview
                    </Btn>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {selected && (
        <RevisionDialog
          revision={selected}
          entityType={entityType}
          currentSnapshot={currentSnapshot}
          step={dialogStep}
          restoring={restoring}
          restoreError={restoreError}
          onStepChange={(step) => {
            setDialogStep(step);
            setRestoreError(null);
          }}
          onRestore={() => void restore()}
          onClose={closeDialog}
        />
      )}
    </Card>
  );
}
