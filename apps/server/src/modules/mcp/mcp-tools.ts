import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectThrottlerStorage, ThrottlerException, type ThrottlerStorage } from '@nestjs/throttler';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { zodToJsonSchema as zodToJsonSchemaRaw } from 'zod-to-json-schema';

/**
 * zodToJsonSchema with its deep conditional generics erased — the raw overloads
 * trip TS2589 ("excessively deep") when handed a non-literal ZodObject. We only
 * need a plain JSON-Schema object out, so cast the function to a simple signature.
 */
const zodToJsonSchema = zodToJsonSchemaRaw as unknown as (
  schema: unknown,
  options?: unknown,
) => Record<string, unknown>;
import {
  ActionApplyRequest,
  ActionResolveRequest,
  ActionUndoToken,
  CampaignCreate,
  CampaignLibraryMonsterCreate,
  CampaignLibraryMonsterUpdate,
  CampaignLibraryTagCreate,
  CampaignLibraryTagUpdate,
  CampaignLibraryCollectionCreate,
  CampaignLibraryCollectionUpdate,
  CampaignLibraryTemplateSave,
  CampaignLibraryTemplateInstantiate,
  LibraryBulkRequest,
  LibraryEntityType,
  LibrarySearchQuery,
  CampaignUpdate,
  CharacterCreate,
  CharacterUpdate,
  CombatantCreate,
  CombatantRemoveRequest, CombatantRemoveUndo,
  CombatantResourceAdjust,
  CombatantTurnStatePatch,
  CombatantUpdate,
  DifficultyBand,
  EncounterShape,
  AoeTemplateDeclare,
  EncounterUpdate,
  EncounterEndTurn,
  EncounterNextTurn,
  EncounterPreviewRequest,
  EncounterCommit,
  DangerLevel,
  EntityType,
  ExpectedUpdatedAt,
  Id,
  IdempotencyKey,
  LocationCreate,
  LocationStatus,
  LocationUpdate,
  MemberCreate,
  MemberUpdate,
  NoteVisibility,
  NpcCreate,
  NpcUpdate,
  FactionCreate,
  FactionUpdate,
  FactionStanding,
  QuestCreate,
  QuestStatus,
  QuestUpdate,
  ArcStatus,
  BeatStatus,
  StoryArcCreate,
  StoryArcUpdate,
  StoryBeatCreate,
  StoryBeatUpdate,
  StoryBranchUpdate,
  RollRequest,
  ActionRollRequest,
  CheckRollRequest,
  CheckRequestCreate,
  RulePackInstall,
  RuleEntryType,
  HomebrewRuleEntryInput,
  HomebrewRuleEntryUpdate,
  HomebrewImportPreview,
  HomebrewImportApply,
  RECAP_TEMPLATE,
  SessionCreate,
  SessionUpdate,
  SessionShareCreate,
  SessionShareUpdate,
  XpAward,
  AiDmTurnKind,
  InventoryItemCreate,
  InventoryFromCompendium,
  InventoryItemUpdate,
  TreasuryPatch,
  TimelineEventCreate,
  TimelineEventUpdate,
  TimelineCalendarUpdate,
  CommentCreate,
  CommentUpdate,
  ScheduledSessionCreate,
  ScheduledSessionCancel,
  ScheduledSessionDuplicate,
  ScheduledSessionRestore,
  ScheduledSessionUpdate,
  SessionZeroUpdate,
  RsvpSetBody,
  RsvpSet,
  GenerateMapParams,
  AiMapGenerationRequest,
  AiMapRefineRequest,
  AttachGeneratedMapRequest,
  CoDmDraftTarget,
  NarrationLanguage,
  CampaignDmRepair,
  ParticipantSupportPreferenceUpsert,
  RevisionEntityType,
  InviteCreate,
  InvitePolicyUpdate,
  SpellSlotPatch,
  ResourcePatch,
  ConditionLevelPatch,
  spellSlotsRemaining,
  EncounterReopen,
  ProposalRevise,
  ProposalBatchResolve,
  NotificationPreferencesUpdate,
  ruleSystemAdapter,
} from '@campfire/schema';
import { hasServerAdminPower, type RequestUser } from '../../common/user.types';
import { buildMcpEnvelope } from '../../common/api-error.envelope';
import { getRequestContext, getRequestId, patchRequestContext } from '../../common/request-context';
import { logRequest } from '../../common/request-log';
import { requireWriteMode, assertDirectWriteAllowed } from '../../common/proposed.util';
import { AI_THROTTLE_LIMIT, AI_THROTTLE_TTL_MS, THROTTLE_AI, isThrottleDisabled } from '../../common/throttle.constants';
import { fromJsonText } from '../../common/json';
import { resolveSavingThrow } from './saving-throw-math';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { QuestsService } from '../quests/quests.service';
import { StorylinesService } from '../storylines/storylines.service';
import { NpcsService } from '../npcs/npcs.service';
import { FactionsService } from '../factions/factions.service';
import { LocationsService } from '../locations/locations.service';
import { SessionsService, buildRecapDraft } from '../sessions/sessions.service';
import { SessionSharesService } from '../sessions/session-shares.service';
import { CharactersService, type RestPartyResult } from '../characters/characters.service';
import { NotesService } from '../notes/notes.service';
import { MembersService } from '../membership/members.service';
import { ProposalRecordsService } from '../proposals/proposal-records.service';
import { ProposalsService } from '../proposals/proposals.service';
import { RulesService } from '../rules/rules.service';
import { EncountersService } from '../encounters/encounters.service';
import { CampaignLibraryService } from '../campaign-library/campaign-library.service';
import { ActionResolverService } from '../encounters/action-resolver.service';
import { MapsService } from '../maps/maps.service';
import { AiMapService } from '../ai-map/ai-map.service';
import { AuditService } from '../audit/audit.service';
import { ExportService } from '../export/export.service';
import { AiDmService } from '../ai-dm/ai-dm.service';
import { CoDmService } from '../ai-dm/co-dm.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { SessionZeroService } from '../session-zero/session-zero.service';
import { SessionZeroConsentService } from '../session-zero/session-zero-consent.service';
import { SafetyCharterValidator } from '../session-zero/safety-charter-validator';
import { SupportPreferencesService } from '../session-zero/support-preferences.service';
import { InventoryService } from '../inventory/inventory.service';
import { TimelineService } from '../timeline/timeline.service';
import { CommentsService } from '../comments/comments.service';
import { SchedulingService } from '../sessions/scheduling.service';
import { OrganizedPlayService } from '../sessions/organized-play.service';
import { ScribeService } from '../scribe/scribe.service';
import { filterHidden, isVisibleTo } from '../../common/redact';
import { UsersService } from '../users/users.service';
import { RevisionsService } from '../revisions/revisions.service';
// Dice-roll retention is applied inside ScribeService.assembleSourceWithConsent, which
// draft_session_recap now delegates to for consent filtering (#501) — no direct use here.
import { RollsService } from '../rolls/rolls.service';
import { InvitesService } from '../membership/invites.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BulkNotificationSchema } from '../notifications/notifications.dto';
import { InboxSweepService } from '../inbox-sweep/inbox-sweep.service';

import { APP_VERSION } from '../../common/build-metadata';

const SERVER_INFO = { name: 'campfire', version: APP_VERSION };
const SharedEditorRevisionType = z.enum([
  'session',
  'quest',
  'npc',
  'location',
  'faction',
  'timeline_event',
  'timeline_calendar',
  'scheduled_session',
  'session_zero',
  'story_beat',
  'comment',
]);

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
 * `{"error":{"status","code","message","requestId"[,"errors[]"]}}` so a calling
 * agent can branch on `status`/`code` programmatically instead of string-matching
 * prose. The shape is the SAME `ApiErrorEnvelope` the REST API publishes (issue
 * #682) — same `code` slug vocabulary, same `errors[]` field-error structure, and
 * a `requestId` for cross-transport support correlation. See
 * `common/api-error.envelope.ts` `buildMcpEnvelope()`. REST carries additional
 * RFC 9457 fields (`type`/`title`/`instance`); MCP omits them — they have no
 * JSON-RPC meaning.
 */
function fail(err: unknown): ToolResult {
  const envelope = buildMcpEnvelope(err);
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(envelope) }] };
}

