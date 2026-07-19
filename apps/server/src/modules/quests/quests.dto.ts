import { createZodDto } from 'nestjs-zod';
import { QuestCreate, QuestUpdate, QuestStatusPatch, ObjectiveCreate, ObjectivePatch } from '@campfire/schema';

// .strict() at the DTO layer only — see encounters.dto.ts header comment. Note:
// QuestCreate/QuestUpdate (the un-.strict()'d shared exports) are also used
// directly via .parse() in quests.controller.ts's `proposed=true` branch, but
// only on `body` AFTER it has already passed through this strict DTO in the
// @Body() pipe step — so an unknown key is rejected before that second parse
// ever runs, and the redundant re-parse itself is unaffected either way.
export class QuestCreateDto extends createZodDto(QuestCreate.strict()) {}
export class QuestUpdateDto extends createZodDto(QuestUpdate.strict()) {}
export class QuestStatusPatchDto extends createZodDto(QuestStatusPatch) {}
export class ObjectiveCreateDto extends createZodDto(ObjectiveCreate) {}
export class ObjectivePatchDto extends createZodDto(ObjectivePatch) {}
