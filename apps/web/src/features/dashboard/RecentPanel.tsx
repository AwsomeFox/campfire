/**
 * Dashboard recent-history panel (issue #840) — the member's bounded, most-recent
 * views in this campaign, with a clear-history control. As with bookmarks, the
 * list is already role-safe (server drops inaccessible targets at read time).
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { RecentHistoryEntry } from '@campfire/schema';
import { ApiError } from '../../lib/api';
import { Card, EmptyState } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';
import { useAnnounce } from '../../components/Announcer';
import { entityHref } from '../../lib/entityLinks';
import { clearRecent, listRecent } from '../../lib/personalNavigation';
import { UI_ICON_SIZE } from '../../lib/uiIcons';
import { timeAgo, useTimeTick } from '../../lib/format';

export function RecentPanel({ campaignId }: { campaignId: number }) {
  useTimeTick();
  const { t } = useTranslation();
  const titleId = useId();
  const announce = useAnnounce();
  const [items, setItems] = useState<RecentHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await listRecent(campaignId));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('personalNavigation.recentLoadFailed'));
    }
  }, [campaignId, t]);

  useEffect(() => {
    if (Number.isFinite(campaignId)) void load();
  }, [campaignId, load]);

  const clear = async () => {
    setClearing(true);
    try {
      await clearRecent(campaignId);
      setItems([]);
      announce(t('personalNavigation.cleared'));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('personalNavigation.clearFailed'));
    } finally {
      setClearing(false);
    }
  };

  return (
    <Card role="region" aria-labelledby={titleId}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <GameIcon slug="campfire" size={UI_ICON_SIZE.md} reserveSpace />
        <h2 id={titleId} className="font-bold text-white" style={{ fontSize: 15, margin: 0, flex: 1, minWidth: 0 }}>
          {t('personalNavigation.recentTitle')}
        </h2>
        {items && items.length > 0 && (
          <button
            type="button"
            className="text-sm"
            style={{ color: 'var(--color-text-muted)' }}
            disabled={clearing}
            onClick={() => void clear()}
          >
            {t('personalNavigation.clearHistory')}
          </button>
        )}
      </div>
      {error && <p role="alert" className="text-sm" style={{ color: 'var(--color-danger)' }}>{error}</p>}
      {items && items.length === 0 && <EmptyState title={t('personalNavigation.recentEmpty')} />}
      {items && items.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {items.map((entry) => (
            <li key={`${entry.entityType}:${entry.entityId}`} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32 }}>
              <Link
                to={entityHref(campaignId, { type: entry.entityType, id: entry.entityId })}
                className="text-sm"
                style={{ color: 'var(--cf-accent)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={entry.label}
              >
                {entry.label}
              </Link>
              <span className="text-sm" style={{ marginLeft: 'auto', color: 'var(--color-text-muted)', flexShrink: 0 }}>
                {timeAgo(entry.visitedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
