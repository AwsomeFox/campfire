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
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import type { Quest, QuestChanges } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { usePollWhileVisible } from '../../lib/usePollWhileVisible';
import { useAuth } from '../../app/auth';
import { Skeleton, ErrorNote, EmptyState } from '../../components/ui';
import { QuestStatusBadge } from '../../components/EntitySemanticBadges';
import { DraftWithAiButton } from '../ai-dm/DraftWithAiButton';

// "Updated Xd ago", mirroring the dashboard's NotesQuickRail phrasing so relative
// times read consistently across the app.
function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  if (days <= 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

// What changed since the last session (#66): the /quests/changes endpoint returns
// the reference instant plus the changed quests. A quest created at/after that
// instant is NEW; one merely edited since is CHANGED. Keyed by id for O(1) lookup
// while rendering the board.
type ChangeKind = 'new' | 'changed';
function buildChangeMap(changes: QuestChanges | null): Map<number, ChangeKind> {
  const map = new Map<number, ChangeKind>();
  if (!changes || changes.since == null) return map;
  for (const q of changes.quests) {
    map.set(q.id, q.createdAt >= changes.since ? 'new' : 'changed');
  }
  return map;
}

// NEW / CHANGED marker for a quest touched since the last session (#66), plus the
// "updated Xd ago" relative time. Renders nothing when the quest hasn't changed.
function ChangeBadge({ quest, kind }: { quest: Quest; kind: ChangeKind | undefined }) {
  const { t } = useTranslation();
  if (!kind) return null;
  const label = kind === 'new' ? t('quests.new') : t('quests.changed');
  return (
    <span
      className="tag tag-accent"
      style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.3 }}
      title={t('quests.changeBadgeTitle', { label, time: timeAgo(quest.updatedAt) })}
    >
      {label} · {timeAgo(quest.updatedAt)}
    </span>
  );
}

// Quest objectives aren't included on the list endpoint (GET /campaigns/:id/quests returns
// bare Quest rows, no `objectives`) — the design's per-quest objective checklist on this
// screen can't be rendered here without an extra fetch. We show status + subquests only;
// objective ticking still lives on the Quest detail screen. See report deviations.

export default function QuestListPage() {
  const { t } = useTranslation();
  const { campaignId } = useParams<{ campaignId: string }>();
  const cid = Number(campaignId);
  const { roleIn } = useAuth();
  const role = roleIn(cid);
  const isDm = role === 'dm';

  const [quests, setQuests] = useState<Quest[]>([]);
  const [changes, setChanges] = useState<Map<number, ChangeKind>>(new Map());
  const [changesSince, setChangesSince] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      // The "what changed since last session" diff is a nicety layered onto the
      // board — never let it fail the whole page, so it's fetched alongside but
      // its own failure just drops the badges (empty change map).
      const [list, changeRes] = await Promise.all([
        api.get<Quest[]>(`${API}/campaigns/${cid}/quests`),
        api.get<QuestChanges>(`${API}/campaigns/${cid}/quests/changes`).catch(() => null),
      ]);
      setQuests(list);
      setChanges(buildChangeMap(changeRes));
      setChangesSince(changeRes?.since ?? null);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setForbidden(true);
      } else {
        setError(t('quests.loadFailed'));
      }
    } finally {
      setLoading(false);
    }
  }, [cid]);

  useEffect(() => {
    if (Number.isFinite(cid)) void load();
  }, [cid, load]);

  // Keep the quest board live at the table (issue #113): poll ~5s while visible.
  usePollWhileVisible(() => void load(), 5000, Number.isFinite(cid));

  if (!Number.isFinite(cid)) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <ErrorNote message={t('quests.noCampaign')} />
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <EmptyState icon="padlock" title={t('quests.noAccess')} />
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
    <div data-testid="quest-list-surface" className="max-w-4xl mx-auto px-4 mt-5 pb-20 md:pb-10" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h3 style={{ margin: '4px 0 0' }}>{t('quests.title')}</h3>
        <div style={{ flex: 1 }} />
        <DraftWithAiButton campaignId={cid} target="beat" label="Draft a beat with AI" />
        {isDm && (
          <Link to={`/c/${cid}/quests/new`} className="btn btn-primary" style={{ fontSize: 13 }}>
            {t('quests.newQuest')}
          </Link>
        )}
      </div>

      {changesSince && changes.size > 0 && (
        <p className="text-muted" style={{ margin: '-6px 0 0', fontSize: 12 }}>
          {t('quests.changedSummary', {
            countLabel: changes.size === 1 ? t('quests.oneQuest') : t('quests.nQuests', { n: changes.size }),
            time: timeAgo(changesSince),
          })}
        </p>
      )}

      {error && <ErrorNote message={error} onRetry={load} />}

      {loading && !quests.length ? (
        <div className="card elev-sm">
          <Skeleton lines={5} />
        </div>
      ) : roots.length === 0 ? (
        <EmptyState icon="scroll-unfurled" title={t('quests.empty.title')} hint={isDm ? t('quests.empty.hintDm') : t('quests.empty.hintPlayer')} />
      ) : (
        roots.map((q) => {
          const kids = childrenOf(q.id);
          return (
            <div key={q.id} className="card elev-sm">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <QuestStatusBadge status={q.status} />
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
                <ChangeBadge quest={q} kind={changes.get(q.id)} />
                {isDm && q.hidden && (
                  <span className="tag tag-outline" style={{ fontSize: 10 }} title={t('quests.hiddenFromPlayers')}>
                    {t('quests.hidden')}
                  </span>
                )}
                <div style={{ flex: 1 }} />
                {q.reward && (
                  <span
                    className="tag tag-neutral"
                    style={{ fontSize: 10, whiteSpace: 'normal', maxWidth: '100%', overflowWrap: 'anywhere', textAlign: 'left' }}
                    title={q.reward}
                  >
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
                  <QuestStatusBadge status={s.status} />
                  <ChangeBadge quest={s} kind={changes.get(s.id)} />
                </div>
              ))}
            </div>
          );
        })
      )}
    </div>
  );
}
