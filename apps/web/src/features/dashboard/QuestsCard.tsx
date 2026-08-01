/**
 * Dashboard "Quests" card — design/claude-design/Campfire.dc.html ~L455-480.
 * Shows root quests with their objectives + subquests inline (glyph + strike-through
 * done objectives); "All quests →" links to the Quests list/board screen.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ListDetailLink } from '../../components/ListDetailLink';
import type { CampaignSummary, QuestObjective } from '@campfire/schema';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import { api, API, ApiError } from '../../lib/api';
import { Card, EmptyState } from '../../components/ui';
import { QuestStatusBadge } from '../../components/EntitySemanticBadges';
import { Toggle } from '../../components/Toggle';

type QuestWithObjectives = CampaignSummary['quests'][number];

export function QuestsCard({
  campaignId,
  quests,
  onChange,
}: {
  campaignId: number;
  quests: QuestWithObjectives[];
  onChange: () => void;
}) {
  const { canPlayerWrite, canDmWrite } = useCampaignAccess();
  const canTick = canPlayerWrite;
  const [pending, setPending] = useState<Record<number, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [localObjectives, setLocalObjectives] = useState<Record<number, boolean>>({});

  // Cycle-robust root/child partition (#95) — see QuestListPage for the rationale.
  // Keeps quests visible even if legacy A↔B parent loops exist in the data.
  const byId = new Map(quests.map((q) => [q.id, q]));
  const isRoot = (q: QuestWithObjectives): boolean => {
    if (q.parentId == null) return true;
    const seen = new Set<number>([q.id]);
    let cur = byId.get(q.parentId);
    while (cur) {
      if (seen.has(cur.id)) return true;
      if (cur.parentId == null) return false;
      seen.add(cur.id);
      cur = byId.get(cur.parentId);
    }
    return true;
  };
  const roots = quests.filter(isRoot);
  const childrenOf = (parentId: number) => quests.filter((q) => q.parentId === parentId && !isRoot(q));

  async function toggleObjective(obj: QuestObjective) {
    if (!canTick || pending[obj.id]) return;
    const nextDone = !(localObjectives[obj.id] ?? obj.done);
    setLocalObjectives((prev) => ({ ...prev, [obj.id]: nextDone }));
    setPending((prev) => ({ ...prev, [obj.id]: true }));
    setError(null);
    try {
      await api.patch(`${API}/quests/${obj.questId}/objectives/${obj.id}`, { done: nextDone });
      onChange();
    } catch (err) {
      setLocalObjectives((prev) => ({ ...prev, [obj.id]: !nextDone }));
      setError(err instanceof ApiError ? err.message : "Couldn't update objective.");
    } finally {
      setPending((prev) => ({ ...prev, [obj.id]: false }));
    }
  }

  function renderQuest(q: QuestWithObjectives) {
    const kids = childrenOf(q.id);
    const isFaded = q.status === 'completed' || q.status === 'failed';

    return (
      <div
        key={q.id}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          padding: '9px 0',
          background:
            'linear-gradient(to right, transparent, var(--color-divider) 48px, var(--color-divider) calc(100% - 48px), transparent) no-repeat top / 100% 1px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, minHeight: 28, flexWrap: 'wrap' }}>
          <QuestStatusBadge status={q.status} />
          <ListDetailLink
            to={`/c/${campaignId}/quests/${q.id}`}
            style={{
              color: isFaded ? 'var(--color-text-disabled)' : 'var(--color-text)',
              fontSize: 14.5,
              textDecoration: 'none',
              minWidth: 0,
              textDecorationLine: q.status === 'completed' ? 'line-through' : 'none',
            }}
          >
            {q.title}
          </ListDetailLink>
          <div style={{ flex: 1 }} />
          {q.reward && (
            <span
              className="tag tag-neutral"
              style={{ fontSize: 'var(--type-label)', whiteSpace: 'normal', maxWidth: '100%', overflowWrap: 'anywhere', textAlign: 'left' }}
              title={q.reward}
            >
              {q.reward}
            </span>
          )}
        </div>
        {q.objectives.map((obj) => {
          const done = localObjectives[obj.id] ?? obj.done;
          return (
            <div key={obj.id} style={{ display: 'flex', alignItems: 'center', gap: 9, paddingLeft: 27, minHeight: 26 }}>
              <Toggle
                checked={done}
                onChange={() => toggleObjective(obj)}
                disabled={!canTick || pending[obj.id]}
                label={done ? `Mark "${obj.text}" not done` : `Mark "${obj.text}" done`}
                size={15}
              />
              <span
                style={{
                  fontSize: 13,
                  color: done ? 'var(--color-text-disabled)' : 'var(--color-neutral-300)',
                  textDecorationLine: done ? 'line-through' : 'none',
                }}
              >
                {obj.text}
              </span>
            </div>
          );
        })}
        {kids.map((s) => (
          <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 9, paddingLeft: 27, minHeight: 26 }}>
            <span className="text-muted" style={{ fontSize: 12 }}>
              ↳
            </span>
            <ListDetailLink
              to={`/c/${campaignId}/quests/${s.id}`}
              style={{ color: 'var(--color-neutral-300)', fontSize: 13, textDecoration: 'none' }}
            >
              {s.title}
            </ListDetailLink>
            <QuestStatusBadge status={s.status} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <Card density="compact" elev="sm">
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <span className="card-kicker">Quests</span>
        <div style={{ flex: 1 }} />
        <Link to={`/c/${campaignId}/quests`} className="btn btn-ghost" style={{ fontSize: 12 }}>
          All quests →
        </Link>
      </div>
      {error && <p className="text-xs text-rose-400">{error}</p>}
      {roots.length === 0 ? (
        <EmptyState
          icon="scroll-unfurled"
          title="No quests yet"
          hint={canDmWrite ? 'Track main objectives, side jobs, and rewards for the party.' : 'Active quests and objectives will appear here as the campaign progresses.'}
          action={
            canDmWrite ? (
              <Link to={`/c/${campaignId}/quests/new`} className="btn btn-primary" style={{ fontSize: 13, gap: 6 }}>
                + Create first quest
              </Link>
            ) : undefined
          }
        />
      ) : (
        roots.map((q) => renderQuest(q))
      )}
    </Card>
  );
}
