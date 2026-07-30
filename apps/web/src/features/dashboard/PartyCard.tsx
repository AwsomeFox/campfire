import { Link } from 'react-router-dom';
import { ListDetailLink } from '../../components/ListDetailLink';
import type { PartyCharacter } from '@campfire/schema';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import { EmptyState, Card } from '../../components/ui';
import { StatusTag } from '../characters/status';
import { initials } from '../../lib/avatarText';

export function PartyCard({
  campaignId,
  characters,
  accessibleCharacterIds,
}: {
  campaignId: number;
  characters: PartyCharacter[];
  /** Full sheets returned by the server to this caller; teammates are roster-only. */
  accessibleCharacterIds: ReadonlySet<number>;
}) {
  const { canPlayerWrite, canDmWrite } = useCampaignAccess();
  const canCreate = canPlayerWrite || canDmWrite;

  return (
    <Card density="compact" elev="sm">
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <span className="card-kicker">Party</span>
        <div style={{ flex: 1 }} />
        <Link to={`/c/${campaignId}/party`} className="btn btn-ghost btn-density-compact" style={{ fontSize: 12 }}>
          Roster →
        </Link>
      </div>
      {characters.length === 0 ? (
        <EmptyState
          icon="shield"
          title="No characters yet"
          hint={canCreate ? 'Add player characters to track party HP, conditions, and stats.' : 'Party members and their stats will appear here once added.'}
          action={
            canCreate ? (
              <Link to={`/c/${campaignId}/party?action=new`} className="btn btn-primary" style={{ fontSize: 13, gap: 6 }}>
                + Add party member
              </Link>
            ) : undefined
          }
        />
      ) : (
        characters.map((c) => {
          const pct = c.hpMax > 0 ? Math.max(0, Math.min(100, (c.hpCurrent / c.hpMax) * 100)) : 0;
          // Mute dead/retired/inactive PCs so the live party stands out (issue #115).
          const isActive = c.status === 'active';
          const rowStyle = {
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            color: isActive ? 'var(--color-text)' : 'var(--color-text-disabled)',
            textDecoration: 'none',
            cursor: accessibleCharacterIds.has(c.id) ? 'pointer' : 'default',
            padding: '6px 0',
            minHeight: 44,
          } as const;
          const contents = (
            <>
              {c.portraitUrl ? (
                <img
                  src={c.portraitUrl}
                  alt=""
                  style={{
                    width: 34,
                    height: 34,
                    flex: 'none',
                    borderRadius: '50%',
                    objectFit: 'cover',
                    border: '1px solid var(--color-neutral-700)',
                  }}
                />
              ) : (
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
              )}
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13.5 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                    {!isActive && <StatusTag status={c.status} />}
                  </span>
                  <span className={isActive ? 'text-muted' : 'text-disabled'} style={{ fontSize: 'var(--type-meta)', flex: 'none' }}>
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
            </>
          );
          return accessibleCharacterIds.has(c.id) ? (
            <ListDetailLink key={c.id} to={`/c/${campaignId}/characters/${c.id}`} style={rowStyle}>
              {contents}
            </ListDetailLink>
          ) : (
            <div key={c.id} style={rowStyle} aria-label={`${c.name}, roster entry`}>
              {contents}
            </div>
          );
        })
      )}
    </Card>
  );
}
