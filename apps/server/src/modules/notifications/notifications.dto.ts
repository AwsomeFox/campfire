import { createZodDto } from 'nestjs-zod';
import { NotificationPreferencesUpdate } from '@campfire/schema';

// .strict() — an unrecognized top-level body key 400s instead of being silently
// stripped (see users.dto.ts / issue #131). Nested quietHours stays partial so a
// caller can PATCH just one field of the window.
export class NotificationPreferencesUpdateDto extends createZodDto(NotificationPreferencesUpdate.strict()) {}

import { z } from 'zod';

export const BulkNotificationSchema = z
  .object({
    ids: z.array(z.number().int().positive()).optional(),
    campaignId: z.number().int().positive().optional(),
    all: z.boolean().optional(),
  })
  .strict();

export class BulkNotificationDto extends createZodDto(BulkNotificationSchema) {}

