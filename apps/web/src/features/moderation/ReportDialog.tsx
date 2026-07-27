/**
 * The report affordance (issue #601).
 *
 * One dialog for all six reportable surfaces. Which fields it shows is driven by
 * the target type, mirroring the server's own split:
 *   - comment / whisper / note / notification — the server already holds the
 *     content and snapshots it itself, so we send only a reason and optional
 *     details. Offering a "what was said" box here would be a lie: the server
 *     rejects reporter-supplied content for these targets outright.
 *   - ai_narration / conduct — there is no stored row to snapshot, so the
 *     reporter's own account IS the evidence and the content box is required.
 *
 * Accessibility: composes the shared `Dialog` (role="dialog", aria-modal, focus
 * trap, Escape-to-close, inert background) and routes every control through
 * `Field`, so each has a real `<label for>` and its help/error text is wired to
 * `aria-describedby`. The success and failure states are announced through the
 * app-wide live region rather than being visual-only — someone reporting abuse
 * needs unambiguous confirmation that it went through.
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ModerationReportReason, ModerationTargetType } from '@campfire/schema';
import { api, API, translateApiError } from '../../lib/api';
import { Btn, Dialog, ErrorNote } from '../../components/ui';
import { Field } from '../../components/Field';
import { useAnnounce } from '../../components/Announcer';
import { REPORT_REASONS, reasonKey } from './moderationQueueState';

export function ReportDialog({
  campaignId,
  targetType,
  targetId,
  onClose,
}: {
  campaignId: number;
  targetType: ModerationTargetType;
  /** Omitted for `conduct` (and optional for `ai_narration`). */
  targetId?: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnounce();
  const prefix = `report-${useId().replace(/:/g, '')}`;
  const titleId = `${prefix}-title`;

  const needsContent = targetType === 'ai_narration' || targetType === 'conduct';
  const [reason, setReason] = useState<ModerationReportReason>('harassment');
  const [details, setDetails] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`${API}/campaigns/${campaignId}/moderation/reports`, {
        targetType,
        ...(targetId != null ? { targetId } : {}),
        reason,
        details,
        // Only ever sent for the reporter-supplied targets: the server 400s if it
        // arrives for a target it captures itself, and silently dropping it would
        // let a reporter believe they attached evidence that was thrown away.
        ...(needsContent ? { content } : {}),
      });
      setSent(true);
      announce(t('moderation.reportSent'));
    } catch (err) {
      const message = translateApiError(err, t, { fallbackKey: 'moderation.reportFailed' });
      setError(message);
      announce(message);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <Dialog
        title={t('moderation.reportSent')}
        titleId={titleId}
        onBackdropClick={onClose}
        actions={<Btn onClick={onClose}>{t('moderation.reportClose')}</Btn>}
      >
        <p className="text-sm text-secondary" role="status">
          {t('moderation.reportSentBody')}
        </p>
      </Dialog>
    );
  }

  return (
    <Dialog
      title={targetType === 'conduct' ? t('moderation.reportTitleConduct') : t('moderation.reportTitle')}
      titleId={titleId}
      onBackdropClick={busy ? undefined : onClose}
      actions={
        <>
          <Btn ghost onClick={onClose} disabled={busy}>
            {t('moderation.reportCancel')}
          </Btn>
          <Btn onClick={submit} disabled={busy || (needsContent && content.trim() === '')}>
            {busy ? t('moderation.reportSubmitting') : t('moderation.reportSubmit')}
          </Btn>
        </>
      }
    >
      <div className="space-y-3">
        {/* Sets expectations up front: the snapshot is taken NOW, so an abuser
            deleting the message after the fact does not undo the report. */}
        <p className="text-xs text-secondary">{t('moderation.reportIntro')}</p>
        {error && <ErrorNote message={error} />}
        <Field
          idPrefix={prefix}
          name="reason"
          as="select"
          label={t('moderation.reportReason')}
          value={reason}
          onChange={(e) => setReason(e.target.value as ModerationReportReason)}
          required
        >
          {REPORT_REASONS.map((value) => (
            <option key={value} value={value}>
              {t(reasonKey(value))}
            </option>
          ))}
        </Field>
        {needsContent && (
          <Field
            idPrefix={prefix}
            name="content"
            as="textarea"
            label={t('moderation.reportContent')}
            help={t('moderation.reportContentHelp')}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            maxLength={20_000}
            required
          />
        )}
        <Field
          idPrefix={prefix}
          name="details"
          as="textarea"
          label={t('moderation.reportDetails')}
          help={t('moderation.reportDetailsHelp')}
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          maxLength={4000}
          optional
        />
      </div>
    </Dialog>
  );
}

/**
 * The inline "Report" button used on reportable surfaces. Owns its own dialog
 * state so a caller only has to drop it into an existing action row.
 */
export function ReportButton({
  campaignId,
  targetType,
  targetId,
  className = 'text-secondary hover:text-[var(--color-neutral-300)]',
}: {
  campaignId: number;
  targetType: ModerationTargetType;
  targetId?: number;
  className?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>
        {t('moderation.reportAction')}
      </button>
      {open && (
        <ReportDialog
          campaignId={campaignId}
          targetType={targetType}
          targetId={targetId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
