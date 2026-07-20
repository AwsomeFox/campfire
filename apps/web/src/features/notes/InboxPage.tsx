/**
 * Scribe inbox — mirrors design/claude-design/Campfire.dc.html "Scribe inbox" (~1105-1124).
 * Route: /c/:campaignId/inbox (DM only; non-dm gets a friendly notice).
 * Design: avatar + text + "from X", a "Resolve →" action per pending item. We keep the
 * existing expand-to-add-a-resolution-note flow (extra functionality) behind that action,
 * and resolving may optionally link the entity the item became (quest/npc/location/…).
 *
 * Two views: "Open" (unresolved items, GET /campaigns/:cid/inbox) and "History"
 * (resolved items, GET /campaigns/:cid/inbox?resolved=true) — history shows each
 * item's resolution note and a link to the entity it was resolved into.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Note } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Card, Chip, Btn, TextArea, EmptyState, Skeleton, ErrorNote } from '../../components/ui';
import { Markdown } from '../../components/Markdown';

type EntityTypeValue = Exclude<Note['entityType'], null>;
type ViewValue = 'open' | 'history';

/** Sub-path under /c/:cid for each linkable entity type (null = campaign dashboard). */
const entityRoute: Record<EntityTypeValue, string | null> = {
  quest: 'quests',
  npc: 'npcs',
  location: 'locations',
  character: 'characters',
  session: 'sessions',
  campaign: null,
};

const entityIcon: Record<EntityTypeValue, string> = {
  quest: '📜',
  npc: '🤝',
  location: '🗺',
  character: '🛡',
  session: '📓',
  campaign: '🔥',
};

/** Entity types the resolve form offers as link targets (campaign excluded — nothing "becomes" the campaign). */
const LINKABLE: { value: EntityTypeValue; label: string; listPath: string }[] = [
  { value: 'quest', label: '📜 Quest', listPath: 'quests' },
  { value: 'npc', label: '🤝 NPC', listPath: 'npcs' },
  { value: 'location', label: '🗺 Location', listPath: 'locations' },
  { value: 'session', label: '📓 Session', listPath: 'sessions' },
  { value: 'character', label: '🛡 Character', listPath: 'characters' },
];

interface EntityOption {
  id: number;
  label: string;
}

function optionLabel(type: EntityTypeValue, row: Record<string, unknown>): string {
  if (type === 'session') {
    const title = typeof row.title === 'string' && row.title ? ` — ${row.title}` : '';
    return `Session ${String(row.number ?? row.id)}${title}`;
  }
  const name = row.title ?? row.name;
  return typeof name === 'string' && name ? name : `#${String(row.id)}`;
}

