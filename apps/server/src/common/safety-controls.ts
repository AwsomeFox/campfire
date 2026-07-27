import { and, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import type { DrizzleDb } from '../db/db.module';
import { memberSafetyControls } from '../db/schema';

/**
 * Personal safety controls (issue #597), read side.
 *
 * Lives in `common/` for the same reason `note-visibility.ts` and
 * `anchor-visibility.ts` do: the rule has to be applied from modules that must not
 * depend on each other. NotificationsService is a LEAF module — every domain module
 * that emits a bell item imports it — so it cannot import a SafetyModule without
 * inverting half the dependency graph. Exposing the predicate as a pure function over
 * a drizzle handle lets NotificationsService, NotesService and SafetyService all apply
 * the identical rule with no new module edge and no service-constructor change.
 *
 * THE NON-DISCLOSURE INVARIANT
 * ----------------------------
 * Nothing in this file is ever consulted on the SENDER's request path. A block changes
 * what the OWNER receives and sees, never what the target's own write returns. That is
 * deliberate and is the whole reason blocking is safe to use: see the header comment on
 * SafetyService for the full argument, and `blockedOwnersOf` for the one place a
 * sender-side identity is read (the multi-account evasion check), which is applied to a
 * newly-created identity rather than to a request outcome.
 */

/** A live control row, in the shape enforcement needs. */
export interface ActiveSafetyControl {
  id: number;
  kind: string;
  campaignId: number | null;
  ownerUserId: string;
  targetUserId: string | null;
  threadEntityType: string | null;
  threadEntityId: number | null;
}

/** Live (not lifted) controls in scope for `campaignId`: account-wide ones plus that campaign's. */
function inScope(campaignId: number | null): SQL {
  const live = isNull(memberSafetyControls.liftedAt);
  if (campaignId == null) return live;
  return and(live, or(isNull(memberSafetyControls.campaignId), eq(memberSafetyControls.campaignId, campaignId))!)!;
}

/**
 * Every live control owned by `ownerUserId` that is in scope for this campaign.
 * Small by construction (a person's own block/mute list), so callers can filter in
 * memory rather than round-tripping per candidate.
 */
export async function safetyControlsOwnedBy(
  db: DrizzleDb,
  ownerUserId: string,
  campaignId: number | null,
): Promise<ActiveSafetyControl[]> {
  return db
    .select({
      id: memberSafetyControls.id,
      kind: memberSafetyControls.kind,
      campaignId: memberSafetyControls.campaignId,
      ownerUserId: memberSafetyControls.ownerUserId,
      targetUserId: memberSafetyControls.targetUserId,
      threadEntityType: memberSafetyControls.threadEntityType,
      threadEntityId: memberSafetyControls.threadEntityId,
    })
    .from(memberSafetyControls)
    .where(and(eq(memberSafetyControls.ownerUserId, ownerUserId), inScope(campaignId))!);
}

/**
 * The identities `ownerUserId` currently BLOCKS (not merely mutes). Used by every
 * owner-side read filter: notification list, note/whisper reads.
 */
export async function blockedTargetsOf(
  db: DrizzleDb,
  ownerUserId: string,
  campaignId: number | null,
): Promise<Set<string>> {
  const rows = await safetyControlsOwnedBy(db, ownerUserId, campaignId);
  return new Set(rows.filter((r) => r.kind === 'block' && r.targetUserId).map((r) => r.targetUserId!));
}

/**
 * The identities that currently BLOCK `targetUserId`. The reverse direction, and the
 * only sender-keyed read in this file.
 *
 * Used by the multi-account evasion check (SafetyService.propagateBlocksToLinkedIdentity):
 * when a NEW identity is seated that the server can tie to an already-blocked one, the
 * existing blocks are extended to it. This runs at seat time, off the harasser's own
 * request path, so it cannot be used as a timing or response oracle for "am I blocked".
 */
export async function blockedOwnersOf(db: DrizzleDb, targetUserId: string): Promise<string[]> {
  const rows = await db
    .select({ ownerUserId: memberSafetyControls.ownerUserId })
    .from(memberSafetyControls)
    .where(
      and(
        eq(memberSafetyControls.targetUserId, targetUserId),
        eq(memberSafetyControls.kind, 'block'),
        isNull(memberSafetyControls.liftedAt),
      )!,
    );
  return [...new Set(rows.map((r) => r.ownerUserId))];
}

/** Does `ownerUserId` block `targetUserId` right now, in scope for this campaign? */
export async function isBlockedBy(
  db: DrizzleDb,
  ownerUserId: string,
  targetUserId: string,
  campaignId: number | null,
): Promise<boolean> {
  const [row] = await db
    .select({ id: memberSafetyControls.id })
    .from(memberSafetyControls)
    .where(
      and(
        eq(memberSafetyControls.ownerUserId, ownerUserId),
        eq(memberSafetyControls.targetUserId, targetUserId),
        eq(memberSafetyControls.kind, 'block'),
        inScope(campaignId),
      )!,
    )
    .limit(1);
  return row != null;
}

/** What a notification fan-out needs to know about the event being delivered. */
export interface SafetyDeliveryContext {
  campaignId: number;
  /** The acting identity (note-identity id), or null for a system-generated event. */
  actorUserId: string | null;
  entityType: string | null;
  entityId: number | null;
}

/**
 * Recipients (as note-identity ids) who must NOT receive this event because they
 * block the actor, mute the actor, or mute the thread it belongs to.
 *
 * One query for the whole fan-out, not one per recipient: `notifyCampaign` can address
 * a whole table, and a per-recipient probe would turn one bell item into N round trips.
 */
export async function suppressedRecipients(
  db: DrizzleDb,
  recipientUserIds: string[],
  ctx: SafetyDeliveryContext,
): Promise<Set<string>> {
  const suppressed = new Set<string>();
  if (recipientUserIds.length === 0) return suppressed;
  const wantsActorMatch = ctx.actorUserId != null && ctx.actorUserId !== '';
  const wantsThreadMatch = ctx.entityType != null && ctx.entityId != null;
  if (!wantsActorMatch && !wantsThreadMatch) return suppressed;

  const rows = await db
    .select({
      kind: memberSafetyControls.kind,
      ownerUserId: memberSafetyControls.ownerUserId,
      targetUserId: memberSafetyControls.targetUserId,
      threadEntityType: memberSafetyControls.threadEntityType,
      threadEntityId: memberSafetyControls.threadEntityId,
    })
    .from(memberSafetyControls)
    .where(
      and(inScope(ctx.campaignId), inArray(memberSafetyControls.ownerUserId, recipientUserIds))!,
    );

  for (const row of rows) {
    if ((row.kind === 'block' || row.kind === 'mute_sender') && wantsActorMatch) {
      if (row.targetUserId === ctx.actorUserId) suppressed.add(row.ownerUserId);
      continue;
    }
    if (row.kind === 'mute_thread' && wantsThreadMatch) {
      if (row.threadEntityType === ctx.entityType && row.threadEntityId === ctx.entityId) {
        suppressed.add(row.ownerUserId);
      }
    }
  }
  return suppressed;
}
