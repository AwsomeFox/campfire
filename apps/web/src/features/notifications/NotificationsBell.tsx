/**
 * Notification bell + dropdown panel (issue #11).
 *
 * Polls GET /notifications/unread-count (60s + on route change) for the badge;
 * fetches the full list only when the panel opens. Clicking a notification
 * marks it read and deep-links to the relevant campaign page. Real-time push
 * (SSE, issue #4) can later call `refresh()` instead of the interval — the
 * fetch/store shape here doesn't care where the tick comes from.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { Notification } from '@campfire/schema';
import { api, API } from '../../lib/api';
import { Btn, EmptyState, Skeleton } from '../../components/ui';

const POLL_MS = 60_000;

function targetPath(n: Notification): string {
  switch (n.type) {
    case 'recap_posted':
    case 'session_scheduled':
      return `/c/${n.campaignId}/sessions`;
    case 'note_reply':
      return `/c/${n.campaignId}/notes`;
    case 'added_to_campaign':
    default:
      return `/c/${n.campaignId}`;
  }
}

function typeIcon(type: Notification['type']): string {
  switch (type) {
    case 'recap_posted':
      return '📖';
    case 'note_reply':
      return '💬';
    case 'added_to_campaign':
      return '🏕️';
    case 'session_scheduled':
      return '🗓️';
    default:
      return '🔔';
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

export function NotificationsBell() {
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const panelRef = useRef<HTMLDivElement>(null);

  const refreshCount = useCallback(async () => {
    try {
      const res = await api.get<{ count: number }>(`${API}/notifications/unread-count`);
      setCount(res.count);
    } catch {
      /* badge is best-effort */
    }
  }, []);

  // Poll for the badge; also re-check on navigation so it stays fresh without SSE.
  useEffect(() => {
    void refreshCount();
    const t = setInterval(() => void refreshCount(), POLL_MS);
    return () => clearInterval(t);
  }, [refreshCount, location.pathname]);

  async function openPanel() {
    setOpen(true);
    setItems(null);
    setLoadError(false);
    try {
      setItems(await api.get<Notification[]>(`${API}/notifications?limit=30`));
    } catch {
      setLoadError(true);
    }
  }

  async function onItemClick(n: Notification) {
    setOpen(false);
    if (!n.readAt) {
      try {
        await api.post(`${API}/notifications/${n.id}/read`);
      } catch {
        /* navigation still proceeds */
      }
      void refreshCount();
    }
    navigate(targetPath(n));
  }

  async function onMarkAllRead() {
    try {
      await api.post(`${API}/notifications/read-all`);
      setItems((prev) => prev?.map((n) => (n.readAt ? n : { ...n, readAt: new Date().toISOString() })) ?? prev);
      setCount(0);
    } catch {
      /* best-effort */
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label={count > 0 ? `Notifications (${count} unread)` : 'Notifications'}
        onClick={() => (open ? setOpen(false) : void openPanel())}
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

      {open && (
        <div
          className="fixed inset-0 z-50"
          style={{ background: 'color-mix(in srgb, var(--color-neutral-900) 35%, transparent)' }}
          onClick={() => setOpen(false)}
        >
          <div
            ref={panelRef}
            className="cf-card elev-lg fixed flex flex-col"
            style={{
              top: 12,
              right: 12,
              width: 'min(380px, calc(100vw - 24px))',
              maxHeight: 'min(520px, calc(100vh - 24px))',
              padding: 0,
              overflow: 'hidden',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex items-center gap-2 px-4 py-3 border-b"
              style={{ borderColor: 'var(--color-divider)' }}
            >
              <span className="text-sm font-semibold" style={{ fontFamily: 'var(--font-heading)' }}>
                Notifications
              </span>
              <div className="flex-1" />
              {count > 0 && (
                <Btn ghost style={{ fontSize: 11, minHeight: 26 }} onClick={() => void onMarkAllRead()}>
                  Mark all read
                </Btn>
              )}
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
                <EmptyState icon="🔔" title="Nothing yet" hint="Recaps, replies, and session plans will land here." />
              )}
              {items?.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => void onItemClick(n)}
                  className="w-full text-left flex items-start gap-2.5 px-2.5 py-2.5 rounded-md"
                  style={{
                    background: n.readAt ? 'transparent' : 'color-mix(in srgb, var(--color-accent) 8%, transparent)',
                  }}
                >
                  <span className="text-base leading-none pt-0.5">{typeIcon(n.type)}</span>
                  <span className="min-w-0 flex-1">
                    <span
                      className="block text-[13px] leading-snug"
                      style={{
                        color: 'var(--color-text)',
                        fontWeight: n.readAt ? 400 : 600,
                      }}
                    >
                      {n.title}
                    </span>
                    {n.body && (
                      <span className="block text-xs truncate" style={{ color: 'var(--color-neutral-400)' }}>
                        {n.body}
                      </span>
                    )}
                    <span className="block text-[10.5px] mt-0.5" style={{ color: 'var(--color-neutral-600)' }}>
                      {timeAgo(n.createdAt)}
                    </span>
                  </span>
                  {!n.readAt && (
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
      )}
    </>
  );
}
