import { createZodDto } from 'nestjs-zod';
import { NoteCreate, NoteUpdate, InboxCreate, InboxResolve } from '@campfire/schema';

export class NoteCreateDto extends createZodDto(NoteCreate) {}
export class NoteUpdateDto extends createZodDto(NoteUpdate) {}
export class InboxCreateDto extends createZodDto(InboxCreate) {}
export class InboxResolveDto extends createZodDto(InboxResolve) {}
