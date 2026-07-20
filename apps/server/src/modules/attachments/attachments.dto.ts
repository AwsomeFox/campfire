import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AttachmentKind, StorageQuotaUpdate } from '@campfire/schema';

/**
 * multipart/form-data upload body. The file itself arrives via FileInterceptor
 * (not part of this schema) — only the non-file field(s) are validated here.
 * `kind` decides the role-check in the controller (player+ for portrait, dm for map/image).
 */
export const AttachmentUploadFields = z.object({
  kind: AttachmentKind,
});
export class AttachmentUploadDto extends createZodDto(AttachmentUploadFields) {}

/** Body for PUT /admin/storage/campaigns/:campaignId/quota (issue #24). */
export class StorageQuotaDto extends createZodDto(StorageQuotaUpdate) {}
