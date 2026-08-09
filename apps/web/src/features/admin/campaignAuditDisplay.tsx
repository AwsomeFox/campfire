import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { AuditActorRole, AuditEntry, CampaignMember } from '@campfire/schema';
import { GameIcon } from '../../components/GameIcon';
import { UI_ICON_SIZE } from '../../lib/uiIcons';
import { entityHref } from '../../lib/entityLinks';

export const ACTOR_ICON: Record<AuditActorRole, string> = {
  dm: 'top-hat',
  player: 'person',
  viewer: 'person',
  admin: 'crown',
};

import { timeAgo } from '../../lib/format';
export { timeAgo };

/** Resolve an AuditEntry.actor to a human-readable label. */
export function resolveActorLabel(actor: string, members: CampaignMember[]): { label: string; isToken: boolean } {
  if (actor.startsWith('token:')) {
    return { label: actor.slice('token:'.length), isToken: true };
  }
  const member = members.find((m) => String(m.userId) === actor);
  if (member) {
    return { label: member.displayName || member.username || `#${actor}`, isToken: false };
  }
  return { label: `#${actor}`, isToken: false };
}

export function auditEntryToCsvRow(entry: AuditEntry, members: CampaignMember[]): string {
  const { label } = resolveActorLabel(entry.actor, members);
  const cols = [
    entry.id,
    entry.createdAt,
    label,
    entry.actorRole,
    entry.action,
    entry.entityType ?? '',
    entry.entityId ?? '',
    entry.detail,
    entry.requestId ?? '',
  ];
  return cols.map(csvEscape).join(',');
}

function csvEscape(value: string | number): string {
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export const AUDIT_CSV_HEADER =
  'id,createdAt,actor,actorRole,action,entityType,entityId,detail,requestId';

/**
 * Link timeline audit rows from the event's current state rather than the
 * historical action. A later soft-delete makes create/update/restore rows
 * point at the Trash, where the target can actually be recovered.
 *
 * `null` means the current Trash state is not available, so callers must be
 * conservative and render plain text instead of a potentially dead link.
 */
export function timelineAuditTarget(
  entry: AuditEntry,
  trashedTimelineEventIds: ReadonlySet<number> | null,
): { label: string; href: string } | null {
  if (entry.campaignId == null || entry.payload?.kind !== 'timeline_event' || trashedTimelineEventIds == null) return null;

  const { entity } = entry.payload;
  return {
    label: entity.label,
    href: trashedTimelineEventIds.has(entity.id)
      ? `/c/${entry.campaignId}/trash`
      : entityHref(entry.campaignId, { type: entity.navigation.route, id: entity.id }),
  };
}

export function AuditEntryRow({
  entry,
  members,
  highlighted,
  trashedTimelineEventIds,
}: {
  entry: AuditEntry;
  members: CampaignMember[];
  highlighted?: boolean;
  trashedTimelineEventIds?: ReadonlySet<number> | null;
}) {
  const { t } = useTranslation();
  const { label, isToken } = resolveActorLabel(entry.actor, members);
  const timelineTarget = timelineAuditTarget(entry, trashedTimelineEventIds ?? null);
  return (
    <div
      id={`audit-${entry.id}`}
      role="listitem"
      className={`text-xs text-slate-400 rounded px-1 -mx-1 ${highlighted ? 'bg-amber-500/10 ring-1 ring-amber-500/40' : ''}`}
    >
      <span className="text-secondary">{timeAgo(entry.createdAt)}</span>{' '}
      <GameIcon slug={ACTOR_ICON[entry.actorRole]} size={UI_ICON_SIZE.xs} className="inline align-text-bottom" />{' '}
      <b className="text-slate-300">{label}</b>{' '}
      {isToken && (
        <span className="tag tag-neutral" style={{ fontSize: 9 }}>
          {t('admin.audit.tokenTag', { defaultValue: 'token' })}
        </span>
      )}{' '}
      <code className="text-[10px] text-amber-400">{entry.action}</code>
      {entry.entityType && (
        <span className="text-secondary">
          {' '}on{' '}
          {timelineTarget ? (
            <Link to={timelineTarget.href} className="text-amber-300 hover:text-amber-200 underline-offset-2 hover:underline">
              {timelineTarget.label}
            </Link>
          ) : (
            <>
              {entry.entityType}
              {entry.entityId != null ? ` #${entry.entityId}` : ''}
            </>
          )}
        </span>
      )}
      {entry.detail && <span className="text-secondary"> — {entry.detail}</span>}
    </div>
  );
}
