/**
 * Campaign dashboard — the home screen for a campaign.
 * Mirrors design/02-dashboard.html structure/classes; see README-less DoD notes in PR.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { CampaignSummary, Encounter } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useCampaignEvents, type CampaignEventsStatus } from '../../lib/useCampaignEvents';
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
import { AiDmDashboardActivity } from '../ai-dm/AiDmDashboardActivity';
import { AiDmDashboardOnboarding } from '../ai-dm/AiSetupChecklist';
import { GameIcon } from '../../components/GameIcon';

// Slow fallback poll for summary entities that do not have campaign events yet.
// Scheduling is event-driven (#790) and does not add a second polling path.
const POLL_MS = 5000;

type ScheduleSyncState = 'live' | 'stale' | 'offline';

export default function DashboardPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const id = Number(campaignId);
  const { roleIn, isAdmin, staleIdentity } = useAuth();
  const role = roleIn(id);
  const { refresh: refreshCampaigns } = useCampaigns();
  const { lostAccess, handle: handleAccessError } = useCampaignAccessError();

  // Keep the campaign id beside the projection/failure. React reuses this route
  // component when :campaignId changes; keying state prevents one campaign's
  // last response (including DM-only fields) from flashing in another campaign.
  const [projection, setProjection] = useState<{ campaignId: number; data: CampaignSummary } | null>(null);
  const projectionRef = useRef(projection);
  projectionRef.current = projection;
  const [failure, setFailure] = useState<{ campaignId: number; message: string } | null>(null);
  const [liveEncounterProjection, setLiveEncounterProjection] = useState<{ campaignId: number; data: Encounter | null } | null>(null);
  const [summaryStale, setSummaryStale] = useState(false);
  const [eventStatus, setEventStatus] = useState<CampaignEventsStatus>('connecting');
  const requestSequence = useRef(0);
  const activeCampaignId = useRef(id);
  activeCampaignId.current = id;

  const summary = projection?.campaignId === id ? projection.data : null;
  const error = failure?.campaignId === id ? failure.message : null;
  const liveEncounter = liveEncounterProjection?.campaignId === id ? liveEncounterProjection.data : null;

  const load = useCallback(async () => {
    const requestId = ++requestSequence.current;
    setFailure((current) => (current?.campaignId === id ? null : current));
    try {
      const data = await api.get<CampaignSummary>(`${API}/campaigns/${id}/summary`);
      if (requestId !== requestSequence.current || activeCampaignId.current !== id) return;
      // Replace the complete server projection in one state transition. In
      // particular, inProgressSession/nextSession are never field-merged:
      // reschedules replace every detail and cancellation replaces each with null.
      setProjection({ campaignId: id, data });
      setSummaryStale(false);
      // Keep the sidebar/topbar/Home tiles in sync — StatusHeader can rename the
      // campaign from here, and CampaignContext is the shared source for its name.
      void refreshCampaigns();
    } catch (err) {
      if (requestId !== requestSequence.current || activeCampaignId.current !== id) return;
      if (!handleAccessError(err)) {
        setFailure({ campaignId: id, message: err instanceof ApiError ? err.message : "Couldn't load the campaign dashboard." });
        if (projectionRef.current?.campaignId === id) setSummaryStale(true);
      }
    }
  }, [id, refreshCampaigns, handleAccessError]);

  useEffect(() => {
    if (Number.isFinite(id)) {
      setEventStatus('connecting');
      setSummaryStale(false);
      void load();
    }
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
      if (activeCampaignId.current === id) setLiveEncounterProjection({ campaignId: id, data: running[0] ?? null });
    } catch {
      if (activeCampaignId.current === id) setLiveEncounterProjection({ campaignId: id, data: null });
    }
  }, [id]);

  useEffect(() => {
    if (summary) void refreshLiveEncounter();
  }, [summary, refreshLiveEncounter]);

  // One campaign stream invalidates each affected authoritative read. Scheduling
  // events refetch the whole dashboard projection; this is also the reconnect
  // catch-up path for anything changed while this tab was offline (#790).
  useCampaignEvents(Number.isFinite(id) ? id : undefined, {
    onEvent: useCallback((event) => {
      if (event.type === 'schedule.updated') {
        void load();
      } else if (event.type === 'encounter.updated' || event.type === 'encounter.deleted') {
        void refreshLiveEncounter();
      }
    }, [load, refreshLiveEncounter]),
    onReconnect: useCallback(() => {
      void load();
      void refreshLiveEncounter();
    }, [load, refreshLiveEncounter]),
    onStreamRecovery: useCallback(() => {
      void load();
      void refreshLiveEncounter();
    }, [load, refreshLiveEncounter]),
    onStatusChange: useCallback((status: CampaignEventsStatus) => setEventStatus(status), []),
  });

  const scheduleSync: ScheduleSyncState = staleIdentity || eventStatus === 'offline'
    ? 'offline'
    : summaryStale || eventStatus === 'reconnecting' || eventStatus === 'stopped'
      ? 'stale'
      : 'live';

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
          <p className="flex justify-center text-[var(--color-neutral-400)]"><GameIcon slug="padlock" size={28} reserveSpace /></p>
          <p className="font-bold text-white">You no longer have access to this campaign</p>
          <Link to="/" className="btn btn-primary" style={{ display: 'inline-flex', marginTop: 4 }}>
            Back to your campaigns
          </Link>
        </Card>
      </div>
    );
  }

  if (!summary && !error) {
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
    <div className="reading-surface max-w-7xl mx-auto px-4 mt-5 pb-20 md:pb-10" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {error && <ErrorNote message={error} onRetry={load} />}

      <StatusHeader campaignId={id} summary={summary} role={role} onChange={load} liveEncounter={liveEncounter} />

      {/* AI-DM live-state relay (#344) — presence + last-action line for everyone, plus
          a DM-only "review it" nudge the instant the AI files a proposal. Renders nothing
          when the seat isn't in Driver mode. */}
      <AiDmDashboardActivity campaignId={id} isDm={role === 'dm'} />

      {/* Onboarding nudge (#343) — DM-only, dismissible, shown only while the seat is off. */}
      <AiDmDashboardOnboarding campaignId={id} isDm={role === 'dm'} isAdmin={isAdmin} />

      <InstallHintBanner />

      {/* Design: two-column grid (~7/5 split), left = map/quests/sessions, right = party/npcs/notes.
          See Campfire.dc.html ~L435-536 (dashCols). Single column below lg per design's mobile spec. */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        <div className="lg:col-span-7" style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <RegionMap campaignId={id} campaign={summary.campaign} locations={summary.locations} role={role} onChange={load} />
          <QuestsCard campaignId={id} quests={summary.quests} role={role} onChange={load} />
          <SessionLog
            campaignId={id}
            sessions={summary.sessions}
            inProgressSession={summary.inProgressSession}
            nextSession={summary.nextSession}
            scheduleSync={scheduleSync}
            role={role}
          />
        </div>

        <div className="lg:col-span-5" style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <PartyCard campaignId={id} characters={summary.characters} />
          <NpcGrid campaignId={id} npcs={summary.npcs} />
          <HandoutsCard campaignId={id} role={role} />
          <DiceWidget campaignId={id} />
          <NotesQuickRail campaignId={id} openInboxCount={summary.openInboxCount} role={role} />
        </div>
      </div>

      <p className="reading-supporting text-slate-600 pb-4">
        Players can tick objectives and edit their own character; viewers can read and leave notes.
      </p>
    </div>
  );
}
