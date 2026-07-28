import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type {
  CampaignImportPreflight,
  CompendiumDependency,
  CompendiumInstallHint,
  CompendiumRef,
  CompendiumRefReport,
  CompendiumSnapshot,
  OnUnresolvedCompendium,
  RuleEntryType,
} from '@campfire/schema';
import type { DrizzleDb } from '../../db/db.module';
import { ruleEntries, rulePacks } from '../../db/schema';
import { stableStringify } from '../proposals/proposal-snapshot';

// Portable compendium hashing intentionally needs only these fields. Keeping this
// structural also permits fixtures/exports created before campaign-homebrew columns.
type RuleEntryRow = Pick<typeof ruleEntries.$inferSelect, 'id' | 'slug' | 'type' | 'name' | 'summary' | 'body' | 'dataJson' | 'source' | 'license' | 'attribution' | 'author' | 'sourceUrl'>;
type RulePackRow = typeof rulePacks.$inferSelect;

/** Portable fields hashed for cross-install identity — excludes server-local ids and DM icon overrides. */
export type RuleEntryContentPayload = {
  slug: string;
  type: string;
  name: string;
  summary: string;
  body: string;
  dataJson: unknown;
};

export function ruleEntryContentPayload(row: RuleEntryRow): RuleEntryContentPayload {
  let dataJson: unknown = null;
  if (row.dataJson) {
    try {
      dataJson = JSON.parse(row.dataJson);
    } catch {
      dataJson = row.dataJson;
    }
  }
  return {
    slug: row.slug,
    type: row.type,
    name: row.name,
    summary: row.summary,
    body: row.body,
    dataJson,
  };
}

export function computeRuleEntryContentHash(row: RuleEntryRow): string {
  return createHash('sha256').update(stableStringify(ruleEntryContentPayload(row))).digest('hex');
}

export function buildCompendiumRef(entry: RuleEntryRow, pack: RulePackRow): CompendiumRef {
  return {
    packSlug: pack.slug,
    packVersion: pack.version,
    entrySlug: entry.slug,
    entryType: entry.type as RuleEntryType,
    contentHash: computeRuleEntryContentHash(entry),
  };
}

export function buildCompendiumSnapshot(entry: RuleEntryRow): CompendiumSnapshot {
  return {
    slug: entry.slug,
    name: entry.name,
    type: entry.type as RuleEntryType,
    summary: entry.summary,
    body: entry.body,
    dataJson: entry.dataJson,
    source: entry.source ?? '',
    license: entry.license ?? '',
    attribution: entry.attribution ?? '',
    author: entry.author ?? '',
    sourceUrl: entry.sourceUrl ?? '',
  };
}

/** Map well-known pack slugs to install `source` hints for guided dependency installation. */
const PACK_INSTALL_SOURCE_HINTS: Record<string, string> = {
  'open5e-srd': 'open5e',
  'pf2e-srd': 'pf2e',
  'sf2e-srd': 'sf2e',
  'pf1e-srd': 'pf1e',
  'starfinder-1e': 'starfinder',
  'archmage-srd': 'archmage',
  'open-legend': 'open-legend',
  'basic-fantasy': 'osr',
  'cepheus-srd': 'cepheus',
  'ironsworn-starforged': 'datasworn',
};

export function compendiumRefKey(ref: Pick<CompendiumRef, 'packSlug' | 'entryType' | 'entrySlug'>): string {
  return `${ref.packSlug}/${ref.entryType}/${ref.entrySlug}`;
}

export function parseCompendiumRef(raw: unknown): CompendiumRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const packSlug = typeof o.packSlug === 'string' ? o.packSlug : '';
  const entrySlug = typeof o.entrySlug === 'string' ? o.entrySlug : '';
  const entryType = typeof o.entryType === 'string' ? o.entryType : '';
  const contentHash = typeof o.contentHash === 'string' ? o.contentHash : '';
  if (!packSlug || !entrySlug || !entryType || contentHash.length !== 64) return null;
  return {
    packSlug,
    packVersion: typeof o.packVersion === 'string' ? o.packVersion : '',
    entrySlug,
    entryType: entryType as RuleEntryType,
    contentHash,
  };
}

