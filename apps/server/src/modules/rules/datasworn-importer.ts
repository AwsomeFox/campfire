import { BadRequestException } from '@nestjs/common';
import { isOpenLicense, licenseForbidsRedistribution, type RuleEntryType } from '@campfire/schema';
import type { ImportedEntry, Open5eImportLogger } from './open5e-importer';

/**
 * Importer for **Ironsworn: Starforged** via the canonical `rsek/datasworn` dataset
 * (issue #405). Unlike the sibling importers (Open5e/PF2e/OSR/Starfinder), which paginate a
 * REST API a section at a time, datasworn ships as ONE self-contained JSON document
 * (~1.4 MB) covering the whole ruleset, so this importer fetches + validates the file ONCE
 * and then maps each requested section out of the in-memory document. The install path
 * (rules.service#installFromDatasworn) still reports per-section progress so the job UI is
 * unchanged.
 *
 * License (issue #405 — honor CC-BY-4.0 attribution):
 *   Datasworn's Starforged data is 100% Creative Commons Attribution 4.0 (CC-BY-4.0) — a
 *   full recursive walk of the file finds exactly one license value, the CC-BY-4.0 URL, on
 *   every content object. (Datasworn's schema/typings are separately MIT, but this importer
 *   only touches the rulebook CONTENT.) Every imported entry is stamped with the CC-BY-4.0
 *   license and an attribution line built from the object's own `_source` (title, authors,
 *   page) plus a link to the license and the source — the attribution CC-BY legally
 *   requires. As defense-in-depth, an object whose `_source.license` is NOT an open license
 *   (e.g. a hypothetical future CC-BY-NC entry) is skipped with a warning rather than
 *   mislabeled as CC-BY.
 *
 * Section mapping (issue #405 — map honestly to Campfire's RuleEntryType). Starforged is a
 * PbtA/narrative game: there are no spells/classes/races, and its native model is
 * oracles/moves/assets. Only NPCs map cleanly to a statblock, so this is framed as a
 * reference-text pack with one real statblock section:
 *   - npcs    → 'monster' (23 creature statblocks — the one clean statblock fit)
 *   - assets  → 'item'    (87 ability/gear packages)
 *   - moves   → 'section' (56 action-resolution rules — reference text)
 *   - oracles → 'section' (262 leaf random-tables — reference text; see recursive flatten)
 *   - truths  → 'section' (14 setting-seed entries — reference text)
 *
 * Nested collections + recursive oracle flattening (issue #405): datasworn groups content in
 * collections. `npcs`/`assets`/`moves` are one collection level deep (collection → contents),
 * but `oracles` are COLLECTIONS-OF-COLLECTIONS: a top-level oracle collection may hold leaf
 * tables in `contents` AND further sub-collections in `collections`, to arbitrary depth
 * (e.g. `oracles/characters/name/...`). `flattenOracleTables` walks that tree recursively and
 * yields every leaf rollable table (`type: 'oracle_rollable'`) as one entry, recording its
 * collection path so related tables stay grouped in the reader.
 */

/** Canonical live source — the single Starforged JSON file in the canonical rsek/datasworn repo. */
export const DATASWORN_STARFORGED_URL =
  'https://raw.githubusercontent.com/rsek/datasworn/main/datasworn/starforged/starforged.json';

/**
 * Human-readable license string stamped on every entry. Datasworn records the license as the
 * bare CC-BY-4.0 URL, which does NOT contain the "cc-by"/"creative commons" tokens the shared
 * `isOpenLicense` gate matches — so we normalize to this canonical string (which passes the
 * gate and reads correctly in the compendium). This honors the CC-BY-4.0 attribution/licensing
 * the issue requires.
 */
export const DATASWORN_LICENSE = 'Creative Commons Attribution 4.0 International (CC-BY-4.0)';
export const DATASWORN_LICENSE_URL = 'https://creativecommons.org/licenses/by/4.0';
export const DATASWORN_PACK_SLUG = 'ironsworn-starforged';
export const DATASWORN_PACK_NAME = 'Ironsworn: Starforged';

/** Guard against a pathological/hostile document blowing up memory (real file is ~660 entries). */
export const DATASWORN_MAX_ENTRIES_PER_SECTION = 5000;
const FETCH_TIMEOUT_MS = 30_000;
/** Max response size we'll buffer (the real file is ~1.4 MB; cap well above it, reject a runaway). */
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

