import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { AiGenerationProvenance } from '@campfire/schema';
import type { EntityType, Proposal, ProposalAction, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { proposals, quests, npcs, locations, sessions, characters, factions, storyArcs, storyBeats, auditLog, ruleEntries, timelineEvents } from '../../db/schema';
import { nowIso } from '../../common/time';
import { fromJsonText, toJsonText } from '../../common/json';
import { notDeleted } from '../../common/soft-delete';
import { isVisibleTo } from '../../common/redact';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
// Pure row->domain mappers only (NOT the injectable services) — importing these
// creates no Nest module cycle, and keeps the snapshot shape exactly in sync
// with what each entity's read endpoints return.
import { toDomain as questToDomain } from '../quests/quests.service';
import { toDomain as npcToDomain } from '../npcs/npcs.service';
import { toDomain as locationToDomain } from '../locations/locations.service';
import { toDomain as sessionToDomain } from '../sessions/sessions.service';
import { toDomain as characterToDomain } from '../characters/characters.service';
import { toEventDomain as timelineEventToDomain } from '../timeline/timeline.service';
import { projectProposal, projectProposals } from './proposal-projection';
import { hashProposalSnapshot } from './proposal-snapshot';

// The entity types that can be filed as a proposal. Co-DM authoring (issue #313) added
// `encounter` and `map`: a co-DM draft never writes canon directly, so those two must
// be proposable for the AI to author them. Both are create-only in v1 and, on approve,
// run the deterministic generator (#304/#306) from the (seeded) params in the payload —
// their proposals carry generate params, not a persisted row. `map` is not one of the
// note-pin EntityTypes (a map is an attachment, not an entity table), so this union is
// standalone rather than derived from EntityType. Factions (issue #1056) are also
// proposable for Co-DM drafting and are create-only in v1 (direct faction writes remain
// DM-gated; the proposal queue is the co-DM intermediary).
export type ProposableEntityType = Exclude<EntityType, 'campaign'> | 'map' | 'story_arc' | 'story_beat' | 'timeline_event' | 'rule_entry';
type ProposalTx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];
type ProposalDb = DrizzleDb | ProposalTx;
type ProposalAttribution = {
  proposer: string;
  proposerUserId?: string;
  proposerToken?: string | null;
  generationProvenance?: AiGenerationProvenance | null;
};

const PROPOSABLE_ENTITY_TYPES: ProposableEntityType[] = ['quest', 'npc', 'location', 'session', 'character', 'encounter', 'map', 'faction', 'story_arc', 'story_beat', 'timeline_event', 'rule_entry'];

export function isProposableEntityType(value: string): value is ProposableEntityType {
  return (PROPOSABLE_ENTITY_TYPES as string[]).includes(value);
}

