/**
 * Scribe inbox — mirrors design/09-scribe-inbox.html.
 * Route: /c/:campaignId/inbox (DM only; non-dm gets a friendly notice).
 *
 * Note: the server only exposes open (unresolved) inbox items
 * (GET /api/v1/campaigns/:cid/inbox). There's no endpoint for resolved items,
 * so the "resolved" section is omitted — only open items are shown.
 */
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Note } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Card, Chip, Btn, TextArea, EmptyState, Skeleton, ErrorNote } from '../../components/ui';

export default function InboxPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const cid = Number(campaignId);
  const { roleIn } = useAuth();
  const role = roleIn(cid);

  const [items, setItems] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setForbidden(false);
    setLoading(true);
    try {
      const list = await api.get<Note[]>(`${API}/campaigns/${cid}/inbox`);
      setItems(list);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setForbidden(true);
      } else {
        setError("Couldn't load the inbox.");
      }
    } finally {
      setLoading(false);
    }
  }, [cid]);

  useEffect(() => {
    if (Number.isFinite(cid) && role === 'dm') void load();
  }, [cid, role, load]);

  async function resolve(item: Note, resolvedNote: string) {
    try {
      await api.post(`${API}/notes/${item.id}/resolve`, { resolvedNote });
      setExpandedId(null);
      await load();
    } catch {
      setError("Couldn't resolve this item.");
    }
  }

  if (!Number.isFinite(cid)) {
    return (
      <div className="max-w-3xl mx-auto px-4 mt-5">
        <ErrorNote message="No campaign selected." />
      </div>
    );
  }

  if (role !== null && role !== 'dm') {
    return (
      <div className="max-w-3xl mx-auto px-4 mt-5">
        <Card>
          <EmptyState icon="🎩" title="DM only" hint="The scribe inbox is only visible to the DM." />
        </Card>
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="max-w-3xl mx-auto px-4 mt-5">
        <Card>
          <EmptyState icon="🔒" title="You don't have access to this campaign" />
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 mt-5 space-y-5 pb-20 md:pb-10">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-extrabold text-white flex items-center gap-2 flex-wrap">
            ✉️ Scribe inbox
            <Chip variant="active">{items.length} open</Chip>
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Raw notes from the table. Resolve each into canon.
          </p>
        </div>
      </div>

      {error && <ErrorNote message={error} onRetry={load} />}

      {loading && items.length === 0 ? (
        <Card>
          <Skeleton lines={4} />
        </Card>
      ) : items.length === 0 ? (
        <EmptyState icon="✉️" title="Inbox clear" hint="No open items — nothing waiting to be resolved." />
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <InboxItem
              key={item.id}
              item={item}
              expanded={expandedId === item.id}
              onToggle={() => setExpandedId((cur) => (cur === item.id ? null : item.id))}
              onResolve={(note) => resolve(item, note)}
              onDismiss={() => resolve(item, 'dismissed')}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function InboxItem({
  item,
  expanded,
  onToggle,
  onResolve,
  onDismiss,
}: {
  item: Note;
  expanded: boolean;
  onToggle: () => void;
  onResolve: (resolvedNote: string) => void;
  onDismiss: () => void;
}) {
  const [resolutionNote, setResolutionNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleResolve() {
    setBusy(true);
    try {
      onResolve(resolutionNote.trim());
    } finally {
      setBusy(false);
    }
  }

  async function handleDismiss() {
    setBusy(true);
    try {
      onDismiss();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className={`!p-4 space-y-3 ${expanded ? 'border-amber-500/40' : ''}`}>
      <button className="w-full text-left" onClick={onToggle}>
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-bold text-slate-300">
            {item.authorName || 'Someone'} <span className="text-slate-600 font-normal">· {timeAgo(item.createdAt)}</span>
          </p>
          <Chip variant="active">Open</Chip>
        </div>
      </button>

      {expanded ? (
        <>
          <p className="text-sm text-slate-200 cf-inset p-3">&quot;{item.body}&quot;</p>
          <div className="cf-inset p-3 space-y-2.5 border-amber-500/30">
            <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">Resolve into…</p>
            <TextArea
              style={{ minHeight: 70 }}
              value={resolutionNote}
              onChange={(e) => setResolutionNote(e.target.value)}
              placeholder="Resolution note — what this became…"
            />
            <div className="flex items-center justify-between pt-1 gap-2 flex-wrap">
              <p className="text-[11px] text-slate-500">Marks this item resolved with your note attached.</p>
              <div className="flex gap-2 shrink-0">
                <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={handleDismiss} disabled={busy}>
                  Dismiss
                </Btn>
                <Btn className="!min-h-0 !py-1.5 text-xs" onClick={handleResolve} disabled={busy}>
                  Resolve
                </Btn>
              </div>
            </div>
          </div>
        </>
      ) : (
        <p className="text-sm text-slate-300">&quot;{item.body}&quot;</p>
      )}
    </Card>
  );
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}
