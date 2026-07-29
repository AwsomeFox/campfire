import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, ne, sql, count } from 'drizzle-orm';
import type { z } from 'zod';
import { SessionCreate, SessionUpdate, RECAP_TEMPLATE } from '@campfire/schema';
import type { Session, SessionListItem, SessionListPage, SessionAttendee, Role, Note, EncounterWithCombatants, EncounterEvent, PageParams, DiceRoll } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { sessions, sessionAttendees, characters, campaigns } from '../../db/schema';
import { nowIso } from '../../common/time';
import { notDeleted } from '../../common/soft-delete';
import { applyPage } from '../../common/pagination';
import { clampSessionsListLimit, sessionsListOffset } from './sessions-pagination';
import { redactSecret, redactSecrets } from '../../common/redact';
import { foldForSearch, foldedIncludes } from '../../common/text-search';
import { AuditService } from '../audit/audit.service';
import { NotificationsService, excerpt } from '../notifications/notifications.service';
import { RevisionsService } from '../revisions/revisions.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import { SchedulingService } from './scheduling.service';

type SessionCreateInput = z.infer<typeof SessionCreate>;
type SessionUpdateInput = z.infer<typeof SessionUpdate>;

export type SessionSearchEntry = {
  id: number;
  campaignId: number;
  number: number;
  title: string;
  recap: string;
  dmSecret: string;
};

