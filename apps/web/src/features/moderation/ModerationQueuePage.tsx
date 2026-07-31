/**
 * Moderation queue — /c/:campaignId/moderation (issue #601).
 *
 * TWO AUDIENCES, ONE PAGE, DIFFERENT DATA
 * ---------------------------------------
 * A DM sees the campaign's incident queue and the action verbs. Any other member
 * sees only the reports THEY filed, with no verbs beyond escalating their own.
 * That split is enforced server-side (the list endpoint filters by reporter for a
 * non-DM); the page renders whatever it is given rather than deciding for itself,
 * so a role misread here cannot widen anyone's access.
 *
 * WHAT THIS PAGE DELIBERATELY DOES NOT DO
 * ---------------------------------------
 * It never renders evidence content until the DM explicitly asks for it, one
 * incident at a time. There is no "expand all", no preview column, no prefetch:
 * every evidence read writes an audit row naming the reader, and a UI that reads
 * evidence as a side effect of scrolling would fill that log with noise while
 * spraying abuse content across the screen.
 */
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../../lib/format';
import type {
  ModerationActionType,
  ModerationEvidence,
  ModerationMute,
  ModerationReport,
  ModerationReportPage,
  ModerationResolution,
} from '@campfire/schema';
import { api, API, translateApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import { Card, Chip, Btn, EmptyState, Skeleton, ErrorNote, Dialog } from '../../components/ui';
import { Field } from '../../components/Field';
import { useAnnounce } from '../../components/Announcer';
import {
  actionKey,
  availableActions,
  canReporterEscalate,
  integrityVariantFor,
  RESOLUTIONS,
  reasonKey,
  resolutionKey,
  statusKey,
  statusVariantFor,
  targetLabel,
} from './moderationQueueState';

function shortDate(iso: string | null): string {
  if (!iso) return '—';
  return formatDateTime(iso);
}

export default function ModerationQueuePage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const cid = Number(campaignId);
  const { isDm } = useCampaignAccess();
  const { me } = useAuth();
  const myUserId = me ? String(me.user.id) : undefined;
  const { t } = useTranslation();
  const announce = useAnnounce();

  const [page, setPage] = useState<ModerationReportPage | null>(null);
  const [rows, setRows] = useState<ModerationReport[]>([]);
  const [mutes, setMutes] = useState<ModerationMute[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [resolving, setResolving] = useState<ModerationReport | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      if (!Number.isFinite(cid)) return;
      setError(null);
      try {
        const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
        const res = await api.get<ModerationReportPage>(`${API}/campaigns/${cid}/moderation/reports${query}`);
        setPage(res);
        setRows((prev) => (cursor ? [...prev, ...res.items] : res.items));
      } catch (err) {
        setError(translateApiError(err, t, { fallbackKey: 'moderation.loadFailed' }));
      }
    },
    [cid, t],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!Number.isFinite(cid) || !isDm) return;
    // Mutes are DM-only; a player request would 403 and produce a spurious error.
    void api
      .get<ModerationMute[]>(`${API}/campaigns/${cid}/moderation/mutes`)
      .then(setMutes)
      .catch(() => setMutes([]));
  }, [cid, isDm, busyId]);

  async function act(report: ModerationReport, action: ModerationActionType, extra: Record<string, unknown> = {}) {
    setBusyId(report.id);
    setError(null);
    try {
      const updated = await api.post<ModerationReport>(
        `${API}/campaigns/${cid}/moderation/reports/${report.id}/actions`,
        { action, ...extra },
      );
      setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      announce(t('moderation.actionDone'));
    } catch (err) {
      const message = translateApiError(err, t, { fallbackKey: 'moderation.actionFailed' });
      setError(message);
      announce(message);
    } finally {
      setBusyId(null);
    }
  }

  const heading = isDm ? t('moderation.queueTitle') : t('moderation.mineTitle');
  const subtitle = isDm ? t('moderation.queueSubtitle') : t('moderation.mineSubtitle');

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold">{heading}</h1>
        <p className="text-xs text-secondary">{subtitle}</p>
      </div>

      {error && <ErrorNote message={error} onRetry={() => void load()} />}

      <Card>
        {page === null ? (
          <Skeleton lines={4} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon="shield"
            title={isDm ? t('moderation.empty') : t('moderation.emptyMine')}
            hint={isDm ? t('moderation.emptyHint') : t('moderation.emptyMineHint')}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">{heading}</caption>
              <thead>
                <tr className="text-[10px] uppercase text-secondary text-left">
                  <th scope="col" className="py-2 pr-4 font-bold">{t('moderation.colTarget')}</th>
                  <th scope="col" className="py-2 pr-4 font-bold">{t('moderation.colSubject')}</th>
                  <th scope="col" className="py-2 pr-4 font-bold">{t('moderation.colReporter')}</th>
                  <th scope="col" className="py-2 pr-4 font-bold">{t('moderation.colReason')}</th>
                  <th scope="col" className="py-2 pr-4 font-bold">{t('moderation.colStatus')}</th>
                  <th scope="col" className="py-2 pr-4 font-bold">{t('moderation.colFiled')}</th>
                  <th scope="col" className="py-2 font-bold">{t('moderation.colActions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {rows.map((report) => (
                  <ReportRow
                    key={report.id}
                    campaignId={cid}
                    report={report}
                    isDm={isDm}
                    userId={myUserId}
                    busy={busyId === report.id}
                    onAct={act}
                    onResolve={() => setResolving(report)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {page?.hasMore && page.nextCursor && (
          <div className="pt-3">
            <Btn ghost onClick={() => void load(page.nextCursor ?? undefined)}>
              {t('moderation.loadMore')}
            </Btn>
          </div>
        )}
      </Card>

      {isDm && (
        <Card>
          <h2 className="text-sm font-bold mb-2">{t('moderation.mutesHeading')}</h2>
          {mutes.length === 0 ? (
            <p className="text-xs text-secondary">{t('moderation.mutesEmpty')}</p>
          ) : (
            <ul className="text-sm space-y-1">
              {mutes.map((mute) => (
                <li key={mute.id}>
                  {mute.userName || mute.userId}{' '}
                  <span className="text-secondary text-xs">
                    {mute.expiresAt
                      ? t('moderation.mutesUntil', { when: shortDate(mute.expiresAt) })
                      : t('moderation.mutesIndefinite')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {resolving && (
        <ResolveDialog
          report={resolving}
          busy={busyId === resolving.id}
          onCancel={() => setResolving(null)}
          onConfirm={async (resolution, note) => {
            await act(resolving, 'resolve', { resolution, note });
            setResolving(null);
          }}
        />
      )}
    </div>
  );
}

function ReportRow({
  campaignId,
  report,
  isDm,
  userId,
  busy,
  onAct,
  onResolve,
}: {
  campaignId: number;
  report: ModerationReport;
  isDm: boolean;
  userId: string | undefined;
  busy: boolean;
  onAct: (report: ModerationReport, action: ModerationActionType, extra?: Record<string, unknown>) => Promise<void>;
  onResolve: () => void;
}) {
  const { t } = useTranslation();
  const [evidence, setEvidence] = useState<ModerationEvidence | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const actions = isDm ? availableActions(report) : [];

  async function toggleEvidence() {
    if (evidence) {
      setEvidence(null);
      return;
    }
    setEvidenceError(null);
    try {
      setEvidence(
        await api.get<ModerationEvidence>(
          `${API}/campaigns/${campaignId}/moderation/reports/${report.id}/evidence`,
        ),
      );
    } catch (err) {
      setEvidenceError(translateApiError(err, t, { fallbackKey: 'moderation.evidenceFailed' }));
    }
  }

  return (
    <>
      <tr>
        <td className="py-2 pr-4">
          {targetLabel(report, t)}
          {report.quarantined && (
            <>
              {' '}
              <Chip variant="whisper">{t('moderation.quarantinedBadge')}</Chip>
            </>
          )}
        </td>
        <td className="py-2 pr-4">{report.subjectName || report.subjectUserId || t('moderation.unknownMember')}</td>
        <td className="py-2 pr-4">{report.reporterName || report.reporterUserId}</td>
        <td className="py-2 pr-4">{t(reasonKey(report.reason))}</td>
        <td className="py-2 pr-4">
          <Chip variant={statusVariantFor(report.status)}>{t(statusKey(report.status))}</Chip>
          {report.resolution && (
            <span className="text-xs text-secondary"> · {t(resolutionKey(report.resolution))}</span>
          )}
        </td>
        <td className="py-2 pr-4 text-xs text-secondary">{shortDate(report.createdAt)}</td>
        <td className="py-2">
          <div className="flex flex-wrap gap-2 text-xs">
            {isDm && report.status !== 'escalated' && (
              <button type="button" className="text-secondary hover:text-[var(--color-neutral-300)]" onClick={() => void toggleEvidence()}>
                {evidence ? t('moderation.hideEvidence') : t('moderation.viewEvidence')}
              </button>
            )}
            {actions.map((action) =>
              action === 'resolve' ? (
                <button key={action} type="button" className="text-secondary hover:text-[var(--color-neutral-300)]" onClick={onResolve} disabled={busy}>
                  {t(actionKey(action))}
                </button>
              ) : (
                <button
                  key={action}
                  type="button"
                  className={action === 'remove' ? 'text-rose-400 hover:text-rose-300' : 'text-secondary hover:text-[var(--color-neutral-300)]'}
                  onClick={() => void onAct(report, action)}
                  disabled={busy}
                >
                  {t(actionKey(action))}
                </button>
              ),
            )}
            {!isDm && canReporterEscalate(report, userId) && (
              <button
                type="button"
                className="text-secondary hover:text-[var(--color-neutral-300)]"
                title={t('moderation.escalateOwnHint')}
                onClick={() => void onAct(report, 'escalate')}
                disabled={busy}
              >
                {t('moderation.escalateOwn')}
              </button>
            )}
          </div>
        </td>
      </tr>
      {(evidence || evidenceError || report.status === 'escalated' || report.evidenceIntegrity === 'tampered') && (
        <tr>
          <td colSpan={7} className="pb-3">
            {report.evidenceIntegrity === 'tampered' && (
              <p className="text-xs text-rose-400">
                {t('moderation.integrityTampered')} — {t('moderation.integrityTamperedHint')}
              </p>
            )}
            {report.status === 'escalated' && (
              <p className="text-xs text-secondary">{t('moderation.escalatedNotice')}</p>
            )}
            {evidenceError && <ErrorNote message={evidenceError} />}
            {evidence && (
              <div className="mt-2 rounded border border-slate-800 p-3 space-y-2">
                <h3 className="text-xs font-bold uppercase tracking-wide text-secondary">
                  {t('moderation.evidenceHeading')}
                </h3>
                <p className="text-[11px] text-secondary">{t('moderation.evidenceNotice')}</p>
                {evidence.source === 'reporter_supplied' && (
                  <p className="text-[11px] text-amber-400">{t('moderation.evidenceReporterSupplied')}</p>
                )}
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-secondary">
                  <dt>{t('moderation.evidenceAuthor')}</dt>
                  <dd>{evidence.authorName || evidence.authorUserId || t('moderation.unknownMember')}</dd>
                  <dt>{t('moderation.evidenceCaptured')}</dt>
                  <dd>{shortDate(evidence.capturedAt)}</dd>
                  <dt>{t('moderation.evidenceRevision')}</dt>
                  <dd>{evidence.revisionAt || '—'}</dd>
                  <dt>{t('moderation.evidenceExpires')}</dt>
                  <dd>{shortDate(evidence.expiresAt)}</dd>
                </dl>
                <Chip variant={integrityVariantFor(evidence.integrity)}>
                  {evidence.integrity === 'intact'
                    ? t('moderation.integrityIntact')
                    : evidence.integrity === 'redacted'
                      ? t('moderation.integrityRedacted')
                      : t('moderation.integrityTampered')}
                </Chip>
                {/* Plain text, never Markdown: evidence is rendered as the literal
                    bytes that were captured, so nothing in it can be interpreted as
                    formatting, a link, or an image request. */}
                <pre className="whitespace-pre-wrap break-words text-sm">{evidence.content}</pre>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function ResolveDialog({
  report,
  busy,
  onCancel,
  onConfirm,
}: {
  report: ModerationReport;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (resolution: ModerationResolution, note: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [resolution, setResolution] = useState<ModerationResolution>('upheld');
  const [note, setNote] = useState('');
  const titleId = `resolve-report-${report.id}-title`;

  return (
    <Dialog
      title={t('moderation.resolveTitle')}
      titleId={titleId}
      onBackdropClick={busy ? undefined : onCancel}
      actions={
        <>
          <Btn ghost onClick={onCancel} disabled={busy}>
            {t('moderation.reportCancel')}
          </Btn>
          <Btn onClick={() => void onConfirm(resolution, note)} disabled={busy}>
            {t('moderation.resolveConfirm')}
          </Btn>
        </>
      }
    >
      <div className="space-y-3">
        <Field
          idPrefix={`resolve-${report.id}`}
          name="resolution"
          as="select"
          label={t('moderation.resolveOutcome')}
          value={resolution}
          onChange={(e) => setResolution(e.target.value as ModerationResolution)}
          required
        >
          {RESOLUTIONS.map((value) => (
            <option key={value} value={value}>
              {t(resolutionKey(value))}
            </option>
          ))}
        </Field>
        <Field
          idPrefix={`resolve-${report.id}`}
          name="note"
          as="textarea"
          label={t('moderation.resolveNote')}
          help={t('moderation.resolveNoteHelp')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={2000}
          optional
        />
      </div>
    </Dialog>
  );
}
