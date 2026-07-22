/**
 * Campfire UI primitives — mirror the design package (design/tokens.html).
 * Feature screens compose these; do not restyle them locally.
 */
import { forwardRef, useEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { GameIcon } from './GameIcon';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`cf-card p-5 ${className}`}>{children}</section>;
}

export function Inset({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`cf-inset p-3 ${className}`}>{children}</div>;
}

export type ChipVariant =
  | 'active' | 'available' | 'completed' | 'failed'
  | 'private' | 'dm' | 'party' | 'proposal' | 'whisper' | 'ai';

const chipClass: Record<ChipVariant, string> = {
  active: 'cf-chip-active',
  available: 'cf-chip-available',
  completed: 'cf-chip-completed',
  failed: 'cf-chip-failed',
  private: 'cf-chip-private',
  dm: 'cf-chip-dm',
  party: 'cf-chip-party',
  proposal: 'cf-chip-proposal',
  whisper: 'cf-chip-whisper',
  // AI-drafted proposal attribution (issue #341): distinct teal so an AI-authored
  // proposal reads as its own thing next to the proposer/delete/status chips.
  ai: 'cf-chip-ai',
};

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

export const Btn = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { ghost?: boolean; danger?: boolean }>(
  function Btn({ ghost, danger, className = '', ...rest }, ref) {
    return (
      <button
        ref={ref}
        className={`cf-btn ${ghost ? 'cf-btn-ghost' : ''} ${danger ? '!text-rose-400 !border-rose-400/40' : ''} ${className}`}
        {...rest}
      />
    );
  },
);

export function TextInput({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`cf-input ${className}`} {...props} />;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function TextArea({ className = '', ...props }, ref) {
    return <textarea ref={ref} className={`cf-textarea ${className}`} {...props} />;
  },
);

export function HpBar({ current, max }: { current: number; max: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (current / max) * 100)) : 0;
  const tone = pct < 25 ? 'crit' : pct < 50 ? 'low' : '';
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

export function EmptyState({ icon = 'candle-flame', title, hint }: { icon?: string; title: string; hint?: string }) {
  return (
    <div className="cf-inset border-dashed p-6 text-center space-y-1">
      <p className="flex justify-center text-[var(--color-neutral-500)]">
        <GameIcon slug={icon} size={30} reserveSpace />
      </p>
      <p className="text-sm font-semibold text-[var(--color-neutral-300)]">{title}</p>
      {hint && <p className="text-xs text-[var(--color-neutral-600)]">{hint}</p>}
    </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className="h-3 rounded animate-pulse bg-[var(--color-neutral-800)]"
          style={{ width: `${85 - i * 15}%` }}
        />
      ))}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="cf-inset p-3 text-sm text-[var(--color-neutral-400)]">
      {message}{' '}
      {onRetry && (
        <button onClick={onRetry} className="font-semibold text-[var(--cf-accent)] hover:underline">
          Retry
        </button>
      )}
    </div>
  );
}
