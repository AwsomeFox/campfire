import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  BadRequestException,
  ConflictException,
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
import { attachments, auditLog, campaigns, characters, encounters, factions, locations, npcs } from '../../db/schema';
import { nowIso } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import { FsDeletionService, type FsDeletionOutcome } from './fs-deletion.service';
import { uploadsRoot } from './uploads-path';
import { auditActor, roleAtLeast } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import { persistedFogConcealsPixels } from '../../common/fog';
import { sanitizeAttachmentFilename } from './filename';
import {
  ATTACHMENT_STATE_COMMITTED,
  ATTACHMENT_STATE_RESERVED,
} from './attachment.constants';
import {
  ALLOWED_MIME_TO_EXT,
  GENERATED_MIME_TO_EXT,
  STAGE_SUFFIX,
  attachmentFilePath,
  derivativeFilePath,
} from './attachment-paths';
import {
  AttachmentDerivativesService,
  type DerivativeManifest,
} from './attachment-derivatives.service';
import {
  DERIVATIVE_EXT,
  DERIVATIVE_MIME,
  DERIVATIVE_VARIANT_NAMES,
  ImageLimitError,
  isDerivableMime,
  probeImageWithinLimits,
  type ImageProbe,
  type RequestedSize,
} from './image-derivatives';

export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024; // 32MB

/**
 * The mime→extension maps moved to the leaf module attachment-paths.ts (issue #604)
 * so AttachmentDerivativesService — which AttachmentsService now depends on — can
 * share them without a module cycle. Re-exported here unchanged because every
 * existing importer (export, campaigns, diagnostics, attachment-copy, the
 * controller) reads them from this module.
 */
export { ALLOWED_MIME_TO_EXT, GENERATED_MIME_TO_EXT };

/** `<id>.<variant>.png.stage` — a derivative write interrupted mid-flight (#604). */
const DERIVATIVE_STAGE_RE = new RegExp(
  `^\\d+\\.(${DERIVATIVE_VARIANT_NAMES.join('|')})\\.${DERIVATIVE_EXT}\\${STAGE_SUFFIX}$`,
);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RESERVED = ATTACHMENT_STATE_RESERVED;
const COMMITTED = ATTACHMENT_STATE_COMMITTED;

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

/**
 * Content sniffing for multipart uploads: the three allowed image types plus PDF.
 * Returns the detected mime, or null when the bytes match none of them.
 *
 *  - PNG:  89 50 4E 47 0D 0A 1A 0A
 *  - JPEG: FF D8 FF
 *  - WebP: "RIFF" <4-byte size> "WEBP"
 *  - PDF:  "%PDF"
 */
function sniffUploadMime(buffer: Buffer): string | null {
  const image = sniffImageMime(buffer);
  if (image) return image;
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  return null;
}

type AttachmentMetadata = { title: string; caption: string; altText: string; creator: string; sourceUrl: string; license: string; rights: string; attribution: string };
type AttachmentMetadataPatch = Partial<AttachmentMetadata>;

