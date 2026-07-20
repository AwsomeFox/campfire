import { createZodDto } from 'nestjs-zod';
import { SessionCreate, SessionUpdate, SessionAttendanceSet, ScheduledSessionCreate, ScheduledSessionUpdate, RsvpSet } from '@campfire/schema';

// .strict() at the DTO layer only (shared exports stay lenient for mcp-tools.ts /
// proposals.service.ts — see encounters.dto.ts): an unrecognized body key 400s
// instead of being silently stripped and written as a partial create/update.
export class SessionCreateDto extends createZodDto(SessionCreate.strict()) {}
export class SessionUpdateDto extends createZodDto(SessionUpdate.strict()) {}
export class SessionAttendanceSetDto extends createZodDto(SessionAttendanceSet.strict()) {}
export class ScheduledSessionCreateDto extends createZodDto(ScheduledSessionCreate.strict()) {}
export class ScheduledSessionUpdateDto extends createZodDto(ScheduledSessionUpdate.strict()) {}
export class RsvpSetDto extends createZodDto(RsvpSet.strict()) {}
