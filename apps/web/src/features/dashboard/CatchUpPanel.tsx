/**
 * Dashboard catch-up panel (#549) — grouped, role-safe diff since the member's
 * stored cursor (or last session when no cursor exists yet).
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { CampaignCatchUp, CatchUpChangeKind } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Card, ErrorNote } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';
import { useAnnounce } from '../../components/Announcer';
import { entityHref } from '../../lib/entityLinks';
import { UI_ICON_SIZE } from '../../lib/uiIcons';
import { timeAgo, useTimeTick, formatDateTime } from '../../lib/format';

const MAX_SHOWN = 30;



function kindLabel(t: (key: string) => string, kind: CatchUpChangeKind): string {
  if (kind === 'new') return t('catchUp.kindNew');
  if (kind === 'resolved') return t('catchUp.kindResolved');
  return t('catchUp.kindChanged');
}

type PeriodMode = 'visit' | 'session';

export function CatchUpPanel({ campaignId }: { campaignId: number }) {
  useTimeTick();
  const { t } = useTranslation();
  const titleId = useId();
  const announce = useAnnounce();
  const announced = useRef(false);
  const [data, setData] = useState<CampaignCatchUp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [marking, setMarking] = useState(false);
  const [period, setPeriod] = useState<PeriodMode>('visit');
  const [sessionSince, setSessionSince] = useState<string | null>(null);

  const load = useCallback(
    async (sinceOverride?: string) => {
      setError(null);
      try {
        const qs = sinceOverride ? `?since=${encodeURIComponent(sinceOverride)}` : '';
        const res = await api.get<CampaignCatchUp>(`${API}/campaigns/${campaignId}/catch-up${qs}`);
        setData(res);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : t('catchUp.loadFailed'));
      }
    },
    [campaignId, t],
  );

  useEffect(() => {
    if (!Number.isFinite(campaignId)) return;
    void load();
  }, [campaignId, load]);

  // Remember the session-anchored reference so members can reopen that window.
  useEffect(() => {
    if (!data?.lastCaughtUpAt || sessionSince) return;
    void api
      .get<{ since: string | null }>(`${API}/campaigns/${campaignId}/quests/changes`)
      .then((changes) => setSessionSince(changes.since))
      .catch(() => {});
  }, [campaignId, data?.lastCaughtUpAt, sessionSince]);

  useEffect(() => {
    if (!data || dismissed || data.totalCount === 0 || announced.current) return;
    announced.current = true;
    announce(t('catchUp.announceSummary', { count: data.totalCount }), { dedupeKey: `catch-up-${campaignId}` });
  }, [announce, campaignId, data, dismissed, t]);

  const switchPeriod = (mode: PeriodMode) => {
    setPeriod(mode);
    if (mode === 'session' && sessionSince) void load(sessionSince);
    else void load();
  };

  const markCaughtUp = async () => {
    setMarking(true);
    setError(null);
    try {
      await api.post(`${API}/campaigns/${campaignId}/catch-up/mark`, {});
      setDismissed(true);
      setData((current) => (current ? { ...current, totalCount: 0, quests: [], sessions: [], timeline: [], schedules: [] } : current));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('catchUp.markFailed'));
    } finally {
      setMarking(false);
    }
  };

  if (dismissed || !data || data.totalCount === 0) return null;

  const isTodaySince = data.since ? Math.floor((Date.now() - new Date(data.since).getTime()) / (1000 * 60 * 60 * 24)) <= 0 : true;
  // `timeAgo` already returns a COMPLETE relative phrase — "28d ago", "just now", and an
  // absolute date once past 30 days. It used to be wrapped in a `"{{time}} ago"` string,
  // which appended a second suffix to every branch: the dashboard read "since 28d ago
  // ago", and would have read "since just now ago" or "since 8/10/2026 ago" in the other
  // two. Nothing to add here; the helper's output is the whole label.
  const sinceLabel = data.since && !isTodaySince ? timeAgo(data.since) : t('catchUp.today');

  const showSessionToggle =
    sessionSince != null && data.lastCaughtUpAt != null && sessionSince !== data.lastCaughtUpAt;

  return (
    <Card
      className="catch-up-panel"
      role="region"
      aria-labelledby={titleId}
      style={{ borderColor: 'var(--color-accent-700)', background: 'var(--color-surface)' }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <GameIcon slug="campfire" size={UI_ICON_SIZE.lg} reserveSpace />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 id={titleId} className="font-bold text-white" style={{ fontSize: 15, margin: 0 }}>
            {t('catchUp.title')}
          </h2>
          <p className="text-muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
            {t(data.totalCount === 1 ? 'catchUp.summary' : 'catchUp.summary_plural', {
              count: data.totalCount,
              time: sinceLabel,
            })}
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          style={{ minHeight: 44, flexShrink: 0 }}
          onClick={() => void markCaughtUp()}
          disabled={marking}
          aria-busy={marking || undefined}
        >
          {marking ? t('catchUp.marking') : t('catchUp.markCaughtUp')}
        </button>
      </div>

      {showSessionToggle && (
        <div
          role="group"
          aria-label={t('catchUp.title')}
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}
        >
          <button
            type="button"
            className={`btn ${period === 'visit' ? 'btn-primary' : 'btn-ghost'}`}
            style={{ minHeight: 44, fontSize: 12 }}
            aria-pressed={period === 'visit'}
            onClick={() => switchPeriod('visit')}
          >
            {t('catchUp.sinceLastVisit')}
          </button>
          <button
            type="button"
            className={`btn ${period === 'session' ? 'btn-primary' : 'btn-ghost'}`}
            style={{ minHeight: 44, fontSize: 12 }}
            aria-pressed={period === 'session'}
            onClick={() => switchPeriod('session')}
          >
            {t('catchUp.sinceLastSession')}
          </button>
        </div>
      )}

      {error && (
        <div style={{ marginTop: 10 }}>
          <ErrorNote message={error} />
        </div>
      )}

      {data.truncated && (
        <p className="text-muted" style={{ fontSize: 11, margin: '10px 0 0' }}>
          {t('catchUp.truncated', { limit: MAX_SHOWN })}
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
        {data.quests.length > 0 && (
          <section aria-label={t('catchUp.questsHeading')}>
            <h3 className="text-muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, margin: '0 0 6px', textTransform: 'uppercase' }}>
              {t('catchUp.questsHeading')}
            </h3>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {data.quests.map(({ kind, quest }) => (
                <li key={`q-${quest.id}`}>
                  <Link
                    to={entityHref(campaignId, { type: 'quest', id: quest.id })}
                    className="catch-up-link"
                    style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, textDecoration: 'none', color: 'var(--color-text)' }}
                    aria-label={t('catchUp.kindLabel', { kind: kindLabel(t, kind), title: quest.title })}
                  >
                    <span className="tag tag-accent" style={{ fontSize: 10, fontWeight: 700 }}>
                      {kindLabel(t, kind)}
                    </span>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {quest.title}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {data.sessions.length > 0 && (
          <section aria-label={t('catchUp.sessionsHeading')}>
            <h3 className="text-muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, margin: '0 0 6px', textTransform: 'uppercase' }}>
              {t('catchUp.sessionsHeading')}
            </h3>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {data.sessions.map(({ kind, session }) => {
                const title = session.title || t('catchUp.sessionNumber', { number: session.number });
                return (
                  <li key={`s-${session.id}`}>
                    <Link
                      to={entityHref(campaignId, { type: 'session', id: session.id })}
                      className="catch-up-link"
                      style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, textDecoration: 'none', color: 'var(--color-text)' }}
                      aria-label={t('catchUp.kindLabel', { kind: kindLabel(t, kind), title })}
                    >
                      <span className="tag tag-accent" style={{ fontSize: 10, fontWeight: 700 }}>
                        {kindLabel(t, kind)}
                      </span>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {title}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {data.timeline.length > 0 && (
          <section aria-label={t('catchUp.timelineHeading')}>
            <h3 className="text-muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, margin: '0 0 6px', textTransform: 'uppercase' }}>
              {t('catchUp.timelineHeading')}
            </h3>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {data.timeline.map(({ kind, event }) => (
                <li key={`tl-${event.id}`}>
                  <Link
                    to={entityHref(campaignId, { type: 'timeline', id: event.id })}
                    className="catch-up-link"
                    style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, textDecoration: 'none', color: 'var(--color-text)' }}
                    aria-label={t('catchUp.kindLabel', { kind: kindLabel(t, kind), title: event.title })}
                  >
                    <span className="tag tag-accent" style={{ fontSize: 10, fontWeight: 700 }}>
                      {kindLabel(t, kind)}
                    </span>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {event.title}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {data.schedules.length > 0 && (
          <section aria-label={t('catchUp.schedulesHeading')}>
            <h3 className="text-muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, margin: '0 0 6px', textTransform: 'uppercase' }}>
              {t('catchUp.schedulesHeading')}
            </h3>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {data.schedules.map(({ kind, schedule }) => {
                const title = schedule.title || t('catchUp.scheduleAt', { time: formatDateTime(schedule.scheduledAt) });
                return (
                  <li key={`sch-${schedule.id}`}>
                    <Link
                      to={entityHref(campaignId, { type: 'scheduled_session', id: schedule.id })}
                      className="catch-up-link"
                      style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, textDecoration: 'none', color: 'var(--color-text)' }}
                      aria-label={t('catchUp.kindLabel', { kind: kindLabel(t, kind), title })}
                    >
                      <span className="tag tag-accent" style={{ fontSize: 10, fontWeight: 700 }}>
                        {kindLabel(t, kind)}
                      </span>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {title}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </Card>
  );
}
