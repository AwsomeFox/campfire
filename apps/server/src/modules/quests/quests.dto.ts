import { createZodDto } from 'nestjs-zod';
import { QuestCreate, QuestUpdate, QuestStatusPatch, ObjectiveCreate, ObjectivePatch } from '@campfire/schema';

export class QuestCreateDto extends createZodDto(QuestCreate) {}
export class QuestUpdateDto extends createZodDto(QuestUpdate) {}
export class QuestStatusPatchDto extends createZodDto(QuestStatusPatch) {}
export class ObjectiveCreateDto extends createZodDto(ObjectiveCreate) {}
export class ObjectivePatchDto extends createZodDto(ObjectivePatch) {}
