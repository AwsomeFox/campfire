import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ApiConsumes, ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ServerRoles } from '../../common/decorators/server-roles.decorator';
import type { RequestUser } from '../../common/user.types';
import { BackupService, RESTORE_CONFIRM_TOKEN } from './backup.service';
import { BackupDownloadDto, BackupRestoreBody } from './backup.dto';

// Express.Multer.File augments the Express namespace via @types/multer; import side-effect only.
type MulterFile = Express.Multer.File;

/** A restored archive can be large (whole DB + all uploads). 1 GB ceiling. */
const MAX_RESTORE_BYTES = 1024 * 1024 * 1024;
export const BACKUP_UPLOAD_STAGE_PREFIX = 'campfire-backup-uploads-';
export const BACKUP_UPLOAD_STAGE_OWNER_FILE = '.campfire-upload-stage-owner.json';
const MAX_BACKUP_UPLOAD_STAGE_OWNER_BYTES = 4 * 1024;
let uploadStageRoot: string | undefined;

interface UploadStageOwner {
  version: 1;
  pid: number;
  token?: string;
  bootId?: string;
  startTicks?: string;
}

export type UploadStageProcessState =
  | { state: 'alive'; bootId: string; startTicks: string }
  | { state: 'dead' }
  | { state: 'unknown' };

export type UploadStageProcessLookup = (pid: number) => UploadStageProcessState;

const processToken = crypto.randomUUID();

export function linuxProcessState(pid: number, platform = process.platform): UploadStageProcessState {
  if (platform !== 'linux') return { state: 'unknown' };
  let bootId: string;
  try {
    bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    // Without the boot identity we cannot tell a missing proc entry from an
    // unmounted/inaccessible procfs, so preserve rather than guess stale.
    return { state: 'unknown' };
  }
  if (!bootId) return { state: 'unknown' };
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'dead' };
    return { state: 'unknown' };
  }
  // stat's second field is parenthesized and may contain spaces, so split only
  // after its final closing parenthesis. starttime is field 22 / index 19 here.
  const closing = stat.lastIndexOf(')');
  const fields = closing >= 0 ? stat.slice(closing + 1).trim().split(/\s+/) : [];
  const startTicks = fields[19];
  if (!startTicks || !/^\d+$/.test(startTicks)) return { state: 'unknown' };
  return { state: 'alive', bootId, startTicks };
}

function portableDeadProcessState(pid: number): UploadStageProcessState {
  try {
    process.kill(pid, 0);
    // A live PID alone cannot prove it is the marker's process instance.
    return { state: 'unknown' };
  } catch (err) {
    // EPERM and every non-ESRCH error are ambiguous and must preserve the root.
    return (err as NodeJS.ErrnoException).code === 'ESRCH'
      ? { state: 'dead' }
      : { state: 'unknown' };
  }
}

export function defaultUploadStageProcessState(
  pid: number,
  linuxLookup: UploadStageProcessLookup = linuxProcessState,
): UploadStageProcessState {
  const linux = linuxLookup(pid);
  return linux.state === 'unknown' ? portableDeadProcessState(pid) : linux;
}

function uploadStageOwnerPath(root: string): string {
  return path.join(root, BACKUP_UPLOAD_STAGE_OWNER_FILE);
}

function shouldReclaimUploadStageOwner(
  owner: UploadStageOwner,
  lookup: UploadStageProcessLookup,
): boolean {
  // A token is an exact identity proof for this process, including PID 1 after
  // a container restart. A mismatched token under our own PID is necessarily a
  // prior process instance and can be reclaimed without relying on /proc.
  if (owner.pid === process.pid && typeof owner.token === 'string') {
    return owner.token !== processToken;
  }
  const state = lookup(owner.pid);
  if (state.state === 'dead') return true;
  if (state.state === 'unknown') return false;
  // A live PID is not enough: only the Linux boot/start identity proves it is
  // the same process instance that created this root. Missing/legacy metadata
  // stays conservative and is never removed while liveness is uncertain.
  if (typeof owner.bootId !== 'string' || typeof owner.startTicks !== 'string') return false;
  return owner.bootId !== state.bootId || owner.startTicks !== state.startTicks;
}

