import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, desc, eq, isNotNull, like, sql } from 'drizzle-orm';
import type {
  Attachment,
  AttachmentKind,
  Role,
  StorageCleanupResult,
  StorageStats,
} from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { attachments, auditLog, campaigns, characters, encounters } from '../../db/schema';
import { nowIso } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import { persistedFogConcealsPixels } from '../../common/fog';
import { generatePngThumbnail } from './thumbnail';
import { sanitizeAttachmentFilename } from './filename';
import {
  ATTACHMENT_STATE_COMMITTED,
  ATTACHMENT_STATE_RESERVED,
} from './attachment.constants';

/** image/png|jpeg|webp only — matches the multer fileFilter in attachments.controller.ts. */
export const ALLOWED_MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024; // 32MB

/**
 * Mime → extension for SERVER-GENERATED attachments only (issue #306). Kept separate
 * from the ALLOWED_MIME_TO_EXT upload allowlist above: uploads stay png/jpeg/webp
 * (raster, magic-byte sniffed), while the procedural map generator produces SVG whose
 * bytes the server itself authors (no untrusted upload, so no sniff needed). filePath()
 * consults both maps so a generated .svg map resolves to the right on-disk name.
 */
export const GENERATED_MIME_TO_EXT: Record<string, string> = {
  'image/svg+xml': 'svg',
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RESERVED = ATTACHMENT_STATE_RESERVED;
const COMMITTED = ATTACHMENT_STATE_COMMITTED;
const STAGE_SUFFIX = '.stage';

export { ATTACHMENT_STATE_COMMITTED, ATTACHMENT_STATE_RESERVED } from './attachment.constants';

/**
 * Content sniffing for the three allowed image types (dependency-free — the
 * signatures are stable and tiny, no need for a `file-type`-style package).
 * Returns the detected mime, or null when the bytes match none of them.
 *
 *  - PNG:  89 50 4E 47 0D 0A 1A 0A
 *  - JPEG: FF D8 FF
 *  - WebP: "RIFF" <4-byte size> "WEBP"
 */
export function sniffImageMime(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function uploadsRoot(): string {
  const dataDir = process.env.DATA_DIR ?? path.resolve(__dirname, '..', '..', '..', 'data');
  return path.join(dataDir, 'uploads');
}

function toDomain(row: typeof attachments.$inferSelect): Attachment {
  return {
    id: row.id,
    campaignId: row.campaignId,
    uploaderUserId: row.uploaderUserId,
    kind: row.kind as AttachmentKind,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    hidden: row.hidden,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Secure default for a freshly uploaded attachment's visibility (issue #97):
 * 'map'/'image' are DM prep material and start hidden (DM-only) so an uploaded
 * handout isn't readable by the party the instant it lands; 'portrait' is a
 * player-facing asset and starts visible.
 */
function defaultHiddenForKind(kind: AttachmentKind): boolean {
  return kind !== 'portrait';
}

@Injectable()
export class AttachmentsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
  ) {}

  /**
   * A process interruption can only strand `reserved` rows. They are deliberately
   * not resumable: the request never received a committed result, and the audit row
   * was never committed, so recovery rolls them back and lets the caller retry.
   * Final and staged names are both removed before the reservation row is released.
   */
  onApplicationBootstrap(): void {
    try {
      this.recoverPendingPublications();
    } catch (err) {
      // Filesystem/permission failures must not prevent the rest of the server from
      // starting. Per-row recovery already logs and keeps unrecoverable reservations;
      // this catch covers top-level IO (e.g. unreadable uploads root).
      this.logger.error(
        `Attachment publication recovery failed during startup: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Roll back every interrupted publication. Public so whole-server restore can run
   * the same protocol immediately after swapping in a backup, without waiting for a
   * process restart. Returns the number of reservation rows released.
   *
   * Dangling `.stage` scrubbing: ordinary recovery with reserved rows only walks the
   * campaigns that had reservations. Restore passes `{ scrubDanglingStages: true }`
   * for a full-root scan because a backup cut can leave stage files under any
   * campaign without a matching reservation. Scrubbing never deletes a stage whose
   * attachment id is still `reserved` in that same campaign. DB reservation
   * rollback runs before any scrub so the event-loop-blocking FS walk stays gated.
   */
  recoverPendingPublications(opts?: { scrubDanglingStages?: boolean }): number {
    // Restore can replace committed bytes while reusing an attachment id/path.
    // Never carry a pre-restore content hash into the recovered filesystem.
    this.etagCache.clear();
    const pending = this.db.select().from(attachments).where(eq(attachments.state, RESERVED)).all();
    const pendingCampaignIds = [...new Set(pending.map((row) => row.campaignId))];
    let recovered = 0;
    for (const row of pending) {
      try {
        this.rollbackReservation(row);
        recovered += 1;
      } catch (err) {
        // Keep the row (and therefore its quota charge) when durable cleanup could
        // not be proved. A later restart/restore retries instead of admitting bytes
        // that might make the campaign exceed quota on disk.
        this.logger.error(
          `Could not recover attachment reservation ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (opts?.scrubDanglingStages === true) {
      this.removeDanglingStageFiles();
    } else if (pendingCampaignIds.length > 0) {
      this.removeDanglingStageFiles({ campaignIds: pendingCampaignIds });
    }
    if (recovered > 0) this.logger.warn(`Recovered ${recovered} interrupted attachment publication(s)`);
    return recovered;
  }

  /** Absolute path a stored attachment's bytes live at, given its DB row. */
  filePath(row: { campaignId: number; id: number; mime: string }): string {
    const ext = ALLOWED_MIME_TO_EXT[row.mime] ?? GENERATED_MIME_TO_EXT[row.mime] ?? 'bin';
    return path.join(uploadsRoot(), String(row.campaignId), `${row.id}.${ext}`);
  }

  /** Absolute path a generated thumbnail (always PNG) is cached at on disk. */
  private thumbPath(row: { campaignId: number; id: number }): string {
    return path.join(uploadsRoot(), String(row.campaignId), `${row.id}.thumb.png`);
  }

  /** Same-filesystem stage path so link(stage, final) + unlink(stage) can publish. */
  stagePath(row: { campaignId: number; id: number; mime: string }): string {
    return `${this.filePath(row)}${STAGE_SUFFIX}`;
  }

  /**
   * Strong ETag for the bytes at `filePath` — sha256 of the file content, hex,
   * quoted per RFC 7232. Attachment bytes are immutable for a given path (written
   * once at create, deleted with the row), so the digest is memoised per path for
   * the process lifetime rather than re-hashing on every request.
   */
  private etagCache = new Map<string, string>();
  private etagForPath(filePath: string): string {
    const cached = this.etagCache.get(filePath);
    if (cached) return cached;
    const hash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    const etag = `"${hash}"`;
    this.etagCache.set(filePath, etag);
    return etag;
  }

  /**
   * Short authorization-aware version token for an attachment URL (issue #498).
   *
   * Protected attachments are served with a long-lived browser cache, so the URL
   * itself must change whenever the bytes OR the user's authorization to see them
   * could change — otherwise a stale cached entry is served straight from the
   * browser HTTP cache without the membership/hidden check ever running. The token
   * folds together three row-level signals, all of which the client already
   * receives in the attachment list (no extra file hashing on list/get):
   *
   *   - `id` — a re-upload always creates a new row with a new id, so the URL
   *     changes automatically;
   *   - `hidden` — toggling reveal/hide is an authorization change that must
   *     invalidate any cached URL even though the bytes are identical; AND
   *   - `updatedAt` — covers the delete-then-restore case where SQLite reuses an
   *     id: the restored row is a fresh insert with a new updatedAt, so the token
   *     changes even though the id collides with the deleted row.
   *
   * The web client (apps/web/src/components/ImageUpload.tsx → attachmentVersionToken)
   * folds the SAME three fields with its own browser-side hash. The two do NOT need
   * to produce identical bytes — `?v=` is a client-controlled cache-buster the server
   * never validates; what matters is that BOTH are deterministic functions of
   * (id, hidden, updatedAt), so a given authorization state yields a stable URL and
   * a changed state yields a different one (modulo the extremely-unlikely 64-bit
   * hash collision noted below). The server helper exists as the canonical
   * implementation for any non-web caller (e.g. an MCP/REST consumer) and for tests.
   *
   * Returns the first 16 hex chars (64 bits) — plenty of entropy to make a stale
   * URL effectively unguessable, short enough to keep the query string tidy.
   */
  versionToken(row: { id: number; hidden: boolean; updatedAt: string }): string {
    const hash = crypto.createHash('sha256').update(`${row.id}|${row.hidden ? '1' : '0'}|${row.updatedAt}`).digest('hex');
    return hash.slice(0, 16);
  }

  /**
   * Resolve the file to serve for a GET, honouring the `?size=thumb` variant.
   * Returns the on-disk path plus the metadata needed to set response headers.
   *
   * For `thumb`, a downscaled PNG is generated once and cached on disk next to the
   * original. When a thumbnail can't be produced (source already small, or a
   * non-PNG / unsupported PNG — see thumbnail.ts) the original bytes are served
   * instead: correct, just without the byte savings for those formats.
   */
  resolveFile(
    row: { campaignId: number; id: number; mime: string; filename: string; size: number },
    variant: 'original' | 'thumb',
  ): { path: string; mime: string; size: number; etag: string } {
    const originalPath = this.filePath(row);

    if (variant === 'thumb') {
      const thumb = this.thumbPath(row);
      if (!fs.existsSync(thumb)) {
        const generated = generatePngThumbnail(fs.readFileSync(originalPath));
        if (generated) fs.writeFileSync(thumb, generated);
      }
      if (fs.existsSync(thumb)) {
        return { path: thumb, mime: 'image/png', size: fs.statSync(thumb).size, etag: this.etagForPath(thumb) };
      }
      // Fall through: no thumbnail available, serve the original.
    }

    return { path: originalPath, mime: row.mime, size: row.size, etag: this.etagForPath(originalPath) };
  }

  async getRowOrThrow(id: number) {
    const [row] = await this.db
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, id), eq(attachments.state, COMMITTED)))
      .limit(1);
    if (!row) throw new NotFoundException(`Attachment ${id} not found`);
    return row;
  }

  /**
   * All attachment rows for a campaign, oldest first (metadata only — no bytes).
   * Used by the export module to enumerate maps/portraits/images so the export can
   * embed the actual files rather than dangling references (issue #87).
   */
  async listRowsForCampaign(campaignId: number) {
    return this.db
      .select()
      .from(attachments)
      .where(and(eq(attachments.campaignId, campaignId), eq(attachments.state, COMMITTED)))
      .orderBy(attachments.id);
  }

  /** True when the attachment's bytes exist on disk (cheap stat, no read). */
  hasBytesOnDisk(row: { campaignId: number; id: number; mime: string }): boolean {
    return fs.existsSync(this.filePath(row));
  }

  /**
   * Read the stored bytes for an attachment row, or `null` when the file is missing
   * on disk (row-without-file — the same shape #84 guards the GET route against).
   * Callers embedding attachments in an export use this to skip missing files
   * gracefully instead of crashing.
   */
  readBytesIfPresent(row: { campaignId: number; id: number; mime: string }): Buffer | null {
    const filePath = this.filePath(row);
    if (!fs.existsSync(filePath)) return null;
    try {
      return fs.readFileSync(filePath);
    } catch {
      return null;
    }
  }

  async getOrThrow(id: number): Promise<Attachment> {
    const row = await this.getRowOrThrow(id);
    return toDomain(row);
  }

  /**
   * Whether an attachment backs an encounter whose active fog still conceals source
   * pixels. This is independent of attachment.hidden: a legacy/reused map may already
   * be a revealed handout, but enabling fog must close every raw-byte shortcut.
   */
  async isFogProtectedEncounterMap(attachmentId: number, campaignId: number): Promise<boolean> {
    const rows = await this.db
      .select({ fog: encounters.fog })
      .from(encounters)
      .where(
        and(
          eq(encounters.mapAttachmentId, attachmentId),
          eq(encounters.campaignId, campaignId),
          isNotNull(encounters.fog),
        ),
      );
    return rows.some((row) => persistedFogConcealsPixels(row.fog));
  }

  /** Set of raw attachments currently protected by at least one fogged encounter. */
  async fogProtectedMapIdsForCampaign(campaignId: number): Promise<Set<number>> {
    // persistedFogConcealsPixels is always false when fog/mapAttachmentId is null, so
    // push those predicates into SQL and skip loading map-less / fog-less encounters.
    const rows = await this.db
      .select({ mapAttachmentId: encounters.mapAttachmentId, fog: encounters.fog })
      .from(encounters)
      .where(
        and(
          eq(encounters.campaignId, campaignId),
          isNotNull(encounters.mapAttachmentId),
          isNotNull(encounters.fog),
        ),
      );
    const ids = new Set<number>();
    for (const row of rows) {
      if (row.mapAttachmentId == null) continue;
      if (persistedFogConcealsPixels(row.fog)) ids.add(row.mapAttachmentId);
    }
    return ids;
  }

  /**
   * Byte-copy an attachment into a new row in the same campaign (issue #463).
   * Used when fog-protecting a battle map that is also the shared campaign region
   * map — the encounter retargets to the clone so the region map stays player-visible.
   */
  async duplicate(
    id: number,
    user: RequestUser,
    role: Role,
    opts?: { filenamePrefix?: string },
  ): Promise<Attachment> {
    const row = await this.getRowOrThrow(id);
    const bytes = this.readBytesIfPresent(row);
    if (!bytes) throw new NotFoundException(`Attachment ${id} file is missing`);
    const prefix = opts?.filenamePrefix ?? '';
    if (row.mime === 'image/svg+xml') {
      return this.createGenerated(
        row.campaignId,
        row.kind as AttachmentKind,
        { filename: `${prefix}${row.filename}`, mime: row.mime, bytes },
        user,
        role,
      );
    }
    return this.create(
      row.campaignId,
      row.kind as AttachmentKind,
      {
        originalname: `${prefix}${row.filename}`,
        mimetype: row.mime,
        size: bytes.length,
        buffer: bytes,
      },
      user,
      role,
    );
  }

  /**
   * All attachments for a campaign, newest first. Visibility filtering (dropping
   * hidden rows for non-DM) is the CALLER's job — the controller applies
   * filterHidden() with the requester's role, mirroring the quests/npcs list
   * pattern (issue #42). Returned as domain objects.
   */
  async listForCampaign(campaignId: number): Promise<Attachment[]> {
    const rows = await this.db
      .select()
      .from(attachments)
      .where(and(eq(attachments.campaignId, campaignId), eq(attachments.state, COMMITTED)))
      .orderBy(desc(attachments.id));
    return rows.map(toDomain);
  }

  /**
   * Stage / un-stage a handout (issue #97). dm-only (enforced by the controller's
   * requireRole). Setting hidden=false is the "reveal" moment that makes the file
   * fetchable by the whole party; hidden=true pulls it back to DM-only. Idempotent.
   */
  async setHidden(id: number, hidden: boolean, user: RequestUser, role: Role): Promise<Attachment> {
    const existing = await this.getRowOrThrow(id);
    const [row] = await this.db
      .update(attachments)
      .set({ hidden, updatedAt: nowIso() })
      .where(eq(attachments.id, id))
      .returning();

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: hidden ? 'attachment.hide' : 'attachment.reveal',
      entityType: 'attachment',
      entityId: id,
      campaignId: existing.campaignId,
      detail: existing.kind,
    });

    return toDomain(row);
  }

  /**
   * Persist a multipart upload through the reservation/publication protocol. The
   * declared mimetype is never trusted on its own: the actual bytes must match it.
   */
  async create(
    campaignId: number,
    kind: AttachmentKind,
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
    user: RequestUser,
    role: Role,
  ): Promise<Attachment> {
    const sniffed = sniffImageMime(file.buffer);
    if (sniffed !== file.mimetype) {
      throw new BadRequestException(
        `File content does not match the declared type ${file.mimetype} — allowed: image/png, image/jpeg, image/webp`,
      );
    }

    return this.createAndPublish(
      campaignId,
      kind,
      { filename: file.originalname, mime: file.mimetype, bytes: file.buffer },
      user,
      role,
      'attachment.upload',
    );
  }

  /**
   * Persist a SERVER-GENERATED attachment (issue #306 — the procedural battle-map
   * generator). Unlike create(), the bytes are authored by the server (not an untrusted
   * multipart upload), so there is no magic-byte sniff — the mime is trusted from the
   * caller (SVG for generated maps). Still enforces the per-campaign storage quota (#24)
   * and defaults visibility per kind (#97): a 'map' lands hidden=true (DM-only prep), so a
   * generated map never auto-leaks to players (regression-guard for #259) until revealed.
   */
  async createGenerated(
    campaignId: number,
    kind: AttachmentKind,
    file: { filename: string; mime: string; bytes: Buffer },
    user: RequestUser,
    role: Role,
  ): Promise<Attachment> {
    return this.createAndPublish(
      campaignId,
      kind,
      file,
      user,
      role,
      'attachment.generate',
    );
  }

  /**
   * Reserve quota, durably publish bytes, then atomically commit metadata + audit.
   *
   * Ordering is load-bearing because SQLite and the filesystem cannot share a
   * transaction:
   *   1. one conditional INSERT creates a quota-counted, non-public reservation;
   *   2. write + fsync a stage file in the destination directory;
   *   3. hard-link stage→final (fails if final exists), unlink stage, fsync dir;
   *   4. in one SQLite transaction, insert the audit row and mark committed.
   *
   * A handled failure rolls back files and metadata synchronously. A process death
   * before step 4 leaves only a reservation, which startup/restore recovery rolls
   * back. A process death after step 4 leaves a durable final file and committed row.
   * A crash between link and unlink can leave both names pointing at the same inode;
   * recovery removes the stage name.
   */
  private async createAndPublish(
    campaignId: number,
    kind: AttachmentKind,
    file: { filename: string; mime: string; bytes: Buffer },
    user: RequestUser,
    role: Role,
    auditAction: 'attachment.upload' | 'attachment.generate',
  ): Promise<Attachment> {
    const row = await this.reserveQuota(campaignId, kind, file, user);
    try {
      this.stageAndPublish(row, file.bytes);
      const committed = this.commitPublication(row, user, role, auditAction);
      return toDomain(committed);
    } catch (err) {
      try {
        this.rollbackReservation(row);
      } catch (cleanupErr) {
        this.logger.error(
          `Attachment ${row.id} publication failed and durable rollback could not complete: ${
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
          }`,
        );
      }
      throw err;
    }
  }

  /**
   * Atomic quota reservation. The subquery counts both committed and reserved rows,
   * and the quota predicate lives in the INSERT statement itself, so concurrent
   * boundary requests cannot both pass a stale SUM/check window.
   */
  private async reserveQuota(
    campaignId: number,
    kind: AttachmentKind,
    file: { filename: string; mime: string; bytes: Buffer },
    user: RequestUser,
  ): Promise<typeof attachments.$inferSelect> {
    const size = file.bytes.length;
    const ts = nowIso();
    // Issue #630: grapheme-safe truncation + path/control scrubbing (not bare
    // String#slice, which can bisect a surrogate pair).
    const filename = sanitizeAttachmentFilename(file.filename);
    const inserted = this.db.all<{
      id: number;
      campaignId: number;
      uploaderUserId: string;
      kind: string;
      filename: string;
      mime: string;
      size: number;
      hidden: number;
      state: string;
      createdAt: string;
      updatedAt: string;
    }>(sql`
      INSERT INTO attachments (
        campaign_id, uploader_user_id, kind, filename, mime, size, hidden, state, created_at, updated_at
      )
      SELECT
        ${campaignId}, ${user.id}, ${kind}, ${filename}, ${file.mime}, ${size},
        ${defaultHiddenForKind(kind) ? 1 : 0}, ${RESERVED}, ${ts}, ${ts}
      FROM campaigns AS campaign
      WHERE campaign.id = ${campaignId}
        AND (
          campaign.storage_quota_bytes IS NULL
          OR coalesce((
            SELECT sum(existing.size)
            FROM attachments AS existing
            WHERE existing.campaign_id = campaign.id
          ), 0) + ${size} <= campaign.storage_quota_bytes
        )
      RETURNING
        id,
        campaign_id AS campaignId,
        uploader_user_id AS uploaderUserId,
        kind,
        filename,
        mime,
        size,
        hidden,
        state,
        created_at AS createdAt,
        updated_at AS updatedAt
    `);

    if (inserted.length === 0) {
      const [camp] = await this.db
        .select({ quota: campaigns.storageQuotaBytes })
        .from(campaigns)
        .where(eq(campaigns.id, campaignId))
        .limit(1);
      if (!camp) throw new NotFoundException(`Campaign ${campaignId} not found`);

      const usage = this.db.get<{ committed: number; reserved: number }>(sql`
        SELECT
          coalesce(sum(CASE WHEN state = ${COMMITTED} THEN size ELSE 0 END), 0) AS committed,
          coalesce(sum(CASE WHEN state = ${RESERVED} THEN size ELSE 0 END), 0) AS reserved
        FROM attachments
        WHERE campaign_id = ${campaignId}
      `);
      throw new PayloadTooLargeException(
        `Upload would exceed this campaign's storage quota (${camp.quota} bytes; ` +
          `${Number(usage?.committed ?? 0)} committed, ${Number(usage?.reserved ?? 0)} reserved).`,
      );
    }

    return { ...inserted[0], hidden: Boolean(inserted[0].hidden) } as typeof attachments.$inferSelect;
  }

  /**
   * Write and fsync a stage file, hard-link it to the final name (no-clobber),
   * unlink the stage name, then fsync the directory. Synchronous disk IO is
   * intentional: durability must finish before metadata becomes visible.
   */
  private stageAndPublish(row: typeof attachments.$inferSelect, bytes: Buffer): void {
    const finalPath = this.filePath(row);
    const stagePath = this.stagePath(row);
    const dir = path.dirname(finalPath);
    this.ensurePublicationDirectory(dir);

    let fd: number | undefined;
    try {
      fd = fs.openSync(stagePath, 'wx', 0o600);
      fs.writeFileSync(fd, bytes);
      const stagedSize = fs.fstatSync(fd).size;
      if (stagedSize !== bytes.length) {
        throw new Error(`Short attachment write: expected ${bytes.length} bytes, staged ${stagedSize}`);
      }
      fs.fsyncSync(fd);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }

    // Publish without clobbering: hard-link stage→final fails with EEXIST if the
    // destination already exists (existsSync+rename races under restore/parallel
    // publish). Then unlink the stage name.
    try {
      fs.linkSync(stagePath, finalPath);
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as NodeJS.ErrnoException).code)
          : '';
      try {
        fs.rmSync(stagePath, { force: true });
      } catch {
        /* ignore */
      }
      if (code === 'EEXIST') {
        throw new Error(`Attachment publication refused: ${finalPath} already exists`, {
          cause: err,
        });
      }
      throw err;
    }
    fs.unlinkSync(stagePath);
    this.fsyncDirectory(dir);
  }

  /** Ensure newly-created directory entries are themselves durable. */
  private ensurePublicationDirectory(dir: string): void {
    const root = uploadsRoot();
    // recursive mkdir is race-safe under concurrent uploads (EEXIST is not thrown).
    const rootExisted = fs.existsSync(root);
    fs.mkdirSync(root, { recursive: true });
    if (!rootExisted) this.fsyncDirectory(path.dirname(root));
    const dirExisted = fs.existsSync(dir);
    fs.mkdirSync(dir, { recursive: true });
    if (!dirExisted) this.fsyncDirectory(root);
  }

  /**
   * Best-effort directory fsync. Unsupported on Windows and some filesystems
   * (EPERM/EINVAL/EISDIR/ENOTSUP); durability stays strict where fsync works.
   */
  private fsyncDirectory(dir: string): void {
    if (process.platform === 'win32') return;
    let fd: number | undefined;
    try {
      fd = fs.openSync(dir, 'r');
      fs.fsyncSync(fd);
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as NodeJS.ErrnoException).code)
          : '';
      if (code === 'EPERM' || code === 'EINVAL' || code === 'EISDIR' || code === 'ENOTSUP') {
        this.logger.warn(
          `Directory fsync unsupported for ${dir} (${code}); continuing without it`,
        );
        return;
      }
      throw err;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore close errors after fsync failure */
        }
      }
    }
  }

  /** Commit the public state and its audit record together, or neither. */
  private commitPublication(
    row: typeof attachments.$inferSelect,
    user: RequestUser,
    role: Role,
    action: 'attachment.upload' | 'attachment.generate',
  ): typeof attachments.$inferSelect {
    return this.db.transaction((tx) => {
      tx.insert(auditLog)
        .values({
          actor: auditActor(user),
          actorRole: role,
          action,
          entityType: 'attachment',
          entityId: row.id,
          campaignId: row.campaignId,
          detail: row.kind,
          createdAt: nowIso(),
        })
        .run();
      const committed = tx
        .update(attachments)
        .set({ state: COMMITTED, updatedAt: nowIso() })
        .where(and(eq(attachments.id, row.id), eq(attachments.state, RESERVED)))
        .returning()
        .get();
      if (!committed) throw new Error(`Attachment reservation ${row.id} is no longer publishable`);
      return committed;
    });
  }

  /**
   * Remove durable file artifacts first, then release the quota reservation row.
   *
   * Only acts while the DB row is still `reserved`. A concurrent whole-server restore
   * can reopen the DB/uploads tree between reserve and commit, so the same attachment
   * id may now point at a restored committed row — deleting its final path would wipe
   * restored bytes while metadata remains.
   */
  private rollbackReservation(row: typeof attachments.$inferSelect): void {
    const current = this.db
      .select({ id: attachments.id, state: attachments.state })
      .from(attachments)
      .where(eq(attachments.id, row.id))
      .get();
    if (!current || current.state !== RESERVED) {
      this.logger.warn(
        `Skipping attachment reservation rollback for ${row.id}: ${
          current ? `state is ${current.state}` : 'row no longer exists'
        }`,
      );
      return;
    }

    const finalPath = this.filePath(row);
    const dir = path.dirname(finalPath);
    for (const candidate of [this.stagePath(row), finalPath, this.thumbPath(row)]) {
      fs.rmSync(candidate, { force: true });
      this.etagCache.delete(candidate);
    }
    if (fs.existsSync(dir)) this.fsyncDirectory(dir);
    this.db
      .delete(attachments)
      .where(and(eq(attachments.id, row.id), eq(attachments.state, RESERVED)))
      .run();
  }

  /**
   * Remove stage artifacts that have no reservation row (e.g. an unusual backup cut).
   * When `campaignIds` is set, only those campaign directories are scanned.
   * Stage files are kept only when their parsed id is still `reserved` in the same
   * campaign directory — a reserved id in another campaign must not retain a stray
   * stage here (restore scrub / orphan cleanup).
   */
  private removeDanglingStageFiles(opts?: { campaignIds?: number[] }): void {
    const root = uploadsRoot();
    if (!fs.existsSync(root)) return;

    const reservedByCampaign = new Map<number, Set<number>>();
    for (const row of this.db
      .select({ id: attachments.id, campaignId: attachments.campaignId })
      .from(attachments)
      .where(eq(attachments.state, RESERVED))
      .all()) {
      let ids = reservedByCampaign.get(row.campaignId);
      if (!ids) {
        ids = new Set<number>();
        reservedByCampaign.set(row.campaignId, ids);
      }
      ids.add(row.id);
    }

    const campaignNames =
      opts?.campaignIds !== undefined
        ? opts.campaignIds.map(String)
        : fs
            .readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);

    for (const campaignName of campaignNames) {
      const dir = path.join(root, campaignName);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
      const campaignId = Number(campaignName);
      const reservedInCampaign = Number.isInteger(campaignId)
        ? reservedByCampaign.get(campaignId)
        : undefined;
      let removed = false;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        // Final names are `<id>.<ext>`; staged names are `<id>.<ext>.stage`.
        const match = /^(\d+)\.[^.]+\.stage$/.exec(entry.name);
        if (!match) continue;
        const id = Number(match[1]);
        if (Number.isInteger(id) && reservedInCampaign?.has(id)) continue;
        try {
          fs.rmSync(path.join(dir, entry.name), { force: true });
          removed = true;
        } catch (err) {
          this.logger.error(
            `Could not remove staged attachment artifact ${path.join(dir, entry.name)}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      if (removed) {
        try {
          this.fsyncDirectory(dir);
        } catch (err) {
          this.logger.error(
            `Could not fsync attachment directory ${dir} after recovery: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
  }

  /**
   * Uploader or dm may delete; others 403. Removes both the DB row and the on-disk file,
   * and clears any dangling references pointing at it in the same transaction:
   *  - campaign.mapAttachmentId, if it was this attachment (numeric FK).
   *  - encounter.mapAttachmentId for every encounter whose battle map was this
   *    attachment (issue #695 — one attachment may be the map for several
   *    encounters, so all of them are cleared in the same statement).
   *  - character.portraitUrl, if it points at this attachment's file route
   *    (`.../attachments/<id>/file` — portraitUrl is a resolved URL string, not a
   *    numeric FK, so it's matched by suffix rather than equality).
   * Without this, deleting an attachment still in use left the campaign map / encounter
   * map / character portrait pointing at a now-404ing file.
   */
  async remove(id: number, user: RequestUser, role: Role): Promise<void> {
    const existing = await this.getRowOrThrow(id);
    if (role !== 'dm' && existing.uploaderUserId !== user.id) {
      throw new ForbiddenException('Only the uploader or dm may delete this attachment');
    }

    const portraitSuffix = `%/attachments/${id}/file`;
    this.db.transaction((tx) => {
      tx.delete(attachments).where(eq(attachments.id, id)).run();
      tx.update(campaigns).set({ mapAttachmentId: null }).where(eq(campaigns.mapAttachmentId, id)).run();
      tx.update(encounters).set({ mapAttachmentId: null }).where(eq(encounters.mapAttachmentId, id)).run();
      tx.update(characters).set({ portraitUrl: null }).where(like(characters.portraitUrl, portraitSuffix)).run();
    });

    const filePath = this.filePath(existing);
    const thumbPath = this.thumbPath(existing);
    this.etagCache.delete(filePath);
    this.etagCache.delete(thumbPath);
    for (const p of [filePath, thumbPath]) {
      fs.rm(p, { force: true }, () => {
        /* best-effort — DB row is the source of truth; a stray orphan file is harmless */
      });
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'attachment.delete',
      entityType: 'attachment',
      entityId: id,
      campaignId: existing.campaignId,
      detail: existing.kind,
    });
  }

  // ---------- storage management (issue #24) ----------

  /**
   * Set (bytes) or clear (null) a campaign's upload quota. Server-admin action —
   * the controller gates it with @ServerRoles('admin'). Throws 404 if the campaign
   * doesn't exist. Returns the persisted quota (echoes the input).
   */
  async setCampaignQuota(campaignId: number, quotaBytes: number | null): Promise<number | null> {
    const [camp] = await this.db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    if (!camp) throw new NotFoundException(`Campaign ${campaignId} not found`);

    await this.db
      .update(campaigns)
      .set({ storageQuotaBytes: quotaBytes, updatedAt: nowIso() })
      .where(eq(campaigns.id, campaignId));
    return quotaBytes;
  }

  /**
   * Server-wide upload-size snapshot: total bytes (from attachment metadata), a
   * per-campaign breakdown (with each campaign's quota + over-quota flag), the
   * actual on-disk byte total, and an orphan summary (rows-without-file &
   * files-without-row). Used by the admin storage console.
   */
  async storageStats(): Promise<StorageStats> {
    const rows = await this.db.select().from(attachments);
    const campRows = await this.db
      .select({ id: campaigns.id, name: campaigns.name, quota: campaigns.storageQuotaBytes })
      .from(campaigns);

    // Aggregate public/committed usage separately from in-flight reservations.
    const perCampaign = new Map<
      number,
      { committedBytes: number; reservedBytes: number; fileCount: number; reservedFileCount: number }
    >();
    let committedBytes = 0;
    let reservedBytes = 0;
    let fileCount = 0;
    let reservedFileCount = 0;
    for (const r of rows) {
      const agg = perCampaign.get(r.campaignId) ?? {
        committedBytes: 0,
        reservedBytes: 0,
        fileCount: 0,
        reservedFileCount: 0,
      };
      if (r.state === COMMITTED) {
        committedBytes += r.size;
        fileCount += 1;
        agg.committedBytes += r.size;
        agg.fileCount += 1;
      } else {
        reservedBytes += r.size;
        reservedFileCount += 1;
        agg.reservedBytes += r.size;
        agg.reservedFileCount += 1;
      }
      perCampaign.set(r.campaignId, agg);
    }

    const campaignsUsage = campRows
      .map((c) => {
        const agg = perCampaign.get(c.id) ?? {
          committedBytes: 0,
          reservedBytes: 0,
          fileCount: 0,
          reservedFileCount: 0,
        };
        const quotaBytes = c.quota ?? null;
        return {
          campaignId: c.id,
          name: c.name,
          fileCount: agg.fileCount,
          reservedFileCount: agg.reservedFileCount,
          // Backward-compatible alias: totalBytes has always meant publicly
          // committed attachment bytes, not temporary quota reservations.
          totalBytes: agg.committedBytes,
          committedBytes: agg.committedBytes,
          reservedBytes: agg.reservedBytes,
          quotaBytes,
          overQuota: quotaBytes !== null && agg.committedBytes + agg.reservedBytes > quotaBytes,
        };
      })
      .sort((a, b) => b.committedBytes + b.reservedBytes - (a.committedBytes + a.reservedBytes));

    const validIds = new Set(rows.map((r) => r.id));
    const reservedIds = new Set(rows.filter((r) => r.state === RESERVED).map((r) => r.id));
    // storageStats is the admin's read-only visibility surface, so a transient
    // storage outage (missing/unreadable volume) is tolerated here — the admin
    // needs to SEE the situation, and nothing deletes rows on this path. We fall
    // back to 0 disk bytes rather than throwing. scanDisk() itself fails closed
    // (throws) on infra errors; that stricter behaviour is reserved for
    // cleanupOrphans, which DELETES based on the orphan verdict (issue #722).
    let disk: { totalBytes: number; orphanFiles: Array<{ path: string; size: number }>; orphanBytes: number };
    try {
      disk = this.scanDisk(validIds, reservedIds);
    } catch {
      disk = { totalBytes: 0, orphanFiles: [], orphanBytes: 0 };
    }

    // Rows whose backing original file is gone from disk.
    let rowsWithoutFile = 0;
    for (const r of rows.filter((candidate) => candidate.state === COMMITTED)) {
      if (!fs.existsSync(this.filePath(r))) rowsWithoutFile += 1;
    }

    return {
      totalBytes: committedBytes,
      committedBytes,
      reservedBytes,
      fileCount,
      reservedFileCount,
      diskBytes: disk.totalBytes,
      campaigns: campaignsUsage,
      orphans: {
        rowsWithoutFile,
        filesWithoutRow: disk.orphanFiles.length,
        orphanBytes: disk.orphanBytes,
      },
    };
  }

  /**
   * Delete orphans: attachment rows whose file is missing on disk, and on-disk
   * upload files (originals or thumbnails) with no backing row. With `dryRun` the
   * counts are reported but nothing is deleted. Server-admin action.
   *
   * Row deletion also clears dangling references (campaign map / encounter map /
   * character portrait), mirroring remove(), so cleanup never leaves a pointer to a
   * row it just dropped.
   *
   * FAIL CLOSED (issue #722): before classifying anything as an orphan, the upload
   * root is verified to be present and readable. A missing/unreadable volume is an
   * INFRASTRUCTURE failure, not a "clean disk with no orphans": every row would
   * look orphaned (its file lives under that very volume) and hard-deleting them
   * would nuke metadata + clear encounter/campaign/character references for
   * attachments whose bytes are merely behind a transiently-unmounted volume. So
   * we refuse to mark rows as orphans in that case (throw 503) rather than
   * silently destroying good data. The same guard covers the dry-run preview: a
   * preview that reports "all rows are orphans" while the disk is gone is itself a
   * footgun the admin could act on.
   */
  async cleanupOrphans(dryRun: boolean): Promise<StorageCleanupResult> {
    // Pre-flight: if the storage root is unavailable, refuse to classify orphans
    // at all. scanDisk() below also re-validates readability as it walks the tree,
    // so a partial failure (e.g. a campaign subdir that lost its permissions
    // mid-walk) surfaces the same way rather than being mistaken for an empty dir.
    this.assertStorageAccessible();

    const rows = await this.db.select().from(attachments);
    const validIds = new Set(rows.map((r) => r.id));
    const reservedIds = new Set(rows.filter((r) => r.state === RESERVED).map((r) => r.id));

    const orphanRows = rows.filter((r) => r.state === COMMITTED && !fs.existsSync(this.filePath(r)));
    const disk = this.scanDisk(validIds, reservedIds);

    let rowsDeleted = 0;
    let filesDeleted = 0;
    let bytesReclaimed = 0;

    if (!dryRun) {
      for (const r of orphanRows) {
        const portraitSuffix = `%/attachments/${r.id}/file`;
        this.db.transaction((tx) => {
          tx.delete(attachments).where(eq(attachments.id, r.id)).run();
          tx.update(campaigns).set({ mapAttachmentId: null }).where(eq(campaigns.mapAttachmentId, r.id)).run();
          tx.update(encounters).set({ mapAttachmentId: null }).where(eq(encounters.mapAttachmentId, r.id)).run();
          tx.update(characters).set({ portraitUrl: null }).where(like(characters.portraitUrl, portraitSuffix)).run();
        });
        this.etagCache.delete(this.filePath(r));
        rowsDeleted += 1;
      }
      for (const f of disk.orphanFiles) {
        try {
          fs.rmSync(f.path, { force: true });
          this.etagCache.delete(f.path);
          filesDeleted += 1;
          bytesReclaimed += f.size;
        } catch {
          /* best-effort — a file we couldn't unlink stays counted as an orphan next run */
        }
      }
    }

    return {
      dryRun,
      rowsWithoutFile: orphanRows.length,
      filesWithoutRow: disk.orphanFiles.length,
      rowsDeleted,
      filesDeleted,
      bytesReclaimed,
    };
  }

  /**
   * Verify the upload root is present and readable. Throws 503
   * (ServiceUnavailableException) when it isn't, so callers that DELETE rows
   * based on "file missing" can fail closed instead of mistaking a vanished
   * volume for an empty directory and nuking good metadata (issue #722).
   *
   * - ENOENT (root absent): the configured DATA_DIR/uploads isn't there at all —
   *   a misconfigured / unmounted / moved volume, not "a campaign with no files."
   * - EACCES / other access errors: the directory exists but the process can't
   *   read it (perms flip, mount swap). Same conclusion: refuse to classify.
   *
   * Uses fs.access (R_OK) rather than existsSync so a present-but-unreadable
   * directory is caught too — existsSync would happily return true for a dir the
   * process then can't readdir.
   */
  private assertStorageAccessible(): void {
    const root = uploadsRoot();
    try {
      // Throws on ENOENT (missing) or EACCES/EPERM (unreadable).
      fs.accessSync(root, fs.constants.R_OK);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      // A transient I/O blip (EIO/ENODEV) reading the volume is just as
      // disqualifying as the root being outright missing — surface it the same way
      // so cleanup never proceeds on an unreliable view of disk state.
      throw new ServiceUnavailableException(
        `Attachment storage is unavailable (${code ?? 'unknown error'} at ${root}); ` +
          'refusing to mark rows as orphans to avoid deleting good data. ' +
          'Restore the storage volume and retry.',
      );
    }
  }

  /**
   * Walk DATA_DIR/uploads once, returning the total on-disk byte size and the set
   * of orphan files — those whose filename does not match a live attachment
   * artifact:
   *   - `<id>.<ext>` / `<id>.thumb.png` owned when `validIds` has `id`
   *   - `<id>.<ext>.stage` owned only when `reservedIds` has `id` (in-flight
   *     publication). Leftover stages must not hitchhike on a committed id via
   *     `parseInt` stopping at the first dot.
   * Non-matching names are orphans too (nothing else writes here).
   *
   * FAIL CLOSED on infra errors (issue #722): if the root vanished between the
   * caller's preflight and this walk, or readdir fails for an infrastructure
   * reason (EACCES/EIO), we throw rather than returning an empty/"all orphans"
   * result. Per-file stat failures (a single corrupt entry) are still tolerated —
   * one unreadable file shouldn't abort the whole scan, and the file is simply
   * skipped rather than misclassified.
   */
  private scanDisk(
    validIds: Set<number>,
    reservedIds: Set<number>,
  ): {
    totalBytes: number;
    orphanFiles: Array<{ path: string; size: number }>;
    orphanBytes: number;
  } {
    const root = uploadsRoot();
    const orphanFiles: Array<{ path: string; size: number }> = [];
    let totalBytes = 0;
    let orphanBytes = 0;

    if (!fs.existsSync(root)) {
      throw new ServiceUnavailableException(
        `Attachment storage root is missing (${root}); refusing to scan for orphans.`,
      );
    }

    let top: fs.Dirent[];
    try {
      top = fs.readdirSync(root, { withFileTypes: true });
    } catch (err) {
      // Unreadable root -> can't trust any orphan classification derived from it.
      const code = (err as NodeJS.ErrnoException)?.code;
      throw new ServiceUnavailableException(
        `Attachment storage root is unreadable (${code ?? 'unknown error'} at ${root}); ` +
          'refusing to scan for orphans.',
      );
    }

    for (const campaignDir of top) {
      if (!campaignDir.isDirectory()) continue;
      const dirPath = path.join(root, campaignDir.name);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
      } catch (err) {
        // A single campaign subdir we can't read is an infra problem too: any
        // attachment rows under it would look like orphans. Fail closed rather
        // than silently dropping their metadata.
        const code = (err as NodeJS.ErrnoException)?.code;
        throw new ServiceUnavailableException(
          `Attachment storage subdirectory is unreadable (${code ?? 'unknown error'} at ${dirPath}); ` +
            'refusing to scan for orphans.',
        );
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const filePath = path.join(dirPath, entry.name);
        // Default 0 for definite assignment; catch continues so the value is unused
        // on the failure path (skip rather than misclassify as a 0-byte orphan).
        let size = 0;
        try {
          size = fs.statSync(filePath).size;
        } catch {
          continue;
        }
        totalBytes += size;
        if (!this.isOwnedUploadArtifact(entry.name, validIds, reservedIds)) {
          orphanFiles.push({ path: filePath, size });
          orphanBytes += size;
        }
      }
    }

    return { totalBytes, orphanFiles, orphanBytes };
  }

  /**
   * Strict upload filename ownership (do not use parseInt — it treats
   * `12.png.stage` as id 12 even when that row is already committed).
   */
  private isOwnedUploadArtifact(
    name: string,
    validIds: Set<number>,
    reservedIds: Set<number>,
  ): boolean {
    const stageMatch = /^(\d+)\.[^.]+\.stage$/.exec(name);
    if (stageMatch) {
      const id = Number(stageMatch[1]);
      return Number.isInteger(id) && id > 0 && reservedIds.has(id);
    }
    const thumbMatch = /^(\d+)\.thumb\.png$/.exec(name);
    if (thumbMatch) {
      const id = Number(thumbMatch[1]);
      return Number.isInteger(id) && id > 0 && validIds.has(id);
    }
    const normalMatch = /^(\d+)\.[a-z0-9]+$/.exec(name);
    if (normalMatch) {
      const id = Number(normalMatch[1]);
      return Number.isInteger(id) && id > 0 && validIds.has(id);
    }
    return false;
  }
}
