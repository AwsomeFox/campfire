import { createZodDto } from 'nestjs-zod';
import { ApiTokenCreate } from '@campfire/schema';

export class ApiTokenCreateDto extends createZodDto(ApiTokenCreate) {}
