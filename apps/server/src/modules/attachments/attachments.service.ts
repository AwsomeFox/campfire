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
} from '@nestjs/common';
import { desc, eq, like, sql } from 'drizzle-orm';
import type {
  Attachment,
  AttachmentKind,
  Role,
  StorageCleanupResult,
  StorageStats,
} from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { attachments, campaigns, characters } from '../../db/schema';
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
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8MB

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
    const ext = ALLOWED_MIME_TO_EXT[row.mime] ?? 'bin';
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
   * Uploader or dm may delete; others 403. Removes both the DB row and the on-disk file,
   * and clears any dangling references pointing at it in the same transaction:
   *  - campaign.mapAttachmentId, if it was this attachment (numeric FK).
   *  - character.portraitUrl, if it points at this attachment's file route
   *    (`.../attachments/<id>/file` — portraitUrl is a resolved URL string, not a
   *    numeric FK, so it's matched by suffix rather than equality).
   * Without this, deleting an attachment still in use left the campaign map / character
   * portrait pointing at a now-404ing file.
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
    const disk = this.scanDisk(validIds);

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
   * Row deletion also clears dangling references (campaign map / character
   * portrait), mirroring remove(), so cleanup never leaves a pointer to a row it
   * just dropped.
   */
  async cleanupOrphans(dryRun: boolean): Promise<StorageCleanupResult> {
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
   * Walk DATA_DIR/uploads once, returning the total on-disk byte size and the set
   * of orphan files — those whose leading numeric id (from `<id>.<ext>` or
   * `<id>.thumb.png`) has no matching attachment row in `validIds`. Non-numeric
   * or unparseable entries are treated as orphans too (nothing else writes here).
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

    if (!fs.existsSync(root)) return { totalBytes, orphanFiles, orphanBytes };

    for (const campaignDir of fs.readdirSync(root, { withFileTypes: true })) {
      if (!campaignDir.isDirectory()) continue;
      const dirPath = path.join(root, campaignDir.name);
      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const filePath = path.join(dirPath, entry.name);
        let size = 0;
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
