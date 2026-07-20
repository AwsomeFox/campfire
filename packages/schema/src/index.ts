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

// ---------- pagination (issue #71) ----------
// Shared list-pagination convention. High-volume list endpoints (sessions, notes,
// audit) and their MCP equivalents accept optional `?limit` & `?offset` query
// params, pushed down into SQL. When both are omitted the endpoint returns its
// full (or historically-capped) result, so existing callers are unaffected —
// pagination is opt-in. `limit` is clamped to a per-endpoint maximum server-side.
export const PageParams = z.object({
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
});
export type PageParams = z.infer<typeof PageParams>;

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
  mapAttachmentId: Id.nullable().default(null), // Attachment (kind='map') rendered as the campaign map background
  // Per-campaign upload quota in bytes, or null for no limit (issue #24). Set by a
  // server admin via the storage console — NOT part of CampaignCreate/Update, so a
  // DM can never lift their own campaign's cap. Enforced on attachment upload.
  storageQuotaBytes: z.number().int().nonnegative().nullable().default(null),
  ...timestamps,
});
export type Campaign = z.infer<typeof Campaign>;
export const CampaignCreate = Campaign.omit({ id: true, createdAt: true, updatedAt: true, sessionCount: true, storageQuotaBytes: true }).partial({ description: true, status: true, currentLocationId: true, dangerLevel: true, ruleSystem: true, mapAttachmentId: true });
export const CampaignUpdate = CampaignCreate.partial();

// Clone/template input — POST /campaigns/:id/clone.
//  - 'full': faithful duplicate (everything except members, attachments and audit/proposals/tokens)
//  - 'template': prep only (quests reset to available, objectives unchecked, npcs, locations
//    reset to unexplored) — play state (sessions, notes, encounters, characters, session count,
//    current party location) is stripped so the copy starts fresh.
export const CampaignCloneMode = z.enum(['full', 'template']);
export const CampaignClone = z.object({
  name: z.string().min(1).max(120).optional(), // defaults server-side to "<source name> (copy)"
  mode: CampaignCloneMode.default('full'),
});

// ---------- character ----------
// characters.ownerUserId is stored as TEXT (it must also hold 'dev:<name>' dev-auth ids)
// while users.id / CampaignMember.userId are integers — the historical type mismatch of
// issue #32. Inputs accept either shape and normalize to the canonical string form
// (String(users.id)), so a DM can pass a member's numeric userId straight through.
export const UserIdRef = z.union([z.string().max(120), Id.transform((n) => String(n))]);

export const AbilityKey = z.enum(['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']);
export type AbilityKey = z.infer<typeof AbilityKey>;

/** Canonical ability keys in sheet order. */
export const ABILITY_KEYS = AbilityKey.options;

/**
 * Fold an ability-score record to canonical uppercase keys (STR/DEX/…). The stats
 * record is typed `z.record(z.string(), …)`, so any key case is schema-valid, and an
 * API/MCP writer may store lowercase keys (`{ str: 16 }`). Callers that look scores up
 * by canonical key — the character sheet, and the initiative engine's `stats.DEX` —
 * would otherwise miss every lowercase entry and read a default of 10 (issue #48).
 * An exact-uppercase key is authoritative, so a lowercase duplicate never clobbers it.
 */
export function normalizeStats(stats: Record<string, number> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!stats) return out;
  for (const [key, value] of Object.entries(stats)) {
    const upper = key.toUpperCase();
    if (upper in out && key !== upper) continue;
    out[upper] = value;
  }
  return out;
}

/** Skill proficiency rank; a skill absent from the record is unproficient. */
export const SkillRank = z.enum(['proficient', 'expertise']);
export type SkillRank = z.infer<typeof SkillRank>;

/** One row in the Actions card — attack, spell, or feature. toHit/damage are free text ("+5", "1d8+3 slashing") so non-attack actions stay valid. */
export const CharacterAction = z.object({
  name: z.string().min(1).max(120),
  kind: z.string().max(40).default(''), // "melee", "ranged", "spell", "feature"…
  toHit: z.string().max(20).default(''),
  damage: z.string().max(80).default(''),
  notes: z.string().max(500).default(''),
});
export type CharacterAction = z.infer<typeof CharacterAction>;

/** Slots at one spell level. `used` is clamped server-side to [0, max]. */
export const SpellSlotLevel = z.object({
  max: z.number().int().min(0).max(20),
  used: z.number().int().min(0).max(20).default(0),
});
export type SpellSlotLevel = z.infer<typeof SpellSlotLevel>;

export const Character = z.object({
  id: Id,
  campaignId: Id,
  // Owning player's user id as a string — String(users.id) for real accounts, 'dev:<name>'
  // under DEV_AUTH; null = DM-managed. Kept in sync with CampaignMember.characterId links
  // (linking a member to a character grants them ownership — see MembersService).
  ownerUserId: UserIdRef.nullable().default(null),
  name: z.string().min(1).max(120),
  species: z.string().max(80).default(''),
  className: z.string().max(80).default(''),
  level: z.number().int().min(1).max(20).default(1),
  xp: z.number().int().min(0).default(0),
  background: z.string().max(120).default(''),
  stats: z.record(z.string(), z.number().int()).default({}), // e.g. { STR: 8, DEX: 14 }
  ac: z.number().int().nullable().default(null),
  hpCurrent: z.number().int().default(10),
  hpMax: z.number().int().min(1).default(10),
  conditions: z.array(z.string().max(40)).default([]),
  saveProficiencies: z.array(AbilityKey).default([]), // abilities with saving-throw proficiency
  skills: z.record(z.string().max(40), SkillRank).default({}), // skill name -> rank; absent = unproficient
  actions: z.array(CharacterAction).max(100).default([]),
  spellSlots: z.record(z.string().regex(/^[1-9]$/), SpellSlotLevel).default({}), // spell level "1".."9" -> slots
  portraitUrl: z.string().max(500).nullable().default(null),
  ddbId: z.string().max(40).nullable().default(null),
  notes: z.string().max(20_000).default(''), // public character bio/story
  dmSecret: z.string().max(20_000).default(''), // DM only — stripped for non-DM (a secret curse, hidden true identity…)
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
/**
 * Canonical 5e condition vocabulary — the single source of truth shared across
 * the character sheet, the encounter tracker, and the compendium (issue #111).
 * Conditions stay free-text on the wire (homebrew is allowed), but these are the
 * standard names surfaced as suggestions so the three surfaces speak the same
 * vocabulary instead of each hardcoding its own list.
 */
export const CONDITIONS = [
  'Blinded',
  'Charmed',
  'Deafened',
  'Exhaustion',
  'Frightened',
  'Grappled',
  'Incapacitated',
  'Invisible',
  'Paralyzed',
  'Petrified',
  'Poisoned',
  'Prone',
  'Restrained',
  'Stunned',
  'Unconscious',
] as const;
export type ConditionName = (typeof CONDITIONS)[number];
/** Spend (+delta) or restore (-delta) slots at one level; `used` is clamped to [0, max]. Slot maxima are edited via PATCH `spellSlots`. */
export const SpellSlotPatch = z.object({
  level: z.number().int().min(1).max(9),
  delta: z.number().int(),
});
export const XpPatch = z.union([
  z.object({ delta: z.number().int() }),
  z.object({ set: z.number().int().nonnegative() }),
]);
/** DM party-wide XP award: amount to every character in the campaign, or just `characterIds`. */
export const XpAward = z.object({
  amount: z.number().int().min(1).max(1_000_000),
  characterIds: z.array(Id).min(1).optional(),
});
/**
 * Guided level-up: +1 level, optionally raising hpMax (hpCurrent grows by the
 * same amount — you gain the new hit points, existing damage stays).
 * Intentionally NOT gated on xp thresholds — milestone-levelling tables level
 * without XP, so the threshold check is advisory (see xpForLevel/levelForXp).
 */
export const LevelUp = z.object({
  hpMax: z.number().int().min(1).optional(),
});

/**
 * D&D 5e cumulative XP thresholds; XP_THRESHOLDS[n] = total XP required to be
 * level n+1 (so index 0 = level 1 at 0 XP, index 19 = level 20 at 355,000 XP).
 */
export const XP_THRESHOLDS = [
  0, 300, 900, 2_700, 6_500, 14_000, 23_000, 34_000, 48_000, 64_000, 85_000, 100_000, 120_000, 140_000, 165_000,
  195_000, 225_000, 265_000, 305_000, 355_000,
] as const;

/** Total XP required to reach `level` (clamped to [1, 20]). */
export function xpForLevel(level: number): number {
  return XP_THRESHOLDS[Math.max(1, Math.min(20, Math.floor(level))) - 1];
}

/** Highest level the given total XP qualifies for (1–20). */
export function levelForXp(xp: number): number {
  let level = 1;
  for (let i = 0; i < XP_THRESHOLDS.length; i++) {
    if (xp >= XP_THRESHOLDS[i]) level = i + 1;
  }
  return level;
}

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
  // Entity-level secrecy (issue #42): a hidden quest is excluded WHOLESALE from
  // every non-DM read (list/get/summary/export) — not merely dmSecret-redacted.
  // Default false = visible; the DM sets it true to prep future content, then
  // "reveals" by patching it back to false.
  hidden: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
  ...timestamps,
});
export type Quest = z.infer<typeof Quest>;
export const QuestCreate = Quest.omit({ id: true, campaignId: true, createdAt: true, updatedAt: true }).partial().required({ title: true });
export const QuestUpdate = QuestCreate.partial();
export const QuestStatusPatch = z.object({ status: QuestStatus });
export const ObjectiveCreate = z.object({ text: z.string().min(1).max(500), sortOrder: z.number().int().optional() });
export const ObjectivePatch = z.object({ text: z.string().min(1).max(500).optional(), done: z.boolean().optional(), sortOrder: z.number().int().optional() });
// Reorder a quest's objectives in one atomic call: `objectiveIds` must be a
// permutation of exactly that quest's current objective ids; the server assigns
// sortOrder by array index. Cleaner (and race-free) than N per-objective PATCHes.
export const ObjectiveReorder = z.object({ objectiveIds: z.array(Id).min(1) });
export type ObjectiveReorder = z.infer<typeof ObjectiveReorder>;

