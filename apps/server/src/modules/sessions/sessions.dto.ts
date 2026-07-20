import { createZodDto } from 'nestjs-zod';
import { SessionCreate, SessionUpdate, ScheduledSessionCreate, ScheduledSessionUpdate, RsvpSet } from '@campfire/schema';

export class SessionCreateDto extends createZodDto(SessionCreate) {}
export class SessionUpdateDto extends createZodDto(SessionUpdate) {}
export class ScheduledSessionCreateDto extends createZodDto(ScheduledSessionCreate) {}
export class ScheduledSessionUpdateDto extends createZodDto(ScheduledSessionUpdate) {}
export class RsvpSetDto extends createZodDto(RsvpSet) {}
