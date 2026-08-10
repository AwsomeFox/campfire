/**
 * Issue #829 — discussion watch/mute/read-state web client.
 *
 * Server-side thread state (watching / muted / lastReadCommentId) is the source of
 * truth; these helpers read and mutate it through the REST surface exposed by the
 * comments controller. `useCommentUnreadByEntity` drives unread badges (e.g. session
 * cards), `useCommentInbox` drives the discussion inbox, and `markCommentThreadRead`
 * advances the read cursor when a member actually opens a thread (clearing unread).
 */
import { useCallback, useEffect, useState } from 'react';
import type { CommentInboxItem, CommentUnreadSummaryEntry, EntityType } from '@campfire/schema';
import { api, API } from '../../lib/api';
import { useAuth } from '../../app/auth';

export interface CommentThreadStateResponse {
  campaignId: number;
  entityType: EntityType;
  entityId: number;
  watching: boolean;
  muted: boolean;
  lastReadCommentId: number | null;
  unreadCount: number;
  updatedAt: string | null;
}

function isNumericUserId(id: unknown): id is number {
  return typeof id === 'number' && Number.isInteger(id) && id > 0;
}

/**
 * Decoupled signal that a thread was just read (issue #829). `CommentsThread`
 * dispatches it after a successful mark-read; the unread-summary and inbox hooks
 * listen so session-card badges and the inbox update immediately instead of
 * waiting for the next navigation/reload (review #2170).
 */
export const COMMENT_THREAD_READ_EVENT = 'campfire:comment-thread-read';

function notifyThreadRead(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(COMMENT_THREAD_READ_EVENT));
  }
}

/** Advance the caller's read cursor on one thread (clears unread for that thread). */
export async function markCommentThreadRead(
  campaignId: number,
  entityType: EntityType,
  entityId: number,
  commentId?: number,
): Promise<void> {
  await api.post(`${API}/campaigns/${campaignId}/comments/thread-state/read`, {
    entityType,
    entityId,
    commentId: commentId ?? null,
  });
  notifyThreadRead();
}

/** Set the per-thread Watch/Mute controls. */
export async function setCommentThreadSubscription(
  campaignId: number,
  entityType: EntityType,
  entityId: number,
  patch: { watching?: boolean; muted?: boolean },
): Promise<CommentThreadStateResponse> {
  return api.put<CommentThreadStateResponse>(`${API}/campaigns/${campaignId}/comments/thread-state`, {
    entityType,
    entityId,
    ...patch,
  });
}

/**
 * Per-entity unread counts for one entity type (issue #829). Returns a map from
 * entityId → unread count for threads with unread > 0, plus a `refresh` callback.
 * Only meaningful for authenticated (numeric) members; returns an empty map
 * otherwise (DEV_AUTH dev users hold no thread state).
 */
export function useCommentUnreadByEntity(
  campaignId: number,
  entityType: EntityType,
): { byEntity: Map<number, number>; refresh: () => void } {
  const { me } = useAuth();
  const numeric = isNumericUserId(me?.user.id);
  const [byEntity, setByEntity] = useState<Map<number, number>>(new Map());
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!numeric) {
      setByEntity(new Map());
      return;
    }
    let cancelled = false;
    void api
      .get<{ items: CommentUnreadSummaryEntry[] }>(
        `${API}/campaigns/${campaignId}/comments/unread-summary?entityType=${entityType}`,
      )
      .then((summary) => {
        if (cancelled) return;
        const next = new Map<number, number>();
        for (const entry of summary.items) next.set(entry.entityId, entry.unreadCount);
        setByEntity(next);
      })
      .catch(() => {
        if (!cancelled) setByEntity(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [campaignId, entityType, numeric, tick]);

  // Refresh when any thread is marked read (review #2170).
  useEffect(() => {
    const onRead = () => setTick((t) => t + 1);
    window.addEventListener(COMMENT_THREAD_READ_EVENT, onRead);
    return () => window.removeEventListener(COMMENT_THREAD_READ_EVENT, onRead);
  }, []);

  return { byEntity, refresh };
}

/**
 * Campaign-wide discussion inbox (issue #829): the caller's watched threads with
 * unread comments. Returns the items plus a `refresh` callback.
 */
export function useCommentInbox(campaignId: number): {
  items: CommentInboxItem[];
  loading: boolean;
  refresh: () => void;
} {
  const { me } = useAuth();
  const numeric = isNumericUserId(me?.user.id);
  const [items, setItems] = useState<CommentInboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!numeric) {
      setItems([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void api
      .get<{ items: CommentInboxItem[] }>(`${API}/campaigns/${campaignId}/comments/inbox`)
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [campaignId, numeric, tick]);

  // Refresh when any thread is marked read (review #2170).
  useEffect(() => {
    const onRead = () => setTick((t) => t + 1);
    window.addEventListener(COMMENT_THREAD_READ_EVENT, onRead);
    return () => window.removeEventListener(COMMENT_THREAD_READ_EVENT, onRead);
  }, []);

  return { items, loading, refresh };
}
