/**
 * Campfire domain contract — single source of truth.
 *
 * Every API DTO, OpenAPI shape, and (later) MCP tool schema derives from these
 * Zod schemas. Server and web import types from here; neither redefines domain shapes.
 *
 * Conventions:
 *  - ids are integer PKs (SQLite rowid-friendly)
 *  - timestamps are ISO strings set by the server
 *  - `dmSecret` fields exist on canon entities and are STRIPPED server-side for non-DM
 *  - Create/Update input schemas are derived from the entity schema
 */
import { z } from 'zod';

// ---------- shared ----------
export const Role = z.enum(['dm', 'player', 'viewer']);
export type Role = z.infer<typeof Role>;

export const Id = z.number().int().positive();
export const IsoDate = z.string(); // ISO-8601, server-assigned

const timestamps = {
  createdAt: IsoDate,
  updatedAt: IsoDate,
};

// ---------- campaign ----------
export const DangerLevel = z.enum(['low', 'moderate', 'high', 'deadly']);

export const Campaign = z.object({
  id: Id,
  name: z.string().min(1).max(120),
  description: z.string().max(10_000).default(''),
  status: z.enum(['active', 'paused', 'completed']).default('active'),
  currentLocationId: Id.nullable().default(null),
  dangerLevel: DangerLevel.default('low'),
  sessionCount: z.number().int().nonnegative().default(0),
  ruleSystem: z.string().max(80).default(''), // slug of the installed rule pack (see RulePack), or '' if none picked
  ...timestamps,
});
export type Campaign = z.infer<typeof Campaign>;
export const CampaignCreate = Campaign.omit({ id: true, createdAt: true, updatedAt: true, sessionCount: true }).partial({ description: true, status: true, currentLocationId: true, dangerLevel: true, ruleSystem: true });
export const CampaignUpdate = CampaignCreate.partial();

// ---------- character ----------
export const Character = z.object({
  id: Id,
  campaignId: Id,
  ownerUserId: z.string().max(120).nullable().default(null), // OIDC sub; null = DM-managed
  name: z.string().min(1).max(120),
  species: z.string().max(80).default(''),
  className: z.string().max(80).default(''),
  level: z.number().int().min(1).max(20).default(1),
  background: z.string().max(120).default(''),
  stats: z.record(z.string(), z.number().int()).default({}), // e.g. { STR: 8, DEX: 14 }
  ac: z.number().int().nullable().default(null),
  hpCurrent: z.number().int().default(10),
  hpMax: z.number().int().min(1).default(10),
  conditions: z.array(z.string().max(40)).default([]),
  portraitUrl: z.string().max(500).nullable().default(null),
  ddbId: z.string().max(40).nullable().default(null),
  notes: z.string().max(20_000).default(''), // public character bio/story
  ...timestamps,
});
export type Character = z.infer<typeof Character>;
export const CharacterCreate = Character.omit({ id: true, campaignId: true, createdAt: true, updatedAt: true }).partial().required({ name: true });
export const CharacterUpdate = CharacterCreate.partial();
export const HpPatch = z.union([
  z.object({ delta: z.number().int() }),
  z.object({ set: z.number().int().nonnegative() }),
]);
export const ConditionsPatch = z.object({
  add: z.array(z.string().max(40)).optional(),
  remove: z.array(z.string().max(40)).optional(),
});

// ---------- quest ----------
export const QuestStatus = z.enum(['available', 'active', 'completed', 'failed']);

export const QuestObjective = z.object({
  id: Id,
  questId: Id,
  text: z.string().min(1).max(500),
  done: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
});
export type QuestObjective = z.infer<typeof QuestObjective>;

export const Quest = z.object({
  id: Id,
  campaignId: Id,
  parentId: Id.nullable().default(null), // subquests
  title: z.string().min(1).max(200),
  body: z.string().max(50_000).default(''), // markdown
  status: QuestStatus.default('available'),
  giverNpcId: Id.nullable().default(null),
  reward: z.string().max(500).default(''),
  dmSecret: z.string().max(20_000).default(''), // DM only — stripped for non-DM
  sortOrder: z.number().int().default(0),
  ...timestamps,
});
export type Quest = z.infer<typeof Quest>;
export const QuestCreate = Quest.omit({ id: true, campaignId: true, createdAt: true, updatedAt: true }).partial().required({ title: true });
export const QuestUpdate = QuestCreate.partial();
export const QuestStatusPatch = z.object({ status: QuestStatus });
export const ObjectiveCreate = z.object({ text: z.string().min(1).max(500), sortOrder: z.number().int().optional() });
export const ObjectivePatch = z.object({ text: z.string().min(1).max(500).optional(), done: z.boolean().optional(), sortOrder: z.number().int().optional() });

