import { createZodDto } from 'nestjs-zod';
import { ApiTokenCreate, AdminTokenCreate } from '@campfire/schema';

// .strict() — an unrecognized body key 400s instead of being silently stripped
// (see encounters.dto.ts / issue #131).
export class ApiTokenCreateDto extends createZodDto(ApiTokenCreate.strict()) {}
export class AdminTokenCreateDto extends createZodDto(AdminTokenCreate.strict()) {}
