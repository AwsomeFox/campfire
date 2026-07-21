/**
 * AI-DM stuck-recovery UI (issue #340) — the player-facing surface for the stuck ladder
 * (#314). Mounted at the `#340 SEAM` in AiTablePage, between the header and the transcript.
 *
 * It reads the THIN server truth (useAiDmSession → state/stuck/levers/vote/actingDm/
 * takeoverRequestedBy, #338) and drives the eight recovery endpoints on
 * ai-driver.controller.ts. Nothing here invents state: the levers rendered are exactly the
 * `session.levers[]` the server offers, and every mutation refetches the session so the
 * banner/vote/takeover surfaces reconcile live off server truth (the SSE stuck/recovered/
 * vote/takeover signals already invalidate the session query — see AiTablePage).
 *
 * Gating mirrors the server's role matrix (all enforced server-side; the client just hides
 * affordances a player can't use):
 *   - nudge/retry, flag, vote (open+cast), rules-lookup, request-takeover, handback → player+
 *   - pause, resume, grant-takeover → DM only
 *   - viewers → read-only (banners/vote render, no action controls)
 *
 * Recovery is automatic: a `recovered`/`state` SSE signal invalidates the session, so when
 * the seat leaves `awaiting_players`/`human_control` the banner simply unmounts, and the
 * transcript reducer drops the matching divider line.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CampaignMember } from '@campfire/schema';
import { api, API, translateApiError } from '../../lib/api';
import { queryKeys, invalidateAiDm, type AiDmSession } from '../../lib/query';
import { Btn, TextArea, TextInput } from '../../components/ui';

/** Which lever ids the server may offer (mirrors AiDriverService.leversFor). */
type Lever = 'retry' | 'nudge' | 'flag' | 'vote' | 'rules_lookup' | 'request_takeover' | 'pause';

/** Levers the server gates to the DM role — hidden for players (they'd 403). */
const DM_ONLY_LEVERS = new Set<Lever>(['pause']);

/**
 * The ambient "table tools" menu (healthy play) is deliberately narrower than the full
 * server lever list: it offers the proactive table tools (flag a ruling, call a vote, rules
 * lookup, request takeover) and omits recovery-only levers (retry/nudge) + `pause` (the DM
 * already has a header pause/resume). The STUCK banner still renders the server list verbatim.
 */
const AMBIENT_LEVERS = new Set<Lever>(['flag', 'vote', 'rules_lookup', 'request_takeover']);

interface StuckLadderProps {
  campaignId: number;
  session: AiDmSession;
  isDm: boolean;
  /** Player or DM — the server's `player+` bar for the shared levers. */
  canAct: boolean;
  /** This viewer's user id as the server keys it (String(users.id)); null for none. */
  myUserId: string | null;
  /** Inject a rules-lookup answer inline into the transcript as a system entry. */
  onRulesAnswer: (query: string, answer: string) => void;
}

type Dialog = 'nudge' | 'flag' | 'vote' | 'rules' | 'grant' | 'handback' | null;

