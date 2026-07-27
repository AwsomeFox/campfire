/**
 * Campaign modules (issue #585) — install, three-way update preview, apply with overlays,
 * rollback, fork and detach.
 *
 * The identity/lineage model, and why each piece exists:
 *
 *  - **Package identity.** A module is a UUID + semver + authors/license/source, not a name.
 *    `campaign_module_installs` is keyed UNIQUE(campaign_id, module_id), so an update is
 *    matched on the UUID. Renaming the campaign or the module changes nothing.
 *  - **Lineage.** `origin_kind` / `origin_source_url` record where an installed copy came
 *    from; `upstream_module_id` / `upstream_version` / `forked_at` record what a fork
 *    descends from. Chained forks are walked moduleId -> upstreamModuleId.
 *  - **Baseline.** `campaign_module_artifacts` stores, per artifact, the content EXACTLY as
 *    installed. That third leg is what turns "these two blobs differ" into a decidable
 *    three-way compare — see module-content.ts for the merge algebra.
 *  - **Overlays.** After an apply, the baseline advances to upstream and the fields where the
 *    campaign still diverges are stored as `overlay_json`. Local edits therefore survive an
 *    update as an explicit, inspectable patch rather than as accumulated drift.
 *  - **Rollback.** Every apply first writes a `campaign_module_snapshots` row holding the
 *    install row, every artifact baseline, and the live content of every owned entity, so a
 *    bad update is undone in one synchronous transaction.
 *
 * Nothing here touches campaigns that have no install rows: a campaign with no manifest is
 * simply a campaign with zero modules, and clone/import/export behave exactly as before.
 */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  MODULE_MANIFEST_FORMAT_VERSION,
  MODULE_UPDATE_PLAN_FORMAT_VERSION,
  isValidSemver,
  parseSemverRange,
  satisfiesSemverRange,
  semverTransition,
} from '@campfire/schema';
import type {
  ModuleArtifactKind,
  ModuleArtifactChange,
  ModuleArtifactAction,
  ModuleAuthor,
  ModuleBulkPreview,
  ModuleBulkPreviewRequest,
  ModuleBulkPreviewSkip,
  ModuleCompatibility,
  ModuleCompatibilityCheck,
  ModuleDependency,
  ModuleDependencyCheck,
  ModuleForkRequest,
  ModuleInstall,
  ModuleInstallRequest,
  ModuleOverlayEntry,
  ModulePackage,
  ModulePlanWarning,
  ModuleRollbackResult,
  ModuleSnapshot,
  ModuleUpdateArtifactPlan,
  ModuleUpdatePlan,
  ModuleUpdateRequest,
  ModuleUpdateResult,
  Role,
} from '@campfire/schema';
import { APP_VERSION } from '../../common/build-metadata';
import { DB, type DrizzleDb } from '../../db/db.module';
import {
  campaignModuleArtifacts,
  campaignModuleInstalls,
  campaignModuleSnapshots,
  campaigns,
  factions,
  locations,
  npcs,
  questObjectives,
  quests,
  rulePacks,
} from '../../db/schema';
import { nowIso } from '../../common/time';
import { auditActor, type RequestUser } from '../../common/user.types';
import { AuditService } from '../audit/audit.service';
import {
  DISPLAY_NAME_FIELD,
  MODULE_ARTIFACT_KINDS,
  REFERENCE_FIELDS,
  applyOverlay,
  artifactId,
  compareObjectives,
  computeOverlay,
  hashProjected,
  projectPortable,
  threeWayMerge,
  type PortableContent,
} from './module-content';

type InstallRow = typeof campaignModuleInstalls.$inferSelect;
type ArtifactRow = typeof campaignModuleArtifacts.$inferSelect;
type SnapshotRow = typeof campaignModuleSnapshots.$inferSelect;

/** Drizzle handle usable both standalone and inside a synchronous better-sqlite3 transaction. */
type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];
type Db = DrizzleDb | Tx;

/** Entity rows read generically — every supported kind has `id`, `deletedAt` and the portable columns. */
type EntityRow = Record<string, unknown> & { id: number; deletedAt: string | null };

/** What one snapshot preserves, so rollback can undo edits, creations and deletions alike. */
type SnapshotState = {
  install: {
    moduleId: string;
    name: string;
    version: string;
    description: string;
    license: string;
    sourceUrl: string;
    authorsJson: string;
    compatibilityJson: string;
    dependenciesJson: string;
    manifestJson: string;
    originKind: string;
    originSourceUrl: string;
    upstreamModuleId: string | null;
    upstreamVersion: string | null;
    forkedAt: string | null;
    detached: boolean;
    detachedAt: string | null;
  };
  artifacts: Array<{
    kind: ModuleArtifactKind;
    artifactKey: string;
    name: string;
    entityId: number | null;
    baselineHash: string;
    baselineJson: string;
    overlayJson: string | null;
    installedVersion: string;
  }>;
  entities: Array<{
    kind: ModuleArtifactKind;
    entityId: number;
    content: PortableContent;
    deleted: boolean;
  }>;
};

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null || raw === '') return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed == null ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

/**
 * better-sqlite3 throws a synchronous Error with `.code` set to one of the
 * SQLITE_CONSTRAINT_* codes on a constraint violation. We only care about UNIQUE here
 * (campaign_module_installs' campaign_id + module_id index) — used to turn a lost race
 * between two concurrent installs of the same module into the documented 409 rather
 * than a raw 500. Mirrors the helper in rules.service.ts.
 */
function isUniqueConstraintError(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true;
  const message = err instanceof Error ? err.message : '';
  return /UNIQUE constraint failed/i.test(message);
}

/**
 * Every `*Key` cross-reference in the package that names an artifact the package does not
 * ship, as human-readable messages. Fatal on install, advisory on update — see the call
 * sites in {@link CampaignModulesService.validatePackage} and `buildPlan` for why.
 */
function danglingReferences(contentById: ReadonlyMap<string, PortableContent>): string[] {
  const out: string[] = [];
  for (const [id, content] of contentById) {
    // Defensive only: every id here is built by artifactId(), so it always has a ':' and a
    // known kind. Without the guard a malformed id would make indexOf return -1, slice(0,-1)
    // would yield a corrupted kind, and REFERENCE_FIELDS[kind] would be undefined — turning
    // a bad package into an unhandled TypeError (a 500) inside what is meant to be
    // validation. Skipping is right rather than reporting: an unknown kind has no reference
    // fields to check, and a spurious rejection of a VALID package would be the worse bug.
    const separator = id.indexOf(':');
    if (separator <= 0) continue;
    const kind = id.slice(0, separator) as ModuleArtifactKind;
    const referenceFields = REFERENCE_FIELDS[kind];
    if (referenceFields == null) continue;
    for (const [field, , refKind] of referenceFields) {
      const key = content[field];
      if (typeof key !== 'string' || key === '') continue;
      const target = artifactId(refKind, key);
      if (!contentById.has(target)) {
        out.push(
          `Artifact ${id} references ${target} via ${field}, but the package does not ship it. Module cross-references must stay inside the package.`,
        );
      }
    }
  }
  return out;
}

