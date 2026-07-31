/**
 * AI-DM Table page (issue #339) — the player-facing surface where a Driver-mode
 * session with the AI DM is actually played.
 *
 * It composes the #338 foundation rather than re-deriving it:
 *   - lib/useAiDmStream          — the SSE narration/signal stream.
 *   - features/ai-dm/transcript  — the pure reducer + localStorage persistence that
 *                                  turns stream events (+ this client's own echoes)
 *                                  into the running transcript every player watches.
 *   - features/ai-dm/toolActivity — the tool-event → query-invalidation + chip map, so
 *                                  the tracker / party / map / proposal queue reconcile
 *                                  live off the AI's actions.
 *   - lib/query (useAiDmSeat / useAiDmSession / invalidateAiDm) — the thin server truth.
 *
 * Flow: the SSE stream folds into a `useReducer(transcriptReducer)`; a `turn.start`
 * opens a DM bubble that `narration.delta` fills token-by-token and `turn.end` closes
 * with a meta row. Between `turn.start` and `turn.end` the composer is locked
 * TABLE-WIDE — every client sees the same events, so every composer locks together.
 * Submitting a player action POSTs to /ai-dm/message (speaker-prefixed per #317) and
 * echoes locally; the AI's reply streams back in.
 *
 * The stuck-ladder banner + recovery levers (#340), co-DM draft buttons (#341), the
 * scribe (#342) and onboarding checklist (#343) are OWNED BY THEIR OWN ISSUES — this
 * page leaves clearly-marked seams for them (see the `session.stuck` / `session.state`
 * region below) and renders only a minimal fallback for the gated/off states.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AI_COST_BASIS_UNKNOWN,
  AI_DM_TRANSCRIPT_LIST_MAX_LIMIT,
  type AiDmReadiness,
  type AiDmTranscriptPage,
  type Character,
  type Encounter,
  type EncounterWithCombatants,
} from '@campfire/schema';
import { api, API, ApiError, translateApiError } from '../../lib/api';
import { formatNumber } from '../../lib/format';
import { useAuth } from '../../app/auth';
import { GameIcon } from '../../components/GameIcon';
import { PageTitle } from '../../components/PageTitle';
import { UndoSnackbar } from '../../components/UndoSnackbar';
import {
  queryKeys,
  useAiDmSeat,
  useAiDmSession,
  invalidateAiDm,
  invalidateAiDmToolConfirmations,
} from '../../lib/query';
import type { DriverLastUndoableCommit } from '@campfire/schema';
import { useAiDmStream } from '../../lib/useAiDmStream';
import { aiDmPauseRequest } from './aiDmPause';
import { nextUndoLeverState, resolveUndoPostError } from './aiDmUndoLever';
import { ToolConfirmationsPanel } from './ToolConfirmationsPanel';
import {
  transcriptReducer,
  clearTranscript,
  loadTranscript,
  newClientRef,
  saveTranscript,
  speakerPrefix,
  dmEntryText,
  emptyTranscript,
} from './transcript';
import { invalidateForToolEvent } from './toolActivity';
import { isTranscriptRememberEnabled, setTranscriptRemember } from './transcriptPrivacy';
import { usePendingHydrate } from './usePendingHydrate';
import {
  advanceNarrationLog,
  announceableEntryIds,
  beginNarrationLogLive,
  collectPreLiveAnnounceableIds,
  formatNarrationLogAddition,
  nextComposerStatusAnnouncement,
  NARRATION_LOG_LIVE_REGION,
  NARRATION_STATUS_LIVE_REGION,
  NARRATION_VISUAL_TRANSCRIPT,
  resolveComposerA11ySnapshot,
  type ComposerA11ySnapshot,
  type NarrationLogAddition,
  type NarrationLogCursor,
} from './narrationAccessibility';
import {
  followLatestAfterUserScroll,
  FEED_NEAR_BOTTOM_PX,
  isFeedNearBottom,
  shouldScrollTranscriptToTailOnMount,
  unreadAfterFeedGrowth,
} from './feedScrollFollow';
import { AiSetupChecklist, AiGateExplainer, AiTransparencyNote } from './AiSetupChecklist';
import { StuckLadder } from './StuckLadder';
import { GroundingPanel } from './GroundingPanel';
import { TranscriptRow, systemText } from './AiDmTranscriptUi';
import { Field } from '../../components/Field';
import { Toggle } from '../../components/Toggle';
import { AI_TABLE_FIELD, AI_TABLE_PREFIX } from '../../components/formFieldLabels';
import { Btn, Card, Chip, EmptyState, Skeleton, type ChipVariant } from '../../components/ui';
import { formatUsdRangeValue } from './costEstimate';
import { CostDisclosure } from './CostDisclosure';
import { UI_ICON_SIZE } from '../../lib/uiIcons';

/** Seat status → chip variant for the header status pill. */
const STATUS_VARIANT: Record<'idle' | 'narrating' | 'paused' | 'human' | 'collaborative', ChipVariant> = {
  idle: 'available',
  narrating: 'active',
  paused: 'private',
  human: 'dm',
  // #1051 — a healthy, running seat with its mechanics deferred, so it reads as active rather
  // than as a stopped state.
  collaborative: 'dm',
};

