/**
 * Export profiles + redaction policy (issue #586).
 *
 * The campaign export used to have exactly one shape: a full DM backup. That is the
 * right artifact for "my server is dying, get me out", and exactly the wrong artifact
 * for "here is my dungeon, publish it" — it carries every member's user id, username
 * and display name, the exporting DM's private notes, whispers, the audit trail,
 * the proposal queue, RSVPs, attendance and AI/credential-ish configuration.
 *
 * This module defines three profiles and the single policy table that separates them:
 *
 *  - `backup`  — unchanged full-fidelity DM backup. Nothing is dropped or rewritten.
 *  - `handoff` — a new DM taking over the table. KEEPS play state and DM secrets
 *                (they need them to run the campaign) but DROPS member identities and
 *                operational history (audit, proposals, RSVPs, attendance, dice log,
 *                revision provenance) — the incoming DM inherits the world, not the
 *                previous group's paper trail.
 *  - `publish` — a redistributable adventure module. Everything identity- or
 *                operations-shaped is excluded by default; DM secrets, played state
 *                and player-authored content are explicit opt-ins.
 *
 * ── Allowlist, not denylist ────────────────────────────────────────────────────
 * Every non-backup profile projects each entity through an EXPLICIT PER-ENTITY FIELD
 * ALLOWLIST (see PUBLISHABLE_FIELDS). This is deliberate and must not be inverted.
 * With a denylist, every column a future migration adds to `npcs`/`characters`/…
 * silently ships in publish archives until somebody remembers to blocklist it. With
 * an allowlist a new column defaults to EXCLUDED, which is the only safe default for
 * a redaction feature: the failure mode is "a field is missing from a published
 * module" (visible, fixable) instead of "a field leaked" (invisible, permanent).
 *
 * If you add a column and want it published, add it to the allowlist below on purpose.
 */

import { createHmac, randomBytes } from 'node:crypto';

export const EXPORT_PROFILES = ['backup', 'handoff', 'publish'] as const;
export type ExportProfile = (typeof EXPORT_PROFILES)[number];

export const DEFAULT_EXPORT_PROFILE: ExportProfile = 'backup';

export function isExportProfile(value: unknown): value is ExportProfile {
  return typeof value === 'string' && (EXPORT_PROFILES as readonly string[]).includes(value);
}

/**
 * Opt-ins a DM can turn on for the `publish` profile. All three default to OFF —
 * a publishable module is a redaction feature, so the safe state is the default one.
 * `backup`/`handoff` have these fixed by their own policy row and ignore the flags.
 */
export type ExportProfileOptions = {
  /** Include `dmSecret` prose, the unrevealed/`hidden` staging flag, and dm_shared notes. */
  includeDmSecrets?: boolean;
  /** Include what actually happened at the table: recaps, played dates, live combat state. */
  includePlayedState?: boolean;
  /** Include participant-authored material: characters, comments, party notes, inventory, safety charter. */
  includePlayerContent?: boolean;
};

/**
 * The one place the three profiles differ. Everything downstream reads these
 * switches — no per-profile branching is allowed to grow anywhere else, so a
 * reviewer can see the whole redaction contract in a single table.
 */
export type ExportPolicySwitches = {
  /** Member roster + every `*UserId` / username / display-name field anywhere in the payload. */
  memberIdentities: boolean;
  /** Audit trail (`audit`, `auditMeta`, `auditNote`). */
  audit: boolean;
  /** Proposal queue (payloads carry arbitrary entity prose + proposer identity). */
  proposals: boolean;
  /** Scheduling + RSVPs, session attendance, dice log, prose revision provenance. */
  operationalHistory: boolean;
  /** `private` and `whisper` notes — one member's prose, never a campaign artifact. */
  privateNotes: boolean;
  /** Participant-authored content: characters, comments, party_shared notes, inventory, safety lines/veils. */
  playerContent: boolean;
  /** What happened at the table: recaps, playedAt, session count, live combat/exploration state. */
  playedState: boolean;
  /** `dmSecret` prose, the `hidden` reveal-staging flag, dm_shared notes. */
  dmSecrets: boolean;
  /** Capability/credential-shaped configuration (AI seat + scribe config, storage quota, sharing switches). */
  credentials: boolean;
  /** Project every entity through the per-entity field allowlist. */
  allowlistProjection: boolean;
  /** Replace retained author display names with per-export pseudonyms. */
  pseudonymizeAuthors: boolean;
  /** Rewrite attachment filenames to content-neutral `attachment-<id>.<ext>`. */
  neutralizeAttachmentFilenames: boolean;
  /** Sweep every serialized string for known private identifiers and redact them. */
  scanFreeText: boolean;
  /**
   * Strip image metadata (PNG ancillary chunks, JPEG APPn/COM) from embedded bytes,
   * and — when `requireSanitizedAttachments` is also set — omit the bytes of any
   * format whose metadata this codebase cannot provably strip.
   */
  sanitizeAttachmentBytes: boolean;
  /** Ship attachment bytes only for formats we can demonstrably sanitize (publish only). */
  requireSanitizedAttachments: boolean;
};

