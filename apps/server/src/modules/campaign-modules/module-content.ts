/**
 * Portable artifact content, hashing, and three-way merge for campaign modules (issue #585).
 *
 * Everything in this file is PURE — no DB, no Nest — so the merge algebra that decides
 * whether a publisher's correction silently clobbers a table's edit can be unit-tested
 * exhaustively without booting an app.
 *
 * ## Portable content
 *
 * A module artifact is NOT a row. Row ids are per-install and meaningless upstream, so an
 * artifact's content is a whitelisted projection of the entity's *portable* fields, with
 * cross-references expressed as the referenced artifact's stable `key` (`locationKey`,
 * `factionKey`, `giverNpcKey`, `parentKey`) rather than as a local id. The whitelist is
 * closed: unknown keys in an incoming package are dropped, so a package can never smuggle
 * a server-local id, a soft-delete timestamp, or an attachment reference into a write.
 *
 * Projection also NORMALIZES (missing/null/undefined collapse to the field's canonical
 * empty value), which is what makes `contentHash` comparable across installs — two servers
 * that spell an absent description as `null` and `''` must agree on the hash.
 *
 * ## Three-way merge
 *
 * Per field, given BASE (as installed), LOCAL (as it is now) and UPSTREAM (the new package):
 *
 *   upstream == base                 -> keep LOCAL      (the publisher did not touch it)
 *   local    == base                 -> take UPSTREAM   (the table did not touch it)
 *   local    == upstream             -> converged, take either
 *   otherwise                        -> CONFLICT        (both moved, to different values)
 *
 * That is the whole reason the baseline is persisted: with only LOCAL and UPSTREAM the first
 * two rules are indistinguishable, and any implementation has to guess (which in practice
 * means "upstream wins", i.e. silently discarding the table's work).
 */
import { createHash } from 'node:crypto';
import type { ModuleArtifactKind, ModuleFieldChange } from '@campfire/schema';
import { stableStringify } from '../proposals/proposal-snapshot';

export const MODULE_ARTIFACT_KINDS = ['location', 'npc', 'quest', 'faction'] as const;

export type FieldType = 'string' | 'number' | 'boolean' | 'nullableNumber' | 'key' | 'json';

export type FieldSpec = {
  /** Field name in the portable payload. */
  name: string;
  type: FieldType;
  /**
   * When set, the entity column this field maps to differs from `name` — used for the
   * `*Key` reference fields, whose column holds a local id resolved from the key.
   */
  column?: string;
  /**
   * Canonical value for a `string` field whose column is a CLOSED ENUM. Without it a
   * package that simply omits `status`/`disposition`/`standing` normalizes to `''`, which
   * is not a member of the enum: the row is then written with an out-of-range value (and
   * a location with `status: ''` is not `unexplored`, so it is visible to players from the
   * moment it is installed). Defaulting HERE rather than at the insert keeps the baseline
   * and the live row projecting to the same value, which is what the hash compare needs.
   */
  default?: string;
};

/**
 * The closed portable field set per artifact kind.
 *
 * Deliberately EXCLUDED everywhere: `id`, `campaignId`, `createdAt`/`updatedAt`,
 * `deletedAt`, `portraitUrl`/`mapAttachmentId` (attachment ids are install-local — a
 * module ships text, and image payloads are out of scope here), and quest-objective
 * `done` (play state, never the publisher's to set).
 */
