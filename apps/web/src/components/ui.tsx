/**
 * Campfire UI primitives — mirror the design package (design/tokens.html).
 * Feature screens compose these; do not restyle geometry locally (issue #674).
 */
import { forwardRef, useEffect, useRef, useState, type ReactNode, type RefObject, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { GameIcon } from './GameIcon';
import { chipClass, type ChipVariant } from './chipVariants';
import { densityClass, elevClass, type UiDensity, type UiElevation } from './density';
import { SKELETON_TEST_IDS } from './loadingSkeletonState';
import { useDialog } from './useDialog';
import { UI_ICON_SIZE } from '../lib/uiIcons';
export type { ChipVariant } from './chipVariants';
export type { UiDensity, UiElevation } from './density';

type DensityProps = { density?: UiDensity };

export function Card({
  children,
  className = '',
  density = 'comfortable',
  elev,
  hover = false,
  flush = false,
  ...props
}: HTMLAttributes<HTMLElement> & DensityProps & {
  children: ReactNode;
  elev?: UiElevation;
  hover?: boolean;
  /** Drop shell padding so inner regions control inset (cover tiles, menus). */
  flush?: boolean;
}) {
  return (
    <section
      className={`cf-card ${densityClass(density)} ${flush ? 'cf-card-flush' : ''} ${elevClass(elev)} ${hover ? 'cf-card-hover' : ''} ${className}`.trim()}
      {...props}
    >
      {children}
    </section>
  );
}

export function Inset({
  children,
  className = '',
  density = 'default',
}: {
  children: ReactNode;
  className?: string;
  density?: UiDensity;
}) {
  return <div className={`cf-inset ${densityClass(density)} ${className}`.trim()}>{children}</div>;
}

export function Chip({
  variant,
  children,
  className = '',
  density = 'default',
}: {
  variant: ChipVariant;
  children: ReactNode;
  className?: string;
  density?: UiDensity;
}) {
  return (
    <span className={`cf-chip ${chipClass[variant]} ${densityClass(density)} ${className}`.trim()}>
      {children}
    </span>
  );
}

/** Map domain statuses to chip variants. */
export function statusVariant(status: string): ChipVariant {
  switch (status) {
    case 'active': case 'current': return 'active';
    case 'completed': case 'explored': return 'completed';
    case 'failed': return 'failed';
    default: return 'available';
  }
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & DensityProps & {
  ghost?: boolean;
  danger?: boolean;
  /** Marks an in-flight action and keeps it natively disabled until it settles. */
  busy?: boolean;
};

export const Btn = forwardRef<HTMLButtonElement, BtnProps>(
  function Btn({ ghost, danger, busy = false, disabled = false, density = 'default', className = '', ...rest }, ref) {
    return (
      <button
        ref={ref}
        className={`cf-btn ${densityClass(density)} ${ghost ? 'cf-btn-ghost' : ''} ${danger ? 'cf-btn-danger' : ''} ${className}`.trim()}
        {...rest}
        disabled={disabled || busy}
        aria-busy={busy || undefined}
      />
    );
  },
);

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & DensityProps>(
  function TextInput({ className = '', dir = 'auto', density = 'comfortable', ...props }, ref) {
    return <input ref={ref} dir={dir} className={`cf-input ${densityClass(density)} ${className}`.trim()} {...props} />;
  },
);

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & DensityProps>(
  function TextArea({ className = '', dir = 'auto', density = 'comfortable', ...props }, ref) {
    return <textarea ref={ref} dir={dir} className={`cf-textarea ${densityClass(density)} ${className}`.trim()} {...props} />;
  },
);

/**
 * Accessible modal shell — the `.dialog` / `.dialog-backdrop` pattern from
 * nocturne.css with canonical density (issue #674). Every modal in the app
 * routes through this primitive (issue #1783); ConfirmDialog and
 * ConfirmDestructiveDialog compose it rather than hand-rolling the markup.
 */
export function Dialog({
  title,
  titleId,
  titleAs: TitleTag = 'p',
  children,
  bodyId,
  afterBody,
  actions,
  density = 'default',
  onBackdropClick,
  className = '',
  backdropClassName = '',
  role = 'dialog',
  descId,
  ariaBusy,
  initialFocusRef,
  backdropTestId,
  dialogTestId,
  'data-overlay': dataOverlay = 'dialog',
}: {
  title?: ReactNode;
  titleId?: string;
  /** Tag for the rendered title element. Defaults to `p`; pass `h2` for flows
   * (e.g. a destructive type-to-confirm dialog) that need a heading landmark. */
  titleAs?: 'p' | 'h2';
  children?: ReactNode;
  /** id applied to the auto-rendered `.dialog-body` wrapper — wire to `descId`
   * for `aria-describedby` when the description must target that region only. */
  bodyId?: string;
  /**
   * Extra content rendered after `.dialog-body`, outside its dimmed styling
   * (nocturne.css sets `.dialog-body { opacity: 0.85 }`). Use this for a
   * caller-owned `<form>`/controls region — e.g. a type-to-confirm input —
   * that must stay at full opacity and isn't part of the description.
   */
  afterBody?: ReactNode;
  actions?: ReactNode;
  density?: UiDensity;
  onBackdropClick?: () => void;
  className?: string;
  backdropClassName?: string;
  /** @default 'dialog' — pass 'alertdialog' for destructive confirmations. */
  role?: 'dialog' | 'alertdialog';
  descId?: string;
  ariaBusy?: boolean;
  /** Prefer this element over the first focusable when focus enters the dialog. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  backdropTestId?: string;
  dialogTestId?: string;
  'data-overlay'?: string;
}) {
  const dialogRef = useDialog<HTMLDivElement>({
    onClose: onBackdropClick ?? (() => {}),
    disabled: !onBackdropClick,
    autoFocus: true,
    inertBackground: true,
    initialFocusRef,
  });

  return createPortal(
    <div
      className={`dialog-backdrop ${backdropClassName}`.trim()}
      data-overlay={dataOverlay}
      data-testid={backdropTestId}
      onClick={onBackdropClick}
    >
      <div
        ref={dialogRef}
        className={`dialog ${densityClass(density)} ${className}`.trim()}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        aria-busy={ariaBusy || undefined}
        data-testid={dialogTestId}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <TitleTag className="dialog-title" id={titleId}>
            {title}
          </TitleTag>
        )}
        {children && (
          <div className="dialog-body" id={bodyId}>
            {children}
          </div>
        )}
        {afterBody}
        {actions && <div className="dialog-actions">{actions}</div>}
      </div>
    </div>,
    document.body,
  );
}

/**
 * HP bar tone for a current/max pair (issue #642).
 *
 * Extracted from `HpBar` so every HP surface — combat tracker, Party card,
 * character sheet — resolves the SAME danger ramp from the same pure helper.
 * Returns the CSS modifier class name appended to `.cf-hp` (`crit` < 25%,
 * `low` < 50%, otherwise empty). Kept here next to the bar so the threshold
 * table and the rendered bar can't drift apart.
 */
export function hpTone(current: number, max: number): '' | 'low' | 'crit' {
  const pct = max > 0 ? Math.max(0, Math.min(100, (current / max) * 100)) : 0;
  return pct < 25 ? 'crit' : pct < 50 ? 'low' : '';
}

export function HpBar({ current, max }: { current: number; max: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (current / max) * 100)) : 0;
  const tone = hpTone(current, max);
  // Flash + shake on HP change (issue #67). Track the previous value across
  // renders and fire a one-shot 'damage'/'heal' pulse cleared on animation end.
  // CSS disables the motion under prefers-reduced-motion; the bar width still
  // conveys the change, so the feedback is never motion-only.
  const prev = useRef(current);
  const [pulse, setPulse] = useState<'damage' | 'heal' | null>(null);
  useEffect(() => {
    if (current < prev.current) setPulse('damage');
    else if (current > prev.current) setPulse('heal');
    prev.current = current;
  }, [current]);
  const flashClass = pulse === 'damage' ? 'cf-hp-flash-damage' : pulse === 'heal' ? 'cf-hp-flash-heal' : '';
  return (
    <div className={`cf-hp ${tone} ${pulse === 'damage' ? 'cf-anim-hp-damage' : ''}`}>
      <div
        className={flashClass}
        style={{ width: `${pct}%` }}
        onAnimationEnd={() => setPulse(null)}
      />
    </div>
  );
}

/** Accent-tinted DM-only panel. Render ONLY when the effective role is dm and content is non-empty. */
export function DmPanel({ children, density = 'default' }: { children: ReactNode; density?: UiDensity }) {
  return (
    <div className={`cf-dm-panel ${densityClass(density)} space-y-1.5`}>
      <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-[var(--color-accent)]">
        <GameIcon slug="padlock" size={UI_ICON_SIZE.xs} reserveSpace /> DM only
      </p>
      <div className="text-sm text-[var(--color-neutral-300)]">{children}</div>
    </div>
  );
}

export function EmptyState({
  icon = 'candle-flame',
  title,
  hint,
  action,
  children,
  density = 'comfortable',
}: {
  icon?: string;
  title: string;
  hint?: string;
  action?: React.ReactNode;
  children?: React.ReactNode;
  density?: UiDensity;
}) {
  return (
    <div className={`cf-inset border-dashed ${densityClass(density)} text-center space-y-2`}>
      <p className="flex justify-center text-[var(--color-neutral-500)]">
        <GameIcon slug={icon} size={30} reserveSpace />
      </p>
      <p className="text-sm font-semibold text-[var(--color-neutral-300)]">{title}</p>
      {hint && <p className="text-xs text-secondary max-w-md mx-auto">{hint}</p>}
      {action && <div className="pt-1 flex justify-center flex-wrap gap-2">{action}</div>}
      {children}
    </div>
  );
}

/** Shared pulse bar — stays painted when animate-pulse is frozen under reduced motion (#594). */
function SkeletonBar({
  width = '100%',
  className = 'h-3',
}: {
  width?: string;
  className?: string;
}) {
  return (
    <div
      className={`rounded animate-pulse bg-[var(--color-neutral-800)] ${className}`}
      style={{ width }}
      aria-hidden="true"
    />
  );
}

function SkeletonStatus({
  children,
  testId,
  label = 'Loading…',
  className = 'space-y-2',
}: {
  children: ReactNode;
  testId?: string;
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={className}
      role="status"
      aria-busy="true"
      data-testid={testId}
    >
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** Inline text-block placeholder — existing default across list/detail pages. */
export function Skeleton({ lines = 3, label }: { lines?: number; label?: string }) {
  return (
    <SkeletonStatus testId={SKELETON_TEST_IDS.inline} label={label}>
      {Array.from({ length: lines }, (_, i) => (
        <SkeletonBar key={i} width={`${85 - i * 15}%`} />
      ))}
    </SkeletonStatus>
  );
}

/** Alias for call sites that want the issue #677 vocabulary explicitly. */
export const SkeletonInline = Skeleton;

/** Route-level lazy-page placeholder — preserves page title + body geometry. */
export function SkeletonRoute({ lines = 5 }: { lines?: number }) {
  return (
    <div className="max-w-4xl mx-auto px-4 mt-8" data-testid={SKELETON_TEST_IDS.route}>
      <SkeletonStatus label="Loading page…" className="space-y-3">
        <SkeletonBar width="38%" className="h-5" />
        {Array.from({ length: lines }, (_, i) => (
          <SkeletonBar key={i} width={`${92 - i * 10}%`} />
        ))}
      </SkeletonStatus>
    </div>
  );
}

/** Card-shaped placeholder — kicker/header row + body lines inside a real card shell. */
export function SkeletonCard({
  lines = 4,
  sections = 1,
  label,
}: {
  lines?: number;
  sections?: number;
  label?: string;
}) {
  return (
    <section className="card elev-sm" data-testid={SKELETON_TEST_IDS.card}>
      <SkeletonStatus label={label} className="space-y-4">
        {Array.from({ length: sections }, (_, section) => (
          <div key={section} className={section > 0 ? 'space-y-2 pt-3 border-t border-[var(--color-neutral-800)]' : 'space-y-2'}>
            <SkeletonBar width="32%" className="h-2.5" />
            {Array.from({ length: lines }, (_, i) => (
              <SkeletonBar key={i} width={`${88 - i * 12}%`} />
            ))}
          </div>
        ))}
      </SkeletonStatus>
    </section>
  );
}

export type SkeletonConditionalPreset = 'scribe' | 'attendance' | 'provider-form';

/**
 * Geometry-preserving shell for async gates (#677). Reserves the footprint of a
 * region that may never mount (AI seat off) so slow networks do not shift the
 * page while the gate is still resolving.
 */
export function SkeletonConditionalRegion({
  preset,
  label,
}: {
  preset: SkeletonConditionalPreset;
  label?: string;
}) {
  if (preset === 'scribe') {
    return (
      <section className="cf-card cf-density-default space-y-3" data-testid={SKELETON_TEST_IDS['conditional-region']} data-skeleton-preset={preset}>
        <SkeletonStatus label={label ?? 'Loading AI scribe…'} className="flex items-center gap-2 flex-wrap">
          <SkeletonBar width="18px" className="h-[18px]" />
          <SkeletonBar width="88px" className="h-3.5" />
          <SkeletonBar width="120px" className="h-5" />
          <div className="flex-1" />
          <SkeletonBar width="52px" className="h-7" />
        </SkeletonStatus>
      </section>
    );
  }

  if (preset === 'attendance') {
    return (
      <section className="cf-card cf-density-default space-y-2" data-testid={SKELETON_TEST_IDS['conditional-region']} data-skeleton-preset={preset}>
        <SkeletonStatus label={label ?? 'Loading attendance…'} className="space-y-2">
          <div className="flex items-center gap-2">
            <SkeletonBar width="84px" className="h-3" />
            <div className="flex-1" />
            <SkeletonBar width="96px" className="h-7" />
          </div>
          <div className="flex flex-wrap gap-1.5">
            <SkeletonBar width="72px" className="h-6 rounded-full" />
            <SkeletonBar width="64px" className="h-6 rounded-full" />
            <SkeletonBar width="80px" className="h-6 rounded-full" />
          </div>
        </SkeletonStatus>
      </section>
    );
  }

  return (
    <div data-testid={SKELETON_TEST_IDS['conditional-region']} data-skeleton-preset={preset}>
      <SkeletonStatus label={label ?? 'Loading provider settings…'} className="space-y-3">
        <div className="flex gap-2 flex-wrap">
          <SkeletonBar width="120px" className="h-9" />
          <SkeletonBar width="min(100%, 220px)" className="h-9 flex-1" />
        </div>
        <SkeletonBar width="min(100%, 280px)" className="h-9" />
        <SkeletonBar width="min(100%, 320px)" className="h-9" />
        <div className="flex gap-2">
          <SkeletonBar width="108px" className="h-8" />
          <SkeletonBar width="120px" className="h-8" />
        </div>
      </SkeletonStatus>
    </div>
  );
}

export function ErrorNote({
  message,
  onRetry,
  onDismiss,
  pending = false,
  context,
  density = 'default',
}: {
  message: string;
  onRetry?: () => void | Promise<void>;
  /** Optional dismiss — used when the error is stale and no longer actionable (#430). */
  onDismiss?: () => void;
  /** Keeps Retry visible but disabled while the loader/mutation is in flight. */
  pending?: boolean;
  /** Light secondary context (e.g. relative time) shown after the message. */
  context?: string;
  density?: UiDensity;
}) {
  return (
    // `data-testid` distinguishes a real error banner from the app's other role="alert"
    // live regions (turn announcements and the like), so a test can assert "no error"
    // without tripping over unrelated announcements (issue #1478).
    <div role="alert" data-testid="error-note" className={`cf-inset ${densityClass(density)} text-sm text-[var(--color-neutral-400)]`}>
      <span>{message}</span>
      {context && (
        <span className="text-[var(--color-neutral-500)]">
          {' '}
          · {context}
        </span>
      )}
      {' '}
      {onRetry && (
        <button
          type="button"
          onClick={() => {
            // Support async retries without forcing callers to wrap in `void`.
            // Rejections are owned by the loader's error UI — don't surface as unhandled.
            void Promise.resolve(onRetry()).catch(() => {});
          }}
          disabled={pending}
          aria-busy={pending || undefined}
          className="font-semibold text-[var(--cf-accent)] hover:underline disabled:opacity-60 disabled:no-underline"
        >
          {pending ? 'Retrying…' : 'Retry'}
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="ml-2 font-semibold text-[var(--color-neutral-500)] hover:underline"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}
