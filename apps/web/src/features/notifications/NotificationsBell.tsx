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
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { Notification } from '@campfire/schema';
import { useAuth } from '../../app/auth';
import { api, API } from '../../lib/api';
import { Btn, Skeleton } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';
import { useDialog } from '../../components/useDialog';
import { notificationHref } from '../../lib/entityLinks';

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
  | { type: 'read-all'; readAt: string };

type NotificationContextValue = {
  count: number;
  open: boolean;
  items: Notification[] | null;
  loadError: boolean;
  togglePanel(): void;
  closePanel(): void;
  markRead(notification: Notification): Promise<void>;
  markAllRead(): Promise<void>;
};

const NotificationContext = createContext<NotificationContextValue | null>(null);

function useNotifications(): NotificationContextValue {
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
      return 'calendar';
    case 'session_rsvp':
      return 'hand';
    case 'quest_updated':
      return 'scroll-unfurled';
    case 'proposal_submitted':
      return 'quill-ink';
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
    if (countRequestRef.current) return countRequestRef.current.promise;

    const stored = readStoredSnapshot();
    if (!force && stored && Date.now() - stored.refreshedAt < POLL_MS) {
      applySnapshot(stored);
      return Promise.resolve();
    }

    const controller = new AbortController();
    const generation = ++countGenerationRef.current;

    const load = async () => {
      if (!isDocumentActive()) return;
      const snapshotVersion = snapshotVersionRef.current;
      const res = await api.get<{ count: number }>(`${API}/notifications/unread-count`, {
        signal: controller.signal,
      });
      if (!mountedRef.current || controller.signal.aborted || generation !== countGenerationRef.current) return;
      // A read mutation or a newer tab refresh completed while this request was
      // in flight. Its snapshot is authoritative; do not resurrect an old count.
      if (snapshotVersionRef.current !== snapshotVersion) return;
      publishSnapshot({ count: res.count, refreshedAt: Date.now() });
    };

    const run = async () => {
      try {
        if (navigator.locks) {
          await navigator.locks.request(lockName, { ifAvailable: true }, async (lock) => {
            if (!lock) return;
            // A tab may have refreshed between our first cache check and acquiring
            // the origin-wide lock. Non-forced interval/initial reads can reuse it.
            const newer = readStoredSnapshot();
            if (!force && newer && Date.now() - newer.refreshedAt < POLL_MS) {
              applySnapshot(newer);
              return;
            }
            await load();
          });
        } else {
          // Web Locks is an optimization for multiple tabs. The per-provider gate
          // still guarantees no overlap in browsers that do not implement it.
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
    void api.get<Notification[]>(`${API}/notifications?limit=30`, { signal: controller.signal })
      .then((nextItems) => {
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

  const syncReadMessage = useCallback((message: Extract<NotificationSyncMessage, { type: 'read' | 'read-all' }>) => {
    if (!mountedRef.current) return;
    if (message.type === 'read') {
      readAtByIdRef.current.set(message.id, message.readAt);
      setItems((previous) => previous?.map((item) => (
        item.id === message.id && !item.readAt ? { ...item, readAt: message.readAt } : item
      )) ?? previous);
    } else {
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

    // Defer initial work one task so React StrictMode's development-only effect
    // replay cancels the discarded mount before it can create network traffic.
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
      // A hidden+offline tab waits until both conditions recover, then does one
      // refresh even if visibility and online events arrive back-to-back.
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

  // Route changes reconcile the badge without rebuilding the interval. The
  // initial route is handled by the lifecycle effect above.
  useEffect(() => {
    if (previousPathRef.current === location.pathname) return;
    previousPathRef.current = location.pathname;
    if (initializedRef.current) void refreshCount(true);
  }, [location.pathname, refreshCount]);

  const markRead = useCallback(async (notification: Notification) => {
    closePanel();
    // Issue #446: navigate first so mark-read only follows a successful route
    // change. Deleted/hidden targets still get a URL; EntityDeepLinkFocus times
    // out gracefully when the DOM node never appears.
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
        /* best-effort — user already landed on the destination */
      }
      void refreshCount(true);
    }
  }, [cancelCountRequest, closePanel, navigate, publishSnapshot, refreshCount, syncReadMessage]);

  const markAllRead = useCallback(async () => {
    try {
      await api.post(`${API}/notifications/read-all`);
      cancelCountRequest();
      const readAt = new Date().toISOString();
      syncReadMessage({ type: 'read-all', readAt });
      channelRef.current?.postMessage({ type: 'read-all', readAt } satisfies NotificationSyncMessage);
      publishSnapshot({ count: 0, refreshedAt: Date.now() });
    } catch {
      /* best-effort */
    }
  }, [cancelCountRequest, publishSnapshot, syncReadMessage]);

  const value: NotificationContextValue = {
    count,
    open,
    items,
    loadError,
    togglePanel,
    closePanel,
    markRead,
    markAllRead,
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

function OpenNotificationsPanel({ notifications }: { notifications: NotificationContextValue }) {
  const { count, items, loadError, closePanel, markRead, markAllRead } = notifications;
  const narrow = useIsNarrowViewport();
  // useDialog already wires Escape-to-close, focus trap, focus restore to the
  // trigger, and an inert background (issue #650/#92). It runs once per mount,
  // so it stays put when the panel re-renders across the breakpoint.
  const dialogRef = useDialog<HTMLDivElement>({ onClose: closePanel, inertBackground: true });
  const itemCountAnnouncement = items === null
    ? (loadError ? "Couldn't load notifications." : 'Loading items.')
    : `${items.length} ${items.length === 1 ? 'item' : 'items'}.`;

  // Bottom sheet on phones (issue #664), top-right flyout everywhere else —
  // matches the MoreSheet pattern in Layout.tsx so a thumb reaches the close
  // button and the surface sits above the mobile tab bar.
  // z-index from --cf-layer-notification so the sheet shares the dialog tier
  // and stays under the undo snackbar (issue #794 layer scale).
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
          <span
            id={NOTIFICATIONS_COUNT_ID}
            className="sr-only"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {itemCountAnnouncement}
          </span>
          <div className="flex-1" />
          {count > 0 && (
            <Btn ghost style={{ fontSize: 11, minHeight: 32 }} onClick={() => void markAllRead()}>
              Mark all read
            </Btn>
          )}
          <CloseButton onClose={closePanel} label="Close notifications" />
        </div>
        <div className="overflow-y-auto p-2" style={{ overscrollBehavior: 'contain' }}>
          {items === null && !loadError && (
            <div className="p-3">
              <Skeleton lines={4} />
            </div>
          )}
          {loadError && (
            <p className="text-sm p-3" style={{ color: 'var(--color-neutral-400)' }}>
              Couldn't load notifications.
            </p>
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
          {items?.map((notification) => (
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
                    {notification.title}
                  </span>
                </span>
                {notification.body && (
                  <span className="block text-xs truncate" style={{ color: 'var(--color-neutral-400)' }}>
                    {notification.body}
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
          ))}
        </div>
      </div>
    </div>
  );
}
