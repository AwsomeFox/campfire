import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq, like } from 'drizzle-orm';
import type { Attachment, AttachmentKind, Role } from '@campfire/schema';
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
}
