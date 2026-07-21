import { createZodDto } from 'nestjs-zod';
import { GenerateMapParams } from '@campfire/schema';

/** Body for the generate-map endpoints (issue #306). `.strict()` — an unknown key 400s. */
export class GenerateMapDto extends createZodDto(GenerateMapParams.strict()) {}
