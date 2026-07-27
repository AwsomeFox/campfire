import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type {
  CharterAcknowledgmentState,
  CharterPreview,
  CharterPreviewPolicy,
  SessionZeroAcknowledgment,
  SessionZeroAcknowledgmentInput,
  SessionZeroBoundarySubmission,
  SessionZeroBoundarySubmissionCreate,
  SessionZeroCharterVersion,
  SessionZeroConsentStatus,
  SessionZeroGuardianConsent,
  SessionZeroGuardianConsentDecision,
  SessionZeroGuardianConsentRequest,
} from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import {
  campaignMembers,
  campaigns,
  sessionZero,
  sessionZeroAcknowledgments,
  sessionZeroBoundarySubmissions,
  sessionZeroCharterVersions,
  sessionZeroGuardianConsents,
  users,
} from '../../db/schema';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { auditActor, type RequestUser } from '../../common/user.types';
import { nowIso } from '../../common/time';
import { fromJsonText, toJsonText } from '../../common/json';
import {
  EMPTY_CHARTER,
  charterUnchanged,
  diffCharters,
  isMaterialCharterChange,
  outstandingAcknowledgers,
  resolveEffectiveVersion,
  type AckLookup,
  type CharterFields,
} from './charter-versions';

type VersionRow = typeof sessionZeroCharterVersions.$inferSelect;

/**
 * Issue #600 — the session-zero consent lifecycle.
 *
 * WHAT WAS WRONG
 * --------------
 * The charter was one mutable row. A participant could not see it before joining (the
 * invite preview showed a name and a role), and once inside, the thing they had agreed
 * to could be rewritten with no trace. "They consented" had no referent.
 *
 * THE SHAPE OF THE FIX
 * --------------------
 * `session_zero` stays as the DM's working DRAFT — editing it is cheap, private to the
 * DM's own process, and consents to nothing. PUBLISHING snapshots the draft into an
 * immutable `session_zero_charter_versions` row. Acknowledgments point at one version
 * id. That indirection is the whole feature: it is what makes "renewed acknowledgment
 * after a material change" expressible, and what lets the AI be bound by the version
 * people actually accepted rather than whatever the DM last typed.
 *
 * The two rules — what counts as material, and which version is effective — live in
 * charter-versions.ts as pure functions so they can be read and tested on their own.
 */
