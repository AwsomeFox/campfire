import { BadRequestException, ForbiddenException, HttpException, Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  CampaignCreate,
  CampaignUpdate,
  CharacterCreate,
  CharacterUpdate,
  CombatantCreate,
  CombatantUpdate,
  DangerLevel,
  EntityType,
  Id,
  LocationCreate,
  LocationStatus,
  LocationUpdate,
  MemberCreate,
  MemberUpdate,
  NoteVisibility,
  NpcCreate,
  NpcUpdate,
  QuestCreate,
  QuestStatus,
  QuestUpdate,
  Role,
  RollRequest,
  RulePackInstall,
  RuleEntryType,
  RECAP_TEMPLATE,
  SessionCreate,
  SessionUpdate,
  XpAward,
} from '@campfire/schema';
import { hasServerAdminPower, type RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { QuestsService } from '../quests/quests.service';
import { NpcsService } from '../npcs/npcs.service';
import { LocationsService } from '../locations/locations.service';
import { SessionsService, buildRecapDraft } from '../sessions/sessions.service';
import { CharactersService } from '../characters/characters.service';
import { NotesService } from '../notes/notes.service';
import { MembersService } from '../membership/members.service';
import { ProposalRecordsService } from '../proposals/proposal-records.service';
import { ProposalsService } from '../proposals/proposals.service';
import { RulesService } from '../rules/rules.service';
import { EncountersService } from '../encounters/encounters.service';
import { AuditService } from '../audit/audit.service';
import { ExportService } from '../export/export.service';

const SERVER_INFO = { name: 'campfire', version: '0.1.0' };

interface ToolResult {
  [x: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/**
 * Structured error content: every isError result's text is a JSON object
 * `{"error":{"status","code","message"}}` so a calling agent can branch on
 * `status`/`code` programmatically instead of string-matching prose. `code`
 * is a short machine-friendly slug derived from the HTTP status (or
 * "validation_failed" for a raw ZodError, e.g. from `.strict()` rejecting an
 * unknown arg key).
 */
function fail(err: unknown): ToolResult {
  let status: number;
  let code: string;
  let message: string;
  if (err instanceof HttpException) {
    status = err.getStatus();
    const res = err.getResponse();
    if (typeof res === 'string') {
      message = res;
    } else {
      const obj = res as { message?: unknown; error?: unknown };
      message = typeof obj.message === 'string' ? obj.message : Array.isArray(obj.message) ? obj.message.join('; ') : JSON.stringify(res);
    }
    code =
      status === 404
        ? 'not_found'
        : status === 403
          ? 'forbidden'
          : status === 400
            ? 'bad_request'
            : status === 409
              ? 'conflict'
              : status === 401
                ? 'unauthorized'
                : 'error';
  } else if (err instanceof z.ZodError) {
    status = 400;
    code = 'validation_failed';
    message = err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  } else if (err instanceof Error) {
    status = 500;
    code = 'internal_error';
    message = err.message;
  } else {
    status = 500;
    code = 'internal_error';
    message = String(err);
  }
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { status, code, message } }) }] };
}

const CampaignIdArg = z.number().int().positive().describe('Campaign id — from list_campaigns or get_campaign_summary');
const ProposeArg = z
  .boolean()
  .optional()
  .describe(
    'If true, submit as a proposal for DM approval instead of writing directly (quest/npc/location/session only). ' +
      'Any member may propose; the returned {proposal} is pending until a dm calls approve_proposal/reject_proposal. ' +
      'Ignored on tools with no REST proposal path (objectives, characters, notes, campaign status, members, encounters).',
  );
const LimitArg = (max: number, fallback: number) =>
  z.number().int().positive().max(max).optional().describe(`Max rows to return (default ${fallback}, max ${max})`);
const OffsetArg = z.number().int().nonnegative().optional().describe('Rows to skip, for paging (default 0)');

/**
 * Deep-clone a zod schema so every node gets a fresh `_def` object.
 *
 * Why: the MCP SDK serializes each tool's inputSchema for `tools/list` with
 * zod-to-json-schema, which tracks visited `_def`s by object identity and emits
 * any SECOND occurrence as a local `$ref` instead of inlining it. Shared
 * singletons in @campfire/schema (e.g. `Id`, reused by CombatantCreate's
 * `characterId` AND `ruleEntryId`) therefore surfaced as sibling-property refs
 * like `{"$ref":"#/properties/characterId"}` — valid JSON Schema, but many MCP
 * clients don't resolve refs between sibling properties, and the field's own
 * type/description metadata was dropped (issue #31; also hit create_quest/
 * update_quest `giverNpcId`, upsert_npc `locationId`, add_member `characterId`).
 * Cloning (zod's own `.describe()` clone pattern, applied recursively) keeps
 * validation behavior identical while guaranteeing every property serializes
 * inline.
 */
