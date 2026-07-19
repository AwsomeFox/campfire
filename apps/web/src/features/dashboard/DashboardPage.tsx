/**
 * Campaign dashboard — the home screen for a campaign.
 * Mirrors design/02-dashboard.html structure/classes; see README-less DoD notes in PR.
 */
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { CampaignSummary } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Card, Skeleton, ErrorNote } from '../../components/ui';
import { StatusHeader } from './StatusHeader';
import { InstallHintBanner } from './InstallHintBanner';
import { RegionMap } from './RegionMap';
import { QuestsCard } from './QuestsCard';
import { NpcGrid } from './NpcGrid';
import { PartyCard } from './PartyCard';
import { SessionLog } from './SessionLog';
import { NotesQuickRail } from './NotesQuickRail';

export default function DashboardPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const id = Number(campaignId);
  const { roleIn } = useAuth();
  const role = roleIn(id);

  const [summary, setSummary] = useState<CampaignSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<CampaignSummary>(`${API}/campaigns/${id}/summary`);
      setSummary(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load the campaign dashboard.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (Number.isFinite(id)) void load();
  }, [id, load]);

  if (!Number.isFinite(id)) {
    return (
      <div className="max-w-7xl mx-auto px-4 mt-5">
        <ErrorNote message="No campaign selected." />
      </div>
    );
  }

  if (loading && !summary) {
    return (
      <div className="max-w-7xl mx-auto px-4 mt-5 space-y-5">
        <Card>
          <Skeleton lines={3} />
        </Card>
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <div className="lg:col-span-7 space-y-5">
            <Card>
              <Skeleton lines={5} />
            </Card>
            <Card>
              <Skeleton lines={5} />
            </Card>
          </div>
          <div className="lg:col-span-5 space-y-5">
            <Card>
              <Skeleton lines={4} />
            </Card>
          </div>
        </div>
      </div>
    );
  }

  if (error && !summary) {
    return (
      <div className="max-w-7xl mx-auto px-4 mt-5">
        <ErrorNote message={error} onRetry={load} />
      </div>
    );
  }

  if (!summary) return null;

  return (
    <div className="max-w-7xl mx-auto px-4 mt-5 pb-20 md:pb-10" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {error && <ErrorNote message={error} onRetry={load} />}

      <StatusHeader campaignId={id} summary={summary} role={role} onChange={load} />

      <InstallHintBanner />

      {/* Design: two-column grid (~7/5 split), left = map/quests/sessions, right = party/npcs/notes.
          See Campfire.dc.html ~L435-536 (dashCols). Single column below lg per design's mobile spec. */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        <div className="lg:col-span-7" style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <RegionMap campaignId={id} campaign={summary.campaign} locations={summary.locations} role={role} onChange={load} />
          <QuestsCard campaignId={id} quests={summary.quests} role={role} onChange={load} />
          <SessionLog campaignId={id} sessions={summary.sessions} />
        </div>

        <div className="lg:col-span-5" style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <PartyCard campaignId={id} characters={summary.characters} />
          <NpcGrid campaignId={id} npcs={summary.npcs} />
          <NotesQuickRail campaignId={id} openInboxCount={summary.openInboxCount} role={role} />
        </div>
      </div>

      <p className="text-[11px] text-slate-600 pb-4">
        Role degradation: <b>player</b> sees no Edit/New buttons on canon, can tick objectives, edits own character;{' '}
        <b>viewer</b> is fully read-only and keeps only the &quot;Leave a note&quot; quick-capture.
      </p>
    </div>
  );
}