// "What changed since last session" (issue #66). `since` is the reference instant
// the diff was taken against — by default the campaign's latest session date
// (max of each session's playedAt, falling back to its createdAt), or the caller's
// explicit `?since=` override (e.g. the player's last visit). `quests` are the
// visible quests whose updatedAt is at/after `since`, in board order. `since` is
// null when the campaign has no sessions to diff against — then `quests` is empty.
// A quest is "new" when its createdAt is also at/after `since`, otherwise "changed"
// (the client derives this from the returned createdAt to keep the payload a plain
// Quest list). Respects redaction + hidden filtering like every other quest read.
export const QuestChanges = z.object({
  since: IsoDate.nullable(),
  quests: z.array(Quest),
});
export type QuestChanges = z.infer<typeof QuestChanges>;

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
  // Entity-level secrecy (issue #42) — see Quest.hidden. A hidden NPC is dropped
  // wholesale from every non-DM read until the DM reveals it (hidden=false).
  hidden: z.boolean().default(false),
  ...timestamps,
});
export type Npc = z.infer<typeof Npc>;
export const NpcCreate = Npc.omit({ id: true, campaignId: true, createdAt: true, updatedAt: true }).partial().required({ name: true });
export const NpcUpdate = NpcCreate.partial();

// ---------- location ----------
// Entity-level secrecy (issue #42) reuses `status` rather than adding a separate
// `hidden` flag (reconcile, don't duplicate): an `unexplored` location is the
// DM's un-revealed prep and is dropped wholesale from every non-DM read
// (list/get/summary/export). The DM "reveals" it via the existing discovery
// action (POST /locations/:id/discover → explored|current).
export const LocationStatus = z.enum(['unexplored', 'explored', 'current']);

export const Location = z.object({
  id: Id,
  campaignId: Id,
  parentId: Id.nullable().default(null), // nesting: region→city→dungeon→room (#99)
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
  dmSecret: z.string().max(20_000).default(''), // DM only — stripped for non-DM (session prep notes)
  ...timestamps,
});
export type Session = z.infer<typeof Session>;
export const SessionCreate = Session.omit({ id: true, campaignId: true, createdAt: true, updatedAt: true }).partial().required({ number: true });
export const SessionUpdate = SessionCreate.partial();

// The list-shape of a session (issue #71): a session's `recap` markdown can be up
// to 100KB, so list/summary payloads deliberately DROP the full body and carry a
// short plain-text `recapExcerpt` instead — a 150-session campaign's list stays
// small. Fetch the full recap with GET /sessions/:id when a single session is opened.
export const SessionListItem = Session.omit({ recap: true }).extend({
  recapExcerpt: z.string().default(''),
});
export type SessionListItem = z.infer<typeof SessionListItem>;

// The canonical recap scaffold — the structured headings a DM fills instead of
// staring at a blank box. Shared by the web "Insert template" affordance and the
// MCP `draft_session_recap` tool so a hand-written recap and an AI-drafted one
// use the same shape. Headings are `##` so they render under the recap's own
// `#`/title in the Markdown viewer.
export const RECAP_HEADINGS = ['Recap', 'Loot', 'NPCs met', 'Cliffhanger'] as const;
export const RECAP_TEMPLATE = RECAP_HEADINGS.map((h) => `## ${h}\n\n`).join('').trimEnd() + '\n';

// ---------- session share links (public read-only recap access) ----------
// A DM-minted, unguessable capability URL for one session recap — viewable
// without an account (absent players). The raw token is returned ONCE at
// creation and stored hashed (sha256), same policy as PATs; deleting the row
// revokes the link.
export const SessionShare = z.object({
  id: Id,
  sessionId: Id,
  campaignId: Id,
  createdBy: z.string().max(200).default(''), // user id or token name, display/audit only
  tokenPrefix: z.string().max(16), // display only, e.g. cf_share_9f2a
  ...timestamps,
});
export type SessionShare = z.infer<typeof SessionShare>;
export const SessionShareCreated = z.object({ token: z.string(), share: SessionShare });
export type SessionShareCreated = z.infer<typeof SessionShareCreated>;

// Payload served by the UNauthenticated GET /shared/recaps/:token endpoint.
// Deliberately minimal — no internal ids, no dmSecret-bearing entities, just
// what an absent player needs to catch up on the session.
export const SharedRecap = z.object({
  campaignName: z.string(),
  sessionNumber: z.number().int().positive(),
  title: z.string().default(''),
  playedAt: IsoDate.nullable().default(null),
  recap: z.string().default(''),
});
export type SharedRecap = z.infer<typeof SharedRecap>;

// ---------- session scheduling (next session + availability + ICS feed) ----------
// A ScheduledSession is a *future* (planned) game night — distinct from Session
// above, which is the play log/recap of a session that already happened.
const IsoDateTime = z
  .string()
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), 'expected an ISO-8601 date-time'); // normalized to UTC server-side

