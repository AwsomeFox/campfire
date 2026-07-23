import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB, type DrizzleDb } from '../../db/db.module';
import { attachments } from '../../db/schema';
import { nowIso } from '../../common/time';
import { ALLOWED_MIME_TO_EXT, GENERATED_MIME_TO_EXT } from './attachments.service';

/**
 * Classification of an issue found during attachment diagnostics scan.
 *
 *  - misplaced:            file on disk but in a different campaign directory than the DB row expects
 *  - wrong-extension:      file extension doesn't match what the MIME type maps to
 *  - duplicate:            multiple files share the same content hash (sha256)
 *  - malformed:            filename on disk doesn't match the expected `<id>.<ext>` pattern
 *  - unexpected-thumbnail: a `.thumb.png` file exists without a parent attachment row
 *  - orphan:               file on disk with no DB row at all
 *  - missing:              DB row whose expected file does not exist on disk
 */
export type DiagnosticIssueType =
  | 'misplaced'
  | 'wrong-extension'
  | 'duplicate'
  | 'malformed'
  | 'unexpected-thumbnail'
  | 'orphan'
  | 'missing';

export interface DiagnosticIssue {
  type: DiagnosticIssueType;
  /** Attachment row id (null for pure orphan files with no matching row). */
  attachmentId: number | null;
  /** Campaign that owns the row (from DB); null for orphans. */
  campaignId: number | null;
  /** Uploader user id from the DB row, if available. */
  owner: string | null;
  /** Actual path on disk (relative to uploads root). */
  path: string;
  /** Expected canonical path (relative to uploads root), if derivable. */
  canonicalPath: string | null;
  /** File size in bytes (0 if file missing). */
  size: number;
  /** SHA-256 hex of the file content (empty string if file missing). */
  checksum: string;
  /** Human-readable description. */
  detail: string;
}

export interface DiagnosticReport {
  scannedAt: string;
  totalDbRows: number;
  totalDiskFiles: number;
  issues: DiagnosticIssue[];
}

export type FixAction = 'relink' | 'quarantine';

export interface FixRequest {
  /** The attachment id or disk path to act on. */
  attachmentId?: number;
  diskPath?: string;
  action: FixAction;
}

export interface FixResult {
  success: boolean;
  action: FixAction;
  attachmentId: number | null;
  detail: string;
}

function uploadsRoot(): string {
  const dataDir = process.env.DATA_DIR ?? path.resolve(__dirname, '..', '..', '..', 'data');
  return path.join(dataDir, 'uploads');
}

function quarantineRoot(): string {
  const dataDir = process.env.DATA_DIR ?? path.resolve(__dirname, '..', '..', '..', 'data');
  return path.join(dataDir, 'quarantine');
}

/** Compute sha256 hex of a file, or empty string if unreadable. */
function checksumFile(filePath: string): string {
  try {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    return '';
  }
}

/** Derive the expected extension for a MIME type. */
function extForMime(mime: string): string {
  return ALLOWED_MIME_TO_EXT[mime] ?? GENERATED_MIME_TO_EXT[mime] ?? 'bin';
}

/**
 * Canonical relative path (from uploads root) for an attachment row.
 * Pattern: `<campaignId>/<id>.<ext>`
 */
function canonicalRelPath(row: { campaignId: number; id: number; mime: string }): string {
  const ext = extForMime(row.mime);
  return `${row.campaignId}/${row.id}.${ext}`;
}

@Injectable()
export class DiagnosticsService {
  constructor(@Inject(DB) private readonly db: DrizzleDb) {}

