import { ForbiddenException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Role } from '@campfire/schema';
import type { DrizzleDb } from '../db/db.module';
import { campaignMembers } from '../db/schema';
import type { RequestUser } from './user.types';

/**
 * The interactive-guest capability (issue #597).
 *
 * THE BUG THIS CLOSES
 * -------------------
 * Viewer was documented as read-only, but `POST /campaigns/:id/notes` and
 * `POST /campaigns/:id/comments` gated on `requireMemberOnWritableCampaign` (the renamed
 * successor to the old `requireMember(..., { write: true })` option, issue #1480), and
 * that option asserts the CAMPAIGN is writable (not archived) — it says nothing about
 * the CALLER's authority. So a viewer could comment on any thread they could see and
 * whisper any member of the table, and a whisper's body excerpt landed in the target's
 * notification bell. On a mixed-age or public table that is a direct-message channel
 * handed to an account the DM believed could only watch.
 *
 * THE FIX, AND ITS SHAPE
 * ----------------------
 * Read-only is now enforced on the CALLER, and the ability for a non-player to take
 * part is a separate, explicit, DM-granted capability rather than an accident of the
 * membership check. That second half matters: plenty of tables legitimately run a
 * commenting non-player (a co-writer, a parent watching, a returning player between
 * characters), and making Viewer read-only WITHOUT offering that capability would just
 * push those tables into promoting people to `player` — handing them authority over
 * campaign content in order to let them talk. That trade is strictly worse than the
 * bug.
 *
 * WHAT IS AND IS NOT GATED
 * ------------------------
 * Gated: everything that lands in another member's view or bell — comments, shared /
 * DM-shared notes, whispers, DM-inbox submissions.
 *
 * NOT gated: a viewer's own PRIVATE notes. They reach nobody, they are the reason the
 * Viewer seat exists (watch the table, keep your own notes), and gating them would be a
 * pure functional regression with no safety benefit — a read-only seat that cannot take
 * notes is not more read-only in any way anyone can observe. See
 * `effectivePermissionsFor` in @campfire/schema, which encodes exactly this split and is
 * the single source the invite preview and the roster render from.
 *
 * WHERE IT IS ENFORCED: in CommentsService and NotesService, never in the controllers.
 * Two reasons, both load-bearing. First, the MCP tools (`post_comment`, `add_note`,
 * `submit_inbox_item`) call those services DIRECTLY — a controller-only gate would have
 * left the agent surface exactly as open as the bug this issue closes. Second, for notes
 * the answer depends on the RESULTING visibility of a patch, which the controller cannot
 * know without re-reading the row. Living in `common/` rather than on
 * CampaignAccessService is what lets both services apply it with the db handle they
 * already hold, with no constructor change and no new module edge — the same pattern
 * #601 used for `note-visibility.ts` / `anchor-visibility.ts`.
 */

/** Is this seat allowed to send things that reach other members? */
export async function memberMayInteract(
  db: DrizzleDb,
  user: RequestUser,
  campaignId: number,
  role: Role,
): Promise<boolean> {
  // Player and DM are interactive by role; the capability flag is only consulted for
  // a viewer seat. A DEV_AUTH `dev:<name>` identity has no campaign_members row at all,
  // so its header role is the whole answer (that path is non-production only).
  if (role !== 'viewer') return true;
  const numericId = Number(user.id);
  if (!Number.isInteger(numericId) || numericId <= 0) return false;
  const [row] = await db
    .select({ interactiveGuest: campaignMembers.interactiveGuest })
    .from(campaignMembers)
    .where(and(eq(campaignMembers.campaignId, campaignId), eq(campaignMembers.userId, numericId))!)
    .limit(1);
  return row?.interactiveGuest === true;
}

/**
 * 403 unless this seat may send something that reaches another member.
 *
 * The message names the capability and who can grant it, rather than saying "forbidden":
 * a viewer who has been commenting for a month and suddenly cannot needs to know what
 * changed and who to ask, or they will read it as a shadow-ban.
 */
export async function assertMayInteract(
  db: DrizzleDb,
  user: RequestUser,
  campaignId: number,
  role: Role,
  what: string,
): Promise<void> {
  if (await memberMayInteract(db, user, campaignId, role)) return;
  throw new ForbiddenException(
    `This campaign seat is read-only, so it cannot ${what}. Ask a DM to grant you the interactive-guest capability, ` +
      'or to change your role to player.',
  );
}

/**
 * Does this note flavour reach anyone other than its author?
 *
 * `private` is the only visibility that does not, so it is the only one a read-only
 * viewer may write. Kept next to the gate it feeds so the two cannot drift.
 */
export function noteVisibilityIsOutbound(visibility: string, kind?: string): boolean {
  if (kind === 'inbox') return true; // a DM-inbox submission is outbound whatever its visibility
  return visibility !== 'private';
}
