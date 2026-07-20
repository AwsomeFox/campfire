/**
 * Proposals — /c/:campaignId/proposals. Mirrors design/claude-design/Campfire.dc.html
 * "Proposals" (~1127-1153): target + proposer tag, why-text, a field/old->new diff table,
 * Approve/Reject (or a decided-status tag once resolved).
 * DM-only guardrail queue for AI/collab writes: nothing touches canon until approved.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Proposal } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Card, Chip, Btn, TextInput, EmptyState, Skeleton, ErrorNote } from '../../components/ui';

type EntityType = Proposal['entityType'];

const entityRoute: Record<EntityType, string | null> = {
  quest: 'quests',
  npc: 'npcs',
  location: 'locations',
  character: 'characters',
  session: 'sessions',
  campaign: null,
};

const entityIcon: Record<EntityType, string> = {
  quest: '📜',
  npc: '🤝',
  location: '🗺',
  character: '🛡',
  session: '📓',
  campaign: '🔥',
};

export default function ProposalsPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const cid = Number(campaignId);
  const { roleIn } = useAuth();
  const role = roleIn(cid);
  const isDm = role === 'dm';

  const [pending, setPending] = useState<Proposal[] | null>(null);
  const [history, setHistory] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const [pendingList, approved, rejected] = await Promise.all([
        api.get<Proposal[]>(`${API}/campaigns/${cid}/proposals?status=pending`),
        api.get<Proposal[]>(`${API}/campaigns/${cid}/proposals?status=approved`),
        api.get<Proposal[]>(`${API}/campaigns/${cid}/proposals?status=rejected`),
      ]);
      setPending(pendingList);
      const merged = [...approved, ...rejected].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
      setHistory(merged.slice(0, 10));
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setForbidden(true);
      } else {
        setError(err instanceof ApiError ? err.message : "Couldn't load proposals.");
      }
    } finally {
      setLoading(false);
    }
  }, [cid]);

  useEffect(() => {
    if (Number.isFinite(cid) && isDm) void load();
  }, [cid, isDm, load]);

  async function resolve(proposal: Proposal, action: 'approve' | 'reject', note: string) {
    try {
      await api.post(`${API}/proposals/${proposal.id}/${action}`, note ? { note } : {});
      setExpandedId(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Couldn't ${action} this proposal.`);
    }
  }

  if (!Number.isFinite(cid)) {
    return (
      <div className="max-w-3xl mx-auto px-4 mt-5">
        <ErrorNote message="No campaign selected." />
      </div>
    );
  }

  if (role !== null && !isDm) {
    return (
      <div className="max-w-3xl mx-auto px-4 mt-5">
        <Card>
          <EmptyState icon="🎩" title="DM only" hint="Proposals are only visible to the DM." />
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

  if (loading && pending === null) {
    return (
      <div className="max-w-3xl mx-auto px-4 mt-5 space-y-5">
        <Card>
          <Skeleton lines={4} />
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 mt-5 space-y-3 pb-20 md:pb-10" style={{ maxWidth: 760 }}>
      <h1 className="text-xl font-extrabold text-white m-0">Proposals</h1>
      <p className="text-muted text-xs m-0">
        AI and collaborator edits land here as pending changes. Nothing touches canon until you approve it.
      </p>
      <p className="text-muted text-xs m-0">
        AI scribe = any MCP-capable assistant (like Claude) connected with an API token — set up in{' '}
        <Link to="/tokens" className="text-purple-400 hover:underline">API tokens</Link>.
      </p>

      {error && <ErrorNote message={error} onRetry={load} />}

      {(pending ?? []).length === 0 ? (
        <EmptyState icon="🔮" title="No pending proposals" hint="Approved & rejected proposals show up below." />
      ) : (
        <div className="space-y-3">
          {(pending ?? []).map((p) => (
            <ProposalCard
              key={p.id}
              proposal={p}
              expanded={expandedId === p.id}
              onToggle={() => setExpandedId((cur) => (cur === p.id ? null : p.id))}
              onApprove={(note) => resolve(p, 'approve', note)}
              onReject={(note) => resolve(p, 'reject', note)}
            />
          ))}
        </div>
      )}

      {history.length > 0 && (
        <section className="space-y-2">
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">History</p>
          {history.map((p) => (
            <HistoryRow key={p.id} proposal={p} />
          ))}
        </section>
      )}

      <p className="text-[11px] text-slate-600">
        Future AI-DM mode uses this exact queue: story beats, generated NPCs, and maps all arrive as proposals. An
        env flag can allow trusted DM-scoped tokens to write directly (audited).
      </p>
    </div>
  );
}

function proposalTitle(p: Proposal): string {
  const verb = p.action === 'create' ? 'Create' : 'Update';
  const name = typeof p.payload.name === 'string' ? p.payload.name : typeof p.payload.title === 'string' ? p.payload.title : null;
  if (name) return `${verb} ${p.entityType} "${name}"`;
  return `${verb} ${p.entityType}${p.entityId ? ` #${p.entityId}` : ''}`;
}

function ProposalCard({
  proposal,
  expanded,
  onToggle,
  onApprove,
  onReject,
}: {
  proposal: Proposal;
  expanded: boolean;
  onToggle: () => void;
  onApprove: (note: string) => void;
  onReject: (note: string) => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const route = entityRoute[proposal.entityType];
  const href = route && proposal.entityId ? `../${route}/${proposal.entityId}` : null;

  async function act(fn: (note: string) => void) {
    setBusy(true);
    try {
      fn(note.trim());
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <p className="card-title text-[15px] m-0">
          {entityIcon[proposal.entityType]} {proposalTitle(proposal)}
        </p>
        <Chip variant="proposal">{proposal.proposer}</Chip>
      </div>
      <p className="text-muted text-xs m-0">
        {proposal.action === 'create' ? 'New' : 'Update'} {proposal.entityType}
        {proposal.entityId && href ? (
          <>
            {' '}
            · <Link to={href} className="text-purple-400 hover:underline">view target</Link>
          </>
        ) : null}
        {' '}· {timeAgo(proposal.createdAt)}
      </p>

      <DiffView payload={proposal.payload} snapshot={proposal.snapshot} />

      {expanded && (
        <TextInput
          className="!min-h-0 !py-2 text-sm"
          placeholder="Optional note…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      )}

      <div className="flex items-center gap-2 justify-end">
        <button type="button" className="text-[11px] text-slate-500 hover:text-white mr-auto" onClick={onToggle}>
          {expanded ? 'Hide note field' : '+ note'}
        </button>
        <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => act(onReject)} disabled={busy}>
          Reject
        </Btn>
        <Btn className="!min-h-0 !py-1.5 text-xs" onClick={() => act(onApprove)} disabled={busy}>
          Approve
        </Btn>
      </div>
    </Card>
  );
}

function DiffView({ payload, snapshot }: { payload: Record<string, unknown>; snapshot: Record<string, unknown> | null }) {
  const entries = Object.entries(payload);
  if (entries.length === 0) {
    return <p className="text-xs text-slate-500">No fields in this proposal.</p>;
  }
  // `snapshot` is the entity's state captured at propose time (update proposals only —
  // null for creates and for proposals recorded before the server grew snapshots), so
  // changed fields render as "field: old -> new" with the old value struck through, as
  // the design depicts. Without a snapshot we fall back to field -> proposed value.
  return (
    <div className="border border-[var(--color-divider)] rounded-[var(--radius-md)] overflow-hidden">
      {entries.map(([key, value], i) => {
        const hasBefore = snapshot !== null && key in snapshot;
        const unchanged = hasBefore && sameValue(snapshot[key], value);
        return (
          <div
            key={key}
            className="flex gap-2.5 px-3 py-2 text-[12.5px] items-baseline"
            style={i > 0 ? { borderTop: '1px solid var(--color-divider)' } : undefined}
          >
            <span className="text-muted w-[86px] shrink-0 text-[11px]">{key}</span>
            {hasBefore && !unchanged && (
              <span className="line-through text-slate-500 whitespace-pre-wrap break-all shrink-0 max-w-[45%]">
                {formatValue(snapshot[key])}
              </span>
            )}
            <span style={{ color: 'var(--color-accent-300)' }} className="whitespace-pre-wrap break-all">
              {unchanged ? formatValue(value) : `→ ${formatValue(value)}`}
            </span>
            {unchanged && <span className="text-[10px] text-slate-600 shrink-0">unchanged</span>}
          </div>
        );
      })}
    </div>
  );
}

/** Structural equality for diff purposes — payload/snapshot values are plain JSON. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function HistoryRow({ proposal }: { proposal: Proposal }) {
  const failed = proposal.status === 'rejected';
  return (
    <div className="cf-card p-3.5 flex items-center justify-between gap-2 opacity-70">
      <p className="text-sm text-slate-400 m-0">
        {entityIcon[proposal.entityType]} {proposalTitle(proposal)}{' '}
        <span className="text-slate-600">· {proposal.proposer}</span>
      </p>
      <span className={`tag ${failed ? 'tag-neutral' : 'tag-accent'}`}>
        {failed ? `Rejected${proposal.note ? ` — ${proposal.note}` : ''}` : 'Approved'}
      </span>
    </div>
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
