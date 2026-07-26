import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { AuditLegalHold, AuditRetentionPolicyUpdate } from '@campfire/schema';

export class AuditRetentionPolicyUpdateDto extends createZodDto(AuditRetentionPolicyUpdate.strict()) {}

export class AuditPruneRequestDto extends createZodDto(
  z
    .object({
      confirm: z.boolean().optional(),
      retentionDays: z.number().int().optional(),
      force: z.boolean().optional(),
    })
    .strict(),
) {}

export class AuditLegalHoldDto extends createZodDto(AuditLegalHold.strict()) {}
