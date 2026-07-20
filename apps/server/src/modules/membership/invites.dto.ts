import { createZodDto } from 'nestjs-zod';
import { InviteCreate, InviteAccept } from '@campfire/schema';

// .strict() — an unrecognized body key 400s instead of being silently stripped
// (see encounters.dto.ts / issue #131).
export class InviteCreateDto extends createZodDto(InviteCreate.strict()) {}
export class InviteAcceptDto extends createZodDto(InviteAccept.strict()) {}
