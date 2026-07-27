import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import {
  ModerationActionRequest,
  ModerationEvidence,
  ModerationIncidentExport,
  ModerationReport,
  ModerationReportCreate,
  ModerationReportPage,
  ModerationRetentionPolicyUpdate,
} from '@campfire/schema';

// `.strict()` at the DTO layer, matching notes/comments: an unrecognized body key
// 400s rather than being silently dropped. For a moderation report that matters more
// than usual — a reporter who mistyped a field must be told, not quietly filed.
export class ModerationReportCreateDto extends createZodDto(ModerationReportCreate) {}
export class ModerationActionRequestDto extends createZodDto(ModerationActionRequest) {}
export class ModerationReportDto extends createZodDto(ModerationReport) {}
export class ModerationReportPageDto extends createZodDto(ModerationReportPage) {}
export class ModerationEvidenceDto extends createZodDto(ModerationEvidence) {}
export class ModerationIncidentExportDto extends createZodDto(ModerationIncidentExport) {}
export class ModerationRetentionPolicyUpdateDto extends createZodDto(ModerationRetentionPolicyUpdate.strict()) {}

/**
 * Explicit redaction request (issue #601 bullet 6). A free-text reason is REQUIRED:
 * redaction destroys the only copy of the evidence prose, so "why" must be on the
 * record before it happens, not reconstructed afterwards.
 */
export class ModerationRedactRequestDto extends createZodDto(
  z.object({ reason: z.string().min(3).max(500) }).strict(),
) {}

/**
 * Break-glass request. `justification` is required and minimum-length-checked in the
 * service as well — a form that can be submitted empty is not a control.
 */
export class ModerationBreakGlassDto extends createZodDto(
  z.object({ justification: z.string().min(10).max(2000) }).strict(),
) {}
