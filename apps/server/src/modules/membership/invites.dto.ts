import { createZodDto } from 'nestjs-zod';
import { InviteCreate, InviteAccept, InviteDecline, InviteJoin, InvitePolicyUpdate } from '@campfire/schema';

// .strict() — an unrecognized body key 400s instead of being silently stripped
// (see encounters.dto.ts / issue #131).
export class InviteCreateDto extends createZodDto(InviteCreate.strict()) {}
export class InviteAcceptDto extends createZodDto(InviteAccept.strict()) {}
export class InvitePolicyUpdateDto extends createZodDto(InvitePolicyUpdate.strict()) {}
// Issue #600: the pre-join consent gate and the recorded refusal.
export class InviteJoinDto extends createZodDto(InviteJoin) {}
export class InviteDeclineDto extends createZodDto(InviteDecline) {}
