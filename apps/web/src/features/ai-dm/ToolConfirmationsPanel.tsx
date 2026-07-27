import { useCallback, useId, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, API, ApiError } from '../../lib/api';
import {
  invalidateAiDmToolConfirmations,
  useAiDmToolConfirmations,
  type AiDmToolConfirmation,
} from '../../lib/query';
import { Btn, ErrorNote } from '../../components/ui';
import { useAnnounce } from '../../components/Announcer';
import { buildToolArgNameLookup, summariseToolConfirmation } from './toolConfirmationSummary';

/**
 * Pending AI tool confirmations, on the AI Table (issue #1558).
 *
 * THE BUG THIS CLOSES. The server half of confirm-policy tools shipped in #1423 and has been
 * tested ever since; the client half was never picked up. So `begin_encounter` — confirm-policy
 * in every profile since #474 — could only be approved with a direct API call. A safety control
 * the user cannot reach is arguably worse than one that does not exist: the DM was told the
 * mechanism protects them, and its failure mode is a SILENT STALL rather than an error. The AI
 * narrates an action, the action never happens, and nothing anywhere says why.
 *
 * WHY IT LIVES HERE and not on a settings page: this is a thing a DM must answer DURING PLAY,
 * within seconds, while the table waits. A confirmations screen nobody navigates to reproduces
 * the original bug with extra steps.
 *
 * A LIST, NOT A PROMPT. Under collaborative handoff (#1051) one ordinary combat turn is four
 * confirmations — resolve, apply, condition, next turn — so multiple pending items is the NORMAL
 * case, not an edge case. Rendering one-at-a-time would be wrong the first time anyone used it.
 * Oldest first, because that is the order the AI proposed them and approving out of order can
 * apply damage to a turn that has moved on.
 *
 * WHAT IS SHOWN. A sentence per call ({@link summariseToolConfirmation}), built only from names
 * the client already holds, with the raw arguments one disclosure away — compact by default,
 * complete on request, never silently partial. See that module for why an unresolvable id stays
 * an id.
 */
export function ToolConfirmationsPanel({
  campaignId,
  isDm,
  /** Character/combatant rows the page already loaded, for name resolution. */
  knownEntities,
}: {
  campaignId: number | undefined;
  isDm: boolean;
  knownEntities?: ReadonlyArray<{ id?: unknown; name?: unknown } | null | undefined>;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const { data: pending } = useAiDmToolConfirmations(campaignId, isDm);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();

  const lookup = useMemo(() => buildToolArgNameLookup(knownEntities), [knownEntities]);

  const resolve = useCallback(
    async (confirmationId: string, action: 'approve' | 'reject') => {
      if (campaignId === undefined) return;
      setBusyId(confirmationId);
      setError(null);
      try {
        await api.post(`${API}/campaigns/${campaignId}/ai-dm/tool-confirmation`, { action, confirmationId });
        announce(t(action === 'approve' ? 'table.confirmations.approved' : 'table.confirmations.rejected'));
      } catch (err) {
        setError(err instanceof ApiError && err.message ? err.message : t('table.confirmations.failed'));
      } finally {
        setBusyId(null);
        invalidateAiDmToolConfirmations(queryClient, campaignId);
      }
    },
    [announce, campaignId, queryClient, t],
  );

  // Players never see this: the endpoint is DM-only, so for anyone else the query is disabled
  // and there is nothing to render. An empty queue renders nothing at all rather than an
  // "all clear" card — the panel appearing IS the signal.
  if (!isDm || !pending || pending.length === 0) return null;

  return (
    <section
      className="cf-inset p-3 flex flex-col gap-2"
      aria-labelledby={headingId}
      data-testid="ai-tool-confirmations"
    >
      {/* `role="status"` so a confirmation arriving while the DM is reading elsewhere on the page
          is announced, rather than silently appearing — the stall being silent is the bug. */}
      <div role="status" className="flex items-center gap-2">
        <h2 id={headingId} className="text-sm font-semibold m-0">
          {t('table.confirmations.title')}
        </h2>
        <span className="cf-chip cf-chip-dm" data-testid="ai-tool-confirmations-count">
          {pending.length}
        </span>
      </div>
      <p className="text-xs text-muted m-0">{t('table.confirmations.blocked')}</p>

      <ul className="flex flex-col gap-2 list-none p-0 m-0">
        {[...pending]
          // Oldest first — the order the AI proposed them in.
          .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
          .map((c) => (
            <ConfirmationRow
              key={c.id}
              confirmation={c}
              lookup={lookup}
              busy={busyId === c.id}
              disabled={busyId !== null}
              onResolve={resolve}
            />
          ))}
      </ul>
      {error && <ErrorNote message={error} />}
    </section>
  );
}

function ConfirmationRow({
  confirmation,
  lookup,
  busy,
  disabled,
  onResolve,
}: {
  confirmation: AiDmToolConfirmation;
  lookup: Readonly<Record<number, string>>;
  busy: boolean;
  disabled: boolean;
  onResolve: (id: string, action: 'approve' | 'reject') => void;
}) {
  const { t } = useTranslation();
  const summary = useMemo(
    () => summariseToolConfirmation(confirmation.tool, confirmation.args ?? {}, lookup),
    [confirmation.tool, confirmation.args, lookup],
  );
  const rowId = useId();

  return (
    <li className="flex flex-col gap-1" data-testid="ai-tool-confirmation-row" data-tool={confirmation.tool}>
      <p className="text-sm m-0" id={`${rowId}-headline`}>
        {summary.headline}
      </p>
      {/* Provenance the DM needs to judge staleness: which turn proposed it, and when. A queued
          call from three turns ago may be about a fight that has since ended. */}
      <p className="text-xs text-muted m-0">
        {t('table.confirmations.meta', { tool: confirmation.tool, turn: confirmation.turnNumber })}
      </p>
      <details className="text-xs">
        <summary className="cursor-pointer">
          {summary.omittedKeys.length > 0
            ? t('table.confirmations.showArgsMore', { count: summary.omittedKeys.length })
            : t('table.confirmations.showArgs')}
        </summary>
        <pre className="overflow-x-auto text-[11px] m-0 mt-1">
          {JSON.stringify(confirmation.args ?? {}, null, 2)}
        </pre>
      </details>
      <div className="flex gap-1.5">
        <Btn
          density="compact"
          busy={busy}
          disabled={disabled && !busy}
          aria-describedby={`${rowId}-headline`}
          onClick={() => onResolve(confirmation.id, 'approve')}
          data-testid="ai-tool-confirmation-approve"
        >
          {t('table.confirmations.approve')}
        </Btn>
        <Btn
          ghost
          danger
          density="compact"
          disabled={disabled}
          aria-describedby={`${rowId}-headline`}
          onClick={() => onResolve(confirmation.id, 'reject')}
          data-testid="ai-tool-confirmation-reject"
        >
          {t('table.confirmations.reject')}
        </Btn>
      </div>
    </li>
  );
}
