import { createZodDto } from 'nestjs-zod';
import { SafetyBlockCreate, SafetyControl, SafetyMuteCreate } from '@campfire/schema';

// `.strict()` already applied on the schemas themselves: an unrecognized key on a
// safety request 400s rather than being silently dropped. A member who mistyped
// `targetUserId` must be told, not left believing they blocked somebody.
export class SafetyBlockCreateDto extends createZodDto(SafetyBlockCreate) {}
export class SafetyMuteCreateDto extends createZodDto(SafetyMuteCreate) {}
export class SafetyControlDto extends createZodDto(SafetyControl) {}
