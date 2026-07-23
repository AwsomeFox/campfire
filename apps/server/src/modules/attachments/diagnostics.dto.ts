import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const DiagnosticIssueTypeSchema = z.enum([
  'misplaced',
  'wrong-extension',
  'duplicate',
  'malformed',
  'unexpected-thumbnail',
  'orphan',
  'missing',
]);

const DiagnosticIssueSchema = z.object({
  type: DiagnosticIssueTypeSchema,
  attachmentId: z.number().nullable(),
  campaignId: z.number().nullable(),
  owner: z.string().nullable(),
  path: z.string(),
  canonicalPath: z.string().nullable(),
  size: z.number(),
  checksum: z.string(),
  detail: z.string(),
});

export const DiagnosticReportSchema = z.object({
  scannedAt: z.string(),
  totalDbRows: z.number(),
  totalDiskFiles: z.number(),
  issues: z.array(DiagnosticIssueSchema),
});

export class DiagnosticReportDto extends createZodDto(DiagnosticReportSchema) {}

const FixActionSchema = z.enum(['relink', 'quarantine']);

export class DiagnosticFixRequestDto extends createZodDto(
  z
    .object({
      attachmentId: z.number().optional(),
      diskPath: z.string().optional(),
      action: FixActionSchema,
    })
    .strict(),
) {}

const FixResultSchema = z.object({
  success: z.boolean(),
  action: FixActionSchema,
  attachmentId: z.number().nullable(),
  detail: z.string(),
});

export class FixResultDto extends createZodDto(FixResultSchema) {}
