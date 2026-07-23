import { Link } from 'react-router-dom';
import type { Character } from '@campfire/schema';
import { EmptyState } from '../../components/ui';
import { StatusTag } from '../characters/status';
import { initials } from '../../lib/avatarText';

export function PartyCard({ campaignId, characters }: { campaignId: number; characters: Character[] }) {
  return (
    <div className="card elev-sm">
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <span className="card-kicker">Party</span>
        <div style={{ flex: 1 }} />
        <Link to={`/c/${campaignId}/party`} className="btn btn-ghost" style={{ fontSize: 12 }}>
          Roster →
        </Link>
      </div>
      {characters.length === 0 ? (
        <EmptyState icon="shield" title="No characters yet" />
      ) : (
        characters.map((c) => {
          const pct = c.hpMax > 0 ? Math.max(0, Math.min(100, (c.hpCurrent / c.hpMax) * 100)) : 0;
          // Mute dead/retired/inactive PCs so the live party stands out (issue #115).
          const isActive = c.status === 'active';
          return (
            <Link
              key={c.id}
              to={`/c/${campaignId}/characters/${c.id}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                color: 'var(--color-text)',
                textDecoration: 'none',
                cursor: 'pointer',
                padding: '6px 0',
                minHeight: 44,
                opacity: isActive ? 1 : 0.6,
              }}
            >
              <span
                style={{
                  width: 34,
                  height: 34,
                  flex: 'none',
                  borderRadius: '50%',
                  background: 'var(--color-accent-900)',
                  color: 'var(--color-accent-200)',
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: 12,
                  fontWeight: 500,
                }}
              >
                {initials(c.name)}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13.5 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                    {!isActive && <StatusTag status={c.status} />}
                  </span>
                  <span className="text-muted" style={{ fontSize: 'var(--type-meta)', flex: 'none' }}>
                    {c.hpCurrent}/{c.hpMax}
                  </span>
                </span>
                <span
                  style={{
                    display: 'block',
                    height: 4,
                    borderRadius: 2,
                    background: 'var(--color-neutral-800)',
                    marginTop: 5,
                    overflow: 'hidden',
                  }}
                >
                  <span
                    style={{
                      display: 'block',
                      height: '100%',
                      borderRadius: 2,
                      background: 'var(--color-accent)',
                      width: `${pct}%`,
                    }}
                  />
                </span>
                {c.conditions.length > 0 && (
                  <span style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                    {c.conditions.map((cond) => (
                      <span key={cond} className="tag tag-neutral">
                        {cond}
                      </span>
                    ))}
                  </span>
                )}
              </span>
            </Link>
          );
        })
      )}
    </div>
  );
}