  /**
   * Full scan: walk DB rows + disk files, classify every issue found.
   */
  async runDiagnostics(): Promise<DiagnosticReport> {
    const root = uploadsRoot();
    // If the uploads root doesn't exist yet (no attachments ever uploaded), that's
    // fine — just scan against an empty disk. Only throw on an existing-but-unreadable dir.
    if (fs.existsSync(root)) {
      this.assertAccessible(root);
    }

    const rows = await this.db.select().from(attachments);
    const rowById = new Map<number, typeof rows[number]>();
    for (const r of rows) rowById.set(r.id, r);

    // Track which row ids we've seen a correct file for on disk.
    const seenOnDisk = new Set<number>();
    const issues: DiagnosticIssue[] = [];
    const checksums = new Map<string, Array<{ id: number; path: string }>>();
    let totalDiskFiles = 0;

    // Walk the uploads tree: uploads/<campaignDir>/<file>
    if (fs.existsSync(root)) {
      const campaignDirs = fs.readdirSync(root, { withFileTypes: true });
      for (const dir of campaignDirs) {
        if (!dir.isDirectory()) continue;
        const dirCampaignId = Number.parseInt(dir.name, 10);
        const dirPath = path.join(root, dir.name);
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dirPath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          totalDiskFiles++;
          const filePath = path.join(dirPath, entry.name);
          const relPath = `${dir.name}/${entry.name}`;
          let size = 0;
          try {
            size = fs.statSync(filePath).size;
          } catch {
            continue;
          }

          // Parse filename: expected forms are `<id>.<ext>` or `<id>.thumb.png`
          const thumbMatch = entry.name.match(/^(\d+)\.thumb\.png$/);
          const normalMatch = entry.name.match(/^(\d+)\.([a-z0-9]+)$/);

          if (thumbMatch) {
            const id = Number.parseInt(thumbMatch[1], 10);
            if (!rowById.has(id)) {
              issues.push({
                type: 'unexpected-thumbnail',
                attachmentId: null,
                campaignId: Number.isNaN(dirCampaignId) ? null : dirCampaignId,
                owner: null,
                path: relPath,
                canonicalPath: null,
                size,
                checksum: checksumFile(filePath),
                detail: `Thumbnail file ${entry.name} has no parent attachment row (id=${id})`,
              });
            }
            // Thumbnails don't count toward the "seen on disk" set for their parent row.
            continue;
          }

          if (!normalMatch) {
            // Malformed filename
            issues.push({
              type: 'malformed',
              attachmentId: null,
              campaignId: Number.isNaN(dirCampaignId) ? null : dirCampaignId,
              owner: null,
              path: relPath,
              canonicalPath: null,
              size,
              checksum: checksumFile(filePath),
              detail: `Filename "${entry.name}" does not match expected pattern <id>.<ext>`,
            });
            continue;
          }

          const fileId = Number.parseInt(normalMatch[1], 10);
          const fileExt = normalMatch[2];
          const row = rowById.get(fileId);

          if (!row) {
            // Orphan: file on disk with no DB row
            issues.push({
              type: 'orphan',
              attachmentId: null,
              campaignId: Number.isNaN(dirCampaignId) ? null : dirCampaignId,
              owner: null,
              path: relPath,
              canonicalPath: null,
              size,
              checksum: checksumFile(filePath),
              detail: `File ${entry.name} has no matching DB row (id=${fileId})`,
            });
            continue;
          }

          seenOnDisk.add(fileId);

          const expectedExt = extForMime(row.mime);
          const expectedCampaignId = row.campaignId;
          const expectedRelPath = canonicalRelPath(row);

          // Check: wrong campaign directory (misplaced)
          if (!Number.isNaN(dirCampaignId) && dirCampaignId !== expectedCampaignId) {
            issues.push({
              type: 'misplaced',
              attachmentId: row.id,
              campaignId: row.campaignId,
              owner: row.uploaderUserId,
              path: relPath,
              canonicalPath: expectedRelPath,
              size,
              checksum: checksumFile(filePath),
              detail: `File is in campaign dir ${dirCampaignId} but DB row says campaign ${expectedCampaignId}`,
            });
          }

          // Check: wrong extension
          if (fileExt !== expectedExt) {
            issues.push({
              type: 'wrong-extension',
              attachmentId: row.id,
              campaignId: row.campaignId,
              owner: row.uploaderUserId,
              path: relPath,
              canonicalPath: expectedRelPath,
              size,
              checksum: checksumFile(filePath),
              detail: `File has extension .${fileExt} but MIME ${row.mime} expects .${expectedExt}`,
            });
          }

          // Track checksum for duplicate detection
          const hash = checksumFile(filePath);
          if (hash) {
            const entry = checksums.get(hash) ?? [];
            entry.push({ id: fileId, path: relPath });
            checksums.set(hash, entry);
          }
        }
      }
    }

    // Check for missing: DB rows with no file on disk
    for (const row of rows) {
      if (!seenOnDisk.has(row.id)) {
        issues.push({
          type: 'missing',
          attachmentId: row.id,
          campaignId: row.campaignId,
          owner: row.uploaderUserId,
          path: canonicalRelPath(row),
          canonicalPath: canonicalRelPath(row),
          size: 0,
          checksum: '',
          detail: `DB row (id=${row.id}) has no file on disk at expected path`,
        });
      }
    }

    // Detect duplicates (same checksum shared by 2+ distinct attachment ids)
    for (const [hash, entries] of checksums) {
      if (entries.length > 1) {
        for (const e of entries) {
          const row = rowById.get(e.id);
          issues.push({
            type: 'duplicate',
            attachmentId: e.id,
            campaignId: row?.campaignId ?? null,
            owner: row?.uploaderUserId ?? null,
            path: e.path,
            canonicalPath: row ? canonicalRelPath(row) : null,
            size: row?.size ?? 0,
            checksum: hash,
            detail: `Content hash ${hash.slice(0, 12)}… shared by ${entries.length} files: ${entries.map((x) => x.path).join(', ')}`,
          });
        }
      }
    }

