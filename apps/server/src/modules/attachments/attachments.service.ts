import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, desc, eq, like, sql } from 'drizzle-orm';
import type {
  Attachment,
  AttachmentKind,
  Role,
  StorageCleanupResult,
  StorageStats,
} from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { attachments, campaigns, characters, encounters } from '../../db/schema';
import { nowIso } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import { generatePngThumbnail } from './thumbnail';

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
export class AttachmentsService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
  ) {}

  /** Absolute path a stored attachment's bytes live at, given its DB row. */
  filePath(row: { campaignId: number; id: number; mime: string }): string {
    const ext = ALLOWED_MIME_TO_EXT[row.mime] ?? GENERATED_MIME_TO_EXT[row.mime] ?? 'bin';
    return path.join(uploadsRoot(), String(row.campaignId), `${row.id}.${ext}`);
  }

  /** Absolute path a generated thumbnail (always PNG) is cached at on disk. */
  private thumbPath(row: { campaignId: number; id: number }): string {
    return path.join(uploadsRoot(), String(row.campaignId), `${row.id}.thumb.png`);
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
    const [row] = await this.db.select().from(attachments).where(eq(attachments.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Attachment ${id} not found`);
    return row;
  }

  /**
   * All attachment rows for a campaign, oldest first (metadata only — no bytes).
   * Used by the export module to enumerate maps/portraits/images so the export can
   * embed the actual files rather than dangling references (issue #87).
   */
  async listRowsForCampaign(campaignId: number) {
    return this.db.select().from(attachments).where(eq(attachments.campaignId, campaignId)).orderBy(attachments.id);
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
   * True when `attachmentId` is the battle map (mapAttachmentId) of some encounter in
   * `campaignId` (issue #259). A fogged encounter map stays hidden (DM-only) as a handout
   * so it never appears raw on the player Handouts card, but the fogged encounter canvas
   * Returns encounter map fog information for `attachmentId` in `campaignId` (issue #259, #523).
   * If `attachmentId` is an encounter's battle map, returns `{ isMap: true, fog: string | null }`.
   * Otherwise returns `{ isMap: false, fog: null }`.
   */
  async getEncounterMapFog(
    attachmentId: number,
    campaignId: number,
  ): Promise<{ isMap: boolean; fog: string | null }> {
    const [row] = await this.db
      .select({ fog: encounters.fog })
      .from(encounters)
      .where(and(eq(encounters.mapAttachmentId, attachmentId), eq(encounters.campaignId, campaignId)))
      .limit(1);
    if (!row) return { isMap: false, fog: null };
    return { isMap: true, fog: row.fog };
  }

  /**
   * True when `attachmentId` is the battle map (mapAttachmentId) of some encounter in
   * `campaignId` (issue #259).
   */
  async isEncounterMap(attachmentId: number, campaignId: number): Promise<boolean> {
    const { isMap } = await this.getEncounterMapFog(attachmentId, campaignId);
    return isMap;
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
      .where(eq(attachments.campaignId, campaignId))
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
   * Persist the uploaded buffer to disk under DATA_DIR/uploads/<campaignId>/<id>.<ext>
   * and record its metadata. Two-step (insert row -> write file named by the new
   * row id) because the on-disk filename embeds the DB id.
   *
   * The declared mimetype is never trusted on its own: the multer fileFilter only
   * sees the multipart header (the buffer doesn't exist yet at that point), so the
   * actual bytes are sniffed here and must match the declared type — otherwise
   * HTML-declared-as-PNG (and the like) would be stored and served as an image.
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

    // Per-campaign upload quota (issue #24). When a quota is set, an upload that
    // would push the campaign's total attachment bytes past it is rejected with a
    // 413 — same status the size cap uses, so callers treat "too big" uniformly.
    await this.enforceQuota(campaignId, file.size);

    const ts = nowIso();
    const [row] = await this.db
      .insert(attachments)
      .values({
        campaignId,
        uploaderUserId: user.id,
        kind,
        filename: file.originalname.slice(0, 255),
        mime: file.mimetype,
        size: file.size,
        hidden: defaultHiddenForKind(kind),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();

    const dest = this.filePath(row);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, file.buffer);

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'attachment.upload',
      entityType: 'attachment',
      entityId: row.id,
      campaignId,
      detail: kind,
    });

    return toDomain(row);
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
    await this.enforceQuota(campaignId, file.bytes.length);

    const ts = nowIso();
    const [row] = await this.db
      .insert(attachments)
      .values({
        campaignId,
        uploaderUserId: user.id,
        kind,
        filename: file.filename.slice(0, 255),
        mime: file.mime,
        size: file.bytes.length,
        hidden: defaultHiddenForKind(kind),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();

    const dest = this.filePath(row);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, file.bytes);

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'attachment.generate',
      entityType: 'attachment',
      entityId: row.id,
      campaignId,
      detail: kind,
    });

    return toDomain(row);
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
   * Reject an upload that would push a campaign's total attachment bytes past its
   * quota (413). No-op when the campaign has no quota set (the common case).
   * `additionalBytes` is the size of the incoming file.
   */
  private async enforceQuota(campaignId: number, additionalBytes: number): Promise<void> {
    const [camp] = await this.db
      .select({ quota: campaigns.storageQuotaBytes })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);
    const quota = camp?.quota;
    if (quota === null || quota === undefined) return; // unlimited

    const [used] = await this.db
      .select({ total: sql<number>`coalesce(sum(${attachments.size}), 0)` })
      .from(attachments)
      .where(eq(attachments.campaignId, campaignId));
    const currentBytes = Number(used?.total ?? 0);

    if (currentBytes + additionalBytes > quota) {
      throw new PayloadTooLargeException(
        `Upload would exceed this campaign's storage quota (${quota} bytes; ${currentBytes} used).`,
      );
    }
  }

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

    // Aggregate attachment metadata per campaign.
    const perCampaign = new Map<number, { totalBytes: number; fileCount: number }>();
    let totalBytes = 0;
    for (const r of rows) {
      totalBytes += r.size;
      const agg = perCampaign.get(r.campaignId) ?? { totalBytes: 0, fileCount: 0 };
      agg.totalBytes += r.size;
      agg.fileCount += 1;
      perCampaign.set(r.campaignId, agg);
    }

    const campaignsUsage = campRows
      .map((c) => {
        const agg = perCampaign.get(c.id) ?? { totalBytes: 0, fileCount: 0 };
        const quotaBytes = c.quota ?? null;
        return {
          campaignId: c.id,
          name: c.name,
          fileCount: agg.fileCount,
          totalBytes: agg.totalBytes,
          quotaBytes,
          overQuota: quotaBytes !== null && agg.totalBytes > quotaBytes,
        };
      })
      .sort((a, b) => b.totalBytes - a.totalBytes);

    const validIds = new Set(rows.map((r) => r.id));
    // storageStats is the admin's read-only visibility surface, so a transient
    // storage outage (missing/unreadable volume) is tolerated here — the admin
    // needs to SEE the situation, and nothing deletes rows on this path. We fall
    // back to 0 disk bytes rather than throwing. scanDisk() itself fails closed
    // (throws) on infra errors; that stricter behaviour is reserved for
    // cleanupOrphans, which DELETES based on the orphan verdict (issue #722).
    let disk: { totalBytes: number; orphanFiles: Array<{ path: string; size: number }>; orphanBytes: number };
    try {
      disk = this.scanDisk(validIds);
    } catch {
      disk = { totalBytes: 0, orphanFiles: [], orphanBytes: 0 };
    }

    // Rows whose backing original file is gone from disk.
    let rowsWithoutFile = 0;
    for (const r of rows) {
      if (!fs.existsSync(this.filePath(r))) rowsWithoutFile += 1;
    }

    return {
      totalBytes,
      fileCount: rows.length,
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

    const orphanRows = rows.filter((r) => !fs.existsSync(this.filePath(r)));
    const disk = this.scanDisk(validIds);

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
   * of orphan files — those whose leading numeric id (from `<id>.<ext>` or
   * `<id>.thumb.png`) has no matching attachment row in `validIds`. Non-numeric
   * or unparseable entries are treated as orphans too (nothing else writes here).
   *
   * FAIL CLOSED on infra errors (issue #722): if the root vanished between the
   * caller's preflight and this walk, or readdir fails for an infrastructure
   * reason (EACCES/EIO), we throw rather than returning an empty/"all orphans"
   * result. Per-file stat failures (a single corrupt entry) are still tolerated —
   * one unreadable file shouldn't abort the whole scan, and the file is simply
   * skipped rather than misclassified.
   */
  private scanDisk(validIds: Set<number>): {
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
        let size: number;
        try {
          size = fs.statSync(filePath).size;
        } catch {
          continue;
        }
        totalBytes += size;
        // Leading integer is the attachment id (`12.png`, `12.thumb.png`).
        const id = Number.parseInt(entry.name, 10);
        if (!Number.isInteger(id) || id <= 0 || !validIds.has(id)) {
          orphanFiles.push({ path: filePath, size });
          orphanBytes += size;
        }
      }
    }

    return { totalBytes, orphanFiles, orphanBytes };
  }
}
