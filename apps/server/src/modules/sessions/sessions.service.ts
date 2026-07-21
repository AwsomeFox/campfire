import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { SessionCreate, SessionUpdate, RECAP_TEMPLATE } from '@campfire/schema';
import type { Session, SessionListItem, SessionAttendee, Role, Note, EncounterWithCombatants, PageParams } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { sessions, sessionAttendees, characters, campaigns } from '../../db/schema';
import { nowIso } from '../../common/time';
import { notDeleted } from '../../common/soft-delete';
import { applyPage } from '../../common/pagination';
import { redactSecret, redactSecrets } from '../../common/redact';
import { AuditService } from '../audit/audit.service';
import { NotificationsService, excerpt } from '../notifications/notifications.service';
import { RevisionsService } from '../revisions/revisions.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';

type SessionCreateInput = z.infer<typeof SessionCreate>;
type SessionUpdateInput = z.infer<typeof SessionUpdate>;

export function toDomain(row: typeof sessions.$inferSelect): Session {
  return {
    id: row.id,
    campaignId: row.campaignId,
    number: row.number,
    title: row.title,
    playedAt: row.playedAt,
    recap: row.recap,
    dmSecret: row.dmSecret,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function attendeeToDomain(row: typeof sessionAttendees.$inferSelect): SessionAttendee {
  return {
    id: row.id,
    sessionId: row.sessionId,
    characterId: row.characterId,
    characterName: row.characterName,
    createdAt: row.createdAt,
  };
}

/**
 * The material an agent (or DM) can seed a recap from: the inbox threads
 * resolved during play and the encounters that were run. This is deliberately
 * NOT an LLM call — Campfire is MCP-first and self-hosted, so the server only
 * assembles the structured source material + a scaffold; the connected agent
 * (or the human) writes the prose.
 */
export interface RecapDraftSource {
  resolvedInbox: Pick<Note, 'body' | 'resolvedNote' | 'entityName'>[];
  encounters: Pick<EncounterWithCombatants, 'name' | 'status' | 'combatants'>[];
}

/** One line summarising an encounter for the Recap section seed. */
function encounterLine(e: RecapDraftSource['encounters'][number]): string {
  const foes = e.combatants.filter((c) => c.kind === 'monster').map((c) => c.name);
  const foeText = foes.length ? ` vs ${foes.join(', ')}` : '';
  return `- ${e.name}${foeText}`;
}

/**
 * Build a recap draft from a session's source material — the shared
 * `RECAP_TEMPLATE` scaffold, with the Recap section pre-seeded with the
 * encounters that were run, plus a "Threads resolved this session" appendix
 * built from resolved inbox items. Empty when there's no material — callers
 * should still offer the bare template. Pure and deterministic (tested).
 */
export function buildRecapDraft(source: RecapDraftSource): string {
  // Only fights that actually happened (running or ended) belong in a recap —
  // a still-"preparing" encounter is prep, not play.
  const fought = source.encounters.filter((e) => e.status === 'running' || e.status === 'ended');
  const encounterSeed = fought.length ? '\n' + fought.map(encounterLine).join('\n') : '';

  // Seed the encounters under the "Recap" heading; leave the rest for the author.
  let draft = RECAP_TEMPLATE.replace('## Recap\n', `## Recap\n${encounterSeed}\n`);

  const threads = source.resolvedInbox
    .map((n) => {
      const detail = n.resolvedNote?.trim() ? ` — ${n.resolvedNote.trim()}` : '';
      const link = n.entityName ? ` (→ ${n.entityName})` : '';
      const body = n.body.trim().replace(/\s+/g, ' ');
      return `- ${body}${detail}${link}`;
    })
    .filter(Boolean);
  if (threads.length) {
    draft +=
      '\n\n---\n\n' +
      '<!-- Source notes (from resolved player inbox items) — weave the relevant ones into the recap, then delete this block. -->\n' +
      '## Threads resolved this session\n\n' +
      threads.join('\n') +
      '\n';
  }
  return draft;
}

/**
 * #161: shape a session update patch for the audit `detail` payload. The recap
 * body can be ~100KB, so instead of stringifying it into every audit row (which
 * would reopen the #74 audit-growth problem), we substitute a compact
 * `{ recapChars }` marker — the delta reader learns the recap changed and its
 * size, then fetches the session itself for the text. Every other field is
 * recorded verbatim.
 */
function auditableSessionPatch(input: SessionUpdateInput): Record<string, unknown> {
  const { recap, ...rest } = input;
  const patch: Record<string, unknown> = { ...rest };
  if (recap !== undefined) patch.recapChars = recap.length;
  return patch;
}

@Injectable()
export class SessionsService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly revisions: RevisionsService,
  ) {}

  /**
   * List-shape sessions (issue #71): newest-first, WITHOUT the full recap body
   * (which can be 100KB each) — instead a short plain-text `recapExcerpt`, sliced
   * out in SQL so a 150-session campaign's list/summary payload stays small.
   * Optional limit/offset are pushed into the query. Used by the REST list endpoint
   * and the campaign summary; MCP's recap tool uses listRecapsForCampaign for full bodies.
   */
  async listForCampaign(campaignId: number, role: Role, page?: PageParams): Promise<SessionListItem[]> {
    let q = this.db
      .select({
        id: sessions.id,
        campaignId: sessions.campaignId,
        number: sessions.number,
        title: sessions.title,
        playedAt: sessions.playedAt,
        // substr caps what SQLite reads/returns; excerpt() then flattens+trims to ~200 chars.
        recapExcerpt: sql<string>`substr(${sessions.recap}, 1, 400)`,
        dmSecret: sessions.dmSecret,
        createdAt: sessions.createdAt,
        updatedAt: sessions.updatedAt,
      })
      .from(sessions)
      .where(and(eq(sessions.campaignId, campaignId), notDeleted(sessions.deletedAt)))
      .orderBy(desc(sessions.number))
      .$dynamic();
    q = applyPage(q, page);
    const rows = await q;
    const items: SessionListItem[] = rows.map((r) => ({
      id: r.id,
      campaignId: r.campaignId,
      number: r.number,
      title: r.title,
      playedAt: r.playedAt,
      recapExcerpt: excerpt(r.recapExcerpt ?? ''),
      dmSecret: r.dmSecret,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
    return redactSecrets(items, role);
  }

  /**
   * Full-recap sessions, newest-first, with limit/offset in SQL — for the MCP
   * `get_session_recaps` tool, whose whole point is returning recap bodies. Kept
   * separate from the lightweight list-shape used by the dashboard.
   */
  async listRecapsForCampaign(campaignId: number, role: Role, page?: PageParams): Promise<Session[]> {
    let q = this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.campaignId, campaignId), notDeleted(sessions.deletedAt)))
      .orderBy(desc(sessions.number))
      .$dynamic();
    q = applyPage(q, page);
    const rows = await q;
    return redactSecrets(rows.map(toDomain), role);
  }

  async getRowOrThrow(id: number, includeDeleted = false) {
    const [row] = await this.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    // A trashed session (soft-deleted, #116) reads as nonexistent unless includeDeleted (restore).
    if (!row || (!includeDeleted && row.deletedAt != null)) throw new NotFoundException(`Session ${id} not found`);
    return row;
  }

  async getOrThrow(id: number, role: Role): Promise<Session> {
    const row = await this.getRowOrThrow(id);
    return redactSecret(toDomain(row), role);
  }

  /**
   * campaign.sessionCount is a denormalized COUNT(*) of this campaign's sessions —
   * recomputed (never bumped/guessed) on every create/delete so it stays accurate
   * regardless of session numbering (which may have gaps or be renumbered) or deletes
   * (which previously never decremented it at all).
   */
  private async recomputeSessionCount(campaignId: number): Promise<void> {
    // Trashed sessions (soft-deleted, #116) don't count toward the campaign's session
    // tally — the count reflects live sessions only, and rises again on restore.
    const rows = await this.db.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.campaignId, campaignId), notDeleted(sessions.deletedAt)));
    await this.db.update(campaigns).set({ sessionCount: rows.length, updatedAt: nowIso() }).where(eq(campaigns.id, campaignId));
  }

  /**
   * "Upcoming" for session_scheduled notifications: playedAt on/after today.
   * playedAt is a date-ish ISO string (the web sends YYYY-MM-DD), so compare
   * date prefixes — a session scheduled for later today still counts.
   */
  private isUpcoming(playedAt: string | null | undefined): boolean {
    if (!playedAt) return false;
    return playedAt.slice(0, 10) >= nowIso().slice(0, 10);
  }

  private sessionLabel(row: { number: number; title: string }): string {
    return row.title ? `Session ${row.number}: ${row.title}` : `Session ${row.number}`;
  }

  /** Session `number` must be unique within a campaign — 409 on a duplicate. */
  private async assertNumberAvailable(campaignId: number, number: number, excludeId?: number): Promise<void> {
    const conflict = excludeId
      ? and(eq(sessions.campaignId, campaignId), eq(sessions.number, number), ne(sessions.id, excludeId))
      : and(eq(sessions.campaignId, campaignId), eq(sessions.number, number));
    const [row] = await this.db.select({ id: sessions.id }).from(sessions).where(conflict).limit(1);
    if (row) throw new ConflictException(`Session number ${number} already exists in this campaign`);
  }

  async create(campaignId: number, input: SessionCreateInput, user: RequestUser, role: Role): Promise<Session> {
    const ts = nowIso();
    const recap = input.recap ?? '';

    // Number assignment and the insert happen in one synchronous better-sqlite3
    // transaction so the campaign-unique guard is airtight:
    //  - explicit number → guard it (409 on a duplicate), same as before;
    //  - omitted number  → assign max(number)+1 *inside* the transaction, so the
    //    number is never precomputed by (and frozen into) the caller. This is what
    //    lets a proposed recap approve cleanly even if other sessions were logged
    //    in between (#125) and keeps two racing auto-numbered creates off the same
    //    number.
    // Retry-safety (#160): an auto-numbered create whose recap is byte-identical to
    // the newest session is treated as a duplicate retry — we return the existing
    // row instead of appending a second canonical session (which the pre-tool
    // max+1 numbering would have sidestepped the guard to do).
    const result = this.db.transaction((tx) => {
      if (input.number === undefined || input.number === null) {
        const [newest] = tx
          .select()
          .from(sessions)
          .where(eq(sessions.campaignId, campaignId))
          .orderBy(desc(sessions.number))
          .limit(1)
          .all();
        if (newest && recap.trim() !== '' && newest.recap === recap) {
          return { row: newest, deduped: true };
        }
        const [{ max }] = tx
          .select({ max: sql<number>`coalesce(max(${sessions.number}), 0)` })
          .from(sessions)
          .where(eq(sessions.campaignId, campaignId))
          .all();
        const number = max + 1;
        const [inserted] = tx
          .insert(sessions)
          .values({ campaignId, number, title: input.title ?? '', playedAt: input.playedAt ?? null, recap, dmSecret: input.dmSecret ?? '', createdAt: ts, updatedAt: ts })
          .returning()
          .all();
        return { row: inserted, deduped: false };
      }
      // Explicit number: enforce campaign-uniqueness inside the same transaction.
      const [conflict] = tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.campaignId, campaignId), eq(sessions.number, input.number)))
        .limit(1)
        .all();
      if (conflict) throw new ConflictException(`Session number ${input.number} already exists in this campaign`);
      const [inserted] = tx
        .insert(sessions)
        .values({ campaignId, number: input.number, title: input.title ?? '', playedAt: input.playedAt ?? null, recap, dmSecret: input.dmSecret ?? '', createdAt: ts, updatedAt: ts })
        .returning()
        .all();
      return { row: inserted, deduped: false };
    });

    const row = result.row;

    // A deduped retry is a no-op: the row (and its recap_posted notification and
    // audit entry) already exists from the first call — return it untouched.
    if (result.deduped) {
      return redactSecret(toDomain(row), role);
    }

    await this.recomputeSessionCount(campaignId);

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'session.create',
      entityType: 'session',
      entityId: row.id,
      campaignId,
    });

    if (row.recap.trim() !== '') {
      await this.notifications.notifyCampaign(campaignId, user, {
        type: 'recap_posted',
        title: `Recap posted for ${this.sessionLabel(row)}`,
        body: excerpt(row.recap),
        entityType: 'session',
        entityId: row.id,
        actorName: user.name,
      });
    }
    if (this.isUpcoming(row.playedAt)) {
      await this.notifications.notifyCampaign(campaignId, user, {
        type: 'session_scheduled',
        title: `${this.sessionLabel(row)} scheduled for ${row.playedAt!.slice(0, 10)}`,
        entityType: 'session',
        entityId: row.id,
        actorName: user.name,
      });
    }
    return redactSecret(toDomain(row), role);
  }

  async update(
    id: number,
    input: SessionUpdateInput,
    user: RequestUser,
    role: Role,
    opts?: { expectedUpdatedAt?: string },
  ): Promise<Session> {
    const existing = await this.getRowOrThrow(id);
    // Optimistic concurrency (#157): 409 if the caller's expectedUpdatedAt is stale,
    // BEFORE any write or revision snapshot, so a losing writer never clobbers.
    this.revisions.assertNotStale(existing, opts?.expectedUpdatedAt);
    if (input.number !== undefined) {
      await this.assertNumberAvailable(existing.campaignId, input.number, id);
    }
    // Snapshot the PRIOR recap into revision history when the recap actually changes,
    // so a subsequent overwrite is recoverable (#157). Bounded to committed edits.
    if (input.recap !== undefined && input.recap !== existing.recap) {
      await this.revisions.record({
        entityType: 'session',
        entityId: id,
        campaignId: existing.campaignId,
        priorProse: existing.recap,
        user,
      });
    }
    const [row] = await this.db
      .update(sessions)
      .set({ ...input, updatedAt: nowIso() })
      .where(eq(sessions.id, id))
      .returning();

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'session.update',
      entityType: 'session',
      entityId: id,
      campaignId: existing.campaignId,
      // #161: record which fields changed so the audit log is a real delta channel
      // (empty detail before). Matches the characters/encounters/members convention.
      // The recap body can be large, so log its length instead of the full text —
      // the delta reader only needs to know recap changed, then fetch the session.
      detail: JSON.stringify(auditableSessionPatch(input)),
    });

    // recap_posted fires only on the empty -> non-empty transition (posting the
    // recap), never on subsequent edits — no notification spam per typo fix.
    if (existing.recap.trim() === '' && row.recap.trim() !== '') {
      await this.notifications.notifyCampaign(existing.campaignId, user, {
        type: 'recap_posted',
        title: `Recap posted for ${this.sessionLabel(row)}`,
        body: excerpt(row.recap),
        entityType: 'session',
        entityId: id,
        actorName: user.name,
      });
    }
    // session_scheduled fires when playedAt is (re)set to an upcoming date.
    if (input.playedAt !== undefined && row.playedAt !== existing.playedAt && this.isUpcoming(row.playedAt)) {
      await this.notifications.notifyCampaign(existing.campaignId, user, {
        type: 'session_scheduled',
        title: `${this.sessionLabel(row)} scheduled for ${row.playedAt!.slice(0, 10)}`,
        entityType: 'session',
        entityId: id,
        actorName: user.name,
      });
    }
    return redactSecret(toDomain(row), role);
  }

  /**
   * Soft-delete (trash) a session (issue #116) — reversible. Only stamps `deleted_at`;
   * the session vanishes from normal reads and stops counting toward sessionCount, but
   * every row survives for restore(). Unlike the old hard delete we deliberately KEEP the
   * session's share links and attendance rows — deleting them would be irreversible; a
   * trashed session's public share simply 404s (the resolver filters deleted) until restore.
   */
  async remove(id: number, user: RequestUser, role: Role): Promise<void> {
    const existing = await this.getRowOrThrow(id);
    await this.db.update(sessions).set({ deletedAt: nowIso(), updatedAt: nowIso() }).where(eq(sessions.id, id));
    await this.recomputeSessionCount(existing.campaignId);
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'session.delete',
      entityType: 'session',
      entityId: id,
      campaignId: existing.campaignId,
      detail: 'soft-delete (trashed)',
    });
  }

  /** Restore a trashed session (issue #116) — clears `deleted_at` + re-counts. 404 if it isn't trashed. */
  async restore(id: number, user: RequestUser, role: Role): Promise<Session> {
    const existing = await this.getRowOrThrow(id, true);
    if (existing.deletedAt == null) throw new NotFoundException(`Session ${id} is not in the trash`);
    const [row] = await this.db
      .update(sessions)
      .set({ deletedAt: null, updatedAt: nowIso() })
      .where(eq(sessions.id, id))
      .returning();
    await this.recomputeSessionCount(existing.campaignId);
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'session.restore',
      entityType: 'session',
      entityId: id,
      campaignId: existing.campaignId,
    });
    return redactSecret(toDomain(row), role);
  }

  // ----- attendance (issue #121): which characters played a session -----

  /** The roster that played a session — characters, newest-added first. Any member may read. */
  async getAttendance(sessionId: number): Promise<SessionAttendee[]> {
    await this.getRowOrThrow(sessionId); // 404 for an unknown session
    const rows = await this.db
      .select()
      .from(sessionAttendees)
      .where(eq(sessionAttendees.sessionId, sessionId))
      .orderBy(asc(sessionAttendees.characterName), asc(sessionAttendees.id));
    return rows.map(attendeeToDomain);
  }

  /**
   * Replace a session's attendance with exactly `characterIds` (idempotent set
   * semantics — an empty array clears it). Every id must be a character in the
   * session's OWN campaign: a character from another campaign (or a non-existent
   * one) is rejected wholesale with a 400, so attendance can only ever name the
   * campaign's own roster. dmSecret-bearing character fields are never touched;
   * only id + name are read. dm-only at the controller/tool layer.
   */
  async setAttendance(sessionId: number, characterIds: number[], user: RequestUser, role: Role): Promise<SessionAttendee[]> {
    const session = await this.getRowOrThrow(sessionId);
    // De-dupe so a caller repeating an id doesn't trip the "unknown id" count check.
    const wanted = [...new Set(characterIds)];

    let valid: { id: number; name: string }[] = [];
    if (wanted.length > 0) {
      const found = await this.db
        .select({ id: characters.id, name: characters.name })
        .from(characters)
        .where(and(eq(characters.campaignId, session.campaignId), inArray(characters.id, wanted), notDeleted(characters.deletedAt)));
      if (found.length !== wanted.length) {
        const foundIds = new Set(found.map((c) => c.id));
        const bad = wanted.filter((id) => !foundIds.has(id));
        throw new BadRequestException(`Not characters in campaign ${session.campaignId}: ${bad.join(', ')}`);
      }
      valid = found;
    }

    const ts = nowIso();
    this.db.transaction((tx) => {
      tx.delete(sessionAttendees).where(eq(sessionAttendees.sessionId, sessionId)).run();
      if (valid.length > 0) {
        tx.insert(sessionAttendees)
          .values(valid.map((c) => ({ sessionId, characterId: c.id, characterName: c.name, createdAt: ts })))
          .run();
      }
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'session.set_attendance',
      entityType: 'session',
      entityId: sessionId,
      campaignId: session.campaignId,
      detail: JSON.stringify({ characterIds: valid.map((c) => c.id) }),
    });
    return this.getAttendance(sessionId);
  }
}
