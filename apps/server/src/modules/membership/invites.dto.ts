import { createZodDto } from 'nestjs-zod';
import { InviteCreate, InviteAccept } from '@campfire/schema';

export class InviteCreateDto extends createZodDto(InviteCreate) {}
export class InviteAcceptDto extends createZodDto(InviteAccept) {}
