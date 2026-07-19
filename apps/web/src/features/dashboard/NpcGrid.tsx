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
    <div className="card elev-sm">
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <span className="card-kicker">NPCs</span>
        <div style={{ flex: 1 }} />
        <Link to={`/c/${campaignId}/npcs`} className="btn btn-ghost" style={{ fontSize: 12 }}>
          World →
        </Link>
      </div>
      {npcs.length === 0 ? (
        <EmptyState icon="🤝" title="No NPCs yet" />
      ) : (
        npcs.map((npc) => (
          <Link
            key={npc.id}
            to={`/c/${campaignId}/npcs/${npc.id}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              color: 'var(--color-text)',
              textDecoration: 'none',
              cursor: 'pointer',
              padding: '6px 0',
              minHeight: 44,
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className={nameColor(npc.disposition)} style={{ fontSize: 13.5 }}>
                {npc.name}
              </span>
              <span className="text-muted" style={{ display: 'block', fontSize: 11 }}>
                {npc.role}
              </span>
            </span>
            <span className="tag tag-neutral" style={{ fontSize: 10, flex: 'none' }}>
              {npc.disposition}
            </span>
          </Link>
        ))
      )}
    </div>
  );
}