export const ScheduledSession = z.object({
  id: Id,
  campaignId: Id,
  scheduledAt: IsoDateTime, // when the session starts (stored as ISO UTC)
  durationMinutes: z.number().int().min(15).max(24 * 60).default(240), // drives DTEND in the ICS feed
  title: z.string().max(200).default(''),
  location: z.string().max(200).default(''), // "Sam's place", a VTT link…
  notes: z.string().max(5000).default(''),
  ...timestamps,
});
export type ScheduledSession = z.infer<typeof ScheduledSession>;
export const ScheduledSessionCreate = ScheduledSession.omit({ id: true, campaignId: true, createdAt: true, updatedAt: true }).partial().required({ scheduledAt: true });
export const ScheduledSessionUpdate = ScheduledSessionCreate.partial();

export const RsvpStatus = z.enum(['yes', 'no', 'maybe']);
export type RsvpStatus = z.infer<typeof RsvpStatus>;

export const SessionRsvp = z.object({
  id: Id,
  scheduledSessionId: Id,
  userId: z.string().max(120), // same shape as Note.authorUserId (String(users.id) or dev user)
  userName: z.string().max(120).default(''), // denormalized for display
  status: RsvpStatus,
  note: z.string().max(500).default(''), // "might be 30min late"
  ...timestamps,
});
export type SessionRsvp = z.infer<typeof SessionRsvp>;
export const RsvpSet = z.object({ status: RsvpStatus, note: z.string().max(500).optional() });
export type RsvpSet = z.infer<typeof RsvpSet>;

export const ScheduledSessionWithRsvps = ScheduledSession.extend({ rsvps: z.array(SessionRsvp) });
export type ScheduledSessionWithRsvps = z.infer<typeof ScheduledSessionWithRsvps>;

// Per-campaign ICS calendar feed. `token` is an unguessable capability secret
// (cf_ics_<48 hex>) baked into the feed URL; null = feed disabled. Any member
// may read it (the feed only exposes schedule data members already see);
// enable/rotate/disable is DM-only.
export const CalendarFeed = z.object({
  token: z.string().nullable(),
  url: z.string().nullable(), // relative feed path, e.g. /api/v1/calendar/<token>.ics
});
export type CalendarFeed = z.infer<typeof CalendarFeed>;

// ---------- timeline (in-world calendar / campaign timeline) — issue #63 ----------
// The real-world Session.playedAt tells you WHEN a table met; it says nothing about
// the in-fiction date ("the 3rd of Flamerule, 1492 DR"). This is a standalone module:
// a DM sequences in-world events on a campaign timeline, each carrying a free-text
// in-world date (fantasy calendars aren't ISO-parseable) plus a DM-controlled
// `sortIndex` so the timeline orders by narrative sequence, not by that unsortable
// string. Canon-entity secrecy conventions apply: `dmSecret` is stripped for non-DM,
// and a `hidden` event is dropped WHOLESALE from every non-DM read (prep for a reveal).
export const TimelineEvent = z.object({
  id: Id,
  campaignId: Id,
  title: z.string().min(1).max(200),
  // Free-text in-fiction date, e.g. "3rd of Flamerule, 1492 DR". Empty = undated
  // (a floating "sometime around here" beat the DM can still sequence via sortIndex).
  inWorldDate: z.string().max(200).default(''),
  body: z.string().max(50_000).default(''), // markdown
  // Optional era/age grouping ("Age of Chains", "Second Era") — a light bucket the
  // timeline view can header on; free text, no enum (every world names its ages).
  era: z.string().max(120).default(''),
  // DM-controlled ordering along the timeline. Free-text dates can't be sorted, so
  // the timeline reads by this (ascending), id as a stable tiebreaker.
  sortIndex: z.number().int().default(0),
  dmSecret: z.string().max(20_000).default(''), // DM only — stripped for non-DM
  // Entity-level secrecy (issue #42 convention): a hidden event is excluded WHOLESALE
  // from every non-DM read until the DM reveals it (hidden=false).
  hidden: z.boolean().default(false),
  ...timestamps,
});
export type TimelineEvent = z.infer<typeof TimelineEvent>;
export const TimelineEventCreate = TimelineEvent.omit({ id: true, campaignId: true, createdAt: true, updatedAt: true })
  .partial()
  .required({ title: true });
export type TimelineEventCreate = z.infer<typeof TimelineEventCreate>;
export const TimelineEventUpdate = TimelineEventCreate.partial();
export type TimelineEventUpdate = z.infer<typeof TimelineEventUpdate>;

// The "honest v0" from the issue: one free-text "current in-world date" per campaign
// ("It is presently the 3rd of Flamerule, 1492 DR"), plus an optional calendar note
// (month names, moon phases, whatever the DM wants to remember). Stored in the
// timeline module's own single-row-per-campaign table so it touches nothing else.
export const TimelineCalendar = z.object({
  campaignId: Id,
  currentDate: z.string().max(200).default(''),
  note: z.string().max(4000).default(''), // markdown — calendar reference / month list
  ...timestamps,
});
export type TimelineCalendar = z.infer<typeof TimelineCalendar>;
export const TimelineCalendarUpdate = z.object({
  currentDate: z.string().max(200).optional(),
  note: z.string().max(4000).optional(),
});
export type TimelineCalendarUpdate = z.infer<typeof TimelineCalendarUpdate>;

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
  // Display name of the anchored entity (quest title, npc/location/character/campaign
  // name, session title), resolved server-side at read time — not stored. Null when
  // the note is unanchored or the entity no longer exists.
  entityName: z.string().max(300).nullable().default(null),
  body: z.string().min(1).max(20_000),
  resolved: z.boolean().default(false), // inbox items only
  resolvedNote: z.string().max(1000).default(''),
  ...timestamps,
});
export type Note = z.infer<typeof Note>;
export const NoteCreate = Note.omit({ id: true, campaignId: true, authorUserId: true, entityName: true, createdAt: true, updatedAt: true, resolved: true, resolvedNote: true }).partial().required({ body: true });
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
export const InboxResolve = z
  .object({
    resolvedNote: z.string().max(1000).default(''),
    // Optional link to the entity this item was resolved into (drives the history view).
    entityType: EntityType.nullable().optional(),
    entityId: Id.nullable().optional(),
  })
  // Reject unknown keys (issue #131). This request-input schema is `.strict()` at
  // its source — unlike the entity Create/Update schemas (kept lenient and made
  // strict at the server DTO layer), this one is a `.refine()`-wrapped ZodEffects
  // with no `.strict()` to apply downstream, and it's a pure request DTO reused
  // nowhere as a pass-through (no MCP/proposal path), so tightening it here is safe.
  .strict()
  .refine((v) => (v.entityType == null) === (v.entityId == null), {
    message: 'entityType and entityId must be provided together',
  });

// ---------- notifications (in-app) ----------
// Per-user notification rows written by the server when something a member cares
// about happens while they're not looking: a session recap is posted, someone
// replies on a shared note thread (or the DM answers an inbox item), a player
// shares a note up to the DM (note_shared), they're added to a campaign, or the
// next session gets scheduled. Read via
// GET /notifications (own rows only); real-time push can layer on later — the
// store is plain rows, transport-agnostic.
export const NotificationType = z.enum(['recap_posted', 'note_reply', 'note_shared', 'added_to_campaign', 'session_scheduled']);
export type NotificationType = z.infer<typeof NotificationType>;

