import fs from 'node:fs';
import path from 'node:path';
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Attachment, AttachmentKind, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { attachments } from '../../db/schema';
import { nowIso } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';

/** image/png|jpeg|webp only — matches the multer fileFilter in attachments.controller.ts. */
export const ALLOWED_MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8MB

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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
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
   * Persist the uploaded buffer to disk under DATA_DIR/uploads/<campaignId>/<id>.<ext>
   * and record its metadata. Two-step (insert row -> write file named by the new
   * row id) because the on-disk filename embeds the DB id.
   */
  async create(
    campaignId: number,
    kind: AttachmentKind,
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
    user: RequestUser,
    role: Role,
  ): Promise<Attachment> {
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

  /** Uploader or dm may delete; others 403. Removes both the DB row and the on-disk file. */
  async remove(id: number, user: RequestUser, role: Role): Promise<void> {
    const existing = await this.getRowOrThrow(id);
    if (role !== 'dm' && existing.uploaderUserId !== user.id) {
      throw new ForbiddenException('Only the uploader or dm may delete this attachment');
    }

    await this.db.delete(attachments).where(eq(attachments.id, id));

    const filePath = this.filePath(existing);
    fs.rm(filePath, { force: true }, () => {
      /* best-effort — DB row is the source of truth; a stray orphan file is harmless */
    });

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
