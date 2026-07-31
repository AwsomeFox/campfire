import { useTranslation } from 'react-i18next';
/**
 * AI Scribe panel — issue #342, mounted on SessionsPage.tsx as a collapsible card in
 * the timeline column, near "+ Add recap".
 *
 * Surfaces the scheduled/on-demand scribe (#316) that already ships server-side:
 *   - GET/PUT  /campaigns/:id/scribe        — trigger config (postSession/cron toggles + budgetPerRun)
 *   - POST     /campaigns/:id/scribe/run    — on-demand run, `dryRun` for a preview-only pass
 *   - GET      /campaigns/:id/scribe/jobs   — recent run history
 *
 * The scribe drafts from the campaign's own material (resolved inbox + encounters) and
 * ALWAYS files the result as a session-create PROPOSAL — nothing here ever touches canon
 * directly. Gated like the other AI surfaces: hidden entirely while the AI-DM seat is off
 * or disabled (the shared `useAiDmSeat` query from #338); DM gets the run/dry-run/config
 * controls, any member gets read-only status + job history.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ScribeConfig, ScribeJob, ScribeJobStatus, ScribeRunResult, ScribeSourceStats, ScribeTrigger } from '@campfire/schema';
import { api, API, translateApiError } from '../../lib/api';
import { useAiDmSeat } from '../../lib/query';
import { Card, Btn, EmptyState, Skeleton, SkeletonConditionalRegion, ErrorNote } from '../../components/ui';
import { conditionalRegionPhase } from '../../components/loadingSkeletonState';
import { Markdown } from '../../components/Markdown';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useDialog } from '../../components/useDialog';
import { useDisclosure } from '../../components/useDisclosure';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import { GameIcon } from '../../components/GameIcon';
import { TermHelp } from '../../components/TermHelp';
import { timeAgo, useTimeTick, formatNumber } from '../../lib/format';
import { UI_ICON_SIZE } from '../../lib/uiIcons';

const TRIGGER_LABEL: Record<ScribeTrigger, string> = {
  on_demand: 'Manual run',
  post_session: 'Post-session sweep',
  cron: 'Cron sweep',
};

/**
 * The DM-facing sentence for material the external-use gate held back (#501).
 *
 * Kept as one phrase so every surface — filed, previewed, and nothing-drafted — says the
 * same thing, and so the count is never rendered without the reason or the remedy.
 *
 * The remedy depends on WHY the gate fired, and the two belong to different people.
 */
function withheldNote(count: number, policy: ScribeSourceStats['campaignPolicy']): string {
  const notes = `${count} note${count === 1 ? '' : 's'}`;
  // Under a `disabled` policy the gate rejects every member-authored note whatever its
  // author consented to, so pointing players at the consent checkbox hands them a control
  // that will appear broken when they use it. Only a DM changing the policy has any effect.
  return policy === 'disabled'
    ? `${notes} withheld: this campaign's AI content policy disallows external use of member-authored notes. A DM can change that in campaign settings.`
    : `${notes} withheld pending author consent for external AI use — each author can opt in from the members page.`;
}

/** Tag class + human label for a recorded job's status. A dry-run "succeeded" job never
 * carries a proposalId (nothing was filed), so it's told apart from a real, filed run. */
function jobBadge(job: ScribeJob): { cls: string; label: string } {
  if (job.status === 'succeeded') {
    return job.proposalId
      ? { cls: 'tag tag-accent', label: 'Filed' }
      : { cls: 'tag tag-outline', label: 'Preview' };
  }
  switch (job.status) {
    case 'skipped':
      return { cls: 'tag tag-neutral', label: 'Skipped' };
    case 'no_material':
      return { cls: 'tag tag-neutral', label: 'No material' };
    case 'disabled':
      return { cls: 'tag tag-neutral', label: 'Disabled' };
    case 'over_budget':
      return { cls: 'tag tag-neutral', label: 'Over budget' };
    case 'no_provider':
      return { cls: 'tag tag-neutral', label: 'No provider' };
    case 'failed':
    default:
      return { cls: 'tag', label: 'Failed' };
  }
}



type Outcome = { kind: 'info' | 'error' | 'success'; text: string; href?: string; hrefLabel?: string };

/** The statuses a run() call can end in that mean "nothing usable happened" — surfaced
 * as the server's own `detail` text (verbatim) rather than a made-up client message. */
const GATE_FAILURE_STATUSES: ScribeJobStatus[] = ['disabled', 'over_budget', 'no_provider'];

