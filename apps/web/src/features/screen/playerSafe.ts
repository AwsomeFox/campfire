/**
 * Player-safe projections for the cast-to-TV Player Display (issue #60).
 *
 * The display is opened by a DM who is authenticated AS a DM, so every API
 * response it consumes still carries the DM's full, UN-redacted view: dmSecret
 * bodies, `hidden` prep entities (issue #42), `unexplored` locations, and exact
 * monster HP (issue #43). Rendering that on a screen the whole table can see
 * would leak every secret the server's role redaction exists to protect.
 *
 * So this module re-derives the *player* view on the client, mirroring the
 * server's redaction rules (see apps/server/src/common/redact.ts and
 * encounters.service.ts `hpBandFor`). Each helper returns a brand-new object
 * containing ONLY player-safe fields — never a spread of the source entity —
 * so a future field added to a canon schema cannot silently leak through.
 */
import type {
  AoeTemplate,
  PartyCharacter,
  Combatant,
  CombatantKind,
  EncounterWithCombatants,
  FogState,
  HpBand,
  Location,
  MonsterHpDisplay,
  Npc,
  Quest,
  QuestObjective,
} from '@campfire/schema';
import { filterAoeTemplatesForViewer, pointInRevealedRegion } from '@campfire/schema';

// ---------------------------------------------------------------------------
// Location — an `unexplored` location is un-revealed DM prep (issue #42) and is
// dropped wholesale from a player's view. Only explored/current are castable.

export interface SafeLocation {
  id: number;
  name: string;
  kind: string;
  isCurrent: boolean;
}

export function safeLocation(loc: Location | null | undefined): SafeLocation | null {
  if (!loc || loc.status === 'unexplored') return null;
  return { id: loc.id, name: loc.name, kind: loc.kind, isCurrent: loc.status === 'current' };
}

// ---------------------------------------------------------------------------
// Party — the server supplies this explicit PartyCharacter allowlist on campaign
// summaries, so Cast and dashboard code never receives another player's full sheet.
// Lifecycle status remains table-safe info used to hide alumni by default.

export interface SafePartyOptions {
  /**
   * When false (default), dead/retired/inactive PCs are omitted so the TV
   * "Party" scene matches the live table (issue #824). Producer opt-in shows
   * the full undeleted roster with status labels on alumni.
   */
  includeAlumni?: boolean;
  /**
   * Character ids currently seated as combatants in a running encounter.
   * When non-empty and alumni are excluded, prefer those participants over the
   * full active roster (sitting-out actives stay off the cast during the fight).
   * Pass null/undefined/empty out of combat to fall back to active-only.
   */
  participatingCharacterIds?: ReadonlySet<number> | readonly number[] | null;
}

function asIdSet(
  ids: SafePartyOptions['participatingCharacterIds'],
): Set<number> | null {
  if (ids == null) return null;
  const set = ids instanceof Set ? ids : new Set(ids);
  return set.size > 0 ? set : null;
}

/**
 * Filters the server-produced safe roster for the Cast / Player Display (issue #824).
 * Defaults to active PCs; during combat prefers participating character combatants;
 * with `includeAlumni` returns the full undeleted roster (status preserved for labels).
 */
export function safeParty(characters: PartyCharacter[], options: SafePartyOptions = {}): PartyCharacter[] {
  const includeAlumni = options.includeAlumni === true;
  const participating = includeAlumni ? null : asIdSet(options.participatingCharacterIds);

  return characters
    .filter((c) => {
      if (includeAlumni) return true;
      if (participating) return participating.has(c.id);
      return c.status === 'active';
    })
    .map((character) => ({ ...character }));
}

// ---------------------------------------------------------------------------
// Quests — a `hidden` quest is DM prep (issue #42) and is excluded entirely.
// We surface only the objectives players are meant to track; the markdown body,
// reward text, and dmSecret are never copied across.

export interface SafeObjective {
  id: number;
  text: string;
  done: boolean;
}

export interface SafeQuest {
  id: number;
  title: string;
  status: Quest['status'];
  objectives: SafeObjective[];
}

function safeObjective(o: QuestObjective): SafeObjective {
  return { id: o.id, text: o.text, done: o.done };
}

