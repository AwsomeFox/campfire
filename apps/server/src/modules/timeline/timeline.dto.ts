import { createZodDto } from 'nestjs-zod';
import { TimelineEventCreate, TimelineEventUpdate, TimelineCalendarUpdate } from '@campfire/schema';

// .strict() at the DTO layer only (see quests.dto.ts / encounters.dto.ts header
// comments): an unrecognized body key 400s instead of the global ZodValidationPipe
// silently stripping it and 201-ing as a partial write.
export class TimelineEventCreateDto extends createZodDto(TimelineEventCreate.strict()) {}
export class TimelineEventUpdateDto extends createZodDto(TimelineEventUpdate.strict()) {}
export class TimelineCalendarUpdateDto extends createZodDto(TimelineCalendarUpdate.strict()) {}
