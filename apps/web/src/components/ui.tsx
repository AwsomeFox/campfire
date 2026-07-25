/**
 * Campfire UI primitives — mirror the design package (design/tokens.html).
 * Feature screens compose these; do not restyle them locally.
 */
import { forwardRef, useEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { GameIcon } from './GameIcon';
import { chipClass, type ChipVariant } from './chipVariants';
import { SKELETON_TEST_IDS } from './loadingSkeletonState';
export type { ChipVariant } from './chipVariants';

export function Card({ children, className = '', ...props }: HTMLAttributes<HTMLElement> & { children: ReactNode }) {
  return <section className={`cf-card p-5 ${className}`} {...props}>{children}</section>;
}

export function Inset({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`cf-inset p-3 ${className}`}>{children}</div>;
}

export function Chip({ variant, children, className = '' }: { variant: ChipVariant; children: ReactNode; className?: string }) {
  return <span className={`cf-chip ${chipClass[variant]} ${className}`}>{children}</span>;
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

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  ghost?: boolean;
  danger?: boolean;
  /** Marks an in-flight action and keeps it natively disabled until it settles. */
  busy?: boolean;
};

export const Btn = forwardRef<HTMLButtonElement, BtnProps>(
  function Btn({ ghost, danger, busy = false, disabled = false, className = '', ...rest }, ref) {
    return (
      <button
        ref={ref}
        className={`cf-btn ${ghost ? 'cf-btn-ghost' : ''} ${danger ? 'cf-btn-danger' : ''} ${className}`}
        {...rest}
        disabled={disabled || busy}
        aria-busy={busy || undefined}
      />
    );
  },
);

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className = '', dir = 'auto', ...props }, ref) {
    return <input ref={ref} dir={dir} className={`cf-input ${className}`} {...props} />;
  },
);

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function TextArea({ className = '', dir = 'auto', ...props }, ref) {
    return <textarea ref={ref} dir={dir} className={`cf-textarea ${className}`} {...props} />;
  },
);

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
export function DmPanel({ children }: { children: ReactNode }) {
  return (
    <div className="cf-dm-panel p-4 space-y-1.5">
      <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-[var(--color-accent)]">
        <GameIcon slug="padlock" size={13} reserveSpace /> DM only
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
}: {
  icon?: string;
  title: string;
  hint?: string;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="cf-inset border-dashed p-6 text-center space-y-2">
      <p className="flex justify-center text-[var(--color-neutral-500)]">
        <GameIcon slug={icon} size={30} reserveSpace />
      </p>
      <p className="text-sm font-semibold text-[var(--color-neutral-300)]">{title}</p>
      {hint && <p className="text-xs text-[var(--color-neutral-600)] max-w-md mx-auto">{hint}</p>}
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
      {...(testId ? { 'data-testid': testId } : {})}
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
    <section className="cf-card p-5" data-testid={SKELETON_TEST_IDS.card}>
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
      <section className="cf-card p-5 space-y-3" data-testid={SKELETON_TEST_IDS['conditional-region']} data-skeleton-preset={preset}>
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
      <section className="cf-card p-5 space-y-2" data-testid={SKELETON_TEST_IDS['conditional-region']} data-skeleton-preset={preset}>
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
}: {
  message: string;
  onRetry?: () => void | Promise<void>;
  /** Optional dismiss — used when the error is stale and no longer actionable (#430). */
  onDismiss?: () => void;
  /** Keeps Retry visible but disabled while the loader/mutation is in flight. */
  pending?: boolean;
  /** Light secondary context (e.g. relative time) shown after the message. */
  context?: string;
}) {
  return (
    <div role="alert" className="cf-inset p-3 text-sm text-[var(--color-neutral-400)]">
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
