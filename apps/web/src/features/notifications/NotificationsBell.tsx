/**
 * Shared notification controller + responsive bell renderer (issues #11, #802).
 *
 * The provider owns the only poller, panel, and request state. Layout may move the
 * passive bell renderer between desktop/mobile chrome without restarting polling
 * or losing an open panel. Polling stops while this document is hidden/offline,
 * and count snapshots/read mutations are shared with same-user tabs.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { Notification, TimeFormat } from '@campfire/schema';
import { parseScheduleNotificationData } from '@campfire/schema';
import { useAuth } from '../../app/auth';
import { api, API } from '../../lib/api';
import { Btn, ErrorNote, Skeleton } from '../../components/ui';
import { useAnnounce } from '../../components/Announcer';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { GameIcon } from '../../components/GameIcon';
import { UndoSnackbar } from '../../components/UndoSnackbar';
import { useDialog } from '../../components/useDialog';
import { notificationHref } from '../../lib/entityLinks';
import { parseCampaignIdParam } from '../../lib/parseCampaignIdParam';
import { useFormattingLocale, useTimeFormat } from '../../lib/format';
import {
  rememberCancelledScheduleDetail,
  scheduleNotificationDisplayBody,
  scheduleNotificationDisplayTitle,
} from '../../lib/scheduleNotificationCopy';

/**
 * Reports whether the viewport is below the desktop breakpoint (768px), so the
 * notifications panel can switch from a top-right desktop flyout to a
 * thumb-reachable bottom sheet on phones (issue #664). Matches the
 * `(min-width: 768px)` query Layout.tsx uses to gate the bell renderer.
 */
function useIsNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia('(max-width: 767px)');
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches);
    setNarrow(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

const POLL_MS = 60_000;
const NOTIFICATIONS_DIALOG_ID = 'notifications-dialog';
const NOTIFICATIONS_COUNT_ID = 'notifications-dialog-item-count';

type CountSnapshot = {
  count: number;
  refreshedAt: number;
};

type NotificationSyncMessage =
  | { type: 'snapshot'; snapshot: CountSnapshot }
  | { type: 'read'; id: number; readAt: string }
  | { type: 'unread'; id: number }
  | { type: 'read-bulk'; ids: number[]; readAt: string }
  | { type: 'unread-bulk'; ids: number[] }
  | { type: 'read-all'; readAt: string };

export type BulkMarkResult = {
  updated: number;
  updatedIds: number[];
};

type NotificationContextValue = {
  count: number;
  open: boolean;
  items: Notification[] | null;
  loadError: boolean;
  togglePanel(): void;
  closePanel(): void;
  retryLoadItems(): void;
  markRead(notification: Notification): Promise<void>;
  markUnread(notification: Notification): Promise<void>;
  markReadBulk(opts: { ids?: number[]; campaignId?: number; all?: boolean }): Promise<BulkMarkResult>;
  markUnreadBulk(opts: { ids?: number[]; campaignId?: number; all?: boolean }): Promise<BulkMarkResult>;
  markAllRead(): Promise<boolean>;
  refreshCount(force?: boolean): Promise<void>;
};

const NotificationContext = createContext<NotificationContextValue | null>(null);

export function useNotifications(): NotificationContextValue {
  const value = useContext(NotificationContext);
  if (!value) throw new Error('Notifications must be rendered inside NotificationsProvider');
  return value;
}

function isDocumentActive(): boolean {
  return !document.hidden && navigator.onLine;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function parseSnapshot(value: string | null): CountSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CountSnapshot>;
    if (
      typeof parsed.count === 'number'
      && Number.isInteger(parsed.count)
      && parsed.count >= 0
      && typeof parsed.refreshedAt === 'number'
      && Number.isFinite(parsed.refreshedAt)
    ) {
      return { count: parsed.count, refreshedAt: parsed.refreshedAt };
    }
  } catch {
    /* malformed/blocked storage is just an empty cache */
  }
  return null;
}

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
    case 'character_reassigned':
      return 'meeple';
    case 'session_scheduled':
    case 'session_reminder':
      return 'calendar';
    case 'session_rsvp':
    case 'rsvp_nudge':
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

function BellIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 4a5 5 0 0 0-5 5v3.2c0 .6-.2 1.2-.6 1.7L5 16h14l-1.4-2.1a3 3 0 0 1-.6-1.7V9a5 5 0 0 0-5-5zM10 19a2 2 0 0 0 4 0"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const userId = me?.user.id;
  const location = useLocation();
  const navigate = useNavigate();
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const announce = useAnnounce();

  const mountedRef = useRef(false);
  const initializedRef = useRef(false);
  const openRef = useRef(false);
  const countRef = useRef(0);
  const latestSnapshotRef = useRef<CountSnapshot | null>(null);
  const snapshotVersionRef = useRef(0);
  const readAtByIdRef = useRef(new Map<number, string>());
  const allReadAtRef = useRef<string | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const countGenerationRef = useRef(0);
  const listGenerationRef = useRef(0);
  const countRequestRef = useRef<{ controller: AbortController; promise: Promise<void>; generation: number } | null>(null);
  const listRequestRef = useRef<{ controller: AbortController; generation: number } | null>(null);
  const previousPathRef = useRef(location.pathname);

  const storageKey = userId === undefined ? null : `campfire.notifications.count.${userId}`;
  const lockName = userId === undefined ? null : `campfire.notifications.poll.${userId}`;
  const channelName = userId === undefined ? null : `campfire.notifications.sync.${userId}`;

  const applyCount = useCallback((next: number) => {
    const safe = Math.max(0, Math.trunc(next));
    countRef.current = safe;
    if (mountedRef.current) setCount(safe);
  }, []);

  const readStoredSnapshot = useCallback((): CountSnapshot | null => {
    if (!storageKey) return null;
    try {
      return parseSnapshot(localStorage.getItem(storageKey));
    } catch {
      return null;
    }
  }, [storageKey]);

  const applySnapshot = useCallback((snapshot: CountSnapshot) => {
    if ((latestSnapshotRef.current?.refreshedAt ?? 0) > snapshot.refreshedAt) return;
    latestSnapshotRef.current = snapshot;
    snapshotVersionRef.current += 1;
    applyCount(snapshot.count);
  }, [applyCount]);

  const publishSnapshot = useCallback((snapshot: CountSnapshot) => {
    latestSnapshotRef.current = snapshot;
    snapshotVersionRef.current += 1;
    applyCount(snapshot.count);
    if (storageKey) {
      try {
        localStorage.setItem(storageKey, JSON.stringify(snapshot));
      } catch {
        /* storage may be unavailable; BroadcastChannel still handles live tabs */
      }
    }
    channelRef.current?.postMessage({ type: 'snapshot', snapshot } satisfies NotificationSyncMessage);
  }, [applyCount, storageKey]);

  const cancelCountRequest = useCallback(() => {
    countGenerationRef.current += 1;
    countRequestRef.current?.controller.abort();
    countRequestRef.current = null;
  }, []);

  const cancelListRequest = useCallback(() => {
    listGenerationRef.current += 1;
    listRequestRef.current?.controller.abort();
    listRequestRef.current = null;
  }, []);

  const refreshCount = useCallback((force = false): Promise<void> => {
    if (userId === undefined || !storageKey || !lockName || !isDocumentActive()) return Promise.resolve();
    if (countRequestRef.current) {
      if (!force) return countRequestRef.current.promise;
      cancelCountRequest();
    }

    const stored = readStoredSnapshot();
    if (!force && stored && Date.now() - stored.refreshedAt < POLL_MS) {
      applySnapshot(stored);
      return Promise.resolve();
    }

    const controller = new AbortController();
    const generation = ++countGenerationRef.current;

    const load = async () => {
      if (!isDocumentActive()) return;
      const res = await api.get<{ count: number }>(`${API}/notifications/unread-count`, {
        signal: controller.signal,
      });
      if (countGenerationRef.current !== generation) {
        return;
      }
      if (allReadAtRef.current !== null) {
        publishSnapshot({ count: 0, refreshedAt: Date.now() });
        return;
      }
      publishSnapshot({ count: res.count, refreshedAt: Date.now() });
    };

    const run = async () => {
      try {
        if (navigator.locks) {
          await navigator.locks.request(lockName, { ifAvailable: true }, async (lock) => {
            if (!lock) return;
            const newer = readStoredSnapshot();
            if (!force && newer && Date.now() - newer.refreshedAt < POLL_MS) {
              applySnapshot(newer);
              return;
            }
            await load();
          });
        } else {
          await load();
        }
      } catch (error) {
        if (!isAbortError(error)) {
          /* badge is best-effort */
        }
      } finally {
        if (countRequestRef.current?.generation === generation) countRequestRef.current = null;
      }
    };

    const promise = run();
    countRequestRef.current = { controller, promise, generation };
    return promise;
  }, [applySnapshot, lockName, publishSnapshot, readStoredSnapshot, storageKey, userId]);

  const loadItems = useCallback(() => {
    if (userId === undefined || !isDocumentActive()) return;
    cancelListRequest();
    const controller = new AbortController();
    const generation = ++listGenerationRef.current;
    listRequestRef.current = { controller, generation };
    setItems(null);
    setLoadError(false);
    void api.get<{ items: Notification[] } | Notification[]>(`${API}/notifications?limit=30`, { signal: controller.signal })
      .then((res) => {
        const nextItems = Array.isArray(res) ? res : res.items;
        if (
          mountedRef.current
          && openRef.current
          && !controller.signal.aborted
          && generation === listGenerationRef.current
        ) {
          setItems(nextItems.map((item) => {
            if (item.readAt) return item;
            const knownReadAt = readAtByIdRef.current.get(item.id) ?? allReadAtRef.current;
            return knownReadAt ? { ...item, readAt: knownReadAt } : item;
          }));
        }
      })
      .catch((error: unknown) => {
        if (
          !isAbortError(error)
          && mountedRef.current
          && openRef.current
          && generation === listGenerationRef.current
        ) {
          setLoadError(true);
        }
      })
      .finally(() => {
        if (listRequestRef.current?.generation === generation) listRequestRef.current = null;
      });
  }, [cancelListRequest, userId]);

  const closePanel = useCallback(() => {
    openRef.current = false;
    setOpen(false);
    cancelListRequest();
  }, [cancelListRequest]);

  const togglePanel = useCallback(() => {
    if (openRef.current) {
      closePanel();
      return;
    }
    openRef.current = true;
    setOpen(true);
    loadItems();
  }, [closePanel, loadItems]);

  const syncReadMessage = useCallback((message: NotificationSyncMessage) => {
    if (!mountedRef.current) return;
    if (message.type === 'read') {
      readAtByIdRef.current.set(message.id, message.readAt);
      setItems((previous) => previous?.map((item) => (
        item.id === message.id && !item.readAt ? { ...item, readAt: message.readAt } : item
      )) ?? previous);
    } else if (message.type === 'unread') {
      readAtByIdRef.current.delete(message.id);
      setItems((previous) => previous?.map((item) => (
        item.id === message.id ? { ...item, readAt: null } : item
      )) ?? previous);
    } else if (message.type === 'read-bulk') {
      const idSet = new Set(message.ids);
      idSet.forEach((id) => readAtByIdRef.current.set(id, message.readAt));
      setItems((previous) => previous?.map((item) => (
        idSet.has(item.id) && !item.readAt ? { ...item, readAt: message.readAt } : item
      )) ?? previous);
    } else if (message.type === 'unread-bulk') {
      const idSet = new Set(message.ids);
      idSet.forEach((id) => readAtByIdRef.current.delete(id));
      setItems((previous) => previous?.map((item) => (
        idSet.has(item.id) ? { ...item, readAt: null } : item
      )) ?? previous);
    } else if (message.type === 'read-all') {
      allReadAtRef.current = message.readAt;
      setItems((previous) => previous?.map((item) => (
        item.readAt ? item : { ...item, readAt: message.readAt }
      )) ?? previous);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    initializedRef.current = false;
    openRef.current = false;
    setOpen(false);
    setItems(null);
    setLoadError(false);
    latestSnapshotRef.current = null;
    snapshotVersionRef.current = 0;
    readAtByIdRef.current.clear();
    allReadAtRef.current = null;
    applyCount(0);

    if (userId === undefined || !storageKey || !channelName) {
      return () => {
        mountedRef.current = false;
      };
    }

    const stored = readStoredSnapshot();
    if (stored) applySnapshot(stored);

    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(channelName);
    channelRef.current = channel;
    const onMessage = (event: MessageEvent<NotificationSyncMessage>) => {
      const message = event.data;
      if (message.type === 'snapshot') applySnapshot(message.snapshot);
      else syncReadMessage(message);
    };
    channel?.addEventListener('message', onMessage);

    const onStorage = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      const snapshot = parseSnapshot(event.newValue);
      if (snapshot) applySnapshot(snapshot);
    };
    window.addEventListener('storage', onStorage);

    let interval: number | null = null;
    let active = isDocumentActive();
    const stopInterval = () => {
      if (interval !== null) window.clearInterval(interval);
      interval = null;
    };
    const startInterval = () => {
      stopInterval();
      interval = window.setInterval(() => void refreshCount(), POLL_MS);
    };

    const initialTimer = window.setTimeout(() => {
      initializedRef.current = true;
      active = isDocumentActive();
      if (active) {
        void refreshCount();
        startInterval();
      }
    }, 0);

    const onActivityChange = () => {
      const nextActive = isDocumentActive();
      if (nextActive === active) return;
      active = nextActive;
      if (!nextActive) {
        stopInterval();
        cancelCountRequest();
        cancelListRequest();
        return;
      }
      void refreshCount(true);
      if (openRef.current) loadItems();
      startInterval();
    };

    document.addEventListener('visibilitychange', onActivityChange);
    window.addEventListener('online', onActivityChange);
    window.addEventListener('offline', onActivityChange);

    return () => {
      mountedRef.current = false;
      initializedRef.current = false;
      window.clearTimeout(initialTimer);
      stopInterval();
      cancelCountRequest();
      cancelListRequest();
      document.removeEventListener('visibilitychange', onActivityChange);
      window.removeEventListener('online', onActivityChange);
      window.removeEventListener('offline', onActivityChange);
      window.removeEventListener('storage', onStorage);
      channel?.removeEventListener('message', onMessage);
      channel?.close();
      if (channelRef.current === channel) channelRef.current = null;
    };
  }, [
    applyCount,
    applySnapshot,
    cancelCountRequest,
    cancelListRequest,
    channelName,
    loadItems,
    readStoredSnapshot,
    refreshCount,
    storageKey,
    syncReadMessage,
    userId,
  ]);

  useEffect(() => {
    if (previousPathRef.current === location.pathname) return;
    previousPathRef.current = location.pathname;
    if (initializedRef.current) void refreshCount(true);
  }, [location.pathname, refreshCount]);

  const markRead = useCallback(async (notification: Notification) => {
    closePanel();
    const scheduleData = parseScheduleNotificationData(notification.data);
    if (scheduleData?.changeType === 'cancelled') {
      rememberCancelledScheduleDetail(scheduleData);
    }
    const href = notificationHref(notification);
    navigate(href);
    if (!notification.readAt) {
      try {
        await api.post(`${API}/notifications/${notification.id}/read`);
        cancelCountRequest();
        const readAt = new Date().toISOString();
        syncReadMessage({ type: 'read', id: notification.id, readAt });
        channelRef.current?.postMessage({ type: 'read', id: notification.id, readAt } satisfies NotificationSyncMessage);
        publishSnapshot({ count: Math.max(0, countRef.current - 1), refreshedAt: Date.now() });
      } catch {
        announce("Couldn't mark notification as read.", { assertive: true });
      }
      void refreshCount(true);
    }
  }, [announce, cancelCountRequest, closePanel, navigate, publishSnapshot, refreshCount, syncReadMessage]);

  const markUnread = useCallback(async (notification: Notification) => {
    if (notification.readAt) {
      try {
        await api.post(`${API}/notifications/${notification.id}/unread`);
        allReadAtRef.current = null;
        cancelCountRequest();
        syncReadMessage({ type: 'unread', id: notification.id });
        channelRef.current?.postMessage({ type: 'unread', id: notification.id } satisfies NotificationSyncMessage);
        publishSnapshot({ count: countRef.current + 1, refreshedAt: Date.now() });
      } catch {
        announce("Couldn't mark notification as unread.", { assertive: true });
      }
      void refreshCount(true);
    }
  }, [announce, cancelCountRequest, publishSnapshot, refreshCount, syncReadMessage]);

  const markReadBulk = useCallback(async (opts: { ids?: number[]; campaignId?: number; all?: boolean }): Promise<BulkMarkResult> => {
    try {
      const res = await api.post<BulkMarkResult>(`${API}/notifications/mark-read`, opts);
      cancelCountRequest();
      const readAt = new Date().toISOString();
      if (opts.all) {
        syncReadMessage({ type: 'read-all', readAt });
        channelRef.current?.postMessage({ type: 'read-all', readAt } satisfies NotificationSyncMessage);
        publishSnapshot({ count: 0, refreshedAt: Date.now() });
      } else {
        syncReadMessage({ type: 'read-bulk', ids: res.updatedIds, readAt });
        channelRef.current?.postMessage({ type: 'read-bulk', ids: res.updatedIds, readAt } satisfies NotificationSyncMessage);
        publishSnapshot({ count: Math.max(0, countRef.current - res.updated), refreshedAt: Date.now() });
      }
      void refreshCount(true);
      return res;
    } catch {
      return { updated: 0, updatedIds: [] };
    }
  }, [cancelCountRequest, publishSnapshot, refreshCount, syncReadMessage]);

  const markUnreadBulk = useCallback(async (opts: { ids?: number[]; campaignId?: number; all?: boolean }): Promise<BulkMarkResult> => {
    try {
      const res = await api.post<BulkMarkResult>(`${API}/notifications/mark-unread`, opts);
      allReadAtRef.current = null;
      cancelCountRequest();
      syncReadMessage({ type: 'unread-bulk', ids: res.updatedIds });
      channelRef.current?.postMessage({ type: 'unread-bulk', ids: res.updatedIds } satisfies NotificationSyncMessage);
      publishSnapshot({ count: countRef.current + res.updated, refreshedAt: Date.now() });
      void refreshCount(true);
      return res;
    } catch {
      return { updated: 0, updatedIds: [] };
    }
  }, [cancelCountRequest, publishSnapshot, refreshCount, syncReadMessage]);

  const markAllRead = useCallback(async (): Promise<boolean> => {
    try {
      const res = await api.post<BulkMarkResult>(`${API}/notifications/read-all`);
      const readAt = new Date().toISOString();
      cancelCountRequest();
      allReadAtRef.current = readAt;
      applyCount(0);
      const updatedIds = res.updatedIds ?? [];
      if (updatedIds.length > 0) {
        syncReadMessage({ type: 'read-bulk', ids: updatedIds, readAt });
        channelRef.current?.postMessage({ type: 'read-bulk', ids: updatedIds, readAt } satisfies NotificationSyncMessage);
      } else {
        syncReadMessage({ type: 'read-all', readAt });
        channelRef.current?.postMessage({ type: 'read-all', readAt } satisfies NotificationSyncMessage);
      }
      publishSnapshot({ count: 0, refreshedAt: Date.now() });
      return true;
    } catch {
      return false;
    }
  }, [applyCount, cancelCountRequest, publishSnapshot, syncReadMessage]);

  const value: NotificationContextValue = {
    count,
    open,
    items,
    loadError,
    togglePanel,
    closePanel,
    retryLoadItems: loadItems,
    markRead,
    markUnread,
    markReadBulk,
    markUnreadBulk,
    markAllRead,
    refreshCount,
  };

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}

