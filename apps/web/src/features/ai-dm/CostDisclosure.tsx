/**
 * The money line, in both of its states (issue #1065).
 *
 * ONE component for "here is roughly what this costs" and "we cannot tell you what this
 * costs", because they are the same slot in the UI and must be equally prominent. Splitting
 * them into an estimate component plus an easily-forgotten fallback is how the disclosure
 * ends up quieter than the number — and the disclosure is the case that actually protects
 * someone, since it is what sends them to their provider's billing page.
 *
 * The scope sentence renders NEXT TO the figure, never in a tooltip or a title attribute. A
 * DM running several campaigns who reads a per-seat figure as their whole server bill is the
 * precise failure this issue exists to prevent, and a caveat nobody sees does not prevent it.
 */
import { useTranslation } from 'react-i18next';
import type { AiCostBasis } from '@campfire/schema';
import { costUnknownReasonKey } from './costEstimate';

export function CostDisclosure({
  basis,
  /** Pre-formatted figure (a point or a range). Ignored when `basis.kind === 'unknown'`. */
  amount,
  /** What the figure covers, e.g. a per-turn estimate or a whole budget. */
  scopeKey,
  className,
}: {
  basis: AiCostBasis;
  amount: string | null;
  scopeKey: string;
  className?: string;
}) {
  const { t } = useTranslation();

  // The unknown branch is FIRST and needs no amount — it is unreachable to render a number
  // here, by construction, because `formatUsdRange` returns null for an unpriced basis.
  if (basis.kind === 'unknown' || amount === null) {
    const reason = basis.kind === 'unknown' ? basis.reason : 'model_not_priced';
    return (
      <div className={className}>
        <p className="m-0 font-semibold text-[var(--color-neutral-200)]">
          {t('aiOnboarding.cost.cannotEstimate')}
        </p>
        <p className="m-0 mt-0.5 text-[11px] text-secondary">{t(costUnknownReasonKey(reason))}</p>
      </div>
    );
  }

  return (
    <div className={className}>
      <p className="m-0">
        <span className="font-semibold text-[var(--color-neutral-100)]">{amount}</span>{' '}
        <span className="text-[var(--color-neutral-300)]">{t(scopeKey)}</span>
      </p>
      <p className="m-0 mt-0.5 text-[11px] text-secondary">
        {t('aiOnboarding.cost.basis', {
          provider: basis.providerType,
          model: basis.model,
          input: basis.inputUsdPerMTok,
          output: basis.outputUsdPerMTok,
        })}
      </p>
      {/* Staleness, only for figures that came from the shipped reference list. An admin who
          typed their own numbers does not need to be told where they came from. */}
      {basis.source === 'reference' && basis.asOf && (
        <p className="m-0 mt-0.5 text-[11px] text-secondary">
          {t('aiOnboarding.cost.referenceAsOf', { date: basis.asOf })}
        </p>
      )}
      <p className="m-0 mt-0.5 text-[11px] text-secondary">{t('aiOnboarding.cost.scopeCaveat')}</p>
    </div>
  );
}