export const Notification = z.object({
  id: Id,
  userId: Id, // recipient (users.id) — never exposed to anyone but the recipient
  campaignId: Id,
  type: NotificationType,
  title: z.string().min(1).max(200),
  body: z.string().max(1000).default(''), // short excerpt/context, plain text
  entityType: EntityType.nullable().default(null), // deep-link target (e.g. session), if any
  entityId: Id.nullable().default(null),
  actorName: z.string().max(120).default(''), // display name of who triggered it
  readAt: IsoDate.nullable().default(null), // null = unread
  createdAt: IsoDate,
});
export type Notification = z.infer<typeof Notification>;

export const NotificationUnreadCount = z.object({ count: z.number().int().nonnegative() });
export type NotificationUnreadCount = z.infer<typeof NotificationUnreadCount>;

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

export const RuleEntryType = z.enum(['spell', 'monster', 'item', 'class', 'race', 'feat', 'condition', 'section', 'other']);
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
  sections: z.array(z.enum(['spells', 'monsters', 'items', 'conditions', 'classes', 'races', 'feats'])).optional(), // default: all
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
  sessions: z.array(SessionListItem), // list-shape (recapExcerpt, not full recap) — issue #71
  openInboxCount: z.number().int().nonnegative(),
});
export type CampaignSummary = z.infer<typeof CampaignSummary>;

// ---------- auth, users, settings, membership ----------
export const ServerRole = z.enum(['admin', 'user']);
export type ServerRole = z.infer<typeof ServerRole>;

// Hex color, e.g. #9184d9. Shared by User.accentColor and PreferencesUpdate below.
const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

// UI text-size preference. 'default' follows the design's base scale; 'large'
// scales the whole UI up for readability. Shared by User.textSize and
// PreferencesUpdate below.
export const TextSize = z.enum(['default', 'large']);
export type TextSize = z.infer<typeof TextSize>;

export const User = z.object({
  id: Id,
  username: z.string().min(2).max(60).regex(/^[a-z0-9_.-]+$/i, 'letters, numbers, _ . - only'),
  displayName: z.string().max(120).default(''),
  serverRole: ServerRole.default('user'),
  disabled: z.boolean().default(false),
  // Personal accent color override (per-user UI theming). null = follow the server default (Nocturne blurple).
  accentColor: HexColor.nullable().default(null),
  // Personal text-size preference (per-user UI scaling).
  textSize: TextSize.default('default'),
  ...timestamps,
}); // passwordHash never leaves the server
export type User = z.infer<typeof User>;

export const Password = z.string().min(8).max(200);
export const SetupRequest = z.object({ username: User.shape.username, password: Password, displayName: z.string().max(120).optional() });
// password capped at 200 (matches `Password` above) — an unbounded string on this
// UNauthenticated path would let a caller force the server to run scrypt (CPU-heavy)
// against an arbitrarily large input before verifyPassword() even gets to reject it.
export const LoginRequest = z.object({ username: z.string().min(1), password: z.string().min(1).max(200) });
export const UserCreate = z.object({ username: User.shape.username, password: Password, displayName: z.string().max(120).optional(), serverRole: ServerRole.optional() });
// Self-service signup (POST /auth/signup) — same shape as SetupRequest, but the created
// account is always serverRole 'user' (never admin) and the route is gated on allowSignup.
export const SignupRequest = z.object({ username: User.shape.username, password: Password, displayName: z.string().max(120).optional() });
export const UserUpdate = z.object({ displayName: z.string().max(120).optional(), serverRole: ServerRole.optional(), disabled: z.boolean().optional() });
export const PasswordChange = z.object({ currentPassword: z.string().optional(), newPassword: Password }); // current required for self-change; admin reset omits

// Self-service preferences (PATCH /me/preferences) — separate from admin-only UserUpdate above.
export const PreferencesUpdate = z.object({
  displayName: z.string().max(120).optional(),
  accentColor: HexColor.nullable().optional(),
  textSize: TextSize.optional(),
});
export type PreferencesUpdate = z.infer<typeof PreferencesUpdate>;

// ---------- forgot-password / self-service reset ----------
// The server may have no mail transport, so the reset path is admin-approved:
// a user files a reset request from the login screen (POST /auth/reset-request,
// @Public — always 202, no user-enumeration signal), a server admin approves it
// and receives a ONE-TIME reset code (stored hashed, short expiry) to hand to
// the user out-of-band, and the user redeems it (POST /auth/reset-confirm) to
// set a new password without the admin ever learning it.
export const PasswordResetRequestCreate = z.object({ username: z.string().min(1).max(60) });
export type PasswordResetRequestCreate = z.infer<typeof PasswordResetRequestCreate>;

export const PasswordResetStatus = z.enum(['pending', 'approved']);
export type PasswordResetStatus = z.infer<typeof PasswordResetStatus>;

export const PasswordResetRequest = z.object({
  id: Id,
  userId: Id,
  username: z.string().default(''), // denormalized for display
  displayName: z.string().default(''),
  status: PasswordResetStatus,
  requestedAt: IsoDate,
  approvedAt: IsoDate.nullable().default(null),
  expiresAt: IsoDate.nullable().default(null), // set when approved — code is dead past this
}); // codeHash never leaves the server
export type PasswordResetRequest = z.infer<typeof PasswordResetRequest>;

// Admin approval response — `code` is returned ONCE, stored hashed.
export const PasswordResetApproval = z.object({ code: z.string(), expiresAt: IsoDate, request: PasswordResetRequest });
export type PasswordResetApproval = z.infer<typeof PasswordResetApproval>;

// code capped like passwords — this is an UNauthenticated path (see LoginRequest note above).
export const PasswordResetConfirm = z.object({ code: z.string().min(1).max(200), newPassword: Password });
export type PasswordResetConfirm = z.infer<typeof PasswordResetConfirm>;

export const AuthStatus = z.object({
  setupRequired: z.boolean(), // true until the first (admin) user exists
  localLoginEnabled: z.boolean(), // for non-admin users (admins can always log in locally)
  signupEnabled: z.boolean(), // effective: allowSignup && allowLocalLogin && !setupRequired
  oidcEnabled: z.boolean(), // future
  version: z.string(),
});
export type AuthStatus = z.infer<typeof AuthStatus>;

export const ServerSettings = z.object({
  allowLocalLogin: z.boolean().default(true), // gate for non-admin local login
  allowSignup: z.boolean().default(false), // gate for self-service signup (POST /auth/signup) — off by default
  // Experimental server-side AI Dungeon Master (issue #28) — OFF by default. When
  // false, every AI-DM configure/turn path is 403-gated server-wide, so the feature
  // is inert until an admin opts the whole server in. See modules/ai-dm.
  experimentalAiDm: z.boolean().default(false),
});
export type ServerSettings = z.infer<typeof ServerSettings>;
export const SettingsUpdate = ServerSettings.partial();

// ── OIDC / SSO in-app configuration (server-admin only) ──────────────────────
// Persisted alongside server settings so OIDC can be configured from the admin
// UI, not only via env vars. Precedence: an OIDC_* env var, when set, OVERRIDES
// the stored value for that field (see server oidc.config.ts). The client
// secret is WRITE-ONLY — it is accepted on update but never returned.
const OidcField = z.string().trim().max(2048);