export const PORTABLE_FIELDS: Record<ModuleArtifactKind, readonly FieldSpec[]> = {
  location: [
    { name: 'name', type: 'string' },
    { name: 'kind', type: 'string' },
    { name: 'status', type: 'string', default: 'unexplored' },
    { name: 'body', type: 'string' },
    { name: 'dmSecret', type: 'string' },
    { name: 'mapX', type: 'nullableNumber' },
    { name: 'mapY', type: 'nullableNumber' },
    { name: 'parentKey', type: 'key', column: 'parentId' },
  ],
  npc: [
    { name: 'name', type: 'string' },
    { name: 'role', type: 'string' },
    { name: 'disposition', type: 'string', default: 'neutral' },
    { name: 'body', type: 'string' },
    { name: 'dmSecret', type: 'string' },
    { name: 'iconSlug', type: 'string' },
    { name: 'hidden', type: 'boolean' },
    { name: 'locationKey', type: 'key', column: 'locationId' },
    { name: 'factionKey', type: 'key', column: 'factionId' },
  ],
  quest: [
    { name: 'title', type: 'string' },
    { name: 'body', type: 'string' },
    { name: 'status', type: 'string', default: 'available' },
    { name: 'reward', type: 'string' },
    { name: 'dmSecret', type: 'string' },
    { name: 'hidden', type: 'boolean' },
    { name: 'sortOrder', type: 'number' },
    { name: 'giverNpcKey', type: 'key', column: 'giverNpcId' },
    { name: 'parentKey', type: 'key', column: 'parentId' },
    { name: 'objectives', type: 'json' },
  ],
  faction: [
    { name: 'name', type: 'string' },
    { name: 'kind', type: 'string' },
    { name: 'body', type: 'string' },
    { name: 'goals', type: 'string' },
    { name: 'dmSecret', type: 'string' },
    { name: 'hidden', type: 'boolean' },
    { name: 'reputation', type: 'number' },
    { name: 'standing', type: 'string', default: 'neutral' },
  ],
};

/** Cross-reference fields per kind, as `[portableField, entityColumn, referencedKind]`. */
export const REFERENCE_FIELDS: Record<ModuleArtifactKind, ReadonlyArray<[string, string, ModuleArtifactKind]>> = {
  location: [['parentKey', 'parentId', 'location']],
  npc: [
    ['locationKey', 'locationId', 'location'],
    ['factionKey', 'factionId', 'faction'],
  ],
  quest: [
    ['giverNpcKey', 'giverNpcId', 'npc'],
    ['parentKey', 'parentId', 'quest'],
  ],
  faction: [],
};

/** The column holding the display name for each kind (quests call it `title`). */
export const DISPLAY_NAME_FIELD: Record<ModuleArtifactKind, string> = {
  location: 'name',
  npc: 'name',
  quest: 'title',
  faction: 'name',
};

export type PortableContent = Record<string, unknown>;

const MAX_TEXT_FIELD = 100_000;
const MAX_OBJECTIVES = 200;

function normalizeString(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, MAX_TEXT_FIELD);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function normalizeNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return 0;
}

function normalizeNullableNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value === 'true' || value === '1';
  return false;
}

/** A reference key: a non-empty artifact key, or null for "no reference". */
function normalizeKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, 160);
  return trimmed.length > 0 ? trimmed : null;
}

/** Quest objectives normalize to an ordered `[{text, sortOrder}]` — `done` is play state. */
function normalizeObjectives(value: unknown): Array<{ text: string; sortOrder: number }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_OBJECTIVES).map((raw, index) => {
    const rec = raw != null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const text = typeof raw === 'string' ? raw : normalizeString(rec.text);
    const sortOrder = rec.sortOrder == null ? index : normalizeNumber(rec.sortOrder);
    return { text: text.slice(0, 2000), sortOrder };
  });
}

function normalizeField(spec: FieldSpec, value: unknown): unknown {
  switch (spec.type) {
    case 'string': {
      const text = normalizeString(value);
      return text === '' && spec.default != null ? spec.default : text;
    }
    case 'number':
      return normalizeNumber(value);
    case 'nullableNumber':
      return normalizeNullableNumber(value);
    case 'boolean':
      return normalizeBoolean(value);
    case 'key':
      return normalizeKey(value);
    case 'json':
    default:
      return normalizeObjectives(value);
  }
}

/**
 * Project an arbitrary payload onto the kind's closed portable field set, normalizing
 * every value. The result is fully determined by the whitelist, so two payloads that
 * differ only in ignored keys hash identically.
 */
export function projectPortable(kind: ModuleArtifactKind, data: unknown): PortableContent {
  const source = data != null && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const out: PortableContent = {};
  for (const spec of PORTABLE_FIELDS[kind]) {
    out[spec.name] = normalizeField(spec, source[spec.name]);
  }
  return out;
}

