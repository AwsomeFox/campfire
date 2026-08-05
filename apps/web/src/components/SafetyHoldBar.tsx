import { useCallback, useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { SafetyHoldRecovery } from '@campfire/schema';
import { api, API } from '../lib/api';
import { invalidateTableSafety, useTableSafety } from '../lib/query';
import { useCampaignAccess } from '../app/CampaignAccessContext';
import { useKeyboardCommandHint, useKeyboardGuardedAction } from './KeyboardCommandProvider';
import { Btn, ErrorNote, TextArea, TextInput } from './ui';
import { useDialog } from './useDialog';

const RECOVERIES: readonly SafetyHoldRecovery[] = ['resume', 'rewind', 'veil', 'scene_change', 'end'];

/**
 * The participant-facing table safety control (issue #599).
 *
 * Mounted once in the campaign Layout so it is present on EVERY campaign route — the encounter
 * tracker, the AI Table, quests, the party sheet. "Persistent" in the acceptance criteria is
 * doing real work: a safety tool you have to navigate to is a safety tool you do not have when
 * you need it, and the moment someone needs this is not a moment to go looking for a tab.
 *
 * FOUR THINGS THIS DELIBERATELY DOES NOT DO
 *
 *  1. It does not ask for a reason. There is no text field on the activation path at all.
 *  2. It does not confirm. A misfire costs the table thirty seconds and is trivially released;
 *     a confirm dialog costs a hesitation at the exact moment hesitation is the problem. The
 *     button fires on the first press.
 *  3. It does not check your role. Viewers see it and viewers can press it.
 *  4. It does not tell you who raised a hold unless they chose to say. The banner reads the
 *     same for every member of the table.
 *
 * The one deliberate friction is on the OTHER side: releasing opens a dialog and makes the
 * facilitator choose a recovery. That asymmetry — instant to stop, considered to restart — is
 * the whole shape of the feature.
 */
export function SafetyHoldBar({ campaignId }: { campaignId: number }) {
  const { t } = useTranslation();
  const { isDm } = useCampaignAccess();
  const queryClient = useQueryClient();
  const { data: hold } = useTableSafety(campaignId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [anonymous, setAnonymous] = useState(true);
  const [releasing, setReleasing] = useState(false);
  const shortcut = useKeyboardCommandHint('safetyHold');

  const active = hold?.active === true;

  const activate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`${API}/campaigns/${campaignId}/safety/hold`, { anonymous });
    } catch {
      // The message is intentionally about what to do next, not about the HTTP status. Someone
      // reading this has already decided the table needs to stop; a stack of jargon does not
      // help them, "say it out loud" does.
      setError(t('safety.activateFailed'));
    } finally {
      setBusy(false);
      invalidateTableSafety(queryClient, campaignId);
    }
  }, [anonymous, campaignId, queryClient, t]);

  // Not context-gated. `useKeyboardGuardedAction` takes a null action to disable a command;
  // passing a live one unconditionally is the point — there is no application state in which
  // a participant may not stop the table.
  useKeyboardGuardedAction('safetyHold', {
    canExecute: () => !busy && !active,
    execute: () => { void activate(); },
  });

  if (!hold) return null;

  return (
    <>
      <div className={`cf-safety-bar${active ? ' cf-safety-bar-active' : ''}`} data-testid="safety-bar">
        {active ? (
          <div className="cf-safety-banner" role="status" data-testid="safety-banner">
            <strong>{t('safety.paused')}</strong>{' '}
            <span>
              {hold.activatedByName
                ? t('safety.pausedByNamed', { name: hold.activatedByName })
                : t('safety.pausedByAnyone')}
            </span>
            {isDm && (
              <Btn density="compact" onClick={() => setReleasing(true)} data-testid="safety-release-open">
                {t('safety.resolve')}
              </Btn>
            )}
          </div>
        ) : (
          <div className="cf-safety-idle">
            <Btn
              danger
              busy={busy}
              onClick={() => void activate()}
              aria-keyshortcuts={shortcut.ariaKeyshortcuts}
              title={`${t('safety.holdTitle')}${shortcut.titleSuffix}`}
              data-testid="safety-hold-btn"
            >
              {t('safety.hold')}
            </Btn>
            <label className="cf-safety-anon">
              <input
                type="checkbox"
                checked={!anonymous}
                onChange={(e) => setAnonymous(!e.target.checked)}
                data-testid="safety-attribute"
              />
              {t('safety.attribute')}
            </label>
          </div>
        )}
        {error && <ErrorNote message={error} />}
      </div>
      {releasing && isDm && (
        <SafetyReleaseDialog
          campaignId={campaignId}
          onClose={() => setReleasing(false)}
        />
      )}
    </>
  );
}

/**
 * The facilitator's recovery dialog. `recovery` is required — there is no "just unpause"
 * button — because the acceptance criteria list five distinct recoveries and collapsing them
 * into one would turn a conversation the table needs to have into a click.
 */
