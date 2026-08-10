/**
 * Shared dice log (issue #35) — the table's roll feed, persisted server-side per
 * campaign so every member sees everyone's rolls (they were previously client-local
 * component state, invisible to the rest of the table and lost on reload).
 *
 * One component, two densities: `compact` for the dashboard DiceWidget card, full
 * size for RunSessionPage's dice log. POSTs to the existing /campaigns/:id/roll
 * endpoint (which now persists) and polls GET /campaigns/:id/rolls while the tab
 * is visible — same 5s poll-while-visible convention as RunSessionPage's encounter
 * refresh. When the SSE event stream lands (issue #4) the poll can be swapped for
 * a push without touching the rendering below.
 */
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ruleSystemAdapter, type ActionRollRequest, type DiceRoll } from '@campfire/schema';
import { api, API, ApiError, getWithHeaders } from '../../lib/api';
import { Card, TextInput, Btn } from '../../components/ui';
import { useAnnounce } from '../../components/Announcer';
import { useRollResultToast } from '../../components/RollResultToastContext';
import { useCampaignAccessFor } from '../../app/CampaignAccessContext';
import { DiceTray } from './DiceTray';
import { openLegendActionRollAnimationExpr, openLegendActionRollAnimationSides } from './diceTrayExpressions';
import { RolledDice } from './RolledDice';
import { RolledTerms } from './RolledTerms';
import { canonicalizeDiceExpr } from '../../lib/i18nNumbers';
import { d20Flavor, d20TotalClasses } from '../../lib/d20Flavor';
import { timeAgo, useTimeTick, formatDateTime } from '../../lib/format';
import {
  advanceDiceRollAnnouncements,
  DICE_LOG_LIVE_REGION,
  formatDiceRollAnnouncementBatch,
  type DiceRollAnnouncementCursor,
} from './diceLogAccessibility';
import {
  diceRollDisplayActor,
  diceRollGroupRole,
  diceRollKindAccentVar,
  diceRollKindLabelKey,
  diceRollKindTagClass,
  diceRollSummaryLine,
  showRolledDice,
} from './diceRollDisplay';
import {
  EMPTY_PHYSICAL_ROLL_FORM,
  isManualDiceRoll,
  parsePhysicalRollForm,
  type PhysicalRollFormFields,
} from './physicalRollForm';
import {
  clearLocalDiceAnnouncements,
  rememberLocalDiceAnnouncement,
  takeLocalDiceAnnouncements,
} from './localDiceAnnouncements';
import { useCampaign } from '../../app/CampaignContext';
import { useAuth } from '../../app/auth';
import { useCampaignEvents, type CampaignEventsStatus } from '../../lib/useCampaignEvents';
import { prefersReducedMotion } from '../../lib/prefersReducedMotion';

const DEGRADED_POLL_MS = 60000;

