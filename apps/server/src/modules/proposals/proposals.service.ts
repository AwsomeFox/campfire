import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import {
  QuestCreate,
  QuestUpdate,
  NpcCreate,
  NpcUpdate,
  LocationCreate,
  LocationUpdate,
  SessionCreate,
  SessionUpdate,
  CharacterCreate,
  CharacterUpdate,
  EncounterGenerate,
  GenerateMapParams,
  FactionCreate,
  FactionUpdate,
  ProposalApprove,
  ProposalResolve,
} from '@campfire/schema';
import type { Proposal, ProposalAction, Role } from '@campfire/schema';
import { fromJsonText } from '../../common/json';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import { AuditService } from '../audit/audit.service';
import { NotificationsService, excerpt } from '../notifications/notifications.service';
import { QuestsService } from '../quests/quests.service';
import { NpcsService } from '../npcs/npcs.service';
import { LocationsService } from '../locations/locations.service';
import { SessionsService } from '../sessions/sessions.service';
import { CharactersService } from '../characters/characters.service';
import { EncountersService } from '../encounters/encounters.service';
import { MapsService } from '../maps/maps.service';
import { ProposalRecordsService, isProposableEntityType, type ProposableEntityType } from './proposal-records.service';

type ProposalResolveInput = z.infer<typeof ProposalResolve>;
type ProposalApproveInput = z.infer<typeof ProposalApprove>;

/** One entry in a batch approve/reject result — success carries the resolved proposal, failure the reason. */
export type BatchResolveResult =
  | { id: number; ok: true; proposal: Proposal }
  | { id: number; ok: false; status: number; error: string };

export { isProposableEntityType, type ProposableEntityType } from './proposal-records.service';

// Zod input schema per entity type/action — used to validate a proposal payload
// before applying it. `.strict()` here mirrors the server DTO layer (issue #131):
// the proposal path is where silent key-stripping was WORST (an invisible drop
// until a DM approves an emptier-than-intended entity), so an amended
// edit-before-approve payload (ProposalApprove.payload) with an unknown/misnamed
// key 400s instead of being quietly discarded. The shared @campfire/schema exports
// stay lenient (reused elsewhere); strictness is applied at this use site only.
const CREATE_SCHEMAS: Record<ProposableEntityType, z.ZodTypeAny> = {
  quest: QuestCreate.strict(),
  npc: NpcCreate.strict(),
  location: LocationCreate.strict(),
  session: SessionCreate.strict(),
  character: CharacterCreate.strict(),
  // Co-DM (issue #313): an encounter/map proposal's payload is the (seeded) GENERATOR
  // request, not a persisted row — approve re-runs generate_encounter (#304) /
  // generate_map (#306). These are create-only in v1; the update entries below reuse the
  // same schema only to keep the Record total (an update proposal is never filed for them).
  encounter: EncounterGenerate.strict(),
  map: GenerateMapParams.strict(),
  faction: FactionCreate.strict(),
};
const UPDATE_SCHEMAS: Record<ProposableEntityType, z.ZodTypeAny> = {
  quest: QuestUpdate.strict(),
  npc: NpcUpdate.strict(),
  location: LocationUpdate.strict(),
  session: SessionUpdate.strict(),
  character: CharacterUpdate.strict(),
  encounter: EncounterGenerate.strict(),
  map: GenerateMapParams.strict(),
  faction: FactionUpdate.strict(),
};

@Injectable()
export class ProposalsService {
  constructor(
    private readonly records: ProposalRecordsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly quests: QuestsService,
    private readonly npcs: NpcsService,
    private readonly locations: LocationsService,
    private readonly sessions: SessionsService,
    private readonly characters: CharactersService,
    private readonly encounters: EncountersService,
    private readonly maps: MapsService,
  ) {}

  async listForCampaign(
    campaignId: number,
    status: string | undefined,
    role: Role,
    opts?: { proposerUserId?: string },
  ): Promise<Proposal[]> {
    return this.records.listForCampaign(campaignId, status, role, opts);
  }