export type ImportCombatantCompendium = {
  encounterIndex: number;
  combatantIndex: number;
  combatantName: string;
  compendiumRef: CompendiumRef | null;
  legacyRuleEntryId: number | null;
  hasSnapshot: boolean;
};

export function collectImportCombatantCompendium(encounterRows: Record<string, unknown>[]): ImportCombatantCompendium[] {
  const out: ImportCombatantCompendium[] = [];
  for (let ei = 0; ei < encounterRows.length; ei++) {
    const rawCombatants = encounterRows[ei].combatants;
    const combatantRows = Array.isArray(rawCombatants) ? rawCombatants : [];
    for (let ci = 0; ci < combatantRows.length; ci++) {
      const c = combatantRows[ci];
      if (!c || typeof c !== 'object') continue;
      const row = c as Record<string, unknown>;
      const legacyRuleEntryId =
        typeof row.ruleEntryId === 'number' && Number.isFinite(row.ruleEntryId) ? Math.trunc(row.ruleEntryId) : null;
      const compendiumRef = parseCompendiumRef(row.compendiumRef);
      if (legacyRuleEntryId == null && compendiumRef == null) continue;
      out.push({
        encounterIndex: ei,
        combatantIndex: ci,
        combatantName: typeof row.name === 'string' ? row.name : 'Combatant',
        compendiumRef,
        legacyRuleEntryId,
        hasSnapshot: row.compendiumSnapshot != null && typeof row.compendiumSnapshot === 'object',
      });
    }
  }
  return out;
}

function installHintFromDependency(dep: CompendiumDependency): CompendiumInstallHint {
  return {
    packSlug: dep.packSlug,
    packName: dep.name,
    license: dep.license,
    sourceUrl: dep.sourceUrl,
    suggestedSource: PACK_INSTALL_SOURCE_HINTS[dep.packSlug],
  };
}

function installHintFromPack(pack: RulePackRow): CompendiumInstallHint {
  return {
    packSlug: pack.slug,
    packName: pack.name,
    license: pack.license,
    sourceUrl: pack.sourceUrl,
    suggestedSource: PACK_INSTALL_SOURCE_HINTS[pack.slug],
  };
}

export function buildDependencyManifest(refs: CompendiumRef[], packBySlug: Map<string, RulePackRow>): CompendiumDependency[] {
  const byPack = new Map<string, { pack: RulePackRow | CompendiumDependency; slugs: Set<string> }>();
  for (const ref of refs) {
    let bucket = byPack.get(ref.packSlug);
    if (!bucket) {
      const pack = packBySlug.get(ref.packSlug);
      bucket = {
        pack: pack ?? {
          packSlug: ref.packSlug,
          packVersion: ref.packVersion,
          name: ref.packSlug,
          license: '',
          sourceUrl: '',
          entrySlugs: [],
        },
        slugs: new Set(),
      };
      byPack.set(ref.packSlug, bucket);
    }
    bucket.slugs.add(ref.entrySlug);
  }
  return [...byPack.values()].map(({ pack, slugs }) => {
    if ('id' in pack) {
      return {
        packSlug: pack.slug,
        packVersion: pack.version,
        name: pack.name,
        license: pack.license,
        sourceUrl: pack.sourceUrl,
        entrySlugs: [...slugs].sort(),
      };
    }
    return { ...pack, entrySlugs: [...slugs].sort() };
  });
}

export type CompendiumResolutionMap = Map<string, number | null>;