export function toDomain(row: typeof proposals.$inferSelect): Proposal {
  return {
    id: row.id,
    campaignId: row.campaignId,
    entityType: row.entityType as Proposal['entityType'],
    entityId: row.entityId,
    action: row.action as ProposalAction,
    payload: fromJsonText<Record<string, unknown>>(row.payload, {}),
    snapshot: row.snapshot == null ? null : fromJsonText<Record<string, unknown> | null>(row.snapshot, null),
    baseUpdatedAt: row.baseUpdatedAt ?? null,
    baseSnapshotHash: row.baseSnapshotHash ?? null,
    proposer: row.proposer,
    proposerUserId: row.proposerUserId ?? '',
    proposerToken: row.proposerToken ?? null,
    // Validated on read (#501): a shape-drifted or hand-edited blob degrades to "no
    // provenance recorded" instead of emitting a malformed object in the API response.
    generationProvenance: AiGenerationProvenance.nullable()
      .catch(null)
      .parse(fromJsonText<unknown>(row.generationProvenance, null)),
    status: row.status as Proposal['status'],
    resolvedBy: row.resolvedBy,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Plain CRUD over the `proposals` table — no dependency on any domain module
 * (quests/npcs/locations/sessions/characters), so it can be imported by
 * those modules' controllers (for the write-path `?proposed=true` flow)
 * without creating a cycle with ProposalsModule (which depends on the
 * domain services to APPLY an approved proposal).
 */
@Injectable()
export class ProposalRecordsService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(
    campaignId: number,
    entityType: ProposableEntityType,
    entityId: number | null,
    action: ProposalAction,
    payload: Record<string, unknown>,
    user: RequestUser,
    role: Role,
    // Override the recorded proposer (issue #313). Co-DM authoring files proposals whose
    // author is the AI seat + model, NOT the DM who triggered the draft — so the review
    // queue attributes them to the AI, not a raw token/user name. Omitted ⇒ the write's
    // actual user (the normal member/PAT propose path).
    attribution?: {
      proposer: string;
      proposerUserId?: string;
      proposerToken?: string | null;
      generationProvenance?: AiGenerationProvenance | null;
    },
    // Long-running AI rewrites may need to pin the proposal to the exact authoritative
    // row that was sent to the model. Without this override, a human edit that lands
    // during generation would become the proposal's base even though the model never
    // saw it, allowing approval to overwrite that edit without a stale conflict (#1311).
    baseSnapshot?: Record<string, unknown>,
  ): Promise<Proposal> {
    // AI provenance (issue #383): the driver seat carries its AI attribution on the principal
    // (`user.proposalAttribution`) rather than passing it explicitly at every mcp tool call site.
    // An explicit `attribution` argument (co-DM authoring) still wins; otherwise fall back to the
    // principal's default so a driver-forced proposal badges as an AI author, never the seat's
    // audit-actor id. Real users carry no proposalAttribution, so their path is unchanged.
    const attr = (attribution ?? user.proposalAttribution) as typeof attribution | undefined;

    // Capture the target's current state so the DM review UI can show a real
    // before/after diff (issue #3). Creates have no "before"; snapshot stays null.
    // Deletes snapshot too, so the DM can see exactly what would be removed.
    // Issue #817: authorize visibility (campaign-bound) BEFORE snapshotting — a
    // non-DM proposing against a hidden/unexplored id must get an indistinguishable
    // 404, never a proposal whose snapshot leaks prep. The persisted snapshot stays
    // the full DM-review copy; create/list responses project a redacted view for
    // non-DM callers (see projectProposal).
    const snapshot =
      action !== 'create' && entityId !== null
        ? baseSnapshot ?? await this.captureAuthorizedSnapshot(campaignId, entityType, entityId, role)
        : null;
    const baseUpdatedAt =
      snapshot !== null && typeof snapshot.updatedAt === 'string' ? snapshot.updatedAt : null;
    const baseSnapshotHash = snapshot !== null ? hashProposalSnapshot(snapshot) : null;

    const ts = nowIso();
    const [row] = await this.db
      .insert(proposals)
      .values({
        campaignId,
        entityType,
        entityId,
        action,
        payload: toJsonText(payload),
        snapshot: snapshot === null ? null : toJsonText(snapshot),
        baseUpdatedAt,
        baseSnapshotHash,
        // Attribution (issue #124): record the actual USER — display name for the
        // human-readable `proposer`, their stable id for the self-view filter — even
        // when the write arrives over a PAT (RequestUser resolves to the token's owning
        // user). The token name is kept as secondary provenance, never the identity.
        proposer: attr ? attr.proposer : user.name,
        proposerUserId: attr?.proposerUserId ?? user.id,
        proposerToken: attr ? (attr.proposerToken ?? null) : user.tokenContext ? user.tokenContext.name : null,
        generationProvenance: attr?.generationProvenance ? toJsonText(attr.generationProvenance) : null,
        status: 'pending',
        resolvedBy: '',
        note: '',
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'proposal.create',
      entityType: row.entityType,
      entityId: row.id,
      campaignId,
      detail: `${action} ${entityType}${entityId ? ` #${entityId}` : ''}`,
    });

    // Tell the DM(s) a proposal is waiting (issue #263) — they own the review queue,
    // and previously a submission gave no signal at all. Fan out to every dm-role
    // member except the actor (a DM proposing to themselves needn't ping). No entity
    // deep-link: the target may not exist yet (create proposals) and the bell routes
    // proposal_* to the proposals queue. Best-effort — never fails the write.
    const roles = await this.notifications.memberRoles(campaignId);
    for (const [memberId, memberRole] of roles) {
      if (memberRole !== 'dm' || String(memberId) === user.id) continue;
      await this.notifications.notifyUser(memberId, campaignId, user, {
        type: 'proposal_submitted',
        title: `${user.name || 'A member'} proposed a ${action} to a ${entityType}`,
        actorName: user.name,
      });
    }

    // Egress projection (#817): non-DM proposers never see the raw DM-review snapshot
    // (or dmSecret in the echoed payload) on the create response.
    return projectProposal(toDomain(row), role);
  }

  /**
   * Create a proposal and a caller-owned sidecar row in one DB transaction.
   * Audit and notifications intentionally remain post-commit, matching `create()`.
   */
  async createWithTransaction<T>(
    campaignId: number,
    entityType: ProposableEntityType,
    entityId: number | null,
    action: ProposalAction,
    payload: Record<string, unknown>,
    user: RequestUser,
    role: Role,
    work: (tx: ProposalTx, proposalRow: typeof proposals.$inferSelect) => T,
    attribution?: ProposalAttribution,
  ): Promise<{ proposal: Proposal; result: T }> {
    const attr = (attribution ?? user.proposalAttribution) as ProposalAttribution | undefined;

    const { row, result } = this.db.transaction((tx) => {
      const row = this.insertProposalRow(tx, campaignId, entityType, entityId, action, payload, user, role, attr);
      const result = work(tx, row);
      return { row, result };
    });

    await this.recordCreatedSideEffects(row, campaignId, entityType, entityId, action, user, role);
    return { proposal: projectProposal(toDomain(row), role), result };
  }

  private insertProposalRow(
    db: ProposalDb,
    campaignId: number,
    entityType: ProposableEntityType,
    entityId: number | null,
    action: ProposalAction,
    payload: Record<string, unknown>,
    user: RequestUser,
    role: Role,
    attr: ProposalAttribution | undefined,
  ): typeof proposals.$inferSelect {
    const snapshot =
      action !== 'create' && entityId !== null
        ? this.captureAuthorizedSnapshotInDb(db, campaignId, entityType, entityId, role)
        : null;
    const baseUpdatedAt =
      snapshot !== null && typeof snapshot.updatedAt === 'string' ? snapshot.updatedAt : null;
    const baseSnapshotHash = snapshot !== null ? hashProposalSnapshot(snapshot) : null;
    const ts = nowIso();

    return db
      .insert(proposals)
      .values({
        campaignId,
        entityType,
        entityId,
        action,
        payload: toJsonText(payload),
        snapshot: snapshot === null ? null : toJsonText(snapshot),
        baseUpdatedAt,
        baseSnapshotHash,
        proposer: attr ? attr.proposer : user.name,
        proposerUserId: attr?.proposerUserId ?? user.id,
        proposerToken: attr ? (attr.proposerToken ?? null) : user.tokenContext ? user.tokenContext.name : null,
        generationProvenance: attr?.generationProvenance ? toJsonText(attr.generationProvenance) : null,
        status: 'pending',
        resolvedBy: '',
        note: '',
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .get();
  }

  private async recordCreatedSideEffects(
    row: typeof proposals.$inferSelect,
    campaignId: number,
    entityType: ProposableEntityType,
    entityId: number | null,
    action: ProposalAction,
    user: RequestUser,
    role: Role,
  ): Promise<void> {
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'proposal.create',
      entityType: row.entityType,
      entityId: row.id,
      campaignId,
      detail: `${action} ${entityType}${entityId ? ` #${entityId}` : ''}`,
    });

    const roles = await this.notifications.memberRoles(campaignId);
    for (const [memberId, memberRole] of roles) {
      if (memberRole !== 'dm' || String(memberId) === user.id) continue;
      await this.notifications.notifyUser(memberId, campaignId, user, {
        type: 'proposal_submitted',
        title: `${user.name || 'A member'} proposed a ${action} to a ${entityType}`,
        actorName: user.name,
      });
    }
  }

  /**
   * Load the target's current authorized snapshot for approve-time stale checks
   * (issue #681). Returns null when the entity no longer exists (deleted).
   */
  async getCurrentAuthorizedSnapshot(
    campaignId: number,
    entityType: ProposableEntityType,
    entityId: number,
    role: Role,
  ): Promise<Record<string, unknown> | null> {
    try {
      return await this.captureAuthorizedSnapshot(campaignId, entityType, entityId, role);
    } catch (err) {
      if (err instanceof NotFoundException) return null;
      throw err;
    }
  }

  /**
   * Load the target in the already-authorized campaign, enforce the same visibility
   * rules as the entity GET endpoints (hidden / unexplored → indistinguishable 404),
   * and return the FULL unredacted domain snapshot for DM review persistence.
   */
  private async captureAuthorizedSnapshot(
    campaignId: number,
    entityType: ProposableEntityType,
    entityId: number,
    role: Role,
  ): Promise<Record<string, unknown> | null> {
    switch (entityType) {
      case 'quest': {
        const [row] = await this.db
          .select()
          .from(quests)
          .where(and(eq(quests.id, entityId), eq(quests.campaignId, campaignId), notDeleted(quests.deletedAt)))
          .limit(1);
        if (!row) throw new NotFoundException(`Quest ${entityId} not found`);
        const domain = questToDomain(row);
        if (!isVisibleTo(domain, role)) throw new NotFoundException(`Quest ${entityId} not found`);
        return { ...domain };
      }
      case 'npc': {
        const [row] = await this.db
          .select()
          .from(npcs)
          .where(and(eq(npcs.id, entityId), eq(npcs.campaignId, campaignId), notDeleted(npcs.deletedAt)))
          .limit(1);
        if (!row) throw new NotFoundException(`NPC ${entityId} not found`);
        const domain = npcToDomain(row);
        if (!isVisibleTo(domain, role)) throw new NotFoundException(`NPC ${entityId} not found`);
        return { ...domain };
      }
      case 'location': {
        const [row] = await this.db
          .select()
          .from(locations)
          .where(and(eq(locations.id, entityId), eq(locations.campaignId, campaignId), notDeleted(locations.deletedAt)))
          .limit(1);
        if (!row) throw new NotFoundException(`Location ${entityId} not found`);
        // Unexplored locations are hidden prep for non-DM (same rule as LocationsService).
        if (role !== 'dm' && row.status === 'unexplored') {
          throw new NotFoundException(`Location ${entityId} not found`);
        }
        return { ...locationToDomain(row) };
      }
      case 'session': {
        const [row] = await this.db
          .select()
          .from(sessions)
          .where(and(eq(sessions.id, entityId), eq(sessions.campaignId, campaignId), notDeleted(sessions.deletedAt)))
          .limit(1);
        if (!row) throw new NotFoundException(`Session ${entityId} not found`);
        // Sessions are member-visible; dmSecret is stripped only at proposer projection.
        return { ...sessionToDomain(row) };
      }
      case 'character': {
        const [row] = await this.db
          .select()
          .from(characters)
          .where(and(eq(characters.id, entityId), eq(characters.campaignId, campaignId), notDeleted(characters.deletedAt)))
          .limit(1);
        if (!row) throw new NotFoundException(`Character ${entityId} not found`);
        // Characters are member-visible; dmSecret is stripped only at proposer projection.
        return { ...characterToDomain(row) };
      }
      // Co-DM (issue #313) files encounter/map proposals as CREATEs only (the payload is
      // seeded generator params, applied by re-running the generator on approve), so this
      // update/delete-only snapshot path is never reached for them — there is no prior row
      // to diff against a fresh generation. Return null explicitly to keep the switch total.
      case 'encounter':
      case 'map':
        return null;
      case 'faction': {
        // Co-DM faction drafts (#1056) are create-only today, but update proposals
        // still need a prior-row snapshot when filed (and for non-AI proposers).
        const [row] = await this.db
          .select()
          .from(factions)
          .where(and(eq(factions.id, entityId), eq(factions.campaignId, campaignId)))
          .limit(1);
        if (!row) throw new NotFoundException(`Faction ${entityId} not found`);
        // Factions with hidden=true are DM-only prep — non-DMs must not see them.
        if (role !== 'dm' && row.hidden) throw new NotFoundException(`Faction ${entityId} not found`);
        return { ...row };
      }
      case 'story_arc': {
        const [row] = await this.db
          .select()
          .from(storyArcs)
          .where(and(eq(storyArcs.id, entityId), eq(storyArcs.campaignId, campaignId), notDeleted(storyArcs.deletedAt)))
          .limit(1);
        if (!row) throw new NotFoundException(`Story arc ${entityId} not found`);
        return {
          id: row.id,
          campaignId: row.campaignId,
          title: row.title,
          summary: row.summary,
          status: row.status,
          sortOrder: row.sortOrder,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
      }
      case 'story_beat': {
        const [row] = await this.db
          .select()
          .from(storyBeats)
          .where(and(eq(storyBeats.id, entityId), eq(storyBeats.campaignId, campaignId)))
          .limit(1);
        if (!row) throw new NotFoundException(`Story beat ${entityId} not found`);
        return {
          id: row.id,
          campaignId: row.campaignId,
          arcId: row.arcId,
          title: row.title,
          body: row.body,
          status: row.status,
          sortOrder: row.sortOrder,
          sessionId: row.sessionId,
          questId: row.questId,
          encounterId: row.encounterId,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
      }
      case 'rule_entry': {
        const [row] = await this.db.select().from(ruleEntries).where(and(eq(ruleEntries.id, entityId), eq(ruleEntries.campaignId, campaignId))).limit(1);
        if (!row) throw new NotFoundException(`Homebrew rule entry ${entityId} not found`);
        return { id: row.id, slug: row.slug, name: row.name, type: row.type, summary: row.summary, body: row.body, dataJson: row.dataJson, rightsStatus: row.rightsStatus, license: row.license, attribution: row.attribution, author: row.author, sourceUrl: row.sourceUrl, iconSlug: row.iconSlug, updatedAt: row.updatedAt, archivedAt: row.archivedAt };
      }
      case 'timeline_event': {
        const [row] = await this.db
          .select()
          .from(timelineEvents)
          .where(and(eq(timelineEvents.id, entityId), eq(timelineEvents.campaignId, campaignId), notDeleted(timelineEvents.deletedAt)))
          .limit(1);
        if (!row) throw new NotFoundException(`Timeline event ${entityId} not found`);
        const domain = timelineEventToDomain(row);
        if (!isVisibleTo(domain, role)) throw new NotFoundException(`Timeline event ${entityId} not found`);
        return { ...domain };
      }
    }
  }

  private captureAuthorizedSnapshotInDb(
    db: ProposalDb,
    campaignId: number,
    entityType: ProposableEntityType,
    entityId: number,
    role: Role,
  ): Record<string, unknown> | null {
    switch (entityType) {
      case 'quest': {
        const row = db
          .select()
          .from(quests)
          .where(and(eq(quests.id, entityId), eq(quests.campaignId, campaignId), notDeleted(quests.deletedAt)))
          .limit(1)
          .get();
        if (!row) throw new NotFoundException(`Quest ${entityId} not found`);
        const domain = questToDomain(row);
        if (!isVisibleTo(domain, role)) throw new NotFoundException(`Quest ${entityId} not found`);
        return { ...domain };
      }
      case 'npc': {
        const row = db
          .select()
          .from(npcs)
          .where(and(eq(npcs.id, entityId), eq(npcs.campaignId, campaignId), notDeleted(npcs.deletedAt)))
          .limit(1)
          .get();
        if (!row) throw new NotFoundException(`NPC ${entityId} not found`);
        const domain = npcToDomain(row);
        if (!isVisibleTo(domain, role)) throw new NotFoundException(`NPC ${entityId} not found`);
        return { ...domain };
      }
      case 'location': {
        const row = db
          .select()
          .from(locations)
          .where(and(eq(locations.id, entityId), eq(locations.campaignId, campaignId), notDeleted(locations.deletedAt)))
          .limit(1)
          .get();
        if (!row) throw new NotFoundException(`Location ${entityId} not found`);
        if (role !== 'dm' && row.status === 'unexplored') {
          throw new NotFoundException(`Location ${entityId} not found`);
        }
        return { ...locationToDomain(row) };
      }
      case 'session': {
        const row = db
          .select()
          .from(sessions)
          .where(and(eq(sessions.id, entityId), eq(sessions.campaignId, campaignId), notDeleted(sessions.deletedAt)))
          .limit(1)
          .get();
        if (!row) throw new NotFoundException(`Session ${entityId} not found`);
        return { ...sessionToDomain(row) };
      }
      case 'character': {
        const row = db
          .select()
          .from(characters)
          .where(and(eq(characters.id, entityId), eq(characters.campaignId, campaignId), notDeleted(characters.deletedAt)))
          .limit(1)
          .get();
        if (!row) throw new NotFoundException(`Character ${entityId} not found`);
        return { ...characterToDomain(row) };
      }
      case 'encounter':
      case 'map':
        return null;
      case 'faction': {
        const row = db
          .select()
          .from(factions)
          .where(and(eq(factions.id, entityId), eq(factions.campaignId, campaignId)))
          .limit(1)
          .get();
        if (!row) throw new NotFoundException(`Faction ${entityId} not found`);
        if (role !== 'dm' && row.hidden) throw new NotFoundException(`Faction ${entityId} not found`);
        return { ...row };
      }
      case 'story_arc': {
        const row = db
          .select()
          .from(storyArcs)
          .where(and(eq(storyArcs.id, entityId), eq(storyArcs.campaignId, campaignId), notDeleted(storyArcs.deletedAt)))
          .limit(1)
          .get();
        if (!row) throw new NotFoundException(`Story arc ${entityId} not found`);
        return {
          id: row.id,
          campaignId: row.campaignId,
          title: row.title,
          summary: row.summary,
          status: row.status,
          sortOrder: row.sortOrder,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
      }
      case 'story_beat': {
        const row = db
          .select()
          .from(storyBeats)
          .where(and(eq(storyBeats.id, entityId), eq(storyBeats.campaignId, campaignId)))
          .limit(1)
          .get();
        if (!row) throw new NotFoundException(`Story beat ${entityId} not found`);
        return {
          id: row.id,
          campaignId: row.campaignId,
          arcId: row.arcId,
          title: row.title,
          body: row.body,
          status: row.status,
          sortOrder: row.sortOrder,
          sessionId: row.sessionId,
          questId: row.questId,
          encounterId: row.encounterId,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
      }
      case 'rule_entry': {
        const row = db
          .select()
          .from(ruleEntries)
          .where(and(eq(ruleEntries.id, entityId), eq(ruleEntries.campaignId, campaignId)))
          .limit(1)
          .get();
        if (!row) throw new NotFoundException(`Homebrew rule entry ${entityId} not found`);
        return {
          id: row.id,
          slug: row.slug,
          name: row.name,
          type: row.type,
          summary: row.summary,
          body: row.body,
          dataJson: row.dataJson,
          rightsStatus: row.rightsStatus,
          license: row.license,
          attribution: row.attribution,
          author: row.author,
          sourceUrl: row.sourceUrl,
          iconSlug: row.iconSlug,
          updatedAt: row.updatedAt,
          archivedAt: row.archivedAt,
        };
      }
      case 'timeline_event': {
        const row = db
          .select()
          .from(timelineEvents)
          .where(and(eq(timelineEvents.id, entityId), eq(timelineEvents.campaignId, campaignId), notDeleted(timelineEvents.deletedAt)))
          .limit(1)
          .get();
        if (!row) throw new NotFoundException(`Timeline event ${entityId} not found`);
        const domain = timelineEventToDomain(row);
        if (!isVisibleTo(domain, role)) throw new NotFoundException(`Timeline event ${entityId} not found`);
        return { ...domain };
      }
    }
  }

  /**
   * List a campaign's proposals, newest first. `opts.proposerUserId` scopes the
   * result to a single submitter — the proposer self-view (issue #124): a non-DM
   * member sees only what they authored, while the DM (no filter) sees everyone's.
   * `role` drives snapshot/payload projection (#817).
   */
  async listForCampaign(
    campaignId: number,
    status: string | undefined,
    role: Role,
    opts?: { proposerUserId?: string },
  ): Promise<Proposal[]> {
    const rows = await this.db
      .select()
      .from(proposals)
      .where(eq(proposals.campaignId, campaignId))
      .orderBy(desc(proposals.id));
    let all = rows.map(toDomain);
    if (opts?.proposerUserId !== undefined) {
      all = all.filter((p) => p.proposerUserId === opts.proposerUserId);
    }
    const filtered = status ? all.filter((p) => p.status === status) : all;
    return projectProposals(filtered, role);
  }

  async latestForCampaign(campaignId: number, limit = 500, role: Role = 'dm'): Promise<Proposal[]> {
    const rows = await this.db
      .select()
      .from(proposals)
      .where(eq(proposals.campaignId, campaignId))
      .orderBy(desc(proposals.id))
      .limit(limit);
    return projectProposals(rows.map(toDomain), role);
  }

  async getRowOrThrow(id: number) {
    const [row] = await this.db.select().from(proposals).where(eq(proposals.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Proposal ${id} not found`);
    return row;
  }

  /**
   * After a successful entity write, atomically backfill bookkeeping and record
   * the proposal.approve audit row (issue #681). Guarded on `status = 'approved'`
   * so a reverted claim is never finalized.
   */
  finalizeApproved(
    id: number,
    user: RequestUser,
    role: Role,
    opts?: { payload?: Record<string, unknown>; entityId?: number },
  ): void {
    const ts = nowIso();
    const actor = auditActor(user);
    this.db.transaction((tx) => {
      const row = tx.select().from(proposals).where(eq(proposals.id, id)).limit(1).get();
      if (!row || row.status !== 'approved') return;

      if (opts?.entityId !== undefined && row.entityId == null) {
        tx.update(proposals)
          .set({ entityId: opts.entityId, updatedAt: ts })
          .where(and(eq(proposals.id, id), eq(proposals.status, 'approved'), isNull(proposals.entityId)))
          .run();
      }
      if (opts?.payload !== undefined) {
        tx.update(proposals)
          .set({ payload: toJsonText(opts.payload), updatedAt: ts })
          .where(and(eq(proposals.id, id), eq(proposals.status, 'approved')))
          .run();
      }

      tx.insert(auditLog)
        .values({
          campaignId: row.campaignId,
          actor,
          actorRole: role,
          action: 'proposal.approve',
          entityType: row.entityType,
          entityId: id,
          detail: '',
          createdAt: ts,
        })
        .run();
    });
  }

  /**
   * Persist an amended payload for a still-pending proposal (edit-before-approve):
   * the DM tweaked the proposed create/update body at approval time, so the stored
   * record matches what actually gets applied. Guarded on `status = 'pending'` so a
   * concurrently-resolved proposal isn't rewritten.
   */
  async updatePayload(id: number, payload: Record<string, unknown>): Promise<void> {
    await this.db
      .update(proposals)
      .set({ payload: toJsonText(payload), updatedAt: nowIso() })
      .where(and(eq(proposals.id, id), eq(proposals.status, 'pending')));
  }

  /**
   * Revise a still-pending proposal's payload (issue #124): the proposer amends
   * their own proposed create/update body before the DM acts. Guarded on
   * `status = 'pending'` so an already-resolved (or withdrawn) proposal isn't
   * rewritten. Returns the updated domain row, or null if it was no longer
   * pending (lost a race to a resolver). Ownership is checked by the caller.
   * `role` projects the returned proposal for non-DM proposers (#817).
   */
  async revisePayload(id: number, payload: Record<string, unknown>, role: Role): Promise<Proposal | null> {
    const [row] = await this.db
      .update(proposals)
      .set({ payload: toJsonText(payload), updatedAt: nowIso() })
      .where(and(eq(proposals.id, id), eq(proposals.status, 'pending')))
      .returning();
    return row ? projectProposal(toDomain(row), role) : null;
  }

  /**
   * Backfill the created entity's id onto an approved create-proposal (issue #124):
   * once the create applies, the proposal record points at the row it produced, so
   * canon provenance survives acceptance. Guarded on `entity_id IS NULL` so it never
   * clobbers an already-set target, and applied right after the successful write.
   */
  async backfillEntityId(id: number, entityId: number): Promise<void> {
    await this.db
      .update(proposals)
      .set({ entityId, updatedAt: nowIso() })
      .where(and(eq(proposals.id, id), isNull(proposals.entityId)));
  }

  /**
   * Withdraw a still-pending proposal (issue #124): a compare-and-set to the
   * `withdrawn` terminal state, guarded on BOTH `status = 'pending'` and the
   * proposer's own user id, so a member can only ever pull their own proposal and
   * only while it is still pending (a concurrent DM approve/reject wins the CAS).
   * Returns the withdrawn domain row, or null if the guard didn't match.
   * `role` projects the returned proposal for non-DM proposers (#817).
   */
  async markWithdrawn(id: number, proposerUserId: string, role: Role): Promise<Proposal | null> {
    const [row] = await this.db
      .update(proposals)
      .set({ status: 'withdrawn', updatedAt: nowIso() })
      .where(
        and(
          eq(proposals.id, id),
          eq(proposals.status, 'pending'),
          eq(proposals.proposerUserId, proposerUserId),
        ),
      )
      .returning();
    return row ? projectProposal(toDomain(row), role) : null;
  }

  /**
   * Atomically transition a proposal from `pending` to `approved`/`rejected`.
   * This is a compare-and-set: the `AND status='pending'` guard means SQLite
   * only touches the row if it is still pending, and `.returning()` reports
   * whether that row actually changed. Two concurrent approve/reject calls (DM
   * double-click, or web + MCP agent) therefore can't both win — exactly one
   * gets the row back; the other gets `null` and the caller raises 409. This
   * is the linchpin of the fix for issue #85: the status flip is the single
   * point of serialization, so the entity write downstream applies at most once.
   *
   * Returns the resolved domain row, or `null` if the proposal was not pending
   * (already resolved, or lost the race to a concurrent resolver).
   * DM-only callers — full (unprojected) snapshot is returned.
   */
  async markResolved(
    id: number,
    status: 'approved' | 'rejected',
    note: string,
    user: RequestUser,
  ): Promise<Proposal | null> {
    const [row] = await this.db
      .update(proposals)
      .set({ status, resolvedBy: auditActor(user), note, updatedAt: nowIso() })
      .where(and(eq(proposals.id, id), eq(proposals.status, 'pending')))
      .returning();
    return row ? toDomain(row) : null;
  }

  /**
   * Roll a claimed proposal back to `pending` (see ProposalsService.approve):
   * approve claims the row first, then applies the entity write. If that write
   * throws, this undoes the claim so the proposal is re-approvable rather than
   * stranded as `approved` with no write applied. Guarded on `status='approved'`
   * so it only ever reverts a claim this request made, never someone else's
   * resolution.
   */
  async revertToPending(id: number): Promise<void> {
    await this.db
      .update(proposals)
      .set({ status: 'pending', resolvedBy: '', note: '', updatedAt: nowIso() })
      .where(and(eq(proposals.id, id), eq(proposals.status, 'approved')))
      .returning();
  }
}
