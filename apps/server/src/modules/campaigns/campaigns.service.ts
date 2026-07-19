import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { CampaignCreate, CampaignUpdate } from '@campfire/schema';
import type { Campaign, CampaignSummary } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { campaigns, notes } from '../../db/schema';
import { nowIso } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import { QuestsService } from '../quests/quests.service';
import { NpcsService } from '../npcs/npcs.service';
import { LocationsService } from '../locations/locations.service';
import { CharactersService } from '../characters/characters.service';
import { SessionsService } from '../sessions/sessions.service';
import type { RequestUser } from '../../common/user.types';

type CampaignCreateInput = z.infer<typeof CampaignCreate>;
type CampaignUpdateInput = z.infer<typeof CampaignUpdate>;

function toDomain(row: typeof campaigns.$inferSelect): Campaign {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status as Campaign['status'],
    currentLocationId: row.currentLocationId,
    dangerLevel: row.dangerLevel as Campaign['dangerLevel'],
    sessionCount: row.sessionCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class CampaignsService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
    private readonly quests: QuestsService,
    private readonly npcs: NpcsService,
    private readonly locations: LocationsService,
    private readonly characters: CharactersService,
    private readonly sessions: SessionsService,
  ) {}

  async list(): Promise<Campaign[]> {
    const rows = await this.db.select().from(campaigns);
    return rows.map(toDomain);
  }

  async getOrThrow(id: number): Promise<Campaign> {
    const [row] = await this.db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Campaign ${id} not found`);
    return toDomain(row);
  }

  async create(input: CampaignCreateInput, user: RequestUser): Promise<Campaign> {
    const ts = nowIso();
    const [row] = await this.db
      .insert(campaigns)
      .values({
        name: input.name,
        description: input.description ?? '',
        status: input.status ?? 'active',
        currentLocationId: input.currentLocationId ?? null,
        dangerLevel: input.dangerLevel ?? 'low',
        sessionCount: 0,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();
    await this.audit.log({
      actor: user.id,
      actorRole: user.role,
      action: 'campaign.create',
      entityType: 'campaign',
      entityId: row.id,
      campaignId: row.id,
    });
    return toDomain(row);
  }

  async update(id: number, input: CampaignUpdateInput, user: RequestUser): Promise<Campaign> {
    await this.getOrThrow(id);
    const [row] = await this.db
      .update(campaigns)
      .set({ ...input, updatedAt: nowIso() })
      .where(eq(campaigns.id, id))
      .returning();
    await this.audit.log({
      actor: user.id,
      actorRole: user.role,
      action: 'campaign.update',
      entityType: 'campaign',
      entityId: id,
      campaignId: id,
    });
    return toDomain(row);
  }

  async remove(id: number, user: RequestUser): Promise<void> {
    await this.getOrThrow(id);
    await this.db.delete(campaigns).where(eq(campaigns.id, id));
    await this.audit.log({
      actor: user.id,
      actorRole: user.role,
      action: 'campaign.delete',
      entityType: 'campaign',
      entityId: id,
      campaignId: id,
    });
  }

  async summary(id: number, user: RequestUser): Promise<CampaignSummary> {
    const campaign = await this.getOrThrow(id);

    const [questList, npcList, locationList, characterList, sessionList] = await Promise.all([
      this.quests.listForCampaignWithObjectives(id, user.role),
      this.npcs.listForCampaign(id, user.role),
      this.locations.listForCampaign(id, user.role),
      this.characters.listForCampaign(id),
      this.sessions.listForCampaign(id),
    ]);

    const currentLocation = campaign.currentLocationId
      ? (locationList.find((l) => l.id === campaign.currentLocationId) ?? null)
      : null;

    const openInboxRows = await this.db
      .select()
      .from(notes)
      .where(eq(notes.campaignId, id));
    const openInboxCount = openInboxRows.filter((n) => n.kind === 'inbox' && !n.resolved).length;

    return {
      campaign,
      currentLocation,
      quests: questList,
      npcs: npcList,
      locations: locationList,
      characters: characterList,
      sessions: sessionList,
      openInboxCount,
    };
  }
}