export default function InboxPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const cid = Number(campaignId);
  const { roleIn } = useAuth();
  const role = roleIn(cid);

  const [view, setView] = useState<ViewValue>('open');
  const [items, setItems] = useState<Note[]>([]);
  const [resolvedItems, setResolvedItems] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setForbidden(false);
    setLoading(true);
    try {
      const [open, resolved] = await Promise.all([
        api.get<Note[]>(`${API}/campaigns/${cid}/inbox`),
        api.get<Note[]>(`${API}/campaigns/${cid}/inbox?resolved=true`),
      ]);
      setItems(open);
      setResolvedItems(resolved);
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

  async function resolve(item: Note, resolvedNote: string, link: { entityType: EntityTypeValue; entityId: number } | null) {
    try {
      await api.post(`${API}/notes/${item.id}/resolve`, {
        resolvedNote,
        ...(link ? { entityType: link.entityType, entityId: link.entityId } : {}),
      });
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
    <div className="max-w-3xl mx-auto px-4 mt-5 space-y-3 pb-20 md:pb-10" style={{ maxWidth: 760 }}>
      <h1 className="text-xl font-extrabold text-white m-0">Scribe inbox</h1>
      <p className="text-muted text-xs m-0">
        Raw notes from the table. Resolve each one into the entity it belongs to — or let Claude sweep them for you.
      </p>
      <p className="text-muted text-xs m-0">
        &quot;Claude&quot; here means any MCP-capable assistant (like Claude) connected with an API token — set one
        up in <Link to="/tokens" className="text-purple-400 hover:underline">API tokens</Link>.
      </p>

      <div className="flex gap-1.5 flex-wrap">
        <button onClick={() => setView('open')}>
          <Chip variant={view === 'open' ? 'active' : 'available'}>✉️ Open{items.length > 0 ? ` (${items.length})` : ''}</Chip>
        </button>
        <button onClick={() => setView('history')}>
          <Chip variant={view === 'history' ? 'active' : 'available'}>
            ✅ History{resolvedItems.length > 0 ? ` (${resolvedItems.length})` : ''}
          </Chip>
        </button>
      </div>

      {error && <ErrorNote message={error} onRetry={load} />}

      {loading && items.length === 0 && resolvedItems.length === 0 ? (
        <Card>
          <Skeleton lines={4} />
        </Card>
      ) : view === 'open' ? (
        items.length === 0 ? (
          <EmptyState icon="✉️" title="Inbox clear" hint="No open items — nothing waiting to be resolved." />
        ) : (
          <div className="space-y-3">
            {items.map((item) => (
              <InboxItem
                key={item.id}
                campaignId={cid}
                item={item}
                expanded={expandedId === item.id}
                onToggle={() => setExpandedId((cur) => (cur === item.id ? null : item.id))}
                onResolve={(note, link) => resolve(item, note, link)}
                onDismiss={() => resolve(item, 'dismissed', null)}
              />
            ))}
          </div>
        )
      ) : resolvedItems.length === 0 ? (
        <EmptyState icon="🗂" title="No history yet" hint="Resolved items land here, linked to the entities they became." />
      ) : (
        <div className="space-y-3">
          {resolvedItems.map((item) => (
            <ResolvedItem key={item.id} campaignId={cid} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

function entityHref(campaignId: number, item: Note): string | null {
  if (!item.entityType) return null;
  const sub = entityRoute[item.entityType];
  if (sub === null) return `/c/${campaignId}`;
  // Sessions have no per-id detail route — link to the sessions list.
  if (item.entityType === 'session') return `/c/${campaignId}/sessions`;
  return item.entityId !== null ? `/c/${campaignId}/${sub}/${item.entityId}` : null;
}

function ResolvedItem({ campaignId, item }: { campaignId: number; item: Note }) {
  const href = entityHref(campaignId, item);
  const resolvedOn = item.updatedAt ? new Date(item.updatedAt).toLocaleDateString() : null;
  return (
    <Card className="!p-4 space-y-2.5">
      <div className="flex gap-2.5 items-start">
        <span className="h-[30px] w-[30px] shrink-0 rounded-full bg-[var(--color-neutral-900)] flex items-center justify-center text-[11px] text-[var(--color-neutral-400)]">
          {(item.authorName || '?').slice(0, 1).toUpperCase()}
        </span>
        <div className="flex-1 min-w-0">
          <Markdown>{item.body}</Markdown>
          <p className="text-muted text-[11px] mt-0.5 mb-0">
            from {item.authorName || 'Someone'}
            {resolvedOn && <> · resolved {resolvedOn}</>}
          </p>
        </div>
      </div>

      <div className="cf-inset p-3 space-y-1.5">
        <p className="text-[10px] font-bold text-emerald-500 uppercase tracking-widest m-0">Resolved into</p>
        {item.entityType && href && (
          <Link to={href} className="inline-flex text-xs text-purple-400 hover:underline">
            {entityIcon[item.entityType]} {capitalize(item.entityType)}
            {item.entityId !== null && item.entityType !== 'campaign' ? ` #${item.entityId}` : ''} →
          </Link>
        )}
        {item.resolvedNote ? (
          <p className="text-xs text-slate-400 m-0">{item.resolvedNote}</p>
        ) : (
          !item.entityType && <p className="text-xs text-slate-500 m-0">No resolution note.</p>
        )}
      </div>
    </Card>
  );
}

function capitalize(s: string): string {
  return s.slice(0, 1).toUpperCase() + s.slice(1);
}

function InboxItem({
  campaignId,
  item,
  expanded,
  onToggle,
  onResolve,
  onDismiss,
}: {
  campaignId: number;
  item: Note;
  expanded: boolean;
  onToggle: () => void;
  onResolve: (resolvedNote: string, link: { entityType: EntityTypeValue; entityId: number } | null) => void;
  onDismiss: () => void;
}) {
  const [resolutionNote, setResolutionNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [linkType, setLinkType] = useState<EntityTypeValue | ''>('');
  const [linkId, setLinkId] = useState<number | ''>('');
  const [options, setOptions] = useState<EntityOption[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);

  useEffect(() => {
    setLinkId('');
    setOptions([]);
    if (!linkType) return;
    const meta = LINKABLE.find((l) => l.value === linkType);
    if (!meta) return;
    let cancelled = false;
    setOptionsLoading(true);
    api
      .get<Record<string, unknown>[]>(`${API}/campaigns/${campaignId}/${meta.listPath}`)
      .then((rows) => {
        if (cancelled) return;
        setOptions(rows.map((row) => ({ id: Number(row.id), label: optionLabel(linkType, row) })));
      })
      .catch(() => {
        if (!cancelled) setOptions([]);
      })
      .finally(() => {
        if (!cancelled) setOptionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [linkType, campaignId]);

  async function handleResolve() {
    setBusy(true);
    try {
      onResolve(resolutionNote.trim(), linkType && linkId !== '' ? { entityType: linkType, entityId: linkId } : null);
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
    <Card className={`!p-4 space-y-2.5 ${expanded ? 'border-amber-500/40' : ''}`}>
      <div className="flex gap-2.5 items-start">
        <span className="h-[30px] w-[30px] shrink-0 rounded-full bg-[var(--color-neutral-900)] flex items-center justify-center text-[11px] text-[var(--color-neutral-400)]">
          {(item.authorName || '?').slice(0, 1).toUpperCase()}
        </span>
        <div className="flex-1 min-w-0">
          <Markdown>{item.body}</Markdown>
          <p className="text-muted text-[11px] mt-0.5 mb-0">from {item.authorName || 'Someone'}</p>
        </div>
      </div>

      {expanded && (
        <div className="cf-inset p-3 space-y-2.5 border-amber-500/30">
          <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">Resolve into…</p>
          <TextArea
            style={{ minHeight: 70 }}
            value={resolutionNote}
            onChange={(e) => setResolutionNote(e.target.value)}
            placeholder="Resolution note — what this became…"
          />
          <div className="flex gap-2 flex-wrap">
            <select
              className="cf-select !min-h-0 !py-2 text-xs"
              value={linkType}
              onChange={(e) => setLinkType(e.target.value as EntityTypeValue | '')}
            >
              <option value="">No entity link</option>
              {LINKABLE.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
            {linkType && (
              <select
                className="cf-select !min-h-0 !py-2 text-xs flex-1 min-w-0"
                value={linkId}
                onChange={(e) => setLinkId(e.target.value === '' ? '' : Number(e.target.value))}
                disabled={optionsLoading}
              >
                <option value="">{optionsLoading ? 'Loading…' : options.length === 0 ? 'Nothing to link' : 'Pick one…'}</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="flex items-center justify-between pt-1 gap-2 flex-wrap">
            <p className="text-[11px] text-slate-500">
              Marks this item resolved{linkType && linkId !== '' ? ', linked to the entity it became' : ' with your note attached'}.
            </p>
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
      )}

      <div className="flex justify-end">
        <Btn className="!min-h-0 !py-1.5 text-xs" onClick={onToggle}>
          {expanded ? 'Collapse' : 'Resolve →'}
        </Btn>
      </div>
    </Card>
  );
}
