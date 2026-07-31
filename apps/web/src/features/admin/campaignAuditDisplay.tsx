import { useTranslation } from 'react-i18next';
import type { AuditActorRole, AuditEntry, CampaignMember } from '@campfire/schema';
import { GameIcon } from '../../components/GameIcon';
import { UI_ICON_SIZE } from '../../lib/uiIcons';

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

export function AuditEntryRow({
  entry,
  members,
  highlighted,
}: {
  entry: AuditEntry;
  members: CampaignMember[];
  highlighted?: boolean;
}) {
  const { t } = useTranslation();
  const { label, isToken } = resolveActorLabel(entry.actor, members);
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
          {' '}
          on {entry.entityType}
          {entry.entityId != null ? ` #${entry.entityId}` : ''}
        </span>
      )}
      {entry.detail && <span className="text-secondary"> — {entry.detail}</span>}
    </div>
  );
}