  /**
   * Tell the proposer the DM resolved their submission (issue #263) — previously an
   * approve/reject was silent, so a member never learned the verdict. Targets the
   * original proposer (proposerUserId); notifyUser skips the actor, so a DM resolving
   * their own proposal doesn't ping themselves, and no-ops cleanly for a DEV_AUTH /
   * empty proposer id. No entity deep-link — the bell routes proposal_* to the queue.
   * Best-effort, like every notify* emitter.
   */
  private async notifyProposerOfResolution(
    resolved: Proposal,
    outcome: 'approved' | 'rejected',
    user: RequestUser,
  ): Promise<void> {
    if (!resolved.proposerUserId) return;
    await this.notifications.notifyUser(resolved.proposerUserId, resolved.campaignId, user, {
      type: 'proposal_resolved',
      title: `${user.name || 'The DM'} ${outcome} your ${resolved.action} to a ${resolved.entityType}`,
      body: resolved.note ? excerpt(resolved.note) : '',
      actorName: user.name,
    });
  }

  async latestForCampaign(campaignId: number, limit = 500, role: Role = 'dm'): Promise<Proposal[]> {
    return this.records.latestForCampaign(campaignId, limit, role);
  }

  async getRowOrThrow(id: number) {
    return this.records.getRowOrThrow(id);
  }

  /** Validates `payload` against the Create/Update schema for (entityType, action); throws BadRequestException if invalid. */
  validatePayload(entityType: ProposableEntityType, action: ProposalAction, payload: unknown): Record<string, unknown> {
    const schema = action === 'create' ? CREATE_SCHEMAS[entityType] : UPDATE_SCHEMAS[entityType];
    const result = schema.safeParse(payload);
    if (!result.success) {
      throw new BadRequestException(result.error.issues);
    }
    return result.data as Record<string, unknown>;
  }

  private serviceFor(entityType: ProposableEntityType) {
    switch (entityType) {
      case 'quest':
        return this.quests;
      case 'npc':
        return this.npcs;
      case 'location':
        return this.locations;
      case 'session':
        return this.sessions;
      case 'character':
        return this.characters;
      // Co-DM (issue #313): encounter/map proposals apply by RE-RUNNING the deterministic
      // generator (#304/#306) from the seeded params in the payload, through the same
      // dm+write-gated write path a direct generate-then-commit would take (the approver's
      // role is passed through). Thin adapters expose the generic `create(campaignId,
      // payload, user, role) -> {id}` contract approve() calls; update/remove aren't
      // reachable (v1 files create-only) and reject loudly if ever hit.
      case 'encounter':
        return {
          create: async (campaignId: number, payload: Record<string, unknown>, user: RequestUser, role: Role) => {
            const { encounter } = await this.encounters.generateAndCreateEncounter(
              campaignId,
              payload as Parameters<EncountersService['generateAndCreateEncounter']>[1],
              user,
              role,
            );
            return encounter;
          },
          update: () => Promise.reject(new BadRequestException('Encounter proposals are create-only')),
          remove: () => Promise.reject(new BadRequestException('Encounter proposals are create-only')),
        };
      case 'map':
        return {
          create: async (campaignId: number, payload: Record<string, unknown>, user: RequestUser, role: Role) => {
            const result = await this.maps.generateForCampaign(
              campaignId,
              payload as Parameters<MapsService['generateForCampaign']>[1],
              user,
              role,
            );
            // The generated map is an attachment; its id is the proposal's produced entity id.
            return { id: result.attachmentId };
          },
          update: () => Promise.reject(new BadRequestException('Map proposals are create-only')),
          remove: () => Promise.reject(new BadRequestException('Map proposals are create-only')),
        };
    }
  }

