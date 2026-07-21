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
import type { ScribeConfig, ScribeJob, ScribeJobStatus, ScribeRunResult, ScribeTrigger } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAiDmSeat } from '../../lib/query';
import { Card, Btn, EmptyState, Skeleton, ErrorNote } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { useDialog } from '../../components/useDialog';
import { GameIcon } from '../../components/GameIcon';

const TRIGGER_LABEL: Record<ScribeTrigger, string> = {
  on_demand: 'Manual run',
  post_session: 'Post-session sweep',
  cron: 'Cron sweep',
};

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

/** Loose "an hour ago" formatter — mirrors ProposalsPage's local helper. */
function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

type Outcome = { kind: 'info' | 'error' | 'success'; text: string; href?: string; hrefLabel?: string };

/** The statuses a run() call can end in that mean "nothing usable happened" — surfaced
 * as the server's own `detail` text (verbatim) rather than a made-up client message. */
const GATE_FAILURE_STATUSES: ScribeJobStatus[] = ['disabled', 'over_budget', 'no_provider'];

export function ScribePanel({ campaignId, isDm }: { campaignId: number; isDm: boolean }) {
  const seatQuery = useAiDmSeat(campaignId);

  const [expanded, setExpanded] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);

  const [config, setConfig] = useState<ScribeConfig | null>(null);
  const [jobs, setJobs] = useState<ScribeJob[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState<'run' | 'preview' | 'filing' | null>(null);
  const [preview, setPreview] = useState<{ text: string } | null>(null);

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
      setLoadError(err instanceof ApiError ? err.message : "Couldn't load the AI scribe.");
    }
  }, [campaignId]);

  // Load status/history as soon as we know the seat is actually on — no point calling
  // scribe endpoints for a campaign that never turned on the AI DM seat.
  useEffect(() => {
    const seat = seatQuery.data;
    if (seat && seat.enabled && seat.mode !== 'off') void load();
  }, [seatQuery.data, load]);

  // Gate: hidden entirely until we know the seat is on. Avoids a flash of scribe UI on
  // campaigns that never enabled the AI DM seat, and matches the other AI surfaces.
  if (seatQuery.isLoading) return null;
  const seat = seatQuery.data;
  if (!seat || !seat.enabled || seat.mode === 'off') return null;

  async function run(dryRun: boolean) {
    setBusy(dryRun ? 'preview' : preview ? 'filing' : 'run');
    setOutcome(null);
    try {
      const result = await api.post<ScribeRunResult>(`${API}/campaigns/${campaignId}/scribe/run`, { dryRun });
      void load(); // refresh history + (if a config-side effect ever touches it) config
      const { job } = result;
      if (job.status === 'succeeded') {
        if (dryRun) {
          setPreview({ text: result.preview ?? '' });
          return;
        }
        setPreview(null);
        const pid = result.proposalIds[0];
        setOutcome(
          pid
            ? { kind: 'success', text: `Recap drafted and filed as a pending proposal.`, href: `/c/${campaignId}/proposals`, hrefLabel: 'Review the proposal' }
            : { kind: 'success', text: 'Recap drafted.' },
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
        setOutcome({ kind: 'info', text: 'Nothing to recap yet — resolve some inbox threads or run an encounter first.' });
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
      setOutcome({ kind: 'error', text: err instanceof ApiError ? err.message : "Couldn't run the scribe." });
    } finally {
      setBusy(null);
    }
  }

  const latest = jobs && jobs.length > 0 ? jobs[0] : null;

  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="flex leading-none"><GameIcon slug="feather" size={18} /></span>
        <h2 className="font-bold text-white text-sm m-0">AI Scribe</h2>
        {latest && (
          <span className={jobBadge(latest).cls} style={{ fontSize: 10 }}>
            Last: {jobBadge(latest).label} · {timeAgo(latest.createdAt)}
          </span>
        )}
        <div className="flex-1" />
        <Btn ghost className="!min-h-0 !py-1 text-xs" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Hide' : 'Show'}
        </Btn>
      </div>

      {expanded && (
        <div className="space-y-3">
          <p className="text-[11.5px] text-slate-500 m-0">
            Drafts a session recap from resolved inbox notes and encounters that were run, and files it as a{' '}
            <strong>pending proposal</strong> for you to review — nothing is ever published automatically.
          </p>

          {loadError && <ErrorNote message={loadError} onRetry={load} />}

          {isDm && (
            <div className="flex items-center gap-2 flex-wrap">
              <Btn className="!min-h-0 !py-1.5 text-xs" onClick={() => void run(false)} disabled={busy !== null}>
                {busy === 'run' ? 'Drafting…' : 'Draft recap with AI'}
              </Btn>
              <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => void run(true)} disabled={busy !== null}>
                {busy === 'preview' ? 'Generating preview…' : 'Preview first'}
              </Btn>
              <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => setConfigOpen((v) => !v)}>
                {configOpen ? 'Hide config' : 'Configure'}
              </Btn>
            </div>
          )}

          {outcome && <OutcomeNote outcome={outcome} onDismiss={() => setOutcome(null)} />}

          {isDm && configOpen && config && (
            <ConfigForm
              campaignId={campaignId}
              config={config}
              onSaved={(c) => {
                setConfig(c);
                setConfigOpen(false);
              }}
              onCancel={() => setConfigOpen(false)}
            />
          )}

          {!isDm && config && (
            <p className="text-[11px] text-slate-600 m-0">
              Post-session: {config.postSession ? 'on' : 'off'} · Cron: {config.cron ? 'on' : 'off'} · Budget per run:{' '}
              {config.budgetPerRun.toLocaleString()} tokens
            </p>
          )}

          <JobHistory campaignId={campaignId} jobs={jobs} />
        </div>
      )}

      {preview && (
        <PreviewModal
          text={preview.text}
          filing={busy === 'filing'}
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
        <button type="button" className="text-xs text-slate-500 hover:text-white" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

function ConfigForm({
  campaignId,
  config,
  onSaved,
  onCancel,
}: {
  campaignId: number;
  config: ScribeConfig;
  onSaved: (c: ScribeConfig) => void;
  onCancel: () => void;
}) {
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
      setError(err instanceof ApiError ? err.message : "Couldn't save the scribe config.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="cf-inset p-3 space-y-3">
      <label className="flex items-start gap-2 cursor-pointer">
        <input type="checkbox" className="mt-0.5" checked={postSession} onChange={(e) => setPostSession(e.target.checked)} />
        <span>
          <span className="block text-[12.5px] font-semibold">Post-session sweep</span>
          <span className="block text-[11px] text-slate-500">
            Auto-draft a recap once a scheduled session's end time has passed. Off by default.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 cursor-pointer">
        <input type="checkbox" className="mt-0.5" checked={cron} onChange={(e) => setCron(e.target.checked)} />
        <span>
          <span className="block text-[12.5px] font-semibold">Cron sweep</span>
          <span className="block text-[11px] text-slate-500">
            Include this campaign in the periodic background sweep, when a server admin has one running. It never
            duplicates a recap — a pending or unchanged draft is skipped.
          </span>
        </span>
      </label>
      <div className="space-y-1">
        <label className="text-xs font-bold text-slate-500 uppercase tracking-wide" htmlFor="scribe-budget">
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
        <p className="text-[11px] text-slate-500 m-0">
          Max output tokens for one run — further clamped by the AI DM seat's remaining budget.
        </p>
      </div>
      {error && <ErrorNote message={error} />}
      <div className="flex gap-2 justify-end">
        <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={onCancel} disabled={saving}>
          Cancel
        </Btn>
        <Btn className="!min-h-0 !py-1.5 text-xs" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save config'}
        </Btn>
      </div>
    </div>
  );
}

function JobHistory({ campaignId, jobs }: { campaignId: number; jobs: ScribeJob[] | null }) {
  if (jobs === null) return <Skeleton lines={2} />;
  if (jobs.length === 0) {
    return <EmptyState icon="feather" title="No scribe runs yet" hint="Run it on demand, or turn on a sweep in Configure." />;
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
            {job.tokensUsed > 0 && <span className="text-muted">· {job.tokensUsed.toLocaleString()} tokens</span>}
            <span className="text-muted">· {timeAgo(job.createdAt)}</span>
            {job.proposalId && (
              <Link to={`/c/${campaignId}/proposals`} className="text-purple-400 hover:underline">
                view proposal
              </Link>
            )}
            {job.detail && (
              <span className="text-slate-600 text-[11px] w-full basis-full">{job.detail}</span>
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
        <p className="text-[11.5px] text-slate-500 m-0">
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