    return {
      scannedAt: nowIso(),
      totalDbRows: rows.length,
      totalDiskFiles,
      issues,
    };
  }

  /**
   * Apply a fix: relink (update DB to match actual file location) or quarantine
   * (move file to quarantine dir before deletion).
   */
  async applyFix(req: FixRequest): Promise<FixResult> {
    const root = uploadsRoot();

    if (req.action === 'relink') {
      return this.applyRelink(req, root);
    }

    if (req.action === 'quarantine') {
      return this.applyQuarantine(req, root);
    }

    return { success: false, action: req.action, attachmentId: req.attachmentId ?? null, detail: 'Unknown action' };
  }

  /**
   * Relink: find the file on disk (possibly in wrong campaign dir) and update
   * the DB row's campaignId to match the directory it's actually in.
   */
  private async applyRelink(req: FixRequest, root: string): Promise<FixResult> {
    if (!req.attachmentId) {
      return { success: false, action: 'relink', attachmentId: null, detail: 'attachmentId required for relink' };
    }

    const [row] = await this.db.select().from(attachments).where(eq(attachments.id, req.attachmentId)).limit(1);
    if (!row) {
      return { success: false, action: 'relink', attachmentId: req.attachmentId, detail: 'Attachment row not found' };
    }

    // Find the actual file: scan all campaign dirs for a file named `<id>.<ext>`
    const ext = extForMime(row.mime);
    const filename = `${row.id}.${ext}`;
    let actualDir: string | null = null;

    const campaignDirs = fs.readdirSync(root, { withFileTypes: true });
    for (const dir of campaignDirs) {
      if (!dir.isDirectory()) continue;
      const candidate = path.join(root, dir.name, filename);
      if (fs.existsSync(candidate)) {
        actualDir = dir.name;
        break;
      }
    }

    if (!actualDir) {
      return { success: false, action: 'relink', attachmentId: req.attachmentId, detail: 'File not found on disk in any campaign directory' };
    }

    const actualCampaignId = Number.parseInt(actualDir, 10);
    if (Number.isNaN(actualCampaignId)) {
      return { success: false, action: 'relink', attachmentId: req.attachmentId, detail: `Non-numeric campaign directory: ${actualDir}` };
    }

    if (actualCampaignId === row.campaignId) {
      return { success: true, action: 'relink', attachmentId: req.attachmentId, detail: 'File already in correct location; no update needed' };
    }

    // Update the DB row to point at the actual campaign directory.
    await this.db
      .update(attachments)
      .set({ campaignId: actualCampaignId, updatedAt: nowIso() })
      .where(eq(attachments.id, req.attachmentId));

    return {
      success: true,
      action: 'relink',
      attachmentId: req.attachmentId,
      detail: `Relinked attachment ${req.attachmentId} from campaign ${row.campaignId} to ${actualCampaignId}`,
    };
  }

  /**
   * Quarantine: move a file from uploads/ into DATA_DIR/quarantine/ (preserving
   * the relative path structure) so it can be inspected/recovered before permanent deletion.
   */
  private async applyQuarantine(req: FixRequest, root: string): Promise<FixResult> {
    const qRoot = quarantineRoot();

    // Determine the file to quarantine
    let relPath: string | undefined = req.diskPath;

    if (!relPath && req.attachmentId) {
      const [row] = await this.db.select().from(attachments).where(eq(attachments.id, req.attachmentId)).limit(1);
      if (row) {
        relPath = canonicalRelPath(row);
      }
    }

    if (!relPath) {
      return { success: false, action: 'quarantine', attachmentId: req.attachmentId ?? null, detail: 'No file path could be determined' };
    }

    const srcPath = path.join(root, relPath);
    if (!fs.existsSync(srcPath)) {
      return { success: false, action: 'quarantine', attachmentId: req.attachmentId ?? null, detail: `File not found at ${relPath}` };
    }

    const destPath = path.join(qRoot, relPath);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.renameSync(srcPath, destPath);

    return {
      success: true,
      action: 'quarantine',
      attachmentId: req.attachmentId ?? null,
      detail: `Moved ${relPath} to quarantine`,
    };
  }

  private assertAccessible(root: string): void {
    try {
      fs.accessSync(root, fs.constants.R_OK);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      throw new ServiceUnavailableException(
        `Attachment storage is unavailable (${code ?? 'unknown error'} at ${root}); cannot run diagnostics.`,
      );
    }
  }
}
