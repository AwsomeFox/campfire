import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  PF2E_PACK_SLUG,
  isOpenLicense,
  type RuleEntry,
  type RuleEntryType,
  type RulePack,
  type RulePackInstall,
  type RulePackInstallJob,
  type RulePackUpload,
} from '@campfire/schema';
import { DB, RULE_ENTRIES_FTS_AVAILABLE, type DrizzleDb } from '../../db/db.module';
import { rulePacks, ruleEntries, combatants, campaigns } from '../../db/schema';
import { nowIso } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import {
  ALL_OPEN5E_SECTIONS,
  MAX_ENTRIES_PER_SECTION,
  OPEN5E_DEFAULT_BASE_URL,
  fetchOpen5eSection,
  type ImportedEntry,
  type Open5eSection,
} from './open5e-importer';
import {
  ALL_PF2E_SECTIONS,
  MAX_ENTRIES_PER_SECTION as PF2E_MAX_ENTRIES_PER_SECTION,
  PF2E_DEFAULT_BASE_URL,
  PF2E_DEFAULT_LICENSE,
  PF2E_PACK_NAME,
  fetchPf2eSection,
  type Pf2eSection,
} from './pf2e-importer';

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
    installedAt: row.installedAt,
    entryCount: row.entryCount,
  };
}

