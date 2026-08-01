/**
 * Campaign dashboard — the home screen for a campaign.
 * Mirrors design/02-dashboard.html structure/classes; see README-less DoD notes in PR.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { CampaignSummary } from '@campfire/schema';
import { api, API, ApiError, isReadTimeout, isTransientError } from '../../lib/api';
import { useCampaignEvents, type CampaignEventsStatus } from '../../lib/useCampaignEvents';
import { usePollWhileVisible } from '../../lib/usePollWhileVisible';
import { useAuth } from '../../app/auth';
import { useCampaigns } from '../../app/CampaignContext';
import { useCampaignAccessError } from '../../app/useCampaignAccessError';
import { useLiveEncounter } from '../../app/LiveEncounterContext';
import { Card, Skeleton, ErrorNote } from '../../components/ui';
import { StatusHeader } from './StatusHeader';
import { InstallHintBanner } from './InstallHintBanner';
import { OfflinePackBanner } from './OfflinePackBanner';
import { RegionMap } from './RegionMap';
import { QuestsCard } from './QuestsCard';
import { NpcGrid } from './NpcGrid';
import { PartyCard } from './PartyCard';
import { SessionLog } from './SessionLog';
import { NotesQuickRail } from './NotesQuickRail';
import { DiceWidget } from './DiceWidget';
import { HandoutsCard } from './HandoutsCard';
import { CampaignOnboardingCard } from './CampaignOnboardingCard';
import { AiDmDashboardActivity } from '../ai-dm/AiDmDashboardActivity';
import { AiDmDashboardOnboarding } from '../ai-dm/AiSetupChecklist';
import { CatchUpPanel } from './CatchUpPanel';
import {
  dashboardCatchUpOptions,
  failureAfterCancel,
  shouldShowSkeletonRetry,
} from './dashboardLoadPolicy';
import { GameIcon } from '../../components/GameIcon';
import { EntityDiscussion } from '../comments/EntityDiscussion';
import { CheckRequestPanel } from '../encounters/CheckRequests';

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
  const [summaryStale, setSummaryStale] = useState(false);
  const [loadPending, setLoadPending] = useState(false);
  const [revalidating, setRevalidating] = useState(false);
  // Distinguishes "mount hasn't kicked off load yet" from "a load finished with
  // nothing to show" so the stranded Retry banner does not flash on first paint.
  const [loadAttempted, setLoadAttempted] = useState(false);
  const loadAbortRef = useRef<AbortController | null>(null);
  const [eventStatus, setEventStatus] = useState<CampaignEventsStatus>('connecting');
  const requestSequence = useRef(0);
  const activeCampaignId = useRef(id);
  activeCampaignId.current = id;

  const summary = projection?.campaignId === id ? projection.data : null;
  const error = failure?.campaignId === id ? failure.message : null;
  const liveEncounter = useLiveEncounter();

  const load = useCallback(async (opts?: { background?: boolean }) => {
    if (opts?.background && loadAbortRef.current) return;

    const requestId = ++requestSequence.current;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;

    if (opts?.background) {
      setRevalidating(true);
    } else {
      setFailure((current) => (current?.campaignId === id ? null : current));
      setLoadPending(true);
    }

    try {
      const data = await api.get<CampaignSummary>(`${API}/campaigns/${id}/summary`, {
        signal: controller.signal,
      });
      if (requestId !== requestSequence.current || activeCampaignId.current !== id) return;
      // Replace the complete server projection in one state transition. In
      // particular, inProgressSession/nextSession are never field-merged:
      // reschedules replace every detail and cancellation replaces each with null.
      setProjection({ campaignId: id, data });
      setSummaryStale(false);
      // Background catch-up/poll never clears failure up-front; drop a prior
      // error banner once we have a fresh projection (SSE recovery self-heals).
      setFailure((current) => (current?.campaignId === id ? null : current));
      // Keep the sidebar/topbar/Home tiles in sync — StatusHeader can rename the
      // campaign from here, and CampaignContext is the shared source for its name.
      void refreshCampaigns();
    } catch (err) {
      if (controller.signal.aborted) return;
      if (requestId !== requestSequence.current || activeCampaignId.current !== id) return;
      if (!handleAccessError(err)) {
        const hasProjection = projectionRef.current?.campaignId === id;
        const timedOut = isReadTimeout(err);
        const transient = isTransientError(err);
        if (hasProjection && (timedOut || transient)) {
          setSummaryStale(true);
          setFailure(null);
          // One background revalidation after surfacing last-known data (#581).
          if (!opts?.background) {
            setTimeout(() => void load({ background: true }), 0);
          }
          return;
        }
        setFailure({
          campaignId: id,
          message: err instanceof ApiError ? err.message : "Couldn't load the campaign dashboard.",
        });
        if (hasProjection) setSummaryStale(true);
      }
    } finally {
      setLoadAttempted(true);
      if (loadAbortRef.current === controller) {
        loadAbortRef.current = null;
        setLoadPending(false);
        setRevalidating(false);
      }
    }
  }, [id, refreshCampaigns, handleAccessError]);

  const cancelLoad = useCallback(() => {
    loadAbortRef.current?.abort();
    loadAbortRef.current = null;
    setLoadPending(false);
    setRevalidating(false);
    setLoadAttempted(true);
    // Cancel with no projection used to leave bare skeletons and no Retry.
    if (projectionRef.current?.campaignId !== activeCampaignId.current) {
      setFailure(failureAfterCancel(activeCampaignId.current));
    }
  }, []);

  useEffect(() => {
    if (Number.isFinite(id)) {
      setEventStatus('connecting');
      setSummaryStale(false);
      setLoadAttempted(false);
      void load();
    }
    return () => {
      loadAbortRef.current?.abort();
      loadAbortRef.current = null;
    };
  }, [id, load]);

  // Keep the summary live while the tab is open (issue #113): the quest/party/notes
  // cards have no SSE event, so poll them ~5s and pause when the tab is hidden.
  usePollWhileVisible(() => void load({ background: true }), POLL_MS, Number.isFinite(id));

  // One campaign stream invalidates each affected authoritative read. Scheduling
  // events refetch the whole dashboard projection; this is also the reconnect
  // catch-up path for anything changed while this tab was offline (#790).
  // Catch-up MUST be background: foreground load() aborts the in-flight first
  // summary and can leave Home on skeletons forever when the SSE stream flaps.
  useCampaignEvents(Number.isFinite(id) ? id : undefined, {
    onEvent: useCallback((event) => {
      if (event.type === 'schedule.updated') {
        void load(dashboardCatchUpOptions());
      }
    }, [load]),
    onReconnect: useCallback(() => {
      void load(dashboardCatchUpOptions());
    }, [load]),
    onStreamRecovery: useCallback(() => {
      void load(dashboardCatchUpOptions());
    }, [load]),
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
    const stranded = shouldShowSkeletonRetry({
      hasSummary: false,
      error,
      loadPending,
      loadAttempted,
    });
    return (
      <div className="max-w-7xl mx-auto px-4 mt-5 space-y-5">
        {loadPending && (
          <div role="status" className="cf-inset text-sm text-[var(--color-neutral-400)] flex items-center justify-between gap-3">
            <span>Loading campaign dashboard…</span>
            <button
              type="button"
              onClick={cancelLoad}
              className="font-semibold text-[var(--color-neutral-500)] hover:underline shrink-0"
            >
              Cancel
            </button>
          </div>
        )}
        {stranded && (
          <div role="status" className="cf-inset text-sm text-[var(--color-neutral-400)] flex items-center justify-between gap-3">
            <span>Dashboard didn&apos;t finish loading.</span>
            <button
              type="button"
              onClick={() => void load()}
              className="font-semibold text-[var(--cf-accent)] hover:underline shrink-0"
            >
              Retry
            </button>
          </div>
        )}
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
        <ErrorNote message={error} onRetry={() => void load()} pending={loadPending} />
      </div>
    );
  }

  if (!summary) return null;

  return (
    <div className="reading-surface max-w-7xl mx-auto px-4 mt-5 pb-20 md:pb-10" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {error && <ErrorNote message={error} onRetry={() => void load()} pending={loadPending} />}
      {(loadPending || revalidating) && (
        <div role="status" className="cf-inset text-sm text-[var(--color-neutral-400)] flex items-center justify-between gap-3">
          <span>{revalidating && !loadPending ? 'Refreshing in background…' : 'Refreshing dashboard…'}</span>
          <button
            type="button"
            onClick={cancelLoad}
            className="font-semibold text-[var(--color-neutral-500)] hover:underline shrink-0"
          >
            Cancel
          </button>
        </div>
      )}
      {summaryStale && !error && (
        <div role="status" className="cf-inset text-sm text-[var(--color-neutral-400)] flex items-center justify-between gap-3">
          <span>Showing last-known dashboard — live refresh is delayed.</span>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loadPending || revalidating}
            className="font-semibold text-[var(--cf-accent)] hover:underline shrink-0 disabled:opacity-60"
          >
            Retry
          </button>
        </div>
      )}

      <StatusHeader campaignId={id} summary={summary} role={role} onChange={() => void load()} liveEncounter={liveEncounter} />

      {/* AI-DM live-state relay (#344) — presence + last-action line for everyone, plus
          a DM-only "review it" nudge the instant the AI files a proposal. Renders nothing
          when the seat isn't in Driver mode. */}
      <AiDmDashboardActivity campaignId={id} isDm={role === 'dm'} />

      <CampaignOnboardingCard campaignId={id} summary={summary} isDm={role === 'dm'} />

      {/* Onboarding nudge (#343) — DM-only, dismissible, shown only while the seat is off. */}
      <AiDmDashboardOnboarding campaignId={id} isDm={role === 'dm'} isAdmin={isAdmin} />

      <InstallHintBanner />
      <OfflinePackBanner campaignId={id} />

      <CatchUpPanel key={id} campaignId={id} />

      {/* Design: two-column grid (~7/5 split), left = map/quests/sessions, right = party/npcs/notes.
          See Campfire.dc.html ~L435-536 (dashCols). Single column below lg per design's mobile spec. */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        <div className="lg:col-span-7" style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <RegionMap campaignId={id} campaign={summary.campaign} locations={summary.locations} onChange={load} />
          <QuestsCard campaignId={id} quests={summary.quests} onChange={load} />
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
          {role === 'dm' && <CheckRequestPanel campaignId={id} characters={summary.characters} />}
          <PartyCard campaignId={id} characters={summary.party} accessibleCharacterIds={new Set(summary.characters.map((character) => character.id))} />
          <NpcGrid campaignId={id} npcs={summary.npcs} />
          <HandoutsCard campaignId={id} />
          <DiceWidget campaignId={id} />
          <NotesQuickRail campaignId={id} openInboxCount={summary.openInboxCount} />
          <EntityDiscussion campaignId={id} entityType="campaign" entityId={id} />
        </div>
      </div>

      <p className="reading-supporting text-secondary pb-4">
        Players can tick objectives and edit their own character; viewers can read and leave notes.
      </p>
    </div>
  );
}