  /**
   * Applies the proposal through the SAME service create/update/delete path used by the
   * direct write endpoints, so invariants hold. `input.payload` (edit-before-approve, #98)
   * lets the DM amend the proposed create/update body before it's applied.
   *
   * Concurrency (issue #85): the status transition is the point of serialization. We
   * validate first, then *claim* the proposal with an atomic compare-and-set
   * (`pending -> approved`, only if still pending). Only one of N concurrent approves —
   * or an approve racing a reject — can win that claim; the losers get a 409 and never
   * touch the entity, so the write applies at most once. The entity write happens only
   * after a successful claim; if it throws, we revert the claim to `pending`.
   */
  async approve(id: number, input: ProposalApproveInput, user: RequestUser, role: Role): Promise<Proposal> {
    const existing = await this.records.getRowOrThrow(id);
    if (existing.status !== 'pending') {
      throw new ConflictException(`Proposal ${id} is already ${existing.status}`);
    }
    if (!isProposableEntityType(existing.entityType)) {
      throw new BadRequestException(`Unsupported proposal entityType: ${existing.entityType}`);
    }

    const action = existing.action as ProposalAction;
    const service = this.serviceFor(existing.entityType);
    // Edit-before-approve: an amended payload replaces the stored one (create/update only).
    const amended = input.payload !== undefined && action !== 'delete';
    const payload = amended ? input.payload! : fromJsonText<Record<string, unknown>>(existing.payload, {});

    // Validate BEFORE claiming so an invalid payload doesn't consume the one-and-only
    // pending->approved transition (issue #85). Delete carries no payload to validate.
    let validated: Record<string, unknown> | undefined;
    if (action !== 'delete') {
      validated = this.validatePayload(existing.entityType, action, payload);
    }
    if ((action === 'update' || action === 'delete') && existing.entityId === null) {
      throw new BadRequestException(`${action} proposal missing entityId`);
    }

    // Atomically claim the proposal (pending -> approved). A null return means it was
    // already resolved or a concurrent request won the race — do not apply the write.
    const resolved = await this.records.markResolved(id, 'approved', input.note ?? '', user);
    if (!resolved) {
      const current = await this.records.getRowOrThrow(id);
      throw new ConflictException(`Proposal ${id} is already ${current.status}`);
    }

    // On a create-proposal, capture the created row's id so we can backfill it onto
    // the proposal (issue #124) — provenance points at the entity it produced.
    let createdEntityId: number | null = null;
    try {
      if (action === 'delete') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (service as any).remove(existing.entityId, user, role);
      } else if (action === 'create') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const created = await (service as any).create(existing.campaignId, validated, user, role);
        if (created && typeof created.id === 'number') {
          createdEntityId = created.id;
          // entity_id was null on a create-proposal; backfill it now that the row exists.
          await this.records.backfillEntityId(id, created.id);
        }
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (service as any).update(existing.entityId, validated, user, role);
      }
      // Persist the DM's amended body so the record reflects what was actually applied.
      if (amended) await this.records.updatePayload(id, validated!);
    } catch (err) {
      // The entity write failed — undo the claim so the proposal returns to pending
      // rather than being stranded as approved with no write applied.
      await this.records.revertToPending(id);
      throw err;
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'proposal.approve',
      entityType: existing.entityType,
      entityId: id,
      campaignId: existing.campaignId,
    });

    await this.notifyProposerOfResolution(resolved, 'approved', user);

    // The claimed row was captured before updatePayload/backfillEntityId ran, so reflect
    // both the amended payload (edit-before-approve) and the backfilled entityId in the
    // returned proposal.
    return {
      ...resolved,
      ...(amended ? { payload: validated! } : {}),
      ...(createdEntityId !== null ? { entityId: createdEntityId } : {}),
    };
  }

  async reject(id: number, input: ProposalResolveInput, user: RequestUser, role: Role): Promise<Proposal> {
    const existing = await this.records.getRowOrThrow(id);
    if (existing.status !== 'pending') {
      throw new ConflictException(`Proposal ${id} is already ${existing.status}`);
    }

    // Same atomic claim as approve: a null return means a concurrent approve or
    // reject already resolved this proposal, so this reject is a no-op 409.
    const resolved = await this.records.markResolved(id, 'rejected', input.note ?? '', user);
    if (!resolved) {
      const current = await this.records.getRowOrThrow(id);
      throw new ConflictException(`Proposal ${id} is already ${current.status}`);
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'proposal.reject',
      entityType: existing.entityType,
      entityId: id,
      campaignId: existing.campaignId,
    });

    await this.notifyProposerOfResolution(resolved, 'rejected', user);

    return resolved;
  }

  /**
   * Withdraw the caller's OWN still-pending proposal (issue #124): the proposer
   * pulls it before the DM acts. Ownership is enforced two ways — a 403 if the
   * proposer's user id doesn't match `user`, and the atomic CAS in markWithdrawn
   * (guarded on both status='pending' and the proposer id) so a concurrent DM
   * approve/reject wins cleanly (409). No entity write is ever applied.
   */
  async withdraw(id: number, user: RequestUser, role: Role): Promise<Proposal> {
    const existing = await this.records.getRowOrThrow(id);
    if ((existing.proposerUserId ?? '') !== user.id) {
      throw new ForbiddenException('You can only withdraw your own proposals');
    }
    if (existing.status !== 'pending') {
      throw new ConflictException(`Proposal ${id} is already ${existing.status}`);
    }
    const withdrawn = await this.records.markWithdrawn(id, user.id, role);
    if (!withdrawn) {
      const current = await this.records.getRowOrThrow(id);
      throw new ConflictException(`Proposal ${id} is already ${current.status}`);
    }
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'proposal.withdraw',
      entityType: existing.entityType,
      entityId: id,
      campaignId: existing.campaignId,
    });
    return withdrawn;
  }

  /**
   * Revise the caller's OWN still-pending proposal's payload (issue #124): the
   * proposer amends the proposed create/update body before the DM acts. Same
   * ownership + pending guards as withdraw. The new payload is validated against
   * the target entity's Create/Update schema (same strict rules as an
   * edit-before-approve), so a bad revision 400s rather than being stored. Delete
   * proposals carry no payload and cannot be revised.
   */
  async revise(id: number, input: { payload: Record<string, unknown> }, user: RequestUser, role: Role): Promise<Proposal> {
    const existing = await this.records.getRowOrThrow(id);
    if ((existing.proposerUserId ?? '') !== user.id) {
      throw new ForbiddenException('You can only revise your own proposals');
    }
    if (existing.status !== 'pending') {
      throw new ConflictException(`Proposal ${id} is already ${existing.status}`);
    }
    if (!isProposableEntityType(existing.entityType)) {
      throw new BadRequestException(`Unsupported proposal entityType: ${existing.entityType}`);
    }
    const action = existing.action as ProposalAction;
    if (action === 'delete') {
      throw new BadRequestException('Delete proposals have no payload to revise');
    }
    const validated = this.validatePayload(existing.entityType, action, input.payload);
    const revised = await this.records.revisePayload(id, validated, role);
    if (!revised) {
      const current = await this.records.getRowOrThrow(id);
      throw new ConflictException(`Proposal ${id} is already ${current.status}`);
    }
    return revised;
  }

  /**
   * Batch approve/reject. Each id is resolved independently through the same single-item
   * path (and its atomic CAS), so one failure (already-resolved, invalid payload, missing
   * access) doesn't abort the rest — the caller gets a per-id result. `resolveAccess` maps
   * a proposal's campaignId to the caller's role there (dm required), so a batch spanning
   * campaigns is access-checked per item.
   */
  async resolveBatch(
    ids: number[],
    action: 'approve' | 'reject',
    note: string | undefined,
    user: RequestUser,
    resolveAccess: (campaignId: number) => Promise<Role>,
  ): Promise<BatchResolveResult[]> {
    const results: BatchResolveResult[] = [];
    for (const id of ids) {
      try {
        const row = await this.records.getRowOrThrow(id);
        const role = await resolveAccess(row.campaignId);
        const proposal =
          action === 'approve'
            ? await this.approve(id, { note }, user, role)
            : await this.reject(id, { note }, user, role);
        results.push({ id, ok: true, proposal });
      } catch (err) {
        const status = typeof (err as { getStatus?: () => number }).getStatus === 'function' ? (err as { getStatus: () => number }).getStatus() : 500;
        const error = err instanceof Error ? err.message : String(err);
        results.push({ id, ok: false, status, error });
      }
    }
    return results;
  }
}