@Injectable()
export class SessionZeroConsentService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // ------------------------------------------------------------------ versions

  async listVersions(campaignId: number): Promise<SessionZeroCharterVersion[]> {
    const rows = await this.db
      .select()
      .from(sessionZeroCharterVersions)
      .where(eq(sessionZeroCharterVersions.campaignId, campaignId))
      .orderBy(desc(sessionZeroCharterVersions.version));
    return rows.map(toVersion);
  }

  async getVersion(campaignId: number, versionId: number): Promise<SessionZeroCharterVersion> {
    const [row] = await this.db
      .select()
      .from(sessionZeroCharterVersions)
      .where(and(eq(sessionZeroCharterVersions.id, versionId), eq(sessionZeroCharterVersions.campaignId, campaignId)))
      .limit(1);
    if (!row) throw new NotFoundException('Charter version not found');
    return toVersion(row);
  }

  /**
   * Publish the current draft as the next immutable version.
   *
   * Materiality is computed HERE, from the previous version, and frozen onto the row —
   * never self-declared by the DM and never recomputed on read. A DM-declared flag would
   * make the safety gate optional in practice, and recomputation would mean a rule change
   * could retroactively un-gate a version people were already asked about.
   */
  async publish(
    campaignId: number,
    input: { changeSummary: string },
    user: RequestUser,
  ): Promise<SessionZeroCharterVersion> {
    const draft = await this.draftFields(campaignId);
    if (isEmptyCharter(draft)) {
      throw new BadRequestException('Cannot publish an empty charter — record lines, veils or safety tools first');
    }

    const [previous] = await this.db
      .select()
      .from(sessionZeroCharterVersions)
      .where(eq(sessionZeroCharterVersions.campaignId, campaignId))
      .orderBy(desc(sessionZeroCharterVersions.version))
      .limit(1);

    const before: CharterFields = previous ? versionFields(previous) : EMPTY_CHARTER;
    if (previous && charterUnchanged(before, draft)) {
      throw new BadRequestException('The draft is identical to the current published version');
    }

    const material = previous ? isMaterialCharterChange(before, draft) : false;
    const ts = nowIso();
    const nextVersion = (previous?.version ?? 0) + 1;

    // One transaction: the version row and its number are allocated together, so two
    // concurrent publishes cannot both claim the same version (UNIQUE(campaign_id,
    // version) is the backstop).
    let inserted: VersionRow;
    try {
      inserted = this.db.transaction((tx) =>
        tx
          .insert(sessionZeroCharterVersions)
          .values({
            campaignId,
            version: nextVersion,
            lines: toJsonText(draft.lines),
            veils: toJsonText(draft.veils),
            safetyTools: toJsonText(draft.safetyTools),
            houseRules: draft.houseRules,
            toneAndExpectations: draft.toneAndExpectations,
            material,
            changeSummary: input.changeSummary.slice(0, 2000),
            publishedBy: auditActor(user),
            publishedAt: ts,
          })
          .returning()
          .get(),
      );
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
        throw new ConflictException(
          'Another charter version was published concurrently — reload and try again.',
        );
      }
      throw err;
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'dm',
      action: 'session_zero.charter.publish',
      entityType: 'session_zero_charter_version',
      entityId: inserted.id,
      campaignId,
      detail: `version=${nextVersion}, material=${material}`,
    });

    // Best-effort, post-commit, exactly like every other notification in the repo. The
    // `charter_published` type maps to the always-on `access` category, so a material
    // change cannot be muted into silence or deferred into a digest that lands after the
    // session it was supposed to gate.
    const diff = diffCharters(before, draft, previous?.version ?? 0, nextVersion);
    await this.notifications.notifyCampaign(campaignId, user, {
      type: 'charter_published',
      title: material ? 'Charter changed — your acknowledgment is needed' : 'Charter updated',
      body: material
        ? `Version ${nextVersion} withdrew a protection: ${[...diff.removedLines, ...diff.removedVeils, ...diff.removedSafetyTools]
            .slice(0, 3)
            .join('; ')
            .slice(0, 400)}`
        : `Version ${nextVersion} published.`,
      // NotificationEvent.entityType is a closed enum that has no session-zero member;
      // 'campaign' + the campaign id is the honest existing anchor, and it is what the
      // client already knows how to deep-link.
      entityType: 'campaign',
      entityId: campaignId,
      actorName: user.name ?? '',
    });

    return toVersion(inserted);
  }

  // ------------------------------------------------------------------ consent gate

  /**
   * Who must acknowledge for the gate to clear: seated DMs and players.
   *
   * Viewers are excluded deliberately — they watch, they do not play, and letting a
   * spectator's silence block a table's session would make the gate something DMs route
   * around rather than use. Dev-auth (`dev:*`) principals have no membership row, so a
   * DEV_AUTH campaign yields an empty required set and the gate clears vacuously; that
   * is the correct degradation for a mode that has no real identities to consent.
   */
  private async requiredAcknowledgers(campaignId: number): Promise<Array<{ userId: string; userName: string }>> {
    const rows = await this.db
      .select({ userId: campaignMembers.userId, role: campaignMembers.role, username: users.username, displayName: users.displayName })
      .from(campaignMembers)
      .leftJoin(users, eq(users.id, campaignMembers.userId))
      .where(eq(campaignMembers.campaignId, campaignId));
    return rows
      .filter((r) => r.role === 'dm' || r.role === 'player')
      .map((r) => ({ userId: String(r.userId), userName: r.displayName || r.username || '' }));
  }

  /**
   * The version the AI is bound by and what "play" is licensed against: strict all-members
   * resolution first, then the sticky fallback when a newcomer has not yet answered but the
   * rest of the table already licensed a version.
   */
  private resolveBoundVersion(
    versions: SessionZeroCharterVersion[],
    requiredIds: string[],
    acksFor: AckLookup,
  ): SessionZeroCharterVersion | null {
    const strict = resolveEffectiveVersion(versions, requiredIds, acksFor);
    if (strict) return strict;

    const participantsWithAcks = requiredIds.filter((userId) =>
      versions.some((v) => acksFor(v.id).has(userId)),
    );
    if (participantsWithAcks.length === 0) return null;
    return resolveEffectiveVersion(versions, participantsWithAcks, acksFor);
  }

  /** Acknowledgment states for a set of versions, as the pure resolver wants them. */
  private async ackTable(versionIds: number[]): Promise<Map<number, Map<string, CharterAcknowledgmentState>>> {
    const out = new Map<number, Map<string, CharterAcknowledgmentState>>();
    if (versionIds.length === 0) return out;
    const rows = await this.db
      .select()
      .from(sessionZeroAcknowledgments)
      .where(inArray(sessionZeroAcknowledgments.versionId, versionIds));
    for (const row of rows) {
      let per = out.get(row.versionId);
      if (!per) {
        per = new Map();
        out.set(row.versionId, per);
      }
      per.set(row.userId, row.state as CharterAcknowledgmentState);
    }
    return out;
  }

  async consentStatus(campaignId: number, user: RequestUser | null): Promise<SessionZeroConsentStatus> {
    const versions = await this.listVersions(campaignId);
    if (versions.length === 0) {
      return {
        campaignId,
        latestVersion: null,
        effectiveVersion: null,
        awaitingRenewal: false,
        outstanding: [],
        mine: null,
        diff: null,
      };
    }

    const required = await this.requiredAcknowledgers(campaignId);
    const table = await this.ackTable(versions.map((v) => v.id));
    const acksFor = (versionId: number) => table.get(versionId) ?? new Map<string, CharterAcknowledgmentState>();

    const latest = versions[0]; // listVersions is newest-first
    const effective = this.resolveBoundVersion(
      versions,
      required.map((r) => r.userId),
      acksFor,
    );

    const nameOf = new Map(required.map((r) => [r.userId, r.userName]));
    const outstandingEntries = outstandingAcknowledgers(
      latest,
      required.map((r) => r.userId),
      versions,
      acksFor,
    ).map((entry) => ({ userId: entry.userId, userName: nameOf.get(entry.userId) ?? '', state: entry.state }));

    const isFacilitator =
      user !== null &&
      (await this.db
        .select({ role: campaignMembers.role })
        .from(campaignMembers)
        .where(and(eq(campaignMembers.campaignId, campaignId), eq(campaignMembers.userId, Number(user.id))))
        .limit(1)
        .get())?.role === 'dm';
    const outstanding = isFacilitator ? outstandingEntries : [];

    let mine: SessionZeroAcknowledgment | null = null;
    if (user) {
      const [row] = await this.db
        .select()
        .from(sessionZeroAcknowledgments)
        .where(
          and(eq(sessionZeroAcknowledgments.versionId, latest.id), eq(sessionZeroAcknowledgments.userId, user.id)),
        )
        .limit(1);
      if (row) mine = toAck(row, latest.version);
    }

    const awaitingRenewal = effective === null || effective.id !== latest.id;
    const diff = awaitingRenewal
      ? diffCharters(
          effective ? charterOf(effective) : EMPTY_CHARTER,
          charterOf(latest),
          effective?.version ?? 0,
          latest.version,
        )
      : null;

    return { campaignId, latestVersion: latest, effectiveVersion: effective, awaitingRenewal, outstanding, mine, diff };
  }

  /**
   * The charter the AI is bound by: the accepted EFFECTIVE version, never the draft and
   * never an unacknowledged newer version.
   *
   * Three outcomes — callers MUST distinguish them:
   *   - `never_published`: no version rows. Fall back to the DM's draft (pre-#600 behaviour).
   *   - `accepted`: a version everybody required has cleared; bind the AI to that text.
   *   - `unbound`: versions exist but none is licensed. Do NOT fall back to the draft —
   *     the draft is mutable and may have withdrawn protections nobody consented to remove.
   *     Withhold instead (empty boundaries + `charterSource: 'none'`).
   *
   * Sticky agreement: when the full required set has not cleared a gate (e.g. a brand-new
   * player was seated via POST /members with no acknowledgment yet), we still serve the
   * last version agreed by everyone who HAS participated in consent. Seating someone must
   * not silently unbind the AI from a charter the rest of the table already accepted.
   */
  async effectiveCharter(campaignId: number): Promise<
    | { status: 'never_published' }
    | { status: 'accepted'; charter: CharterFields & { version: number } }
    | { status: 'unbound' }
  > {
    const versions = await this.listVersions(campaignId);
    if (versions.length === 0) return { status: 'never_published' };

    const required = await this.requiredAcknowledgers(campaignId);
    const table = await this.ackTable(versions.map((v) => v.id));
    const acksFor = (versionId: number) => table.get(versionId) ?? new Map<string, CharterAcknowledgmentState>();
    const requiredIds = required.map((r) => r.userId);

    const effective = this.resolveBoundVersion(versions, requiredIds, acksFor);
    if (effective) {
      return { status: 'accepted', charter: { ...charterOf(effective), version: effective.version } };
    }

    return { status: 'unbound' };
  }

  async acknowledge(
    campaignId: number,
    input: SessionZeroAcknowledgmentInput,
    user: RequestUser,
  ): Promise<SessionZeroAcknowledgment> {
    const version = await this.getVersion(campaignId, input.versionId);
    if (input.state !== 'acknowledged' && input.note.trim() === '') {
      // An objection with no words is one the DM cannot act on, and a "discuss" that
      // says nothing is indistinguishable from a mis-click.
      throw new BadRequestException('A note is required when choosing discuss or decline');
    }
    return this.recordAcknowledgment(campaignId, version, user, input.state, input.note);
  }

  /** Shared by the member route and the pre-join invite flow. */
  async recordAcknowledgment(
    campaignId: number,
    version: SessionZeroCharterVersion,
    user: RequestUser,
    state: CharterAcknowledgmentState,
    note: string,
  ): Promise<SessionZeroAcknowledgment> {
    const ts = nowIso();
    const userName = user.name ?? '';
    const row = this.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(sessionZeroAcknowledgments)
        .where(
          and(eq(sessionZeroAcknowledgments.versionId, version.id), eq(sessionZeroAcknowledgments.userId, user.id)),
        )
        .limit(1)
        .get();
      if (existing) {
        return tx
          .update(sessionZeroAcknowledgments)
          .set({ state, note: note.slice(0, 2000), userName, updatedAt: ts })
          .where(eq(sessionZeroAcknowledgments.id, existing.id))
          .returning()
          .get();
      }
      return tx
        .insert(sessionZeroAcknowledgments)
        .values({
          campaignId,
          versionId: version.id,
          userId: user.id,
          userName,
          state,
          note: note.slice(0, 2000),
          createdAt: ts,
          updatedAt: ts,
        })
        .returning()
        .get();
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'player',
      action: `session_zero.charter.${state}`,
      entityType: 'session_zero_charter_version',
      entityId: version.id,
      campaignId,
      detail: `version=${version.version}`,
    });
    return toAck(row, version.version);
  }

  // ------------------------------------------------------------------ pre-join preview

  /**
   * The charter as shown at an invite link, to somebody who is not a member and may not
   * even have an account.
   *
   * PRIVACY IS THE WHOLE JOB HERE. This is built as an enumerated projection, exactly
   * like the #587 admin catalog, and for the same reason: "the charter minus a few
   * fields" would ship whatever gets added to the table next. Specifically it never
   * discloses —
   *   - the DM's unpublished DRAFT (only a published version is previewable, so a DM
   *     workshopping a change does not broadcast it to everyone holding a link);
   *   - private boundary submissions, which are facilitator-only by construction and are
   *     not read by this method at all;
   *   - member names, member counts, or who acknowledged what;
   *   - anything outside the charter tables — no description, quests, notes, or sessions.
   * The prose fields (house rules, tone) are additionally gated behind the DM's
   * `previewPolicy`, because they are free text that routinely carries campaign
   * specifics, while lines/veils/safety tools are the safety floor a person needs in
   * order to decline meaningfully.
   */
  async previewForInvite(campaignId: number): Promise<CharterPreview | null> {
    const versions = await this.listVersions(campaignId);
    if (versions.length === 0) return null;

    // The LATEST published version, not the effective one: a prospective member is being
    // asked to agree to the table's current terms, and showing them an older version
    // that happens to be what the existing members are still arguing about would be
    // showing them something they are not being asked about.
    const latest = versions[0];
    const [draftRow] = await this.db
      .select({ previewPolicy: sessionZero.previewPolicy })
      .from(sessionZero)
      .where(eq(sessionZero.campaignId, campaignId))
      .limit(1);
    const [campaign] = await this.db
      .select({ aiExternalContentPolicy: campaigns.aiExternalContentPolicy })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);

    const previewPolicy: CharterPreviewPolicy = draftRow?.previewPolicy === 'full' ? 'full' : 'boundaries';
    const full = previewPolicy === 'full';

    return {
      version: latest.version,
      lines: latest.lines,
      veils: latest.veils,
      safetyTools: latest.safetyTools,
      houseRules: full ? latest.houseRules : '',
      toneAndExpectations: full ? latest.toneAndExpectations : '',
      previewPolicy,
      aiExternalContentPolicy:
        campaign?.aiExternalContentPolicy === 'disabled' ? 'disabled' : 'member_consent',
      publishedAt: latest.publishedAt,
    };
  }

  /** The newest published version, or null — used to gate invite acceptance. */
  async latestVersion(campaignId: number): Promise<SessionZeroCharterVersion | null> {
    const [row] = await this.db
      .select()
      .from(sessionZeroCharterVersions)
      .where(eq(sessionZeroCharterVersions.campaignId, campaignId))
      .orderBy(desc(sessionZeroCharterVersions.version))
      .limit(1);
    return row ? toVersion(row) : null;
  }

  /**
   * Re-validate the charter gate inside a membership transaction so a publish that lands
   * after the outer preview read cannot seat someone against a stale version.
   */
  assertCharterAcknowledgedTx(
    tx: Parameters<Parameters<DrizzleDb['transaction']>[0]>[0],
    campaignId: number,
    acknowledgeVersion?: number,
  ): SessionZeroCharterVersion | null {
    const latest = tx
      .select()
      .from(sessionZeroCharterVersions)
      .where(eq(sessionZeroCharterVersions.campaignId, campaignId))
      .orderBy(desc(sessionZeroCharterVersions.version))
      .limit(1)
      .get();
    if (!latest) return null;
    if (acknowledgeVersion !== latest.version) {
      throw new ConflictException(
        'This table has a session-zero charter you must acknowledge before joining. Reload the invite to see the current version.',
      );
    }
    return toVersion(latest);
  }

  async setPreviewPolicy(campaignId: number, previewPolicy: CharterPreviewPolicy, user: RequestUser): Promise<void> {
    const ts = nowIso();
    const updated = await this.db
      .update(sessionZero)
      .set({ previewPolicy, updatedAt: ts })
      .where(eq(sessionZero.campaignId, campaignId))
      .returning({ campaignId: sessionZero.campaignId });
    if (updated.length === 0) {
      await this.db.insert(sessionZero).values({ campaignId, previewPolicy, createdAt: ts, updatedAt: ts });
    }
    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'dm',
      action: 'session_zero.preview_policy.update',
      entityType: 'session_zero',
      entityId: campaignId,
      campaignId,
      detail: `previewPolicy=${previewPolicy}`,
    });
  }

  // ------------------------------------------------------------------ private boundaries

  /**
   * Boundaries the facilitator can see, with anonymity honoured by DROPPING the
   * submitter rather than merely not rendering it.
   *
   * A participant sees only their own submissions; the facilitator sees all of them, but
   * an anonymous row reaches them with empty submitter fields. The distinction matters:
   * a payload that carried the id and relied on the UI to hide it would leak through the
   * API, the network tab, and any future consumer.
   */
  async listBoundarySubmissions(
    campaignId: number,
    user: RequestUser,
    isFacilitator: boolean,
  ): Promise<SessionZeroBoundarySubmission[]> {
    const rows = await this.db
      .select()
      .from(sessionZeroBoundarySubmissions)
      .where(eq(sessionZeroBoundarySubmissions.campaignId, campaignId))
      .orderBy(asc(sessionZeroBoundarySubmissions.id));

    return rows
      .filter((row) => isFacilitator || row.submitterUserId === user.id)
      .map((row) => {
        const mine = row.submitterUserId === user.id;
        const disclose = mine || (isFacilitator && !row.anonymous);
        return {
          id: row.id,
          campaignId: row.campaignId,
          kind: row.kind === 'veil' ? ('veil' as const) : ('line' as const),
          text: row.text,
          anonymous: row.anonymous,
          submitterUserId: disclose ? row.submitterUserId : '',
          submitterName: disclose ? row.submitterName : '',
          mine,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
      });
  }

  async createBoundarySubmission(
    campaignId: number,
    input: SessionZeroBoundarySubmissionCreate,
    user: RequestUser,
  ): Promise<SessionZeroBoundarySubmission> {
    const ts = nowIso();
    const [row] = await this.db
      .insert(sessionZeroBoundarySubmissions)
      .values({
        campaignId,
        kind: input.kind,
        text: input.text,
        anonymous: input.anonymous,
        submitterUserId: user.id,
        submitterName: input.anonymous ? '' : (user.name ?? ''),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();

    // Audited WITHOUT the text and without the submitter when anonymous: an audit trail
    // that recorded the private boundary would be a second, less protected copy of the
    // thing the participant asked to keep private.
    await this.audit.log({
      actor: input.anonymous ? 'anonymous-participant' : auditActor(user),
      actorRole: 'player',
      action: 'session_zero.boundary.submit',
      entityType: 'session_zero_boundary_submission',
      entityId: row.id,
      campaignId,
      detail: `kind=${input.kind}, anonymous=${input.anonymous}`,
    });

    return {
      id: row.id,
      campaignId,
      kind: input.kind,
      text: row.text,
      anonymous: row.anonymous,
      submitterUserId: user.id,
      submitterName: row.submitterName,
      mine: true,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** A participant withdraws their own submission. Facilitators cannot delete for them. */
  async deleteBoundarySubmission(campaignId: number, id: number, user: RequestUser): Promise<void> {
    const [row] = await this.db
      .select()
      .from(sessionZeroBoundarySubmissions)
      .where(and(eq(sessionZeroBoundarySubmissions.id, id), eq(sessionZeroBoundarySubmissions.campaignId, campaignId)))
      .limit(1);
    if (!row) throw new NotFoundException('Submission not found');
    if (row.submitterUserId !== user.id) {
      throw new ForbiddenException('Only the participant who submitted a boundary may withdraw it');
    }
    await this.db.delete(sessionZeroBoundarySubmissions).where(eq(sessionZeroBoundarySubmissions.id, id));
  }

  // ------------------------------------------------------------------ guardian consent

  async listGuardianConsents(campaignId: number): Promise<SessionZeroGuardianConsent[]> {
    const rows = await this.db
      .select()
      .from(sessionZeroGuardianConsents)
      .where(eq(sessionZeroGuardianConsents.campaignId, campaignId))
      .orderBy(desc(sessionZeroGuardianConsents.id));
    const versions = await this.listVersions(campaignId);
    const versionNumber = new Map(versions.map((v) => [v.id, v.version]));
    return rows.map((row) => toGuardian(row, versionNumber.get(row.versionId) ?? 1));
  }

  /**
   * Open a guardian consent request for a participant.
   *
   * Collects a guardian's NAME, EMAIL and RELATIONSHIP plus a single `minorAttested`
   * boolean — and nothing that encodes an age. The request DTO is `.strict()`, so an
   * integrator who sends `birthDate` gets a 400 rather than a silently dropped field
   * they believe was stored.
   */
  async requestGuardianConsent(
    campaignId: number,
    input: SessionZeroGuardianConsentRequest,
    subject: { userId: string; userName: string },
    actor: RequestUser,
  ): Promise<SessionZeroGuardianConsent> {
    const version = await this.getVersion(campaignId, input.versionId);
    const ts = nowIso();

    const row = this.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(sessionZeroGuardianConsents)
        .where(
          and(
            eq(sessionZeroGuardianConsents.campaignId, campaignId),
            eq(sessionZeroGuardianConsents.userId, subject.userId),
          ),
        )
        .limit(1)
        .get();
      const values = {
        guardianName: input.guardianName,
        guardianEmail: input.guardianEmail,
        guardianRelationship: input.guardianRelationship,
        minorAttested: true,
        versionId: version.id,
        status: 'pending',
        decisionNote: '',
        decidedAt: null,
        userName: subject.userName,
        updatedAt: ts,
      };
      if (existing) {
        return tx
          .update(sessionZeroGuardianConsents)
          .set(values)
          .where(eq(sessionZeroGuardianConsents.id, existing.id))
          .returning()
          .get();
      }
      return tx
        .insert(sessionZeroGuardianConsents)
        .values({ campaignId, userId: subject.userId, ...values, createdAt: ts })
        .returning()
        .get();
    });

    await this.audit.log({
      actor: auditActor(actor),
      actorRole: 'dm',
      action: 'session_zero.guardian.request',
      entityType: 'session_zero_guardian_consent',
      entityId: row.id,
      campaignId,
      // No guardian contact details in the audit detail — the trail records that consent
      // was sought, not a second copy of a third party's email address.
      detail: `version=${version.version}, status=pending`,
    });
    return toGuardian(row, version.version);
  }

  async decideGuardianConsent(
    campaignId: number,
    consentId: number,
    decision: SessionZeroGuardianConsentDecision,
    actor: RequestUser,
  ): Promise<SessionZeroGuardianConsent> {
    const [row] = await this.db
      .select()
      .from(sessionZeroGuardianConsents)
      .where(and(eq(sessionZeroGuardianConsents.id, consentId), eq(sessionZeroGuardianConsents.campaignId, campaignId)))
      .limit(1);
    if (!row) throw new NotFoundException('Guardian consent not found');

    const ts = nowIso();
    const [updated] = await this.db
      .update(sessionZeroGuardianConsents)
      .set({ status: decision.status, decisionNote: decision.note.slice(0, 2000), decidedAt: ts, updatedAt: ts })
      .where(eq(sessionZeroGuardianConsents.id, consentId))
      .returning();

    await this.audit.log({
      actor: auditActor(actor),
      actorRole: 'dm',
      action: `session_zero.guardian.${decision.status}`,
      entityType: 'session_zero_guardian_consent',
      entityId: consentId,
      campaignId,
      detail: `status=${decision.status}`,
    });
    const versions = await this.listVersions(campaignId);
    return toGuardian(updated, versions.find((v) => v.id === updated.versionId)?.version ?? 1);
  }

  // ------------------------------------------------------------------ internals

  /** The DM's mutable working draft, as comparable fields. */
  private async draftFields(campaignId: number): Promise<CharterFields> {
    const [row] = await this.db.select().from(sessionZero).where(eq(sessionZero.campaignId, campaignId)).limit(1);
    if (!row) return EMPTY_CHARTER;
    return {
      lines: fromJsonText<string[]>(row.lines, []),
      veils: fromJsonText<string[]>(row.veils, []),
      safetyTools: fromJsonText<string[]>(row.safetyTools, []),
      houseRules: row.houseRules,
      toneAndExpectations: row.toneAndExpectations,
    };
  }
}

function isEmptyCharter(c: CharterFields): boolean {
  return (
    c.lines.length === 0 &&
    c.veils.length === 0 &&
    c.safetyTools.length === 0 &&
    c.houseRules.trim() === '' &&
    c.toneAndExpectations.trim() === ''
  );
}

function versionFields(row: VersionRow): CharterFields {
  return {
    lines: fromJsonText<string[]>(row.lines, []),
    veils: fromJsonText<string[]>(row.veils, []),
    safetyTools: fromJsonText<string[]>(row.safetyTools, []),
    houseRules: row.houseRules,
    toneAndExpectations: row.toneAndExpectations,
  };
}

function charterOf(v: SessionZeroCharterVersion): CharterFields {
  return {
    lines: v.lines,
    veils: v.veils,
    safetyTools: v.safetyTools,
    houseRules: v.houseRules,
    toneAndExpectations: v.toneAndExpectations,
  };
}

function toVersion(row: VersionRow): SessionZeroCharterVersion {
  return {
    id: row.id,
    campaignId: row.campaignId,
    version: row.version,
    ...versionFields(row),
    material: row.material,
    changeSummary: row.changeSummary,
    publishedBy: row.publishedBy,
    publishedAt: row.publishedAt,
  };
}

function toAck(row: typeof sessionZeroAcknowledgments.$inferSelect, version: number): SessionZeroAcknowledgment {
  return {
    id: row.id,
    campaignId: row.campaignId,
    versionId: row.versionId,
    version,
    userId: row.userId,
    userName: row.userName,
    state: row.state as CharterAcknowledgmentState,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toGuardian(
  row: typeof sessionZeroGuardianConsents.$inferSelect,
  version: number,
): SessionZeroGuardianConsent {
  return {
    id: row.id,
    campaignId: row.campaignId,
    userId: row.userId,
    userName: row.userName,
    versionId: row.versionId,
    version,
    guardianName: row.guardianName,
    guardianEmail: row.guardianEmail,
    guardianRelationship: row.guardianRelationship,
    status: row.status as SessionZeroGuardianConsent['status'],
    decisionNote: row.decisionNote,
    decidedAt: row.decidedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
