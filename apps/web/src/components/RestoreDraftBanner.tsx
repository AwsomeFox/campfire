/**
 * Restore prompt when a namespaced local draft exists (issue #641).
 */
import { Btn } from './ui';
import { formatDateTime } from '../lib/format';

export function RestoreDraftBanner({
  savedAt,
  stale,
  onRestore,
  onDismiss,
}: {
  savedAt: string;
  stale: boolean;
  onRestore: () => void;
  onDismiss: () => void;
}) {
  const when = formatDraftSavedAt(savedAt);
  return (
    <div className="card elev-sm space-y-2" role="region" aria-label="Draft restore">
      <p className="m-0 text-sm text-slate-200">
        {stale
          ? `You have a local draft from ${when}, but the server copy changed since then. Restoring may overwrite newer work.`
          : `You have an unsaved local draft from ${when}.`}
      </p>
      <div className="flex flex-wrap gap-2">
        <Btn density="xs" className="text-xs" onClick={onRestore}>
          Restore draft
        </Btn>
        <Btn density="xs" ghost className="text-xs" onClick={onDismiss}>
          Discard draft
        </Btn>
      </div>
    </div>
  );
}

function formatDraftSavedAt(savedAt: string): string {
  return formatDateTime(savedAt);
}