export function StuckLadder({ campaignId, session, isDm, canAct, myUserId, onRulesAnswer }: StuckLadderProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Roster resolves the acting-DM / requester user ids to display names for the banners.
  const membersQuery = useQuery({
    queryKey: queryKeys.campaignMembers(campaignId),
    queryFn: () => api.get<CampaignMember[]>(`${API}/campaigns/${campaignId}/members`),
    enabled: canAct || session.state === 'human_control' || session.takeoverRequestedBy !== null,
  });
  const nameFor = useMemo(() => {
    const byUser = new Map<string, string>();
    for (const m of membersQuery.data ?? []) {
      byUser.set(String(m.userId), m.displayName || m.username || `#${m.userId}`);
    }
    return (userId: string | null | undefined): string => (userId ? byUser.get(userId) ?? userId : '');
  }, [membersQuery.data]);

  const stuck = session.state === 'awaiting_players' && session.stuck !== null;
  const humanControl = session.state === 'human_control';
  const levers = (session.levers ?? []) as Lever[];
  const vote = session.vote && !session.vote.resolved ? session.vote : null;

  /** Run a lever mutation: refetch the session on success, surface a 4xx verbatim. */
  async function run(key: string, fn: () => Promise<unknown>, onOk?: () => void) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      invalidateAiDm(queryClient, campaignId);
      onOk?.();
    } catch (err) {
      setError(translateApiError(err, t));
    } finally {
      setBusy(null);
    }
  }

  const post = (path: string, body?: unknown) => api.post(`${API}/campaigns/${campaignId}/ai-dm/${path}`, body);

  function openDialog(d: Dialog) {
    setError(null);
    setDialog((prev) => (prev === d ? null : d));
  }

  // ---- Individual lever actions -----------------------------------------
  const doRetry = () => run('retry', () => post('nudge', {}));
  const doNudge = (hint: string) =>
    run('nudge', () => post('nudge', hint.trim() ? { hint: hint.trim() } : {}), () => setDialog(null));
  const doFlag = (objection: string) =>
    run('flag', () => post('flag', { objection: objection.trim() }), () => setDialog(null));
  const doOpenVote = (kind: 'override' | 'pause') =>
    run('vote-open', () => post('vote', { action: 'open', kind }), () => setDialog(null));
  const doCastVote = (choice: boolean) => run(`cast-${choice}`, () => post('vote', { action: 'cast', choice }));
  const doRequestTakeover = () => run('request_takeover', () => post('request-takeover', {}));
  const doGrant = (note: string) =>
    run('grant', () => post('grant-takeover', note.trim() ? { note: note.trim() } : {}), () => setDialog(null));
  const doHandback = (note: string) =>
    run('handback', () => post('handback', note.trim() ? { note: note.trim() } : {}), () => setDialog(null));
  const doPause = () => run('pause', () => post('pause', { paused: true }));
  const doRulesLookup = (query: string) =>
    run('rules', async () => {
      const res = await api.post<{ query: string; result: string }>(
        `${API}/campaigns/${campaignId}/ai-dm/rules-lookup`,
        { query: query.trim() },
      );
      onRulesAnswer(res.query, res.result);
    }, () => setDialog(null));

  // Nothing to show for a healthy seat with no vote/request when the viewer can't act.
  const showToolbar = canAct && !stuck && !humanControl && session.state === 'running';
  if (!stuck && !humanControl && !vote && !showToolbar && !(isDm && session.takeoverRequestedBy)) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      {/* ---- Human-control banner (full-width, seat frozen) ---- */}
      {humanControl && (
        <div
          className="cf-inset p-4 flex flex-col gap-2"
          style={{ borderColor: 'var(--color-accent)', background: 'color-mix(in srgb, var(--color-accent) 8%, transparent)' }}
          role="status"
        >
          <div className="flex items-center gap-2">
            <span className="text-lg">🎙️</span>
            <p className="text-sm font-semibold text-[var(--color-text)]">
              {t('ladder.humanControlTitle', { name: nameFor(session.actingDm?.memberId) })}
            </p>
          </div>
          <p className="text-xs text-[var(--color-neutral-400)]">{t('ladder.humanControlHint')}</p>
          {session.actingDm?.note && (
            <p className="text-xs text-[var(--color-neutral-400)] italic">
              {t('ladder.grantNoteLabel')} {session.actingDm.note}
            </p>
          )}
          {canAct && (
            <div>
              <Btn onClick={() => openDialog('handback')} disabled={busy !== null}>
                {t('ladder.handback')}
              </Btn>
            </div>
          )}
          {dialog === 'handback' && (
            <NoteDialog
              placeholder={t('ladder.handbackNotePlaceholder')}
              submitLabel={t('ladder.handbackConfirm')}
              busy={busy === 'handback'}
              onCancel={() => setDialog(null)}
              onSubmit={doHandback}
              required={false}
            />
          )}
        </div>
      )}

      {/* ---- Stuck banner ---- */}
      {stuck && session.stuck && (
        <div
          className="cf-inset p-4 flex flex-col gap-3"
          style={{ borderColor: '#f59e0b', background: 'color-mix(in srgb, #f59e0b 8%, transparent)' }}
          role="alert"
        >
          <div className="flex items-start gap-2">
            <span className="text-lg">⚠️</span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-[var(--color-text)]">
                {t(`ladder.reason.${session.stuck.reason}`, { defaultValue: t('ladder.stuckTitle') })}
              </p>
              {/* Server's player-readable detail — verbatim. */}
              <p className="text-sm text-[var(--color-neutral-200)] mt-0.5">{session.stuck.detail}</p>
              <p className="text-[11px] text-[var(--color-neutral-600)] mt-1">
                {t('ladder.stuckSince', { time: new Date(session.stuck.since).toLocaleTimeString(), turn: session.stuck.turn })}
              </p>
            </div>
          </div>
          {canAct ? (
            <LeverBar
              levers={levers}
              isDm={isDm}
              busy={busy}
              onLever={(l) => onLever(l)}
            />
          ) : (
            <p className="text-xs text-[var(--color-neutral-600)]">{t('ladder.viewerStuckHint')}</p>
          )}
        </div>
      )}

      {/* ---- Open table vote ---- */}
      {vote && (
        <VoteCard
          vote={vote}
          myUserId={myUserId}
          canAct={canAct}
          busy={busy}
          onCast={doCastVote}
        />
      )}

      {/* ---- DM: pending human-takeover request → grant affordance ---- */}
      {isDm && !humanControl && session.takeoverRequestedBy && (
        <div className="cf-inset p-3 flex flex-wrap items-center gap-2">
          <span className="text-sm">🙋 {t('ladder.takeoverRequested', { name: nameFor(session.takeoverRequestedBy) })}</span>
          <div className="ml-auto">
            <Btn onClick={() => openDialog('grant')} disabled={busy !== null}>
              {t('ladder.grantTakeover')}
            </Btn>
          </div>
          {dialog === 'grant' && (
            <NoteDialog
              placeholder={t('ladder.grantNotePlaceholder')}
              submitLabel={t('ladder.grantConfirm')}
              busy={busy === 'grant'}
              onCancel={() => setDialog(null)}
              onSubmit={doGrant}
              required={false}
            />
          )}
        </div>
      )}

      {/* ---- Ambient table-tools bar (healthy play) ---- */}
      {showToolbar && (
        <div className="cf-inset p-2 flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-neutral-600)] px-1">
            {t('ladder.tableTools')}
          </span>
          <LeverBar
            levers={levers.filter((l) => AMBIENT_LEVERS.has(l))}
            isDm={isDm}
            busy={busy}
            onLever={(l) => onLever(l)}
            compact
          />
        </div>
      )}

      {/* ---- Dialogs shared by both bars ---- */}
      {dialog === 'nudge' && (
        <NoteDialog
          placeholder={t('ladder.nudgeHintPlaceholder')}
          submitLabel={t('ladder.nudgeConfirm')}
          busy={busy === 'nudge'}
          onCancel={() => setDialog(null)}
          onSubmit={doNudge}
          required={false}
        />
      )}
      {dialog === 'flag' && (
        <NoteDialog
          placeholder={t('ladder.flagObjectionPlaceholder')}
          submitLabel={t('ladder.flagConfirm')}
          busy={busy === 'flag'}
          onCancel={() => setDialog(null)}
          onSubmit={doFlag}
          required
        />
      )}
      {dialog === 'rules' && (
        <RulesDialog busy={busy === 'rules'} onCancel={() => setDialog(null)} onSubmit={doRulesLookup} />
      )}
      {dialog === 'vote' && (
        <div className="cf-inset p-3 flex flex-col gap-2">
          <p className="text-xs text-[var(--color-neutral-400)]">{t('ladder.voteOpenPrompt')}</p>
          <div className="flex flex-wrap gap-2">
            <Btn onClick={() => doOpenVote('override')} disabled={busy !== null}>
              {t('ladder.voteOpenOverride')}
            </Btn>
            <Btn onClick={() => doOpenVote('pause')} disabled={busy !== null}>
              {t('ladder.voteOpenPause')}
            </Btn>
            <Btn ghost onClick={() => setDialog(null)} disabled={busy !== null}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Btn>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-rose-400 px-1">{error}</p>}
    </div>
  );

  // Route a lever button to its action / dialog.
  function onLever(lever: Lever) {
    switch (lever) {
      case 'retry':
        return void doRetry();
      case 'nudge':
        return openDialog('nudge');
      case 'flag':
        return openDialog('flag');
      case 'vote':
        return openDialog('vote');
      case 'rules_lookup':
        return openDialog('rules');
      case 'request_takeover':
        return void doRequestTakeover();
      case 'pause':
        return void doPause();
    }
  }
}

