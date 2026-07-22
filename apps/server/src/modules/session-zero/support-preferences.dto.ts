import { createZodDto } from 'nestjs-zod';
import { ParticipantSupportPreferenceUpsert } from '@campfire/schema';

/** Unknown fields fail closed; privacy/consent keys are never silently ignored. */
export class ParticipantSupportPreferenceUpsertDto extends createZodDto(
  ParticipantSupportPreferenceUpsert.strict(),
) {}