export async function preflightCompendiumImport(
  db: DrizzleDb,
  encounterRows: Record<string, unknown>[],
  exportDependencies: CompendiumDependency[] = [],
): Promise<CampaignImportPreflight> {
  const combatants = collectImportCombatantCompendium(encounterRows);
  const refs = combatants.map((c) => c.compendiumRef).filter((r): r is CompendiumRef => r != null);
  const packSlugs = [...new Set(refs.map((r) => r.packSlug))];
  const packRows = packSlugs.length
    ? await db.select().from(rulePacks).where(inArray(rulePacks.slug, packSlugs))
    : [];
  const packBySlug = new Map(packRows.map((p) => [p.slug, p]));
  const depBySlug = new Map(exportDependencies.map((d) => [d.packSlug, d]));

  const entrySlugsByPack = new Map<string, Set<string>>();
  for (const ref of refs) {
    let slugs = entrySlugsByPack.get(ref.packSlug);
    if (!slugs) {
      slugs = new Set();
      entrySlugsByPack.set(ref.packSlug, slugs);
    }
    slugs.add(ref.entrySlug);
  }

  const entryRowsByPack = new Map<number, RuleEntryRow[]>();
  for (const pack of packRows) {
    const neededSlugs = entrySlugsByPack.get(pack.slug);
    if (!neededSlugs || neededSlugs.size === 0) continue;
    const rows = await db
      .select()
      .from(ruleEntries)
      .where(and(eq(ruleEntries.packId, pack.id), inArray(ruleEntries.slug, [...neededSlugs])));
    entryRowsByPack.set(pack.id, rows);
  }

  const references: CompendiumRefReport[] = [];
  for (const item of combatants) {
    if (item.compendiumRef == null && item.legacyRuleEntryId != null) {
      references.push({
        compendiumRef: null,
        legacyRuleEntryId: item.legacyRuleEntryId,
        combatantName: item.combatantName,
        status: 'legacy_numeric_id',
        resolvedEntryId: null,
      });
      continue;
    }
    const ref = item.compendiumRef;
    if (!ref) continue;

    const pack = packBySlug.get(ref.packSlug);
    if (!pack) {
      const dep = depBySlug.get(ref.packSlug);
      references.push({
        compendiumRef: ref,
        combatantName: item.combatantName,
        status: 'missing_pack',
        resolvedEntryId: null,
        expectedContentHash: ref.contentHash,
        installHint: dep ? installHintFromDependency(dep) : {
          packSlug: ref.packSlug,
          packName: ref.packSlug,
          license: '',
          sourceUrl: '',
          suggestedSource: PACK_INSTALL_SOURCE_HINTS[ref.packSlug],
        },
      });
      continue;
    }

    const entries = entryRowsByPack.get(pack.id) ?? [];
    const entry = entries.find((e) => e.slug === ref.entrySlug && e.type === ref.entryType);
    if (!entry) {
      const wrongTypeEntry = entries.find((e) => e.slug === ref.entrySlug);
      if (wrongTypeEntry) {
        references.push({
          compendiumRef: ref,
          combatantName: item.combatantName,
          status: 'type_mismatch',
          resolvedEntryId: null,
          expectedContentHash: ref.contentHash,
          actualContentHash: computeRuleEntryContentHash(wrongTypeEntry),
          installHint: installHintFromPack(pack),
        });
      } else {
        references.push({
          compendiumRef: ref,
          combatantName: item.combatantName,
          status: 'missing_entry',
          resolvedEntryId: null,
          expectedContentHash: ref.contentHash,
          installHint: installHintFromPack(pack),
        });
      }
      continue;
    }

    const actualHash = computeRuleEntryContentHash(entry);
    if (actualHash !== ref.contentHash) {
      references.push({
        compendiumRef: ref,
        combatantName: item.combatantName,
        status: 'hash_mismatch',
        resolvedEntryId: null,
        expectedContentHash: ref.contentHash,
        actualContentHash: actualHash,
        installHint: installHintFromPack(pack),
      });
      continue;
    }

    references.push({
      compendiumRef: ref,
      combatantName: item.combatantName,
      status: 'resolved',
      resolvedEntryId: entry.id,
    });
  }

  const unresolvedCount = references.filter((r) => r.status !== 'resolved').length;
  const canImport = unresolvedCount === 0;
  const snapshotKeys = new Set(
    combatants.filter((c) => c.hasSnapshot && c.compendiumRef).map((c) => compendiumRefKey(c.compendiumRef!)),
  );
  const canImportDetached = references.every((r) => {
    if (r.status === 'resolved') return true;
    if (!r.compendiumRef) return false;
    return snapshotKeys.has(compendiumRefKey(r.compendiumRef));
  });

  const manifestRefs = refs.length ? refs : [];
  const compendiumDependencies =
    exportDependencies.length > 0
      ? exportDependencies
      : buildDependencyManifest(manifestRefs, packBySlug);

  return {
    compendiumDependencies,
    references,
    canImport,
    canImportDetached,
    unresolvedCount,
  };
}