function toDomain(row: typeof attachments.$inferSelect): Attachment {
  return {
    id: row.id,
    campaignId: row.campaignId,
    uploaderUserId: row.uploaderUserId,
    kind: row.kind as AttachmentKind,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    title: row.title,
    caption: row.caption,
    altText: row.altText,
    creator: row.creator,
    sourceUrl: row.sourceUrl,
    license: row.license,
    rights: row.rights,
    attribution: row.attribution,
    checksumSha256: row.checksumSha256,
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
    private readonly fsDeletion: FsDeletionService,
    /**
     * Issue #604. Injected one-way (derivatives never import this service) so the
     * O(pixels) work has a home that is not the request path. Every method used
     * from here is either a plan/kick (returns immediately) or a single indexed
     * SELECT (resolveBest / manifest).
     */
    private readonly derivatives: AttachmentDerivativesService,
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
    return attachmentFilePath(row);
  }

  /**
   * Absolute paths of every responsive derivative this attachment could own
   * (issue #604). Used by delete/rollback so a removed attachment never strands
   * its ladder on disk. Paths are returned whether or not the file exists — the
   * deletion queue treats a missing path as an already-satisfied erasure.
   */
  private derivativePaths(row: { campaignId: number; id: number }): string[] {
    return this.derivatives.derivativePathsFor(row);
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
   * Resolve the file to serve for a GET, honouring the `?size=` responsive
   * variant (issue #604).
   *
   * THIS METHOD NEVER DECODES AN IMAGE. Before #604 it called a synchronous PNG
   * decoder on the request thread the first time a thumbnail was requested, and
   * fell back to the multi-MB ORIGINAL for every format that decoder did not
   * support — the two halves of the map-performance defect. Now it is a single
   * indexed lookup against the durable `attachment_derivatives` ladder:
   *
   *   - a ready rung at (or below) the requested size wins;
   *   - otherwise the ORIGINAL is served, and `derivative` reports why. That
   *     fallback is a DOCUMENTED LAST RESORT for exactly three cases: the ladder
   *     is still `pending` (first seconds after upload), every rung was `skipped`
   *     because the source is already small, or generation `failed`. It is no
   *     longer the default outcome for JPEG/WebP/SVG.
   *
   * The returned `derivative` field is echoed as the `X-Campfire-Derivative`
   * response header so clients (and the e2e suite) can tell a real derivative
   * from a fallback without inspecting pixels.
   */
  resolveFile(
    row: { campaignId: number; id: number; mime: string; filename: string; size: number },
    variant: RequestedSize,
  ): { path: string; mime: string; size: number; etag: string; derivative: string } {
    const originalPath = this.filePath(row);

    if (variant !== 'original' && isDerivableMime(row.mime)) {
      const best = this.derivatives.resolveBest(row.id, variant);
      if (best) {
        const derivativePath = derivativeFilePath(row, best.variant);
        // Trust the row only as far as the bytes still exist: an operator-side
        // `rm` or a half-restored volume must degrade to the original rather
        // than 500 on a missing path inside the stream.
        if (fs.existsSync(derivativePath)) {
          return {
            path: derivativePath,
            mime: DERIVATIVE_MIME,
            size: fs.statSync(derivativePath).size,
            etag: this.etagForPath(derivativePath),
            derivative: best.variant,
          };
        }
      }
    }

    return {
      path: originalPath,
      mime: row.mime,
      size: row.size,
      etag: this.etagForPath(originalPath),
      derivative: variant === 'original' ? 'original' : 'original-fallback',
    };
  }

  /**
   * Responsive-delivery manifest for an attachment (issue #604): which rungs are
   * ready (with their real pixel dimensions, so the client can emit an accurate
   * `srcset`), which are still processing, and which failed. Also flags STALE
   * rungs by comparing each rung's recorded source hash against the current
   * bytes — see AttachmentDerivativesService.manifest for why that can happen.
   */
  derivativeManifest(row: { campaignId: number; id: number; mime: string }): DerivativeManifest {
    let sourceEtag: string | undefined;
    try {
      // etagForPath is memoised per path, so this is a hash only on the first
      // call for this attachment in this process — not per manifest request.
      sourceEtag = this.etagForPath(this.filePath(row)).replaceAll('"', '');
    } catch {
      // Missing/unreadable original: staleness is simply unknown, and the
      // manifest still reports pending/failed rungs honestly.
      sourceEtag = undefined;
    }
    return this.derivatives.manifest(row.id, sourceEtag);
  }

  /**
   * DM-triggered recovery for a failed/stale ladder (issue #604). Re-plans from
   * the current source header and kicks the background drain; returns the fresh
   * manifest so the UI can flip straight to "processing" without a poll.
   */
  async retryDerivatives(row: { campaignId: number; id: number; mime: string }): Promise<DerivativeManifest> {
    return this.derivatives.retry(row);
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

  private openExportFile(
    row: { campaignId: number; id: number; mime: string },
  ): { path: string; fd: number } | null {
    const source = this.filePath(row);
    let fd: number;
    try {
      fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (error: unknown) {
      // A missing row-backed file is an expected export race. Permission and
      // other I/O errors must remain visible to the archive caller instead of
      // silently omitting bytes as though the attachment had vanished.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ELOOP') return null;
      throw error;
    }
    try {
      if (!fs.fstatSync(fd).isFile()) {
        fs.closeSync(fd);
        return null;
      }
      return { path: source, fd };
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }

  /** Probe export availability without retaining an open descriptor. */
  hasExportFile(row: { campaignId: number; id: number; mime: string }): boolean {
    const source = this.openExportFile(row);
    if (!source) return false;
    fs.closeSync(source.fd);
    return true;
  }

  /**
   * Open a row-backed regular file without following a final-component symlink.
   * The returned stream owns the validated descriptor, eliminating a check/open
   * race between attachment planning and archive staging.
   */
  openExportStreamIfPresent(
    row: { campaignId: number; id: number; mime: string },
  ): fs.ReadStream | null {
    const source = this.openExportFile(row);
    if (!source) return null;
    try {
      return fs.createReadStream(source.path, { fd: source.fd, autoClose: true });
    } catch (error) {
      fs.closeSync(source.fd);
      throw error;
    }
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
        { filename: `${prefix}${row.filename}`, mime: row.mime, bytes, metadata: {
          title: row.title, caption: row.caption, altText: row.altText, creator: row.creator, sourceUrl: row.sourceUrl,
          license: row.license, rights: row.rights, attribution: row.attribution,
        } },
        user,
        role,
        undefined,
        'attachment.generate',
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
      user, role, {
        title: row.title, caption: row.caption, altText: row.altText, creator: row.creator, sourceUrl: row.sourceUrl,
        license: row.license, rights: row.rights, attribution: row.attribution,
      },
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

  /** Correct descriptive/provenance metadata without ever changing bytes or visibility. */
  async updateMetadata(
    id: number,
    input: AttachmentMetadataPatch & { updatedAt: string },
    user: RequestUser,
    role: Role,
  ): Promise<Attachment> {
    const existing = await this.getRowOrThrow(id);
    if (role !== 'dm' && existing.uploaderUserId !== user.id) {
      throw new ForbiddenException('Only the uploader or a DM can correct attachment metadata');
    }
    if (existing.updatedAt !== input.updatedAt) throw new ConflictException('Attachment metadata changed; reload before saving');
    const { updatedAt: _updatedAt, ...patch } = input;
    const before = {
      title: existing.title, caption: existing.caption, altText: existing.altText, creator: existing.creator,
      sourceUrl: existing.sourceUrl, license: existing.license, rights: existing.rights, attribution: existing.attribution,
    };
    const after = { ...before, ...patch };
    const ts = nowIso();
    const row = this.db.transaction((tx) => {
      const updated = tx.update(attachments).set({ ...patch, updatedAt: ts }).where(and(eq(attachments.id, id), eq(attachments.updatedAt, input.updatedAt))).returning().get();
      if (!updated) throw new ConflictException('Attachment metadata changed; reload before saving');
      tx.run(sql`INSERT INTO attachment_metadata_revisions (attachment_id, actor_user_id, before_json, after_json, created_at)
        VALUES (${id}, ${user.id}, ${JSON.stringify(before)}, ${JSON.stringify(after)}, ${ts})`);
      return updated;
    });
    await this.audit.log({ actor: auditActor(user), actorRole: role, action: 'attachment.metadata.update', entityType: 'attachment', entityId: id, campaignId: existing.campaignId, detail: 'attribution/accessibility metadata corrected' });
    return toDomain(row);
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
    metadata: Partial<AttachmentMetadata> = {},
  ): Promise<Attachment> {
    const sniffed = sniffUploadMime(file.buffer);
    if (sniffed !== file.mimetype) {
      throw new BadRequestException(
        `File content does not match the declared type ${file.mimetype} — allowed: image/png, image/jpeg, image/webp, application/pdf`,
      );
    }
    if (sniffed === 'application/pdf' && kind !== 'image') {
      throw new BadRequestException('PDF uploads are only allowed for handout attachments (kind=image)');
    }

    // Issue #604 — decompression-bomb defence, BEFORE anything commits to a
    // decode. MAX_UPLOAD_BYTES does not bound pixels: a maximally-compressible
    // PNG reaches gigapixels in a few hundred KB, and the old code would then
    // inflate exactly that on a request thread the first time a thumbnail was
    // asked for. probeImageWithinLimits reads only the container header, so this
    // costs microseconds on the happy path and rejects the bomb outright.
    const probe = await this.validateImageLimits(file.buffer, file.mimetype);

    return this.createAndPublish(
      campaignId,
      kind,
      { filename: file.originalname, mime: file.mimetype, bytes: file.buffer, metadata },
      user,
      role,
      'attachment.upload',
      undefined,
      probe,
    );
  }

  /**
   * Enforce the #604 image caps for an UNTRUSTED upload. Returns the probe so the
   * derivative planner does not repeat the header read, or undefined for a
   * non-image (PDF) upload.
   *
   * Status mapping is deliberate: a bomb is "your payload is too large for us to
   * process" (413, same family as the quota/size rejections a DM already
   * understands), while a corrupt or absurdly-shaped image is a malformed request
   * (400).
   */
  private async validateImageLimits(bytes: Buffer, mime: string): Promise<ImageProbe | undefined> {
    if (!isDerivableMime(mime)) return undefined;
    try {
      return await probeImageWithinLimits(bytes);
    } catch (err) {
      if (err instanceof ImageLimitError) {
        if (err.reason === 'pixels') throw new PayloadTooLargeException(err.message);
        throw new BadRequestException(err.message);
      }
      throw err;
    }
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
    file: { filename: string; mime: string; bytes: Buffer; metadata?: Partial<AttachmentMetadata> },
    user: RequestUser,
    role: Role,
    /**
     * Optional richer audit `detail` (issue #409). Defaults to the attachment `kind`
     * (unchanged for every existing caller). The procedural map generator passes
     * `map:generator-builtin:seed=<seed>` so the audit trail names the source and the
     * exact seed, keeping a generated map attributable + reproducible.
     */
    auditDetail?: string,
    auditAction: string = 'attachment.generate',
  ): Promise<Attachment> {
    // Issue #604: "generated" does not always mean "authored by us". The curated
    // external-map import (maps.service → 'map.import') routes an UNTRUSTED raster
    // upload through here, so the same header-only bomb check the multipart path
    // runs must apply. SVG is exempt: those bytes really are server-authored by the
    // procedural generator, and a probe failure there would break map generation on
    // a sharp build without SVG support rather than protect anything.
    const probe =
      file.mime === 'image/svg+xml' ? undefined : await this.validateImageLimits(file.bytes, file.mime);

    return this.createAndPublish(
      campaignId,
      kind,
      file,
      user,
      role,
      auditAction,
      auditDetail,
      probe,
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
    file: { filename: string; mime: string; bytes: Buffer; metadata?: Partial<AttachmentMetadata> },
    user: RequestUser,
    role: Role,
    auditAction: string = 'attachment.upload',
    auditDetail?: string,
    /** Header probe from upload validation, threaded through to avoid a re-read (#604). */
    probe?: ImageProbe,
  ): Promise<Attachment> {
    const row = await this.reserveQuota(campaignId, kind, file, user);
    try {
      this.stageAndPublish(row, file.bytes);
      const committed = this.commitPublication(row, user, role, auditAction, auditDetail);
      // Issue #604: plan the responsive ladder only AFTER the publication is
      // committed, so an interrupted upload (rolled back, never resumed) cannot
      // leave derivative rows pointing at bytes that no longer exist. Planning
      // is a handful of INSERTs; the actual rendering happens on the background
      // drain, so the upload response is not delayed by image work.
      await this.planDerivativesQuietly(committed, probe);
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
   * Plan the responsive ladder for a just-committed attachment (issue #604).
   *
   * Failures here are logged, not propagated: the attachment IS published and its
   * original is servable, so turning a planning hiccup into a failed upload would
   * be strictly worse for the DM. The consequence is visible rather than hidden —
   * the attachment's manifest reports `unsupported`/`failed`, the map surface
   * shows its error state with a Retry, and the boot backfill re-adopts any
   * attachment that ended up with no ladder at all.
   */
  private async planDerivativesQuietly(
    row: { id: number; campaignId: number; mime: string },
    probe?: ImageProbe,
  ): Promise<void> {
    try {
      await this.derivatives.planForAttachment(row, probe);
    } catch (err) {
      this.logger.error(
        `Could not plan responsive derivatives for attachment ${row.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
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
    file: { filename: string; mime: string; bytes: Buffer; metadata?: Partial<AttachmentMetadata> },
    user: RequestUser,
  ): Promise<typeof attachments.$inferSelect> {
    const size = file.bytes.length;
    const ts = nowIso();
    // Issue #630: grapheme-safe truncation + path/control scrubbing (not bare
    // String#slice, which can bisect a surrogate pair).
    const filename = sanitizeAttachmentFilename(file.filename);
    const metadata = file.metadata ?? {};
    const checksum = crypto.createHash('sha256').update(file.bytes).digest('hex');
    const inserted = this.db.all<{
      id: number;
      campaignId: number;
      uploaderUserId: string;
      kind: string;
      filename: string;
      mime: string;
      size: number;
      title: string;
      caption: string;
      altText: string;
      creator: string;
      sourceUrl: string;
      license: string;
      rights: string;
      attribution: string;
      checksumSha256: string | null;
      hidden: number;
      state: string;
      createdAt: string;
      updatedAt: string;
    }>(sql`
      INSERT INTO attachments (
        campaign_id, uploader_user_id, kind, filename, mime, size, title, caption, alt_text, creator, source_url, license, rights, attribution, checksum_sha256, hidden, state, created_at, updated_at
      )
      SELECT
        ${campaignId}, ${user.id}, ${kind}, ${filename}, ${file.mime}, ${size},
        ${metadata.title ?? ''}, ${metadata.caption ?? ''}, ${metadata.altText ?? ''}, ${metadata.creator ?? ''}, ${metadata.sourceUrl ?? ''}, ${metadata.license ?? ''}, ${metadata.rights ?? ''}, ${metadata.attribution ?? ''}, ${checksum},
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
        title,
        caption,
        alt_text AS altText,
        creator,
        source_url AS sourceUrl,
        license,
        rights,
        attribution,
        checksum_sha256 AS checksumSha256,
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
    action: string,
    auditDetail?: string,
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
          detail: auditDetail ?? row.kind,
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
    // Issue #604: a rolled-back reservation never had derivatives planned (planning
    // happens after commit), but a retried upload can reuse an id whose ladder
    // files are still on disk from a previous life — scrub every rung's final and
    // stage name so a stale derivative can never be served for new bytes.
    const derivativeArtifacts = this.derivativePaths(row).flatMap((candidate) => [
      candidate,
      `${candidate}${STAGE_SUFFIX}`,
    ]);
    for (const candidate of [this.stagePath(row), finalPath, ...derivativeArtifacts]) {
      fs.rmSync(candidate, { force: true });
      this.etagCache.delete(candidate);
    }
    this.derivatives.forgetAttachment(row.id);
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
        // Issue #604: a derivative stage (`<id>.<variant>.png.stage`) is left by a
        // crash mid-derivative-write. Unlike a publication stage it is NEVER
        // resumable and never tied to a reservation — the ladder row is the durable
        // record, and the drain simply regenerates — so it is always removed. Its
        // two-dot name would otherwise slip past the single-dot publication pattern
        // below and linger until an admin ran orphan cleanup.
        if (DERIVATIVE_STAGE_RE.test(entry.name)) {
          try {
            fs.rmSync(path.join(dir, entry.name), { force: true });
            removed = true;
          } catch (err) {
            this.logger.error(
              `Could not remove staged derivative artifact ${path.join(dir, entry.name)}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
          continue;
        }
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
   *  - character.portraitUrl, npc.portraitUrl, faction.portraitUrl, and location.portraitUrl,
   *    if any point at this attachment's file route (`.../attachments/<id>/file` — portraitUrl is
   *    a resolved URL string, not a numeric FK, so it's matched by suffix rather than equality).
   * Without this, deleting an attachment still in use left the campaign map / encounter
   * map / character or NPC portrait pointing at a now-404ing file.
   */
  async remove(id: number, user: RequestUser, role: Role): Promise<FsDeletionOutcome> {
    const existing = await this.getRowOrThrow(id);
    // Issue #1636 defense in depth: `uploaderUserId` is never cleared by a role change, so
    // the ownership check below alone would still let a member demoted from player to
    // viewer delete files they uploaded while a player. Both callers (REST + MCP) already
    // gate on requireRole('player'), but this service must stay safe even if a future
    // caller forgets that, matching #1450's defense-in-depth pattern.
    if (!roleAtLeast(role, 'player')) {
      throw new ForbiddenException('Viewers may not delete attachments.');
    }
    if (role !== 'dm' && existing.uploaderUserId !== user.id) {
      throw new ForbiddenException('Only the uploader or dm may delete this attachment');
    }

    const auditCtx = {
      scope: 'attachment' as const,
      auditPrefix: 'attachment.delete',
      actor: auditActor(user),
      actorRole: role,
      campaignId: existing.campaignId,
      entityType: 'attachment',
      entityId: id,
    };
    await this.fsDeletion.auditRequested(auditCtx);

    const filePath = this.filePath(existing);
    // Issue #604: every responsive rung is an upload artifact too, so it goes
    // through the SAME verified-erasure queue as the original rather than a
    // best-effort unlink. The ladder rows themselves are dropped by the ON DELETE
    // CASCADE on attachment_derivatives (belt-and-braces forgetAttachment below
    // covers a DB whose FK enforcement is off).
    const derivativePaths = this.derivativePaths(existing);
    // Reserve FS cleanup rows as `held` BEFORE metadata commit so a crash cannot
    // orphan bytes without a durable retry record — drain skips `held` until
    // metadata is gone (orchestrator / #727).
    const planned = await this.fsDeletion.reserveUploadPaths([filePath, ...derivativePaths], auditCtx);

    // Match the attachment file URL with an optional cache-buster query string (e.g.
    // `?v=...` appended to AI-generated portrait URLs). Without the trailing `%`, a versioned
    // URL ending in `?v=abc` would not match and portraitUrl would not be cleared when the
    // attachment is deleted (review feedback on issue #1321).
    const portraitSuffix = `%/attachments/${id}/file%`;
    this.db.transaction((tx) => {
      tx.delete(attachments).where(eq(attachments.id, id)).run();
      tx.update(campaigns).set({ mapAttachmentId: null }).where(eq(campaigns.mapAttachmentId, id)).run();
      tx.update(encounters).set({ mapAttachmentId: null }).where(eq(encounters.mapAttachmentId, id)).run();
      tx.update(characters).set({ portraitUrl: null }).where(like(characters.portraitUrl, portraitSuffix)).run();
      tx.update(npcs).set({ portraitUrl: null }).where(like(npcs.portraitUrl, portraitSuffix)).run();
      tx.update(factions).set({ portraitUrl: null }).where(like(factions.portraitUrl, portraitSuffix)).run();
      tx.update(locations).set({ portraitUrl: null }).where(like(locations.portraitUrl, portraitSuffix)).run();
    });

    await this.fsDeletion.auditMetadataComplete(auditCtx, existing.kind);

    this.derivatives.forgetAttachment(id);
    this.etagCache.delete(filePath);
    for (const derivativePath of derivativePaths) this.etagCache.delete(derivativePath);

    return this.fsDeletion.completeReservedUploadPaths(planned, auditCtx);
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

    const fsCleanup = await this.fsDeletion.listPendingSummary();

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
      fsCleanup,
    };
  }

  /**
   * Delete orphans: attachment rows whose file is missing on disk, and on-disk
   * upload files (originals or thumbnails) with no backing row. With `dryRun` the
   * counts are reported but nothing is deleted. Server-admin action.
   *
   * Row deletion also clears dangling references (campaign map / encounter map /
   * character portrait / NPC portrait / faction portrait / location portrait), mirroring
   * remove(), so cleanup never leaves a pointer to a row it just dropped.
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
          tx.update(npcs).set({ portraitUrl: null }).where(like(npcs.portraitUrl, portraitSuffix)).run();
          tx.update(factions).set({ portraitUrl: null }).where(like(factions.portraitUrl, portraitSuffix)).run();
          tx.update(locations).set({ portraitUrl: null }).where(like(locations.portraitUrl, portraitSuffix)).run();
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
    // Issue #604: `<id>.<variant>.png` for every ladder rung, which subsumes the
    // pre-#604 `<id>.thumb.png` name (`thumb` is still the smallest rung, so old
    // files stay owned across an upgrade rather than being reaped as orphans).
    const derivativeMatch = new RegExp(`^(\\d+)\\.(${DERIVATIVE_VARIANT_NAMES.join('|')})\\.${DERIVATIVE_EXT}$`).exec(
      name,
    );
    if (derivativeMatch) {
      const id = Number(derivativeMatch[1]);
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
