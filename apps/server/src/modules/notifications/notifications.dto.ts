import { createZodDto } from 'nestjs-zod';
import {
  BrowserPushSubscription,
  BrowserPushUnsubscribe,
  NotificationPreferencesUpdate,
} from '@campfire/schema';

// .strict() — an unrecognized top-level body key 400s instead of being silently
// stripped (see users.dto.ts / issue #131). Nested quietHours stays partial so a
// caller can PATCH just one field of the window.
export class NotificationPreferencesUpdateDto extends createZodDto(NotificationPreferencesUpdate.strict()) {}

export class BrowserPushSubscriptionDto extends createZodDto(BrowserPushSubscription.strict()) {}

export class BrowserPushUnsubscribeDto extends createZodDto(BrowserPushUnsubscribe.strict()) {}

import { z } from 'zod';

export const BulkNotificationSchema = z
  .object({
    ids: z.array(z.number().int().positive()).optional(),
    campaignId: z.number().int().positive().optional(),
    all: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => (value.ids?.length ?? 0) > 0 || value.campaignId !== undefined || value.all === true,
    { message: 'At least one of ids, campaignId, or all must be provided' },
  );

export class BulkNotificationDto extends createZodDto(BulkNotificationSchema) {}
