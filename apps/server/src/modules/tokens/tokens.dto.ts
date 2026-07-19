import { createZodDto } from 'nestjs-zod';
import { ApiTokenCreate, AdminTokenCreate } from '@campfire/schema';

export class ApiTokenCreateDto extends createZodDto(ApiTokenCreate) {}
export class AdminTokenCreateDto extends createZodDto(AdminTokenCreate) {}
