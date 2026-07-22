import { Link } from 'react-router-dom';
import type { Npc } from '@campfire/schema';
import { EmptyState } from '../../components/ui';
import { NpcDispositionBadge } from '../../components/EntitySemanticBadges';

export function NpcGrid({ campaignId, npcs }: { campaignId: number; npcs: Npc[] }) {
  return (
    <div className="card elev-sm">
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <span className="card-kicker">NPCs</span>
        <div style={{ flex: 1 }} />
        <Link to={`/c/${campaignId}/npcs`} className="btn btn-ghost" style={{ fontSize: 12 }}>
          NPCs →
        </Link>
      </div>
      {npcs.length === 0 ? (
        <EmptyState icon="hooded-figure" title="No NPCs yet" />
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
              <span style={{ fontSize: 13.5 }}>
                {npc.name}
              </span>
              <span className="text-muted" style={{ display: 'block', fontSize: 'var(--type-meta)' }}>
                {npc.role}
              </span>
            </span>
            <NpcDispositionBadge disposition={npc.disposition} className="flex-none" />
          </Link>
        ))
      )}
    </div>
  );
}
