import { createZodDto } from 'nestjs-zod';
import { GenerateMapParams, ImportMapAttribution } from '@campfire/schema';

/** Body for the generate-map endpoints (issue #306). `.strict()` — an unknown key 400s. */
export class GenerateMapDto extends createZodDto(GenerateMapParams.strict()) {}

/**
 * Non-file fields for POST /campaigns/:campaignId/maps/import (issue #303). The map image
 * arrives via FileInterceptor (stripped from the body before validation), so — like the
 * attachment upload DTO — the only valid fields are the attribution ones. `.strict()` 400s
 * on any unknown key.
 */
export class ImportMapDto extends createZodDto(ImportMapAttribution.strict()) {}
