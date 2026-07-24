import type { EntityType, MentionTarget, Notification, Proposal, SearchResult } from '@campfire/schema';
import { parseScheduleNotificationData } from '@campfire/schema';
import { normalizeMentionName } from './mentionMatching';
import { cancelledScheduleDetailHref } from './scheduleNotificationCopy';

/** Every campaign record that can be the destination of a cross-entity link. */
export type NavigableEntityType = EntityType | MentionTarget['type'] | SearchResult['type'] | 'inbox';

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
  inbox: { path: 'inbox', query: 'inbox' },
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

// ---------------------------------------------------------------------------
// Identity-persisted mention tokens (issue #739).
//
// A mention authored as plain text ("Vex") is fragile: rename Vex and the link
// silently retargets, and two NPCs sharing a name collapse to the first match.
// To keep a link bound to a specific record through renames and collisions, an
// author writes a typed token inside a normal markdown link:
//
//   [Vex](/.cf/npc/5)
//
// The renderer turns that into the canonical entity URL via entityHref, and
// rewrites the visible label to the entity's CURRENT name (rename-tolerant).
// Deleted / hidden / foreign targets degrade to plain text (their authored
// label) rather than a broken 404 link, so no link ever points at nothing.
//
// The token is a synthetic RELATIVE URL (`/.cf/...`) on purpose: it survives
// DOMPurify's default URI allow-list (which strips unknown `scheme:` URIs),
// never collides with a real route (those live under `/c/...`), and is owned
// end-to-end by this module — no router or server ever interprets it. Only the
// Markdown renderer (and the editor that inserts these) read or write it.
// ---------------------------------------------------------------------------

const CF_LINK = /^\/\.cf\/([a-z-]+)\/(\d+)$/;

/** A typed entity reference parsed out of a `/.cf/<type>/<id>` token. */
export type CfLink = { type: NavigableEntityType; id: number };

/**
 * Parse a `/.cf/<type>/<id>` token, returning null for anything that isn't a
 * valid typed mention (a normal URL, an empty href, a malformed key). Centralized
 * so the Markdown renderer, the editor, and tests share one strict parser.
 */
export function parseCfLink(href: string | null | undefined): CfLink | null {
  if (!href) return null;
  const m = CF_LINK.exec(href.trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isInteger(id) || id <= 0) return null;
  return { type: m[1] as NavigableEntityType, id };
}

/** Authoring side: serialize a typed mention into the `/.cf/<type>/<id>` token. */
export function cfLinkToken(type: NavigableEntityType, id: number): string {
  return `/.cf/${type}/${id}`;
}

/**
 * Resolve a parsed `cf:` link to a canonical entity URL inside `campaignId`,
 * or null when the type has no navigable surface (defensive — every value that
 * parseCfLink accepts is navigable today, but unknown future types must never
 * silently land on the dashboard). Mirrors entityHref's safe-fallback contract.
 */
export function cfLinkHref(campaignId: number, link: CfLink): string | null {
  // entityHref always returns a string (the campaign base, at minimum), so this
  // is a presence check on the underlying typed route rather than a null gate.
  const href = entityHref(campaignId, { type: link.type, id: link.id });
  // A bare campaign base (no /type segment and no selector) means this type is
  // not navigable — surface null so the renderer falls back to plain text.
  if (href === `/c/${campaignId}` && link.type !== 'campaign') return null;
  return href;
}

/**
 * Find the single non-ambiguous target whose NAME matches `needle`
 * case-insensitively. Returns null when zero OR MORE THAN ONE visible target
 * share the name — more than one is exactly the same-name collision the typed
 * token exists to disambiguate, so the auto-linker must NOT silently pick one.
 * Callers (the Markdown auto-linker) treat null as "do not auto-link this name".
 */
