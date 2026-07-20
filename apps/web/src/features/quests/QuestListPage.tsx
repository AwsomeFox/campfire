/**
 * Quest list/board — design/claude-design/Campfire.dc.html "Quests" screen (~L541-568).
 * One card per root quest with inline objectives + subquest rows; DM gets "+ New quest".
 *
 * Route this page needs (wired by the app orchestrator, not by this feature):
 *   /c/:campaignId/quests  →  features/quests/QuestListPage.tsx (default export)
 *
 * Data: GET /api/v1/campaigns/:campaignId/quests
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Quest } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Skeleton, ErrorNote, EmptyState } from '../../components/ui';

const STATUS_GLYPH: Record<Quest['status'], { glyph: string; color: string }> = {
  available: { glyph: '○', color: 'var(--color-neutral-500)' },
  active: { glyph: '◐', color: 'var(--color-accent)' },
  completed: { glyph: '✓', color: 'var(--color-neutral-500)' },
  failed: { glyph: '✕', color: 'var(--color-neutral-600)' },
};

const STATUS_LABEL: Record<Quest['status'], string> = {
  available: 'Available',
  active: 'Active',
  completed: 'Completed',
  failed: 'Failed',
};

const STATUS_TAG_CLASS: Record<Quest['status'], string> = {
  available: 'tag tag-outline',
  active: 'tag tag-accent',
  completed: 'tag tag-neutral',
  failed: 'tag tag-neutral',
};

// Quest objectives aren't included on the list endpoint (GET /campaigns/:id/quests returns
// bare Quest rows, no `objectives`) — the design's per-quest objective checklist on this
// screen can't be rendered here without an extra fetch. We show status + subquests only;
// objective ticking still lives on the Quest detail screen. See report deviations.

export default function QuestListPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const cid = Number(campaignId);
  const { roleIn } = useAuth();
  const role = roleIn(cid);
  const isDm = role === 'dm';

  const [quests, setQuests] = useState<Quest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const list = await api.get<Quest[]>(`${API}/campaigns/${cid}/quests`);
      setQuests(list);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setForbidden(true);
      } else {
        setError("Couldn't load quests.");
      }
    } finally {
      setLoading(false);
    }
  }, [cid]);

  useEffect(() => {
    if (Number.isFinite(cid)) void load();
  }, [cid, load]);

  if (!Number.isFinite(cid)) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <ErrorNote message="No campaign selected." />
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <EmptyState icon="🔒" title="You don't have access to this campaign" />
      </div>
    );
  }

  // Root/child partition that stays robust against legacy cyclic data (#95): the
  // server now rejects parent cycles, but any pre-existing A↔B loop must still not
  // make quests vanish. A quest renders as a root when it has no parent, its parent
  // isn't in this list (orphan), OR walking its ancestor chain loops back to itself
  // (cycle). Children exclude anything that is itself a root, so a cycle surfaces as
  // two standalone cards rather than an infinite/duplicated nesting.
  const byId = new Map(quests.map((q) => [q.id, q]));
  const isRoot = (q: Quest): boolean => {
    if (q.parentId == null) return true;
    const seen = new Set<number>([q.id]);
    let cur = byId.get(q.parentId);
    while (cur) {
      if (seen.has(cur.id)) return true; // cycle back to q (or a loop) → treat as root
      if (cur.parentId == null) return false; // chain terminates cleanly → genuine child
      seen.add(cur.id);
      cur = byId.get(cur.parentId);
    }
    return true; // parent missing from list → orphan, show as root
  };
  const roots = quests.filter(isRoot);
  const childrenOf = (parentId: number) => quests.filter((q) => q.parentId === parentId && !isRoot(q));

  return (
    <div className="max-w-4xl mx-auto px-4 mt-5 pb-20 md:pb-10" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h3 style={{ margin: '4px 0 0' }}>Quests</h3>
        <div style={{ flex: 1 }} />
        {isDm && (
          <Link to={`/c/${cid}/quests/new`} className="btn btn-primary" style={{ fontSize: 13 }}>
            + New quest
          </Link>
        )}
      </div>

      {error && <ErrorNote message={error} onRetry={load} />}

      {loading && !quests.length ? (
        <div className="card elev-sm">
          <Skeleton lines={5} />
        </div>
      ) : roots.length === 0 ? (
        <EmptyState icon="📜" title="No quests yet" hint={isDm ? 'Start one with "+ New quest".' : 'Check back after the next session.'} />
      ) : (
        roots.map((q) => {
          const kids = childrenOf(q.id);
          const meta = STATUS_GLYPH[q.status];
          return (
            <div key={q.id} className="card elev-sm">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 14, width: 18, textAlign: 'center', color: meta.color }}>{meta.glyph}</span>
                <Link
                  to={`/c/${cid}/quests/${q.id}`}
                  style={{
                    color: 'var(--color-text)',
                    fontFamily: 'var(--font-heading)',
                    fontWeight: 500,
                    fontSize: 16,
                    textDecoration: 'none',
                    opacity: q.status === 'completed' || q.status === 'failed' ? 0.7 : 1,
                  }}
                >
                  {q.title}
                </Link>
                <span className={STATUS_TAG_CLASS[q.status]} style={{ fontSize: 10 }}>
                  {STATUS_LABEL[q.status]}
                </span>
                {isDm && q.hidden && (
                  <span className="tag tag-outline" style={{ fontSize: 10 }} title="Hidden from players">
                    🙈 Hidden
                  </span>
                )}
                <div style={{ flex: 1 }} />
                {q.reward && (
                  <span className="tag tag-neutral" style={{ fontSize: 10, whiteSpace: 'nowrap' }}>
                    {q.reward}
                  </span>
                )}
              </div>
              {kids.map((s) => (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 9, minHeight: 28, paddingLeft: 4 }}>
                  <span className="text-muted">↳</span>
                  <Link
                    to={`/c/${cid}/quests/${s.id}`}
                    style={{ color: 'var(--color-neutral-200)', fontSize: 13.5, textDecoration: 'none' }}
                  >
                    {s.title}
                  </Link>
                  <span className="tag tag-neutral" style={{ fontSize: 10 }}>
                    {STATUS_LABEL[s.status]}
                  </span>
                </div>
              ))}
            </div>
          );
        })
      )}
    </div>
  );
}
