/**
 * Campaign dashboard — the home screen for a campaign.
 * Mirrors design/02-dashboard.html structure/classes; see README-less DoD notes in PR.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { CampaignSummary, Encounter } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useCampaignEvents } from '../../lib/useCampaignEvents';
import { usePollWhileVisible } from '../../lib/usePollWhileVisible';
import { useAuth } from '../../app/auth';
import { useCampaigns } from '../../app/CampaignContext';
import { useCampaignAccessError } from '../../app/useCampaignAccessError';
import { Card, Skeleton, ErrorNote } from '../../components/ui';
import { StatusHeader } from './StatusHeader';
import { InstallHintBanner } from './InstallHintBanner';
import { RegionMap } from './RegionMap';
import { QuestsCard } from './QuestsCard';
import { NpcGrid } from './NpcGrid';
import { PartyCard } from './PartyCard';
import { SessionLog } from './SessionLog';
import { NotesQuickRail } from './NotesQuickRail';
import { DiceWidget } from './DiceWidget';
import { HandoutsCard } from './HandoutsCard';

// Slow poll so the summary (quests, party HP, notes, NPCs) picks up other
// players' edits at the table without a manual reload; SSE only covers combat.
const POLL_MS = 5000;

export default function DashboardPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const id = Number(campaignId);
  const { roleIn } = useAuth();
  const role = roleIn(id);
  const { refresh: refreshCampaigns } = useCampaigns();
  const { lostAccess, handle: handleAccessError } = useCampaignAccessError();

  const [summary, setSummary] = useState<CampaignSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [liveEncounter, setLiveEncounter] = useState<Encounter | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<CampaignSummary>(`${API}/campaigns/${id}/summary`);
      setSummary(data);
      // Keep the sidebar/topbar/Home tiles in sync — StatusHeader can rename the
      // campaign from here, and CampaignContext is the shared source for its name.
      void refreshCampaigns();
    } catch (err) {
      if (!handleAccessError(err)) {
        setError(err instanceof ApiError ? err.message : "Couldn't load the campaign dashboard.");
      }
    } finally {
      setLoading(false);
    }
  }, [id, refreshCampaigns, handleAccessError]);

  useEffect(() => {
    if (Number.isFinite(id)) void load();
  }, [id, load]);

  // Keep the summary live while the tab is open (issue #113): the quest/party/notes
  // cards have no SSE event, so poll them ~5s and pause when the tab is hidden.
  usePollWhileVisible(() => void load(), POLL_MS, Number.isFinite(id));

  // Check for a running encounter to surface a "Live" chip.
  // Best-effort: an empty/failed lookup just means no chip, not a page error.
  const refreshLiveEncounter = useCallback(async () => {
    if (!Number.isFinite(id)) return;
    try {
      const running = await api.get<Encounter[]>(`${API}/campaigns/${id}/encounters?status=running`);
      setLiveEncounter(running[0] ?? null);
    } catch {
      setLiveEncounter(null);
    }
  }, [id]);

  useEffect(() => {
    if (summary) void refreshLiveEncounter();
  }, [summary, refreshLiveEncounter]);

  // Live updates over SSE (replaces polling, issue #4): keep the "Live" chip in sync
  // the moment the DM starts/ends/deletes an encounter, without a manual reload.
  useCampaignEvents(Number.isFinite(id) ? id : undefined, {
    onEvent: useCallback(() => void refreshLiveEncounter(), [refreshLiveEncounter]),
    onReconnect: useCallback(() => void refreshLiveEncounter(), [refreshLiveEncounter]),
  });

  if (!Number.isFinite(id)) {
    return (
      <div className="max-w-7xl mx-auto px-4 mt-5">
        <ErrorNote message="No campaign selected." />
      </div>
    );
  }

  if (lostAccess) {
    return (
      <div className="max-w-7xl mx-auto px-4 mt-5">
        <Card className="text-center space-y-2">
          <p className="text-2xl">🔒</p>
          <p className="font-bold text-white">You no longer have access to this campaign</p>
          <Link to="/" className="btn btn-primary" style={{ display: 'inline-flex', marginTop: 4 }}>
            Back to your campaigns
          </Link>
        </Card>
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

      <StatusHeader campaignId={id} summary={summary} role={role} onChange={load} liveEncounter={liveEncounter} />

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
          <HandoutsCard campaignId={id} role={role} />
          <DiceWidget campaignId={id} />
          <NotesQuickRail campaignId={id} openInboxCount={summary.openInboxCount} role={role} />
        </div>
      </div>

      <p className="text-[11px] text-slate-600 pb-4">
        Players can tick objectives and edit their own character; viewers can read and leave notes.
      </p>
    </div>
  );
}