/**
 * Best-effort startup reclamation for orphaned Multer upload roots. We only
 * remove a direct child with our exact prefix, a regular owner marker, and a
 * provably stale recorded process instance. Roots from a live sibling process
 * (and any unknown or suspicious temp entry) are left untouched.
 */
export function reclaimStaleUploadStageRoots(
  tmpDir = os.tmpdir(),
  currentRoot?: string,
  lookup: UploadStageProcessLookup = defaultUploadStageProcessState,
): void {
  const parent = path.resolve(tmpDir);
  const current = currentRoot ? path.resolve(currentRoot) : undefined;
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.name.startsWith(BACKUP_UPLOAD_STAGE_PREFIX)) continue;
    const root = path.resolve(parent, entry.name);
    if (path.dirname(root) !== parent || root === current) continue;
    try {
      const stat = fs.lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const markerPath = uploadStageOwnerPath(root);
      const marker = fs.lstatSync(markerPath);
      if (!marker.isFile() || marker.isSymbolicLink()) continue;
      if (marker.size > MAX_BACKUP_UPLOAD_STAGE_OWNER_BYTES) continue;
      if (
        (uid !== undefined && (stat.uid !== uid || marker.uid !== uid)) ||
        (stat.mode & 0o077) !== 0 || (marker.mode & 0o077) !== 0
      ) continue;
      const owner = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as UploadStageOwner;
      if (
        owner.version !== 1 ||
        typeof owner.pid !== 'number' || !Number.isInteger(owner.pid) || owner.pid <= 0
      ) continue;
      if (!shouldReclaimUploadStageOwner(owner, lookup)) continue;
      // Recheck both inodes immediately before moving the root aside. The
      // rename gives us a stable exact target for recursive removal even if a
      // concurrent process scans the same temp parent.
      const finalRoot = fs.lstatSync(root);
      const finalMarker = fs.lstatSync(markerPath);
      if (
        !finalRoot.isDirectory() || finalRoot.isSymbolicLink() ||
        !finalMarker.isFile() || finalMarker.isSymbolicLink() ||
        (uid !== undefined && (finalRoot.uid !== uid || finalMarker.uid !== uid)) ||
        (finalRoot.mode & 0o077) !== 0 || (finalMarker.mode & 0o077) !== 0 ||
        finalRoot.dev !== stat.dev || finalRoot.ino !== stat.ino ||
        finalMarker.dev !== marker.dev || finalMarker.ino !== marker.ino
      ) continue;
      const quarantine = path.join(parent, `${BACKUP_UPLOAD_STAGE_PREFIX}reclaim-${crypto.randomUUID()}`);
      fs.renameSync(root, quarantine);
      fs.rmSync(quarantine, { recursive: true, force: true });
    } catch {
      // Cleanup is never allowed to block startup or hide the request result.
    }
  }
}

/**
 * Make the Multer staging directory lazily. `mkdtempSync` atomically creates a
 * unique directory (rather than trusting a predictable path in a shared temp
 * area), and the restrictive mode keeps uploaded archives private.
 */
