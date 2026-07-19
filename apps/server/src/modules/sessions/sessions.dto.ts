import { createZodDto } from 'nestjs-zod';
import { SessionCreate, SessionUpdate } from '@campfire/schema';

export class SessionCreateDto extends createZodDto(SessionCreate) {}
export class SessionUpdateDto extends createZodDto(SessionUpdate) {}
