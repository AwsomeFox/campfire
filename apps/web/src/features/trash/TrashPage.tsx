/**
 * Per-campaign Trash (issue #269) — the recovery surface the soft-delete/undo feature
 * (#116) promised but never built. Deleting an entity shows an Undo toast that says
 * "restore it from the campaign Trash"; this is that Trash. It lists the campaign's
 * soft-deleted child entities (GET /campaigns/:id/trash — DM-only) and offers a
 * one-click Restore (POST /<type>/:id/restore) so a mis-click is recoverable long
 * after the toast has expired.
 *
 * Route: /c/:campaignId/trash. Covers the entity types with a DM-gated restore route
 * today: sessions, characters, quests, npcs, locations (see TrashedEntityType).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { TrashedEntity, TrashedEntityType } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { formatDate as formatLocaleDate, useFormattingLocale } from '../../lib/format';
import { useAuth } from '../../app/auth';
import { Card, Btn, EmptyState, Skeleton, ErrorNote } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';
import { ENTITY_ICON } from '../../lib/uiIcons';

/** Restore route base + display label per trashed entity type. Route is `/<base>/:id/restore`. */
const TYPE_META: Record<TrashedEntityType, { label: string; route: string; icon: string }> = {
  session: { label: 'Session', route: 'sessions', icon: ENTITY_ICON.session },
  character: { label: 'Character', route: 'characters', icon: ENTITY_ICON.character },
  quest: { label: 'Quest', route: 'quests', icon: ENTITY_ICON.quest },
  npc: { label: 'NPC', route: 'npcs', icon: ENTITY_ICON.npc },
  location: { label: 'Location', route: 'locations', icon: ENTITY_ICON.location },
};

export default function TrashPage() {
  useFormattingLocale();
  const { campaignId } = useParams<{ campaignId: string }>();
  const cid = Number(campaignId);
  const { roleIn } = useAuth();
  const isDm = roleIn(cid) === 'dm';

  const [items, setItems] = useState<TrashedEntity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setForbidden(false);
    setLoading(true);
    try {
      setItems(await api.get<TrashedEntity[]>(`${API}/campaigns/${cid}/trash`));
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) setForbidden(true);
      else setError("Couldn't load the Trash.");
    } finally {
      setLoading(false);
    }
  }, [cid]);

  useEffect(() => {
    if (Number.isFinite(cid)) void load();
  }, [cid, load]);

  async function restore(item: TrashedEntity) {
    const key = `${item.type}:${item.id}`;
    setRestoringId(key);
    setError(null);
    try {
      await api.post(`${API}/${TYPE_META[item.type].route}/${item.id}/restore`);
      // Drop the restored row locally so it disappears immediately, no manual reload.
      setItems((prev) => prev.filter((i) => !(i.type === item.type && i.id === item.id)));
    } catch {
      setError(`Couldn't restore that ${TYPE_META[item.type].label.toLowerCase()}.`);
    } finally {
      setRestoringId(null);
    }
  }

  if (!Number.isFinite(cid)) {
    return (
      <div className="max-w-3xl mx-auto px-4 mt-5">
        <ErrorNote message="No campaign selected." />
      </div>
    );
  }

  if (forbidden || (!loading && !isDm)) {
    return (
      <div className="max-w-3xl mx-auto px-4 mt-5">
        <Card>
          <EmptyState icon="padlock" title="Only the DM can view the campaign Trash" />
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 mt-5 space-y-4 pb-20 md:pb-10">
      <div className="flex items-center gap-2.5">
        <h1 className="text-2xl font-extrabold text-white">Trash</h1>
        <div className="flex-1" />
        <Link to={`/c/${cid}`} className="text-xs text-slate-500 hover:text-slate-300">
          ← Dashboard
        </Link>
      </div>

      <p className="text-[13px] text-muted m-0">
        Deleted sessions, characters, quests, NPCs and locations land here — restore any of them to bring the entity back
        exactly as it was. Nothing here is permanent yet.
      </p>

      {error && <ErrorNote message={error} onRetry={load} />}

      {loading ? (
        <Card>
          <Skeleton lines={4} />
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState icon="trash-can" title="The Trash is empty" hint="Deleted entities show up here until you restore them." />
        </Card>
      ) : (
        <Card>
          <ul className="m-0 p-0" style={{ listStyle: 'none' }}>
            {items.map((item) => {
              const meta = TYPE_META[item.type];
              const key = `${item.type}:${item.id}`;
              return (
                <li
                  key={key}
                  className="flex items-center gap-3 py-2.5"
                  style={{ borderBottom: '1px solid var(--color-accent-900, rgba(255,255,255,0.06))' }}
                >
                  <span aria-hidden className="flex text-[var(--color-neutral-400)]">
                    <GameIcon slug={meta.icon} size={20} />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="flex items-baseline gap-2 flex-wrap">
                      <span className="tag">{meta.label}</span>
                      <span className="font-heading text-[15px] text-white truncate">{item.name || 'Untitled'}</span>
                    </span>
                    <span className="text-muted text-[11.5px] block mt-0.5">Deleted {formatDate(item.deletedAt)}</span>
                  </span>
                  <Btn
                    ghost
                    className="!min-h-0 !py-1.5 text-xs shrink-0"
                    onClick={() => void restore(item)}
                    disabled={restoringId === key}
                  >
                    {restoringId === key ? 'Restoring…' : 'Restore'}
                  </Btn>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}

function formatDate(iso: string): string {
  if (!iso || Number.isNaN(new Date(iso).getTime())) return 'recently';
  return formatLocaleDate(iso, { month: 'short', day: 'numeric', year: 'numeric' });
}
