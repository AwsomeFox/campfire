import type { EntityType, MentionTarget, Notification, Proposal, SearchResult } from '@campfire/schema';

/** Every campaign record that can be the destination of a cross-entity link. */
export type NavigableEntityType = EntityType | MentionTarget['type'] | SearchResult['type'];

export type EntityLinkTarget = {
  type: NavigableEntityType;
  id?: number | null;
  /** Comments live inside another entity's discussion thread. */
  parentType?: EntityType | null;
  parentId?: number | null;
};

const DIRECT_ROUTES: Partial<Record<NavigableEntityType, string>> = {
  quest: 'quests',
  npc: 'npcs',
  faction: 'factions',
  location: 'locations',
  character: 'characters',
  encounter: 'encounters',
};

const LIST_ROUTES: Partial<Record<NavigableEntityType, { path: string; query: string }>> = {
  session: { path: 'sessions', query: 'session' },
  timeline: { path: 'timeline', query: 'event' },
  item: { path: 'inventory', query: 'item' },
  note: { path: 'notes', query: 'note' },
  arc: { path: 'storylines', query: 'arc' },
  beat: { path: 'storylines', query: 'beat' },
};

const PROPOSAL_TARGET_TYPES = new Set<string>([
  'quest', 'npc', 'faction', 'location', 'character', 'session', 'encounter', 'campaign',
]);

function validId(id: number | null | undefined): id is number {
  return typeof id === 'number' && Number.isInteger(id) && id > 0;
}

/** Stable DOM id shared by link generation and the focus manager. */
export function entityDomId(type: NavigableEntityType, id: number): string {
  return `entity-${type}-${id}`;
}

/** Props applied to the element representing a navigable campaign record. */
export function entityTargetProps(type: NavigableEntityType, id: number) {
  return {
    id: entityDomId(type, id),
    'data-entity-type': type,
    'data-entity-id': String(id),
    tabIndex: -1,
  } as const;
}

function focused(path: string, type: NavigableEntityType, id: number, query?: [string, number]): string {
  const search = query ? `?${query[0]}=${query[1]}` : '';
  return `${path}${search}#${entityDomId(type, id)}`;
}

/**
 * Canonical campaign entity URL contract.
 *
 * Records with real detail routes use /:id. Records rendered inside list pages
 * use a typed query selector, and every record carries a hash consumed by the
 * app-level focus manager after asynchronous content appears.
 */
export function entityHref(campaignId: number, target: EntityLinkTarget): string {
  const base = `/c/${campaignId}`;
  const { type, id } = target;

  if (type === 'campaign') return base;

  if (type === 'comment') {
    if (!validId(id) || !target.parentType || !validId(target.parentId)) return base;
    const parent = entityHref(campaignId, { type: target.parentType, id: target.parentId });
    const withoutHash = parent.split('#', 1)[0];
    const separator = withoutHash.includes('?') ? '&' : '?';
    return `${withoutHash}${separator}comment=${id}#${entityDomId('comment', id)}`;
  }

  const direct = DIRECT_ROUTES[type];
  if (direct) {
    return validId(id) ? focused(`${base}/${direct}/${id}`, type, id) : `${base}/${direct}`;
  }

  const list = LIST_ROUTES[type];
  if (list) {
    return validId(id)
      ? focused(`${base}/${list.path}`, type, id, [list.query, id])
      : `${base}/${list.path}`;
  }

  return base;
}

/** Search results sometimes carry a parent entity for comments. */
export function searchResultHref(campaignId: number, result: SearchResult): string {
  return entityHref(campaignId, {
    type: result.type,
    id: result.id,
    parentType: result.entityType,
    parentId: result.entityId,
  });
}

/** Mention targets use the same contract as every other cross-entity surface. */
export function mentionTargetHref(campaignId: number, target: MentionTarget): string {
  return entityHref(campaignId, { type: target.type, id: target.id });
}

/** Notes link to the entity they annotate; an unanchored note links to itself. */
export function noteTargetHref(
  campaignId: number,
  note: { id: number; entityType?: EntityType | null; entityId?: number | null },
): string {
  if (note.entityType) return entityHref(campaignId, { type: note.entityType, id: note.entityId });
  return entityHref(campaignId, { type: 'note', id: note.id });
}

/** Existing proposals can open their target; create proposals stay in the queue. */
export function proposalTargetHref(campaignId: number, proposal: Pick<Proposal, 'entityType' | 'entityId'>): string | null {
  // Older generated-map proposals can carry a runtime `map` entity type that
  // predates the shared schema and has no detail surface. Preserve “no link”
  // for unknown future types instead of silently landing on the dashboard.
  return validId(proposal.entityId) && PROPOSAL_TARGET_TYPES.has(proposal.entityType)
    ? entityHref(campaignId, { type: proposal.entityType, id: proposal.entityId })
    : null;
}

/** Notification destinations use entity metadata when the event supplies it. */
export function notificationHref(notification: Notification): string {
  const campaignId = notification.campaignId;
  switch (notification.type) {
    case 'proposal_submitted':
    case 'proposal_resolved':
      return `/c/${campaignId}/proposals`;
    case 'ai_dm_alert':
      return `/c/${campaignId}/table`;
    case 'session_scheduled':
    case 'session_rsvp':
      return notification.entityType === 'session' && validId(notification.entityId)
        ? entityHref(campaignId, { type: 'session', id: notification.entityId })
        : `/c/${campaignId}/sessions?tab=schedule`;
    case 'recap_posted':
    case 'quest_updated':
    case 'note_reply':
    case 'note_shared':
    case 'comment_reply':
      return notification.entityType && validId(notification.entityId)
        ? entityHref(campaignId, { type: notification.entityType, id: notification.entityId })
        : notification.type.startsWith('note_')
          ? `/c/${campaignId}/notes`
          : notification.type === 'quest_updated'
            ? `/c/${campaignId}/quests`
            : `/c/${campaignId}/sessions`;
    case 'added_to_campaign':
    default:
      return `/c/${campaignId}`;
  }
}
