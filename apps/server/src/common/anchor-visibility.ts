import { NotFoundException } from '@nestjs/common';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { EntityType, Role } from '@campfire/schema';
import type { DrizzleDb } from '../db/db.module';
import { campaigns, characters, encounters, factions, locations, npcs, quests, sessions } from '../db/schema';
import { notDeleted } from './soft-delete';
import { isVisibleTo } from './redact';

/**
 * Anchored-entity secrecy gate (issue #230). Before listing/posting on
 * (entityType, entityId) — and before editing/deleting/REPORTING a comment anchored
 * to one — the caller must be able to SEE that entity. We resolve it within THIS
 * campaign and apply the SAME rule the entity's own GET uses (issue #42): a hidden
 * quest/npc/faction/encounter or an unexplored location is 404 for a non-DM, indistinguishable
 * from a nonexistent one — so a thread can never leak that a secret entity exists (or
 * expose its comments). Types with no entity-level secrecy (session, character,
 * campaign) are visible to any member; a nonexistent, trashed, or
 * foreign-campaign anchor 404s for everyone (a comment can only hang off a live entity
 * in its own campaign). The 404 message is uniform so a hidden entity is byte-for-byte
 * a missing one.
 *
 * Lifted verbatim out of CommentsService into `common/` for issue #601: the moderation
 * module must apply the identical rule when authorizing "may this reporter report this
 * comment" — reporting must never become a probe for hidden entities — and calling
 * back into CommentsService would create a circular dependency (CommentsService now
 * depends on ModerationService for pre-mutation evidence capture). CommentsService
 * keeps a thin private delegate so its existing call sites and comments are unchanged.
 */
export async function assertAnchorVisible(
  db: DrizzleDb,
  campaignId: number,
  entityType: EntityType,
  entityId: number,
  role: Role,
): Promise<void> {
  const notFound = () => new NotFoundException(`${entityType} ${entityId} not found`);
  switch (entityType) {
    case 'quest': {
      const [row] = await db
        .select({ hidden: quests.hidden })
        .from(quests)
        .where(and(eq(quests.id, entityId), eq(quests.campaignId, campaignId), notDeleted(quests.deletedAt)))
        .limit(1);
      if (!row || !isVisibleTo(row, role)) throw notFound();
      return;
    }
    case 'npc': {
      const [row] = await db
        .select({ hidden: npcs.hidden })
        .from(npcs)
        .where(and(eq(npcs.id, entityId), eq(npcs.campaignId, campaignId), notDeleted(npcs.deletedAt)))
        .limit(1);
      if (!row || !isVisibleTo(row, role)) throw notFound();
      return;
    }
    case 'faction': {
      const [row] = await db
        .select({ hidden: factions.hidden })
        .from(factions)
        .where(and(eq(factions.id, entityId), eq(factions.campaignId, campaignId), notDeleted(factions.deletedAt)))
        .limit(1);
      if (!row || !isVisibleTo(row, role)) throw notFound();
      return;
    }
    case 'location': {
      const [row] = await db
        .select({ status: locations.status })
        .from(locations)
        .where(and(eq(locations.id, entityId), eq(locations.campaignId, campaignId), notDeleted(locations.deletedAt)))
        .limit(1);
      // Unexplored → hidden from non-DM (mirrors LocationsService.isHiddenFrom, issue #42).
      if (!row || (role !== 'dm' && row.status === 'unexplored')) throw notFound();
      return;
    }
    case 'session': {
      const [row] = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.id, entityId), eq(sessions.campaignId, campaignId), notDeleted(sessions.deletedAt)))
        .limit(1);
      if (!row) throw notFound();
      return;
    }
    case 'character': {
      const [row] = await db
        .select({ id: characters.id })
        .from(characters)
        .where(and(eq(characters.id, entityId), eq(characters.campaignId, campaignId), notDeleted(characters.deletedAt)))
        .limit(1);
      if (!row) throw notFound();
      return;
    }
    case 'encounter': {
      const [row] = await db
        .select({ hidden: encounters.hidden })
        .from(encounters)
        .where(and(eq(encounters.id, entityId), eq(encounters.campaignId, campaignId), notDeleted(encounters.deletedAt)))
        .limit(1);
      if (!row || !isVisibleTo(row, role)) throw notFound();
      return;
    }
    case 'campaign': {
      // A comment can only anchor to its OWN campaign; a foreign campaign id 404s.
      if (entityId !== campaignId) throw notFound();
      const [row] = await db
        .select({ id: campaigns.id })
        .from(campaigns)
        .where(and(eq(campaigns.id, campaignId), notDeleted(campaigns.deletedAt)))
        .limit(1);
      if (!row) throw notFound();
      return;
    }
  }
}

/**
 * SQL form of {@link assertAnchorVisible}. Search uses this for comments because
 * its FTS candidate query must reject an inaccessible anchor before it can return
 * a matching comment snippet. Keeping the predicates here with the direct-read
 * gate prevents comment search and direct comment reads from drifting apart.
 */
export function anchorVisibilitySql(
  entityType: SQL,
  entityId: SQL,
  campaignId: SQL,
  role: Role,
): SQL {
  const questVisible = role === 'dm' ? sql`` : sql`AND cq.hidden = 0`;
  const npcVisible = role === 'dm' ? sql`` : sql`AND cn.hidden = 0`;
  const factionVisible = role === 'dm' ? sql`` : sql`AND cf.hidden = 0`;
  const locationVisible = role === 'dm' ? sql`` : sql`AND cl.status <> 'unexplored'`;
  const encounterVisible = role === 'dm' ? sql`` : sql`AND ce.hidden = 0`;

  return sql`(
    (${entityType} = 'quest' AND EXISTS (
      SELECT 1 FROM quests cq
      WHERE cq.id = ${entityId} AND cq.campaign_id = ${campaignId} AND cq.deleted_at IS NULL ${questVisible}
    ))
    OR (${entityType} = 'npc' AND EXISTS (
      SELECT 1 FROM npcs cn
      WHERE cn.id = ${entityId} AND cn.campaign_id = ${campaignId} AND cn.deleted_at IS NULL ${npcVisible}
    ))
    OR (${entityType} = 'faction' AND EXISTS (
      SELECT 1 FROM factions cf
      WHERE cf.id = ${entityId} AND cf.campaign_id = ${campaignId} AND cf.deleted_at IS NULL ${factionVisible}
    ))
    OR (${entityType} = 'location' AND EXISTS (
      SELECT 1 FROM locations cl
      WHERE cl.id = ${entityId} AND cl.campaign_id = ${campaignId} AND cl.deleted_at IS NULL ${locationVisible}
    ))
    OR (${entityType} = 'session' AND EXISTS (
      SELECT 1 FROM sessions cs WHERE cs.id = ${entityId} AND cs.campaign_id = ${campaignId} AND cs.deleted_at IS NULL
    ))
    OR (${entityType} = 'character' AND EXISTS (
      SELECT 1 FROM characters cch WHERE cch.id = ${entityId} AND cch.campaign_id = ${campaignId} AND cch.deleted_at IS NULL
    ))
    OR (${entityType} = 'encounter' AND EXISTS (
      SELECT 1 FROM encounters ce
      WHERE ce.id = ${entityId} AND ce.campaign_id = ${campaignId} AND ce.deleted_at IS NULL ${encounterVisible}
    ))
    OR (${entityType} = 'campaign' AND ${entityId} = ${campaignId} AND EXISTS (
      SELECT 1 FROM campaigns cc WHERE cc.id = ${campaignId} AND cc.deleted_at IS NULL
    ))
  )`;
}
