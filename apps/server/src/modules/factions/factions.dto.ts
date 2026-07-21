import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { FactionCreate, FactionUpdate, FactionStanding, ExpectedUpdatedAt } from '@campfire/schema';

// .strict() at the DTO layer only — the shared FactionCreate/FactionUpdate exports in
// @campfire/schema stay lenient (reused verbatim by mcp-tools.ts). An unrecognized body
// key now 400s instead of the global ZodValidationPipe silently stripping it. Mirrors
// npcs.dto.ts (issue #131).
export class FactionCreateDto extends createZodDto(FactionCreate.strict()) {}
// expectedUpdatedAt (#157) added here, not in the shared FactionUpdate — see npcs.dto.ts.
export class FactionUpdateDto extends createZodDto(FactionUpdate.extend({ expectedUpdatedAt: ExpectedUpdatedAt }).strict()) {}

// Reputation control (issue #221): adjust by delta OR set an absolute score, and/or set
// the standing label. At least one field must be present (enforced in the service).
export const FactionReputationPatch = z
  .object({
    delta: z.number().int().min(-200).max(200).optional(),
    reputation: z.number().int().min(-100).max(100).optional(),
    standing: FactionStanding.optional(),
  })
  .strict();
export class FactionReputationDto extends createZodDto(FactionReputationPatch) {}
