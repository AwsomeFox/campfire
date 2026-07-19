import { BadRequestException, HttpException, Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  CombatantCreate,
  DangerLevel,
  EntityType,
  Id,
  LocationCreate,
  LocationUpdate,
  NoteVisibility,
  NpcCreate,
  NpcUpdate,
  QuestCreate,
  QuestStatus,
  QuestUpdate,
  RollRequest,
  RuleEntryType,
  SessionCreate,
} from '@campfire/schema';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { QuestsService } from '../quests/quests.service';
import { NpcsService } from '../npcs/npcs.service';
import { LocationsService } from '../locations/locations.service';
import { SessionsService } from '../sessions/sessions.service';
import { CharactersService } from '../characters/characters.service';
import { NotesService } from '../notes/notes.service';
import { ProposalRecordsService } from '../proposals/proposal-records.service';
import { ProposalsService } from '../proposals/proposals.service';
import { RulesService } from '../rules/rules.service';
import { EncountersService } from '../encounters/encounters.service';

const SERVER_INFO = { name: 'campfire', version: '0.1.0' };

interface ToolResult {
  [x: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown): ToolResult {
  let message: string;
  if (err instanceof HttpException) {
    const res = err.getResponse();
    const detail = typeof res === 'string' ? res : JSON.stringify(res);
    message = `${err.getStatus()}: ${detail}`;
  } else if (err instanceof z.ZodError) {
    message = `400: validation failed — ${JSON.stringify(err.issues)}`;
  } else if (err instanceof Error) {
    message = err.message;
  } else {
    message = String(err);
  }
  return { isError: true, content: [{ type: 'text', text: message }] };
}

const CampaignIdArg = z.number().int().positive().describe('Campaign id');
const ProposeArg = z
  .boolean()
  .optional()
  .describe('If true, submit as a proposal for DM approval instead of writing directly (quest/npc/location/session only)');

/**
 * Builds a per-request McpServer whose tools are bound to the authenticated
 * RequestUser. Stateless: one server + transport per POST /mcp.
 *
 * Every tool resolves the effective campaign role via CampaignAccessService
 * (which applies PAT scope caps via RoleResolver) and then calls the SAME
 * domain services the REST controllers use — no new business logic. Audit
 * entries therefore record `token:<name>` automatically for PAT callers.
 */
@Injectable()
export class McpToolsService {
  constructor(
    private readonly access: CampaignAccessService,
    private readonly campaigns: CampaignsService,
    private readonly quests: QuestsService,
    private readonly npcs: NpcsService,
    private readonly locations: LocationsService,
    private readonly sessions: SessionsService,
    private readonly characters: CharactersService,
    private readonly notes: NotesService,
    private readonly proposalRecords: ProposalRecordsService,
    private readonly proposals: ProposalsService,
    private readonly rules: RulesService,
    private readonly encounters: EncountersService,
  ) {}

  buildServer(user: RequestUser): McpServer {
    const server = new McpServer(SERVER_INFO, {
      instructions:
        'Campfire D&D campaign tracker. Read/write campaigns, quests, NPCs, locations, characters, session recaps, ' +
        'notes and proposals. Writes on quest/npc/location/session accept propose:true to queue a DM-approval proposal ' +
        'instead of writing directly.',
    });
    this.registerReadTools(server, user);
    this.registerWriteTools(server, user);
    return server;
  }

  private tool(
    server: McpServer,
    name: string,
    description: string,
    shape: z.ZodRawShape,
    handler: (args: Record<string, unknown>) => Promise<unknown>,
  ): void {
    // Cast away the SDK's deep conditional generics (TS2589 with a non-literal ZodRawShape);
    // runtime behavior is unchanged — the SDK still validates args against `shape`.
    const register = server.registerTool.bind(server) as (
      name: string,
      config: { description: string; inputSchema: z.ZodRawShape },
      cb: (args: Record<string, unknown>) => Promise<ToolResult>,
    ) => void;
    register(name, { description, inputSchema: shape }, async (args) => {
      try {
        return ok(await handler(args ?? {}));
      } catch (err) {
        return fail(err);
      }
    });
  }