function campaignIdFromToolArgs(args: Record<string, unknown>): number | undefined {
  const raw = args.campaignId;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

function logMcpTool(name: string, args: Record<string, unknown>, startedAt: number, result: 'ok' | 'error'): void {
  const requestId = getRequestId();
  if (!requestId) return;
  const ctx = getRequestContext();
  logRequest({
    requestId,
    transport: 'mcp',
    result,
    latencyMs: Math.max(0, Date.now() - startedAt),
    tool: name,
    actor: ctx?.actor,
    campaignId: campaignIdFromToolArgs(args),
  });
}

/**
 * A single executable tool captured from the SAME registration path the MCP
 * endpoint uses. The driver runtime (#312) consumes these to run a model's tool
 * calls server-side without the MCP transport — so every call goes through the
 * identical strict-parse + role/write-mode/proposal enforcement + ok/fail shaping
 * a remote MCP client would hit. `inputSchema` is the tool's JSON Schema (offered
 * to the provider via the neutral tool registry); `proposalCapable` mirrors
 * writeTool()'s `propose`-arg detection so the runtime knows which canon writes to
 * force down the proposal path.
 */
export interface DriverTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  proposalCapable: boolean;
  /**
   * True when this tool MUTATES state (registered via writeTool), false for pure reads.
   * The driver runtime (#312/#378) uses this to default-deny: reads are always allowed,
   * proposal-capable writes are forced onto the proposal path, and every OTHER direct
   * write must be on the explicit live-play allow-list — so no administrative/economy/
   * settings tool is ever driveable by the seat just because it wasn't denylisted.
   */
  mutating: boolean;
  invoke(args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

/** The full, executable tool registry for one principal (see McpToolsService.buildToolset). */
export interface DriverToolset {
  tools: DriverTool[];
  get(name: string): DriverTool | undefined;
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

/**
 * Symbol used to hand a collector Map to buildServer() so tool() records every
 * registered tool alongside binding it on the McpServer — one registration path,
 * two consumers (the MCP transport and the driver runtime). Kept off the public
 * surface so it never collides with SDK properties.
 */
const TOOL_COLLECTOR = Symbol('driverToolCollector');

const CampaignIdArg = z.number().int().positive().describe('Campaign id — from list_campaigns or get_campaign_summary');
const ProposeArg = z
  .boolean()
  .optional()
  .describe(
    'If true, submit as a proposal for DM approval instead of writing directly (quest/npc/location/session/character ' +
      'create+update, and delete_quest/delete_npc/delete_location/delete_character/delete_session). Any member may ' +
      'propose; the returned {proposal} is ' +
      'pending until a dm calls approve_proposal/reject_proposal. Ignored on tools with no REST proposal path ' +
      '(objectives, notes, campaign status, members, encounters).',
  );
const LimitArg = (max: number, fallback: number) =>
  z.number().int().positive().max(max).optional().describe(`Max rows to return (default ${fallback}, max ${max})`);
const OffsetArg = z.number().int().nonnegative().optional().describe('Rows to skip, for paging (default 0)');
const BulkNotificationArgs = {
  ids: z.array(Id).optional().describe('Specific notification ids (from list_notifications)'),
  campaignId: z.number().int().positive().optional().describe('All notifications in this campaign'),
  all: z.boolean().optional().describe('Every notification owned by the caller'),
};

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
 * #371: give nullable numeric FK fields a concrete TOP-LEVEL `type` in the
 * generated JSON Schema.
 *
 * An optional numeric FK such as `giverNpcId: Id.nullable().default(null)` (Id =
 * `z.number().int().positive()`) serializes to
 *   {"anyOf":[{"type":"integer","exclusiveMinimum":0},{"type":"null"}],"default":null}
 * — a union with NO top-level `type`. zod-to-json-schema is forced into this
 * `anyOf` shape (instead of the flat `{"type":["integer","null"]}`) by
 * `strictUnions:true` whenever the numeric branch carries constraints
 * (`.int()`/`.positive()` → `type:"integer"` + `exclusiveMinimum`). Some MCP
 * clients only inspect a property's top-level `type`; finding none they treat the
 * field as untyped and send it as a string, so the server's numeric validator then
 * rejects it ("Expected number, received string") and the relationship can't be set
 * over MCP at all. (Distinct from the sibling-`$ref` artifact fixed by inlineClone /
 * issue #31 — this is the *untyped-union* half of the same family of FK fields.)
 *
 * Flatten every `anyOf:[<numeric>, {type:"null"}]` (in either order) back into a
 * single node with a top-level `type:[<numeric>,"null"]`, carrying the numeric
 * branch's own constraints (e.g. `exclusiveMinimum`) and the outer node's
 * `default`/`description` up with it. Recurses through the whole schema so nested
 * objects/arrays are covered too. Non-nullable numeric FKs (`{"type":"integer"}`)
 * and already-flat nullable numbers (`{"type":["number","null"]}`, e.g. location
 * `mapX`/`mapY`) are left untouched.
 */
export function flattenNullableNumericFks(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(flattenNullableNumericFks);
  if (!node || typeof node !== 'object') return node;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    next[key] = flattenNullableNumericFks(value);
  }
  const { anyOf } = next;
  if (Array.isArray(anyOf) && anyOf.length === 2) {
    const nullIndex = anyOf.findIndex(
      (opt) => opt !== null && typeof opt === 'object' && (opt as { type?: unknown }).type === 'null',
    );
    if (nullIndex !== -1) {
      const numeric = anyOf[1 - nullIndex] as Record<string, unknown> | undefined;
      const numericType = numeric?.type;
      if (numeric && (numericType === 'number' || numericType === 'integer')) {
        const merged: Record<string, unknown> = { ...numeric, type: [numericType, 'null'] };
        // Lift the union's own metadata (default, description) onto the flattened node.
        for (const [key, value] of Object.entries(next)) if (key !== 'anyOf') merged[key] = value;
        return merged;
      }
    }
  }
  return next;
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
    private readonly storylines: StorylinesService,
    private readonly npcs: NpcsService,
    private readonly factions: FactionsService,
    private readonly locations: LocationsService,
    private readonly sessions: SessionsService,
    private readonly sessionShares: SessionSharesService,
    private readonly characters: CharactersService,
    private readonly notes: NotesService,
    private readonly members: MembersService,
    private readonly proposalRecords: ProposalRecordsService,
    private readonly proposals: ProposalsService,
    private readonly rules: RulesService,
    private readonly encounters: EncountersService,
    private readonly campaignLibrary: CampaignLibraryService,
    private readonly maps: MapsService,
    private readonly aiMap: AiMapService,
    private readonly audit: AuditService,
    private readonly exportService: ExportService,
    private readonly aiDm: AiDmService,
    private readonly coDm: CoDmService,
    private readonly attachments: AttachmentsService,
    private readonly sessionZero: SessionZeroService,
    private readonly supportPreferences: SupportPreferencesService,
    private readonly inventory: InventoryService,
    private readonly timeline: TimelineService,
    private readonly comments: CommentsService,
    private readonly scheduling: SchedulingService,
    // #588: only for toConflictResponse — the ONE translator that turns a
    // SeriesConflictSignal into a per-caller-redacted 409, shared with
    // ScheduleController so REST and MCP cannot disagree about a booking clash.
    private readonly organizedPlay: OrganizedPlayService,
    private readonly scribe: ScribeService,
    private readonly users: UsersService,
    private readonly revisions: RevisionsService,
    private readonly rolls: RollsService,
    private readonly actionResolver: ActionResolverService,
    private readonly invites: InvitesService,
    private readonly notifications: NotificationsService,
    // Issue #600: resolves the ACCEPTED effective charter version. Appended LAST on
    // purpose — test/unit/mcp-rest-parity.spec.ts constructs this service positionally
    // with placeholder arguments, so inserting a parameter in the middle would silently
    // shift every dependency after it rather than failing loudly.
    private readonly sessionZeroConsent: SessionZeroConsentService,
    // Issue #1645/1716: the MCP surface for the inbox sweep (#1644) — calls the exact same
    // InboxSweepService.startInboxSweep() orchestration the REST POST /campaigns/:id/inbox/sweep
    // route uses, never a second implementation. Appended near-last for the same
    // positional-constructor-test reason as sessionZeroConsent above.
    private readonly inboxSweep: InboxSweepService,
    // apply the strict AI bucket to a single tool. Use the same throttler storage here.
    @InjectThrottlerStorage()
    private readonly throttlerStorage: ThrottlerStorage,
    private readonly safetyCharterValidator: SafetyCharterValidator,
  ) {}

  /**
   * The charter every AI surface is bound by (issue #600).
   *
   * This is the ONE place the "AI uses the accepted effective version" criterion is
   * enforced, and it is enforced here rather than in the Driver on purpose: the Driver,
   * the co-DM, Scribe and any external MCP client all read the charter through this tool,
   * so binding it at the tool means none of them can drift onto the draft independently.
   *
   * Falls back to the DM's draft ONLY when a campaign has published nothing at all —
   * such a table has no consent record to honour, and this keeps every pre-#600 campaign
   * behaving exactly as it did. When versions exist but none is currently licensed
   * (publish→before-first-ack, or every prior acknowledger left), the model gets empty
   * boundaries with `charterSource: 'none'` — never the mutable draft, which may have
   * withdrawn protections nobody consented to remove. When a newer version is awaiting
   * acknowledgment, the model keeps operating under the last version everybody agreed
   * to, which is the safe direction.
   */
  // Public so the #600 e2e can assert the exact code path the AI reads through, rather
  // than re-deriving the answer beside it and proving only that the test agrees with
  // itself. Callers other than get_session_zero should not use it — go through the tool.
  async effectiveSessionZero(campaignId: number) {
    const draft = await this.sessionZero.get(campaignId);
    const result = await this.sessionZeroConsent.effectiveCharter(campaignId);
    if (result.status === 'never_published') {
      return { ...draft, charterVersion: 0, charterSource: 'draft' as const };
    }
    if (result.status === 'unbound') {
      // Published but not licensed for live AI. Empty boundaries beat the mutable draft.
      return {
        ...draft,
        lines: [],
        veils: [],
        safetyTools: [],
        houseRules: '',
        toneAndExpectations: '',
        charterVersion: 0,
        charterSource: 'none' as const,
      };
    }
    const accepted = result.charter;
    return {
      ...draft,
      lines: accepted.lines,
      veils: accepted.veils,
      safetyTools: accepted.safetyTools,
      houseRules: accepted.houseRules,
      toneAndExpectations: accepted.toneAndExpectations,
      charterVersion: accepted.version,
      charterSource: 'accepted' as const,
    };
  }

  buildServer(user: RequestUser, collector?: Map<string, DriverTool>): McpServer {
    const server = new McpServer(SERVER_INFO, {
      instructions:
        'Campfire is a D&D-style campaign tracker. This server exposes the full REST surface as tools so an agent ' +
        'can run an entire campaign (world-building, session prep, and live combat) over MCP alone.\n\n' +
        'BOOTSTRAP / ID DISCOVERY — ids are never guessable, always discover them:\n' +
        '  1. list_campaigns -> pick a campaignId.\n' +
        '  2. get_campaign_summary {campaignId} -> full dashboard: campaign, current location, quests (with ' +
        'objectives), npcs, locations, characters, sessions, encounters, in-world timeline, party treasury, ' +
        'inventory/comment counts, next scheduled session, and open inbox count. This is the cheapest way to learn ' +
        'every entity id in a campaign in one call — prefer it over multiple list_* calls when starting fresh.\n' +
        '  3. For anything not in the summary (inventory items, comments, scheduled sessions, notes, rule entries, ' +
        'members, proposals, audit log), use the matching list_* tool first (e.g. list_inventory, list_comments, ' +
        'list_scheduled_sessions, list_encounters) to get ids.\n\n' +
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
        'server-wide operations) is capped separately and more strictly: a PAT never ' +
        'carries server-admin power unless it was explicitly minted with adminEnabled:true by a caller who ' +
        'currently held real server-admin power themselves — an admin\'s ordinary/viewer-scoped token is NOT an ' +
        'admin token by default.\n\n' +
        'PROPOSE-THEN-APPROVE — quest/npc/location/session/character create+update, upsert_character, ' +
        'delete_quest/delete_npc/delete_location, and set_quest_status (which proposes a quest update) accept ' +
        'propose:true: any member may submit a change (including a deletion) as a pending Proposal instead of writing ' +
        'directly; a dm later calls approve_proposal (applies it through the normal write path) or reject_proposal, ' +
        'or resolves many at once via the batch endpoints. Use this when acting as a player-role agent proposing ' +
        'world changes for a human DM to review. propose is not available on objectives, notes, campaign status, ' +
        'members, or combat tools — those write directly and are already gated by role.\n\n' +
        'ARCHIVED CAMPAIGNS — a campaign whose status is paused or completed is READ-ONLY: every write tool ' +
        '(quests, npcs, locations, sessions, characters, notes, inbox, members, encounters, dice rolls, proposal ' +
        'submission/approval) fails with 403 until a dm sets status back to "active" via update_campaign_status. ' +
        'Reads, export_campaign, read_audit_log, delete_campaign, and the status flip itself still work.\n\n' +
        'ERRORS — a failed call returns isError:true with JSON text {"error":{"status","code","message","requestId"[,"errors[]"]}} ' +
        '(e.g. status 404/code "not_found", status 403/code "forbidden", status 400/code "validation_failed"). The shape is ' +
        'the SAME envelope the REST API publishes (issue #682): same `code` slug vocabulary and, for validation_failed, a ' +
        'structured `errors[]` of {field,message}. Every tool\'s argument object is strict — an unknown/misspelled key is a ' +
        'validation_failed error, not a silent no-op, so check the message/errors and retry with corrected keys rather than ' +
        'assuming the call succeeded. `requestId` is a per-call correlation id; include it in any support ticket.\n\n' +
        'RESOURCES & PROMPTS — beyond tools, the server exposes read surfaces as MCP resources and a couple of ' +
        'authoring prompts. Resources: the static campfire://campaigns index, plus the per-campaign templates ' +
        'campfire://campaign/{campaignId}/summary, /party, and /recaps (each returns the same JSON as the ' +
        'matching read tool, gated by the same membership/secrecy rules — resources/list enumerates one concrete ' +
        'URI per accessible campaign). The access-support resource/tool returns only preferences whose participant ' +
        'explicitly opted into AI use; facilitator visibility alone never grants model access. Prompts: recap-writer ' +
        'and session-prep, each taking a campaignId argument, ' +
        'return a ready-to-run message that drives the corresponding tools.',
    });
    // When a collector is supplied (driver runtime), tool() records every tool onto it
    // as it binds it on the server — so the driver executes the exact same callbacks.
    if (collector) (server as unknown as { [TOOL_COLLECTOR]?: Map<string, DriverTool> })[TOOL_COLLECTOR] = collector;
    this.registerReadTools(server, user);
    this.registerWriteTools(server, user);
    this.registerResources(server, user);
    this.registerPrompts(server);
    this.patchListToolsSchemas(server);
    return server;
  }

  /**
   * #371: post-process the `tools/list` response so nullable numeric FK fields carry
   * a concrete top-level `type`. The MCP SDK owns tools/list JSON-Schema generation
   * (McpServer serializes each tool's zod inputSchema with zod-to-json-schema under
   * `strictUnions:true`), which emits nullable constrained-number FKs as an untyped
   * `anyOf` union — see flattenNullableNumericFks(). We can't change the SDK's
   * converter, so wrap its already-registered ListTools handler and flatten each
   * tool's inputSchema on the way out. Defensive: if the SDK's internals ever move,
   * we simply leave the handler untouched rather than break tools/list.
   */
  private patchListToolsSchemas(server: McpServer): void {
    const low = (server as unknown as { server?: { _requestHandlers?: Map<string, unknown> } }).server;
    const handlers = low?._requestHandlers;
    const original = handlers?.get('tools/list') as
      | ((request: unknown, extra: unknown) => Promise<{ tools?: { inputSchema?: unknown }[] }>)
      | undefined;
    if (!handlers || !original) return;
    handlers.set('tools/list', async (request: unknown, extra: unknown) => {
      const result = await original(request, extra);
      if (result && Array.isArray(result.tools)) {
        for (const tool of result.tools) {
          if (tool && tool.inputSchema) tool.inputSchema = flattenNullableNumericFks(tool.inputSchema);
        }
      }
      return result;
    });
  }

  /**
   * Build the FULL, executable tool registry for `user` without the MCP transport —
   * the seam the driver runtime (#312) drives a model's tool calls through. Reuses
   * buildServer()'s exact registration (same strict-parse, same role checks, same
   * write-mode/proposal gating, same ok/fail JSON), so a tool executed here behaves
   * byte-for-byte like the same tool called over POST /mcp. The transient McpServer
   * is never connected to a transport; it exists only to run the registration and
   * populate the collector.
   */
  buildToolset(user: RequestUser): DriverToolset {
    const collector = new Map<string, DriverTool>();
    this.buildServer(user, collector);
    return {
      tools: [...collector.values()],
      get: (name) => collector.get(name),
      call: async (name, args) => {
        const tool = collector.get(name);
        if (!tool) {
          // Same envelope shape as fail() — issue #682. Built inline because
          // there's no thrown value to normalize (this is the driver runtime's
          // own "no such tool" path, not a tool callback).
          const env = buildMcpEnvelope(new NotFoundException(`No such tool: ${name}`));
          return {
            text: JSON.stringify(env),
            isError: true,
          };
        }
        return tool.invoke(args ?? {});
      },
    };
  }

  private tool(
    server: McpServer,
    name: string,
    description: string,
    shape: z.ZodRawShape,
    handler: (args: Record<string, unknown>) => Promise<unknown>,
    // Marks this registration as a mutating (write) tool — set by writeTool(). Reads
    // omit it. Recorded on the DriverTool so the driver's live-play allow-list (#378)
    // can default-deny every non-live-play write without a fragile denylist.
    mutating = false,
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
    const cb = async (args: Record<string, unknown>): Promise<ToolResult> => {
      const startedAt = Date.now();
      try {
        const validated = strictShape.parse(args ?? {}) as Record<string, unknown>;
        const campaignId = campaignIdFromToolArgs(validated);
        patchRequestContext({
          tool: name,
          campaignId,
        });

        if (mutating && campaignId) {
          // Extract text from all string arguments
          const textValues = Object.values(validated).filter(v => typeof v === 'string').join('\\n');
          if (textValues) {
            const safetyResult = await this.safetyCharterValidator.validateContent(campaignId, textValues);
            if (safetyResult.violates) {
              throw new ForbiddenException(`Content violates session-zero safety charter: ${safetyResult.reason}`);
            }
          }
        }

        const data = await handler(validated);
        logMcpTool(name, validated, startedAt, 'ok');
        return ok(data);
      } catch (err) {
        logMcpTool(name, args ?? {}, startedAt, 'error');
        return fail(err);
      }
    };
    register(name, { description, inputSchema: strictShape }, cb);

    // Driver runtime (#312): record this tool onto the collector (when one was passed
    // to buildServer) so it can be executed off-transport through the identical cb.
    const collector = (server as unknown as { [TOOL_COLLECTOR]?: Map<string, DriverTool> })[TOOL_COLLECTOR];
    if (collector) {
      collector.set(name, {
        name,
        description,
        // JSON Schema for the neutral tool registry offered to the provider. $refStrategy
        // 'none' inlines everything (real providers reject cross-property $refs), matching
        // the inlineClone() rationale used for tools/list. `strictShape` is cast to the base
        // zod type to avoid TS2589 (the deep conditional generics zodToJsonSchema infers).
        // #371: flatten nullable numeric FK unions to a top-level numeric type so the
        // provider tool registry advertises the same concrete types as tools/list.
        inputSchema: flattenNullableNumericFks(zodToJsonSchema(strictShape, { $refStrategy: 'none' })) as Record<
          string,
          unknown
        >,
        proposalCapable: Object.prototype.hasOwnProperty.call(shape, 'propose'),
        mutating,
        invoke: async (args) => {
          const res = await cb(args);
          return { text: res.content.map((c) => c.text).join('\n'), isError: res.isError === true };
        },
      });
    }
  }

  /**
   * Registers a MUTATING tool with server-enforced write-mode (issue #158). MCP
   * tools call services directly, bypassing the HTTP WriteModeGuard, so write
   * authority must be enforced here:
   *  - Proposal-capable tools (those exposing a `propose` arg) enforce it inside
   *    their own handler via requireWriteMode(user, propose) — a 'propose' token is
   *    coerced to the proposal path, a 'none' token is rejected.
   *  - Every other (direct-only) write tool is gated HERE with
   *    assertDirectWriteAllowed(user): a 'propose'- or 'none'-mode token can't drive
   *    a mutation that has no review path, exactly as the REST WriteModeGuard blocks
   *    the equivalent non-@Proposable endpoints.
   * Read tools keep using this.tool() directly and are never gated.
   */
  /**
   * Combat-log one line per character after a rest (#1041).
   *
   * Logged from the TOOL layer, not from CharactersService, on purpose: the characters module
   * has no EncountersService edge and adding one to write a log line would be a new
   * cross-module dependency for a side effect. Both services are already injected here, and
   * the AI driver's loot tools (#1021) already append their combat-log notes at this same
   * boundary — so this follows the established seam instead of opening a new one.
   *
   * BEST-EFFORT, and after the rest has committed: a combat-log failure must never roll back
   * a rest the party has already been told about. `appendActiveEncounterNote` is itself a
   * no-op when no encounter is running, which is the common case for a rest.
   */
  private async logRestToCombatLog(campaignId: number, result: RestPartyResult): Promise<void> {
    for (const character of result.characters) {
      // The character's NAME goes in the `actor` field, never interpolated into `detail` —
      // the combat log redacts names per role and forbids name-bearing detail text (#869).
      await this.encounters
        .appendActiveEncounterNote(campaignId, character.logLine, character.name)
        .catch(() => undefined);
    }
  }

  private writeTool(
    server: McpServer,
    user: RequestUser,
    name: string,
    description: string,
    shape: z.ZodRawShape,
    handler: (args: Record<string, unknown>) => Promise<unknown>,
  ): void {
    const proposalCapable = Object.prototype.hasOwnProperty.call(shape, 'propose');
    this.tool(
      server,
      name,
      description,
      shape,
      async (args) => {
        if (!proposalCapable) assertDirectWriteAllowed(user);
        return handler(args);
      },
      true, // mutating — recorded on the DriverTool for the driver's live-play allow-list
    );
  }

  private async throttleMcpAiTool(user: RequestUser, toolName: string): Promise<void> {
    if (isThrottleDisabled()) return;

    const tracker = `user:${user.id}`;
    const key = `mcp:${toolName}:${THROTTLE_AI}:${tracker}`;
    const record = await this.throttlerStorage.increment(
      key,
      AI_THROTTLE_TTL_MS,
      AI_THROTTLE_LIMIT,
      AI_THROTTLE_TTL_MS,
      THROTTLE_AI,
    );
    if (record.isBlocked) throw new ThrottlerException();
  }

  // ---------- READ ----------

  private registerReadTools(server: McpServer, user: RequestUser): void {
    this.tool(server, 'list_campaigns', 'List the campaigns this user (or token) can access. Start here.', {}, async () =>
      this.campaigns.listForUser(user),
    );

    this.tool(
      server,
      'list_trashed_campaigns',
      'List campaigns currently in the trash (issue #116) — newest-trashed first. Same membership scoping as ' +
        'list_campaigns. Restore with restore_campaign or permanently purge via REST DELETE /campaigns/:id/purge.',
      {},
      async () => this.campaigns.listTrashedForUser(user),
    );

    this.tool(
      server,
      'get_campaign_summary',
      'Full campaign dashboard: campaign, current location, quests (with objectives), NPCs, locations, characters, ' +
        'sessions, encounter digests, in-world timeline, party treasury, inventory/comment counts, next scheduled ' +
        'session, and open inbox count. The cheapest single call to learn every core entity id in a campaign.',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        const role = await this.access.requireMember(user, campaignId as number);
        return this.campaigns.summary(campaignId as number, user, role);
      },
    );

    this.tool(
      server,
      'list_revisions',
      'List recoverable prior prose/safety snapshots for a shared editor. DM only except comment history, which is ' +
        'author-or-DM and inherits the anchored entity visibility rules.',
      { entityType: SharedEditorRevisionType, entityId: Id.describe('Entity id; campaign id for session_zero/timeline_calendar') },
      async ({ entityType, entityId }) => {
        const type = SharedEditorRevisionType.parse(entityType);
        if (type === 'comment') {
          const row = await this.comments.getRowOrThrow(entityId as number);
          const role = await this.access.requireMember(user, row.campaignId);
          return this.comments.listRevisions(entityId as number, user, role);
        }
        const campaignId = await this.revisions.campaignIdForEntityOrThrow(type, entityId as number);
        await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
        return this.revisions.listForEntity(type, entityId as number);
      },
    );

    this.tool(
      server,
      'get_session_zero',
      "The campaign's session-zero charter — lines (hard limits: content that never appears), veils (soft limits: " +
        'kept off-screen), the safety tools the table agreed to use (X-Card, Open Door, …), house rules, and tone/' +
        'content expectations. Any AI running or assisting at this table MUST respect these boundaries. Read-only over ' +
        'MCP; a campaign that never ran session zero returns empty fields. Returns the ACCEPTED charter version ' +
        '(issue #600) — the one participants actually agreed to — not the DM’s unpublished draft and not a newer ' +
        'version still awaiting acknowledgment. `charterSource` is `accepted`, `draft` (never published), or `none` ' +
        '(published but not yet licensed — empty boundaries, never the mutable draft).',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        await this.access.requireMember(user, campaignId as number);
        return this.effectiveSessionZero(campaignId as number);
      },
    );

    this.tool(
      server,
      'get_ai_support_preferences',
      'DM only: practical participation support preferences that their owners explicitly consented to AI use. Human ' +
        'table/facilitator visibility is independent and never widens this result. Re-read before prep/live use so ' +
        'revoked consent immediately stops disclosure; an empty array means no AI-authorized preferences.',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        await this.access.requireRole(user, campaignId as number, 'dm', { allowArchived: true });
        return this.supportPreferences.listForAi(campaignId as number);
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

    // ---------- storylines (issue #27) — DM-only branching arc/beat planner ----------
    this.tool(
      server,
      'list_arcs',
      'DM only: list a campaign\'s story arcs, each embedding its ordered beats (each beat embeds its ordered ' +
        'branches). Story arcs are the DM\'s branching plan of FUTURE beats — never visible to players.',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        await this.access.requireRole(user, campaignId as number, 'dm', { allowArchived: true });
        return this.storylines.listArcsWithBeats(campaignId as number);
      },
    );

    this.tool(
      server,
      'get_arc',
      'DM only: get one story arc (with its beats and branches) by id. Ids come from list_arcs.',
      { arcId: Id.describe('Story arc id') },
      async ({ arcId }) => {
        const row = await this.storylines.getArcRowOrThrow(arcId as number);
        await this.access.requireRole(user, row.campaignId, 'dm', { allowArchived: true });
        return this.storylines.getArcWithBeatsOrThrow(arcId as number);
      },
    );

    this.tool(
      server,
      'get_beat',
      'DM only: get one story beat (with its branches) by id. Ids come from list_arcs or get_arc.',
      { beatId: Id.describe('Story beat id') },
      async ({ beatId }) => {
        const row = await this.storylines.getBeatRowOrThrow(beatId as number);
        await this.access.requireRole(user, row.campaignId, 'dm', { allowArchived: true });
        return this.storylines.getBeatWithBranchesOrThrow(beatId as number);
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
      'get_faction',
      'Get a faction/organization by id, WITH its member NPCs embedded. Ids come from list_factions.',
      { factionId: Id.describe('Faction id') },
      async ({ factionId }) => {
        const row = await this.factions.getRowOrThrow(factionId as number);
        const role = await this.access.requireMember(user, row.campaignId);
        return this.factions.getWithMembersOrThrow(factionId as number, role);
      },
    );

    this.tool(server, 'list_factions', 'List factions/organizations in a campaign (guilds, cults, governments…) with their party reputation.', { campaignId: CampaignIdArg }, async ({ campaignId }) => {
      const role = await this.access.requireMember(user, campaignId as number);
      return this.factions.listForCampaign(campaignId as number, role);
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
      'Get a character sheet by id. DMs may read any party sheet; other members may read only sheets they own. Ids come from get_party or get_campaign_summary.',
      { characterId: Id.describe('Character id') },
      async ({ characterId }) => {
        const row = await this.characters.getRowOrThrow(characterId as number);
        const role = await this.access.requireMember(user, row.campaignId);
        return this.characters.getOrThrow(characterId as number, user, role);
      },
    );

    this.tool(
      server,
      'get_party',
      'List visible character sheets: the DM receives the party, while other members receive only sheets they own.',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        const role = await this.access.requireMember(user, campaignId as number);
        return this.characters.listForCampaign(campaignId as number, user, role);
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
      'list_session_shares',
      'List active public recap-share metadata for a session. Any campaign member may inspect label, creator, expiry, access count, and access timestamps; raw tokens and hashes are never returned.',
      { sessionId: Id.describe('Session id — from get_session_recaps') },
      async ({ sessionId }) => {
        const row = await this.sessions.getRowOrThrow(sessionId as number);
        await this.access.requireMember(user, row.campaignId);
        return this.sessionShares.listForSession(sessionId as number);
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
        // Issue #501: the connected MCP client IS an external model. This tool hands it raw
        // member-authored note bodies, so it MUST use the same server-side consent filter as
        // the scribe run engine — assembleSourceWithConsent drops private/whisper notes and
        // any note whose author has not opted in under the campaign's AI content policy.
        // Reading notes directly here would be a consent bypass.
        const assembly = await this.scribe.assembleSourceWithConsent(campaignId as number);
        // Whatever material exists, INCLUDING encounters still `preparing`. This tool
        // assembles a scaffold and calls no model, so the run engine's "is there enough
        // here to be worth spending provider tokens on?" gate deliberately does not apply
        // — dropping prepared encounters here served no consent purpose (#501 review).
        const assembled = assembly.source;
        const source = {
          resolvedInbox: assembled.resolvedInbox.map((n) => ({
            body: n.body,
            resolvedNote: n.resolvedNote,
            entityName: n.entityName,
          })),
          encounters: assembled.encounters.map((e) => ({
            name: e.name,
            status: e.status,
            combatants: e.combatants,
            events: e.events ?? [],
          })),
          diceRolls: (assembled.diceRolls ?? []).map((r) => ({
            label: r.label,
            actor: r.actor,
            rollerName: r.rollerName,
            total: r.total,
            dc: r.dc,
            success: r.success,
            natural20: r.natural20,
            source: r.source,
            createdAt: r.createdAt,
          })),
        };
        return {
          template: RECAP_TEMPLATE,
          draft: buildRecapDraft(source),
          sourceMaterial: source,
          // Surfaced so the DM/agent can see WHY material is missing rather than assuming
          // the table had a quiet session (#501).
          consent: assembly.consent,
          guidance:
            'Rewrite `draft` into a finished recap in the DM\'s voice, then call add_session_recap (or update_session ' +
            'for an existing session). Delete the "Threads resolved this session" and "Dice log highlights" source appendices before publishing. ' +
            'Inbox notes are filtered by the campaign AI content policy and per-member consent (see `consent`); excluded material must not be requested by other means.',
        };
      },
    );

    // write-gated (#522): files a pending proposal + spends the AI seat budget, so a
    // read-only/propose PAT must NOT trigger it. Registered via writeTool so the wrapper runs
    // assertDirectWriteAllowed(user) and tags mutating:true — the same tier as the REST
    // POST /campaigns/:id/scribe/run endpoint (no @Proposable path: a propose token can't
    // route it through review either, so it is direct-write gated, not propose-capable).
    this.writeTool(
      server,
      user,
      'run_scribe',
      'DM only: run the automatic AI scribe now. Unlike draft_session_recap (which hands YOU the source material to write ' +
        'from), this has the campaign\'s CONFIGURED provider write the recap prose server-side, then files it as a PENDING ' +
        'PROPOSAL for DM approval — nothing is published to canon. Gated like an AI-DM turn: the server experimentalAiDm flag ' +
        'must be on, the AI-DM seat enabled, and token budget must remain (the cost is metered against it). Write-gated: a ' +
        'propose/none writeScope token is refused (this spends the AI budget + files a proposal) — only a direct-write token ' +
        '(or a session) may trigger it. Idempotent: a re-run over unchanged material, or while a scribe recap proposal is ' +
        'still pending, is a no-op that returns the existing proposal. Pass dryRun:true to generate a preview without filing ' +
        'anything. Pass force:true to bypass idempotency for an explicit rerun (#499). Optionally pass scheduledSessionId to ' +
        'scope assembly to one ended scheduled game night. Returns the recorded job + any filed proposal ids + sourcePreview.',
      {
        campaignId: CampaignIdArg,
        dryRun: z.boolean().optional().describe('Generate a preview without filing a proposal'),
        force: z.boolean().optional().describe('Bypass idempotency and re-draft (#499)'),
        scheduledSessionId: Id.optional().describe('Scope assembly to one scheduled session window (#499)'),
        narrationLanguage: NarrationLanguage.optional().describe('Per-run override of the campaign narration language (#635)'),
      },
      async ({ campaignId, dryRun, force, scheduledSessionId, narrationLanguage }) => {
        await this.access.requireRole(user, campaignId as number, 'dm');
        return this.scribe.run(campaignId as number, 'on_demand', user, {
          dryRun: (dryRun as boolean | undefined) ?? false,
          force: (force as boolean | undefined) ?? false,
          ...(scheduledSessionId !== undefined ? { scheduledSessionId: scheduledSessionId as number } : {}),
          ...(narrationLanguage !== undefined ? { narrationLanguage: narrationLanguage as z.infer<typeof NarrationLanguage> } : {}),
        });
      },
    );

    this.tool(
      server,
      'read_inbox',
      'DM only: list player inbox items for a campaign — messages players sent up via submit_inbox_item. ' +
        'Defaults to open (unresolved) items; pass resolved=true for the resolved history (newest first), ' +
        'including any entity link each item was resolved into. Returns a page ' +
        '({ items, total, hasMore, nextCursor (null when exhausted), limit }) — default 50, max 200; continue with cursor (issue #608).',
      {
        campaignId: CampaignIdArg,
        resolved: z.boolean().optional().describe('If true, list resolved items instead of open ones'),
        limit: LimitArg(200, 50),
        cursor: z.string().max(512).optional().describe('Opaque cursor from a previous page\'s nextCursor'),
      },
      async ({ campaignId, resolved, limit, cursor }) => {
        await this.access.requireRole(user, campaignId as number, 'dm', { allowArchived: true });
        return this.notes.listInbox(campaignId as number, (resolved as boolean | undefined) ?? false, {
          limit: limit as number | undefined,
          cursor: cursor as string | undefined,
        });
      },
    );

    this.tool(
      server,
      'list_proposals',
      'List proposals for a campaign, optionally filtered by status (pending|approved|rejected|withdrawn). The DM ' +
        'sees ALL proposals; a non-DM member sees only their OWN submissions (proposer self-view, issue #124).',
      { campaignId: CampaignIdArg, status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']).optional().describe('Filter by status') },
      async ({ campaignId, status }) => {
        // Any member may list; the DM sees all, a non-DM member sees only their own.
        const role = await this.access.requireMember(user, campaignId as number);
        const opts = role === 'dm' ? undefined : { proposerUserId: user.id };
        return this.proposals.listForCampaign(campaignId as number, status as string | undefined, role, opts);
      },
    );

    this.tool(
      server,
      'list_notifications',
      'List the caller\'s own notifications (newest first, cursor pagination). Optionally filter unread-only, by ' +
        'campaign, type, or date range. Notifications from trashed campaigns are excluded.',
      {
        unread: z.boolean().optional().describe('If true, only unread notifications'),
        limit: LimitArg(200, 50),
        cursor: Id.optional().describe('Cursor notification id from a previous page'),
        campaignId: z.number().int().positive().optional().describe('Filter by campaign id'),
        type: z.string().max(80).optional().describe('Filter by notification type'),
        startDate: z.string().max(40).optional().describe('Created on or after (ISO date or date-time)'),
        endDate: z.string().max(40).optional().describe('Created on or before (ISO date or date-time)'),
      },
      async ({ unread, limit, cursor, campaignId, type, startDate, endDate }) =>
        this.notifications.listForUser(user, {
          unreadOnly: unread as boolean | undefined,
          limit: limit as number | undefined,
          cursor: cursor as number | undefined,
          campaignId: campaignId as number | undefined,
          type: type as string | undefined,
          startDate: startDate as string | undefined,
          endDate: endDate as string | undefined,
        }),
    );

    this.tool(
      server,
      'get_unread_notification_count',
      'Cheap poll target for the notification bell — returns { count } for the caller\'s unread notifications.',
      {},
      async () => ({ count: await this.notifications.unreadCount(user) }),
    );

    this.tool(
      server,
      'get_notification_preferences',
      'Per-campaign notification delivery preferences and quiet hours for every campaign the caller belongs to.',
      {},
      async () => this.notifications.getPreferences(user),
    );

    this.tool(
      server,
      'lookup_rule',
      'Search installed rule packs (spells, monsters, items, conditions, etc.) for a rules question. Returns up to 5 ' +
        'matches; the top match includes its full body text so the caller can quote/cite it directly. Pass `pack` ' +
        '(a rule pack slug from list_rule_packs) to scope the search to a single rule system — the campaign-scoped ' +
        'path the AI table uses for its rules help (issue #717), so a multi-pack server answers a 5e question from ' +
        'the 5e pack, not whichever pack happens to match first.',
      {
        query: z.string().min(1).max(200).describe('Free-text search query'),
        type: RuleEntryType.optional().describe('Filter by entry type'),
        pack: z
          .string()
          .min(1)
          .max(160)
          .optional()
          .describe(
            'Filter to a single installed rule pack by slug (e.g. "open5e-srd", "pf2e-srd") — the campaign-scoped path (issue #717).',
          ),
        campaignId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Optional campaign id to include campaign homebrew entries in search results for members.'),
      },
      async ({ query, type, pack, campaignId }) => {
        const page = await this.rules.search(
          { q: query as string, type: type as z.infer<typeof RuleEntryType> | undefined, pack: pack as string | undefined, campaignId: campaignId as number | undefined },
          5,
          user,
        );
        return page.items.map((entry, i) => (i === 0 ? entry : { ...entry, body: undefined }));
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
        'dataJson (e.g. a monster statblock\'s ability scores, HP, AC, traits, actions, reactions, and legendary actions). ' +
        'Ids come from lookup_rule.',
      {
        entryId: Id.describe('Rule entry id — from lookup_rule'),
        campaignId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Optional campaign id to resolve campaign homebrew entries for members.'),
      },
      async ({ entryId, campaignId }) => this.rules.getEntryOrThrow(entryId as number, campaignId as number | undefined, user),
    );

    this.tool(server, 'list_campaign_homebrew', 'List non-archived private homebrew for one campaign.', { campaignId: CampaignIdArg, includeArchived: z.boolean().optional() }, async ({ campaignId, includeArchived }) => this.rules.listCampaignHomebrew(campaignId as number, user, Boolean(includeArchived)));
    this.tool(server, 'get_campaign_homebrew', 'Get a campaign-private homebrew entry by id.', { campaignId: CampaignIdArg, entryId: Id }, async ({ campaignId, entryId }) => this.rules.getCampaignHomebrew(campaignId as number, entryId as number, user));
    this.tool(server, 'list_campaign_homebrew_revisions', 'List immutable revisions for a campaign homebrew entry.', { campaignId: CampaignIdArg, entryId: Id }, async ({ campaignId, entryId }) => this.rules.homebrewRevisions(campaignId as number, entryId as number, user));
    this.tool(server, 'preview_campaign_homebrew_import', 'Dry-run a campaign homebrew import and report slug conflicts.', { campaignId: CampaignIdArg, input: HomebrewImportPreview }, async ({ campaignId, input }) => this.rules.previewHomebrewImport(campaignId as number, input as { entries: unknown[] }, user));
    // Mutating homebrew tools must use writeTool so PAT writeScope is enforced
    // (issue #158) and the AI-driver live-play allow-list sees mutating:true.
    this.writeTool(server, user, 'create_campaign_homebrew', 'Create campaign homebrew, or submit it for DM review with propose=true.', { campaignId: CampaignIdArg, entry: HomebrewRuleEntryInput, propose: ProposeArg }, async ({ campaignId, entry, propose }) => {
      const mustPropose = requireWriteMode(user, propose);
      const role = await this.access.requireMemberOnWritableCampaign(user, campaignId as number);
      if (mustPropose || role !== 'dm') return this.proposalRecords.create(campaignId as number, 'rule_entry', null, 'create', entry as Record<string, unknown>, user, role);
      return this.rules.createCampaignHomebrew(campaignId as number, entry, user);
    });
    this.writeTool(server, user, 'update_campaign_homebrew', 'Update campaign homebrew, or submit an edit for DM review with propose=true.', { campaignId: CampaignIdArg, entryId: Id, patch: HomebrewRuleEntryUpdate, propose: ProposeArg }, async ({ campaignId, entryId, patch, propose }) => {
      const mustPropose = requireWriteMode(user, propose);
      const role = await this.access.requireMemberOnWritableCampaign(user, campaignId as number);
      if (mustPropose || role !== 'dm') return this.proposalRecords.create(campaignId as number, 'rule_entry', entryId as number, 'update', patch as Record<string, unknown>, user, role);
      return this.rules.updateCampaignHomebrew(campaignId as number, entryId as number, patch as Record<string, unknown>, user);
    });
    this.writeTool(server, user, 'duplicate_campaign_homebrew', 'Duplicate a campaign homebrew entry.', { campaignId: CampaignIdArg, entryId: Id }, async ({ campaignId, entryId }) => this.rules.duplicateCampaignHomebrew(campaignId as number, entryId as number, user));
    this.writeTool(server, user, 'archive_campaign_homebrew', 'Archive a campaign homebrew entry.', { campaignId: CampaignIdArg, entryId: Id }, async ({ campaignId, entryId }) => this.rules.archiveCampaignHomebrew(campaignId as number, entryId as number, user));
    this.writeTool(server, user, 'apply_campaign_homebrew_import', 'Apply a validated campaign homebrew import with skip, replace, or duplicate conflict handling.', { campaignId: CampaignIdArg, input: HomebrewImportApply }, async ({ campaignId, input }) => this.rules.applyHomebrewImport(campaignId as number, input as { entries: unknown[]; strategy: 'skip' | 'replace' | 'duplicate'; expectedUpdatedAt?: Record<string, string> }, user));

    this.tool(
      server,
      'get_encounter',
      'Get an encounter (combat tracker) by id, including its full combatant list sorted by turn order.',
      { encounterId: Id.describe('Encounter id — from list_encounters') },
      async ({ encounterId }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        // Pass the caller's campaign role so a non-DM viewer gets the same
        // redaction the REST route applies (issue #256): monster HP as a coarse
        // band (#43) and fog-hidden token positions nulled (#40). Omitting the
        // role defaulted to full-DM view, leaking both to any player-scoped PAT.
        const role = await this.access.requireMember(user, row.campaignId);
        return this.encounters.getWithCombatantsOrThrow(encounterId as number, role);
      },
    );

    this.tool(
      server,
      'get_encounter_difficulty',
      'Estimate an encounter\'s 5e difficulty (issue #58): a read-only Easy/Medium/Hard/Deadly band computed from the ' +
        'party PCs\' levels vs the combatant monsters\' CRs, with the standard number-of-monsters XP multiplier. Returns ' +
        'the band plus the party XP thresholds and the adjusted monster XP. No state change.',
      { encounterId: Id.describe('Encounter id — from list_encounters') },
      async ({ encounterId }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        // Pass the caller's role so a hidden encounter's difficulty (prep) is denied to a
        // non-DM the same way get_encounter's roster is (issue #262).
        const role = await this.access.requireMember(user, row.campaignId);
        return this.encounters.getDifficulty(encounterId as number, role);
      },
    );

    this.tool(
      server,
      'get_encounter_aftermath',
      'DM only: post-encounter aftermath workflow (issue #473). For an ENDED encounter, returns outcome tallies, a ' +
        'recap draft seeded from the combat log, adapter-aware XP guidance, and deep-link hand-offs to loot/treasury, ' +
        'quest objectives, and session recap surfaces. Read-only.',
      { encounterId: Id.describe('Encounter id — from list_encounters') },
      async ({ encounterId }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.encounters.getAftermath(encounterId as number, role);
      },
    );

    this.writeTool(
      server,
      user,
      'declare_aoe_template',
      'Declare or move an area-of-effect template in an encounter (issue #1913). Any DM or player may call this. ' +
        'On first use, the server stamps the authenticated caller as declarer; calling again with the same templateId ' +
        'updates that caller’s own template. A DM may update any template but never changes its original declarer. ' +
      'Callers cannot supply declarer identity. Player templates remain visible only to their owner and DMs in unrevealed fog.',
      {
        encounterId: Id.describe('Encounter id — from list_encounters'),
        templateId: AoeTemplateDeclare.shape.id.describe('Stable caller-chosen id: a repeated id upserts this template'),
        ...AoeTemplateDeclare.omit({ id: true }).partial().shape,
      },
      async ({ encounterId, templateId, ...template }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        // Keep the hidden encounter's 404 behavior inside EncountersService before
        // archive enforcement, just like REST.
        const role = await this.access.requireMember(user, row.campaignId);
        return this.encounters.declareAoeTemplate(
          encounterId as number,
          // Preserve which optional keys the MCP caller actually supplied. The service
          // validates the declaration before creating and uses that raw presence on upsert.
          { ...template, id: templateId },
          user,
          role,
          true,
        );
      },
    );

    this.writeTool(
      server,
      user,
      'remove_aoe_template',
      'Remove an area-of-effect template (issue #1913). A player may remove only their own declaration; a DM may remove any template. ' +
        'Hidden encounter, archived campaign, and ended encounter protections match declare_aoe_template and REST.',
      {
        encounterId: Id.describe('Encounter id — from list_encounters'),
        templateId: z.string().min(1).max(40).describe('AoE template id supplied when it was declared'),
      },
      async ({ encounterId, templateId }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        const role = await this.access.requireMember(user, row.campaignId);
        return this.encounters.removeAoeTemplate(encounterId as number, templateId as string, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'dismiss_encounter_aftermath',
      'DM only: defer/skip the post-encounter aftermath panel (issue #473). Idempotent — safe to retry. Cleared when the encounter is reopened.',
      { encounterId: Id.describe('Encounter id — from list_encounters') },
      async ({ encounterId }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.encounters.dismissAftermath(encounterId as number, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'apply_encounter_aftermath_xp',
      'DM only: apply XP or milestone awards for an ended encounter aftermath (issue #1448). Idempotent award of encounter XP or milestone progress to party characters.',
      {
        encounterId: Id.describe('Encounter id'),
        amount: z.number().int().min(1).optional().describe('Optional custom XP amount per character (defaults to suggested per-character XP)'),
        characterIds: z.array(Id).optional().describe('Optional target character IDs (defaults to character combatants)'),
        isMilestone: z.boolean().optional().describe('Flag indicating milestone award mode'),
        milestoneNote: z.string().optional().describe('Optional note for milestone progression'),
      },
      async ({ encounterId, amount, characterIds, isMilestone, milestoneNote }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.encounters.applyAftermathXp(
          encounterId as number,
          {
            amount: amount as number | undefined,
            characterIds: characterIds as number[] | undefined,
            isMilestone: isMilestone as boolean | undefined,
            milestoneNote: milestoneNote as string | undefined,
          },
          user,
          role,
        );
      },
    );

    this.writeTool(
      server,
      user,
      'transfer_encounter_aftermath_loot',
      'DM only: transfer loot item or currency from an ended encounter aftermath directly to character inventory or party treasury (issue #1448).',
      {
        encounterId: Id.describe('Encounter id'),
        itemId: z.string().optional().describe('Loot item id in aftermath to transfer'),
        ownerType: z.enum(['character', 'party']).optional().default('party').describe('Target owner: character or party'),
        characterId: Id.nullable().optional().describe('Target character id if ownerType is character'),
        qty: z.number().int().min(1).optional().describe('Quantity to transfer'),
        transferCoins: z
          .object({
            cp: z.number().int().min(0).optional(),
            sp: z.number().int().min(0).optional(),
            ep: z.number().int().min(0).optional(),
            gp: z.number().int().min(0).optional(),
            pp: z.number().int().min(0).optional(),
          })
          .optional()
          .describe('Coins to transfer to party treasury'),
      },
      async ({ encounterId, itemId, ownerType, characterId, qty, transferCoins }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.encounters.transferAftermathLoot(
          encounterId as number,
          {
            itemId: itemId as string | undefined,
            ownerType: (ownerType as 'character' | 'party') ?? 'party',
            characterId: characterId as number | null | undefined,
            qty: qty as number | undefined,
            transferCoins: transferCoins as any,
          },
          user,
          role,
        );
      },
    );

    this.writeTool(
      server,
      user,
      'update_encounter_aftermath_quest',
      'DM only: update quest status or objectives from encounter aftermath (issue #1448).',
      {
        encounterId: Id.describe('Encounter id'),
        questId: Id.optional().describe('Quest id (defaults to linked quest)'),
        objectiveIndex: z.number().int().min(0).optional().describe('Objective index to update'),
        objectiveCompleted: z.boolean().optional().describe('Objective completion status'),
        questStatus: z.enum(['available', 'active', 'completed', 'failed']).optional().describe('New quest status'),
        note: z.string().optional().describe('Optional note'),
      },
      async ({ encounterId, questId, objectiveIndex, objectiveCompleted, questStatus, note }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.encounters.updateAftermathQuest(
          encounterId as number,
          {
            questId: (questId as number) ?? row.questId ?? 0,
            objectiveIndex: objectiveIndex as number | undefined,
            objectiveCompleted: objectiveCompleted as boolean | undefined,
            questStatus: questStatus as any,
            note: note as string | undefined,
          },
          user,
          role,
        );
      },
    );

    this.writeTool(
      server,
      user,
      'update_encounter_aftermath_beat',
      'DM only: update or create a storyline beat from encounter aftermath (issue #1448).',
      {
        encounterId: Id.describe('Encounter id'),
        beatId: Id.optional().describe('Story beat id to update (omit to create a new beat)'),
        arcId: Id.optional().describe('Story arc id when creating a new beat'),
        title: z.string().optional().describe('Beat title'),
        body: z.string().optional().describe('Beat markdown body/notes'),
        status: z.enum(['planned', 'active', 'done', 'skipped']).optional().describe('Beat status'),
      },
      async ({ encounterId, beatId, arcId, title, body, status }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.encounters.updateAftermathBeat(
          encounterId as number,
          {
            beatId: beatId as number | undefined,
            arcId: arcId as number | undefined,
            title: title as string | undefined,
            body: body as string | undefined,
            status: status as any,
          },
          user,
          role,
        );
      },
    );

    this.writeTool(
      server,
      user,
      'add_encounter_aftermath_timeline_event',
      'DM only: add a campaign timeline event from encounter aftermath (issue #1448).',
      {
        encounterId: Id.describe('Encounter id'),
        title: z.string().min(1).max(200).describe('Timeline event title'),
        description: z.string().optional().describe('Event description'),
        inGameDate: z.string().optional().describe('In-game date string'),
        era: z.string().optional().describe('Era name'),
        sortIndex: z.number().int().optional().describe('Sort order index'),
      },
      async ({ encounterId, title, description, inGameDate, era, sortIndex }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.encounters.addAftermathTimelineEvent(
          encounterId as number,
          {
            title: title as string,
            description: description as string | undefined,
            inGameDate: inGameDate as string | undefined,
            era: era as string | undefined,
            sortIndex: sortIndex as number | undefined,
          },
          user,
          role,
        );
      },
    );

    this.tool(
      server,
      'list_encounter_events',
      'List an encounter\'s persistent combat log (issue #1068) — the round-by-round event trail of damage, healing, ' +
        'conditions, deaths, rolls, turns, notes, and DM overrides/corrections, in chronological (insertion) order. ' +
        'Read-only; persists NOTHING. Use this to reconstruct "what happened during the fight" for a recap or to ' +
        'narrate consequences — it complements get_encounter (current roster/turn state) with the historical trail. ' +
        'Role-aware (issue #869): a hidden encounter 404s for non-DM callers, and for non-DMs actor/target names (and ' +
        'name-bearing detail) are projected from CURRENT hidden-NPC visibility so a later reveal unmasks historical ' +
        'lines; stable actorId/targetId are always returned.',
      { encounterId: Id.describe('Encounter id — from list_encounters') },
      async ({ encounterId }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        // Same role-scoped redaction the REST GET :id/events route applies (issue #869):
        // a non-DM PAT must not read raw names/detail on a hidden encounter or hidden NPCs.
        const role = await this.access.requireMember(user, row.campaignId);
        return this.encounters.listEvents(encounterId as number, role);
      },
    );

    this.tool(
      server,
      'get_turn',
      'Get the current-turn workspace (issue #413): the active combatant, round, next actor, and — for the DM or the ' +
        'current combatant\'s owner — the adapter-defined action-economy slots (with usage + plain-language help), ' +
        'movement / reaction / concentration / active effects, suggested actions from the sheet, EQUIPPED inventory ' +
        'items (issue #1901 — same merged index space as list_usable_actions/resolve_action), or statblock, the ' +
        'start/end-of-turn prompts to resolve before advancing, and — for a character actor — its persisted spell ' +
        'slots and derived castable spells (issue #1900). Read-only. The detailed workspace (including spells/slots) ' +
        'is withheld from other viewers (a monster\'s abilities/effects never leak to players).',
      { encounterId: Id.describe('Encounter id — from list_encounters') },
      async ({ encounterId }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        const role = await this.access.requireMember(user, row.campaignId);
        return this.encounters.getTurnWorkspace(encounterId as number, user, role);
      },
    );

    this.tool(
      server,
      'list_usable_actions',
      'List a combatant\'s usable structured actions (issue #414): each sheet action with its mode (attack/save/check), ' +
        'the structured spec, and a `resolvable` flag — false means the action lacks enough structure to auto-resolve, ' +
        'so fall back to its freeform statblock (toHit/damage/notes) rather than inventing numbers. The freeform text is ' +
        'always returned. For a character, sheet actions come first, then any EQUIPPED inventory item\'s authored ' +
        'action appended after (issue #1326) — an equipped-item row\'s `source` reads "equipped: <item name>" (issue ' +
        '#1901); a sheet action\'s `source` is empty. A player may list only their own character\'s actions; the DM ' +
        'may list any combatant\'s. Feed the chosen action name/index into resolve_action.',
      { encounterId: Id.describe('Encounter id — from list_encounters'), combatantId: Id.describe('Combatant id — from get_encounter') },
      async ({ encounterId, combatantId }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        const role = await this.access.requireMember(user, row.campaignId);
        return this.actionResolver.listUsableActions(encounterId as number, combatantId as number, user, role);
      },
    );

    this.tool(
      server,
      'generate_encounter',
      'Generate a balanced monster group from the installed compendium to hit a target difficulty band for the ' +
        'party (issue #304) — a first-party, offline, DETERMINISTIC builder (no external data) sized by a 5e-shaped ' +
        'count/CR heuristic for every rule system. NON-MUTATING: returns a read-only suggestion ' +
        '{ combatants:[{ruleEntryId,name,entryType,cr,xp,hpMax,count}], difficulty, totalXp, shape, seed, matchedBand, difficultySupport } ' +
        'and persists NOTHING. `difficulty` is the target band (trivial|easy|medium|hard|deadly) — accepted and used ' +
        'to size the roster for every system, but the REPORTED `difficulty` result is only the rule system\'s own ' +
        'audited XP/CR math when `difficultySupport:\'supported\'` (5e and an empty/homebrew slug); a registered ' +
        'non-5e system (PF2e, OSR, …) returns `difficultySupport:\'heuristic\'` with `difficulty.status:\'unsupported\'` ' +
        '— issue #1928, label don\'t block: the roster is still valid, judge its balance yourself for that system. ' +
        '`matchedBand` describes the ROSTER-SIZING pass only (always 5e-shaped) and is NOT a claim about the ' +
        'reported `difficulty`: under `difficultySupport:\'heuristic\'` it can be `true` while `difficulty.band` is ' +
        'null, meaning "the 5e-shaped sizing hit the band you asked for", NOT "this system rates the fight that ' +
        'hard". Do not report a matched band as an achieved difficulty for a heuristic system. ' +
        'Party is inferred from the campaign\'s active PCs unless `party` (explicit PC levels) is passed. Optional ' +
        'filters: creatureType/environment (substring), minCr/maxCr, packSlug, includeHazards (add traps/environmental dangers); `shape` (solo|pair|group|horde) and `count` (max ' +
        'monsters) bound the group. Reproduce a group by passing back its `seed`; re-roll by changing/omitting it. ' +
        'TO COMMIT: call create_encounter (hidden:true keeps it DM-only prep) then add_combatant once per line with ' +
        'its ruleEntryId + count — those tools honor write-mode (#158)/proposals (#124), so this preview→commit split ' +
        'inherits the AI safety model. matchedBand:false means the compendium couldn\'t field the exact band (closest ' +
        'group returned).',
      {
        campaignId: CampaignIdArg,
        difficulty: DifficultyBand.describe('Target difficulty band to hit'),
        party: z.array(z.number().int().min(1).max(20)).max(20).optional().describe('Explicit party PC levels; omit to infer from the campaign\'s active PCs'),
        creatureType: z.string().min(1).max(60).optional().describe('Filter monsters by creature type/tag substring (e.g. "undead", "dragon")'),
        environment: z.string().min(1).max(60).optional().describe('Filter monsters by environment/terrain substring (when the source data carries it)'),
        minCr: z.number().min(0).max(30).optional().describe('Minimum challenge rating (inclusive)'),
        maxCr: z.number().min(0).max(30).optional().describe('Maximum challenge rating (inclusive)'),
        packSlug: z.string().min(1).max(160).optional().describe('Restrict to a single installed rule pack by slug (list_rule_packs)'),
        includeHazards: z.boolean().optional().describe('Also draw compendium hazards (traps/environmental dangers) as budgeted building blocks alongside monsters; omit for monsters only'),
        shape: EncounterShape.optional().describe('solo (1) | pair (2) | group (3–6) | horde (7+); omit to let the budget pick the count'),
        count: z.number().int().min(1).max(30).optional().describe('Upper bound on the number of monsters/hazards (default 12)'),
        seed: z.number().int().nonnegative().max(4294967295).optional().describe('Deterministic seed — pass a returned seed to reproduce, omit for a fresh group'),
      },
      async ({ campaignId, difficulty, party, creatureType, environment, minCr, maxCr, packSlug, includeHazards, shape, count, seed }) => {
        // Read-only preview: membership is enough, so any member or AI can generate + reroll
        // before committing through the write-gated create_encounter/add_combatant tools.
        const role = await this.access.requireMember(user, campaignId as number);
        const filters =
          creatureType !== undefined || environment !== undefined || minCr !== undefined || maxCr !== undefined || packSlug !== undefined || includeHazards !== undefined
            ? {
                creatureType: creatureType as string | undefined,
                environment: environment as string | undefined,
                minCr: minCr as number | undefined,
                maxCr: maxCr as number | undefined,
                packSlug: packSlug as string | undefined,
                includeHazards: includeHazards as boolean | undefined,
              }
            : undefined;
        return this.encounters.generateEncounter(
          campaignId as number,
          {
            difficulty: difficulty as z.infer<typeof DifficultyBand>,
            party: party as number[] | undefined,
            filters,
            shape: shape as z.infer<typeof EncounterShape> | undefined,
            count: count as number | undefined,
            seed: seed as number | undefined,
          },
          role,
        );
      },
    );

    this.tool(
      server,
      'preview_encounter',
      'Preview & TUNE a generated encounter (issue #412) — NON-MUTATING. Returns a multi-slot roster with ' +
        'per-creature inspection (AC/HP/actions/saves/traits), an XP/difficulty EXPLANATION (headline + detail, not ' +
        'just a band), a `difficultySupport` flag (\'supported\' for 5e/homebrew, \'heuristic\' for a registered ' +
        'non-5e system, where the roster was SIZED by the 5e-shaped heuristic but the reported `difficulty` is ' +
        '`status:\'unsupported\'` with a null band — it is NOT a 5e-shaped difficulty rating, it is the absence of ' +
        'one, so do not report a band for it — issue #1928; `matchedBand` refers to that 5e-shaped roster-SIZING ' +
        'pass and can be `true` beside an `unsupported` difficulty, so never report it as an achieved difficulty ' +
        'when `difficultySupport` is \'heuristic\'), ' +
        'actionable warnings (role duplication, action-economy mismatch, missing statblocks, ' +
        'unsupported-system math, swinginess), and actionable fallbacks when the compendium is empty or the system ' +
        'lacks budget math. First call with just `difficulty` (+ optional party/filters/shape/count/seed) to generate; ' +
        'then pass back `roster` (the returned plan[]) with a `tune` op to reroll-all / reroll-slot / swap-slot / ' +
        'adjust-count / pin / add-slot / remove-slot — deterministic by the per-slot seeds so pinned slots survive ' +
        'rerolls. Persists NOTHING; commit the tuned plan via commit_encounter.',
      {
        campaignId: CampaignIdArg,
        ...EncounterPreviewRequest.shape,
      },
      async ({ campaignId, ...fields }) => {
        const role = await this.access.requireMember(user, campaignId as number);
        const request = EncounterPreviewRequest.parse(fields);
        return this.encounters.previewEncounter(campaignId as number, request, role);
      },
    );

    this.writeTool(
      server,
      user,
      'commit_encounter',
      'DM only: COMMIT a tuned encounter roster (issue #412) atomically. Creates the encounter with its combatants ' +
        'plus optional location/quest/session links, battle map/grid, and token placement in ONE transaction — never ' +
        'a partial encounter or duplicate combatants. IDEMPOTENT: a retry with the same `idempotencyKey` returns the ' +
        'SAME encounter (safe to retry a lost response). Pass the `roster` (plan[]) from preview_encounter. Created ' +
        'hidden + preparing by default (DM prep, #262). The autonomous driver seat MAY commit prep encounters (they ' +
        'are hidden until the DM reveals them); the co-DM should preview and let the DM confirm. Source/inputs/roster/' +
        'manual edits are stamped into the audit trail.',
      {
        campaignId: CampaignIdArg,
        ...EncounterCommit.shape,
      },
      async ({ campaignId, ...fields }) => {
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        const request = EncounterCommit.parse(fields);
        return this.encounters.commitGeneratedEncounter(campaignId as number, request, user, role);
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
        // Pass the caller's role so a hidden (prepared, not-yet-sprung) encounter is dropped
        // from a non-DM's list, mirroring the REST route (issue #262).
        const role = await this.access.requireMember(user, campaignId as number);
        return this.encounters.listForCampaign(campaignId as number, status as 'preparing' | 'running' | 'ended' | undefined, role);
      },
    );

    this.tool(
      server,
      'list_members',
      'List campaign members (user id, role, linked character, and disabled account status). Disabled accounts do ' +
        'not count as usable DM authority.',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        await this.access.requireMember(user, campaignId as number);
        return this.members.listForCampaign(campaignId as number);
      },
    );

    this.tool(
      server,
      'list_invites',
      'DM only: list a campaign\'s live invite links (code, role, expiry, use counts). Expired/exhausted invites are ' +
        'retained but not listed. Allowed on archived campaigns.',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        await this.access.requireRole(user, campaignId as number, 'dm', { allowArchived: true });
        return this.invites.listForCampaign(campaignId as number);
      },
    );

    this.tool(
      server,
      'preview_invite',
      'Resolve a join code to the campaign name and role it grants. Unknown, expired, exhausted, revoked, or suspended ' +
        'codes return 404 — same as REST GET /invites/:code.',
      { code: z.string().min(1).max(200).describe('Invite join code — from list_invites') },
      async ({ code }) => this.invites.preview(code as string),
    );

    this.tool(
      server,
      'list_campaign_trash',
      'DM only: list soft-deleted entities in a campaign trash (sessions, characters, quests, npcs, locations) as ' +
        '{type,id,name,deletedAt} rows, newest first. Restore with the matching restore_* tool.',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        await this.access.requireRole(user, campaignId as number, 'dm');
        return this.campaigns.listTrashedEntities(campaignId as number);
      },
    );

    this.tool(
      server,
      'get_membership_integrity',
      'Server admin only: inspect secret-free campaign authority metadata (usable/disabled DM counts and migration ' +
        'repair history). This never returns campaign entities or DM-secret content and grants no campaign role.',
      {},
      async () => {
        if (!hasServerAdminPower(user)) throw new ForbiddenException('Requires server admin');
        return this.users.membershipIntegrity();
      },
    );

    this.tool(
      server,
      'list_notes',
      'List notes visible to the caller in a campaign: private (author only), dm_shared (author+dm), party_shared ' +
        '(everyone), or whisper (author + the single targeted recipient + any dm). A whisper the caller is not the ' +
        'target of is never returned. Optionally filter by the entity the note is linked to, visibility, or to just ' +
        'the caller\'s own notes. Returns a page ({ items, total, hasMore, nextCursor (null when exhausted), limit }) — default 50, max 200; ' +
        'newest first; continue with cursor (issue #608).',
      {
        campaignId: CampaignIdArg,
        entityType: EntityType.optional().describe('Filter to notes linked to this entity type'),
        entityId: Id.optional().describe('Filter to notes linked to this entity id (use with entityType)'),
        mine: z.boolean().optional().describe('If true, only the caller\'s own notes'),
        visibility: NoteVisibility.optional().describe('Filter to a single visibility'),
        q: z.string().max(200).optional().describe('Free-text search over each note body and its anchored entity name (Unicode-aware case folding), applied across the full visible set before paging'),
        limit: LimitArg(200, 50),
        cursor: z.string().max(512).optional().describe('Opaque cursor from a previous page\'s nextCursor'),
      },
      async ({ campaignId, entityType, entityId, mine, visibility, q, limit, cursor }) => {
        const role = await this.access.requireMember(user, campaignId as number);
        return this.notes.listForCampaign(campaignId as number, user, role, {
          entityType: entityType as string | undefined,
          entityId: entityId as number | undefined,
          mine: mine as boolean | undefined,
          visibility: visibility as z.infer<typeof NoteVisibility> | undefined,
          q: q as string | undefined,
          limit: limit as number | undefined,
          cursor: cursor as string | undefined,
        });
      },
    );

    this.tool(
      server,
      'read_audit_log',
      'DM only: read the campaign audit log (newest first) — who did what, incl. `token:<name>` for PAT-driven ' +
        'actions. For a "what changed since last session" delta, pass `sinceId` (the highest id you saw last time) ' +
        'to get only newer entries — one call, no client-side re-filtering — then keep the first row\'s id as the ' +
        'next cursor. `sinceTs` (ISO timestamp) is a wall-clock alternative. Narrow with `action` (e.g. "npc.update") ' +
        'or `entityType` (e.g. "quest"). Update entries carry the changed fields in `detail`.',
      {
        campaignId: CampaignIdArg,
        limit: LimitArg(500, 100),
        offset: OffsetArg,
        sinceId: z.number().int().positive().optional().describe('Delta cursor: only entries with id greater than this (highest id from your last read)'),
        sinceTs: z.string().min(1).optional().describe('Only entries created strictly after this ISO-8601 timestamp'),
        action: z.string().min(1).optional().describe('Filter to a single action, e.g. "npc.update" or "quest.status"'),
        entityType: z.string().min(1).optional().describe('Filter to a single entity type, e.g. "npc", "quest", "session"'),
      },
      async ({ campaignId, limit, offset, sinceId, sinceTs, action, entityType }) => {
        await this.access.requireRole(user, campaignId as number, 'dm', { allowArchived: true });
        // issue #71: offset pages back through history the cap-100 previously hid.
        // issue #161: sinceId/sinceTs + action/entityType turn this into a real delta channel.
        return this.audit.listForCampaign(
          campaignId as number,
          (limit as number | undefined) ?? 100,
          (offset as number | undefined) ?? 0,
          {
            sinceId: sinceId as number | undefined,
            sinceTs: sinceTs as string | undefined,
            action: action as string | undefined,
            entityType: entityType as string | undefined,
          },
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

    this.tool(
      server,
      'get_ai_dm_seat',
      'EXPERIMENTAL (issue #28): read the AI Dungeon Master seat for a campaign — whether an AI holds the DM seat, its ' +
        'persona/instructions, and the per-campaign token budget/usage. Requires membership. A connected agent that is ' +
        'meant to run the game reads this first to learn its instructions and remaining budget before ai_dm_narrate. ' +
        'The DM-authored `instructions` (steering prompt / plot secrets) are omitted for non-DM callers (issue #261).',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        const role = await this.access.requireMember(user, campaignId as number);
        return this.aiDm.getSeatForRole(campaignId as number, role);
      },
    );

    this.tool(
      server,
      'list_attachments',
      'List a campaign\'s attachments (maps, portraits, images) as metadata only — id, kind, filename, mime, byte ' +
        'size, hidden flag, uploader. Requires membership; hidden (DM-only, unrevealed) attachments are omitted ' +
        'WHOLESALE for non-DM callers, mirroring hidden quests/npcs. The raw file BYTES are not served over MCP ' +
        '(JSON-RPC surface) — fetch them via the REST route GET /attachments/:id/file. Multipart UPLOAD is also ' +
        'REST-only: POST /campaigns/:campaignId/attachments with field "file" + kind.',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        const role = await this.access.requireMember(user, campaignId as number);
        const all = await this.attachments.listForCampaign(campaignId as number);
        return filterHidden(all, role);
      },
    );

    this.tool(
      server,
      'get_attachment',
      'Get one attachment\'s metadata by id (no bytes). Requires membership; a hidden (DM-only) attachment 404s for ' +
        'non-DM callers, exactly as it is omitted from list_attachments. Fetch the actual file via the REST route ' +
        'GET /attachments/:id/file.',
      { attachmentId: Id.describe('Attachment id — from list_attachments') },
      async ({ attachmentId }) => {
        const row = await this.attachments.getRowOrThrow(attachmentId as number);
        const role = await this.access.requireMember(user, row.campaignId);
        const [visible] = filterHidden([await this.attachments.getOrThrow(attachmentId as number)], role);
        if (!visible) throw new NotFoundException(`Attachment ${attachmentId} not found`);
        return visible;
      },
    );

    // ---------- inventory & treasury (issue #257) ----------
    this.tool(
      server,
      'list_inventory',
      'List a campaign\'s inventory — the party stash plus per-character items together. Requires membership; group ' +
        'client-side by ownerType ("party"|"character") and characterId.',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        const role = await this.access.requireMember(user, campaignId as number);
        return this.inventory.listForCampaign(campaignId as number, user, role);
      },
    );

    this.tool(
      server,
      'get_inventory_item',
      'Get one inventory item by id. Ids come from list_inventory.',
      { itemId: Id.describe('Inventory item id — from list_inventory') },
      async ({ itemId }) => {
        const row = await this.inventory.getRowOrThrow(itemId as number);
        const role = await this.access.requireMember(user, row.campaignId);
        return this.inventory.getOrThrow(itemId as number, user, role);
      },
    );

    this.tool(
      server,
      'get_treasury',
      'Get the party treasury — coin totals (cp/sp/ep/gp/pp) for a campaign. Requires membership; a zeroed row is ' +
        'created lazily on first access.',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        await this.access.requireMember(user, campaignId as number);
        return this.inventory.getTreasury(campaignId as number);
      },
    );

    // ---------- timeline & calendar (issue #257) ----------
    this.tool(
      server,
      'list_timeline',
      'List a campaign\'s in-world timeline events in narrative order (DM-controlled sortIndex, then id). Requires ' +
        'membership; dmSecret is stripped and hidden events are dropped WHOLESALE for non-DM callers. Returns a ' +
        'bounded page (`items`, `total`, `hasMore`, `nextCursor`); pass `cursor` from a previous `nextCursor` to continue.',
      {
        campaignId: CampaignIdArg,
        limit: LimitArg(200, 50),
        cursor: z.string().max(512).optional().describe("Opaque cursor from a previous page's nextCursor."),
      },
      async ({ campaignId, limit, cursor }) => {
        const role = await this.access.requireMember(user, campaignId as number);
        return this.timeline.listEventsPage(campaignId as number, role, {
          limit: limit as number | undefined,
          cursor: cursor as string | undefined,
        });
      },
    );

    this.tool(
      server,
      'get_timeline_event',
      'Get one in-world timeline event by id. Ids come from list_timeline. dmSecret is stripped for non-DM; a hidden ' +
        'event 404s for non-DM (indistinguishable from a nonexistent one).',
      { eventId: Id.describe('Timeline event id — from list_timeline') },
      async ({ eventId }) => {
        const row = await this.timeline.getEventRowOrThrow(eventId as number);
        const role = await this.access.requireMember(user, row.campaignId);
        return this.timeline.getEventOrThrow(eventId as number, role);
      },
    );

    this.tool(
      server,
      'get_calendar',
      'Get the campaign\'s current in-world date and calendar note (issue #63). Requires membership; returns an empty ' +
        'default (never 404s) if no date has been set yet.',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        await this.access.requireMember(user, campaignId as number);
        return this.timeline.getCalendar(campaignId as number);
      },
    );

    // ---------- discussion comments (issue #257) ----------
    this.tool(
      server,
      'list_comments',
      'List the discussion thread anchored to one entity (entityType + entityId) in a campaign, oldest-first; ' +
        'reconstruct threading client-side from each comment\'s parentId. Requires membership AND visibility of the ' +
        'anchored entity — a thread on a hidden quest/npc/faction or an unexplored location 404s for non-DM (issue #230).',
      {
        campaignId: CampaignIdArg,
        entityType: EntityType.describe('The entity type the thread is anchored to'),
        entityId: Id.describe('The entity id the thread is anchored to'),
        limit: LimitArg(500, 500),
        offset: OffsetArg,
      },
      async ({ campaignId, entityType, entityId, limit, offset }) => {
        const role = await this.access.requireMember(user, campaignId as number);
        return this.comments.listForEntity(
          campaignId as number,
          entityType as z.infer<typeof EntityType>,
          entityId as number,
          role,
          { limit: limit as number | undefined, offset: offset as number | undefined },
        );
      },
    );

    this.tool(
      server,
      'get_comment',
      'Get one discussion comment by id. Ids come from list_comments. A tombstoned comment (issue #503) is ' +
        'returned as a redacted "[deleted]" placeholder rather than 404 — replies keep their parent. ' +
        '404s (not 403) for a comment on an entity the caller cannot see (issue #230).',
      { commentId: Id.describe('Comment id — from list_comments') },
      async ({ commentId }) => {
        const row = await this.comments.getRowOrThrow(commentId as number, true);
        const role = await this.access.requireMember(user, row.campaignId);
        return this.comments.getOrThrow(commentId as number, role);
      },
    );

    // ---------- scheduling (issue #257) ----------
    this.tool(
      server,
      'list_scheduled_sessions',
      'List a campaign\'s scheduled-session records, soonest-first, each with member RSVPs. Includes retained ' +
        'cancelled/completed history rows; use status to distinguish live planned nights. Requires membership. ' +
        'Distinct from get_session_recaps, which is the log of sessions that already happened.',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        const role = await this.access.requireMember(user, campaignId as number);
        return this.scheduling.listForCampaign(campaignId as number, role);
      },
    );

    this.tool(
      server,
      'get_next_session',
      'Get the campaign\'s "next session" — the earliest not-yet-past scheduled game night (with RSVPs), or null when ' +
        'nothing is planned. Requires membership.',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        const role = await this.access.requireMember(user, campaignId as number);
        return this.scheduling.nextForCampaign(campaignId as number, role);
      },
    );

    this.tool(
      server,
      'get_calendar_feed',
      'Get the campaign\'s ICS calendar-feed settings — the capability token and relative feed URL, or nulls when the ' +
        'feed is disabled. Requires membership (the feed only exposes schedule data members already see).',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        await this.access.requireMember(user, campaignId as number);
        return this.scheduling.getFeed(campaignId as number);
      },
    );

    this.tool(
      server,
      'list_entity_revisions',
      'List the prose revision history for an entity (session, quest, npc, location, faction, or note). ' +
        'Returns prior snapshots ordered newest-first. DM role required for world-building entities; note revisions ' +
        'are accessible to any campaign member who can read the note.',
      {
        entityType: RevisionEntityType.describe('Entity type (session|quest|npc|location|faction|note)'),
        entityId: Id.describe('Entity id'),
      },
      async ({ entityType, entityId }) => {
        const type = RevisionEntityType.parse(entityType);
        if (type === 'note') {
          // Note access mirrors the web path: any member who can read the note sees its history.
          const campaignId = await this.revisions.campaignIdForEntityOrThrow(type, entityId as number);
          await this.access.requireMember(user, campaignId);
        } else {
          const campaignId = await this.revisions.campaignIdForEntityOrThrow(type, entityId as number);
          await this.access.requireRole(user, campaignId, 'dm');
        }
        return this.revisions.listForEntity(type, entityId as number);
      },
    );
  }

  // ---------- WRITE ----------

  private registerWriteTools(server: McpServer, user: RequestUser): void {
    this.writeTool(
      server,
      user,
      'restore_revision',
      'Restore a recoverable shared-editor snapshot. The current content is recorded first, making restore reversible. ' +
        'DM only except comment history, which remains author-or-DM with normal anchor visibility.',
      {
        entityType: SharedEditorRevisionType,
        entityId: Id.describe('Entity id; campaign id for session_zero/timeline_calendar'),
        revisionId: Id.describe('Revision id from list_revisions'),
      },
      async ({ entityType, entityId, revisionId }) => {
        const type = SharedEditorRevisionType.parse(entityType);
        if (type === 'comment') {
          const row = await this.comments.getRowOrThrow(entityId as number);
          const role = await this.access.requireMemberOnWritableCampaign(user, row.campaignId);
          return this.comments.restoreRevision(entityId as number, revisionId as number, user, role);
        }
        const campaignId = await this.revisions.campaignIdForEntityOrThrow(type, entityId as number);
        const role = await this.access.requireRole(user, campaignId, 'dm');
        return this.revisions.restore(type, entityId as number, revisionId as number, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'set_my_support_preference',
      'Create or replace the authenticated participant\'s own practical support preference. This cannot edit another ' +
        'participant. Human visibility (table|facilitator) and AI use consent are independent required choices. When ' +
        'aiUseConsent is false, the result confirms metadata without echoing the private support text.',
      { campaignId: CampaignIdArg, ...ParticipantSupportPreferenceUpsert.shape },
      async ({ campaignId, ...fields }) => {
        const role = await this.access.requireMemberOnWritableCampaign(user, campaignId as number);
        const validated = ParticipantSupportPreferenceUpsert.parse(fields);
        const saved = await this.supportPreferences.upsert(campaignId as number, validated, user, role);
        return saved.aiUseConsent
          ? saved
          : { saved: true, id: saved.id, visibility: saved.visibility, aiUseConsent: false };
      },
    );

    this.writeTool(
      server,
      user,
      'delete_my_support_preference',
      'Delete the authenticated participant\'s own support preference. This cannot delete another participant\'s row.',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        const role = await this.access.requireMemberOnWritableCampaign(user, campaignId as number);
        await this.supportPreferences.removeOwn(campaignId as number, user, role);
        return { ok: true, campaignId };
      },
    );

    this.writeTool(
      server,
      user,
      'create_campaign',
      'Create a new campaign. Any authenticated user may create one; the creator is auto-added as its dm.',
      { name: z.string().min(1).max(120).describe('Campaign name'), description: z.string().max(10_000).optional().describe('Campaign description') },
      async ({ name, description }) => {
        const validated = CampaignCreate.parse({ name, ...(description !== undefined ? { description } : {}) });
        return this.campaigns.create(validated, user);
      },
    );

    this.writeTool(
      server,
      user,
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

    this.writeTool(
      server,
      user,
      'restore_campaign',
      'DM only: restore a trashed campaign (issue #116) — clears deletedAt so it returns to normal listings with every ' +
        'child row intact. 404 if not actually in the trash.',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        await this.access.requireRole(user, campaignId as number, 'dm', { allowArchived: true });
        return this.campaigns.restore(campaignId as number, user);
      },
    );

    this.writeTool(
      server,
      user,
      'create_quest',
      'Create a quest in a campaign (DM). With propose:true any member may submit it as a proposal instead. ' +
        'Supports subquests via parentId (another quest\'s id in the same campaign), an optional giverNpcId, a ' +
        'dmSecret field (DM-only text, stripped from non-DM reads), and a hidden flag (omit/true = DM-only prep by ' +
        'default, issue #754 — excluded WHOLESALE from every non-DM read until revealed via hidden=false).',
      { campaignId: CampaignIdArg, propose: ProposeArg, ...QuestCreate.shape },
      async ({ campaignId, propose, ...fields }) => {
        const validated = QuestCreate.parse(fields);
        if (requireWriteMode(user, propose)) {
          const role = await this.access.requireMemberOnWritableCampaign(user, campaignId as number);
          const proposal = await this.proposalRecords.create(campaignId as number, 'quest', null, 'create', validated, user, role);
          return { proposal };
        }
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        return this.quests.create(campaignId as number, validated, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'update_quest',
      'Update a quest (DM). With propose:true any member may submit the change as a proposal instead. Supports ' +
        'subquests via parentId, an optional giverNpcId, a dmSecret field (DM-only text), and a hidden flag ' +
        '(set hidden=false to reveal a previously-hidden quest to players).',
      { questId: Id.describe('Quest id'), propose: ProposeArg, expectedUpdatedAt: ExpectedUpdatedAt, ...QuestUpdate.shape },
      async ({ questId, propose, expectedUpdatedAt, ...fields }) => {
        const row = await this.quests.getRowOrThrow(questId as number);
        const validated = QuestUpdate.parse(fields);
        if (requireWriteMode(user, propose)) {
          const role = await this.access.requireMemberOnWritableCampaign(user, row.campaignId);
          const proposal = await this.proposalRecords.create(row.campaignId, 'quest', questId as number, 'update', validated, user, role);
          return { proposal };
        }
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.quests.update(questId as number, validated, user, role, { expectedUpdatedAt: expectedUpdatedAt as string | undefined });
      },
    );

    this.writeTool(
      server,
      user,
      'delete_quest',
      'Delete a quest (DM). Any subquests (parentId pointing at this quest) are promoted to top-level rather than ' +
        'deleted. With propose:true any member may submit the deletion as a pending proposal instead.',
      { questId: Id.describe('Quest id'), propose: ProposeArg },
      async ({ questId, propose }) => {
        const row = await this.quests.getRowOrThrow(questId as number);
        if (requireWriteMode(user, propose)) {
          const role = await this.access.requireMemberOnWritableCampaign(user, row.campaignId);
          const proposal = await this.proposalRecords.create(row.campaignId, 'quest', questId as number, 'delete', {}, user, role);
          return { proposal };
        }
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        await this.quests.remove(questId as number, user, role);
        return { ok: true, questId };
      },
    );

    this.writeTool(
      server,
      user,
      'restore_quest',
      'DM only: restore a trashed quest (issue #116) — clears deletedAt. 404 if not in the trash.',
      { questId: Id.describe('Quest id — from list_campaign_trash') },
      async ({ questId }) => {
        const row = await this.quests.getRowOrThrow(questId as number, true);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.quests.restore(questId as number, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'set_quest_status',
      'Set a quest status: available | active | completed | failed (DM). With propose:true submits a quest-update proposal.',
      { questId: Id.describe('Quest id'), status: QuestStatus, propose: ProposeArg },
      async ({ questId, status, propose }) => {
        const row = await this.quests.getRowOrThrow(questId as number);
        if (requireWriteMode(user, propose)) {
          const role = await this.access.requireMemberOnWritableCampaign(user, row.campaignId);
          const validated = QuestUpdate.parse({ status });
          const proposal = await this.proposalRecords.create(row.campaignId, 'quest', questId as number, 'update', validated, user, role);
          return { proposal };
        }
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.quests.setStatus(questId as number, { status: status as z.infer<typeof QuestStatus> }, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'add_objective',
      'Add an objective to a quest (DM).',
      { questId: Id.describe('Quest id'), text: z.string().min(1).max(500).describe('Objective text') },
      async ({ questId, text }) => {
        const row = await this.quests.getRowOrThrow(questId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.quests.addObjective(questId as number, { text: text as string }, user, role);
      },
    );

    this.writeTool(
      server,
      user,
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

    this.writeTool(
      server,
      user,
      'check_objective',
      'Mark a quest objective done/undone (player or DM).',
      { questId: Id.describe('Quest id'), objectiveId: Id.describe('Objective id'), done: z.boolean().describe('Done state') },
      async ({ questId, objectiveId, done }) => {
        const row = await this.quests.getRowOrThrow(questId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'player');
        return this.quests.patchObjective(questId as number, objectiveId as number, { done: done as boolean }, user, role);
      },
    );

    this.writeTool(
      server,
      user,
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

    // ---------- storylines (issue #27) — DM-only branching arc/beat planner ----------
    this.writeTool(
      server,
      user,
      'create_arc',
      'DM only: create a story arc — the top-level container for a branching plan of future beats. Status defaults ' +
        'to "planned" (planned | active | resolved | abandoned).',
      { campaignId: CampaignIdArg, ...StoryArcCreate.shape },
      async ({ campaignId, ...fields }) => {
        const validated = StoryArcCreate.parse(fields);
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        return this.storylines.createArc(campaignId as number, validated, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'update_arc',
      'DM only: update a story arc\'s title, summary, status, or sortOrder.',
      { arcId: Id.describe('Story arc id'), ...StoryArcUpdate.shape },
      async ({ arcId, ...fields }) => {
        const row = await this.storylines.getArcRowOrThrow(arcId as number);
        const validated = StoryArcUpdate.parse(fields);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.storylines.updateArc(arcId as number, validated, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'set_arc_status',
      'DM only: set a story arc status: planned | active | resolved | abandoned.',
      { arcId: Id.describe('Story arc id'), status: ArcStatus },
      async ({ arcId, status }) => {
        const row = await this.storylines.getArcRowOrThrow(arcId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.storylines.setArcStatus(arcId as number, { status: status as z.infer<typeof ArcStatus> }, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'delete_arc',
      'DM only: delete a story arc and ALL of its beats, plus any branch pointing at or out of those beats. Irreversible.',
      { arcId: Id.describe('Story arc id') },
      async ({ arcId }) => {
        const row = await this.storylines.getArcRowOrThrow(arcId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        await this.storylines.removeArc(arcId as number, user, role);
        return { ok: true, arcId };
      },
    );

    this.writeTool(
      server,
      user,
      'create_beat',
      'DM only: add a beat to a story arc. A beat is one planned story moment; it defaults to sortOrder = end of the ' +
        'arc and status "planned" (planned | active | done | skipped). Wire beats together with add_branch.',
      { arcId: Id.describe('Story arc id — from list_arcs/get_arc'), ...StoryBeatCreate.shape },
      async ({ arcId, ...fields }) => {
        const row = await this.storylines.getArcRowOrThrow(arcId as number);
        const validated = StoryBeatCreate.parse(fields);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.storylines.addBeat(arcId as number, validated, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'update_beat',
      'DM only: update a beat\'s title, body, status, or sortOrder.',
      { beatId: Id.describe('Story beat id'), expectedUpdatedAt: ExpectedUpdatedAt, ...StoryBeatUpdate.shape },
      async ({ beatId, expectedUpdatedAt, ...fields }) => {
        const row = await this.storylines.getBeatRowOrThrow(beatId as number);
        const validated = StoryBeatUpdate.parse(fields);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.storylines.updateBeat(beatId as number, validated, user, role, { expectedUpdatedAt: expectedUpdatedAt as string | undefined });
      },
    );

    this.writeTool(
      server,
      user,
      'set_beat_status',
      'DM only: set a beat status: planned | active | done | skipped.',
      { beatId: Id.describe('Story beat id'), status: BeatStatus },
      async ({ beatId, status }) => {
        const row = await this.storylines.getBeatRowOrThrow(beatId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.storylines.setBeatStatus(beatId as number, { status: status as z.infer<typeof BeatStatus> }, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'delete_beat',
      'DM only: delete a beat, plus any branch pointing at or out of it.',
      { beatId: Id.describe('Story beat id') },
      async ({ beatId }) => {
        const row = await this.storylines.getBeatRowOrThrow(beatId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        await this.storylines.removeBeat(beatId as number, user, role);
        return { ok: true, beatId };
      },
    );

    this.writeTool(
      server,
      user,
      'add_branch',
      'DM only: add a branch (a labelled, ordered next-option) FROM a beat. `label` is the trigger/condition ' +
        '(e.g. "if the party spares the goblin"); optional `toBeatId` targets another beat in the same campaign, or ' +
        'omit it to sketch an option whose destination beat does not exist yet. Branches order by sortOrder (appended by default).',
      {
        beatId: Id.describe('Source beat id'),
        label: z.string().min(1).max(200).describe('Trigger/condition label for this option'),
        toBeatId: Id.optional().describe('Target beat id (same campaign); omit for an open-ended option'),
        sortOrder: z.number().int().optional().describe('Explicit order; defaults to end'),
      },
      async ({ beatId, label, toBeatId, sortOrder }) => {
        const row = await this.storylines.getBeatRowOrThrow(beatId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.storylines.addBranch(
          beatId as number,
          {
            label: label as string,
            ...(toBeatId !== undefined ? { toBeatId: toBeatId as number } : {}),
            ...(sortOrder !== undefined ? { sortOrder: sortOrder as number } : {}),
          },
          user,
          role,
        );
      },
    );

    this.writeTool(
      server,
      user,
      'update_branch',
      'DM only: update an existing branch on a beat. Change the trigger `label`, retarget `toBeatId` to another beat ' +
        'in the same campaign, set `toBeatId` to null to clear the target, or adjust `sortOrder`. Omitted fields are left unchanged.',
      {
        beatId: Id.describe('Source beat id'),
        branchId: Id.describe('Branch id'),
        ...StoryBranchUpdate.shape,
      },
      async ({ beatId, branchId, ...fields }) => {
        const row = await this.storylines.getBeatRowOrThrow(beatId as number);
        const validated = StoryBranchUpdate.parse(fields);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.storylines.updateBranch(beatId as number, branchId as number, validated, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'remove_branch',
      'DM only: delete a branch from a beat.',
      { beatId: Id.describe('Source beat id'), branchId: Id.describe('Branch id') },
      async ({ beatId, branchId }) => {
        const row = await this.storylines.getBeatRowOrThrow(beatId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        await this.storylines.removeBranch(beatId as number, branchId as number, user, role);
        return { ok: true, beatId, branchId };
      },
    );

    this.writeTool(
      server,
      user,
      'upsert_npc',
      'Create or update an NPC. Pass npcId to update a specific NPC; omit it and an existing NPC with the same ' +
        'name (case-insensitive, same campaign) is updated in place — a true upsert, so an identical re-run is ' +
        'idempotent rather than duplicating. A genuinely new name creates a new NPC. DM; with propose:true any ' +
        'member may submit a proposal instead. Supports a dmSecret field (DM-only text, stripped from non-DM reads), ' +
        'an optional locationId, and a hidden flag whose omission depends on the branch: on CREATE, omit (or true) ' +
        'means DM-only prep by default (issue #754) — excluded WHOLESALE from every non-DM read until revealed via ' +
        'hidden=false; on UPDATE (an existing name or npcId), omitting hidden leaves the NPC’s current visibility ' +
        'unchanged, since only supplied fields are applied — pass hidden explicitly to change it.',
      {
        campaignId: CampaignIdArg,
        npcId: Id.optional().describe('Existing NPC id (update); omit to create'),
        propose: ProposeArg,
        expectedUpdatedAt: ExpectedUpdatedAt,
        ...NpcUpdate.shape,
      },
      async ({ campaignId, npcId, propose, expectedUpdatedAt, ...fields }) => {
        if (npcId !== undefined) {
          const row = await this.npcs.getRowOrThrow(npcId as number);
          if (row.campaignId !== (campaignId as number)) {
            throw new BadRequestException(`NPC ${npcId} belongs to campaign ${row.campaignId}, not ${campaignId}`);
          }
          const validated = NpcUpdate.parse(fields);
          if (requireWriteMode(user, propose)) {
            const role = await this.access.requireMemberOnWritableCampaign(user, row.campaignId);
            const proposal = await this.proposalRecords.create(row.campaignId, 'npc', npcId as number, 'update', validated, user, role);
            return { proposal };
          }
          const role = await this.access.requireRole(user, row.campaignId, 'dm');
          return this.npcs.update(npcId as number, validated, user, role, { expectedUpdatedAt: expectedUpdatedAt as string | undefined });
        }
        const validated = NpcCreate.parse(fields); // name required on create
        // #159: real upsert. With no npcId, match an existing NPC by (campaignId, name)
        // case-insensitively and UPDATE it instead of creating a duplicate — so an AI
        // scribe's identical re-run (timeout-after-commit, or a re-issued prompt) is
        // idempotent. A genuinely different name still creates a new NPC.
        const existingByName = await this.npcs.findRowByName(campaignId as number, validated.name);
        if (existingByName) {
          if (requireWriteMode(user, propose)) {
            const role = await this.access.requireMemberOnWritableCampaign(user, existingByName.campaignId);
            const proposal = await this.proposalRecords.create(existingByName.campaignId, 'npc', existingByName.id, 'update', validated, user, role);
            return { proposal };
          }
          const role = await this.access.requireRole(user, existingByName.campaignId, 'dm');
          return this.npcs.update(existingByName.id, validated, user, role);
        }
        if (requireWriteMode(user, propose)) {
          const role = await this.access.requireMemberOnWritableCampaign(user, campaignId as number);
          const proposal = await this.proposalRecords.create(campaignId as number, 'npc', null, 'create', validated, user, role);
          return { proposal };
        }
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        return this.npcs.create(campaignId as number, validated, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'delete_npc',
      'Delete an NPC (DM). With propose:true any member may submit the deletion as a pending proposal instead.',
      { npcId: Id.describe('NPC id'), propose: ProposeArg },
      async ({ npcId, propose }) => {
        const row = await this.npcs.getRowOrThrow(npcId as number);
        if (requireWriteMode(user, propose)) {
          const role = await this.access.requireMemberOnWritableCampaign(user, row.campaignId);
          const proposal = await this.proposalRecords.create(row.campaignId, 'npc', npcId as number, 'delete', {}, user, role);
          return { proposal };
        }
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        await this.npcs.remove(npcId as number, user, role);
        return { ok: true, npcId };
      },
    );

    this.writeTool(
      server,
      user,
      'restore_npc',
      'DM only: restore a trashed NPC (issue #116). 404 if not in the trash.',
      { npcId: Id.describe('NPC id — from list_campaign_trash') },
      async ({ npcId }) => {
        const row = await this.npcs.getRowOrThrow(npcId as number, true);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.npcs.restore(npcId as number, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'set_npc_disposition',
      'Set an NPC\'s disposition (attitude/stance toward the party) in real time (DM). The live social-scene counterpart ' +
        'to upsert_npc\'s disposition field — allows the AI DM to flip attitude during dialogue without a full NPC proposal. ' +
        'Disposition is free text (max 40 chars); typical values: friendly, neutral, hostile, suspicious, terrified.',
      {
        npcId: Id.describe('NPC id'),
        disposition: z.string().max(40).describe('New disposition label (e.g. "hostile", "friendly", "suspicious")'),
      },
      async ({ npcId, disposition }) => {
        const row = await this.npcs.getRowOrThrow(npcId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.npcs.update(npcId as number, { disposition: disposition as string }, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'upsert_faction',
      'Create or update a faction/organization (guild, cult, government, syndicate). Pass factionId to update a ' +
        'specific faction; omit it and an existing faction with the same name (case-insensitive, same campaign) is ' +
        'updated in place — a true upsert, so an identical re-run is idempotent rather than duplicating. A genuinely ' +
        'new name creates a new faction. DM only. Supports a dmSecret field (DM-only text, stripped from non-DM reads), ' +
        'a hidden flag (true = excluded WHOLESALE from every non-DM read until revealed), `goals`, a numeric ' +
        '`reputation` (-100 hostile → +100 allied) and a `standing` label. To ADJUST reputation by a delta rather than ' +
        'set it, use set_faction_reputation. Link NPCs to a faction via upsert_npc\'s factionId.',
      {
        campaignId: CampaignIdArg,
        factionId: Id.optional().describe('Existing faction id (update); omit to create'),
        expectedUpdatedAt: ExpectedUpdatedAt,
        ...FactionUpdate.shape,
      },
      async ({ campaignId, factionId, expectedUpdatedAt, ...fields }) => {
        if (factionId !== undefined) {
          const row = await this.factions.getRowOrThrow(factionId as number);
          if (row.campaignId !== (campaignId as number)) {
            throw new BadRequestException(`Faction ${factionId} belongs to campaign ${row.campaignId}, not ${campaignId}`);
          }
          const validated = FactionUpdate.parse(fields);
          const role = await this.access.requireRole(user, row.campaignId, 'dm');
          return this.factions.update(factionId as number, validated, user, role, { expectedUpdatedAt: expectedUpdatedAt as string | undefined });
        }
        const validated = FactionCreate.parse(fields); // name required on create
        // Real upsert (#159 semantics): with no factionId, match an existing faction by
        // (campaignId, name) case-insensitively and UPDATE it instead of duplicating.
        const existingByName = await this.factions.findRowByName(campaignId as number, validated.name);
        if (existingByName) {
          const role = await this.access.requireRole(user, existingByName.campaignId, 'dm');
          return this.factions.update(existingByName.id, validated, user, role);
        }
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        return this.factions.create(campaignId as number, validated, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'set_faction_reputation',
      'Adjust a faction\'s party standing (DM). The AI-scribe entry point — e.g. "the party burned the guildhall, drop ' +
        'Guild reputation by 20". Pass `delta` to bump the current score, `reputation` to set an absolute score ' +
        '(-100 hostile → +100 allied), and/or `standing` to set the label (hostile/unfriendly/neutral/friendly/allied). ' +
        'At least one of the three is required.',
      {
        factionId: Id.describe('Faction id'),
        delta: z.number().int().min(-200).max(200).optional().describe('Amount to add to the current reputation score (clamped to [-100, 100])'),
        reputation: z.number().int().min(-100).max(100).optional().describe('Absolute reputation score to set (overrides delta)'),
        standing: FactionStanding.optional().describe('Standing label to set'),
      },
      async ({ factionId, delta, reputation, standing }) => {
        const row = await this.factions.getRowOrThrow(factionId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.factions.adjustReputation(
          factionId as number,
          { delta: delta as number | undefined, reputation: reputation as number | undefined, standing: standing as FactionStanding | undefined },
          user,
          role,
        );
      },
    );

    this.writeTool(
      server,
      user,
      'delete_faction',
      'Delete a faction/organization (DM). NPCs pinned to it are unlinked (their factionId is nulled), not deleted.',
      { factionId: Id.describe('Faction id') },
      async ({ factionId }) => {
        const row = await this.factions.getRowOrThrow(factionId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        await this.factions.remove(factionId as number, user, role);
        return { ok: true, factionId };
      },
    );

    this.writeTool(
      server,
      user,
      'upsert_location',
      'Create or update a location. Pass locationId to update a specific location; omit it and an existing location ' +
        'with the same name (case-insensitive, same campaign) is updated in place — a true upsert, so an identical ' +
        're-run is idempotent rather than duplicating. A genuinely new name creates a new location. DM; with ' +
        'propose:true any member may submit a proposal instead. Supports a dmSecret field (DM-only text, stripped ' +
        'from non-DM reads). Use set_location_discovery to change `status` with the "current location" demotion side-effect.',
      {
        campaignId: CampaignIdArg,
        locationId: Id.optional().describe('Existing location id (update); omit to create'),
        propose: ProposeArg,
        expectedUpdatedAt: ExpectedUpdatedAt,
        ...LocationUpdate.shape,
      },
      async ({ campaignId, locationId, propose, expectedUpdatedAt, ...fields }) => {
        if (locationId !== undefined) {
          const row = await this.locations.getRowOrThrow(locationId as number);
          if (row.campaignId !== (campaignId as number)) {
            throw new BadRequestException(`Location ${locationId} belongs to campaign ${row.campaignId}, not ${campaignId}`);
          }
          const validated = LocationUpdate.parse(fields);
          if (requireWriteMode(user, propose)) {
            const role = await this.access.requireMemberOnWritableCampaign(user, row.campaignId);
            const proposal = await this.proposalRecords.create(row.campaignId, 'location', locationId as number, 'update', validated, user, role);
            return { proposal };
          }
          const role = await this.access.requireRole(user, row.campaignId, 'dm');
          return this.locations.update(locationId as number, validated, user, role, { expectedUpdatedAt: expectedUpdatedAt as string | undefined });
        }
        const validated = LocationCreate.parse(fields); // name required on create
        // #159: real upsert. With no locationId, match an existing location by
        // (campaignId, name) case-insensitively and UPDATE it instead of creating a
        // duplicate — so an AI scribe's identical re-run is idempotent. A genuinely
        // different name still creates a new location.
        const existingByName = await this.locations.findRowByName(campaignId as number, validated.name);
        if (existingByName) {
          if (requireWriteMode(user, propose)) {
            const role = await this.access.requireMemberOnWritableCampaign(user, existingByName.campaignId);
            const proposal = await this.proposalRecords.create(existingByName.campaignId, 'location', existingByName.id, 'update', validated, user, role);
            return { proposal };
          }
          const role = await this.access.requireRole(user, existingByName.campaignId, 'dm');
          return this.locations.update(existingByName.id, validated, user, role);
        }
        if (requireWriteMode(user, propose)) {
          const role = await this.access.requireMemberOnWritableCampaign(user, campaignId as number);
          const proposal = await this.proposalRecords.create(campaignId as number, 'location', null, 'create', validated, user, role);
          return { proposal };
        }
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        return this.locations.create(campaignId as number, validated, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'delete_location',
      'Delete a location (DM). With propose:true any member may submit the deletion as a pending proposal instead.',
      { locationId: Id.describe('Location id'), propose: ProposeArg },
      async ({ locationId, propose }) => {
        const row = await this.locations.getRowOrThrow(locationId as number);
        if (requireWriteMode(user, propose)) {
          const role = await this.access.requireMemberOnWritableCampaign(user, row.campaignId);
          const proposal = await this.proposalRecords.create(row.campaignId, 'location', locationId as number, 'delete', {}, user, role);
          return { proposal };
        }
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        await this.locations.remove(locationId as number, user, role);
        return { ok: true, locationId };
      },
    );

    this.writeTool(
      server,
      user,
      'restore_location',
      'DM only: restore a trashed location (issue #116). 404 if not in the trash.',
      { locationId: Id.describe('Location id — from list_campaign_trash') },
      async ({ locationId }) => {
        const row = await this.locations.getRowOrThrow(locationId as number, true);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.locations.restore(locationId as number, user, role);
      },
    );

    this.writeTool(
      server,
      user,
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

    this.writeTool(
      server,
      user,
      'add_session_recap',
      'Add a session recap (DM). Omit number and the server assigns the next available session number at write time ' +
        '(for propose:true, at APPROVAL time) — so a drafted recap still approves cleanly if other sessions were logged ' +
        'in between, and re-running without a number is retry-safe (an identical recap is deduped, not duplicated). ' +
        'Supports a dmSecret field (DM-only prep notes, stripped from non-DM reads). With propose:true any member may ' +
        'submit a proposal instead.',
      {
        campaignId: CampaignIdArg,
        number: z.number().int().positive().optional().describe('Session number; omit to auto-assign next available (max + 1) at write/approval time'),
        title: z.string().max(200).optional().describe('Session title'),
        recap: z.string().max(100_000).describe('Session recap (markdown)'),
        playedAt: z.string().optional().describe('ISO date the session was played'),
        dmSecret: z.string().max(20_000).optional().describe('DM-only prep notes — stripped from non-DM reads'),
        propose: ProposeArg,
      },
      async ({ campaignId, number, title, recap, playedAt, dmSecret, propose }) => {
        // Do NOT precompute the number here: freezing max+1 into the payload stranded
        // proposals on a stale number (#125) and let retries sidestep the campaign-unique
        // guard (#160). We pass number through only when the caller was explicit; otherwise
        // SessionsService.create assigns it atomically at write time (or the proposal apply
        // path does, at approval time).
        const memberRole = await this.access.requireMemberOnWritableCampaign(user, campaignId as number);
        const validated = SessionCreate.parse({
          ...(number !== undefined ? { number } : {}),
          ...(title !== undefined ? { title } : {}),
          ...(playedAt !== undefined ? { playedAt } : {}),
          ...(dmSecret !== undefined ? { dmSecret } : {}),
          recap,
        });
        if (requireWriteMode(user, propose)) {
          const proposal = await this.proposalRecords.create(campaignId as number, 'session', null, 'create', validated, user, memberRole);
          return { proposal };
        }
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        return this.sessions.create(campaignId as number, validated, user, role);
      },
    );

    this.writeTool(
      server,
      user,
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
        expectedUpdatedAt: ExpectedUpdatedAt,
      },
      async ({ sessionId, title, recap, playedAt, dmSecret, propose, expectedUpdatedAt }) => {
        const row = await this.sessions.getRowOrThrow(sessionId as number);
        const validated = SessionUpdate.parse({
          ...(title !== undefined ? { title } : {}),
          ...(recap !== undefined ? { recap } : {}),
          ...(playedAt !== undefined ? { playedAt } : {}),
          ...(dmSecret !== undefined ? { dmSecret } : {}),
        });
        if (requireWriteMode(user, propose)) {
          const role = await this.access.requireMemberOnWritableCampaign(user, row.campaignId);
          const proposal = await this.proposalRecords.create(row.campaignId, 'session', sessionId as number, 'update', validated, user, role);
          return { proposal };
        }
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.sessions.update(sessionId as number, validated, user, role, { expectedUpdatedAt: expectedUpdatedAt as string | undefined });
      },
    );

    this.writeTool(
      server,
      user,
      'delete_session',
      'Delete a session recap (DM). The campaign\'s denormalized sessionCount and latestSessionNumber are recomputed. ' +
        'With propose:true any member may submit the deletion as a pending proposal for a dm to approve instead.',
      { sessionId: Id.describe('Session id — from get_session_recaps'), propose: ProposeArg },
      async ({ sessionId, propose }) => {
        const row = await this.sessions.getRowOrThrow(sessionId as number);
        if (requireWriteMode(user, propose)) {
          const role = await this.access.requireMemberOnWritableCampaign(user, row.campaignId);
          const proposal = await this.proposalRecords.create(row.campaignId, 'session', sessionId as number, 'delete', {}, user, role);
          return { proposal };
        }
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        await this.sessions.remove(sessionId as number, user, role);
        return { ok: true, sessionId };
      },
    );

    this.writeTool(
      server,
      user,
      'restore_session',
      'DM only: restore a trashed session recap (issue #116). 404 if not in the trash.',
      { sessionId: Id.describe('Session id — from list_campaign_trash') },
      async ({ sessionId }) => {
        const row = await this.sessions.getRowOrThrow(sessionId as number, true);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.sessions.restore(sessionId as number, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'create_session_share',
      'DM only: create a public read-only recap capability. expiresAt is required: pass an ISO date-time for bounded access or explicit null only when deliberately choosing never. The raw token is returned once.',
      {
        sessionId: Id.describe('Session id — from get_session_recaps'),
        label: z.string().max(120).optional().describe('Member-visible purpose/recipient label'),
        expiresAt: z.string().datetime({ offset: true }).nullable().describe('Required expiry; explicit null means deliberately never'),
      },
      async ({ sessionId, label, expiresAt }) => {
        const row = await this.sessions.getRowOrThrow(sessionId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        const input = SessionShareCreate.parse({ label, expiresAt });
        return this.sessionShares.create(row, input, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'update_session_share',
      'DM only: update a public recap share label and/or expiry. Extending the expiry notifies affected campaign members.',
      {
        sessionId: Id.describe('Session id'),
        shareId: Id.describe('Share id — from list_session_shares'),
        label: z.string().max(120).optional(),
        expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
      },
      async ({ sessionId, shareId, label, expiresAt }) => {
        const row = await this.sessions.getRowOrThrow(sessionId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        const input = SessionShareUpdate.parse({ ...(label !== undefined ? { label } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}) });
        return this.sessionShares.update(shareId as number, row, input, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'revoke_session_share',
      'DM only: revoke one public recap capability immediately.',
      { sessionId: Id.describe('Session id'), shareId: Id.describe('Share id — from list_session_shares') },
      async ({ sessionId, shareId }) => {
        const row = await this.sessions.getRowOrThrow(sessionId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm', { allowArchived: true });
        await this.sessionShares.revoke(shareId as number, row, user, role);
        return { ok: true, shareId };
      },
    );

    this.writeTool(
      server,
      user,
      'revoke_all_session_shares',
      'DM only: revoke every public recap capability in a campaign, including expired rows.',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        await this.sessionShares.getCampaignOrThrow(campaignId as number);
        const role = await this.access.requireRole(user, campaignId as number, 'dm', { allowArchived: true });
        return this.sessionShares.revokeAll(campaignId as number, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'set_recap_share_policy',
      'DM only: enable or disable public recap sharing for a campaign. Disabling atomically revokes every existing URL; re-enabling never resurrects them.',
      { campaignId: CampaignIdArg, enabled: z.boolean() },
      async ({ campaignId, enabled }) => {
        const campaign = await this.sessionShares.getCampaignOrThrow(campaignId as number);
        const role = await this.access.requireRole(user, campaignId as number, 'dm', { allowArchived: true });
        return this.sessionShares.setCampaignPolicy(campaign, enabled as boolean, user, role);
      },
    );

    this.tool(
      server,
      'get_session_attendance',
      'List the characters that played a session (issue #121) — the West Marches "who was there" record. Ids come ' +
        'from get_session_recaps / get_session. Names reflect the current character row (including retired/trashed ' +
        'characters), with the recorded name as a fallback if that row is unavailable. Empty when attendance was never recorded.',
      { sessionId: Id.describe('Session id — from get_session_recaps') },
      async ({ sessionId }) => {
        const row = await this.sessions.getRowOrThrow(sessionId as number);
        await this.access.requireMember(user, row.campaignId);
        return this.sessions.getAttendance(sessionId as number);
      },
    );

    this.writeTool(
      server,
      user,
      'set_session_attendance',
      'DM only: record who played a session (issue #121). Replaces the session\'s attendance with exactly ' +
        '`characterIds` — pass the full set each time (an empty array clears it). Every id must be a character in the ' +
        'session\'s own campaign (character ids come from get_campaign_summary / list). Lets an AI scribe log the ' +
        'rotating cast of a West Marches outing.',
      {
        sessionId: Id.describe('Session id — from get_session_recaps'),
        characterIds: z.array(Id).max(500).describe('The full set of characters that attended; replaces any prior attendance'),
      },
      async ({ sessionId, characterIds }) => {
        const row = await this.sessions.getRowOrThrow(sessionId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.sessions.setAttendance(sessionId as number, characterIds as number[], user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'upsert_character',
      'Create a character (omit characterId) or update one (pass characterId). player may create/update their own ' +
        'character; dm may create/update any character in the campaign, incl. reassigning ownerUserId. The dmSecret ' +
        'field (DM-only text, stripped from non-DM reads) is only writable as dm — ignored otherwise. Set status to ' +
        "active|draft|dead|retired|inactive to mark a PC's lifecycle — only active PCs are auto-added to new encounters. With propose:true " +
        'any member may submit the create/update as a pending proposal for a dm to approve instead of writing directly. ' +
        'Pass expectedUpdatedAt (the updatedAt you last read) on an update to opt into optimistic concurrency (issue #746): ' +
        'a stale value returns 409 Conflict instead of silently clobbering a fresher edit from another tab or a connected AI.',
      {
        campaignId: CampaignIdArg,
        characterId: Id.optional().describe('Existing character id (update); omit to create'),
        propose: ProposeArg,
        expectedUpdatedAt: ExpectedUpdatedAt,
        ...CharacterUpdate.shape,
      },
      async ({ campaignId, characterId, propose, expectedUpdatedAt, ...fields }) => {
        if (characterId !== undefined) {
          const row = await this.characters.getRowOrThrow(characterId as number);
          if (row.campaignId !== (campaignId as number)) {
            throw new BadRequestException(`Character ${characterId} belongs to campaign ${row.campaignId}, not ${campaignId}`);
          }
          const validated = CharacterUpdate.parse(fields);
          if (requireWriteMode(user, propose)) {
            const role = await this.access.requireMemberOnWritableCampaign(user, row.campaignId);
            const proposal = await this.proposalRecords.create(row.campaignId, 'character', characterId as number, 'update', validated, user, role);
            return { proposal };
          }
          const role = await this.access.requireRole(user, row.campaignId, 'player');
          return this.characters.update(characterId as number, validated, user, role, {
            expectedUpdatedAt: expectedUpdatedAt as string | undefined,
          });
        }
        const validated = CharacterCreate.parse(fields); // name required on create
        if (requireWriteMode(user, propose)) {
          const role = await this.access.requireMemberOnWritableCampaign(user, campaignId as number);
          const proposal = await this.proposalRecords.create(campaignId as number, 'character', null, 'create', validated, user, role);
          return { proposal };
        }
        const role = await this.access.requireRole(user, campaignId as number, 'player');
        return this.characters.create(campaignId as number, validated, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'delete_character',
      'Delete a character (DM). With propose:true any member may submit the deletion as a pending proposal for a dm ' +
        'to approve instead.',
      { characterId: Id.describe('Character id'), propose: ProposeArg },
      async ({ characterId, propose }) => {
        const row = await this.characters.getRowOrThrow(characterId as number);
        if (requireWriteMode(user, propose)) {
          const role = await this.access.requireMemberOnWritableCampaign(user, row.campaignId);
          const proposal = await this.proposalRecords.create(row.campaignId, 'character', characterId as number, 'delete', {}, user, role);
          return { proposal };
        }
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        await this.characters.remove(characterId as number, user, role);
        return { ok: true, characterId };
      },
    );

    this.writeTool(
      server,
      user,
      'restore_character',
      'Restore a trashed character (issue #116) — dm or the owning player. 404 if not in the trash.',
      { characterId: Id.describe('Character id — from list_campaign_trash') },
      async ({ characterId }) => {
        const row = await this.characters.getRowOrThrow(characterId as number, true);
        const role = await this.access.requireRole(user, row.campaignId, 'player');
        return this.characters.restore(characterId as number, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'adjust_spell_slots',
      'Spend (+delta) or restore (-delta) spell slots at one level for a character — dm or the owning player. ' +
        'A spend that exceeds the slots remaining FAILS with an error carrying `remaining` and `max`, so it is safe ' +
        'to treat success as "the slot was consumed" — do not narrate a spell as cast if this call errored. ' +
        'Restores clamp at zero. 400 if the character has no slots configured at that level. Optional ' +
        '`expectedUpdatedAt` (the character\'s `updatedAt` you last read) rejects the write with 409 if the sheet ' +
        'changed since — omit for an unconditional write.',
      { characterId: Id.describe('Character id'), ...SpellSlotPatch.shape },
      // Issue #1902 rework (round 5): `expectedUpdatedAt` MUST be pulled out and forwarded
      // explicitly, matching update_quest/update_npc/update_faction above — spreading
      // `SpellSlotPatch.shape` into this tool's declared input widens what it ADVERTISES,
      // but nothing forwards a field the handler never names. Before this fix an MCP
      // caller (the AI DM) that supplied `expectedUpdatedAt` believing it opted into the
      // 409 STALE_WRITE guard got an unconditional write instead — the token was silently
      // dropped, not honoured.
      async ({ characterId, level, delta, expectedUpdatedAt }) => {
        const row = await this.characters.getRowOrThrow(characterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'player');
        const before = await this.characters.spellSlotsLeft(characterId as number, level as number);
        const updated = await this.characters.patchSpellSlots(
          characterId as number,
          { level: level as number, delta: delta as number, expectedUpdatedAt: expectedUpdatedAt as string | undefined },
          user,
          role,
        );
        // Combat-logged at the TOOL boundary, not inside CharactersService: that module has no
        // EncountersService edge, and both the rest tools and the driver's loot tools (#1021)
        // already log here. Best-effort and post-commit — a log failure must not undo a spend.
        const after = spellSlotsRemaining(
          (updated.spellSlots ?? {}) as Record<string, { max: number; used: number }>,
          level as number,
        );
        if (after !== before) {
          const spent = after < before;
          const count = Math.abs(after - before);
          await this.encounters
            .appendActiveEncounterNote(
              row.campaignId,
              `${spent ? 'spent' : 'restored'} ${count} level ${level} spell ${count === 1 ? 'slot' : 'slots'} (${after} remaining)`,
              updated.name,
            )
            .catch(() => undefined);
        }
        return updated;
      },
    );

    // #422/#1578 — the character-resource system had zero callers: adjustResource and
    // resourceVocabularyForAdapter existed, race-free and rule-system-aware, with no REST
    // route, MCP tool, or UI reaching either. These two mirror adjust_spell_slots/list_checks'
    // shape exactly (same requireRole('player') gate as every other player-owns-their-sheet
    // mutation, same read-the-adapter-don't-hardcode-a-vocabulary pattern).
    this.tool(
      server,
      'list_character_resources',
      "List a character's available resource vocabulary (issue #422): the campaign rule system's STANDARD pools " +
        '(5e hitDice/rage/actionSurge/kiPoints/inspiration, PF2e focusPoints/hitDice/heroPoints, and so on) plus ' +
        'any CUSTOM resource already on this sheet, sourced from the campaign RuleSystemAdapter — never hardcoded ' +
        'to one system. Use a returned `key` with adjust_character_resource; that tool also accepts a key outside ' +
        'this list to create a homebrew resource, so this is for DISCOVERING the adapter-declared ones, not gating them.',
      { characterId: Id.describe('Character id — from list_members, get_party, or list_characters') },
      async ({ characterId }) => {
        await this.characters.assertCharacterReadable(characterId as number, user);
        return this.characters.listResourceVocabulary(characterId as number);
      },
    );

    this.writeTool(
      server,
      user,
      'adjust_character_resource',
      'Spend, restore, or configure one bounded character resource (issue #422) — dm or the owning player, same ' +
        'authority as adjust_spell_slots. `delta` adjusts relative to the resource\'s current `used`; `used` sets it ' +
        'absolutely (applied first when both are sent). Spending past 0 or restoring past `max` FAILS with a 400 — ' +
        'never a silent clamp — so it is safe to treat success as "the resource was actually spent/restored"; do not ' +
        'narrate a Second Wind or a Ki technique the call errored on. `key` is not restricted to ' +
        'list_character_resources\' vocabulary: an unrecognised key creates a custom resource from `max`/`name`/' +
        '`recharge` (or their defaults) the first time it is touched. Optional `expectedUpdatedAt` (the character\'s ' +
        '`updatedAt` you last read) rejects the write with 409 if the sheet changed since — this matters especially ' +
        'here because `used` is an ABSOLUTE overwrite: without it, a concurrent spend or rest from another caller ' +
        'between your read and this write is silently undone. Omit for an unconditional write.',
      { characterId: Id.describe('Character id'), ...ResourcePatch.shape },
      async ({ characterId, ...patch }) => {
        const row = await this.characters.getRowOrThrow(characterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'player');
        const validated = ResourcePatch.parse(patch);
        const before = fromJsonText<Record<string, { used?: number }>>(row.resources, {})[validated.key]?.used ?? 0;
        const updated = await this.characters.adjustResource(characterId as number, validated, user, role);
        // Same best-effort combat-log convenience as adjust_spell_slots above, and for the same
        // reason: CharactersService has no EncountersService edge, and a log failure must never
        // undo a spend that already committed.
        const after = updated.resources?.[validated.key]?.used ?? before;
        if (after !== before) {
          const spent = after > before;
          const count = Math.abs(after - before);
          const label = updated.resources?.[validated.key]?.name || validated.key;
          await this.encounters
            .appendActiveEncounterNote(
              row.campaignId,
              `${spent ? 'spent' : 'restored'} ${count} ${label} (${after} used, ${updated.resources?.[validated.key]?.max ?? '?'} max)`,
              updated.name,
            )
            .catch(() => undefined);
        }
        return updated;
      },
    );

    this.writeTool(
      server,
      user,
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

    this.writeTool(
      server,
      user,
      'award_xp',
      "Award XP. Either adjust one character by characterId (player owner or DM; amount may be negative and XP never drops below 0), or make a DM-only party award. Party awards default to active characters; characterIds is enforced exactly, and inactive/retired/dead recipients require both explicit characterIds and includeNonActive:true for deliberate historical corrections.",
      {
        campaignId: CampaignIdArg,
        characterId: Id.optional().describe('Single character to adjust (owner or DM); omit for a DM party-wide award'),
        amount: z.number().int().describe('XP to add. Party-wide awards require a positive amount'),
        characterIds: z.array(Id).min(1).optional().describe('Party-award only: exact recipient character ids'),
        includeNonActive: z
          .boolean()
          .optional()
          .describe('Party-award only: explicit opt-in required for inactive, retired, or dead recipients'),
      },
      async ({ campaignId, characterId, amount, characterIds, includeNonActive }) => {
        if (characterId !== undefined) {
          if (characterIds !== undefined || includeNonActive !== undefined) {
            throw new BadRequestException('characterIds/includeNonActive are only valid for party awards');
          }
          const row = await this.characters.getRowOrThrow(characterId as number);
          if (row.campaignId !== (campaignId as number)) {
            throw new BadRequestException(`Character ${characterId} belongs to campaign ${row.campaignId}, not ${campaignId}`);
          }
          const role = await this.access.requireRole(user, row.campaignId, 'player');
          return this.characters.patchXp(characterId as number, { delta: amount as number }, user, role);
        }
        const validated = XpAward.parse({
          amount,
          ...(characterIds !== undefined ? { characterIds } : {}),
          ...(includeNonActive !== undefined ? { includeNonActive } : {}),
        });
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        return this.characters.awardXp(campaignId as number, validated, user, role);
      },
    );

    this.writeTool(
      server,
      user,
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

    // ── Rest mechanics (#1041) ────────────────────────────────────────────────────────
    //
    // ATOMIC BY CONTRACT. Before these existed the only way to run a rest was to set each
    // character's HP, reset each spell-slot level and clear each condition with its own call —
    // dozens of writes with no transaction, so a turn that ran out of steps left the party
    // half-rested. Both tools plan the WHOLE party first and reject the entire call if any
    // character's rest is not applicable, so there is no partial outcome to unpick.
    this.writeTool(
      server,
      user,
      'long_rest',
      'Take a LONG rest for one or more characters, atomically: HP to full, temp HP cleared, ' +
        'death saves reset, spell slots restored, resources refilled by their rule-system recharge cadence, ' +
        'and the conditions this rule system says a long rest ends. Conditions it does NOT recognise are ' +
        'deliberately LEFT in place and reported, so a curse or a homebrew status is never silently deleted ' +
        'by a night\'s sleep. Rejects the whole rest (writing nothing) if any named character is dead.',
      {
        campaignId: Id.describe('Campaign the party belongs to'),
        characterIds: z
          .array(Id)
          .min(1)
          .max(20)
          .describe('Characters taking the rest. Every one is validated before ANYTHING is written.'),
      },
      async ({ campaignId, characterIds }) => {
        const role = await this.access.requireRole(user, campaignId as number, 'player');
        const result = await this.characters.restParty(campaignId as number, 'long', characterIds as number[], {}, user, role);
        await this.logRestToCombatLog(campaignId as number, result);
        return result;
      },
    );

    this.writeTool(
      server,
      user,
      'short_rest',
      'Take a SHORT rest for one or more characters, atomically. Restores resources whose recharge ' +
        'cadence is short-rest, and optionally spends hit dice for HP recovery (each die rolled + CON ' +
        'modifier). Hit dice require an explicit `hitDie` size — the class die is not stored on the sheet, ' +
        'and guessing one would silently under-heal. Rejects the whole rest (writing nothing) if any ' +
        'character lacks the hit dice requested or is dead.',
      {
        campaignId: Id.describe('Campaign the party belongs to'),
        characterIds: z
          .array(Id)
          .min(1)
          .max(20)
          .describe('Characters taking the rest. Every one is validated before ANYTHING is written.'),
        hitDice: z
          .array(
            z.object({
              characterId: Id.describe('Character spending hit dice'),
              dice: z.number().int().min(1).max(20).describe('How many hit dice to spend'),
              hitDie: z
                .number()
                .int()
                .min(2)
                .max(100)
                .describe('Die size, e.g. 8 for a d8. Required — the sheet does not store the class hit die.'),
            }),
          )
          .max(20)
          .optional()
          .describe('Per-character hit-dice spend. Characters omitted here simply spend none.'),
      },
      async ({ campaignId, characterIds, hitDice }) => {
        const role = await this.access.requireRole(user, campaignId as number, 'player');
        const perCharacter: Record<number, { spendHitDice?: number; hitDie?: number }> = {};
        for (const entry of (hitDice ?? []) as Array<{ characterId: number; dice: number; hitDie: number }>) {
          perCharacter[entry.characterId] = { spendHitDice: entry.dice, hitDie: entry.hitDie };
        }
        const result = await this.characters.restParty(
          campaignId as number,
          'short',
          characterIds as number[],
          perCharacter,
          user,
          role,
        );
        await this.logRestToCombatLog(campaignId as number, result);
        return result;
      },
    );

    this.writeTool(
      server,
      user,
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

    // Issue #1643: set_character_conditions above only adds/removes a bare name and
    // PRESERVES an existing instance's `stacks` — there was no way for the AI (or a human
    // via REST) to actually MOVE the level of a leveled condition track (5e Exhaustion) on
    // a character sheet, only toggle its presence. This is that path: same
    // delta/level-are-alternatives shape as adjust_character_resource, gated to whichever
    // ONE condition (if any) the campaign's rule-system adapter declares as leveled — a
    // PF2e campaign 400s on every call, since it declares none.
    this.writeTool(
      server,
      user,
      'adjust_character_condition_level',
      "Raise or lower the LEVEL of the campaign's leveled condition track (issue #1643) — 5e Exhaustion (1-6), " +
        'or nothing on a system with no such track (e.g. PF2e — every call 400s there). player owner or DM, same ' +
        'authority as adjust_character_resource. `delta` adjusts relative to the current level; `level` sets it ' +
        'absolutely (applied first when both are sent). Resulting level outside [0, the track\'s max] FAILS with a ' +
        '400 — never a silent clamp — so a success can be trusted as "the level actually changed by that amount." ' +
        'Level 0 removes the condition. `name` must match the track this campaign actually has.',
      // ConditionLevelPatch is a ZodEffects (.refine requiring delta|level), so it has no
      // `.shape` to spread — list the wire fields here and re-validate with .parse below.
      {
        characterId: Id.describe('Character id'),
        name: z.string().min(1).max(40).describe("Leveled condition track name for this campaign (5e: 'Exhaustion')"),
        delta: z.number().int().optional().describe('Relative level adjustment (at least one of delta or level required)'),
        level: z
          .number()
          .int()
          .min(0)
          .max(99)
          .optional()
          .describe('Absolute level; 0 removes (at least one of delta or level required)'),
      },
      async ({ characterId, ...patch }) => {
        const row = await this.characters.getRowOrThrow(characterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'player');
        const validated = ConditionLevelPatch.parse(patch);
        return this.characters.adjustConditionLevel(characterId as number, validated, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'add_note',
      'Add a note to a campaign (any member). Visibility: private (default) | dm_shared | party_shared | whisper. ' +
        'A `whisper` is a per-player secret: pass `recipientUserId` (a campaign member id) and the note is visible ' +
        'ONLY to that member, the author, and any DM — the way to record "only the rogue notices the trap door" or a ' +
        'patron speaking to one warlock. Prefer the dedicated whisper_to_player tool for the common case.',
      {
        campaignId: CampaignIdArg,
        body: z.string().min(1).max(20_000).describe('Note body (markdown)'),
        visibility: NoteVisibility.optional().describe('private | dm_shared | party_shared | whisper'),
        entityType: EntityType.optional().describe('Optionally link to an entity type'),
        entityId: Id.optional().describe('Optionally link to an entity id'),
        recipientUserId: z
          .string()
          .max(120)
          .optional()
          .describe('Required when visibility is "whisper": the member userId (from list_members) the whisper targets'),
      },
      async ({ campaignId, body, visibility, entityType, entityId, recipientUserId }) => {
        const role = await this.access.requireMemberOnWritableCampaign(user, campaignId as number);
        return this.notes.create(
          campaignId as number,
          {
            body: body as string,
            ...(visibility !== undefined ? { visibility: visibility as z.infer<typeof NoteVisibility> } : {}),
            ...(entityType !== undefined ? { entityType: entityType as z.infer<typeof EntityType> } : {}),
            ...(entityId !== undefined ? { entityId: entityId as number } : {}),
            ...(recipientUserId !== undefined ? { recipientUserId: recipientUserId as string } : {}),
          },
          user,
          role,
        );
      },
    );

    this.writeTool(
      server,
      user,
      'whisper_to_player',
      'Share a note with ONE specific player — a per-player secret ("whisper"). Visible only to that member, the ' +
        'author, and any DM; every other member (incl. over MCP) can never see it. Use for asymmetric knowledge the ' +
        'party does not share: "only the rogue notices the trap door", a patron whispering to one warlock, a traitor ' +
        'briefing. Optionally anchor it to an entity (entityType/entityId) so the secret lives on that NPC/location/' +
        'quest page for the recipient. recipientUserId is a member userId — see list_members.',
      {
        campaignId: CampaignIdArg,
        recipientUserId: z.string().max(120).describe('The member userId to whisper to (from list_members)'),
        body: z.string().min(1).max(20_000).describe('Note body (markdown)'),
        entityType: EntityType.optional().describe('Optionally anchor the whisper to an entity type'),
        entityId: Id.optional().describe('Optionally anchor the whisper to an entity id'),
      },
      async ({ campaignId, recipientUserId, body, entityType, entityId }) => {
        const role = await this.access.requireMemberOnWritableCampaign(user, campaignId as number);
        return this.notes.create(
          campaignId as number,
          {
            body: body as string,
            visibility: 'whisper',
            recipientUserId: recipientUserId as string,
            ...(entityType !== undefined ? { entityType: entityType as z.infer<typeof EntityType> } : {}),
            ...(entityId !== undefined ? { entityId: entityId as number } : {}),
          },
          user,
          role,
        );
      },
    );

    this.writeTool(
      server,
      user,
      'update_note',
      'Edit a note\'s body and/or visibility. Author only — dm may NOT edit another member\'s note. Set visibility to ' +
        '"whisper" together with recipientUserId to re-target it at one member; switching away from whisper clears the recipient.',
      {
        noteId: Id.describe('Note id'),
        body: z.string().min(1).max(20_000).optional().describe('Note body (markdown)'),
        visibility: NoteVisibility.optional().describe('private | dm_shared | party_shared | whisper'),
        recipientUserId: z
          .string()
          .max(120)
          .nullable()
          .optional()
          .describe('Whisper target member id — required alongside visibility "whisper"; ignored for other visibilities'),
        expectedUpdatedAt: ExpectedUpdatedAt,
      },
      async ({ noteId, body, visibility, recipientUserId, expectedUpdatedAt }) => {
        const row = await this.notes.getRowOrThrow(noteId as number);
        const role = await this.access.requireMemberOnWritableCampaign(user, row.campaignId);
        return this.notes.update(
          noteId as number,
          {
            ...(body !== undefined ? { body: body as string } : {}),
            ...(visibility !== undefined ? { visibility: visibility as z.infer<typeof NoteVisibility> } : {}),
            ...(recipientUserId !== undefined ? { recipientUserId: recipientUserId as string | null } : {}),
          },
          user,
          role,
          { expectedUpdatedAt: expectedUpdatedAt as string | undefined },
        );
      },
    );

    this.writeTool(
      server,
      user,
      'delete_note',
      'Delete a note. Author only — dm may NOT delete another member\'s note.',
      { noteId: Id.describe('Note id') },
      async ({ noteId }) => {
        const row = await this.notes.getRowOrThrow(noteId as number);
        const role = await this.access.requireMemberOnWritableCampaign(user, row.campaignId);
        await this.notes.remove(noteId as number, user, role);
        return { ok: true, noteId };
      },
    );

    this.writeTool(
      server,
      user,
      'restore_note',
      'Restore a trashed note (issue #116). Author only — dm may NOT restore another member\'s note. 404 if not in trash.',
      { noteId: Id.describe('Note id') },
      async ({ noteId }) => {
        const row = await this.notes.getRowOrThrow(noteId as number, true);
        const role = await this.access.requireMemberOnWritableCampaign(user, row.campaignId);
        return this.notes.restore(noteId as number, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'submit_inbox_item',
      'Any member may send a message up to the DM (e.g. a player asking a rules question, flagging something out ' +
        'of character). Appears in read_inbox until a dm calls resolve_inbox_item.',
      { campaignId: CampaignIdArg, body: z.string().min(1).max(20_000).describe('Message body') },
      async ({ campaignId, body }) => {
        const role = await this.access.requireMemberOnWritableCampaign(user, campaignId as number);
        return this.notes.createInbox(campaignId as number, { authorName: user.name, body: body as string }, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'resolve_inbox_item',
      'DM only: resolve a player inbox item, optionally with a resolution note and/or a link to the entity it ' +
        'became (entityType + entityId together) — shown in the resolved history (read_inbox with resolved=true). ' +
        'Retrying the identical terminal payload returns the existing result; a different terminal payload after ' +
        'resolution fails with conflict.',
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

    // Issue #1645/1716 — MCP parity for the inbox sweep (#1644). Calls the EXACT SAME
    // InboxSweepService.startInboxSweep() orchestration the REST POST /campaigns/:id/inbox/sweep
    // route uses, and exposes the matching GET /campaigns/:id/inbox/sweep/:jobId poll as
    // `get_inbox_sweep_result` — so MCP/REST behavior cannot drift apart. dm role required
    // (same as the REST controller), which also enforces the archived-campaign read-only gate
    // via requireRole. Although startInboxSweep() files PENDING PROPOSALS for canon changes, it
    // also writes sweep job/ledger rows and resolves inbox notes, so this is direct-write-only
    // just like the non-@Proposable REST route.
    this.tool(
      server,
      'sweep_inbox',
      'DM only: start a sweep of the campaign inbox — reads every OPEN inbox item, infers create/update/dismiss ' +
        'per capture (unsupported cases like objective ticks or HP/combat writes always skip with a stated reason), ' +
        'files each inferred canon change as a PENDING PROPOSAL (never a direct canon write), records the sweep, and ' +
        'resolves swept items. Requires direct write authority; propose-only tokens are rejected to match REST. ' +
        'Safe to re-run: an item already swept is never re-classified or re-proposed. Returns a job row whose status ' +
        'is `running` when the sweep needs more time (poll `get_inbox_sweep_result {campaignId, jobId}` until the ' +
        'status is no longer `running` to receive the per-item outcomes), or already terminal (`succeeded`/`failed`/' +
        '`disabled`) when the sweep completes within a few seconds. Identical behavior to REST POST /campaigns/:id/inbox/sweep.',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        assertDirectWriteAllowed(user);
        await this.throttleMcpAiTool(user, 'sweep_inbox');
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        return this.inboxSweep.startInboxSweep(campaignId as number, user, role);
      },
      true, // mutating — recorded on the DriverTool; not proposal-capable-tagged (no `propose`
      // arg) and NOT in DRIVER_LIVE_PLAY_TOOLS, so the driver seat cannot trigger a bulk sweep
      // mid-session — this is an administrative/out-of-session action, same posture as
      // run_scribe.
    );

    this.tool(
      server,
      'get_inbox_sweep_result',
      'DM only: get the current result of a previously started inbox sweep job. ' +
        'Returns the job status and the per-item outcomes recorded so far. Poll repeatedly while `job.status` is ' +
        '`running`. Identical behavior to REST GET /campaigns/:id/inbox/sweep/:jobId.',
      { campaignId: CampaignIdArg, jobId: Id.describe('Inbox sweep job id — from sweep_inbox') },
      async ({ campaignId, jobId }) => {
        // #1716 review: reading a sweep result is a poll, not a write, so archived campaigns
        // must still be allowed (same as the REST route).
        await this.access.requireRole(user, campaignId as number, 'dm', { allowArchived: true });
        return this.inboxSweep.getInboxSweepResult(campaignId as number, jobId as number);
      },
      false, // read-only
    );

    this.writeTool(
      server,
      user,
      'update_campaign_status',
      'DM only: update campaign state — status (active|paused|completed), current location, and/or campaign-wide ' +
        'danger level (a persistent tone/challenge backdrop, not a live threat state — see the `dangerLevel` arg). ' +
        '(sessionCount and latestSessionNumber are intentionally NOT settable here — they\'re denormalized ' +
        'stats auto-recomputed by add_session_recap/session delete/restore, not free-form fields.)',
      {
        campaignId: CampaignIdArg,
        status: z.enum(['active', 'paused', 'completed']).optional().describe('Campaign status'),
        currentLocationId: Id.nullable().optional().describe('Current location id (null to clear)'),
        dangerLevel: DangerLevel.optional().describe(
          'low | moderate | high | deadly — campaign-wide narrative tone/challenge backdrop, not a ' +
            'live threat state, encounter difficulty, or HP status (issue #871).',
        ),
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

    this.writeTool(
      server,
      user,
      'update_campaign',
      'DM only: general campaign update — name, description, ruleSystem (the installed rule-pack slug this campaign ' +
        'uses, or "" for none/homebrew), mapAttachmentId (a map attachment id, or null to clear), and/or the same ' +
        'status/currentLocationId/dangerLevel that update_campaign_status covers. On a paused/completed (archived, ' +
        'read-only) campaign only `status` may be changed — un-archive first to edit anything else. (sessionCount, ' +
        'latestSessionNumber, and storageQuotaBytes are intentionally NOT settable here.)',
      { campaignId: CampaignIdArg, ...CampaignUpdate.shape },
      async ({ campaignId, ...fields }) => {
        // allowArchived: CampaignsService.update() itself restricts an archived campaign to a
        // status-only patch, matching REST PATCH /campaigns/:id.
        await this.access.requireRole(user, campaignId as number, 'dm', { allowArchived: true });
        const validated = CampaignUpdate.parse(fields);
        if (Object.keys(validated).length === 0) {
          throw new BadRequestException('Pass at least one field to update');
        }
        return this.campaigns.update(campaignId as number, validated, user);
      },
    );

    this.writeTool(
      server,
      user,
      'approve_proposal',
      'DM only: approve a pending proposal — applies it through the normal service write path.',
      { proposalId: Id.describe('Proposal id'), note: z.string().max(1000).optional().describe('Resolution note') },
      async ({ proposalId, note }) => {
        const row = await this.proposals.getRowOrThrow(proposalId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.proposals.approve(proposalId as number, { note: note as string | undefined }, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'reject_proposal',
      'DM only: reject a pending proposal.',
      { proposalId: Id.describe('Proposal id'), note: z.string().max(1000).optional().describe('Resolution note') },
      async ({ proposalId, note }) => {
        const row = await this.proposals.getRowOrThrow(proposalId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.proposals.reject(proposalId as number, { note: note as string | undefined }, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'withdraw_proposal',
      'Withdraw YOUR OWN still-pending proposal before a DM reviews it (issue #124). Only the original proposer may ' +
        'withdraw; 403 otherwise, 409 if the DM already resolved it. No entity write is applied.',
      { proposalId: Id.describe('Proposal id') },
      async ({ proposalId }) => {
        const row = await this.proposals.getRowOrThrow(proposalId as number);
        // Member-level write: the archive read-only gate applies (issue #1480).
        const role = await this.access.requireMemberOnWritableCampaign(user, row.campaignId);
        return this.proposals.withdraw(proposalId as number, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'revise_proposal',
      'Revise YOUR OWN still-pending proposal\'s create/update payload before the DM acts (issue #124). Only the ' +
        'original proposer may revise; 403 otherwise, 409 if already resolved. Delete proposals cannot be revised.',
      { proposalId: Id.describe('Proposal id'), ...ProposalRevise.shape },
      async ({ proposalId, payload }) => {
        const row = await this.proposals.getRowOrThrow(proposalId as number);
        // Member-level write: the archive read-only gate applies (issue #1480).
        const role = await this.access.requireMemberOnWritableCampaign(user, row.campaignId);
        return this.proposals.revise(proposalId as number, { payload: payload as Record<string, unknown> }, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'batch_approve_proposals',
      'DM only: approve up to 100 pending proposals in one call. Each id is resolved independently — one failure ' +
        'does not abort the rest. Returns { results: [{ id, ok, ... }] }.',
      { ...ProposalBatchResolve.shape },
      async ({ ids, note }) => {
        const results = await this.proposals.resolveBatch(
          ids as number[],
          'approve',
          note as string | undefined,
          user,
          (campaignId) => this.access.requireRole(user, campaignId, 'dm'),
        );
        return { results };
      },
    );

    this.writeTool(
      server,
      user,
      'batch_reject_proposals',
      'DM only: reject up to 100 pending proposals in one call. No entity writes are applied. Returns per-id results.',
      { ...ProposalBatchResolve.shape },
      async ({ ids, note }) => {
        const results = await this.proposals.resolveBatch(
          ids as number[],
          'reject',
          note as string | undefined,
          user,
          (campaignId) => this.access.requireRole(user, campaignId, 'dm'),
        );
        return { results };
      },
    );

    this.writeTool(
      server,
      user,
      'set_notification_preferences',
      'Update the caller\'s notification preferences for one campaign (category delivery modes and/or quiet hours). ' +
        'Critical access/security categories stay always-on. 404 when not a member.',
      { campaignId: CampaignIdArg, ...NotificationPreferencesUpdate.shape },
      async ({ campaignId, ...fields }) => {
        const validated = NotificationPreferencesUpdate.parse(fields);
        return this.notifications.setPreferences(user, campaignId as number, validated);
      },
    );

    this.writeTool(
      server,
      user,
      'mark_notification_read',
      'Mark one of the caller\'s notifications read. Recipient only — 404 for anyone else. Idempotent.',
      { notificationId: Id.describe('Notification id — from list_notifications') },
      async ({ notificationId }) => this.notifications.markRead(notificationId as number, user),
    );

    this.writeTool(
      server,
      user,
      'mark_notification_unread',
      'Mark one of the caller\'s notifications unread. Recipient only — 404 for anyone else. Idempotent.',
      { notificationId: Id.describe('Notification id — from list_notifications') },
      async ({ notificationId }) => this.notifications.markUnread(notificationId as number, user),
    );

    this.writeTool(
      server,
      user,
      'mark_notifications_read',
      'Mark selected, campaign-scoped, or all of the caller\'s notifications read. At least one of ids, campaignId, ' +
        'or all:true is required.',
      BulkNotificationArgs,
      async ({ ids, campaignId, all }) => {
        const validated = BulkNotificationSchema.parse({ ids, campaignId, all });
        return this.notifications.markReadBulk(user, validated);
      },
    );

    this.writeTool(
      server,
      user,
      'mark_notifications_unread',
      'Mark selected, campaign-scoped, or all of the caller\'s notifications unread. At least one of ids, ' +
        'campaignId, or all:true is required.',
      BulkNotificationArgs,
      async ({ ids, campaignId, all }) => {
        const validated = BulkNotificationSchema.parse({ ids, campaignId, all });
        return this.notifications.markUnreadBulk(user, validated);
      },
    );

    this.writeTool(
      server,
      user,
      'mark_all_notifications_read',
      'Mark every notification owned by the caller read.',
      {},
      async () => this.notifications.markAllRead(user),
    );

    this.writeTool(
      server,
      user,
      'add_member',
      'DM only: add a campaign member by user id, with a role (dm|player|viewer) and optional linked characterId.',
      { campaignId: CampaignIdArg, ...MemberCreate.shape },
      async ({ campaignId, ...fields }) => {
        await this.access.requireRole(user, campaignId as number, 'dm');
        const validated = MemberCreate.parse(fields);
        return this.members.create(campaignId as number, validated, user);
      },
    );

    this.writeTool(
      server,
      user,
      'create_invite',
      'DM only: create a shareable invite link. Role is capped to player/viewer; the code always expires (default 7 ' +
        'days) and may be use-capped. Refused while public invites are suspended.',
      { campaignId: CampaignIdArg, ...InviteCreate.shape },
      async ({ campaignId, ...fields }) => {
        await this.access.requireRole(user, campaignId as number, 'dm');
        const validated = InviteCreate.parse(fields);
        return this.invites.create(campaignId as number, validated, user);
      },
    );

    this.writeTool(
      server,
      user,
      'revoke_invite',
      'DM only: revoke one invite link immediately. Existing members are unaffected. Allowed on archived campaigns.',
      { campaignId: CampaignIdArg, inviteId: Id.describe('Invite id — from list_invites') },
      async ({ campaignId, inviteId }) => {
        await this.access.requireRole(user, campaignId as number, 'dm', { allowArchived: true });
        await this.invites.revoke(campaignId as number, inviteId as number, user);
        return { ok: true, inviteId };
      },
    );

    this.writeTool(
      server,
      user,
      'revoke_all_invites',
      'DM only: permanently delete every invite row in a campaign (including expired history). Returns { revoked }.',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        await this.access.requireRole(user, campaignId as number, 'dm', { allowArchived: true });
        return this.invites.revokeAll(campaignId as number, user);
      },
    );

    this.writeTool(
      server,
      user,
      'set_invite_policy',
      'DM only: enable or disable the campaign public-invite policy. Disabling suspends every outstanding code without ' +
        'deleting rows; re-enabling is refused while archived or trashed.',
      { campaignId: CampaignIdArg, ...InvitePolicyUpdate.shape },
      async ({ campaignId, enabled }) => {
        await this.access.requireRole(user, campaignId as number, 'dm', { allowArchived: true });
        return this.invites.setPolicy(campaignId as number, enabled as boolean, user);
      },
    );

    this.writeTool(
      server,
      user,
      'join_invite',
      'Accept an invite as the current authenticated user — adds membership at the invite\'s role. 404 when invalid, ' +
        '409 when already a member.',
      { code: z.string().min(1).max(200).describe('Invite join code — from preview_invite or list_invites') },
      async ({ code }) => this.invites.join(code as string, user),
    );

    this.writeTool(
      server,
      user,
      'update_member',
      'DM only: update a campaign member\'s role and/or linked characterId. Cannot demote the campaign\'s last dm.',
      { campaignId: CampaignIdArg, memberId: Id.describe('Member id — from list_members'), ...MemberUpdate.shape },
      async ({ campaignId, memberId, ...fields }) => {
        await this.access.requireRole(user, campaignId as number, 'dm');
        const validated = MemberUpdate.parse(fields);
        return this.members.update(campaignId as number, memberId as number, validated, user);
      },
    );

    this.writeTool(
      server,
      user,
      'remove_member',
      'DM only: remove a campaign member. Cannot remove the campaign\'s last dm.',
      { campaignId: CampaignIdArg, memberId: Id.describe('Member id — from list_members') },
      async ({ campaignId, memberId }) => {
        await this.access.requireRole(user, campaignId as number, 'dm');
        await this.members.remove(campaignId as number, memberId as number, user);
        return { ok: true, memberId };
      },
    );

    this.writeTool(
      server,
      user,
      'repair_campaign_dm',
      'Server admin only: recover an orphaned campaign that currently has zero enabled DMs by assigning an existing ' +
        'enabled account as DM. Returns authority metadata only; it does not expose campaign secrets or grant the ' +
        'calling admin membership unless that admin is explicitly selected as userId.',
      { ...CampaignDmRepair.shape },
      async (fields) => {
        if (!hasServerAdminPower(user)) throw new ForbiddenException('Requires server admin');
        return this.users.repairCampaignDm(CampaignDmRepair.parse(fields), user);
      },
    );

    this.writeTool(
      server,
      user,
      'install_rule_pack',
      'Server admin only: install (or incrementally update) an open-content rule pack — spells, monsters, items, ' +
        'conditions, classes, races, feats and system-specific sections — so lookup_rule/get_rule_entry and ' +
        "add_combatant's ruleEntryId can find them. `source` selects the importer: 'open5e' (default), 'pf2e', " +
        "'pf1e', 'starfinder', 'archmage', 'open-legend', or 'osr' (pass `system` for the retroclone variant). " +
        'Sources without a verified live default API (pf1e/starfinder/archmage/osr) require an explicit `url`.',
      { ...RulePackInstall.shape },
      async ({ source, url, sections, system }) => {
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
          ...(system !== undefined ? { system } : {}),
        });
        // Dispatch by source (issue #345) — runs the matching importer, not a silent Open5e install.
        return this.rules.installFromSource(validated, user);
      },
    );

    this.writeTool(
      server,
      user,
      'uninstall_rule_pack',
      'Server admin only: uninstall an unused rule pack by id — removes the pack and ALL of its entries and nulls any ' +
        'combatant references. Packs selected by campaigns are blocked to avoid silently changing live rules. ' +
        'Ids come from list_rule_packs. Irreversible.',
      { packId: Id.describe('Rule pack id — from list_rule_packs') },
      async ({ packId }) => {
        // hasServerAdminPower(), not a raw serverRole check — same token-cap rationale as
        // install_rule_pack: a PAT minted for an admin must NOT carry server-wide power
        // unless it was explicitly minted with adminEnabled=true.
        if (!hasServerAdminPower(user)) {
          throw new ForbiddenException('Requires server admin');
        }
        await this.rules.uninstall(packId as number, user);
        return { ok: true, packId };
      },
    );

    this.writeTool(
      server,
      user,
      'roll_dice',
      'Roll a dice expression in the context of a campaign, e.g. "1d20+3", "2d6", or with keep/drop for ' +
        'advantage/disadvantage/stat-gen: "2d20kh1" (advantage), "2d20kl1" (disadvantage), "4d6dl1" (drop lowest). ' +
        'Optionally pass a label and dc to record a check (success = total >= dc). Any campaign member may use this; ' +
        'the roll is audited (action "dice.roll") and appears in the campaign-shared dice log.',
      {
        campaignId: CampaignIdArg,
        expr: RollRequest.shape.expr.describe('Dice expression: a sum of die terms (NdM) and modifiers, e.g. "1d20+3", "2d20kh1", or "1d20+1d4+3"'),
        label: RollRequest.shape.label.describe('Optional check label, e.g. "DEX save"'),
        dc: RollRequest.shape.dc.describe('Optional difficulty class; success is computed as total >= dc'),
      },
      async ({ campaignId, expr, label, dc }) => {
        const role = await this.access.requireMemberOnWritableCampaign(user, campaignId as number);
        return this.encounters.rollDiceForCampaign(
          campaignId as number,
          { expr: expr as string, label: label as string | undefined, dc: dc as number | undefined },
          user,
          role,
        );
      },
    );

    this.writeTool(
      server,
      user,
      'roll_action_dice',
      'Roll an adapter-native action dice pool for a campaign (Open Legend). Pass the native attribute score; ' +
        'the server resolves the campaign rule-system adapter, expands the score to an exploding pool, rolls with ' +
        'server crypto RNG, and records ONE campaign-shared dice-log event with pool, explosions, disadvantage, and total.',
      {
        campaignId: CampaignIdArg,
        score: ActionRollRequest.shape.score,
        attribute: ActionRollRequest.shape.attribute,
        label: ActionRollRequest.shape.label,
        dc: ActionRollRequest.shape.dc,
      },
      async ({ campaignId, score, attribute, label, dc }) => {
        const role = await this.access.requireMemberOnWritableCampaign(user, campaignId as number);
        return this.encounters.rollActionDiceForCampaign(
          campaignId as number,
          {
            score: score as number,
            attribute: attribute as string | undefined,
            label: label as string | undefined,
            dc: dc as number | undefined,
          },
          user,
          role,
        );
      },
    );

    // #1040: saving_throw — resolve a legacy d20 save server-side using the character's
    // real stats + proficiency, comparing the final total against a DC in one verifiable call.
    //
    // #1599: the modifier math is the CAMPAIGN'S rule-system adapter's own — ability
    // modifier and proficiency bonus alike — not a hardcoded 5e formula. 5e (and every
    // unaudited/homebrew system, via the adapter-agnostic default) still gets exactly the
    // same numbers as before; PF2e/SF2e now get a real (non-zero) proficiency bonus instead
    // of silently 5e's. See `checkProficiencyBonusForAdapter` (action-resolver.ts) for the
    // full reasoning, including why PF2e's answer is a "trained" floor rather than an exact
    // per-save rank (the character sheet does not track rank, only proficient/not). Outcome
    // classification is intentionally still the legacy d20 total-vs-DC boolean; callers that
    // need PF2e/SF2e degree-of-success or system-specific roll modes should use `roll_check`.
    this.writeTool(
      server,
      user,
      'saving_throw',
      'Roll a legacy d20 saving throw for a character using their actual stats + proficiency. ' +
        'Server reads the ability score, computes the modifier via the campaign\'s rule-system adapter, adds that adapter\'s ' +
        'proficiency bonus (0 for a system that has not implemented one — e.g. OSR, whose saves are a different shape ' +
        'entirely — never a silent guess) when the ability is in saveProficiencies, then rolls 1d20 (or 2d20kh1/kl1). ' +
        'The returned success boolean is only a legacy total >= DC comparison; it does not apply PF2e/SF2e degree-of-success ' +
        'or natural-1/natural-20 outcome shifts. Use roll_check for adapter-owned outcome classification. Returns ' +
        '{characterId, ability, dc, mode, score, abilityMod, profBonus, proficient, bonus, total, rolls, success, diceLogId}. ' +
        'Optionally set advantage="advantage"|"disadvantage" to use the legacy 2d20 keep-highest/lowest mode.',
      {
        characterId: Id.describe('Character id — from list_members or get_party'),
        ability: z.enum(['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']).describe('Save ability key'),
        dc: z.number().int().min(1).max(100).describe('Difficulty class to beat (1–100; homebrew/high-level effects may exceed typical PHB DCs)'),
        advantage: z.enum(['normal', 'advantage', 'disadvantage']).optional().describe('Roll mode; defaults to normal'),
      },
      async ({ characterId, ability, dc, advantage }) => {
        // Issue #1479: `requireMember(..., { write: true })` alone let any campaign
        // member roll a save as a character they did not own. `assertCharacterWritable`
        // is the shared seam (also used by the REST controller and `roll_check`) —
        // player-or-above membership AND dm-or-owner.
        const { row: character, role } = await this.characters.assertCharacterWritable(characterId as number, user);
        const abilityKey = ability as 'STR' | 'DEX' | 'CON' | 'INT' | 'WIS' | 'CHA';
        const dcNum = dc as number;
        const rollMode = (advantage as 'normal' | 'advantage' | 'disadvantage' | undefined) ?? 'normal';

        const campaign = await this.campaigns.getOrThrow(character.campaignId);
        const adapter = ruleSystemAdapter(campaign.ruleSystem);
        const resolved = resolveSavingThrow({
          stats: fromJsonText<Record<string, number>>(character.stats, {}),
          saveProficiencies: fromJsonText<string[]>(character.saveProficiencies, []),
          ability: abilityKey,
          level: character.level,
          adapter,
        });
        const { score, abilityMod, proficient, profBonus, bonus } = resolved;

        const diceExpr =
          rollMode === 'advantage'
            ? `2d20kh1${bonus >= 0 ? `+${bonus}` : bonus}`
            : rollMode === 'disadvantage'
              ? `2d20kl1${bonus >= 0 ? `+${bonus}` : bonus}`
              : `1d20${bonus >= 0 ? `+${bonus}` : bonus}`;

        const label = `${abilityKey} save (${proficient ? 'proficient' : 'unproficient'})`;
        const persisted = await this.encounters.rollDiceForCampaign(
          character.campaignId,
          { expr: diceExpr, label, dc: dcNum },
          user,
          role,
        );

        return {
          characterId: character.id,
          ability: abilityKey,
          dc: dcNum,
          mode: rollMode,
          score,
          abilityMod,
          profBonus,
          proficient,
          bonus,
          total: persisted.total,
          rolls: persisted.rolls,
          success: persisted.total >= dcNum,
          diceLogId: persisted.id,
        };
      },
    );

    // #415: list_checks — the adapter-owned roll catalog for a character. Every rollable
    // check (ability checks, skills incl. unproficient, saves, initiative) with an
    // authoritative modifier and a transparent breakdown, favorites first. This is the
    // same list the character sheet and encounter card render.
    this.tool(
      server,
      'list_checks',
      'List the rollable checks (roll catalog) for a character (issue #415): ability checks, skills (proficient AND ' +
        'unproficient), saves/defenses, and initiative — each with an authoritative modifier and a transparent ' +
        'breakdown, favorites (trained/proficient) first. The modifier math is the campaign rule system\'s, so it ' +
        'matches the character sheet and encounter card exactly. Use a returned `id` with roll_check to roll one.',
      {
        characterId: Id.describe('Character id — from list_members, get_party, or list_characters'),
      },
      async ({ characterId }) => {
        await this.characters.assertCharacterReadable(characterId as number, user);
        return this.characters.listChecks(characterId as number);
      },
    );

    // #415: roll_check — resolve + roll a catalog check server-side. The server computes the
    // modifier + dice expression from the rule-system adapter (the caller only names a
    // checkId + mode), rolls, records to the shared dice log with a transparent breakdown,
    // and returns the outcome (and PF2e degree of success when a DC is given). The dm or the
    // owning player may call this (issue #1479); the roll is audited and visible in the
    // campaign feed.
    this.writeTool(
      server,
      user,
      'roll_check',
      'Roll a check from a character\'s roll catalog (issue #415). Name a `checkId` from list_checks (e.g. ' +
        '"skill:Athletics", "save:DEX", "ability:STR", "initiative") and an optional roll `mode` and `dc`. The server ' +
        'resolves the authoritative modifier + dice expression from the campaign rule system (you do NOT send the math), ' +
        'rolls, records it to the shared dice log with a transparent breakdown label, and returns ' +
        '{check:{id,label,modifier,breakdown,breakdownText}, mode, roll, degree?}. `degree` (criticalFailure|failure|' +
        'success|criticalSuccess) is returned only for a system that reports degrees of success (PF2e) with a dc. ' +
        'advantage/disadvantage apply only where the system supports them. Optionally pass DM consequence text.',
      {
        characterId: Id.describe('Character id — from list_members, get_party, or list_characters'),
        checkId: CheckRollRequest.shape.checkId,
        mode: CheckRollRequest.shape.mode,
        dc: CheckRollRequest.shape.dc,
        consequence: CheckRollRequest.shape.consequence,
      },
      async ({ characterId, checkId, mode, dc, consequence }) => {
        // Issue #1479: `requireMember(..., { write: true })` alone let any campaign
        // member roll (and attach `consequence` text) as a character they did not own.
        // `assertCharacterWritable` is the shared seam (also used by the REST controller
        // and the `saving_throw` tool) — player-or-above membership AND dm-or-owner.
        const { role } = await this.characters.assertCharacterWritable(characterId as number, user);
        return this.characters.rollCheck(
          characterId as number,
          {
            checkId: checkId as string,
            mode: mode as 'normal' | 'advantage' | 'disadvantage' | 'crit',
            dc: dc as number | undefined,
            consequence: consequence as string | undefined,
          },
          user,
          role,
        );
      },
    );

    // #415: request_check — DM asks selected players to roll a check/save. Creates one pending
    // request per target character; each targeted player's client is nudged (thin real-time
    // signal) to read it back and roll once. The check must exist in each target's catalog.
    this.writeTool(
      server,
      user,
      'request_check',
      'DM only: request a check/save from one or more characters (issue #415). Name a `checkId` from list_checks ' +
        '(e.g. "save:DEX", "skill:Perception") and one or more `characterIds`, plus an optional `dc` and `consequence` ' +
        'text. One pending request is created per character; the targeted player rolls it once (over the app UI or ' +
        'resolve_check_request), which records the roll to the shared dice log and surfaces your consequence text. ' +
        'The check must exist in each target character\'s catalog.',
      {
        campaignId: CampaignIdArg,
        characterIds: CheckRequestCreate.shape.characterIds,
        checkId: CheckRequestCreate.shape.checkId,
        mode: CheckRequestCreate.shape.mode,
        dc: CheckRequestCreate.shape.dc,
        consequence: CheckRequestCreate.shape.consequence,
        encounterId: CheckRequestCreate.shape.encounterId,
      },
      async ({ campaignId, characterIds, checkId, mode, dc, consequence, encounterId }) => {
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        return this.characters.requestChecks(
          campaignId as number,
          {
            characterIds: characterIds as number[],
            checkId: checkId as string,
            mode: mode as 'normal' | 'advantage' | 'disadvantage' | 'crit',
            dc: dc as number | undefined,
            consequence: consequence as string | undefined,
            encounterId: encounterId as number | undefined,
          },
          user,
          role,
        );
      },
    );

    // #415: list_check_requests — the pending/resolved check requests visible to the caller. A DM
    // sees every request in the campaign; a player sees only requests for a character they own.
    this.tool(
      server,
      'list_check_requests',
      'List DM-initiated check requests visible to you (issue #415). The DM sees every request in the campaign; a ' +
        'player sees only requests targeting a character they own. Optional `status` filter (pending|resolved). Use a ' +
        'returned request id with resolve_check_request to roll it.',
      {
        campaignId: CampaignIdArg,
        status: z.enum(['pending', 'resolved']).optional().describe('Filter by request status'),
      },
      async ({ campaignId, status }) => {
        const role = await this.access.requireMember(user, campaignId as number);
        return this.characters.listCheckRequests(campaignId as number, user, role, {
          status: status as 'pending' | 'resolved' | undefined,
        });
      },
    );

    // #415: resolve_check_request — the targeted player (or the DM) answers a request by rolling
    // once. Reuses the catalog-roll path (shared dice log + audit + degree) and marks it resolved.
    this.writeTool(
      server,
      user,
      'resolve_check_request',
      'Answer a check request by rolling it ONCE (issue #415). The targeted player (owner of the character) or the DM ' +
        'passes the `requestId` (from list_check_requests); the server rolls the requested check, records it to the ' +
        'shared dice log with a transparent breakdown, returns {request, result:{check, mode, roll, degree?}}, and ' +
        'marks the request resolved. A request that was already answered is an error.',
      {
        requestId: Id.describe('Check request id — from list_check_requests'),
      },
      async ({ requestId }) => {
        const campaignId = await this.characters.campaignIdForCheckRequest(requestId as number);
        // Issue #1636: see characters.controller.ts's roll() — write:true does not assert
        // caller authority, and this reaches the identical resolveCheckRequest() path.
        const role = await this.access.requireRole(user, campaignId, 'player');
        return this.characters.resolveCheckRequest(requestId as number, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'create_encounter',
      'DM only: create a new encounter (combat tracker) in a campaign, status=preparing. Auto-adds every campaign ' +
        'character as a combatant with hp from their sheet and initiative modifier from DEX. Optionally attach it to a ' +
        'location/quest/session (issue #126) so combat is tied to where/why/when it happened. Omitting hidden ' +
        'defaults to DM-only prep (issue #754/#262): its roster + difficulty stay invisible to players until you reveal it. ' +
        'Pass hidden=false only for an intentional public create. To build a balanced fight automatically, call ' +
        'generate_encounter first (non-mutating preview), then create it here and add_combatant once per suggested line ' +
        'with its ruleEntryId + count.',
      {
        campaignId: CampaignIdArg,
        name: z.string().min(1).max(120).describe('Encounter name'),
        locationId: Id.optional().describe('Attach the encounter to a location (where it happens)'),
        questId: Id.optional().describe('Attach the encounter to a quest (why it happens)'),
        sessionId: Id.optional().describe('Attach the encounter to a session (when it happens)'),
        hidden: z.boolean().optional().describe('Omit or true = DM-only prep (default, #754); false = visible to players immediately'),
      },
      async ({ campaignId, name, locationId, questId, sessionId, hidden }) => {
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        return this.encounters.create(
          campaignId as number,
          { name: name as string, locationId: locationId as number | undefined, questId: questId as number | undefined, sessionId: sessionId as number | undefined, hidden: hidden as boolean | undefined },
          user,
          role,
        );
      },
    );

    this.writeTool(
      server,
      user,
      'update_encounter',
      'DM only: edit an encounter\'s name, its location/quest/session links (issue #126), and/or its battle map ' +
        '(issue #39: mapAttachmentId = an uploaded image attachment id, kind map|image, rendered as the run-session ' +
        'background; combatant token positions are set with update_combatant tokenX/tokenY, 0–100). Toggle hidden to ' +
        'hide/reveal the encounter as DM-only prep (issue #262: hidden=true withholds its roster + difficulty from ' +
        'players; hidden=false reveals it). Pass null to clear a link or the map; omit a field to leave it unchanged. ' +
        'Pass expectedUpdatedAt (the updatedAt you last read for this encounter) to opt into optimistic concurrency ' +
        '(issue #532): a stale value 409s rather than silently clobbering a co-DM\'s fresher edit.',
      { encounterId: Id.describe('Encounter id — from list_encounters'), expectedUpdatedAt: ExpectedUpdatedAt, ...EncounterUpdate.shape },
      async ({ encounterId, expectedUpdatedAt, ...fields }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        const validated = EncounterUpdate.parse(fields);
        return this.encounters.updateEncounter(encounterId as number, validated, user, role, {
          expectedUpdatedAt: expectedUpdatedAt as string | undefined,
        });
      },
    );

    this.writeTool(
      server,
      user,
      'reveal_map_region',
      'DM only: reveal a rectangular region of an encounter\'s battle-map fog of war (issue #40) ' +
        'so players can see it. Enables fog on the encounter if it isn\'t already, and appends the ' +
        'rectangle to the revealed area (call repeatedly to light the board as the party explores). ' +
        'Coordinates are 0–100 percent of the map surface: x/y = the top-left corner, w/h = width/' +
        'height. Player clients only ever receive combatant token positions that lie INSIDE a ' +
        'revealed region — tokens in the dark are withheld server-side — so this is how an AI DM ' +
        'controls what the table can see. To hide the map again or reset the mask, use update_encounter ' +
        'with fog ({enabled,revealed:[]} or null). Move tokens with update_combatant tokenX/tokenY.',
      {
        encounterId: Id.describe('Encounter id — from list_encounters'),
        x: z.number().min(0).max(100).describe('Left edge of the revealed rectangle, 0–100 percent of map width'),
        y: z.number().min(0).max(100).describe('Top edge of the revealed rectangle, 0–100 percent of map height'),
        w: z.number().min(0).max(100).describe('Width of the revealed rectangle, 0–100 percent of map width'),
        h: z.number().min(0).max(100).describe('Height of the revealed rectangle, 0–100 percent of map height'),
      },
      async ({ encounterId, x, y, w, h }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.encounters.revealFogRegion(
          encounterId as number,
          { x: x as number, y: y as number, w: w as number, h: h as number },
          user,
          role,
        );
      },
    );

    this.writeTool(
      server,
      user,
      'generate_map',
      'DM only: procedurally GENERATE a battle map server-side (issue #306) and save it as a hidden attachment ' +
        '(kind=map). Deterministic + offline + license-clean — no external calls. kind: "dungeon" (room-and-corridor), ' +
        '"cave" (organic cavern), or "wilderness" (open ground with terrain). size: small|medium|large. Pass a `seed` ' +
        'to reproduce a map exactly; omit it and the server picks one and returns it. Optional complexity (0–1), theme, ' +
        'gridScale/gridUnit (real-world cell size, default 5 ft). Pass encounterId to ALSO set the generated map as ' +
        'that encounter\'s battle map with an aligned grid, in one call. The attachment defaults HIDDEN (DM-only) so a ' +
        'prepped map never auto-reveals to players (#97/#259) — reveal it deliberately when the party arrives. Returns ' +
        '{ attachmentId, seed, gridConfig, kind, widthCells, heightCells, roomCount }; fetch the image via GET /attachments/:id/file.',
      {
        campaignId: CampaignIdArg,
        encounterId: Id.optional().describe('Optional: also attach the generated map to this encounter and align its grid (must be in the same campaign)'),
        ...GenerateMapParams.shape,
      },
      async ({ campaignId, encounterId, ...fields }) => {
        const params = GenerateMapParams.parse(fields);
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        if (encounterId !== undefined) {
          const row = await this.encounters.getRowOrThrow(encounterId as number);
          if (row.campaignId !== (campaignId as number)) {
            throw new BadRequestException(`Encounter ${encounterId} is not in campaign ${campaignId}`);
          }
          return this.maps.generateForEncounter(encounterId as number, campaignId as number, params, user, role);
        }
        return this.maps.generateForCampaign(campaignId as number, params, user, role);
      },
    );

    // ── genuine AI map generation (issue #410) ──────────────────────────────────
    this.writeTool(
      server,
      user,
      'generate_ai_map',
      'DM only: generate battle-map / concept-art CANDIDATES from a free-form brief using the configured AI provider ' +
        '(issue #410). Routes HONESTLY: an image-capable provider (OpenAI-compatible) draws a real image; a text-only ' +
        'provider (Anthropic) instead produces a blueprint that Campfire\'s own procedural renderer draws (labeled as ' +
        'such — never claimed to be AI-drawn); with no capable provider it returns external-generator instructions. ' +
        'Previews live in memory only — NOTHING is persisted until you call attach_generated_map, so cancelling leaves ' +
        'no orphan files. `count` (1–4) previews. `mode`: "battle-map" (grid) or "concept-art". Campaign secrets are ' +
        'NOT sent to the provider unless includeCampaignSecrets:true. Returns the job { id, status, method, previews[], ' +
        'cost, moderation }; poll get_map_generation and then attach_generated_map to keep one.',
      {
        campaignId: CampaignIdArg,
        idempotencyKey: z.string().max(120).optional().describe('Optional idempotency key — a retry with the same key returns the same job'),
        ...AiMapGenerationRequest.shape,
      },
      async ({ campaignId, idempotencyKey, ...fields }) => {
        const request = AiMapGenerationRequest.parse(fields);
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        return this.aiMap.createJob(campaignId as number, request, user, role, {
          idempotencyKey: idempotencyKey as string | undefined,
          caller: 'co-dm',
        });
      },
    );

    this.tool(
      server,
      'get_map_generation',
      'DM only: fetch the status/progress/previews of an AI map generation job (issue #410). Pass the campaignId and ' +
        'the jobId returned by generate_ai_map / refine_ai_map.',
      {
        campaignId: CampaignIdArg,
        jobId: z.string().min(1).max(80).describe('AI map job id from generate_ai_map'),
      },
      async ({ campaignId, jobId }) => {
        await this.access.requireRole(user, campaignId as number, 'dm');
        return this.aiMap.getJob(jobId as string, campaignId as number);
      },
    );

    this.writeTool(
      server,
      user,
      'refine_ai_map',
      'DM only: refine an existing AI map job (issue #410) — tweak the prompt/chips (or reuse a chosen preview\'s seed ' +
        'for continuity) and regenerate a fresh set of candidates. Returns the new job. Like generate_ai_map, nothing ' +
        'is persisted until attach_generated_map.',
      {
        campaignId: CampaignIdArg,
        jobId: z.string().min(1).max(80).describe('The job to refine (from generate_ai_map)'),
        ...AiMapRefineRequest.shape,
      },
      async ({ campaignId, jobId, ...fields }) => {
        const refine = AiMapRefineRequest.parse(fields);
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        return this.aiMap.refine(campaignId as number, jobId as string, refine, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'attach_generated_map',
      'DM only: persist a chosen AI-generated candidate as a HIDDEN (DM-only) map attachment (issue #410) and, when ' +
        'encounterId is set, link it as that encounter\'s battle map with an aligned grid. This is the reveal/replace ' +
        'path a DM controls — the autonomous driver seat is NOT permitted to reveal/replace a live map. Prompt, ' +
        'provider/model, seed/params, dimensions, provenance, moderation, and cost are stamped into the attachment ' +
        'audit record. Returns { attachment, result, provenance }. The map stays DM-hidden until you reveal it.',
      {
        campaignId: CampaignIdArg,
        jobId: z.string().min(1).max(80).describe('The succeeded job to attach a preview from'),
        ...AttachGeneratedMapRequest.shape,
      },
      async ({ campaignId, jobId, ...fields }) => {
        const body = AttachGeneratedMapRequest.parse(fields);
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        // A DM invoking this tool directly is authorized to reveal/replace a live map. The
        // driver seat never reaches here: attach_generated_map is absent from its allow-list.
        return this.aiMap.attach(campaignId as number, jobId as string, body, user, role, { allowLiveReplace: true });
      },
    );

    this.writeTool(
      server,
      user,
      'add_combatant',
      '`kind` ("character"|"monster"|"npc") is required. DM only: add a combatant to an encounter. Pass ruleEntryId (a ' +
        'monster statblock id from lookup_rule/get_rule_entry) to pull name/hp/DEX-derived initMod from the ' +
        'compendium, or characterId to pull from a character sheet, when name/hpMax/initMod are omitted. For kind="npc" ' +
        'pass npcId to link a campaign NPC (its name is used); give hpMax or a ruleEntryId statblock for its HP. Pass ' +
        '`count` (>1) to add several distinguishable copies at once, auto-suffixed "Goblin 1".."Goblin N". Optional `tokenSize` controls the token footprint.',
      {
        encounterId: Id.describe('Encounter id — from list_encounters'),
        ...CombatantCreate.shape,
        // Same constraints as CombatantCreate (Id, optional) but described for tools/list.
        characterId: Id.optional().describe('Character id — links a party member and pulls name/hp/initMod from their sheet when omitted'),
        npcId: Id.optional().describe('NPC id (kind="npc") — links a campaign NPC as the combatant identity; its name is used when name is omitted'),
        ruleEntryId: Id.optional().describe('Monster statblock rule entry id — from lookup_rule/get_rule_entry'),
        count: z.number().int().min(1).max(50).optional().describe('Add this many copies at once (monsters), names auto-suffixed 1..N so duplicates are distinguishable'),
      },
      async ({ encounterId, ...fields }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        const validated = CombatantCreate.parse(fields);
        return this.encounters.addCombatant(encounterId as number, validated, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'update_combatant',
      'Update a combatant mid-fight: hpDelta (relative) or hpSet (absolute, exclusive with hpDelta), hpTemp ' +
        '(temp-HP pool, absorbs damage first), deathSaveSuccesses/deathSaveFailures (0–3; 3 failures = dead, 3 ' +
        'successes = stable). Use roll_death_save for a server-authoritative d20. ' +
        'Structured conditions are PREFERRED over flat string labels: use addConditionInstance, removeConditionInstanceId, ' +
        'updateConditionInstance, or conditionInstances. A ConditionInstance supports { name, durationRounds, ' +
        'roundsRemaining, saveDc, saveAbility, isConcentration, source, sourceCombatantId, ruleEntryId, stacks }. ' +
        'Legacy addConditions/removeConditions flat strings are still supported. ' +
        'actorId (optional): the combatant who dealt the damage/heal/death, used to attribute the combat-log ' +
        'entry ("Ember hit Goblin 3 for 8"); omit to fall back to the current-turn combatant, or pass null to ' +
        'suppress attribution entirely (legacy target-only phrasing). DM-only ' +
        'fields: initiative, and the identity edits name / hpMax / initMod (rename a duplicate, fix a mistyped stat). ' +
        'Battle-map token position tokenX/tokenY (0–100 percent overlay, clamped) moves the combatant\'s token on the ' +
        'encounter map. DM may modify any combatant; a player may only touch hp/temp-hp/death-saves/conditions/token ' +
        'on a combatant linked to a character they own.',
      {
        encounterId: Id.describe('Encounter id'),
        combatantId: Id.describe('Combatant id — from get_encounter'),
        expectedUpdatedAt: ExpectedUpdatedAt,
        ...CombatantUpdate.shape,
        deathSaveRoll: z.number().optional().describe('Removed: use roll_death_save instead'),
      },
      async ({ encounterId, combatantId, deathSaveRoll, expectedUpdatedAt, ...fields }) => {
        if (deathSaveRoll !== undefined) {
          throw new BadRequestException({
            code: 'validation_failed',
            message: 'deathSaveRoll is removed; use roll_death_save instead',
            errors: [
              {
                field: 'deathSaveRoll',
                message: 'deathSaveRoll is removed; use roll_death_save instead',
              },
            ],
          });
        }
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'player');
        const validated = CombatantUpdate.parse(fields);
        return this.encounters.updateCombatant(
          encounterId as number,
          combatantId as number,
          { ...validated, expectedUpdatedAt: expectedUpdatedAt as string | undefined },
          user,
          role,
        );
      },
    );

    // Issue #1909: the delta-based, transactional counterpart to update_combatant's
    // `statblock` field above — flipping one Ki pip or one spell-slot checkbox no longer
    // requires this tool (or a human via REST) to resend the ENTIRE statblock/character
    // JSON, which raced last-writer-wins against a second writer (another DM tab, a
    // concurrent MCP call) and silently reverted their unrelated edits.
    this.writeTool(
      server,
      user,
      'adjust_combatant_resource',
      'Spend or restore ONE bounded resource or spell-slot level on a combatant mid-fight — a character-linked ' +
        'combatant OR a monster/NPC combatant with an inline statblock. Exactly one of `key` (feature resource) or ' +
        '`spellLevel` (1-9); `delta` is relative to the resource\'s current `used` (default +1). `key` must name a ' +
        'resource that ALREADY exists on the combatant/character (from get_encounter/get_character) — an unknown ' +
        'key FAILS with a 400 naming it rather than silently creating a new one, the same as an out-of-range ' +
        '`spellLevel`. Spending past 0 or restoring past `max` FAILS with a 400 — never a silent clamp — so success ' +
        'can be trusted as "the resource was actually spent/restored." dm may adjust any combatant; a player only a ' +
        'combatant linked to a character they own; a statblock combatant (no linked character) is dm-only, ' +
        'matching update_combatant\'s statblock rule. Records a resource_changed encounter event. `idempotencyKey`: ' +
        'a lost-response retry with the SAME key replays the original outcome instead of double-spending. Returns ' +
        'the combatant: for a statblock combatant this shows the new value directly (the statblock lives on the ' +
        'combatant); for a character-linked combatant the resource lives on the CHARACTER sheet instead, so this ' +
        'response does not show the new value — call get_character separately to confirm it.',
      // CombatantResourceAdjust is a ZodEffects (.superRefine requiring exactly one of
      // key|spellLevel), so it has no `.shape` to spread — list the wire fields here and
      // re-validate with .parse below, matching adjust_character_condition_level's pattern.
      {
        encounterId: Id.describe('Encounter id'),
        combatantId: Id.describe('Combatant id — from get_encounter'),
        key: z.string().min(1).max(80).optional().describe('Feature resource key (exactly one of key or spellLevel required)'),
        spellLevel: z.number().int().min(1).max(9).optional().describe('Spell slot level 1-9 (exactly one of key or spellLevel required)'),
        delta: z.number().int().optional().describe('Relative to current used; +1 spends, -1 restores (default +1)'),
        expectedUsed: z.number().int().min(0).optional().describe(
          'Optional per-resource CAS guard: the `used` value get_encounter/get_character last showed for this ' +
            'resource. If another writer changed it since, the request 409s instead of silently applying delta on ' +
            'top of the new value. Omit for a purely relative intent (e.g. "restore 2 charges") with no rendered baseline.',
        ),
        idempotencyKey: IdempotencyKey.describe('Client-minted intent key; reuse for retries of this exact spend/restore'),
      },
      async ({ encounterId, combatantId, ...fields }) => {
        // Same-key retries replay a stored response without writing, even after the
        // encounter is trashed; the service still rejects a fresh key transactionally.
        const row = await this.encounters.getRowOrThrow(encounterId as number, true);
        // Issue #1909 review (Devin): mirror roll_combatant_initiative's own viewer-role
        // visibility pre-check just below — `requireRole(..., 'player')` alone throws 403
        // for a viewer BEFORE the service's own `isVisibleTo` gate is ever reached, so a
        // viewer hitting a HIDDEN encounter's real id would get 403, distinguishable from
        // the 404 a nonexistent id gets (an enumeration oracle). Pre-check at the VIEWER
        // floor first so a hidden encounter is 404 for every non-DM.
        //
        // Issue #1909 review round 2 (Codex): `allowArchived: true` on both this check and
        // the role gate below — without it, `requireRole(..., 'viewer')` 403'd EVERY member
        // on a paused/completed campaign before `isVisibleTo` ever ran, reopening the same
        // oracle keyed on campaign archival instead of role. The service's own
        // `assertCampaignWritableInTx` still rejects a fresh write against an archived
        // campaign; see the REST controller's identical fix for the full rationale.
        if (
          !isVisibleTo(
            { hidden: row.hidden },
            await this.access.requireRole(user, row.campaignId, 'viewer', { allowArchived: true }),
          )
        ) {
          throw new NotFoundException(`Encounter ${encounterId} not found`);
        }
        const role = await this.access.requireRole(user, row.campaignId, 'player', { allowArchived: true });
        const validated = CombatantResourceAdjust.parse(fields);
        return this.encounters.adjustCombatantResource(encounterId as number, combatantId as number, validated, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'roll_death_save',
      'Roll exactly one server-authoritative d20 for a dying character combatant. The same face drives the 5e death-save outcome and one shared dice-log entry; callers cannot choose the result. Reuse idempotencyKey after a lost response to replay that exact outcome.',
      {
        encounterId: Id.describe('Encounter id'),
        combatantId: Id.describe('Dying character combatant id — from get_encounter'),
        idempotencyKey: IdempotencyKey.unwrap().describe('Client-minted action intent key; reuse for retries of this roll'),
      },
      async ({ encounterId, combatantId, idempotencyKey }) => {
        // Same-key retries replay a stored response without writing, even after the
        // encounter is trashed; the service still rejects a fresh key transactionally.
        const row = await this.encounters.getRowOrThrow(encounterId as number, true);
        const role = await this.access.requireRole(user, row.campaignId, 'player', { allowArchived: true });
        return this.encounters.rollDeathSave(encounterId as number, combatantId as number, idempotencyKey as string, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'roll_combatant_initiative',
      'Roll server-authoritative initiative for ONE combatant. The DM may roll any combatant; a player may roll only a combatant linked to a character they own (everyone else 403s). Writes the roll + breakdown and records one shared dice-log entry (skipped for a hidden encounter). 409 if initiative is already set unless overwrite:true (DM only). 400 for a group-initiative rule system — a side shares one roll; use roll_initiative instead. Reuse idempotencyKey after a lost response to replay that exact outcome.',
      {
        encounterId: Id.describe('Encounter id'),
        combatantId: Id.describe('Combatant id — from get_encounter'),
        idempotencyKey: IdempotencyKey.unwrap().describe('Client-minted action intent key; reuse for retries of this roll'),
        overwrite: z.boolean().optional().describe('DM only: re-roll a combatant that already has initiative set'),
      },
      async ({ encounterId, combatantId, idempotencyKey, overwrite }) => {
        // Same-key retries replay a stored response without writing, even after the
        // encounter is trashed; the service still rejects a fresh key transactionally.
        const row = await this.encounters.getRowOrThrow(encounterId as number, true);
        // Issue #1904 review finding: mirror the REST handler's viewer-role visibility
        // pre-check (POST .../roll-initiative in encounters.controller.ts) so a viewer
        // hitting a HIDDEN encounter's id gets the same 404 a nonexistent id gets. Without
        // this, a viewer-role caller falls straight into the stricter 'player' role gate
        // below and gets 403 instead — distinguishable from a real 404, which leaks that
        // the hidden encounter exists (hidden entities must be indistinguishable from
        // nonexistent for a non-DM).
        if (
          !isVisibleTo(
            { hidden: row.hidden },
            await this.access.requireRole(user, row.campaignId, 'viewer', { allowArchived: true }),
          )
        ) {
          throw new NotFoundException(`Encounter ${encounterId} not found`);
        }
        const role = await this.access.requireRole(user, row.campaignId, 'player', { allowArchived: true });
        return this.encounters.rollCombatantInitiative(
          encounterId as number,
          combatantId as number,
          idempotencyKey as string,
          overwrite as boolean | undefined,
          user,
          role,
        );
      },
    );

    this.writeTool(
      server,
      user,
      'remove_combatant',
      'DM only: remove a combatant from an encounter. Returns a server-issued { undoToken, encounterId, combatantId }; the one-use token is valid for 30 seconds. Supply an idempotencyKey and reuse it after a lost response to replay that receipt.',
      { encounterId: Id.describe('Encounter id'), combatantId: Id.describe('Combatant id — from get_encounter'), ...CombatantRemoveRequest.shape },
      async ({ encounterId, combatantId, idempotencyKey }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number, true);
        const role = await this.access.requireRole(user, row.campaignId, 'dm', { allowArchived: true });
        return this.encounters.removeCombatant(encounterId as number, combatantId as number, user, role, idempotencyKey as string | undefined);
      },
    );

    this.writeTool(
      server,
      user,
      'undo_remove_combatant',
      'DM only: restore a combatant using its short-lived one-use undoToken. A same-token retry after a lost success response replays the restored combatant.',
      { encounterId: Id.describe('Encounter id'), ...CombatantRemoveUndo.shape },
      async ({ encounterId, undoToken }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number, true);
        const role = await this.access.requireRole(user, row.campaignId, 'dm', { allowArchived: true });
        return this.encounters.undoRemoveCombatant(encounterId as number, undoToken as string, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'roll_initiative',
      'DM only: roll d20+initMod for every combatant in an encounter that does not already have an initiative set.',
      { encounterId: Id.describe('Encounter id') },
      async ({ encounterId }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.encounters.rollInitiative(encounterId as number, user, role);
      },
    );

    this.writeTool(
      server,
      user,
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

    this.writeTool(
      server,
      user,
      'next_turn',
      'DM only: advance an encounter to the next combatant’s turn, wrapping to the next round when past the last combatant. ' +
        'Issue #580 — pass idempotencyKey (a stable id minted once for this ONE advance, reused verbatim on every retry) so ' +
        'retrying after a timeout replays the original result instead of advancing twice, and expectedCurrentCombatantId ' +
        '(the combatant you believe holds the turn) so a 409 tells you a human already advanced rather than silently ' +
        'skipping that combatant’s turn.',
      { encounterId: Id.describe('Encounter id'), ...EncounterNextTurn.shape },
      async ({ encounterId, ...body }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.encounters.nextTurn(encounterId as number, body as EncounterNextTurn, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'set_escalation_die',
      'DM only: for 13th Age encounters, hold automatic escalation and/or set/clear the escalation die override (0–6). ' +
        'Pass override=null to clear an override; pass held=false to resume automatic round defaults.',
      {
        encounterId: Id.describe('Encounter id'),
        held: z.boolean().optional().describe('When true, automatic round advancement keeps the current escalation value'),
        override: z.number().int().min(0).max(6).nullable().optional().describe('Set a DM override value, or null to clear it'),
      },
      async ({ encounterId, held, override }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.encounters.updateEscalationDie(
          encounterId as number,
          { held: held as boolean | undefined, override: override as number | null | undefined },
          user,
          role,
        );
      },
    );

    this.writeTool(
      server,
      user,
      'end_turn',
      'End the CURRENT combatant\'s turn (issue #413). The DM may always end it; a player may end the turn of their ' +
        'OWN active character when the campaign allows player advancement (dmControlsTurns=false). The server validates ' +
        'ownership + that it is actually that combatant\'s turn, serializes advancement, resolves start/end-of-turn ' +
        'effects. Pass idempotencyKey (a stable id minted once for this ONE advance, reused verbatim on every retry) so ' +
        'retrying after a timeout replays the original result instead of advancing twice. ' +
        'It also guards against double-advance: pass expectedCurrentCombatantId (the combatant you believe is ' +
        'acting) and a 409 is returned if the turn already moved on. When the campaign requires DM confirmation a ' +
        'player end-turn is staged (409); the DM then advances it directly (a DM end-turn / next-turn is the confirmation).',
      { encounterId: Id.describe('Encounter id'), ...EncounterEndTurn.shape },
      async ({ encounterId, ...body }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'player');
        return this.encounters.endTurn(encounterId as number, body as EncounterEndTurn, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'undo_turn',
      'DM only: undo the last turn advance (issue #413) — step the turn pointer BACKWARD, decrementing the round when ' +
        'unwrapping past the top. Timed conditions and active effects ticked while advancing are restored automatically.',
      { encounterId: Id.describe('Encounter id') },
      async ({ encounterId }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.encounters.undoTurn(encounterId as number, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'set_turn_state',
      'Declare / resolve the current turn\'s action economy and effects on a combatant (issue #413): useSlot / ' +
        'releaseSlot / setSlotUsed against an adapter action-economy slot key (get_turn lists them), moveFt (spend ' +
        'movement) or resetMovement, concentration (set/clear what the combatant concentrates on), addEffect / ' +
        'removeEffectId for a structured active effect (duration + save timing), delaying / readied for the turn-order ' +
        'tools, and resetTurn to clear the per-turn slice. The DM may edit any combatant; a player only a combatant ' +
        'linked to a character they own.',
      { encounterId: Id.describe('Encounter id'), combatantId: Id.describe('Combatant id — from get_encounter'), ...CombatantTurnStatePatch.shape },
      async ({ encounterId, combatantId, ...fields }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'player');
        const validated = CombatantTurnStatePatch.parse(fields);
        return this.encounters.updateCombatantTurnState(encounterId as number, combatantId as number, validated, user, role);
      },
    );

    // ---------- structured action resolver (issue #414) ----------

    this.writeTool(
      server,
      user,
      'resolve_action',
      'Resolve a structured action (issue #414): roll the attack or the targets\' saves with the correct modifiers, ' +
        'compare vs AC / DC, classify the outcome (5e hit/miss/crit or PF2e degrees), and return a per-target PREVIEW ' +
        'with player-safe text separated from DM-only mechanics. Identify the action by actionName/actionIndex on the ' +
        'actor\'s sheet (see list_usable_actions) OR pass an inline `spec` for a monster / ad-hoc action. A player may ' +
        'resolve only their OWN active character\'s action (a monster/NPC action is DM-only) but may target anyone — so a ' +
        'player can finish an attack against a monster end-to-end. Pass commit:true to apply atomically in the same ' +
        'call when the campaign policy permits (automatic); otherwise the result is a declaration the DM applies via ' +
        'apply_action (dm-confirmed / player-declares). An unsupported action shape is refused (fall back to its ' +
        'statblock). Returns { resolution, applied, canApply, policy, undoToken, systemMathSupported, mathProfile }. ' +
        '`systemMathSupported` is false whenever this campaign\'s system has NOT been audited end-to-end against the ' +
        'resolver\'s maths — it does NOT mean 5e math was necessarily used. Some adapters (OSR, Open Legend) supply ' +
        'their own `resolveAttack` (descending-AC comparison, exploding dice pools) and are still reported unsupported ' +
        'because the combined attack/save profile is unaudited. Read `mathProfile` for what actually ran: it names the ' +
        'audited profile when one is in force, and is null otherwise. Only when it names the 5e profile are the d20 ' +
        'roll, ascending-AC comparison and proficiency bonus below the 5e-shaped ones; ' +
        '`systemMathSupported` is true only when the campaign\'s rule system is 5e or an empty/unrecognized slug ' +
        '(the same 5e fallback combat math already uses) — false for a registered non-5e system (PF2e, OSR, …) that ' +
        'has not been audited against this maths (issue #1928, label don\'t block: resolution still runs and, under ' +
        '`commit:true`, still applies — the flag only marks the system UNAUDITED end-to-end, and does NOT tell you ' +
        'which maths ran). `mathProfile` names the audited profile in force, or null when unsupported — read it, not ' +
        'the flag, to learn what actually executed.',
      { encounterId: Id.describe('Encounter id'), ...ActionResolveRequest.shape },
      async ({ encounterId, ...fields }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        // Issue #1450: write:true only asserts the campaign is writable, not caller
        // authority — MCP reaches the same resolve() path as the REST route, so it needs
        // the same requireRole('player') gate (a viewer must not resolve combat actions).
        const role = await this.access.requireRole(user, row.campaignId, 'player');
        const validated = ActionResolveRequest.parse(fields);
        return this.actionResolver.resolve(encounterId as number, validated, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'apply_action',
      'Apply a resolved action chain (issue #414 confirm path): pass the `chainId` returned by resolve_action — a ' +
        'LOOKUP KEY only (issue #1451). The server re-reads the exact resolution it computed and persisted at resolve ' +
        'time, so a caller cannot inflate damage, alter a per-target delta, or inject a condition/effect never in the ' +
        'resolved spec. The DM may apply any resolution; a player only their own active character\'s action under an ' +
        'automatic policy. Returns an undo token that reverses the whole apply. Under collaborative handoff this call ' +
        'may be queued for DM confirmation; the confirmation prompt describes it from the server\'s own persisted ' +
        'resolution, never from anything this call passes.',
      { encounterId: Id.describe('Encounter id'), ...ActionApplyRequest.shape },
      async ({ encounterId, ...fields }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        // Issue #1450: see resolve_action — write:true does not assert caller authority.
        const role = await this.access.requireRole(user, row.campaignId, 'player');
        const validated = ActionApplyRequest.parse(fields);
        return this.actionResolver.apply(encounterId as number, validated, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'undo_action',
      'Undo an applied action resolution (issue #414): pass back the undoToken from resolve_action/apply_action to ' +
        'restore every target\'s HP / temp HP / death state / conditions to the pre-apply snapshot, remove the effects ' +
        'the apply added, and refund the actor\'s action-economy slot, spell slot, and concentration. The DM may undo ' +
        'any action; a player only one whose actor is their own character.',
      { ...ActionUndoToken.shape },
      async ({ ...fields }) => {
        const validated = ActionUndoToken.parse(fields);
        const row = await this.encounters.getRowOrThrow(validated.encounterId);
        // Issue #1450: see resolve_action — write:true does not assert caller authority.
        const role = await this.access.requireRole(user, row.campaignId, 'player');
        return this.actionResolver.undo(validated.encounterId, validated, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'end_encounter',
      'DM only: end an encounter and write every character combatant’s current hp back onto their character record.',
      { encounterId: Id.describe('Encounter id') },
      async ({ encounterId }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.encounters.end(encounterId as number, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'reopen_encounter',
      'DM only: reopen an ended encounter back to running, preserving round/turn state. When character sheets advanced ' +
        'after End, pass hpResync decisions for each conflict from GET (issue #466).',
      { encounterId: Id.describe('Encounter id'), ...EncounterReopen.shape },
      async ({ encounterId, hpResync }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        const body = EncounterReopen.parse(hpResync !== undefined ? { hpResync } : {});
        return this.encounters.reopen(encounterId as number, user, role, body);
      },
    );

    this.writeTool(
      server,
      user,
      'delete_encounter',
      'DM only: permanently delete an encounter (combat tracker) and all of its combatants. Irreversible. Does NOT ' +
        'write combatant hp back to characters — use end_encounter first if you want the fight\'s damage to persist.',
      { encounterId: Id.describe('Encounter id — from list_encounters') },
      async ({ encounterId }) => {
        const row = await this.encounters.getRowOrThrow(encounterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        await this.encounters.remove(encounterId as number, user, role);
        return { ok: true, encounterId };
      },
    );

    this.tool(
      server,
      'list_campaign_library_monsters',
      'List homebrew monsters saved in a campaign library for reuse (issue #425).',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        await this.access.requireMember(user, campaignId as number);
        return this.campaignLibrary.listForCampaign(campaignId as number);
      },
    );

    this.writeTool(
      server,
      user,
      'create_campaign_library_monster',
      'DM only: save a homebrew monster statblock to the campaign library (issue #425).',
      { campaignId: CampaignIdArg, ...CampaignLibraryMonsterCreate.shape },
      async ({ campaignId, ...fields }) => {
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        return this.campaignLibrary.create(campaignId as number, CampaignLibraryMonsterCreate.parse(fields), user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'update_campaign_library_monster',
      'DM only: update a saved campaign-library monster (issue #425).',
      { libraryMonsterId: Id.describe('Library monster id'), ...CampaignLibraryMonsterUpdate.shape },
      async ({ libraryMonsterId, ...fields }) => {
        const row = await this.campaignLibrary.getRowOrThrow(libraryMonsterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.campaignLibrary.update(libraryMonsterId as number, CampaignLibraryMonsterUpdate.parse(fields), user, role, row.campaignId);
      },
    );

    this.writeTool(
      server,
      user,
      'delete_campaign_library_monster',
      'DM only: delete a saved campaign-library monster (issue #425).',
      { libraryMonsterId: Id.describe('Library monster id') },
      async ({ libraryMonsterId }) => {
        const row = await this.campaignLibrary.getRowOrThrow(libraryMonsterId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        await this.campaignLibrary.remove(libraryMonsterId as number, user, role, row.campaignId);
        return { ok: true, libraryMonsterId };
      },
    );

    this.writeTool(
      server,
      user,
      'clone_campaign_library_monster',
      'DM only: clone a campaign-library monster under a new name (issue #425).',
      { campaignId: CampaignIdArg, libraryMonsterId: Id.describe('Source library monster id'), name: z.string().min(1).max(120) },
      async ({ campaignId, libraryMonsterId, name }) => {
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        return this.campaignLibrary.clone(libraryMonsterId as number, name as string, user, role, campaignId as number);
      },
    );

    this.tool(server, 'search_campaign_library', 'Search the role-safe campaign library, including tags and facets (issue #742).', { campaignId: CampaignIdArg, ...LibrarySearchQuery.shape }, async ({ campaignId, ...query }) => {
      const role = await this.access.requireMember(user, campaignId as number);
      return this.campaignLibrary.search(campaignId as number, role, LibrarySearchQuery.parse(query));
    });
    this.tool(server, 'list_campaign_library_tags', 'List campaign library tags (issue #742).', { campaignId: CampaignIdArg }, async ({ campaignId }) => { await this.access.requireMember(user, campaignId as number); return this.campaignLibrary.listTags(campaignId as number); });
    this.tool(server, 'list_campaign_library_collections', 'List campaign library collections (issue #742).', { campaignId: CampaignIdArg }, async ({ campaignId }) => { await this.access.requireMember(user, campaignId as number); return this.campaignLibrary.listCollections(campaignId as number); });
    this.writeTool(server, user, 'create_campaign_library_tag', 'DM only: create a campaign library tag.', { campaignId: CampaignIdArg, ...CampaignLibraryTagCreate.shape }, async ({ campaignId, ...body }) => { const role = await this.access.requireRole(user, campaignId as number, 'dm'); return this.campaignLibrary.createTag(campaignId as number, CampaignLibraryTagCreate.parse(body), user, role); });
    this.writeTool(server, user, 'update_campaign_library_tag', 'DM only: edit a campaign library tag.', { campaignId: CampaignIdArg, tagId: Id, ...CampaignLibraryTagUpdate.shape }, async ({ campaignId, tagId, ...body }) => { const role = await this.access.requireRole(user, campaignId as number, 'dm'); return this.campaignLibrary.updateTag(campaignId as number, tagId as number, CampaignLibraryTagUpdate.parse(body), user, role); });
    this.writeTool(server, user, 'delete_campaign_library_tag', 'DM only: delete a campaign library tag.', { campaignId: CampaignIdArg, tagId: Id }, async ({ campaignId, tagId }) => { const role = await this.access.requireRole(user, campaignId as number, 'dm'); await this.campaignLibrary.removeTag(campaignId as number, tagId as number, user, role); return { ok: true }; });
    this.writeTool(server, user, 'create_campaign_library_collection', 'DM only: create a campaign library collection.', { campaignId: CampaignIdArg, ...CampaignLibraryCollectionCreate.shape }, async ({ campaignId, ...body }) => { const role = await this.access.requireRole(user, campaignId as number, 'dm'); return this.campaignLibrary.createCollection(campaignId as number, CampaignLibraryCollectionCreate.parse(body), user, role); });
    this.writeTool(server, user, 'update_campaign_library_collection', 'DM only: edit a campaign library collection.', { campaignId: CampaignIdArg, collectionId: Id, ...CampaignLibraryCollectionUpdate.shape }, async ({ campaignId, collectionId, ...body }) => { const role = await this.access.requireRole(user, campaignId as number, 'dm'); return this.campaignLibrary.updateCollection(campaignId as number, collectionId as number, CampaignLibraryCollectionUpdate.parse(body), user, role); });
    this.writeTool(server, user, 'delete_campaign_library_collection', 'DM only: delete a campaign library collection.', { campaignId: CampaignIdArg, collectionId: Id }, async ({ campaignId, collectionId }) => { const role = await this.access.requireRole(user, campaignId as number, 'dm'); await this.campaignLibrary.removeCollection(campaignId as number, collectionId as number, user, role); return { ok: true }; });
    this.writeTool(server, user, 'bulk_campaign_library', 'DM only: atomically mutate up to 500 campaign library entities.', { campaignId: CampaignIdArg, request: LibraryBulkRequest }, async ({ campaignId, request }) => { const role = await this.access.requireRole(user, campaignId as number, 'dm'); return this.campaignLibrary.bulk(campaignId as number, request, user, role); });
    this.writeTool(server, user, 'undo_campaign_library_bulk', 'DM only: undo one campaign library bulk operation when no later edit conflicts.', { campaignId: CampaignIdArg, operationId: Id }, async ({ campaignId, operationId }) => { const role = await this.access.requireRole(user, campaignId as number, 'dm'); return this.campaignLibrary.undoBulk(campaignId as number, operationId as number, user, role); });
    this.tool(server, 'list_campaign_library_templates', 'DM only: list active campaign library templates.', { campaignId: CampaignIdArg }, async ({ campaignId }) => { await this.access.requireRole(user, campaignId as number, 'dm'); return this.campaignLibrary.listTemplates(campaignId as number); });
    this.writeTool(server, user, 'save_campaign_library_template', 'DM only: save a current-format entity template.', { campaignId: CampaignIdArg, ...CampaignLibraryTemplateSave.shape }, async ({ campaignId, ...body }) => { const role = await this.access.requireRole(user, campaignId as number, 'dm'); return this.campaignLibrary.saveTemplate(campaignId as number, body, user, role); });
    this.writeTool(server, user, 'instantiate_campaign_library_template', 'DM only: instantiate an active campaign library template.', { campaignId: CampaignIdArg, templateId: Id, ...CampaignLibraryTemplateInstantiate.shape }, async ({ campaignId, templateId, ...body }) => { const role = await this.access.requireRole(user, campaignId as number, 'dm'); return this.campaignLibrary.instantiateTemplate(campaignId as number, templateId as number, body, user, role); });
    this.writeTool(server, user, 'archive_campaign_library_template', 'DM only: archive a campaign library template.', { campaignId: CampaignIdArg, templateId: Id }, async ({ campaignId, templateId }) => { const role = await this.access.requireRole(user, campaignId as number, 'dm'); return this.campaignLibrary.archiveTemplate(campaignId as number, templateId as number, user, role); });
    this.writeTool(server, user, 'duplicate_campaign_library_entity', 'DM only: duplicate a campaign library entity through its current-format adapter.', { campaignId: CampaignIdArg, entityType: LibraryEntityType, entityId: Id, ...CampaignLibraryTemplateInstantiate.shape }, async ({ campaignId, entityType, entityId, ...body }) => { const role = await this.access.requireRole(user, campaignId as number, 'dm'); return this.campaignLibrary.duplicateEntity(campaignId as number, LibraryEntityType.parse(entityType), entityId as number, body, user, role); });

    this.writeTool(
      server,
      user,
      'ai_dm_narrate',
      'EXPERIMENTAL (issue #28): the AI Dungeon Master takes a turn. DM role required (the AI holds the DM seat), the ' +
        'server-wide experimental flag must be on, the seat must be enabled, and the per-campaign token budget must not ' +
        'be exhausted (otherwise a forbidden error). Narration is produced by the server\'s injected AI_DM_PROVIDER — the ' +
        'shipped default is a no-op scaffold that makes NO vendor call, so in a stock install this returns a placeholder ' +
        'and it is the connected agent (you) that authors the real narration and drives the other write tools. Metered ' +
        'against the budget and audited as ai-dm.',
      {
        campaignId: CampaignIdArg,
        prompt: z.string().min(1).max(20_000).describe('The situation / what the players just did, for the DM to respond to'),
        kind: AiDmTurnKind.optional().describe("Turn kind: 'narrate' (default), 'combat', or 'recap'"),
        maxTokens: z.number().int().min(1).max(4096).optional().describe('Optional cap on this turn\'s output tokens (clamped to remaining budget)'),
      },
      async ({ campaignId, prompt, kind, maxTokens }) => {
        await this.access.requireRole(user, campaignId as number, 'dm');
        return this.aiDm.takeTurn(
          campaignId as number,
          {
            prompt: prompt as string,
            kind: (kind as AiDmTurnKind | undefined) ?? 'narrate',
            ...(maxTokens !== undefined ? { maxTokens: maxTokens as number } : {}),
          },
          user,
        );
      },
    );

    this.writeTool(
      server,
      user,
      'draft_content',
      'EXPERIMENTAL co-DM (issue #313 / #1056): ask the AI DM to DRAFT content and file it as PENDING PROPOSAL(S) for ' +
        'the human DM to review — nothing is written to canon directly. DM role required, the server-wide experimental ' +
        'flag must be on, and the seat must be enabled with remaining budget. `target` picks what to draft: npc, ' +
        'location, beat (a story beat filed as story_beat — pass arcId to pin it to an arc), quest (a full quest draft), faction, recap ' +
        '(filed as a session), encounter (reuses generate_encounter #304), or map (reuses generate_map #306). `count` ' +
        '(npc/location/beat/quest/faction only) drafts several at once; recap/encounter/map ignore count. `arcId` (beat only) ' +
        'pins drafted beats to a story arc. Returns the ' +
        'created proposal ids; approve/reject them with approve_proposal / reject_proposal. Metered against the seat ' +
        'budget; the proposer is recorded as the AI seat + model.',
      {
        campaignId: CampaignIdArg,
        target: CoDmDraftTarget.describe('What to draft: npc | location | beat | quest | faction | recap | encounter | map'),
        prompt: z.string().min(1).max(20_000).describe('Free-text brief, e.g. "a shady fence tied to the thieves guild"'),
        count: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe('How many to draft (npc/location/beat/quest/faction only; ignored for recap/encounter/map)'),
        narrationLanguage: NarrationLanguage.optional().describe('Per-run override of the campaign narration language (#635)'),
        arcId: Id.optional().describe('When target is beat, pin drafted beat(s) to this story arc id'),
      },
      async ({ campaignId, target, prompt, count, narrationLanguage, arcId }) => {
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        return this.coDm.draft(
          campaignId as number,
          {
            target: target as z.infer<typeof CoDmDraftTarget>,
            prompt: prompt as string,
            ...(count !== undefined ? { count: count as number } : {}),
            ...(narrationLanguage !== undefined ? { narrationLanguage: narrationLanguage as z.infer<typeof NarrationLanguage> } : {}),
            ...(arcId !== undefined ? { arcId: arcId as number } : {}),
          },
          user,
          role,
        );
      },
    );

    // ---------- inventory & treasury (issue #257) ----------
    this.writeTool(
      server,
      user,
      'add_inventory_item',
      'player: add an inventory item. ownerType defaults to "party" (the shared stash, writable by any player); ' +
        'ownerType "character" requires a characterId in this campaign and is writable only by the dm or that ' +
        'character\'s owning player.',
      { campaignId: CampaignIdArg, ...InventoryItemCreate.shape },
      async ({ campaignId, ...fields }) => {
        const validated = InventoryItemCreate.parse(fields);
        const role = await this.access.requireRole(user, campaignId as number, 'player');
        return this.inventory.create(campaignId as number, validated, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'acquire_compendium_item',
      'player: acquire an installed compendium item into party or an owned character inventory. Captures its source, license and play-safe snapshot. An equivalent item returns INVENTORY_COMPENDIUM_DUPLICATE until duplicateMode is increment or separate.',
      { campaignId: CampaignIdArg, ...InventoryFromCompendium.shape },
      async ({ campaignId, ...fields }) => {
        const validated = InventoryFromCompendium.parse(fields);
        const role = await this.access.requireRole(user, campaignId as number, 'player');
        return this.inventory.acquireFromCompendium(campaignId as number, validated, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'update_inventory_item',
      'player: update an inventory item\'s name/notes/icon, or MOVE it by changing ownerType/characterId. Character ' +
        'items are writable only by the dm or the owning player; a move requires write access at both source and ' +
        'destination. Quantity (issue #782): prefer qtyDelta + idempotencyKey for atomic +/-; an absolute qty ' +
        'requires expectedUpdatedAt (CAS) and 409s on conflict. A qtyDelta that would take quantity negative 400s ' +
        'without changing the item. Equip/unequip (issue #1326): equipped:true requires a character-owned item and ' +
        'a non-empty equipSlot (400 otherwise); a slot already occupied by another equipped item on the same ' +
        'character 409s (INVENTORY_SLOT_CONFLICT). equippedAction attaches a structured action the item grants ' +
        'while equipped, surfaced by list_usable_actions for the item\'s character.',
      { itemId: Id.describe('Inventory item id — from list_inventory'), ...InventoryItemUpdate.shape },
      async ({ itemId, ...fields }) => {
        const row = await this.inventory.getRowOrThrow(itemId as number);
        const validated = InventoryItemUpdate.parse(fields);
        const role = await this.access.requireRole(user, row.campaignId, 'player');
        return this.inventory.update(itemId as number, validated, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'delete_inventory_item',
      'player: delete an inventory item. Character items only by the dm or the owning player.',
      { itemId: Id.describe('Inventory item id — from list_inventory') },
      async ({ itemId }) => {
        const row = await this.inventory.getRowOrThrow(itemId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'player');
        await this.inventory.remove(itemId as number, user, role);
        return { ok: true, itemId };
      },
    );

    this.writeTool(
      server,
      user,
      'adjust_treasury',
      'player: adjust the party treasury coins. Pass exactly one of `delta` (relative per-denomination change; result ' +
        'must stay >= 0) or `set` (absolute per-denomination values). Omitted denominations are left untouched. ' +
        'Denominations: cp, sp, ep, gp, pp.',
      {
        campaignId: CampaignIdArg,
        delta: z
          .object({
            cp: z.number().int().optional(),
            sp: z.number().int().optional(),
            ep: z.number().int().optional(),
            gp: z.number().int().optional(),
            pp: z.number().int().optional(),
          })
          .optional()
          .describe('Relative per-denomination change (may be negative; each result must stay >= 0)'),
        set: z
          .object({
            cp: z.number().int().nonnegative().optional(),
            sp: z.number().int().nonnegative().optional(),
            ep: z.number().int().nonnegative().optional(),
            gp: z.number().int().nonnegative().optional(),
            pp: z.number().int().nonnegative().optional(),
          })
          .optional()
          .describe('Absolute per-denomination values to set'),
      },
      async ({ campaignId, delta, set }) => {
        if ((delta === undefined) === (set === undefined)) {
          throw new BadRequestException('Pass exactly one of delta or set');
        }
        const validated = TreasuryPatch.parse(delta !== undefined ? { delta } : { set });
        const role = await this.access.requireRole(user, campaignId as number, 'player');
        return this.inventory.patchTreasury(campaignId as number, validated, user, role);
      },
    );

    // ---------- timeline & calendar (issue #257) ----------
    this.writeTool(
      server,
      user,
      'update_session_zero',
      'DM only: update the shared Session Zero charter. Supply expectedUpdatedAt from get_session_zero to prevent ' +
        'overwriting newer lines, veils, safety tools, house rules, or tone expectations.',
      { campaignId: CampaignIdArg, expectedUpdatedAt: ExpectedUpdatedAt, ...SessionZeroUpdate.shape },
      async ({ campaignId, expectedUpdatedAt, ...fields }) => {
        const validated = SessionZeroUpdate.parse(fields);
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        return this.sessionZero.update(campaignId as number, validated, user, role, {
          expectedUpdatedAt: expectedUpdatedAt as string | undefined,
        });
      },
    );

    this.writeTool(
      server,
      user,
      'create_timeline_event',
      'DM only: add an in-world timeline event (issue #63). Free-text `inWorldDate` (fantasy calendars aren\'t ' +
        'ISO-parseable) plus a DM-controlled `sortIndex` for narrative order. Supports a dmSecret field (DM-only text, ' +
        'stripped from non-DM reads) and a hidden flag (excluded WHOLESALE from non-DM reads until revealed).',
      { campaignId: CampaignIdArg, ...TimelineEventCreate.shape },
      async ({ campaignId, ...fields }) => {
        const validated = TimelineEventCreate.parse(fields);
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        return this.timeline.createEvent(campaignId as number, validated, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'update_timeline_event',
      'DM only: update an in-world timeline event\'s title, inWorldDate, body, era, sortIndex, dmSecret, or hidden flag ' +
        '(set hidden=false to reveal a previously-hidden event to players).',
      { eventId: Id.describe('Timeline event id — from list_timeline'), expectedUpdatedAt: ExpectedUpdatedAt, ...TimelineEventUpdate.shape },
      async ({ eventId, expectedUpdatedAt, ...fields }) => {
        const row = await this.timeline.getEventRowOrThrow(eventId as number);
        const validated = TimelineEventUpdate.parse(fields);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.timeline.updateEvent(eventId as number, validated, user, role, { expectedUpdatedAt: expectedUpdatedAt as string | undefined });
      },
    );

    this.writeTool(
      server,
      user,
      'delete_timeline_event',
      'DM only: delete an in-world timeline event.',
      { eventId: Id.describe('Timeline event id — from list_timeline') },
      async ({ eventId }) => {
        const row = await this.timeline.getEventRowOrThrow(eventId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        await this.timeline.removeEvent(eventId as number, user, role);
        return { ok: true, eventId };
      },
    );

    this.writeTool(
      server,
      user,
      'set_calendar',
      'DM only: set the campaign\'s current in-world date and/or calendar note (issue #63). Upserts the single ' +
        'per-campaign calendar row.',
      { campaignId: CampaignIdArg, expectedUpdatedAt: ExpectedUpdatedAt, ...TimelineCalendarUpdate.shape },
      async ({ campaignId, expectedUpdatedAt, ...fields }) => {
        const validated = TimelineCalendarUpdate.parse(fields);
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        return this.timeline.setCalendar(campaignId as number, validated, user, role, { expectedUpdatedAt: expectedUpdatedAt as string | undefined });
      },
    );

    // ---------- discussion comments (issue #257) ----------
    this.writeTool(
      server,
      user,
      'post_comment',
      'Any member: post a discussion comment anchored to an entity (entityType/entityId). Optional parentId for a ' +
        'threaded reply (must reference a comment on the same entity). For a play-by-post scene set inCharacter=true ' +
        'and characterId to a live character owned by the authenticated account; the response retains immutable ' +
        'character name/avatar snapshots plus account provenance. ' +
        'Requires visibility of the anchored entity — posting on a hidden/secret entity 404s for non-DM (issue #230).',
      { campaignId: CampaignIdArg, ...CommentCreate.shape },
      async ({ campaignId, ...fields }) => {
        const validated = CommentCreate.parse(fields);
        const role = await this.access.requireMemberOnWritableCampaign(user, campaignId as number);
        return this.comments.create(campaignId as number, validated, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'update_comment',
      'Edit a discussion comment body. Author or DM only. Character attribution is immutable after posting; changing inCharacter is rejected.',
      { commentId: Id.describe('Comment id — from list_comments'), expectedUpdatedAt: ExpectedUpdatedAt, ...CommentUpdate.shape },
      async ({ commentId, expectedUpdatedAt, ...fields }) => {
        const row = await this.comments.getRowOrThrow(commentId as number);
        const validated = CommentUpdate.parse(fields);
        const role = await this.access.requireMemberOnWritableCampaign(user, row.campaignId);
        return this.comments.update(commentId as number, validated, user, role, { expectedUpdatedAt: expectedUpdatedAt as string | undefined });
      },
    );

    this.writeTool(
      server,
      user,
      'delete_comment',
      'Delete a discussion comment (tombstone). Author or DM only. Soft-deletes the comment — its body is ' +
        'redacted to "[deleted]" but the row remains so replies keep their parent (issue #503: a root author ' +
        'must not destroy other members\' replies). Reversible via restore_comment.',
      { commentId: Id.describe('Comment id — from list_comments') },
      async ({ commentId }) => {
        const row = await this.comments.getRowOrThrow(commentId as number, true);
        const role = await this.access.requireMemberOnWritableCampaign(user, row.campaignId);
        await this.comments.remove(commentId as number, user, role);
        return { ok: true, commentId };
      },
    );

    this.writeTool(
      server,
      user,
      'restore_comment',
      'Restore a tombstoned discussion comment. Author or DM only. Undoes a soft-delete (issue #503): clears ' +
        'deletedAt/deletedBy and returns the comment with its original body. 404 if the comment is not currently ' +
        'tombstoned.',
      { commentId: Id.describe('Comment id — from list_comments') },
      async ({ commentId }) => {
        const row = await this.comments.getRowOrThrow(commentId as number, true);
        const role = await this.access.requireMemberOnWritableCampaign(user, row.campaignId);
        return this.comments.restore(commentId as number, user, role);
      },
    );

    // ---------- scheduling (issue #257) ----------
    this.writeTool(
      server,
      user,
      'schedule_session',
      'DM only: schedule a (future) game night (issue #13). `scheduledAt` is an ISO date-time (normalized to UTC); ' +
        'durationMinutes defaults to 240. Notifies the party. Distinct from add_session_recap (a past session log).',
      { campaignId: CampaignIdArg, ...ScheduledSessionCreate.shape },
      async ({ campaignId, ...fields }) => {
        const validated = ScheduledSessionCreate.parse(fields);
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        return this.scheduling.create(campaignId as number, validated, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'update_scheduled_session',
      'DM only: update a scheduled game night\'s time/duration/title/location/notes. Meaningful changes ' +
        '(time, duration, venue/VTT link, notes) re-notify the party once with a field summary; title-only edits stay silent. ' +
        'A cancelled night is rejected — restore_scheduled_session first, so the party is never notified about a game that is not happening.',
      { scheduleId: Id.describe('Scheduled session id — from list_scheduled_sessions'), expectedUpdatedAt: ExpectedUpdatedAt, ...ScheduledSessionUpdate.shape },
      async ({ scheduleId, expectedUpdatedAt, ...fields }) => {
        const row = await this.scheduling.getRowOrThrow(scheduleId as number);
        const validated = ScheduledSessionUpdate.parse(fields);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.scheduling.update(scheduleId as number, validated, user, role, { expectedUpdatedAt: expectedUpdatedAt as string | undefined });
      },
    );

    this.writeTool(
      server,
      user,
      'cancel_scheduled_session',
      'DM only: cancel a scheduled game night. Retains the schedule row and RSVPs, stamps cancellation metadata, ' +
        'updates the ICS feed, and notifies the party.',
      { scheduleId: Id.describe('Scheduled session id — from list_scheduled_sessions'), ...ScheduledSessionCancel.shape },
      async ({ scheduleId, ...fields }) => {
        const row = await this.scheduling.getRowOrThrow(scheduleId as number);
        const validated = ScheduledSessionCancel.parse(fields);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.scheduling.remove(scheduleId as number, user, role, validated);
      },
    );

    this.writeTool(
      server,
      user,
      'restore_scheduled_session',
      'DM only: restore a cancelled scheduled game night. Clears cancellation metadata and returns it to live schedule '
        + 'projections. A cancelled night RELEASED any room and assigned DM it held, so restoring re-books them: if either '
        + 'was taken meanwhile this fails with SCHEDULE_CONFLICT listing the clashes, and `force: true` overrides it.',
      {
        scheduleId: Id.describe('Cancelled scheduled session id — from list_scheduled_sessions'),
        // #588: the same override fields REST exposes on POST /schedule/:id/restore.
        // Without them an MCP caller could see the clash but had no way to act on it.
        ...ScheduledSessionRestore.shape,
      },
      async ({ scheduleId, ...fields }) => {
        const row = await this.scheduling.getRowOrThrow(scheduleId as number);
        const validated = ScheduledSessionRestore.parse(fields);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        try {
          return await this.scheduling.restore(scheduleId as number, user, role, validated.force, (validated.reason ?? '').trim());
        } catch (err) {
          // #588: `SeriesConflictSignal` is a plain Error, so the generic envelope
          // would render it as an opaque 500 "Something went wrong" — the caller
          // would learn neither that the room was taken nor that `force` exists.
          // ScheduleController already translates it; routing MCP through the SAME
          // translator keeps one redaction rule rather than a second copy that can
          // disagree about what a stranger may see.
          return await this.organizedPlay.toConflictResponse(err, user);
        }
      },
    );

    this.writeTool(
      server,
      user,
      'duplicate_scheduled_session',
      'DM only: duplicate/reschedule a scheduled game night into a new live schedule row. Optional fields override the copied time/details; RSVPs are not copied.',
      { scheduleId: Id.describe('Scheduled session id — from list_scheduled_sessions'), ...ScheduledSessionDuplicate.shape },
      async ({ scheduleId, ...fields }) => {
        const row = await this.scheduling.getRowOrThrow(scheduleId as number);
        const validated = ScheduledSessionDuplicate.parse(fields);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.scheduling.duplicate(scheduleId as number, validated, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'set_rsvp',
      'Any member: set YOUR OWN availability (RSVP) for a scheduled game night — status yes|no|maybe with an optional ' +
        'note. Upserts your single RSVP; notifies the DM(s).',
      { scheduleId: Id.describe('Scheduled session id — from list_scheduled_sessions'), ...RsvpSetBody.shape },
      async ({ scheduleId, ...fields }) => {
        const row = await this.scheduling.getRowOrThrow(scheduleId as number);
        const validated = RsvpSet.parse(fields);
        // Member-level write: the archive read-only gate applies (issue #1480).
        const role = await this.access.requireMemberOnWritableCampaign(user, row.campaignId);
        return this.scheduling.setRsvp(scheduleId as number, validated, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'rotate_calendar_feed',
      'DM only: enable the campaign\'s public ICS calendar feed, or rotate its token if already enabled (invalidating ' +
        'any previously-shared feed URL). Returns the fresh token + relative feed URL.',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        return this.scheduling.rotateFeed(campaignId as number, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'disable_calendar_feed',
      'DM only: disable the campaign\'s public ICS calendar feed — clears the token so the public feed URL 404s afterward.',
      { campaignId: CampaignIdArg },
      async ({ campaignId }) => {
        const role = await this.access.requireRole(user, campaignId as number, 'dm');
        return this.scheduling.disableFeed(campaignId as number, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'import_ddb_character',
      'Import a character from a public D&D Beyond sheet (player+ role), including attacks, spells, and spell slots. ' +
        'Pass either `ddbId` (numeric character id) or `url` (a D&D Beyond character/share link). The sheet must be set ' +
        'to Public on DDB. Only available for D&D 5e campaigns — rejected with 400 for other rule systems. Returns ' +
        '`{ character, summary }`: the created character plus counts of imported actions/spells/slots and the names of ' +
        'any entries that came in text-only (unparseable, never silently dropped).',
      {
        campaignId: CampaignIdArg,
        ddbId: z.string().max(200).optional().describe('D&D Beyond numeric character id'),
        url: z.string().max(500).optional().describe('D&D Beyond character URL (e.g. https://www.dndbeyond.com/characters/12345678)'),
      },
      async ({ campaignId, ddbId, url }) => {
        const role = await this.access.requireRole(user, campaignId as number, 'player');
        return this.characters.importFromDdb(campaignId as number, { ddbId: ddbId as string | undefined, url: url as string | undefined }, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'restore_entity_revision',
      'Restore a prior prose revision for an entity (session, quest, npc, location, faction, or note). The current ' +
        'content is captured as a new revision first, so the restore is itself reversible. DM role required for ' +
        'world-building entities; notes require authorship.',
      {
        entityType: RevisionEntityType.describe('Entity type (session|quest|npc|location|faction|note)'),
        entityId: Id.describe('Entity id'),
        revisionId: Id.describe('Revision id to restore'),
      },
      async ({ entityType, entityId, revisionId }) => {
        const type = RevisionEntityType.parse(entityType);
        if (type === 'note') {
          const campaignId = await this.revisions.campaignIdForEntityOrThrow(type, entityId as number);
          const role = await this.access.requireMember(user, campaignId);
          // Note restore is author-only (mirrors the web path).
          const noteAccess = await this.revisions.loadNoteAccess(entityId as number);
          if (noteAccess?.authorUserId !== user.id) throw new ForbiddenException('Only the author may restore this note');
          return this.revisions.restore(type, entityId as number, revisionId as number, user, role);
        }
        const campaignId = await this.revisions.campaignIdForEntityOrThrow(type, entityId as number);
        const role = await this.access.requireRole(user, campaignId, 'dm');
        return this.revisions.restore(type, entityId as number, revisionId as number, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'reveal_attachment',
      'DM only: reveal a staged handout attachment to the party (issue #97) — sets hidden=false so every member can ' +
        'fetch/list it. Binary bytes remain REST-only (GET /attachments/:id/file).',
      { attachmentId: Id.describe('Attachment id — from list_attachments') },
      async ({ attachmentId }) => {
        const row = await this.attachments.getRowOrThrow(attachmentId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.attachments.setHidden(attachmentId as number, false, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'hide_attachment',
      'DM only: re-hide an attachment from players — sets hidden=true (issue #97).',
      { attachmentId: Id.describe('Attachment id') },
      async ({ attachmentId }) => {
        const row = await this.attachments.getRowOrThrow(attachmentId as number);
        const role = await this.access.requireRole(user, row.campaignId, 'dm');
        return this.attachments.setHidden(attachmentId as number, true, user, role);
      },
    );

    this.writeTool(
      server,
      user,
      'delete_attachment',
      'Delete an attachment\'s metadata (and queue filesystem erasure). Uploader or dm only. Uploading new files is ' +
        'REST-only multipart POST /campaigns/:campaignId/attachments.',
      { attachmentId: Id.describe('Attachment id') },
      async ({ attachmentId }) => {
        const row = await this.attachments.getRowOrThrow(attachmentId as number);
        // Issue #1636: see attachments.controller.ts's remove() — write:true does not
        // assert caller authority, and this reaches the identical service.remove() path.
        const role = await this.access.requireRole(user, row.campaignId, 'player');
        return this.attachments.remove(attachmentId as number, user, role);
      },
    );
  }

  // ---------- RESOURCES ----------

  /**
   * Read surfaces exposed as MCP resources (in addition to the read tools).
   *
   * A static index resource (campfire://campaigns) plus three per-campaign
   * templated resources (summary/party/recaps). Each resolves the caller's
   * effective role via CampaignAccessService and calls the SAME domain services
   * the read tools use — identical membership gating and DM-secrecy stripping, no
   * new business logic. The template `list` callbacks enumerate one concrete URI
   * per accessible campaign so a client can discover them without guessing ids.
   */
  private registerResources(server: McpServer, user: RequestUser): void {
    const json = (uri: URL, data: unknown) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }],
    });

    server.registerResource(
      'campaigns',
      'campfire://campaigns',
      {
        title: 'Campaigns',
        description:
          'Every campaign this user (or token) can access — the resource form of list_campaigns. Start here to ' +
          'discover campaign ids for the campfire://campaign/{campaignId}/* resources.',
        mimeType: 'application/json',
      },
      async (uri) => json(uri, await this.campaigns.listForUser(user)),
    );

    // Builds a campfire://campaign/{campaignId}/<suffix> templated resource whose
    // list callback enumerates one URI per accessible campaign.
    const perCampaign = (
      name: string,
      suffix: string,
      meta: { title: string; description: string },
      read: (campaignId: number) => Promise<unknown>,
    ): void => {
      const template = new ResourceTemplate(`campfire://campaign/{campaignId}/${suffix}`, {
        list: async () => {
          const campaigns = await this.campaigns.listForUser(user);
          return {
            resources: campaigns.map((c) => ({
              name: `${c.name} — ${suffix}`,
              uri: `campfire://campaign/${c.id}/${suffix}`,
              mimeType: 'application/json',
            })),
          };
        },
      });
      server.registerResource(name, template, { ...meta, mimeType: 'application/json' }, async (uri, variables) => {
        const raw = Array.isArray(variables.campaignId) ? variables.campaignId[0] : variables.campaignId;
        const campaignId = Number(raw);
        if (!Number.isInteger(campaignId) || campaignId <= 0) {
          throw new BadRequestException(`Invalid campaignId "${raw}" in resource URI`);
        }
        return json(uri, await read(campaignId));
      });
    };

    perCampaign(
      'campaign-summary',
      'summary',
      {
        title: 'Campaign summary',
        description:
          'Full campaign dashboard (campaign, current location, quests with objectives, NPCs, locations, ' +
          'characters, sessions, open inbox count) — the resource form of get_campaign_summary.',
      },
      async (campaignId) => {
        const role = await this.access.requireMember(user, campaignId);
        return this.campaigns.summary(campaignId, user, role);
      },
    );

    perCampaign(
      'campaign-party',
      'party',
      { title: 'Party', description: 'Character sheets visible to the caller — the resource form of get_party.' },
      async (campaignId) => {
        const role = await this.access.requireMember(user, campaignId);
        return this.characters.listForCampaign(campaignId, user, role);
      },
    );

    perCampaign(
      'campaign-recaps',
      'recaps',
      { title: 'Session recaps', description: 'Session recaps for a campaign, newest first — the resource form of get_session_recaps.' },
      async (campaignId) => {
        const role = await this.access.requireMember(user, campaignId);
        return this.sessions.listForCampaign(campaignId, role);
      },
    );

    perCampaign(
      'campaign-session-zero',
      'session-zero',
      {
        title: 'Session zero charter',
        description:
          "The table's safety & expectations charter — lines & veils, safety tools, house rules, tone. Any AI at " +
          'this table is bound by it. The resource form of get_session_zero.',
      },
      async (campaignId) => {
        await this.access.requireMember(user, campaignId);
        return this.effectiveSessionZero(campaignId as number);
      },
    );

    perCampaign(
      'campaign-ai-support-preferences',
      'ai-support-preferences',
      {
        title: 'AI-authorized access supports',
        description:
          'DM only. Practical support preferences whose participant explicitly opted into AI use. Facilitator visibility ' +
          'alone never grants this resource access to the text.',
      },
      async (campaignId) => {
        await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
        return this.supportPreferences.listForAi(campaignId);
      },
    );
  }

  // ---------- PROMPTS ----------

  /**
   * Authoring prompts (recap-writer, session-prep). These return ready-to-run
   * messages parameterized by campaignId that drive the existing tools/resources;
   * they do no data access themselves (so no role gating here — the tools they
   * point at enforce it when actually invoked).
   */
  private registerPrompts(server: McpServer): void {
    // Cast away the SDK's deep conditional generics over the argsSchema shape
    // (TS2589 with a non-literal ZodRawShape) — same reason the tool() helper
    // rebinds registerTool. Behavior is unchanged; the SDK still validates args.
    type PromptMessage = { role: 'user' | 'assistant'; content: { type: 'text'; text: string } };
    const registerPrompt = server.registerPrompt.bind(server) as (
      name: string,
      config: { title?: string; description?: string; argsSchema?: z.ZodRawShape },
      cb: (args: Record<string, string>) => { messages: PromptMessage[] },
    ) => void;

    registerPrompt(
      'recap-writer',
      {
        title: 'Session recap writer',
        description: "Draft a polished session recap for a campaign in the DM's voice.",
        argsSchema: {
          campaignId: z.string().describe('Campaign id (as a string) — from list_campaigns or the campfire://campaigns resource'),
        },
      },
      ({ campaignId }) => ({
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                `You are the Dungeon Master's writing assistant for Campfire campaign ${campaignId}.\n\n` +
                `1. Call the draft_session_recap tool with { "campaignId": ${campaignId} } to pull the recap scaffold, ` +
                `the encounters that were run this session, and the resolved player inbox threads.\n` +
                `2. Rewrite the returned \`draft\` into a finished, engaging recap in the DM's voice, following this template:\n\n` +
                `${RECAP_TEMPLATE}\n\n` +
                `3. Delete the "Threads resolved this session" source-notes appendix, then publish the result with ` +
                `add_session_recap (a new session) or update_session (an existing one).`,
            },
          },
        ],
      }),
    );

    registerPrompt(
      'session-prep',
      {
        title: 'Session prep',
        description: 'Prepare for the next session of a campaign: review open threads and draft what happens next.',
        argsSchema: {
          campaignId: z.string().describe('Campaign id (as a string) — from list_campaigns or the campfire://campaigns resource'),
        },
      },
      ({ campaignId }) => ({
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                `You are the Dungeon Master's prep assistant for Campfire campaign ${campaignId}.\n\n` +
                `1. Read campfire://campaign/${campaignId}/summary (or call get_campaign_summary) for the current state: ` +
                `active quests and their objectives, the party's characters, the current location, and danger level.\n` +
                `2. Call get_ai_support_preferences { "campaignId": ${campaignId} } and apply only the returned, ` +
                `participant-authorized practical supports. Then call read_inbox for open player questions and ` +
                `list_proposals for anything pending your approval.\n` +
                `3. Propose a focused prep plan for the next session: which active quests to advance, likely encounters to stat ` +
                `up (use lookup_rule for monster statblocks), NPCs and locations to flesh out, and any secrets to seed. Offer to ` +
                `create the encounters, quests, or locations you suggest via the matching tools.`,
            },
          },
        ],
      }),
    );
  }
}
