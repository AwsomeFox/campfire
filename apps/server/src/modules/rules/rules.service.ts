import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { RuleEntry, RuleEntryType, RulePack, RulePackInstall } from '@campfire/schema';
import { DB, RULE_ENTRIES_FTS_AVAILABLE, type DrizzleDb } from '../../db/db.module';
import { rulePacks, ruleEntries, combatants } from '../../db/schema';
import { nowIso } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import {
  ALL_OPEN5E_SECTIONS,
  MAX_ENTRIES_PER_SECTION,
  OPEN5E_DEFAULT_BASE_URL,
  entryTypeForSection,
  fetchOpen5eSection,
  type Open5eSection,
} from './open5e-importer';

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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
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
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    @Inject(RULE_ENTRIES_FTS_AVAILABLE) private readonly ftsAvailable: boolean,
    private readonly audit: AuditService,
  ) {}

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
   * Installs a rule pack from Open5e. Fetches each requested section live,
   * maps to RuleEntry rows, and writes pack + entries in one transaction so a
   * failed import never leaves a half-populated pack. Re-installing the same
   * slug is rejected (409) — uninstall first if you want to refresh.
   */
  async installFromOpen5e(input: RulePackInstall, user: RequestUser): Promise<RulePack> {
    const baseUrl = input.url ?? OPEN5E_DEFAULT_BASE_URL;
    const sections: Open5eSection[] = input.sections?.length ? (input.sections as Open5eSection[]) : ALL_OPEN5E_SECTIONS;
    const slug = 'open5e-srd';

    const [existing] = await this.db.select().from(rulePacks).where(eq(rulePacks.slug, slug)).limit(1);
    if (existing) {
      throw new ConflictException(`Rule pack "${slug}" is already installed — uninstall it first to reimport`);
    }

    const sectionResults = await Promise.all(sections.map((s) => fetchOpen5eSection(baseUrl, s)));
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
    const ts = nowIso();

    const pack = this.db.transaction((tx) => {
      const [packRow] = tx
        .insert(rulePacks)
        .values({
          slug,
          name: 'Open5e SRD',
          version: ts.slice(0, 10),
          license,
          sourceUrl: baseUrl,
          installedAt: ts,
          entryCount: allEntries.length,
        })
        .returning()
        .all();

      for (const entry of allEntries) {
        tx.insert(ruleEntries)
          .values({
            packId: packRow.id,
            slug: entry.slug,
            name: entry.name,
            type: entry.type,
            summary: entry.summary,
            body: entry.body,
            dataJson: entry.dataJson,
            createdAt: ts,
            updatedAt: ts,
          })
          .run();
      }

      return packRow;
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'dm',
      action: 'rulepack.install',
      entityType: 'rule_pack',
      entityId: pack.id,
      detail: `${allEntries.length} entries from ${sections.join(',')} (cap ${MAX_ENTRIES_PER_SECTION}/section, ${totalSkipped} skipped)`,
    });

    return packToDomain(pack);
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
      .limit(limit);
    return rows.map(entryToDomain);
  }
}