  // ---------- READ ----------

  private registerReadTools(server: McpServer, user: RequestUser): void {
    this.tool(server, 'list_campaigns', 'List the campaigns this user (or token) can access.', {}, async () =>
      this.campaigns.listForUser(user),
    );

    this.tool(
      server,
      'get_campaign_summary',
      'Full campaign dashboard: campaign, current location, quests (with objectives), NPCs, locations, characters, sessions, open inbox count.',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        const role = await this.access.requireMember(user, campaignId as number);
        return this.campaigns.summary(campaignId as number, role);
      },
    );

    this.tool(
      server,
      'get_quest',
      'Get a quest (with objectives) by id.',
      { questId: Id.describe('Quest id') },
      async ({ questId }) => {
        const row = await this.quests.getRowOrThrow(questId as number);
        const role = await this.access.requireMember(user, row.campaignId);
        return this.quests.getWithObjectivesOrThrow(questId as number, role);
      },
    );

    this.tool(
      server,
      'list_quests',
      'List quests in a campaign, optionally filtered by status.',
      { campaignId: CampaignIdArg, status: QuestStatus.optional().describe('Filter by quest status') },
      async ({ campaignId, status }) => {
        const role = await this.access.requireMember(user, campaignId as number);
        return this.quests.listForCampaignByStatus(campaignId as number, status as string | undefined, role);
      },
    );

    this.tool(server, 'get_npc', 'Get an NPC by id.', { npcId: Id.describe('NPC id') }, async ({ npcId }) => {
      const row = await this.npcs.getRowOrThrow(npcId as number);
      const role = await this.access.requireMember(user, row.campaignId);
      return this.npcs.getOrThrow(npcId as number, role);
    });

    this.tool(server, 'list_npcs', 'List NPCs in a campaign.', { campaignId: CampaignIdArg }, async ({ campaignId }) => {
      const role = await this.access.requireMember(user, campaignId as number);
      return this.npcs.listForCampaign(campaignId as number, role);
    });

    this.tool(
      server,
      'get_location',
      'Get a location by id.',
      { locationId: Id.describe('Location id') },
      async ({ locationId }) => {
        const row = await this.locations.getRowOrThrow(locationId as number);
        const role = await this.access.requireMember(user, row.campaignId);
        return this.locations.getOrThrow(locationId as number, role);
      },
    );

    this.tool(
      server,
      'list_locations',
      'List locations in a campaign.',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        const role = await this.access.requireMember(user, campaignId as number);
        return this.locations.listForCampaign(campaignId as number, role);
      },
    );

    this.tool(
      server,
      'get_character',
      'Get a character sheet by id.',
      { characterId: Id.describe('Character id') },
      async ({ characterId }) => {
        const row = await this.characters.getRowOrThrow(characterId as number);
        await this.access.requireMember(user, row.campaignId);
        return this.characters.getOrThrow(characterId as number);
      },
    );

