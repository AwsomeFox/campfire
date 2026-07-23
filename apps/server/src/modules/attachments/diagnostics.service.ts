import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BadRequestException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB, type DrizzleDb } from '../../db/db.module';
import { attachments, campaigns } from '../../db/schema';
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

/**
 * Parse a campaign upload directory name into its numeric id, but ONLY when the
 * name is an exact canonical decimal (no leading zeros, no trailing characters).
 *
 * `Number.parseInt` is too permissive here: it maps `1extra` -> 1 and `010` ->
 * 10, so a stray directory could be treated as a real campaign id. That would
 * let a scan mark files "canonical" (and relink report success) while the bytes
 * live under a path `AttachmentsService` — which reads strictly from
 * `<campaignId>/<id>.<ext>` — never looks at. Returning NaN for any
 * non-canonical name makes callers treat such directories as unknown, so the
 * owning row is honestly reported as `missing` rather than falsely healthy.
 */
function parseCampaignDirId(name: string): number {
  if (!/^(0|[1-9]\d*)$/.test(name)) return NaN;
  return Number.parseInt(name, 10);
}

/**
 * True when a `path.relative()` result escapes its root via parent traversal.
 * A bare `startsWith('..')` would also reject legitimate names that merely begin
 * with two dots (e.g. `..foo`), so match only an exact `..` or a `..<sep>` prefix.
 */
function escapesRoot(relative: string): boolean {
  return relative === '..' || relative.startsWith(`..${path.sep}`);
}

/**
 * Resolve `candidate` and ensure it (and any symlink target) stays inside `root`.
 * Lexical `path.resolve` alone is not enough: a directory symlink under the root
 * can make `path.join(root, 'link/file')` reach outside the intended tree.
 */
function assertPathContained(root: string, candidate: string, label: string): string {
  const rootResolved = path.resolve(root);
  const candidateResolved = path.resolve(candidate);
  const lexicalRelative = path.relative(rootResolved, candidateResolved);
  if (escapesRoot(lexicalRelative) || path.isAbsolute(lexicalRelative)) {
    throw new BadRequestException(`${label} must stay within ${path.basename(rootResolved)} root`);
  }

  // Without an on-disk root we can only enforce lexical containment (callers then
  // report missing-file / empty-storage outcomes instead of a hard 400).
  if (!fs.existsSync(rootResolved)) {
    return candidateResolved;
  }

  let rootReal: string;
  try {
    rootReal = fs.realpathSync(rootResolved);
  } catch {
    throw new BadRequestException(`${label} must stay within ${path.basename(rootResolved)} root`);
  }

  // If the candidate exists, require its realpath (symlink target) to stay inside
  // the real root. If it does not exist yet (e.g. quarantine destination), require
  // the nearest existing ancestor to stay contained instead — but do not walk past
  // the lexical root (missing intermediate dirs under a valid root are fine).
  let probe = candidateResolved;
  while (!fs.existsSync(probe)) {
    if (probe === rootResolved) return candidateResolved;
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }

  try {
    const probeReal = fs.realpathSync(probe);
    const realRelative = path.relative(rootReal, probeReal);
    if (escapesRoot(realRelative) || path.isAbsolute(realRelative)) {
      throw new BadRequestException(`${label} must stay within ${path.basename(rootResolved)} root`);
    }
  } catch (err) {
    if (err instanceof BadRequestException) throw err;
    // Unresolvable path — treat as containment failure rather than following blindly.
    throw new BadRequestException(`${label} must stay within ${path.basename(rootResolved)} root`);
  }

  return candidateResolved;
}