/** Active + available quests, hidden prep dropped, sorted the way the API sends them. */
export function safeQuests(quests: (Quest & { objectives: QuestObjective[] })[]): SafeQuest[] {
  return quests
    .filter((q) => !q.hidden && (q.status === 'active' || q.status === 'available'))
    .map((q) => ({
      id: q.id,
      title: q.title,
      status: q.status,
      objectives: [...q.objectives].sort((a, b) => a.sortOrder - b.sortOrder).map(safeObjective),
    }));
}

// ---------------------------------------------------------------------------
// NPCs — a `hidden` NPC is dropped; we show only the name + public role/
// disposition a player would already know from the table.

export interface SafeNpc {
  id: number;
  name: string;
  role: string;
  disposition: string;
  portraitUrl: string | null;
}

export function safeNpcs(npcs: Npc[]): SafeNpc[] {
  return npcs
    .filter((n) => !n.hidden)
    .map((n) => ({ id: n.id, name: n.name, role: n.role, disposition: n.disposition, portraitUrl: n.portraitUrl }));
}

// ---------------------------------------------------------------------------
// Initiative order — monster HP is banded (issue #43); characters keep exact HP.
// Mirrors encounters.service.ts `hpBandFor` so the cast view matches what a
// player already sees in the live run-session tracker.

/** Coarse HP band for a monster — mirror of the server's hpBandFor. */
export function hpBandFor(hpCurrent: number, hpMax: number): HpBand {
  if (hpCurrent <= 0) return 'down';
  const pct = hpMax > 0 ? hpCurrent / hpMax : 0;
  if (pct <= 0.25) return 'critical';
  if (pct <= 0.5) return 'bloodied';
  return 'healthy';
}

export interface SafeCombatant {
  id: number;
  kind: CombatantKind;
  name: string;
  initiative: number | null;
  conditions: string[];
  down: boolean;
  /** Exact HP — only ever populated for characters (party HP is shared). */
  hpCurrent: number | null;
  hpMax: number | null;
  /** Coarse band — populated for monsters (exact numbers withheld). */
  hpBand: HpBand | null;
}

/**
 * Issue #1925: monster/NPC HP follows the encounter's `monsterHpDisplay` dial. The
 * server has ALREADY applied that mode to `c` before it ever reaches this client code
 * (real numbers in 'exact', band-only in 'band', neither in 'hidden' except 'down') —
 * this function mirrors that server decision through to the cast-window projection; it
 * never makes its own hiding decision. `monsterHpDisplay` is REQUIRED (no default): two
 * separate reviews on this feature found call sites that silently fell back to a stale
 * default and disagreed with the server's actual mode — a required parameter forces
 * every call site (present and future) to state which mode it means.
 *
 * `'hidden'` mode never derives a band (or a down state) from `hpCurrent`/`hpMax`, even
 * when those numbers happen to be present on `c`. A client that "repairs" a server-side
 * leak into a plausible-looking band would hide the leak's only visible evidence — the
 * whole point of secrecy being enforced server-side is that this code has nothing to
 * repair; if the server ever regresses, hidden mode must render as nothing, not as a
 * band. The one exception is an explicitly-provided `'down'` band, which the server
 * ships in every mode so the table always knows who dropped.
 */
export function safeCombatant(c: Combatant, monsterHpDisplay: MonsterHpDisplay): SafeCombatant {
  const idBase = {
    id: c.id,
    kind: c.kind,
    name: c.name,
    initiative: c.initiative,
    conditions: c.conditions,
  };
  // Characters expose exact HP to the table; party HP is shared table knowledge.
  if (c.kind === 'character') {
    return {
      ...idBase,
      hpCurrent: c.hpCurrent,
      hpMax: c.hpMax,
      hpBand: null,
      down: c.hpCurrent != null ? c.hpCurrent <= 0 : c.hpBand === 'down',
    };
  }
  // 'exact' mode: the server already sent the real numbers on `c` — carry them through
  // rather than stripping them. hpBand stays null: numbers and band are mutually
  // exclusive on SafeCombatant, and the exact numbers already convey everything a band
  // would.
  if (monsterHpDisplay === 'exact' && c.hpCurrent != null && c.hpMax != null) {
    return { ...idBase, hpCurrent: c.hpCurrent, hpMax: c.hpMax, hpBand: null, down: c.hpCurrent <= 0 };
  }
  if (monsterHpDisplay === 'hidden') {
    const down = c.hpBand === 'down';
    return { ...idBase, hpCurrent: null, hpMax: null, hpBand: down ? 'down' : null, down };
  }
  // 'band' mode: the coarse status the server already computed, or (defense in depth,
  // for a caller that somehow reached here with un-redacted numbers and no band) derived
  // from the raw numbers — 'band' mode has no numbers to protect from being echoed back
  // as a band, unlike 'hidden' above.
  const band =
    c.hpBand ?? (c.hpCurrent != null && c.hpMax != null ? hpBandFor(c.hpCurrent, c.hpMax) : null);
  return { ...idBase, hpCurrent: null, hpMax: null, hpBand: band, down: band === 'down' };
}

