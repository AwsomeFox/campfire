/**
 * Campfire UI primitives — mirror the design package (design/tokens.html).
 * Feature screens compose these; do not restyle them locally.
 */
import { forwardRef, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`cf-card p-5 ${className}`}>{children}</section>;
}

export function Inset({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`cf-inset p-3 ${className}`}>{children}</div>;
}

export type ChipVariant =
  | 'active' | 'available' | 'completed' | 'failed'
  | 'private' | 'dm' | 'party' | 'proposal';

const chipClass: Record<ChipVariant, string> = {
  active: 'cf-chip-active',
  available: 'cf-chip-available',
  completed: 'cf-chip-completed',
  failed: 'cf-chip-failed',
  private: 'cf-chip-private',
  dm: 'cf-chip-dm',
  party: 'cf-chip-party',
  proposal: 'cf-chip-proposal',
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

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="cf-input" {...props} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className="cf-textarea" {...props} />;
}

export function HpBar({ current, max }: { current: number; max: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (current / max) * 100)) : 0;
  const tone = pct < 25 ? 'crit' : pct < 50 ? 'low' : '';
  return (
    <div className={`cf-hp ${tone}`}>
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Accent-tinted DM-only panel. Render ONLY when the effective role is dm and content is non-empty. */
export function DmPanel({ children }: { children: ReactNode }) {
  return (
    <div className="cf-dm-panel p-4 space-y-1.5">
      <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-accent)]">🔒 DM only</p>
      <div className="text-sm text-[var(--color-neutral-300)]">{children}</div>
    </div>
  );
}

export function EmptyState({ icon = '🕯️', title, hint }: { icon?: string; title: string; hint?: string }) {
  return (
    <div className="cf-inset border-dashed p-6 text-center space-y-1">
      <p className="text-2xl">{icon}</p>
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
    <div className="cf-inset p-3 text-sm text-[var(--color-neutral-400)]">
      {message}{' '}
      {onRetry && (
        <button onClick={onRetry} className="font-semibold text-[var(--cf-accent)] hover:underline">
          Retry
        </button>
      )}
    </div>
  );
}