// ---------- npc ----------
export const Npc = z.object({
  id: Id,
  campaignId: Id,
  name: z.string().min(1).max(120),
  role: z.string().max(120).default(''), // "Townmaster", "Midwife"…
  disposition: z.string().max(40).default('neutral'),
  locationId: Id.nullable().default(null),
  body: z.string().max(50_000).default(''),
  dmSecret: z.string().max(20_000).default(''),
  ...timestamps,
});
export type Npc = z.infer<typeof Npc>;
export const NpcCreate = Npc.omit({ id: true, campaignId: true, createdAt: true, updatedAt: true }).partial().required({ name: true });
export const NpcUpdate = NpcCreate.partial();

// ---------- location ----------
export const LocationStatus = z.enum(['unexplored', 'explored', 'current']);

export const Location = z.object({
  id: Id,
  campaignId: Id,
  name: z.string().min(1).max(120),
  kind: z.string().max(80).default(''), // town, dungeon, region…
  status: LocationStatus.default('unexplored'),
  mapX: z.number().nullable().default(null), // 0..100 on the abstract pin canvas
  mapY: z.number().nullable().default(null),
  body: z.string().max(50_000).default(''),
  dmSecret: z.string().max(20_000).default(''),
  ...timestamps,
});
export type Location = z.infer<typeof Location>;
export const LocationCreate = Location.omit({ id: true, campaignId: true, createdAt: true, updatedAt: true }).partial().required({ name: true });
export const LocationUpdate = LocationCreate.partial();

// ---------- session ----------
export const Session = z.object({
  id: Id,
  campaignId: Id,
  number: z.number().int().positive(),
  title: z.string().max(200).default(''),
  playedAt: IsoDate.nullable().default(null),
  recap: z.string().max(100_000).default(''), // markdown
  ...timestamps,
});
export type Session = z.infer<typeof Session>;
export const SessionCreate = Session.omit({ id: true, campaignId: true, createdAt: true, updatedAt: true }).partial().required({ number: true });
export const SessionUpdate = SessionCreate.partial();

// ---------- notes ----------
export const NoteVisibility = z.enum(['private', 'dm_shared', 'party_shared']);
export const NoteKind = z.enum(['note', 'inbox']);
export const EntityType = z.enum(['quest', 'npc', 'location', 'session', 'character', 'campaign']);

export const Note = z.object({
  id: Id,
  campaignId: Id,
  authorUserId: z.string().max(120), // OIDC sub or dev user
  authorName: z.string().max(120).default(''),
  kind: NoteKind.default('note'),
  visibility: NoteVisibility.default('private'),
  entityType: EntityType.nullable().default(null),
  entityId: Id.nullable().default(null),
  body: z.string().min(1).max(20_000),
  resolved: z.boolean().default(false), // inbox items only
  resolvedNote: z.string().max(1000).default(''),
  ...timestamps,
});
export type Note = z.infer<typeof Note>;
export const NoteCreate = Note.omit({ id: true, campaignId: true, authorUserId: true, createdAt: true, updatedAt: true, resolved: true, resolvedNote: true }).partial().required({ body: true });
export const NoteUpdate = z.object({
  body: z.string().min(1).max(20_000).optional(),
  visibility: NoteVisibility.optional(),
  entityType: EntityType.nullable().optional(),
  entityId: Id.nullable().optional(),
});
export const InboxCreate = z.object({
  authorName: z.string().max(120).default('someone'),
  body: z.string().min(1).max(20_000),
});
export const InboxResolve = z.object({ resolvedNote: z.string().max(1000).default('') });

