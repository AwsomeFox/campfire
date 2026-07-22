/**
 * Proposals — /c/:campaignId/proposals. Mirrors design/claude-design/Campfire.dc.html
 * "Proposals" (~1127-1153): target + proposer tag, why-text, a field/old->new diff table,
 * Approve/Reject (or a decided-status tag once resolved).
 * DM-only guardrail queue for AI/collab writes: nothing touches canon until approved.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Proposal } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Card, Chip, Btn, TextInput, EmptyState, Skeleton, ErrorNote } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useAnnounce } from '../../components/Announcer';
import { ENTITY_ICON } from '../../lib/uiIcons';
import { proposalTargetHref } from '../../lib/entityLinks';
import {
  deriveProposalSelectionScope,
  isAiProposal,
  retainPendingSelection,
  summarizeProposalBatch,
} from './proposalSelection';

type EntityType = Proposal['entityType'];

const entityIcon: Record<EntityType, string> = {
  quest: ENTITY_ICON.quest,
  npc: ENTITY_ICON.npc,
  faction: ENTITY_ICON.faction,
  location: ENTITY_ICON.location,
  character: ENTITY_ICON.character,
  session: ENTITY_ICON.session,
  encounter: ENTITY_ICON.encounter,
  campaign: ENTITY_ICON.campaign,
};

/** `entityIcon` slug lookup with a fallback for entity types outside the shared enum
 *  (e.g. a co-DM 'map' draft, #313/#306) — see the `targetHref` comment above. */
function iconFor(entityType: EntityType): string {
  return entityIcon[entityType] ?? ENTITY_ICON.location;
}

/** Entity glyph + title, shared by the pending/history rows. */
function EntityTitle({ slug, children }: { slug: string; children: ReactNode }) {
  return (
    <>
      <GameIcon slug={slug} size={15} className="inline align-text-bottom mr-1.5 text-[var(--color-accent)]" /> {children}
    </>
  );
}

