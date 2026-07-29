/**
 * Notification Center Page (issue #550).
 *
 * Full notification management view featuring:
 * - Cursor pagination with "Load More"
 * - Filters: Campaign, Notification Type, Date Range (Start/End), Unread Only
 * - Action distinctions: "Mark displayed read", "Mark campaign read", "Mark all N read"
 * - Confirmation dialogs for actions affecting undisplayed rows or other campaigns
 * - Mark unread / Undo snackbar functionality
 * - Synchronized counts and rows across tabs
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Notification, NotificationType, TimeFormat } from '@campfire/schema';
import { parseScheduleNotificationData } from '@campfire/schema';
import { useCampaigns } from '../../app/CampaignContext';
import { api, API } from '../../lib/api';
import { Btn, Card, ErrorNote, Skeleton } from '../../components/ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { UndoSnackbar } from '../../components/UndoSnackbar';
import { useAnnounce } from '../../components/Announcer';
import { GameIcon } from '../../components/GameIcon';
import { notificationHref } from '../../lib/entityLinks';
import { useFormattingLocale, useTimeFormat } from '../../lib/format';
import { parseCampaignIdParam } from '../../lib/parseCampaignIdParam';
import {
  rememberCancelledScheduleDetail,
  scheduleNotificationDisplayBody,
  scheduleNotificationDisplayTitle,
} from '../../lib/scheduleNotificationCopy';
import { useNotifications } from './NotificationsBell';
import { UI_ICON_SIZE } from '../../lib/uiIcons';

function typeIcon(type: Notification['type']): string {
  switch (type) {
    case 'recap_posted':
    case 'recap_share_enabled':
    case 'recap_share_extended':
      return 'open-book';
    case 'note_reply':
      return 'chat-bubble';
    case 'comment_reply':
      return 'conversation';
    case 'note_shared':
      return 'top-hat';
    case 'added_to_campaign':
      return 'campfire';
    // Issue #1707: campaign_trashed shares the same "you lost access to this campaign"
    // concept as removed_from_campaign, so it reuses its icon (matches the padlock the
    // Layout lost-access screen already uses).
    case 'removed_from_campaign':
    case 'campaign_trashed':
      return 'padlock';
    case 'character_reassigned':
      return 'meeple';
    case 'session_scheduled':
      return 'calendar';
    case 'session_rsvp':
      return 'hand';
    case 'quest_updated':
      return 'scroll-unfurled';
    case 'proposal_submitted':
      return 'quill-ink';
    case 'inbox_submitted':
      return 'envelope';
    case 'proposal_resolved':
      return 'scales';
    case 'ai_dm_alert':
      return 'robot-golem';
    // #599 — the table safety hold. Its own icon, not the AI one: it fires on tables with
    // no AI seat at all.
    case 'safety_hold':
      return 'stop-sign';
    default:
      return 'ringing-bell';
  }
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function notificationCopy(
  notification: Notification,
  locale: string | undefined,
  timeFormat: TimeFormat,
): { title: string; body: string } {
  const scheduleData = parseScheduleNotificationData(notification.data);
  if (scheduleData) {
    return {
      title: scheduleNotificationDisplayTitle(scheduleData, locale, undefined, timeFormat),
      body: scheduleNotificationDisplayBody(scheduleData, locale),
    };
  }
  return { title: notification.title, body: notification.body };
}

const NOTIFICATION_TYPES: { type: NotificationType; label: string }[] = [
  { type: 'recap_posted', label: 'Recap Posted' },
  { type: 'note_reply', label: 'Note Reply' },
  { type: 'note_shared', label: 'Note Shared' },
  { type: 'added_to_campaign', label: 'Added to Campaign' },
  { type: 'removed_from_campaign', label: 'Removed from Campaign' },
  { type: 'campaign_trashed', label: 'Campaign Deleted' },
  { type: 'session_scheduled', label: 'Session Scheduled' },
  { type: 'session_rsvp', label: 'Session RSVP' },
  { type: 'quest_updated', label: 'Quest Updated' },
  { type: 'proposal_submitted', label: 'Proposal Submitted' },
  { type: 'proposal_resolved', label: 'Proposal Resolved' },
  { type: 'inbox_submitted', label: 'Inbox Submitted' },
  { type: 'ai_dm_alert', label: 'AI DM Alert' },
  { type: 'safety_hold', label: 'Table Safety Hold' },
];

export default function NotificationsPage() {
  const params = useParams<{ campaignId?: string }>();
  const campaignIdFromParams = parseCampaignIdParam(params.campaignId);
  const navigate = useNavigate();
  const announce = useAnnounce();
  const formattingLocale = useFormattingLocale();
  const timeFormat = useTimeFormat();
  const { campaigns } = useCampaigns();
  const { count: globalUnreadCount, markReadBulk, markUnreadBulk } = useNotifications();

  // Filters state
  const [selectedCampaignId, setSelectedCampaignId] = useState<string>(
    campaignIdFromParams ? String(campaignIdFromParams) : '',
  );
  const [selectedType, setSelectedType] = useState<string>('');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [unreadOnly, setUnreadOnly] = useState<boolean>(false);

  // List & pagination state
  const [items, setItems] = useState<Notification[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [total, setTotal] = useState<number>(0);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<boolean>(false);

  // Confirmation dialog state
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    title: string;
    body: string;
    confirmLabel: string;
    action: () => Promise<void>;
  } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState<boolean>(false);

  // Undo snackbar state
  const [pendingUndo, setPendingUndo] = useState<{
    message: string;
    ids: number[];
  } | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Sync selectedCampaignId when param changes
  useEffect(() => {
    setSelectedCampaignId(campaignIdFromParams ? String(campaignIdFromParams) : '');
  }, [campaignIdFromParams]);

  const campaignMap = useMemo(() => {
    const map = new Map<number, string>();
    for (const c of campaigns) {
      map.set(c.id, c.name);
    }
    return map;
  }, [campaigns]);

  // Fetch initial page with filters
  const fetchNotifications = useCallback(async (cursor?: number) => {
    if (cursor) {
      setLoadingMore(true);
    } else {
      setLoading(true);
      setLoadError(false);
    }

    try {
      const queryParams = new URLSearchParams();
      queryParams.set('limit', '30');
      if (unreadOnly) queryParams.set('unread', 'true');
      if (selectedCampaignId) queryParams.set('campaignId', selectedCampaignId);
      if (selectedType) queryParams.set('type', selectedType);
      if (startDate) queryParams.set('startDate', startDate);
      if (endDate) queryParams.set('endDate', endDate);
      if (cursor) queryParams.set('cursor', String(cursor));

      const res = await api.get<{
        items: Notification[];
        nextCursor: number | null;
        total: number;
        hasMore: boolean;
      } | Notification[]>(`${API}/notifications?${queryParams.toString()}`);

      if (!mountedRef.current) return;

      if (Array.isArray(res)) {
        if (cursor) {
          setItems((prev) => [...prev, ...res]);
        } else {
          setItems(res);
        }
        setNextCursor(null);
        setHasMore(false);
        setTotal(res.length);
      } else {
        if (cursor) {
          setItems((prev) => [...prev, ...res.items]);
        } else {
          setItems(res.items);
        }
        setNextCursor(res.nextCursor);
        setHasMore(res.hasMore);
        setTotal(res.total);
      }
    } catch {
      if (mountedRef.current && !cursor) {
        setLoadError(true);
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [unreadOnly, selectedCampaignId, selectedType, startDate, endDate]);

  useEffect(() => {
    void fetchNotifications();
  }, [fetchNotifications]);

  const handleLoadMore = () => {
    if (nextCursor && !loadingMore) {
      void fetchNotifications(nextCursor);
    }
  };

  const clearFilters = () => {
    setSelectedCampaignId('');
    setSelectedType('');
    setStartDate('');
    setEndDate('');
    setUnreadOnly(false);
  };

  const hasActiveFilters = Boolean(
    selectedCampaignId || selectedType || startDate || endDate || unreadOnly,
  );

  const displayedUnreadItems = useMemo(
    () => items.filter((n) => !n.readAt),
    [items],
  );

  // Execute a mark-read action and record for Undo
  const executeMarkReadAction = async (
    opts: { ids?: number[]; campaignId?: number; all?: boolean },
    _actionName?: string,
  ) => {
    const res = await markReadBulk(opts);
    if (res.updated > 0) {
      setPendingUndo({
        message: `Marked ${res.updated} notification${res.updated === 1 ? '' : 's'} as read.`,
        ids: res.updatedIds,
      });
      // Refresh current list state
      await fetchNotifications();
    }
  };

  // 1. "Mark displayed read" (Mark these N displayed rows)
  const handleMarkDisplayedRead = async () => {
    const unreadIds = displayedUnreadItems.map((n) => n.id);
    if (unreadIds.length === 0) return;
    await executeMarkReadAction({ ids: unreadIds });
  };

  // 2. "Mark this campaign"
  const handleMarkCampaignRead = () => {
    const cid = selectedCampaignId ? Number(selectedCampaignId) : campaignIdFromParams;
    if (!cid) return;
    const campaignName = campaignMap.get(cid) || `Campaign ${cid}`;
    const campaignUnreadInView = items.filter((n) => n.campaignId === cid && !n.readAt).length;

    // Confirm if action affects undisplayed rows or entire campaign
    const requiresConfirm = hasMore || total > items.length || globalUnreadCount > campaignUnreadInView;

    const run = async () => {
      await executeMarkReadAction({ campaignId: cid }, 'campaign');
    };

    if (requiresConfirm) {
      setConfirmDialog({
        open: true,
        title: `Mark all notifications in "${campaignName}" as read?`,
        body: `This will mark all unread notifications in ${campaignName} as read, including rows not currently displayed on screen.`,
        confirmLabel: 'Mark campaign read',
        action: run,
      });
    } else {
      void run();
    }
  };

  // 3. "Mark all N read"
  const handleMarkAllRead = () => {
    const totalUnreadToMark = globalUnreadCount > 0 ? globalUnreadCount : displayedUnreadItems.length;
    if (totalUnreadToMark === 0) return;

    const isMultiCampaign = campaigns.length > 1;
    const affectsUndisplayed = totalUnreadToMark > displayedUnreadItems.length || hasMore;

    const run = async () => {
      await executeMarkReadAction({ all: true }, 'all');
    };

    if (affectsUndisplayed || isMultiCampaign) {
      setConfirmDialog({
        open: true,
        title: `Mark all ${totalUnreadToMark} notifications as read?`,
        body: `This will mark ${totalUnreadToMark} unread notification${totalUnreadToMark === 1 ? '' : 's'} across all campaigns as read, including rows not currently displayed.`,
        confirmLabel: `Mark all ${totalUnreadToMark} read`,
        action: run,
      });
    } else {
      void run();
    }
  };

  const handleConfirmExecute = async () => {
    if (!confirmDialog) return;
    setConfirmBusy(true);
    try {
      await confirmDialog.action();
    } finally {
      if (mountedRef.current) {
        setConfirmBusy(false);
        setConfirmDialog(null);
      }
    }
  };

  const handleUndo = async () => {
    if (!pendingUndo) return;
    const { ids } = pendingUndo;
    setPendingUndo(null);
    // markUnreadBulk swallows network/server errors and returns
    // { updated: 0, updatedIds: [] } on failure. Announcing "Restored
    // unread status." unconditionally would lie on an offline failure
    // (issue #1534): the rows were never restored. Announce only when the
    // server confirms the write.
    const res = await markUnreadBulk({ ids });
    if (res.updated > 0) {
      announce('Restored unread status.');
    } else {
      announce('Could not restore unread status.');
    }
    await fetchNotifications();
  };

  const handleToggleRead = async (notification: Notification) => {
    if (notification.readAt) {
      await markUnreadBulk({ ids: [notification.id] });
      setItems((prev) =>
        prev.map((n) => (n.id === notification.id ? { ...n, readAt: null } : n)),
      );
    } else {
      await markReadBulk({ ids: [notification.id] });
      setItems((prev) =>
        prev.map((n) =>
          n.id === notification.id ? { ...n, readAt: new Date().toISOString() } : n,
        ),
      );
    }
  };

  const handleRowClick = async (notification: Notification) => {
    const scheduleData = parseScheduleNotificationData(notification.data);
    if (scheduleData?.changeType === 'cancelled') {
      rememberCancelledScheduleDetail(scheduleData);
    }
    const href = notificationHref(notification);
    if (!notification.readAt) {
      await markReadBulk({ ids: [notification.id] });
    }
    navigate(href);
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b pb-4" style={{ borderColor: 'var(--color-divider)' }}>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2" style={{ fontFamily: 'var(--font-heading)' }}>
            <GameIcon slug="ringing-bell" size={26} />
            Notification Center
          </h1>
          <p className="text-xs text-[var(--color-neutral-400)] mt-1">
            Manage, filter, and paginate notifications across all your campaigns.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {globalUnreadCount > 0 && (
            <span className="tag tag-accent text-xs font-semibold px-2.5 py-1">
              {globalUnreadCount} unread total
            </span>
          )}
        </div>
      </div>

      {/* Filter Toolbar */}
      <Card className="p-4 space-y-3">
        <div className="text-xs font-semibold text-[var(--color-neutral-300)] uppercase tracking-wider">
          Filter Notifications
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {/* Campaign Filter */}
          <div>
            <label htmlFor="filter-campaign" className="block text-xs text-[var(--color-neutral-400)] mb-1">
              Campaign
            </label>
            <select
              id="filter-campaign"
              value={selectedCampaignId}
              onChange={(e) => setSelectedCampaignId(e.target.value)}
              className="w-full text-xs input px-2 py-1.5"
            >
              <option value="">All Campaigns</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {/* Type Filter */}
          <div>
            <label htmlFor="filter-type" className="block text-xs text-[var(--color-neutral-400)] mb-1">
              Type
            </label>
            <select
              id="filter-type"
              value={selectedType}
              onChange={(e) => setSelectedType(e.target.value)}
              className="w-full text-xs input px-2 py-1.5"
            >
              <option value="">All Types</option>
              {NOTIFICATION_TYPES.map((t) => (
                <option key={t.type} value={t.type}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          {/* Date Range Start */}
          <div>
            <label htmlFor="filter-start-date" className="block text-xs text-[var(--color-neutral-400)] mb-1">
              From Date
            </label>
            <input
              id="filter-start-date"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-full text-xs input px-2 py-1.5"
            />
          </div>

          {/* Date Range End */}
          <div>
            <label htmlFor="filter-end-date" className="block text-xs text-[var(--color-neutral-400)] mb-1">
              To Date
            </label>
            <input
              id="filter-end-date"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-full text-xs input px-2 py-1.5"
            />
          </div>
        </div>

        <div className="flex items-center justify-between pt-2 border-t" style={{ borderColor: 'var(--color-divider)' }}>
          <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
            <input
              type="checkbox"
              checked={unreadOnly}
              onChange={(e) => setUnreadOnly(e.target.checked)}
              className="rounded accent-[var(--color-accent)]"
            />
            Show unread only
          </label>
          {hasActiveFilters && (
            <Btn ghost style={{ fontSize: 11, minHeight: 28 }} onClick={clearFilters}>
              Clear filters
            </Btn>
          )}
        </div>
      </Card>

      {/* Bulk Action Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <div className="text-xs text-[var(--color-neutral-400)]">
          Showing {items.length} {items.length === 1 ? 'notification' : 'notifications'}
          {total > items.length ? ` of ${total}` : ''}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {displayedUnreadItems.length > 0 && (
            <Btn ghost style={{ fontSize: 12, minHeight: 32 }} onClick={() => void handleMarkDisplayedRead()}>
              Mark displayed ({displayedUnreadItems.length}) read
            </Btn>
          )}
          {(selectedCampaignId || campaignIdFromParams) && (
            <Btn ghost style={{ fontSize: 12, minHeight: 32 }} onClick={handleMarkCampaignRead}>
              Mark this campaign read
            </Btn>
          )}
          {globalUnreadCount > 0 && (
            <Btn ghost style={{ fontSize: 12, minHeight: 32 }} onClick={handleMarkAllRead}>
              Mark all ({globalUnreadCount}) read
            </Btn>
          )}
        </div>
      </div>

      {/* Notifications List */}
      <div className="space-y-2">
        {loading && (
          <Card className="p-4">
            <Skeleton lines={5} />
          </Card>
        )}

        {loadError && (
          <Card className="p-4">
            <ErrorNote message="Couldn't load notifications." onRetry={() => void fetchNotifications()} />
          </Card>
        )}

        {!loading && !loadError && items.length === 0 && (
          <Card className="p-8 text-center space-y-2 border-dashed">
            <p className="flex justify-center text-[var(--color-neutral-500)]">
              <GameIcon slug="ringing-bell" size={32} reserveSpace />
            </p>
            <p className="text-base font-semibold text-[var(--color-neutral-300)]">
              {hasActiveFilters ? 'No notifications match your filters' : 'No notifications yet'}
            </p>
            <p className="text-xs text-[var(--color-neutral-400)] max-w-sm mx-auto">
              {hasActiveFilters
                ? 'Try adjusting or clearing your campaign, type, date, or unread filters.'
                : 'Session recaps, note replies, quest updates, and session invites will appear here.'}
            </p>
            {hasActiveFilters && (
              <div className="pt-2">
                <Btn ghost style={{ fontSize: 12 }} onClick={clearFilters}>
                  Clear all filters
                </Btn>
              </div>
            )}
          </Card>
        )}

        {items.map((notification) => {
          const copy = notificationCopy(notification, formattingLocale, timeFormat);
          const campaignName = campaignMap.get(notification.campaignId);
          const isRead = Boolean(notification.readAt);

          return (
            <Card
              key={notification.id}
              className={`p-3 transition-colors flex items-start gap-3 min-h-[52px] ${
                isRead
                  ? 'opacity-85'
                  : 'border-l-4'
              }`}
              style={{
                borderColor: isRead ? 'var(--color-divider)' : 'var(--color-accent)',
                background: isRead
                  ? 'transparent'
                  : 'color-mix(in srgb, var(--color-accent) 6%, transparent)',
              }}
            >
              {/* Type Icon */}
              <span className="flex leading-none pt-1 text-[var(--color-neutral-300)] shrink-0">
                <GameIcon slug={typeIcon(notification.type)} size={UI_ICON_SIZE.md} />
              </span>

              {/* Main Info */}
              <div
                className="min-w-0 flex-1 cursor-pointer select-none outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] rounded"
                role="button"
                tabIndex={0}
                onClick={() => void handleRowClick(notification)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    void handleRowClick(notification);
                  }
                }}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  {campaignName && (
                    <span className="tag tag-neutral" style={{ fontSize: 9 }}>
                      {campaignName}
                    </span>
                  )}
                  {notification.type === 'ai_dm_alert' && (
                    <span className="tag tag-accent" style={{ fontSize: 9 }}>
                      AI DM
                    </span>
                  )}
                  <span
                    className="text-sm leading-snug"
                    style={{
                      color: 'var(--color-text)',
                      fontWeight: isRead ? 400 : 600,
                    }}
                  >
                    {copy.title}
                  </span>
                </div>
                {copy.body && (
                  <p className="text-xs mt-0.5 line-clamp-2" style={{ color: 'var(--color-neutral-400)' }}>
                    {copy.body}
                  </p>
                )}
                <div className="flex items-center gap-3 text-[11px] mt-1.5" style={{ color: 'var(--color-neutral-400)' }}>
                  <span>{timeAgo(notification.createdAt)}</span>
                  {notification.actorName && (
                    <span>By {notification.actorName}</span>
                  )}
                </div>
              </div>

              {/* Mark Read/Unread Toggle Button */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleToggleRead(notification);
                }}
                className="shrink-0 text-xs px-2.5 py-1 rounded border min-h-[32px] self-center"
                style={{
                  borderColor: 'var(--color-divider)',
                  color: isRead ? 'var(--color-neutral-400)' : 'var(--color-accent)',
                  background: 'transparent',
                }}
                aria-label={isRead ? 'Mark as unread' : 'Mark as read'}
                title={isRead ? 'Mark as unread' : 'Mark as read'}
              >
                {isRead ? 'Mark unread' : 'Mark read'}
              </button>
            </Card>
          );
        })}
      </div>

      {/* Pagination Load More Button */}
      {hasMore && (
        <div className="text-center pt-2">
          <Btn
            onClick={handleLoadMore}
            disabled={loadingMore}
            style={{ fontSize: 13, minHeight: 38 }}
          >
            {loadingMore ? 'Loading more…' : 'Load more notifications'}
          </Btn>
        </div>
      )}

      {/* Confirmation Dialog */}
      {confirmDialog?.open && (
        <ConfirmDialog
          title={confirmDialog.title}
          body={confirmDialog.body}
          confirmLabel={confirmDialog.confirmLabel}
          busy={confirmBusy}
          onConfirm={() => void handleConfirmExecute()}
          onCancel={() => setConfirmDialog(null)}
        />
      )}

      {/* Undo Snackbar */}
      {pendingUndo && (
        <UndoSnackbar
          message={pendingUndo.message}
          onUndo={handleUndo}
          onExpire={() => setPendingUndo(null)}
          successMessage="Restored notifications as unread."
        />
      )}
    </div>
  );
}