/** Compute sha256 hex of a file, or empty string if unreadable. */
function checksumFile(filePath: string): string {
  const hash = crypto.createHash('sha256');
  let fd: number | undefined;
  const buf = Buffer.allocUnsafe(64 * 1024);
  try {
    fd = fs.openSync(filePath, 'r');
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buf, 0, buf.length, null);
      if (bytesRead > 0) {
        hash.update(buf.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
    return hash.digest('hex');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
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

/**
 * Read a campaign directory's entries for the on-disk scan/lookup paths below.
 * Returns `null` on `ENOENT` (directory vanished between the parent listing and
 * this read). Any other error — e.g. EACCES/EPERM, or ENOTDIR — is fail-closed
 * (503) so callers cannot produce a false "not found".
 */
function readCampaignDirOrNullOnError(dirPath: string, dirName: string, contextSuffix: string): fs.Dirent[] | null {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return null;
    throw new ServiceUnavailableException(
      `Attachment storage subdirectory is unreadable or inaccessible (${code ?? 'unknown error'} in campaign directory ${dirName}); ${contextSuffix}`,
    );
  }
}

/**
 * All primary (non-thumbnail) attachment files for an id, anywhere under uploads,
 * returned in a stable (relPath-sorted) order.
 *
 * Returning every match — rather than the first one `readdirSync` happens to
 * yield — lets callers detect the ambiguous case where the same id exists in
 * multiple campaign directories (a realistic misplacement/duplicate failure
 * mode) and refuse to act nondeterministically on a possibly-wrong file.
 */
function findPrimaryAttachmentFilesOnDisk(
  root: string,
  attachmentId: number,
): Array<{ relPath: string; campaignDir: string }> {
  let campaignDirs: fs.Dirent[];
  try {
    campaignDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // Missing root is an empty-storage case (callers report success:false), not 503.
    // `existsSync` would also mask EACCES/EPERM (existing-but-unreadable root) as
    // "missing", so check the readdir error code directly instead.
    if (code === 'ENOENT') return [];
    // Avoid leaking absolute host paths in admin API error responses.
    throw new ServiceUnavailableException(
      `Attachment storage root is unreadable or inaccessible (${code ?? 'unknown error'}); cannot locate attachment files.`,
    );
  }

  const idPattern = new RegExp(`^${attachmentId}\\.([a-z0-9]+)$`);
  const matches: Array<{ relPath: string; campaignDir: string }> = [];
  for (const dir of campaignDirs) {
    if (!dir.isDirectory()) continue;
    const dirPath = path.join(root, dir.name);
    // Fail closed like runDiagnostics: skipping an unreadable campaign dir can
    // produce a false "file not found" for relink/quarantine-by-attachmentId.
    const entries = readCampaignDirOrNullOnError(dirPath, dir.name, 'cannot locate attachment files.');
    if (entries === null) continue;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (idPattern.test(entry.name)) {
        matches.push({ relPath: `${dir.name}/${entry.name}`, campaignDir: dir.name });
      }
    }
  }
  matches.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return matches;
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
    const checksums = new Map<string, Array<{ id: number; path: string; size: number }>>();
    let totalDiskFiles = 0;

    // Walk the uploads tree: uploads/<campaignDir>/<file>
    if (fs.existsSync(root)) {
      let campaignDirs: fs.Dirent[];
      try {
        campaignDirs = fs.readdirSync(root, { withFileTypes: true });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        throw new ServiceUnavailableException(
          `Attachment storage root is unreadable or inaccessible (${code ?? 'unknown error'}); cannot run diagnostics.`,
        );
      }
      for (const dir of campaignDirs) {
        if (!dir.isDirectory()) continue;
        const dirCampaignId = parseCampaignDirId(dir.name);
        const dirPath = path.join(root, dir.name);
        const entries = readCampaignDirOrNullOnError(dirPath, dir.name, 'cannot run diagnostics.');
        if (entries === null) continue;
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          totalDiskFiles++;
          const filePath = path.join(dirPath, entry.name);
          const relPath = `${dir.name}/${entry.name}`;
          let size: number;
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

          const expectedExt = extForMime(row.mime);
          const expectedCampaignId = row.campaignId;
          const expectedRelPath = canonicalRelPath(row);
          const checksum = checksumFile(filePath);
          const isCanonical =
            !Number.isNaN(dirCampaignId) &&
            dirCampaignId === expectedCampaignId &&
            fileExt === expectedExt;

          if (isCanonical) {
            seenOnDisk.add(fileId);
          }

          // Check: wrong campaign directory (misplaced). A file that is not under
          // its canonical numeric campaign directory — whether it's a *different*
          // campaign id or a non-canonical directory name like `1extra`
          // (dirCampaignId === NaN) — is not where AttachmentsService looks for
          // it. Surface it (with its real on-disk path) so the row isn't reported
          // as only `missing` with no pointer to where the bytes actually live.
          if (Number.isNaN(dirCampaignId) || dirCampaignId !== expectedCampaignId) {
            const actualDirDesc = Number.isNaN(dirCampaignId)
              ? `non-canonical dir "${dir.name}"`
              : `campaign dir ${dirCampaignId}`;
            issues.push({
              type: 'misplaced',
              attachmentId: row.id,
              campaignId: row.campaignId,
              owner: row.uploaderUserId,
              path: relPath,
              canonicalPath: expectedRelPath,
              size,
              checksum,
              detail: `File is in ${actualDirDesc} but DB row says campaign ${expectedCampaignId}`,
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
              checksum,
              detail: `File has extension .${fileExt} but MIME ${row.mime} expects .${expectedExt}`,
            });
          }

          // Track checksum for duplicate detection
          if (checksum) {
            const entry = checksums.get(checksum) ?? [];
            entry.push({ id: fileId, path: relPath, size });
            checksums.set(checksum, entry);
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
            size: e.size,
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
    if (req.attachmentId === undefined) {
      return { success: false, action: 'relink', attachmentId: null, detail: 'attachmentId required for relink' };
    }

    const [row] = await this.db.select().from(attachments).where(eq(attachments.id, req.attachmentId)).limit(1);
    if (!row) {
      return { success: false, action: 'relink', attachmentId: req.attachmentId, detail: 'Attachment row not found' };
    }

    // Match scan/quarantine: a missing uploads root is an empty-storage case
    // (report success:false), not a 503. Only assert accessibility when the
    // directory exists but may be unreadable.
    if (fs.existsSync(root)) {
      this.assertAccessible(root);
    }
    const located = findPrimaryAttachmentFilesOnDisk(root, req.attachmentId);
    if (located.length === 0) {
      return { success: false, action: 'relink', attachmentId: req.attachmentId, detail: 'File not found on disk in any campaign directory' };
    }
    if (located.length > 1) {
      return {
        success: false,
        action: 'relink',
        attachmentId: req.attachmentId,
        detail: `Multiple on-disk files match attachment ${req.attachmentId} (${located
          .map((l) => l.relPath)
          .join(', ')}); resolve the duplicates before relinking`,
      };
    }

    const actualDir = located[0].campaignDir;
    const actualCampaignId = parseCampaignDirId(actualDir);
    if (Number.isNaN(actualCampaignId)) {
      return { success: false, action: 'relink', attachmentId: req.attachmentId, detail: `Non-numeric campaign directory: ${actualDir}` };
    }

    if (actualCampaignId === row.campaignId) {
      return { success: true, action: 'relink', attachmentId: req.attachmentId, detail: 'File already in correct location; no update needed' };
    }

    const [campaign] = await this.db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(eq(campaigns.id, actualCampaignId))
      .limit(1);
    if (!campaign) {
      return {
        success: false,
        action: 'relink',
        attachmentId: req.attachmentId,
        detail: `Campaign ${actualCampaignId} does not exist; cannot relink`,
      };
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

    if (!relPath && req.attachmentId !== undefined) {
      const located = findPrimaryAttachmentFilesOnDisk(root, req.attachmentId);
      if (located.length > 1) {
        return {
          success: false,
          action: 'quarantine',
          attachmentId: req.attachmentId,
          detail: `Multiple on-disk files match attachment ${req.attachmentId} (${located
            .map((l) => l.relPath)
            .join(', ')}); pass an explicit diskPath to disambiguate`,
        };
      }
      if (located.length === 1) {
        relPath = located[0].relPath;
      } else {
        const [row] = await this.db.select().from(attachments).where(eq(attachments.id, req.attachmentId)).limit(1);
        if (row) {
          relPath = canonicalRelPath(row);
        }
      }
    }

    if (!relPath) {
      return { success: false, action: 'quarantine', attachmentId: req.attachmentId ?? null, detail: 'No file path could be determined' };
    }

    const safeRelPath = relPath.trim();
    if (!safeRelPath || path.isAbsolute(safeRelPath)) {
      throw new BadRequestException('diskPath must be a non-empty relative path');
    }

    const srcPath = assertPathContained(root, path.resolve(root, safeRelPath), 'diskPath');
    const srcRelative = path.relative(path.resolve(root), srcPath);

    if (!fs.existsSync(srcPath)) {
      return {
        success: false,
        action: 'quarantine',
        attachmentId: req.attachmentId ?? null,
        detail: `File not found at ${safeRelPath}`,
      };
    }

    // Ensure quarantine root exists before realpath-based containment checks.
    fs.mkdirSync(qRoot, { recursive: true });
    const destPath = assertPathContained(qRoot, path.resolve(qRoot, srcRelative), 'diskPath');

    // The move can fail for storage-health reasons (EACCES/EIO/ENOSPC/EXDEV,
    // etc.). Since these endpoints exist to diagnose storage health, surface an
    // actionable 503 with the underlying errno instead of letting an unmapped
    // exception bubble up as a bare 500.
    try {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      // Re-check after mkdir: a symlink planted in the destination tree must not
      // let the final rename escape the quarantine root.
      assertPathContained(qRoot, destPath, 'diskPath');
      fs.renameSync(srcPath, destPath);
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      const code = (err as NodeJS.ErrnoException)?.code;
      throw new ServiceUnavailableException(
        `Failed to move ${srcRelative} to quarantine (${code ?? 'unknown error'}); attachment storage may be unavailable.`,
      );
    }

    return {
      success: true,
      action: 'quarantine',
      attachmentId: req.attachmentId ?? null,
      detail: `Moved ${srcRelative} to quarantine`,
    };
  }

  private assertAccessible(root: string): void {
    try {
      // Directory listing requires execute (search) permission in addition to
      // read; checking R_OK alone can pass while a subsequent readdirSync()
      // still fails with EACCES, defeating the intended 503 error mapping.
      fs.accessSync(root, fs.constants.R_OK | fs.constants.X_OK);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      // Avoid leaking the absolute host path in admin API error responses,
      // matching the other unreadable-storage error messages in this file.
      throw new ServiceUnavailableException(
        `Attachment storage is unavailable or inaccessible (${code ?? 'unknown error'}).`,
      );
    }
  }
}
