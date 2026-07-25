import { createZodDto } from 'nestjs-zod';
import { RosterImportRequest } from '@campfire/schema';

export class RosterImportDto extends createZodDto(RosterImportRequest.strict()) {}
