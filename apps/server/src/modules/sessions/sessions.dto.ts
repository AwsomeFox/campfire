import { createZodDto } from 'nestjs-zod';
import {
  SessionCreate,
  SessionUpdate,
  SessionAttendanceSet,
  ScheduledSessionCreate,
  ScheduledSessionUpdate,
  RsvpSetBody,
  hasRsvpSetMutation,
  RSVP_SET_REQUIRED_MESSAGE,
  ExpectedUpdatedAt,
  SessionShareCreate,
  SessionShareUpdate,
  SessionSharePolicyUpdate,
} from '@campfire/schema';

// .strict() at the DTO layer only (shared exports stay lenient for mcp-tools.ts /
// proposals.service.ts — see encounters.dto.ts): an unrecognized body key 400s
// instead of being silently stripped and written as a partial create/update.
export class SessionCreateDto extends createZodDto(SessionCreate.strict()) {}
// expectedUpdatedAt (#157) is added HERE, not in the shared SessionUpdate: it's a
// request-time optimistic-concurrency guard, kept out of the proposal payload (the
// controller's `proposed=true` branch re-parses `body` with the shared SessionUpdate,
// which drops it) and stripped in the controller before the direct-write service call.
export class SessionUpdateDto extends createZodDto(SessionUpdate.extend({ expectedUpdatedAt: ExpectedUpdatedAt }).strict()) {}
export class SessionAttendanceSetDto extends createZodDto(SessionAttendanceSet.strict()) {}
export class ScheduledSessionCreateDto extends createZodDto(ScheduledSessionCreate.strict()) {}
export class ScheduledSessionUpdateDto extends createZodDto(ScheduledSessionUpdate.strict()) {}
export class RsvpSetDto extends createZodDto(
  RsvpSetBody.strict().refine(hasRsvpSetMutation, {
    message: RSVP_SET_REQUIRED_MESSAGE,
  }),
) {}
export class SessionShareCreateDto extends createZodDto(SessionShareCreate.strict()) {}
export class SessionShareUpdateDto extends createZodDto(SessionShareUpdate) {}
export class SessionSharePolicyUpdateDto extends createZodDto(SessionSharePolicyUpdate.strict()) {}