export function filterPlayerSafeCombatants<T>(combatants: T[]): T[] {
  return combatants.filter((c) => (c as { hidden?: boolean }).hidden !== true);
}

export function safeCombatants(combatants: Combatant[], monsterHpDisplay: MonsterHpDisplay): SafeCombatant[] {
  return filterPlayerSafeCombatants(combatants).map((c) => safeCombatant(c, monsterHpDisplay));
}



// ---------------------------------------------------------------------------
// Battle map — re-derive the player VTT projection for the cast surface (issue
// #484). The display is opened by an authenticated DM, so encounter payloads
// still carry full coordinates; redact fog-hidden tokens and unrevealed AoE
// before painting the table-facing map scene.

/** Mirror of encounters.service.ts `redactTokenInFog` (issue #40 / #418). */
function redactTokenInFog(c: Combatant, fog: FogState): Combatant {
  if (c.tokenX == null || c.tokenY == null) return c;
  if (pointInRevealedRegion(c.tokenX, c.tokenY, fog)) return c;
  return { ...c, tokenX: null, tokenY: null, tokenHiddenByFog: true };
}

/**
 * BattleMap needs the combatant shape for map placement, but the Player Display
 * still runs in an authenticated DM browser. Reapply the player-safe HP and
 * turn-state projection before rendering any token state.
 *
 * Issue #1925 (Devin review on #2040): this used to call `safeCombatant(c)` with no
 * mode, silently defaulting to 'band' — so on an 'exact' table the map scene's tokens
 * disagreed with the initiative scene on the very same screen. `monsterHpDisplay` is
 * now required (see `safeCombatant`'s doc comment), so `safeEncounterForCast` below
 * must thread the encounter's own mode through here.
 */
function redactCombatantForCast(c: Combatant, monsterHpDisplay: MonsterHpDisplay): Combatant {
  const safe = safeCombatant(c, monsterHpDisplay);
  return {
    ...c,
    hpCurrent: safe.hpCurrent,
    hpMax: safe.hpMax,
    hpBand: safe.hpBand,
    // BattleMap's shared Combatant input requires this object. Populate it
    // solely with neutral values so no turn workspace state reaches the TV.
    turnState: {
      used: {},
      movementUsedFt: 0,
      concentration: null,
      pendingConcentrationChecks: [],
      delaying: false,
      readied: null,
    },
  };
}

/**
 * Player-safe encounter slice for the Cast map scene. Combatants and AoE are
 * filtered; grid/fog fields are kept so the read-only BattleMap can render the
 * same projection a player sees on the run-session page. Threads the encounter's own
 * `monsterHpDisplay` through to `redactCombatantForCast` so the map scene agrees with
 * the initiative scene (both ultimately mirror the same server-set mode).
 */
export function safeEncounterForCast(encounter: EncounterWithCombatants): EncounterWithCombatants {
  const fog = encounter.fog;
  const combatants = encounter.combatants
    .map((c) => redactCombatantForCast(c, encounter.monsterHpDisplay))
    .map((c) => (fog?.enabled === true ? redactTokenInFog(c, fog) : c));
  const aoe: AoeTemplate[] = filterAoeTemplatesForViewer(encounter.aoe ?? [], fog);
  return { ...encounter, combatants, aoe };
}
