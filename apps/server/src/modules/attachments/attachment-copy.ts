import fs from 'node:fs';
import path from 'node:path';
import { ALLOWED_MIME_TO_EXT, GENERATED_MIME_TO_EXT } from './attachments.service';
import { uploadsRoot } from './uploads-path';

/**
 * Absolute on-disk path for an attachment's bytes under uploadsRoot()/<campaignId>/.
 * Mirrors AttachmentsService.filePath so clone/import helpers stay in sync with GET.
 */
export function attachmentUploadPath(campaignId: number, attachmentId: number, mime: string): string {
  const ext = ALLOWED_MIME_TO_EXT[mime] ?? GENERATED_MIME_TO_EXT[mime] ?? 'bin';
  return path.join(uploadsRoot(), String(campaignId), `${attachmentId}.${ext}`);
}

/**
 * Copy attachment bytes from one campaign's uploads dir into another's (#524).
 * Caller inserts the destination attachment row first (fresh id) and passes both ids.
 * Returns true when the source file existed and was copied; false if missing (the
 * tolerated #84 row-without-file shape — GET will 404 until re-uploaded).
 */
export function copyAttachmentBytes(opts: {
  srcCampaignId: number;
  dstCampaignId: number;
  srcAttachmentId: number;
  dstAttachmentId: number;
  mime: string;
}): boolean {
  const srcPath = attachmentUploadPath(opts.srcCampaignId, opts.srcAttachmentId, opts.mime);
  if (!fs.existsSync(srcPath)) return false;
  const dstPath = attachmentUploadPath(opts.dstCampaignId, opts.dstAttachmentId, opts.mime);
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  fs.copyFileSync(srcPath, dstPath);
  return true;
}

/**
 * Rewrite a source `/attachments/<id>/file` URL through an src→dst attachment id map
 * (shared by clone + importCampaign — issue #524 / #236). Non-attachment URLs return
 * null so callers can decide whether to preserve remotes (clone) or drop them (import).
 */
export function remapAttachmentFileUrl(url: unknown, attMap: Map<number, number>): string | null {
  if (typeof url !== 'string') return null;
  const m = url.match(/\/attachments\/(\d+)\/file(?:[?#].*)?$/);
  if (!m) return null;
  const newId = attMap.get(Number(m[1]));
  return newId != null ? `/api/v1/attachments/${newId}/file` : null;
}
