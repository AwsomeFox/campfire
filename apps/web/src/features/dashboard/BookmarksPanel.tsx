/**
 * Dashboard bookmarks panel (issue #840) — quick access to the member's private
 * bookmarks in this campaign, with one-tap unbookmark. The list is already
 * role-safe: the server drops hidden / deleted / cross-campaign / lost-access
 * targets at read time, so this renders exactly what the member may see.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Bookmark } from '@campfire/schema';
import { ApiError } from '../../lib/api';
import { Card, EmptyState } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';
import { useAnnounce } from '../../components/Announcer';
import { entityHref } from '../../lib/entityLinks';
import { listBookmarks, removeBookmark } from '../../lib/personalNavigation';
import { UI_ICON_SIZE } from '../../lib/uiIcons';

export function BookmarksPanel({ campaignId }: { campaignId: number }) {
  const { t } = useTranslation();
  const titleId = useId();
  const announce = useAnnounce();
  const [items, setItems] = useState<Bookmark[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<number, boolean>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await listBookmarks(campaignId));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('personalNavigation.loadFailed'));
    }
  }, [campaignId, t]);

  useEffect(() => {
    if (Number.isFinite(campaignId)) void load();
  }, [campaignId, load]);

  const remove = async (id: number) => {
    setPending((p) => ({ ...p, [id]: true }));
    try {
      await removeBookmark(id);
      setItems((cur) => (cur ? cur.filter((b) => b.id !== id) : cur));
      announce(t('personalNavigation.removed'));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('personalNavigation.removeFailed'));
    } finally {
      setPending((p) => ({ ...p, [id]: false }));
    }
  };

  return (
    <Card role="region" aria-labelledby={titleId}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <GameIcon slug="campfire" size={UI_ICON_SIZE.md} reserveSpace />
        <h2 id={titleId} className="font-bold text-white" style={{ fontSize: 15, margin: 0 }}>
          {t('personalNavigation.bookmarksTitle')}
        </h2>
      </div>
      {error && <p role="alert" className="text-sm" style={{ color: 'var(--color-danger)' }}>{error}</p>}
      {items && items.length === 0 && <EmptyState title={t('personalNavigation.empty')} />}
      {items && items.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {items.map((b) => (
            <li key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32 }}>
              <Link
                to={entityHref(campaignId, { type: b.entityType, id: b.entityId })}
                className="text-sm"
                style={{ color: 'var(--cf-accent)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={b.label}
              >
                {b.label}
              </Link>
              <button
                type="button"
                className="text-sm"
                style={{ marginLeft: 'auto', color: 'var(--color-text-muted)' }}
                aria-label={t('personalNavigation.remove', { label: b.label })}
                disabled={pending[b.id]}
                onClick={() => void remove(b.id)}
              >
                {t('personalNavigation.removeButton')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