@Injectable()
export class CampaignModulesService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ reads

  private installRow(db: Db, campaignId: number, installId: number): InstallRow {
    const row = db
      .select()
      .from(campaignModuleInstalls)
      .where(and(eq(campaignModuleInstalls.id, installId), eq(campaignModuleInstalls.campaignId, campaignId)))
      .limit(1)
      .get();
    if (!row) throw new NotFoundException(`Module install ${installId} not found in campaign ${campaignId}.`);
    return row;
  }

  private artifactRows(db: Db, installId: number): ArtifactRow[] {
    return db
      .select()
      .from(campaignModuleArtifacts)
      .where(eq(campaignModuleArtifacts.installId, installId))
      .all();
  }

  /** Live rows for one artifact kind in a campaign, keyed by id. Trashed rows are included so
   *  "deleted locally" is distinguishable from "never existed". */
  private entityRows(db: Db, campaignId: number, kind: ModuleArtifactKind): Map<number, EntityRow> {
    const rows = ((): unknown[] => {
      switch (kind) {
        case 'location':
          return db.select().from(locations).where(eq(locations.campaignId, campaignId)).all();
        case 'npc':
          return db.select().from(npcs).where(eq(npcs.campaignId, campaignId)).all();
        case 'quest':
          return db.select().from(quests).where(eq(quests.campaignId, campaignId)).all();
        case 'faction':
        default:
          return db.select().from(factions).where(eq(factions.campaignId, campaignId)).all();
      }
    })();
    const map = new Map<number, EntityRow>();
    for (const raw of rows) {
      const row = raw as EntityRow;
      map.set(row.id, row);
    }
    return map;
  }

  private questObjectiveRows(db: Db, questIds: number[]): Map<number, Array<{ text: string; sortOrder: number }>> {
    const map = new Map<number, Array<{ text: string; sortOrder: number }>>();
    if (questIds.length === 0) return map;
    const rows = db.select().from(questObjectives).where(inArray(questObjectives.questId, questIds)).all();
    for (const row of rows) {
      const list = map.get(row.questId) ?? [];
      list.push({ text: row.text, sortOrder: row.sortOrder });
      map.set(row.questId, list);
    }
    // The SAME comparator the projection uses. Sorting on sortOrder alone is not enough: it
    // is not a total order (a package may ship ties), so tied entries would fall back to
    // SQLite's scan order here and to the publisher's array order there, and the quest would
    // read `locally_edited` with nobody having edited it.
    for (const list of map.values()) list.sort(compareObjectives);
    return map;
  }

  /**
   * Snapshot of everything the module owns in this campaign: the artifact rows, the live
   * entity rows per kind, the entityId->artifactKey reverse map (needed to express
   * cross-references portably), and quest objectives.
   */
  private ownedState(db: Db, install: InstallRow) {
    const artifacts = this.artifactRows(db, install.id);
    const entities = new Map<ModuleArtifactKind, Map<number, EntityRow>>();
    for (const kind of MODULE_ARTIFACT_KINDS) {
      entities.set(kind, this.entityRows(db, install.campaignId, kind));
    }
    const keyByEntity = new Map<string, string>(); // `${kind}:${entityId}` -> artifactKey
    for (const row of artifacts) {
      if (row.entityId != null) keyByEntity.set(`${row.kind}:${row.entityId}`, row.artifactKey);
    }
    const questIds = artifacts.filter((a) => a.kind === 'quest' && a.entityId != null).map((a) => a.entityId!);
    const objectives = this.questObjectiveRows(db, questIds);
    return { artifacts, entities, keyByEntity, objectives };
  }

  /** Project a live entity row onto portable content, expressing references as artifact keys. */
  private entityToPortable(
    kind: ModuleArtifactKind,
    row: EntityRow,
    keyByEntity: Map<string, string>,
    objectives: Map<number, Array<{ text: string; sortOrder: number }>>,
  ): PortableContent {
    const draft: Record<string, unknown> = { ...row };
    for (const [field, column, refKind] of REFERENCE_FIELDS[kind]) {
      const refId = row[column];
      draft[field] = typeof refId === 'number' ? (keyByEntity.get(`${refKind}:${refId}`) ?? null) : null;
    }
    if (kind === 'quest') draft.objectives = objectives.get(row.id) ?? [];
    return projectPortable(kind, draft);
  }

  // ------------------------------------------------------------- validation

  /**
   * Structural + integrity validation of an incoming package. The manifest's per-artifact
   * `contentHash` is authoritative: a payload that does not hash to its declared value is
   * rejected outright, which is what makes the manifest a real integrity contract rather
   * than decoration.
   */
  private validatePackage(pkg: ModulePackage, mode: 'install' | 'update'): void {
    const manifest = pkg.manifest;
    if (!isValidSemver(manifest.version)) {
      throw new BadRequestException(
        `Module version "${manifest.version}" is not valid semver (expected MAJOR.MINOR.PATCH).`,
      );
    }
    if (manifest.formatVersion > MODULE_MANIFEST_FORMAT_VERSION) {
      throw new BadRequestException(
        `Manifest formatVersion ${manifest.formatVersion} is newer than this server understands (${MODULE_MANIFEST_FORMAT_VERSION}). Upgrade Campfire to install it.`,
      );
    }
    if (parseSemverRange(manifest.compatibility.campfire) == null) {
      throw new BadRequestException(
        `compatibility.campfire "${manifest.compatibility.campfire}" is not a supported semver range.`,
      );
    }
    const seenRefs = new Set<string>();
    for (const ref of manifest.artifacts) {
      const id = artifactId(ref.kind, ref.key);
      if (seenRefs.has(id)) throw new BadRequestException(`Manifest lists artifact ${id} more than once.`);
      seenRefs.add(id);
    }
    const contentById = new Map<string, PortableContent>();
    for (const entry of pkg.artifacts) {
      const id = artifactId(entry.kind, entry.key);
      if (contentById.has(id)) throw new BadRequestException(`Package contains artifact ${id} more than once.`);
      contentById.set(id, projectPortable(entry.kind, entry.data));
    }
    for (const ref of manifest.artifacts) {
      const id = artifactId(ref.kind, ref.key);
      const content = contentById.get(id);
      if (!content) throw new BadRequestException(`Manifest declares artifact ${id} but the package omits its content.`);
      const actual = hashProjected(ref.kind, content);
      if (actual !== ref.contentHash) {
        throw new BadRequestException(
          `Artifact ${id} content hash mismatch: manifest declares ${ref.contentHash.slice(0, 12)}…, payload hashes to ${actual.slice(0, 12)}…`,
        );
      }
    }
    for (const id of contentById.keys()) {
      if (!seenRefs.has(id)) {
        throw new BadRequestException(`Package ships artifact ${id} that the manifest does not declare.`);
      }
    }
    // Every cross-reference must name an artifact THIS package ships. On INSTALL a dangling
    // key is rejected rather than quietly dropped: it would resolve to NULL on the row while
    // the baseline still recorded the key, so the artifact's live projection could never
    // match its own baseline and the install would report itself `locally_edited` forever —
    // and would take the "the table edited this, keep it" branch on every later update.
    //
    // On UPDATE it is deliberately NOT rejected. validatePackage runs on every update path
    // (preview, apply, bulk preview), so throwing here would leave a table that already
    // carries a dangling reference — shipped by a bad package before this check existed —
    // permanently unable to receive ANY further update, including the very correction that
    // would repair the reference. Rejecting at the door is a publisher-facing error they can
    // act on; rejecting on update strands a table that did nothing wrong. The key projects
    // to null as it did before, and surfaces as a non-blocking plan warning (see buildPlan).
    if (mode === 'install') {
      const dangling = danglingReferences(contentById);
      if (dangling.length > 0) throw new BadRequestException(dangling[0]);
    }
  }

  /** Upstream content, projected and keyed by `<kind>:<key>`. */
  private packageContent(pkg: ModulePackage): Map<string, { kind: ModuleArtifactKind; key: string; name: string; content: PortableContent; hash: string }> {
    const byId = new Map<string, { kind: ModuleArtifactKind; key: string; name: string; content: PortableContent; hash: string }>();
    const nameByRef = new Map(pkg.manifest.artifacts.map((r) => [artifactId(r.kind, r.key), r.name] as const));
    for (const entry of pkg.artifacts) {
      const id = artifactId(entry.kind, entry.key);
      const content = projectPortable(entry.kind, entry.data);
      const fallbackName = content[DISPLAY_NAME_FIELD[entry.kind]];
      byId.set(id, {
        kind: entry.kind,
        key: entry.key,
        name: nameByRef.get(id) || (typeof fallbackName === 'string' ? fallbackName : ''),
        content,
        hash: hashProjected(entry.kind, content),
      });
    }
    return byId;
  }

  // ------------------------------------------------------------------ write helpers

  private insertEntity(db: Db, campaignId: number, kind: ModuleArtifactKind, content: PortableContent, ts: string): number {
    switch (kind) {
      case 'location': {
        const [row] = db
          .insert(locations)
          .values({
            campaignId,
            name: String(content.name ?? ''),
            kind: String(content.kind ?? ''),
            status: String(content.status ?? 'unexplored'),
            body: String(content.body ?? ''),
            dmSecret: String(content.dmSecret ?? ''),
            mapX: content.mapX as number | null,
            mapY: content.mapY as number | null,
            createdAt: ts,
            updatedAt: ts,
          })
          .returning()
          .all();
        return row.id;
      }
      case 'npc': {
        const [row] = db
          .insert(npcs)
          .values({
            campaignId,
            name: String(content.name ?? ''),
            role: String(content.role ?? ''),
            disposition: String(content.disposition ?? 'neutral'),
            body: String(content.body ?? ''),
            dmSecret: String(content.dmSecret ?? ''),
            iconSlug: String(content.iconSlug ?? ''),
            hidden: Boolean(content.hidden),
            createdAt: ts,
            updatedAt: ts,
          })
          .returning()
          .all();
        return row.id;
      }
      case 'quest': {
        const [row] = db
          .insert(quests)
          .values({
            campaignId,
            title: String(content.title ?? ''),
            body: String(content.body ?? ''),
            status: String(content.status ?? 'available'),
            reward: String(content.reward ?? ''),
            dmSecret: String(content.dmSecret ?? ''),
            hidden: Boolean(content.hidden),
            sortOrder: Number(content.sortOrder ?? 0),
            createdAt: ts,
            updatedAt: ts,
          })
          .returning()
          .all();
        this.writeObjectives(db, row.id, content);
        return row.id;
      }
      case 'faction':
      default: {
        const [row] = db
          .insert(factions)
          .values({
            campaignId,
            name: String(content.name ?? ''),
            kind: String(content.kind ?? ''),
            body: String(content.body ?? ''),
            goals: String(content.goals ?? ''),
            dmSecret: String(content.dmSecret ?? ''),
            hidden: Boolean(content.hidden),
            reputation: Number(content.reputation ?? 0),
            standing: String(content.standing ?? 'neutral'),
            createdAt: ts,
            updatedAt: ts,
          })
          .returning()
          .all();
        return row.id;
      }
    }
  }

  /**
   * Rewrite a quest's objectives from portable content.
   *
   * `done` is PLAY STATE — deliberately excluded from the portable payload, and therefore
   * NOT the publisher's to set. Because this rewrite is a delete+insert (objective rows have
   * no stable portable id), the completion flags have to be carried across explicitly, or
   * every module update that touches any field of a quest would silently reset the party's
   * progress on it. Carry-over is matched on the objective TEXT: an objective that was only
   * reordered keeps its tick, one whose wording the publisher actually changed is a
   * different objective and starts untucked. Duplicated text is matched positionally.
   */
  private writeObjectives(db: Db, questId: number, content: PortableContent): void {
    const list = Array.isArray(content.objectives)
      ? (content.objectives as Array<{ text: string; sortOrder: number }>)
      : [];
    const doneByText = new Map<string, boolean[]>();
    for (const row of db.select().from(questObjectives).where(eq(questObjectives.questId, questId)).all()) {
      const queue = doneByText.get(row.text) ?? [];
      queue.push(row.done);
      doneByText.set(row.text, queue);
    }
    db.delete(questObjectives).where(eq(questObjectives.questId, questId)).run();
    for (const [index, item] of list.entries()) {
      const queue = doneByText.get(item.text);
      const done = queue != null && queue.length > 0 ? (queue.shift() as boolean) : false;
      db.insert(questObjectives)
        .values({ questId, text: item.text, done, sortOrder: item.sortOrder ?? index })
        .run();
    }
  }

  /**
   * Write portable content onto an existing row. Reference fields are written separately by
   * {@link resolveReferences} once every key in the batch has an id.
   */
  private updateEntity(db: Db, kind: ModuleArtifactKind, entityId: number, content: PortableContent, ts: string): void {
    switch (kind) {
      case 'location':
        db.update(locations)
          .set({
            name: String(content.name ?? ''),
            kind: String(content.kind ?? ''),
            status: String(content.status ?? 'unexplored'),
            body: String(content.body ?? ''),
            dmSecret: String(content.dmSecret ?? ''),
            mapX: content.mapX as number | null,
            mapY: content.mapY as number | null,
            updatedAt: ts,
          })
          .where(eq(locations.id, entityId))
          .run();
        return;
      case 'npc':
        db.update(npcs)
          .set({
            name: String(content.name ?? ''),
            role: String(content.role ?? ''),
            disposition: String(content.disposition ?? 'neutral'),
            body: String(content.body ?? ''),
            dmSecret: String(content.dmSecret ?? ''),
            iconSlug: String(content.iconSlug ?? ''),
            hidden: Boolean(content.hidden),
            updatedAt: ts,
          })
          .where(eq(npcs.id, entityId))
          .run();
        return;
      case 'quest':
        db.update(quests)
          .set({
            title: String(content.title ?? ''),
            body: String(content.body ?? ''),
            status: String(content.status ?? 'available'),
            reward: String(content.reward ?? ''),
            dmSecret: String(content.dmSecret ?? ''),
            hidden: Boolean(content.hidden),
            sortOrder: Number(content.sortOrder ?? 0),
            updatedAt: ts,
          })
          .where(eq(quests.id, entityId))
          .run();
        this.writeObjectives(db, entityId, content);
        return;
      case 'faction':
      default:
        db.update(factions)
          .set({
            name: String(content.name ?? ''),
            kind: String(content.kind ?? ''),
            body: String(content.body ?? ''),
            goals: String(content.goals ?? ''),
            dmSecret: String(content.dmSecret ?? ''),
            hidden: Boolean(content.hidden),
            reputation: Number(content.reputation ?? 0),
            standing: String(content.standing ?? 'neutral'),
            updatedAt: ts,
          })
          .where(eq(factions.id, entityId))
          .run();
    }
  }

  private setEntityDeleted(db: Db, kind: ModuleArtifactKind, entityId: number, deletedAt: string | null): void {
    switch (kind) {
      case 'location':
        db.update(locations).set({ deletedAt }).where(eq(locations.id, entityId)).run();
        return;
      case 'npc':
        db.update(npcs).set({ deletedAt }).where(eq(npcs.id, entityId)).run();
        return;
      case 'quest':
        db.update(quests).set({ deletedAt }).where(eq(quests.id, entityId)).run();
        return;
      case 'faction':
      default:
        db.update(factions).set({ deletedAt }).where(eq(factions.id, entityId)).run();
    }
  }

  /** The current value of each of a kind's reference columns for one row. */
  private refColumnValues(db: Db, kind: ModuleArtifactKind, entityId: number): Record<string, number | null> {
    const row = ((): Record<string, unknown> | undefined => {
      switch (kind) {
        case 'location':
          return db.select().from(locations).where(eq(locations.id, entityId)).limit(1).all()[0];
        case 'npc':
          return db.select().from(npcs).where(eq(npcs.id, entityId)).limit(1).all()[0];
        case 'quest':
          return db.select().from(quests).where(eq(quests.id, entityId)).limit(1).all()[0];
        default:
          return undefined;
      }
    })();
    const out: Record<string, number | null> = {};
    for (const [, column] of REFERENCE_FIELDS[kind]) {
      const value = row?.[column];
      out[column] = typeof value === 'number' ? value : null;
    }
    return out;
  }

  /**
   * Second pass: turn `*Key` references into local ids now that every artifact in the batch
   * has one. A key that names an artifact this module does not ship does not resolve —
   * cross-module references are not part of the contract.
   *
   * An UNRESOLVED reference is NOT the same as "clear the column". The portable model can
   * only name this module's own artifacts, so a table that re-points a module NPC at one of
   * their OWN locations produces content whose `locationKey` is null purely because the link
   * is inexpressible — writing that null back would silently destroy the DM's edit on the
   * next publisher correction. A reference is therefore only cleared when the link it would
   * clear is one this module still owns; a link to anything else is left alone.
   */
  private resolveReferences(
    db: Db,
    kind: ModuleArtifactKind,
    entityId: number,
    content: PortableContent,
    idByArtifact: Map<string, number>,
  ): void {
    const refs = REFERENCE_FIELDS[kind];
    if (refs.length === 0) return;
    // Owned ids are per-kind: ids are per-table, so location 1 and npc 1 are unrelated.
    const ownedByKind = new Map<string, Set<number>>();
    for (const [id, ownedId] of idByArtifact) {
      const ownedKind = id.slice(0, id.indexOf(':'));
      const set = ownedByKind.get(ownedKind) ?? new Set<number>();
      set.add(ownedId);
      ownedByKind.set(ownedKind, set);
    }
    const current = this.refColumnValues(db, kind, entityId);
    const patch: Record<string, number | null> = {};
    for (const [field, column, refKind] of refs) {
      const key = content[field];
      const resolved = typeof key === 'string' ? (idByArtifact.get(artifactId(refKind, key)) ?? null) : null;
      if (resolved === null) {
        const existing = current[column];
        if (existing != null && !(ownedByKind.get(refKind)?.has(existing) ?? false)) continue;
      }
      // A quest/location may not be its own parent. The guard is deliberately scoped to
      // SAME-kind references: ids are per-table, so npc 1 pointing at location 1 is an
      // ordinary reference, not a self-reference.
      patch[column] = refKind === kind && resolved === entityId ? null : resolved;
    }
    if (Object.keys(patch).length === 0) return;
    switch (kind) {
      case 'location':
        db.update(locations).set(patch).where(eq(locations.id, entityId)).run();
        return;
      case 'npc':
        db.update(npcs).set(patch).where(eq(npcs.id, entityId)).run();
        return;
      case 'quest':
        db.update(quests).set(patch).where(eq(quests.id, entityId)).run();
        return;
      default:
    }
  }

  // ------------------------------------------------------------------ install

  async install(campaignId: number, request: ModuleInstallRequest, user: RequestUser, role: Role): Promise<ModuleInstall> {
    const pkg = request.package;
    this.validatePackage(pkg, 'install');
    const manifest = pkg.manifest;
    const existing = this.db
      .select({ id: campaignModuleInstalls.id })
      .from(campaignModuleInstalls)
      .where(
        and(eq(campaignModuleInstalls.campaignId, campaignId), eq(campaignModuleInstalls.moduleId, manifest.moduleId)),
      )
      .limit(1)
      .get();
    if (existing) {
      throw new ConflictException(
        `Module ${manifest.moduleId} is already installed in this campaign (install ${existing.id}). Use the update route to move it to a new version.`,
      );
    }

    // Compatibility and dependencies gate GETTING the module into a campaign, so they have
    // to run here and not only on the update path. Installing materializes the module's
    // content into live campaign rows immediately — there is no staging state in which an
    // incompatible module sits inert — so letting a package whose declared Campfire range
    // excludes this server, or whose required dependencies are absent, install cleanly
    // would invert the purpose of declaring them. Same findings and the same 409 semantics
    // the apply path uses; as there, only NON-optional dependencies block.
    const compatibility = this.compatibilityCheck(this.db, campaignId, pkg);
    const dependencies = this.dependencyChecks(this.db, campaignId, pkg, null);
    const blockers = [
      ...compatibility.issues,
      ...dependencies
        .filter((dep) => dep.status !== 'satisfied' && !dep.optional)
        .map(
          (dep) =>
            `Dependency ${dep.name} (${dep.versionRange}) is ${dep.status.replace('_', ' ')}${
              dep.installedVersion ? ` — installed ${dep.installedVersion}` : ''
            }.`,
        ),
    ];
    if (blockers.length > 0) {
      throw new ConflictException({
        code: 'MODULE_INSTALL_BLOCKED',
        message: `This module cannot be installed: ${blockers.join(' ')}`,
        blockers,
      });
    }

    const ts = nowIso();
    const contentById = this.packageContent(pkg);
    // Insert in dependency order so most references resolve on the first pass; the explicit
    // second pass below still runs, because self-references (location/quest parents) can point
    // forward within a kind.
    const order: ModuleArtifactKind[] = ['faction', 'location', 'npc', 'quest'];

    let installId: number;
    try {
      installId = this.db.transaction((tx) => {
        const [installRow] = tx
          .insert(campaignModuleInstalls)
          .values({
            campaignId,
            moduleId: manifest.moduleId,
            name: manifest.name,
            version: manifest.version,
            description: manifest.description,
            license: manifest.license,
            sourceUrl: manifest.sourceUrl,
            authorsJson: JSON.stringify(manifest.authors),
            compatibilityJson: JSON.stringify(manifest.compatibility),
            dependenciesJson: JSON.stringify(manifest.dependencies),
            manifestJson: JSON.stringify(manifest),
            originKind: 'install',
            originSourceUrl: request.originSourceUrl ?? manifest.sourceUrl,
            upstreamModuleId: null,
            upstreamVersion: null,
            forkedAt: null,
            detached: false,
            detachedAt: null,
            installedAt: ts,
            installedBy: auditActor(user),
            updatedAt: ts,
          })
          .returning()
          .all();

        const idByArtifact = new Map<string, number>();
        for (const kind of order) {
          for (const entry of contentById.values()) {
            if (entry.kind !== kind) continue;
            const entityId = this.insertEntity(tx, campaignId, kind, entry.content, ts);
            idByArtifact.set(artifactId(kind, entry.key), entityId);
            tx.insert(campaignModuleArtifacts)
              .values({
                installId: installRow.id,
                campaignId,
                kind,
                artifactKey: entry.key,
                name: entry.name,
                entityId,
                baselineHash: entry.hash,
                baselineJson: JSON.stringify(entry.content),
                overlayJson: null,
                installedVersion: manifest.version,
                createdAt: ts,
                updatedAt: ts,
              })
              .run();
          }
        }
        for (const entry of contentById.values()) {
          const entityId = idByArtifact.get(artifactId(entry.kind, entry.key));
          if (entityId != null) this.resolveReferences(tx, entry.kind, entityId, entry.content, idByArtifact);
        }
        return installRow.id;
      });
    } catch (err) {
      // The `existing` probe above and this insert are not one atomic step: two concurrent
      // installs of the same module can both find nothing and both proceed. The second then
      // trips UNIQUE(campaign_id, module_id), which would surface as a raw SQLITE_CONSTRAINT
      // (a 500). Map it to the same 409 the probe returns so the documented contract holds
      // under the race, not merely in the common case.
      if (isUniqueConstraintError(err)) {
        throw new ConflictException(
          `Module ${manifest.moduleId} is already installed in this campaign. Use the update route to move it to a new version.`,
        );
      }
      throw err;
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'campaign_module.install',
      entityType: 'campaign_module',
      entityId: installId,
      campaignId,
      detail: `${manifest.name} ${manifest.version} (${manifest.moduleId})`,
    });
    return this.toInstall(this.db, this.installRow(this.db, campaignId, installId));
  }

  // ------------------------------------------------------------------ read API

  async list(campaignId: number): Promise<ModuleInstall[]> {
    const rows = this.db
      .select()
      .from(campaignModuleInstalls)
      .where(eq(campaignModuleInstalls.campaignId, campaignId))
      .all();
    return rows.map((row) => this.toInstall(this.db, row));
  }

  async get(campaignId: number, installId: number): Promise<ModuleInstall> {
    return this.toInstall(this.db, this.installRow(this.db, campaignId, installId));
  }

  /**
   * Rollback points for an install, oldest first — the order the API documents. The
   * ordering is stated explicitly rather than left to the query plan: SQLite happens to
   * return insertion order for a bare table scan, but that is a plan detail, not a
   * guarantee, and adding an index over this table later could silently change it.
   */
  async snapshots(campaignId: number, installId: number): Promise<ModuleSnapshot[]> {
    this.installRow(this.db, campaignId, installId);
    return this.db
      .select()
      .from(campaignModuleSnapshots)
      .where(eq(campaignModuleSnapshots.installId, installId))
      .orderBy(asc(campaignModuleSnapshots.id))
      .all()
      .map((row) => this.toSnapshot(row));
  }

  /**
   * The retained local divergence, artifact by artifact. Two sources are folded together:
   * the `overlay_json` a previous apply persisted, and any divergence that has accrued
   * since (an edit made after the last update). Both are expressed against the CURRENT
   * baseline, so the answer to "what has my table changed relative to the publisher's
   * version?" is one read rather than a diff the caller has to assemble.
   */
  async overlays(campaignId: number, installId: number): Promise<ModuleOverlayEntry[]> {
    const install = this.installRow(this.db, campaignId, installId);
    const { artifacts, entities, keyByEntity, objectives } = this.ownedState(this.db, install);
    const out: ModuleOverlayEntry[] = [];
    for (const row of artifacts) {
      const kind = row.kind as ModuleArtifactKind;
      const baseline = parseJson<PortableContent>(row.baselineJson, {});
      const entity = row.entityId != null ? entities.get(kind)?.get(row.entityId) : undefined;
      const live = entity && entity.deletedAt == null ? this.entityToPortable(kind, entity, keyByEntity, objectives) : null;
      const overlay = live
        ? computeOverlay(kind, baseline, live)
        : parseJson<PortableContent | null>(row.overlayJson, null);
      if (overlay == null) continue;
      out.push({
        kind,
        key: row.artifactKey,
        name: row.name,
        entityId: row.entityId,
        baselineVersion: row.installedVersion,
        baseline,
        overlay,
        effective: applyOverlay(kind, baseline, overlay),
        fields: Object.keys(overlay).sort(),
      });
    }
    return out;
  }

  private toSnapshot(row: SnapshotRow): ModuleSnapshot {
    return {
      id: row.id,
      installId: row.installId,
      reason: (row.reason === 'install' || row.reason === 'fork' ? row.reason : 'update') as ModuleSnapshot['reason'],
      fromVersion: row.fromVersion,
      toVersion: row.toVersion,
      artifactCount: row.artifactCount,
      createdAt: row.createdAt,
      createdBy: row.createdBy,
      rolledBackAt: row.rolledBackAt,
    };
  }

  private toInstall(db: Db, row: InstallRow): ModuleInstall {
    const { artifacts, entities, keyByEntity, objectives } = this.ownedState(db, row);
    let locallyEdited = 0;
    let overlays = 0;
    for (const artifact of artifacts) {
      if (artifact.overlayJson != null) overlays += 1;
      if (artifact.entityId == null) continue;
      const kind = artifact.kind as ModuleArtifactKind;
      const entity = entities.get(kind)?.get(artifact.entityId);
      if (!entity || entity.deletedAt != null) continue;
      const local = this.entityToPortable(kind, entity, keyByEntity, objectives);
      if (hashProjected(kind, local) !== artifact.baselineHash) locallyEdited += 1;
    }
    const pendingRollback = db
      .select({ id: campaignModuleSnapshots.id })
      .from(campaignModuleSnapshots)
      .where(and(eq(campaignModuleSnapshots.installId, row.id), isNull(campaignModuleSnapshots.rolledBackAt)))
      .limit(1)
      .all()[0];
    return {
      id: row.id,
      campaignId: row.campaignId,
      moduleId: row.moduleId,
      name: row.name,
      version: row.version,
      description: row.description,
      license: row.license,
      sourceUrl: row.sourceUrl,
      authors: parseJson<ModuleAuthor[]>(row.authorsJson, []),
      compatibility: parseJson<ModuleCompatibility>(row.compatibilityJson, { campfire: '*', ruleSystems: [] }),
      dependencies: parseJson<ModuleDependency[]>(row.dependenciesJson, []),
      lineage: {
        originKind: row.originKind === 'fork' ? 'fork' : 'install',
        originSourceUrl: row.originSourceUrl,
        upstreamModuleId: row.upstreamModuleId,
        upstreamVersion: row.upstreamVersion,
        forkedAt: row.forkedAt,
        detached: row.detached,
        detachedAt: row.detachedAt,
      },
      artifactCount: artifacts.length,
      locallyEditedCount: locallyEdited,
      overlayCount: overlays,
      installedAt: row.installedAt,
      updatedAt: row.updatedAt,
      rollbackAvailable: pendingRollback != null,
    };
  }

  // ------------------------------------------------------------------ preview

  private compatibilityCheck(db: Db, campaignId: number, pkg: ModulePackage): ModuleCompatibilityCheck {
    const compat = pkg.manifest.compatibility;
    const campaign = db
      .select({ ruleSystem: campaigns.ruleSystem })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1)
      .get();
    const ruleSystem = campaign?.ruleSystem ?? '';
    const issues: string[] = [];
    const range = compat.campfire || '*';
    if (parseSemverRange(range) == null) {
      issues.push(`compatibility.campfire "${range}" is not a supported semver range.`);
    } else if (!satisfiesSemverRange(APP_VERSION, range)) {
      issues.push(`This module requires Campfire ${range}; this server runs ${APP_VERSION}.`);
    }
    if (compat.ruleSystems.length > 0 && !compat.ruleSystems.includes(ruleSystem)) {
      issues.push(
        `This module targets rule system(s) ${compat.ruleSystems.join(', ')}; this campaign uses "${ruleSystem || 'none'}".`,
      );
    }
    return {
      compatible: issues.length === 0,
      appVersion: APP_VERSION,
      campfireRange: range,
      ruleSystem,
      ruleSystems: compat.ruleSystems,
      issues,
    };
  }

  /**
   * Resolve every declared dependency against what this campaign actually has.
   *
   * `previousDependenciesJson` is the dependency set already recorded on the install, used
   * only to report whether a dependency's declaration `changed`. It is null on a fresh
   * install, where every dependency is new by definition.
   */
  private dependencyChecks(
    db: Db,
    campaignId: number,
    pkg: ModulePackage,
    previousDependenciesJson: string | null,
  ): ModuleDependencyCheck[] {
    const installedDeps = new Map(
      parseJson<ModuleDependency[]>(previousDependenciesJson, []).map((d) => [`${d.kind}:${d.id}`, d] as const),
    );
    return pkg.manifest.dependencies.map((dep) => {
      const previous = installedDeps.get(`${dep.kind}:${dep.id}`);
      const changed = previous == null || previous.versionRange !== dep.versionRange || previous.optional !== dep.optional;
      let installedVersion: string | null = null;
      if (dep.kind === 'compendium-pack') {
        const pack = db
          .select({ version: rulePacks.version })
          .from(rulePacks)
          .where(eq(rulePacks.slug, dep.id))
          .limit(1)
          .all()[0];
        installedVersion = pack?.version ?? null;
      } else {
        const other = db
          .select({ version: campaignModuleInstalls.version })
          .from(campaignModuleInstalls)
          .where(
            and(eq(campaignModuleInstalls.campaignId, campaignId), eq(campaignModuleInstalls.moduleId, dep.id)),
          )
          .limit(1)
          .get();
        installedVersion = other?.version ?? null;
      }
      let status: ModuleDependencyCheck['status'];
      if (parseSemverRange(dep.versionRange) == null) {
        status = 'unparseable_range';
      } else if (installedVersion == null) {
        status = 'missing';
      } else if (installedVersion === '' || satisfiesSemverRange(installedVersion, dep.versionRange)) {
        // A rule pack with no recorded version cannot be range-checked; treat it as satisfied
        // rather than blocking an update on metadata the pack importer never captured.
        status = 'satisfied';
      } else {
        status = 'version_mismatch';
      }
      return {
        kind: dep.kind,
        id: dep.id,
        name: dep.name || dep.id,
        versionRange: dep.versionRange,
        optional: dep.optional,
        status,
        installedVersion,
        changed,
      };
    });
  }

  /**
   * The three-way dry run. Reads only; the same routine backs `update/preview`, the
   * bulk preview, and the apply path (which re-runs it inside the transaction so the plan
   * it acts on is the plan it reports).
   */
  private buildPlan(db: Db, install: InstallRow, pkg: ModulePackage, request: ModuleUpdateRequest): ModuleUpdatePlan {
    const manifest = pkg.manifest;
    const warnings: ModulePlanWarning[] = [];

    // Identity: an update must be for THIS module, or for the upstream a fork descends from
    // (which is exactly how a divergent fork pulls in a publisher's correction).
    const matchesSelf = manifest.moduleId === install.moduleId;
    const matchesUpstream = install.upstreamModuleId != null && manifest.moduleId === install.upstreamModuleId;
    if (!matchesSelf && !matchesUpstream) {
      warnings.push({
        code: 'module_id_mismatch',
        message: `Package module ${manifest.moduleId} does not match installed module ${install.moduleId}${
          install.upstreamModuleId ? ` (or its upstream ${install.upstreamModuleId})` : ''
        }.`,
        blocking: true,
      });
    } else if (!matchesSelf) {
      warnings.push({
        code: 'upstream_merge_into_fork',
        message: `Merging upstream ${manifest.moduleId} ${manifest.version} into fork ${install.moduleId}. The fork keeps its own identity and version.`,
        blocking: false,
      });
    }
    if (install.detached) {
      warnings.push({
        code: 'detached',
        message: 'This install was detached from its source; upstream updates no longer apply. Lineage is retained as history.',
        blocking: true,
      });
    }
    if (!isValidSemver(manifest.version)) {
      warnings.push({ code: 'invalid_version', message: `"${manifest.version}" is not valid semver.`, blocking: true });
    }

    const compatibility = this.compatibilityCheck(db, install.campaignId, pkg);
    if (!compatibility.compatible) {
      for (const issue of compatibility.issues) {
        warnings.push({ code: 'incompatible', message: issue, blocking: true });
      }
    }
    const dependencies = this.dependencyChecks(db, install.campaignId, pkg, install.dependenciesJson);
    for (const dep of dependencies) {
      if (dep.status === 'satisfied') continue;
      warnings.push({
        code: `dependency_${dep.status}`,
        message: `Dependency ${dep.name} (${dep.versionRange}) is ${dep.status.replace('_', ' ')}${
          dep.installedVersion ? ` — installed ${dep.installedVersion}` : ''
        }.`,
        blocking: !dep.optional,
      });
    }

    // Compare against the fork's own baseline version when merging upstream into a fork.
    const fromVersion = matchesSelf ? install.version : (install.upstreamVersion ?? install.version);
    const { artifacts, entities, keyByEntity, objectives } = this.ownedState(db, install);
    const upstream = this.packageContent(pkg);

    // Advisory, never blocking: install rejects a package with a dangling cross-reference,
    // but an update must not — a table already carrying one would otherwise be unable to
    // take the correction that repairs it. The key resolves to null, and the DM is told.
    for (const message of danglingReferences(new Map([...upstream].map(([id, e]) => [id, e.content])))) {
      warnings.push({ code: 'dangling_reference', message, blocking: false });
    }

    const baselineById = new Map(artifacts.map((a) => [artifactId(a.kind as ModuleArtifactKind, a.artifactKey), a] as const));

    const plans: ModuleUpdateArtifactPlan[] = [];
    const counts: Record<string, number> = {};
    const bump = (change: ModuleArtifactChange) => {
      counts[change] = (counts[change] ?? 0) + 1;
    };
    let conflictCount = 0;

    const allIds = new Set<string>([...baselineById.keys(), ...upstream.keys()]);
    for (const id of [...allIds].sort()) {
      const baseline = baselineById.get(id);
      const incoming = upstream.get(id);

      if (baseline && !incoming) {
        const kind = baseline.kind as ModuleArtifactKind;
        const entity = baseline.entityId != null ? entities.get(kind)?.get(baseline.entityId) : undefined;
        const alive = entity != null && entity.deletedAt == null;
        const local = alive ? this.entityToPortable(kind, entity, keyByEntity, objectives) : null;
        const localHash = local ? hashProjected(kind, local) : null;
        const editedLocally = alive && localHash !== baseline.baselineHash;
        // The publisher removed it. If the table never touched it we honour the removal
        // (subject to policy); if they edited it we keep their row and relinquish ownership.
        const action: ModuleArtifactAction =
          !alive ? 'none' : editedLocally || request.onUpstreamDelete === 'keep' ? 'keep_local' : 'delete';
        bump('deleted_upstream');
        plans.push({
          kind,
          key: baseline.artifactKey,
          name: baseline.name,
          change: 'deleted_upstream',
          action,
          entityId: baseline.entityId,
          baselineHash: baseline.baselineHash,
          localHash,
          upstreamHash: null,
          fields: [],
          conflictFields: [],
        });
        continue;
      }

      if (!baseline && incoming) {
        bump('added_upstream');
        plans.push({
          kind: incoming.kind,
          key: incoming.key,
          name: incoming.name,
          change: 'added_upstream',
          action: 'create',
          entityId: null,
          baselineHash: null,
          localHash: null,
          upstreamHash: incoming.hash,
          fields: [],
          conflictFields: [],
        });
        continue;
      }
      if (!baseline || !incoming) continue;

      const kind = baseline.kind as ModuleArtifactKind;
      const entity = baseline.entityId != null ? entities.get(kind)?.get(baseline.entityId) : undefined;
      if (entity == null || entity.deletedAt != null) {
        bump('deleted_locally');
        plans.push({
          kind,
          key: baseline.artifactKey,
          name: incoming.name || baseline.name,
          change: 'deleted_locally',
          action: 'none',
          entityId: null,
          baselineHash: baseline.baselineHash,
          localHash: null,
          upstreamHash: incoming.hash,
          fields: [],
          conflictFields: [],
        });
        continue;
      }

      const base = parseJson<PortableContent>(baseline.baselineJson, {});
      const local = this.entityToPortable(kind, entity, keyByEntity, objectives);
      const localHash = hashProjected(kind, local);
      const upstreamChanged = incoming.hash !== baseline.baselineHash;
      const locallyChanged = localHash !== baseline.baselineHash;

      let change: ModuleArtifactChange;
      let action: ModuleArtifactAction;
      let fields: ModuleUpdateArtifactPlan['fields'] = [];
      let conflictFields: string[] = [];

      if (!upstreamChanged && !locallyChanged) {
        change = 'unchanged';
        action = 'none';
      } else if (upstreamChanged && !locallyChanged) {
        change = 'upstream_changed';
        action = 'update';
        const merge = threeWayMerge(kind, base, local, incoming.content);
        fields = merge.fields;
      } else if (!upstreamChanged && locallyChanged) {
        change = 'locally_edited';
        action = 'keep_local';
        const merge = threeWayMerge(kind, base, local, incoming.content);
        fields = merge.fields;
      } else {
        const merge = threeWayMerge(kind, base, local, incoming.content);
        fields = merge.fields;
        conflictFields = merge.conflictFields;
        if (conflictFields.length === 0) {
          change = 'both_changed';
          action = 'merge';
        } else {
          change = 'conflict';
          const resolution = request.resolutions[id] ?? request.onConflict;
          action =
            resolution === 'upstream' || resolution === 'local' || resolution === 'merge'
              ? 'merge'
              : 'needs_resolution';
          conflictCount += 1;
        }
      }

      bump(change);
      plans.push({
        kind,
        key: baseline.artifactKey,
        name: incoming.name || baseline.name,
        change,
        action,
        entityId: baseline.entityId,
        baselineHash: baseline.baselineHash,
        localHash,
        upstreamHash: incoming.hash,
        fields,
        conflictFields,
      });
    }

    const campaign = db
      .select({ name: campaigns.name })
      .from(campaigns)
      .where(eq(campaigns.id, install.campaignId))
      .limit(1)
      .all()[0];

    return {
      app: 'campfire',
      kind: 'campaign-module-update-plan',
      formatVersion: MODULE_UPDATE_PLAN_FORMAT_VERSION,
      campaignId: install.campaignId,
      campaignName: campaign?.name ?? '',
      installId: install.id,
      moduleId: install.moduleId,
      moduleName: install.name,
      fromVersion,
      toVersion: manifest.version,
      versionChange: semverTransition(fromVersion, manifest.version),
      compatibility,
      dependencies,
      artifacts: plans,
      counts,
      conflictCount,
      warnings,
      canApply: !warnings.some((w) => w.blocking),
      createdAt: nowIso(),
    };
  }

  async previewUpdate(campaignId: number, installId: number, request: ModuleUpdateRequest): Promise<ModuleUpdatePlan> {
    this.validatePackage(request.package, 'update');
    const install = this.installRow(this.db, campaignId, installId);
    return this.buildPlan(this.db, install, request.package, request);
  }

  // ------------------------------------------------------------------ apply

  async applyUpdate(
    campaignId: number,
    installId: number,
    request: ModuleUpdateRequest,
    user: RequestUser,
    role: Role,
  ): Promise<ModuleUpdateResult> {
    this.validatePackage(request.package, 'update');
    if (request.dryRun) {
      const install = this.installRow(this.db, campaignId, installId);
      const plan = this.buildPlan(this.db, install, request.package, request);
      return {
        install: this.toInstall(this.db, install),
        plan,
        applied: false,
        updatedCount: 0,
        createdCount: 0,
        deletedCount: 0,
        keptLocalCount: 0,
        overlayCount: 0,
        unresolvedConflictCount: plan.conflictCount,
        snapshotId: null,
      };
    }

    const manifest = request.package.manifest;
    const ts = nowIso();
    const actor = auditActor(user);

    const outcome = this.db.transaction((tx) => {
      const install = this.installRow(tx, campaignId, installId);
      const plan = this.buildPlan(tx, install, request.package, request);
      if (!plan.canApply) {
        const blockers = plan.warnings.filter((w) => w.blocking).map((w) => w.message);
        throw new ConflictException({
          code: 'MODULE_UPDATE_BLOCKED',
          message: `This update cannot be applied: ${blockers.join(' ')}`,
          blockers,
        });
      }

      const snapshotId = this.writeSnapshot(tx, install, plan.toVersion, 'update', actor, ts);
      const upstream = this.packageContent(request.package);
      const { artifacts, entities, keyByEntity, objectives } = this.ownedState(tx, install);
      const artifactRowById = new Map(
        artifacts.map((a) => [artifactId(a.kind as ModuleArtifactKind, a.artifactKey), a] as const),
      );
      const idByArtifact = new Map<string, number>();
      for (const row of artifacts) {
        if (row.entityId != null) idByArtifact.set(artifactId(row.kind as ModuleArtifactKind, row.artifactKey), row.entityId);
      }

      let updatedCount = 0;
      let createdCount = 0;
      let deletedCount = 0;
      let keptLocalCount = 0;
      let unresolvedConflictCount = 0;
      /** Artifacts whose entity content changed and therefore need a reference re-resolve. */
      const touched: Array<{ kind: ModuleArtifactKind; key: string; entityId: number; content: PortableContent }> = [];

      // Creations first (in dependency order) so later references can resolve to them.
      const creationOrder: ModuleArtifactKind[] = ['faction', 'location', 'npc', 'quest'];
      for (const kind of creationOrder) {
        for (const item of plan.artifacts) {
          if (item.action !== 'create' || item.kind !== kind) continue;
          const incoming = upstream.get(artifactId(item.kind, item.key));
          if (!incoming) continue;
          const entityId = this.insertEntity(tx, campaignId, kind, incoming.content, ts);
          idByArtifact.set(artifactId(kind, item.key), entityId);
          tx.insert(campaignModuleArtifacts)
            .values({
              installId: install.id,
              campaignId,
              kind,
              artifactKey: item.key,
              name: incoming.name,
              entityId,
              baselineHash: incoming.hash,
              baselineJson: JSON.stringify(incoming.content),
              overlayJson: null,
              installedVersion: manifest.version,
              createdAt: ts,
              updatedAt: ts,
            })
            .run();
          touched.push({ kind, key: item.key, entityId, content: incoming.content });
          createdCount += 1;
        }
      }

      for (const item of plan.artifacts) {
        const id = artifactId(item.kind, item.key);
        const row = artifactRowById.get(id);
        const incoming = upstream.get(id);
        const kind = item.kind;

        if (item.change === 'deleted_upstream') {
          if (!row) continue;
          if (item.action === 'delete' && row.entityId != null) {
            this.setEntityDeleted(tx, kind, row.entityId, ts);
            deletedCount += 1;
          } else if (item.action === 'keep_local') {
            keptLocalCount += 1;
          }
          // Either way the module no longer ships it, so it stops being a module artifact.
          // Note the consequence for a kept row: if a later version RE-adds the same key it
          // arrives as `added_upstream` and is created fresh alongside the table's copy.
          // That is deliberate — once the publisher dropped an artifact the table had edited,
          // the surviving row is the table's, and silently re-adopting it would resurrect
          // exactly the "upstream quietly overwrote my work" failure this feature exists to
          // prevent. Rollback restores the artifact row from the snapshot either way.
          tx.delete(campaignModuleArtifacts).where(eq(campaignModuleArtifacts.id, row.id)).run();
          continue;
        }
        if (item.change === 'added_upstream' || !row || !incoming) continue;

        if (item.change === 'deleted_locally') {
          // The table trashed it. Do not resurrect — advance the baseline so a later restore
          // starts from the current upstream content, and clear the stale entity link.
          tx.update(campaignModuleArtifacts)
            .set({
              entityId: null,
              name: incoming.name,
              baselineHash: incoming.hash,
              baselineJson: JSON.stringify(incoming.content),
              overlayJson: null,
              installedVersion: manifest.version,
              updatedAt: ts,
            })
            .where(eq(campaignModuleArtifacts.id, row.id))
            .run();
          continue;
        }
        if (row.entityId == null) continue;

        if (item.change === 'conflict' && item.action === 'needs_resolution') {
          // Unresolved: leave BOTH the entity and the baseline untouched, so the same conflict
          // is re-detected on the next preview instead of being silently swallowed.
          unresolvedConflictCount += 1;
          continue;
        }

        const base = parseJson<PortableContent>(row.baselineJson, {});
        const entity = entities.get(kind)?.get(row.entityId);
        const local = entity ? this.entityToPortable(kind, entity, keyByEntity, objectives) : base;
        // Only the CONFLICTING fields are decided by the resolution; every other field
        // follows the deterministic rules regardless. 'merge' and 'local' both keep the
        // table's value on a collision — the difference is only in intent/reporting.
        const resolution = request.resolutions[id] ?? request.onConflict;
        const winner: 'upstream' | 'local' = resolution === 'upstream' ? 'upstream' : 'local';
        const merged = threeWayMerge(kind, base, local, incoming.content, winner).merged;

        const before = hashProjected(kind, local);
        const after = hashProjected(kind, merged);
        if (after !== before) {
          this.updateEntity(tx, kind, row.entityId, merged, ts);
          touched.push({ kind, key: item.key, entityId: row.entityId, content: merged });
          updatedCount += 1;
        } else if (item.change === 'locally_edited') {
          keptLocalCount += 1;
        }
        tx.update(campaignModuleArtifacts)
          .set({
            name: incoming.name,
            baselineHash: incoming.hash,
            baselineJson: JSON.stringify(incoming.content),
            // The overlay is what the campaign still holds beyond the NEW baseline.
            overlayJson: (() => {
              const overlay = computeOverlay(kind, incoming.content, merged);
              return overlay ? JSON.stringify(overlay) : null;
            })(),
            installedVersion: manifest.version,
            updatedAt: ts,
          })
          .where(eq(campaignModuleArtifacts.id, row.id))
          .run();
      }

      for (const item of touched) {
        this.resolveReferences(tx, item.kind, item.entityId, item.content, idByArtifact);
      }

      // Identity: a plain install advances to the package's version and manifest. A FORK keeps
      // its own moduleId/version/name and instead records how far upstream it has merged.
      const isFork = install.originKind === 'fork' && manifest.moduleId !== install.moduleId;
      if (isFork) {
        tx.update(campaignModuleInstalls)
          .set({
            dependenciesJson: JSON.stringify(manifest.dependencies),
            compatibilityJson: JSON.stringify(manifest.compatibility),
            upstreamVersion: manifest.version,
            updatedAt: ts,
          })
          .where(eq(campaignModuleInstalls.id, install.id))
          .run();
      } else {
        tx.update(campaignModuleInstalls)
          .set({
            name: manifest.name,
            version: manifest.version,
            description: manifest.description,
            license: manifest.license,
            sourceUrl: manifest.sourceUrl,
            authorsJson: JSON.stringify(manifest.authors),
            compatibilityJson: JSON.stringify(manifest.compatibility),
            dependenciesJson: JSON.stringify(manifest.dependencies),
            manifestJson: JSON.stringify(manifest),
            updatedAt: ts,
          })
          .where(eq(campaignModuleInstalls.id, install.id))
          .run();
      }

      const refreshed = this.installRow(tx, campaignId, installId);
      const overlayCount = this.artifactRows(tx, install.id).filter((a) => a.overlayJson != null).length;
      return {
        install: this.toInstall(tx, refreshed),
        // Re-run the plan post-apply so the caller sees the residual state (unresolved
        // conflicts stay visible; everything else settles to `unchanged`).
        plan: this.buildPlan(tx, refreshed, request.package, request),
        applied: true,
        updatedCount,
        createdCount,
        deletedCount,
        keptLocalCount,
        overlayCount,
        unresolvedConflictCount,
        snapshotId,
      } satisfies ModuleUpdateResult;
    });

    await this.audit.log({
      actor,
      actorRole: role,
      action: 'campaign_module.update',
      entityType: 'campaign_module',
      entityId: installId,
      campaignId,
      detail: `${manifest.name} -> ${manifest.version} (updated ${outcome.updatedCount}, created ${outcome.createdCount}, deleted ${outcome.deletedCount}, kept local ${outcome.keptLocalCount}, unresolved ${outcome.unresolvedConflictCount})`,
    });
    return outcome;
  }

  // ------------------------------------------------------------------ snapshots / rollback

  private writeSnapshot(
    db: Db,
    install: InstallRow,
    toVersion: string,
    reason: 'install' | 'update' | 'fork',
    actor: string,
    ts: string,
  ): number {
    const { artifacts, entities, keyByEntity, objectives } = this.ownedState(db, install);
    const state: SnapshotState = {
      install: {
        moduleId: install.moduleId,
        name: install.name,
        version: install.version,
        description: install.description,
        license: install.license,
        sourceUrl: install.sourceUrl,
        authorsJson: install.authorsJson,
        compatibilityJson: install.compatibilityJson,
        dependenciesJson: install.dependenciesJson,
        manifestJson: install.manifestJson,
        originKind: install.originKind,
        originSourceUrl: install.originSourceUrl,
        upstreamModuleId: install.upstreamModuleId,
        upstreamVersion: install.upstreamVersion,
        forkedAt: install.forkedAt,
        detached: install.detached,
        detachedAt: install.detachedAt,
      },
      artifacts: artifacts.map((a) => ({
        kind: a.kind as ModuleArtifactKind,
        artifactKey: a.artifactKey,
        name: a.name,
        entityId: a.entityId,
        baselineHash: a.baselineHash,
        baselineJson: a.baselineJson,
        overlayJson: a.overlayJson,
        installedVersion: a.installedVersion,
      })),
      entities: [],
    };
    for (const artifact of artifacts) {
      if (artifact.entityId == null) continue;
      const kind = artifact.kind as ModuleArtifactKind;
      const entity = entities.get(kind)?.get(artifact.entityId);
      if (!entity) continue;
      state.entities.push({
        kind,
        entityId: artifact.entityId,
        content: this.entityToPortable(kind, entity, keyByEntity, objectives),
        deleted: entity.deletedAt != null,
      });
    }
    const [row] = db
      .insert(campaignModuleSnapshots)
      .values({
        installId: install.id,
        campaignId: install.campaignId,
        reason,
        fromVersion: install.version,
        toVersion,
        artifactCount: artifacts.length,
        stateJson: JSON.stringify(state),
        createdAt: ts,
        createdBy: actor,
        rolledBackAt: null,
      })
      .returning()
      .all();
    return row.id;
  }

  /**
   * Undo the most recent un-rolled-back apply: restore the install row, the artifact
   * baselines, and every entity's content — including un-trashing rows the update deleted
   * and trashing rows it created.
   */
  async rollback(campaignId: number, installId: number, user: RequestUser, role: Role): Promise<ModuleRollbackResult> {
    const ts = nowIso();
    const actor = auditActor(user);
    const outcome = this.db.transaction((tx) => {
      const install = this.installRow(tx, campaignId, installId);
      // "Newest un-rolled-back" is selected in SQL rather than by loading every candidate
      // and sorting in memory. Same row either way (the previous JS sort on `id` was already
      // deterministic), but the ordering now lives with the query and only one row is read.
      const snapshot = tx
        .select()
        .from(campaignModuleSnapshots)
        .where(and(eq(campaignModuleSnapshots.installId, install.id), isNull(campaignModuleSnapshots.rolledBackAt)))
        .orderBy(desc(campaignModuleSnapshots.id))
        .limit(1)
        .get();
      if (!snapshot) {
        throw new NotFoundException('There is no un-rolled-back module update to restore for this install.');
      }
      const state = parseJson<SnapshotState | null>(snapshot.stateJson, null);
      if (!state) throw new ConflictException('The stored rollback state for this update is unreadable.');

      const currentArtifacts = this.artifactRows(tx, install.id);
      const snapshotEntityIds = new Set(state.entities.map((e) => `${e.kind}:${e.entityId}`));

      // 1. Anything the update CREATED is not in the snapshot — trash it.
      let removedCount = 0;
      for (const row of currentArtifacts) {
        if (row.entityId == null) continue;
        if (snapshotEntityIds.has(`${row.kind}:${row.entityId}`)) continue;
        this.setEntityDeleted(tx, row.kind as ModuleArtifactKind, row.entityId, ts);
        removedCount += 1;
      }

      // 2. Restore artifact rows verbatim.
      tx.delete(campaignModuleArtifacts).where(eq(campaignModuleArtifacts.installId, install.id)).run();
      const idByArtifact = new Map<string, number>();
      for (const artifact of state.artifacts) {
        tx.insert(campaignModuleArtifacts)
          .values({
            installId: install.id,
            campaignId: install.campaignId,
            kind: artifact.kind,
            artifactKey: artifact.artifactKey,
            name: artifact.name,
            entityId: artifact.entityId,
            baselineHash: artifact.baselineHash,
            baselineJson: artifact.baselineJson,
            overlayJson: artifact.overlayJson,
            installedVersion: artifact.installedVersion,
            createdAt: ts,
            updatedAt: ts,
          })
          .run();
        if (artifact.entityId != null) idByArtifact.set(artifactId(artifact.kind, artifact.artifactKey), artifact.entityId);
      }

      // 3. Restore entity content, including un-trashing whatever the update deleted.
      let restoredCount = 0;
      let recreatedCount = 0;
      const liveByKind = new Map<ModuleArtifactKind, Map<number, EntityRow>>();
      for (const kind of MODULE_ARTIFACT_KINDS) {
        liveByKind.set(kind, this.entityRows(tx, install.campaignId, kind));
      }
      const restored: SnapshotState['entities'] = [];
      for (const entity of state.entities) {
        const live = liveByKind.get(entity.kind)?.get(entity.entityId);
        if (!live) {
          // Hard-deleted since the snapshot (purge). Nothing to restore into; skip rather
          // than minting a new id the snapshot's references would not point at.
          continue;
        }
        this.updateEntity(tx, entity.kind, entity.entityId, entity.content, ts);
        if (!entity.deleted && live.deletedAt != null) {
          this.setEntityDeleted(tx, entity.kind, entity.entityId, null);
          recreatedCount += 1;
        } else if (entity.deleted && live.deletedAt == null) {
          this.setEntityDeleted(tx, entity.kind, entity.entityId, ts);
        }
        restored.push(entity);
        restoredCount += 1;
      }
      // Second pass, now that every restored row is back at its snapshot content.
      for (const entity of restored) {
        this.resolveReferences(tx, entity.kind, entity.entityId, entity.content, idByArtifact);
      }

      // 4. Restore the install row and close out the snapshot.
      tx.update(campaignModuleInstalls)
        .set({
          moduleId: state.install.moduleId,
          name: state.install.name,
          version: state.install.version,
          description: state.install.description,
          license: state.install.license,
          sourceUrl: state.install.sourceUrl,
          authorsJson: state.install.authorsJson,
          compatibilityJson: state.install.compatibilityJson,
          dependenciesJson: state.install.dependenciesJson,
          manifestJson: state.install.manifestJson,
          originKind: state.install.originKind,
          originSourceUrl: state.install.originSourceUrl,
          upstreamModuleId: state.install.upstreamModuleId,
          upstreamVersion: state.install.upstreamVersion,
          forkedAt: state.install.forkedAt,
          // `detached` / `detachedAt` are DELIBERATELY not restored. Detaching is its own
          // deliberate, documented-as-permanent action and is not snapshotted, so replaying
          // a pre-detach snapshot over it would silently re-attach an install the table had
          // chosen to sever — an undo of something this rollback never did. Nothing that IS
          // snapshotted can change the flag: apply is blocked outright on a detached install.
          updatedAt: ts,
        })
        .where(eq(campaignModuleInstalls.id, install.id))
        .run();
      tx.update(campaignModuleSnapshots)
        .set({ rolledBackAt: ts })
        .where(eq(campaignModuleSnapshots.id, snapshot.id))
        .run();

      const refreshed = this.installRow(tx, campaignId, installId);
      return {
        install: this.toInstall(tx, refreshed),
        snapshot: this.toSnapshot({ ...snapshot, rolledBackAt: ts }),
        restoredCount,
        recreatedCount,
        removedCount,
      } satisfies ModuleRollbackResult;
    });

    await this.audit.log({
      actor,
      actorRole: role,
      action: 'campaign_module.rollback',
      entityType: 'campaign_module',
      entityId: installId,
      campaignId,
      detail: `restored ${outcome.restoredCount} artifact(s) to ${outcome.install.version}`,
    });
    return outcome;
  }

  // ------------------------------------------------------------------ fork / detach

  /**
   * Fork this install in place: the campaign's copy becomes an independently identified
   * module (fresh UUID) that RETAINS its ancestry in `upstream_module_id`/`upstream_version`.
   * A fork can still preview and merge upstream corrections — that is the divergent-fork
   * case the issue calls for — but it publishes under its own identity.
   */
  async fork(
    campaignId: number,
    installId: number,
    request: ModuleForkRequest,
    user: RequestUser,
    role: Role,
  ): Promise<ModuleInstall> {
    if (request.version != null && !isValidSemver(request.version)) {
      throw new BadRequestException(`Fork version "${request.version}" is not valid semver.`);
    }
    const ts = nowIso();
    const actor = auditActor(user);
    const forkId = randomUUID();
    const result = this.db.transaction((tx) => {
      const install = this.installRow(tx, campaignId, installId);
      if (install.detached) {
        throw new ConflictException('This install is detached; there is no upstream identity left to fork from.');
      }
      this.writeSnapshot(tx, install, install.version, 'fork', actor, ts);
      const name = request.name ?? `${install.name} (fork)`;
      const version = request.version ?? install.version;
      const manifest = parseJson<Record<string, unknown>>(install.manifestJson, {});
      manifest.moduleId = forkId;
      manifest.name = name;
      manifest.version = version;
      tx.update(campaignModuleInstalls)
        .set({
          moduleId: forkId,
          name,
          version,
          originKind: 'fork',
          upstreamModuleId: install.moduleId,
          upstreamVersion: install.version,
          forkedAt: ts,
          manifestJson: JSON.stringify(manifest),
          updatedAt: ts,
        })
        .where(eq(campaignModuleInstalls.id, install.id))
        .run();
      return this.toInstall(tx, this.installRow(tx, campaignId, installId));
    });

    await this.audit.log({
      actor,
      actorRole: role,
      action: 'campaign_module.fork',
      entityType: 'campaign_module',
      entityId: installId,
      campaignId,
      detail: `forked ${result.lineage.upstreamModuleId} ${result.lineage.upstreamVersion} as ${forkId}`,
    });
    return result;
  }

  /**
   * Permanently sever upstream updates. Lineage is deliberately RETAINED — the table still
   * knows what this content came from, they just stop receiving corrections for it.
   */
  async detach(campaignId: number, installId: number, user: RequestUser, role: Role): Promise<ModuleInstall> {
    const ts = nowIso();
    const install = this.installRow(this.db, campaignId, installId);
    if (install.detached) return this.toInstall(this.db, install);
    this.db
      .update(campaignModuleInstalls)
      .set({ detached: true, detachedAt: ts, updatedAt: ts })
      .where(eq(campaignModuleInstalls.id, install.id))
      .run();
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'campaign_module.detach',
      entityType: 'campaign_module',
      entityId: installId,
      campaignId,
      detail: `${install.name} ${install.version} (${install.moduleId})`,
    });
    return this.toInstall(this.db, this.installRow(this.db, campaignId, installId));
  }

  // ------------------------------------------------------------------ bulk dry run

  /**
   * Bulk dry run across selected tables. Purely read-only: a publisher (or an organized-play
   * coordinator running many tables) sees, per campaign, whether the new version lands clean,
   * conflicts, or is blocked — before touching anything.
   *
   * `allowed` is the set of campaign ids the caller has already been authorized for by the
   * controller; everything else is reported as skipped rather than silently omitted.
   */
  async bulkPreview(
    request: ModuleBulkPreviewRequest,
    allowed: ReadonlySet<number>,
  ): Promise<ModuleBulkPreview> {
    this.validatePackage(request.package, 'update');
    const moduleId = request.package.manifest.moduleId;
    const plans: ModuleUpdatePlan[] = [];
    const skipped: ModuleBulkPreviewSkip[] = [];
    const updateRequest: ModuleUpdateRequest = {
      package: request.package,
      onConflict: 'skip',
      onUpstreamDelete: 'delete',
      resolutions: {},
      dryRun: true,
    };

    for (const campaignId of request.campaignIds) {
      const campaign = this.db
        .select({ id: campaigns.id, name: campaigns.name })
        .from(campaigns)
        .where(eq(campaigns.id, campaignId))
        .limit(1)
        .all()[0];
      if (!campaign) {
        skipped.push({ campaignId, campaignName: '', code: 'not_found', message: 'Campaign does not exist.' });
        continue;
      }
      if (!allowed.has(campaignId)) {
        skipped.push({
          campaignId,
          campaignName: campaign.name,
          code: 'forbidden',
          message: 'You are not a dm of this campaign.',
        });
        continue;
      }
      // Match the install on the package UUID OR on a fork's recorded upstream, so forked
      // tables are included in a publisher's bulk dry run instead of vanishing from it.
      const installs = this.db
        .select()
        .from(campaignModuleInstalls)
        .where(eq(campaignModuleInstalls.campaignId, campaignId))
        .all()
        .filter((row) => row.moduleId === moduleId || row.upstreamModuleId === moduleId);
      if (installs.length === 0) {
        skipped.push({
          campaignId,
          campaignName: campaign.name,
          code: 'not_installed',
          message: `Module ${moduleId} is not installed in this campaign.`,
        });
        continue;
      }
      for (const install of installs) {
        if (install.detached) {
          skipped.push({
            campaignId,
            campaignName: campaign.name,
            code: 'detached',
            message: `Install ${install.id} was detached from its source.`,
          });
          continue;
        }
        plans.push(this.buildPlan(this.db, install, request.package, updateRequest));
      }
    }

    return {
      app: 'campfire',
      kind: 'campaign-module-bulk-update-preview',
      formatVersion: MODULE_UPDATE_PLAN_FORMAT_VERSION,
      moduleId,
      toVersion: request.package.manifest.version,
      plans,
      skipped,
      cleanCount: plans.filter((p) => p.canApply && p.conflictCount === 0).length,
      conflictedCount: plans.filter((p) => p.canApply && p.conflictCount > 0).length,
      blockedCount: plans.filter((p) => !p.canApply).length,
      createdAt: nowIso(),
    };
  }

  /**
   * Every campaign that has `moduleId` installed (directly or as the upstream of a fork).
   * Discovery for the bulk dry run — without it a coordinator would have to guess campaign
   * ids. The controller filters the result down to campaigns the caller is a dm of.
   */
  async campaignsWithModule(moduleId: string): Promise<Array<{ campaignId: number; campaignName: string; installId: number; version: string; forked: boolean; detached: boolean }>> {
    const rows = this.db
      .select({
        campaignId: campaignModuleInstalls.campaignId,
        campaignName: campaigns.name,
        installId: campaignModuleInstalls.id,
        version: campaignModuleInstalls.version,
        moduleId: campaignModuleInstalls.moduleId,
        upstreamModuleId: campaignModuleInstalls.upstreamModuleId,
        detached: campaignModuleInstalls.detached,
      })
      .from(campaignModuleInstalls)
      .innerJoin(campaigns, eq(campaigns.id, campaignModuleInstalls.campaignId))
      .all();
    return rows
      .filter((r) => r.moduleId === moduleId || r.upstreamModuleId === moduleId)
      .map((r) => ({
        campaignId: r.campaignId,
        campaignName: r.campaignName,
        installId: r.installId,
        version: r.version,
        forked: r.moduleId !== moduleId,
        detached: r.detached,
      }));
  }
}