export function ScribePanel({ campaignId, isDm }: { campaignId: number; isDm: boolean }) {
  useTimeTick();
  const { t } = useTranslation();
  const { canDmWrite } = useCampaignAccess();
  const seatQuery = useAiDmSeat(campaignId);

  const panelDisclosure = useDisclosure({ regionLabel: 'AI Scribe status and controls' });
  const configDisclosure = useDisclosure({ regionLabel: 'AI Scribe configuration' });
  const expanded = panelDisclosure.open;
  const configOpen = configDisclosure.open;

  const [config, setConfig] = useState<ScribeConfig | null>(null);
  const [jobs, setJobs] = useState<ScribeJob[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState<'run' | 'preview' | 'filing' | null>(null);
  const [preview, setPreview] = useState<{ text: string } | null>(null);
  // Pending external-send confirmation. Replaces a native `window.confirm`, which was both
  // off-pattern for this codebase and invisible to Playwright (which auto-dismisses native
  // dialogs unless a spec registers a handler, so a driven run would silently no-op).
  const [confirmingRun, setConfirmingRun] = useState<{ dryRun: boolean } | null>(null);
  // Whether a run would really reach an external endpoint, derived server-side (#501).
  // Fail closed while the config is still loading or failed to load: an unknown state
  // shows the strict external-send warning rather than a reassurance we cannot back up.
  const externalSend = config?.externalSend ?? true;

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [c, j] = await Promise.all([
        api.get<ScribeConfig>(`${API}/campaigns/${campaignId}/scribe`),
        api.get<ScribeJob[]>(`${API}/campaigns/${campaignId}/scribe/jobs?limit=10`),
      ]);
      setConfig(c);
      setJobs(j);
    } catch (err) {
      setLoadError(translateApiError(err, t, { fallbackKey: 'sessions.errors.loadScribe' }));
    }
  }, [campaignId]);

  // Load status/history as soon as we know the seat is actually on — no point calling
  // scribe endpoints for a campaign that never turned on the AI DM seat.
  useEffect(() => {
    const seat = seatQuery.data;
    if (seat && seat.enabled && seat.mode !== 'off') void load();
  }, [seatQuery.data, load]);

  // Gate: hidden entirely once we know the seat is off. While the seat query is
  // still loading, reserve the collapsed card footprint so the timeline column
  // does not jump (#677).
  const seat = seatQuery.data;
  const seatVisible = Boolean(seat && seat.enabled && seat.mode !== 'off');
  const seatPhase = conditionalRegionPhase(seatQuery.isLoading, seatVisible);
  if (seatPhase === 'loading') return <SkeletonConditionalRegion preset="scribe" />;
  if (seatPhase === 'ready-hidden') return null;

  async function run(dryRun: boolean) {
    setBusy(dryRun ? 'preview' : preview ? 'filing' : 'run');
    setOutcome(null);
    try {
      const result = await api.post<ScribeRunResult>(`${API}/campaigns/${campaignId}/scribe/run`, { dryRun });
      void load(); // refresh history + (if a config-side effect ever touches it) config
      const { job } = result;
      // How many member-authored notes the external-use gate held back. Never let this pass
      // silently: a recap that quietly omits half the table's notes, or an empty one,
      // otherwise reads as "the scribe is broken" (#501).
      const withheld = job.sourceStats?.excludedInboxByConsent ?? 0;
      const withheldPolicy = job.sourceStats?.campaignPolicy;
      const withheldSuffix = withheld > 0 ? ` ${withheldNote(withheld, withheldPolicy)}` : '';
      // Send them where the fix actually lives: campaign settings owns the policy, the
      // members page owns per-member consent.
      const withheldHref =
        withheldPolicy === 'disabled' ? `/c/${campaignId}/settings` : `/c/${campaignId}/members`;
      const withheldHrefLabel =
        withheldPolicy === 'disabled' ? 'Open campaign AI settings' : 'Open consent settings';

      if (job.status === 'succeeded') {
        if (dryRun) {
          setPreview({ text: result.preview ?? '' });
          if (withheld > 0) {
            setOutcome({
              kind: 'info',
              text: withheldNote(withheld, withheldPolicy),
              href: withheldHref,
              hrefLabel: withheldHrefLabel,
            });
          }
          return;
        }
        setPreview(null);
        const pid = result.proposalIds[0];
        setOutcome(
          pid
            ? {
                kind: withheld > 0 ? 'info' : 'success',
                text: `Recap drafted and filed as a pending proposal.${withheldSuffix}`,
                href: withheld > 0 ? withheldHref : `/c/${campaignId}/proposals`,
                hrefLabel: withheld > 0 ? withheldHrefLabel : 'Review the proposal',
              }
            : { kind: withheld > 0 ? 'info' : 'success', text: `Recap drafted.${withheldSuffix}` },
        );
        return;
      }
      setPreview(null);
      if (job.status === 'skipped') {
        setOutcome({
          kind: 'info',
          text: job.detail || 'Nothing new to draft since the last run.',
          href: job.proposalId ? `/c/${campaignId}/proposals` : undefined,
          hrefLabel: job.proposalId ? 'Review the pending draft' : undefined,
        });
        return;
      }
      if (job.status === 'no_material') {
        // The important distinction: "there is genuinely nothing" vs "everything there was
        // got withheld by the external-use gate". The second is fixable — by a member or by
        // the DM depending on cause — and telling them to go resolve more inbox threads
        // would be actively misleading.
        setOutcome(
          withheld > 0
            ? {
                kind: 'info',
                text: `No recap drafted. ${withheldNote(withheld, withheldPolicy)}`,
                href: withheldHref,
                hrefLabel: withheldHrefLabel,
              }
            : { kind: 'info', text: 'Nothing to recap yet — resolve some inbox threads or run an encounter first.' },
        );
        return;
      }
      if (GATE_FAILURE_STATUSES.includes(job.status)) {
        setOutcome({
          kind: 'error',
          text: job.detail || 'The scribe is not available right now.',
          href: `/c/${campaignId}/settings`,
          hrefLabel: 'Open AI DM settings',
        });
        return;
      }
      // failed
      setOutcome({ kind: 'error', text: job.detail || "The scribe run failed." });
    } catch (err) {
      setOutcome({ kind: 'error', text: translateApiError(err, t, { fallbackKey: 'sessions.errors.runScribe' }) });
    } finally {
      setBusy(null);
    }
  }

  const latest = jobs && jobs.length > 0 ? jobs[0] : null;

  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="flex leading-none"><GameIcon slug="feather" size={UI_ICON_SIZE.md} /></span>
        <h2 className="font-bold text-white text-sm m-0">AI Scribe</h2>
        <TermHelp termId="scribe" />
        {latest && (
          <span className={jobBadge(latest).cls} style={{ fontSize: 10 }}>
            Last: {jobBadge(latest).label} · {timeAgo(latest.createdAt)}
          </span>
        )}
        <div className="flex-1" />
        <Btn density="xs" ghost className="text-xs" {...panelDisclosure.buttonProps}>
          {expanded ? 'Hide' : 'Show'}
        </Btn>
      </div>

      {expanded && (
        <div {...panelDisclosure.regionProps} className="space-y-3">
          <p className="text-[11.5px] text-secondary m-0">
            Drafts a session recap from resolved inbox notes and encounters that were run, and files it as a{' '}
            <strong>pending proposal</strong> for you to review — nothing is ever published automatically.
          </p>
          {externalSend ? (
            <p className="text-[11px] text-amber-200 m-0">
              External-send notice: generation sends the prompt to the configured AI provider. Member-authored inbox
              notes are included only when the campaign policy allows it and that member has opted in.
            </p>
          ) : (
            <p className="text-[11px] text-secondary m-0">
              No external AI provider is in effect — recaps are generated on this server and no campaign content leaves
              it, so member consent is not required. Private and whisper notes are excluded either way.
            </p>
          )}

          {loadError && <ErrorNote message={loadError} onRetry={load} />}

          {canDmWrite && (
            <div className="flex items-center gap-2 flex-wrap">
              <Btn density="xs" className="text-xs" onClick={() => setConfirmingRun({ dryRun: false })} disabled={busy !== null}>
                {busy === 'run' ? 'Drafting…' : 'Draft recap with AI'}
              </Btn>
              <Btn density="xs" ghost className="text-xs" onClick={() => setConfirmingRun({ dryRun: true })} disabled={busy !== null}>
                {busy === 'preview' ? 'Generating preview…' : 'Preview first'}
              </Btn>
              <Btn density="xs" ghost className="text-xs" {...configDisclosure.buttonProps}>
                {configOpen ? 'Hide config' : 'Configure'}
              </Btn>
            </div>
          )}

          {outcome && <OutcomeNote outcome={outcome} onDismiss={() => setOutcome(null)} />}

          {canDmWrite && configOpen && config && (
            <ConfigForm
              campaignId={campaignId}
              config={config}
              regionProps={configDisclosure.regionProps}
              onSaved={(c) => {
                setConfig(c);
                configDisclosure.setOpen(false);
              }}
              onCancel={() => configDisclosure.setOpen(false)}
            />
          )}

          {!isDm && config && (
            <p className="text-[11px] text-secondary m-0">
              Post-session: {config.postSession ? 'on' : 'off'} · Cron: {config.cron ? 'on' : 'off'} · Budget per run:{' '}
              {formatNumber(config.budgetPerRun)} tokens
            </p>
          )}

          <JobHistory campaignId={campaignId} jobs={jobs} />
        </div>
      )}

      {confirmingRun && (
        <ConfirmDialog
          // The server decides whether a run actually leaves the box (#501); say what will
          // really happen. Warning about an external send that cannot occur is a false
          // alarm, and a DM who learns this dialog overstates will stop reading it before
          // the run where it genuinely matters. Unknown config ⇒ assume external.
          title={externalSend ? 'Send source material to the AI provider?' : 'Draft a recap on this server?'}
          body={
            externalSend ? (
              <>
                <p className="m-0">
                  {confirmingRun.dryRun
                    ? 'Previewing is not a local dry run: the server still sends the prompt to the configured AI provider and only skips filing the proposal.'
                    : 'The AI scribe sends allowed campaign source material to the configured AI provider.'}
                </p>
                <p className="m-0">
                  Only resolved inbox notes from members who opted in are included; private, whisper, and opted-out
                  notes are excluded.
                </p>
              </>
            ) : (
              <>
                <p className="m-0">
                  No external AI provider is in effect for this campaign, so the recap is generated on this server and
                  no campaign content leaves it.
                  {confirmingRun.dryRun ? ' Previewing additionally skips filing the proposal.' : ''}
                </p>
                <p className="m-0">
                  Because nothing is sent externally, member consent is not required — but private and whisper notes are
                  still excluded.
                </p>
              </>
            )
          }
          confirmLabel={confirmingRun.dryRun ? 'Generate preview' : 'Draft recap'}
          danger={false}
          onConfirm={() => {
            const { dryRun } = confirmingRun;
            setConfirmingRun(null);
            void run(dryRun);
          }}
          onCancel={() => setConfirmingRun(null)}
        />
      )}

      {preview && (
        <PreviewModal
          text={preview.text}
          filing={busy === 'filing'}
          // Filing does re-run generation, but against the SAME material and the SAME
          // endpoint the DM just confirmed and read the output of, so it does not re-prompt.
          onFile={() => void run(false)}
          onDiscard={() => {
            setPreview(null);
            setBusy(null);
          }}
        />
      )}
    </Card>
  );
}

