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
import { useEffect, useMemo, useReducer, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Character, Encounter, EncounterWithCombatants } from '@campfire/schema';
import { api, API, translateApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { GameIcon } from '../../components/GameIcon';
import {
  queryKeys,
  useAiDmSeat,
  useAiDmSession,
  invalidateAiDm,
} from '../../lib/query';
import { useAiDmStream } from '../../lib/useAiDmStream';
import {
  transcriptReducer,
  loadTranscript,
  saveTranscript,
  speakerPrefix,
  dmEntryText,
  emptyTranscript,
  type DmEntry,
  type PlayerEntry,
  type SystemEntry,
  type ToolEntry,
} from './transcript';
import { invalidateForToolEvent, resolveToolActivity, type ToolResource } from './toolActivity';
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
import { AiSetupChecklist, AiGateExplainer, AiTransparencyNote } from './AiSetupChecklist';
import { StuckLadder } from './StuckLadder';
import { Markdown } from '../../components/Markdown';
import { Field } from '../../components/Field';
import { AI_TABLE_FIELD, AI_TABLE_PREFIX } from '../../components/formFieldLabels';
import { Btn, Card, Chip, EmptyState, Skeleton, type ChipVariant } from '../../components/ui';

/** game-icons slug for a tool chip's resource family — the shared map returns lucide
 * names, which this app doesn't bundle, so we render an equivalent <GameIcon> glyph. */
const RESOURCE_ICON: Record<ToolResource, string> = {
  dice: 'rolling-dices',
  encounter: 'crossed-swords',
  party: 'shield',
  map: 'treasure-map',
  proposals: 'quill-ink',
  rules: 'open-book',
  other: 'sparkles',
};

/** Seat status → chip variant for the header status pill. */
const STATUS_VARIANT: Record<'idle' | 'narrating' | 'paused' | 'human', ChipVariant> = {
  idle: 'available',
  narrating: 'active',
  paused: 'private',
  human: 'dm',
};

export default function AiTablePage() {
  const { t } = useTranslation();
  const params = useParams<{ campaignId: string }>();
  const campaignId = params.campaignId ? Number(params.campaignId) : undefined;
  const { me, roleIn, isAdmin } = useAuth();
  const queryClient = useQueryClient();

  const role = campaignId !== undefined ? roleIn(campaignId) : null;
  const isDm = role === 'dm';
  const canCompose = role === 'dm' || role === 'player';

  const seatQuery = useAiDmSeat(campaignId);
  const seat = seatQuery.data;
  const isDriver = seat?.mode === 'driver';

  const sessionQuery = useAiDmSession(campaignId);
  const session = sessionQuery.data;

  // The running transcript is assembled client-side (see transcript.ts). Lazy-hydrate
  // from localStorage so a reload keeps the recent local scrollback.
  const [transcript, dispatch] = useReducer(
    transcriptReducer,
    campaignId,
    (id) => (id !== undefined ? loadTranscript(id) : emptyTranscript),
  );

  // `streaming` is the table-wide composer lock: true between turn.start and turn.end.
  // It is driven purely by SSE events, so every client's composer locks in lockstep.
  const [streaming, setStreaming] = useState(false);

  const [input, setInput] = useState('');
  const [sceneField, setSceneField] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pauseError, setPauseError] = useState<string | null>(null);
  const [pauseBusy, setPauseBusy] = useState(false);

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

  // Persist the transcript on every change (bounded inside saveTranscript).
  useEffect(() => {
    if (campaignId !== undefined) saveTranscript(campaignId, transcript);
  }, [campaignId, transcript]);

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
        else if (event.type === 'turn.end') setStreaming(false);
        else if (event.type === 'tool') {
          invalidateForToolEvent(queryClient, event, { campaignId, encounterId: activeEncounterId });
        } else if (
          event.type === 'state' ||
          event.type === 'stuck' ||
          event.type === 'recovered' ||
          event.type === 'vote' ||
          event.type === 'takeover'
        ) {
          // Lifecycle signals move the thin server truth — reconcile the session/seat reads
          // so the header + composer-lock reflect the new state (#340 reads the same truth).
          invalidateAiDm(queryClient, campaignId);
          if (event.type === 'state' && event.state !== 'running') setStreaming(false);
        }
      },
      onReconnect: () => {
        if (campaignId === undefined) return;
        // Transport drop healed — refetch session + live surfaces we may have missed.
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

  // Auto-scroll to the newest entry as the transcript grows / streams.
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [transcript.entries]);

  // Composer lock: streaming OR a state the stuck-ladder issue (#340) owns.
  const paused = session?.state === 'paused';
  const humanControl = session?.state === 'human_control';
  const awaiting = session?.state === 'awaiting_players';
  const locked = streaming || paused || humanControl || awaiting;
  const lockReason = streaming
    ? t('table.composerLockedStreaming')
    : paused
      ? t('table.composerLockedPaused')
      : humanControl
        ? t('table.composerLockedHuman')
        : awaiting
          ? t('table.composerLockedAwaiting')
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
    // Prefix with the speaker identity (#317-safe flavour). The DM may also set the scene.
    const body: { input: string; scene?: string } = {
      input: `${speakerPrefix(memberName, characterName)} ${text}`,
    };
    if (isDm && sceneField.trim()) body.scene = sceneField.trim();
    try {
      await api.post(`${API}/campaigns/${campaignId}/ai-dm/message`, body);
      // Echo our own action immediately — the stream carries only the AI's narration back.
      dispatch({ type: 'localPlayer', memberName, characterName, text });
      setInput('');
      setSceneField('');
    } catch (err) {
      // 403 (gate/turn cap) / 503 (provider) messages are shown verbatim.
      setSubmitError(translateApiError(err, t));
    } finally {
      setSubmitting(false);
    }
  }

  async function onTogglePause() {
    if (campaignId === undefined) return;
    const action = paused ? 'resume' : 'pause';
    setPauseBusy(true);
    setPauseError(null);
    try {
      await api.post(`${API}/campaigns/${campaignId}/ai-dm/${action}`);
      invalidateAiDm(queryClient, campaignId);
    } catch {
      setPauseError(t('table.pauseFailed'));
    } finally {
      setPauseBusy(false);
    }
  }

  // ---- Gated / off / loading states --------------------------------------
  // The onboarding issue (#343) owns the rich explainer/checklist; here we render only
  // the minimal fallback the issue calls for (message + a settings link).

  if (seatQuery.isLoading) {
    return (
      <div className="max-w-3xl mx-auto px-4 mt-8">
        <Skeleton lines={6} />
      </div>
    );
  }

  if (seatQuery.isError) {
    // Onboarding (#343): a blocked seat read maps to a friendly explainer + deep link
    // (aiGate.ts) instead of a bare 403, and a DM gets the full setup checklist.
    return (
      <Gate campaignId={campaignId} isDm={isDm} isAdmin={isAdmin} error={seatQuery.error} />
    );
  }

  if (!isDriver) {
    const off = seat?.mode === 'off';
    return (
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
    );
  }

  const statusKey: 'idle' | 'narrating' | 'paused' | 'human' = streaming
    ? 'narrating'
    : paused
      ? 'paused'
      : humanControl
        ? 'human'
        : 'idle';
  const statusLabel = {
    idle: t('table.seatIdle'),
    narrating: t('table.seatNarrating'),
    paused: t('table.seatPaused'),
    human: t('table.seatHumanControl'),
  }[statusKey];

  return (
    <div className="max-w-3xl mx-auto w-full px-4 py-5 flex flex-col gap-3" style={{ minHeight: 'calc(100dvh - 60px)' }}>
      {/* Header: scene, status pill, token budget, DM pause/resume */}
      <Card className="!p-4">
        <div className="flex items-start gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-neutral-600)]">
                {t('table.scene')}
              </span>
              <Chip variant={STATUS_VARIANT[statusKey]}>{statusLabel}</Chip>
            </div>
            <p className="text-sm mt-1 truncate text-[var(--color-neutral-200)]">
              {session?.scene || t('table.noScene')}
            </p>
            {session !== undefined && (
              <p className="text-[11px] text-[var(--color-neutral-600)] mt-0.5">
                {t('table.turnCount', { count: session.turnCount })}
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <BudgetMeter used={seat?.tokensUsed ?? 0} budget={seat?.tokenBudget ?? 0} />
            {isDm && (
              <Btn ghost onClick={onTogglePause} disabled={pauseBusy}>
                {paused ? t('table.resume') : t('table.pause')}
              </Btn>
            )}
          </div>
        </div>
        {pauseError && <p className="text-xs text-rose-400 mt-2">{pauseError}</p>}
      </Card>

      {/* Live-encounter strip (design point 4) */}
      {activeEncounter && (
        <Link
          to={`/c/${campaignId}/encounters/${activeEncounter.id}`}
          className="cf-inset p-3 flex items-center gap-2 text-sm"
          style={{ color: 'var(--color-neutral-200)' }}
        >
          <span className="flex text-[var(--color-accent)]"><GameIcon slug="crossed-swords" size={16} /></span>
          <span className="font-semibold">{t('table.liveEncounterTitle')}</span>
          {currentCombatantName && (
            <span className="text-[var(--color-neutral-600)]">· {t('table.liveEncounterTurn', { name: currentCombatantName })}</span>
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

      {/* Transcript — named log landmark with aria-live=off so token deltas
          never spam SRs. The sr-only mirror below owns polite additions. */}
      <Card className="!p-0 flex-1 flex flex-col overflow-hidden">
        <div
          {...NARRATION_VISUAL_TRANSCRIPT}
          className="flex-1 overflow-y-auto p-4 space-y-3"
          aria-label={t('table.transcriptLabel')}
          aria-busy={streaming || undefined}
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
      </Card>

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
        <p className="text-xs text-center text-[var(--color-neutral-600)] py-2">{t('table.viewerHint')}</p>
      )}
    </div>
  );
}

/** The token-budget meter in the header. */
function BudgetMeter({ used, budget }: { used: number; budget: number }) {
  const { t } = useTranslation();
  if (budget <= 0) {
    return <span className="text-[11px] text-[var(--color-neutral-600)]">{t('table.noBudget')}</span>;
  }
  const pct = Math.max(0, Math.min(100, (used / budget) * 100));
  const tone = pct > 90 ? '#f43f5e' : pct > 70 ? '#f59e0b' : 'var(--color-accent)';
  return (
    <div className="text-right">
      <div className="text-[10px] uppercase tracking-widest text-[var(--color-neutral-600)]">{t('table.tokenBudget')}</div>
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
      <div className="text-[10px] text-[var(--color-neutral-600)] mt-0.5">
        {t('table.tokensUsedOf', { used: used.toLocaleString(), budget: budget.toLocaleString() })}
      </div>
    </div>
  );
}

/** Render one transcript entry. */
function TranscriptRow({
  entry,
  campaignId,
  encounterId,
}: {
  entry: PlayerEntry | DmEntry | ToolEntry | SystemEntry;
  campaignId: number;
  encounterId?: number;
}) {
  const { t } = useTranslation();

  if (entry.kind === 'player') {
    return (
      <div className="flex flex-col items-end">
        <div className="text-[11px] text-[var(--color-neutral-600)] mb-0.5">
          {entry.characterName
            ? `${entry.characterName} · ${t('table.playedBy', { name: entry.memberName })}`
            : entry.memberName}
        </div>
        <div
          className="max-w-[85%] rounded-lg px-3 py-2 text-sm"
          style={{
            background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)',
            color: 'var(--color-neutral-100)',
          }}
        >
          {entry.text}
        </div>
      </div>
    );
  }

  if (entry.kind === 'dm') {
    const text = dmEntryText(entry);
    return (
      <div className="flex flex-col items-start">
        <div className="text-[11px] font-semibold text-[var(--color-accent)] mb-0.5">DM</div>
        <div className="max-w-[92%] rounded-lg px-3 py-2 cf-inset">
          {text ? <Markdown>{text}</Markdown> : <span className="cf-typing text-[var(--color-neutral-600)]">…</span>}
          {entry.status === 'streaming' && text && <span className="cf-typing"> ▍</span>}
          {entry.meta && (
            <div className="text-[10px] text-[var(--color-neutral-600)] mt-1.5 pt-1.5 border-t border-[var(--color-divider)]">
              {entry.meta.stopReason} · {entry.meta.steps} steps · {entry.meta.tokensUsed.toLocaleString()} tokens ·{' '}
              {entry.meta.budgetRemaining.toLocaleString()} left
            </div>
          )}
        </div>
      </div>
    );
  }

  if (entry.kind === 'tool') {
    const chip = resolveToolActivity(
      { type: 'tool', campaignId, name: entry.name, isError: entry.isError, proposed: entry.proposed, at: entry.at },
      { campaignId, encounterId },
    );
    const tone =
      chip.variant === 'error'
        ? 'var(--color-neutral-600)'
        : chip.variant === 'proposal'
          ? 'var(--color-accent)'
          : 'var(--color-neutral-400)';
    const body = (
      <span
        className="cf-chip inline-flex items-center gap-1"
        style={{ color: tone, borderColor: 'var(--color-divider)' }}
      >
        <span className="flex"><GameIcon slug={RESOURCE_ICON[chip.resource]} size={13} /></span>
        <span>{chip.label}</span>
      </span>
    );
    return (
      <div className="flex justify-center">
        {chip.href ? (
          <Link to={chip.href}>{body}</Link>
        ) : (
          body
        )}
      </div>
    );
  }

  // system: a rules-lookup answer renders as a small compendium card (question + answer);
  // every other system variant is a single italic divider line.
  if (entry.variant === 'rules') {
    return (
      <div className="flex justify-center">
        <div className="cf-inset px-3 py-2 max-w-[92%] text-sm">
          <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-neutral-600)]">
            {t('ladder.rulesAnswerLabel', { query: entry.data?.query ?? '' })}
          </div>
          <div className="mt-1">
            <Markdown>{entry.text ?? ''}</Markdown>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-center">
      <span className="text-[11px] text-[var(--color-neutral-600)] italic px-2">{systemText(entry, t)}</span>
    </div>
  );
}

/** Localized text for a system/divider transcript line (visible + SR mirror). */
function systemText(entry: SystemEntry, t: (k: string, o?: Record<string, unknown>) => string): string {
  switch (entry.variant) {
    case 'divider':
      return `— ${t('table.joinedDivider')} —`;
    case 'scene':
      return t('table.systemScene', { text: entry.text ?? '' });
    case 'stuck':
      return entry.text ? `${t('table.systemStuck')} ${entry.text}` : t('table.systemStuck');
    case 'recovered':
      return t('table.systemRecovered');
    case 'paused':
      return t('table.systemPaused');
    case 'resumed':
      return t('table.systemResumed');
    case 'takeover':
      return t('table.systemTakeover');
    case 'vote':
      return t('table.systemVote', { action: entry.data?.action ?? '' });
    case 'rules':
      return entry.text
        ? t('table.systemRules', { text: entry.text })
        : t('table.systemRulesEmpty');
    case 'info':
    default:
      return t('table.systemInfo', { state: entry.data?.state ?? '' });
  }
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
