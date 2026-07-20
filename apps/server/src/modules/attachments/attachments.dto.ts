import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AttachmentKind, StorageQuotaUpdate } from '@campfire/schema';

/**
 * multipart/form-data upload body. The file itself arrives via FileInterceptor
 * (not part of this schema) — only the non-file field(s) are validated here.
 * `kind` decides the role-check in the controller (player+ for portrait, dm for map/image).
 */
// .strict() — the file arrives via FileInterceptor (stripped from the body before
// this runs), so the only valid non-file field is `kind`; any other field 400s
// instead of being silently ignored (see encounters.dto.ts / issue #131).
export const AttachmentUploadFields = z
  .object({
    kind: AttachmentKind,
  })
  .strict();
export class AttachmentUploadDto extends createZodDto(AttachmentUploadFields) {}

/** Body for PUT /admin/storage/campaigns/:campaignId/quota (issue #24). */
export class StorageQuotaDto extends createZodDto(StorageQuotaUpdate.strict()) {}
