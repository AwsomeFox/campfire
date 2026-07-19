import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
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

  /** Applies the proposal's payload through the SAME service create/update path used by the direct write endpoints, so invariants hold. */
  async approve(id: number, input: ProposalResolveInput, user: RequestUser, role: Role): Promise<Proposal> {
    const existing = await this.records.getRowOrThrow(id);
    if (existing.status !== 'pending') {
      throw new ForbiddenException(`Proposal ${id} is already ${existing.status}`);
    }
    if (!isProposableEntityType(existing.entityType)) {
      throw new BadRequestException(`Unsupported proposal entityType: ${existing.entityType}`);
    }

    const payload = fromJsonText<Record<string, unknown>>(existing.payload, {});
    const action = existing.action as ProposalAction;
    const validated = this.validatePayload(existing.entityType, action, payload);
    const service = this.serviceFor(existing.entityType);

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

    const resolved = await this.records.markResolved(id, 'approved', input.note ?? '', user);

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
}
