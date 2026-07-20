import { createZodDto } from 'nestjs-zod';
import { NoteCreate, NoteUpdate, InboxCreate, InboxResolve, ExpectedUpdatedAt } from '@campfire/schema';

// .strict() at the DTO layer only (shared exports stay lenient for mcp-tools.ts /
// proposals.service.ts — see encounters.dto.ts): an unrecognized body key 400s
// instead of being silently stripped and written as a partial create/update.
// InboxResolve is `.strict()` at its source in @campfire/schema — it's a
// `.refine()`-wrapped ZodEffects, which has no `.strict()` to apply here.
export class NoteCreateDto extends createZodDto(NoteCreate.strict()) {}
// expectedUpdatedAt (#157) added here, not in the shared NoteUpdate — see sessions.dto.ts.
export class NoteUpdateDto extends createZodDto(NoteUpdate.extend({ expectedUpdatedAt: ExpectedUpdatedAt }).strict()) {}
export class InboxCreateDto extends createZodDto(InboxCreate.strict()) {}
export class InboxResolveDto extends createZodDto(InboxResolve) {}