export function toDomain(row: typeof sessions.$inferSelect): Session {
  return {
    id: row.id,
    campaignId: row.campaignId,
    number: row.number,
    title: row.title,
    playedAt: row.playedAt,
    recap: row.recap,
    dmSecret: row.dmSecret,
    scheduledSessionId: row.scheduledSessionId,
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
  resolvedInbox: (Pick<Note, 'body' | 'resolvedNote' | 'entityName'> &
    Partial<Pick<Note, 'id' | 'authorUserId' | 'visibility'>>)[];
  // `events` (issue #1068) is the persisted per-encounter combat log — the round-by-round
  // damage/heal/condition/death/turn trail — so a recap can narrate WHAT HAPPENED in the
  // fight, not just who was in it. Optional so pure buildRecapDraft callers/tests that only
  // seed the roster line stay valid; assembled sources (scribe + draft_session_recap) carry it.
  encounters: (Pick<EncounterWithCombatants, 'name' | 'status' | 'combatants'> &
    Partial<Pick<EncounterWithCombatants, 'id'>> & { events?: EncounterEvent[] })[];
  // Issue #673: paper-table / physical rolls logged during play — honest totals without
  // fabricated dice — so recap drafts can mention notable off-screen checks.
  // `rollerUserId` is carried ONLY between assembly and the #501 consent gate, which uses it
  // as the join key for redacting `rollerName` (the member's own display name) on rolls whose
  // roller has not consented to external use. Both gate exits strip it again, so it never
  // reaches a prompt, a source hash, or an MCP client.
  diceRolls?: (Pick<DiceRoll, 'label' | 'actor' | 'rollerName' | 'total' | 'dc' | 'success' | 'natural20' | 'source' | 'createdAt'> &
    Partial<Pick<DiceRoll, 'id' | 'rollerUserId'>>)[];
}

/** One line summarising an encounter for the Recap section seed. */
function encounterLine(e: RecapDraftSource['encounters'][number]): string {
  const foes = e.combatants.filter((c) => c.kind === 'monster').map((c) => c.name);
  const foeText = foes.length ? ` vs ${foes.join(', ')}` : '';
  return `- ${e.name}${foeText}`;
}

function diceRollLine(r: NonNullable<RecapDraftSource['diceRolls']>[number]): string {
  const who = r.actor?.trim() || r.rollerName?.trim() || 'Unknown';
  const label = r.label?.trim() ? `${r.label.trim()} ` : '';
  const nat = r.natural20 != null ? ` (nat ${r.natural20})` : '';
  const dc =
    r.dc != null ? ` vs DC ${r.dc}${r.success != null ? (r.success ? ' — pass' : ' — fail') : ''}` : '';
  const kind = r.source === 'manual' ? 'physical' : 'rolled';
  return `- ${who}: ${label}${kind} ${r.total}${dc}${nat}`;
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

  const rolls = source.diceRolls ?? [];
  if (rolls.length) {
    draft +=
      '\n\n---\n\n' +
      '<!-- Dice log (including physical/off-screen rolls) — weave notable results into the recap, then delete this block. -->\n' +
      '## Dice log highlights\n\n' +
      rolls.map(diceRollLine).join('\n') +
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
    private readonly scheduling: SchedulingService,
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
        scheduledSessionId: sessions.scheduledSessionId,
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
      scheduledSessionId: r.scheduledSessionId,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
    return redactSecrets(items, role);
  }

  /**
   * Paginated session log (issue #612): newest-first with total/hasMore. Used by
   * SessionsPage so a five-year table history never loads in one response.
   */
  async listPageForCampaign(
    campaignId: number,
    role: Role,
    opts?: { limit?: number; offset?: number },
  ): Promise<SessionListPage> {
    const limit = clampSessionsListLimit(opts?.limit);
    const offset = sessionsListOffset(opts?.offset);
    const where = and(eq(sessions.campaignId, campaignId), notDeleted(sessions.deletedAt));

    const [{ value: total }] = await this.db.select({ value: count() }).from(sessions).where(where);

    let q = this.db
      .select({
        id: sessions.id,
        campaignId: sessions.campaignId,
        number: sessions.number,
        title: sessions.title,
        playedAt: sessions.playedAt,
        recapExcerpt: sql<string>`substr(${sessions.recap}, 1, 400)`,
        dmSecret: sessions.dmSecret,
        scheduledSessionId: sessions.scheduledSessionId,
        createdAt: sessions.createdAt,
        updatedAt: sessions.updatedAt,
      })
      .from(sessions)
      .where(where)
      .orderBy(desc(sessions.number))
      .$dynamic();
    q = applyPage(q, { limit, offset });
    const rows = await q;
    const items: SessionListItem[] = rows.map((r) => ({
      id: r.id,
      campaignId: r.campaignId,
      number: r.number,
      title: r.title,
      playedAt: r.playedAt,
      recapExcerpt: excerpt(r.recapExcerpt ?? ''),
      dmSecret: r.dmSecret,
      scheduledSessionId: r.scheduledSessionId,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
    const redacted = redactSecrets(items, role);
    return {
      items: redacted,
      total,
      hasMore: offset + redacted.length < total,
      limit,
      offset,
    };
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

  /**
   * Bounded campaign-search read (issue #442). Indexes the full recap body (not the
   * list-shape excerpt) with the same role redaction as list/get. Fold-match runs in
   * JS so Unicode haystacks stay aligned with SearchService (#624).
   */
  async searchForCampaign(campaignId: number, role: Role, needle: string, limit: number): Promise<SessionSearchEntry[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 50));
    // SearchService passes an already-folded needle; fold again for idempotent callers (#624).
    const folded = foldForSearch(needle.trim());
    if (!folded) return [];

    const rows = await this.db
      .select({
        id: sessions.id,
        campaignId: sessions.campaignId,
        number: sessions.number,
        title: sessions.title,
        recap: sessions.recap,
        dmSecret: sessions.dmSecret,
      })
      .from(sessions)
      .where(and(eq(sessions.campaignId, campaignId), notDeleted(sessions.deletedAt)))
      .orderBy(desc(sessions.number));

    const redacted = redactSecrets(
      rows.map((r) => ({
        id: r.id,
        campaignId: r.campaignId,
        number: r.number,
        title: r.title,
        recap: r.recap,
        dmSecret: r.dmSecret,
      })),
      role,
    );

    return redacted
      .filter((s) => {
        const title = s.title.trim() || `Session ${s.number}`;
        return (
          foldedIncludes(title, folded)
          || foldedIncludes(s.recap, folded)
          || foldedIncludes(s.dmSecret, folded)
        );
      })
      .slice(0, boundedLimit);
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
      ? and(eq(sessions.campaignId, campaignId), eq(sessions.number, number), ne(sessions.id, excludeId), notDeleted(sessions.deletedAt))
      : and(eq(sessions.campaignId, campaignId), eq(sessions.number, number), notDeleted(sessions.deletedAt));
    const [row] = await this.db.select({ id: sessions.id }).from(sessions).where(conflict).limit(1);
    if (row) throw new ConflictException(`Session number ${number} already exists in this campaign`);
  }

  async create(campaignId: number, input: SessionCreateInput, user: RequestUser, role: Role): Promise<Session> {
    const ts = nowIso();
    const recap = input.recap ?? '';
    const requestedScheduledSessionId = input.scheduledSessionId ?? null;

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
    // Schedule linking joins this SAME transaction (#504). Validating and linking after
    // the insert had committed left two holes: a schedule cancelled concurrently between
    // the pre-check and the link produced a persisted-but-unlinked session alongside a
    // 400, and an identical retry of a linked recap 400'd on the now-'completed' schedule
    // instead of returning the existing row. In-transaction, a rejected link rolls the
    // insert back, so the request is all-or-nothing.
    const result = this.db.transaction((tx) => {
      const linkInTx = (row: typeof sessions.$inferSelect) => {
        if (requestedScheduledSessionId == null) return null;
        // An identical retry whose row is already linked to the requested schedule is
        // the idempotent no-op, not a re-link attempt — don't re-validate it.
        if (row.scheduledSessionId === requestedScheduledSessionId) return null;
        const schedule = this.scheduling.getScheduleRowInTx(tx, requestedScheduledSessionId);
        if (schedule.campaignId !== campaignId) {
          throw new BadRequestException('Scheduled session must belong to the same campaign as the session');
        }
        if (schedule.status !== 'scheduled') {
          throw new BadRequestException('Only scheduled sessions can be completed by a recap');
        }
        return this.scheduling.linkSessionInTx(tx, requestedScheduledSessionId, row.id);
      };
      if (input.number === undefined || input.number === null) {
        const [newest] = tx
          .select()
          .from(sessions)
          .where(and(eq(sessions.campaignId, campaignId), notDeleted(sessions.deletedAt)))
          .orderBy(desc(sessions.number))
          .limit(1)
          .all();
        if (newest && recap.trim() !== '' && newest.recap === recap) {
          // #160 retry: reuse the existing row, but still honour a requested link so a
          // retry that asked to link is not silently returned unlinked.
          const linkOutcome = linkInTx(newest);
          const row = linkOutcome?.linked
            ? tx.select().from(sessions).where(eq(sessions.id, newest.id)).limit(1).all()[0]
            : newest;
          return { row, deduped: true, linkOutcome };
        }
        const [{ max }] = tx
          .select({ max: sql<number>`coalesce(max(${sessions.number}), 0)` })
          .from(sessions)
          .where(eq(sessions.campaignId, campaignId))
          .all();
        const number = max + 1;
        const [inserted] = tx
          .insert(sessions)
          .values({ campaignId, number, title: input.title ?? '', playedAt: input.playedAt ?? null, recap, dmSecret: input.dmSecret ?? '', scheduledSessionId: null, createdAt: ts, updatedAt: ts })
          .returning()
          .all();
        const linkOutcome = linkInTx(inserted);
        const row = linkOutcome?.linked
          ? tx.select().from(sessions).where(eq(sessions.id, inserted.id)).limit(1).all()[0]
          : inserted;
        return { row, deduped: false, linkOutcome };
      }
      // Explicit number: enforce campaign-uniqueness inside the same transaction.
      const [conflict] = tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.campaignId, campaignId), eq(sessions.number, input.number), notDeleted(sessions.deletedAt)))
        .limit(1)
        .all();
      if (conflict) throw new ConflictException(`Session number ${input.number} already exists in this campaign`);
      const [inserted] = tx
        .insert(sessions)
        .values({ campaignId, number: input.number, title: input.title ?? '', playedAt: input.playedAt ?? null, recap, dmSecret: input.dmSecret ?? '', scheduledSessionId: null, createdAt: ts, updatedAt: ts })
        .returning()
        .all();
      const linkOutcome = linkInTx(inserted);
      const row = linkOutcome?.linked
        ? tx.select().from(sessions).where(eq(sessions.id, inserted.id)).limit(1).all()[0]
        : inserted;
      return { row, deduped: false, linkOutcome };
    });

    const row = result.row;

    // A deduped retry is a no-op: the row (and its recap_posted notification and
    // audit entry) already exists from the first call — return it untouched. A link
    // the retry newly established still gets its audit trail.
    if (result.deduped) {
      if (result.linkOutcome) {
        await this.scheduling.recordSessionLink(result.linkOutcome, requestedScheduledSessionId!, row.id, user, role);
      }
      return redactSecret(toDomain(row), role);
    }

    await this.recomputeSessionCount(campaignId);

    // Open the initial prose tip so the first overwrite attributes this version to
    // the creator rather than inventing legacy "Replaced by…" authorship (#813).
    if (row.recap !== '') {
      await this.revisions.commitProseVersion({
        entityType: 'session',
        entityId: row.id,
        campaignId,
        priorProse: '',
        nextProse: row.recap,
        user,
      });
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'session.create',
      entityType: 'session',
      entityId: row.id,
      campaignId,
    });

    // The link itself already committed with the insert; this is only its audit + SSE.
    if (result.linkOutcome) {
      await this.scheduling.recordSessionLink(result.linkOutcome, requestedScheduledSessionId!, row.id, user, role);
    }

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
    const shouldLinkSchedule = input.scheduledSessionId != null && input.scheduledSessionId !== existing.scheduledSessionId;
    // An explicit `scheduledSessionId: null` is an UNLINK, not a plain column write —
    // it has to clear the schedule's side too, or the schedule stays 'completed' with
    // session_id pointing at this recap (dangling half-link). Delegated to
    // SchedulingService.unlinkSession so both rows move in one transaction.
    const shouldUnlinkSchedule = input.scheduledSessionId === null && existing.scheduledSessionId != null;
    if (shouldLinkSchedule) {
      const schedule = await this.scheduling.getRowOrThrow(input.scheduledSessionId!);
      if (schedule.campaignId !== existing.campaignId) {
        throw new BadRequestException('Scheduled session must belong to the same campaign as the session');
      }
      if (schedule.status !== 'scheduled') {
        throw new BadRequestException('Only scheduled sessions can be completed by a recap');
      }
      // The remaining guards are about the SESSION (already linked elsewhere, or some
      // other schedule already claims it). They used to fire only inside linkSession,
      // i.e. AFTER the field update and its audit entry had committed — so a PATCH
      // carrying a title change plus a doomed relink saved the title and still returned
      // 400. Evaluated here, a rejected relink leaves the recap completely unchanged.
      this.scheduling.assertCanLinkSession(input.scheduledSessionId!, id);
    }
    // Commit an immutable prose version when the recap actually changes (#157/#813):
    // close the prior tip (real author preserved) and open a tip for the new prose.
    if (input.recap !== undefined && input.recap !== existing.recap) {
      await this.revisions.commitProseVersion({
        entityType: 'session',
        entityId: id,
        campaignId: existing.campaignId,
        priorProse: existing.recap,
        nextProse: input.recap,
        user,
      });
    }
    const { scheduledSessionId, ...restInput } = input;
    // `scheduledSessionId` is never written by the plain patch: linkSessionInTx /
    // unlinkSessionInTx own that column so both sides of the relationship always move
    // together. The field update joins their transaction, so a guard that trips on a
    // concurrent change rolls the field update back too — a rejected edit changes
    // nothing, and a committed edit never leaves a half-link.
    const updatePatch = shouldLinkSchedule || shouldUnlinkSchedule ? restInput : input;
    const written = this.db.transaction((tx) => {
      const [updated] = tx
        .update(sessions)
        .set({ ...updatePatch, updatedAt: nowIso() })
        .where(eq(sessions.id, id))
        .returning()
        .all();
      let linkOutcome = null as ReturnType<SchedulingService['linkSessionInTx']> | null;
      let unlinkOutcome = null as ReturnType<SchedulingService['unlinkSessionInTx']> | null;
      if (shouldLinkSchedule) linkOutcome = this.scheduling.linkSessionInTx(tx, scheduledSessionId!, id);
      else if (shouldUnlinkSchedule) unlinkOutcome = this.scheduling.unlinkSessionInTx(tx, id);
      const row = linkOutcome || unlinkOutcome
        ? tx.select().from(sessions).where(eq(sessions.id, id)).limit(1).all()[0]
        : updated;
      return { row, linkOutcome, unlinkOutcome };
    });
    const row = written.row;

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

    // Both relationship writes already committed with the field update above; these are
    // only their audit + SSE halves.
    if (written.linkOutcome) {
      await this.scheduling.recordSessionLink(written.linkOutcome, scheduledSessionId!, id, user, role);
    } else if (written.unlinkOutcome) {
      await this.scheduling.recordSessionUnlink(written.unlinkOutcome, id, user, role);
    }

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

  /**
   * Bulk attendance read for campaign export (issue #436): one query for every
   * session in the campaign instead of N per-session getAttendance calls.
   */
  async listAttendanceForCampaign(
    campaignId: number,
  ): Promise<Array<{ sessionId: number; characterId: number; characterName: string }>> {
    const sessionRows = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.campaignId, campaignId), notDeleted(sessions.deletedAt)));
    if (sessionRows.length === 0) return [];

    const sessionIds = sessionRows.map((r) => r.id);
    const rows = await this.db
      .select({ attendee: sessionAttendees, currentCharacterName: characters.name })
      .from(sessionAttendees)
      .innerJoin(sessions, eq(sessionAttendees.sessionId, sessions.id))
      .leftJoin(
        characters,
        and(eq(sessionAttendees.characterId, characters.id), eq(characters.campaignId, campaignId)),
      )
      .where(inArray(sessionAttendees.sessionId, sessionIds));
    return rows.map(({ attendee, currentCharacterName }) => ({
      sessionId: attendee.sessionId,
      characterId: attendee.characterId,
      characterName: currentCharacterName ?? attendee.characterName,
    }));
  }

  /**
   * The roster that played a session. Any member may read.
   *
   * `character_name` is the write-time snapshot kept for compatibility and as a
   * graceful fallback for an orphaned legacy row. Prefer the character table's
   * current name when that row still exists, including when it is retired or
   * soft-deleted. This is intentionally a read-only LEFT JOIN: renames are visible
   * immediately without a read causing synchronization writes.
   */
  async getAttendance(sessionId: number): Promise<SessionAttendee[]> {
    const session = await this.getRowOrThrow(sessionId); // 404 for an unknown session
    const displayName = sql<string>`coalesce(${characters.name}, ${sessionAttendees.characterName})`;
    const rows = await this.db
      .select({ attendee: sessionAttendees, currentCharacterName: characters.name })
      .from(sessionAttendees)
      .leftJoin(
        characters,
        and(eq(sessionAttendees.characterId, characters.id), eq(characters.campaignId, session.campaignId)),
      )
      .where(eq(sessionAttendees.sessionId, sessionId))
      .orderBy(asc(displayName), asc(sessionAttendees.id));
    return rows.map(({ attendee, currentCharacterName }) =>
      attendeeToDomain({
        ...attendee,
        characterName: currentCharacterName ?? attendee.characterName,
      }),
    );
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
