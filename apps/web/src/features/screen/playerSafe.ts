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
  Character,
  Combatant,
  CombatantKind,
  HpBand,
  Location,
  Npc,
  Quest,
  QuestObjective,
} from '@campfire/schema';

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
// Party — characters' HP is shared table info (party members see each other's
// sheets), so exact HP is fine here; only the DM-only `dmSecret`/prep notes are
// dropped by never copying them across.

export interface SafeCharacter {
  id: number;
  name: string;
  species: string;
  className: string;
  level: number;
  ac: number | null;
  hpCurrent: number;
  hpMax: number;
  conditions: string[];
  portraitUrl: string | null;
}

export function safeCharacter(c: Character): SafeCharacter {
  return {
    id: c.id,
    name: c.name,
    species: c.species,
    className: c.className,
    level: c.level,
    ac: c.ac,
    hpCurrent: c.hpCurrent,
    hpMax: c.hpMax,
    conditions: c.conditions,
    portraitUrl: c.portraitUrl,
  };
}

export function safeParty(characters: Character[]): SafeCharacter[] {
  return characters.map(safeCharacter);
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
}

export function safeNpcs(npcs: Npc[]): SafeNpc[] {
  return npcs
    .filter((n) => !n.hidden)
    .map((n) => ({ id: n.id, name: n.name, role: n.role, disposition: n.disposition }));
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
  /** Exact HP — only ever populated for characters (party HP is shared). */
  hpCurrent: number | null;
  hpMax: number | null;
  /** Coarse band — populated for monsters (exact numbers withheld). */
  hpBand: HpBand | null;
}

export function safeCombatant(c: Combatant): SafeCombatant {
  const base = {
    id: c.id,
    kind: c.kind,
    name: c.name,
    initiative: c.initiative,
    conditions: c.conditions,
  };
  // Characters expose exact HP to the table; monsters are banded, exact numbers withheld.
  if (c.kind === 'character') {
    return { ...base, hpCurrent: c.hpCurrent, hpMax: c.hpMax, hpBand: null };
  }
  const band =
    c.hpBand ?? (c.hpCurrent != null && c.hpMax != null ? hpBandFor(c.hpCurrent, c.hpMax) : null);
  return { ...base, hpCurrent: null, hpMax: null, hpBand: band };
}

export function safeCombatants(combatants: Combatant[]): SafeCombatant[] {
  return combatants.map(safeCombatant);
}
