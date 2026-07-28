import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class RepairPreviewDto extends createZodDto(z.object({
  findingId: z.number().int().positive(), action: z.enum(['relink', 'null', 'quarantine']),
  replacementParentId: z.number().int().positive().optional(), expectedVersion: z.number().int().positive(),
}).strict()) {}
export class RepairApplyDto extends createZodDto(z.object({
  findingId: z.number().int().positive(), action: z.enum(['relink', 'null', 'quarantine']),
  replacementParentId: z.number().int().positive().optional(), expectedVersion: z.number().int().positive(), previewToken: z.string().uuid(),
}).strict()) {}
