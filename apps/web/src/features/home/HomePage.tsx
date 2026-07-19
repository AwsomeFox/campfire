/**
 * Campaign picker — landing page for authenticated users, styled after the
 * design's "Campaign hub" screen (card grid with cover strip + dashed
 * "New campaign" tile). Grid of campaign tiles plus a create-campaign card.
 * Any user may create a campaign.
 */
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../app/auth';
import { useCampaigns } from '../../app/CampaignContext';
import { api, ApiError, API } from '../../lib/api';
import { Card, Chip, statusVariant, Btn, TextInput, TextArea, EmptyState, Skeleton, ErrorNote } from '../../components/ui';
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

function CreateCampaignCard({ onCreated }: { onCreated: (campaign: Campaign) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError('Give your campaign a name.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const campaign = await api.post<Campaign>(`${API}/campaigns`, {
        name: name.trim(),
        description: description.trim() || undefined,
      });
      onCreated(campaign);
      setName('');
      setDescription('');
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create campaign.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
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

  return (
    <Card>
      <form onSubmit={onSubmit} className="space-y-3">
        <div className="field">
          <label htmlFor="cname">Campaign name</label>
          <TextInput id="cname" value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        </div>
        <div className="field">
          <label htmlFor="cdesc">
            Description <span className="text-muted" style={{ textTransform: 'none', letterSpacing: 0 }}>· optional</span>
          </label>
          <TextArea
            id="cdesc"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        {error && <p className="text-sm text-rose-400">{error}</p>}
        <div className="flex gap-2">
          <Btn ghost type="button" className="flex-1" onClick={() => setOpen(false)}>
            Cancel
          </Btn>
          <Btn type="submit" className="flex-1" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create'}
          </Btn>
        </div>
      </form>
    </Card>
  );
}

export function HomePage() {
  const { roleIn } = useAuth();
  const { campaigns, loading, refresh } = useCampaigns();
  const navigate = useNavigate();
  const [justCreated, setJustCreated] = useState<Campaign[]>([]);

  const allCampaigns = [...campaigns, ...justCreated.filter((c) => !campaigns.some((x) => x.id === c.id))];

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
          <CreateCampaignCard
            onCreated={(c) => {
              setJustCreated((prev) => [...prev, c]);
              void refresh();
              navigate(`/c/${c.id}`);
            }}
          />
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
          <CreateCampaignCard
            onCreated={(c) => {
              setJustCreated((prev) => [...prev, c]);
              void refresh();
              navigate(`/c/${c.id}`);
            }}
          />
        </div>
      )}
    </div>
  );
}
