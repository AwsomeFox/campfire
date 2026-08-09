import { randomUUID, createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import {
  PF2E_PACK_SLUG,
  SF2E_PACK_SLUG,
  PF1E_PACK_SLUG,
  STARFINDER_ADAPTER_ID,
  isValidUploadLicense,
  isSelfAuthoredLicense,
  licenseForbidsRedistribution,
  type RuleEntry,
  type RuleEntryType,
  type RulePack,
  type RulePackKind,
  type RulePackInstall,
  type RulePackInstallJob,
  type RulePackUpdatePreview,
  type RulePackInstallSource,
  type RulePackUpload,
  type RuleSearchFacet,
  type RuleSearchPage,
  HomebrewRuleEntryInput,
  OPEN_LEGEND_PACK_SLUG,
  RULE_PACK_SOURCE_META,
} from '@campfire/schema';
import { DB, RULE_ENTRIES_FTS_AVAILABLE, type DrizzleDb } from '../../db/db.module';
import { rulePacks, ruleEntries, ruleEntryRevisions, combatants, campaigns, importJobs } from '../../db/schema';
import { nowIso } from '../../common/time';
import { fromJsonText } from '../../common/json';
import { foldForSearch } from '../../common/text-search';
import { AuditService } from '../audit/audit.service';
import { auditActor, auditActorRole } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import {
  clampRuleSearchLimit,
  decodeRuleSearchCursor,
  encodeRuleSearchCursor,
  type BrowseCursor,
  type FtsCursor,
  type LikeCursor,
} from './rules-search';
import {
  ALL_OPEN5E_SECTIONS,
  MAX_ENTRIES_PER_SECTION,
  OPEN5E_DEFAULT_BASE_URL,
  fetchOpen5eSection,
  OPEN5E_PACK_VERSION,
  type ImportedEntry,
  type Open5eSection,
} from './open5e-importer';
import {
  ALL_OPEN_LEGEND_SECTIONS,
  OL_MAX_ENTRIES_PER_SECTION,
  OPEN_LEGEND_DEFAULT_BASE_URL,
  OPEN_LEGEND_DEFAULT_LICENSE,
  fetchOpenLegendSection,
  type OpenLegendSection,
} from './open-legend-importer';
import {
  ALL_PF2E_SECTIONS,
  MAX_ENTRIES_PER_SECTION as PF2E_MAX_ENTRIES_PER_SECTION,
  PF2E_DEFAULT_BASE_URL,
  PF2E_DEFAULT_LICENSE,
  PF2E_PACK_NAME,
  SF2E_DEFAULT_BASE_URL,
  SF2E_DEFAULT_LICENSE,
  SF2E_PACK_NAME,
  fetchPf2eSection,
  fetchSf2eSection,
  type Pf2eSection,
} from './pf2e-importer';
import {
  ALL_PF1E_SECTIONS,
  MAX_ENTRIES_PER_SECTION as PF1E_MAX_ENTRIES_PER_SECTION,
  PF1E_DEFAULT_LICENSE,
  PF1E_PACK_NAME,
  fetchPathfinder1eSection,
  type Pf1eSection,
} from './pathfinder1e-importer';
import {
  ALL_STARFINDER_SECTIONS,
  MAX_ENTRIES_PER_SECTION as STARFINDER_MAX_ENTRIES_PER_SECTION,
  STARFINDER_DEFAULT_BASE_URL,
  fetchStarfinderSection,
  type StarfinderSection,
} from './starfinder-importer';
import {
  ALL_ARCHMAGE_SECTIONS,
  ARCHMAGE_DEFAULT_BASE_URL,
  ARCHMAGE_LICENSE,
  ARCHMAGE_PACK_SLUG,
  MAX_ENTRIES_PER_SECTION as ARCHMAGE_MAX_ENTRIES_PER_SECTION,
  fetchArchmageSection,
  type ArchmageSection,
} from './archmage-importer';
import {
  ALL_OSR_SECTIONS,
  OSR_MAX_ENTRIES_PER_SECTION,
  fetchOsrSection,
  osrSource,
  type OsrSection,
} from './osr-importer';
import {
  ALL_CEPHEUS_SECTIONS,
  CEPHEUS_DEFAULT_BASE_URL,
  CEPHEUS_FETCH_CONCURRENCY,
  CEPHEUS_LICENSE,
  CEPHEUS_PACK_NAME,
  CEPHEUS_PACK_SLUG,
  consoleLogger,
  createFetchLimiter,
  fetchCepheusSection,
  type CepheusSection,
} from './cepheus-importer';
import {
  ALL_DATASWORN_SECTIONS,
  DATASWORN_LICENSE,
  DATASWORN_MAX_ENTRIES_PER_SECTION,
  DATASWORN_PACK_NAME,
  DATASWORN_PACK_SLUG,
  DATASWORN_STARFORGED_URL,
  fetchDataswornDocument,
  mapDataswornSection,
  type DataswornSection,
} from './datasworn-importer';

/** Internal progress shape persisted as JSON in import_jobs.progress. */
interface ImportJobProgress {
  committed: number;
  skipped: number;
  failed: number;
  sections: Array<{ section: string; status: string; imported: number }>;
  changed?: number;
  removed?: number;
  sourceHash?: string;
  sourceVersion?: string;
  preview?: RulePackUpdatePreview;
}

/**
 * What a caller of persistPack is willing to let a re-import do to an ALREADY-INSTALLED pack.
 * Both flags default to off (the safe, purely additive behaviour) and are independent — an
 * upload declares the pack's provenance but never authorises deletion; a truncated upstream
 * fetch authorises neither.
 */
type PersistPackOptions = {
  /** Delete installed rows absent from this manifest. Only safe when the manifest is provably complete — see manifestIsComplete(). */
  removeMissing?: boolean;
  /**
   * Replace the pack row's own provenance columns (name/license/sourceUrl) from this manifest.
   * Only safe when the manifest describes the WHOLE pack: `meta` is derived from the sections
   * fetched by THIS call, so rewriting from a partial add would narrow the pack's license and
   * source to the newly-fetched sections and drop the terms still governing every retained entry.
   */
  rewritePackProvenance?: boolean;
};

type PersistPackMeta = {
  slug: string;
  name: string;
  version: string;
  license: string;
  sourceUrl: string;
  sectionLabels: string[];
  kind?: RulePackKind;
  extendsPackSlug?: string | null;
};

export type PersistPackResult = RulePack & {
  /**
   * Which branch of persistPack produced this result: 'created' for a fresh install,
   * 'updated' for a sync against an already-installed pack. An EXPLICIT discriminant —
   * runJob used to infer it with `'added' in result`, which silently depends on the
   * fresh-install branch never mentioning the key (even as `added: undefined`, which
   * `in` still reports as present). The job outcome an operator sees is worth more than
   * a structural guess, so the producing branch states it.
   */
  outcome: 'created' | 'updated';
  added?: number;
  skippedExisting?: number;
  changed?: number;
  removed?: number;
  sourceHash?: string;
  sourceVersion?: string;
  preview?: RulePackUpdatePreview;
};

/**
 * better-sqlite3 throws a synchronous Error with `.code` set to one of the
 * SQLITE_CONSTRAINT_* codes on a constraint violation. We only care about UNIQUE here
 * (rule_packs.slug) — used to detect a lost race between concurrent installs so it can
 * be turned into a clean incremental-install retry instead of a raw 500.
 */
function isUniqueConstraintError(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true;
  const message = err instanceof Error ? err.message : '';
  return /UNIQUE constraint failed/i.test(message);
}

function packToDomain(row: typeof rulePacks.$inferSelect): RulePack {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    version: row.version,
    license: row.license,
    sourceUrl: row.sourceUrl,
    kind: row.kind as RulePack['kind'],
    extendsPackSlug: row.extendsPackSlug,
    installedAt: row.installedAt,
    entryCount: row.entryCount,
  };
}

