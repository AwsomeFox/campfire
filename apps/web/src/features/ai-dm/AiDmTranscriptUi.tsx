/**
 * Shared transcript row rendering for AI-DM surfaces (#339 Table, #427 encounter dock).
 */
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { GameIcon } from '../../components/GameIcon';
import { Markdown } from '../../components/Markdown';
import { resolveToolActivity, type ToolResource } from './toolActivity';
import {
  dmEntryText,
  type DmEntry,
  type PlayerEntry,
  type SystemEntry,
  type ToolEntry,
} from './transcript';
import { UI_ICON_SIZE } from '../../lib/uiIcons';
import { formatNumber } from '../../lib/format';

/** game-icons slug for a tool chip's resource family. */
export const RESOURCE_ICON: Record<ToolResource, string> = {
  dice: 'rolling-dices',
  encounter: 'crossed-swords',
  party: 'shield',
  map: 'treasure-map',
  proposals: 'quill-ink',
  rules: 'open-book',
  other: 'sparkles',
};

/** Render one transcript entry. */
export function TranscriptRow({
  entry,
  campaignId,
  encounterId,
}: {
  entry: PlayerEntry | DmEntry | ToolEntry | SystemEntry;
  campaignId: number;
  encounterId?: number;
}) {
  const { t } = useTranslation();

  if (entry.kind === 'player') {
    return (
      <div className="flex flex-col items-end">
        <div className="text-[11px] text-secondary mb-0.5">
          {entry.characterName
            ? `${entry.characterName} · ${t('table.playedBy', { name: entry.memberName })}`
            : entry.memberName}
        </div>
        <div
          className="max-w-[85%] rounded-lg px-3 py-2 text-sm"
          style={{
            background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)',
            color: 'var(--color-neutral-100)',
          }}
        >
          {entry.text}
        </div>
      </div>
    );
  }

  if (entry.kind === 'dm') {
    const text = dmEntryText(entry);
    return (
      <div className="flex flex-col items-start">
        <div className="text-[11px] font-semibold text-[var(--color-accent)] mb-0.5">DM</div>
        <div className="max-w-[92%] rounded-lg px-3 py-2 cf-inset">
          {text ? <Markdown>{text}</Markdown> : <span className="cf-typing text-secondary">…</span>}
          {entry.status === 'streaming' && text && <span className="cf-typing"> ▍</span>}
          {entry.meta && (
            <div className="text-[10px] text-secondary mt-1.5 pt-1.5 border-t border-[var(--color-divider)]">
              {entry.meta.stopReason} · {entry.meta.steps} steps ·{' '}
              {entry.meta.tokensUsageUnknown
                ? t('table.tokensUnknown')
                : t('table.tokensUsedInline', {
                    count: entry.meta.tokensUsed,
                    formatted: formatNumber(entry.meta.tokensUsed),
                  })}{' '}
              · {formatNumber(entry.meta.budgetRemaining)} left
              {entry.meta.errorMessage ? (
                <span className="block mt-1 text-rose-400/90">{entry.meta.errorMessage}</span>
              ) : null}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (entry.kind === 'tool') {
    const chip = resolveToolActivity(
      {
        type: 'tool',
        campaignId,
        name: entry.name,
        isError: entry.isError,
        proposed: entry.proposed,
        ...(entry.encounterId !== undefined ? { encounterId: entry.encounterId } : {}),
        at: entry.at,
      },
      { campaignId, encounterId },
    );
    const tone =
      chip.variant === 'error'
        ? 'var(--color-text-secondary)'
        : chip.variant === 'proposal'
          ? 'var(--color-accent)'
          : 'var(--color-neutral-400)';
    const body = (
      <span
        className="cf-chip inline-flex items-center gap-1"
        style={{ color: tone, borderColor: 'var(--color-divider)' }}
      >
        <span className="flex"><GameIcon slug={RESOURCE_ICON[chip.resource]} size={UI_ICON_SIZE.xs} /></span>
        <span>{chip.label}</span>
      </span>
    );
    return (
      <div className="flex justify-center">
        {chip.href ? <Link to={chip.href}>{body}</Link> : body}
      </div>
    );
  }

  if (entry.variant === 'rules') {
    return (
      <div className="flex justify-center">
        <div className="cf-inset px-3 py-2 max-w-[92%] text-sm">
          <div className="text-[10px] font-bold uppercase tracking-widest text-secondary">
            {t('ladder.rulesAnswerLabel', { query: entry.data?.query ?? '' })}
          </div>
          <div className="mt-1">
            <Markdown>{entry.text ?? ''}</Markdown>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-center">
      <span className="text-[11px] text-secondary italic px-2">{systemText(entry, t)}</span>
    </div>
  );
}


/**
 * #1043 — the session phases that have their own copy. Kept as a literal list rather than
 * imported from the server enum because this is a rendering question: it asks "do we have a
 * translated line for this string", and a phase added server-side without copy must fall back,
 * not print a raw key.
 */
const KNOWN_PHASES = ['active', 'greeting', 'wrap_up', 'ended'] as const;
function isKnownPhase(value: string): boolean {
  return (KNOWN_PHASES as readonly string[]).includes(value);
}

/** Localized text for a system/divider transcript line (visible + SR mirror). */
export function systemText(entry: SystemEntry, t: (k: string, o?: Record<string, unknown>) => string): string {
  switch (entry.variant) {
    case 'divider':
      return `— ${t('table.joinedDivider')} —`;
    case 'scene':
      return t('table.systemScene', { text: entry.text ?? '' });
    case 'stuck':
      return entry.text ? `${t('table.systemStuck')} ${entry.text}` : t('table.systemStuck');
    case 'withheld':
      // #598 — the server supplies the neutral sentence (the same copy the stuck detail and the
      // audit trail carry); the localized prefix stands alone if it is missing. Nothing here
      // ever describes WHAT was withheld — that would hand the table the content the withhold
      // exists to keep from them.
      return entry.text ? `${t('table.systemWithheld')} ${entry.text}` : t('table.systemWithheld');
    case 'recovered':
      return t('table.systemRecovered');
    case 'paused':
      return t('table.systemPaused');
    case 'resumed':
      return t('table.systemResumed');
    case 'takeover':
      return t('table.systemTakeover');
    case 'vote':
      return t('table.systemVote', { action: entry.data?.action ?? '' });
    case 'rules':
      return entry.text
        ? t('table.systemRules', { text: entry.text })
        : t('table.systemRulesEmpty');
    // #1043 — the durable lifecycle rows. The phase name is interpolated through its own key
    // rather than printed raw: these rows are read by everyone at the table, in their own
    // language, and `wrap_up` is not a phrase. An unrecognised phase (a row written by a newer
    // server) falls back to the generic line instead of rendering a missing-key placeholder.
    case 'phase': {
      const phase = entry.data?.phase ?? '';
      return isKnownPhase(phase) ? t(`table.systemPhase.${phase}`) : t('table.systemPhaseUnknown');
    }
    case 'phaseInterrupted': {
      const interrupted = entry.data?.interrupted ?? '';
      return t('table.systemPhaseInterrupted', {
        phase: isKnownPhase(interrupted) ? t(`table.phaseName.${interrupted}`) : interrupted,
      });
    }
    case 'info':
    default:
      return t('table.systemInfo', { state: entry.data?.state ?? '' });
  }
}
