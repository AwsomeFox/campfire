import { createZodDto } from 'nestjs-zod';
import { NpcCreate, NpcUpdate } from '@campfire/schema';

// .strict() at the DTO layer only — the shared NpcCreate/NpcUpdate exports in
// @campfire/schema stay lenient (reused verbatim by mcp-tools.ts and
// proposals.service.ts; see encounters.dto.ts header). An unrecognized body key
// now 400s instead of the global ZodValidationPipe silently stripping it and
// 201/200/202-ing as a partial write. This is the concrete case from issue #131:
// POST .../npcs?proposed=true with a misnamed field like `{ description: ... }`
// (the real column is `body`) used to return 202 and store an emptier-than-intended NPC.
export class NpcCreateDto extends createZodDto(NpcCreate.strict()) {}
export class NpcUpdateDto extends createZodDto(NpcUpdate.strict()) {}