export default function ProposalsPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const cid = Number(campaignId);
  const { roleIn } = useAuth();
  const announce = useAnnounce();
  const role = roleIn(cid);
  const isDm = role === 'dm';

  const [pending, setPending] = useState<Proposal[] | null>(null);
  const [history, setHistory] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchConfirmation, setBatchConfirmation] = useState<{
    action: 'approve' | 'reject';
    proposals: Proposal[];
  } | null>(null);
  // "AI drafts" filter (issue #341): narrow the pending queue down to co-DM-drafted
  // proposals so a DM can triage what the AI wrote separately from human/collab edits.
  const [aiOnly, setAiOnly] = useState(false);

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
      // A proposal may be resolved by another DM or agent while this page is open.
      // Never retain an invisible, no-longer-pending id after the refresh.
      setSelected((current) => retainPendingSelection(pendingList, current));
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

  async function resolve(
    proposal: Proposal,
    action: 'approve' | 'reject',
    note: string,
    amendedPayload?: Record<string, unknown>,
  ) {
    try {
      const body: Record<string, unknown> = {};
      if (note) body.note = note;
      // Edit-before-approve: send the DM's amended payload so it's applied instead of
      // the originally proposed one. Only meaningful on approve.
      if (action === 'approve' && amendedPayload) body.payload = amendedPayload;
      await api.post(`${API}/proposals/${proposal.id}/${action}`, body);
      setExpandedId(null);
      setSelected((cur) => {
        const next = new Set(cur);
        next.delete(proposal.id);
        return next;
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Couldn't ${action} this proposal.`);
    }
  }

  async function resolveSelected(action: 'approve' | 'reject', proposals: Proposal[]) {
    // `proposals` is the frozen visible selection shown in the confirmation. Its
    // order and ids are used unchanged for the request.
    const ids = proposals.map((proposal) => proposal.id);
    if (ids.length === 0) return;
    setBatchBusy(true);
    setError(null);
    try {
      const { results } = await api.post<{ results: { id: number; ok: boolean; error?: string }[] }>(
        `${API}/proposals/batch/${action}`,
        { ids },
      );
      const succeededIds = new Set(results.filter((result) => result.ok).map((result) => result.id));
      // Treat a missing result as a failure too. The server currently returns one
      // result per id, but preserving an unacknowledged id is the safer fallback.
      const failedIds = ids.filter((id) => !succeededIds.has(id));
      const firstFailure = results.find((result) => !result.ok);
      setSelected(new Set(failedIds));
      await load();
      if (failedIds.length > 0) {
        setError(`${failedIds.length} of ${ids.length} couldn't be ${action === 'approve' ? 'approved' : 'rejected'}: ${firstFailure?.error ?? 'unknown error'}`);
      }
      setBatchConfirmation(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Couldn't ${action} the selected proposals.`);
      setBatchConfirmation(null);
    } finally {
      setBatchBusy(false);
    }
  }

  function toggleSelected(id: number) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function setAiFilter(nextAiOnly: boolean) {
    const nextScope = deriveProposalSelectionScope(pending ?? [], selected, nextAiOnly);
    setSelected(new Set(nextScope.selectedIds));
    setAiOnly(nextAiOnly);
    if (nextScope.hiddenSelectedIds.length > 0) {
      const cleared = nextScope.hiddenSelectedIds.length;
      const remaining = nextScope.selectedCount;
      announce(
        `AI drafts filter cleared ${cleared} hidden ${cleared === 1 ? 'selection' : 'selections'}. ` +
          `${remaining} visible ${remaining === 1 ? 'proposal remains' : 'proposals remain'} selected.`,
      );
    }
  }

  if (!Number.isFinite(cid)) {
    return (
      <div className="max-w-3xl mx-auto px-4 mt-5">
        <ErrorNote message="No campaign selected." />
      </div>
    );
  }

  // Non-DM members get a self-view of the proposals THEY submitted (issue #124):
  // status, the DM's resolution note, and a withdraw action while still pending.
  if (role !== null && !isDm) {
    return <MyProposalsView campaignId={cid} />;
  }

  if (forbidden) {
    return (
      <div className="max-w-3xl mx-auto px-4 mt-5">
        <Card>
          <EmptyState icon="padlock" title="You don't have access to this campaign" />
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

  const aiPendingCount = (pending ?? []).filter(isAiProposal).length;
  const selectionScope = deriveProposalSelectionScope(pending ?? [], selected, aiOnly);
  const visiblePending = selectionScope.visible;

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
        <EmptyState icon="crystal-ball" title="No pending proposals" hint="Approved & rejected proposals show up below." />
      ) : (
        <div className="space-y-3">
          {(aiPendingCount > 0 || aiOnly) && (
            <label
              className="inline-flex items-center gap-1.5 text-[11px] px-1 cursor-pointer"
              style={{ color: aiOnly ? 'var(--color-accent-300)' : 'var(--color-neutral-500)' }}
            >
              <input
                type="checkbox"
                checked={aiOnly}
                onChange={(event) => setAiFilter(event.target.checked)}
                disabled={batchBusy}
              />
              <GameIcon slug="robot-golem" size={13} className="inline align-text-bottom mr-1" /> AI drafts only ({aiPendingCount})
            </label>
          )}
          <BatchBar
            total={selectionScope.total}
            selectedCount={selectionScope.selectedCount}
            allSelected={selectionScope.allSelected}
            indeterminate={selectionScope.indeterminate}
            busy={batchBusy}
            onToggleAll={(all) =>
              setSelected(all ? new Set(visiblePending.map((p) => p.id)) : new Set())
            }
            onApprove={() => setBatchConfirmation({ action: 'approve', proposals: selectionScope.selected })}
            onReject={() => setBatchConfirmation({ action: 'reject', proposals: selectionScope.selected })}
          />
          {visiblePending.length === 0 ? (
            <EmptyState icon="robot-golem" title="No AI drafts pending" hint="Turn off the filter to see the rest of the queue." />
          ) : (
            visiblePending.map((p) => (
              <ProposalCard
                key={p.id}
                proposal={p}
                campaignId={cid}
                expanded={expandedId === p.id}
                selected={selected.has(p.id)}
                onSelectChange={() => toggleSelected(p.id)}
                onToggle={() => setExpandedId((cur) => (cur === p.id ? null : p.id))}
                onApprove={(note, payload) => resolve(p, 'approve', note, payload)}
                onReject={(note) => resolve(p, 'reject', note)}
              />
            ))
          )}
        </div>
      )}

      {batchConfirmation && (
        <BatchConfirmationDialog
          action={batchConfirmation.action}
          proposals={batchConfirmation.proposals}
          busy={batchBusy}
          onConfirm={() => void resolveSelected(batchConfirmation.action, batchConfirmation.proposals)}
          onCancel={() => setBatchConfirmation(null)}
        />
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

const actionVerb: Record<Proposal['action'], string> = {
  create: 'Create',
  update: 'Update',
  delete: 'Delete',
};

function proposalTitle(p: Proposal): string {
  const verb = actionVerb[p.action];
  const source = p.action === 'delete' ? (p.snapshot ?? {}) : p.payload;
  const name = typeof source.name === 'string' ? source.name : typeof source.title === 'string' ? source.title : null;
  if (name) return `${verb} ${p.entityType} "${name}"`;
  return `${verb} ${p.entityType}${p.entityId ? ` #${p.entityId}` : ''}`;
}

/** Bulk approve/reject bar for the pending queue (#98) — select many, resolve in one call. */
function BatchBar({
  total,
  selectedCount,
  allSelected,
  indeterminate,
  busy,
  onToggleAll,
  onApprove,
  onReject,
}: {
  total: number;
  selectedCount: number;
  allSelected: boolean;
  indeterminate: boolean;
  busy: boolean;
  onToggleAll: (all: boolean) => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="flex items-center gap-2.5 flex-wrap px-1">
      <label className="flex items-center gap-2 text-[12px] text-slate-400 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={allSelected}
          disabled={busy || total === 0}
          ref={(el) => {
            if (el) el.indeterminate = indeterminate;
          }}
          onChange={(e) => onToggleAll(e.target.checked)}
        />
        {selectedCount > 0 ? `${selectedCount} of ${total} selected` : `Select all (${total})`}
      </label>
      {selectedCount > 0 && (
        <div className="flex items-center gap-2 ml-auto">
          <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={onReject} disabled={busy}>
            Reject {selectedCount}
          </Btn>
          <Btn className="!min-h-0 !py-1.5 text-xs" onClick={onApprove} disabled={busy}>
            Approve {selectedCount}
          </Btn>
        </div>
      )}
    </div>
  );
}

function BatchConfirmationDialog({
  action,
  proposals,
  busy,
  onConfirm,
  onCancel,
}: {
  action: 'approve' | 'reject';
  proposals: Proposal[];
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const summary = summarizeProposalBatch(proposals);
  const verb = action === 'approve' ? 'Approve' : 'Reject';
  const pastVerb = action === 'approve' ? 'approved' : 'rejected';

  return (
    <ConfirmDialog
      title={`${verb} ${summary.total} selected ${summary.total === 1 ? 'proposal' : 'proposals'}?`}
      confirmLabel={`${verb} ${summary.total} ${summary.total === 1 ? 'proposal' : 'proposals'}`}
      danger={action === 'reject' || summary.destructiveCount > 0}
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
      body={(
        <div className="space-y-2">
          <p>
            Only these {summary.total} visible selected {summary.total === 1 ? 'proposal' : 'proposals'} will be {pastVerb}.
          </p>
          <ul className="list-disc pl-5 space-y-1" aria-label="Selected proposal types">
            {summary.actions.map((item) => (
              <li key={item.action}>
                <strong className="capitalize">{item.action}</strong>: {item.count}{' '}
                {item.count === 1 ? 'proposal' : 'proposals'} ({item.entityCounts.map(({ entityType, count }) =>
                  `${count} ${entityType}`,
                ).join(', ')})
              </li>
            ))}
          </ul>
          {summary.destructiveCount > 0 && (
            <p className="text-rose-400">
              {action === 'approve'
                ? `${summary.destructiveCount} delete ${summary.destructiveCount === 1 ? 'proposal is' : 'proposals are'} destructive and will permanently remove the target.`
                : `${summary.destructiveCount} delete ${summary.destructiveCount === 1 ? 'proposal is' : 'proposals are'} included; rejecting keeps the target unchanged.`}
            </p>
          )}
        </div>
      )}
    />
  );
}

function ProposalCard({
  proposal,
  campaignId,
  expanded,
  selected,
  onSelectChange,
  onToggle,
  onApprove,
  onReject,
}: {
  proposal: Proposal;
  campaignId: number;
  expanded: boolean;
  selected: boolean;
  onSelectChange: () => void;
  onToggle: () => void;
  onApprove: (note: string, payload?: Record<string, unknown>) => void;
  onReject: (note: string) => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const href = proposalTargetHref(campaignId, proposal);
  const isDelete = proposal.action === 'delete';
  // Edit-before-approve is meaningful only for create/update (delete carries no payload).
  const canEdit = !isDelete;
  const isAi = isAiProposal(proposal);
  // Encounter/map drafts carry a pinned `seed` (#304/#306) so approving them re-runs the
  // deterministic generator rather than a plain field write — worth flagging (issue #341).
  // 'map' isn't (yet) a member of the shared EntityType enum — see the `targetHref`
  // comment above — hence the string cast rather than a plain literal comparison.
  const isGenerated = proposal.entityType === 'encounter' || (proposal.entityType as string) === 'map';

  function startEdit() {
    setDraft(JSON.stringify(proposal.payload, null, 2));
    setEditError(null);
    setEditing(true);
  }

  async function act(fn: (note: string, payload?: Record<string, unknown>) => void, withPayload: boolean) {
    let payload: Record<string, unknown> | undefined;
    if (withPayload && editing) {
      try {
        const parsed = JSON.parse(draft);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Payload must be a JSON object.');
        }
        payload = parsed as Record<string, unknown>;
      } catch (err) {
        setEditError(err instanceof Error ? err.message : 'Invalid JSON.');
        return;
      }
    }
    setBusy(true);
    try {
      fn(note.trim(), payload);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-2.5">
      <div className="flex items-start gap-2.5">
        <input
          type="checkbox"
          className="mt-1.5"
          checked={selected}
          onChange={onSelectChange}
          aria-label={`Select proposal ${proposal.id}`}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="card-title text-[15px] m-0">
              <EntityTitle slug={iconFor(proposal.entityType)}>{proposalTitle(proposal)}</EntityTitle>
            </p>
            {isDelete && <Chip variant="proposal">delete</Chip>}
            {isAi && <Chip variant="ai"><span className="inline-flex items-center gap-1"><GameIcon slug="robot-golem" size={12} /> drafted by AI</span></Chip>}
            <Chip variant="proposal">{proposal.proposer}</Chip>
          </div>
          <p className="text-muted text-xs m-0 mt-0.5">
            {actionVerb[proposal.action]} {proposal.entityType}
            {href ? (
              <>
                {' '}
                · <Link to={href} className="text-purple-400 hover:underline">view target</Link>
              </>
            ) : null}
            {' '}· {timeAgo(proposal.createdAt)}
          </p>
          {isAi && (
            <p className="text-[11px] m-0 mt-1" style={{ color: 'var(--color-accent-2-300)' }}>
              AI-drafted — review closely before approving.{' '}
              {isGenerated
                ? 'Approving re-runs the generator with the pinned seed shown below.'
                : `Approving creates the ${proposal.entityType} through the normal write path.`}
            </p>
          )}
        </div>
      </div>

      {isDelete ? (
        <DeleteView snapshot={proposal.snapshot} />
      ) : editing ? (
        <div className="space-y-1">
          <textarea
            className="w-full text-[12px] font-mono bg-[var(--color-surface-2,#1a1b26)] border border-[var(--color-divider)] rounded-[var(--radius-md)] p-2.5 min-h-[140px] text-slate-200"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
          />
          {editError && <p className="text-[11px] text-red-400 m-0">{editError}</p>}
          <p className="text-[10px] text-slate-600 m-0">Edit the proposed payload (JSON) before approving.</p>
        </div>
      ) : (
        <DiffView payload={proposal.payload} snapshot={proposal.snapshot} />
      )}

      {expanded && (
        <TextInput
          className="!min-h-0 !py-2 text-sm"
          placeholder="Optional note…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      )}

      <div className="flex items-center gap-2 justify-end flex-wrap">
        <button type="button" className="text-[11px] text-slate-500 hover:text-white mr-auto" onClick={onToggle}>
          {expanded ? 'Hide note field' : '+ note'}
        </button>
        {canEdit && (
          <button
            type="button"
            className="text-[11px] text-slate-500 hover:text-white"
            onClick={() => (editing ? setEditing(false) : startEdit())}
          >
            {editing ? 'Cancel edit' : 'Edit payload'}
          </button>
        )}
        <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => act(onReject, false)} disabled={busy}>
          Reject
        </Btn>
        <Btn className="!min-h-0 !py-1.5 text-xs" onClick={() => act(onApprove, true)} disabled={busy}>
          {editing ? 'Approve edited' : 'Approve'}
        </Btn>
      </div>
    </Card>
  );
}

/** Delete proposals carry no payload — show the snapshot of what would be removed. */
function DeleteView({ snapshot }: { snapshot: Record<string, unknown> | null }) {
  if (snapshot === null) {
    return <p className="text-xs text-slate-500">This entity will be permanently deleted.</p>;
  }
  const entries = Object.entries(snapshot).filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && v.length === 0));
  return (
    <div className="border border-[var(--color-divider)] rounded-[var(--radius-md)] overflow-hidden">
      <div className="px-3 py-1.5 text-[11px] text-red-400 border-b border-[var(--color-divider)]">Will be deleted</div>
      {entries.slice(0, 8).map(([key, value], i) => (
        <div
          key={key}
          className="flex gap-2.5 px-3 py-2 text-[12.5px] items-baseline"
          style={i > 0 ? { borderTop: '1px solid var(--color-divider)' } : undefined}
        >
          <span className="text-muted w-[86px] shrink-0 text-[11px]">{key}</span>
          <span className="line-through text-slate-500 whitespace-pre-wrap break-all">{formatValue(value)}</span>
        </div>
      ))}
    </div>
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

/**
 * Proposer self-view (issue #124) — /c/:id/proposals for a non-DM member. Lists
 * only the proposals THEY submitted (the server scopes it), so a player who
 * suggests a change can see whether it's still pending, was approved/rejected
 * (with the DM's note), or was withdrawn — and can withdraw a still-pending one.
 */
function MyProposalsView({ campaignId }: { campaignId: number }) {
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const rows = await api.get<Proposal[]>(`${API}/campaigns/${campaignId}/proposals`);
      setProposals(rows);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load your proposals.");
    }
  }, [campaignId]);

  useEffect(() => {
    if (Number.isFinite(campaignId)) void load();
  }, [campaignId, load]);

  async function withdraw(id: number) {
    setBusyId(id);
    setError(null);
    try {
      await api.post(`${API}/proposals/${id}/withdraw`, {});
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't withdraw this proposal.");
    } finally {
      setBusyId(null);
    }
  }

  const pending = (proposals ?? []).filter((p) => p.status === 'pending');
  const resolved = (proposals ?? []).filter((p) => p.status !== 'pending');

  return (
    <div className="max-w-3xl mx-auto px-4 mt-5 space-y-3 pb-20 md:pb-10" style={{ maxWidth: 760 }}>
      <h1 className="text-xl font-extrabold text-white m-0">My proposals</h1>
      <p className="text-muted text-xs m-0">
        Changes you suggest to the DM land here. Nothing touches the campaign until the DM approves it — you can
        withdraw anything that's still pending.
      </p>

      {error && <ErrorNote message={error} onRetry={load} />}

      {proposals === null ? (
        <Card>
          <Skeleton lines={4} />
        </Card>
      ) : proposals.length === 0 ? (
        <EmptyState
          icon="crystal-ball"
          title="You haven't proposed anything yet"
          hint="Use “Suggest to the DM” on a quest, NPC, or location to send a change here for approval."
        />
      ) : (
        <>
          {pending.length > 0 && (
            <section className="space-y-3">
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">Pending</p>
              {pending.map((p) => (
                <MyProposalCard
                  key={p.id}
                  proposal={p}
                  campaignId={campaignId}
                  busy={busyId === p.id}
                  onWithdraw={() => withdraw(p.id)}
                />
              ))}
            </section>
          )}
          {resolved.length > 0 && (
            <section className="space-y-2">
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">Resolved</p>
              {resolved.map((p) => (
                <HistoryRow key={p.id} proposal={p} />
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** A single pending proposal in the proposer's self-view, with a withdraw action (#124). */
function MyProposalCard({
  proposal,
  campaignId,
  busy,
  onWithdraw,
}: {
  proposal: Proposal;
  campaignId: number;
  busy: boolean;
  onWithdraw: () => void;
}) {
  const href = proposalTargetHref(campaignId, proposal);
  const isDelete = proposal.action === 'delete';
  return (
    <Card className="space-y-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <p className="card-title text-[15px] m-0">
          <EntityTitle slug={iconFor(proposal.entityType)}>{proposalTitle(proposal)}</EntityTitle>
        </p>
        <Chip variant="proposal">pending</Chip>
      </div>
      <p className="text-muted text-xs m-0">
        {actionVerb[proposal.action]} {proposal.entityType}
        {href ? (
          <>
            {' '}
            · <Link to={href} className="text-purple-400 hover:underline">view target</Link>
          </>
        ) : null}
        {' '}· {timeAgo(proposal.createdAt)}
      </p>
      {isDelete ? <DeleteView snapshot={proposal.snapshot} /> : <DiffView payload={proposal.payload} snapshot={proposal.snapshot} />}
      <div className="flex items-center justify-end">
        <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={onWithdraw} disabled={busy}>
          Withdraw
        </Btn>
      </div>
    </Card>
  );
}

function HistoryRow({ proposal }: { proposal: Proposal }) {
  const approved = proposal.status === 'approved';
  // Rejected (a DM decision, carries a note) and withdrawn (the proposer pulled it)
  // are both neutral outcomes; only an approval is accented.
  const label =
    proposal.status === 'rejected'
      ? `Rejected${proposal.note ? ` — ${proposal.note}` : ''}`
      : proposal.status === 'withdrawn'
        ? 'Withdrawn'
        : 'Approved';
  return (
    <div className="cf-card p-3.5 flex items-center justify-between gap-2 opacity-70">
      <p className="text-sm text-slate-400 m-0">
        <EntityTitle slug={iconFor(proposal.entityType)}>{proposalTitle(proposal)}</EntityTitle>{' '}
        {isAiProposal(proposal) && <Chip variant="ai" className="mx-1"><span className="inline-flex items-center gap-1"><GameIcon slug="robot-golem" size={12} /> AI</span></Chip>}
        <span className="text-slate-600">· {proposal.proposer}</span>
      </p>
      <span className={`tag ${approved ? 'tag-accent' : 'tag-neutral'}`}>{label}</span>
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
