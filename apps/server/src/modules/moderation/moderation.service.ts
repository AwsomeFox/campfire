import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, isNull, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import type {
  AuditActorRole,
  EntityType,
  ModerationActionRequest,
  ModerationEvidence,
  ModerationEvidenceReason,
  ModerationIncidentExport,
  ModerationMute,
  ModerationReport,
  ModerationReportCreate,
  ModerationReportPage,
  ModerationReportStatus,
  ModerationRetentionPolicy,
  ModerationRetentionPolicyUpdate,
  ModerationSilenceCreate,
  ModerationTargetType,
  Role,
} from '@campfire/schema';
import { MODERATION_SERVER_CAPTURED_TARGETS } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import {
  auditLog,
  campaignMembers,
  comments,
  moderationEvidence,
  moderationMutes,
  moderationReports,
  notes,
  notifications,
  settings,
  users,
} from '../../db/schema';
import { nowIso } from '../../common/time';
import { getRequestId } from '../../common/request-context';
import { buildCursorListPage } from '../../common/cursor-pagination';
import { assertAnchorVisible } from '../../common/anchor-visibility';
import { canSee } from '../../common/note-visibility';
import { auditActor, type RequestUser } from '../../common/user.types';
import { AuditService, DEFAULT_AUDIT_RETENTION_DAYS, toAuditEntry } from '../audit/audit.service';
import { clampModerationListLimit, decodeModerationCursor } from './moderation-pagination';
import {
  MODERATION_REDACTED_CONTENT,
  moderationEvidenceHash,
  moderationEvidenceMetadataHash,
  verifyModerationEvidence,
  type ModerationEvidencePayload,
} from './moderation-evidence';

/**
 * The drizzle transaction handle handed to a `db.transaction(cb)` callback.
 * better-sqlite3 is synchronous, so everything inside a transaction callback must
 * use the sync `.all()` / `.get()` / `.run()` query terminators — that is exactly
 * what makes atomic snapshot-then-mutate possible here (see captureEvidenceTx).
 */
export type ModerationTx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

/** Reads that must work against either the pooled handle or an open transaction. */
type ModerationReader = DrizzleDb | ModerationTx;

const MODERATION_RETENTION_SETTINGS_KEY = 'moderation.retention';

/**
 * Body a quarantined comment reads back as. Deliberately distinct from
 * comments' `[deleted]` tombstone copy: a reader who has already seen a
 * placeholder deserves to know whether the author withdrew the post or a
 * moderator withheld it, and conflating the two would let a moderation action
 * masquerade as an author's own choice.
 */
export const QUARANTINE_BODY = '[withheld pending moderation review]';

/** Report statuses that still justify withholding content / capturing pre-mutation snapshots. */
const UNRESOLVED_STATUSES: ModerationReportStatus[] = ['open', 'acknowledged', 'escalated'];

/**
 * Which note target type a notes row corresponds to. A whisper is modelled as its
 * own reportable surface (see @campfire/schema ModerationTargetType) because it is
 * the one note flavour with a single private recipient.
 */
function noteTargetType(visibility: string): ModerationTargetType {
  return visibility === 'whisper' ? 'whisper' : 'note';
}

/** Both note flavours share a row, so "is this note watched" must check both labels. */
const NOTE_TARGET_TYPES: ModerationTargetType[] = ['note', 'whisper'];

/** Everything needed to write one evidence row, minus the fields the service fills in. */
export interface ModerationCaptureInput {
  campaignId: number;
  targetType: ModerationTargetType;
  targetId: number | null;
  reason: ModerationEvidenceReason;
  source: 'server_capture' | 'reporter_supplied';
  authorUserId: string;
  authorName: string;
  recipientUserId: string | null;
  anchorEntityType: string | null;
  anchorEntityId: number | null;
  revisionAt: string;
  content: string;
  context: Record<string, unknown>;
}

/**
 * Moderation / abuse-incident service (issue #601).
 *
 * Three responsibilities, in dependency order:
 *
 *  1. EVIDENCE (bullet 2). `captureEvidenceTx` writes an integrity-protected
 *     snapshot of content + revision + context. It is deliberately SYNCHRONOUS and
 *     takes a transaction handle, so CommentsService/NotesService can capture inside
 *     the very transaction that performs the edit/delete. A snapshot taken outside
 *     the mutation's transaction can be beaten by a concurrent delete; a snapshot
 *     taken inside it cannot, because SQLite serializes the write transaction. See
 *     the "EDIT/DELETE RACE" note on captureEvidenceTx.
 *
 *  2. REPORTS (bullet 1) over one generic (targetType, targetId) pair covering all
 *     six surfaces named in the issue.
 *
 *  3. THE QUEUE + ACCESS SPLIT (bullets 3-5). Report METADATA is queue data; report
 *     CONTENT is sensitive evidence behind a separate, always-audited endpoint that
 *     no ordinary campaign content read can reach.
 *
 * DEPENDENCIES: this service must not inject CommentsService or NotesService — they
 * inject IT (for capture hooks). The two visibility rules it needs are therefore
 * shared through `common/anchor-visibility.ts` and `common/note-visibility.ts`
 * rather than reached through those services.
 */