/** The row of lever buttons, filtered to what this role may use. */
function LeverBar({
  levers,
  isDm,
  busy,
  onLever,
  compact = false,
}: {
  levers: Lever[];
  isDm: boolean;
  busy: string | null;
  onLever: (l: Lever) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const visible = levers.filter((l) => isDm || !DM_ONLY_LEVERS.has(l));
  return (
    <div className="flex flex-wrap gap-2">
      {visible.map((l) => (
        <Btn key={l} ghost={compact} onClick={() => onLever(l)} disabled={busy !== null}>
          {t(`ladder.lever.${l}`)}
        </Btn>
      ))}
    </div>
  );
}

/** Live open-vote card: kind, tally vs threshold, your ballot, cast yes/no. */
function VoteCard({
  vote,
  myUserId,
  canAct,
  busy,
  onCast,
}: {
  vote: NonNullable<AiDmSession['vote']>;
  myUserId: string | null;
  canAct: boolean;
  busy: string | null;
  onCast: (choice: boolean) => void;
}) {
  const { t } = useTranslation();
  const ballots = Object.values(vote.ballots);
  const yes = ballots.filter(Boolean).length;
  const no = ballots.length - yes;
  const myBallot = myUserId != null ? vote.ballots[myUserId] : undefined;
  const pct = vote.threshold > 0 ? Math.min(100, (yes / vote.threshold) * 100) : 0;

  return (
    <div className="cf-inset p-4 flex flex-col gap-2" role="group">
      <div className="flex items-center gap-2">
        <span className="text-lg">🗳️</span>
        <p className="text-sm font-semibold text-[var(--color-text)]">
          {t(`ladder.voteTitle.${vote.kind}`)}
        </p>
      </div>
      <div
        className="rounded-full overflow-hidden"
        style={{ height: 6, background: 'var(--color-neutral-800)' }}
        role="progressbar"
        aria-valuenow={yes}
        aria-valuemin={0}
        aria-valuemax={vote.threshold}
      >
        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--color-accent)' }} />
      </div>
      <p className="text-[11px] text-[var(--color-neutral-600)]">
        {t('ladder.voteTally', { yes, threshold: vote.threshold, no })}
      </p>
      {myBallot !== undefined && (
        <p className="text-[11px] text-[var(--color-neutral-400)]">
          {t('ladder.voteYourBallot', { choice: myBallot ? t('ladder.voteYes') : t('ladder.voteNo') })}
        </p>
      )}
      {canAct && (
        <div className="flex gap-2">
          <Btn onClick={() => onCast(true)} disabled={busy !== null}>
            {t('ladder.voteCastYes')}
          </Btn>
          <Btn ghost onClick={() => onCast(false)} disabled={busy !== null}>
            {t('ladder.voteCastNo')}
          </Btn>
        </div>
      )}
    </div>
  );
}