// ---------- rule packs (Compendium backend) ----------
// Installed, server-wide rules content (spells/monsters/items/…) imported from
// an open-licensed source (currently Open5e). Read by any authed user;
// install/uninstall is server-admin only (see rules.controller.ts).
export const RulePack = z.object({
  id: Id,
  slug: z.string().min(1).max(80), // e.g. "open5e-srd", unique
  name: z.string().min(1).max(120),
  version: z.string().max(40).default(''),
  license: z.string().max(120).default(''), // e.g. "OGL 1.0a", "CC-BY-4.0"
  sourceUrl: z.string().max(500).default(''),
  installedAt: IsoDate,
  entryCount: z.number().int().nonnegative().default(0),
});
export type RulePack = z.infer<typeof RulePack>;

export const RuleEntryType = z.enum(['spell', 'monster', 'item', 'class', 'race', 'condition', 'section', 'other']);
export type RuleEntryType = z.infer<typeof RuleEntryType>;

export const RuleEntry = z.object({
  id: Id,
  packId: Id,
  slug: z.string().min(1).max(160),
  name: z.string().min(1).max(200),
  type: RuleEntryType,
  summary: z.string().max(1000).default(''),
  body: z.string().max(50_000).default(''), // markdown
  dataJson: z.string().nullable().default(null), // raw structured fields (stats etc.), JSON-encoded
  ...timestamps,
});
export type RuleEntry = z.infer<typeof RuleEntry>;

export const RulePackInstall = z.object({
  source: z.literal('open5e'),
  url: z.string().max(500).optional(), // override API base, mainly for tests (fake server)
  sections: z.array(z.enum(['spells', 'monsters', 'items', 'conditions'])).optional(), // default: all
});
export type RulePackInstall = z.infer<typeof RulePackInstall>;

export const RuleSearchQuery = z.object({
  q: z.string().max(200).default(''),
  type: RuleEntryType.optional(),
  pack: z.string().max(80).optional(), // pack slug
});

// ---------- campaign summary (dashboard aggregate / AI primer) ----------
export const CampaignSummary = z.object({
  campaign: Campaign,
  currentLocation: Location.nullable(),
  quests: z.array(Quest.extend({ objectives: z.array(QuestObjective) })),
  npcs: z.array(Npc),
  locations: z.array(Location),
  characters: z.array(Character),
  sessions: z.array(Session),
  openInboxCount: z.number().int().nonnegative(),
});
export type CampaignSummary = z.infer<typeof CampaignSummary>;

// ---------- auth, users, settings, membership ----------
export const ServerRole = z.enum(['admin', 'user']);
export type ServerRole = z.infer<typeof ServerRole>;

// Hex color, e.g. #9184d9. Shared by User.accentColor and PreferencesUpdate below.
const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const User = z.object({
  id: Id,
  username: z.string().min(2).max(60).regex(/^[a-z0-9_.-]+$/i, 'letters, numbers, _ . - only'),
  displayName: z.string().max(120).default(''),
  serverRole: ServerRole.default('user'),
  disabled: z.boolean().default(false),
  // Personal accent color override (per-user UI theming). null = follow the server default (Nocturne blurple).
  accentColor: HexColor.nullable().default(null),
  ...timestamps,
}); // passwordHash never leaves the server
export type User = z.infer<typeof User>;

export const Password = z.string().min(8).max(200);
export const SetupRequest = z.object({ username: User.shape.username, password: Password, displayName: z.string().max(120).optional() });
export const LoginRequest = z.object({ username: z.string().min(1), password: z.string().min(1) });
export const UserCreate = z.object({ username: User.shape.username, password: Password, displayName: z.string().max(120).optional(), serverRole: ServerRole.optional() });
export const UserUpdate = z.object({ displayName: z.string().max(120).optional(), serverRole: ServerRole.optional(), disabled: z.boolean().optional() });
export const PasswordChange = z.object({ currentPassword: z.string().optional(), newPassword: Password }); // current required for self-change; admin reset omits

// Self-service preferences (PATCH /me/preferences) — separate from admin-only UserUpdate above.
export const PreferencesUpdate = z.object({
  displayName: z.string().max(120).optional(),
  accentColor: HexColor.nullable().optional(),
});
export type PreferencesUpdate = z.infer<typeof PreferencesUpdate>;