export function createPrivateUploadStageRoot(tmpDir = os.tmpdir()): string {
  const root = fs.mkdtempSync(path.join(tmpDir, BACKUP_UPLOAD_STAGE_PREFIX));
  try {
    fs.chmodSync(root, 0o700);
    const identity = linuxProcessState(process.pid);
    fs.writeFileSync(uploadStageOwnerPath(root), JSON.stringify({
      version: 1,
      pid: process.pid,
      token: processToken,
      ...(identity.state === 'alive'
        ? { bootId: identity.bootId, startTicks: identity.startTicks }
        : {}),
    }), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return root;
  } catch (err) {
    // `root` came directly from mkdtempSync above, so this exact removal cannot
    // affect another process's staging root. Preserve the setup error even if
    // best-effort rollback itself encounters a filesystem problem.
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw err;
  }
}

export function getUploadStageRoot(): string {
  if (!uploadStageRoot || !fs.existsSync(uploadStageRoot) || !fs.existsSync(uploadStageOwnerPath(uploadStageRoot))) {
    uploadStageRoot = createPrivateUploadStageRoot();
  }
  return uploadStageRoot;
}

const uploadStorage = diskStorage({
  destination: (_req, _file, callback) => {
    try { callback(null, getUploadStageRoot()); }
    catch (err) { callback(err as Error, ''); }
  },
  filename: (_req, _file, callback) => callback(null, `${crypto.randomUUID()}.zip`),
});

async function removeUpload(file: MulterFile | undefined): Promise<void> {
  if (!file?.path) return;
  try {
    await fs.promises.rm(file.path, { force: true });
  } catch {
    // Staging cleanup is best-effort and must never replace the inspect/restore
    // result (especially a useful validation 400) with an unrelated cleanup 500.
  }
}

function requestAbort(req: Request, res: Response): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const abortOnClose = () => {
    if (!res.writableEnded) abort();
  };
  req.once('aborted', abort);
  res.once('close', abortOnClose);
  // The request/response may have disconnected between Express noticing it and
  // this handler registering its listeners. EventEmitter cannot replay that
  // transition, so inspect the terminal state after registration as well.
  // `writableEnded` is safe to treat as terminal here because this operation
  // has not started yet; the close listener still deliberately ignores the
  // normal close that follows a successfully completed response.
  if (req.aborted || res.destroyed || res.writableEnded) abort();
  return {
    signal: controller.signal,
    dispose: () => {
      req.removeListener('aborted', abort);
      res.removeListener('close', abortOnClose);
    },
  };
}

function isBackupDownloadCancellation(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted || !(error instanceof Error)) return false;
  return error.name === 'AbortError' || error.message === 'Backup generation cancelled';
}

@ApiTags('backup')
@Controller('backup')
@ServerRoles('admin')
export class BackupController {
  constructor(private readonly backup: BackupService) {
    reclaimStaleUploadStageRoots();
  }

  @Get('status')
  @ApiOperation({
    summary: 'Scheduled backup status',
    description:
      'Server-admin only. Read-only view of whether scheduled backups are enabled, the effective cadence, persisted last-run metadata, and recent on-disk archives under BACKUP_DIR.',
  })
  @ApiResponse({ status: 200, description: 'Scheduled backup status and on-disk archive listing.' })
  async status() {
    return this.backup.getStatus();
  }

  @Get()
  @ApiOperation({
    summary: 'Download a whole-server backup',
    description:
      'Server-admin only. Returns a zip archive containing a WAL-safe snapshot of the SQLite database (via VACUUM INTO) plus every uploaded file, with a manifest. ' +
      'To include the auto-generated AI credential encryption keyfile as an encrypted envelope (issue #496), use POST /backup/download with a JSON body instead — passphrases must not travel in query strings. ' +
      'Without the envelope, a restore to a fresh DATA_DIR cannot decrypt stored provider API keys unless the operator has set AI_CONFIG_KEY out-of-band.',
  })
  @ApiResponse({ status: 200, description: 'Zip file download (application/zip, Content-Disposition attachment).' })
  async download(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.sendBackup(req, res);
  }