/** A one-field note/objection/hint dialog. `required` gates the submit on non-empty text. */
function NoteDialog({
  placeholder,
  submitLabel,
  busy,
  required,
  onCancel,
  onSubmit,
}: {
  placeholder: string;
  submitLabel: string;
  busy: boolean;
  required: boolean;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const canSubmit = !busy && (!required || text.trim().length > 0);
  return (
    <div className="cf-inset p-3 flex flex-col gap-2">
      <TextArea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        rows={2}
        disabled={busy}
        autoFocus
      />
      <div className="flex gap-2">
        <Btn onClick={() => onSubmit(text)} disabled={!canSubmit}>
          {busy ? t('ladder.working') : submitLabel}
        </Btn>
        <Btn ghost onClick={onCancel} disabled={busy}>
          {t('common.cancel', { defaultValue: 'Cancel' })}
        </Btn>
      </div>
    </div>
  );
}

/** Rules-lookup dialog: a single question that routes to the compendium (no model budget). */
function RulesDialog({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (query: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  return (
    <div className="cf-inset p-3 flex flex-col gap-2">
      <p className="text-xs text-[var(--color-neutral-400)]">{t('ladder.rulesHint')}</p>
      <TextInput
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('ladder.rulesPlaceholder')}
        disabled={busy}
        autoFocus
      />
      <div className="flex gap-2">
        <Btn onClick={() => onSubmit(query)} disabled={busy || query.trim().length === 0}>
          {busy ? t('ladder.working') : t('ladder.rulesConfirm')}
        </Btn>
        <Btn ghost onClick={onCancel} disabled={busy}>
          {t('common.cancel', { defaultValue: 'Cancel' })}
        </Btn>
      </div>
    </div>
  );
}
