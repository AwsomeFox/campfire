import type { ReactNode } from 'react';
import { ListDetailLink } from './ListDetailLink';
import { GameIcon } from './GameIcon';
import { UI_ICON_SIZE } from '../lib/uiIcons';
import { initials } from '../lib/avatarText';

export type EntityCardProps = {
  to: string;
  title: string;
  'aria-label'?: string;
  ariaLabel?: string;
  subtitle?: ReactNode;
  portraitUrl?: string | null;
  iconSlug?: string;
  badges?: ReactNode;
  children?: ReactNode;
  className?: string;
  nameClassName?: string;
};

/**
 * Shared entity row/card primitive (issue #1783).
 * Provides identical visual rhythm across roster screens (NPCs, Factions, Locations).
 */
export function EntityCard({
  to,
  title,
  'aria-label': ariaLabelProp,
  ariaLabel,
  subtitle,
  portraitUrl,
  iconSlug,
  badges,
  children,
  className = '',
  nameClassName = 'font-bold text-slate-200 text-sm truncate cf-name-reveal',
}: EntityCardProps) {
  const resolvedAriaLabel = ariaLabelProp ?? ariaLabel ?? title;
  return (
    <ListDetailLink
      to={to}
      className={`cf-card cf-card-hover cf-density-compact space-y-2 ${className}`.trim()}
    >
      <div className="flex items-center gap-2.5">
        {portraitUrl ? (
          <img
            src={portraitUrl}
            alt=""
            className="h-9 w-9 shrink-0 rounded-full object-cover border border-[var(--color-divider)]"
          />
        ) : iconSlug ? (
          <span className="h-9 w-9 shrink-0 rounded-full bg-[var(--color-neutral-900)] border border-[var(--color-divider)] flex items-center justify-center text-[13px] text-[var(--color-neutral-400)] overflow-hidden">
            <GameIcon
              slug={iconSlug}
              size={UI_ICON_SIZE.lg}
              title={title}
              className="text-[var(--color-accent)]"
              fallback={initials(title)}
            />
          </span>
        ) : (
          <span className="h-9 w-9 shrink-0 rounded-full bg-[var(--color-neutral-900)] border border-[var(--color-divider)] flex items-center justify-center text-[13px] text-[var(--color-neutral-400)]">
            {initials(title)}
          </span>
        )}
        <div className="flex-1 min-w-0">
          <p
            className={nameClassName}
            title={title}
            aria-label={resolvedAriaLabel}
          >
            {title}
          </p>
          {subtitle && (
            <p className="text-[11.5px] text-secondary truncate cf-name-reveal" title={typeof subtitle === 'string' ? subtitle : undefined}>{subtitle}</p>
          )}
        </div>
      </div>
      {children}
      {badges && <div className="flex items-center gap-1.5 flex-wrap">{badges}</div>}
    </ListDetailLink>
  );
}