export function SharedDiceLog({ campaignId, compact = false }: { campaignId: number; compact?: boolean }) {
  useTimeTick();
  const { t } = useTranslation();
  const { me } = useAuth();
  // `canAnyMemberWrite`, not `canMemberWrite`: `POST /campaigns/:id/roll` calls
  // `requireMemberOnWritableCampaign`, which asserts membership and writability and nothing
  // about role, so a VIEWER may roll. Gating the tray on the viewer-excluding flag hid controls
  // the server would have accepted — and told the user the campaign was archived when it was
  // not. Visible on the character sheet (#2115 review), where a viewer who owns a character
  // saw enabled action chips beside a tray claiming the campaign was read-only.
  const { canAnyMemberWrite, writable } = useCampaignAccessFor(campaignId);
  const campaign = useCampaign(campaignId);
  const supportsActionDice = Boolean(
    ruleSystemAdapter(campaign?.ruleSystem, campaign?.customMechanicsProfile).attributeDicePool,
  );
  const limit = compact ? 4 : 8;
  const [expr, setExpr] = useState('1d20');
  const [physical, setPhysical] = useState<PhysicalRollFormFields>(EMPTY_PHYSICAL_ROLL_FORM);
  const [rolling, setRolling] = useState(false);
  const [loggingPhysical, setLoggingPhysical] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rolls, setRolls] = useState<DiceRoll[]>([]);
  const [sseStatus, setSseStatus] = useState<CampaignEventsStatus | null>(null);
  // Id of the roll the local user (or fresh spectator roll) just made/received.
  const [justRolledId, setJustRolledId] = useState<number | null>(null);
  // Durable retention ceiling disclosed by the server (#614).
  const [retention, setRetention] = useState<number | null | undefined>(undefined);
  const announce = useAnnounce();
  const { beginRollAnimation, cancelRollAnimation, showRoll } = useRollResultToast();
  const exprId = useId();
  const physicalTotalId = useId();
  const physicalLabelId = useId();
  const physicalActorId = useId();
  const physicalNaturalId = useId();
  const physicalDcId = useId();
  const rollAnnouncementRef = useRef<{
    campaignId: number;
    cursor: DiceRollAnnouncementCursor;
  } | null>(null);
  /** Which campaign the in-memory `rolls` array came from (guards campaign switches). */
  const rollsCampaignIdRef = useRef<number | null>(null);
  const knownRollIdsRef = useRef<Set<number>>(new Set());
  const isInitialLoadRef = useRef<boolean>(true);

  useEffect(() => {
    rollAnnouncementRef.current = null;
    rollsCampaignIdRef.current = null;
    knownRollIdsRef.current = new Set();
    isInitialLoadRef.current = true;
    setRolls([]);
    setRetention(undefined);
    setJustRolledId(null);
    setError(null);
    // Clear the *previous* campaign on switch/unmount (cleanup runs with that id).
    return () => {
      clearLocalDiceAnnouncements(campaignId);
    };
  }, [campaignId]);

  // Remote (and local) rolls share one ID cursor so poll refetches never double-speak.
  // Skip the pre-fetch empty render — otherwise the first poll would announce full history.
  // A null cursor establishes the silent baseline; never pass a non-null seed on first
  // load or every hydrated id would be treated as "appended" (orchestrator / #590).
  useEffect(() => {
    if (rollsCampaignIdRef.current !== campaignId) return;

    const previous = rollAnnouncementRef.current;
    const cursor = previous?.campaignId === campaignId ? previous.cursor : null;

    const localIds = takeLocalDiceAnnouncements(campaignId);
    if (cursor === null) {
      const baseline = advanceDiceRollAnnouncements(rolls, null);
      for (const id of localIds) baseline.cursor.seenRollIds.add(id);
      rollAnnouncementRef.current = { campaignId, cursor: baseline.cursor };
      return;
    }

    const merged: DiceRollAnnouncementCursor = {
      seenRollIds: new Set([...cursor.seenRollIds, ...localIds]),
    };
    const advanced = advanceDiceRollAnnouncements(rolls, merged);
    rollAnnouncementRef.current = { campaignId, cursor: advanced.cursor };

    const message = formatDiceRollAnnouncementBatch(advanced.appendedRolls, t);
    if (!message) return;
    const appended = advanced.appendedRolls;
    const firstId = appended[0]!.id;
    const lastId = appended[appended.length - 1]!.id;
    announce(message, {
      dedupeKey: `dice-roll:${campaignId}:${appended.length}:${firstId}:${lastId}`,
    });
  }, [rolls, campaignId, announce, t]);

  const load = useCallback(async () => {
    try {
      const { data, headers } = await getWithHeaders<DiceRoll[]>(`${API}/campaigns/${campaignId}/rolls?limit=${limit}`);
      rollsCampaignIdRef.current = campaignId;

      if (isInitialLoadRef.current) {
        for (const r of data) knownRollIdsRef.current.add(r.id);
        isInitialLoadRef.current = false;
      } else {
        const newlyArrived = data.filter((r) => !knownRollIdsRef.current.has(r.id));
        for (const r of data) knownRollIdsRef.current.add(r.id);

        if (newlyArrived.length > 0) {
          const now = Date.now();
          const freshNonOwn = newlyArrived.filter((r) => {
            if (isManualDiceRoll(r)) return false;
            if (me?.user?.id != null && String(r.rollerUserId) === String(me.user.id)) return false;
            const rollTime = new Date(r.createdAt).getTime();
            if (Number.isNaN(rollTime) || now - rollTime >= 8000) return false;
            return true;
          });

          // Bursts >2 coalesce to feed tumble-in only (no spectator overlay).
          if (freshNonOwn.length > 0 && freshNonOwn.length <= 2) {
            const allowAnimation = me?.user?.animateOthersRolls !== false && !prefersReducedMotion();
            for (const r of freshNonOwn) {
              setJustRolledId(r.id);
              if (allowAnimation) {
                beginRollAnimation(r.expr);
                showRoll(r, { applyDisabled: true });
              }
            }
          }
        }
      }

      setRolls(data);
      // Retention is disclosed per-response so it tracks the server's current
      // policy (incl. the "unlimited" keep-all mode) without a separate call.
      const r = headers.get('X-Dice-Rolls-Retention');
      setRetention(r === null ? undefined : r === 'unlimited' ? null : Number.isFinite(Number(r)) ? Number(r) : undefined);
    } catch {
      /* keep last-known feed; next poll retries */
    }
  }, [campaignId, limit, me?.user?.id, me?.user?.animateOthersRolls, beginRollAnimation, showRoll]);

  useCampaignEvents(Number.isFinite(campaignId) ? campaignId : undefined, {
    onEvent: (event) => {
      if (event.type === 'dice.rolled') {
        void load();
      }
    },
    onReconnect: () => {
      void load();
    },
    onStreamRecovery: () => {
      void load();
    },
    onStatusChange: (status) => {
      setSseStatus(status);
    },
  });

  // Initial fetch + degraded poll fallback (~60s) when stream drops.
  // Demote 5s poll when the stream is healthy (connected).
  useEffect(() => {
    void load();
    if (sseStatus === 'connected') return;

    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      void load();
    };
    const handle = setInterval(tick, DEGRADED_POLL_MS);
    return () => clearInterval(handle);
  }, [load, sseStatus]);

  // Single roll-submit path, shared by the tap-to-build tray (issue #38) and the
  // advanced expression box. Kept intact so the shared-log/animation work (#35, #67)
  // can hook the same POST -> prepend -> announce flow. Returns the persisted roll so
  // the tray can surface a per-roll result (e.g. the kept die on an advantage roll).
  const submitExpr = useCallback(
    async (raw: string, label?: string): Promise<DiceRoll | null> => {
      const cleaned = canonicalizeDiceExpr(raw.trim());
      if (!cleaned) return null;
      setRolling(true);
      setError(null);
      beginRollAnimation(cleaned);
      try {
        const result = await api.post<DiceRoll>(`${API}/campaigns/${campaignId}/roll`, { expr: cleaned, label });
        knownRollIdsRef.current.add(result.id);
        const batch = formatDiceRollAnnouncementBatch([result], t);
        if (batch) {
          rememberLocalDiceAnnouncement(campaignId, result.id);
          announce(batch, {
            dedupeKey: `dice-roll:${campaignId}:1:${result.id}:${result.id}`,
          });
        }
        // Prepend own roll immediately (dedupe by id — the next poll returns it too).
        setRolls((prev) => {
          rollsCampaignIdRef.current = campaignId;
          const next = [result, ...prev.filter((r) => r.id !== result.id)].slice(0, limit);
          const previous = rollAnnouncementRef.current;
          const cursor = previous?.campaignId === campaignId ? previous.cursor : null;
          const advanced = advanceDiceRollAnnouncements(next, cursor);
          rollAnnouncementRef.current = { campaignId, cursor: advanced.cursor };
          return next;
        });
        setJustRolledId(result.id); // triggers the tumble/crit/fumble animation (issue #67)
        showRoll(result);
        return result;
      } catch (err) {
        cancelRollAnimation();
        const message = err instanceof ApiError ? err.message : t('dice.rollError');
        setError(message);
        announce(message, { assertive: true });
        return null;
      } finally {
        setRolling(false);
      }
    },
    [campaignId, limit, announce, beginRollAnimation, cancelRollAnimation, showRoll, t],
  );

  const submitActionRoll = useCallback(
    async (payload: ActionRollRequest): Promise<DiceRoll | null> => {
      setRolling(true);
      setError(null);
      beginRollAnimation(openLegendActionRollAnimationExpr(payload.score));
      try {
        const result = await api.post<DiceRoll>(`${API}/campaigns/${campaignId}/roll/action`, payload);
        knownRollIdsRef.current.add(result.id);
        const batch = formatDiceRollAnnouncementBatch([result], t);
        if (batch) {
          rememberLocalDiceAnnouncement(campaignId, result.id);
          announce(batch, {
            dedupeKey: `dice-roll:${campaignId}:1:${result.id}:${result.id}`,
          });
        }
        setRolls((prev) => {
          rollsCampaignIdRef.current = campaignId;
          const next = [result, ...prev.filter((r) => r.id !== result.id)].slice(0, limit);
          const previous = rollAnnouncementRef.current;
          const cursor = previous?.campaignId === campaignId ? previous.cursor : null;
          const advanced = advanceDiceRollAnnouncements(next, cursor);
          rollAnnouncementRef.current = { campaignId, cursor: advanced.cursor };
          return next;
        });
        setJustRolledId(result.id);
        showRoll(result, { animationSides: openLegendActionRollAnimationSides(result.terms) });
        return result;
      } catch (err) {
        cancelRollAnimation();
        const message = err instanceof ApiError ? err.message : t('dice.rollError');
        setError(message);
        announce(message, { assertive: true });
        return null;
      } finally {
        setRolling(false);
      }
    },
    [campaignId, limit, announce, beginRollAnimation, cancelRollAnimation, showRoll, t],
  );

  async function rollFromInput(e: FormEvent) {
    e.preventDefault();
    await submitExpr(expr);
  }

  const prependRoll = useCallback(
    (result: DiceRoll) => {
      knownRollIdsRef.current.add(result.id);
      const batch = formatDiceRollAnnouncementBatch([result], t);
      if (batch) {
        rememberLocalDiceAnnouncement(campaignId, result.id);
        announce(batch, {
          dedupeKey: `dice-roll:${campaignId}:1:${result.id}:${result.id}`,
        });
      }
      setRolls((prev) => {
        rollsCampaignIdRef.current = campaignId;
        const next = [result, ...prev.filter((r) => r.id !== result.id)].slice(0, limit);
        const previous = rollAnnouncementRef.current;
        const cursor = previous?.campaignId === campaignId ? previous.cursor : null;
        const advanced = advanceDiceRollAnnouncements(next, cursor);
        rollAnnouncementRef.current = { campaignId, cursor: advanced.cursor };
        return next;
      });
      setJustRolledId(result.id);
    },
    [campaignId, limit, announce, t],
  );

  const submitPhysical = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const parsed = parsePhysicalRollForm(physical);
      if (!parsed.ok) {
        const message = t(
          parsed.error === 'totalRequired'
            ? 'dice.physicalErrorTotalRequired'
            : parsed.error === 'totalInvalid'
              ? 'dice.physicalErrorTotalInvalid'
              : parsed.error === 'natural20Invalid'
                ? 'dice.physicalErrorNatural20Invalid'
                : 'dice.physicalErrorDcInvalid',
        );
        setError(message);
        announce(message, { assertive: true });
        return;
      }
      setLoggingPhysical(true);
      setError(null);
      try {
        const result = await api.post<DiceRoll>(`${API}/campaigns/${campaignId}/roll/manual`, parsed.payload);
        prependRoll(result);
        setPhysical(EMPTY_PHYSICAL_ROLL_FORM);
      } catch (err) {
        const message = err instanceof ApiError ? err.message : t('dice.physicalRollError');
        setError(message);
        announce(message, { assertive: true });
      } finally {
        setLoggingPhysical(false);
      }
    },
    [physical, campaignId, prependRoll, announce, t],
  );

  return (
    <Card className="space-y-2.5">
      <span className="card-kicker">{compact ? t('dice.dice') : t('dice.diceLog')}</span>
      {canAnyMemberWrite ? (
        <>
          <DiceTray
            onSubmitExpr={submitExpr}
            onSubmitActionRoll={submitActionRoll}
            supportsActionDice={supportsActionDice}
            rolling={rolling}
            campaignId={campaignId}
            compact={compact}
          />
          <details className="dice-advanced">
            <summary className="text-muted" style={{ fontSize: 11.5, cursor: 'pointer' }}>
              {t('dice.advancedSummary')}
            </summary>
            <form onSubmit={rollFromInput} className="flex gap-2 items-end flex-wrap" style={{ marginTop: 8 }}>
              <div className="field" style={{ flex: 1, minWidth: compact ? 100 : 120 }}>
                <label htmlFor={exprId}>{t('dice.expression')}</label>
                <TextInput
                  id={exprId}
                  aria-label={t('dice.diceExpressionLabel')}
                  placeholder={t('dice.exprPlaceholder')}
                  value={expr}
                  onChange={(e) => setExpr(e.target.value)}
                />
              </div>
              <Btn type="submit" density={compact ? 'xs' : undefined} className={compact ? 'text-xs' : undefined} disabled={rolling || !expr.trim()}>
                {rolling ? t('dice.rolling') : t('dice.roll')}
              </Btn>
            </form>
          </details>
          <details className="dice-physical" data-testid="physical-roll-form">
            <summary className="text-muted" style={{ fontSize: 11.5, cursor: 'pointer' }}>
              {t('dice.physicalRollSummary')}
            </summary>
            <p className="text-muted m-0" style={{ fontSize: 11, marginTop: 8 }}>
              {t('dice.physicalRollHint')}
            </p>
            <form onSubmit={submitPhysical} className="flex gap-2 items-end flex-wrap" style={{ marginTop: 8 }}>
              <div className="field" style={{ flex: '0 1 72px', minWidth: 64 }}>
                <label htmlFor={physicalTotalId}>{t('dice.physicalTotal')}</label>
                <TextInput
                  id={physicalTotalId}
                  inputMode="numeric"
                  aria-label={t('dice.physicalTotalLabel')}
                  value={physical.total}
                  onChange={(e) => setPhysical((p) => ({ ...p, total: e.target.value }))}
                  required
                />
              </div>
              <div className="field" style={{ flex: 1, minWidth: compact ? 90 : 110 }}>
                <label htmlFor={physicalLabelId}>{t('dice.physicalLabel')}</label>
                <TextInput
                  id={physicalLabelId}
                  aria-label={t('dice.physicalLabel')}
                  placeholder={t('dice.physicalLabelPlaceholder')}
                  value={physical.label}
                  onChange={(e) => setPhysical((p) => ({ ...p, label: e.target.value }))}
                />
              </div>
              <div className="field" style={{ flex: 1, minWidth: compact ? 90 : 110 }}>
                <label htmlFor={physicalActorId}>{t('dice.physicalActor')}</label>
                <TextInput
                  id={physicalActorId}
                  aria-label={t('dice.physicalActor')}
                  placeholder={t('dice.physicalActorPlaceholder')}
                  value={physical.actor}
                  onChange={(e) => setPhysical((p) => ({ ...p, actor: e.target.value }))}
                />
              </div>
              <div className="field" style={{ flex: '0 1 72px', minWidth: 64 }}>
                <label htmlFor={physicalNaturalId}>{t('dice.physicalNatural20')}</label>
                <TextInput
                  id={physicalNaturalId}
                  inputMode="numeric"
                  aria-label={t('dice.physicalNatural20')}
                  placeholder={t('dice.physicalNatural20Placeholder')}
                  value={physical.natural20}
                  onChange={(e) => setPhysical((p) => ({ ...p, natural20: e.target.value }))}
                />
              </div>
              <div className="field" style={{ flex: '0 1 56px', minWidth: 48 }}>
                <label htmlFor={physicalDcId}>{t('dice.physicalDc')}</label>
                <TextInput
                  id={physicalDcId}
                  inputMode="numeric"
                  aria-label={t('dice.physicalDc')}
                  placeholder={t('dice.physicalDcPlaceholder')}
                  value={physical.dc}
                  onChange={(e) => setPhysical((p) => ({ ...p, dc: e.target.value }))}
                />
              </div>
              <Btn
                type="submit"
                density={compact ? 'xs' : undefined}
                className={compact ? 'text-xs' : undefined}
                disabled={loggingPhysical || !physical.total.trim()}
              >
                {loggingPhysical ? t('dice.physicalSubmitting') : t('dice.physicalSubmit')}
              </Btn>
            </form>
          </details>
        </>
      ) : (
        <p className="text-muted m-0" style={{ fontSize: 11.5 }}>
          {writable
            ? 'Dice rolling is available to campaign members.'
            : 'Dice rolling is disabled while this campaign is archived (read-only).'}
        </p>
      )}
      {error && <p role="alert" className="text-sm text-rose-400">{error}</p>}
      <div
        {...DICE_LOG_LIVE_REGION}
        aria-label={compact ? t('dice.dice') : t('dice.diceLogFeedLabel')}
        data-testid="shared-dice-log"
        className="flex flex-col gap-1"
      >
        {rolls.length === 0 ? (
          <p className="text-muted" style={{ fontSize: 11.5, margin: 0 }}>
            {supportsActionDice
              ? compact
                ? t('dice.emptyActionCompact')
                : t('dice.emptyActionFull')
              : compact
                ? t('dice.emptyCompact')
                : t('dice.emptyFull')}
          </p>
        ) : (
          rolls.map((r, i) => {
            const manual = isManualDiceRoll(r);
            const flavor = manual ? null : d20Flavor(r);
            const fresh = r.id === justRolledId && !manual;
            const totalClass = d20TotalClasses(flavor, fresh);
            const summary = diceRollSummaryLine(r, t('dice.physicalExpr'));
            const kindTagClass = diceRollKindTagClass(r.kind);
            const kindLabelKey = diceRollKindLabelKey(r.kind);
            // Issue #2183: literal per-kind grouping — bands a *run* of consecutive
            // same-kind rows with a shared accent, without reordering the
            // chronological list. See `diceRollGroupRole`'s doc comment for why.
            const groupRole = diceRollGroupRole(rolls, i);
            const groupAccent = groupRole === 'solo' ? null : diceRollKindAccentVar(r.kind);
            return (
            <div
              key={r.id}
              title={formatDateTime(r.createdAt)}
              data-dice-roll-kind={r.kind ?? 'unclassified'}
              data-dice-roll-group={groupRole}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                minHeight: compact ? 28 : 32,
                ...(groupAccent
                  ? {
                      borderLeft: `3px solid ${groupAccent}`,
                      background: `color-mix(in srgb, ${groupAccent} 10%, transparent)`,
                      borderRadius: 6,
                      paddingLeft: 6,
                      paddingRight: 6,
                    }
                  : null),
              }}
            >
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, display: 'flex', gap: 8, alignItems: 'baseline', overflow: 'hidden' }}>
                <span className="text-muted" style={{ fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {diceRollDisplayActor(r)}
                </span>
                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  <bdi>{summary}</bdi>
                </span>
              </span>
              {manual && (
                <span
                  className="text-muted"
                  style={{ fontSize: 9.5, fontWeight: 600, flex: 'none', letterSpacing: '0.04em', textTransform: 'uppercase' }}
                  title={t('dice.physicalRollHint')}
                >
                  {t('dice.physicalBadge')}
                </span>
              )}
              {/* Issue #2155: kind badge — undefined for a manual/physical entry (never
                  classified) and for any pre-#2155 row (unclassified, not guessed). */}
              {kindTagClass && kindLabelKey && (
                <span className={`tag ${kindTagClass}`} style={{ fontSize: 9.5, flex: 'none', padding: '2px 7px' }}>
                  {t(kindLabelKey)}
                </span>
              )}
              {showRolledDice(r) && <RolledDice rolls={r.rolls} kept={r.kept} />}
              {!manual && r.terms && <RolledTerms terms={r.terms} />}
              {fresh && flavor === 'crit' && (
                <span className="cf-crit-spark" aria-hidden="true" style={{ fontSize: compact ? 12 : 14, color: 'var(--cf-crit)', flex: 'none' }}>
                  ✦
                </span>
              )}
              {r.dc != null && (
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    flex: 'none',
                    color: r.success ? 'var(--color-success, #4ade80)' : 'var(--color-danger, #f87171)',
                  }}
                >
                  {r.success ? t('dice.pass') : t('dice.fail')}
                </span>
              )}
              <bdi
                className={totalClass || undefined}
                style={{
                  fontFamily: 'var(--font-heading)',
                  fontSize: compact ? 16 : 18,
                  color: 'var(--color-accent)',
                  flex: 'none',
                }}
              >
                {r.total}
              </bdi>
              <bdi className="text-muted" style={{ fontSize: 10, flex: 'none', minWidth: 26, textAlign: 'end' }}>
                {timeAgo(r.createdAt)}
              </bdi>
            </div>
            );
          })
        )}
      </div>
      {/* #614: disclose the durable retention policy honestly. Hidden on the
          compact dashboard widget (no room) and until the first fetch resolves
          `retention`; null means "keep everything", a number is the cap. */}
      {!compact && retention !== undefined && (
        <p className="text-muted" style={{ fontSize: 10.5, margin: 0 }}>
          {retention === null
            ? t('dice.retentionUnbounded')
            : t('dice.retentionCapped', { count: retention })}
        </p>
      )}
    </Card>
  );
}