export default function AiTablePage() {
  const { t } = useTranslation();
  const params = useParams<{ campaignId: string }>();
  const campaignId = params.campaignId ? Number(params.campaignId) : undefined;
  const { me, ready: authReady, roleIn, isAdmin } = useAuth();
  const queryClient = useQueryClient();

  const role = campaignId !== undefined ? roleIn(campaignId) : null;
  const isDm = role === 'dm';
  const canCompose = role === 'dm' || role === 'player';

  const seatQuery = useAiDmSeat(campaignId);
  const seat = seatQuery.data;
  const isDriver = seat?.mode === 'driver';

  const sessionQuery = useAiDmSession(campaignId);
  const session = sessionQuery.data;
  const readinessQuery = useQuery({
    queryKey: campaignId !== undefined ? queryKeys.aiDmReadiness(campaignId) : ['ai-dm', 'readiness', 'disabled'],
    queryFn: () => api.get<AiDmReadiness>(`${API}/campaigns/${campaignId}/ai-dm/readiness`),
    enabled: campaignId !== undefined && isDriver && isDm,
  });
  const readiness = readinessQuery.data ?? null;
  // #1065 — null here means "no price on file", which is a rendered sentence, not a blank.
  const runCostUsd = formatUsdRangeValue(readiness?.estimatedCost.estimatedUsdRange ?? null);

  // The transcript VIEW MODEL (see transcript.ts). The authoritative log lives on the
  // server since #572; localStorage is only a paint cache so a reload has something on
  // screen before the first page lands, and is reconciled away by `eventId` as soon as it
  // does.
  //
  // #573: the reducer starts EMPTY. It used to hydrate in its lazy initializer, which runs
  // on the FIRST render — before `/me` has resolved — so it could not know whose cache it
  // was reading, and a slow auth check painted the previous account's table. Hydration now
  // happens in the identity-gated effect below, one commit later. That is the deliberate
  // trade: a frame of empty transcript instead of a frame of somebody else's.
  const [transcript, dispatch] = useReducer(transcriptReducer, emptyTranscript);

  /**
   * The shared hydrate/identity latch (#572, #573). `viewerId` is null until `/me` has
   * resolved, and every transcript storage entry point is a no-op for a null viewer — so
   * "never hydrate before identity is established" needs no separate flag here.
   */
  const pendingHydrate = usePendingHydrate({ ready: authReady, userId: me?.user.id ?? null });
  const viewerId = pendingHydrate.viewerId;
  const [rememberTranscript, setRememberTranscript] = useState(false);
  // Read the device grant once identity settles, and re-read on an identity change: it is
  // per-user, so the previous account's answer must never carry over. Default false.
  useEffect(() => {
    setRememberTranscript(isTranscriptRememberEnabled(viewerId));
  }, [viewerId]);

  /**
   * Reconnect watermark (#572): the highest authoritative `seq` this client has folded in.
   * Held in a ref as well as state so the SSE `onReconnect` callback — which is captured
   * once and must not re-subscribe the stream on every new event — always reads the
   * CURRENT value when it asks the server for "everything after N".
   */
  const lastSeqRef = useRef(0);
  useEffect(() => {
    lastSeqRef.current = transcript.lastSeq ?? 0;
  }, [transcript.lastSeq]);

  // `streaming` is the table-wide composer lock: true between turn.start and turn.end.
  // It is driven purely by SSE events, so every client's composer locks in lockstep.
  const [streaming, setStreaming] = useState(false);

  const [input, setInput] = useState('');
  const [sceneField, setSceneField] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pauseError, setPauseError] = useState<string | null>(null);
  const [pauseBusy, setPauseBusy] = useState(false);
  // #1501 — DM undo of the AI's last reversible action. `undoSnackbar` holds the commit a fresh
  // snackbar is offering; `seenUndoChainRef` stops a reload that rehydrates a commit from
  // re-popping it. A failed undo is surfaced via `undoError` rather than swallowed, EXCEPT a 404
  // (the lever is already gone — superseded or reversed), which just dismisses the snackbar.
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoSnackbar, setUndoSnackbar] = useState<DriverLastUndoableCommit | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);
  const seenUndoChainRef = useRef<string | null>(null);
  // `nextUndoLeverState` seeds `seenUndoChainRef` from the FIRST loaded session so a lever that
  // pre-existed when the DM (re)opened the table (prior visit, or react-query cache rehydration)
  // doesn't pop a stale undo; only actions armed after mount pop. Sticky once set.
  const undoLeverSeededRef = useRef(false);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);

  // Party roster — resolves this member's character name for speaker attribution, and
  // is also a live surface refreshed by party-touching tool events.
  const charactersQuery = useQuery({
    queryKey: campaignId !== undefined ? queryKeys.campaignCharacters(campaignId) : ['characters', 'disabled'],
    queryFn: () => api.get<Character[]>(`${API}/campaigns/${campaignId}/characters`),
    enabled: campaignId !== undefined && isDriver,
  });

  // Live-encounter strip: the running encounter this table sits beside (design point 4).
  const encountersQuery = useQuery({
    queryKey: campaignId !== undefined ? queryKeys.campaignEncounters(campaignId) : ['encounters', 'disabled'],
    queryFn: () => api.get<Encounter[]>(`${API}/campaigns/${campaignId}/encounters`),
    enabled: campaignId !== undefined && isDriver,
  });
  const activeEncounter = encountersQuery.data?.find((e) => e.status === 'running');
  const activeEncounterId = activeEncounter?.id;

  // Detail of the running encounter, only to name whose turn it is in the placeholder.
  const activeEncounterQuery = useQuery({
    queryKey: activeEncounterId !== undefined ? queryKeys.encounter(activeEncounterId) : ['encounter', 'disabled'],
    queryFn: () => api.get<EncounterWithCombatants>(`${API}/encounters/${activeEncounterId}`),
    enabled: activeEncounterId !== undefined,
  });
  /**
   * #1558 — the id → name map the confirmation summaries resolve against.
   *
   * Deliberately assembled from reads THIS PAGE ALREADY MADE under the viewer's own permissions
   * (characters + the running encounter's combatants). No extra fetch is added to make the
   * summaries prettier, which is what guarantees a DM-hidden entity can never be named here: an
   * id the client was never given renders as `#12`.
   */
  const confirmationEntities = useMemo(
    () => [...(charactersQuery.data ?? []), ...(activeEncounterQuery.data?.combatants ?? [])],
    [charactersQuery.data, activeEncounterQuery.data],
  );

  const currentCombatantName = useMemo(() => {
    const d = activeEncounterQuery.data;
    if (!d?.currentCombatantId) return undefined;
    return d.combatants.find((c) => c.id === d.currentCombatantId)?.name;
  }, [activeEncounterQuery.data]);

  // Speaker identity for the composer (design point 3): the character this member owns
  // when they have one, else their display name. #317 fences the raw input server-side,
  // so the prefix is flavour for the model, not authority.
  const myMembership = me?.memberships.find((m) => m.campaignId === campaignId);
  const myCharacter = charactersQuery.data?.find((c) => c.id === myMembership?.characterId);
  const memberName = me?.user.displayName || me?.user.username || t('table.you');
  const characterName = myCharacter?.name;

  /**
   * Which (viewer, campaign) the reducer state currently holds. Starts as "nobody" —
   * unlike before #573 the reducer no longer hydrates in its initializer — and is
   * re-pointed by the load effect below. Needed because a table -> table param change (or
   * an account switch) reuses this component instance, so for one render `campaignId` /
   * `viewerId` are already the NEW owner while `transcript` still holds the OLD one's
   * entries.
   */
  const transcriptOwnerRef = useRef<string>('');
  const transcriptOwnerKey = `${viewerId ?? ''}:${campaignId ?? ''}`;

  // Persist the transcript cache on every change (bounded inside saveTranscript, and a
  // no-op unless this viewer opted into remembering transcripts on this device).
  useEffect(() => {
    // Never write one owner's entries under another's key. This effect is declared BEFORE
    // the load/reset effect, so on the switch render it would otherwise persist the
    // previous table's transcript to the new key — which the reset would then read
    // straight back, laundering the leak through localStorage. With `viewerId` in the key
    // that leak would cross ACCOUNTS, not just campaigns.
    if (campaignId === undefined || viewerId === null) return;
    if (transcriptOwnerRef.current !== transcriptOwnerKey) return;
    saveTranscript(viewerId, campaignId, transcript);
  }, [campaignId, viewerId, transcriptOwnerKey, transcript]);

  /**
   * Load the AUTHORITATIVE transcript (#572) — the fix for late join, reload and reconnect.
   * Before this, a player who joined mid-session had no server transcript to page through
   * and seeded from `scene` + `lastNarration` behind a "joined mid-session" divider, so no
   * two browsers at the table agreed on what had happened.
   *
   * Fetches the newest page on mount, then gap-fills from the watermark on every later
   * pass — so the same code path serves the first load AND a reconnect. Failure is soft:
   * the live stream still works, the client just keeps whatever scrollback it had.
   */
  const fetchTranscript = useCallback(
    async (after?: number) => {
      if (campaignId === undefined) return;
      let watermark = after;
      // A long disconnect can leave more missed events than one page holds. Walk forward
      // until the server says there is nothing left — a partial catch-up would silently
      // reintroduce exactly the gap #572 exists to close. Bounded so a pathological
      // response can never spin the page.
      for (let page = 0; page < 20; page += 1) {
        try {
          const res = await api.get<AiDmTranscriptPage>(
            `${API}/campaigns/${campaignId}/ai-dm/transcript?limit=${AI_DM_TRANSCRIPT_LIST_MAX_LIMIT}` +
              (watermark ? `&after=${watermark}` : ''),
          );
          if (res.items.length > 0) dispatch({ type: 'serverEvents', events: res.items });
          const last = res.items[res.items.length - 1];
          // Only forward (gap-fill) paging continues here; the initial load renders the
          // newest page and older scrollback is paged by `nextCursor` on demand.
          if (watermark === undefined || !res.hasMore || !last) return;
          watermark = last.seq;
        } catch (err) {
          // #573: membership removal and campaign deletion are SERVER-side events with no
          // push channel of their own — they surface as the next read being refused. A 403
          // ("not a member of this campaign") or a 404 (campaign gone) means this viewer
          // may no longer see this table's history, so drop the local copy rather than
          // leaving it repainting from cache. BOTH scopes go: the activity provider caches
          // the same campaign under its own key and never fetches the transcript, so it has
          // no failure of its own to learn this from. Any other failure is soft — the live
          // stream still carries the table and the client keeps whatever scrollback it had.
          if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
            clearTranscript(viewerId, campaignId);
            clearTranscript(viewerId, campaignId, 'activity');
            dispatch({ type: 'reset' });
            dispatch({ type: 'authoritative' });
          }
          return;
        }
      }
    },
    [campaignId, viewerId],
  );

  const transcriptLoadedFor = useRef<string | null>(null);
  const [transcriptFetched, setTranscriptFetched] = useState(false);
  useEffect(() => {
    if (campaignId === undefined || !isDriver) return;
    // #573: no hydrate, no fetch, no seed until `/me` has established who is looking.
    if (pendingHydrate.identityPending || viewerId === null) return;
    if (transcriptLoadedFor.current === transcriptOwnerKey) return;
    transcriptLoadedFor.current = transcriptOwnerKey;
    setTranscriptFetched(false);
    // TABLE -> TABLE campaign switch. `/c/:campaignId/table` is one unkeyed route element,
    // so React reuses this component instance when only the param changes — the reducer's
    // lazy initializer does NOT re-run. That transition is reachable: the always-mounted
    // notifications bell lists cross-campaign items and navigates straight to
    // `/c/<other>/table` for an ai_dm_alert. Without this reset, the previous campaign's
    // entries survive, the new campaign's authoritative events MERGE into them, and the
    // save effect then persists the old table's transcript under the new campaign's cache
    // key. A transcript is exactly the wrong thing to leak between tables.
    //
    // A reset dispatch rather than `key={campaignId}` on the route: remounting would also
    // discard scroll/follow position and re-run the whole seed + screen-reader settle
    // sequence, and this is the narrower, local fix.
    // Runs on the FIRST established owner as well as on every switch, because since #573
    // the reducer no longer hydrates in its lazy initializer — this effect is the only
    // thing that ever loads the cache, and it cannot run before `/me` has answered.
    lastSeqRef.current = 0;
    dispatch({ type: 'hydrate', state: loadTranscript(viewerId, campaignId) });
    seededRef.current = false;
    // The seed effect runs LATER IN THIS SAME COMMIT and would still see the previous
    // owner's entries — its `entries.length > 0` branch would latch `seededRef` back
    // to true, and the new table (whose own transcript is empty) would then never seed
    // its scene / lastNarration join context at all. Skip that one stale pass.
    pendingHydrate.mark();
    transcriptOwnerRef.current = transcriptOwnerKey;
    // Opt this surface into authoritative mode BEFORE the first fetch: from here on the
    // durable `transcript` frames are the transcript, and the thin signal frames that now
    // have durable counterparts are ignored so nothing renders twice.
    dispatch({ type: 'authoritative' });
    void fetchTranscript().finally(() => setTranscriptFetched(true));
  }, [
    campaignId,
    isDriver,
    fetchTranscript,
    viewerId,
    transcriptOwnerKey,
    pendingHydrate.identityPending,
  ]);

  // Seed a fresh transcript (empty localStorage) from thin session state so a brand-new
  // browser drops in behind a "joined mid-session" divider showing scene + last narration.
  // `narrationLogLive` stays false until this phase settles so the SR log mirror does not
  // treat the delayed seed as live additions (#1077 / Bugbot).
  const seededRef = useRef(false);
  const [narrationLogLive, setNarrationLogLive] = useState(false);
  // When viewer→driver reseeds after the log already went live, re-baseline so join
  // context is silenced instead of announced as live additions.
  const silenceSeedBaselineRef = useRef(false);
  const narrationLogCursorRef = useRef<NarrationLogCursor | null>(null);
  const pendingPreLiveIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    // A campaign switch queued a hydrate this commit cannot see yet; every branch below
    // reads `transcript.entries`, so this pass's view belongs to the PREVIOUS table.
    if (pendingHydrate.consume()) return;
    if (transcript.entries.length > 0) {
      // Hydrated history (or seed applied on the previous commit): no further seed.
      if (!seededRef.current) seededRef.current = true;
      if (!narrationLogLive) setNarrationLogLive(true);
      return;
    }
    if (seededRef.current) {
      if (!narrationLogLive) setNarrationLogLive(true);
      return;
    }
    // Seat still loading: `isDriver` is false while data is missing, but a driver
    // session seed may still arrive — wait before enabling the live log.
    if (!seatQuery.isFetched) return;
    // #572: never seed a "joined mid-session" placeholder before the AUTHORITATIVE
    // transcript has had its chance to answer. The placeholder existed only because there
    // was no server transcript to page through; seeding over one would duplicate the last
    // narration and give this browser a transcript nobody else has.
    if (isDriver && !transcriptFetched) return;
    if (!isDriver) {
      // Do NOT set seededRef — a later seat switch into driver with an empty
      // transcript must still run session join-context seeding (#1077 recovery).
      if (!narrationLogLive) setNarrationLogLive(true);
      return;
    }
    // Driver: wait for the session read so join-context seed can land in the same
    // settle pass as enabling the live log (empty/error session → empty baseline).
    if (!sessionQuery.isFetched) return;
    if (session?.scene || session?.lastNarration) {
      // If SR log already went live (viewer → driver), hold the live region and
      // re-baseline so join-context seed is silenced rather than announced.
      if (narrationLogLive) {
        narrationLogCursorRef.current = null;
        pendingPreLiveIdsRef.current.clear();
        silenceSeedBaselineRef.current = true;
        setNarrationLogLive(false);
        dispatch({ type: 'seed', scene: session.scene, lastNarration: session.lastNarration });
        seededRef.current = true;
        // Next pass (entries.length > 0) re-enables live and silences the seed.
        return;
      }
      dispatch({ type: 'seed', scene: session.scene, lastNarration: session.lastNarration });
    }
    seededRef.current = true;
    // Batched with the seed dispatch so the next commit sees seeded entries + live
    // together; the log effect then silences the baseline instead of announcing it.
    setNarrationLogLive(true);
  }, [
    session,
    isDriver,
    transcript.entries.length,
    seatQuery.isFetched,
    sessionQuery.isFetched,
    narrationLogLive,
    transcriptFetched,
  ]);

  // Subscribe to the narration stream. Only opened in Driver mode; the hook itself also
  // stops on a 401/403 (feature off / not a member), so a non-member simply gets nothing.
  useAiDmStream(
    campaignId,
    {
      onEvent: (event) => {
        if (campaignId === undefined) return;
        dispatch({ type: 'stream', event });
        if (event.type === 'turn.start') setStreaming(true);
        else if (event.type === 'turn.end' || event.type === 'turn.error') setStreaming(false);
        else if (event.type === 'tool') {
          invalidateForToolEvent(queryClient, event, {
            campaignId,
            encounterId: event.encounterId ?? activeEncounterId,
          });
        } else if (event.type === 'transcript.reset') {
          // The DM erased the log and `seq` restarted; the reducer cleared our copy, so
          // re-seed from an empty server transcript rather than a stale watermark (#572).
          // The paint cache must go too, or a reload would repaint erased scrollback that
          // the (now empty) server transcript has nothing to correct.
          clearTranscript(viewerId, campaignId);
          lastSeqRef.current = 0;
          void fetchTranscript();
        } else if (event.type === 'grounding') {
          // #577: thin signal — refetch the claim list so the review card reconciles with the
          // server's verdict on the turn that just ended.
          void queryClient.invalidateQueries({ queryKey: queryKeys.aiDmGrounding(campaignId) });
        } else if (event.type === 'tool-confirmation') {
          // #1558: thin signal — refetch the authoritative queue. Without this the panel would
          // only update on its poll, and "the AI is waiting on you" would arrive up to 30s late
          // in the one situation where the delay is the whole problem.
          invalidateAiDmToolConfirmations(queryClient, campaignId);
          // #1501: a DM-APPROVED mechanical commit arms the undo lever server-side on this path
          // (collaborative handoff promotes resolve_action/apply_action to `confirm`), but an
          // approval emits a tool-confirmation frame — not a tool/state frame — so the session
          // invalidation those paths drive never fires, and useAiDmSession has no poll. Refetch the
          // session on approval so the just-armed "undo the AI's last action" control appears.
          if (event.action === 'approved') invalidateAiDm(queryClient, campaignId);
        } else if (
          event.type === 'state' ||
          event.type === 'stuck' ||
          event.type === 'recovered' ||
          event.type === 'vote' ||
          event.type === 'takeover' ||
          event.type === 'phase'
        ) {
          // Lifecycle signals move the thin server truth — reconcile the session/seat reads
          // so the header + composer-lock reflect the new state (#340 reads the same truth).
          // #1043: `phase` belongs here for the same reason as its siblings, and more sharply.
          // Only the member who pressed Start Session / Wrap Up gets a response carrying the new
          // phase; everyone else learns it from this frame alone. Without the refetch they keep a
          // stale phase and can type into an ended session, collecting a 409 nothing warned them
          // about.
          invalidateAiDm(queryClient, campaignId);
          if (event.type === 'state' && event.state !== 'running') setStreaming(false);
        }
      },
      onReconnect: () => {
        if (campaignId === undefined) return;
        // Transport drop healed — refetch session + live surfaces we may have missed.
        // #572: replay exactly the transcript events that happened while we were offline,
        // from our own watermark. Gap-free by construction — `seq` is a dense per-campaign
        // sequence, so "everything after N" has one correct answer.
        void fetchTranscript(lastSeqRef.current || undefined);
        setStreaming(false);
        invalidateAiDm(queryClient, campaignId);
        void queryClient.invalidateQueries({ queryKey: queryKeys.campaignEncounters(campaignId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.campaignParty(campaignId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.campaignCharacters(campaignId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.campaignMap(campaignId) });
      },
      // Parser recovery keeps the connection; still refetch skipped stream state.
      onStreamRecovery: () => {
        if (campaignId === undefined) return;
        // Discarded bytes may have eaten transcript frames — recover from the watermark (#572).
        void fetchTranscript(lastSeqRef.current || undefined);
        setStreaming(false);
        invalidateAiDm(queryClient, campaignId);
        void queryClient.invalidateQueries({ queryKey: queryKeys.campaignEncounters(campaignId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.campaignParty(campaignId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.campaignCharacters(campaignId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.campaignMap(campaignId) });
      },
    },
    { enabled: campaignId !== undefined && isDriver },
  );

  // Auto-scroll only while the reader is pinned to the tail (#590).
  const transcriptRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const [followLatest, setFollowLatest] = useState(true);
  const [unreadBelow, setUnreadBelow] = useState(0);
  const prevEntryCountRef = useRef(transcript.entries.length);
  const transcriptMountScrollDoneRef = useRef(false);
  /** Suppress unpin-on-scroll while a programmatic pin assigns scrollTop (#590). */
  const ignoreScrollUnpinRef = useRef(false);

  useEffect(() => {
    // Campaign switches must not inherit follow/unread state from the previous table.
    transcriptMountScrollDoneRef.current = false;
    followLatestRef.current = true;
    setFollowLatest(true);
    setUnreadBelow(0);
    prevEntryCountRef.current = 0;
    ignoreScrollUnpinRef.current = false;
  }, [campaignId]);

  useEffect(() => {
    followLatestRef.current = followLatest;
  }, [followLatest]);

  const transcriptRevision = useMemo(() => {
    const last = transcript.entries[transcript.entries.length - 1];
    const tail =
      last?.kind === 'dm' && last.status === 'streaming'
        ? `${last.id}:${dmEntryText(last).length}`
        : (last?.id ?? '');
    return `${transcript.entries.length}:${tail}`;
  }, [transcript.entries]);

  useEffect(() => {
    const prev = prevEntryCountRef.current;
    const next = transcript.entries.length;
    prevEntryCountRef.current = next;
    setUnreadBelow((unread) => unreadAfterFeedGrowth(unread, followLatestRef.current, prev, next));
  }, [transcript.entries.length]);

  const handleTranscriptScroll = useCallback(() => {
    // Programmatic pinTranscriptToTail fires scroll events; don't treat those as the
    // reader leaving the tail (flex settle on short viewports can land ~50–60px off,
    // just outside FEED_NEAR_BOTTOM_PX, and would otherwise show jump-to-latest).
    if (ignoreScrollUnpinRef.current) return;
    const el = transcriptRef.current;
    if (!el) return;
    const near = isFeedNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
    const pin = followLatestAfterUserScroll(near);
    followLatestRef.current = pin;
    setFollowLatest((prev) => (prev === pin ? prev : pin));
    if (pin) setUnreadBelow(0);
  }, []);

  const pinTranscriptToTail = useCallback((el: HTMLDivElement) => {
    // Prefer scrollTop over scrollIntoView — the latter can move the window when
    // nested flex overflow is still settling (issue #590 mount flake).
    ignoreScrollUnpinRef.current = true;
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        ignoreScrollUnpinRef.current = false;
        // Layout may have moved us off the tail during the suppressed window; re-pin
        // while follow is still intended so jump-to-latest does not stick (#590).
        const node = transcriptRef.current;
        if (node && followLatestRef.current) {
          node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
        }
      });
    });
  }, []);

  const syncTranscriptTailScroll = useCallback(() => {
    const el = transcriptRef.current;
    if (!el || transcript.entries.length === 0) return;

    const canScroll = el.scrollHeight > el.clientHeight + 1;

    if (!transcriptMountScrollDoneRef.current) {
      // Wait for a real overflow box; early layouts with equal scroll/client height
      // would otherwise mark the mount done and leave the reader at the top.
      if (!canScroll) return;
      transcriptMountScrollDoneRef.current = true;
      if (
        shouldScrollTranscriptToTailOnMount(
          transcript.entries.length,
          el.scrollTop,
          el.scrollHeight,
          el.clientHeight,
        )
      ) {
        pinTranscriptToTail(el);
        followLatestRef.current = true;
        setFollowLatest(true);
        setUnreadBelow(0);
        return;
      }
    }

    if (!canScroll) return;

    // Prefer previous follow intent over post-growth distance: a tall append can
    // push "near bottom" false even when the reader was pinned (orchestrator / #590).
    if (followLatestRef.current) {
      setUnreadBelow(0);
      pinTranscriptToTail(el);
      return;
    }
    const near = isFeedNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
    if (near) {
      followLatestRef.current = true;
      setFollowLatest(true);
      setUnreadBelow(0);
      pinTranscriptToTail(el);
    }
  }, [pinTranscriptToTail, transcript.entries.length]);

  const jumpToLatest = useCallback(() => {
    followLatestRef.current = true;
    setFollowLatest(true);
    setUnreadBelow(0);
    const el = transcriptRef.current;
    if (el) pinTranscriptToTail(el);
    else bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [pinTranscriptToTail]);

  useLayoutEffect(() => {
    if (!isDriver) return;
    const el = transcriptRef.current;
    if (!el) return;

    const sync = () => {
      // If follow-latest is on but layout left us away from the tail (flex
      // overflow settling on CI), allow mount pin to run again (#590 flake).
      if (
        followLatestRef.current &&
        el.scrollHeight > el.clientHeight + 1 &&
        el.scrollHeight - el.scrollTop - el.clientHeight > FEED_NEAR_BOTTOM_PX
      ) {
        transcriptMountScrollDoneRef.current = false;
      }
      syncTranscriptTailScroll();
    };

    sync();
    const raf = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(sync);
    });
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => {
      window.cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [isDriver, transcriptRevision, campaignId, syncTranscriptTailScroll]);

  // Composer lock: streaming OR a state the stuck-ladder issue (#340) owns.
  const paused = session?.state === 'paused';
  // #1043 — default to `active` while the session read is in flight, so the lifecycle controls
  // render in their normal state rather than flickering through a phase nobody is in.
  const phase = session?.phase ?? 'active';
  const humanControl = session?.state === 'human_control';
  // #1051. This flag only reports the MODE. The approval surface for the calls it defers is
  // #1558's `ToolConfirmationsPanel`, mounted above the transcript on this same page — so a DM
  // who sees this status also sees, and resolves, the queue the mode fills.
  const collaborative = session?.state === 'collaborative';
  const awaiting = session?.state === 'awaiting_players';
  // #1043 — an ENDED session locks the composer too.
  //
  // This was deliberately left unlocked at first, on the reasoning that `locked` is the
  // seat-UNAVAILABLE lock and `ended` is one click from cleared, so grey-ing it out would frame an
  // affordance as a permission problem. That reasoning does not survive the actual consequence:
  // after a normal wrap-up EVERY up-to-date client shows a composer whose submit the server
  // ALWAYS rejects with AI_DM_SESSION_ENDED. An input that cannot succeed is not an affordance,
  // it is a trap, and it springs on everyone rather than only on a client that missed a frame.
  //
  // The distinction that was really being drawn is preserved by `lockReason`, not by leaving the
  // box enabled: the lock states its cause in the composer's own help text and placeholder, the
  // phase note repeats it, and Start Session stays visible in the header — player+, so any member
  // still clears it in one click. The seat is not what is unavailable; the session is over, and
  // now the composer says so instead of letting you find out by being refused.
  const ended = phase === 'ended';
  const locked = streaming || paused || humanControl || awaiting || ended;
  const lockReason = streaming
    ? t('table.composerLockedStreaming')
    : paused
      ? t('table.composerLockedPaused')
      : humanControl
        ? t('table.composerLockedHuman')
        : awaiting
          ? t('table.composerLockedAwaiting')
          : ended
            ? t('table.composerLockedEnded')
            : null;

  // #1077: SR live regions. The visible transcript mutates token-by-token, so a
  // mirror only gains finished additions (turn.end / player / system). Status
  // covers turn.start/end + composer lock/unlock without flooding SRs.
  const [narrationLogMirror, setNarrationLogMirror] = useState<NarrationLogAddition[]>([]);
  const [a11yStatus, setA11yStatus] = useState('');
  const composerA11yRef = useRef<ComposerA11ySnapshot | null>(null);
  // Hydrated localStorage ids on first commit — never treat as pre-live pending.
  const mountBaselineIdsRef = useRef<Set<string> | null>(null);
  if (mountBaselineIdsRef.current === null) {
    mountBaselineIdsRef.current = announceableEntryIds(transcript.entries);
  }

  useEffect(() => {
    // Delay until seed/hydration settles — an early pass on [] would pin an empty
    // cursor and then announce the later session seed as live additions.
    if (!narrationLogLive) {
      // Viewer→driver reseed hold: do not mark seed lines as pre-live pending.
      if (silenceSeedBaselineRef.current) return;
      // Keep early finished turns pending so the go-live silence pass cannot
      // permanently suppress a streamed DM that completed before seeding (#1077).
      for (const id of collectPreLiveAnnounceableIds(
        transcript.entries,
        mountBaselineIdsRef.current!,
      )) {
        pendingPreLiveIdsRef.current.add(id);
      }
      return;
    }
    if (narrationLogCursorRef.current === null) {
      const pending = silenceSeedBaselineRef.current
        ? new Set<string>()
        : pendingPreLiveIdsRef.current;
      silenceSeedBaselineRef.current = false;
      const started = beginNarrationLogLive(transcript.entries, pending);
      narrationLogCursorRef.current = started.cursor;
      pendingPreLiveIdsRef.current.clear();
      if (started.additions.length === 0) return;
      setNarrationLogMirror((prev) => [...prev, ...started.additions]);
      return;
    }
    const advanced = advanceNarrationLog(transcript.entries, narrationLogCursorRef.current);
    narrationLogCursorRef.current = advanced.cursor;
    if (advanced.additions.length === 0) return;
    setNarrationLogMirror((prev) => [...prev, ...advanced.additions]);
  }, [transcript.entries, narrationLogLive]);

  useEffect(() => {
    // Non-streaming lock reasons already carry the localized copy; streaming uses
    // the same "DM is narrating…" string as the composer placeholder.
    // Viewers must not hear "Composer unlocked…" — the composer isn't shown.
    const next = resolveComposerA11ySnapshot(streaming, streaming ? null : lockReason);
    const message = nextComposerStatusAnnouncement(composerA11yRef.current, next, {
      streaming: t('table.composerLockedStreaming'),
      ready: canCompose ? t('table.composerUnlocked') : t('table.narrationReady'),
    });
    composerA11yRef.current = next;
    if (message) setA11yStatus(message);
  }, [streaming, lockReason, canCompose, t]);

  const placeholder = activeEncounter
    ? currentCombatantName
      ? t('table.composerPlaceholderTurn', { name: currentCombatantName })
      : t('table.composerPlaceholderCombat')
    : t('table.composerPlaceholder');

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || locked || submitting || campaignId === undefined) return;
    setSubmitting(true);
    setSubmitError(null);
    // #572: a correlation token so the authoritative echo REPLACES this client's optimistic
    // entry instead of rendering the action twice. Deliberately a token, not a content
    // match — two players typing the same words in the same round are two real lines.
    const clientRef = newClientRef();
    const body: {
      input: string;
      scene?: string;
      characterId?: number;
      clientRef: string;
      characterName?: string;
      displayText: string;
    } = {
      // `input` is what the MODEL sees (speaker-prefixed, #317); `displayText` is what the
      // TABLE reads. Keeping them separate stops the prefix leaking into the shared log.
      input: `${speakerPrefix(memberName, characterName)} ${text}`,
      characterId: myMembership?.characterId ?? undefined,
      clientRef,
      characterName,
      displayText: text,
    };
    if (isDm && sceneField.trim()) body.scene = sceneField.trim();
    try {
      await api.post(`${API}/campaigns/${campaignId}/ai-dm/message`, body);
      // Echo our own action. The action is now ALSO broadcast to everyone else (the #572
      // fix), so this echo exists only to close the round-trip gap for the sender — and it
      // is a no-op if the server frame already beat the HTTP response back, because the
      // reducer dedups on `clientRef` in BOTH directions.
      dispatch({ type: 'localPlayer', memberName, characterName, text, clientRef });
      setInput('');
      setSceneField('');
    } catch (err) {
      // 403 (gate/turn cap) / 503 (provider) messages are shown verbatim.
      setSubmitError(translateApiError(err, t));
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * Session lifecycle (#1043). Both run a real AI turn server-side, so they go through every
   * gate a player action does — a paused or frozen seat refuses them and the phase is left
   * alone. The button is disabled while a lifecycle turn is in flight, but the server is the
   * authority: it 409s a second start rather than trusting this.
   */
  async function onLifecycle(action: 'start-session' | 'wrap-up') {
    if (campaignId === undefined) return;
    setLifecycleBusy(true);
    setLifecycleError(null);
    try {
      await api.post(`${API}/campaigns/${campaignId}/ai-dm/${action}`);
      invalidateAiDm(queryClient, campaignId);
    } catch (err) {
      setLifecycleError(
        err instanceof ApiError && err.message ? err.message : t('table.lifecycleFailed'),
      );
    } finally {
      setLifecycleBusy(false);
    }
  }

  // #1501 — reset the undo-lever state whenever the page switches to a different campaign.
  // AiTablePage stays mounted across a campaign switch (same route, different :campaignId — see
  // router.tsx), so without this the seeded flag, seen chain id, open snackbar, and busy/error
  // state from the PREVIOUS table survive. The newly-opened table's pre-existing lever would
  // immediately pop a stale undo the DM never asked for (or a stale snackbar would post to the
  // wrong campaign). Declared before the lever effect so it runs first on the switch render. A
  // first visit is unaffected: the refs already start false/null and the state is already clear.
  useEffect(() => {
    undoLeverSeededRef.current = false;
    seenUndoChainRef.current = null;
    setUndoSnackbar(null);
    setUndoError(null);
    setUndoBusy(false);
  }, [campaignId]);

  // #1501 — when the seat arms a NEW reversible action (after the first session load), surface the
  // standard UndoSnackbar so a DM has the same one-click "X — Undo" affordance every soft-delete in
  // the app offers. The decision (including seeding the "seen" chain id from the first loaded
  // session so a lever that pre-existed on mount doesn't pop a stale undo) lives in `nextUndoLeverState`.
  useEffect(() => {
    const commit = session?.lastUndoableCommit ?? null;
    const step = nextUndoLeverState({
      sessionFetched: sessionQuery.isFetched,
      seeded: undoLeverSeededRef.current,
      commit,
      seenChainId: seenUndoChainRef.current,
    });
    undoLeverSeededRef.current = step.seeded;
    seenUndoChainRef.current = step.seenChainId;
    if (step.pop) {
      setUndoSnackbar(step.pop);
    }
    // `campaignId` is a dep so this re-runs on a table switch. AiTablePage stays mounted across a
    // /c/:id/table change, and the reset effect above clears the seeded flag on the switch — so
    // without re-running here, a switch BACK to a table whose session is already cached with
    // nothing armed (data deps unchanged) would leave `seeded` false and the next armed action
    // would be absorbed as already-seen (no snackbar) — #1501 review.
  }, [campaignId, session?.lastUndoableCommit, sessionQuery.isFetched]);

  async function undoAiAction(): Promise<void> {
    if (campaignId === undefined) return;
    setUndoBusy(true);
    setUndoError(null);
    try {
      await api.post(`${API}/campaigns/${campaignId}/ai-dm/undo`);
      setUndoSnackbar(null);
      invalidateAiDm(queryClient, campaignId);
    } catch (err) {
      // A 404 means the server has nothing left to undo (already reversed or superseded) — it is
      // the authority, so the cached session MUST be refetched or the header control keeps offering
      // a reversal that fails every time. Any other failure is surfaced so the DM knows the AI's
      // action was NOT reversed (issue #1501 review). The 404-refetch rule lives in the pure
      // helper so it is unit-testable (mirrors nextUndoLeverState / aiDmPauseRequest).
      const outcome = resolveUndoPostError(
        err instanceof ApiError ? err.status : undefined,
        translateApiError(err, t) || t('table.undoAiFailed'),
      );
      if (outcome.dismissSnackbar) setUndoSnackbar(null);
      if (outcome.invalidateSession) invalidateAiDm(queryClient, campaignId);
      if (outcome.errorMessage) setUndoError(outcome.errorMessage);
    } finally {
      setUndoBusy(false);
    }
  }

  async function onTogglePause() {
    if (campaignId === undefined) return;
    // #1501 — the strict /pause DTO needs { paused }; see aiDmPauseRequest.
    const { action, body } = aiDmPauseRequest(paused);
    setPauseBusy(true);
    setPauseError(null);
    try {
      await api.post(`${API}/campaigns/${campaignId}/ai-dm/${action}`, body);
      invalidateAiDm(queryClient, campaignId);
    } catch {
      setPauseError(t('table.pauseFailed'));
    } finally {
      setPauseBusy(false);
    }
  }

  /**
   * Flip the device grant (#573).
   *
   * Turning it ON writes what is already on screen, so the control takes effect at once
   * rather than only from the next narration delta. Turning it OFF purges inside
   * {@link setTranscriptRemember} — "don't keep this on my device" has to mean the copy
   * that is already there, not just future ones.
   */
  function onToggleRememberTranscript() {
    if (viewerId === null) return;
    const next = !rememberTranscript;
    setTranscriptRemember(viewerId, next);
    setRememberTranscript(next);
    if (next && campaignId !== undefined && transcriptOwnerRef.current === transcriptOwnerKey) {
      saveTranscript(viewerId, campaignId, transcript);
    }
  }

  // ---- Gated / off / loading states --------------------------------------
  // The onboarding issue (#343) owns the rich explainer/checklist; here we render only
  // the minimal fallback the issue calls for (message + a settings link).
  //
  // Issue #1711 (sibling audit off the Dashboard <h1> gap): this route had NO heading
  // element at all — the "Scene" label below is a small uppercase tag, not a heading,
  // and `Gate`'s `title` renders as a plain `<p>`. Every early-return branch below gets
  // its own sr-only `<PageTitle>` (rather than restructuring the control flow into one
  // shared wrapper) so the one-h1-per-route landmark exists regardless of which state
  // the table is in, without changing any of this page's visible design.

  if (seatQuery.isLoading) {
    return (
      <div className="max-w-3xl mx-auto px-4 mt-8">
        <PageTitle className="sr-only">{t('table.title')}</PageTitle>
        <Skeleton lines={6} />
      </div>
    );
  }

  if (seatQuery.isError) {
    // Onboarding (#343): a blocked seat read maps to a friendly explainer + deep link
    // (aiGate.ts) instead of a bare 403, and a DM gets the full setup checklist.
    return (
      <>
        <PageTitle className="sr-only">{t('table.title')}</PageTitle>
        <Gate campaignId={campaignId} isDm={isDm} isAdmin={isAdmin} error={seatQuery.error} />
      </>
    );
  }

  if (!isDriver) {
    const off = seat?.mode === 'off';
    return (
      <>
        <PageTitle className="sr-only">{t('table.title')}</PageTitle>
        <Gate
          campaignId={campaignId}
          isDm={isDm}
          isAdmin={isAdmin}
          icon={off ? 'moon' : 'shaking-hands'}
          title={off ? t('table.offTitle') : t('table.coDmTitle')}
          hint={off ? t('table.offHint') : t('table.coDmHint')}
          // Off + DM → the setup checklist. Co-DM → the transparency explainer (the AI
          // co-DMs via proposals, so the Table isn't where it's played).
          showChecklist={off && isDm}
          showTransparency={!off}
        />
      </>
    );
  }

  const statusKey: 'idle' | 'narrating' | 'paused' | 'human' | 'collaborative' = streaming
    ? 'narrating'
    : paused
      ? 'paused'
      : humanControl
        ? 'human'
        : collaborative
          ? 'collaborative'
          : 'idle';
  const statusLabel = {
    idle: t('table.seatIdle'),
    narrating: t('table.seatNarrating'),
    paused: t('table.seatPaused'),
    human: t('table.seatHumanControl'),
    collaborative: t('table.seatCollaborative'),
  }[statusKey];

  return (
    <div
      className="max-w-3xl mx-auto w-full px-4 py-5 flex flex-col gap-3 min-h-0"
      style={{ height: 'calc(100dvh - 60px)' }}
    >
      {/* Issue #1711: sr-only landmark — see the comment above the gated-state returns. */}
      <PageTitle className="sr-only">{t('table.title')}</PageTitle>
      {/* Header: scene, status pill, token budget, DM pause/resume */}
      <Card density="default">
        <div className="flex items-start gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-widest text-secondary">
                {t('table.scene')}
              </span>
              <Chip variant={STATUS_VARIANT[statusKey]}>{statusLabel}</Chip>
            </div>
            <p className="text-sm mt-1 truncate text-[var(--color-neutral-200)]">
              {session?.scene || t('table.noScene')}
            </p>
            {session !== undefined && (
              <p className="text-[11px] text-secondary mt-0.5">
                {t('table.turnCount', { count: session.turnCount })}
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <BudgetMeter used={seat?.tokensUsed ?? 0} budget={seat?.tokenBudget ?? 0} />
            {isDm && (
              <div className="flex items-center justify-end gap-1.5">
                <Btn ghost onClick={onTogglePause} disabled={pauseBusy}>
                  {paused ? t('table.resume') : t('table.pause')}
                </Btn>
                {/* #1501 — DM-only "Undo the AI's last action". The lever is the server's
                    `lastUndoableCommit`; the button is hidden entirely (not merely disabled) when
                    there is nothing to reverse, so it never offers an action the server would 404. */}
                {session?.lastUndoableCommit && (
                  <Btn
                    ghost
                    onClick={() => void undoAiAction()}
                    disabled={undoBusy}
                    title={t('table.undoAiAction')}
                  >
                    {t('table.undoAiAction')}
                  </Btn>
                )}
              </div>
            )}
            {/* #1043 — session lifecycle. Start Session is player+ (sitting down to play is a
                table act); Wrap Up is DM-only (closing a session is a decision). Both are hidden
                while a lifecycle turn is mid-flight rather than merely disabled, so the header
                does not offer an action the server is about to 409.

                `canCompose` (dm | player) mirrors the server's player+ gate on start-session. A
                VIEWER was previously shown the button and got a 403 on click — the same "control
                that cannot succeed" defect as the ended composer, and against this block's own
                stated intent. Wrap Up keeps its additional `isDm` check on top. */}
            {canCompose && phase !== 'greeting' && phase !== 'wrap_up' && (
              <div className="flex gap-1.5">
                <Btn ghost onClick={() => void onLifecycle('start-session')} disabled={lifecycleBusy}>
                  {t('table.startSession')}
                </Btn>
                {isDm && phase !== 'ended' && (
                  <Btn ghost onClick={() => void onLifecycle('wrap-up')} disabled={lifecycleBusy}>
                    {t('table.wrapUp')}
                  </Btn>
                )}
              </div>
            )}
          </div>
        </div>
        {phase !== 'active' && (
          <p className="text-xs text-secondary mt-2" data-testid="ai-phase-note">
            {t(`table.phaseNote.${phase}`)}
          </p>
        )}
        {pauseError && <p className="text-xs text-rose-400 mt-2">{pauseError}</p>}
        {undoError && <p className="text-xs text-rose-400 mt-2">{undoError}</p>}
        {lifecycleError && <p className="text-xs text-rose-400 mt-2">{lifecycleError}</p>}
      </Card>

      {/* #1558 — pending AI tool confirmations. Mounted HIGH, directly under the header and above
          the transcript, because it is an action a DM must take during play within seconds. It
          renders nothing when the queue is empty, so it costs the page no space until it matters
          and its appearance is itself the signal. */}
      <ToolConfirmationsPanel campaignId={campaignId} isDm={isDm} knownEntities={confirmationEntities} />

      {/* Live-encounter strip (design point 4) */}
      {activeEncounter && (
        <Link
          to={`/c/${campaignId}/encounters/${activeEncounter.id}`}
          className="cf-inset p-3 flex items-center gap-2 text-sm"
          style={{ color: 'var(--color-neutral-200)' }}
        >
          <span className="flex text-[var(--color-accent)]"><GameIcon slug="crossed-swords" size={UI_ICON_SIZE.sm} /></span>
          <span className="font-semibold">{t('table.liveEncounterTitle')}</span>
          {currentCombatantName && (
            <span className="text-secondary">· {t('table.liveEncounterTurn', { name: currentCombatantName })}</span>
          )}
          <span className="ml-auto text-[var(--color-accent)]">{t('table.openTracker')} →</span>
        </Link>
      )}

      {/*
        #340: the stuck-ladder banner + recovery levers, driven by session.stuck /
        session.state / session.vote / session.actingDm (all carried by useAiDmSession).
        The SSE stuck/recovered/vote/takeover signals invalidate the session query (above),
        so this reconciles live for every member; a rules-lookup answer is folded straight
        into the transcript as a system line.
      */}
      {session && (
        <StuckLadder
          campaignId={campaignId!}
          session={session}
          isDm={isDm}
          canAct={canCompose}
          myUserId={me ? String(me.user.id) : null}
          onRulesAnswer={(query, answer) =>
            dispatch({ type: 'localSystem', variant: 'rules', text: answer, data: { query } })
          }
        />
      )}

      {/*
        #577: rulings the server could NOT trace to an authorized retrieval this turn. The
        transcript keeps every word the AI said; this card labels the factual claims inside it
        as unverified, shows the provider/model that produced them plus evidence links for the
        citations that DID check out, and lets a DM correct one into every later turn.
      */}
      {campaignId !== undefined && <GroundingPanel campaignId={campaignId} isDm={isDm} />}

      {/* Transcript — named log landmark with aria-live=off so token deltas
          never spam SRs. The sr-only mirror below owns polite additions. */}
      <Card density="comfortable" flush className="flex-1 min-h-0 flex flex-col overflow-hidden relative">
        <div
          ref={transcriptRef}
          {...NARRATION_VISUAL_TRANSCRIPT}
          onScroll={handleTranscriptScroll}
          className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3"
          aria-label={t('table.transcriptLabel')}
          aria-busy={streaming || undefined}
          tabIndex={0}
          style={{ overflowAnchor: 'none' }}
        >
          {transcript.entries.length === 0 ? (
            <EmptyState icon="campfire" title={t('table.emptyTitle')} hint={t('table.emptyHint')} />
          ) : (
            transcript.entries.map((entry) => (
              <TranscriptRow
                key={entry.id}
                entry={entry}
                campaignId={campaignId!}
                encounterId={activeEncounterId}
              />
            ))
          )}
          <div ref={bottomRef} />
        </div>
        {!followLatest && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10">
            <Btn type="button" onClick={jumpToLatest} data-testid="transcript-jump-latest">
              {unreadBelow > 0
                ? t('table.jumpToLatestUnread', { count: unreadBelow })
                : t('table.jumpToLatest')}
            </Btn>
          </div>
        )}
      </Card>

      {/*
        #573 — the explicit device grant. OFF by default: the server owns the authoritative
        transcript and refetches it on every load, so keeping a copy in this browser buys a
        frame of earlier paint and costs a readable record of who said what at the table.
        On a shared device that trade is not ours to make silently, so the private option is
        the default and remembering is something the player asks for. Turning it back off
        purges what is already stored rather than only stopping future writes.
      */}
      <div className="flex items-start gap-2 px-1">
        <Toggle
          checked={rememberTranscript}
          disabled={viewerId === null}
          onChange={onToggleRememberTranscript}
          label={t('table.rememberTranscript')}
          title={t('table.rememberTranscriptHelp')}
          size={15}
          className="mt-0.5"
        />
        <div className="min-w-0">
          <span className="text-xs text-[var(--color-neutral-200)]">{t('table.rememberTranscript')}</span>
          <p className="text-[11px] text-secondary">{t('table.rememberTranscriptHelp')}</p>
        </div>
      </div>

      {/* #1077: polite log mirror — appends only finished entries (turn.end). */}
      <div
        {...NARRATION_LOG_LIVE_REGION}
        aria-label={t('table.narrationLogLabel')}
        className="sr-only"
        data-testid="ai-narration-log"
      >
        {narrationLogMirror.map((addition) => (
          <p key={addition.id}>
            {formatNarrationLogAddition(addition, {
              // Same localized copy as the visible transcript (not English fallback).
              // Tool additions use their own spoken text (not system/info, which ignores `text`).
              formatSystem: (a) =>
                systemText(
                  {
                    id: a.id,
                    kind: 'system',
                    variant: a.variant,
                    text: a.text,
                    data: a.data,
                    at: '',
                  },
                  t,
                ),
            })}
          </p>
        ))}
      </div>

      {/* #1077: turn.start/end + composer lock/unlock — same status pattern as
          DraftWithAiButton / StuckLadder. */}
      <div
        {...NARRATION_STATUS_LIVE_REGION}
        className="sr-only"
        data-testid="ai-narration-status"
      >
        {a11yStatus}
      </div>

      {/* Composer */}
      {canCompose ? (
        <form onSubmit={onSubmit} className="flex flex-col gap-2" data-testid="ai-table-composer">
          {isDm && readiness && (
            <div className="cf-inset p-2 text-[11px] text-secondary" data-testid="ai-run-cost-estimate">
              <span className="font-semibold text-[var(--color-neutral-300)]">{t('aiOnboarding.runCost.label')}</span>{' '}
              {/* Prompt/completion only when the server has a real split to report. On a
                  campaign with metered turns it has a total and nothing more. */}
              {readiness.estimatedCost.estimatedPromptTokens === null ||
              readiness.estimatedCost.estimatedCompletionTokens === null
                ? t('aiOnboarding.runCost.summaryTotal', {
                    tokens: formatNumber(readiness.estimatedCost.estimatedTotalTokens),
                  })
                : t('aiOnboarding.runCost.summary', {
                    tokens: formatNumber(readiness.estimatedCost.estimatedTotalTokens),
                    prompt: formatNumber(readiness.estimatedCost.estimatedPromptTokens),
                    completion: formatNumber(readiness.estimatedCost.estimatedCompletionTokens),
                  })}{' '}
              {/* #1065 — the same money line as the settings card, from the same basis. It
                  used to render `toFixed(4)` against a hardcoded-null figure: five decimal
                  places of implied accuracy on an estimate that did not exist. */}
              {runCostUsd !== null && t('aiOnboarding.runCost.usdKnown', { usd: runCostUsd })}
              {/* The full reason-specific disclosure, not the generic "USD varies by
                  provider/model" this used to show. The DM standing at the composer about to
                  spend money is the person best placed to act on "this campaign uses a custom
                  endpoint and nobody has priced it" — telling them less than the settings card
                  does, at the moment it matters most, was the wrong way round. */}
              {runCostUsd === null && (
                <CostDisclosure
                  className="mt-1"
                  basis={readiness.estimatedCost.basis ?? AI_COST_BASIS_UNKNOWN}
                  amount={null}
                  scopeKey="aiOnboarding.cost.scopePerTurn"
                />
              )}
            </div>
          )}
          {isDm && (
            <Field
              idPrefix={AI_TABLE_PREFIX}
              name={AI_TABLE_FIELD.scene}
              label={t('table.sceneFieldLabel')}
              value={sceneField}
              onChange={(e) => setSceneField(e.target.value)}
              placeholder={t('table.sceneFieldPlaceholder')}
              help={t('table.sceneFieldHelp')}
              disabled={submitting}
              optional
            />
          )}
          <div className="flex items-end gap-2">
            <Field
              idPrefix={AI_TABLE_PREFIX}
              name={AI_TABLE_FIELD.action}
              as="textarea"
              label={t('table.composerLabel')}
              className="field flex-1 min-w-0"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void onSubmit(e as unknown as FormEvent);
                }
              }}
              help={locked && lockReason ? lockReason : t('table.composerHelp')}
              placeholder={locked && lockReason ? lockReason : placeholder}
              disabled={locked || submitting}
              rows={2}
              minHeight={56}
              error={submitError}
              style={{ resize: 'none' }}
            />
            <Btn type="submit" disabled={locked || submitting || !input.trim()}>
              {submitting ? t('table.sending') : t('table.send')}
            </Btn>
          </div>
        </form>
      ) : (
        <p className="text-xs text-center text-secondary py-2">{t('table.viewerHint')}</p>
      )}
      {/* #1501 — the standard "X — Undo" affordance, offered to a DM the moment the AI commits a
          reversible action. The persistent header button covers the case where this dismisses. */}
      {isDm && undoSnackbar && (
        <UndoSnackbar
          message={t('table.undoAiSnackbar', { action: undoSnackbar.actionName || t('table.undoAiAction') })}
          onUndo={undoAiAction}
          onExpire={() => setUndoSnackbar(null)}
          successMessage={t('table.undoAiDone')}
        />
      )}
    </div>
  );
}

/** The token-budget meter in the header. */
function BudgetMeter({ used, budget }: { used: number; budget: number }) {
  const { t } = useTranslation();
  if (budget <= 0) {
    return <span className="text-[11px] text-secondary">{t('table.noBudget')}</span>;
  }
  const pct = Math.max(0, Math.min(100, (used / budget) * 100));
  const tone = pct > 90 ? '#f43f5e' : pct > 70 ? '#f59e0b' : 'var(--color-accent)';
  return (
    <div className="text-right">
      <div className="text-[10px] uppercase tracking-widest text-secondary">{t('table.tokenBudget')}</div>
      <div
        className="mt-1 rounded-full overflow-hidden"
        style={{ width: 120, height: 6, background: 'var(--color-neutral-800)' }}
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div style={{ width: `${pct}%`, height: '100%', background: tone }} />
      </div>
      <div className="text-[10px] text-secondary mt-0.5">
        {t('table.tokensUsedOf', { used: formatNumber(used), budget: formatNumber(budget) })}
      </div>
    </div>
  );
}


/**
 * Gated/off/error fallback for the Table page (onboarding #343). This lives ABOVE and
 * OUTSIDE the driver-mode render (and thus clear of the #340 SEAM): it's only reached by
 * the early returns for the loading/error/off/co-DM states.
 *
 * Three shapes:
 *   - `error` given → the mapped gate explainer (aiGate.ts) + link; DMs also get the
 *     full setup checklist so a real gate is actionable, not a dead end.
 *   - `showChecklist` → the DM setup stepper (seat is off).
 *   - `showTransparency` → the player-facing "what the AI sees" note (co-DM state).
 */
function Gate({
  icon = 'cancel',
  title,
  hint,
  campaignId,
  isDm,
  isAdmin,
  error,
  showChecklist,
  showTransparency,
}: {
  icon?: string;
  title?: string;
  hint?: string;
  campaignId: number | undefined;
  isDm: boolean;
  isAdmin: boolean;
  error?: unknown;
  showChecklist?: boolean;
  showTransparency?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="max-w-lg mx-auto px-4 mt-10 space-y-4">
      <Card className="space-y-3">
        {error !== undefined ? (
          <>
            <p className="flex justify-center text-[var(--color-neutral-400)]"><GameIcon slug={icon} size={30} reserveSpace /></p>
            {/* Only surface the fix link when the current viewer can act on it. */}
            <AiGateExplainer err={error} campaignId={campaignId} canFix={isDm || isAdmin} />
          </>
        ) : (
          <div className="text-center space-y-2">
            <p className="flex justify-center text-[var(--color-neutral-400)]"><GameIcon slug={icon} size={30} reserveSpace /></p>
            {title && <p className="font-bold text-[var(--color-text)]">{title}</p>}
            {hint && <p className="text-sm text-[var(--color-neutral-400)]">{hint}</p>}
            {isDm && campaignId !== undefined && !showChecklist && (
              <Link to={`/c/${campaignId}/settings#ai-dm`} className="cf-btn inline-flex no-underline">
                {t('table.openSettings')}
              </Link>
            )}
          </div>
        )}
        {showTransparency && <AiTransparencyNote />}
      </Card>

      {(showChecklist || (error !== undefined && isDm)) && campaignId !== undefined && (
        <Card>
          <AiSetupChecklist campaignId={campaignId} isAdmin={isAdmin} />
        </Card>
      )}
    </div>
  );
}