/** Passive trigger. Layout renders exactly one at the active breakpoint. */
export function NotificationsBell() {
  const { count, open, togglePanel } = useNotifications();
  return (
    <button
      type="button"
      aria-label={count > 0 ? `Notifications (${count} unread)` : 'Notifications'}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? NOTIFICATIONS_DIALOG_ID : undefined}
      onClick={togglePanel}
      className="relative flex items-center justify-center h-8 w-8 rounded-full"
      style={{ color: 'var(--color-neutral-300)', border: '1px solid var(--color-divider)' }}
    >
      <BellIcon />
      {count > 0 && (
        <span
          className="absolute -top-1 -right-1 flex items-center justify-center rounded-full font-bold"
          style={{
            minWidth: 15,
            height: 15,
            padding: '0 3px',
            fontSize: 9,
            background: 'var(--color-accent)',
            color: '#fff',
          }}
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );
}

/** The single panel instance remains mounted in the shared layout controller. */
export function NotificationsPanel() {
  const notifications = useNotifications();
  if (!notifications.open) return null;
  return <OpenNotificationsPanel notifications={notifications} />;
}

function CloseButton({ onClose, label }: { onClose: () => void; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClose}
      className="shrink-0 flex items-center justify-center rounded-md"
      style={{
        width: 36,
        height: 36,
        color: 'var(--color-text)',
        fontSize: 18,
        lineHeight: 1,
        border: '1px solid var(--color-divider)',
      }}
    >
      ✕
    </button>
  );
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

function OpenNotificationsPanel({ notifications }: { notifications: NotificationContextValue }) {
  const {
    count,
    items,
    loadError,
    closePanel,
    retryLoadItems,
    markRead,
    markReadBulk,
    markUnreadBulk,
  } = notifications;
  const formattingLocale = useFormattingLocale();
  const timeFormat = useTimeFormat();
  const narrow = useIsNarrowViewport();
  const navigate = useNavigate();
  const location = useLocation();
  const [markAllAnnouncement, setMarkAllAnnouncement] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    body: string;
    confirmLabel: string;
    action: () => Promise<void>;
  } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [pendingUndo, setPendingUndo] = useState<{ message: string; ids: number[] } | null>(null);
  const markDisplayedRef = useRef<HTMLButtonElement>(null);
  const initialActionFocusRef = useRef(false);

  const panelMountedRef = useRef(true);
  useEffect(() => {
    panelMountedRef.current = true;
    return () => {
      panelMountedRef.current = false;
    };
  }, []);

  const dialogRef = useDialog<HTMLDivElement>({ onClose: closePanel, inertBackground: true });

  const campaignIdFromRoute = useMemo(() => {
    const match = /^\/c\/(\d+)/.exec(location.pathname);
    return parseCampaignIdParam(match?.[1]);
  }, [location.pathname]);

  const displayedUnreadItems = useMemo(
    () => (items ?? []).filter((notification) => !notification.readAt),
    [items],
  );

  useEffect(() => {
    if (initialActionFocusRef.current || items === null || displayedUnreadItems.length === 0) return;
    markDisplayedRef.current?.focus();
    initialActionFocusRef.current = true;
  }, [displayedUnreadItems.length, items]);

  const listDescription =
    items === null
      ? loadError
        ? 'Notification list unavailable.'
        : 'Loading items.'
      : `${items.length} ${items.length === 1 ? 'item' : 'items'}.`;
  const statusAnnouncement = markAllAnnouncement ?? listDescription;

  const recordMarkRead = useCallback(async (
    opts: { ids?: number[]; campaignId?: number; all?: boolean },
    successMessage: string | ((res: BulkMarkResult) => string),
    failureMessage: string,
  ) => {
    const res = await markReadBulk(opts);
    if (!panelMountedRef.current) return;
    if (res.updated > 0) {
      setMarkAllAnnouncement(typeof successMessage === 'function' ? successMessage(res) : successMessage);
      setPendingUndo({
        message: `Marked ${res.updated} notification${res.updated === 1 ? '' : 's'} as read.`,
        ids: res.updatedIds,
      });
    } else {
      setMarkAllAnnouncement(failureMessage);
    }
  }, [markReadBulk]);

  const handleMarkDisplayedRead = useCallback(async () => {
    const unreadIds = displayedUnreadItems.map((notification) => notification.id);
    if (unreadIds.length === 0) return;
    await recordMarkRead(
      { ids: unreadIds },
      (res) => `Marked ${res.updated} displayed notification${res.updated === 1 ? '' : 's'} as read.`,
      "Couldn't mark displayed notifications as read.",
    );
  }, [displayedUnreadItems, recordMarkRead]);

  const handleMarkCampaignRead = useCallback(() => {
    if (!campaignIdFromRoute) return;
    const campaignUnreadInView = displayedUnreadItems.filter(
      (notification) => notification.campaignId === campaignIdFromRoute,
    ).length;
    const requiresConfirm = items !== null && items.length >= 30 && campaignUnreadInView > 0;

    const run = async () => {
      await recordMarkRead(
        { campaignId: campaignIdFromRoute },
        'Marked campaign notifications as read.',
        "Couldn't mark campaign notifications as read.",
      );
    };

    if (requiresConfirm) {
      setConfirmDialog({
        title: 'Mark all notifications in this campaign as read?',
        body: 'This will mark every unread notification in the current campaign as read, including rows not shown in this panel.',
        confirmLabel: 'Mark campaign read',
        action: run,
      });
    } else {
      void run();
    }
  }, [campaignIdFromRoute, displayedUnreadItems, items, recordMarkRead]);

  const handleMarkAllRead = useCallback(() => {
    if (count === 0) return;
    const affectsUndisplayed = count > displayedUnreadItems.length;

    const run = async () => {
      await recordMarkRead(
        { all: true },
        'All notifications marked as read.',
        "Couldn't mark all notifications as read.",
      );
    };

    if (affectsUndisplayed) {
      setConfirmDialog({
        title: `Mark all ${count} notifications as read?`,
        body: `This will mark ${count} unread notification${count === 1 ? '' : 's'} across all campaigns as read, including rows not currently displayed.`,
        confirmLabel: `Mark all ${count} read`,
        action: run,
      });
    } else {
      void run();
    }
  }, [count, displayedUnreadItems.length, recordMarkRead]);

  const handleConfirmExecute = useCallback(async () => {
    if (!confirmDialog) return;
    setConfirmBusy(true);
    try {
      await confirmDialog.action();
    } finally {
      if (panelMountedRef.current) {
        setConfirmBusy(false);
        setConfirmDialog(null);
      }
    }
  }, [confirmDialog]);

  const handleUndo = useCallback(async () => {
    if (!pendingUndo) return;
    const { ids } = pendingUndo;
    const res = await markUnreadBulk({ ids });
    if (!panelMountedRef.current) return;
    if (res.updated > 0) {
      setPendingUndo(null);
    } else {
      throw new Error('Restore failed');
    }
  }, [markUnreadBulk, pendingUndo]);

  const handleViewAllCenter = useCallback(() => {
    closePanel();
    navigate(campaignIdFromRoute ? `/c/${campaignIdFromRoute}/notifications` : '/notifications');
  }, [campaignIdFromRoute, closePanel, navigate]);

  const rootClassName = narrow
    ? 'fixed inset-0 flex items-end justify-center'
    : 'fixed inset-0';
  const rootStyle = {
    zIndex: 'var(--cf-layer-notification)' as const,
    background: narrow
      ? 'color-mix(in srgb, var(--color-neutral-900) 55%, transparent)'
      : 'color-mix(in srgb, var(--color-neutral-900) 35%, transparent)',
  };

  const panelClassName = narrow
    ? 'cf-card elev-lg w-full flex flex-col'
    : 'cf-card elev-lg fixed flex flex-col';
  const panelStyle: CSSProperties = narrow
    ? {
        maxWidth: 440,
        maxHeight: 'calc(100dvh - 16px)',
        borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0',
        padding: 0,
        paddingBottom: 'env(safe-area-inset-bottom)',
        overflow: 'hidden',
      }
    : {
        top: 12,
        right: 12,
        width: 'min(380px, calc(100vw - 24px))',
        maxHeight: 'min(520px, calc(100vh - 24px))',
        padding: 0,
        overflow: 'hidden',
      };

  return (
    <div className={rootClassName} style={rootStyle} onClick={closePanel}>
      <div
        id={NOTIFICATIONS_DIALOG_ID}
        ref={dialogRef}
        className={panelClassName}
        role="dialog"
        aria-modal="true"
        aria-label="Notifications"
        aria-describedby={NOTIFICATIONS_COUNT_ID}
        style={panelStyle}
        onClick={(event) => event.stopPropagation()}
      >
        {narrow && (
          <div
            aria-hidden="true"
            className="mx-auto mt-2.5 mb-1 shrink-0"
            style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--color-neutral-700)' }}
          />
        )}
        <div
          className="flex items-center gap-2 px-4 py-3 border-b shrink-0"
          style={{ borderColor: 'var(--color-divider)' }}
        >
          <span className="text-sm font-semibold" style={{ fontFamily: 'var(--font-heading)' }}>
            Notifications
          </span>
          <span id={NOTIFICATIONS_COUNT_ID} className="sr-only">
            {listDescription}
          </span>
          <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {statusAnnouncement}
          </span>
          <div className="flex-1" />
          {displayedUnreadItems.length > 0 && (
            <Btn
              ref={markDisplayedRef}
              ghost
              style={{ fontSize: 11, minHeight: 32 }}
              onClick={() => void handleMarkDisplayedRead()}
            >
              Mark displayed ({displayedUnreadItems.length}) read
            </Btn>
          )}
          {campaignIdFromRoute && displayedUnreadItems.some((n) => n.campaignId === campaignIdFromRoute) && (
            <Btn ghost style={{ fontSize: 11, minHeight: 32 }} onClick={handleMarkCampaignRead}>
              Mark campaign read
            </Btn>
          )}
          {count > displayedUnreadItems.length && (
            <Btn ghost style={{ fontSize: 11, minHeight: 32 }} onClick={handleMarkAllRead}>
              Mark all ({count}) read
            </Btn>
          )}
          <CloseButton onClose={closePanel} label="Close notifications" />
        </div>
        <div className="overflow-y-auto p-2 flex-1" style={{ overscrollBehavior: 'contain' }}>
          {items === null && !loadError && (
            <div className="p-3">
              <Skeleton lines={4} />
            </div>
          )}
          {loadError && (
            <div className="p-3">
              <ErrorNote message="Couldn't load notifications." onRetry={retryLoadItems} />
            </div>
          )}
          {items !== null && items.length === 0 && (
            <div className="cf-inset border-dashed p-6 text-center space-y-1">
              <p className="flex justify-center text-[var(--color-neutral-500)]">
                <GameIcon slug="ringing-bell" size={30} reserveSpace />
              </p>
              <p className="text-sm font-semibold text-[var(--color-neutral-300)]">Nothing yet</p>
              <p className="text-xs text-[var(--color-neutral-400)]">
                Recaps, replies, and session plans will land here.
              </p>
            </div>
          )}
          {items?.map((notification) => {
            const copy = notificationCopy(notification, formattingLocale, timeFormat);
            return (
            <button
              key={notification.id}
              type="button"
              onClick={() => void markRead(notification)}
              className="w-full text-left flex items-start gap-2.5 px-2.5 py-2.5 rounded-md min-h-[44px]"
              style={{
                background: notification.readAt
                  ? 'transparent'
                  : 'color-mix(in srgb, var(--color-accent) 8%, transparent)',
              }}
            >
              <span className="flex leading-none pt-0.5 text-[var(--color-neutral-300)]">
                <GameIcon slug={typeIcon(notification.type)} size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 flex-wrap">
                  {notification.type === 'ai_dm_alert' && (
                    <span className="tag tag-accent" style={{ fontSize: 8.5 }}>
                      AI DM
                    </span>
                  )}
                  <span
                    className="block text-[13px] leading-snug"
                    style={{
                      color: 'var(--color-text)',
                      fontWeight: notification.readAt ? 400 : 600,
                    }}
                  >
                    {copy.title}
                  </span>
                </span>
                {copy.body && (
                  <span className="block text-xs truncate" style={{ color: 'var(--color-neutral-400)' }}>
                    {copy.body}
                  </span>
                )}
                <span className="block text-[10.5px] mt-0.5" style={{ color: 'var(--color-neutral-400)' }}>
                  {timeAgo(notification.createdAt)}
                </span>
              </span>
              {!notification.readAt && (
                <span
                  className="w-[7px] h-[7px] rounded-full shrink-0 mt-1.5"
                  style={{ background: 'var(--color-accent)' }}
                />
              )}
            </button>
            );
          })}
        </div>
        <div
          className="px-4 py-2 border-t text-center shrink-0"
          style={{ borderColor: 'var(--color-divider)', background: 'var(--color-surface, rgba(0,0,0,0.1))' }}
        >
          <button
            type="button"
            tabIndex={-1}
            onClick={handleViewAllCenter}
            className="text-xs font-semibold hover:underline cursor-pointer inline-block border-none bg-transparent p-0"
            style={{ color: 'var(--color-accent)' }}
          >
            Notification Center &rarr;
          </button>
        </div>
      </div>
      {confirmDialog && (
        <ConfirmDialog
          title={confirmDialog.title}
          body={confirmDialog.body}
          confirmLabel={confirmDialog.confirmLabel}
          busy={confirmBusy}
          onConfirm={() => void handleConfirmExecute()}
          onCancel={() => setConfirmDialog(null)}
        />
      )}
      {pendingUndo && (
        <div onClick={(event) => event.stopPropagation()}>
          <UndoSnackbar
            message={pendingUndo.message}
            onUndo={handleUndo}
            onExpire={() => setPendingUndo(null)}
            successMessage="Restored notifications as unread."
          />
        </div>
      )}
    </div>
  );
}