  @Post('download')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Download a whole-server backup (with optional key envelope passphrase)',
    description:
      'Server-admin only. Same archive as GET /backup, but accepts the issue-#496 keyfile envelope passphrase in the POST body so it is not logged in query strings or browser history. ' +
      `The passphrase MUST be at least 12 characters; short values are rejected before the archive is produced.`,
  })
  @ApiResponse({ status: 200, description: 'Zip file download (application/zip, Content-Disposition attachment).' })
  async downloadWithKeyEnvelope(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: BackupDownloadDto,
  ): Promise<void> {
    await this.sendBackup(req, res, body.keyPassphrase);
  }

  private async sendBackup(req: Request, res: Response, keyPassphrase?: string): Promise<void> {
    const operation = requestAbort(req, res);
    // Deferred until the first archive byte. Snapshot, reconciliation and staging all
    // run before any byte is produced; committing zip headers up front meant a failure
    // in that window produced a JSON error still labelled `application/zip` with an
    // attachment disposition. Today's web client uses fetch and can read the status,
    // but that is a UI detail — a curl or anchor-driven caller would just save the
    // error body as a corrupt archive.
    const onFirstByte = () => {
      res
        .status(200)
        .set({
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${this.backup.backupFilename()}"`,
          // Issue #730: never let browsers / the PWA Cache Storage retain a whole-server archive.
          'Cache-Control': 'private, no-store',
        });
    };
    try {
      // Do not start an expensive snapshot after an already-fired disconnect
      // (or after a response was already terminal before this handler ran).
      if (operation.signal.aborted) return;
      await this.backup.buildBackup(
        {
          ...(keyPassphrase && keyPassphrase.length > 0 ? { keyPassphrase } : {}),
          signal: operation.signal,
          onFirstByte,
        },
        res,
      );
    } catch (error) {
      // A client disconnect is expected during a streamed download. Preserve
      // unrelated failures even if the request happened to close at the same time.
      if (isBackupDownloadCancellation(error, operation.signal)) return;
      // Once bytes are committed the response belongs to the archive. Rethrowing would
      // have Nest write a JSON error over the in-flight ZIP — the compressed-size ceiling
      // is enforced mid-stream, so this is the *expected* path for an oversized archive,
      // not a rare one. Destroy the response instead: a truncated transfer the client can
      // detect beats a body that is half archive and half error. Mirrors the export path.
      if (res.headersSent || res.destroyed) {
        // Destroy rather than merely returning: letting the response end normally would
        // present a truncated archive as a complete one.
        if (!res.destroyed) res.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      throw error;
    } finally {
      operation.dispose();
    }
  }

  @Post('inspect')
  @HttpCode(200)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Inspect a backup archive (non-destructive)',
    description:
      'Server-admin only. Parses manifest.json and lists upload paths without restoring or modifying the live server.',
  })
  @ApiResponse({ status: 200, description: 'Manifest metadata and upload listing.' })
  @ApiResponse({ status: 400, description: 'Malformed or invalid archive.' })
  @ApiResponse({ status: 403, description: 'Not a server admin.' })
  @UseInterceptors(FileInterceptor('file', { storage: uploadStorage, limits: { fileSize: MAX_RESTORE_BYTES } }))
  async inspect(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @UploadedFile() file: MulterFile | undefined,
  ) {
    if (!file) throw new BadRequestException('Missing backup archive (multipart field "file")');
    const operation = requestAbort(req, res);
    try {
      return await this.backup.inspectFile(file.path, operation.signal);
    } finally {
      operation.dispose();
      await removeUpload(file);
    }
  }

  @Post('restore')
  @HttpCode(200)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Restore a whole-server backup',
    description:
      `Server-admin only. DESTRUCTIVE — replaces the entire database and uploads with the contents of the uploaded archive. ` +
      `The multipart body must include the archive as field "file" and a field "confirm" equal to "${RESTORE_CONFIRM_TOKEN}". ` +
      `The archive is fully validated before anything is overwritten; a malformed archive is rejected (400) with the server untouched. ` +
      `When the archive carries an encrypted AI keyfile envelope (issue #496), pass "keyPassphrase" with the passphrase used when the ` +
      `backup was cut so stored provider credentials remain decryptable after restore. Wrong passphrase → 400, server untouched.`,
  })
  @ApiResponse({ status: 200, description: 'Restore applied. Returns a summary of what was restored.' })
  @ApiResponse({ status: 400, description: 'Missing/invalid confirmation token, or malformed/invalid archive.' })
  @ApiResponse({ status: 403, description: 'Not a server admin.' })
  @UseInterceptors(FileInterceptor('file', { storage: uploadStorage, limits: { fileSize: MAX_RESTORE_BYTES } }))
  async restore(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @UploadedFile() file: MulterFile | undefined,
    @Body('confirm') confirm: string | undefined,
    @Body('keyPassphrase') keyPassphrase: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    if (!file) throw new BadRequestException('Missing backup archive (multipart field "file")');
    const operation = requestAbort(req, res);
    try {
      const fields = BackupRestoreBody.safeParse({ confirm, keyPassphrase });
      if (!fields.success) {
        const message = fields.error.issues.map((i) => i.message).join('; ');
        throw new BadRequestException(message || 'Invalid restore request');
      }
      return await this.backup.restoreFile(
        file.path, fields.data.confirm, user,
        {
          ...(fields.data.keyPassphrase ? { keyPassphrase: fields.data.keyPassphrase } : {}),
          signal: operation.signal,
        },
      );
    } finally {
      operation.dispose();
      await removeUpload(file);
    }
  }
}