@Injectable()
export class ModerationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ModerationService.name);

  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
  ) {}

  /**
   * Disclose the evidence-retention horizon at boot, mirroring AuditService. No
   * sweep runs during startup; expiry is applied lazily on read (a redacted-on-read
   * snapshot can never be served stale) and on the explicit admin sweep endpoint.
   */
  async onApplicationBootstrap(): Promise<void> {
    const policy = await this.getRetentionPolicy();
    this.logger.log(
      `Moderation evidence retention: ${policy.days <= 0 ? 'keep forever' : `${policy.days} days`} ` +
        `(source: ${policy.source}); auto-redact ${policy.autoRedactEnabled ? 'enabled' : 'disabled'}`,
    );
  }

  // -------------------------------------------------------------------------
  // Retention (bullet 6)
  // -------------------------------------------------------------------------

  /**
   * Evidence retention. Extends the audit retention model rather than inventing a
   * parallel one: when no moderation-specific override is stored, `days` INHERITS
   * the effective audit retention policy, so an operator who has already tuned
   * retention once does not have to discover a second knob.
   *
   * The one intentional divergence: expiry REDACTS the snapshot content instead of
   * deleting the row. Deleting would destroy the record that an incident occurred
   * at all — the opposite of what a safeguarding policy wants — so the report
   * shell, the hashes, and the audit timeline survive while the abusive prose does
   * not linger. `days <= 0` disables expiry entirely (self-hosters who ship
   * evidence off-box under their own policy).
   */
  async getRetentionPolicy(): Promise<ModerationRetentionPolicy> {
    const stored = this.readStoredRetention(this.db);
    const auditPolicy = await this.audit.getRetentionPolicy();
    return {
      days: stored.days ?? auditPolicy.days,
      defaultDays: DEFAULT_AUDIT_RETENTION_DAYS,
      autoRedactEnabled: stored.autoRedactEnabled ?? true,
      source: stored.days !== undefined ? 'settings' : 'audit',
    };
  }

  async updateRetentionPolicy(
    update: ModerationRetentionPolicyUpdate,
    actor: { actor: string; actorRole: AuditActorRole },
  ): Promise<ModerationRetentionPolicy> {
    const existing = this.readStoredRetention(this.db);
    const next: ModerationRetentionPolicyUpdate = { ...existing };
    if (update.days !== undefined) {
      if (!Number.isInteger(update.days)) throw new BadRequestException('days must be an integer');
      next.days = update.days;
    }
    if (update.autoRedactEnabled !== undefined) next.autoRedactEnabled = update.autoRedactEnabled;
    this.writeStoredRetention(next);
    const policy = await this.getRetentionPolicy();
    await this.audit.log({
      actor: actor.actor,
      actorRole: actor.actorRole,
      action: 'moderation.retention.update',
      entityType: 'settings',
      detail: `days=${policy.days}, autoRedactEnabled=${policy.autoRedactEnabled}`,
    });
    return policy;
  }

  /**
   * Redact every snapshot whose `expires_at` has passed. Idempotent (already-redacted
   * rows are skipped by the `redacted_at IS NULL` predicate) and safe to call from an
   * admin endpoint or a test. Returns the number of snapshots redacted.
   *
   * Honours `autoRedactEnabled`: with the policy switched off this is a no-op, and so
   * is the lazy on-read sweep in loadEvidence. That switch is the operator's control
   * over automatic destruction of evidence content — a setting that is stored,
   * reported and audited but silently ignored would be worse than not offering it,
   * because an operator would believe they had turned scheduled redaction off. The
   * explicit per-incident {@link redactEvidence} is deliberately NOT gated on it: that
   * one is a deliberate human decision, not a timer.
   *
   * Redaction preserves `content_hash` unchanged on purpose — see
   * verifyModerationEvidence: keeping the original digest, alongside the metadata
   * digest that still verifies, is what lets a reviewer confirm later that redaction
   * was the ONLY thing that changed.
   */
  async redactExpired(actor: { actor: string; actorRole: AuditActorRole }): Promise<number> {
    if (!(await this.getRetentionPolicy()).autoRedactEnabled) return 0;
    const nowTs = nowIso();
    const rows = await this.db
      .select({ id: moderationEvidence.id, campaignId: moderationEvidence.campaignId })
      .from(moderationEvidence)
      .where(and(isNull(moderationEvidence.redactedAt), lte(moderationEvidence.expiresAt, nowTs)));
    if (rows.length === 0) return 0;
    await this.db
      .update(moderationEvidence)
      .set({
        content: MODERATION_REDACTED_CONTENT,
        redactedAt: nowTs,
        redactedBy: actor.actor,
        redactionReason: 'retention expiry',
      })
      .where(
        inArray(
          moderationEvidence.id,
          rows.map((r) => r.id),
        ),
      );
    for (const row of rows) {
      await this.audit.log({
        actor: actor.actor,
        actorRole: actor.actorRole,
        action: 'moderation.evidence.redact',
        entityType: 'moderation_evidence',
        entityId: row.id,
        campaignId: row.campaignId,
        detail: 'retention expiry',
      });
    }
    return rows.length;
  }

  // -------------------------------------------------------------------------
  // Evidence capture (bullet 2) — the load-bearing piece
  // -------------------------------------------------------------------------

  /**
   * Write one integrity-protected snapshot. SYNCHRONOUS and transaction-bound.
   *
   * EDIT/DELETE RACE (#601's first named test case)
   * ----------------------------------------------
   * The attack is: a victim files a report at the same moment the abuser edits or
   * deletes the message. If the snapshot were taken by an ordinary async read
   * OUTSIDE the mutation's transaction, the interleaving
   *
   *     [report] read row -> (abuser's DELETE commits) -> [report] insert snapshot
   *
   * could snapshot content that no longer reflects what the report is about, or —
   * for a hard-deleting surface — snapshot nothing at all. Capturing INSIDE the
   * transaction removes the window: SQLite serializes write transactions, so the
   * row the capture reads and the row the mutation writes are the same row in the
   * same exclusive window, and no other writer can slip between them.
   *
   * Both interleavings therefore preserve evidence:
   *   - report first  -> snapshot holds the pre-mutation content; the abuser's later
   *                      edit/delete additionally trips the watched-target hook below
   *                      and captures its own pre_edit/pre_delete snapshot.
   *   - mutation first -> the mutation itself captures nothing (no report existed yet),
   *                      but comments and notes are SOFT-deleting, so the report that
   *                      lands moments later still reads the original body out of the
   *                      row and snapshots it.
   *
   * The audit row is inserted in the SAME transaction, so "a snapshot exists" and
   * "the snapshot was recorded" can never disagree.
   */
  captureEvidenceTx(tx: ModerationTx, input: ModerationCaptureInput): number {
    const capturedAt = nowIso();
    const payload: ModerationEvidencePayload = {
      campaignId: input.campaignId,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason,
      source: input.source,
      authorUserId: input.authorUserId,
      authorName: input.authorName,
      recipientUserId: input.recipientUserId,
      anchorEntityType: input.anchorEntityType,
      anchorEntityId: input.anchorEntityId,
      revisionAt: input.revisionAt,
      capturedAt,
      context: input.context,
      content: input.content,
    };
    const contentHash = moderationEvidenceHash(payload);
    // Second digest over everything but the content, so a later redaction cannot turn
    // into a blanket "integrity checking off" flag — see moderation-evidence.ts.
    const metadataHash = moderationEvidenceMetadataHash(payload);
    const expiresAt = this.computeExpiry(tx, capturedAt);

    const [row] = tx
      .insert(moderationEvidence)
      .values({
        campaignId: input.campaignId,
        targetType: input.targetType,
        targetId: input.targetId,
        reason: input.reason,
        source: input.source,
        authorUserId: input.authorUserId,
        authorName: input.authorName,
        recipientUserId: input.recipientUserId,
        anchorEntityType: input.anchorEntityType,
        anchorEntityId: input.anchorEntityId,
        revisionAt: input.revisionAt,
        content: input.content,
        contextJson: JSON.stringify(input.context),
        contentHash,
        metadataHash,
        expiresAt,
        capturedAt,
      })
      .returning()
      .all();

    tx.insert(auditLog)
      .values({
        campaignId: input.campaignId,
        actor: 'system:moderation',
        actorRole: 'admin',
        action: 'moderation.evidence.capture',
        entityType: 'moderation_evidence',
        entityId: row.id,
        detail: `target=${input.targetType}:${input.targetId ?? 'none'}, reason=${input.reason}, hash=${contentHash.slice(0, 16)}…`,
        requestId: getRequestId() ?? null,
        createdAt: capturedAt,
      })
      .run();

    return row.id;
  }

  /**
   * Pre-mutation hook for CommentsService. Captures ONLY when the comment is under
   * moderation interest — i.e. some unresolved report already names it.
   *
   * WHY NOT ALWAYS: #601 explicitly says "only snapshot what is needed; this is
   * abuse evidence, not a general revision history", and the repo already HAS a
   * general revision history (RevisionsService.commitProseVersion, #157/#813) that
   * every comment edit writes to. Snapshotting every edit would duplicate that at
   * moderation's much stricter retention and access rules, which is both wasteful
   * and worse for privacy — evidence storage should hold as little as possible.
   *
   * The bound this accepts, stated plainly: content edited or deleted BEFORE anyone
   * reports it is not captured here. It is not lost either — the report path itself
   * snapshots the live row (comments/notes soft-delete, so the prose is still there),
   * and prior bodies remain in entity_revisions. What this hook guarantees is that
   * once an incident is open, no further mutation of its subject goes unrecorded.
   */
  snapshotCommentIfWatched(
    tx: ModerationTx,
    row: typeof comments.$inferSelect,
    reason: ModerationEvidenceReason,
  ): number | null {
    if (!this.isTargetWatchedTx(tx, row.campaignId, ['comment'], row.id)) return null;
    return this.captureEvidenceTx(tx, this.commentCaptureInput(row, reason));
  }

  /** Pre-mutation hook for NotesService. See snapshotCommentIfWatched for the bound. */
  snapshotNoteIfWatched(
    tx: ModerationTx,
    row: typeof notes.$inferSelect,
    reason: ModerationEvidenceReason,
  ): number | null {
    if (!this.isTargetWatchedTx(tx, row.campaignId, NOTE_TARGET_TYPES, row.id)) return null;
    return this.captureEvidenceTx(tx, this.noteCaptureInput(row, reason));
  }

  /** Is some unresolved report currently naming this target? */
  private isTargetWatchedTx(
    tx: ModerationReader,
    campaignId: number,
    targetTypes: ModerationTargetType[],
    targetId: number,
  ): boolean {
    const rows = tx
      .select({ id: moderationReports.id })
      .from(moderationReports)
      .where(
        and(
          eq(moderationReports.campaignId, campaignId),
          inArray(moderationReports.targetType, targetTypes),
          eq(moderationReports.targetId, targetId),
          inArray(moderationReports.status, UNRESOLVED_STATUSES),
        ),
      )
      .limit(1)
      .all();
    return rows.length > 0;
  }

  private commentCaptureInput(
    row: typeof comments.$inferSelect,
    reason: ModerationEvidenceReason,
  ): ModerationCaptureInput {
    return {
      campaignId: row.campaignId,
      targetType: 'comment',
      targetId: row.id,
      reason,
      source: 'server_capture',
      authorUserId: row.authorUserId,
      authorName: row.authorName,
      recipientUserId: null,
      anchorEntityType: row.entityType,
      anchorEntityId: row.entityId,
      revisionAt: row.updatedAt,
      content: row.body,
      context: {
        parentId: row.parentId,
        inCharacter: row.inCharacter,
        characterName: row.characterName,
        createdAt: row.createdAt,
        deletedAt: row.deletedAt,
        deletedBy: row.deletedBy,
        editedAt: row.editedAt,
        editedBy: row.editedBy,
        quarantinedAt: row.quarantinedAt,
      },
    };
  }

  private noteCaptureInput(
    row: typeof notes.$inferSelect,
    reason: ModerationEvidenceReason,
  ): ModerationCaptureInput {
    return {
      campaignId: row.campaignId,
      targetType: noteTargetType(row.visibility),
      targetId: row.id,
      reason,
      source: 'server_capture',
      authorUserId: row.authorUserId,
      authorName: row.authorName,
      recipientUserId: row.recipientUserId ?? null,
      anchorEntityType: row.entityType,
      anchorEntityId: row.entityId,
      revisionAt: row.updatedAt,
      content: row.body,
      context: {
        kind: row.kind,
        visibility: row.visibility,
        createdAt: row.createdAt,
        deletedAt: row.deletedAt,
        quarantinedAt: row.quarantinedAt,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Mute enforcement (the `mute` queue action, made real)
  // -------------------------------------------------------------------------

  /**
   * 403 when this user currently has an active mute in this campaign. Called from
   * comment and note creation — a mute nobody enforces is theatre.
   *
   * Keyed on the user id, not the membership row, so leaving and rejoining the
   * campaign does not clear the sanction.
   */
  async assertNotMuted(campaignId: number, user: RequestUser): Promise<void> {
    const nowTs = nowIso();
    const [row] = await this.db
      .select({ expiresAt: moderationMutes.expiresAt })
      .from(moderationMutes)
      .where(
        and(
          eq(moderationMutes.campaignId, campaignId),
          eq(moderationMutes.userId, user.id),
          isNull(moderationMutes.liftedAt),
          or(isNull(moderationMutes.expiresAt), sql`${moderationMutes.expiresAt} > ${nowTs}`)!,
        ),
      )
      .limit(1);
    if (!row) return;
    throw new ForbiddenException(
      row.expiresAt
        ? `You are muted in this campaign until ${row.expiresAt}.`
        : 'You are muted in this campaign. Contact your DM.',
    );
  }

  /**
   * Issue #597: TEMPORARY SILENCE, applied directly by a DM without a report.
   *
   * #601 delivered the enforcement (assertNotMuted, above) but only reachable through
   * the queue's `mute` verb, which needs an incident to hang it on. That leaves a DM
   * facing an escalating table with two bad options: manufacture a permanent accusation
   * record against someone who mainly needs to cool off, or remove them from the
   * campaign. This is the middle rung the issue asks for — time-bounded, reversible,
   * audited, and explicitly NOT removal: the member keeps their seat, their character,
   * and every read; they simply cannot post for a while.
   *
   * `hours` omitted means indefinite-until-lifted, which is the honest representation of
   * "we'll talk about it later" — but the endpoint documents that a bounded silence is
   * the expected shape, because an unbounded one that everybody forgets about is a
   * removal with extra steps.
   *
   * Refuses to silence a DM: silencing a co-DM is a jurisdiction question (they can lift
   * it themselves a second later), and the conflicted-DM path in the report queue is how
   * that case is meant to travel.
   */
  async silenceMember(
    campaignId: number,
    input: ModerationSilenceCreate,
    user: RequestUser,
    role: Role,
  ): Promise<ModerationMute> {
    const target = input.userId.trim();
    if (target === user.id) throw new BadRequestException('You cannot silence yourself.');
    const targetName = await this.lookupMemberName(campaignId, target);
    if (!targetName) throw new BadRequestException('`userId` must name a member of this campaign');
    if (await this.holdsDmRole(campaignId, target)) {
      throw new BadRequestException(
        'A DM cannot be silenced from the queue — they could lift it themselves. Escalate a report instead, which ' +
          'leaves DM jurisdiction for server-admin review.',
      );
    }

    const nowTs = nowIso();
    const expiresAt = input.hours ? new Date(Date.now() + input.hours * 3600_000).toISOString() : null;
    // Clear any live silence first so the list never shows two overlapping rows for one
    // member and `assertNotMuted` cannot be confused about which horizon applies.
    await this.db
      .update(moderationMutes)
      .set({ liftedAt: nowTs, liftedBy: auditActor(user) })
      .where(
        and(
          eq(moderationMutes.campaignId, campaignId),
          eq(moderationMutes.userId, target),
          isNull(moderationMutes.liftedAt),
        ),
      );
    const [row] = await this.db
      .insert(moderationMutes)
      .values({
        campaignId,
        userId: target,
        userName: targetName,
        reason: input.reason?.slice(0, 500) ?? '',
        expiresAt,
        createdBy: auditActor(user),
        createdAt: nowTs,
      })
      .returning();

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'moderation.silence',
      entityType: 'moderation_mute',
      entityId: row.id,
      campaignId,
      detail: `user=${target}, until=${expiresAt ?? 'lifted'}`,
    });
    return {
      id: row.id,
      campaignId: row.campaignId,
      userId: row.userId,
      userName: row.userName,
      reason: row.reason,
      expiresAt: row.expiresAt,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    };
  }

  /** Lift one silence by id (issue #597) — the reverse of {@link silenceMember}. */
  async liftSilence(campaignId: number, muteId: number, user: RequestUser, role: Role): Promise<void> {
    const [row] = await this.db
      .select()
      .from(moderationMutes)
      .where(
        and(
          eq(moderationMutes.id, muteId),
          eq(moderationMutes.campaignId, campaignId),
          isNull(moderationMutes.liftedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException(`Mute ${muteId} not found`);
    await this.db
      .update(moderationMutes)
      .set({ liftedAt: nowIso(), liftedBy: auditActor(user) })
      .where(eq(moderationMutes.id, muteId));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'moderation.unsilence',
      entityType: 'moderation_mute',
      entityId: muteId,
      campaignId,
      detail: `user=${row.userId}`,
    });
  }

  async listMutes(campaignId: number): Promise<ModerationMute[]> {
    const rows = await this.db
      .select()
      .from(moderationMutes)
      .where(and(eq(moderationMutes.campaignId, campaignId), isNull(moderationMutes.liftedAt)))
      .orderBy(desc(moderationMutes.id));
    return rows.map((row) => ({
      id: row.id,
      campaignId: row.campaignId,
      userId: row.userId,
      userName: row.userName,
      reason: row.reason,
      expiresAt: row.expiresAt,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    }));
  }

  // -------------------------------------------------------------------------
  // Reports (bullet 1)
  // -------------------------------------------------------------------------

  /**
   * File a report. Authorization is deliberately strict in both directions:
   *
   *  - the reporter must be able to SEE the target under the SAME rule the target's
   *    own GET uses, so reporting can never become a probe for a hidden entity or
   *    someone else's whisper (uniform 404, never 403);
   *  - and the snapshot is captured atomically with the report insert, so an abuser
   *    racing a delete cannot leave a report pointing at nothing.
   *
   * CONFLICTED DM (#601's explicit test case): if the report's subject holds the dm
   * role in this campaign, the report is created ALREADY ESCALATED and never enters
   * that campaign's DM queue. Leaving it visible would hand the accused the tools to
   * acknowledge, quarantine the complaint's own evidence, and resolve it against
   * themselves. Fail closed: it leaves DM jurisdiction entirely and is reachable only
   * through audited server-admin break-glass.
   */
  async createReport(
    campaignId: number,
    input: ModerationReportCreate,
    user: RequestUser,
    role: Role,
  ): Promise<ModerationReport> {
    const resolved = await this.resolveTarget(campaignId, input, user, role);

    // Conflict detection happens BEFORE the write so the report is born escalated
    // rather than briefly visible to the very person it accuses.
    // A notification can retain an actor solely for attribution relabeling and
    // moderation evidence. It is not itself an authored moderation target: reports
    // about a recipient's bell item stay in the campaign DM queue, as they did
    // before notification actor ids were retained.
    const subjectIsDm = input.targetType !== 'notification' && resolved.authorUserId
      ? await this.holdsDmRole(campaignId, resolved.authorUserId)
      : false;
    const nowTs = nowIso();

    const reportRow = this.db.transaction((tx) => {
      // Re-read the source row INSIDE the transaction. Between the async
      // authorization above and this point the author may have edited or deleted;
      // whatever is in the row NOW is what the snapshot must record.
      const capture = this.rereadCaptureTx(tx, campaignId, resolved);
      const evidenceId = this.captureEvidenceTx(tx, capture);
      // Bell items are reportable server-captured evidence, but their triggering
      // actor is not the report's moderation subject. Otherwise a DM-triggered
      // notification either auto-escalates or is hidden from that table's own queue.
      // The evidence keeps the actor's stable id for account-lifecycle relabeling.
      const notificationReport = resolved.targetType === 'notification';
      const [row] = tx
        .insert(moderationReports)
        .values({
          campaignId,
          targetType: resolved.targetType,
          targetId: resolved.targetId,
          reporterUserId: user.id,
          reporterName: user.name,
          subjectUserId: notificationReport ? '' : capture.authorUserId,
          subjectName: notificationReport ? '' : capture.authorName,
          reason: input.reason,
          details: input.details ?? '',
          status: subjectIsDm ? 'escalated' : 'open',
          evidenceId,
          quarantined: false,
          escalatedAt: subjectIsDm ? nowTs : null,
          escalationReason: subjectIsDm
            ? 'auto: the reported member holds the dm role in this campaign (conflicted queue)'
            : '',
          createdAt: nowTs,
          updatedAt: nowTs,
        })
        .returning()
        .all();
      return row;
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'moderation.report.create',
      entityType: 'moderation_report',
      entityId: reportRow.id,
      campaignId,
      // Never the content or the details prose — the audit log is DM-readable
      // campaign history, and evidence lives behind its own gate.
      detail: `target=${resolved.targetType}:${resolved.targetId ?? 'none'}, reason=${input.reason}, status=${reportRow.status}`,
    });

    return this.toReportDomain(reportRow, await this.evidenceIntegrityOf(reportRow.evidenceId));
  }

  /**
   * The DM queue (bullet 4) — METADATA ONLY. No evidence content is ever returned
   * here; reading the words requires {@link readEvidence}, which audits every call.
   *
   * A non-DM member sees only the reports THEY filed (status tracking for their own
   * complaint) and never anyone else's. A DM sees the campaign queue MINUS escalated
   * reports, which have left DM jurisdiction.
   */
  async listReports(
    campaignId: number,
    user: RequestUser,
    role: Role,
    opts: { status?: ModerationReportStatus; limit?: number; cursor?: string } = {},
  ): Promise<ModerationReportPage> {
    const limit = clampModerationListLimit(opts.limit);
    const cursor = decodeModerationCursor(opts.cursor);
    const base = this.queueConditions(campaignId, user, role, opts.status);
    const pageConds = cursor ? [...base, lt(moderationReports.id, cursor.i)] : base;

    const [countRows, fetched] = await Promise.all([
      this.db.select({ value: count() }).from(moderationReports).where(and(...base)),
      this.db
        .select()
        .from(moderationReports)
        .where(and(...pageConds))
        .orderBy(desc(moderationReports.id))
        .limit(limit + 1),
    ]);

    const total = countRows[0]?.value ?? 0;
    const page = buildCursorListPage(fetched, limit, total, (last) => ({ v: 1, m: 'id', i: last.id }));
    const integrity = await this.evidenceIntegrityFor(page.items.map((r) => r.evidenceId));
    return {
      ...page,
      items: page.items.map((row) => this.toReportDomain(row, integrity.get(row.evidenceId) ?? 'tampered')),
    };
  }

  private queueConditions(
    campaignId: number,
    user: RequestUser,
    role: Role,
    status?: ModerationReportStatus,
  ): SQL[] {
    const conds: SQL[] = [eq(moderationReports.campaignId, campaignId)];
    if (role === 'dm') {
      // Escalated reports have left DM jurisdiction — including from a co-DM who is
      // not personally the subject, because co-DMs at one table are exactly the
      // people least able to review each other impartially. Server-admin only.
      conds.push(ne(moderationReports.status, 'escalated'));
      // Belt and braces alongside the per-report conflict check in
      // requireReportForModeration: a DM never even LISTS a report about themselves.
      conds.push(ne(moderationReports.subjectUserId, user.id));
    } else {
      conds.push(eq(moderationReports.reporterUserId, user.id));
    }
    if (status) conds.push(eq(moderationReports.status, status));
    return conds;
  }

  /** Single report, metadata only, same access split as {@link listReports}. */
  async getReport(campaignId: number, reportId: number, user: RequestUser, role: Role): Promise<ModerationReport> {
    const row = await this.loadReportRow(campaignId, reportId);
    if (role === 'dm') {
      this.assertDmMayHandle(row, user);
    } else if (row.reporterUserId !== user.id) {
      throw new NotFoundException(`Moderation report ${reportId} not found`);
    }
    return this.toReportDomain(row, await this.evidenceIntegrityOf(row.evidenceId));
  }

  // -------------------------------------------------------------------------
  // Evidence access (bullet 3 + the access-logging half of bullet 6)
  // -------------------------------------------------------------------------

  /**
   * Read the sensitive evidence behind a report. This is the ONLY campaign-scoped
   * path that returns snapshot content, and it:
   *   - requires the dm role (checked by the controller) AND passes the conflicted-DM
   *     and escalation gates below;
   *   - applies retention lazily, so an expired snapshot is redacted on the way out
   *     rather than served because no sweep has run yet;
   *   - writes an access audit row EVERY time, naming who read which evidence when.
   *
   * There is no bulk evidence list. Evidence is read one incident at a time, on
   * purpose: a browsable archive of abuse content is itself a hazard.
   */
  async readEvidence(
    campaignId: number,
    reportId: number,
    user: RequestUser,
    role: Role,
  ): Promise<ModerationEvidence> {
    const report = await this.loadReportRow(campaignId, reportId);
    this.assertDmMayHandle(report, user);
    const evidence = await this.loadEvidence(report.evidenceId, { actor: auditActor(user), actorRole: role });
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'moderation.evidence.access',
      entityType: 'moderation_evidence',
      entityId: evidence.id,
      campaignId,
      detail: `report=${reportId}, integrity=${evidence.integrity}`,
    });
    return evidence;
  }

  /**
   * Controlled export of one incident (bullet 6). Same gates as {@link readEvidence}
   * plus its own audit action, so "someone took a copy off the box" is distinguishable
   * from "someone read it in the UI". Bundles the incident's audit timeline so the
   * export is self-contained for a safeguarding referral.
   */
  async exportIncident(
    campaignId: number,
    reportId: number,
    user: RequestUser,
    role: Role,
  ): Promise<ModerationIncidentExport> {
    const report = await this.loadReportRow(campaignId, reportId);
    this.assertDmMayHandle(report, user);
    const bundle = await this.buildIncidentExport(report, { actor: auditActor(user), actorRole: role });
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'moderation.incident.export',
      entityType: 'moderation_report',
      entityId: reportId,
      campaignId,
      detail: `evidence=${report.evidenceId}, integrity=${bundle.evidence.integrity}`,
    });
    return bundle;
  }

  /**
   * Redact a snapshot's content on request (bullet 6's redaction path), before its
   * retention horizon. The report, hashes, and timeline survive; the prose does not.
   * Used when the content must stop being retained sooner than policy — e.g. it
   * depicts a minor — without destroying the record that the incident happened.
   */
  async redactEvidence(
    campaignId: number,
    reportId: number,
    reason: string,
    user: RequestUser,
    role: Role,
  ): Promise<ModerationEvidence> {
    const report = await this.loadReportRow(campaignId, reportId);
    this.assertDmMayHandle(report, user);
    const nowTs = nowIso();
    await this.db
      .update(moderationEvidence)
      .set({
        content: MODERATION_REDACTED_CONTENT,
        redactedAt: nowTs,
        redactedBy: auditActor(user),
        redactionReason: reason.slice(0, 500) || 'manual redaction',
      })
      .where(and(eq(moderationEvidence.id, report.evidenceId), isNull(moderationEvidence.redactedAt)));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'moderation.evidence.redact',
      entityType: 'moderation_evidence',
      entityId: report.evidenceId,
      campaignId,
      detail: `report=${reportId}, reason=${reason.slice(0, 200)}`,
    });
    return this.loadEvidence(report.evidenceId, { actor: auditActor(user), actorRole: role });
  }

  // -------------------------------------------------------------------------
  // Queue actions (bullet 4)
  // -------------------------------------------------------------------------

  /**
   * Apply one queue verb. Every action is audited through the existing AuditService
   * (no second audit system), and every action that touches content captures a
   * pre-mutation snapshot inside the same transaction as the mutation.
   *
   * ESCALATE is the one action a non-DM may take, and only on their OWN report: it
   * is the appeal valve for "the DM is the problem, or sided with them". Everything
   * else requires the dm role plus the conflicted-DM and escalation gates.
   */
  async act(
    campaignId: number,
    reportId: number,
    input: ModerationActionRequest,
    user: RequestUser,
    role: Role,
  ): Promise<ModerationReport> {
    const report = await this.loadReportRow(campaignId, reportId);

    if (role !== 'dm') {
      // A non-DM may only ever touch their OWN report, and only to escalate it. The
      // 404-before-403 ordering matters: a bare `role !== 'dm'` 403 here would make
      // this endpoint an existence oracle for every report id in the campaign —
      // 404 for "no such report", 403 for "exists but you may not act" — which is
      // exactly the confirmation the conflicted-DM 404 in assertDmMayHandle exists
      // to deny. The SUBJECT of a report is usually an ordinary member, so this is
      // the very probe they would reach for. Non-reporters get the same 404 whether
      // or not the report exists; only the reporter, who already knows it exists,
      // sees a 403 for a verb that is not theirs.
      if (report.reporterUserId !== user.id) throw new NotFoundException(`Moderation report ${reportId} not found`);
      if (input.action !== 'escalate') {
        throw new ForbiddenException('Only a DM may act on the moderation queue; you may escalate your own report');
      }
    } else {
      this.assertDmMayHandle(report, user);
    }
    if (report.status === 'resolved' && input.action !== 'escalate') {
      throw new BadRequestException('This report is already resolved; escalate it to reopen the incident upstream');
    }

    const nowTs = nowIso();
    const patch: Partial<typeof moderationReports.$inferInsert> = { updatedAt: nowTs };
    let detail = '';

    switch (input.action) {
      case 'acknowledge':
        patch.status = 'acknowledged';
        patch.acknowledgedAt = nowTs;
        break;

      case 'quarantine':
        this.setTargetQuarantine(report, true, user);
        patch.quarantined = true;
        if (report.status === 'open') patch.status = 'acknowledged';
        if (!report.acknowledgedAt) patch.acknowledgedAt = nowTs;
        detail = 'content withheld from normal reads';
        break;

      case 'unquarantine':
        this.setTargetQuarantine(report, false, user);
        patch.quarantined = false;
        detail = 'content restored to normal reads';
        break;

      case 'mute':
        detail = await this.applyMute(report, input, user);
        break;

      case 'unmute':
        detail = await this.liftMute(report, user);
        break;

      case 'remove':
        this.removeTarget(report, user);
        // Stays `true`: removal sets the quarantine (see removeTarget) precisely so the
        // author cannot restore the takedown away, and the flag is what a later
        // `rejected` resolution keys off to lift it again.
        patch.quarantined = true;
        if (report.status === 'open') patch.status = 'acknowledged';
        detail = 'content removed at source';
        break;

      case 'escalate':
        patch.status = 'escalated';
        patch.escalatedAt = nowTs;
        patch.escalationReason = input.note?.slice(0, 500) || 'escalated for server-admin review';
        detail = patch.escalationReason;
        break;

      case 'resolve': {
        if (!input.resolution) throw new BadRequestException('resolve requires a `resolution`');
        patch.status = 'resolved';
        patch.resolvedAt = nowTs;
        patch.resolution = input.resolution;
        patch.resolutionNote = input.note ?? '';
        // FALSE REPORT (#601's explicit test case): rejecting a report must undo the
        // suppression it caused, or a bad-faith report becomes a permanent mute button.
        if (input.resolution === 'rejected' && report.quarantined) {
          this.setTargetQuarantine(report, false, user);
          patch.quarantined = false;
        }
        detail = `resolution=${input.resolution}`;
        break;
      }
    }

    const [updated] = await this.db
      .update(moderationReports)
      .set(patch)
      .where(eq(moderationReports.id, reportId))
      .returning();

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: `moderation.${input.action}`,
      entityType: 'moderation_report',
      entityId: reportId,
      campaignId,
      detail: detail ? `${detail}` : `status=${updated.status}`,
    });

    return this.toReportDomain(updated, await this.evidenceIntegrityOf(updated.evidenceId));
  }

  // -------------------------------------------------------------------------
  // Server-admin break-glass (bullet 5)
  // -------------------------------------------------------------------------

  /**
   * Escalated incidents, METADATA ONLY, newest-first. This exists so an admin can
   * SEE that something needs attention without being able to browse its contents:
   * knowing "campaign 7 has an open harassment escalation" is operational
   * necessity; reading the words is not, and requires {@link adminBreakGlass}.
   *
   * Listing is itself audited — an admin scrolling the escalation queue leaves a
   * trace, because "not automatic browsing" has to bite somewhere.
   */
  async adminListEscalated(user: RequestUser, opts: { limit?: number; cursor?: string } = {}): Promise<ModerationReportPage> {
    const limit = clampModerationListLimit(opts.limit);
    const cursor = decodeModerationCursor(opts.cursor);
    const base = [eq(moderationReports.status, 'escalated')];
    const pageConds = cursor ? [...base, lt(moderationReports.id, cursor.i)] : base;
    const [countRows, fetched] = await Promise.all([
      this.db.select({ value: count() }).from(moderationReports).where(and(...base)),
      this.db
        .select()
        .from(moderationReports)
        .where(and(...pageConds))
        .orderBy(desc(moderationReports.id))
        .limit(limit + 1),
    ]);
    const total = countRows[0]?.value ?? 0;
    const page = buildCursorListPage(fetched, limit, total, (last) => ({ v: 1, m: 'id', i: last.id }));
    const integrity = await this.evidenceIntegrityFor(page.items.map((r) => r.evidenceId));

    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'admin',
      action: 'moderation.admin.list',
      entityType: 'moderation_report',
      detail: `escalated queue, returned=${page.items.length}, total=${total}`,
    });

    return {
      ...page,
      items: page.items.map((row) => this.toReportDomain(row, integrity.get(row.evidenceId) ?? 'tampered')),
    };
  }

  /**
   * BREAK-GLASS: a server admin reads one incident in full, across campaign
   * boundaries, including evidence content.
   *
   * Deliberately NOT a browsing surface. It is:
   *   - per-incident (an explicit report id, no list-with-content variant);
   *   - refused without a substantive written `justification` — a required, recorded
   *     reason is what separates "I broke glass because X" from ambient access;
   *   - audited on EVERY invocation, with the justification, at BOTH scopes: a
   *     campaign-scoped row so the campaign's own trail shows an outside reader
   *     arrived, and a server-scoped row so the server-admin trail shows it too.
   *     The issue's complaint that "campaign audit is DM-only while server-admin
   *     audit excludes campaign rows" is exactly this blind spot; writing both ends
   *     closes it without merging the two access levels.
   */
  async adminBreakGlass(reportId: number, justification: string, user: RequestUser): Promise<ModerationIncidentExport> {
    const reason = justification.trim();
    if (reason.length < 10) {
      throw new BadRequestException(
        'Break-glass access requires a written justification of at least 10 characters; it is recorded in the audit log.',
      );
    }
    const [report] = await this.db.select().from(moderationReports).where(eq(moderationReports.id, reportId)).limit(1);
    if (!report) throw new NotFoundException(`Moderation report ${reportId} not found`);

    const actor = auditActor(user);
    const bundle = await this.buildIncidentExport(report, { actor, actorRole: 'admin' });

    // Campaign-scoped row: the campaign's own audit trail must show that a
    // server admin read one of its incidents.
    await this.audit.log({
      actor,
      actorRole: 'admin',
      action: 'moderation.breakglass',
      entityType: 'moderation_report',
      entityId: reportId,
      campaignId: report.campaignId,
      detail: `justification=${reason.slice(0, 400)}`,
    });
    // Server-scoped row (campaignId null): the server-admin trail excludes campaign
    // rows, so without this the admin console would never show its own break-glass.
    await this.audit.log({
      actor,
      actorRole: 'admin',
      action: 'moderation.breakglass',
      entityType: 'moderation_report',
      entityId: reportId,
      campaignId: null,
      detail: `campaign=${report.campaignId}, integrity=${bundle.evidence.integrity}, justification=${reason.slice(0, 400)}`,
    });

    return bundle;
  }

  /** Server-admin resolution of an escalated incident — the far end of the escalation path. */
  async adminResolve(
    reportId: number,
    input: ModerationActionRequest,
    user: RequestUser,
  ): Promise<ModerationReport> {
    if (input.action !== 'resolve') throw new BadRequestException('Break-glass supports only the `resolve` action');
    if (!input.resolution) throw new BadRequestException('resolve requires a `resolution`');
    const [report] = await this.db.select().from(moderationReports).where(eq(moderationReports.id, reportId)).limit(1);
    if (!report) throw new NotFoundException(`Moderation report ${reportId} not found`);

    const nowTs = nowIso();
    if (input.resolution === 'rejected' && report.quarantined) {
      this.setTargetQuarantine(report, false, user);
    }
    const [updated] = await this.db
      .update(moderationReports)
      .set({
        status: 'resolved',
        resolvedAt: nowTs,
        resolution: input.resolution,
        resolutionNote: input.note ?? '',
        quarantined: input.resolution === 'rejected' ? false : report.quarantined,
        updatedAt: nowTs,
      })
      .where(eq(moderationReports.id, reportId))
      .returning();

    for (const campaignId of [report.campaignId, null]) {
      await this.audit.log({
        actor: auditActor(user),
        actorRole: 'admin',
        action: 'moderation.admin.resolve',
        entityType: 'moderation_report',
        entityId: reportId,
        campaignId,
        detail: `resolution=${input.resolution}`,
      });
    }
    return this.toReportDomain(updated, await this.evidenceIntegrityOf(updated.evidenceId));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The two gates every DM-side evidence/action path shares.
   *
   * CONFLICTED DM: a DM who is the SUBJECT of a report has no authority over it —
   * not to read its evidence, not to quarantine it, not to resolve it. 404 rather
   * than 403 so the accused cannot even confirm a report exists and go looking for
   * the reporter; the incident is instead visible to server admins via break-glass.
   *
   * ESCALATED: once an incident leaves DM jurisdiction it stays gone, for every DM
   * at the table, not just the accused one.
   */
  private assertDmMayHandle(report: typeof moderationReports.$inferSelect, user: RequestUser): void {
    if (report.subjectUserId && report.subjectUserId === user.id) {
      throw new NotFoundException(`Moderation report ${report.id} not found`);
    }
    if (report.status === 'escalated') {
      throw new ForbiddenException(
        'This report has been escalated for server-admin review and is no longer visible to campaign DMs.',
      );
    }
  }

  private async loadReportRow(campaignId: number, reportId: number): Promise<typeof moderationReports.$inferSelect> {
    const [row] = await this.db
      .select()
      .from(moderationReports)
      .where(and(eq(moderationReports.id, reportId), eq(moderationReports.campaignId, campaignId)))
      .limit(1);
    if (!row) throw new NotFoundException(`Moderation report ${reportId} not found`);
    return row;
  }

  private toReportDomain(
    row: typeof moderationReports.$inferSelect,
    evidenceIntegrity: ModerationReport['evidenceIntegrity'],
  ): ModerationReport {
    return {
      id: row.id,
      campaignId: row.campaignId,
      targetType: row.targetType as ModerationTargetType,
      targetId: row.targetId,
      reporterUserId: row.reporterUserId,
      reporterName: row.reporterName,
      subjectUserId: row.subjectUserId,
      subjectName: row.subjectName,
      reason: row.reason as ModerationReport['reason'],
      details: row.details,
      status: row.status as ModerationReportStatus,
      resolution: (row.resolution as ModerationReport['resolution']) ?? null,
      resolutionNote: row.resolutionNote,
      evidenceId: row.evidenceId,
      evidenceIntegrity,
      quarantined: row.quarantined,
      escalatedAt: row.escalatedAt,
      escalationReason: row.escalationReason,
      acknowledgedAt: row.acknowledgedAt,
      resolvedAt: row.resolvedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Load + verify one snapshot, applying retention lazily. If the row's horizon has
   * passed but no sweep has run, it is redacted HERE, before it is returned —
   * retention that only holds when a background job happens to have fired is not
   * retention.
   */
  private async loadEvidence(
    evidenceId: number,
    actor: { actor: string; actorRole: AuditActorRole },
  ): Promise<ModerationEvidence> {
    let [row] = await this.db.select().from(moderationEvidence).where(eq(moderationEvidence.id, evidenceId)).limit(1);
    if (!row) throw new NotFoundException(`Moderation evidence ${evidenceId} not found`);

    // Lazy retention: an expired snapshot is redacted on the way out rather than
    // served because no sweep has run yet. Gated on the same autoRedactEnabled switch
    // as redactExpired — otherwise turning scheduled redaction off would change
    // nothing, since every read would still redact.
    const autoRedact = this.readStoredRetention(this.db).autoRedactEnabled ?? true;
    if (autoRedact && row.redactedAt == null && row.expiresAt != null && row.expiresAt <= nowIso()) {
      const nowTs = nowIso();
      await this.db
        .update(moderationEvidence)
        .set({
          content: MODERATION_REDACTED_CONTENT,
          redactedAt: nowTs,
          redactedBy: 'system:retention',
          redactionReason: 'retention expiry',
        })
        .where(and(eq(moderationEvidence.id, evidenceId), isNull(moderationEvidence.redactedAt)));
      await this.audit.log({
        actor: actor.actor,
        actorRole: actor.actorRole,
        action: 'moderation.evidence.redact',
        entityType: 'moderation_evidence',
        entityId: evidenceId,
        campaignId: row.campaignId,
        detail: 'retention expiry (applied on read)',
      });
      [row] = await this.db.select().from(moderationEvidence).where(eq(moderationEvidence.id, evidenceId)).limit(1);
    }

    return this.toEvidenceDomain(row);
  }

  private toEvidenceDomain(row: typeof moderationEvidence.$inferSelect): ModerationEvidence {
    const context = this.parseContext(row.contextJson);
    const integrity = verifyModerationEvidence(
      {
        campaignId: row.campaignId,
        targetType: row.targetType,
        targetId: row.targetId,
        reason: row.reason,
        source: row.source,
        authorUserId: row.authorUserId,
        authorName: row.authorName,
        recipientUserId: row.recipientUserId,
        anchorEntityType: row.anchorEntityType,
        anchorEntityId: row.anchorEntityId,
        revisionAt: row.revisionAt,
        capturedAt: row.capturedAt,
        context,
        content: row.content,
      },
      row.contentHash,
      row.redactedAt,
      row.metadataHash,
    );
    return {
      id: row.id,
      campaignId: row.campaignId,
      targetType: row.targetType as ModerationTargetType,
      targetId: row.targetId,
      reason: row.reason as ModerationEvidenceReason,
      source: row.source as ModerationEvidence['source'],
      authorUserId: row.authorUserId,
      authorName: row.authorName,
      recipientUserId: row.recipientUserId,
      anchorEntityType: row.anchorEntityType,
      anchorEntityId: row.anchorEntityId,
      revisionAt: row.revisionAt,
      content: row.content,
      context,
      contentHash: row.contentHash,
      integrity,
      redactedAt: row.redactedAt,
      redactedBy: row.redactedBy,
      redactionReason: row.redactionReason,
      expiresAt: row.expiresAt,
      capturedAt: row.capturedAt,
    };
  }

  private parseContext(raw: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /** Integrity verdict for one snapshot, WITHOUT returning its content (queue rows). */
  private async evidenceIntegrityOf(evidenceId: number): Promise<ModerationReport['evidenceIntegrity']> {
    return (await this.evidenceIntegrityFor([evidenceId])).get(evidenceId) ?? 'tampered';
  }

  private async evidenceIntegrityFor(ids: number[]): Promise<Map<number, ModerationReport['evidenceIntegrity']>> {
    const out = new Map<number, ModerationReport['evidenceIntegrity']>();
    const unique = [...new Set(ids)];
    if (unique.length === 0) return out;
    const rows = await this.db.select().from(moderationEvidence).where(inArray(moderationEvidence.id, unique));
    for (const row of rows) out.set(row.id, this.toEvidenceDomain(row).integrity);
    return out;
  }

  private async buildIncidentExport(
    report: typeof moderationReports.$inferSelect,
    actor: { actor: string; actorRole: AuditActorRole },
  ): Promise<ModerationIncidentExport> {
    const evidence = await this.loadEvidence(report.evidenceId, actor);

    // Every LATER snapshot of the same target. This is what makes the pre-mutation
    // hooks worth having: the reviewer's central question is "what did they change
    // after they were reported", and without collecting these the pre_edit /
    // pre_delete captures would be write-only. Restricted to snapshots taken at or
    // after this report's own capture so an older, unrelated incident's evidence
    // never bleeds into this bundle.
    const additionalRows =
      report.targetId == null
        ? []
        : await this.db
            .select()
            .from(moderationEvidence)
            .where(
              and(
                eq(moderationEvidence.campaignId, report.campaignId),
                eq(moderationEvidence.targetType, report.targetType),
                eq(moderationEvidence.targetId, report.targetId),
                ne(moderationEvidence.id, report.evidenceId),
                sql`${moderationEvidence.capturedAt} >= ${evidence.capturedAt}`,
              ),
            )
            .orderBy(asc(moderationEvidence.id));
    const additionalEvidence = additionalRows.map((row) => this.toEvidenceDomain(row));

    const evidenceIds = [report.evidenceId, ...additionalRows.map((r) => r.id)];
    const timelineRows = await this.db
      .select()
      .from(auditLog)
      .where(
        or(
          and(eq(auditLog.entityType, 'moderation_report'), eq(auditLog.entityId, report.id)),
          and(eq(auditLog.entityType, 'moderation_evidence'), inArray(auditLog.entityId, evidenceIds)),
        ),
      )
      .orderBy(asc(auditLog.id));

    return {
      report: this.toReportDomain(report, evidence.integrity),
      evidence,
      additionalEvidence,
      timeline: timelineRows.map((row) => toAuditEntry(row)),
      exportedAt: nowIso(),
      exportedBy: actor.actor,
    };
  }

  /** Does this identity currently hold the dm role in this campaign? */
  private async holdsDmRole(campaignId: number, userId: string): Promise<boolean> {
    const numeric = Number(userId);
    if (!Number.isInteger(numeric) || numeric <= 0) {
      // DEV_AUTH synthetic identities (`dev:<name>`) have no campaign_members row;
      // their role travels on the request header and cannot be resolved from a
      // stored id. Treat as non-DM: the per-request conflicted-DM check in
      // assertDmMayHandle still fires for them on every read and action, so the
      // protection holds — this only affects the auto-escalate-at-creation shortcut.
      return false;
    }
    const [row] = await this.db
      .select({ role: campaignMembers.role })
      .from(campaignMembers)
      .where(and(eq(campaignMembers.campaignId, campaignId), eq(campaignMembers.userId, numeric)))
      .limit(1);
    return row?.role === 'dm';
  }

  // ---- target resolution -----------------------------------------------------

  private async resolveTarget(
    campaignId: number,
    input: ModerationReportCreate,
    user: RequestUser,
    role: Role,
  ): Promise<ResolvedTarget> {
    const serverCaptured = MODERATION_SERVER_CAPTURED_TARGETS.includes(input.targetType);
    if (serverCaptured) {
      if (input.content !== undefined) {
        throw new BadRequestException(
          `\`content\` is not accepted for a ${input.targetType} report — the server captures the content itself`,
        );
      }
      if (input.subjectUserId !== undefined) {
        throw new BadRequestException(
          `\`subjectUserId\` is not accepted for a ${input.targetType} report — the server resolves the author itself`,
        );
      }
      if (input.targetId == null) throw new BadRequestException(`\`targetId\` is required for a ${input.targetType} report`);
    }

    switch (input.targetType) {
      case 'comment':
        return this.resolveCommentTarget(campaignId, input.targetId!, role);
      case 'note':
      case 'whisper':
        return this.resolveNoteTarget(campaignId, input.targetId!, input.targetType, user, role);
      case 'notification':
        return this.resolveNotificationTarget(campaignId, input.targetId!, user);
      case 'ai_narration':
      case 'conduct':
        return this.resolveReporterSuppliedTarget(campaignId, input);
    }
  }

  private async resolveCommentTarget(campaignId: number, targetId: number, role: Role): Promise<ResolvedTarget> {
    const [row] = await this.db
      .select()
      .from(comments)
      .where(and(eq(comments.id, targetId), eq(comments.campaignId, campaignId)))
      .limit(1);
    // Uniform 404 whether the comment is missing, in another campaign, or anchored
    // to an entity the reporter cannot see (issue #230's convention). A tombstoned
    // or quarantined comment IS reportable — reporting content that was just deleted
    // is the central case #601 exists for.
    if (!row) throw new NotFoundException(`Comment ${targetId} not found`);
    await assertAnchorVisible(this.db, campaignId, row.entityType as EntityType, row.entityId, role);
    return { targetType: 'comment', targetId, authorUserId: row.authorUserId, authorName: row.authorName };
  }

  private async resolveNoteTarget(
    campaignId: number,
    targetId: number,
    targetType: 'note' | 'whisper',
    user: RequestUser,
    role: Role,
  ): Promise<ResolvedTarget> {
    const [row] = await this.db
      .select()
      .from(notes)
      .where(and(eq(notes.id, targetId), eq(notes.campaignId, campaignId)))
      .limit(1);
    const notFound = new NotFoundException(`Note ${targetId} not found`);
    if (!row) throw notFound;
    // Same visibility rule the note's own GET applies — reporting must never be a
    // way to confirm that someone else's private note or whisper exists.
    if (!canSee(row, user, role)) throw notFound;
    // The label must match reality: a whisper report must name a whisper. A mismatch
    // 404s (rather than 400s) so the response cannot be used to probe visibility.
    if (noteTargetType(row.visibility) !== targetType) throw notFound;
    return { targetType, targetId, authorUserId: row.authorUserId, authorName: row.authorName };
  }

  private async resolveNotificationTarget(
    campaignId: number,
    targetId: number,
    user: RequestUser,
  ): Promise<ResolvedTarget> {
    const recipient = Number(user.id);
    const notFound = new NotFoundException(`Notification ${targetId} not found`);
    if (!Number.isInteger(recipient) || recipient <= 0) throw notFound;
    const [row] = await this.db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.id, targetId),
          eq(notifications.campaignId, campaignId),
          // You may only report a notification DELIVERED TO YOU. Anything looser
          // would turn the report endpoint into a read of other people's bells.
          eq(notifications.userId, recipient),
        ),
      )
      .limit(1);
    if (!row) throw notFound;
    return {
      targetType: 'notification',
      targetId,
      // A safety hold must never become a moderation-mute target merely because
      // its notification retained attribution for later relabeling. System and
      // anonymous notifications remain intentionally un-attributed as well.
      authorUserId: row.type === 'safety_hold' ? '' : (row.actorUserId ?? ''),
      authorName: row.actorName,
    };
  }

  private async resolveReporterSuppliedTarget(
    campaignId: number,
    input: ModerationReportCreate,
  ): Promise<ResolvedTarget> {
    const content = (input.content ?? '').trim();
    if (!content) {
      throw new BadRequestException(
        `\`content\` is required for a ${input.targetType} report — the server has no stored row to snapshot`,
      );
    }
    let subjectUserId = '';
    let subjectName = '';
    if (input.subjectUserId) {
      if (input.targetType !== 'conduct') {
        throw new BadRequestException('`subjectUserId` is only accepted for a conduct report');
      }
      const named = await this.lookupMemberName(campaignId, input.subjectUserId);
      if (!named) throw new BadRequestException('`subjectUserId` must name a member of this campaign');
      subjectUserId = input.subjectUserId;
      subjectName = named;
    }
    return {
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      authorUserId: subjectUserId,
      authorName: subjectName,
      reporterSuppliedContent: content,
    };
  }

  private async lookupMemberName(campaignId: number, userId: string): Promise<string | null> {
    if (userId.startsWith('dev:')) return userId.slice(4) || userId;
    const numeric = Number(userId);
    if (!Number.isInteger(numeric) || numeric <= 0) return null;
    const [row] = await this.db
      .select({ displayName: users.displayName, username: users.username })
      .from(campaignMembers)
      .innerJoin(users, eq(campaignMembers.userId, users.id))
      .where(and(eq(campaignMembers.campaignId, campaignId), eq(campaignMembers.userId, numeric)))
      .limit(1);
    if (!row) return null;
    return row.displayName || row.username || String(numeric);
  }

  /**
   * Re-read the target row inside the report transaction and build the capture
   * payload from THAT read — never from the row fetched during the earlier async
   * authorization. See captureEvidenceTx's race note for why this matters.
   */
  private rereadCaptureTx(tx: ModerationTx, campaignId: number, resolved: ResolvedTarget): ModerationCaptureInput {
    if (resolved.reporterSuppliedContent !== undefined) {
      return {
        campaignId,
        targetType: resolved.targetType,
        targetId: resolved.targetId,
        reason: 'report',
        source: 'reporter_supplied',
        authorUserId: resolved.authorUserId,
        authorName: resolved.authorName,
        recipientUserId: null,
        anchorEntityType: null,
        anchorEntityId: null,
        revisionAt: '',
        content: resolved.reporterSuppliedContent,
        context: { provenance: 'supplied by the reporter; the server did not observe this content' },
      };
    }

    if (resolved.targetType === 'comment') {
      const [row] = tx.select().from(comments).where(eq(comments.id, resolved.targetId!)).limit(1).all();
      if (row) return { ...this.commentCaptureInput(row, 'report') };
    } else if (resolved.targetType === 'note' || resolved.targetType === 'whisper') {
      const [row] = tx.select().from(notes).where(eq(notes.id, resolved.targetId!)).limit(1).all();
      if (row) return { ...this.noteCaptureInput(row, 'report') };
    } else if (resolved.targetType === 'notification') {
      const [row] = tx.select().from(notifications).where(eq(notifications.id, resolved.targetId!)).limit(1).all();
      if (row) {
        return {
          campaignId,
          targetType: 'notification',
          targetId: row.id,
          reason: 'report',
          source: 'server_capture',
          authorUserId: row.type === 'safety_hold' ? '' : (row.actorUserId ?? ''),
          authorName: row.actorName,
          recipientUserId: String(row.userId),
          anchorEntityType: row.entityType,
          anchorEntityId: row.entityId,
          revisionAt: row.createdAt,
          content: [row.title, row.body].filter(Boolean).join('\n\n'),
          context: { notificationType: row.type, commentId: row.commentId, createdAt: row.createdAt },
        };
      }
    }

    // Unreachable for comments/notes (both soft-delete, so the row survives) but
    // handled rather than thrown: an abuser who somehow destroyed the row must not
    // also get to prevent the report from being filed. The empty snapshot records
    // that the content was already gone when we looked.
    return {
      campaignId,
      targetType: resolved.targetType,
      targetId: resolved.targetId,
      reason: 'report',
      source: 'server_capture',
      authorUserId: resolved.authorUserId,
      authorName: resolved.authorName,
      recipientUserId: null,
      anchorEntityType: null,
      anchorEntityId: null,
      revisionAt: '',
      content: '',
      context: { missingAtCapture: true },
    };
  }

  // ---- action effects --------------------------------------------------------

  /**
   * Set or clear quarantine on the report's target, capturing a pre-mutation
   * snapshot in the SAME transaction as the content change (the moderator's own
   * action is evidence too).
   *
   * Quarantine genuinely withholds: for a comment the body reads back as
   * QUARANTINE_BODY through the single toDomain chokepoint and the campaign search
   * index skips the row; for a note/whisper the row is dropped from every normal
   * read exactly like a trashed one — including from its own author and, for a
   * whisper, its recipient, since shielding the recipient is the entire point.
   */
  private setTargetQuarantine(
    report: typeof moderationReports.$inferSelect,
    on: boolean,
    user: RequestUser,
  ): void {
    const targetType = report.targetType as ModerationTargetType;
    if (report.targetId == null || !MODERATION_SERVER_CAPTURED_TARGETS.includes(targetType) || targetType === 'notification') {
      throw new BadRequestException(
        'Quarantine applies only to a comment, note, or whisper — this report has no withholdable content',
      );
    }
    const nowTs = nowIso();
    const actor = auditActor(user);

    this.db.transaction((tx) => {
      if (targetType === 'comment') {
        const [row] = tx.select().from(comments).where(eq(comments.id, report.targetId!)).limit(1).all();
        if (!row) throw new NotFoundException(`Comment ${report.targetId} not found`);
        if (on) this.captureEvidenceTx(tx, this.commentCaptureInput(row, 'pre_quarantine'));
        tx.update(comments)
          .set({ quarantinedAt: on ? nowTs : null, quarantinedBy: on ? actor : null })
          .where(eq(comments.id, report.targetId!))
          .run();
        return;
      }
      const [row] = tx.select().from(notes).where(eq(notes.id, report.targetId!)).limit(1).all();
      if (!row) throw new NotFoundException(`Note ${report.targetId} not found`);
      if (on) this.captureEvidenceTx(tx, this.noteCaptureInput(row, 'pre_quarantine'));
      tx.update(notes)
        .set({ quarantinedAt: on ? nowTs : null, quarantinedBy: on ? actor : null })
        .where(eq(notes.id, report.targetId!))
        .run();
    });
  }

  /**
   * `remove`: take the content down at source. Uses each surface's OWN removal
   * semantics rather than a hard delete — a comment is tombstoned so replies keep
   * their parent (#503), a note is trashed (#116) — so removal stays reversible while
   * the evidence snapshot preserves what was said.
   *
   * Removal also SETS the quarantine rather than clearing it. Soft-delete alone is
   * reversible by the author (`POST /comments/:id/restore`, `POST /notes/:id/restore`
   * are author-or-DM and author-only respectively), so a `remove` that cleared the
   * flag would let the reported member undo the moderator's takedown a second later
   * and put the content straight back in front of the person who reported it. The
   * quarantine is what makes the removal stick: both restore paths refuse while it is
   * set. It is lifted the same way any other quarantine is — by `unquarantine`, or
   * automatically when the report resolves as `rejected`, which is precisely the case
   * where the content SHOULD become restorable again.
   */
  private removeTarget(report: typeof moderationReports.$inferSelect, user: RequestUser): void {
    const targetType = report.targetType as ModerationTargetType;
    if (report.targetId == null || targetType === 'notification' || !MODERATION_SERVER_CAPTURED_TARGETS.includes(targetType)) {
      throw new BadRequestException('Remove applies only to a comment, note, or whisper');
    }
    const nowTs = nowIso();
    const actor = auditActor(user);
    this.db.transaction((tx) => {
      if (targetType === 'comment') {
        const [row] = tx.select().from(comments).where(eq(comments.id, report.targetId!)).limit(1).all();
        if (!row) throw new NotFoundException(`Comment ${report.targetId} not found`);
        this.captureEvidenceTx(tx, this.commentCaptureInput(row, 'pre_remove'));
        tx.update(comments)
          .set({
            deletedAt: nowTs,
            deletedBy: actor,
            quarantinedAt: row.quarantinedAt ?? nowTs,
            quarantinedBy: row.quarantinedBy ?? actor,
          })
          .where(eq(comments.id, report.targetId!))
          .run();
        return;
      }
      const [row] = tx.select().from(notes).where(eq(notes.id, report.targetId!)).limit(1).all();
      if (!row) throw new NotFoundException(`Note ${report.targetId} not found`);
      this.captureEvidenceTx(tx, this.noteCaptureInput(row, 'pre_remove'));
      tx.update(notes)
        .set({
          deletedAt: nowTs,
          updatedAt: nowTs,
          quarantinedAt: row.quarantinedAt ?? nowTs,
          quarantinedBy: row.quarantinedBy ?? actor,
        })
        .where(eq(notes.id, report.targetId!))
        .run();
    });
  }

  private async applyMute(
    report: typeof moderationReports.$inferSelect,
    input: ModerationActionRequest,
    user: RequestUser,
  ): Promise<string> {
    if (!report.subjectUserId) {
      throw new BadRequestException(
        'This report has no machine-identified subject, so there is nobody to mute. Use `remove`, or file a conduct report naming the member.',
      );
    }
    const nowTs = nowIso();
    const expiresAt = input.muteHours ? new Date(Date.now() + input.muteHours * 3600_000).toISOString() : null;
    await this.db.insert(moderationMutes).values({
      campaignId: report.campaignId,
      userId: report.subjectUserId,
      userName: report.subjectName,
      reason: input.note ?? '',
      expiresAt,
      createdBy: auditActor(user),
      createdAt: nowTs,
    });
    return `muted ${report.subjectUserId} until ${expiresAt ?? 'lifted'}`;
  }

  private async liftMute(report: typeof moderationReports.$inferSelect, user: RequestUser): Promise<string> {
    if (!report.subjectUserId) throw new BadRequestException('This report has no machine-identified subject to unmute');
    const nowTs = nowIso();
    await this.db
      .update(moderationMutes)
      .set({ liftedAt: nowTs, liftedBy: auditActor(user) })
      .where(
        and(
          eq(moderationMutes.campaignId, report.campaignId),
          eq(moderationMutes.userId, report.subjectUserId),
          isNull(moderationMutes.liftedAt),
        ),
      );
    return `unmuted ${report.subjectUserId}`;
  }

  // ---- retention settings (sync, so the capture path can read them in a tx) ----

  private readStoredRetention(reader: ModerationReader): ModerationRetentionPolicyUpdate {
    const rows = reader
      .select()
      .from(settings)
      .where(eq(settings.key, MODERATION_RETENTION_SETTINGS_KEY))
      .limit(1)
      .all();
    if (rows.length === 0) return {};
    try {
      const raw = JSON.parse(rows[0].value) as Record<string, unknown>;
      const out: ModerationRetentionPolicyUpdate = {};
      if (Number.isInteger(raw.days)) out.days = raw.days as number;
      if (typeof raw.autoRedactEnabled === 'boolean') out.autoRedactEnabled = raw.autoRedactEnabled;
      return out;
    } catch {
      return {};
    }
  }

  private writeStoredRetention(value: ModerationRetentionPolicyUpdate): void {
    const json = JSON.stringify(value);
    const existing = this.db.select().from(settings).where(eq(settings.key, MODERATION_RETENTION_SETTINGS_KEY)).limit(1).all();
    if (existing.length > 0) {
      this.db.update(settings).set({ value: json }).where(eq(settings.key, MODERATION_RETENTION_SETTINGS_KEY)).run();
    } else {
      this.db.insert(settings).values({ key: MODERATION_RETENTION_SETTINGS_KEY, value: json }).run();
    }
  }

  /**
   * The retention horizon stamped on a new snapshot, resolved SYNCHRONOUSLY so it can
   * be computed inside the capture transaction. Order of precedence mirrors
   * getRetentionPolicy(): a stored moderation override, else the stored audit
   * retention days, else AUDIT_RETENTION_DAYS from the environment, else the shared
   * default. `days <= 0` means "no expiry" and stores null.
   */
  private computeExpiry(reader: ModerationReader, capturedAt: string): string | null {
    const days = this.readStoredRetention(reader).days ?? this.readAuditRetentionDays(reader);
    if (!Number.isFinite(days) || days <= 0) return null;
    return new Date(Date.parse(capturedAt) + days * 24 * 60 * 60 * 1000).toISOString();
  }

  private readAuditRetentionDays(reader: ModerationReader): number {
    const rows = reader.select().from(settings).where(eq(settings.key, 'audit.retention')).limit(1).all();
    if (rows.length > 0) {
      try {
        const raw = JSON.parse(rows[0].value) as Record<string, unknown>;
        if (Number.isInteger(raw.days)) return raw.days as number;
      } catch {
        // fall through to env/default
      }
    }
    const envRaw = process.env.AUDIT_RETENTION_DAYS;
    if (envRaw !== undefined && envRaw !== '') {
      const n = Number(envRaw);
      if (Number.isFinite(n)) return n;
    }
    return DEFAULT_AUDIT_RETENTION_DAYS;
  }
}

/** What target resolution produced, before the transactional re-read. */
interface ResolvedTarget {
  targetType: ModerationTargetType;
  targetId: number | null;
  authorUserId: string;
  authorName: string;
  /** Set only for `ai_narration` / `conduct`, whose bytes the server never observed. */
  reporterSuppliedContent?: string;
}