function inlineClone<T extends z.ZodTypeAny>(schema: T): T {
  const def = schema._def as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(def)) {
    if (value instanceof z.ZodType) {
      // wrapper/composite nodes: optional/nullable/default `innerType`, array element `type`, effects `schema`, object `catchall`, …
      next[key] = inlineClone(value);
    } else if (Array.isArray(value) && value.length > 0 && value.every((v) => v instanceof z.ZodType)) {
      next[key] = value.map((v) => inlineClone(v as z.ZodTypeAny)); // union options / tuple items
    } else {
      next[key] = value; // plain metadata (typeName, checks, description, defaultValue, enum values, …)
    }
  }
  if (typeof def.shape === 'function') {
    // ZodObject exposes its shape lazily through a function — rebuild it over cloned properties.
    const shape = (def.shape as () => z.ZodRawShape)();
    const clonedShape: z.ZodRawShape = {};
    for (const [key, value] of Object.entries(shape)) clonedShape[key] = inlineClone(value);
    next.shape = () => clonedShape;
  }
  return new (schema.constructor as new (d: Record<string, unknown>) => T)(next);
}

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
    private readonly members: MembersService,
    private readonly proposalRecords: ProposalRecordsService,
    private readonly proposals: ProposalsService,
    private readonly rules: RulesService,
    private readonly encounters: EncountersService,
    private readonly audit: AuditService,
    private readonly exportService: ExportService,
  ) {}

  buildServer(user: RequestUser): McpServer {
    const server = new McpServer(SERVER_INFO, {
      instructions:
        'Campfire is a D&D-style campaign tracker. This server exposes the full REST surface as tools so an agent ' +
        'can run an entire campaign (world-building, session prep, and live combat) over MCP alone.\n\n' +
        'BOOTSTRAP / ID DISCOVERY — ids are never guessable, always discover them:\n' +
        '  1. list_campaigns -> pick a campaignId.\n' +
        '  2. get_campaign_summary {campaignId} -> full dashboard: campaign, current location, quests (with ' +
        'objectives), npcs, locations, characters, sessions, open inbox count. This is the cheapest way to learn ' +
        'every entity id in a campaign in one call — prefer it over multiple list_* calls when starting fresh.\n' +
        '  3. For anything not in the summary (encounters, notes, rule entries, members, proposals, audit log), ' +
        'use the matching list_* tool first (e.g. list_encounters before get_encounter/update_combatant) to get ids.\n\n' +
        'ROLES — every tool resolves the caller\'s EFFECTIVE role for the campaign in question: dm > player > viewer ' +
        '(ranked; a higher role can do everything a lower one can). dm: full write access, secrets (dmSecret fields, ' +
        'NPC/quest/location DM-only text), approve/reject proposals, install rule packs (server admin only), manage ' +
        'members. player: create/update their own character, roll dice, check objectives, post notes/inbox items, ' +
        'act on combatants linked to characters they own. viewer: read-only, plus dice rolls and notes/inbox (any ' +
        'member may post). ENTITY-LEVEL SECRECY — beyond dmSecret (which strips one field), a quest/NPC marked ' +
        'hidden:true, and any location still status:"unexplored", are DM-only: they are excluded WHOLESALE from ' +
        'every non-DM list/get/summary/export (a non-DM get 404s). The DM reveals a quest/NPC by setting ' +
        'hidden=false, and a location via set_location_discovery (status → explored|current). ' +
        'Server admins hold NO implicit campaign role (admin != auto-DM): campaign access, ' +
        'including DM secrets, comes only from an actual membership row, exactly like any other user. A PAT ' +
        '(personal access token) additionally CAPS the effective role to min(token scope, ' +
        'real membership role) and, if the token is bound to one campaignId, 403s on every other campaign. ' +
        'SERVER-admin power (install_rule_pack, and ' +
        'REST-only routes like POST /users and /settings) is capped separately and more strictly: a PAT never ' +
        'carries server-admin power unless it was explicitly minted with adminEnabled:true by a caller who ' +
        'currently held real server-admin power themselves — an admin\'s ordinary/viewer-scoped token is NOT an ' +
        'admin token by default.\n\n' +
        'PROPOSE-THEN-APPROVE — quest/npc/location/session create+update (and set_quest_status, which proposes a ' +
        'quest update) accept propose:true: any member may submit a change as a pending Proposal instead of writing ' +
        'directly; a dm later calls approve_proposal (applies it through the normal write path) or reject_proposal. ' +
        'Use this when acting as a player-role agent proposing world changes for a human DM to review. propose is ' +
        'not available on objectives, characters, notes, campaign status, members, or combat tools — those write ' +
        'directly and are already gated by role.\n\n' +
        'ARCHIVED CAMPAIGNS — a campaign whose status is paused or completed is READ-ONLY: every write tool ' +
        '(quests, npcs, locations, sessions, characters, notes, inbox, members, encounters, dice rolls, proposal ' +
        'submission/approval) fails with 403 until a dm sets status back to "active" via update_campaign_status. ' +
        'Reads, export_campaign, read_audit_log, delete_campaign, and the status flip itself still work.\n\n' +
        'ERRORS — a failed call returns isError:true with JSON text {"error":{"status","code","message"}} (e.g. ' +
        'status 404/code "not_found", status 403/code "forbidden", status 400/code "validation_failed"). Every ' +
        'tool\'s argument object is strict — an unknown/misspelled key is a validation_failed error, not a silent ' +
        'no-op, so check the message and retry with corrected keys rather than assuming the call succeeded.',
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
    // Every tool's args are validated against z.object(shape).strict() — an unknown/
    // misnamed key (e.g. {hpCurrent} instead of {hpSet}) is a validation_failed error
    // instead of being silently dropped by a non-strict object parse.
    // Cast away the SDK's deep conditional generics (TS2589 with a non-literal
    // ZodRawShape); passing a prebuilt ZodObject instance (rather than the raw shape) is
    // an officially supported `inputSchema` form and is what carries `.strict()` through
    // to `tools/list`'s JSON schema (additionalProperties:false). inlineClone() breaks
    // shared zod-instance identity so no property serializes as a sibling $ref (see above).
    const strictShape = inlineClone(z.object(shape).strict());
    // The SDK runs its own validation against inputSchema BEFORE invoking our callback
    // and, on failure, returns its "-32602 Input validation error ..." prose as the
    // isError text — NOT the documented {"error":{status,code,message}} JSON (our
    // try/catch below never runs). Shadow safeParseAsync — the only parse entry point
    // the SDK's per-call validation uses for a zod-v3 object schema — so the SDK's
    // pre-parse always passes, and run the real strict parse inside the callback where
    // fail() renders a ZodError as {"error":{status:400,code:"validation_failed",...}}.
    // tools/list is unaffected: JSON-schema generation reads the object shape (not the
    // parse method), so additionalProperties:false is still advertised.
    (strictShape as { safeParseAsync: unknown }).safeParseAsync = (data: unknown) =>
      Promise.resolve({ success: true as const, data });
    const register = server.registerTool.bind(server) as (
      name: string,
      config: { description: string; inputSchema: z.ZodTypeAny },
      cb: (args: Record<string, unknown>) => Promise<ToolResult>,
    ) => void;
    register(name, { description, inputSchema: strictShape }, async (args) => {
      try {
        const validated = strictShape.parse(args ?? {}) as Record<string, unknown>;
        return ok(await handler(validated));
      } catch (err) {
        return fail(err);
      }
    });
  }

  // ---------- READ ----------

  private registerReadTools(server: McpServer, user: RequestUser): void {
    this.tool(server, 'list_campaigns', 'List the campaigns this user (or token) can access. Start here.', {}, async () =>
      this.campaigns.listForUser(user),
    );

    this.tool(
      server,
      'get_campaign_summary',
      'Full campaign dashboard: campaign, current location, quests (with objectives), NPCs, locations, characters, ' +
        'sessions, open inbox count. The cheapest single call to learn every core entity id in a campaign.',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        const role = await this.access.requireMember(user, campaignId as number);
        return this.campaigns.summary(campaignId as number, role);
      },
    );

    this.tool(
      server,
      'get_quest',
      'Get a quest (with objectives) by id. Ids come from list_quests or get_campaign_summary.',
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
      'List quests in a campaign, optionally filtered by status. Quests may nest as subquests via parentId.',
      { campaignId: CampaignIdArg, status: QuestStatus.optional().describe('Filter by quest status') },
      async ({ campaignId, status }) => {
        const role = await this.access.requireMember(user, campaignId as number);
        return this.quests.listForCampaignByStatus(campaignId as number, status as string | undefined, role);
      },
    );

    this.tool(server, 'get_npc', 'Get an NPC by id. Ids come from list_npcs or get_campaign_summary.', { npcId: Id.describe('NPC id') }, async ({ npcId }) => {
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
      'Get a location by id. Ids come from list_locations or get_campaign_summary.',
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
      'Get a character sheet by id. Ids come from get_party or get_campaign_summary.',
      { characterId: Id.describe('Character id') },
      async ({ characterId }) => {
        const row = await this.characters.getRowOrThrow(characterId as number);
        const role = await this.access.requireMember(user, row.campaignId);
        return this.characters.getOrThrow(characterId as number, role);
      },
    );

    this.tool(
      server,
      'get_party',
      'List all characters (the party) in a campaign.',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        const role = await this.access.requireMember(user, campaignId as number);
        return this.characters.listForCampaign(campaignId as number, role);
      },
    );

    this.tool(
      server,
      'get_session_recaps',
      'List session recaps for a campaign, newest first.',
      { campaignId: CampaignIdArg, limit: LimitArg(100, 100), offset: OffsetArg },
      async ({ campaignId, limit, offset }) => {
        const role = await this.access.requireMember(user, campaignId as number);
        // issue #71: limit/offset pushed into SQL (was rows.slice() after a full read).
        return this.sessions.listRecapsForCampaign(campaignId as number, role, {
          limit: limit as number | undefined,
          offset: offset as number | undefined,
        });
      },
    );

    this.tool(
      server,
      'get_session',
      'Get a single session recap by id.',
      { sessionId: Id.describe('Session id — from get_session_recaps') },
      async ({ sessionId }) => {
        const row = await this.sessions.getRowOrThrow(sessionId as number);
        const role = await this.access.requireMember(user, row.campaignId);
        return this.sessions.getOrThrow(sessionId as number, role);
      },
    );

    this.tool(
      server,
      'draft_session_recap',
      'DM only: assemble the source material for a session recap — the shared recap template scaffold, a draft ' +
        'seeded with the campaign\'s encounters and resolved inbox threads, and the raw structured material. This ' +
        'does NO LLM work: it hands you the scaffold + the facts so you can write the recap, then call ' +
        'add_session_recap (new session) or update_session (existing). Refine `draft`, delete the "Source notes" ' +
        'appendix, and publish.',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        await this.access.requireRole(user, campaignId as number, 'dm', { allowArchived: true });
        const resolvedInbox = await this.notes.listInbox(campaignId as number, true);
        const encounterList = await this.encounters.listForCampaign(campaignId as number);
        const encounters = await Promise.all(
          encounterList.map((e) => this.encounters.getWithCombatantsOrThrow(e.id)),
        );
        const source = {
          resolvedInbox: resolvedInbox.map((n) => ({ body: n.body, resolvedNote: n.resolvedNote, entityName: n.entityName })),
          encounters: encounters.map((e) => ({ name: e.name, status: e.status, combatants: e.combatants })),
        };
        return {
          template: RECAP_TEMPLATE,
          draft: buildRecapDraft(source),
          sourceMaterial: source,
          guidance:
            'Rewrite `draft` into a finished recap in the DM\'s voice, then call add_session_recap (or update_session ' +
            'for an existing session). Delete the "Threads resolved this session" source-notes appendix before publishing.',
        };
      },
    );

    this.tool(
      server,
      'read_inbox',
      'DM only: list player inbox items for a campaign — messages players sent up via submit_inbox_item. ' +
        'Defaults to open (unresolved) items; pass resolved=true for the resolved history (newest first), ' +
        'including any entity link each item was resolved into.',
      {
        campaignId: CampaignIdArg,
        resolved: z.boolean().optional().describe('If true, list resolved items instead of open ones'),
        limit: LimitArg(200, 200),
        offset: OffsetArg,
      },
      async ({ campaignId, resolved, limit, offset }) => {
        await this.access.requireRole(user, campaignId as number, 'dm', { allowArchived: true });
        // issue #71: limit/offset pushed into SQL.
        return this.notes.listInbox(campaignId as number, (resolved as boolean | undefined) ?? false, {
          limit: limit as number | undefined,
          offset: offset as number | undefined,
        });
      },
    );

    this.tool(
      server,
      'list_proposals',
      'DM only: list proposals for a campaign, optionally filtered by status (pending|approved|rejected).',
      { campaignId: CampaignIdArg, status: z.enum(['pending', 'approved', 'rejected']).optional().describe('Filter by status') },
      async ({ campaignId, status }) => {
        await this.access.requireRole(user, campaignId as number, 'dm', { allowArchived: true });
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
      'list_rule_packs',
      'List installed rule packs (server-wide compendium sources, e.g. Open5e SRD).',
      {},
      async () => this.rules.listPacks(),
    );

    this.tool(
      server,
      'get_rule_entry',
      'Get a single rule entry (spell/monster/item/condition/etc.) by id, including its full body and structured ' +
        'dataJson (e.g. a monster statblock\'s ability scores/hp/AC). Ids come from lookup_rule.',
      { entryId: Id.describe('Rule entry id — from lookup_rule') },
      async ({ entryId }) => this.rules.getEntryOrThrow(entryId as number),
    );

    this.tool(
      server,
      'get_encounter',
      'Get an encounter (combat tracker) by id, including its full combatant list sorted by turn order.',
      { encounterId: Id.describe('Encounter id — from list_encounters') },
      async ({ encounterId }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        await this.access.requireMember(user, row.campaignId);
        return this.encounters.getWithCombatantsOrThrow(encounterId as number);
      },
    );

    this.tool(
      server,
      'list_encounters',
      'List encounters in a campaign, optionally filtered by status (preparing|running|ended). Call this before ' +
        'get_encounter/update_combatant/etc. to discover encounter ids.',
      {
        campaignId: CampaignIdArg,
        status: z.enum(['preparing', 'running', 'ended']).optional().describe('Filter by encounter status'),
      },
      async ({ campaignId, status }) => {
        await this.access.requireMember(user, campaignId as number);
        return this.encounters.listForCampaign(campaignId as number, status as 'preparing' | 'running' | 'ended' | undefined);
      },
    );

    this.tool(
      server,
      'list_members',
      'List campaign members (user id, role, linked character).',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        await this.access.requireMember(user, campaignId as number);
        return this.members.listForCampaign(campaignId as number);
      },
    );

    this.tool(
      server,
      'list_notes',
      'List notes visible to the caller in a campaign: private (author only), dm_shared (author+dm), or ' +
        'party_shared (everyone). Optionally filter by the entity the note is linked to, or to just the caller\'s own notes.',
      {
        campaignId: CampaignIdArg,
        entityType: EntityType.optional().describe('Filter to notes linked to this entity type'),
        entityId: Id.optional().describe('Filter to notes linked to this entity id (use with entityType)'),
        mine: z.boolean().optional().describe('If true, only the caller\'s own notes'),
        limit: LimitArg(200, 200),
        offset: OffsetArg,
      },
      async ({ campaignId, entityType, entityId, mine, limit, offset }) => {
        const role = await this.access.requireMember(user, campaignId as number);
        // issue #71: limit/offset pushed into SQL (was rows.slice() after a full read).
        return this.notes.listForCampaign(campaignId as number, user, role, {
          entityType: entityType as string | undefined,
          entityId: entityId as number | undefined,
          mine: mine as boolean | undefined,
          limit: limit as number | undefined,
          offset: offset as number | undefined,
        });
      },
    );

    this.tool(
      server,
      'read_audit_log',
      'DM only: read the campaign audit log (newest first) — who did what, incl. `token:<name>` for PAT-driven actions.',
      { campaignId: CampaignIdArg, limit: LimitArg(500, 100), offset: OffsetArg },
      async ({ campaignId, limit, offset }) => {
        await this.access.requireRole(user, campaignId as number, 'dm', { allowArchived: true });
        // issue #71: offset pages back through history the cap-100 previously hid.
        return this.audit.listForCampaign(
          campaignId as number,
          (limit as number | undefined) ?? 100,
          (offset as number | undefined) ?? 0,
        );
      },
    );

    this.tool(
      server,
      'export_campaign',
      'DM only: export the full campaign (campaign, quests, npcs, locations, sessions, characters, notes, members, ' +
        'audit log, proposals, encounters incl. combatants) as JSON, with dmSecret fields included. Returned as text ' +
        '— the caller may treat it as a JSON string to parse or archive.',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        await this.access.requireRole(user, campaignId as number, 'dm', { allowArchived: true });
        return this.exportService.buildExport(campaignId as number, user);
      },
    );
  }

  // ---------- WRITE ----------

  private registerWriteTools(server: McpServer, user: RequestUser): void {
    this.tool(
      server,
      'create_campaign',
      'Create a new campaign. Any authenticated user may create one; the creator is auto-added as its dm.',
      { name: z.string().min(1).max(120).describe('Campaign name'), description: z.string().max(10_000).optional().describe('Campaign description') },
      async ({ name, description }) => {
        const validated = CampaignCreate.parse({ name, ...(description !== undefined ? { description } : {}) });
        return this.campaigns.create(validated, user);
      },
    );

    this.tool(
      server,
      'delete_campaign',
      'DM only: permanently delete a campaign and ALL of its data (quests, npcs, locations, characters, encounters, ' +
        'notes, sessions, proposals, members, tokens, attachments). Irreversible.',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        await this.access.requireRole(user, campaignId as number, 'dm', { allowArchived: true });
        await this.campaigns.remove(campaignId as number, user);
        return { ok: true, campaignId };
      },
    );

    this.tool(
      server,
      'create_quest',
      'Create a quest in a campaign (DM). With propose:true any member may submit it as a proposal instead. ' +
        'Supports subquests via parentId (another quest\'s id in the same campaign), an optional giverNpcId, a ' +
        'dmSecret field (DM-only text, stripped from non-DM reads), and a hidden flag (true = excluded WHOLESALE ' +
        'from every non-DM read until the DM reveals it by setting hidden=false — for prepping future content).',
      { campaignId: CampaignIdArg, propose: ProposeArg, ...QuestCreate.shape },
      async ({ campaignId, propose, ...fields }) => {
        const validated = QuestCreate.parse(fields);
        if (propose) {
          const role = await this.access.requireMember(user, campaignId as number, { write: true });
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
      'Update a quest (DM). With propose:true any member may submit the change as a proposal instead. Supports ' +
        'subquests via parentId, an optional giverNpcId, a dmSecret field (DM-only text), and a hidden flag ' +
        '(set hidden=false to reveal a previously-hidden quest to players).',
      { questId: Id.describe('Quest id'), propose: ProposeArg, ...QuestUpdate.shape },
      async ({ questId, propose, ...fields }) => {
        const row = await this.quests.getRowOrThrow(questId as number);
        const validated = QuestUpdate.parse(fields);
        if (propose) {
          const role = await this.access.requireMember(user, row.campaignId, { write: true });
          const proposal = await this.proposalRecords.create(row.campaignId, 'quest', questId as number, 'update', validated, user, role);
          return { proposal };
        }
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.quests.update(questId as number, validated, user, role);
      },
    );

    this.tool(
      server,
      'delete_quest',
      'DM only: delete a quest. Any subquests (parentId pointing at this quest) are promoted to top-level rather than deleted.',
      { questId: Id.describe('Quest id') },
      async ({ questId }) => {
        const row = await this.quests.getRowOrThrow(questId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        await this.quests.remove(questId as number, user, role);
        return { ok: true, questId };
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
          const role = await this.access.requireMember(user, row.campaignId, { write: true });
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
      'update_objective',
      'Update a quest objective\'s text and/or done state. Any member (player+) may toggle `done`; changing `text` ' +
        'requires dm. Use check_objective for a done-only toggle.',
      {
        questId: Id.describe('Quest id'),
        objectiveId: Id.describe('Objective id'),
        text: z.string().min(1).max(500).optional().describe('New objective text (dm only)'),
        done: z.boolean().optional().describe('Done state'),
      },
      async ({ questId, objectiveId, text, done }) => {
        const row = await this.quests.getRowOrThrow(questId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'player');
        return this.quests.patchObjective(
          questId as number,
          objectiveId as number,
          { ...(text !== undefined ? { text: text as string } : {}), ...(done !== undefined ? { done: done as boolean } : {}) },
          user,
          role,
        );
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
      'remove_objective',
      'DM only: delete a quest objective.',
      { questId: Id.describe('Quest id'), objectiveId: Id.describe('Objective id') },
      async ({ questId, objectiveId }) => {
        const row = await this.quests.getRowOrThrow(questId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        await this.quests.removeObjective(questId as number, objectiveId as number, user, role);
        return { ok: true, questId, objectiveId };
      },
    );

    this.tool(
      server,
      'upsert_npc',
      'Create an NPC (omit npcId) or update one (pass npcId). DM; with propose:true any member may submit a ' +
        'proposal instead. Supports a dmSecret field (DM-only text, stripped from non-DM reads), an optional ' +
        'locationId, and a hidden flag (true = excluded WHOLESALE from every non-DM read until revealed via hidden=false).',
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
            const role = await this.access.requireMember(user, row.campaignId, { write: true });
            const proposal = await this.proposalRecords.create(row.campaignId, 'npc', npcId as number, 'update', validated, user, role);
            return { proposal };
          }
          const role = await this.access.requireRole(user, row.campaignId, 'dm');
          return this.npcs.update(npcId as number, validated, user, role);
        }
        const validated = NpcCreate.parse(fields); // name required on create
        if (propose) {
          const role = await this.access.requireMember(user, campaignId as number, { write: true });
          const proposal = await this.proposalRecords.create(campaignId as number, 'npc', null, 'create', validated, user, role);
          return { proposal };
        }
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        return this.npcs.create(campaignId as number, validated, user, role);
      },
    );

    this.tool(
      server,
      'delete_npc',
      'DM only: delete an NPC.',
      { npcId: Id.describe('NPC id') },
      async ({ npcId }) => {
        const row = await this.npcs.getRowOrThrow(npcId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        await this.npcs.remove(npcId as number, user, role);
        return { ok: true, npcId };
      },
    );

    this.tool(
      server,
      'upsert_location',
      'Create a location (omit locationId) or update one (pass locationId). DM; with propose:true any member may ' +
        'submit a proposal instead. Supports a dmSecret field (DM-only text, stripped from non-DM reads). Use ' +
        'set_location_discovery to change `status` with the "current location" demotion side-effect.',
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
            const role = await this.access.requireMember(user, row.campaignId, { write: true });
            const proposal = await this.proposalRecords.create(row.campaignId, 'location', locationId as number, 'update', validated, user, role);
            return { proposal };
          }
          const role = await this.access.requireRole(user, row.campaignId, 'dm');
          return this.locations.update(locationId as number, validated, user, role);
        }
        const validated = LocationCreate.parse(fields); // name required on create
        if (propose) {
          const role = await this.access.requireMember(user, campaignId as number, { write: true });
          const proposal = await this.proposalRecords.create(campaignId as number, 'location', null, 'create', validated, user, role);
          return { proposal };
        }
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        return this.locations.create(campaignId as number, validated, user, role);
      },
    );

    this.tool(
      server,
      'delete_location',
      'DM only: delete a location.',
      { locationId: Id.describe('Location id') },
      async ({ locationId }) => {
        const row = await this.locations.getRowOrThrow(locationId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        await this.locations.remove(locationId as number, user, role);
        return { ok: true, locationId };
      },
    );

    this.tool(
      server,
      'set_location_discovery',
      'DM only: set a location\'s status (unexplored|explored|current). Setting "current" demotes any other ' +
        '"current" location in the campaign to "explored" and updates the campaign\'s currentLocationId.',
      { locationId: Id.describe('Location id'), status: LocationStatus },
      async ({ locationId, status }) => {
        const row = await this.locations.getRowOrThrow(locationId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.locations.discover(locationId as number, status as z.infer<typeof LocationStatus>, user, role);
      },
    );

    this.tool(
      server,
      'add_session_recap',
      'Add a session recap (DM). number defaults to max existing session number + 1. Supports a dmSecret field ' +
        '(DM-only prep notes, stripped from non-DM reads). With propose:true any member may submit a proposal instead.',
      {
        campaignId: CampaignIdArg,
        number: z.number().int().positive().optional().describe('Session number; defaults to max + 1'),
        title: z.string().max(200).optional().describe('Session title'),
        recap: z.string().max(100_000).describe('Session recap (markdown)'),
        playedAt: z.string().optional().describe('ISO date the session was played'),
        dmSecret: z.string().max(20_000).optional().describe('DM-only prep notes — stripped from non-DM reads'),
        propose: ProposeArg,
      },
      async ({ campaignId, number, title, recap, playedAt, dmSecret, propose }) => {
        // Membership is required even to compute the default number.
        const memberRole = await this.access.requireMember(user, campaignId as number, { write: true });
        let sessionNumber = number as number | undefined;
        if (sessionNumber === undefined) {
          const existing = await this.sessions.listForCampaign(campaignId as number, memberRole);
          sessionNumber = existing.reduce((max, s) => Math.max(max, s.number), 0) + 1;
        }
        const validated = SessionCreate.parse({
          number: sessionNumber,
          ...(title !== undefined ? { title } : {}),
          ...(playedAt !== undefined ? { playedAt } : {}),
          ...(dmSecret !== undefined ? { dmSecret } : {}),
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
      'update_session',
      'Update a session recap\'s title, recap text, playedAt date, and/or dmSecret (DM-only prep notes, stripped ' +
        'from non-DM reads) (DM). With propose:true any member may submit the change as a proposal instead.',
      {
        sessionId: Id.describe('Session id'),
        title: z.string().max(200).optional().describe('Session title'),
        recap: z.string().max(100_000).optional().describe('Session recap (markdown)'),
        playedAt: z.string().nullable().optional().describe('ISO date the session was played'),
        dmSecret: z.string().max(20_000).optional().describe('DM-only prep notes — stripped from non-DM reads'),
        propose: ProposeArg,
      },
      async ({ sessionId, title, recap, playedAt, dmSecret, propose }) => {
        const row = await this.sessions.getRowOrThrow(sessionId as number);
        const validated = SessionUpdate.parse({
          ...(title !== undefined ? { title } : {}),
          ...(recap !== undefined ? { recap } : {}),
          ...(playedAt !== undefined ? { playedAt } : {}),
          ...(dmSecret !== undefined ? { dmSecret } : {}),
        });
        if (propose) {
          const role = await this.access.requireMember(user, row.campaignId, { write: true });
          const proposal = await this.proposalRecords.create(row.campaignId, 'session', sessionId as number, 'update', validated, user, role);
          return { proposal };
        }
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.sessions.update(sessionId as number, validated, user, role);
      },
    );

    this.tool(
      server,
      'upsert_character',
      'Create a character (omit characterId) or update one (pass characterId). player may create/update their own ' +
        'character; dm may create/update any character in the campaign, incl. reassigning ownerUserId. The dmSecret ' +
        'field (DM-only text, stripped from non-DM reads) is only writable as dm — ignored otherwise.',
      {
        campaignId: CampaignIdArg,
        characterId: Id.optional().describe('Existing character id (update); omit to create'),
        ...CharacterUpdate.shape,
      },
      async ({ campaignId, characterId, ...fields }) => {
        if (characterId !== undefined) {
          const row = await this.characters.getRowOrThrow(characterId as number);
          if (row.campaignId !== (campaignId as number)) {
            throw new BadRequestException(`Character ${characterId} belongs to campaign ${row.campaignId}, not ${campaignId}`);
          }
          const validated = CharacterUpdate.parse(fields);
          const role = await this.access.requireRole(user, row.campaignId, 'player');
          return this.characters.update(characterId as number, validated, user, role);
        }
        const validated = CharacterCreate.parse(fields); // name required on create
        const role = await this.access.requireRole(user, campaignId as number, 'player');
        return this.characters.create(campaignId as number, validated, user, role);
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
      'award_xp',
      "Award XP. Either to one character by characterId (player owner or DM; delta may be negative to correct a mistake, XP never drops below 0), or DM-only to the whole party / a characterIds subset via amount.",
      {
        campaignId: CampaignIdArg,
        characterId: Id.optional().describe('Single character to adjust (owner or DM); omit for a DM party-wide award'),
        amount: z.number().int().describe('XP to add. Party-wide awards require a positive amount'),
        characterIds: z.array(Id).optional().describe('Party-award only: limit the award to these characters'),
      },
      async ({ campaignId, characterId, amount, characterIds }) => {
        if (characterId !== undefined) {
          const row = await this.characters.getRowOrThrow(characterId as number);
          if (row.campaignId !== (campaignId as number)) {
            throw new BadRequestException(`Character ${characterId} belongs to campaign ${row.campaignId}, not ${campaignId}`);
          }
          const role = await this.access.requireRole(user, row.campaignId, 'player');
          return this.characters.patchXp(characterId as number, { delta: amount as number }, user, role);
        }
        const validated = XpAward.parse({ amount, ...(characterIds !== undefined ? { characterIds } : {}) });
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        return this.characters.awardXp(campaignId as number, validated, user, role);
      },
    );

    this.tool(
      server,
      'level_up_character',
      'Level a character up by 1 (player owner or DM; 400 at level 20). Optionally pass the new hpMax — hit points gained are added to current HP too. Not gated on XP thresholds (milestone campaigns level without XP).',
      {
        characterId: Id.describe('Character id'),
        hpMax: z.number().int().min(1).optional().describe('New maximum HP after the level-up'),
      },
      async ({ characterId, hpMax }) => {
        const row = await this.characters.getRowOrThrow(characterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'player');
        return this.characters.levelUp(characterId as number, { ...(hpMax !== undefined ? { hpMax: hpMax as number } : {}) }, user, role);
      },
    );

    this.tool(
      server,
      'set_character_conditions',
      'Add and/or remove status conditions (e.g. "poisoned", "prone") on a character (player owner or DM).',
      {
        characterId: Id.describe('Character id'),
        add: z.array(z.string().max(40)).optional().describe('Conditions to add'),
        remove: z.array(z.string().max(40)).optional().describe('Conditions to remove'),
      },
      async ({ characterId, add, remove }) => {
        const row = await this.characters.getRowOrThrow(characterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'player');
        return this.characters.patchConditions(
          characterId as number,
          { ...(add !== undefined ? { add: add as string[] } : {}), ...(remove !== undefined ? { remove: remove as string[] } : {}) },
          user,
          role,
        );
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
        const role = await this.access.requireMember(user, campaignId as number, { write: true });
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
      'update_note',
      'Edit a note\'s body and/or visibility. Author only — dm may NOT edit another member\'s note.',
      {
        noteId: Id.describe('Note id'),
        body: z.string().min(1).max(20_000).optional().describe('Note body (markdown)'),
        visibility: NoteVisibility.optional().describe('private | dm_shared | party_shared'),
      },
      async ({ noteId, body, visibility }) => {
        const row = await this.notes.getRowOrThrow(noteId as number);
        const role = await this.access.requireMember(user, row.campaignId, { write: true });
        return this.notes.update(
          noteId as number,
          { ...(body !== undefined ? { body: body as string } : {}), ...(visibility !== undefined ? { visibility: visibility as z.infer<typeof NoteVisibility> } : {}) },
          user,
          role,
        );
      },
    );

    this.tool(
      server,
      'delete_note',
      'Delete a note. Author only — dm may NOT delete another member\'s note.',
      { noteId: Id.describe('Note id') },
      async ({ noteId }) => {
        const row = await this.notes.getRowOrThrow(noteId as number);
        const role = await this.access.requireMember(user, row.campaignId, { write: true });
        await this.notes.remove(noteId as number, user, role);
        return { ok: true, noteId };
      },
    );

    this.tool(
      server,
      'submit_inbox_item',
      'Any member may send a message up to the DM (e.g. a player asking a rules question, flagging something out ' +
        'of character). Appears in read_inbox until a dm calls resolve_inbox_item.',
      { campaignId: CampaignIdArg, body: z.string().min(1).max(20_000).describe('Message body') },
      async ({ campaignId, body }) => {
        const role = await this.access.requireMember(user, campaignId as number, { write: true });
        return this.notes.createInbox(campaignId as number, { authorName: user.name, body: body as string }, user, role);
      },
    );

    this.tool(
      server,
      'resolve_inbox_item',
      'DM only: resolve a player inbox item, optionally with a resolution note and/or a link to the entity it ' +
        'became (entityType + entityId together) — shown in the resolved history (read_inbox with resolved=true).',
      {
        noteId: Id.describe('Inbox note id'),
        resolvedNote: z.string().max(1000).optional().describe('Resolution note'),
        entityType: EntityType.optional().describe('Entity type this item was resolved into (requires entityId)'),
        entityId: Id.optional().describe('Entity id this item was resolved into (requires entityType)'),
      },
      async ({ noteId, resolvedNote, entityType, entityId }) => {
        if ((entityType == null) !== (entityId == null)) {
          throw new BadRequestException('entityType and entityId must be provided together');
        }
        const row = await this.notes.getRowOrThrow(noteId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.notes.resolveInbox(
          noteId as number,
          {
            resolvedNote: (resolvedNote as string | undefined) ?? '',
            entityType: (entityType as z.infer<typeof EntityType> | undefined) ?? null,
            entityId: (entityId as number | undefined) ?? null,
          },
          user,
          role,
        );
      },
    );

    this.tool(
      server,
      'update_campaign_status',
      'DM only: update campaign state — status (active|paused|completed), current location, and/or danger level. ' +
        '(sessionCount is intentionally NOT settable here — it\'s a denormalized count auto-recomputed by ' +
        'add_session_recap/session delete, not a free-form field.)',
      {
        campaignId: CampaignIdArg,
        status: z.enum(['active', 'paused', 'completed']).optional().describe('Campaign status'),
        currentLocationId: Id.nullable().optional().describe('Current location id (null to clear)'),
        dangerLevel: DangerLevel.optional().describe('low | moderate | high | deadly'),
      },
      async ({ campaignId, status, currentLocationId, dangerLevel }) => {
        // allowArchived: this is the un-archive path (status back to 'active') —
        // CampaignsService.update() restricts archived campaigns to status-only patches.
        await this.access.requireRole(user, campaignId as number, 'dm', { allowArchived: true });
        const patch: z.infer<typeof CampaignUpdate> = {};
        if (status !== undefined) patch.status = status as z.infer<typeof CampaignUpdate>['status'];
        if (currentLocationId !== undefined) patch.currentLocationId = currentLocationId as number | null;
        if (dangerLevel !== undefined) patch.dangerLevel = dangerLevel as z.infer<typeof DangerLevel>;
        if (Object.keys(patch).length === 0) {
          throw new BadRequestException('Pass at least one of status, currentLocationId, or dangerLevel');
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
      'add_member',
      'DM only: add a campaign member by user id, with a role (dm|player|viewer) and optional linked characterId.',
      { campaignId: CampaignIdArg, ...MemberCreate.shape },
      async ({ campaignId, ...fields }) => {
        await this.access.requireRole(user, campaignId as number, 'dm');
        const validated = MemberCreate.parse(fields);
        return this.members.create(campaignId as number, validated, user);
      },
    );

    this.tool(
      server,
      'update_member',
      'DM only: update a campaign member\'s role and/or linked characterId. Cannot demote the campaign\'s last dm.',
      { campaignId: CampaignIdArg, memberId: Id.describe('Member id — from list_members'), ...MemberUpdate.shape },
      async ({ campaignId, memberId, ...fields }) => {
        await this.access.requireRole(user, campaignId as number, 'dm');
        const validated = MemberUpdate.parse(fields);
        return this.members.update(campaignId as number, memberId as number, validated, user);
      },
    );

    this.tool(
      server,
      'remove_member',
      'DM only: remove a campaign member. Cannot remove the campaign\'s last dm.',
      { campaignId: CampaignIdArg, memberId: Id.describe('Member id — from list_members') },
      async ({ campaignId, memberId }) => {
        await this.access.requireRole(user, campaignId as number, 'dm');
        await this.members.remove(campaignId as number, memberId as number, user);
        return { ok: true, memberId };
      },
    );

    this.tool(
      server,
      'install_rule_pack',
      'Server admin only: install (or incrementally update) the Open5e SRD rule pack — spells, monsters, items, ' +
        'conditions, classes, races, feats — so lookup_rule/get_rule_entry and add_combatant\'s ruleEntryId can find them.',
      { ...RulePackInstall.shape },
      async ({ source, url, sections }) => {
        // hasServerAdminPower(), not a raw serverRole check — a token minted for a server
        // admin must NOT carry that admin's server-wide power unless it was explicitly
        // minted with adminEnabled=true. See user.types.ts / the P1 finding this closes.
        if (!hasServerAdminPower(user)) {
          throw new ForbiddenException('Requires server admin');
        }
        const validated = RulePackInstall.parse({
          source,
          ...(url !== undefined ? { url } : {}),
          ...(sections !== undefined ? { sections } : {}),
        });
        return this.rules.installFromOpen5e(validated, user);
      },
    );

    this.tool(
      server,
      'roll_dice',
      'Roll a dice expression, e.g. "1d20+3" or "2d6", in the context of a campaign. Any campaign member may use ' +
        'this; the roll is audited (action "dice.roll") and appears in the campaign-shared dice log.',
      { campaignId: CampaignIdArg, expr: RollRequest.shape.expr.describe('Dice expression, e.g. "1d20+3"') },
      async ({ campaignId, expr }) => {
        const role = await this.access.requireMember(user, campaignId as number, { write: true });
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
      '`kind` ("character"|"monster") is required. DM only: add a combatant to an encounter. Pass ruleEntryId (a ' +
        'monster statblock id from lookup_rule/get_rule_entry) to pull name/hp/DEX-derived initMod from the ' +
        'compendium, or characterId to pull from a character sheet, when name/hpMax/initMod are omitted.',
      {
        encounterId: Id.describe('Encounter id — from list_encounters'),
        ...CombatantCreate.shape,
        // Same constraints as CombatantCreate (Id, optional) but described for tools/list.
        characterId: Id.optional().describe('Character id — links a party member and pulls name/hp/initMod from their sheet when omitted'),
        ruleEntryId: Id.optional().describe('Monster statblock rule entry id — from lookup_rule/get_rule_entry'),
      },
      async ({ encounterId, ...fields }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        const validated = CombatantCreate.parse(fields);
        return this.encounters.addCombatant(encounterId as number, validated, user, role);
      },
    );

    this.tool(
      server,
      'update_combatant',
      'Update a combatant mid-fight: hpDelta (relative) or hpSet (absolute, exclusive with hpDelta), ' +
        'addConditions/removeConditions, and/or initiative (dm only). DM may modify any combatant; a player may only ' +
        'touch hp/conditions on a combatant linked to a character they own.',
      { encounterId: Id.describe('Encounter id'), combatantId: Id.describe('Combatant id — from get_encounter'), ...CombatantUpdate.shape },
      async ({ encounterId, combatantId, ...fields }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'player');
        const validated = CombatantUpdate.parse(fields);
        return this.encounters.updateCombatant(encounterId as number, combatantId as number, validated, user, role);
      },
    );

    this.tool(
      server,
      'remove_combatant',
      'DM only: remove a combatant from an encounter.',
      { encounterId: Id.describe('Encounter id'), combatantId: Id.describe('Combatant id — from get_encounter') },
      async ({ encounterId, combatantId }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        await this.encounters.removeCombatant(encounterId as number, combatantId as number, user, role);
        return { ok: true, encounterId, combatantId };
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