const BACKUP_SWITCHES: ExportPolicySwitches = {
  memberIdentities: true,
  audit: true,
  proposals: true,
  operationalHistory: true,
  privateNotes: true,
  playerContent: true,
  playedState: true,
  dmSecrets: true,
  credentials: true,
  allowlistProjection: false,
  pseudonymizeAuthors: false,
  neutralizeAttachmentFilenames: false,
  scanFreeText: false,
  sanitizeAttachmentBytes: false,
  requireSanitizedAttachments: false,
};

/**
 * Handoff is the subtle one: the incoming DM needs the whole world AND the secrets
 * AND where the party got to — but they have no business inheriting the outgoing
 * group's identities or paper trail.
 */
const HANDOFF_SWITCHES: ExportPolicySwitches = {
  memberIdentities: false,
  audit: false,
  proposals: false,
  operationalHistory: false,
  privateNotes: false,
  playerContent: true,
  playedState: true,
  dmSecrets: true,
  credentials: false,
  allowlistProjection: true,
  pseudonymizeAuthors: true,
  neutralizeAttachmentFilenames: false,
  scanFreeText: true,
  sanitizeAttachmentBytes: true,
  requireSanitizedAttachments: false,
};

const PUBLISH_SWITCHES: ExportPolicySwitches = {
  memberIdentities: false,
  audit: false,
  proposals: false,
  operationalHistory: false,
  privateNotes: false,
  playerContent: false,
  playedState: false,
  dmSecrets: false,
  credentials: false,
  allowlistProjection: true,
  pseudonymizeAuthors: true,
  neutralizeAttachmentFilenames: true,
  scanFreeText: true,
  sanitizeAttachmentBytes: true,
  requireSanitizedAttachments: true,
};

export const EXPORT_PROFILE_SWITCHES: Record<ExportProfile, ExportPolicySwitches> = {
  backup: BACKUP_SWITCHES,
  handoff: HANDOFF_SWITCHES,
  publish: PUBLISH_SWITCHES,
};

/** Secrecy label written into the archive manifest for each profile. */
export const EXPORT_PROFILE_SECRECY: Record<ExportProfile, string> = {
  backup: 'dm-full',
  handoff: 'dm-handoff',
  publish: 'publishable-module',
};

export const EXPORT_PROFILE_SUMMARY: Record<ExportProfile, string> = {
  backup:
    'Full-fidelity DM backup. Includes member identities, the audit trail, proposals, private and whisper notes, ' +
    'RSVPs, attendance, the dice log and DM secrets. Treat the file as if it were the database.',
  handoff:
    'Campaign handoff to a new DM. Keeps the world, DM secrets and play state; drops member identities, the audit ' +
    'trail, proposals, RSVPs, attendance, the dice log and revision provenance. Retained authors are pseudonymized.',
  publish:
    'Redistributable adventure module. Excludes member identities, audit, proposals, private/whisper notes, RSVPs, ' +
    'attendance, the dice log and credentials. DM secrets, played state and player-authored content are opt-in.',
};

export type ResolvedExportPolicy = ExportPolicySwitches & {
  profile: ExportProfile;
  options: Required<ExportProfileOptions>;
  secrecyProfile: string;
  summary: string;
};

/**
 * Resolve the effective policy. The opt-ins only WIDEN the `publish` profile — they
 * can never narrow `backup`/`handoff`, and they can never turn on anything the
 * publish row leaves off other than the three reviewed switches.
 */