export const AuthStatus = z.object({
  setupRequired: z.boolean(), // true until the first (admin) user exists
  localLoginEnabled: z.boolean(), // for non-admin users (admins can always log in locally)
  oidcEnabled: z.boolean(), // future
  version: z.string(),
});
export type AuthStatus = z.infer<typeof AuthStatus>;

export const ServerSettings = z.object({
  allowLocalLogin: z.boolean().default(true), // gate for non-admin local login
});
export type ServerSettings = z.infer<typeof ServerSettings>;
export const SettingsUpdate = ServerSettings.partial();

export const CampaignMember = z.object({
  id: Id,
  campaignId: Id,
  userId: Id,
  role: Role, // dm | player | viewer — per campaign
  characterId: Id.nullable().default(null),
  username: z.string().default(''), // denormalized for display
  displayName: z.string().default(''),
  ...timestamps,
});
export type CampaignMember = z.infer<typeof CampaignMember>;
export const MemberCreate = z.object({ userId: Id, role: Role, characterId: Id.nullable().optional() });
export const MemberUpdate = z.object({ role: Role.optional(), characterId: Id.nullable().optional() });

export const Me = z.object({
  user: User,
  memberships: z.array(z.object({ campaignId: Id, role: Role, characterId: Id.nullable() })),
});
export type Me = z.infer<typeof Me>;

// ---------- API tokens (PATs — REST + MCP auth) ----------
export const TokenScope = Role; // token caps the effective role; real role = min(scope, membership role)

export const ApiToken = z.object({
  id: Id,
  userId: Id,
  name: z.string().min(1).max(80),
  scope: TokenScope,
  campaignId: Id.nullable().default(null), // null = all campaigns the owner can access
  tokenPrefix: z.string().max(12), // display only, e.g. cf_pat_9f2a
  lastUsedAt: IsoDate.nullable().default(null),
  ...timestamps,
}); // raw token is returned ONCE at creation, stored hashed
export type ApiToken = z.infer<typeof ApiToken>;
export const ApiTokenCreate = z.object({ name: z.string().min(1).max(80), scope: TokenScope, campaignId: Id.nullable().optional() });
export const ApiTokenCreated = z.object({ token: z.string(), apiToken: ApiToken });

// ---------- proposals (AI/collab writes pending DM approval) ----------
export const ProposalAction = z.enum(['create', 'update']);
export const ProposalStatus = z.enum(['pending', 'approved', 'rejected']);

export const Proposal = z.object({
  id: Id,
  campaignId: Id,
  entityType: EntityType,
  entityId: Id.nullable().default(null), // null for creates
  action: ProposalAction,
  payload: z.record(z.string(), z.unknown()), // the Create/Update body that would have been applied
  proposer: z.string().max(200), // user id or token name
  status: ProposalStatus.default('pending'),
  resolvedBy: z.string().max(200).default(''),
  note: z.string().max(1000).default(''),
  ...timestamps,
});
export type Proposal = z.infer<typeof Proposal>;
export const ProposalResolve = z.object({ note: z.string().max(1000).optional() });

// ---------- audit ----------
// Type aliases for enum/value exports (TS declaration merging: value + type share the name)
export type DangerLevel = z.infer<typeof DangerLevel>;
export type QuestStatus = z.infer<typeof QuestStatus>;
export type LocationStatus = z.infer<typeof LocationStatus>;
export type NoteVisibility = z.infer<typeof NoteVisibility>;
export type NoteKind = z.infer<typeof NoteKind>;
export type EntityType = z.infer<typeof EntityType>;
export type TokenScope = z.infer<typeof TokenScope>;
export type ProposalAction = z.infer<typeof ProposalAction>;
export type ProposalStatus = z.infer<typeof ProposalStatus>;
export type ApiTokenCreated = z.infer<typeof ApiTokenCreated>;

export const AuditEntry = z.object({
  id: Id,
  campaignId: Id.nullable(),
  actor: z.string().max(200), // user id or token name
  actorRole: Role,
  action: z.string().max(80), // e.g. quest.update
  entityType: z.string().max(40).nullable(),
  entityId: Id.nullable(),
  detail: z.string().max(2000).default(''),
  createdAt: IsoDate,
});
export type AuditEntry = z.infer<typeof AuditEntry>;
