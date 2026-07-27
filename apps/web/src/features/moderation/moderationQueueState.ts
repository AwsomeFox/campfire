/**
 * Pure presentation logic for the moderation queue (issue #601).
 *
 * Kept out of the page component so the rules a DM actually depends on — which
 * verbs are offered on which report, which surfaces can be withheld, how a
 * status/reason maps to copy — are unit-testable without a browser, following
 * the `proposalSelection.ts` precedent.
 *
 * IMPORTANT: nothing here is a security control. The server re-decides every one
 * of these questions (see ModerationService.act / assertDmMayHandle). Hiding a
 * button the server would refuse is a courtesy to the DM, not a gate.
 */
import type { ChipVariant } from '../../components/chipVariants';
import type {
  ModerationActionType,
  ModerationEvidenceIntegrity,
  ModerationReport,
  ModerationReportReason,
  ModerationReportStatus,
  ModerationResolution,
  ModerationTargetType,
} from '@campfire/schema';

/** i18n key suffixes, so the page never hand-builds a translation key from a raw enum. */
const TARGET_KEYS: Record<ModerationTargetType, string> = {
  comment: 'targetComment',
  whisper: 'targetWhisper',
  note: 'targetNote',
  notification: 'targetNotification',
  ai_narration: 'targetAiNarration',
  conduct: 'targetConduct',
};

const REASON_KEYS: Record<ModerationReportReason, string> = {
  harassment: 'reasonHarassment',
  hate: 'reasonHate',
  sexual_content: 'reasonSexualContent',
  threat_or_violence: 'reasonThreatOrViolence',
  self_harm: 'reasonSelfHarm',
  privacy: 'reasonPrivacy',
  spam: 'reasonSpam',
  other: 'reasonOther',
};

const STATUS_KEYS: Record<ModerationReportStatus, string> = {
  open: 'statusOpen',
  acknowledged: 'statusAcknowledged',
  escalated: 'statusEscalated',
  resolved: 'statusResolved',
};

const RESOLUTION_KEYS: Record<ModerationResolution, string> = {
  upheld: 'resolutionUpheld',
  rejected: 'resolutionRejected',
  no_action: 'resolutionNoAction',
};

const ACTION_KEYS: Record<ModerationActionType, string> = {
  acknowledge: 'actionAcknowledge',
  quarantine: 'actionQuarantine',
  unquarantine: 'actionUnquarantine',
  mute: 'actionMute',
  unmute: 'actionUnmute',
  remove: 'actionRemove',
  escalate: 'actionEscalate',
  resolve: 'actionResolve',
};

export function targetKey(target: ModerationTargetType): string {
  return `moderation.${TARGET_KEYS[target]}`;
}
export function reasonKey(reason: ModerationReportReason): string {
  return `moderation.${REASON_KEYS[reason]}`;
}
export function statusKey(status: ModerationReportStatus): string {
  return `moderation.${STATUS_KEYS[status]}`;
}
export function resolutionKey(resolution: ModerationResolution): string {
  return `moderation.${RESOLUTION_KEYS[resolution]}`;
}
export function actionKey(action: ModerationActionType): string {
  return `moderation.${ACTION_KEYS[action]}`;
}

export const REPORT_REASONS: ModerationReportReason[] = [
  'harassment',
  'hate',
  'threat_or_violence',
  'sexual_content',
  'self_harm',
  'privacy',
  'spam',
  'other',
];

export const RESOLUTIONS: ModerationResolution[] = ['upheld', 'rejected', 'no_action'];

/**
 * Targets whose content the server holds and can therefore withhold or take down.
 * A notification is a delivered copy of something else, and AI narration / conduct
 * have no stored row at all, so quarantine and remove are meaningless for them —
 * the server refuses those combinations with a 400 and the queue should not offer
 * a button that is guaranteed to fail.
 */
export function isWithholdableTarget(target: ModerationTargetType): boolean {
  return target === 'comment' || target === 'note' || target === 'whisper';
}

/**
 * Chip tone for a status, mapped onto the app's EXISTING ChipVariant palette
 * rather than a moderation-specific one — an incident queue should read like the
 * rest of Campfire, and a new variant would need new CSS in nocturne.css to mean
 * anything. `failed` (red) for escalated is the strongest tone available and is
 * the right one: an escalation is the queue's alarm state.
 */
export function statusVariantFor(status: ModerationReportStatus): ChipVariant {
  switch (status) {
    case 'open':
      return 'active';
    case 'acknowledged':
      return 'neutral';
    case 'escalated':
      return 'failed';
    case 'resolved':
      return 'completed';
  }
}

/** Chip tone for an evidence integrity verdict. `tampered` must read as an alarm. */
export function integrityVariantFor(integrity: ModerationEvidenceIntegrity): ChipVariant {
  if (integrity === 'intact') return 'completed';
  if (integrity === 'redacted') return 'neutral';
  return 'failed';
}

/**
 * The verbs a DM may usefully apply to this report, in the order they appear in
 * the row. Rules, and the reasoning behind each:
 *
 *  - A RESOLVED report offers nothing: reopening is an escalation, and that belongs
 *    to the reporter (or a server admin), not to the DM who closed it.
 *  - An ESCALATED report offers nothing: it has left DM jurisdiction entirely.
 *  - `acknowledge` disappears once acknowledged — it is a one-way "I have seen this".
 *  - `quarantine`/`unquarantine` are mutually exclusive and only for withholdable targets.
 *  - `mute`/`unmute` need a machine-identified subject; a notification report has only
 *    a display name, so muting has nobody to act on.
 *  - `remove` is offered last among the content verbs because it is the least reversible
 *    thing on the row.
 */
export function availableActions(report: ModerationReport): ModerationActionType[] {
  if (report.status === 'resolved' || report.status === 'escalated') return [];
  const out: ModerationActionType[] = [];
  if (report.status === 'open') out.push('acknowledge');
  if (isWithholdableTarget(report.targetType) && report.targetId != null) {
    out.push(report.quarantined ? 'unquarantine' : 'quarantine');
  }
  if (report.subjectUserId) out.push('mute', 'unmute');
  if (isWithholdableTarget(report.targetType) && report.targetId != null) out.push('remove');
  out.push('escalate', 'resolve');
  return out;
}

/** Whether the signed-in member may escalate this report themselves (the appeal valve). */
export function canReporterEscalate(report: ModerationReport, userId: string | undefined): boolean {
  if (!userId) return false;
  if (report.reporterUserId !== userId) return false;
  return report.status !== 'escalated';
}

/** A short human label for the reported artefact, e.g. "Comment #12" / "Conduct". */
export function targetLabel(report: ModerationReport, t: (key: string) => string): string {
  const base = t(targetKey(report.targetType));
  return report.targetId == null ? base : `${base} #${report.targetId}`;
}
