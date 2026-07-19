import { Link } from 'react-router-dom';
import type { Npc } from '@campfire/schema';
import { EmptyState } from '../../components/ui';

const DISPOSITION_COLOR: Record<string, string> = {
  friendly: 'text-emerald-400',
  hostile: 'text-rose-400',
  wary: 'text-purple-400',
  neutral: 'text-slate-200',
};

function nameColor(disposition: string): string {
  return DISPOSITION_COLOR[disposition.toLowerCase()] ?? 'text-slate-200';
}

export function NpcGrid({ campaignId, npcs }: { campaignId: number; npcs: Npc[] }) {
  return (
    <section className="cf-card p-5 space-y-4">
      <div className="flex items-center justify-between border-b border-slate-700 pb-3">
        <h2 className="font-bold text-white flex items-center gap-2">🤝 NPCs</h2>
        <Link to={`/c/${campaignId}/npcs`} className="text-xs text-slate-400 hover:text-white">
          All NPCs →
        </Link>
      </div>
      {npcs.length === 0 ? (
        <EmptyState icon="🤝" title="No NPCs yet" />
      ) : (
        <div className="grid sm:grid-cols-2 gap-3">
          {npcs.map((npc) => (
            <Link
              key={npc.id}
              to={`/c/${campaignId}/npcs/${npc.id}`}
              className="cf-inset p-3.5 space-y-1 hover:border-amber-500/50"
            >
              <div className="flex items-center justify-between">
                <p className={`font-bold text-sm ${nameColor(npc.disposition)}`}>{npc.name}</p>
                <span className="cf-chip cf-chip-available">{npc.disposition}</span>
              </div>
              <p className="text-[11px] text-slate-500">{npc.role}</p>
              {npc.body && <p className="text-xs text-slate-400">{npc.body.split('\n')[0]}</p>}
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
