import { createZodDto } from 'nestjs-zod';
import { EncounterCreate, CombatantCreate, CombatantUpdate, RollRequest } from '@campfire/schema';

export class EncounterCreateDto extends createZodDto(EncounterCreate) {}
export class CombatantCreateDto extends createZodDto(CombatantCreate) {}
export class CombatantUpdateDto extends createZodDto(CombatantUpdate) {}
export class RollRequestDto extends createZodDto(RollRequest) {}
