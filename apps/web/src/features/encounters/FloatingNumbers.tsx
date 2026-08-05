import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { HpFeedbackEvent } from './hpFeedback';

type FloatingNumbersProps = {
  events: readonly (HpFeedbackEvent & { id: number })[];
};

/** One transient, presentational overlay used by roster, initiative, and map tokens. */
export function FloatingNumbers({ events }: FloatingNumbersProps) {
  const { t } = useTranslation();
  if (events.length === 0) return null;

  return (
    <span className="cf-hp-feedback" aria-hidden="true" data-testid="hp-feedback">
      {events.map((event, index) => {
        const label =
          event.kind === 'damage'
            ? `-${event.amount}`
            : event.kind === 'heal' || event.kind === 'tempHp'
              ? `+${event.amount}`
              : event.kind === 'down'
                ? t('encounters.feedback.down')
                : event.kind === 'revive'
                  ? t('encounters.feedback.revive')
                  : event.bandDirection === 'recover'
                    ? t('encounters.feedback.recover')
                    : t('encounters.feedback.hurt');
        return (
          <span
            key={event.id}
            className={`cf-hp-feedback__item cf-hp-feedback__item--${event.kind}${event.crit ? ' cf-hp-feedback__item--crit' : ''}`}
            data-testid={`hp-feedback-${event.kind}`}
            style={{
              animationDelay: `${index * 120}ms`,
              '--cf-hp-feedback-offset': `${index * 1.2}em`,
            } as CSSProperties}
          >
            {event.kind === 'tempHp' && '◆ '}
            {label}
          </span>
        );
      })}
    </span>
  );
}