function SafetyReleaseDialog({ campaignId, onClose }: { campaignId: number; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [recovery, setRecovery] = useState<SafetyHoldRecovery>('resume');
  const [note, setNote] = useState('');
  const [veil, setVeil] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const firstRef = useRef<HTMLSelectElement>(null);
  const dialogRef = useDialog<HTMLDivElement>({ onClose, disabled: saving, initialFocusRef: firstRef, inertBackground: true });

  const submit = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await api.post(`${API}/campaigns/${campaignId}/safety/release`, {
        recovery,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(recovery === 'veil' && veil.trim() ? { veil: veil.trim() } : {}),
      });
      onClose();
    } catch {
      setError(t('safety.releaseFailed'));
    } finally {
      setSaving(false);
      invalidateTableSafety(queryClient, campaignId);
    }
  }, [campaignId, note, onClose, queryClient, recovery, t, veil]);

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>{t('safety.resolveTitle')}</h2>
        <p className="text-muted">{t('safety.resolveHint')}</p>
        <label htmlFor={`${titleId}-recovery`}>{t('safety.recovery')}</label>
        <select
          id={`${titleId}-recovery`}
          ref={firstRef}
          className="cf-input"
          value={recovery}
          onChange={(e) => setRecovery(e.target.value as SafetyHoldRecovery)}
          data-testid="safety-recovery"
        >
          {RECOVERIES.map((r) => (
            <option key={r} value={r}>{t(`safety.recoveryOption.${r}`)}</option>
          ))}
        </select>
        {recovery === 'veil' && (
          <>
            <label htmlFor={`${titleId}-veil`}>{t('safety.veilLabel')}</label>
            <TextInput
              id={`${titleId}-veil`}
              value={veil}
              maxLength={500}
              onChange={(e) => setVeil(e.target.value)}
              placeholder={t('safety.veilPlaceholder')}
              data-testid="safety-veil"
            />
          </>
        )}
        <label htmlFor={`${titleId}-note`}>{t('safety.noteLabel')}</label>
        <TextArea
          id={`${titleId}-note`}
          value={note}
          maxLength={500}
          rows={3}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('safety.notePlaceholder')}
        />
        {/* Only `resume` restarts the AI seat; the others leave it paused on purpose. Saying so
            here stops a facilitator picking "scene change" and then waiting for a narration
            that is never coming. */}
        {recovery !== 'resume' && <p className="text-muted">{t('safety.stillPaused')}</p>}
        {error && <ErrorNote message={error} />}
        <div className="dialog-actions">
          <Btn ghost onClick={onClose} disabled={saving}>{t('safety.cancel')}</Btn>
          <Btn busy={saving} onClick={() => void submit()} data-testid="safety-release-submit">
            {t('safety.resolveSubmit')}
          </Btn>
        </div>
      </div>
    </div>
  );
}

/**
 * Presentational "the table is paused" overlay markup, shared by the authed and cast-token
 * Player Display (issue #1908). Split out so both routes render the identical DOM/strings —
 * the only difference is where `active` comes from: a member-scoped `useTableSafety` query
 * for the authed route, or a poll against the anonymous `/cast/:token/safety` capability for
 * a cast client, which has no member identity and cannot call the member endpoint at all.
 */
export function SafetyHoldOverlayView({ active }: { active: boolean }) {
  const { t } = useTranslation();
  // Render directly from the prop — no local state/effect copy. That
  // indirection delayed visibility by one render cycle in both directions
  // (raising the curtain, and lifting it), with no animation depending on the
  // intermediate state to justify it. On the cast route (issue #1908) it also
  // undermined the fail-safe "show the curtain until the first poll confirms
  // no hold" guarantee: `active` can be `true` on this component's very
  // first render (parent passes `castSafetyActive || !castSafetyKnown`), but
  // rendering from a `visible` state that only starts reflecting `active`
  // after a post-mount effect painted the scene underneath for that first
  // frame regardless.
  if (!active) return null;
  return (
    <div className="cf-safety-display" role="status" data-testid="safety-display-overlay">
      <div className="cf-safety-display-inner">
        <strong>{t('safety.paused')}</strong>
        <span>{t('safety.displayHint')}</span>
      </div>
    </div>
  );
}

/**
 * Read-only "the table is paused" overlay for the AUTHED shared display (issue #599).
 *
 * The cast screen is a television in the corner of a room. It has no keyboard, and on the
 * `/cast/:id/:token` route no member identity either, so it CANNOT raise a hold. What it must
 * do is stop showing the fiction: a monitor still cheerfully rendering the initiative order of
 * the fight everyone just stopped is the single most visible way this feature could fail. It
 * therefore carries the acknowledgment and nothing else — no actor, no reason, and no control.
 *
 * Cast-token clients cannot use this component (no membership to back `useTableSafety`'s
 * `GET /campaigns/:id/safety`); `PlayerDisplayPage` renders `SafetyHoldOverlayView` directly
 * for that route, fed from a poll against the anonymous `/cast/:token/safety` capability.
 */
export function SafetyHoldDisplayOverlay({ campaignId }: { campaignId: number }) {
  const { data: hold } = useTableSafety(campaignId);
  return <SafetyHoldOverlayView active={hold?.active === true} />;
}
