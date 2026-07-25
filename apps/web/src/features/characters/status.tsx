/**
 * Character lifecycle status (issue #115) — shared label/UI so the sheet and the
 * party roster render a dead/retired/inactive PC identically. Non-active characters
 * stay fully viewable; they're just visually muted and skipped by encounter auto-add.
 */
import type { CharacterStatus } from '@campfire/schema';

export const CHARACTER_STATUSES: readonly CharacterStatus[] = ['active', 'draft', 'dead', 'retired', 'inactive'];

export const STATUS_LABEL: Record<CharacterStatus, string> = {
  active: 'Active',
  draft: 'Draft',
  dead: 'Dead',
  retired: 'Retired',
  inactive: 'Inactive',
};

/** A muted, non-accent tag for a non-active PC. Kept subdued so a corpse doesn't shout on the roster. */
export function StatusTag({ status, className = '' }: { status: CharacterStatus; className?: string }) {
  const skipped =
    status === 'draft'
      ? 'still being built — not auto-added to new encounters until marked Active'
      : 'kept on the roster but not auto-added to new encounters';
  return (
    <span className={`tag tag-neutral ${className}`} style={{ fontSize: 10 }} title={`This character is ${STATUS_LABEL[status].toLowerCase()} — ${skipped}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}
