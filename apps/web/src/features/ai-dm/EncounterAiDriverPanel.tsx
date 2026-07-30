/**
 * Collapsible AI-DM driver dock on the encounter page (issue #427).
 *
 * Reuses the app-wide stream transcript from `useAiDmLiveActivity` (no second SSE
 * connection) and surfaces the Table's composer + stuck-ladder recovery controls in
 * context so supervising a Driver DM does not require leaving the combat tracker.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Character, Combatant, EncounterWithCombatants } from '@campfire/schema';
import { api, API, translateApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { queryKeys, useAiDmSession, invalidateAiDm } from '../../lib/query';
import { speakerPrefix } from './transcript';
import { StuckLadder } from './StuckLadder';
import { ToolConfirmationsPanel } from './ToolConfirmationsPanel';
import { TranscriptRow } from './AiDmTranscriptUi';
import { useAiDmLiveActivity } from './useAiDmLiveActivity';
import {
  followLatestAfterUserScroll,
  isFeedNearBottom,
  shouldScrollTranscriptToTailOnMount,
  unreadAfterFeedGrowth,
} from './feedScrollFollow';
import { NARRATION_VISUAL_TRANSCRIPT } from './narrationAccessibility';
import { useDisclosure } from '../../components/useDisclosure';
import { Btn, Card, Chip, EmptyState } from '../../components/ui';
import { Field } from '../../components/Field';
import { GameIcon } from '../../components/GameIcon';
import { UI_ICON_SIZE } from '../../lib/uiIcons';

export const ENCOUNTER_DRIVER_PANEL_ID = 'encounter-ai-driver-panel';

export function EncounterAiDriverPanel({
  campaignId,
  encounterId,
  encounter,
  isDm,
  canCompose,
}: {
  campaignId: number;
  encounterId: number;
  encounter: EncounterWithCombatants;
  isDm: boolean;
  canCompose: boolean;
}) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const queryClient = useQueryClient();
  const liveActivity = useAiDmLiveActivity();
  const sessionQuery = useAiDmSession(campaignId);
  const session = sessionQuery.data;

  const { open, buttonProps, regionProps } = useDisclosure({
    id: ENCOUNTER_DRIVER_PANEL_ID,
    regionLabel: t('encounters.driver.panelLabel'),
    focusManagement: true,
  });

  const transcript = liveActivity.transcript;
  const dispatchTranscript = liveActivity.dispatchTranscript;
  const streaming = liveActivity.turnActive;

  const [input, setInput] = useState('');
  const [sceneField, setSceneField] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pauseError, setPauseError] = useState<string | null>(null);
  const [pauseBusy, setPauseBusy] = useState(false);

  const charactersQuery = useQuery({
    queryKey: queryKeys.campaignCharacters(campaignId),
    queryFn: () => api.get<Character[]>(`${API}/campaigns/${campaignId}/characters`),
    enabled: open,
  });

  const myMembership = me?.memberships.find((m) => m.campaignId === campaignId);
  const myCharacter = charactersQuery.data?.find((c) => c.id === myMembership?.characterId);
  const memberName = me?.user.displayName || me?.user.username || t('table.you');
  const characterName = myCharacter?.name;

  const currentCombatantName = useMemo(() => {
    if (!encounter.currentCombatantId) return undefined;
    return encounter.combatants.find((c: Combatant) => c.id === encounter.currentCombatantId)?.name;
  }, [encounter.combatants, encounter.currentCombatantId]);

  /**
   * #1494 — the id → name map the confirmation summaries resolve against, assembled from reads
   * THIS PANEL ALREADY MAKES (the encounter's combatants + the roster fetched when the dock
   * opens). Mirrors AiTablePage's derivation so the same combatant/character ids that name a
   * summary on the Table name it here too; an id neither holds stays an id rather than being
   * named from a fetch the viewer was never authorized for.
   */
  const confirmationEntities = useMemo(
    () => [...(charactersQuery.data ?? []), ...encounter.combatants],
    [charactersQuery.data, encounter.combatants],
  );

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

  const placeholder =
    encounter.status === 'running'
      ? currentCombatantName
        ? t('table.composerPlaceholderTurn', { name: currentCombatantName })
        : t('table.composerPlaceholderCombat')
      : t('table.composerPlaceholder');

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

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || locked || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    const body: { input: string; scene?: string; characterId?: number } = {
      input: `${speakerPrefix(memberName, characterName)} ${text}`,
      characterId: myMembership?.characterId ?? undefined,
    };
    if (isDm && sceneField.trim()) body.scene = sceneField.trim();
    try {
      await api.post(`${API}/campaigns/${campaignId}/ai-dm/message`, body);
      dispatchTranscript({ type: 'localPlayer', memberName, characterName, text });
      setInput('');
      setSceneField('');
    } catch (err) {
      setSubmitError(translateApiError(err, t));
    } finally {
      setSubmitting(false);
    }
  }

  async function onTogglePause() {
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

  const transcriptRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const [followLatest, setFollowLatest] = useState(true);
  const [unreadBelow, setUnreadBelow] = useState(0);
  const prevEntryCountRef = useRef(transcript.entries.length);
  const transcriptMountScrollDoneRef = useRef(false);
  const ignoreScrollUnpinRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    transcriptMountScrollDoneRef.current = false;
    followLatestRef.current = true;
    setFollowLatest(true);
    setUnreadBelow(0);
    prevEntryCountRef.current = transcript.entries.length;
  }, [open, campaignId, encounterId, transcript.entries.length]);

  useEffect(() => {
    followLatestRef.current = followLatest;
  }, [followLatest]);

  const transcriptRevision = useMemo(() => {
    const last = transcript.entries[transcript.entries.length - 1];
    return `${transcript.entries.length}:${last?.id ?? ''}`;
  }, [transcript.entries]);

  useEffect(() => {
    if (!open) return;
    const prev = prevEntryCountRef.current;
    const next = transcript.entries.length;
    prevEntryCountRef.current = next;
    setUnreadBelow((unread) => unreadAfterFeedGrowth(unread, followLatestRef.current, prev, next));
  }, [open, transcript.entries.length]);

  const handleTranscriptScroll = useCallback(() => {
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
    ignoreScrollUnpinRef.current = true;
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        ignoreScrollUnpinRef.current = false;
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
      }
      return;
    }
    if (!canScroll) return;
    if (followLatestRef.current) {
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
    if (!open) return;
    const el = transcriptRef.current;
    if (!el) return;
    const sync = () => syncTranscriptTailScroll();
    sync();
    const raf = window.requestAnimationFrame(() => window.requestAnimationFrame(sync));
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => {
      window.cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [open, transcriptRevision, syncTranscriptTailScroll]);

  if (liveActivity.mode !== 'driver') return null;

  return (
    <Card density="default" className="flex flex-col gap-0 overflow-hidden" data-testid="encounter-ai-driver-panel">
      <div className="flex items-center gap-2 flex-wrap p-3 pb-2">
        <Btn
          type="button"
          ghost
          density="compact"
          className="text-sm font-semibold flex items-center gap-2"
          data-testid="encounter-ai-driver-toggle"
          {...buttonProps}
        >
          <GameIcon slug="campfire" size={UI_ICON_SIZE.sm} />
          {t('encounters.driver.toggle')}
          <Chip variant={statusKey === 'narrating' ? 'active' : statusKey === 'paused' ? 'private' : 'available'}>
            {statusLabel}
          </Chip>
        </Btn>
        <div className="flex-1" />
        <Link
          to={`/c/${campaignId}/table`}
          className="text-xs text-[var(--color-accent)] no-underline hover:underline"
        >
          {t('encounters.driver.openTable')} →
        </Link>
      </div>

      {open && (
        <div {...regionProps} className="flex flex-col gap-3 px-3 pb-3 min-h-0 border-t border-[var(--color-divider)] pt-3">
          {/*
            #1494 — pending AI tool confirmations, surfaced where a DM mid-encounter is actually
            looking when `begin_encounter` / `end_encounter` / `award_xp` fire. Reuses the
            app-wide confirmation queue (the same React Query key as the AI Table) and its SSE +
            GET recovery path — no second stream — so a confirmation queued on either surface
            resolves from either. The panel renders nothing for non-DMs or an empty queue, so its
            appearance is itself the signal; mounted first so a waiting decision is seen before
            the transcript scrolls it out of view.
          */}
          <ToolConfirmationsPanel campaignId={campaignId} isDm={isDm} knownEntities={confirmationEntities} />

          <div className="flex flex-wrap items-center gap-2 justify-between">
            <p className="text-xs text-secondary m-0 truncate flex-1 min-w-0">
              {session?.scene ? (
                <>
                  <span className="font-semibold text-[var(--color-neutral-300)]">{t('table.scene')}: </span>
                  {session.scene}
                </>
              ) : (
                t('table.noScene')
              )}
            </p>
            {isDm && (
              <Btn density="xs" ghost className="" onClick={onTogglePause} disabled={pauseBusy}>
                {paused ? t('table.resume') : t('table.pause')}
              </Btn>
            )}
          </div>
          {pauseError && <p className="text-xs text-rose-400 m-0">{pauseError}</p>}

          {session && (
            <StuckLadder
              campaignId={campaignId}
              session={session}
              isDm={isDm}
              canAct={canCompose}
              myUserId={me ? String(me.user.id) : null}
              onRulesAnswer={(query, answer) =>
                dispatchTranscript({ type: 'localSystem', variant: 'rules', text: answer, data: { query } })
              }
            />
          )}

          <Card density="comfortable" flush className="relative flex flex-col min-h-[12rem] max-h-[min(40vh,22rem)] overflow-hidden">
            <div
              ref={transcriptRef}
              {...NARRATION_VISUAL_TRANSCRIPT}
              onScroll={handleTranscriptScroll}
              className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2"
              aria-label={t('encounters.driver.transcriptLabel')}
              aria-busy={streaming || undefined}
              tabIndex={0}
            >
              {transcript.entries.length === 0 ? (
                <EmptyState icon="campfire" title={t('table.emptyTitle')} hint={t('table.emptyHint')} />
              ) : (
                transcript.entries.map((entry) => (
                  <TranscriptRow
                    key={entry.id}
                    entry={entry}
                    campaignId={campaignId}
                    encounterId={encounterId}
                  />
                ))
              )}
              <div ref={bottomRef} />
            </div>
            {!followLatest && (
              <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-10">
                <Btn type="button" onClick={jumpToLatest} data-testid="encounter-driver-jump-latest">
                  {unreadBelow > 0
                    ? t('table.jumpToLatestUnread', { count: unreadBelow })
                    : t('table.jumpToLatest')}
                </Btn>
              </div>
            )}
          </Card>

          {canCompose ? (
            <form onSubmit={onSubmit} className="flex flex-col gap-2" data-testid="encounter-ai-driver-composer">
              {isDm && (
                <Field
                  idPrefix="encounter-driver"
                  name="scene"
                  label={t('table.sceneFieldLabel')}
                  value={sceneField}
                  onChange={(e) => setSceneField(e.target.value)}
                  placeholder={t('table.sceneFieldPlaceholder')}
                  help={t('table.sceneFieldHelp')}
                  disabled={submitting}
                  optional
                />
              )}
              <div className="flex items-end gap-2 flex-col sm:flex-row">
                <Field
                  idPrefix="encounter-driver"
                  name="action"
                  as="textarea"
                  label={t('table.composerLabel')}
                  className="field flex-1 min-w-0 w-full"
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
                  minHeight={48}
                  error={submitError}
                  style={{ resize: 'none' }}
                />
                <Btn type="submit" disabled={locked || submitting || !input.trim()} className="w-full sm:w-auto">
                  {submitting ? t('table.sending') : t('table.send')}
                </Btn>
              </div>
            </form>
          ) : (
            <p className="text-xs text-center text-secondary py-1 m-0">{t('table.viewerHint')}</p>
          )}
        </div>
      )}
    </Card>
  );
}