export type DataswornSection = 'npcs' | 'assets' | 'moves' | 'oracles' | 'truths';

export const ALL_DATASWORN_SECTIONS: DataswornSection[] = ['npcs', 'assets', 'moves', 'oracles', 'truths'];

const SECTION_TO_ENTRY_TYPE: Record<DataswornSection, RuleEntryType> = {
  npcs: 'monster', // the one clean statblock fit
  assets: 'item',
  moves: 'section',
  oracles: 'section',
  truths: 'section',
};

export function entryTypeForDataswornSection(section: DataswornSection): RuleEntryType {
  return SECTION_TO_ENTRY_TYPE[section];
}

export interface DataswornSectionResult {
  entries: ImportedEntry[];
  /** Objects skipped: malformed, or carrying a non-open license (defense-in-depth). */
  skippedCount: number;
}

/** A datasworn `_source` sub-object — per-object provenance (title/authors/page/url/license). */
interface DataswornSource {
  title?: string;
  page?: number;
  authors?: Array<{ name?: string }>;
  url?: string;
  license?: string;
}

/** The top-level datasworn ruleset document (only the fields this importer reads are typed). */
export interface DataswornDocument {
  _id?: string;
  type?: string;
  title?: string;
  authors?: Array<{ name?: string }>;
  url?: string;
  license?: string;
  npcs?: Record<string, unknown>;
  assets?: Record<string, unknown>;
  moves?: Record<string, unknown>;
  oracles?: Record<string, unknown>;
  truths?: Record<string, unknown>;
}

const consoleLogger: Open5eImportLogger = {
  // eslint-disable-next-line no-console
  warn: (message: string) => console.warn(message),
  // eslint-disable-next-line no-console
  info: (message: string) => console.info(message),
};

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(asString).filter(Boolean) : [];
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Stable, unique slug from a datasworn `_id` (e.g. "starforged/npcs/sample_npcs/chiton").
 * The `_id` path is globally unique in the document, so dropping the ruleset prefix and
 * hyphenating the remaining segments yields a collision-free slug across collections — safer
 * than slugifying the bare name (two collections can hold same-named entries). Falls back to
 * a slugified name when `_id` is missing.
 */
