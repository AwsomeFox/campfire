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
  ProposalApprove,
  ProposalResolve,
} from '@campfire/schema';
import type { Proposal, ProposalAction, Role } from '@campfire/schema';
import { fromJsonText } from '../../common/json';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import { AuditService } from '../audit/audit.service';
import { QuestsService } from '../quests/quests.service';
import { NpcsService } from '../npcs/npcs.service';
import { LocationsService } from '../locations/locations.service';
import { SessionsService } from '../sessions/sessions.service';
import { CharactersService } from '../characters/characters.service';
import { ProposalRecordsService, isProposableEntityType, type ProposableEntityType } from './proposal-records.service';

type ProposalResolveInput = z.infer<typeof ProposalResolve>;
type ProposalApproveInput = z.infer<typeof ProposalApprove>;

/** One entry in a batch approve/reject result — success carries the resolved proposal, failure the reason. */
export type BatchResolveResult =
  | { id: number; ok: true; proposal: Proposal }
  | { id: number; ok: false; status: number; error: string };

export { isProposableEntityType, type ProposableEntityType } from './proposal-records.service';

/** Zod input schema per entity type/action — used to validate a proposal payload before applying it. */
const CREATE_SCHEMAS: Record<ProposableEntityType, z.ZodTypeAny> = {
  quest: QuestCreate,
  npc: NpcCreate,
  location: LocationCreate,
  session: SessionCreate,
  character: CharacterCreate,
};
const UPDATE_SCHEMAS: Record<ProposableEntityType, z.ZodTypeAny> = {
  quest: QuestUpdate,
  npc: NpcUpdate,
  location: LocationUpdate,
  session: SessionUpdate,
  character: CharacterUpdate,
};

@Injectable()
export class ProposalsService {
  constructor(
    private readonly records: ProposalRecordsService,
    private readonly audit: AuditService,
    private readonly quests: QuestsService,
    private readonly npcs: NpcsService,
    private readonly locations: LocationsService,
    private readonly sessions: SessionsService,
    private readonly characters: CharactersService,
  ) {}

  async listForCampaign(campaignId: number, status: string | undefined): Promise<Proposal[]> {
    return this.records.listForCampaign(campaignId, status);
  }

  async latestForCampaign(campaignId: number, limit = 500): Promise<Proposal[]> {
    return this.records.latestForCampaign(campaignId, limit);
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
    }
  }

  /**
   * Applies the proposal through the SAME service create/update/delete path used by the
   * direct write endpoints, so invariants hold. `input.payload` (edit-before-approve) lets
   * the DM amend the proposed create/update body before it's applied — the amended payload
   * is validated and persisted onto the record so it matches what was written. The status
   * flip is an atomic compare-and-set (see markResolved): a concurrent double-approve 409s.
   */
  async approve(id: number, input: ProposalApproveInput, user: RequestUser, role: Role): Promise<Proposal> {
    const existing = await this.records.getRowOrThrow(id);
    if (existing.status !== 'pending') {
      throw new ForbiddenException(`Proposal ${id} is already ${existing.status}`);
    }
    if (!isProposableEntityType(existing.entityType)) {
      throw new BadRequestException(`Unsupported proposal entityType: ${existing.entityType}`);
    }

    const action = existing.action as ProposalAction;
    const service = this.serviceFor(existing.entityType);
    // Edit-before-approve: an amended payload replaces the stored one (create/update only).
    const amended = input.payload !== undefined && action !== 'delete';
    const payload = amended ? input.payload! : fromJsonText<Record<string, unknown>>(existing.payload, {});

    if (action === 'delete') {
      if (existing.entityId === null) {
        throw new BadRequestException('delete proposal missing entityId');
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (service as any).remove(existing.entityId, user, role);
    } else {
      const validated = this.validatePayload(existing.entityType, action, payload);
      if (amended) {
        // Persist the DM's amended body so the record reflects what was actually applied.
        await this.records.updatePayload(id, validated);
      }
      if (action === 'create') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (service as any).create(existing.campaignId, validated, user, role);
      } else {
        if (existing.entityId === null) {
          throw new BadRequestException('update proposal missing entityId');
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (service as any).update(existing.entityId, validated, user, role);
      }
    }

    const resolved = await this.records.markResolved(id, 'approved', input.note ?? '', user);
    if (resolved === null) {
      // Lost the race to a concurrent resolution after we already applied the write.
      throw new ConflictException(`Proposal ${id} was resolved concurrently`);
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'proposal.approve',
      entityType: existing.entityType,
      entityId: id,
      campaignId: existing.campaignId,
    });

    return resolved;
  }

  async reject(id: number, input: ProposalResolveInput, user: RequestUser, role: Role): Promise<Proposal> {
    const existing = await this.records.getRowOrThrow(id);
    if (existing.status !== 'pending') {
      throw new ForbiddenException(`Proposal ${id} is already ${existing.status}`);
    }

    const resolved = await this.records.markResolved(id, 'rejected', input.note ?? '', user);
    if (resolved === null) {
      throw new ConflictException(`Proposal ${id} was resolved concurrently`);
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'proposal.reject',
      entityType: existing.entityType,
      entityId: id,
      campaignId: existing.campaignId,
    });

    return resolved;
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