function entryToDomain(row: typeof ruleEntries.$inferSelect): RuleEntry {
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

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
function nameMatchRank(q: string) {
  // Strip LIKE wildcards so user input can't skew the bucketing (mirrors the
  // sanitisation in the LIKE fallback below); lower() both sides for
  // case-insensitive comparison independent of the column's collation.
  const needle = q.trim().replace(/[%_]/g, '').toLowerCase();
  return sql`CASE
    WHEN lower(${ruleEntries.name}) = ${needle} THEN 0
    WHEN lower(${ruleEntries.name}) LIKE ${`${needle}%`} THEN 1
    WHEN lower(${ruleEntries.name}) LIKE ${`%${needle}%`} THEN 2
    ELSE 3
  END`;
}

/** Escapes an FTS5 MATCH query string by quoting it as a single phrase, then appending a prefix wildcard per token. */
function toFtsQuery(q: string): string {
  const tokens = q
    .split(/\s+/)
    .map((t) => t.replace(/["]/g, ''))
    .filter(Boolean);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"*`).join(' ');
}

@Injectable()
export class RulesService {
  /**
   * In-memory registry of background install jobs (issue #20). Campfire is a
   * single-node SQLite app, so an in-process map is sufficient — job state is
   * ephemeral progress, not durable data, and a restart simply drops in-flight
   * jobs (their DB writes are transactional and already committed by section).
   * Completed/failed jobs are pruned lazily once past PRUNE_AFTER_MS so the map
   * can't grow without bound over a long-lived server.
   */
  private readonly jobs = new Map<string, RulePackInstallJob>();
  private static readonly PRUNE_AFTER_MS = 60 * 60 * 1000; // 1h

  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    @Inject(RULE_ENTRIES_FTS_AVAILABLE) private readonly ftsAvailable: boolean,
    private readonly audit: AuditService,
  ) {}

  // ---------- background install jobs (issue #20) ----------

  getJobOrThrow(id: string): RulePackInstallJob {
    const job = this.jobs.get(id);
    if (!job) throw new NotFoundException(`Install job ${id} not found`);
    return { ...job, progress: job.progress.map((p) => ({ ...p })) };
  }

  private newJob(source: 'open5e' | 'pf2e' | 'upload', sections: string[]): RulePackInstallJob {
    this.pruneOldJobs();
    const ts = nowIso();
    const job: RulePackInstallJob = {
      id: randomUUID(),
      source,
      status: 'pending',
      progress: sections.map((s) => ({ section: s, status: 'pending', imported: 0 })),
      totalSections: sections.length,
      completedSections: 0,
      outcome: null,
      pack: null,
      added: null,
      skippedExisting: null,
      error: null,
      createdAt: ts,
      updatedAt: ts,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  private markSectionDone(jobId: string, section: string, imported: number): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const row = job.progress.find((p) => p.section === section);
    if (row) {
      row.status = 'done';
      row.imported = imported;
    }
    job.completedSections = job.progress.filter((p) => p.status === 'done').length;
    job.updatedAt = nowIso();
  }

  /**
   * Runs one enqueued install in the background. `work` performs the actual
   * fetch+persist (installFromOpen5e / installFromUpload) and returns the
   * resulting pack, incremental installs additionally carrying added/skipped.
   * All progress is reflected on the job so the UI can poll it — the request
   * that enqueued the job has already returned 202 by the time this runs.
   */
  private async runJob(
    jobId: string,
    work: () => Promise<RulePack & { added?: number; skippedExisting?: number }>,
  ): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = 'running';
    job.progress.forEach((p) => {
      if (p.status === 'pending') p.status = 'running';
    });
    job.updatedAt = nowIso();

    try {
      const result = await work();
      const isIncremental = 'added' in result;
      const { added, skippedExisting, ...pack } = result as RulePack & { added?: number; skippedExisting?: number };
      const current = this.jobs.get(jobId);
      if (!current) return;
      current.status = 'completed';
      current.outcome = isIncremental ? 'updated' : 'created';
      current.pack = pack;
      current.added = added ?? null;
      current.skippedExisting = skippedExisting ?? null;
      current.progress.forEach((p) => {
        if (p.status !== 'done') p.status = 'done';
      });
      current.completedSections = current.progress.length;
      current.updatedAt = nowIso();
    } catch (err) {
      const current = this.jobs.get(jobId);
      if (!current) return;
      current.status = 'failed';
      current.error = err instanceof Error ? err.message : String(err);
      current.progress.forEach((p) => {
        if (p.status !== 'done') p.status = 'failed';
      });
      current.updatedAt = nowIso();
    }
  }

  private pruneOldJobs(): void {
    const cutoff = Date.now() - RulesService.PRUNE_AFTER_MS;
    for (const [id, job] of this.jobs) {
      if ((job.status === 'completed' || job.status === 'failed') && new Date(job.updatedAt).getTime() < cutoff) {
        this.jobs.delete(id);
      }
    }
  }

  /**
   * Enqueue an Open5e install as a background job (issue #20). Returns immediately
   * with a 'pending' job snapshot; the heavy paginated fetch + insert runs in
   * runJob(), updating per-section progress the caller can poll.
   */
  enqueueOpen5eInstall(input: RulePackInstall, user: RequestUser): RulePackInstallJob {
    const sections: Open5eSection[] = input.sections?.length ? (input.sections as Open5eSection[]) : ALL_OPEN5E_SECTIONS;
    const job = this.newJob('open5e', sections);
    // Defer to a microtask so this method returns the 'pending' snapshot before any
    // work (or DB writes) begin — the POST is truly non-blocking (issue #20).
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
    // The shared RulePackInstall.sections enum is Open5e-shaped (spells/monsters/…); PF2e
    // has its own section vocabulary (creatures/equipment/ancestries/…), so a PF2e install
    // always imports all PF2e sections rather than honouring the 5e-named filter.
    const job = this.newJob('pf2e', ALL_PF2E_SECTIONS);
    queueMicrotask(() =>
      void this.runJob(job.id, () =>
        this.installFromPf2e(input, user, (section, imported) => this.markSectionDone(job.id, section, imported)),
      ),
    );
    return this.getJobOrThrow(job.id);
  }

  /**
   * Enqueue a generic uploaded-dataset install as a background job (issues #19 + #20).
   * License open-ness is validated synchronously here so a bad-license upload gets a
   * clean 400 at the POST rather than a failed job the caller must poll to discover.
   */
  enqueueUploadInstall(input: RulePackUpload, user: RequestUser): RulePackInstallJob {
    this.assertOpenLicense(input.pack.license);
    const types = [...new Set(input.entries.map((e) => e.type))];
    const job = this.newJob('upload', types);
    queueMicrotask(() =>
      void this.runJob(job.id, () =>
        this.installFromUpload(input, user, (section, imported) => this.markSectionDone(job.id, section, imported)),
      ),
    );
    return this.getJobOrThrow(job.id);
  }

  private assertOpenLicense(license: string): void {
    if (!isOpenLicense(license)) {
      throw new BadRequestException(
        `License "${license}" is not a recognized open license. Uploaded rule packs must be OGL, ORC, Creative Commons, or public domain — copyrighted or purchased content cannot be uploaded.`,
      );
    }
  }

  async listPacks(): Promise<RulePack[]> {
    const rows = await this.db.select().from(rulePacks);
    return rows.map(packToDomain);
  }

  async getPackOrThrow(id: number) {
    const [row] = await this.db.select().from(rulePacks).where(eq(rulePacks.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Rule pack ${id} not found`);
    return row;
  }

  async getEntryOrThrow(id: number): Promise<RuleEntry> {
    const [row] = await this.db.select().from(ruleEntries).where(eq(ruleEntries.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Rule entry ${id} not found`);
    return entryToDomain(row);
  }

  /**
   * Installs a rule pack from Open5e, or — if "open5e-srd" is already installed —
   * incrementally adds whatever entries from the requested sections aren't present yet
   * (round-2 finding #2). Dedupe key is (slug, type): an entry already in the pack with
   * the same slug+type is skipped rather than duplicated or overwritten.
   *
   * Fresh install: 201, returns the RulePack as before.
   * Incremental install (pack already exists): 200, returns
   * `RulePack & { added: number; skippedExisting: number }`. We deliberately never 409
   * here even if every requested entry already existed (added:0, skippedExisting:N) —
   * simpler UX than forcing the caller to pre-check section coverage, and idempotent:
   * calling install repeatedly with the same sections converges to a 200 no-op rather
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
  ): Promise<RulePack & { added?: number; skippedExisting?: number }> {
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

    const licenses = new Set(allEntries.map((e) => e.license).filter(Boolean));
    const license = licenses.size > 0 ? [...licenses].join(', ') : 'OGL/CC';

    return this.persistPack(
      { slug, name: 'Open5e SRD', version: nowIso().slice(0, 10), license, sourceUrl: baseUrl, sectionLabels: sections },
      allEntries,
      user,
      `(cap ${MAX_ENTRIES_PER_SECTION}/section, ${totalSkipped} skipped)`,
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
  ): Promise<RulePack & { added?: number; skippedExisting?: number }> {
    const baseUrl = input.url ?? PF2E_DEFAULT_BASE_URL;
    const sections: Pf2eSection[] = ALL_PF2E_SECTIONS;

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

    const licenses = new Set(allEntries.map((e) => e.license).filter(Boolean));
    const license = licenses.size > 0 ? [...licenses].join(', ') : PF2E_DEFAULT_LICENSE;

    return this.persistPack(
      { slug: PF2E_PACK_SLUG, name: PF2E_PACK_NAME, version: nowIso().slice(0, 10), license, sourceUrl: baseUrl, sectionLabels: sections },
      allEntries,
      user,
      `(cap ${PF2E_MAX_ENTRIES_PER_SECTION}/section, ${totalSkipped} skipped)`,
    );
  }

  /**
   * Installs a generic uploaded rule pack (issue #19): an open-licensed JSON dataset
   * for any system (Pathfinder 2e ORC, other OGL/CC content, homebrew), not just
   * Open5e. Reuses the same persistence path as the Open5e importer, so multi-pack
   * coexistence, incremental adds, and the concurrent-install race guard all apply
   * identically. License open-ness is (re)validated here as defense-in-depth; the
   * enqueue path already rejected a non-open license with a 400.
   */
  async installFromUpload(
    input: RulePackUpload,
    user: RequestUser,
    onSectionDone?: (section: string, imported: number) => void,
  ): Promise<RulePack & { added?: number; skippedExisting?: number }> {
    this.assertOpenLicense(input.pack.license);

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
      },
      entries,
      user,
      `upload (${entries.length} entries)`,
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
    meta: { slug: string; name: string; version: string; license: string; sourceUrl: string; sectionLabels: string[] },
    entries: ImportedEntry[],
    user: RequestUser,
    detailSuffix: string,
  ): Promise<RulePack & { added?: number; skippedExisting?: number }> {
    const [existing] = await this.db.select().from(rulePacks).where(eq(rulePacks.slug, meta.slug)).limit(1);
    if (existing) {
      return this.addEntriesToExistingPack(existing, entries, meta.sectionLabels, user);
    }

    const ts = nowIso();
    let pack: typeof rulePacks.$inferSelect;
    try {
      pack = this.db.transaction((tx) => {
        const [packRow] = tx
          .insert(rulePacks)
          .values({
            slug: meta.slug,
            name: meta.name,
            version: meta.version,
            license: meta.license,
            sourceUrl: meta.sourceUrl,
            installedAt: ts,
            entryCount: entries.length,
          })
          .returning()
          .all();

        for (const entry of entries) {
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
      return this.addEntriesToExistingPack(raced, entries, meta.sectionLabels, user);
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'dm',
      action: 'rulepack.install',
      entityType: 'rule_pack',
      entityId: pack.id,
      detail: `${entries.length} entries from ${meta.sectionLabels.join(',')} ${detailSuffix}`,
    });

    return packToDomain(pack);
  }

  /**
   * Adds whichever of `fetchedEntries` aren't already present (by slug+type) in
   * `packRow`'s entries, bumping entryCount/version. Wrapped in a transaction so a
   * partial write never happens; also absorbs a UNIQUE-constraint race between two
   * concurrent incremental installs targeting the same pack (one retries against the
   * fresh entry list rather than 500ing).
   */
  private async addEntriesToExistingPack(
    packRow: typeof rulePacks.$inferSelect,
    fetchedEntries: ImportedEntry[],
    sections: string[],
    user: RequestUser,
  ): Promise<RulePack & { added: number; skippedExisting: number }> {
    const existingRows = await this.db
      .select({ slug: ruleEntries.slug, type: ruleEntries.type })
      .from(ruleEntries)
      .where(eq(ruleEntries.packId, packRow.id));
    const existingKeys = new Set(existingRows.map((r) => `${r.type}::${r.slug}`));

    const toAdd = fetchedEntries.filter((e) => !existingKeys.has(`${e.type}::${e.slug}`));
    const skippedExisting = fetchedEntries.length - toAdd.length;
    const ts = nowIso();

    let updatedPack = packRow;
    if (toAdd.length > 0) {
      try {
        updatedPack = this.db.transaction((tx) => {
          for (const entry of toAdd) {
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
                createdAt: ts,
                updatedAt: ts,
              })
              .run();
          }
          const [row] = tx
            .update(rulePacks)
            .set({ entryCount: packRow.entryCount + toAdd.length, version: ts.slice(0, 10) })
            .where(eq(rulePacks.id, packRow.id))
            .returning()
            .all();
          return row;
        });
      } catch (err) {
        if (!isUniqueConstraintError(err)) throw err;
        // Another concurrent incremental install inserted one of the same (slug,type)
        // rows first — re-derive what's actually there now rather than 500ing. This
        // install just contributed nothing new (safe under the dedupe-by-slug+type rule).
        const [freshPack] = await this.db.select().from(rulePacks).where(eq(rulePacks.id, packRow.id)).limit(1);
        updatedPack = freshPack ?? packRow;
        await this.audit.log({
          actor: auditActor(user),
          actorRole: 'dm',
          action: 'rulepack.install',
          entityType: 'rule_pack',
          entityId: updatedPack.id,
          detail: `incremental install lost a race for pack "${packRow.slug}" (sections ${sections.join(',')}) — 0 added after retry`,
        });
        return { ...packToDomain(updatedPack), added: 0, skippedExisting: fetchedEntries.length };
      }
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'dm',
      action: 'rulepack.install',
      entityType: 'rule_pack',
      entityId: updatedPack.id,
      detail: `incremental install for pack "${packRow.slug}": +${toAdd.length} entries from sections ${sections.join(',')}, ${skippedExisting} already present`,
    });

    return { ...packToDomain(updatedPack), added: toAdd.length, skippedExisting };
  }

  async uninstall(id: number, user: RequestUser): Promise<void> {
    const pack = await this.getPackOrThrow(id);
    // Any combatant referencing one of this pack's entries (added via addCombatant's
    // ruleEntryId path) would otherwise be left with a dangling rule_entry_id once the
    // entries are gone — null it out in the SAME transaction as the entries/pack delete,
    // so there's never a window where the FK-shaped reference points at nothing.
    const entryRows = await this.db.select({ id: ruleEntries.id }).from(ruleEntries).where(eq(ruleEntries.packId, id));
    const entryIds = entryRows.map((r) => r.id);

    this.db.transaction((tx) => {
      for (const entryId of entryIds) {
        tx.update(combatants).set({ ruleEntryId: null }).where(eq(combatants.ruleEntryId, entryId)).run();
      }
      // Campaigns that selected this pack as their rule system would otherwise be left
      // pointing at a dangling slug — GET /campaigns/:id would still report the removed
      // pack's slug, and it would silently re-link if the pack were reinstalled (issue
      // #147). Reset those campaigns to '' (none/homebrew, the column default) in the same
      // transaction, matching what the uninstall dialog promises.
      tx.update(campaigns).set({ ruleSystem: '' }).where(eq(campaigns.ruleSystem, pack.slug)).run();
      tx.delete(ruleEntries).where(eq(ruleEntries.packId, id)).run();
      tx.delete(rulePacks).where(eq(rulePacks.id, id)).run();
    });
    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'dm',
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
   * in the LIKE fallback) breaking ties within a bucket.
   */
  async search(params: { q: string; type?: RuleEntryType; pack?: string }, limit = 50): Promise<RuleEntry[]> {
    const packFilter = params.pack ? await this.db.select().from(rulePacks).where(eq(rulePacks.slug, params.pack)).limit(1) : undefined;
    if (params.pack && (!packFilter || packFilter.length === 0)) return [];
    const packId = packFilter?.[0]?.id;

    if (!params.q.trim()) {
      const conditions = [
        params.type ? eq(ruleEntries.type, params.type) : undefined,
        packId !== undefined ? eq(ruleEntries.packId, packId) : undefined,
      ].filter((c): c is NonNullable<typeof c> => c !== undefined);
      const rows = await this.db
        .select()
        .from(ruleEntries)
        .where(conditions.length ? and(...conditions) : undefined)
        .limit(limit);
      return rows.map(entryToDomain);
    }

    if (this.ftsAvailable) {
      const ftsQuery = toFtsQuery(params.q);
      if (!ftsQuery) return [];
      const conditions = [
        params.type ? eq(ruleEntries.type, params.type) : undefined,
        packId !== undefined ? eq(ruleEntries.packId, packId) : undefined,
      ].filter((c): c is NonNullable<typeof c> => c !== undefined);
      const rows = await this.db
        .select({ entry: ruleEntries })
        .from(ruleEntries)
        .innerJoin(sql`rule_entries_fts`, sql`rule_entries_fts.rowid = ${ruleEntries.id}`)
        .where(and(sql`rule_entries_fts MATCH ${ftsQuery}`, ...conditions))
        .orderBy(nameMatchRank(params.q), sql`rule_entries_fts.rank`)
        .limit(limit);
      return rows.map((r) => entryToDomain(r.entry));
    }

    // LIKE fallback — documented in README as the no-fts5 path.
    const like = `%${params.q.replace(/[%_]/g, '')}%`;
    const conditions = [
      sql`(${ruleEntries.name} LIKE ${like} OR ${ruleEntries.summary} LIKE ${like} OR ${ruleEntries.body} LIKE ${like})`,
      params.type ? eq(ruleEntries.type, params.type) : undefined,
      packId !== undefined ? eq(ruleEntries.packId, packId) : undefined,
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);
    const rows = await this.db
      .select()
      .from(ruleEntries)
      .where(and(...conditions))
      .orderBy(nameMatchRank(params.q), ruleEntries.name)
      .limit(limit);
    return rows.map(entryToDomain);
  }
}