function slugFromId(id: string, fallbackName: string): string {
  const cleaned = id
    .replace(/^[^/]+\//, '') // drop the leading ruleset id ("starforged/")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (cleaned) return truncate(cleaned, 160);
  const nameSlug = fallbackName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return truncate(nameSlug, 160);
}

function authorsOf(src: DataswornSource | null, doc: DataswornDocument): string {
  const list = src?.authors?.length ? src.authors : doc.authors;
  return (list ?? []).map((a) => asString(a?.name)).filter(Boolean).join(', ');
}

/**
 * The CC-BY version declared by a license URL (e.g. "4.0" for
 * `https://creativecommons.org/licenses/by/4.0`), or null when the URL is not a CC-BY license.
 */
function ccByVersion(url: string): string | null {
  const m = url
    .trim()
    .toLowerCase()
    .match(/creativecommons\.org\/licenses\/by\/(\d+(?:\.\d+)?)\/?$/);
  return m ? m[1] : null;
}

/**
 * Normalizes a CC-BY license URL to a human license string WITHOUT mislabeling its version:
 * exactly 4.0 becomes the canonical DATASWORN_LICENSE string, any OTHER CC-BY version keeps its
 * own version (so a /by/3.0 file isn't stamped as 4.0), and a non-CC-BY URL is returned as-is.
 */
function normalizeCcByLicense(url: string): string {
  const ver = ccByVersion(url);
  if (!ver) return url;
  return ver === '4.0' ? DATASWORN_LICENSE : `Creative Commons Attribution ${ver} (CC-BY-${ver})`;
}

/**
 * The CC-BY attribution line the license obliges us to display: title + author + license +
 * a link to the license, plus the page when known. Built from the object's own `_source`,
 * falling back to the document's top-level provenance.
 */
function attributionOf(
  src: DataswornSource | null,
  doc: DataswornDocument,
  licenseUrl: string,
  licenseLabel: string,
): string {
  const title = asString(src?.title) || asString(doc.title) || DATASWORN_PACK_NAME;
  const authors = authorsOf(src, doc);
  const page = typeof src?.page === 'number' ? `, p. ${src.page}` : '';
  const by = authors ? ` by ${authors}` : '';
  // Credit under the ACTUAL license (caller passes the resolved label), never a hard-coded
  // "CC BY 4.0" — a non-4.0 CC-BY or a different open license must not be misattributed.
  const licLink = licenseUrl || DATASWORN_LICENSE_URL;
  return `${title}${by}${page}, licensed under ${licenseLabel} (${licLink}).`;
}

function sourceUrlOf(src: DataswornSource | null, doc: DataswornDocument): string {
  return asString(src?.url) || asString(doc.url) || 'https://ironswornrpg.com';
}

/**
 * The effective license URL for an object — its own `_source.license`, else the ruleset's
 * document-level license (datasworn objects inherit the ruleset license). No fabricated
 * fallback to the CC-BY URL: when NEITHER the object nor the document declares a license this
 * stays empty, so the caller treats it as "unknown" and skips the object rather than assuming
 * it is open.
 */
function licenseUrlOf(src: DataswornSource | null, doc: DataswornDocument): string {
  return asString(src?.license) || asString(doc.license);
}

/**
 * Common per-entry provenance for a datasworn object. Returns the CC-BY-4.0 license string,
 * the attribution line, author, and source-url — or `null` when the object's license is NOT
 * open (skip it rather than mislabel). All Starforged content is CC-BY-4.0, so `null` never
 * happens for the real file; the guard is honest insurance for future/foreign datasets.
 */
function provenanceOf(
  obj: Record<string, unknown>,
  doc: DataswornDocument,
): { license: string; attribution: string; author: string; sourceUrl: string } | null {
  const src = asRecord(obj._source) as DataswornSource | null;
  const licenseUrl = licenseUrlOf(src, doc);
  // The datasworn license is a URL; normalize the CC-BY family to a human string, preserving
  // the ACTUAL version (only /by/4.0 maps to the canonical CC-BY-4.0 string). A URL that isn't
  // a recognized CC-BY version and isn't otherwise open (e.g. "All Rights Reserved", or a
  // missing license) is rejected so the object is skipped rather than mislabeled.
  const ccByVer = ccByVersion(licenseUrl);
  const license = normalizeCcByLicense(licenseUrl);
  if (ccByVer == null && !isOpenLicense(license)) return null;
  // Defense-in-depth: isOpenLicense is a permissive substring match, so "CC-BY-NC-4.0" would
  // pass on the "cc-by" substring. Explicitly reject NC/ND content (which can't be legally
  // redistributed) — checked on both the resolved string and the raw URL.
  if (licenseForbidsRedistribution(license) || licenseForbidsRedistribution(licenseUrl)) return null;
  // Attribution label: the exact CC-BY version, or the resolved open-license string otherwise.
  const licenseLabel = ccByVer ? `CC BY ${ccByVer}` : license;
  return {
    license,
    attribution: attributionOf(src, doc, licenseUrl, licenseLabel),
    author: authorsOf(src, doc),
    sourceUrl: sourceUrlOf(src, doc),
  };
}

/** Renders a markdown bullet list from a string array, or '' when empty. */
function bulletList(items: string[]): string {
  return items.map((i) => `- ${i}`).join('\n');
}

// ---------- per-section mappers ----------

/**
 * NPC (→ monster). Real statblock-ish content: rank, nature, features, drives, tactics,
 * quest starter, and nested `variants`. Variants stay folded into the parent entry (body +
 * dataJson) so the section keeps its honest count of 23 distinct creatures rather than
 * exploding sub-forms into separate rows.
 */
function mapNpc(npc: Record<string, unknown>, doc: DataswornDocument): ImportedEntry | null {
  const prov = provenanceOf(npc, doc);
  if (!prov) return null;
  const name = asString(npc.name);
  const rank = asString(npc.rank) || (typeof npc.rank === 'number' ? String(npc.rank) : '');
  const nature = asString(npc.nature);
  const summary = asString(npc.summary);
  const description = asString(npc.description);
  const features = asStringArray(npc.features);
  const drives = asStringArray(npc.drives);
  const tactics = asStringArray(npc.tactics);
  const questStarter = asString(npc.quest_starter);
  const variantsRec = asRecord(npc.variants);
  const variants = variantsRec
    ? Object.values(variantsRec)
        .map(asRecord)
        .filter((v): v is Record<string, unknown> => v !== null)
        .map((v) => ({
          name: asString(v.name),
          rank: typeof v.rank === 'number' ? v.rank : asString(v.rank),
          description: asString(v.description),
        }))
    : [];

  const bodyParts: string[] = [];
  if (description) bodyParts.push(description);
  if (features.length) bodyParts.push(`**Features**\n\n${bulletList(features)}`);
  if (drives.length) bodyParts.push(`**Drives**\n\n${bulletList(drives)}`);
  if (tactics.length) bodyParts.push(`**Tactics**\n\n${bulletList(tactics)}`);
  if (questStarter) bodyParts.push(`**Quest Starter**\n\n${questStarter}`);
  for (const v of variants) {
    if (!v.name) continue;
    bodyParts.push(`### ${v.name}${v.rank ? ` (rank ${v.rank})` : ''}\n\n${v.description}`);
  }

  return {
    slug: slugFromId(asString(npc._id), name),
    name,
    type: 'monster',
    summary: truncate(
      [rank ? `Rank ${rank}` : null, nature || null, summary || null].filter(Boolean).join(' · ') || description,
      300,
    ),
    body: bodyParts.join('\n\n'),
    dataJson: JSON.stringify({
      rank: rank || null,
      nature: nature || null,
      features,
      drives,
      tactics,
      questStarter: questStarter || null,
      variants,
    }),
    license: prov.license,
    source: DATASWORN_PACK_NAME,
    attribution: prov.attribution,
    author: prov.author,
    sourceUrl: prov.sourceUrl,
  };
}

/** Asset (→ item). Character ability/gear package: category + abilities + controls/options. */
function mapAsset(asset: Record<string, unknown>, doc: DataswornDocument): ImportedEntry | null {
  const prov = provenanceOf(asset, doc);
  if (!prov) return null;
  const name = asString(asset.name);
  const category = asString(asset.category);
  const abilities = Array.isArray(asset.abilities)
    ? (asset.abilities as unknown[]).map(asRecord).map((a) => asString(a?.text)).filter(Boolean)
    : [];
  const requirement = asString(asset.requirement);

  const bodyParts: string[] = [];
  if (requirement) bodyParts.push(`*${requirement}*`);
  if (abilities.length) bodyParts.push(abilities.map((a) => `- ${a}`).join('\n\n'));

  return {
    slug: slugFromId(asString(asset._id), name),
    name,
    type: 'item',
    summary: truncate(category || abilities[0] || '', 300),
    body: bodyParts.join('\n\n'),
    dataJson: JSON.stringify({
      category: category || null,
      requirement: requirement || null,
      abilities,
      controls: asset.controls ?? null,
      options: asset.options ?? null,
      shared: asset.shared ?? null,
      countAsImpact: asset.count_as_impact ?? null,
    }),
    license: prov.license,
    source: DATASWORN_PACK_NAME,
    attribution: prov.attribution,
    author: prov.author,
    sourceUrl: prov.sourceUrl,
  };
}

/** Move (→ section). Action-resolution rule: roll type, trigger text, body text, outcomes. */
function mapMove(move: Record<string, unknown>, doc: DataswornDocument, categoryName: string): ImportedEntry | null {
  const prov = provenanceOf(move, doc);
  if (!prov) return null;
  const name = asString(move.name);
  const rollType = asString(move.roll_type);
  const text = asString(move.text);
  const trigger = asRecord(move.trigger);
  const triggerText = trigger ? asString(trigger.text) : '';

  const bodyParts: string[] = [];
  if (triggerText) bodyParts.push(`**Trigger:** ${triggerText}`);
  if (text) bodyParts.push(text);
  const outcomes = asRecord(move.outcomes);
  if (outcomes) {
    for (const key of ['strong_hit', 'weak_hit', 'miss']) {
      const o = asRecord(outcomes[key]);
      const otext = o ? asString(o.text) : '';
      if (otext) bodyParts.push(`**${key.replace('_', ' ')}:** ${otext}`);
    }
  }

  return {
    slug: slugFromId(asString(move._id), name),
    name,
    type: 'section',
    summary: truncate([categoryName, rollType ? `roll: ${rollType}` : null].filter(Boolean).join(' · ') || text, 300),
    body: bodyParts.join('\n\n'),
    dataJson: JSON.stringify({
      category: categoryName || null,
      rollType: rollType || null,
      trigger: move.trigger ?? null,
      outcomes: move.outcomes ?? null,
    }),
    license: prov.license,
    source: DATASWORN_PACK_NAME,
    attribution: prov.attribution,
    author: prov.author,
    sourceUrl: prov.sourceUrl,
  };
}

/** Renders an oracle table's rows as a markdown table (roll range | result[, detail]). */
function oracleRowsToMarkdown(rows: unknown, columnLabels: Record<string, unknown> | null): string {
  if (!Array.isArray(rows)) return '';
  const rollLabel = asString(columnLabels?.roll) || 'Roll';
  const resultLabel = asString(columnLabels?.text) || 'Result';
  const lines: string[] = [`| ${rollLabel} | ${resultLabel} |`, '| --- | --- |'];
  for (const raw of rows) {
    const row = asRecord(raw);
    if (!row) continue;
    const min = row.min;
    const max = row.max;
    const range = min === max || max == null ? `${min ?? ''}` : `${min ?? ''}–${max}`;
    const text = asString(row.text);
    const text2 = asString(row.text2);
    const result = [text, text2].filter(Boolean).join(' — ').replace(/\|/g, '\\|');
    lines.push(`| ${range} | ${result} |`);
  }
  return lines.join('\n');
}

/** One leaf oracle rollable table (→ section). `collectionPath` groups related tables. */
function mapOracleTable(
  table: Record<string, unknown>,
  doc: DataswornDocument,
  collectionPath: string[],
): ImportedEntry | null {
  const prov = provenanceOf(table, doc);
  if (!prov) return null;
  const name = asString(table.name);
  const dice = asString(table.dice);
  const columnLabels = asRecord(table.column_labels);
  const summary = asString(table.summary);
  const bodyTable = oracleRowsToMarkdown(table.rows, columnLabels);

  return {
    slug: slugFromId(asString(table._id), name),
    name,
    type: 'section',
    summary: truncate(
      [collectionPath.join(' › ') || null, dice || null, summary || null].filter(Boolean).join(' · '),
      300,
    ),
    body: bodyTable,
    dataJson: JSON.stringify({
      dice: dice || null,
      oracleType: asString(table.oracle_type) || null,
      collectionPath,
      columnLabels: table.column_labels ?? null,
      rows: table.rows ?? null,
    }),
    license: prov.license,
    source: DATASWORN_PACK_NAME,
    attribution: prov.attribution,
    author: prov.author,
    sourceUrl: prov.sourceUrl,
  };
}

/** Truth (→ section). Setting-seed entry: renders its options (summary/description/quest starter). */
function mapTruth(truth: Record<string, unknown>, doc: DataswornDocument): ImportedEntry | null {
  const prov = provenanceOf(truth, doc);
  if (!prov) return null;
  const name = asString(truth.name);
  const options = Array.isArray(truth.options) ? (truth.options as unknown[]).map(asRecord) : [];

  const bodyParts: string[] = [];
  options.forEach((opt, i) => {
    if (!opt) return;
    const s = asString(opt.summary);
    const d = asString(opt.description);
    const qs = asString(opt.quest_starter);
    const heading = s ? `### ${s}` : `### Option ${i + 1}`;
    const chunk = [heading, d, qs ? `**Quest Starter:** ${qs}` : ''].filter(Boolean).join('\n\n');
    if (chunk) bodyParts.push(chunk);
  });

  return {
    slug: slugFromId(asString(truth._id), name),
    name,
    type: 'section',
    summary: truncate(
      options.map((o) => asString(o?.summary)).filter(Boolean).join(' / ') || name,
      300,
    ),
    body: bodyParts.join('\n\n'),
    dataJson: JSON.stringify({ dice: asString(truth.dice) || null, options: truth.options ?? null }),
    license: prov.license,
    source: DATASWORN_PACK_NAME,
    attribution: prov.attribution,
    author: prov.author,
    sourceUrl: prov.sourceUrl,
  };
}

// ---------- section extraction (walks the in-memory document) ----------

/**
 * Iterates one level of `collection → contents` (npcs/assets), invoking `map` per leaf object.
 * `collectionsRoot` is the section's top-level record of collections.
 */
function mapSingleLevelCollections(
  collectionsRoot: Record<string, unknown> | undefined,
  map: (obj: Record<string, unknown>) => ImportedEntry | null,
): DataswornSectionResult {
  const entries: ImportedEntry[] = [];
  let skippedCount = 0;
  const root = asRecord(collectionsRoot) ?? {};
  for (const collection of Object.values(root)) {
    const coll = asRecord(collection);
    const contents = asRecord(coll?.contents);
    if (!contents) continue;
    for (const obj of Object.values(contents)) {
      const rec = asRecord(obj);
      if (!rec) {
        skippedCount += 1;
        continue;
      }
      const entry = map(rec);
      if (entry && entry.name) entries.push(entry);
      else skippedCount += 1;
      if (entries.length >= DATASWORN_MAX_ENTRIES_PER_SECTION) return { entries, skippedCount };
    }
  }
  return { entries, skippedCount };
}

/** Moves are `category → contents`; we thread the category name through to each move. */
function mapMoves(movesRoot: Record<string, unknown> | undefined, doc: DataswornDocument): DataswornSectionResult {
  const entries: ImportedEntry[] = [];
  let skippedCount = 0;
  const root = asRecord(movesRoot) ?? {};
  for (const category of Object.values(root)) {
    const cat = asRecord(category);
    const categoryName = asString(cat?.name);
    const contents = asRecord(cat?.contents);
    if (!contents) continue;
    for (const obj of Object.values(contents)) {
      const rec = asRecord(obj);
      if (!rec) {
        skippedCount += 1;
        continue;
      }
      const entry = mapMove(rec, doc, categoryName);
      if (entry && entry.name) entries.push(entry);
      else skippedCount += 1;
      if (entries.length >= DATASWORN_MAX_ENTRIES_PER_SECTION) return { entries, skippedCount };
    }
  }
  return { entries, skippedCount };
}

/**
 * RECURSIVE oracle flattening (issue #405): oracles are collections-of-collections. A
 * collection may hold leaf rollable tables in `contents` AND further sub-collections in
 * `collections`, to arbitrary depth. This walks the whole tree, emitting one entry per leaf
 * table and recording the human-readable collection path (collection names) so related
 * tables stay grouped in the reader. Guards against a malformed self-referential structure
 * with a depth cap.
 */
function flattenOracleTables(
  node: Record<string, unknown>,
  doc: DataswornDocument,
  path: string[],
  out: ImportedEntry[],
  counters: { skipped: number },
  depth: number,
): void {
  if (depth > 12 || out.length >= DATASWORN_MAX_ENTRIES_PER_SECTION) return;
  const contents = asRecord(node.contents);
  if (contents) {
    for (const obj of Object.values(contents)) {
      const rec = asRecord(obj);
      // Leaf tables are `type: 'oracle_rollable'`; anything else in contents is skipped.
      if (!rec || asString(rec.type) !== 'oracle_rollable') {
        counters.skipped += 1;
        continue;
      }
      const entry = mapOracleTable(rec, doc, path);
      if (entry && entry.name) out.push(entry);
      else counters.skipped += 1;
      if (out.length >= DATASWORN_MAX_ENTRIES_PER_SECTION) return;
    }
  }
  const subCollections = asRecord(node.collections);
  if (subCollections) {
    for (const sub of Object.values(subCollections)) {
      const subRec = asRecord(sub);
      if (!subRec) continue;
      flattenOracleTables(subRec, doc, [...path, asString(subRec.name)].filter(Boolean), out, counters, depth + 1);
    }
  }
}

function mapOracles(oraclesRoot: Record<string, unknown> | undefined, doc: DataswornDocument): DataswornSectionResult {
  const entries: ImportedEntry[] = [];
  const counters = { skipped: 0 };
  const root = asRecord(oraclesRoot) ?? {};
  for (const collection of Object.values(root)) {
    const coll = asRecord(collection);
    if (!coll) continue;
    flattenOracleTables(coll, doc, [asString(coll.name)].filter(Boolean), entries, counters, 0);
    if (entries.length >= DATASWORN_MAX_ENTRIES_PER_SECTION) break;
  }
  return { entries, skippedCount: counters.skipped };
}

function mapTruths(truthsRoot: Record<string, unknown> | undefined, doc: DataswornDocument): DataswornSectionResult {
  const entries: ImportedEntry[] = [];
  let skippedCount = 0;
  const root = asRecord(truthsRoot) ?? {};
  for (const obj of Object.values(root)) {
    const rec = asRecord(obj);
    if (!rec) {
      skippedCount += 1;
      continue;
    }
    const entry = mapTruth(rec, doc);
    if (entry && entry.name) entries.push(entry);
    else skippedCount += 1;
  }
  return { entries, skippedCount };
}

/**
 * Maps one section out of an already-fetched datasworn document. Pure (no network) so the
 * whole file is fetched once and every requested section is mapped from memory.
 */
export function mapDataswornSection(
  doc: DataswornDocument,
  section: DataswornSection,
  logger: Open5eImportLogger = consoleLogger,
): DataswornSectionResult {
  let result: DataswornSectionResult;
  switch (section) {
    case 'npcs':
      result = mapSingleLevelCollections(doc.npcs, (o) => mapNpc(o, doc));
      break;
    case 'assets':
      result = mapSingleLevelCollections(doc.assets, (o) => mapAsset(o, doc));
      break;
    case 'moves':
      result = mapMoves(doc.moves, doc);
      break;
    case 'oracles':
      result = mapOracles(doc.oracles, doc);
      break;
    case 'truths':
      result = mapTruths(doc.truths, doc);
      break;
    default:
      throw new BadRequestException(`Unknown datasworn section "${section}"`);
  }
  logger.info(
    `[datasworn-importer] section "${section}": mapped ${result.entries.length} entries` +
      (result.skippedCount > 0 ? ` (${result.skippedCount} skipped)` : ''),
  );
  return result;
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches and validates the whole datasworn document ONCE. Enforces a size ceiling, verifies
 * it parses as JSON and has the expected top-level ruleset shape, and confirms the document's
 * license is open (CC-BY-4.0) before any section is mapped — so a wrong URL or a
 * non-open/renamed file fails fast with a clear 400 rather than importing garbage.
 */
export async function fetchDataswornDocument(
  url: string = DATASWORN_STARFORGED_URL,
  logger: Open5eImportLogger = consoleLogger,
): Promise<DataswornDocument> {
  let res: Response;
  try {
    res = await fetchWithTimeout(url);
  } catch (err) {
    throw new BadRequestException(`Failed to fetch datasworn document from ${url}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new BadRequestException(`Datasworn document fetch returned HTTP ${res.status} for ${url}`);
  }

  const lengthHeader = Number(res.headers.get('content-length') ?? '0');
  if (Number.isFinite(lengthHeader) && lengthHeader > MAX_DOCUMENT_BYTES) {
    throw new BadRequestException(
      `Datasworn document at ${url} is ${lengthHeader} bytes, over the ${MAX_DOCUMENT_BYTES}-byte cap`,
    );
  }

  const text = await res.text();
  // Enforce the cap on real UTF-8 BYTES, not JS string length (chars), so a multi-byte body
  // can't slip past a char-count check.
  if (Buffer.byteLength(text, 'utf8') > MAX_DOCUMENT_BYTES) {
    throw new BadRequestException(`Datasworn document at ${url} exceeds the ${MAX_DOCUMENT_BYTES}-byte cap`);
  }

  let doc: DataswornDocument;
  try {
    doc = JSON.parse(text) as DataswornDocument;
  } catch (err) {
    throw new BadRequestException(`Datasworn document at ${url} is not valid JSON: ${(err as Error).message}`);
  }
  if (!doc || typeof doc !== 'object') {
    throw new BadRequestException(`Datasworn document at ${url} did not parse to an object`);
  }
  // Sanity-check the shape: a datasworn ruleset carries at least one of the sections we map.
  const hasAnySection = ALL_DATASWORN_SECTIONS.some((s) => asRecord((doc as Record<string, unknown>)[s]));
  if (!hasAnySection) {
    throw new BadRequestException(
      `Datasworn document at ${url} has none of the expected sections (${ALL_DATASWORN_SECTIONS.join(', ')}) — is this a Starforged datasworn file?`,
    );
  }
  // Honor the license requirement up front: the document must be open-licensed.
  const docLicenseUrl = asString(doc.license);
  const docLicense = normalizeCcByLicense(docLicenseUrl);
  if (
    !docLicenseUrl ||
    (ccByVersion(docLicenseUrl) == null && !isOpenLicense(docLicense)) ||
    licenseForbidsRedistribution(docLicense) ||
    licenseForbidsRedistribution(docLicenseUrl)
  ) {
    throw new BadRequestException(
      `Datasworn document at ${url} ${
        docLicenseUrl ? `declares a non-open license ("${docLicenseUrl}")` : 'declares no license'
      } — only open-licensed content can be imported`,
    );
  }
  logger.info(`[datasworn-importer] fetched document "${asString(doc.title) || asString(doc._id)}" from ${url}`);
  return doc;
}
