import { expect, test } from '@playwright/test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ModerationReport } from '@campfire/schema';
import {
  availableActions,
  canReporterEscalate,
  integrityVariantFor,
  isWithholdableTarget,
  statusVariantFor,
  targetLabel,
} from '../../src/features/moderation/moderationQueueState';

/**
 * Issue #601 — the moderation queue's presentation rules.
 *
 * These are courtesies, not controls (the server re-decides all of it), but they
 * are the difference between a DM confidently working a queue and a DM clicking
 * buttons that 400. Worth pinning.
 */

function report(overrides: Partial<ModerationReport> = {}): ModerationReport {
  return {
    id: 1,
    campaignId: 1,
    targetType: 'comment',
    targetId: 10,
    reporterUserId: '2',
    reporterName: 'Victim',
    subjectUserId: '3',
    subjectName: 'Abuser',
    reason: 'harassment',
    details: '',
    status: 'open',
    resolution: null,
    resolutionNote: '',
    evidenceId: 5,
    evidenceIntegrity: 'intact',
    quarantined: false,
    escalatedAt: null,
    escalationReason: '',
    acknowledgedAt: null,
    resolvedAt: null,
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
    ...overrides,
  };
}

test.describe('#601 moderation queue state', () => {
  test('offers the full verb set on a fresh comment report', () => {
    expect(availableActions(report())).toEqual([
      'acknowledge',
      'quarantine',
      'mute',
      'unmute',
      'remove',
      'escalate',
      'resolve',
    ]);
  });

  test('drops acknowledge once acknowledged and flips quarantine to its inverse', () => {
    const actions = availableActions(report({ status: 'acknowledged', quarantined: true }));
    expect(actions).not.toContain('acknowledge');
    expect(actions).toContain('unquarantine');
    expect(actions).not.toContain('quarantine');
  });

  test('offers nothing on a resolved or escalated report', () => {
    // Resolved: reopening is an escalation and belongs to the reporter, not the DM
    // who closed it. Escalated: the incident has left DM jurisdiction entirely.
    expect(availableActions(report({ status: 'resolved' }))).toEqual([]);
    expect(availableActions(report({ status: 'escalated' }))).toEqual([]);
  });

  test('hides content verbs for targets the server cannot withhold', () => {
    expect(isWithholdableTarget('comment')).toBe(true);
    expect(isWithholdableTarget('whisper')).toBe(true);
    expect(isWithholdableTarget('note')).toBe(true);
    expect(isWithholdableTarget('notification')).toBe(false);
    expect(isWithholdableTarget('ai_narration')).toBe(false);
    expect(isWithholdableTarget('conduct')).toBe(false);

    const conduct = availableActions(report({ targetType: 'conduct', targetId: null }));
    expect(conduct).not.toContain('quarantine');
    expect(conduct).not.toContain('remove');
    expect(conduct).toContain('mute'); // a conduct report CAN name its subject
  });

  test('hides mute when the report has no machine-identified subject', () => {
    // A notification report carries only the actor's display name, so there is
    // nobody the server can mute.
    const actions = availableActions(report({ targetType: 'notification', subjectUserId: '' }));
    expect(actions).not.toContain('mute');
    expect(actions).not.toContain('unmute');
  });

  test('lets only the reporter escalate their own un-escalated report', () => {
    expect(canReporterEscalate(report(), '2')).toBe(true);
    expect(canReporterEscalate(report(), '9')).toBe(false);
    expect(canReporterEscalate(report(), undefined)).toBe(false);
    expect(canReporterEscalate(report({ status: 'escalated' }), '2')).toBe(false);
  });

  test('maps statuses and integrity verdicts onto real chip variants', () => {
    expect(statusVariantFor('open')).toBe('active');
    expect(statusVariantFor('escalated')).toBe('failed');
    expect(statusVariantFor('resolved')).toBe('completed');
    expect(integrityVariantFor('intact')).toBe('completed');
    expect(integrityVariantFor('redacted')).toBe('neutral');
    // A hash mismatch with no recorded redaction must read as an alarm.
    expect(integrityVariantFor('tampered')).toBe('failed');
  });

  test('labels a target with its id, and without one when there is none', () => {
    const t = (key: string) => key;
    expect(targetLabel(report(), t)).toBe('moderation.targetComment #10');
    expect(targetLabel(report({ targetType: 'conduct', targetId: null }), t)).toBe('moderation.targetConduct');
  });
});

/**
 * Issue #601 — the report-sent confirmation must describe what actually happens.
 *
 * Filing a report writes the incident and its evidence snapshot; it emits NO
 * notification to the DM. Discovery is the moderation queue, which a DM visits.
 * The shipped copy said "Your DM has been notified", which promises a push that
 * does not exist — to a person who has just reported harassment and is deciding
 * whether they still need to do something else about it. Copy that oversells the
 * response is worse than no copy at all here, so it is pinned.
 */
test.describe('#601 report confirmation copy matches the shipped behaviour', () => {
  const localesRoot = resolve(__dirname, '../../src/i18n/locales');

  function catalog(lang: string): Record<string, Record<string, string>> {
    return JSON.parse(readFileSync(resolve(localesRoot, lang, 'moderation.json'), 'utf8'));
  }

  test('does not claim the DM was notified, in any locale', () => {
    for (const lang of readdirSync(localesRoot)) {
      const body = catalog(lang).moderation.reportSentBody;
      expect(body, `${lang}: reportSentBody must exist`).toBeTruthy();
      // No push/alert/notification promise, in the English catalog or in any
      // translation that still carries the English wording verbatim.
      expect(body, `${lang}: must not promise a notification`).not.toMatch(/notified|notification|alerted/i);
    }
  });

  test('names the queue as the discovery path', () => {
    expect(catalog('en').moderation.reportSentBody).toMatch(/queue/i);
  });

  test('keeps the Arabic catalog a translation, not English text in an Arabic file', () => {
    const arFile = resolve(localesRoot, 'ar', 'moderation.json');
    if (!existsSync(arFile)) return;
    // At least one Arabic letter — a synced-from-English placeholder would have none.
    expect(catalog('ar').moderation.reportSentBody).toMatch(/[؀-ۿ]/);
  });
});