export function resolveUniqueByName(
  targets: ReadonlyArray<Pick<MentionTarget, 'type' | 'id' | 'name'>>,
  needle: string,
): MentionTarget | null {
  const key = normalizeMentionName(needle);
  if (!key) return null;
  let hit: MentionTarget | null = null;
  for (const t of targets) {
    if (normalizeMentionName(t.name) !== key) continue;
    if (hit) return null; // collision — caller must disambiguate explicitly
    hit = { type: t.type, id: t.id, name: t.name };
  }
  return hit;
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

  // Scheduled sessions are distinct from recap/log sessions and live inside the
  // Schedule tab. Keep both selectors in the URL so direct loads open the right
  // surface and focus the exact game-night card after its async data arrives.
  if (type === 'scheduled_session') {
    return validId(id)
      ? `${base}/sessions?tab=schedule&schedule=${id}#${entityDomId(type, id)}`
      : `${base}/sessions?tab=schedule`;
  }

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

/**
 * Notification destinations (issue #446).
 *
 * Schedule/RSVP always open the Schedule tab (never the session log). When the
 * server stamped a schedule row id (and did NOT set entityType='session' — that
 * legacy shape is a log-session playedAt ping), focus the exact game-night card.
 * Quest updates use /quests/:id. Comment replies focus the comment inside its
 * parent entity thread when commentId is present.
 */
export function notificationHref(notification: Notification): string {
  const campaignId = notification.campaignId;
  switch (notification.type) {
    case 'proposal_submitted':
    case 'proposal_resolved':
      return `/c/${campaignId}/proposals`;
    case 'inbox_submitted':
      return validId(notification.entityId)
        ? entityHref(campaignId, { type: 'inbox', id: notification.entityId })
        : `/c/${campaignId}/inbox`;
    case 'ai_dm_alert':
      return `/c/${campaignId}/table`;
    case 'session_scheduled':
    case 'session_rsvp': {
      // Issue #820: cancelled nights are deleted — route to a stable cancelled
      // detail fed by the notification's structured snapshot (not a live card).
      // The bell stashes the snapshot before navigate (see NotificationsBell).
      const scheduleData = parseScheduleNotificationData(notification.data);
      if (
        notification.type === 'session_scheduled'
        && scheduleData?.changeType === 'cancelled'
        && validId(scheduleData.scheduleId)
      ) {
        return cancelledScheduleDetailHref(campaignId, scheduleData.scheduleId);
      }
      // Log-session "upcoming playedAt" pings set entityType=session; those still
      // land on the Schedule tab (not the session log) without a bogus schedule id.
      if (validId(notification.entityId) && notification.entityType !== 'session') {
        return entityHref(campaignId, { type: 'scheduled_session', id: notification.entityId });
      }
      return `/c/${campaignId}/sessions?tab=schedule`;
    }
    case 'comment_reply': {
      if (notification.entityType && validId(notification.entityId)) {
        if (validId(notification.commentId)) {
          return entityHref(campaignId, {
            type: 'comment',
            id: notification.commentId,
            parentType: notification.entityType,
            parentId: notification.entityId,
          });
        }
        return entityHref(campaignId, { type: notification.entityType, id: notification.entityId });
      }
      return `/c/${campaignId}`;
    }
    case 'recap_posted':
    case 'quest_updated':
    case 'note_reply':
    case 'note_shared':
      return notification.entityType && validId(notification.entityId)
        ? entityHref(campaignId, { type: notification.entityType, id: notification.entityId })
        : notification.type.startsWith('note_')
          ? `/c/${campaignId}/notes`
          : notification.type === 'quest_updated'
            ? `/c/${campaignId}/quests`
            : `/c/${campaignId}/sessions`;
    case 'character_reassigned':
      return notification.entityType === 'character' && validId(notification.entityId)
        ? entityHref(campaignId, { type: 'character', id: notification.entityId })
        : `/c/${campaignId}/characters`;
    case 'added_to_campaign':
    default:
      return `/c/${campaignId}`;
  }
}
