import { createZodDto } from 'nestjs-zod';
import {
  StoryArcCreate,
  StoryArcUpdate,
  StoryArcStatusPatch,
  StoryBeatCreate,
  StoryBeatUpdate,
  StoryBeatStatusPatch,
  StoryBranchCreate,
} from '@campfire/schema';

// .strict() at the DTO layer only — an unknown/misspelled key 400s here instead of
// the global ZodValidationPipe silently stripping it (mirrors quests.dto.ts).
export class StoryArcCreateDto extends createZodDto(StoryArcCreate.strict()) {}
export class StoryArcUpdateDto extends createZodDto(StoryArcUpdate.strict()) {}
export class StoryArcStatusPatchDto extends createZodDto(StoryArcStatusPatch) {}
export class StoryBeatCreateDto extends createZodDto(StoryBeatCreate.strict()) {}
export class StoryBeatUpdateDto extends createZodDto(StoryBeatUpdate.strict()) {}
export class StoryBeatStatusPatchDto extends createZodDto(StoryBeatStatusPatch) {}
export class StoryBranchCreateDto extends createZodDto(StoryBranchCreate.strict()) {}