function OutcomeNote({ outcome, onDismiss }: { outcome: Outcome; onDismiss: () => void }) {
  const color = outcome.kind === 'error' ? '#f87171' : outcome.kind === 'success' ? 'var(--color-accent, #4ade80)' : undefined;
  return (
    <div className="cf-inset p-3 text-sm space-y-1">
      <p className="m-0" style={color ? { color } : undefined}>
        {outcome.text}
      </p>
      <div className="flex items-center gap-3">
        {outcome.href && (
          <Link to={outcome.href} className="text-xs text-purple-400 hover:underline">
            {outcome.hrefLabel || 'View'}
          </Link>
        )}
        <button type="button" className="text-xs text-secondary hover:text-white" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

function ConfigForm({
  campaignId,
  config,
  regionProps,
  onSaved,
  onCancel,
}: {
  campaignId: number;
  config: ScribeConfig;
  regionProps: ReturnType<typeof useDisclosure>['regionProps'];
  onSaved: (c: ScribeConfig) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [postSession, setPostSession] = useState(config.postSession);
  const [cron, setCron] = useState(config.cron);
  const [budgetPerRun, setBudgetPerRun] = useState(String(config.budgetPerRun));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const n = Number(budgetPerRun);
    if (!Number.isFinite(n) || n < 1) {
      setError('Budget per run must be a positive number of tokens.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await api.put<ScribeConfig>(`${API}/campaigns/${campaignId}/scribe`, {
        postSession,
        cron,
        budgetPerRun: Math.floor(n),
      });
      onSaved(updated);
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'sessions.errors.saveScribe' }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div {...regionProps} className="cf-inset p-3 space-y-3">
      <label className="flex items-start gap-2 cursor-pointer">
        <input type="checkbox" className="mt-0.5" checked={postSession} onChange={(e) => setPostSession(e.target.checked)} />
        <span>
          <span className="block text-[12.5px] font-semibold">Post-session sweep</span>
          <span className="block text-[11px] text-secondary">
            Auto-draft a recap once a scheduled session's end time has passed. Off by default.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 cursor-pointer">
        <input type="checkbox" className="mt-0.5" checked={cron} onChange={(e) => setCron(e.target.checked)} />
        <span>
          <span className="block text-[12.5px] font-semibold">Cron sweep</span>
          <span className="block text-[11px] text-secondary">
            Include this campaign in the periodic background sweep, when a server admin has one running. It never
            duplicates a recap — a pending or unchanged draft is skipped.
          </span>
        </span>
      </label>
      <div className="space-y-1">
        <label className="text-xs font-bold text-secondary uppercase tracking-wide" htmlFor="scribe-budget">
          Budget per run
        </label>
        <input
          id="scribe-budget"
          className="cf-input"
          type="number"
          min={1}
          value={budgetPerRun}
          onChange={(e) => setBudgetPerRun(e.target.value)}
          style={{ maxWidth: 160 }}
        />
        <p className="text-[11px] text-secondary m-0">
          Max output tokens for one run — further clamped by the AI DM seat's remaining budget.
        </p>
      </div>
      {error && <ErrorNote message={error} />}
      <div className="flex gap-2 justify-end">
        <Btn density="xs" ghost className="text-xs" onClick={onCancel} disabled={saving}>
          Cancel
        </Btn>
        <Btn density="xs" className="text-xs" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save config'}
        </Btn>
      </div>
    </div>
  );
}

function JobHistory({ campaignId, jobs }: { campaignId: number; jobs: ScribeJob[] | null }) {
  const { t } = useTranslation();
  if (jobs === null) return <Skeleton lines={2} />;
  if (jobs.length === 0) {
    return <EmptyState icon="feather" title={t('sessions.empty.noScribeRuns')} hint={t('sessions.empty.noScribeRunsHint')} />;
  }
  return (
    <ul className="m-0 p-0 space-y-1.5" style={{ listStyle: 'none' }}>
      {jobs.map((job) => {
        const badge = jobBadge(job);
        return (
          <li key={job.id} className="flex items-center gap-2.5 text-xs flex-wrap">
            <span className={badge.cls} style={{ fontSize: 10 }}>
              {badge.label}
            </span>
            <span className="text-muted">{TRIGGER_LABEL[job.trigger]}</span>
            {job.tokensUsed > 0 && <span className="text-muted">· {formatNumber(job.tokensUsed)} tokens</span>}
            <span className="text-muted">· {timeAgo(job.createdAt)}</span>
            {job.proposalId && (
              <Link to={`/c/${campaignId}/proposals`} className="text-purple-400 hover:underline">
                view proposal
              </Link>
            )}
            {job.detail && (
              <span className="text-secondary text-[11px] w-full basis-full">{job.detail}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Dry-run preview — the recap text is rendered but nothing has been filed. Filing runs
 * the scribe again for real (the dry run made no proposal to promote), so the final
 * wording can differ slightly from this preview. */
function PreviewModal({
  text,
  filing,
  onFile,
  onDiscard,
}: {
  text: string;
  filing: boolean;
  onFile: () => void;
  onDiscard: () => void;
}) {
  const dialogRef = useDialog<HTMLDivElement>({ onClose: onDiscard, disabled: filing });
  return (
    <div className="dialog-backdrop" onClick={() => !filing && onDiscard()}>
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="AI scribe recap preview"
        style={{ width: 'min(640px, 100%)', maxHeight: '80vh', overflow: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="dialog-title">Recap preview</p>
        <p className="text-[11.5px] text-secondary m-0">
          A draft only — nothing has been filed yet. "File as proposal" runs the scribe once more to produce the
          version that lands in your proposals queue.
        </p>
        <div className="dialog-body">
          <Markdown>{text || '_The scribe returned an empty draft._'}</Markdown>
        </div>
        <div className="dialog-actions">
          <Btn ghost onClick={onDiscard} disabled={filing}>
            Discard
          </Btn>
          <Btn onClick={onFile} disabled={filing}>
            {filing ? 'Filing…' : 'File as proposal'}
          </Btn>
        </div>
      </div>
    </div>
  );
}