    this.tool(
      server,
      'get_party',
      'List all characters (the party) in a campaign.',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        await this.access.requireMember(user, campaignId as number);
        return this.characters.listForCampaign(campaignId as number);
      },
    );

    this.tool(
      server,
      'get_session_recaps',
      'List session recaps for a campaign, newest first. Optionally limit the count.',
      { campaignId: CampaignIdArg, limit: z.number().int().positive().max(100).optional().describe('Max sessions to return') },
      async ({ campaignId, limit }) => {
        await this.access.requireMember(user, campaignId as number);
        const list = await this.sessions.listForCampaign(campaignId as number);
        return limit !== undefined ? list.slice(0, limit as number) : list;
      },
    );

    this.tool(
      server,
      'read_inbox',
      'DM only: list open (unresolved) player inbox items for a campaign.',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        await this.access.requireRole(user, campaignId as number, 'dm');
        return this.notes.listInbox(campaignId as number);
      },
    );

    this.tool(
      server,
      'list_proposals',
      'DM only: list proposals for a campaign, optionally filtered by status (pending|approved|rejected).',
      { campaignId: CampaignIdArg, status: z.enum(['pending', 'approved', 'rejected']).optional().describe('Filter by status') },
      async ({ campaignId, status }) => {
        await this.access.requireRole(user, campaignId as number, 'dm');
        return this.proposals.listForCampaign(campaignId as number, status as string | undefined);
      },
    );

    this.tool(
      server,
      'lookup_rule',
      'Search installed rule packs (spells, monsters, items, conditions, etc.) for a rules question. Returns up to 5 ' +
        'matches; the top match includes its full body text so the caller can quote/cite it directly.',
      { query: z.string().min(1).max(200).describe('Free-text search query'), type: RuleEntryType.optional().describe('Filter by entry type') },
      async ({ query, type }) => {
        const results = await this.rules.search({ q: query as string, type: type as z.infer<typeof RuleEntryType> | undefined }, 5);
        return results.map((entry, i) => (i === 0 ? entry : { ...entry, body: undefined }));
      },
    );

    this.tool(
      server,
      'get_encounter',
      'Get an encounter (combat tracker) by id, including its full combatant list sorted by turn order.',
      { encounterId: Id.describe('Encounter id') },
      async ({ encounterId }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        await this.access.requireMember(user, row.campaignId);
        return this.encounters.getWithCombatantsOrThrow(encounterId as number);
      },
    );
  }

  // ---------- WRITE ----------

  private registerWriteTools(server: McpServer, user: RequestUser): void {
    this.tool(
      server,
      'create_quest',
      'Create a quest in a campaign (DM). With propose:true any member may submit it as a proposal instead.',
      { campaignId: CampaignIdArg, propose: ProposeArg, ...QuestCreate.shape },
      async ({ campaignId, propose, ...fields }) => {
        const validated = QuestCreate.parse(fields);
        if (propose) {
          const role = await this.access.requireMember(user, campaignId as number);
          const proposal = await this.proposalRecords.create(campaignId as number, 'quest', null, 'create', validated, user, role);
          return { proposal };
        }
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        return this.quests.create(campaignId as number, validated, user, role);
      },
    );

    this.tool(
      server,
      'update_quest',
      'Update a quest (DM). With propose:true any member may submit the change as a proposal instead.',
      { questId: Id.describe('Quest id'), propose: ProposeArg, ...QuestUpdate.shape },
      async ({ questId, propose, ...fields }) => {
        const row = await this.quests.getRowOrThrow(questId as number);
        const validated = QuestUpdate.parse(fields);
        if (propose) {
          const role = await this.access.requireMember(user, row.campaignId);
          const proposal = await this.proposalRecords.create(row.campaignId, 'quest', questId as number, 'update', validated, user, role);
          return { proposal };
        }
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.quests.update(questId as number, validated, user, role);
      },
    );

    this.tool(
      server,
      'set_quest_status',
      'Set a quest status: available | active | completed | failed (DM). With propose:true submits a quest-update proposal.',
      { questId: Id.describe('Quest id'), status: QuestStatus, propose: ProposeArg },
      async ({ questId, status, propose }) => {
        const row = await this.quests.getRowOrThrow(questId as number);
        if (propose) {
          const role = await this.access.requireMember(user, row.campaignId);
          const validated = QuestUpdate.parse({ status });
          const proposal = await this.proposalRecords.create(row.campaignId, 'quest', questId as number, 'update', validated, user, role);
          return { proposal };
        }
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.quests.setStatus(questId as number, { status: status as z.infer<typeof QuestStatus> }, user, role);
      },
    );

    this.tool(
      server,
      'add_objective',
      'Add an objective to a quest (DM).',
      { questId: Id.describe('Quest id'), text: z.string().min(1).max(500).describe('Objective text') },
      async ({ questId, text }) => {
        const row = await this.quests.getRowOrThrow(questId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.quests.addObjective(questId as number, { text: text as string }, user, role);
      },
    );

    this.tool(
      server,
      'check_objective',
      'Mark a quest objective done/undone (player or DM).',
      { questId: Id.describe('Quest id'), objectiveId: Id.describe('Objective id'), done: z.boolean().describe('Done state') },
      async ({ questId, objectiveId, done }) => {
        const row = await this.quests.getRowOrThrow(questId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'player');
        return this.quests.patchObjective(questId as number, objectiveId as number, { done: done as boolean }, user, role);
      },
    );

    this.tool(
      server,
      'upsert_npc',
      'Create an NPC (omit npcId) or update one (pass npcId). DM; with propose:true any member may submit a proposal instead.',
      {
        campaignId: CampaignIdArg,
        npcId: Id.optional().describe('Existing NPC id (update); omit to create'),
        propose: ProposeArg,
        ...NpcUpdate.shape,
      },
      async ({ campaignId, npcId, propose, ...fields }) => {
        if (npcId !== undefined) {
          const row = await this.npcs.getRowOrThrow(npcId as number);
          if (row.campaignId !== (campaignId as number)) {
            throw new BadRequestException(`NPC ${npcId} belongs to campaign ${row.campaignId}, not ${campaignId}`);
          }
          const validated = NpcUpdate.parse(fields);
          if (propose) {
            const role = await this.access.requireMember(user, row.campaignId);
            const proposal = await this.proposalRecords.create(row.campaignId, 'npc', npcId as number, 'update', validated, user, role);
            return { proposal };
          }
          const role = await this.access.requireRole(user, row.campaignId, 'dm');
          return this.npcs.update(npcId as number, validated, user, role);
        }
        const validated = NpcCreate.parse(fields); // name required on create
        if (propose) {
          const role = await this.access.requireMember(user, campaignId as number);
          const proposal = await this.proposalRecords.create(campaignId as number, 'npc', null, 'create', validated, user, role);
          return { proposal };
        }
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        return this.npcs.create(campaignId as number, validated, user, role);
      },
    );

    this.tool(
      server,
      'upsert_location',
      'Create a location (omit locationId) or update one (pass locationId). DM; with propose:true any member may submit a proposal instead.',
      {
        campaignId: CampaignIdArg,
        locationId: Id.optional().describe('Existing location id (update); omit to create'),
        propose: ProposeArg,
        ...LocationUpdate.shape,
      },
      async ({ campaignId, locationId, propose, ...fields }) => {
        if (locationId !== undefined) {
          const row = await this.locations.getRowOrThrow(locationId as number);
          if (row.campaignId !== (campaignId as number)) {
            throw new BadRequestException(`Location ${locationId} belongs to campaign ${row.campaignId}, not ${campaignId}`);
          }
          const validated = LocationUpdate.parse(fields);
          if (propose) {
            const role = await this.access.requireMember(user, row.campaignId);
            const proposal = await this.proposalRecords.create(row.campaignId, 'location', locationId as number, 'update', validated, user, role);
            return { proposal };
          }
          const role = await this.access.requireRole(user, row.campaignId, 'dm');
          return this.locations.update(locationId as number, validated, user, role);
        }
        const validated = LocationCreate.parse(fields); // name required on create
        if (propose) {
          const role = await this.access.requireMember(user, campaignId as number);
          const proposal = await this.proposalRecords.create(campaignId as number, 'location', null, 'create', validated, user, role);
          return { proposal };
        }
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        return this.locations.create(campaignId as number, validated, user, role);
      },
    );

    this.tool(
      server,
      'add_session_recap',
      'Add a session recap (DM). number defaults to max existing session number + 1. With propose:true any member may submit a proposal instead.',
      {
        campaignId: CampaignIdArg,
        number: z.number().int().positive().optional().describe('Session number; defaults to max + 1'),
        title: z.string().max(200).optional().describe('Session title'),
        recap: z.string().max(100_000).describe('Session recap (markdown)'),
        playedAt: z.string().optional().describe('ISO date the session was played'),
        propose: ProposeArg,
      },
      async ({ campaignId, number, title, recap, playedAt, propose }) => {
        // Membership is required even to compute the default number.
        const memberRole = await this.access.requireMember(user, campaignId as number);
        let sessionNumber = number as number | undefined;
        if (sessionNumber === undefined) {
          const existing = await this.sessions.listForCampaign(campaignId as number);
          sessionNumber = existing.reduce((max, s) => Math.max(max, s.number), 0) + 1;
        }
        const validated = SessionCreate.parse({
          number: sessionNumber,
          ...(title !== undefined ? { title } : {}),
          ...(playedAt !== undefined ? { playedAt } : {}),
          recap,
        });
        if (propose) {
          const proposal = await this.proposalRecords.create(campaignId as number, 'session', null, 'create', validated, user, memberRole);
          return { proposal };
        }
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        return this.sessions.create(campaignId as number, validated, user, role);
      },
    );

    this.tool(
      server,
      'update_character_hp',
      "Adjust a character's HP by delta, or set it absolutely (player owner or DM). Pass exactly one of delta | set.",
      {
        characterId: Id.describe('Character id'),
        delta: z.number().int().optional().describe('Relative HP change, e.g. -5'),
        set: z.number().int().nonnegative().optional().describe('Absolute HP value'),
      },
      async ({ characterId, delta, set }) => {
        if ((delta === undefined) === (set === undefined)) {
          throw new BadRequestException('Pass exactly one of delta or set');
        }
        const row = await this.characters.getRowOrThrow(characterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'player');
        const patch = delta !== undefined ? { delta: delta as number } : { set: set as number };
        return this.characters.patchHp(characterId as number, patch, user, role);
      },
    );

    this.tool(
      server,
      'add_note',
      'Add a note to a campaign (any member). Visibility: private (default) | dm_shared | party_shared.',
      {
        campaignId: CampaignIdArg,
        body: z.string().min(1).max(20_000).describe('Note body (markdown)'),
        visibility: NoteVisibility.optional().describe('private | dm_shared | party_shared'),
        entityType: EntityType.optional().describe('Optionally link to an entity type'),
        entityId: Id.optional().describe('Optionally link to an entity id'),
      },
      async ({ campaignId, body, visibility, entityType, entityId }) => {
        const role = await this.access.requireMember(user, campaignId as number);
        return this.notes.create(
          campaignId as number,
          {
            body: body as string,
            ...(visibility !== undefined ? { visibility: visibility as z.infer<typeof NoteVisibility> } : {}),
            ...(entityType !== undefined ? { entityType: entityType as z.infer<typeof EntityType> } : {}),
            ...(entityId !== undefined ? { entityId: entityId as number } : {}),
          },
          user,
          role,
        );
      },
    );

    this.tool(
      server,
      'resolve_inbox_item',
      'DM only: resolve a player inbox item, optionally with a resolution note.',
      { noteId: Id.describe('Inbox note id'), resolvedNote: z.string().max(1000).optional().describe('Resolution note') },
      async ({ noteId, resolvedNote }) => {
        const row = await this.notes.getRowOrThrow(noteId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.notes.resolveInbox(noteId as number, { resolvedNote: (resolvedNote as string | undefined) ?? '' }, user, role);
      },
    );

    this.tool(
      server,
      'update_campaign_status',
      'DM only: update campaign state — current location and/or danger level.',
      {
        campaignId: CampaignIdArg,
        currentLocationId: Id.nullable().optional().describe('Current location id (null to clear)'),
        dangerLevel: DangerLevel.optional().describe('low | moderate | high | deadly'),
      },
      async ({ campaignId, currentLocationId, dangerLevel }) => {
        await this.access.requireRole(user, campaignId as number, 'dm');
        const patch: { currentLocationId?: number | null; dangerLevel?: z.infer<typeof DangerLevel> } = {};
        if (currentLocationId !== undefined) patch.currentLocationId = currentLocationId as number | null;
        if (dangerLevel !== undefined) patch.dangerLevel = dangerLevel as z.infer<typeof DangerLevel>;
        if (Object.keys(patch).length === 0) {
          throw new BadRequestException('Pass at least one of currentLocationId or dangerLevel');
        }
        return this.campaigns.update(campaignId as number, patch, user);
      },
    );

    this.tool(
      server,
      'approve_proposal',
      'DM only: approve a pending proposal — applies it through the normal service write path.',
      { proposalId: Id.describe('Proposal id'), note: z.string().max(1000).optional().describe('Resolution note') },
      async ({ proposalId, note }) => {
        const row = await this.proposals.getRowOrThrow(proposalId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.proposals.approve(proposalId as number, { note: note as string | undefined }, user, role);
      },
    );

    this.tool(
      server,
      'reject_proposal',
      'DM only: reject a pending proposal.',
      { proposalId: Id.describe('Proposal id'), note: z.string().max(1000).optional().describe('Resolution note') },
      async ({ proposalId, note }) => {
        const row = await this.proposals.getRowOrThrow(proposalId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.proposals.reject(proposalId as number, { note: note as string | undefined }, user, role);
      },
    );

    this.tool(
      server,
      'roll_dice',
      'Roll a dice expression, e.g. "1d20+3" or "2d6", in the context of a campaign. Any campaign member may use ' +
        'this; the roll is audited (action "dice.roll").',
      { campaignId: CampaignIdArg, expr: RollRequest.shape.expr.describe('Dice expression, e.g. "1d20+3"') },
      async ({ campaignId, expr }) => {
        const role = await this.access.requireMember(user, campaignId as number);
        return this.encounters.rollDiceForCampaign(campaignId as number, { expr: expr as string }, user, role);
      },
    );

    this.tool(
      server,
      'create_encounter',
      'DM only: create a new encounter (combat tracker) in a campaign, status=preparing. Auto-adds every campaign ' +
        'character as a combatant with hp from their sheet and initiative modifier from DEX.',
      { campaignId: CampaignIdArg, name: z.string().min(1).max(120).describe('Encounter name') },
      async ({ campaignId, name }) => {
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        return this.encounters.create(campaignId as number, { name: name as string }, user, role);
      },
    );

    this.tool(
      server,
      'add_combatant',
      'DM only: add a combatant (monster or character) to an encounter. Pass ruleEntryId to pull name/hp from a ' +
        'compendium monster statblock, or characterId to pull from a character sheet, when name/hpMax are omitted.',
      { encounterId: Id.describe('Encounter id'), ...CombatantCreate.shape },
      async ({ encounterId, ...fields }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        const validated = CombatantCreate.parse(fields);
        return this.encounters.addCombatant(encounterId as number, validated, user, role);
      },
    );

    this.tool(
      server,
      'roll_initiative',
      'DM only: roll d20+initMod for every combatant in an encounter that does not already have an initiative set.',
      { encounterId: Id.describe('Encounter id') },
      async ({ encounterId }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.encounters.rollInitiative(encounterId as number, user, role);
      },
    );

    this.tool(
      server,
      'begin_encounter',
      'DM only: start an encounter (status=running, round=1, turn 0). Fails with a 400 if any combatant is missing ' +
        'initiative — roll_initiative first.',
      { encounterId: Id.describe('Encounter id') },
      async ({ encounterId }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.encounters.start(encounterId as number, user, role);
      },
    );

    this.tool(
      server,
      'next_turn',
      'DM only: advance an encounter to the next combatant’s turn, wrapping to the next round when past the last combatant.',
      { encounterId: Id.describe('Encounter id') },
      async ({ encounterId }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.encounters.nextTurn(encounterId as number, user, role);
      },
    );

    this.tool(
      server,
      'end_encounter',
      'DM only: end an encounter and write every character combatant’s current hp back onto their character record.',
      { encounterId: Id.describe('Encounter id') },
      async ({ encounterId }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.encounters.end(encounterId as number, user, role);
      },
    );
  }
}