/** Exact current DB projection; fresh alpha format deliberately has no legacy shape. */
type EntryProjection = typeof ruleEntries.$inferSelect;
function entryToDomain(row: EntryProjection): RuleEntry {
  return {
    id: row.id,
    packId: row.packId,
    slug: row.slug,
    name: row.name,
    type: row.type as RuleEntryType,
    summary: row.summary,
    body: row.body,
    dataJson: row.dataJson,
    source: row.source ?? '',
    // Per-entry provenance (issue #734). '' on rows written before migration 0050 means
    // "inherit the pack's value"; the reader resolves that fallback (entry.license || pack.license).
    license: row.license ?? '',
    attribution: row.attribution ?? '',
    author: row.author ?? '',
    sourceUrl: row.sourceUrl ?? '',
    iconSlug: row.iconSlug ?? '',
    campaignId: row.campaignId,
    rightsStatus: (row.rightsStatus === 'private_original' || row.rightsStatus === 'permission_granted' || row.rightsStatus === 'open_licensed' ? row.rightsStatus : 'open_licensed'),
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Resolve an imported entry's per-entry provenance against the pack-level fallbacks
 * (issue #734). Importers know the license/source for every entry but may leave
 * attribution/author/sourceUrl unset ('' → "inherit the pack's value"). This centralizes
 * the fallback rule so both the fresh-install and incremental-add insert paths stamp the
 * SAME effective values, and the reader can trust entry.license as the entry's real license
 * rather than a dropped/blank field. The pack fallbacks are the installer's `meta`
 * (license/sourceUrl/name): attribution falls back to the pack name (a reasonable default
 * credit line), and license to the pack license.
 */
function effectiveEntryProvenance(
  entry: ImportedEntry,
  packLicense: string,
  packSourceUrl: string,
  packName: string,
): { license: string; attribution: string; author: string; sourceUrl: string } {
  return {
    license: (entry.license ?? '').trim() || packLicense,
    attribution: (entry.attribution ?? '').trim() || packName,
    author: (entry.author ?? '').trim(),
    sourceUrl: (entry.sourceUrl ?? '').trim() || packSourceUrl,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function importedEntryHash(entry: ImportedEntry, packLicense: string, packSourceUrl: string, packName: string): string {
  const prov = effectiveEntryProvenance(entry, packLicense, packSourceUrl, packName);
  return sha256Hex({
    slug: entry.slug,
    type: entry.type,
    name: entry.name,
    summary: entry.summary,
    body: entry.body,
    dataJson: entry.dataJson,
    source: entry.source,
    license: prov.license,
    attribution: prov.attribution,
    author: prov.author,
    sourceUrl: prov.sourceUrl,
  });
}

function storedEntryHash(row: typeof ruleEntries.$inferSelect): string {
  return sha256Hex({
    slug: row.slug,
    type: row.type,
    name: row.name,
    summary: row.summary,
    body: row.body,
    dataJson: row.dataJson,
    source: row.source ?? '',
    license: row.license ?? '',
    attribution: row.attribution ?? '',
    author: row.author ?? '',
    sourceUrl: row.sourceUrl ?? '',
  });
}

function packManifestHash(
  meta: PersistPackMeta,
  entries: ImportedEntry[],
): string {
  // CONTENT-ONLY fingerprint of the pack's provenance plus every fetched entry's content
  // hash. `meta.version` is deliberately EXCLUDED (#1518): every importer except Open5e
  // stamps it to today's UTC date (nowIso().slice(0,10)), so folding it in would make a
  // byte-identical re-import compute a different hash each day and never match the
  // manifest_hash the previous install stamped — defeating the cross-day short-circuit that
  // is this function's whole purpose (the large Datasworn / large-pack case it exists to
  // protect). The version label is still STORED and displayed: the caller flows it to
  // rule_packs.version and the audit `version=` fragment, and the short-circuit refreshes
  // it as a separate column even when content matches — it is simply not part of the
  // content-equality comparison. Real content changes are still captured through the entry
  // hashes and the provenance fields below.
  return sha256Hex({
    slug: meta.slug,
    name: meta.name,
    license: meta.license,
    sourceUrl: meta.sourceUrl,
    sections: [...meta.sectionLabels].sort(),
    entries: entries
      .map((entry) => ({
        key: `${entry.type}::${entry.slug}`,
        hash: importedEntryHash(entry, meta.license, meta.sourceUrl, meta.name),
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  });
}

/**
 * The subset of every importer's per-section result that the completeness gate reads.
 * `truncated` is optional so a source with no pagination (and therefore no page cap) doesn't
 * have to carry a field that is structurally always false.
 */
type SectionFetchResult = { entries: readonly unknown[]; skippedCount: number; truncated?: boolean };

/**
 * Audit/detail fragment naming sections whose pagination stopped at the per-section page cap.
 * Reported SEPARATELY from the skip count — a truncated section dropped no rows, it just never
 * reached the end of the source — and it is the reason a re-import may decline to delete
 * entries missing from the manifest, so an operator reading the audit trail can see why.
 */
function truncationNote(sectionResults: ReadonlyArray<SectionFetchResult>): string {
  const count = sectionResults.filter((r) => r.truncated).length;
  return count > 0 ? `, ${count} section(s) truncated at page cap` : '';
}

/**
 * Decides whether a fetched manifest may be treated as the COMPLETE upstream set, which
 * is the only condition under which `removeMissing` (delete installed rows absent from the
 * fetch) is safe.
 *
 * Every HTTP importer can legitimately return a SHORT section without throwing:
 *   - a per-section entry cap truncates large sections. This is not hypothetical: Open5e's
 *     creatures (~3.5k) and magicitems (~2.3k) both exceed MAX_ENTRIES_PER_SECTION (2000)
 *     on every single run, so a full Open5e manifest is *always* truncated.
 *   - a single malformed row is skipped rather than failing the import, and a refused
 *     cross-origin `next` link stops pagination early — both return what was collected so
 *     far and report `skippedCount > 0`.
 *   - the per-section page cap breaks out of the pagination loop, reported as `truncated`.
 *     That is a SEPARATE signal from `skippedCount` because no row was dropped: an operator
 *     reading "skipped N rows" after a page-cap stop would be told something untrue. A
 *     section can hit the page cap while landing under the entry cap (heavy same-name
 *     de-duplication collapses many fetched rows into few entries), so the entry-cap check
 *     below does not subsume it.
 *   - the caller may have requested only a subset of sections.
 *
 * Deleting installed entries because they fell outside a truncation window would report
 * them as "removed upstream", drop them from the pack, and null out every combatant that
 * referenced them — the silent pack corruption issue #500 exists to prevent. So removal is
 * enabled only when every section of the source was requested, nothing was skipped, and no
 * section came back sitting at its cap.
 *
 * Note the section check is a set-cover, not a length comparison: `sections` comes straight
 * off the request body and is not de-duplicated by the schema, so seven copies of "spells"
 * would satisfy `sections.length === ALL_OPEN5E_SECTIONS.length` and authorise deleting
 * every monster, item, condition, class, race and feat in the installed pack.
 */
function manifestIsComplete(
  requestedSections: readonly string[],
  allSections: readonly string[],
  sectionResults: ReadonlyArray<SectionFetchResult>,
  perSectionCap: number,
): boolean {
  const requested = new Set<string>(requestedSections);
  if (!allSections.every((section) => requested.has(section))) return false;
  return sectionResults.every((r) => r.skippedCount === 0 && !r.truncated && r.entries.length < perSectionCap);
}

/**
 * The persistPack options a fetched-manifest importer should pass. Both destructive removal
 * AND rewriting the pack's own provenance columns require the SAME proof — that this fetch is
 * the complete pack, not one section of it — so they are derived from one `manifestIsComplete`
 * call rather than being kept in sync by hand at ten call sites.
 *
 * `dropsAreCounted` is a SECOND, independent precondition for removal, and it is a property of
 * the importer rather than of any one fetch. `manifestIsComplete` can only prove "we kept
 * everything the source gave us"; concluding "therefore an installed entry missing from this
 * fetch was removed upstream" additionally requires that the importer cannot lose a REAL row
 * without saying so. An importer that silently drops a row it failed to recognise produces a
 * clean, complete-looking manifest with a genuine entry missing from it — and removal would
 * then delete that entry and sever its combatant references. Sources that can't make that
 * guarantee pass `dropsAreCounted: false` and stay purely additive no matter how complete the
 * fetch looks. See the per-source audit at the call sites.
 */
function completeManifestOptions(
  requestedSections: readonly string[],
  allSections: readonly string[],
  sectionResults: ReadonlyArray<SectionFetchResult>,
  perSectionCap: number,
  { dropsAreCounted = true }: { dropsAreCounted?: boolean } = {},
): { removeMissing: boolean; rewritePackProvenance: boolean } {
  const complete = manifestIsComplete(requestedSections, allSections, sectionResults, perSectionCap);
  // Provenance is deliberately NOT gated on dropsAreCounted: rewriting the pack's license and
  // source from a complete fetch is non-destructive and stays correct even if an entry that
  // failed to parse went missing from this run.
  return { removeMissing: complete && dropsAreCounted, rewritePackProvenance: complete };
}

/** Keep one canonical pack license on partial re-imports; entry rows carry their own terms. */
function canonicalLicense(existing: string, incoming: string): string {
  // A pack label is one canonical provenance statement, not a lossy list of all
  // licenses found while fetching a subset of its entries. Keep the established
  // canonical label for incremental section adds; complete manifests replace it.
  return existing.trim() || incoming;
}

function canonicalPackLicense(entries: readonly ImportedEntry[], fallback: string): string {
  return entries.map((entry) => entry.license.trim()).find(Boolean) ?? fallback;
}

/** Thrown before a job's SQLite persistence transaction when it was cancelled. */
class ImportJobCancelledError extends Error {}

/**
 * ORDER BY expression that ranks name matches ahead of summary/body matches
 * (issue #33: searching "poisoned" must return "Poisoned" before "Petrified",
 * whose body merely mentions the Poisoned condition). Buckets, best first:
 *   0 — exact name match (case-insensitive)
 *   1 — name starts with the query
 *   2 — name contains the query
 *   3 — everything else (summary/body-only matches)
 * Ties within a bucket are broken by the caller's secondary ORDER BY
 * (FTS bm25 rank, or name in the LIKE fallback).
 */
const DIACRITIC_REPLACEMENT_PAIRS: Array<[string, string]> = [
  ['É', 'e'], ['È', 'e'], ['Ê', 'e'], ['Ë', 'e'], ['é', 'e'], ['è', 'e'], ['ê', 'e'], ['ë', 'e'],
  ['Á', 'a'], ['À', 'a'], ['Â', 'a'], ['Ä', 'a'], ['Ã', 'a'], ['Å', 'a'], ['á', 'a'], ['à', 'a'], ['â', 'a'], ['ä', 'a'], ['ã', 'a'], ['å', 'a'],
  ['Í', 'i'], ['Ì', 'i'], ['Î', 'i'], ['Ï', 'i'], ['í', 'i'], ['ì', 'i'], ['î', 'i'], ['ï', 'i'],
  ['Ó', 'o'], ['Ò', 'o'], ['Ô', 'o'], ['Ö', 'o'], ['Õ', 'o'], ['Ø', 'o'], ['ó', 'o'], ['ò', 'o'], ['ô', 'o'], ['ö', 'o'], ['õ', 'o'], ['ø', 'o'],
  ['Ú', 'u'], ['Ù', 'u'], ['Û', 'u'], ['Ü', 'u'], ['ú', 'u'], ['ù', 'u'], ['û', 'u'], ['ü', 'u'],
  ['Ý', 'y'], ['Ÿ', 'y'], ['ý', 'y'], ['ÿ', 'y'],
  ['Ñ', 'n'], ['ñ', 'n'],
  ['Ç', 'c'], ['ç', 'c'], ['Ć', 'c'], ['ć', 'c'], ['Č', 'c'], ['č', 'c'],
  ['Š', 's'], ['š', 's'], ['Ś', 's'], ['ś', 's'],
  ['Ž', 'z'], ['ž', 'z'], ['Ź', 'z'], ['ź', 'z'], ['Ż', 'z'], ['ż', 'z'],
  ['Ł', 'l'], ['ł', 'l'],
  ['Æ', 'ae'], ['æ', 'ae'], ['Œ', 'oe'], ['œ', 'oe'],
];

function foldSqlCol(col: any) {
  let expr = sql`lower(${col})`;
  for (const [from, to] of DIACRITIC_REPLACEMENT_PAIRS) {
    expr = sql`replace(${expr}, ${from}, ${to})`;
  }
  return expr;
}

/**
 * Name-match ranking expression used to compute candidate relevance bucket
 * (FTS bm25 rank, or name in the LIKE fallback).
 */
function nameMatchRank(q: string) {
  const rawNeedle = q.trim().replace(/[%_]/g, '').toLowerCase();
  const needle = foldForSearch(q.trim().replace(/[%_]/g, ''));
  const foldedName = foldSqlCol(ruleEntries.name);
  return sql`CASE
    WHEN lower(${ruleEntries.name}) = ${rawNeedle} OR ${foldedName} = ${needle} THEN 0
    WHEN lower(${ruleEntries.name}) LIKE ${`${rawNeedle}%`} OR ${foldedName} LIKE ${`${needle}%`} THEN 1
    WHEN lower(${ruleEntries.name}) LIKE ${`%${rawNeedle}%`} OR ${foldedName} LIKE ${`%${needle}%`} THEN 2
    ELSE 3
  END`;
}

/** Escapes an FTS5 MATCH query string by quoting it as a single phrase, then appending a prefix wildcard per token. */
function toFtsQuery(q: string): string {
  const rawTokens = q
    .split(/\s+/)
    .map((t) => t.replace(/["]/g, ''))
    .filter(Boolean);
  if (rawTokens.length === 0) return '';

  return rawTokens
    .map((rawToken) => {
      const unicode61Token = rawToken
        .normalize('NFD')
        // eslint-disable-next-line no-misleading-character-class
        .replace(/[\u{0300}-\u{036f}\u{1ab0}-\u{1aff}\u{1dc0}-\u{1dff}\u{20d0}-\u{20ff}\u{fe20}-\u{fe2f}]/gu, '')
        .normalize('NFKC')
        .toLowerCase();
      const expandedToken = foldForSearch(rawToken);

      if (unicode61Token && expandedToken && unicode61Token !== expandedToken) {
        return `("${unicode61Token}"* OR "${expandedToken}"*)`;
      }
      const tokenToUse = expandedToken || unicode61Token || rawToken;
      return `"${tokenToUse}"*`;
    })
    .join(' ');
}

const RULE_FACET_ORDER: RuleEntryType[] = [
  'spell',
  'monster',
  'hazard',
  'item',
  'condition',
  'class',
  'race',
  'feat',
  'section',
  'other',
];

const DEFAULT_FACET_LABELS: Record<RuleEntryType, string> = {
  spell: 'Spells',
  monster: 'Monsters',
  hazard: 'Hazards',
  item: 'Items',
  condition: 'Conditions',
  class: 'Classes',
  race: 'Races',
  feat: 'Feats',
  section: 'Rules',
  other: 'Reference',
};

function ruleFacetLabel(type: RuleEntryType, packSlug?: string): string {
  if (type === 'section' || type === 'other') return DEFAULT_FACET_LABELS[type];

  if (packSlug === 'pf2e-srd' || packSlug === 'sf2e-srd') {
    const labels: Partial<Record<RuleEntryType, string>> = {
      monster: 'Creatures',
      item: 'Equipment',
      race: 'Ancestries',
    };
    return labels[type] ?? DEFAULT_FACET_LABELS[type];
  }

  if (packSlug === 'starfinder-1e') {
    const labels: Partial<Record<RuleEntryType, string>> = {
      monster: 'Creatures',
      item: 'Equipment',
      race: 'Species',
    };
    return labels[type] ?? DEFAULT_FACET_LABELS[type];
  }

  if (packSlug === 'open-legend-srd' || packSlug === 'open-legend') {
    const labels: Partial<Record<RuleEntryType, string>> = {
      condition: 'Banes & Boons',
    };
    return labels[type] ?? DEFAULT_FACET_LABELS[type];
  }

  if (packSlug === 'ironsworn-starforged') {
    const labels: Partial<Record<RuleEntryType, string>> = {
      monster: 'NPCs',
      item: 'Assets',
    };
    return labels[type] ?? DEFAULT_FACET_LABELS[type];
  }

  if (packSlug === 'osr' || packSlug === 'basic-fantasy' || packSlug === 'osric' || packSlug === 'swords-wizardry' || packSlug === 'labyrinth-lord' || packSlug === 'old-school-essentials' || packSlug === 'ose') {
    const labels: Partial<Record<RuleEntryType, string>> = {
      item: 'Equipment',
    };
    return labels[type] ?? DEFAULT_FACET_LABELS[type];
  }

  return DEFAULT_FACET_LABELS[type];
}

/**
 * Build the Compendium facet list for a search (issue #544).
 *
 * The facet *set* comes from `packTypeCounts` — the categories that actually exist in
 * the active pack — so the chip row is stable while the user types and categories the
 * pack has no entries for stay hidden. The facet *counts* come from `matchTypeCounts`
 * — the current query/pack scope with the active type filter deliberately excluded —
 * so a chip's count always equals what selecting that chip would return. A category
 * that exists in the pack but has no match for the current query is reported with
 * `count: 0` rather than dropped, so the user can still pivot to it mid-search.
 */
function buildRuleFacets(
  packTypeCounts: Map<string, number>,
  matchTypeCounts: Map<string, number>,
  packSlug?: string,
): RuleSearchFacet[] {
  return RULE_FACET_ORDER.filter((type) => (packTypeCounts.get(type) ?? 0) > 0).map((type) => ({
    type,
    label: ruleFacetLabel(type, packSlug),
    count: matchTypeCounts.get(type) ?? 0,
  }));
}

@Injectable()
export class RulesService implements OnModuleInit {
  private readonly runningJobs = new Map<string, { cancelled: boolean }>();
  private readonly importJobContext = new AsyncLocalStorage<string>();

  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    @Inject(RULE_ENTRIES_FTS_AVAILABLE) private readonly ftsAvailable: boolean,
    private readonly audit: AuditService,
    private readonly access: CampaignAccessService,
  ) {}

  async onModuleInit(): Promise<void> {
    const interrupted = this.db
      .select()
      .from(importJobs)
      .where(inArray(importJobs.status, ['running', 'queued']))
      .all();
    for (const job of interrupted) {
      const ts = nowIso();
      const errors = RulesService.parseErrors(job.errors);
      errors.push('Job interrupted by server restart');
      this.db.update(importJobs).set({ status: 'failed', updatedAt: ts, completedAt: ts, errors: JSON.stringify(errors) }).where(eq(importJobs.id, job.id)).run();
    }
  }

  // ---------- persistent import jobs (issue #737) ----------

  private static parseProgress(json: string): ImportJobProgress {
    try { return JSON.parse(json) as ImportJobProgress; }
    catch { return { committed: 0, skipped: 0, failed: 0, sections: [] }; }
  }

  private static parseErrors(json: string): string[] {
    try { return JSON.parse(json || '[]') as string[]; }
    catch { return []; }
  }

  getJobOrThrow(id: string): RulePackInstallJob {
    const [row] = this.db.select().from(importJobs).where(eq(importJobs.id, id)).all();
    if (!row) throw new NotFoundException(`Install job ${id} not found`);
    return this.rowToJob(row);
  }

  listJobs(limit = 50): RulePackInstallJob[] {
    const rows = this.db.select().from(importJobs).orderBy(sql`${importJobs.createdAt} DESC`).limit(limit).all();
    return rows.map((r) => this.rowToJob(r));
  }

  private rowToJob(row: typeof importJobs.$inferSelect): RulePackInstallJob {
    const progress = RulesService.parseProgress(row.progress);
    const packSlug = (progress as unknown as Record<string, unknown>).packSlug as string | undefined;
    let pack: RulePack | null = null;
    if (packSlug && row.status === 'completed') {
      const [packRow] = this.db.select().from(rulePacks).where(eq(rulePacks.slug, packSlug)).all();
      if (packRow) pack = packToDomain(packRow);
    }
    return {
      id: row.id,
      source: row.source as RulePackInstallJob['source'],
      status: row.status === 'queued' ? 'pending' : row.status as RulePackInstallJob['status'],
      progress: progress.sections.map((s) => ({ section: s.section, status: s.status as 'pending' | 'running' | 'done' | 'failed', imported: s.imported })),
      totalSections: progress.sections.length,
      completedSections: progress.sections.filter((s) => s.status === 'done').length,
      outcome: row.outcome as RulePackInstallJob['outcome'],
      pack,
      added: row.status === 'completed' ? progress.committed : null,
      skippedExisting: row.status === 'completed' ? progress.skipped : null,
      changed: row.status === 'completed' ? progress.changed ?? 0 : null,
      removed: row.status === 'completed' ? progress.removed ?? 0 : null,
      preview: row.status === 'completed' ? progress.preview ?? null : null,
      error: RulesService.parseErrors(row.errors)[0] ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private newJob(source: RulePackInstallJob['source'], sections: string[], user: RequestUser, input: Record<string, unknown> = {}): RulePackInstallJob {
    const ts = nowIso();
    const id = randomUUID();
    const progress: ImportJobProgress = { committed: 0, skipped: 0, failed: 0, sections: sections.map((s) => ({ section: s, status: 'pending', imported: 0 })) };
    const persistedInput = { source, ...input };
    const payload = JSON.stringify(persistedInput);
    const sourceHash = createHash('sha256').update(payload).digest('hex').slice(0, 16);
    this.db.insert(importJobs).values({ id, source, sourceHash, input: payload, status: 'queued', progress: JSON.stringify(progress), cursor: null, actorId: user.id, startedAt: null, updatedAt: ts, completedAt: null, outcome: null, errors: '[]', createdAt: ts }).run();
    return this.getJobOrThrow(id);
  }

  private markSectionDone(jobId: string, section: string, imported: number): void {
    const [row] = this.db.select().from(importJobs).where(eq(importJobs.id, jobId)).all();
    if (!row) return;
    const progress = RulesService.parseProgress(row.progress);
    const entry = progress.sections.find((s) => s.section === section);
    if (entry) { entry.status = 'done'; entry.imported = imported; }
    progress.committed += imported;
    const cursor = entry ? JSON.stringify({ lastSection: section, index: progress.sections.indexOf(entry) }) : null;
    this.db.update(importJobs).set({ progress: JSON.stringify(progress), cursor, updatedAt: nowIso() }).where(eq(importJobs.id, jobId)).run();
  }

  private markJobCompleted(
    jobId: string,
    outcome: 'created' | 'updated',
    result: {
      added: number;
      skippedExisting: number;
      changed?: number;
      removed?: number;
      sourceHash?: string;
      sourceVersion?: string;
      preview?: RulePackUpdatePreview;
    },
    pack?: RulePack,
  ): void {
    const [row] = this.db.select().from(importJobs).where(eq(importJobs.id, jobId)).all();
    if (!row || row.status === 'cancelled') {
      this.runningJobs.delete(jobId);
      return;
    }
    const progress = RulesService.parseProgress(row.progress);
    // Fetch progress is deliberately not the outcome: imports de-duplicate across
    // sections before persistence. The terminal counts must equal committed rows.
    progress.committed = result.added;
    progress.skipped = result.skippedExisting;
    progress.changed = result.changed ?? 0;
    progress.removed = result.removed ?? 0;
    if (result.sourceHash) progress.sourceHash = result.sourceHash;
    if (result.sourceVersion) progress.sourceVersion = result.sourceVersion;
    if (result.preview) progress.preview = result.preview;
    if (pack) (progress as unknown as Record<string, unknown>).packSlug = pack.slug;
    progress.sections.forEach((s) => { if (s.status !== 'done') s.status = 'done'; });
    const ts = nowIso();
    this.db.update(importJobs).set({ status: 'completed', outcome, progress: JSON.stringify(progress), updatedAt: ts, completedAt: ts }).where(eq(importJobs.id, jobId)).run();
    this.runningJobs.delete(jobId);
  }

  private markJobFailed(jobId: string, error: string): void {
    const [row] = this.db.select().from(importJobs).where(eq(importJobs.id, jobId)).all();
    if (!row || row.status === 'cancelled') {
      this.runningJobs.delete(jobId);
      return;
    }
    const errors = RulesService.parseErrors(row.errors); errors.push(error);
    const progress = RulesService.parseProgress(row.progress);
    progress.sections.forEach((s) => { if (s.status !== 'done') s.status = 'failed'; });
    const ts = nowIso();
    this.db.update(importJobs).set({ status: 'failed', progress: JSON.stringify(progress), errors: JSON.stringify(errors), updatedAt: ts, completedAt: ts }).where(eq(importJobs.id, jobId)).run();
    this.runningJobs.delete(jobId);
  }

  cancelJob(jobId: string): RulePackInstallJob {
    const [row] = this.db.select().from(importJobs).where(eq(importJobs.id, jobId)).all();
    if (!row) throw new NotFoundException(`Install job ${jobId} not found`);
    if (row.status !== 'queued' && row.status !== 'running') throw new BadRequestException(`Job ${jobId} is already in terminal state: ${row.status}`);
    const ts = nowIso();
    const running = this.runningJobs.get(jobId);
    if (running) running.cancelled = true;
    else this.runningJobs.set(jobId, { cancelled: true });
    this.db.update(importJobs).set({ status: 'cancelled', updatedAt: ts, completedAt: ts }).where(eq(importJobs.id, jobId)).run();
    return this.getJobOrThrow(jobId);
  }

  retryJob(jobId: string, user: RequestUser): RulePackInstallJob {
    const [row] = this.db.select().from(importJobs).where(eq(importJobs.id, jobId)).all();
    if (!row) throw new NotFoundException(`Install job ${jobId} not found`);
    if (row.status !== 'failed' && row.status !== 'cancelled') throw new BadRequestException(`Job ${jobId} cannot be retried (status: ${row.status})`);
    if (row.source === 'upload') throw new BadRequestException(`Upload jobs cannot be retried`);
    const input = JSON.parse(row.input) as RulePackInstall;
    return this.enqueueInstall(input, user);
  }

  private isJobCancelled(jobId: string): boolean {
    if (this.runningJobs.get(jobId)?.cancelled) return true;
    const [row] = this.db.select({ status: importJobs.status }).from(importJobs).where(eq(importJobs.id, jobId)).all();
    return row?.status === 'cancelled';
  }

  /** No-op for synchronous MCP installs; background jobs fail closed before commit. */
  private assertCurrentJobCanPersist(): void {
    const jobId = this.importJobContext.getStore();
    if (jobId && this.isJobCancelled(jobId)) throw new ImportJobCancelledError();
  }

  private async runJob(jobId: string, work: () => Promise<PersistPackResult>): Promise<void> {
    if (this.isJobCancelled(jobId)) {
      this.runningJobs.delete(jobId);
      return;
    }
    const ts = nowIso();
    this.db.update(importJobs).set({ status: 'running', startedAt: ts, updatedAt: ts }).where(eq(importJobs.id, jobId)).run();
    if (this.isJobCancelled(jobId)) {
      this.runningJobs.delete(jobId);
      return;
    }
    if (!this.runningJobs.has(jobId)) {
      this.runningJobs.set(jobId, { cancelled: false });
    }
    try {
      const result = await this.importJobContext.run(jobId, work);
      if (this.isJobCancelled(jobId)) {
        this.runningJobs.delete(jobId);
        return;
      }
      const { outcome, added, skippedExisting, changed, removed, sourceHash, sourceVersion, preview, ...pack } = result;
      this.markJobCompleted(
        jobId,
        outcome,
        {
          added: added ?? preview?.added ?? 0,
          skippedExisting: skippedExisting ?? 0,
          changed: changed ?? preview?.changed ?? 0,
          removed: removed ?? preview?.removed ?? 0,
          sourceHash: sourceHash ?? preview?.sourceHash,
          sourceVersion: sourceVersion ?? preview?.sourceVersion,
          preview,
        },
        pack,
      );
    } catch (err) {
      if (err instanceof ImportJobCancelledError) {
        this.runningJobs.delete(jobId);
        return;
      }
      if (this.isJobCancelled(jobId)) {
        this.runningJobs.delete(jobId);
        return;
      }
      this.markJobFailed(jobId, err instanceof Error ? err.message : String(err));
    }
  }

  // ---------- open-ruleset install dispatch (issue #345) ----------

  /**
   * Static local constants for the sibling importers that don't export a pack slug/name of
   * their own. Starfinder's pack installs under the adapter id `starfinder-1e`, which the
   * StarfinderAdapter is registered against, so a campaign selecting the pack resolves the
   * right combat math.
   */
  private static readonly STARFINDER_PACK_SLUG = STARFINDER_ADAPTER_ID; // 'starfinder-1e'
  private static readonly STARFINDER_PACK_NAME = 'Starfinder 1e SRD';
  private static readonly STARFINDER_DEFAULT_LICENSE = 'Open Game License v1.0a';

  /**
   * The section vocabulary each `source` accepts (issue #345). A caller-supplied section
   * that isn't in the chosen source's set is rejected 400 synchronously, before a job is
   * enqueued (acceptance criteria) — the widened `RulePackInstallSection` enum lets a name
   * like 'starships' parse for Zod, but it's only meaningful for Starfinder. PF2e and SF2e
   * accept only the native PF2e/SF2e section keys in ALL_PF2E_SECTIONS (e.g., 'creatures',
   * 'equipment') — Open5e-shaped section names are rejected for those sources; 'other' rides
   * the Open5e path for back-compat.
   */
  private static readonly SECTIONS_BY_SOURCE: Record<RulePackInstallSource, readonly string[]> = {
    open5e: ALL_OPEN5E_SECTIONS,
    pf2e: ALL_PF2E_SECTIONS,
    sf2e: ALL_PF2E_SECTIONS,
    pf1e: ALL_PF1E_SECTIONS,
    starfinder: ALL_STARFINDER_SECTIONS,
    archmage: ALL_ARCHMAGE_SECTIONS,
    'open-legend': ALL_OPEN_LEGEND_SECTIONS,
    osr: ALL_OSR_SECTIONS,
    // Cepheus organizes its content as mdBook "books" (parts), not a per-statblock section
    // vocabulary. Its section keys aren't in the shared RulePackInstallSection enum, so the
    // enum-typed `sections` input can never carry one — the importer imports the whole SRD
    // (like PF2e/SF2e import their full set regardless of the filter). Listed here so a caller
    // that DOES pass a foreign section (e.g. 'spells') gets a clear 400 naming the real books.
    cepheus: ALL_CEPHEUS_SECTIONS,
    datasworn: ALL_DATASWORN_SECTIONS,
    other: ALL_OPEN5E_SECTIONS,
  };

  /**
   * Sources with NO validated open, machine-readable first-party source (the #346 research
   * pass: pf1e/starfinder/archmage/osr — see RULE_PACK_SOURCE_META for the per-system finding).
   * They are `sourceKind: 'manual-upload'`, so an install with no `url` is rejected 400 at
   * enqueue with a pointer to the upload path — friendlier than a job that fails obscurely
   * against a dead default, and honest about the fact that no built-in source exists. Derived
   * from the shared metadata so enforcement and the install picker (#347) never drift apart.
   */
  private static readonly SOURCES_REQUIRING_URL: ReadonlySet<RulePackInstallSource> = new Set(
    (Object.values(RULE_PACK_SOURCE_META) as (typeof RULE_PACK_SOURCE_META)[RulePackInstallSource][])
      .filter((m) => !m.installableWithoutUrl)
      .map((m) => m.source),
  );

  /** Reject a section that isn't valid for the chosen source (400, before any job is enqueued). */
  private assertSectionsForSource(source: RulePackInstallSource, sections: string[] | undefined): void {
    if (!sections?.length) return;
    const allowed = RulesService.SECTIONS_BY_SOURCE[source];
    const invalid = sections.filter((s) => !allowed.includes(s));
    if (invalid.length > 0) {
      throw new BadRequestException(
        `Section(s) ${invalid.join(', ')} are not valid for source "${source}". Allowed: ${allowed.join(', ')}.`,
      );
    }
  }

  /** Require an explicit base URL for a manual-upload source (no open first-party API, see #346). */
  private assertUrlForSource(source: RulePackInstallSource, url: string | undefined): void {
    if (RulesService.SOURCES_REQUIRING_URL.has(source) && !url) {
      const meta = RULE_PACK_SOURCE_META[source];
      throw new BadRequestException(
        `Source "${source}" has no built-in open data source (${meta.note}). ` +
          `Upload an open-licensed JSON pack via POST /rules/packs/upload, or pass an explicit "url" pointing at a self-hosted mirror.`,
      );
    }
  }

  /**
   * Dispatch an install to the right importer by `source` (issue #345). Validates the
   * source/section combination and any required URL synchronously (400 before enqueue),
   * then hands off to the matching enqueue* method — each returns a 'pending' job snapshot
   * the caller polls, running the paginated fetch + persist in runJob(). Existing open5e/
   * pf2e callers are unaffected (same request shape, same code path).
   */
  enqueueInstall(input: RulePackInstall, user: RequestUser): RulePackInstallJob {
    this.assertSectionsForSource(input.source, input.sections);
    this.assertUrlForSource(input.source, input.url);
    if (input.source === 'osr' && input.url && !input.system) {
      throw new BadRequestException('An OSR install from a custom URL requires an explicit "system" so the pack license and attribution cannot be inferred from another publisher.');
    }
    switch (input.source) {
      case 'pf2e':
        return this.enqueuePf2eInstall(input, user);
      case 'sf2e':
        return this.enqueueSf2eInstall(input, user);
      case 'pf1e':
        return this.enqueuePf1eInstall(input, user);
      case 'starfinder':
        return this.enqueueStarfinderInstall(input, user);
      case 'archmage':
        return this.enqueueArchmageInstall(input, user);
      case 'open-legend':
        return this.enqueueOpenLegendInstall(input, user);
      case 'osr':
        return this.enqueueOsrInstall(input, user);
      case 'cepheus':
        return this.enqueueCepheusInstall(input, user);
      case 'datasworn':
        return this.enqueueDataswornInstall(input, user);
      case 'open5e':
      case 'other':
      default:
        return this.enqueueOpen5eInstall(input, user);
    }
  }

  /**
   * Synchronous install dispatch used by the MCP `install_rule_pack` tool (which awaits the
   * result rather than polling a job). Same per-source validation as enqueueInstall, routed
   * to the matching installFrom* method. Keeps the MCP tool honest: `source: 'starfinder'`
   * runs the Starfinder importer, not a silent Open5e install.
   */
  async installFromSource(
    input: RulePackInstall,
    user: RequestUser,
    onSectionDone?: (section: string, imported: number) => void,
  ): Promise<PersistPackResult> {
    this.assertSectionsForSource(input.source, input.sections);
    this.assertUrlForSource(input.source, input.url);
    if (input.source === 'osr' && input.url && !input.system) {
      throw new BadRequestException('An OSR install from a custom URL requires an explicit "system" so the pack license and attribution cannot be inferred from another publisher.');
    }
    switch (input.source) {
      case 'pf2e':
        return this.installFromPf2e(input, user, onSectionDone);
      case 'sf2e':
        return this.installFromSf2e(input, user, onSectionDone);
      case 'pf1e':
        return this.installFromPf1e(input, user, onSectionDone);
      case 'starfinder':
        return this.installFromStarfinder(input, user, onSectionDone);
      case 'archmage':
        return this.installFromArchmage(input, user, onSectionDone);
      case 'open-legend':
        return this.installFromOpenLegend(input, user, onSectionDone);
      case 'osr':
        return this.installFromOsr(input, user, onSectionDone);
      case 'cepheus':
        return this.installFromCepheus(input, user, onSectionDone);
      case 'datasworn':
        return this.installFromDatasworn(input, user, onSectionDone);
      case 'open5e':
      case 'other':
      default:
        return this.installFromOpen5e(input, user, onSectionDone);
    }
  }

  /**
   * Enqueue an Open5e install as a background job (issue #20). Returns immediately
   * with a 'pending' job snapshot; the heavy paginated fetch + insert runs in
   * runJob(), updating per-section progress the caller can poll.
   */
  enqueueOpen5eInstall(input: RulePackInstall, user: RequestUser): RulePackInstallJob {
    const sections: Open5eSection[] = input.sections?.length ? (input.sections as Open5eSection[]) : ALL_OPEN5E_SECTIONS;
    const job = this.newJob('open5e', sections, user, input as unknown as Record<string, unknown>);
    queueMicrotask(() =>
      void this.runJob(job.id, () =>
        this.installFromOpen5e(input, user, (section, imported) => this.markSectionDone(job.id, section, imported)),
      ),
    );
    return this.getJobOrThrow(job.id);
  }

  /**
   * Enqueue a Pathfinder 2e install as a background job (issues #295 + #20). Same shape as
   * the Open5e enqueue — returns a 'pending' snapshot immediately and runs the paginated
   * fetch + insert in runJob() — but routes through the PF2e importer and installs under
   * the `pf2e-srd` pack slug, which the PF2e RuleSystemAdapter is registered against.
   */
  enqueuePf2eInstall(input: RulePackInstall, user: RequestUser): RulePackInstallJob {
    const sections: Pf2eSection[] = input.sections?.length
      ? (input.sections as Pf2eSection[])
      : ALL_PF2E_SECTIONS;
    const job = this.newJob('pf2e', sections, user, input as unknown as Record<string, unknown>);
    queueMicrotask(() =>
      void this.runJob(job.id, () =>
        this.installFromPf2e(input, user, (section, imported) => this.markSectionDone(job.id, section, imported)),
      ),
    );
    return this.getJobOrThrow(job.id);
  }

  enqueueSf2eInstall(input: RulePackInstall, user: RequestUser): RulePackInstallJob {
    const sections: Pf2eSection[] = input.sections?.length
      ? (input.sections as Pf2eSection[])
      : ALL_PF2E_SECTIONS;
    const job = this.newJob('sf2e', sections, user, input as unknown as Record<string, unknown>);
    queueMicrotask(() =>
      void this.runJob(job.id, () =>
        this.installFromSf2e(input, user, (section, imported) => this.markSectionDone(job.id, section, imported)),
      ),
    );
    return this.getJobOrThrow(job.id);
  }

  /**
   * Enqueue a Pathfinder 1e install (issues #296 + #345). Mirrors the Open5e enqueue: a
   * 'pending' snapshot immediately, the paginated fetch + insert in runJob(), installing
   * under PF1E_PACK_SLUG (which the Pathfinder1eAdapter is registered against). PF1e shares
   * the 5e-shaped section vocabulary, so the caller's section filter is honoured.
   */
  enqueuePf1eInstall(input: RulePackInstall, user: RequestUser): RulePackInstallJob {
    const sections: Pf1eSection[] = input.sections?.length ? (input.sections as Pf1eSection[]) : ALL_PF1E_SECTIONS;
    const job = this.newJob('pf1e', sections, user, input as unknown as Record<string, unknown>);
    queueMicrotask(() =>
      void this.runJob(job.id, () =>
        this.installFromPf1e(input, user, (section, imported) => this.markSectionDone(job.id, section, imported)),
      ),
    );
    return this.getJobOrThrow(job.id);
  }

  /**
   * Enqueue a Starfinder 1e install (issues #297 + #345). Installs under the `starfinder-1e`
   * pack slug (= STARFINDER_ADAPTER_ID) so a campaign selecting it resolves the Starfinder
   * adapter. Starfinder adds its own sections (equipment/starships/vehicles) on top of the
   * 5e-shaped ones, all validated per-source before this runs.
   */
  enqueueStarfinderInstall(input: RulePackInstall, user: RequestUser): RulePackInstallJob {
    const sections: StarfinderSection[] = input.sections?.length
      ? (input.sections as StarfinderSection[])
      : ALL_STARFINDER_SECTIONS;
    const job = this.newJob('starfinder', sections, user, input as unknown as Record<string, unknown>);
    queueMicrotask(() =>
      void this.runJob(job.id, () =>
        this.installFromStarfinder(input, user, (section, imported) => this.markSectionDone(job.id, section, imported)),
      ),
    );
    return this.getJobOrThrow(job.id);
  }

  /**
   * Enqueue a 13th Age (Archmage Engine) install (issues #298 + #345). The importer parses
   * HTML rather than JSON but returns the same ImportedEntry[] shape, so the background-job
   * machinery is identical. Installs under ARCHMAGE_PACK_SLUG. 13th Age exposes only
   * monsters + conditions.
   */
  enqueueArchmageInstall(input: RulePackInstall, user: RequestUser): RulePackInstallJob {
    const sections: ArchmageSection[] = input.sections?.length
      ? (input.sections as ArchmageSection[])
      : ALL_ARCHMAGE_SECTIONS;
    const job = this.newJob('archmage', sections, user, input as unknown as Record<string, unknown>);
    queueMicrotask(() =>
      void this.runJob(job.id, () =>
        this.installFromArchmage(input, user, (section, imported) => this.markSectionDone(job.id, section, imported)),
      ),
    );
    return this.getJobOrThrow(job.id);
  }

  /**
   * Enqueue an Open Legend install (issues #299 + #345). Wraps the already-built
   * installFromOpenLegend in the background-job machinery. Open Legend's open data exists as
   * exactly three sections — boons/banes/feats (see ALL_OPEN_LEGEND_SECTIONS / #346).
   */
  enqueueOpenLegendInstall(input: RulePackInstall, user: RequestUser): RulePackInstallJob {
    const sections: OpenLegendSection[] = input.sections?.length
      ? (input.sections as OpenLegendSection[])
      : ALL_OPEN_LEGEND_SECTIONS;
    const job = this.newJob('open-legend', sections, user, input as unknown as Record<string, unknown>);
    queueMicrotask(() =>
      void this.runJob(job.id, () =>
        this.installFromOpenLegend(input, user, (section, imported) => this.markSectionDone(job.id, section, imported)),
      ),
    );
    return this.getJobOrThrow(job.id);
  }

  /**
   * Enqueue an OSR install (issues #300 + #345). The single OSR importer serves several
   * retroclone packs; `input.system` selects which `OsrSource` (slug/license/attribution)
   * the pack installs under, defaulting to 'basic-fantasy'. The pack installs under that
   * source's `systemSlug`, which the shared OsrAdapter is registered against.
   */
  enqueueOsrInstall(input: RulePackInstall, user: RequestUser): RulePackInstallJob {
    const sections: OsrSection[] = input.sections?.length ? (input.sections as OsrSection[]) : ALL_OSR_SECTIONS;
    const job = this.newJob('osr', sections, user, input as unknown as Record<string, unknown>);
    queueMicrotask(() =>
      void this.runJob(job.id, () =>
        this.installFromOsr(input, user, (section, imported) => this.markSectionDone(job.id, section, imported)),
      ),
    );
    return this.getJobOrThrow(job.id);
  }

  /**
   * Enqueue a Cepheus Engine SRD install (issue #406). The importer fetches raw Markdown
   * from the mdBook and maps each chapter into a `section`-typed rule entry, so it reuses the
   * same background-job machinery as every other importer. Installs under CEPHEUS_PACK_SLUG.
   * Cepheus imports the whole SRD (its mdBook "books" are progress groups, not a selectable
   * per-statblock filter — a foreign `sections` value is rejected 400 before enqueue).
   */
  enqueueCepheusInstall(input: RulePackInstall, user: RequestUser): RulePackInstallJob {
    const job = this.newJob('cepheus', ALL_CEPHEUS_SECTIONS, user, input as unknown as Record<string, unknown>);
    queueMicrotask(() =>
      void this.runJob(job.id, () =>
        this.installFromCepheus(input, user, (section, imported) => this.markSectionDone(job.id, section, imported)),
      ),
    );
    return this.getJobOrThrow(job.id);
  }

  /**
   * Enqueue an Ironsworn: Starforged (datasworn) install (issue #405). Unlike the paginated
   * siblings, datasworn is a SINGLE JSON document, so installFromDatasworn fetches the file
   * once and maps each requested section from memory — but it still reports per-section
   * progress, so the background-job machinery is identical. Installs under
   * DATASWORN_PACK_SLUG. Sections are npcs/assets/moves/oracles/truths (see the importer).
   */
  enqueueDataswornInstall(input: RulePackInstall, user: RequestUser): RulePackInstallJob {
    const sections: DataswornSection[] = input.sections?.length
      ? (input.sections as DataswornSection[])
      : ALL_DATASWORN_SECTIONS;
    const job = this.newJob('datasworn', sections, user, input as unknown as Record<string, unknown>);
    queueMicrotask(() =>
      void this.runJob(job.id, () =>
        this.installFromDatasworn(input, user, (section, imported) => this.markSectionDone(job.id, section, imported)),
      ),
    );
    return this.getJobOrThrow(job.id);
  }

  /**
   * Enqueue a generic uploaded-dataset install as a background job (issues #19 + #20).
   * License open-ness is validated synchronously here so a bad-license upload gets a
   * clean 400 at the POST rather than a failed job the caller must poll to discover.
   */
  async enqueueUploadInstall(input: RulePackUpload, user: RequestUser): Promise<RulePackInstallJob> {
    // License open-ness is validated synchronously here so a bad-license upload gets a
    // clean 400 at the POST rather than a failed job the caller must poll to discover.
    // BOTH the pack license AND every entry's effective license (entry license or pack
    // fallback) are checked up front — a non-open entry in an otherwise-open pack is
    // rejected with an indexed error naming the offender, before any job/mutation (#734).
    this.assertOpenLicense(input.pack.license);
    this.assertEntriesOpenLicensed(input);
    await this.validatePackRelationship(input.pack.slug, input.pack.kind ?? 'base', input.pack.extendsPackSlug ?? null);
    const types = [...new Set(input.entries.map((e) => e.type))];
    const job = this.newJob('upload', types, user, { pack: input.pack } as unknown as Record<string, unknown>);
    queueMicrotask(() =>
      void this.runJob(job.id, () =>
        this.installFromUpload(input, user, (section, imported) => this.markSectionDone(job.id, section, imported)),
      ),
    );
    return this.getJobOrThrow(job.id);
  }

  private async validatePackRelationship(slug: string, kind: RulePackKind, extendsPackSlug: string | null): Promise<void> {
    if (extendsPackSlug === slug) throw new BadRequestException('A rule pack cannot extend itself');
    if (kind === 'extension' && !extendsPackSlug) {
      throw new BadRequestException('Extension packs must declare extendsPackSlug');
    }
    if (kind === 'base' && extendsPackSlug) {
      throw new BadRequestException('Base packs cannot declare extendsPackSlug');
    }

    const [existing] = await this.db
      .select({ id: rulePacks.id, kind: rulePacks.kind })
      .from(rulePacks)
      .where(eq(rulePacks.slug, slug))
      .limit(1);
    if (existing?.kind === 'base' && kind !== 'base') {
      const [primaryCampaign] = await this.db
        .select({ id: campaigns.id })
        .from(campaigns)
        .where(eq(campaigns.ruleSystem, slug))
        .limit(1);
      const [dependentExtension] = await this.db
        .select({ name: rulePacks.name })
        .from(rulePacks)
        .where(and(eq(rulePacks.extendsPackSlug, slug), eq(rulePacks.kind, 'extension')))
        .limit(1);
      if (primaryCampaign || dependentExtension) {
        throw new ConflictException(
          `Rule pack "${slug}" cannot be changed from base to ${kind} while campaigns or installed extensions depend on it as a base`,
        );
      }
    }
    if (!extendsPackSlug) return;
    const [base] = await this.db
      .select({ kind: rulePacks.kind })
      .from(rulePacks)
      .where(eq(rulePacks.slug, extendsPackSlug))
      .limit(1);
    if (!base) throw new BadRequestException(`extendsPackSlug "${extendsPackSlug}" is not installed`);
    if (base.kind !== 'base') {
      throw new BadRequestException(`extendsPackSlug "${extendsPackSlug}" must identify a base pack`);
    }
  }

  private assertOpenLicense(license: string): void {
    if (!isValidUploadLicense(license)) {
      if (licenseForbidsRedistribution(license) && !isSelfAuthoredLicense(license)) {
        throw new BadRequestException(
          `License "${license}" forbids redistribution (NonCommercial or NoDerivatives restrictions). Non-redistributable third-party content cannot be uploaded.`,
        );
      }
      throw new BadRequestException(
        `License "${license}" is not a recognized open license. Uploaded rule packs must be OGL, ORC, Creative Commons, or public domain — copyrighted or purchased content cannot be uploaded.`,
      );
    }
  }

  /**
   * Per-entry effective-license validation (issue #734). The pack-level check
   * (assertOpenLicense) only validates the PACK license; a non-open entry ("All Rights
   * Reserved") could otherwise smuggle into an open-licensed pack. Each entry's effective
   * license is its own, falling back to the pack's, and ALL must be open or self-authored. Throws a single
   * indexed BadRequestException naming every offending entry (input index + slug + license)
   * so the uploader can fix and resubmit — called synchronously at enqueue so the caller
   * gets a 400 at the POST, not a failed job to poll for.
   */
  private assertEntriesOpenLicensed(input: RulePackUpload): void {
    const offenders: Array<{ index: number; slug: string; license: string }> = [];
    input.entries.forEach((entry, index) => {
      const effectiveLicense = (entry.license ?? '').trim() || input.pack.license;
      if (!isValidUploadLicense(effectiveLicense)) {
        offenders.push({ index, slug: entry.slug, license: effectiveLicense });
      }
    });
    if (offenders.length > 0) {
      const detail = offenders
        .map((o) => `entry[${o.index}] "${o.slug}" (license "${o.license}")`)
        .join('; ');
      throw new BadRequestException(
        `Uploaded pack contains ${offenders.length} entr${offenders.length === 1 ? 'y' : 'ies'} with a non-open effective license. Each entry must be OGL, ORC, Creative Commons, or public domain (entry license falls back to the pack license). Offending ${offenders.length === 1 ? 'entry' : 'entries'}: ${detail}.`,
      );
    }
  }

  async listPacks(): Promise<RulePack[]> {
    const rows = await this.db.select().from(rulePacks).where(sql`${rulePacks.slug} != '__campaign_homebrew_internal__'`);
    const usage = await this.countCampaignsByRuleSystem();
    return rows.map((row) => ({ ...packToDomain(row), usageCount: usage.get(row.slug) ?? 0 }));
  }

  /**
   * Authoritative, server-wide count of live campaigns per `ruleSystem` slug (issue #385).
   * The admin is usually a member of few/no campaigns, so a client-side count from GET
   * /campaigns (only the caller's visible campaigns) under-reports. This grouped count sees
   * every live campaign and feeds each pack's `usageCount`; trashed campaigns no longer use
   * live rules and must not block a pack uninstall.
   */
  private async countCampaignsByRuleSystem(): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ ruleSystem: campaigns.ruleSystem, enabledPackSlugs: campaigns.enabledPackSlugs })
      .from(campaigns)
      .where(isNull(campaigns.deletedAt));
    const map = new Map<string, number>();
    for (const r of rows) {
      const slugs = new Set([r.ruleSystem, ...fromJsonText<string[]>(r.enabledPackSlugs, [])].filter(Boolean));
      for (const slug of slugs) map.set(slug, (map.get(slug) ?? 0) + 1);
    }
    return map;
  }

  async getPackOrThrow(id: number) {
    const [row] = await this.db.select().from(rulePacks).where(eq(rulePacks.id, id)).limit(1);
    if (!row || row.slug === '__campaign_homebrew_internal__') throw new NotFoundException(`Rule pack ${id} not found`);
    return row;
  }

  async getEntryOrThrow(id: number, campaignId?: number, user?: RequestUser): Promise<RuleEntry> {
    if (campaignId !== undefined) {
      if (!user) throw new ForbiddenException('Campaign access requires user context');
      await this.homebrewRole(campaignId, user);
    }
    const scope = campaignId !== undefined
      ? and(eq(ruleEntries.id, id), or(isNull(ruleEntries.campaignId), eq(ruleEntries.campaignId, campaignId)))
      : and(eq(ruleEntries.id, id), isNull(ruleEntries.campaignId));
    const [row] = await this.db.select().from(ruleEntries).where(scope).limit(1);
    if (!row) throw new NotFoundException(`Rule entry ${id} not found`);
    return entryToDomain(row);
  }

  /**
   * Look up an installed rule pack by its slug (issue #717). The AI table's rules help
   * binds lookups to the campaign's active rule system — its `ruleSystem` field is the
   * slug of the installed pack the table is playing under (or '' for homebrew). This
   * resolves that slug to a `RulePack` (with name/license/sourceUrl for the human-
   * readable answer) so the driver can scope `search` to a single pack and render the
   * pack's attribution. Returns undefined for a missing/empty slug rather than throwing,
   * so the caller can render a "no rule system configured" note for homebrew tables.
   */
  async getPackBySlug(slug: string): Promise<RulePack | undefined> {
    if (!slug) return undefined;
    const [row] = await this.db.select().from(rulePacks).where(eq(rulePacks.slug, slug)).limit(1);
    return row ? packToDomain(row) : undefined;
  }

  /**
   * DM/admin-set edits to an imported entry (issue #305). Today only the manual icon
   * override is editable — a DM picks a bundled game-icons.net slug to show in the
   * compendium list + reader, or clears it ('') to fall back to the type-derived
   * default. The slug is stored opaquely (an unknown one just renders as the default),
   * so no catalog validation is needed server-side. Bumps updatedAt so the reader's
   * optimistic state stays in sync.
   */
  async updateEntry(id: number, patch: { iconSlug?: string }): Promise<RuleEntry> {
    const set: Partial<typeof ruleEntries.$inferInsert> = {};
    if (patch.iconSlug !== undefined) set.iconSlug = patch.iconSlug;
    if (Object.keys(set).length === 0) return this.getEntryOrThrow(id);

    set.updatedAt = nowIso();
    const [row] = await this.db
      .update(ruleEntries)
      .set(set)
      .where(and(eq(ruleEntries.id, id), isNull(ruleEntries.campaignId)))
      .returning();
    if (!row) throw new NotFoundException(`Rule entry ${id} not found`);
    return entryToDomain(row);
  }

  private async homebrewPackId(): Promise<number> {
    const slug = '__campaign_homebrew_internal__';
    let [pack] = await this.db.select().from(rulePacks).where(eq(rulePacks.slug, slug)).limit(1);
    if (!pack) {
      const now = nowIso();
      try { [pack] = await this.db.insert(rulePacks).values({ slug, name: 'Campaign homebrew (internal)', version: '', license: '', sourceUrl: '', installedAt: now, entryCount: 0 }).returning(); }
      catch { [pack] = await this.db.select().from(rulePacks).where(eq(rulePacks.slug, slug)).limit(1); }
    }
    if (!pack) throw new BadRequestException('Unable to initialize campaign homebrew');
    return pack.id;
  }

  private async homebrewRole(campaignId: number, user: RequestUser, write = false) {
    return write ? this.access.requireRole(user, campaignId, 'dm') : this.access.requireMember(user, campaignId);
  }

  private homebrewPayload(row: typeof ruleEntries.$inferSelect): Record<string, unknown> {
    return { slug: row.slug, name: row.name, type: row.type, summary: row.summary, body: row.body, dataJson: row.dataJson ?? undefined, rightsStatus: row.rightsStatus, license: row.license, attribution: row.attribution, author: row.author, sourceUrl: row.sourceUrl, iconSlug: row.iconSlug };
  }
  private async auditHomebrew(campaignId: number, row: RuleEntry, user: RequestUser, action: string): Promise<void> {
    await this.audit.log({ campaignId, actor: auditActor(user), actorRole: auditActorRole(user), action, entityType: 'rule_entry', entityId: row.id, detail: row.slug });
  }

  async listCampaignHomebrew(campaignId: number, user: RequestUser, includeArchived = false): Promise<RuleEntry[]> {
    await this.homebrewRole(campaignId, user);
    const scope = includeArchived
      ? eq(ruleEntries.campaignId, campaignId)
      : and(eq(ruleEntries.campaignId, campaignId), isNull(ruleEntries.archivedAt));
    return (await this.db.select().from(ruleEntries).where(scope).orderBy(asc(ruleEntries.name), asc(ruleEntries.id))).map(entryToDomain);
  }

  async getCampaignHomebrew(campaignId: number, id: number, user: RequestUser): Promise<RuleEntry> {
    await this.homebrewRole(campaignId, user);
    const [row] = await this.db.select().from(ruleEntries).where(and(eq(ruleEntries.id, id), eq(ruleEntries.campaignId, campaignId))).limit(1);
    if (!row) throw new NotFoundException(`Homebrew rule entry ${id} not found`);
    return entryToDomain(row);
  }

  private normalizedHomebrew(input: unknown) {
    const parsed = HomebrewRuleEntryInput.parse(input);
    const { data, ...rest } = parsed;
    return { ...rest, dataJson: data !== undefined ? JSON.stringify(data) : (parsed.dataJson ?? null) };
  }

  async createCampaignHomebrew(campaignId: number, input: unknown, user: RequestUser, auditAction = 'homebrew.create'): Promise<RuleEntry> {
    await this.homebrewRole(campaignId, user, true);
    const value = this.normalizedHomebrew(input); const now = nowIso(); const packId = await this.homebrewPackId();
    try {
      const [row] = await this.db.transaction((tx) => {
        const row = tx.insert(ruleEntries).values({ packId, campaignId, ...value, source: '', provenance: 'campaign_homebrew', archivedAt: null, createdAt: now, updatedAt: now }).returning().get();
        tx.insert(ruleEntryRevisions).values({ ruleEntryId: row.id, campaignId, actor: String(user.id), beforeJson: '{}', afterJson: JSON.stringify(this.homebrewPayload(row)), createdAt: now }).run();
        return [row];
      });
      const entry = entryToDomain(row);
      await this.auditHomebrew(campaignId, entry, user, auditAction);
      return entry;
    } catch (err) { if (isUniqueConstraintError(err)) throw new ConflictException('A homebrew entry already uses this slug'); throw err; }
  }

  async updateCampaignHomebrew(campaignId: number, id: number, patch: Record<string, unknown>, user: RequestUser): Promise<RuleEntry> {
    await this.homebrewRole(campaignId, user, true);
    const expected = typeof patch.expectedUpdatedAt === 'string' ? patch.expectedUpdatedAt : undefined; delete patch.expectedUpdatedAt;
    const current = await this.getCampaignHomebrew(campaignId, id, user);
    if (expected && current.updatedAt !== expected) throw new ConflictException('Homebrew entry has changed; reload before saving');
    // homebrewPayload always projects dataJson. If the editor (or a proposal) supplies
    // structured `data`, drop the stored representation first — HomebrewRuleEntryInput
    // rejects objects that carry both.
    const base = this.homebrewPayload((await this.db.select().from(ruleEntries).where(eq(ruleEntries.id, id)).get())!);
    const mergedInput: Record<string, unknown> = { ...base, ...patch };
    if (patch.data !== undefined) delete mergedInput.dataJson;
    if (patch.dataJson !== undefined) delete mergedInput.data;
    const merged = this.normalizedHomebrew(mergedInput); const now = nowIso();
    const [row] = await this.db.transaction((tx) => {
      const before = tx.select().from(ruleEntries).where(and(eq(ruleEntries.id, id), eq(ruleEntries.campaignId, campaignId))).get(); if (!before) throw new NotFoundException('Homebrew rule entry not found');
      const row = tx.update(ruleEntries).set({ ...merged, updatedAt: now }).where(and(eq(ruleEntries.id, id), eq(ruleEntries.campaignId, campaignId), expected ? eq(ruleEntries.updatedAt, expected) : undefined)).returning().get();
      if (!row) throw new ConflictException('Homebrew entry has changed; reload before saving');
      tx.insert(ruleEntryRevisions).values({ ruleEntryId: id, campaignId, actor: String(user.id), beforeJson: JSON.stringify(this.homebrewPayload(before)), afterJson: JSON.stringify(this.homebrewPayload(row)), createdAt: now }).run(); return [row];
    }); const entry = entryToDomain(row); await this.auditHomebrew(campaignId, entry, user, 'homebrew.update'); return entry;
  }

  /** Proposal approval adapter: resolves campaign scope from the private row, then
   * reuses the normal DM/CAS/revision/audit update path. */
  async updateCampaignHomebrewFromProposal(id: number, patch: Record<string, unknown>, user: RequestUser): Promise<RuleEntry> {
    const row = await this.db.select({ campaignId: ruleEntries.campaignId }).from(ruleEntries).where(eq(ruleEntries.id, id)).get();
    if (!row?.campaignId) throw new NotFoundException('Homebrew rule entry not found');
    return this.updateCampaignHomebrew(row.campaignId, id, patch, user);
  }

  async duplicateCampaignHomebrew(campaignId: number, id: number, user: RequestUser): Promise<RuleEntry> {
    const source = await this.getCampaignHomebrew(campaignId, id, user);
    const base = `${source.slug}-copy`; let slug = base; let i = 2;
    while ((await this.db.select({ id: ruleEntries.id }).from(ruleEntries).where(and(eq(ruleEntries.campaignId, campaignId), eq(ruleEntries.slug, slug))).limit(1)).length) slug = `${base}-${i++}`;
    return this.createCampaignHomebrew(campaignId, { ...this.homebrewPayload((await this.db.select().from(ruleEntries).where(eq(ruleEntries.id, id)).get())!), slug, name: `${source.name} (copy)` }, user, 'homebrew.duplicate');
  }

  async archiveCampaignHomebrew(campaignId: number, id: number, user: RequestUser): Promise<RuleEntry> {
    await this.homebrewRole(campaignId, user, true); const now = nowIso();
    const [row] = await this.db.transaction((tx) => { const before = tx.select().from(ruleEntries).where(and(eq(ruleEntries.id, id), eq(ruleEntries.campaignId, campaignId))).get(); if (!before) throw new NotFoundException('Homebrew rule entry not found'); const row = tx.update(ruleEntries).set({ archivedAt: now, updatedAt: now }).where(and(eq(ruleEntries.id, id), eq(ruleEntries.campaignId, campaignId))).returning().get(); tx.insert(ruleEntryRevisions).values({ ruleEntryId: id, campaignId, actor: String(user.id), beforeJson: JSON.stringify(this.homebrewPayload(before)), afterJson: JSON.stringify(this.homebrewPayload(row)), createdAt: now }).run(); return [row]; }); const entry = entryToDomain(row); await this.auditHomebrew(campaignId, entry, user, 'homebrew.archive'); return entry;
  }

  async homebrewRevisions(campaignId: number, id: number, user: RequestUser) { await this.getCampaignHomebrew(campaignId, id, user); return this.db.select().from(ruleEntryRevisions).where(and(eq(ruleEntryRevisions.campaignId, campaignId), eq(ruleEntryRevisions.ruleEntryId, id))).orderBy(asc(ruleEntryRevisions.id)); }

  async previewHomebrewImport(campaignId: number, input: { entries: unknown[] }, user: RequestUser) {
    await this.homebrewRole(campaignId, user);
    const existing = await this.db.select({ slug: ruleEntries.slug, id: ruleEntries.id, updatedAt: ruleEntries.updatedAt }).from(ruleEntries).where(eq(ruleEntries.campaignId, campaignId));
    const bySlug = new Map(existing.map((row) => [row.slug, row]));
    return { entries: input.entries.map((raw, index) => { const entry = this.normalizedHomebrew(raw); const conflict = bySlug.get(entry.slug); return { index, slug: entry.slug, valid: true, conflict: conflict ? { id: conflict.id, updatedAt: conflict.updatedAt } : null, entry }; }) };
  }

  async applyHomebrewImport(campaignId: number, input: { entries: unknown[]; strategy: 'skip' | 'replace' | 'duplicate'; expectedUpdatedAt?: Record<string, string> }, user: RequestUser) {
    await this.homebrewRole(campaignId, user, true);
    // Parse every payload before opening the write transaction: malformed later rows
    // must never leave an earlier half of the file imported.
    const planned = input.entries.map((raw) => this.normalizedHomebrew(raw));
    const packId = await this.homebrewPackId(); const now = nowIso();
    const result = this.db.transaction((tx) => {
      const existing = tx.select().from(ruleEntries).where(eq(ruleEntries.campaignId, campaignId)).all();
      const bySlug = new Map(existing.map((row) => [row.slug, row])); const used = new Set(existing.map((row) => row.slug));
      const rows: typeof ruleEntries.$inferSelect[] = []; let skipped = 0; let replaced = 0;
      for (const entry of planned) {
        const conflict = bySlug.get(entry.slug);
        if (conflict && input.strategy === 'skip') { skipped++; continue; }
        if (conflict && input.strategy === 'replace') {
          const expected = input.expectedUpdatedAt?.[entry.slug] ?? conflict.updatedAt;
          const row = tx.update(ruleEntries).set({ ...entry, updatedAt: now }).where(and(eq(ruleEntries.id, conflict.id), eq(ruleEntries.campaignId, campaignId), eq(ruleEntries.updatedAt, expected))).returning().get();
          if (!row) throw new ConflictException(`Homebrew entry ${entry.slug} has changed; reload import preview`);
          tx.insert(ruleEntryRevisions).values({ ruleEntryId: row.id, campaignId, actor: String(user.id), beforeJson: JSON.stringify(this.homebrewPayload(conflict)), afterJson: JSON.stringify(this.homebrewPayload(row)), createdAt: now }).run(); rows.push(row); replaced++; continue;
        }
        let slug = entry.slug; if (conflict) { slug = `${slug}-import`; let n = 2; while (used.has(slug)) slug = `${entry.slug}-import-${n++}`; }
        const row = tx.insert(ruleEntries).values({ packId, campaignId, ...entry, slug, source: '', provenance: 'campaign_homebrew_import', archivedAt: null, createdAt: now, updatedAt: now }).returning().get();
        tx.insert(ruleEntryRevisions).values({ ruleEntryId: row.id, campaignId, actor: String(user.id), beforeJson: '{}', afterJson: JSON.stringify(this.homebrewPayload(row)), createdAt: now }).run(); rows.push(row); used.add(slug); bySlug.set(slug, row);
      }
      return { rows, skipped, replaced };
    });
    const entries = result.rows.map(entryToDomain);
    await this.audit.log({ campaignId, actor: auditActor(user), actorRole: auditActorRole(user), action: 'homebrew.import', entityType: 'rule_entry', detail: `${entries.length} entries (${result.replaced} replaced, ${result.skipped} skipped)` });
    return { entries, created: entries.length - result.replaced, replaced: result.replaced, skipped: result.skipped };
  }

  /**
   * Installs a rule pack from Open5e, or — if "open5e-srd" is already installed —
   * refreshes entries from the requested sections in place and incrementally adds any
   * that aren't present yet. Dedupe key is (slug, type); refreshing keeps stable entry
   * ids and manual icon overrides while replacing importer-owned content. This matters
   * when a newer importer starts retaining additional upstream fields (issue #621).
   *
   * Fresh install: 201, returns the RulePack as before.
   * Incremental install (pack already exists): 200, returns
   * `RulePack & { added: number; skippedExisting: number }`. We deliberately never 409
   * here even if every requested entry already existed (added:0, skippedExisting:N) —
   * simpler UX than forcing the caller to pre-check section coverage, and idempotent:
   * calling install repeatedly with the same sections converges to a 200 refresh rather
   * than an error the caller has to special-case.
   *
   * Concurrency (round-2 finding #3): two concurrent *fresh* installs can both pass the
   * `existing` pack check before either commits. The first INSERT wins; the second hits
   * `rule_packs.slug`'s UNIQUE constraint. That constraint violation is caught and the
   * call is retried once as an incremental install against the now-existing row, so
   * concurrent installs converge to one 201 and the rest clean 200/409s — never a raw 500.
   */
  async installFromOpen5e(
    input: RulePackInstall,
    user: RequestUser,
    onSectionDone?: (section: string, imported: number) => void,
  ): Promise<PersistPackResult> {
    const baseUrl = input.url ?? OPEN5E_DEFAULT_BASE_URL;
    const sections: Open5eSection[] = input.sections?.length ? (input.sections as Open5eSection[]) : ALL_OPEN5E_SECTIONS;
    const slug = 'open5e-srd';

    // Fetch sections concurrently (as before), but report each section's imported
    // count as its fetch resolves so a polling job (issue #20) shows live progress.
    const sectionResults = await Promise.all(
      sections.map(async (s) => {
        const r = await fetchOpen5eSection(baseUrl, s);
        onSectionDone?.(s, r.entries.length);
        return r;
      }),
    );
    const allEntries = sectionResults.flatMap((r) => r.entries);
    const totalSkipped = sectionResults.reduce((sum, r) => sum + r.skippedCount, 0);
    if (allEntries.length === 0) {
      throw new BadRequestException('Open5e import returned no entries for the requested sections');
    }
    if (totalSkipped > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[open5e-importer] install "${slug}": ${allEntries.length} entries imported across ${sections.length} section(s), ${totalSkipped} row(s) skipped total (see per-section warnings above)`,
      );
    }

    const license = canonicalPackLicense(allEntries, 'OGL/CC');

    return this.persistPack(
      { slug, name: 'Open5e SRD', version: OPEN5E_PACK_VERSION, license, sourceUrl: baseUrl, sectionLabels: sections },
      allEntries,
      user,
      `(cap ${MAX_ENTRIES_PER_SECTION}/section, ${totalSkipped} skipped${truncationNote(sectionResults)})`,
      completeManifestOptions(sections, ALL_OPEN5E_SECTIONS, sectionResults, MAX_ENTRIES_PER_SECTION),
    );
  }

  /**
   * Installs a Pathfinder 2e rule pack from the Archives of Nethys open dataset (issue
   * #295), or incrementally adds missing entries if `pf2e-srd` is already installed. This
   * is the deliberate mirror of installFromOpen5e: fetch each PF2e section concurrently,
   * report per-section progress, then reuse the same persistPack path (multi-pack
   * coexistence, incremental add, and the concurrent-install race guard all apply). The
   * pack installs under PF2E_PACK_SLUG, which the PF2e RuleSystemAdapter is registered
   * against — so a campaign selecting this pack routes its combat math through PF2e.
   */
  async installFromPf2e(
    input: RulePackInstall,
    user: RequestUser,
    onSectionDone?: (section: string, imported: number) => void,
  ): Promise<PersistPackResult> {
    const baseUrl = input.url ?? PF2E_DEFAULT_BASE_URL;
    const sections: Pf2eSection[] = input.sections?.length
      ? (input.sections as Pf2eSection[])
      : ALL_PF2E_SECTIONS;

    const sectionResults = await Promise.all(
      sections.map(async (s) => {
        const r = await fetchPf2eSection(baseUrl, s);
        onSectionDone?.(s, r.entries.length);
        return r;
      }),
    );
    const allEntries = sectionResults.flatMap((r) => r.entries);
    const totalSkipped = sectionResults.reduce((sum, r) => sum + r.skippedCount, 0);
    if (allEntries.length === 0) {
      throw new BadRequestException('Pathfinder 2e import returned no entries for the requested sections');
    }

    const license = canonicalPackLicense(allEntries, PF2E_DEFAULT_LICENSE);

    return this.persistPack(
      { slug: PF2E_PACK_SLUG, name: PF2E_PACK_NAME, version: nowIso().slice(0, 10), license, sourceUrl: baseUrl, sectionLabels: sections },
      allEntries,
      user,
      `(cap ${PF2E_MAX_ENTRIES_PER_SECTION}/section, ${totalSkipped} skipped${truncationNote(sectionResults)})`,
      // PF2e/SF2e DO keep removal: every row the AoN walk drops — off-type hit, adventure
      // source, mapper throw, missing name — increments skippedCount, so a real entry can
      // never go missing from a manifest that still looks complete. Note that in practice this
      // arms rarely: the live AoN index routinely returns adventure-sourced rows, which are
      // counted as skips, so a real full import usually reports skippedCount > 0 and declines
      // to remove. That is conservative in the right direction and is not relied upon.
      completeManifestOptions(sections, ALL_PF2E_SECTIONS, sectionResults, PF2E_MAX_ENTRIES_PER_SECTION),
    );
  }

  async installFromSf2e(
    input: RulePackInstall,
    user: RequestUser,
    onSectionDone?: (section: string, imported: number) => void,
  ): Promise<PersistPackResult> {
    const baseUrl = input.url ?? SF2E_DEFAULT_BASE_URL;
    const sections: Pf2eSection[] = input.sections?.length
      ? (input.sections as Pf2eSection[])
      : ALL_PF2E_SECTIONS;

    const sectionResults = await Promise.all(
      sections.map(async (s) => {
        const r = await fetchSf2eSection(baseUrl, s);
        onSectionDone?.(s, r.entries.length);
        return r;
      }),
    );
    const allEntries = sectionResults.flatMap((r) => r.entries);
    const totalSkipped = sectionResults.reduce((sum, r) => sum + r.skippedCount, 0);
    if (allEntries.length === 0) {
      throw new BadRequestException('Starfinder 2e import returned no entries for the requested sections');
    }

    const license = canonicalPackLicense(allEntries, SF2E_DEFAULT_LICENSE);

    return this.persistPack(
      { slug: SF2E_PACK_SLUG, name: SF2E_PACK_NAME, version: nowIso().slice(0, 10), license, sourceUrl: baseUrl, sectionLabels: sections },
      allEntries,
      user,
      `(cap ${PF2E_MAX_ENTRIES_PER_SECTION}/section, ${totalSkipped} skipped${truncationNote(sectionResults)})`,
      completeManifestOptions(sections, ALL_PF2E_SECTIONS, sectionResults, PF2E_MAX_ENTRIES_PER_SECTION),
    );
  }

  /**
   * Installs the Open Legend SRD/community codex rule pack (issue #299), or incrementally
   * adds any not-yet-present entries if "open-legend-srd" is already installed. Mirrors
   * installFromOpen5e exactly — same concurrent-fresh-install race guard, same dedupe-by-
   * (slug,type), same persistence path — but pulls Open Legend's attribute-based content
   * (boons/banes/feats — the three sections that exist as open data) instead of Open5e's.
   * Banes and boons both import as
   * 'condition' entries, distinguished by dataJson.kind. Bulk ingest runs through the same
   * background install-job machinery as Open5e once a controller enqueues it (the job-source
   * enum widening is left to the #275 ruleset program so sibling systems land theirs together).
   */
  async installFromOpenLegend(
    input: RulePackInstall,
    user: RequestUser,
    onSectionDone?: (section: string, imported: number) => void,
  ): Promise<PersistPackResult> {
    const baseUrl = input.url ?? OPEN_LEGEND_DEFAULT_BASE_URL;
    const sections: OpenLegendSection[] = input.sections?.length
      ? (input.sections as OpenLegendSection[])
      : ALL_OPEN_LEGEND_SECTIONS;
    const slug = OPEN_LEGEND_PACK_SLUG;

    const sectionResults = await Promise.all(
      sections.map(async (s) => {
        const r = await fetchOpenLegendSection(baseUrl, s);
        onSectionDone?.(s, r.entries.length);
        return r;
      }),
    );
    const allEntries = sectionResults.flatMap((r) => r.entries);
    const totalSkipped = sectionResults.reduce((sum, r) => sum + r.skippedCount, 0);
    if (allEntries.length === 0) {
      throw new BadRequestException('Open Legend import returned no entries for the requested sections');
    }
    if (totalSkipped > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[open-legend-importer] install "${slug}": ${allEntries.length} entries imported across ${sections.length} section(s), ${totalSkipped} row(s) skipped total (see per-section warnings above)`,
      );
    }

    const license = canonicalPackLicense(allEntries, OPEN_LEGEND_DEFAULT_LICENSE);

    return this.persistPack(
      { slug, name: 'Open Legend SRD', version: nowIso().slice(0, 10), license, sourceUrl: baseUrl, sectionLabels: sections },
      allEntries,
      user,
      `(cap ${OL_MAX_ENTRIES_PER_SECTION}/section, ${totalSkipped} skipped${truncationNote(sectionResults)})`,
      completeManifestOptions(sections, ALL_OPEN_LEGEND_SECTIONS, sectionResults, OL_MAX_ENTRIES_PER_SECTION),
    );
  }

  /**
   * Installs a Pathfinder 1e rule pack (issue #296), or incrementally adds missing entries
   * if `pathfinder-1e` already exists. Deliberate mirror of installFromOpen5e — concurrent
   * fetch, per-section progress, shared persistPack (multi-pack coexistence + incremental
   * add + race guard). Installs under PF1E_PACK_SLUG, which the Pathfinder1eAdapter is
   * registered against. NOTE: no live PF1e SRD mirror is configured; `assertUrlForSource`
   * requires an explicit `url` and the importer itself refuses an empty/missing base URL
   * before any fetch (#555).
   */
  async installFromPf1e(
    input: RulePackInstall,
    user: RequestUser,
    onSectionDone?: (section: string, imported: number) => void,
  ): Promise<PersistPackResult> {
    this.assertUrlForSource(input.source, input.url);
    const baseUrl = input.url!;
    const sections: Pf1eSection[] = input.sections?.length ? (input.sections as Pf1eSection[]) : ALL_PF1E_SECTIONS;

    const sectionResults = await Promise.all(
      sections.map(async (s) => {
        const r = await fetchPathfinder1eSection(baseUrl, s);
        onSectionDone?.(s, r.entries.length);
        return r;
      }),
    );
    const allEntries = sectionResults.flatMap((r) => r.entries);
    const totalSkipped = sectionResults.reduce((sum, r) => sum + r.skippedCount, 0);
    if (allEntries.length === 0) {
      throw new BadRequestException('Pathfinder 1e import returned no entries for the requested sections');
    }

    const license = canonicalPackLicense(allEntries, PF1E_DEFAULT_LICENSE);

    return this.persistPack(
      { slug: PF1E_PACK_SLUG, name: PF1E_PACK_NAME, version: nowIso().slice(0, 10), license, sourceUrl: baseUrl, sectionLabels: sections },
      allEntries,
      user,
      `(cap ${PF1E_MAX_ENTRIES_PER_SECTION}/section, ${totalSkipped} skipped${truncationNote(sectionResults)})`,
      completeManifestOptions(sections, ALL_PF1E_SECTIONS, sectionResults, PF1E_MAX_ENTRIES_PER_SECTION),
    );
  }

  /**
   * Installs a Starfinder 1e rule pack (issue #297), or incrementally adds missing entries
   * if `starfinder-1e` already exists. Mirror of installFromOpen5e. Installs under the
   * `starfinder-1e` pack slug (= STARFINDER_ADAPTER_ID) so a campaign selecting it resolves
   * the Starfinder adapter. NOTE: the default base URL does not resolve (dead DNS, #346); the
   * enqueue path requires an explicit `url` until a live SRD mirror is validated.
   */
  async installFromStarfinder(
    input: RulePackInstall,
    user: RequestUser,
    onSectionDone?: (section: string, imported: number) => void,
  ): Promise<PersistPackResult> {
    const baseUrl = input.url ?? STARFINDER_DEFAULT_BASE_URL;
    const sections: StarfinderSection[] = input.sections?.length
      ? (input.sections as StarfinderSection[])
      : ALL_STARFINDER_SECTIONS;

    const sectionResults = await Promise.all(
      sections.map(async (s) => {
        const r = await fetchStarfinderSection(baseUrl, s);
        onSectionDone?.(s, r.entries.length);
        return r;
      }),
    );
    const allEntries = sectionResults.flatMap((r) => r.entries);
    const totalSkipped = sectionResults.reduce((sum, r) => sum + r.skippedCount, 0);
    if (allEntries.length === 0) {
      throw new BadRequestException('Starfinder import returned no entries for the requested sections');
    }

    const license = canonicalPackLicense(allEntries, RulesService.STARFINDER_DEFAULT_LICENSE);

    return this.persistPack(
      {
        slug: RulesService.STARFINDER_PACK_SLUG,
        name: RulesService.STARFINDER_PACK_NAME,
        version: nowIso().slice(0, 10),
        license,
        sourceUrl: baseUrl,
        sectionLabels: sections,
      },
      allEntries,
      user,
      `(cap ${STARFINDER_MAX_ENTRIES_PER_SECTION}/section, ${totalSkipped} skipped${truncationNote(sectionResults)})`,
      completeManifestOptions(sections, ALL_STARFINDER_SECTIONS, sectionResults, STARFINDER_MAX_ENTRIES_PER_SECTION),
    );
  }

  /**
   * Installs a 13th Age (Archmage Engine) rule pack (issue #298), or incrementally adds
   * missing entries if `archmage-srd` already exists. The importer parses HTML rather than
   * JSON but returns the same ImportedEntry[] shape, so this mirrors installFromOpen5e down
   * to the shared persistPack path. NOTE: the default base URL returns HTTP 410 Gone (#346);
   * the enqueue path requires an explicit `url` until a live mirror is validated.
   */
  async installFromArchmage(
    input: RulePackInstall,
    user: RequestUser,
    onSectionDone?: (section: string, imported: number) => void,
  ): Promise<PersistPackResult> {
    const baseUrl = input.url ?? ARCHMAGE_DEFAULT_BASE_URL;
    const sections: ArchmageSection[] = input.sections?.length
      ? (input.sections as ArchmageSection[])
      : ALL_ARCHMAGE_SECTIONS;

    const sectionResults = await Promise.all(
      sections.map(async (s) => {
        const r = await fetchArchmageSection(baseUrl, s);
        onSectionDone?.(s, r.entries.length);
        return r;
      }),
    );
    const allEntries = sectionResults.flatMap((r) => r.entries);
    const totalSkipped = sectionResults.reduce((sum, r) => sum + r.skippedCount, 0);
    if (allEntries.length === 0) {
      throw new BadRequestException('13th Age import returned no entries for the requested sections');
    }

    const license = canonicalPackLicense(allEntries, ARCHMAGE_LICENSE);

    return this.persistPack(
      { slug: ARCHMAGE_PACK_SLUG, name: '13th Age SRD', version: nowIso().slice(0, 10), license, sourceUrl: baseUrl, sectionLabels: sections },
      allEntries,
      user,
      `(cap ${ARCHMAGE_MAX_ENTRIES_PER_SECTION}/section, ${totalSkipped} skipped)`,
      // archmage-importer distinguishes drifted statblocks from prose headings and counts
      // drifted statblocks into skippedCount (issue #1522), so completeManifestOptions can
      // safely check completeness to gate removal on re-import.
      completeManifestOptions(sections, ALL_ARCHMAGE_SECTIONS, sectionResults, ARCHMAGE_MAX_ENTRIES_PER_SECTION),
    );
  }

  /**
   * Installs an OSR retroclone rule pack (issue #300), or incrementally adds missing entries
   * if the selected source's pack already exists. `input.system` selects which `OsrSource`
   * (slug/license/attribution) the pack installs under — one importer serving several packs —
   * defaulting to 'basic-fantasy'. The pack installs under that source's `systemSlug`, which
   * the shared OsrAdapter is registered against, so `ruleSystemAdapter()` resolves OSR combat
   * for a campaign on that pack. NOTE: OSR has no public paginated JSON API (#346); the
   * enqueue path requires an explicit `url` pointing at a mirror/self-hosted server.
   */
  async installFromOsr(
    input: RulePackInstall,
    user: RequestUser,
    onSectionDone?: (section: string, imported: number) => void,
  ): Promise<PersistPackResult> {
    const source = osrSource(input.system);
    const baseUrl = input.url ?? source.sourceUrl;
    const sections: OsrSection[] = input.sections?.length ? (input.sections as OsrSection[]) : ALL_OSR_SECTIONS;

    const sectionResults = await Promise.all(
      sections.map(async (s) => {
        const r = await fetchOsrSection(baseUrl, s, source);
        onSectionDone?.(s, r.entries.length);
        return r;
      }),
    );
    const allEntries = sectionResults.flatMap((r) => r.entries);
    const totalSkipped = sectionResults.reduce((sum, r) => sum + r.skippedCount, 0);
    if (allEntries.length === 0) {
      throw new BadRequestException('OSR import returned no entries for the requested sections');
    }

    return this.persistPack(
      {
        slug: source.systemSlug,
        name: source.name,
        version: nowIso().slice(0, 10),
        license: source.license,
        sourceUrl: baseUrl,
        sectionLabels: sections,
      },
      allEntries,
      user,
      `(cap ${OSR_MAX_ENTRIES_PER_SECTION}/section, ${totalSkipped} skipped${truncationNote(sectionResults)})`,
      completeManifestOptions(sections, ALL_OSR_SECTIONS, sectionResults, OSR_MAX_ENTRIES_PER_SECTION),
    );
  }

  /**
   * Installs the Cepheus Engine SRD rule pack (issue #406), or incrementally adds any
   * not-yet-present entries if `cepheus-srd` is already installed. Deliberate mirror of
   * installFromOpen5e — concurrent per-book fetch, per-book progress, the shared persistPack
   * path (multi-pack coexistence + incremental add + concurrent-install race guard) — but the
   * importer parses mdBook Markdown into `section`-typed entries instead of JSON statblocks.
   * The pack carries the OGL v1.0a license and the Cepheus SRD's own attribution/trademark
   * notice (issue #143 / #734); an oversized chapter is split at headings by the importer so
   * no entry exceeds the body cap and no rules text is truncated away.
   */
  async installFromCepheus(
    input: RulePackInstall,
    user: RequestUser,
    onSectionDone?: (section: string, imported: number) => void,
  ): Promise<PersistPackResult> {
    const baseUrl = input.url ?? CEPHEUS_DEFAULT_BASE_URL;
    // Cepheus imports the whole SRD; its mdBook "books" are progress groups, not a selectable
    // per-statblock filter (a foreign `sections` value was already rejected 400 before enqueue).
    const sections: CepheusSection[] = ALL_CEPHEUS_SECTIONS;

    // One limiter shared across all books bounds the TOTAL in-flight raw-CDN fetches for the
    // whole install (books are fetched concurrently, so without a shared cap the burst would be
    // books × chapters). Chapters still complete in a deterministic order within each book.
    const fetchLimiter = createFetchLimiter(CEPHEUS_FETCH_CONCURRENCY);
    const sectionResults = await Promise.all(
      sections.map(async (s) => {
        const r = await fetchCepheusSection(baseUrl, s, consoleLogger, fetchLimiter);
        onSectionDone?.(s, r.entries.length);
        return r;
      }),
    );
    const allEntries = sectionResults.flatMap((r) => r.entries);
    const totalSkipped = sectionResults.reduce((sum, r) => sum + r.skippedCount, 0);
    if (allEntries.length === 0) {
      throw new BadRequestException('Cepheus Engine import returned no entries');
    }

    return this.persistPack(
      {
        slug: CEPHEUS_PACK_SLUG,
        name: CEPHEUS_PACK_NAME,
        version: nowIso().slice(0, 10),
        license: CEPHEUS_LICENSE,
        sourceUrl: baseUrl,
        sectionLabels: sections,
      },
      allEntries,
      user,
      `(${totalSkipped} skipped)`,
      // Cepheus always requests every book, but the mdBook parser still skips chapters/blocks
      // it cannot read; a short parse must not be mistaken for upstream deletions. No
      // per-section entry cap applies here (chapters are split, never truncated away).
      completeManifestOptions(sections, ALL_CEPHEUS_SECTIONS, sectionResults, Number.POSITIVE_INFINITY),
    );
  }

  /**
   * Installs the Ironsworn: Starforged (datasworn) rule pack (issue #405), or incrementally
   * adds missing entries if `ironsworn-starforged` already exists. Datasworn is a SINGLE JSON
   * document, so — unlike the paginated importers — this fetches the whole file ONCE and maps
   * each requested section out of it (npcs→monster, assets→item, moves/oracles/truths→section),
   * reporting per-section progress the caller polls. Oracles are flattened recursively (they
   * are collections-of-collections). Every entry carries CC-BY-4.0 licensing + attribution
   * built from the object's own provenance. The canonical source is live and open, so no
   * `url` is required (an explicit `url` overrides the default file location for tests/mirrors).
   */
  async installFromDatasworn(
    input: RulePackInstall,
    user: RequestUser,
    onSectionDone?: (section: string, imported: number) => void,
  ): Promise<PersistPackResult> {
    const url = input.url ?? DATASWORN_STARFORGED_URL;
    const sections: DataswornSection[] = input.sections?.length
      ? (input.sections as DataswornSection[])
      : ALL_DATASWORN_SECTIONS;

    // Fetch + validate the whole document ONCE, then map each requested section from memory.
    const doc = await fetchDataswornDocument(url);
    let totalSkipped = 0;
    const allEntries: ImportedEntry[] = [];
    const sectionResults: Array<{ entries: ImportedEntry[]; skippedCount: number }> = [];
    for (const section of sections) {
      const result = mapDataswornSection(doc, section);
      totalSkipped += result.skippedCount;
      allEntries.push(...result.entries);
      sectionResults.push(result);
      onSectionDone?.(section, result.entries.length);
    }
    if (allEntries.length === 0) {
      throw new BadRequestException('Datasworn import returned no entries for the requested sections');
    }

    return this.persistPack(
      {
        slug: DATASWORN_PACK_SLUG,
        name: DATASWORN_PACK_NAME,
        version: nowIso().slice(0, 10),
        license: DATASWORN_LICENSE,
        sourceUrl: url,
        sectionLabels: sections,
      },
      allEntries,
      user,
      `(cap ${DATASWORN_MAX_ENTRIES_PER_SECTION}/section, ${totalSkipped} skipped)`,
      // Datasworn never removes either, for a narrower version of the 13th Age reason. Its
      // per-OBJECT accounting is complete (every unmapped object increments skippedCount), but
      // its CONTAINER walk is not: a collection/category that isn't a record, or one whose
      // `contents` key is missing, is skipped with a bare `continue`. A schema drift in the
      // upstream JSON would therefore drop a whole collection of real oracles/moves with
      // skippedCount still 0.
      //
      // It is worth stating that today this changes nothing operationally: a real Starforged
      // file routinely nests sub-collections inside `contents`, and flattenOracleTables counts
      // each of those as a skip, so any import including `oracles` already has skippedCount > 0
      // and could never have removed anything. That safety is ACCIDENTAL — it evaporates the
      // moment an operator imports without the oracles section — so it is made explicit here
      // rather than left resting on the shape of one upstream file.
      completeManifestOptions(sections, ALL_DATASWORN_SECTIONS, sectionResults, DATASWORN_MAX_ENTRIES_PER_SECTION, {
        dropsAreCounted: false,
      }),
    );
  }

  /**
   * Installs a generic uploaded rule pack (issue #19): an open-licensed JSON dataset
   * for any system (Pathfinder 2e ORC, other OGL/CC content, homebrew), not just
   * Open5e. Reuses the same persistence path as the Open5e importer, so multi-pack
   * coexistence, incremental adds, and the concurrent-install race guard all apply
   * identically. License open-ness (pack + per-entry effective) is re-validated here as
   * defense-in-depth; the enqueue path already rejected a non-open license with a 400.
   */
  async installFromUpload(
    input: RulePackUpload,
    user: RequestUser,
    onSectionDone?: (section: string, imported: number) => void,
  ): Promise<PersistPackResult> {
    this.assertOpenLicense(input.pack.license);
    this.assertEntriesOpenLicensed(input);
    await this.validatePackRelationship(input.pack.slug, input.pack.kind ?? 'base', input.pack.extendsPackSlug ?? null);

    // De-dupe the incoming entries by (type, slug), keeping the first occurrence — the
    // (pack_id, type, slug) unique index (issue #143) would otherwise reject an upload that
    // carried the same slug twice with a raw constraint error mid-transaction.
    const seenKeys = new Set<string>();
    const entries: ImportedEntry[] = input.entries
      .filter((e) => {
        const key = `${e.type}::${e.slug}`;
        if (seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
      })
      .map((e) => ({
        slug: e.slug,
        name: e.name,
        type: e.type,
        summary: e.summary ?? '',
        body: e.body ?? '',
        dataJson: e.dataJson ?? null,
        license: e.license ?? input.pack.license,
        source: e.source ?? input.pack.name,
        // Per-entry provenance (issue #734): fall back to pack-level values so every row has
        // explicit, attributable provenance rather than a dropped/blank field.
        attribution: e.attribution ?? input.pack.name,
        author: e.author ?? '',
        sourceUrl: e.sourceUrl ?? input.pack.sourceUrl ?? '',
        iconSlug: e.iconSlug ?? '',
      }));

    // Report per-type import counts for progress (uploads have no network fetch, so
    // this is effectively instantaneous, but keeps the job's progress shape uniform).
    const byType = new Map<string, number>();
    for (const e of entries) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
    for (const [type, count] of byType) onSectionDone?.(type, count);

    return this.persistPack(
      {
        slug: input.pack.slug,
        name: input.pack.name,
        version: input.pack.version || nowIso().slice(0, 10),
        license: input.pack.license,
        sourceUrl: input.pack.sourceUrl ?? '',
        sectionLabels: [...byType.keys()],
        kind: input.pack.kind ?? 'base',
        extendsPackSlug: input.pack.extendsPackSlug ?? null,
      },
      entries,
      user,
      `upload (${entries.length} entries)`,
      // Uploads are ADDITIVE: a re-upload adds new entries and applies corrections to
      // existing ones, but never deletes entries absent from the file. Issue #500 is scoped
      // to UPSTREAM source updates, where the fetched manifest is authoritative and absence
      // genuinely means "removed upstream". A hand-uploaded file carries no such authority —
      // absence almost always means the operator uploaded a partial pack, not that they
      // intend a deletion. Turning that into "delete everything not in this file" would be
      // an unrequested destructive change with no opt-out. If full-replace uploads are ever
      // wanted, they need an explicit opt-in flag on RulePackUpload that defaults to off.
      //
      // Pack PROVENANCE is a separate question from the entry set, and an upload does carry
      // authority there: `pack.name`/`pack.license`/`pack.sourceUrl` are required, operator-
      // authored fields describing the whole pack (install even refuses a non-open pack
      // license), so a re-upload is how an operator corrects a pack's license or source.
      // That stays authoritative — only deletion is withheld.
      { removeMissing: false, rewritePackProvenance: true },
    );
  }

  /**
   * Shared persistence for both the Open5e importer and generic uploads: creates the
   * pack + entries in one transaction, or — if a pack with this slug already exists —
   * incrementally adds whatever entries aren't present yet (dedupe by slug+type). The
   * UNIQUE(slug) race between two concurrent fresh installs is absorbed by falling back
   * to the incremental path, so concurrent installs converge to one 'created' and the
   * rest 'updated' rather than a raw 500 (see the class docs / issue history).
   */
  private async persistPack(
    meta: PersistPackMeta,
    rawEntries: ImportedEntry[],
    user: RequestUser,
    detailSuffix: string,
    options: PersistPackOptions = {},
  ): Promise<PersistPackResult> {
    this.assertCurrentJobCanPersist();
    this.assertOpenLicense(meta.license);
    for (const entry of rawEntries) {
      const license = entry.license.trim() || meta.license;
      if (!isValidUploadLicense(license)) {
        throw new BadRequestException(`Imported entry "${entry.slug}" has a non-open or forbidden license "${license}".`);
      }
    }
    // De-dupe the incoming entries by (type, slug), keeping the first occurrence. Importers
    // only de-dupe WITHIN a section, but several sources map two sections onto one entry
    // type (PF2e feats+backgrounds→feat, OL boons+banes→condition, SF equipment/starships/
    // vehicles→item). A cross-section name collision would otherwise survive to the INSERT
    // and trip the (pack_id, type, slug) UNIQUE index mid-transaction — misreported as a
    // concurrent-install race. Centralizing the de-dupe here covers every caller (importers
    // and uploads) and both the fresh-install and incremental-add paths. Issues #326/#353.
    const seenKeys = new Set<string>();
    const entries = rawEntries.filter((e) => {
      const key = `${e.type}::${e.slug}`;
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });

    const sourceHash = packManifestHash(meta, entries);
    const previewForFresh: RulePackUpdatePreview = {
      added: entries.length,
      changed: 0,
      removed: 0,
      unchanged: 0,
      sourceHash,
      sourceVersion: meta.version,
    };

    const [existing] = await this.db.select().from(rulePacks).where(eq(rulePacks.slug, meta.slug)).limit(1);
    this.assertCurrentJobCanPersist();
    if (existing) {
      return this.syncExistingPack(existing, meta, entries, sourceHash, user, options);
    }

    const ts = nowIso();
    let pack: typeof rulePacks.$inferSelect;
    try {
      pack = this.db.transaction((tx) => {
        this.assertCurrentJobCanPersist();
        const [packRow] = tx
          .insert(rulePacks)
          .values({
            slug: meta.slug,
            name: meta.name,
            version: meta.version,
            license: meta.license,
            sourceUrl: meta.sourceUrl,
            kind: meta.kind ?? 'base',
            extendsPackSlug: meta.extendsPackSlug ?? null,
            installedAt: ts,
            entryCount: entries.length,
            manifestHash: sourceHash,
          })
          .returning()
          .all();

        for (const entry of entries) {
          const prov = effectiveEntryProvenance(entry, meta.license, meta.sourceUrl, meta.name);
          tx.insert(ruleEntries)
            .values({
              packId: packRow.id,
              slug: entry.slug,
              name: entry.name,
              type: entry.type,
              summary: entry.summary,
              body: entry.body,
              dataJson: entry.dataJson,
              source: entry.source,
              license: prov.license,
              attribution: prov.attribution,
              author: prov.author,
              sourceUrl: prov.sourceUrl,
              iconSlug: entry.iconSlug ?? '',
              createdAt: ts,
              updatedAt: ts,
            })
            .run();
        }

        return packRow;
      });
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      // Lost a race with a concurrent fresh install that committed between our
      // existence check and our INSERT — the pack now exists, so fall back to the
      // incremental path against it instead of surfacing a raw 500.
      const [raced] = await this.db.select().from(rulePacks).where(eq(rulePacks.slug, meta.slug)).limit(1);
      if (!raced) throw err; // shouldn't happen, but don't swallow a genuine failure
      return this.syncExistingPack(raced, meta, entries, sourceHash, user, options);
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: auditActorRole(user),
      action: 'rulepack.install',
      entityType: 'rule_pack',
      entityId: pack.id,
      detail: `${entries.length} entries from ${meta.sectionLabels.join(',')} ${detailSuffix}; source=${meta.sourceUrl || 'upload'} version=${meta.version} manifest=${sourceHash.slice(0, 12)}`,
    });

    return { ...packToDomain(pack), outcome: 'created', sourceHash, sourceVersion: meta.version, preview: previewForFresh };
  }

  /**
   * Synchronizes an already-installed pack against a freshly fetched/uploaded manifest.
   * Existing rows are compared by (type, slug); importer-owned fields are updated when
   * their content hash changes, while row ids, createdAt, and manual icon overrides are
   * preserved. Full-manifest callers may also remove rows no longer present upstream.
   */
  private async syncExistingPack(
    packRow: typeof rulePacks.$inferSelect,
    meta: PersistPackMeta,
    fetchedEntries: ImportedEntry[],
    sourceHash: string,
    user: RequestUser,
    options: PersistPackOptions = {},
  ): Promise<PersistPackResult> {
    const ts = nowIso();

    // The pack row's provenance columns describe the WHOLE pack, but `meta` is derived from
    // only the sections this call fetched — the admin UI's "Add sections to <pack>" flow means
    // an operator can install `monsters` today and add `spells` next week, and each importer
    // computes its pack license from just the entries it pulled. Rewriting the pack row from
    // that partial manifest would narrow the pack's license/source onto the new sections and
    // drop the terms that still govern every retained entry — and pack.license is not
    // decorative: it is the documented fallback for an entry whose own license is blank, the
    // label the AI source line prints, and what compendium export/import records as a
    // dependency's license. So provenance is replaced only when the caller proved this
    // manifest speaks for the whole pack (completeManifestOptions, or an operator-declared
    // upload). On a partial add we keep the pack's existing name + sourceUrl and UNION in the
    // new license terms, so the label still covers the retained sections while gaining
    // whatever the new one adds.
    //
    // `version` and `entryCount` always move: they describe this install and the pack's
    // current size, not where the content came from. This is also what the pre-#500
    // addEntriesToExistingPack did — the #500 work traded that preservation for provenance
    // updates, which is right for a full upstream refresh and wrong for a partial add.
    //
    // The computation itself lives INSIDE applySync's transaction — see the recompute site.

    let updatedPack = packRow;
    // The pack row as it stood at the START of the attempt that actually committed. The audit
    // trail diffs against this, not against the `packRow` snapshot taken before the
    // transaction, so a retry reports what it really changed.
    let packBeforeSync = packRow;
    let preview: RulePackUpdatePreview = {
      added: 0,
      changed: 0,
      removed: 0,
      unchanged: 0,
      sourceHash,
      sourceVersion: meta.version,
    };

    // The whole compare-and-apply runs inside ONE synchronous better-sqlite3 transaction:
    // the pack's current rows are re-read here (not before the transaction), so the
    // add/change/remove classification and the writes derived from it can never straddle
    // another writer's commit. A throw anywhere rolls the entire update back — the pack
    // stays wholly on the old manifest rather than becoming a half-old/half-new mixture.
    const applySync = (): {
      pack: typeof rulePacks.$inferSelect;
      before: typeof rulePacks.$inferSelect;
      preview: RulePackUpdatePreview;
    } =>
      this.db.transaction((tx) => {
        this.assertCurrentJobCanPersist();
        // Re-read the pack row INSIDE the transaction, and derive the provenance to write from
        // THAT row — never from the `packRow` snapshot the caller took before the transaction.
        // applySync is re-invoked wholesale when it loses a UNIQUE race, and the losing attempt
        // rolled back while the winner COMMITTED: by the time the retry runs, another writer may
        // have changed this pack's license. Computing the union from the pre-transaction
        // snapshot would silently overwrite that writer's terms with a stale label — precisely
        // the "lose license terms" failure this whole block exists to prevent. Keeping the read
        // and the derivation here means every attempt starts from freshly committed state.
        // Do not hoist these out of the transaction.
        const [currentPack] = tx.select().from(rulePacks).where(eq(rulePacks.id, packRow.id)).all();
        const before = currentPack ?? packRow;

        // Issue #1518 short-circuit. `sourceHash` (packManifestHash) is a CONTENT-ONLY
        // fingerprint of the pack's provenance plus every fetched entry's content hash —
        // `meta.version` is deliberately excluded (see packManifestHash) so a same-content
        // re-import matches even when it lands on a later UTC day than the install that
        // stamped the tracked hash. If it is byte-identical to the manifest hash the LAST
        // successful install/sync stamped on this pack row, every fetched entry is already
        // installed byte-for-byte: global rule-entry content only ever changes through THIS
        // import flow (campaign homebrew is campaign-scoped, and the only global edit path —
        // updateEntry — touches iconSlug/updatedAt, which the content hash excludes), and
        // that flow always re-stamps the hash. So the add/change classification below would
        // be all-unchanged, and the only remaining work a full pass could do is REMOVE
        // installed rows the manifest omits — which only a removeMissing pass attempts, so
        // gate it on entryCount (the import flow maintains entryCount == global row count):
        // if it already equals the manifest size there is nothing to remove, and
        // manifestUnchanged guarantees no fetched entry is missing either. Under those
        // conditions the only column a full sync would still move is the displayed `version`
        // label (the volatile date stamp #1518 keeps OUT of the comparison), so we skip the
        // per-entry read+sha256 classification and refresh just that one row — mirroring the
        // full sync's version write so the pack reflects this re-import while manifestHash is
        // left untouched (the content-only hash is unchanged). That keeps a large identical
        // re-import from monopolising the single Node thread — including the install-job poll
        // the admin UI renders this very import's progress through — and works identically
        // whether the re-import lands on the same day or a later one. Atomicity/read-stability
        // are preserved: the version refresh is a single in-transaction row update with nothing
        // entangled to roll back, and any genuinely-changed manifest (different sourceHash)
        // falls through to the full transactional classification below.
        const manifestUnchanged = before.manifestHash !== '' && before.manifestHash === sourceHash;
        const nothingToRemove = !options.removeMissing || before.entryCount === fetchedEntries.length;
        const provenanceAlreadySet =
          !options.rewritePackProvenance ||
          (before.name === meta.name &&
            before.sourceUrl === meta.sourceUrl &&
            before.license === meta.license &&
            before.kind === (meta.kind ?? 'base') &&
            before.extendsPackSlug === (meta.extendsPackSlug ?? null));
        if (manifestUnchanged && nothingToRemove && provenanceAlreadySet) {
          // Content identical -> skip the per-entry classification. Only the displayed
          // `version` label moves (#1518 keeps it out of the content hash, so it may differ
          // when the re-import lands on a later day): refresh it so the pack row reflects
          // this re-import, leaving manifestHash untouched. A same-day re-import whose version
          // label already matches short-circuits with no write at all.
          const refreshed =
            meta.version === before.version
              ? before
              : (tx
                  .update(rulePacks)
                  .set({ version: meta.version })
                  .where(eq(rulePacks.id, packRow.id))
                  .returning()
                  .all()[0] ?? before);
          return {
            pack: refreshed,
            before,
            preview: {
              added: 0,
              changed: 0,
              removed: 0,
              unchanged: fetchedEntries.length,
              sourceHash,
              sourceVersion: meta.version,
            } satisfies RulePackUpdatePreview,
          };
        }

        const nextName = options.rewritePackProvenance ? meta.name : before.name;
        const nextSourceUrl = options.rewritePackProvenance ? meta.sourceUrl : before.sourceUrl;
        const nextLicense = options.rewritePackProvenance
          ? meta.license
          : canonicalLicense(before.license, meta.license);
        const nextKind = options.rewritePackProvenance ? (meta.kind ?? 'base') : before.kind;
        const nextExtendsPackSlug = options.rewritePackProvenance
          ? (meta.extendsPackSlug ?? null)
          : before.extendsPackSlug;
        // Repeat the enqueue-time relationship guard inside the write transaction. A
        // campaign or extension can start referencing this base while an upload job is
        // queued; re-read those inbound references at the exact point reclassification
        // would otherwise commit so that race cannot leave invalid stored state.
        if (before.kind === 'base' && nextKind !== 'base') {
          const primaryCampaign = tx
            .select({ id: campaigns.id })
            .from(campaigns)
            .where(eq(campaigns.ruleSystem, before.slug))
            .limit(1)
            .all()[0];
          const dependentExtension = tx
            .select({ name: rulePacks.name })
            .from(rulePacks)
            .where(and(eq(rulePacks.extendsPackSlug, before.slug), eq(rulePacks.kind, 'extension')))
            .limit(1)
            .all()[0];
          if (primaryCampaign || dependentExtension) {
            throw new ConflictException(
              `Rule pack "${before.slug}" cannot be changed from base to ${nextKind} while campaigns or installed extensions depend on it as a base`,
            );
          }
        }

        const existingRows = tx.select().from(ruleEntries).where(eq(ruleEntries.packId, packRow.id)).all();
        const existingByKey = new Map(existingRows.map((r) => [`${r.type}::${r.slug}`, r]));
        const fetchedByKey = new Map(fetchedEntries.map((entry) => [`${entry.type}::${entry.slug}`, entry]));

        const toAdd: ImportedEntry[] = [];
        const toChange: Array<{ row: typeof ruleEntries.$inferSelect; entry: ImportedEntry }> = [];
        let unchanged = 0;

        for (const entry of fetchedEntries) {
          const key = `${entry.type}::${entry.slug}`;
          const existing = existingByKey.get(key);
          if (!existing) {
            toAdd.push(entry);
            continue;
          }
          const nextHash = importedEntryHash(entry, meta.license, meta.sourceUrl, meta.name);
          if (storedEntryHash(existing) === nextHash) unchanged += 1;
          else toChange.push({ row: existing, entry });
        }

        const toRemove = options.removeMissing
          ? existingRows.filter((row) => !fetchedByKey.has(`${row.type}::${row.slug}`))
          : [];

        for (const { row, entry } of toChange) {
          const prov = effectiveEntryProvenance(entry, meta.license, meta.sourceUrl, meta.name);
          tx.update(ruleEntries)
            .set({
              name: entry.name,
              summary: entry.summary,
              body: entry.body,
              dataJson: entry.dataJson,
              source: entry.source,
              license: prov.license,
              attribution: prov.attribution,
              author: prov.author,
              sourceUrl: prov.sourceUrl,
              updatedAt: ts,
            })
            .where(eq(ruleEntries.id, row.id))
            .run();
        }

        for (const entry of toAdd) {
          const prov = effectiveEntryProvenance(entry, meta.license, meta.sourceUrl, meta.name);
          tx.insert(ruleEntries)
            .values({
              packId: packRow.id,
              slug: entry.slug,
              name: entry.name,
              type: entry.type,
              summary: entry.summary,
              body: entry.body,
              dataJson: entry.dataJson,
              source: entry.source,
              license: prov.license,
              attribution: prov.attribution,
              author: prov.author,
              sourceUrl: prov.sourceUrl,
              iconSlug: entry.iconSlug ?? '',
              createdAt: ts,
              updatedAt: ts,
            })
            .run();
        }

        for (const row of toRemove) {
          tx.update(combatants).set({ ruleEntryId: null }).where(eq(combatants.ruleEntryId, row.id)).run();
          tx.delete(ruleEntries).where(eq(ruleEntries.id, row.id)).run();
        }

        const nextEntryCount = existingRows.length + toAdd.length - toRemove.length;
        const [row] = tx
          .update(rulePacks)
          .set({
            name: nextName,
            version: meta.version,
            license: nextLicense,
            sourceUrl: nextSourceUrl,
            kind: nextKind,
            extendsPackSlug: nextExtendsPackSlug,
            entryCount: nextEntryCount,
            manifestHash: sourceHash,
          })
          .where(eq(rulePacks.id, packRow.id))
          .returning()
          .all();

        return {
          pack: row,
          before,
          preview: {
            added: toAdd.length,
            changed: toChange.length,
            removed: toRemove.length,
            unchanged,
            sourceHash,
            sourceVersion: meta.version,
          } satisfies RulePackUpdatePreview,
        };
      });

    try {
      const result = applySync();
      updatedPack = result.pack;
      packBeforeSync = result.before;
      preview = result.preview;
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      // Another writer inserted one of the same (type, slug) rows between our read and our
      // write, so the transaction rolled back and NOTHING was applied. Retry once: the retry
      // re-reads the pack's rows inside its own transaction, sees the racer's row, and
      // classifies it as changed/unchanged instead of an insert — so it converges.
      //
      // The pre-#500 code returned "0 added" here, which was true then because that path only
      // ever added rows. Reporting the same shape now would claim `unchanged: <every entry>`
      // for an update that silently dropped every upstream correction — precisely the
      // "undocumented mixture of old and new" #500 exists to stop. So the retry is what makes
      // the success report honest, and if it still loses we report zero work done (and say so
      // in the audit trail) rather than inventing an "everything was already current" result.
      try {
        const retried = applySync();
        updatedPack = retried.pack;
        packBeforeSync = retried.before;
        preview = retried.preview;
      } catch (retryErr) {
        if (!isUniqueConstraintError(retryErr)) throw retryErr;
        const [freshPack] = await this.db.select().from(rulePacks).where(eq(rulePacks.id, packRow.id)).limit(1);
        updatedPack = freshPack ?? packRow;
        preview = { added: 0, changed: 0, removed: 0, unchanged: 0, sourceHash, sourceVersion: meta.version };
        await this.audit.log({
          actor: auditActor(user),
          actorRole: auditActorRole(user),
          action: 'rulepack.install',
          entityType: 'rule_pack',
          entityId: updatedPack.id,
          detail: `rule pack update for "${packRow.slug}" lost a write race twice and applied NOTHING (pack left on its previous manifest; re-run to apply) — sections=${meta.sectionLabels.join(',')} source=${meta.sourceUrl || 'upload'} version=${meta.version} manifest=${sourceHash.slice(0, 12)}`,
        });
        return {
          ...packToDomain(updatedPack),
          outcome: 'updated',
          added: 0,
          skippedExisting: 0,
          changed: 0,
          removed: 0,
          sourceHash,
          sourceVersion: meta.version,
          preview,
        };
      }
    }

    // A license or source change is exactly the kind of thing an operator must be able to
    // discover after the fact — issue #500 asks for provenance/license changes to be AUDITED,
    // not silently swallowed — so record the before→after explicitly rather than leaving the
    // new value to be inferred from whatever the pack row happens to say now. This diffs the
    // pack row as the COMMITTING attempt found it against the row that attempt actually wrote,
    // both read inside that transaction — so a partial add that deliberately preserved
    // provenance reports no change, and a retry reports what it really changed rather than a
    // diff against a snapshot taken before a racing writer committed.
    const provenanceChanges = [
      ['license', packBeforeSync.license, updatedPack.license],
      ['sourceUrl', packBeforeSync.sourceUrl, updatedPack.sourceUrl],
      ['name', packBeforeSync.name, updatedPack.name],
      ['version', packBeforeSync.version, updatedPack.version],
    ]
      .filter(([, before, after]) => before !== after)
      .map(([field, before, after]) => `${field}:"${before}"->"${after}"`);

    await this.audit.log({
      actor: auditActor(user),
      actorRole: auditActorRole(user),
      action: 'rulepack.install',
      entityType: 'rule_pack',
      entityId: updatedPack.id,
      detail:
        `rule pack update for "${packRow.slug}": +${preview.added} ~${preview.changed} -${preview.removed} unchanged=${preview.unchanged}` +
        ` sections=${meta.sectionLabels.join(',')} source=${meta.sourceUrl || 'upload'} version=${meta.version} manifest=${sourceHash.slice(0, 12)}` +
        (provenanceChanges.length > 0 ? ` provenance-changed[${provenanceChanges.join(' ')}]` : ''),
    });

    return {
      ...packToDomain(updatedPack),
      outcome: 'updated',
      added: preview.added,
      skippedExisting: preview.changed + preview.unchanged,
      changed: preview.changed,
      removed: preview.removed,
      sourceHash,
      sourceVersion: meta.version,
      preview,
    };
  }

  async uninstall(id: number, user: RequestUser): Promise<void> {
    const pack = await this.getPackOrThrow(id);
    // Any combatant referencing one of this pack's entries (added via addCombatant's
    // ruleEntryId path) would otherwise be left with a dangling rule_entry_id once the
    // entries are gone — null it out in the SAME transaction as the entries/pack delete,
    // so there's never a window where the FK-shaped reference points at nothing.
    this.db.transaction((tx) => {
      const liveCampaigns = tx
        .select({ ruleSystem: campaigns.ruleSystem, enabledPackSlugs: campaigns.enabledPackSlugs })
        .from(campaigns)
        .where(isNull(campaigns.deletedAt))
        .all();
      const usageCount = liveCampaigns.filter((campaign) =>
        campaign.ruleSystem === pack.slug || fromJsonText<string[]>(campaign.enabledPackSlugs, []).includes(pack.slug),
      ).length;
      if (usageCount > 0) {
        throw new ConflictException(
          `Rule pack "${pack.name}" is currently selected by ${usageCount} campaign(s) as a primary or enabled content pack. Uninstall is blocked to avoid silently removing their rules content. Disable or replace it in those campaigns first.`,
        );
      }
      const dependents = tx
        .select({ name: rulePacks.name })
        .from(rulePacks)
        .where(and(eq(rulePacks.extendsPackSlug, pack.slug), eq(rulePacks.kind, 'extension')))
        .all();
      if (dependents.length > 0) {
        throw new ConflictException(
          `Rule pack "${pack.name}" is required by installed extension pack(s): ${dependents.map((row) => row.name).join(', ')}`,
        );
      }
      // Trashed campaigns do not use live rules and cannot block the uninstall, but clear
      // their dormant slug before deleting the pack so a later restore cannot retain a
      // dangling reference or silently link to a different reinstalled pack.
      tx
        .update(campaigns)
        .set({ ruleSystem: '' })
        .where(and(eq(campaigns.ruleSystem, pack.slug), isNotNull(campaigns.deletedAt)))
        .run();
      const trashed = tx
        .select({ id: campaigns.id, enabledPackSlugs: campaigns.enabledPackSlugs })
        .from(campaigns)
        .where(isNotNull(campaigns.deletedAt))
        .all();
      for (const campaign of trashed) {
        const next = fromJsonText<string[]>(campaign.enabledPackSlugs, []).filter((slug) => slug !== pack.slug);
        tx.update(campaigns).set({ enabledPackSlugs: JSON.stringify(next) }).where(eq(campaigns.id, campaign.id)).run();
      }
      const entryIds = tx.select({ id: ruleEntries.id }).from(ruleEntries).where(eq(ruleEntries.packId, id)).all().map((row) => row.id);
      for (const entryId of entryIds) {
        tx.update(combatants).set({ ruleEntryId: null }).where(eq(combatants.ruleEntryId, entryId)).run();
      }
      tx.delete(ruleEntries).where(eq(ruleEntries.packId, id)).run();
      tx.delete(rulePacks).where(eq(rulePacks.id, id)).run();
    });
    await this.audit.log({
      actor: auditActor(user),
      actorRole: auditActorRole(user),
      action: 'rulepack.uninstall',
      entityType: 'rule_pack',
      entityId: id,
      detail: pack.slug,
    });
  }

  /**
   * Search entries by free-text query, optionally filtered by type and/or
   * pack slug. Uses SQLite fts5 MATCH when available (see db.module.ts probe);
   * otherwise falls back to a LIKE scan across name/summary/body — slower but
   * correct on SQLite builds without the fts5 extension compiled in.
   *
   * Both paths order results by nameMatchRank() so exact/prefix name matches
   * rank ahead of body-only matches (issue #33), with FTS bm25 rank (or name,
   * in the LIKE fallback) breaking ties within a bucket, and `id` as the final
   * stable tiebreak (issue #613). Empty-query browse orders by lower(name), id.
   *
   * Returns a paginated page (`items` / `total` / `hasMore` / `nextCursor`) —
   * never a silently truncated array. Default page size is 50; pass `cursor`
   * from a previous `nextCursor` to continue. The optional second `limit` arg
   * is kept for MCP / AI-driver callers that want a smaller top-N page.
   */
  /**
   * `packId` narrows only the GLOBAL half of the scope. Campaign homebrew rows live
   * under a dedicated internal pack (homebrewPackId()), never under a real installed
   * pack's id, so ANDing the pack filter across the whole scope (as this used to do)
   * silently dropped every homebrew result whenever a `pack` filter was also given —
   * which the encounter add-combatant picker and MCP lookup_rule always do once a
   * campaign has a rule system configured (issue #1898 review). A homebrew row is
   * admitted by campaign membership alone; `pack` never applies to it.
   */
  private ruleScopeCondition(campaignId?: number, packIds?: number[]) {
    const globalScope = packIds !== undefined
      ? and(isNull(ruleEntries.campaignId), inArray(ruleEntries.packId, packIds))
      : isNull(ruleEntries.campaignId);
    return campaignId !== undefined
      ? or(globalScope, and(eq(ruleEntries.campaignId, campaignId), isNull(ruleEntries.archivedAt)))
      : globalScope;
  }

  async search(
    params: { q: string; type?: RuleEntryType; pack?: string; packs?: string[]; homebrewOnly?: boolean; cursor?: string; limit?: number; campaignId?: number },
    limitArg?: number,
    user?: RequestUser,
  ): Promise<RuleSearchPage> {
    const limit = clampRuleSearchLimit(params.limit ?? limitArg);
    const empty = (total = 0): RuleSearchPage => ({ items: [], total, hasMore: false, limit, facets: [] });

    if (params.campaignId !== undefined) {
      if (!user) throw new ForbiddenException('Campaign access requires user context');
      await this.homebrewRole(params.campaignId, user);
    }

    let requestedSlugs = params.homebrewOnly
      ? []
      : params.packs?.length
        ? [...new Set(params.packs)]
        : params.pack
          ? [params.pack]
          : [];
    // Campaign-aware callers that omit an explicit pack filter get the authoritative
    // primary + enabled content set. This is the path used by MCP/AI lookups.
    if (!params.homebrewOnly && params.campaignId !== undefined && requestedSlugs.length === 0) {
      const [campaign] = await this.db
        .select({ ruleSystem: campaigns.ruleSystem, enabledPackSlugs: campaigns.enabledPackSlugs })
        .from(campaigns)
        .where(eq(campaigns.id, params.campaignId))
        .limit(1);
      requestedSlugs = [...new Set([
        campaign?.ruleSystem ?? '',
        ...fromJsonText<string[]>(campaign?.enabledPackSlugs, []),
      ].filter(Boolean))];
    }
    const packFilter = !params.homebrewOnly && requestedSlugs.length
      ? await this.db.select().from(rulePacks).where(inArray(rulePacks.slug, requestedSlugs))
      : undefined;
    const packRequestedButMissing = params.homebrewOnly ||
      (requestedSlugs.length > 0 && (!packFilter || packFilter.length === 0));
    // Issue #1898 review: `campaign.ruleSystem` is free-text (never validated against
    // installed packs), and the picker always forwards it as `pack` alongside
    // `campaignId`. Short-circuiting to fully empty here — as the no-campaignId path
    // still correctly does — would drop the campaign's own homebrew too, even though
    // homebrew was never scoped to the requested (non-existent) pack in the first
    // place. With campaignId present, fall through with a packId that can never match
    // any real row (rule_packs.id is an AUTOINCREMENT PK starting at 1, so 0 is a safe
    // "no pack" sentinel) — the global half of the scope then correctly returns
    // nothing while the campaign homebrew half is unaffected.
    if (packRequestedButMissing && params.campaignId === undefined) return empty();
    const packIds = packRequestedButMissing ? [0] : packFilter?.map((pack) => pack.id);
    const packSlug = packFilter?.length === 1 ? packFilter[0]?.slug : undefined;

    if (!params.q.trim()) {
      return this.searchBrowse({ type: params.type, packIds, packSlug, cursor: params.cursor, limit, campaignId: params.campaignId });
    }

    if (this.ftsAvailable) {
      const ftsQuery = toFtsQuery(params.q);
      if (!ftsQuery) return empty();
      return this.searchFts({ q: params.q, ftsQuery, type: params.type, packIds, packSlug, cursor: params.cursor, limit, campaignId: params.campaignId });
    }

    return this.searchLike({ q: params.q, type: params.type, packIds, packSlug, cursor: params.cursor, limit, campaignId: params.campaignId });
  }

  /** Empty-query browse: deterministic lower(name), id order with keyset cursor. */
  private async searchBrowse(opts: {
    type?: RuleEntryType;
    packIds?: number[];
    packSlug?: string;
    cursor?: string;
    limit: number;
    campaignId?: number;
  }): Promise<RuleSearchPage> {
    const cursor = decodeRuleSearchCursor(opts.cursor, 'browse') as BrowseCursor | undefined;
    const baseConditions = [
      this.ruleScopeCondition(opts.campaignId, opts.packIds),
      opts.type ? eq(ruleEntries.type, opts.type) : undefined,
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);

    const keyset = cursor
      ? sql`(lower(${ruleEntries.name}) > ${cursor.n} OR (lower(${ruleEntries.name}) = ${cursor.n} AND ${ruleEntries.id} > ${cursor.i}))`
      : undefined;
    const conditions = [...baseConditions, keyset].filter((c): c is NonNullable<typeof c> => c !== undefined);

    // Browse has no query, so the pack scope IS the result scope: one grouped count
    // serves both "which categories exist in this pack" and "how many match".
    const [total, packTypeCounts] = await Promise.all([
      this.countEntries(baseConditions),
      this.groupEntryCounts(this.packScopeConditions(opts.packIds, opts.campaignId)),
    ]);
    const facets = buildRuleFacets(packTypeCounts, packTypeCounts, opts.packSlug);
    const rows = await this.db
      .select({
        entry: ruleEntries,
        sortKey: sql<string>`lower(${ruleEntries.name})`,
      })
      .from(ruleEntries)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(sql`lower(${ruleEntries.name})`, asc(ruleEntries.id))
      .limit(opts.limit + 1);

    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    const items = page.map((r) => entryToDomain(r.entry));
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeRuleSearchCursor({
            v: 1,
            m: 'browse',
            n: last.sortKey,
            i: last.entry.id,
          })
        : undefined;
    return { items, total, hasMore, nextCursor, limit: opts.limit, facets };
  }

  private async searchFts(opts: {
    q: string;
    ftsQuery: string;
    type?: RuleEntryType;
    packIds?: number[];
    packSlug?: string;
    cursor?: string;
    limit: number;
    campaignId?: number;
  }): Promise<RuleSearchPage> {
    const cursor = decodeRuleSearchCursor(opts.cursor, 'fts') as FtsCursor | undefined;
    const rankExpr = nameMatchRank(opts.q);
    const baseConditions = [
      this.ruleScopeCondition(opts.campaignId, opts.packIds),
      sql`rule_entries_fts MATCH ${opts.ftsQuery}`,
      opts.type ? eq(ruleEntries.type, opts.type) : undefined,
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);

    const keyset = cursor
      ? sql`(
          ${rankExpr} > ${cursor.b}
          OR (${rankExpr} = ${cursor.b} AND rule_entries_fts.rank > ${cursor.r})
          OR (${rankExpr} = ${cursor.b} AND rule_entries_fts.rank = ${cursor.r} AND ${ruleEntries.id} > ${cursor.i})
        )`
      : undefined;
    const conditions = [...baseConditions, keyset].filter((c): c is NonNullable<typeof c> => c !== undefined);

    const matchConditions = [
      this.ruleScopeCondition(opts.campaignId, opts.packIds),
      sql`rule_entries_fts MATCH ${opts.ftsQuery}`,
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);
    const [total, packTypeCounts, matchTypeCounts] = await Promise.all([
      this.countFts(baseConditions),
      this.groupEntryCounts(this.packScopeConditions(opts.packIds, opts.campaignId)),
      this.groupFtsCounts(matchConditions),
    ]);
    const facets = buildRuleFacets(packTypeCounts, matchTypeCounts, opts.packSlug);
    const rows = await this.db
      .select({
        entry: ruleEntries,
        ftsRank: sql<number>`rule_entries_fts.rank`,
        bucket: rankExpr,
      })
      .from(ruleEntries)
      .innerJoin(sql`rule_entries_fts`, sql`rule_entries_fts.rowid = ${ruleEntries.id}`)
      .where(and(...conditions))
      .orderBy(rankExpr, sql`rule_entries_fts.rank`, asc(ruleEntries.id))
      .limit(opts.limit + 1);

    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    const items = page.map((r) => entryToDomain(r.entry));
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeRuleSearchCursor({
            v: 1,
            m: 'fts',
            b: Number(last.bucket),
            r: Number(last.ftsRank),
            i: last.entry.id,
          })
        : undefined;
    return { items, total, hasMore, nextCursor, limit: opts.limit, facets };
  }

  private async searchLike(opts: {
    q: string;
    type?: RuleEntryType;
    packIds?: number[];
    packSlug?: string;
    cursor?: string;
    limit: number;
    campaignId?: number;
  }): Promise<RuleSearchPage> {
    const cursor = decodeRuleSearchCursor(opts.cursor, 'like') as LikeCursor | undefined;
    const rankExpr = nameMatchRank(opts.q);
    const needle = foldForSearch(opts.q.trim().replace(/[%_]/g, ''));
    const rawLike = `%${opts.q.replace(/[%_]/g, '')}%`;
    const foldedLike = needle ? `%${needle}%` : undefined;
    const foldedName = foldSqlCol(ruleEntries.name);
    const foldedSummary = foldSqlCol(ruleEntries.summary);
    const foldedBody = foldSqlCol(ruleEntries.body);
    const likeClause = foldedLike
      ? sql`(${ruleEntries.name} LIKE ${rawLike} OR ${foldedName} LIKE ${foldedLike} OR ${ruleEntries.summary} LIKE ${rawLike} OR ${foldedSummary} LIKE ${foldedLike} OR ${ruleEntries.body} LIKE ${rawLike} OR ${foldedBody} LIKE ${foldedLike})`
      : sql`(${ruleEntries.name} LIKE ${rawLike} OR ${ruleEntries.summary} LIKE ${rawLike} OR ${ruleEntries.body} LIKE ${rawLike})`;
    const baseConditions = [
      this.ruleScopeCondition(opts.campaignId, opts.packIds),
      likeClause,
      opts.type ? eq(ruleEntries.type, opts.type) : undefined,
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);

    const keyset = cursor
      ? sql`(
          ${rankExpr} > ${cursor.b}
          OR (${rankExpr} = ${cursor.b} AND ${ruleEntries.name} > ${cursor.n})
          OR (${rankExpr} = ${cursor.b} AND ${ruleEntries.name} = ${cursor.n} AND ${ruleEntries.id} > ${cursor.i})
        )`
      : undefined;
    const conditions = [...baseConditions, keyset].filter((c): c is NonNullable<typeof c> => c !== undefined);

    const matchConditions = [
      this.ruleScopeCondition(opts.campaignId, opts.packIds),
      likeClause,
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);
    const [total, packTypeCounts, matchTypeCounts] = await Promise.all([
      this.countEntries(baseConditions),
      this.groupEntryCounts(this.packScopeConditions(opts.packIds, opts.campaignId)),
      this.groupEntryCounts(matchConditions),
    ]);
    const facets = buildRuleFacets(packTypeCounts, matchTypeCounts, opts.packSlug);
    const rows = await this.db
      .select({
        entry: ruleEntries,
        bucket: rankExpr,
      })
      .from(ruleEntries)
      .where(and(...conditions))
      .orderBy(rankExpr, asc(ruleEntries.name), asc(ruleEntries.id))
      .limit(opts.limit + 1);

    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    const items = page.map((r) => entryToDomain(r.entry));
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeRuleSearchCursor({
            v: 1,
            m: 'like',
            b: Number(last.bucket),
            n: last.entry.name,
            i: last.entry.id,
          })
        : undefined;
    return { items, total, hasMore, nextCursor, limit: opts.limit, facets };
  }

  private async countEntries(conditions: Array<ReturnType<typeof sql> | ReturnType<typeof eq> | ReturnType<typeof isNull> | ReturnType<typeof or>>): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)` })
      .from(ruleEntries)
      .where(conditions.length ? and(...conditions) : undefined);
    return Number(row?.n ?? 0);
  }

  /**
   * Conditions that scope a query to the active pack only (no query/type filter).
   * The pack filter is folded into ruleScopeCondition so it narrows only the global
   * half of the scope — campaign homebrew (a different internal pack) still counts
   * toward these facet/total figures alongside the requested pack (issue #1898 review).
   */
  private packScopeConditions(packIds?: number[], campaignId?: number): Array<ReturnType<typeof sql> | ReturnType<typeof eq> | ReturnType<typeof isNull> | ReturnType<typeof or> | ReturnType<typeof inArray>> {
    return [this.ruleScopeCondition(campaignId, packIds)];
  }

  private async groupEntryCounts(
    conditions: Array<ReturnType<typeof sql> | ReturnType<typeof eq> | ReturnType<typeof isNull> | ReturnType<typeof or>>,
  ): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ type: ruleEntries.type, count: sql<number>`count(*)` })
      .from(ruleEntries)
      .where(conditions.length ? and(...conditions) : undefined)
      .groupBy(ruleEntries.type);
    return new Map(rows.map((r) => [r.type, Number(r.count)]));
  }

  private async countFts(conditions: Array<ReturnType<typeof sql> | ReturnType<typeof eq>>): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)` })
      .from(ruleEntries)
      .innerJoin(sql`rule_entries_fts`, sql`rule_entries_fts.rowid = ${ruleEntries.id}`)
      .where(and(...conditions));
    return Number(row?.n ?? 0);
  }

  private async groupFtsCounts(
    conditions: Array<ReturnType<typeof sql> | ReturnType<typeof eq>>,
  ): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ type: ruleEntries.type, count: sql<number>`count(*)` })
      .from(ruleEntries)
      .innerJoin(sql`rule_entries_fts`, sql`rule_entries_fts.rowid = ${ruleEntries.id}`)
      .where(and(...conditions))
      .groupBy(ruleEntries.type);
    return new Map(rows.map((r) => [r.type, Number(r.count)]));
  }
}