/** OIDC settings as returned to admins (GET). Never includes the client secret. */
export const OidcSettings = z.object({
  issuer: z.string(),
  clientId: z.string(),
  redirectUri: z.string(),
  adminGroup: z.string(),
  allowedGroup: z.string(),
  groupsClaim: z.string(),
  scope: z.string(),
  // Server-computed, read-only:
  clientSecretSet: z.boolean(), // a secret is stored or set via env (value never returned)
  enabled: z.boolean(), // effective config is complete (issuer + clientId + clientSecret all resolve)
  envKeys: z.array(z.string()), // OIDC_* env vars currently set — these override the stored values
  effectiveRedirectUri: z.string(), // the callback URL the flow will actually use
});
export type OidcSettings = z.infer<typeof OidcSettings>;

/** Admin update payload. All fields optional. clientSecret is write-only: omit to keep the current secret, pass '' to clear it. */
export const OidcSettingsUpdate = z.object({
  issuer: OidcField.optional(),
  clientId: OidcField.optional(),
  clientSecret: z.string().max(2048).optional(),
  redirectUri: OidcField.optional(),
  adminGroup: OidcField.optional(),
  allowedGroup: OidcField.optional(),
  groupsClaim: OidcField.optional(),
  scope: OidcField.optional(),
});
export type OidcSettingsUpdate = z.infer<typeof OidcSettingsUpdate>;

/** Test-connection request. Optional issuer lets an admin validate before saving; omitted = test the effective issuer. */
export const OidcTestRequest = z.object({ issuer: OidcField.optional() });
export type OidcTestRequest = z.infer<typeof OidcTestRequest>;

/** Result of fetching + validating the issuer's OIDC discovery document. */
export const OidcTestResult = z.object({
  ok: z.boolean(),
  issuer: z.string(),
  message: z.string(),
  authorizationEndpoint: z.string().nullable().default(null),
  tokenEndpoint: z.string().nullable().default(null),
});
export type OidcTestResult = z.infer<typeof OidcTestResult>;

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

// ---------- campaign invites (DM invite links / join codes) ----------
// A DM-generated, shareable link that onboards a player without a server admin:
// whoever opens /join/<code> creates their own account (or joins with an existing
// one) and lands in the campaign at the role the DM chose. Never grants 'dm' —
// a leaked link must not hand out DM power. Codes are unguessable (128-bit
// random), expiring, optionally use-capped, and revocable by the DM.
export const InviteRole = z.enum(['player', 'viewer']);
export type InviteRole = z.infer<typeof InviteRole>;

export const CampaignInvite = z.object({
  id: Id,
  campaignId: Id,
  code: z.string(), // join code — the shareable link is <origin>/join/<code>
  role: InviteRole,
  createdByUserId: Id.nullable().default(null),
  expiresAt: IsoDate,
  maxUses: z.number().int().positive().nullable().default(null), // null = unlimited (until expiry/revocation)
  useCount: z.number().int().nonnegative().default(0),
  ...timestamps,
});
export type CampaignInvite = z.infer<typeof CampaignInvite>;

export const InviteCreate = z.object({
  role: InviteRole.default('player'),
  expiresInDays: z.number().int().min(1).max(365).default(7), // invites always expire — default one week
  maxUses: z.number().int().min(1).max(1000).nullable().optional(),
});
export type InviteCreate = z.infer<typeof InviteCreate>;

// Public preview of a valid invite (GET /invites/:code) — just enough for the
// join page to say what you're joining and as what. campaignId is included so
// the web app can navigate to /c/:id after joining.
export const InvitePreview = z.object({
  campaignId: Id,
  campaignName: z.string(),
  role: InviteRole,
  expiresAt: IsoDate,
});
export type InvitePreview = z.infer<typeof InvitePreview>;

// Accept an invite as a brand-new user (POST /invites/:code/accept, @Public):
// creates the account AND the membership in one call, then starts a session.
export const InviteAccept = z.object({
  username: User.shape.username,
  password: Password,
  displayName: z.string().max(120).optional(),
});
export type InviteAccept = z.infer<typeof InviteAccept>;

// Present on Me only when the request authenticated via a PAT (Authorization:
// Bearer cf_pat_...). Describes what THAT token can actually do, so /me is
// truthful for debugging scoped AI access (issue #55): `scope` caps every
// per-campaign role, `campaignId` (when set) restricts the token to one
// campaign, and `serverAdmin` is the token's EFFECTIVE server-admin power
// (owner is a server admin AND the token was minted adminEnabled) — see
// hasServerAdminPower() on the server.
export const MeToken = z.object({
  tokenId: Id,
  name: z.string(),
  scope: Role,
  campaignId: Id.nullable(),
  adminEnabled: z.boolean(),
  serverAdmin: z.boolean(),
});
export type MeToken = z.infer<typeof MeToken>;

export const Me = z.object({
  user: User,
  // When `token` is present (PAT auth), memberships reflect the token's
  // EFFECTIVE view: role is capped to min(token scope, membership role) and a
  // campaign-bound token only lists that campaign. Cookie sessions see raw
  // membership roles and no `token` field.
  memberships: z.array(z.object({ campaignId: Id, role: Role, characterId: Id.nullable() })),
  token: MeToken.optional(),
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
  // Whether this token may exercise SERVER-admin powers (ServerRolesGuard-gated routes,
  // install_rule_pack, etc) on behalf of an admin owner. Independent of `scope`, which
  // only caps per-campaign role — see RoleResolver / user.types.ts hasServerAdminPower().
  // Default false: a token minted without this explicitly set is never server-admin-capable,
  // even if its owner is a server admin. Only a caller who is CURRENTLY exercising real
  // server-admin power may mint a token with this true (TokensService.create).
  adminEnabled: z.boolean().default(false),
  tokenPrefix: z.string().max(12), // display only, e.g. cf_pat_9f2a
  lastUsedAt: IsoDate.nullable().default(null),
  ...timestamps,
}); // raw token is returned ONCE at creation, stored hashed
export type ApiToken = z.infer<typeof ApiToken>;
export const ApiTokenCreate = z.object({
  name: z.string().min(1).max(80),
  // When the caller is itself authenticated via a PAT, both scope and campaignId are
  // additionally capped to the CALLING token (TokensService.create): scope is silently
  // downgraded to min(requested, calling token's scope), and a campaign-bound calling
  // token can only mint tokens bound to that same campaign — a scoped-down token can
  // never mint a broader sibling.
  scope: TokenScope,
  campaignId: Id.nullable().optional(),
  adminEnabled: z.boolean().optional(), // requires the caller to currently hold real server-admin power; silently forced false otherwise
});
export const ApiTokenCreated = z.object({ token: z.string(), apiToken: ApiToken });

// Headless PAT bootstrap (POST /auth/token, @Public): verifies credentials in the
// same call that mints the token, so an AI agent can go from nothing to a working
// Bearer token in one round trip, no cookie/session dance required.
export const AuthTokenRequest = z.object({
  username: z.string().min(1),
  password: z.string().min(1).max(200), // same cap as LoginRequest.password — scrypt DoS guard on an unauthenticated path
  tokenName: z.string().min(1).max(80),
  scope: TokenScope.optional(), // default: 'viewer' (least privilege) — see TokensService.mintFor
  campaignId: Id.nullable().optional(),
  adminEnabled: z.boolean().optional(), // caller (the just-authenticated user) must currently be a server admin — see TokensService.create
});
export type AuthTokenRequest = z.infer<typeof AuthTokenRequest>;