export function resolveImportedCombatantRuleEntryId(
  combatant: Record<string, unknown>,
  resolutionMap: CompendiumResolutionMap,
): { ruleEntryId: number | null; detached: boolean; ignoredLegacyId: boolean } {
  const legacyId =
    typeof combatant.ruleEntryId === 'number' && Number.isFinite(combatant.ruleEntryId)
      ? Math.trunc(combatant.ruleEntryId)
      : null;
  const ref = parseCompendiumRef(combatant.compendiumRef);
  if (ref) {
    const resolved = resolutionMap.get(compendiumRefKey(ref));
    if (resolved != null) return { ruleEntryId: resolved, detached: false, ignoredLegacyId: legacyId != null };
    return { ruleEntryId: null, detached: true, ignoredLegacyId: legacyId != null };
  }
  if (legacyId != null) {
    return { ruleEntryId: null, detached: false, ignoredLegacyId: true };
  }
  return { ruleEntryId: null, detached: false, ignoredLegacyId: false };
}

export function buildResolutionMap(
  preflight: CampaignImportPreflight,
  mode: OnUnresolvedCompendium,
): CompendiumResolutionMap {
  const map: CompendiumResolutionMap = new Map();
  for (const report of preflight.references) {
    if (!report.compendiumRef) continue;
    const key = compendiumRefKey(report.compendiumRef);
    if (report.status === 'resolved' && report.resolvedEntryId != null) {
      map.set(key, report.resolvedEntryId);
    } else if (mode === 'detach') {
      map.set(key, null);
    }
  }
  return map;
}

export function assertCompendiumImportAllowed(
  preflight: CampaignImportPreflight,
  mode: OnUnresolvedCompendium,
): void {
  if (mode === 'detach') {
    if (!preflight.canImportDetached) {
      throw new BadRequestException({
        message: 'Cannot import with detached compendium snapshots — one or more combatants lack a compendiumSnapshot.',
        preflight,
      });
    }
    return;
  }
  if (!preflight.canImport) {
    throw new BadRequestException({
      message:
        'Campaign import blocked: compendium references could not be resolved on this server. Install the missing rule packs or re-export with compendium snapshots, then retry. POST /campaigns/import/preflight returns the full dependency report.',
      preflight,
    });
  }
}

/** Load rule entries + packs for export-time compendium ref embedding (issue #584). */
export async function loadCompendiumExportContext(
  db: DrizzleDb,
  ruleEntryIds: number[],
): Promise<{
  refByEntryId: Map<number, CompendiumRef>;
  snapshotByEntryId: Map<number, CompendiumSnapshot>;
  dependencies: CompendiumDependency[];
}> {
  const refByEntryId = new Map<number, CompendiumRef>();
  const snapshotByEntryId = new Map<number, CompendiumSnapshot>();
  if (ruleEntryIds.length === 0) {
    return { refByEntryId, snapshotByEntryId, dependencies: [] };
  }

  const rows = await db
    .select({ entry: ruleEntries, pack: rulePacks })
    .from(ruleEntries)
    .innerJoin(rulePacks, eq(ruleEntries.packId, rulePacks.id))
    .where(inArray(ruleEntries.id, ruleEntryIds));

  const refs: CompendiumRef[] = [];
  const packBySlug = new Map<string, RulePackRow>();
  for (const { entry, pack } of rows) {
    const ref = buildCompendiumRef(entry, pack);
    refByEntryId.set(entry.id, ref);
    snapshotByEntryId.set(entry.id, buildCompendiumSnapshot(entry));
    refs.push(ref);
    packBySlug.set(pack.slug, pack);
  }

  return {
    refByEntryId,
    snapshotByEntryId,
    dependencies: buildDependencyManifest(refs, packBySlug),
  };
}