export function resolveExportPolicy(
  profile: ExportProfile,
  options: ExportProfileOptions = {},
): ResolvedExportPolicy {
  const base = EXPORT_PROFILE_SWITCHES[profile];
  const opts: Required<ExportProfileOptions> = {
    includeDmSecrets: profile === 'publish' ? options.includeDmSecrets === true : base.dmSecrets,
    includePlayedState: profile === 'publish' ? options.includePlayedState === true : base.playedState,
    includePlayerContent: profile === 'publish' ? options.includePlayerContent === true : base.playerContent,
  };
  return {
    ...base,
    dmSecrets: profile === 'publish' ? opts.includeDmSecrets : base.dmSecrets,
    playedState: profile === 'publish' ? opts.includePlayedState : base.playedState,
    playerContent: profile === 'publish' ? opts.includePlayerContent : base.playerContent,
    profile,
    options: opts,
    secrecyProfile: EXPORT_PROFILE_SECRECY[profile],
    summary: EXPORT_PROFILE_SUMMARY[profile],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-entity field ALLOWLISTS.
//
// READ THE MODULE HEADER BEFORE EDITING. These are allowlists on purpose: a column
// that is not listed here is excluded from every non-backup export, including
// columns that do not exist yet. Do not "simplify" this into a denylist of
// sensitive fields — that inverts the default and makes future migrations leak.
//
// Fields that are themselves conditional (dmSecret, hidden, played state) are
// listed in the `*_SECRET` / `*_PLAYED` companions and merged in by policy.
// ─────────────────────────────────────────────────────────────────────────────

export const PUBLISHABLE_FIELDS = {
  campaign: ['id', 'name', 'description', 'status', 'dangerLevel', 'narrationLanguage', 'ruleSystem', 'mapAttachmentId', 'currentLocationId'],
  quest: ['id', 'campaignId', 'parentId', 'title', 'body', 'giverNpcId', 'reward', 'sortOrder', 'objectives'],
  questObjective: ['id', 'questId', 'text', 'sortOrder'],
  npc: ['id', 'campaignId', 'name', 'role', 'disposition', 'locationId', 'factionId', 'body', 'portraitUrl', 'iconSlug'],
  location: ['id', 'campaignId', 'parentId', 'name', 'kind', 'mapX', 'mapY', 'body', 'portraitUrl'],
  faction: ['id', 'campaignId', 'name', 'kind', 'body', 'goals', 'reputation', 'standing', 'portraitUrl'],
  session: ['id', 'campaignId', 'number', 'title'],
  character: [
    // Issue #1910 review (Codex, PR #1980): `speed` is a baseline mechanical stat,
    // the same category as `ac`/`eac`/`kac` — it doesn't change turn-by-turn like
    // played state does, so it belongs here (always carried), not in
    // PLAYED_STATE_FIELDS. Omitting it meant the `handoff`/`publish` profiles
    // silently stripped a non-default speed before import.
    'id', 'campaignId', 'name', 'species', 'className', 'level', 'background', 'stats', 'ac', 'eac', 'kac', 'speed',
    'hpMax', 'spMax', 'rpMax', 'saveProficiencies', 'skills', 'actions', 'resources', 'portraitUrl', 'notes',
  ],
  note: ['id', 'campaignId', 'visibility', 'entityType', 'entityId', 'entityName', 'body'],
  comment: ['id', 'campaignId', 'entityType', 'entityId', 'parentId', 'body', 'inCharacter', 'characterId', 'characterName'],
  encounter: [
    'id', 'campaignId', 'name', 'locationId', 'questId', 'sessionId', 'mapAttachmentId',
    'gridSize', 'gridScale', 'gridUnit', 'gridSnap', 'gridType', 'hexOrientation', 'aoe',
    'gridOffsetX', 'gridOffsetY', 'gridCellHeight', 'gridRotation', 'gridOpacity', 'combatants',
  ],
  combatant: [
    // Issue #1910 review: the add-time speed snapshot follows the same
    // always-carried convention as eac/kac (Starfinder's combatant-side armor
    // snapshot) just above it, not PLAYED_STATE_FIELDS — see the character list.
    'id', 'encounterId', 'kind', 'characterId', 'npcId', 'name', 'initMod', 'initiativeGroup',
    'hpMax', 'spMax', 'rpMax', 'eac', 'kac', 'speed', 'sortOrder', 'tokenX', 'tokenY', 'tokenSize',
    'statblockJson', 'compendiumRef', 'compendiumSnapshot', 'ruleEntryId',
  ],
  storyArc: ['id', 'campaignId', 'title', 'summary', 'sortOrder', 'beats'],
  storyBeat: ['id', 'campaignId', 'arcId', 'title', 'body', 'sortOrder', 'sessionId', 'questId', 'encounterId', 'branches'],
  storyBranch: ['id', 'beatId', 'toBeatId', 'label', 'sortOrder'],
  timelineEvent: ['id', 'campaignId', 'title', 'inWorldDate', 'body', 'era', 'sortIndex'],
  timelineCalendar: ['campaignId', 'note'],
  sessionZero: ['campaignId', 'houseRules', 'toneAndExpectations'],
  inventoryItem: [
    'id', 'campaignId', 'ownerType', 'characterId', 'name', 'qty', 'notes', 'iconSlug',
    // Issue #738: portable provenance (numeric ruleEntryId is local-only on import).
    'ruleEntryId', 'compendiumRef', 'compendiumSnapshot', 'compendiumState',
  ],
  treasury: ['campaignId', 'cp', 'sp', 'ep', 'gp', 'pp'],
  attachment: ['id', 'kind', 'filename', 'mime', 'size', 'file', 'fileRoute', 'present'],
} as const satisfies Record<string, readonly string[]>;

/** Fields merged in only when the policy allows DM secrets / unrevealed staging. */
export const DM_SECRET_FIELDS = {
  quest: ['dmSecret', 'hidden'],
  npc: ['dmSecret', 'hidden'],
  location: ['dmSecret', 'hidden'],
  faction: ['dmSecret', 'hidden'],
  session: ['dmSecret'],
  character: ['dmSecret'],
  encounter: ['hidden', 'fog'],
  timelineEvent: ['dmSecret', 'hidden'],
} as const satisfies Record<string, readonly string[]>;

/** Fields merged in only when the policy allows played state. */
export const PLAYED_STATE_FIELDS = {
  campaign: ['sessionCount', 'latestSessionNumber'],
  quest: ['status'],
  location: ['status'],
  session: ['playedAt', 'recap'],
  // #1667 half B: `conditionInstances` sits beside `conditions` here, matching
  // `combatant` below — a character's structured condition data (source, duration,
  // concentration, `stacks` — this is how #1641's exhaustion level is stored) is
  // played state, not identity data, and the allowlist is exhaustive: leaving it out
  // meant a character's exhaustion level could never survive ANY export, including a
  // full owner backup with playedState on. See CharactersService.listForExport for
  // where the field actually gets resolved onto the exported row (it is not on the
  // public Character schema).
  character: ['status', 'xp', 'hpCurrent', 'hpTemp', 'deathState', 'deathSaveSuccesses', 'deathSaveFailures', 'conditions', 'conditionInstances', 'spellSlots'],
  encounter: ['status', 'round', 'turnIndex', 'currentCombatantId', 'turnPhase', 'escalationDie', 'endedAt'],
  combatant: ['initiative', 'hpCurrent', 'hpTemp', 'spCurrent', 'rpCurrent', 'deathState', 'deathSaveSuccesses', 'deathSaveFailures', 'conditions', 'conditionInstances', 'activeEffects'],
  storyArc: ['status'],
  storyBeat: ['status'],
  timelineCalendar: ['currentDate'],
} as const satisfies Record<string, readonly string[]>;

/** Participant-authored fields on the safety charter (issue #877 spirit: the group's own words). */
export const PLAYER_CONTENT_FIELDS = {
  sessionZero: ['lines', 'veils', 'safetyTools'],
} as const satisfies Record<string, readonly string[]>;

/**
 * Values written in place of played state when a profile drops it, so the projected
 * document still IMPORTS cleanly (a publishable module should arrive pristine, not
 * half-played or shape-broken).
 */
export const PRISTINE_STATE: Record<string, Record<string, unknown>> = {
  campaign: { sessionCount: 0, latestSessionNumber: 0 },
  quest: { status: 'available' },
  location: { status: 'unexplored' },
  encounter: { status: 'preparing', round: 0, turnIndex: 0, currentCombatantId: null, turnPhase: 'combatant', escalationDie: 0, endedAt: null },
  combatant: { initiative: null, hpTemp: 0, deathState: 'none', deathSaveSuccesses: 0, deathSaveFailures: 0, conditions: [], conditionInstances: [], activeEffects: [] },
  storyArc: { status: 'planned' },
  storyBeat: { status: 'planned' },
  timelineCalendar: { currentDate: '' },
  // #1667: `conditionInstances: []` mirrors combatant's pristine default above — the
  // same asymmetry the issue flagged for the allowlist existed here too.
  character: { status: 'active', xp: 0, hpTemp: 0, deathState: 'none', deathSaveSuccesses: 0, deathSaveFailures: 0, conditions: [], conditionInstances: [], spellSlots: {} },
};

type Row = Record<string, unknown>;

/** Allowlist projection: copy exactly the named keys that are present on the row. */
export function pickFields(row: Row, fields: readonly string[]): Row {
  const out: Row = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(row, field)) out[field] = row[field];
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pseudonymization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stable-within-one-archive, unlinkable-across-archives author labels.
 *
 * A bare `sha256(userId)` would be worthless here: user ids are small integers
 * serialized as strings, so anyone holding two archives could enumerate the id space
 * in microseconds and both de-anonymize the authors AND correlate the same person
 * across exports. Instead every export mints a fresh 32-byte salt, keys an HMAC with
 * it, and then THROWS THE SALT AWAY — it is never written to the payload, the
 * manifest, the database or a log. Consequences, all intended:
 *
 *  - within one archive, author A always renders as the same label;
 *  - two exports of the SAME campaign give A two unrelated labels;
 *  - nobody, including this server, can invert a label back to a user id.
 */
export class ExportPseudonymizer {
  private readonly salt = randomBytes(32);
  private readonly assigned = new Map<string, string>();

  /** Distinct identities that were given a label in this export. */
  get size(): number {
    return this.assigned.size;
  }

  label(rawId: string | null | undefined): string {
    const key = (rawId ?? '').trim();
    if (!key) return 'Contributor (unknown)';
    const existing = this.assigned.get(key);
    if (existing) return existing;
    const digest = createHmac('sha256', this.salt).update(key).digest('hex').slice(0, 10);
    const label = `Contributor ${digest}`;
    this.assigned.set(key, label);
    return label;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Identifier scanning
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Identifiers short enough that a literal sweep would mangle unrelated prose
 * ("Al", "Dan", numeric user ids like "7"). They are reported to the DM in the
 * pre-export inventory as unscannable rather than silently ignored — the
 * ALLOWLIST is what keeps them out of structured fields; the sweep is only a
 * second line of defence for free text.
 *
 * The reported LITERALS are for the DM-only preview endpoint ONLY. They are roster
 * identities by construction (every numeric user id under 1000 lands here, as does
 * any display name like "Bob" or "Jo"), so nothing that ships inside an archive may
 * reproduce the list — see `ExportService.redactionDisclosure`, which carries only
 * the count.
 */
export const MIN_SCANNABLE_IDENTIFIER = 4;

export type IdentifierScanResult = {
  /** Distinct identifier strings the sweep looked for. */
  scanned: number;
  /** Identifiers too short/ambiguous to sweep for safely (reported, not swept). */
  unscannable: string[];
  /** Literal occurrences replaced across the whole serialized payload. */
  occurrencesRedacted: number;
};

export const REDACTION_MARKER = '[redacted]';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Any email address, whether or not this server has an account for it. A DM who
 * typed "mail the caretaker at sam@example.com" into an NPC body has written a real
 * person's contact details into what may become a public adventure module, and no
 * roster-derived identifier list can catch it. Deliberately generic and deliberately
 * greedy — an in-fiction email address in a fantasy module is a rounding error next
 * to publishing somebody's inbox.
 */
const EMAIL_PATTERN = '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}';

/**
 * Build a single alternation matching any scannable identifier, longest-first so
 * "Ada Lovelace" wins over "Lovelace". Boundaries are word-ish rather than `\b`
 * because identifiers legitimately contain `@`, `.` and `-` (emails, `dev:name`).
 * The email pattern goes FIRST so a full address wins over a display name that
 * happens to be its local part.
 */
function buildIdentifierRegex(identifiers: string[]): RegExp {
  const literals = [...identifiers].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const alternation = [EMAIL_PATTERN, ...literals].join('|');
  return new RegExp(`(?<![A-Za-z0-9])(?:${alternation})(?![A-Za-z0-9])`, 'gi');
}

export function partitionIdentifiers(identifiers: Iterable<string>): { scannable: string[]; unscannable: string[] } {
  const scannable: string[] = [];
  const unscannable: string[] = [];
  for (const raw of new Set(identifiers)) {
    const value = raw.trim();
    if (!value) continue;
    if (value.length < MIN_SCANNABLE_IDENTIFIER) unscannable.push(value);
    else scannable.push(value);
  }
  return { scannable: scannable.sort(), unscannable: unscannable.sort() };
}

/**
 * Deep, in-place-free sweep replacing every literal occurrence of a known private
 * identifier in EVERY string reachable from `value` — object values, array elements,
 * and (importantly) object KEYS, since a map keyed by username would otherwise carry
 * the name in the key.
 *
 * Over-redaction is the intended failure mode: a published module with `[redacted]`
 * where a common word collided is a cosmetic bug a DM can see and fix; a published
 * module with a player's real name in it cannot be un-published.
 */
export function redactIdentifiers<T>(value: T, identifiers: string[]): { value: T; occurrences: number } {
  const re = buildIdentifierRegex(identifiers);
  let occurrences = 0;

  const sweepString = (input: string): string =>
    input.replace(re, () => {
      occurrences += 1;
      return REDACTION_MARKER;
    });

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return sweepString(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        out[sweepString(key)] = walk(child);
      }
      return out;
    }
    return node;
  };

  return { value: walk(value) as T, occurrences };
}

/** True when the raw bytes contain any known private identifier (UTF-8 or Latin-1). */
export function bytesContainIdentifier(bytes: Buffer, identifiers: string[]): boolean {
  const re = buildIdentifierRegex(identifiers);
  // Two decodings: metadata blobs are frequently ASCII/Latin-1, EXIF UserComment
  // is sometimes UTF-16 — the latter is not covered and is called out in the
  // publish limitations note.
  return re.test(bytes.toString('utf8')) || re.test(bytes.toString('latin1'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-export inventory
// ─────────────────────────────────────────────────────────────────────────────

export type ExportInventoryRow = {
  /** Payload key, e.g. `npcs`. */
  module: string;
  /** Rows carried into the archive. */
  included: number;
  /** Rows dropped by the policy. */
  redacted: number;
  /** Why rows were dropped, or why fields were stripped. Present whenever redacted > 0 or fields were stripped. */
  reason?: string;
  /** Named fields the allowlist withheld from the included rows. */
  fieldsWithheld?: string[];
};

export type ExportAttachmentInventory = {
  included: number;
  /** Rows whose BYTES were withheld (missing on disk, unsanitizable format, or identifier-bearing). */
  bytesWithheld: number;
  filenamesNeutralized: number;
  metadataStripped: number;
  notes: string[];
};

export type ExportInventory = {
  app: 'campfire';
  kind: 'campaign-export-inventory';
  formatVersion: number;
  campaignId: number;
  profile: ExportProfile;
  options: Required<ExportProfileOptions>;
  secrecyProfile: string;
  summary: string;
  createdAt: string;
  policy: ExportPolicySwitches;
  rows: ExportInventoryRow[];
  attachments: ExportAttachmentInventory;
  identifiers: IdentifierScanResult;
  pseudonyms: { contributors: number };
  limitations: string[];
};

export const EXPORT_INVENTORY_FORMAT_VERSION = 1;

/**
 * Honest limitations, surfaced in the pre-export inventory AND in the archive
 * manifest so a DM publishing a module is told what this feature does NOT do.
 */
export function exportLimitations(policy: ResolvedExportPolicy): string[] {
  const out: string[] = [];
  if (policy.profile === 'backup') {
    out.push(
      'Backup profile applies no redaction at all: member identities, audit history, proposals, private and whisper ' +
        'notes, RSVPs, attendance and DM secrets are all present. Handle it like a database dump.',
    );
    return out;
  }
  out.push(
    'Free-text redaction sweeps for identifiers this server knows about (member user ids, usernames, display names, ' +
      'and the author/actor names found in the campaign). A real name that appears ONLY inside prose and matches no ' +
      'known account cannot be detected — read the archive before you publish it.',
  );
  out.push(
    `Identifiers shorter than ${MIN_SCANNABLE_IDENTIFIER} characters are not swept from prose (they would mangle ` +
      'unrelated text); they are listed in this inventory. Structured identity fields are excluded by the field ' +
      'allowlist regardless of length.',
  );
  out.push(
    'Every email-shaped string is redacted from prose, whether or not it belongs to an account on this server. ' +
      'An in-fiction address will be redacted too.',
  );
  if (policy.sanitizeAttachmentBytes) {
    out.push(
      'Embedded image metadata is stripped for PNG (ancillary chunks) and JPEG (APPn/COM segments) only. ' +
        (policy.requireSanitizedAttachments
          ? 'WebP, PDF and SVG attachments cannot be provably stripped by this codebase, so the publish profile omits their bytes entirely and records them below.'
          : 'WebP, PDF and SVG attachments are embedded WITH their original metadata — review them before sharing the archive.'),
    );
    out.push(
      'Metadata stripping is container-level. Text rendered INTO the pixels of a map (a player name written on the ' +
        'image) is not detected or removed.',
    );
  }
  return out;
}
