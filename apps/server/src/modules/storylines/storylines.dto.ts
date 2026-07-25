import { createZodDto } from 'nestjs-zod';
import {
  StoryArcCreate,
  StoryArcUpdate,
  StoryArcStatusPatch,
  StoryBeatCreate,
  StoryBeatUpdate,
  StoryBeatStatusPatch,
  StoryBranchCreate,
  StoryBranchUpdate,
  ExpectedUpdatedAt,
} from '@campfire/schema';

// .strict() at the DTO layer only — an unknown/misspelled key 400s here instead of
// the global ZodValidationPipe silently stripping it (mirrors quests.dto.ts).
export class StoryArcCreateDto extends createZodDto(StoryArcCreate.strict()) {}
// expectedUpdatedAt (#881) is added HERE, not in the shared Update schemas: a
// transport-only CAS token for optimistic concurrency on arc summary/title edits.
export class StoryArcUpdateDto extends createZodDto(StoryArcUpdate.extend({ expectedUpdatedAt: ExpectedUpdatedAt }).strict()) {}
export class StoryArcStatusPatchDto extends createZodDto(StoryArcStatusPatch) {}
export class StoryBeatCreateDto extends createZodDto(StoryBeatCreate.strict()) {}
export class StoryBeatUpdateDto extends createZodDto(StoryBeatUpdate.extend({ expectedUpdatedAt: ExpectedUpdatedAt }).strict()) {}
export class StoryBeatStatusPatchDto extends createZodDto(StoryBeatStatusPatch) {}
export class StoryBranchCreateDto extends createZodDto(StoryBranchCreate.strict()) {}
export class StoryBranchUpdateDto extends createZodDto(StoryBranchUpdate.strict()) {}
