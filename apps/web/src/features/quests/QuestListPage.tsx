/**
 * Quest list/board — design/claude-design/Campfire.dc.html "Quests" screen (~L541-568).
 * One card per root quest with bounded objective progress + subquest rows; DM gets "+ New quest".
 *
 * Route this page needs (wired by the app orchestrator, not by this feature):
 *   /c/:campaignId/quests  →  features/quests/QuestListPage.tsx (default export)
 *
 * Data: GET /api/v1/campaigns/:campaignId/quests
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { ListDetailLink } from '../../components/ListDetailLink';
import { useRestoreListOriginScroll } from '../../hooks/useRestoreListOriginScroll';
import type { Quest, QuestChanges, QuestListItem } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { usePollWhileVisible } from '../../lib/usePollWhileVisible';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import { Card, Skeleton, ErrorNote, EmptyState } from '../../components/ui';
import { QuestStatusBadge } from '../../components/EntitySemanticBadges';
import { PageHeader, type PageHeaderSecondaryAction } from '../../components/PageHeader';
import { cardExcerpt } from '../../lib/cardExcerpt';
import { usePageHeaderDraftWithAi } from '../ai-dm/usePageHeaderDraftWithAi';
import { GameIcon } from '../../components/GameIcon';
import { UI_ICON_SIZE } from '../../lib/uiIcons';
import { timeAgo, useTimeTick } from '../../lib/format';



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

export default function QuestListPage() {
  useTimeTick();
  const { t } = useTranslation();
  const { campaignId } = useParams<{ campaignId: string }>();
  const cid = Number(campaignId);
  const { isDm, canDmWrite } = useCampaignAccess();
  useRestoreListOriginScroll();

  const { secondaryAction: draftAction, draftDialog } = usePageHeaderDraftWithAi({
    campaignId: Number.isFinite(cid) ? cid : 0,
    target: 'quest',
    label: t('quests.draftWithAi'),
  });

  const secondaryActions: PageHeaderSecondaryAction[] = draftAction ? [draftAction] : [];

  const [quests, setQuests] = useState<QuestListItem[]>([]);
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
        api.get<QuestListItem[]>(`${API}/campaigns/${cid}/quests`),
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
  const isRoot = (q: QuestListItem): boolean => {
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
      <PageHeader
        icon={<GameIcon slug="scroll-unfurled" size={UI_ICON_SIZE.md} />}
        title={t('quests.title')}
        secondaryActions={secondaryActions}
        primaryAction={
          canDmWrite ? (
            <Link to={`/c/${cid}/quests/new`} className="btn btn-primary cf-page-header__action" style={{ fontSize: 13 }}>
              {t('quests.newQuest')}
            </Link>
          ) : undefined
        }
      />
      {draftDialog}

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
        <Card density="compact" elev="sm">
          <Skeleton lines={5} />
        </Card>
      ) : roots.length === 0 ? (
        <EmptyState icon="scroll-unfurled" title={t('quests.empty.title')} hint={isDm ? t('quests.empty.hintDm') : t('quests.empty.hintPlayer')} />
      ) : (
        roots.map((q) => {
          const kids = childrenOf(q.id);
          return (
            <Card key={q.id} data-testid={`quest-card-${q.id}`} density="compact" elev="sm" className="quest-list-card">
              <div className="quest-card-heading">
                <QuestStatusBadge status={q.status} />
                <h2
                  className="quest-card-title"
                  style={{
                    margin: 0,
                    fontFamily: 'var(--font-heading)',
                    fontWeight: 500,
                    fontSize: 16,
                    opacity: q.status === 'completed' || q.status === 'failed' ? 0.7 : 1,
                  }}
                >
                  <ListDetailLink
                    to={`/c/${cid}/quests/${q.id}`}
                    style={{
                      color: 'var(--color-text)',
                      textDecoration: 'none',
                    }}
                  >
                    {q.title}
                  </ListDetailLink>
                </h2>
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
              {/* A one-glance sense of WHAT the quest is. The card previously showed the
                  title, its badges and its objective counter — so a list of quests told a
                  DM almost nothing about any of them, and every card needed opening to be
                  identified. `body` is the player-visible field (`dmSecret` is the DM-only
                  one), so this leaks nothing the title row did not already. */}
              {cardExcerpt(q.body) && (
                /* Bounded BEFORE render, not just clamped in CSS. `Quest.body` allows 50k
                   characters and this list is unpaginated, so passing the raw body would
                   put megabytes of markdown in the DOM — and in `title`, a tooltip the
                   size of the field — while CSS painted two lines of it. */
                <p className="cf-card-excerpt" title={cardExcerpt(q.body)}>
                  {cardExcerpt(q.body)}
                </p>
              )}
              {q.status === 'active' && (
                <div className="quest-card-progress">
                  <div className="quest-progress-summary">
                    <span>{t('quests.objectiveProgress', q.objectiveProgress)}</span>
                    {q.objectiveProgress.total > 0 && (
                      <span
                        className="quest-progress-track"
                        role="progressbar"
                        aria-label={t('quests.objectiveProgressLabel', { title: q.title })}
                        aria-valuemin={0}
                        aria-valuemax={q.objectiveProgress.total}
                        aria-valuenow={q.objectiveProgress.completed}
                        aria-valuetext={t('quests.objectiveProgress', q.objectiveProgress)}
                      >
                        <span
                          className="quest-progress-fill"
                          style={{ width: `${(q.objectiveProgress.completed / q.objectiveProgress.total) * 100}%` }}
                        />
                      </span>
                    )}
                  </div>
                  {q.nextObjective && (
                    <p className="quest-next-step">
                      <strong>{t('quests.continue')}</strong>{' '}
                      <span>{q.nextObjective.text}</span>
                    </p>
                  )}
                  <ListDetailLink
                    to={`/c/${cid}/quests/${q.id}`}
                    className="btn btn-secondary quest-detail-link"
                    aria-label={t('quests.viewDetailsLabel', { title: q.title })}
                  >
                    {t('quests.viewDetails')}
                  </ListDetailLink>
                </div>
              )}
              {kids.map((s) => (
                <div key={s.id} className="quest-subquest-row">
                  <span className="text-muted" aria-hidden="true">↳</span>
                  <h3 style={{ margin: 0, minWidth: 0, fontSize: 13.5, fontWeight: 500 }}>
                    <ListDetailLink
                      to={`/c/${cid}/quests/${s.id}`}
                      style={{ color: 'var(--color-neutral-200)', textDecoration: 'none', overflowWrap: 'anywhere' }}
                    >
                      {s.title}
                    </ListDetailLink>
                  </h3>
                  <QuestStatusBadge status={s.status} />
                  <ChangeBadge quest={s} kind={changes.get(s.id)} />
                </div>
              ))}
            </Card>
          );
        })
      )}
    </div>
  );
}