// Admin provisioning (POST /users/:id/tokens, server-admin only): mint a PAT on
// behalf of another user. No username/password — the admin's own session/PAT is
// the credential; scope/campaignId are validated against the TARGET user's access.
export const AdminTokenCreate = z.object({
  tokenName: z.string().min(1).max(80),
  scope: TokenScope.optional(), // default: 'viewer'
  campaignId: Id.nullable().optional(),
  // May only be set true when the TARGET user (owner of the minted token) is themself
  // a server admin, AND the calling admin currently holds real (non-token-capped)
  // server-admin power — see UsersController.mintToken() / TokensService.create.
  adminEnabled: z.boolean().optional(),
});
export type AdminTokenCreate = z.infer<typeof AdminTokenCreate>;

// ---------- proposals (AI/collab writes pending DM approval) ----------
export const ProposalAction = z.enum(['create', 'update', 'delete']);
export const ProposalStatus = z.enum(['pending', 'approved', 'rejected']);

export const Proposal = z.object({
  id: Id,
  campaignId: Id,
  entityType: EntityType,
  entityId: Id.nullable().default(null), // null for creates
  action: ProposalAction,
  payload: z.record(z.string(), z.unknown()), // the Create/Update body that would have been applied
  // The target entity's state captured at propose time (update proposals only; null for
  // creates) — lets the DM review UI render a real before/after diff even if the entity
  // changes between propose and review.
  snapshot: z.record(z.string(), z.unknown()).nullable().default(null),
  proposer: z.string().max(200), // user id or token name
  status: ProposalStatus.default('pending'),
  resolvedBy: z.string().max(200).default(''),
  note: z.string().max(1000).default(''),
  ...timestamps,
});
export type Proposal = z.infer<typeof Proposal>;
export const ProposalResolve = z.object({ note: z.string().max(1000).optional() });
// Approve may carry an amended `payload` (edit-before-approve): the DM tweaks the
// proposed create/update body before it's applied through the normal write path.
// Ignored for `delete` proposals (which carry no payload). Omit `payload` to apply
// the proposal exactly as submitted.
export const ProposalApprove = z.object({
  note: z.string().max(1000).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type ProposalApprove = z.infer<typeof ProposalApprove>;
// Batch resolve: approve or reject up to 100 pending proposals in one request. Each
// id is resolved independently through the same atomic approve/reject path, so the
// response reports per-id success/failure rather than failing the whole batch.
export const ProposalBatchResolve = z.object({
  ids: z.array(Id).min(1).max(100),
  note: z.string().max(1000).optional(),
});
export type ProposalBatchResolve = z.infer<typeof ProposalBatchResolve>;

// ---------- experimental: server-side AI Dungeon Master (issue #28) ----------
// Plumbing for an AI that holds the DM seat of a campaign: everyone else plays,
// a connected agent (over MCP or REST, authenticated with a dm-scoped PAT) drives
// the existing tool layer — narrating, running combat, writing recaps. It is
// deliberately MCP-FIRST and self-hosted: Campfire ships NO server-side LLM
// dependency and never calls a vendor. The narration text is produced by an
// injected AiDmProvider (server DI seam) whose shipped default is a no-op that
// returns a scaffold response and instructs the operator to point the seat at a
// connected agent — an operator may swap in their own provider. Gated twice: the
// server-wide experimental flag (ServerSettings.experimentalAiDm) AND the
// per-campaign seat's `enabled`. Every turn is metered against a per-campaign
// token budget and audited as `ai-dm`.
export const AiDmTurnKind = z.enum(['narrate', 'combat', 'recap']);
export type AiDmTurnKind = z.infer<typeof AiDmTurnKind>;

// One AI-DM "seat" per campaign (created lazily on first configure/read).
export const AiDmSeat = z.object({
  campaignId: Id,
  enabled: z.boolean().default(false), // per-campaign on/off (in addition to the server flag)
  model: z.string().max(120).default(''), // informational label of the model/agent occupying the seat
  instructions: z.string().max(20_000).default(''), // the DM persona / house rules the connected agent should follow
  // Per-campaign metering, in tokens. tokenBudget is a HARD cap: a turn whose cost
  // would push tokensUsed past it is rejected (403). 0 = no budget → no turns allowed
  // (a positive budget must be configured to run the seat).
  tokenBudget: z.number().int().nonnegative().max(1_000_000_000).default(0),
  tokensUsed: z.number().int().nonnegative().default(0),
  turnCount: z.number().int().nonnegative().default(0),
  lastTurnAt: IsoDate.nullable().default(null),
  ...timestamps,
});
export type AiDmSeat = z.infer<typeof AiDmSeat>;

// Configure the seat (PUT /campaigns/:id/ai-dm, dm only). All fields optional;
// an omitted field is left unchanged.
export const AiDmSeatUpdate = z.object({
  enabled: z.boolean().optional(),
  model: z.string().max(120).optional(),
  instructions: z.string().max(20_000).optional(),
  tokenBudget: z.number().int().min(0).max(1_000_000_000).optional(),
});
export type AiDmSeatUpdate = z.infer<typeof AiDmSeatUpdate>;

// Ask the AI DM to take a turn (POST /campaigns/:id/ai-dm/turn, dm only, or the
// MCP ai_dm_narrate tool). `prompt` is the situation/what the players just did.
export const AiDmTurnRequest = z.object({
  prompt: z.string().min(1).max(20_000),
  kind: AiDmTurnKind.default('narrate'),
  maxTokens: z.number().int().min(1).max(4096).optional(), // cap on this turn's output; provider clamps to the remaining budget
});
export type AiDmTurnRequest = z.infer<typeof AiDmTurnRequest>;

export const AiDmTurnResult = z.object({
  narration: z.string(), // the DM's response text (from the configured provider; the default is a no-op scaffold)
  provider: z.string(), // which provider produced it ('noop' by default)
  kind: AiDmTurnKind,
  tokensUsed: z.number().int().nonnegative(), // this turn's cost
  tokenBudget: z.number().int().nonnegative(), // the seat's cap
  budgetRemaining: z.number().int().nonnegative(), // after this turn
  seat: AiDmSeat, // the seat after metering
});
export type AiDmTurnResult = z.infer<typeof AiDmTurnResult>;

// ---------- attachments (uploaded images: character portraits, campaign maps) ----------
export const AttachmentKind = z.enum(['portrait', 'map', 'image']);

export const Attachment = z.object({
  id: Id,
  campaignId: Id,
  uploaderUserId: z.string().max(120), // OIDC sub or dev user; audit/ownership (delete-by-uploader)
  kind: AttachmentKind,
  filename: z.string().max(255), // original client filename, display only
  mime: z.string().max(80),
  size: z.number().int().nonnegative(), // bytes
  // Per-attachment visibility / staged reveal (issue #97). `hidden` gates the file
  // bytes AND the row itself: a hidden attachment is DM-only — non-DM members get a
  // 404 on GET /attachments/:id/file and never see it in the campaign list, so an
  // uploaded-but-unrevealed handout (next-arc dungeon map, reveal art) can't be
  // fetched by id enumeration. New 'map'/'image' uploads default hidden=true (DM
  // prep material); 'portrait' uploads default hidden=false (player-visible). The
  // DM stages the reveal moment via POST /attachments/:id/reveal (hidden=false).
  hidden: z.boolean().default(false),
  ...timestamps,
});
export type Attachment = z.infer<typeof Attachment>;

// ---------- encounters (combat tracker) ----------
export const EncounterStatus = z.enum(['preparing', 'running', 'ended']);
export type EncounterStatus = z.infer<typeof EncounterStatus>;

export const Encounter = z.object({
  id: Id,
  campaignId: Id,
  name: z.string().min(1).max(120),
  status: EncounterStatus.default('preparing'),
  round: z.number().int().nonnegative().default(0),
  // Positional turn cursor, kept in lockstep with `currentCombatantId` as a
  // display/back-compat convenience — it is the index of the current combatant in
  // the server-sorted order. `currentCombatantId` is the AUTHORITATIVE pointer
  // (issue #49): a positional index alone corrupts when a combatant is added or
  // removed mid-fight (everyone after the removed row shifts a slot and the
  // "current turn" highlight jumps to the wrong creature). null = no current
  // combatant (not running, or the encounter is empty).
  turnIndex: z.number().int().nonnegative().default(0),
  currentCombatantId: Id.nullable().default(null),
  endedAt: IsoDate.nullable().default(null),
  ...timestamps,
});
export type Encounter = z.infer<typeof Encounter>;
export const EncounterCreate = z.object({ name: z.string().min(1).max(120) });

export const CombatantKind = z.enum(['character', 'monster']);
export type CombatantKind = z.infer<typeof CombatantKind>;

/**
 * Coarse HP status band shown to non-DM viewers in place of a monster's exact HP
 * (issue #43). `down` = 0 HP; `critical` <= 25%; `bloodied` <= 50%; `healthy`
 * above. Null for combatants whose exact HP is visible (characters, or any
 * combatant when the DM is viewing).
 */
export const HpBand = z.enum(['healthy', 'bloodied', 'critical', 'down']);
export type HpBand = z.infer<typeof HpBand>;

export const Combatant = z.object({
  id: Id,
  encounterId: Id,
  kind: CombatantKind,
  characterId: Id.nullable().default(null),
  name: z.string().min(1).max(120),
  initiative: z.number().int().nullable().default(null),
  initMod: z.number().int().default(0),
  // Nullable so a monster's exact HP can be redacted to `null` for non-DM viewers
  // (issue #43); `hpBand` then carries the coarse status instead.
  hpCurrent: z.number().int().nullable().default(10),
  hpMax: z.number().int().min(1).nullable().default(10),
  hpBand: HpBand.nullable().default(null),
  conditions: z.array(z.string().max(40)).default([]),
  ruleEntryId: Id.nullable().default(null),
  sortOrder: z.number().int().default(0),
});
export type Combatant = z.infer<typeof Combatant>;

export const CombatantCreate = z.object({
  kind: CombatantKind,
  name: z.string().min(1).max(120).optional(), // required unless resolvable from ruleEntryId
  characterId: Id.optional(), // link a late-joining party member
  ruleEntryId: Id.optional(),
  hpMax: z.number().int().min(1).optional(),
  initMod: z.number().int().optional(),
});
export const CombatantUpdate = z.object({
  hpDelta: z.number().int().optional(),
  hpSet: z.number().int().nonnegative().optional(),
  addConditions: z.array(z.string().max(40)).optional(),
  removeConditions: z.array(z.string().max(40)).optional(),
  initiative: z.number().int().optional(), // dm only, enforced server-side
});

export const EncounterWithCombatants = Encounter.extend({ combatants: z.array(Combatant) });
export type EncounterWithCombatants = z.infer<typeof EncounterWithCombatants>;

// ---------- inventory & loot (party treasury + per-character items) ----------
export const ItemOwnerType = z.enum(['party', 'character']);
export type ItemOwnerType = z.infer<typeof ItemOwnerType>;

export const InventoryItem = z.object({
  id: Id,
  campaignId: Id,
  ownerType: ItemOwnerType.default('party'),
  characterId: Id.nullable().default(null), // set iff ownerType='character'
  name: z.string().min(1).max(200),
  qty: z.number().int().min(0).default(1),
  notes: z.string().max(5_000).default(''),
  ...timestamps,
});
export type InventoryItem = z.infer<typeof InventoryItem>;
export const InventoryItemCreate = InventoryItem.omit({ id: true, campaignId: true, createdAt: true, updatedAt: true }).partial().required({ name: true });
export const InventoryItemUpdate = InventoryItemCreate.partial();

// Party treasury — one row of coin totals per campaign (cp/sp/ep/gp/pp).
const Coin = z.number().int().nonnegative();
export const Treasury = z.object({
  campaignId: Id,
  cp: Coin.default(0),
  sp: Coin.default(0),
  ep: Coin.default(0),
  gp: Coin.default(0),
  pp: Coin.default(0),
  updatedAt: IsoDate,
});
export type Treasury = z.infer<typeof Treasury>;
// Union like HpPatch: { delta } (relative, may be negative but result must stay >= 0)
// or { set } (absolute). Omitted denominations are left untouched.
export const TreasuryPatch = z.union([
  z.object({
    delta: z.object({
      cp: z.number().int().optional(),
      sp: z.number().int().optional(),
      ep: z.number().int().optional(),
      gp: z.number().int().optional(),
      pp: z.number().int().optional(),
    }),
  }),
  z.object({
    set: z.object({ cp: Coin.optional(), sp: Coin.optional(), ep: Coin.optional(), gp: Coin.optional(), pp: Coin.optional() }),
  }),
]);
export type TreasuryPatch = z.infer<typeof TreasuryPatch>;

// ---------- dice rolling ----------
// Safe, restricted dice expression: NdM optionally followed by +K or -K, e.g. "1d20+3", "2d6-1", "d20".
export const DiceExprPattern = /^\s*(\d{1,2})?d(\d{1,3})\s*([+-]\s*\d{1,3})?\s*$/i;
export const RollRequest = z.object({
  expr: z.string().min(1).max(40).regex(DiceExprPattern, 'expected NdM+K, e.g. "1d20+3"'),
});
export type RollRequest = z.infer<typeof RollRequest>;
export const RollResult = z.object({
  expr: z.string(),
  rolls: z.array(z.number().int()),
  total: z.number().int(),
});
export type RollResult = z.infer<typeof RollResult>;

// ---------- real-time campaign events (SSE) ----------
// Thin invalidation signals pushed over GET /campaigns/:id/events — they carry ids, not
// entity payloads, so clients refetch through the normal (permission-checked) REST reads.
export const CampaignEventType = z.enum(['encounter.updated', 'encounter.deleted']);
export type CampaignEventType = z.infer<typeof CampaignEventType>;
export const CampaignEvent = z.object({
  type: CampaignEventType,
  campaignId: Id,
  encounterId: Id,
  at: IsoDate,
});
export type CampaignEvent = z.infer<typeof CampaignEvent>;

// A persisted, campaign-shared dice roll (issue #35): RollResult plus authorship +
// timestamp. Rolls are stored server-side so every campaign member sees the same
// feed — POST /campaigns/:id/roll returns one of these, and GET /campaigns/:id/rolls
// lists the recent history (polled by the web today; the same payload is what an
// SSE stream would push later).
export const DiceRoll = RollResult.extend({
  id: Id,
  campaignId: Id,
  rollerUserId: z.string().max(200), // RequestUser.id — String(users.id) or 'dev:<name>' / 'token:<name>' actors
  rollerName: z.string().max(200).default(''),
  createdAt: IsoDate,
});
export type DiceRoll = z.infer<typeof DiceRoll>;

// ---------- audit ----------
// Type aliases for enum/value exports (TS declaration merging: value + type share the name)
export type DangerLevel = z.infer<typeof DangerLevel>;
export type CampaignCloneMode = z.infer<typeof CampaignCloneMode>;
export type QuestStatus = z.infer<typeof QuestStatus>;
export type LocationStatus = z.infer<typeof LocationStatus>;
export type NoteVisibility = z.infer<typeof NoteVisibility>;
export type NoteKind = z.infer<typeof NoteKind>;
export type EntityType = z.infer<typeof EntityType>;
export type TokenScope = z.infer<typeof TokenScope>;
export type ProposalAction = z.infer<typeof ProposalAction>;
export type ProposalStatus = z.infer<typeof ProposalStatus>;
export type ApiTokenCreated = z.infer<typeof ApiTokenCreated>;
export type AttachmentKind = z.infer<typeof AttachmentKind>;

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

// ---------- admin observability (issue #22) ----------
// Server-wide operational snapshot for the admin console (GET /admin/metrics,
// @ServerRoles('admin')). Everything here is cheap to compute — COUNT(*) per
// table plus PRAGMA page_count/page_size for on-disk DB size — so the dashboard
// can be polled without straining the server. Nothing here is per-campaign or
// exposes story secrets: it's counts, sizes, uptime, and version only.

// COUNT(*) of each top-level entity. Kept as an explicit object (not a generic
// map) so the shape is typed end-to-end and the web dashboard can label each row.
export const AdminMetricsCounts = z.object({
  users: z.number().int().nonnegative(),
  campaigns: z.number().int().nonnegative(),
  characters: z.number().int().nonnegative(),
  npcs: z.number().int().nonnegative(),
  locations: z.number().int().nonnegative(),
  quests: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
  notes: z.number().int().nonnegative(),
  encounters: z.number().int().nonnegative(),
  attachments: z.number().int().nonnegative(),
  apiTokens: z.number().int().nonnegative(),
  rulePacks: z.number().int().nonnegative(),
  ruleEntries: z.number().int().nonnegative(),
});
export type AdminMetricsCounts = z.infer<typeof AdminMetricsCounts>;

export const AdminMetricsDatabase = z.object({
  sizeBytes: z.number().int().nonnegative(), // page_count * page_size (on-disk file size)
  pageCount: z.number().int().nonnegative(),
  pageSize: z.number().int().nonnegative(),
});
export type AdminMetricsDatabase = z.infer<typeof AdminMetricsDatabase>;

export const AdminMetrics = z.object({
  version: z.string(), // server package.json version (same source as /healthz)
  now: IsoDate, // server clock when this snapshot was taken
  startedAt: IsoDate, // process start (now - uptime)
  uptimeSeconds: z.number().nonnegative(),
  activeSessions: z.number().int().nonnegative(), // non-expired rows in user_sessions
  counts: AdminMetricsCounts,
  database: AdminMetricsDatabase,
  recentActivity: z.array(AuditEntry), // most-recent audit rows (read-only, newest first)
});
export type AdminMetrics = z.infer<typeof AdminMetrics>;

// ---------- storage management (issue #24) ----------
// Server-admin storage console: upload-size visibility, per-campaign quotas, and
// orphan cleanup. All surfaces are gated by @ServerRoles('admin'). Byte counts
// come from the attachments table (metadata) plus a walk of DATA_DIR/uploads.

// One campaign's slice of upload usage.
export const StorageCampaignUsage = z.object({
  campaignId: Id,
  name: z.string(),
  fileCount: z.number().int().nonnegative(), // attachment rows for this campaign
  totalBytes: z.number().int().nonnegative(), // sum of attachment.size for this campaign
  quotaBytes: z.number().int().nonnegative().nullable(), // per-campaign cap, or null for unlimited
  overQuota: z.boolean(), // totalBytes > quotaBytes (always false when unlimited)
});
export type StorageCampaignUsage = z.infer<typeof StorageCampaignUsage>;

// Orphans: DB rows whose bytes are missing on disk, and on-disk files with no row.
export const StorageOrphans = z.object({
  rowsWithoutFile: z.number().int().nonnegative(), // attachment rows whose file is gone from disk
  filesWithoutRow: z.number().int().nonnegative(), // upload files (incl. thumbs) with no backing row
  orphanBytes: z.number().int().nonnegative(), // bytes occupied by files-without-row (reclaimable)
});
export type StorageOrphans = z.infer<typeof StorageOrphans>;

export const StorageStats = z.object({
  totalBytes: z.number().int().nonnegative(), // sum of attachment.size across all campaigns (DB view)
  fileCount: z.number().int().nonnegative(), // total attachment rows
  diskBytes: z.number().int().nonnegative(), // actual bytes on disk under uploads/ (originals + thumbs)
  campaigns: z.array(StorageCampaignUsage), // per-campaign breakdown, largest first
  orphans: StorageOrphans,
});
export type StorageStats = z.infer<typeof StorageStats>;

// Set (or clear, with null) a campaign's upload quota.
export const StorageQuotaUpdate = z.object({
  quotaBytes: z.number().int().nonnegative().nullable(),
});
export type StorageQuotaUpdate = z.infer<typeof StorageQuotaUpdate>;

// Result of an orphan-cleanup run. With dryRun=true nothing is deleted and the
// *Deleted counts are 0 — only the found counts are populated, for a preview.
export const StorageCleanupResult = z.object({
  dryRun: z.boolean(),
  rowsWithoutFile: z.number().int().nonnegative(), // orphan rows found
  filesWithoutRow: z.number().int().nonnegative(), // orphan files found
  rowsDeleted: z.number().int().nonnegative(),
  filesDeleted: z.number().int().nonnegative(),
  bytesReclaimed: z.number().int().nonnegative(), // disk bytes freed by deleting orphan files
});
export type StorageCleanupResult = z.infer<typeof StorageCleanupResult>;

// ---------- campaign-wide search + @-mention cross-linking (issue #64) ----------
// The kinds of things a campaign-wide search can turn up. `campaign` from
// EntityType is deliberately excluded — a campaign never searches its own row,
// only the entities inside it — and `note` is added (notes are searchable but
// aren't a mention/link target).
export const SearchResultType = z.enum(['quest', 'npc', 'location', 'character', 'session', 'note']);
export type SearchResultType = z.infer<typeof SearchResultType>;

// A single hit. The service ONLY ever builds these from role-filtered lists
// (listForCampaign(role)), so a hidden quest/npc/unexplored location, a
// non-visible note, and every dmSecret are already stripped before a result
// object is ever constructed — hits never leak an entity the caller can't see.
export const SearchResult = z.object({
  type: SearchResultType,
  id: Id,
  campaignId: Id,
  title: z.string().default(''), // display name/title (session -> title || "Session N")
  snippet: z.string().default(''), // short excerpt around the first match
  matchedField: z.string().default(''), // which field matched (name/title/body/recap/notes…)
  // For a note anchored to another entity — lets the UI deep-link to the anchor
  // rather than the (page-less) note itself. Null for the entity types themselves.
  entityType: EntityType.nullable().default(null),
  entityId: Id.nullable().default(null),
});
export type SearchResult = z.infer<typeof SearchResult>;

export const SearchResponse = z.object({
  query: z.string(),
  results: z.array(SearchResult),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

// @-mention cross-linking: the set of named, page-backed entities a member may
// link to (and that the Markdown renderer may auto-link by name). Notes are
// excluded — they have no standalone page — so this is SearchResultType minus 'note'.
export const MentionTargetType = z.enum(['quest', 'npc', 'location', 'character', 'session']);
export type MentionTargetType = z.infer<typeof MentionTargetType>;

export const MentionTarget = z.object({
  type: MentionTargetType,
  id: Id,
  name: z.string(), // quest/session title, or entity name — what to match & display
});
export type MentionTarget = z.infer<typeof MentionTarget>;
