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
    title: z.string().trim().max(255).optional(), caption: z.string().trim().max(2_000).optional(), altText: z.string().trim().max(1_000).optional(),
    creator: z.string().trim().max(255).optional(), sourceUrl: z.string().trim().url().refine((v) => /^https?:\/\//i.test(v)).or(z.literal('')).optional(),
    license: z.string().trim().max(255).optional(), rights: z.string().trim().max(1_000).optional(), attribution: z.string().trim().max(1_000).optional(),
  })
  .strict();
export class AttachmentUploadDto extends createZodDto(AttachmentUploadFields) {}

export const AttachmentMetadataUpdate = AttachmentUploadFields.omit({ kind: true }).extend({ updatedAt: z.string().datetime() }).strict();
export class AttachmentMetadataUpdateDto extends createZodDto(AttachmentMetadataUpdate) {}

/** Body for PUT /admin/storage/campaigns/:campaignId/quota (issue #24). */
export class StorageQuotaDto extends createZodDto(StorageQuotaUpdate.strict()) {}
