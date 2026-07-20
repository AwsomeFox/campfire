import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { LocationCreate, LocationUpdate, LocationStatus, ExpectedUpdatedAt } from '@campfire/schema';

// .strict() at the DTO layer only (shared exports stay lenient for mcp-tools.ts /
// proposals.service.ts — see encounters.dto.ts): an unrecognized body key 400s
// instead of being silently stripped and written as a partial create/update.
export class LocationCreateDto extends createZodDto(LocationCreate.strict()) {}
// expectedUpdatedAt (#157) added here, not in the shared LocationUpdate — see sessions.dto.ts.
export class LocationUpdateDto extends createZodDto(LocationUpdate.extend({ expectedUpdatedAt: ExpectedUpdatedAt }).strict()) {}

export const LocationDiscoverPatch = z.object({ status: LocationStatus }).strict();
export class LocationDiscoverDto extends createZodDto(LocationDiscoverPatch) {}
