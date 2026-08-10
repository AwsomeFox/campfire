import { createZodDto } from 'nestjs-zod';
import { PersonalNavigationTarget } from '@campfire/schema';

// .strict() at the DTO layer only — see encounters.dto.ts header comment.
export class PersonalNavigationTargetDto extends createZodDto(PersonalNavigationTarget.strict()) {}
