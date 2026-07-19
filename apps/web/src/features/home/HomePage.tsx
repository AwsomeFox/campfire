/**
 * Campaign picker — landing page for authenticated users. Grid of campaign
 * tiles plus a create-campaign card. Any user may create a campaign.
 */
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../app/auth';
import { useCampaigns } from '../../app/CampaignContext';
import { api, ApiError, API } from '../../lib/api';
import { Card, Chip, statusVariant, Btn, TextInput, TextArea, EmptyState, Skeleton, ErrorNote } from '../../components/ui';
import type { Campaign } from '@campfire/schema';

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
        className="cf-inset border-dashed p-5 flex flex-col items-center justify-center gap-2 text-center hover:border-amber-500/50 min-h-[160px]"
      >
        <span className="text-2xl">🔥</span>
        <span className="text-sm font-semibold text-slate-300">New campaign</span>
      </button>
    );
  }

  return (
    <Card>
      <form onSubmit={onSubmit} className="space-y-3">
        <div className="space-y-1">
          <label className="text-xs text-slate-400 font-semibold" htmlFor="cname">
            Campaign name
          </label>
          <TextInput id="cname" value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-slate-400 font-semibold" htmlFor="cdesc">
            Description <span className="text-slate-600 font-normal">(optional)</span>
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
    <div className="max-w-6xl mx-auto px-4 mt-8 space-y-6 pb-10">
      <div className="space-y-1">
        <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">Campfire</p>
        <h1 className="text-2xl md:text-3xl font-extrabold text-white tracking-tight">Your campaigns</h1>
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
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {allCampaigns.map((campaign) => {
            const role = roleIn(campaign.id);
            return (
              <button
                key={campaign.id}
                onClick={() => navigate(`/c/${campaign.id}`)}
                className="cf-card p-5 text-left space-y-3 hover:border-amber-500/50 transition-colors"
              >
                <div className="flex items-start justify-between gap-2">
                  <h2 className="font-bold text-white truncate">{campaign.name}</h2>
                  <Chip variant={statusVariant(campaign.status)}>{campaign.status}</Chip>
                </div>
                {campaign.description && (
                  <p className="text-xs text-slate-400 line-clamp-2">{campaign.description}</p>
                )}
                <div className="flex items-center justify-between pt-1">
                  <span className="text-[11px] text-slate-500 font-semibold">
                    Session {campaign.sessionCount}
                  </span>
                  {role && (
                    <Chip variant="dm">{role === 'dm' ? 'DM' : role === 'player' ? 'Player' : 'Viewer'}</Chip>
                  )}
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
