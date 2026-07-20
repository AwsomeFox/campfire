import { createZodDto } from 'nestjs-zod';
import { QuestCreate, QuestUpdate, QuestStatusPatch, ObjectiveCreate, ObjectivePatch, ObjectiveReorder, ExpectedUpdatedAt } from '@campfire/schema';

// .strict() at the DTO layer only — see encounters.dto.ts header comment. Note:
// QuestCreate/QuestUpdate (the un-.strict()'d shared exports) are also used
// directly via .parse() in quests.controller.ts's `proposed=true` branch, but
// only on `body` AFTER it has already passed through this strict DTO in the
// @Body() pipe step — so an unknown key is rejected before that second parse
// ever runs, and the redundant re-parse itself is unaffected either way.
export class QuestCreateDto extends createZodDto(QuestCreate.strict()) {}
// expectedUpdatedAt (#157) added here, not in the shared QuestUpdate — see sessions.dto.ts.
export class QuestUpdateDto extends createZodDto(QuestUpdate.extend({ expectedUpdatedAt: ExpectedUpdatedAt }).strict()) {}
export class QuestStatusPatchDto extends createZodDto(QuestStatusPatch.strict()) {}
export class ObjectiveCreateDto extends createZodDto(ObjectiveCreate.strict()) {}
export class ObjectivePatchDto extends createZodDto(ObjectivePatch.strict()) {}
export class ObjectiveReorderDto extends createZodDto(ObjectiveReorder.strict()) {}
