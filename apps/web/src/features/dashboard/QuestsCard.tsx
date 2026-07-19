import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { CampaignSummary, QuestObjective, Role } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { Chip, statusVariant } from '../../components/ui';
import { EmptyState } from '../../components/ui';

type QuestWithObjectives = CampaignSummary['quests'][number];

export function QuestsCard({
  campaignId,
  quests,
  role,
  onChange,
}: {
  campaignId: number;
  quests: QuestWithObjectives[];
  role: Role | null;
  onChange: () => void;
}) {
  const isDm = role === 'dm';
  const canTick = role === 'dm' || role === 'player';
  const [pending, setPending] = useState<Record<number, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [localObjectives, setLocalObjectives] = useState<Record<number, boolean>>({});

  const roots = quests.filter((q) => q.parentId == null);
  const childrenOf = (parentId: number) => quests.filter((q) => q.parentId === parentId);

  async function toggleObjective(obj: QuestObjective, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
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

  function renderQuest(q: QuestWithObjectives, depth: number) {
    const kids = childrenOf(q.id);
    const titleColor =
      q.status === 'completed' ? 'text-emerald-400' : q.status === 'active' ? 'text-white' : 'text-slate-300';
    const isFaded = q.status === 'completed';

    return (
      <div key={q.id} className={depth > 0 ? 'pl-4 border-l border-slate-700' : ''}>
        <Link
          to={`/c/${campaignId}/quests/${q.id}`}
          className={`block cf-inset p-4 space-y-3 hover:border-amber-500/50 ${isFaded ? 'opacity-60' : ''}`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <p className={`font-bold ${titleColor}`}>
                {depth > 0 && <span className="text-rose-400">↳ </span>}
                {q.title} <Chip variant={statusVariant(q.status)} className="ml-1">{q.status}</Chip>
              </p>
              {q.body && <p className="text-xs text-slate-400">{q.body.split('\n')[0]}</p>}
            </div>
            {q.reward && <span className="text-xs font-bold text-amber-500 whitespace-nowrap">{q.reward}</span>}
          </div>
          {q.objectives.length > 0 && (
            <div className="space-y-1.5 text-sm">
              {q.objectives.map((obj) => {
                const done = localObjectives[obj.id] ?? obj.done;
                return (
                  <label key={obj.id} className="flex items-center gap-2.5 text-slate-300">
                    <input
                      type="checkbox"
                      checked={done}
                      disabled={!canTick || pending[obj.id]}
                      onClick={(e) => toggleObjective(obj, e)}
                      onChange={() => {}}
                      className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-amber-500"
                    />
                    {done ? <s className="opacity-60">{obj.text}</s> : obj.text}
                  </label>
                );
              })}
            </div>
          )}
        </Link>
        {kids.map((kid) => renderQuest(kid, depth + 1))}
      </div>
    );
  }

  return (
    <section id="quests" className="cf-card p-5 space-y-4 scroll-mt-16">
      <div className="flex items-center justify-between border-b border-slate-700 pb-3">
        <h2 className="font-bold text-white flex items-center gap-2">
          <span className="text-amber-500">📜</span> Quests
        </h2>
        {isDm && (
          <Link to={`/c/${campaignId}/quests/new`} className="cf-btn-ghost cf-btn !min-h-0 !py-1.5 text-xs">
            + New quest
          </Link>
        )}
      </div>
      {error && <p className="text-xs text-rose-400">{error}</p>}
      {roots.length === 0 ? (
        <EmptyState icon="📜" title="No quests yet" hint={isDm ? 'Start one with "+ New quest".' : 'Check back after the next session.'} />
      ) : (
        roots.map((q) => renderQuest(q, 0))
      )}
    </section>
  );
}
