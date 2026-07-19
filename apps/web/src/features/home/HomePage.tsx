/**
 * Campaign picker — landing page for authenticated users, styled after the
 * design's "Campaign hub" screen (card grid with cover strip + dashed
 * "New campaign" tile). Grid of campaign tiles plus a create-campaign tile
 * that launches the full NewCampaignWizard overlay (details -> rule system
 * -> POST + PATCH ruleSystem). Any user may create a campaign.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../app/auth';
import { useCampaigns } from '../../app/CampaignContext';
import { Card, Chip, statusVariant, EmptyState, Skeleton } from '../../components/ui';
import { NewCampaignWizard } from './NewCampaignWizard';
import type { Campaign } from '@campfire/schema';

/** Deterministic cover gradient per campaign, echoing the design's cc.cover swatches. */
const COVERS = [
  'linear-gradient(135deg, var(--color-accent-800), var(--color-accent-600))',
  'linear-gradient(135deg, var(--color-accent-2-800), var(--color-accent-2-600))',
  'linear-gradient(135deg, var(--color-neutral-800), var(--color-neutral-600))',
  'linear-gradient(135deg, #1f3d38, #2f6f5e)',
  'linear-gradient(135deg, #3a2a4a, #6c4f8f)',
];

function coverFor(id: number): string {
  return COVERS[id % COVERS.length];
}

function NewCampaignTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center justify-center gap-2 text-center"
      style={{
        border: '1px dashed var(--color-neutral-700)',
        borderRadius: 'var(--radius-lg)',
        background: 'transparent',
        color: 'var(--color-neutral-400)',
        minHeight: 220,
        fontSize: 13,
      }}
    >
      <span
        className="grid place-items-center rounded-full text-lg"
        style={{ width: 34, height: 34, border: '1px dashed var(--color-neutral-700)' }}
      >
        +
      </span>
      New campaign
    </button>
  );
}

export function HomePage() {
  const { roleIn } = useAuth();
  const { campaigns, loading, refresh } = useCampaigns();
  const navigate = useNavigate();
  const [justCreated, setJustCreated] = useState<Campaign[]>([]);
  const [wizardOpen, setWizardOpen] = useState(false);

  const allCampaigns = [...campaigns, ...justCreated.filter((c) => !campaigns.some((x) => x.id === c.id))];

  function onCampaignCreated(c: Campaign) {
    setJustCreated((prev) => [...prev, c]);
    void refresh();
    setWizardOpen(false);
    navigate(`/c/${c.id}`);
  }

  if (wizardOpen) {
    return <NewCampaignWizard onClose={() => setWizardOpen(false)} onCreated={onCampaignCreated} />;
  }

  return (
    <div className="w-full max-w-[960px] mx-auto px-5 pt-7 pb-12 flex flex-col gap-4.5">
      <div>
        <h3 style={{ margin: 0 }}>Your campaigns</h3>
        <p className="text-muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
          Everything on this server, one sign-in. Roles are per campaign.
        </p>
      </div>

      {loading ? (
        <Card>
          <Skeleton lines={4} />
        </Card>
      ) : allCampaigns.length === 0 ? (
        <div className="max-w-md space-y-4">
          <EmptyState icon="🕯️" title="No campaigns yet — light the first fire." />
          <p className="text-muted" style={{ fontSize: 12.5, margin: 0 }}>
            New here as a player? Ask your DM or the server admin to add your account to a campaign — no need to
            create one.
          </p>
          <NewCampaignTile onClick={() => setWizardOpen(true)} />
        </div>
      ) : (
        <div
          className="grid gap-3.5"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(270px, 1fr))' }}
        >
          {allCampaigns.map((campaign) => {
            const role = roleIn(campaign.id);
            return (
              <button
                key={campaign.id}
                onClick={() => navigate(`/c/${campaign.id}`)}
                className="card elev-sm text-left overflow-hidden"
                style={{ padding: 0, gap: 0 }}
              >
                <div
                  className="h-[88px] grid place-items-center"
                  style={{ background: coverFor(campaign.id) }}
                >
                  <span
                    style={{ fontFamily: 'var(--font-heading)', fontSize: 30, color: 'var(--color-accent-100)' }}
                  >
                    {campaign.name.charAt(0).toUpperCase()}
                  </span>
                </div>
                <div className="flex flex-col gap-2.5" style={{ padding: '14px 16px 16px' }}>
                  <div>
                    <div className="card-title" style={{ fontSize: 16 }}>{campaign.name}</div>
                    <div className="flex gap-1.5 flex-wrap" style={{ marginTop: 6 }}>
                      <Chip variant={statusVariant(campaign.status)}>{campaign.status}</Chip>
                      {role && (
                        <Chip variant="dm">{role === 'dm' ? 'DM' : role === 'player' ? 'Player' : 'Viewer'}</Chip>
                      )}
                    </div>
                  </div>
                  {campaign.description && (
                    <p className="text-muted line-clamp-2" style={{ fontSize: 11.5, margin: 0 }}>
                      {campaign.description}
                    </p>
                  )}
                  <div className="text-muted" style={{ fontSize: 11.5 }}>
                    Session {campaign.sessionCount}
                  </div>
                </div>
              </button>
            );
          })}
          <NewCampaignTile onClick={() => setWizardOpen(true)} />
        </div>
      )}
    </div>
  );
}
