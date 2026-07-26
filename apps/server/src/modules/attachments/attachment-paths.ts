/**
 * Leaf module for attachment on-disk naming (issue #604).
 *
 * These maps and path builders used to live in attachments.service.ts, which is
 * fine for the controller and the copy helpers but not for
 * AttachmentDerivativesService: the service that GENERATES derivatives is a
 * dependency OF AttachmentsService, so it cannot import from it without a
 * module cycle. Hoisting the naming rules into a leaf (same reasoning as
 * attachment.constants.ts) keeps one definition of "where do an attachment's
 * bytes live" for every caller. attachments.service.ts re-exports the two mime
 * maps so existing importers are untouched.
 */
import path from 'node:path';
import { uploadsRoot } from './uploads-path';
import { DERIVATIVE_EXT, type DerivativeVariantName } from './image-derivatives';

/** image/png|jpeg|webp and application/pdf — matches the multer fileFilter in attachments.controller.ts. */
export const ALLOWED_MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/**
 * Mime → extension for SERVER-GENERATED attachments only (issue #306). Kept separate
 * from the ALLOWED_MIME_TO_EXT upload allowlist above: uploads stay png/jpeg/webp
 * (raster, magic-byte sniffed), while the procedural map generator produces SVG whose
 * bytes the server itself authors (no untrusted upload, so no sniff needed).
 * attachmentFilePath() consults both maps so a generated .svg map resolves to the
 * right on-disk name.
 */
export const GENERATED_MIME_TO_EXT: Record<string, string> = {
  'image/svg+xml': 'svg',
};

/** Same-filesystem stage suffix so link(stage, final) + unlink(stage) can publish. */
export const STAGE_SUFFIX = '.stage';

export function attachmentExtForMime(mime: string): string {
  return ALLOWED_MIME_TO_EXT[mime] ?? GENERATED_MIME_TO_EXT[mime] ?? 'bin';
}

/** Absolute path a stored attachment's original bytes live at. */
export function attachmentFilePath(row: { campaignId: number; id: number; mime: string }): string {
  return path.join(uploadsRoot(), String(row.campaignId), `${row.id}.${attachmentExtForMime(row.mime)}`);
}

/**
 * Absolute path a generated derivative lives at: `<campaign>/<id>.<variant>.png`.
 *
 * The `thumb` rung deliberately resolves to the SAME `<id>.thumb.png` name the
 * pre-#604 synchronous thumbnailer used, so an upgrade reuses the existing
 * filename (and the existing diagnostics/orphan classifier keeps recognising it)
 * instead of stranding a second copy on disk.
 */
export function derivativeFilePath(
  row: { campaignId: number; id: number },
  variant: DerivativeVariantName,
): string {
  return path.join(uploadsRoot(), String(row.campaignId), `${row.id}.${variant}.${DERIVATIVE_EXT}`);
}
