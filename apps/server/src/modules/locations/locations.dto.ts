import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { LocationCreate, LocationUpdate, LocationStatus } from '@campfire/schema';

export class LocationCreateDto extends createZodDto(LocationCreate) {}
export class LocationUpdateDto extends createZodDto(LocationUpdate) {}

export const LocationDiscoverPatch = z.object({ status: LocationStatus });
export class LocationDiscoverDto extends createZodDto(LocationDiscoverPatch) {}