/** sha256 of the projected content under the repo-wide stable-JSON encoding. */
export function hashPortable(kind: ModuleArtifactKind, data: unknown): string {
  return createHash('sha256').update(`${kind} ${stableStringify(projectPortable(kind, data))}`).digest('hex');
}

/** Hash an ALREADY-projected payload (skips re-projection when the caller has one). */
export function hashProjected(kind: ModuleArtifactKind, projected: PortableContent): string {
  return createHash('sha256').update(`${kind} ${stableStringify(projected)}`).digest('hex');
}

function fieldEquals(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

export type MergeResult = {
  /** The content to write, field by field, under the chosen conflict handling. */
  merged: PortableContent;
  /** Every field that moved on either side, with all three legs for display. */
  fields: ModuleFieldChange[];
  /** Field names where BASE, LOCAL and UPSTREAM all disagree. */
  conflictFields: string[];
};

/**
 * Field-level three-way merge. `conflictWinner` decides only the fields that genuinely
 * collide; every other field follows the deterministic rules above regardless.
 *
 * All three inputs are projected first, so callers may pass raw payloads.
 */
export function threeWayMerge(
  kind: ModuleArtifactKind,
  base: unknown,
  local: unknown,
  upstream: unknown,
  conflictWinner: 'upstream' | 'local' = 'local',
): MergeResult {
  const b = projectPortable(kind, base);
  const l = projectPortable(kind, local);
  const u = projectPortable(kind, upstream);
  const merged: PortableContent = {};
  const fields: ModuleFieldChange[] = [];
  const conflictFields: string[] = [];

  for (const spec of PORTABLE_FIELDS[kind]) {
    const name = spec.name;
    const bv = b[name];
    const lv = l[name];
    const uv = u[name];
    const upstreamMoved = !fieldEquals(uv, bv);
    const localMoved = !fieldEquals(lv, bv);

    if (!upstreamMoved) {
      // The publisher did not touch this field; whatever the table has stands.
      merged[name] = lv;
    } else if (!localMoved) {
      // Only the publisher moved it — take the correction.
      merged[name] = uv;
    } else if (fieldEquals(lv, uv)) {
      // Both moved to the same value: converged, not a conflict.
      merged[name] = uv;
    } else {
      conflictFields.push(name);
      merged[name] = conflictWinner === 'upstream' ? uv : lv;
    }

    if (upstreamMoved || localMoved) {
      fields.push({
        field: name,
        base: bv,
        local: lv,
        upstream: uv,
        conflict: upstreamMoved && localMoved && !fieldEquals(lv, uv),
      });
    }
  }

  return { merged, fields, conflictFields };
}

/**
 * The overlay for an artifact: the fields where the campaign's content still diverges
 * from its (new) baseline. Recomputed after every apply so the next update starts from a
 * clean three-way compare instead of accumulating drift. Returns null when there is no
 * divergence at all, which keeps `overlay_json` NULL for the common untouched artifact.
 */
export function computeOverlay(
  kind: ModuleArtifactKind,
  baseline: unknown,
  current: unknown,
): PortableContent | null {
  const b = projectPortable(kind, baseline);
  const c = projectPortable(kind, current);
  const overlay: PortableContent = {};
  let diverged = false;
  for (const spec of PORTABLE_FIELDS[kind]) {
    if (!fieldEquals(b[spec.name], c[spec.name])) {
      overlay[spec.name] = c[spec.name];
      diverged = true;
    }
  }
  return diverged ? overlay : null;
}

/** Apply a stored overlay patch on top of a baseline, yielding the effective content. */
export function applyOverlay(
  kind: ModuleArtifactKind,
  baseline: unknown,
  overlay: unknown,
): PortableContent {
  const b = projectPortable(kind, baseline);
  if (overlay == null || typeof overlay !== 'object') return b;
  const patch = overlay as Record<string, unknown>;
  for (const spec of PORTABLE_FIELDS[kind]) {
    if (Object.prototype.hasOwnProperty.call(patch, spec.name)) {
      b[spec.name] = normalizeField(spec, patch[spec.name]);
    }
  }
  return b;
}

/** Stable `<kind>:<key>` identifier used for resolution maps and API keys. */
export function artifactId(kind: ModuleArtifactKind, key: string): string {
  return `${kind}:${key}`;
}
