/**
 * Small presentational pieces shared by the two "outside the Table" surfaces (#344):
 * the combat tracker's header presence chip + activity toast (RunSessionPage) and the
 * dashboard's activity card (DashboardPage). Both read off the single app-wide
 * `useAiDmLiveActivity()` snapshot (mounted once in `app/Layout.tsx`) — neither opens
 * its own stream connection.
 */
import { Link } from 'react-router-dom';
import type { ToolChip } from './toolActivity';
import { chipIconSlug, chipVariantColor } from './chipEmoji';
import { GameIcon } from '../../components/GameIcon';
import { prefersReducedMotion } from '../../lib/prefersReducedMotion';

/** "AI DM is at the table" presence pill — shown wherever the seat is in Driver mode. */
export function AiDmPresenceTag({ turnActive }: { turnActive: boolean }) {
  // Infinite opacity pulse is decorative; under reduced motion keep a steady
  // dot + the text status so "AI is acting" is never motion-only (issue #594).
  const pulse = turnActive && !prefersReducedMotion();
  return (
    <span
      className="tag tag-accent"
      style={{ fontSize: 10, display: 'inline-flex', alignItems: 'center', gap: 4 }}
      title={turnActive ? 'The AI DM is mid-turn' : 'The AI DM holds this seat (Driver mode)'}
      data-ai-dm-active={turnActive ? 'true' : 'false'}
    >
      <span
        aria-hidden="true"
        data-testid="ai-dm-presence-dot"
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: 'currentColor',
          animation: pulse ? 'cf-ai-pulse 1.1s ease-in-out infinite' : undefined,
        }}
      />
      {turnActive ? 'AI DM is acting…' : 'AI DM is at the table'}
      {pulse && <style>{`@keyframes cf-ai-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }`}</style>}
    </span>
  );
}

function timeAgoShort(at: number): string {
  const secs = Math.round((Date.now() - at) / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  return `${mins}m ago`;
}

/** One resolved tool-activity line: icon, label, optional deep-link, relative time. */
export function AiDmToolActivityRow({ chip, at }: { chip: ToolChip; at: number }) {
  const color = chipVariantColor(chip.variant);
  const content = (
    <span className="flex items-center gap-2" style={{ fontSize: 12, color: color ?? 'var(--color-neutral-300)' }}>
      <span aria-hidden="true" className="flex"><GameIcon slug={chipIconSlug(chip.icon)} size={14} /></span>
      <span className="min-w-0 truncate">The AI DM {chip.label.toLowerCase()}</span>
      <span className="shrink-0" style={{ fontSize: 10.5, color: 'var(--color-neutral-600)' }}>
        {timeAgoShort(at)}
      </span>
    </span>
  );
  if (!chip.href) return content;
  return (
    <Link to={chip.href} className="flex items-center gap-2" style={{ textDecoration: 'none' }}>
      {content}
    </Link>
  );
}
