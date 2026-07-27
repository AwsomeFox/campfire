import { createZodDto } from 'nestjs-zod';
import {
  SessionCreate,
  SessionUpdate,
  SessionAttendanceSet,
  ScheduledSessionCreate,
  ScheduledSessionCancel,
  ScheduledSessionRestore,
  ScheduledSessionDuplicate,
  ScheduledSessionUpdate,
  RsvpSetBody,
  hasAnyRsvpSetField,
  RSVP_SET_REQUIRED_MESSAGE,
  ExpectedUpdatedAt,
  SessionShareCreate,
  SessionShareUpdate,
  SessionSharePolicyUpdate,
  PlayVenueCreate,
  PlayVenueUpdate,
  PlayRoomCreate,
  PlayRoomUpdate,
  SessionSeriesCreate,
  SessionSeriesUpdate,
  SessionSeriesExtend,
  SessionSeriesCancel,
  OccurrenceReschedule,
  OccurrenceReassign,
  ScheduleConflictQuery,
  ScheduleTemplateCreate,
  ScheduleTemplateApply,
} from '@campfire/schema';
import { z } from 'zod';

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
export class ScheduledSessionUpdateDto extends createZodDto(ScheduledSessionUpdate.extend({ expectedUpdatedAt: ExpectedUpdatedAt }).strict()) {}
export class ScheduledSessionCancelDto extends createZodDto(ScheduledSessionCancel.strict().default({})) {}
// `.default({})` so an existing caller that posts no body at all still resolves to
// `{ force: false }` rather than failing validation (#588).
export class ScheduledSessionRestoreDto extends createZodDto(ScheduledSessionRestore.strict().default({})) {}
// `.default({})` matches the cancel DTO above: every field is optional, so a bodyless
// POST is valid, and it makes the controller's `body ?? {}` fallback actually reachable.
export class ScheduledSessionDuplicateDto extends createZodDto(ScheduledSessionDuplicate.strict().default({})) {}
export class RsvpSetDto extends createZodDto(
  RsvpSetBody.strict().refine(hasAnyRsvpSetField, {
    message: RSVP_SET_REQUIRED_MESSAGE,
  }),
) {}
export class SessionShareCreateDto extends createZodDto(SessionShareCreate.strict()) {}
export class SessionShareUpdateDto extends createZodDto(SessionShareUpdate) {}
export class SessionSharePolicyUpdateDto extends createZodDto(SessionSharePolicyUpdate.strict()) {}

// ---------- organized play (issue #588) ----------
export class PlayVenueCreateDto extends createZodDto(PlayVenueCreate.strict()) {}
export class PlayVenueUpdateDto extends createZodDto(PlayVenueUpdate.strict()) {}
export class PlayRoomCreateDto extends createZodDto(PlayRoomCreate.strict()) {}
export class PlayRoomUpdateDto extends createZodDto(PlayRoomUpdate.strict()) {}
// `force` is a request-time coordinator override, not part of the stored series,
// so it is added at the DTO layer exactly like expectedUpdatedAt above.
export class SessionSeriesCreateDto extends createZodDto(
  SessionSeriesCreate.extend({ force: z.boolean().default(false) }).strict(),
) {}
// `force` here too: a series PATCH carrying roomId/assignedDmUserId fans that
// resource out to every future unoverridden occurrence, so it books rooms in
// bulk and needs the same coordinator override as its per-occurrence siblings.
export class SessionSeriesUpdateDto extends createZodDto(
  SessionSeriesUpdate.extend({ force: z.boolean().default(false) }).strict(),
) {}
export class SessionSeriesExtendDto extends createZodDto(
  SessionSeriesExtend.extend({ force: z.boolean().default(false) }).strict(),
) {}
export class SessionSeriesCancelDto extends createZodDto(SessionSeriesCancel.strict().default({})) {}
export class OccurrenceRescheduleDto extends createZodDto(OccurrenceReschedule.strict()) {}
export class OccurrenceReassignDto extends createZodDto(OccurrenceReassign.strict()) {}
export class ScheduleConflictQueryDto extends createZodDto(ScheduleConflictQuery.strict()) {}
export class ScheduleTemplateCreateDto extends createZodDto(ScheduleTemplateCreate.strict()) {}
export class ScheduleTemplateApplyDto extends createZodDto(ScheduleTemplateApply.strict()) {}
