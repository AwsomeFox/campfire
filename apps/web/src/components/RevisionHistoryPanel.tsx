import { useEffect, useState } from 'react';
import type { EntityRevision, RevisionEntityType } from '@campfire/schema';
import { api, API } from '../lib/api';
import { Card, Btn, ErrorNote } from './ui';

/**
 * Prose revision history + restore (issue #157/#233). Generic over the revision entity
 * types — the collapsed panel the entity detail pages mount so a clobbered or regretted
 * edit is recoverable (a co-DM or a connected AI over MCP can overwrite prose between a
 * load and a save). Lists the prior-content snapshots the server records on every
 * committed prose change (newest first) and lets an authorized caller restore any of
 * them; the restore is itself recorded server-side, so it's reversible.
 *
 * Access is enforced server-side (dm-gated for world-building prose, note-visibility +
 * author for notes) — this component just renders whatever the endpoint returns and
 * surfaces a friendly error otherwise. Originally lived only on SessionsPage; extracted
 * here so quest/npc/location/note pages share one implementation.
 */
export function RevisionHistoryPanel({
  entityType,
  entityId,
  reloadNonce,
  onRestored,
  label = 'Edit history',
}: {
  entityType: RevisionEntityType;
  entityId: number;
  /** Bump to force a refetch after an out-of-band save (e.g. the owning editor saved). */
  reloadNonce?: number;
  /** Called after a successful restore so the parent can reload the live prose. */
  onRestored?: () => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [revisions, setRevisions] = useState<EntityRevision[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get<EntityRevision[]>(`${API}/revisions/${entityType}/${entityId}`)
      .then((rows) => {
        if (!cancelled) setRevisions(rows);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load history.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, entityType, entityId, reloadNonce]);

  async function restore(revisionId: number) {
    setRestoringId(revisionId);
    setError(null);
    try {
      const res = await api.post<{ revisions: EntityRevision[] }>(
        `${API}/revisions/${entityType}/${entityId}/${revisionId}/restore`,
      );
      if (res?.revisions) setRevisions(res.revisions);
      onRestored?.();
    } catch {
      setError("Couldn't restore that version.");
    } finally {
      setRestoringId(null);
    }
  }

  return (
    <Card>
      <button
        className="flex items-center gap-2 text-xs font-bold text-slate-500 uppercase tracking-wide w-full"
        onClick={() => setOpen((v) => !v)}
      >
        <span>{open ? '▾' : '▸'}</span>
        <span>{label}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {error && <ErrorNote message={error} />}
          {loading ? (
            <p className="text-sm text-slate-600">Loading history…</p>
          ) : revisions.length === 0 ? (
            <p className="text-sm text-slate-600">No earlier versions yet — edits are recorded here from now on.</p>
          ) : (
            revisions.map((rev) => {
              // The snapshot is keyed by the entity's prose field ('recap' for a session,
              // 'body' for everything else) — render whichever key is present.
              const prior = rev.snapshot.body ?? rev.snapshot.recap ?? '';
              const preview = prior.replace(/\s+/g, ' ').trim().slice(0, 120);
              return (
                <div key={rev.id} className="flex items-start gap-2 border-t border-slate-800 pt-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-muted">
                      {rev.authorName || 'Someone'} · {new Date(rev.createdAt).toLocaleString()}
                    </div>
                    <div className="text-[13px] text-slate-400 truncate">{preview || '(empty)'}</div>
                  </div>
                  <Btn
                    ghost
                    className="!min-h-0 !py-1 text-xs shrink-0"
                    onClick={() => restore(rev.id)}
                    disabled={restoringId !== null}
                  >
                    {restoringId === rev.id ? 'Restoring…' : 'Restore'}
                  </Btn>
                </div>
              );
            })
          )}
        </div>
      )}
    </Card>
  );
}
