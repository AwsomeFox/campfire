import { createZodDto } from 'nestjs-zod';
import { AiMapGenerationRequest, AiMapRefineRequest, AttachGeneratedMapRequest } from '@campfire/schema';

/** Body for POST .../ai-maps and .../ai-maps/readiness (issue #410). `.strict()` — unknown key 400s. */
export class AiMapGenerationDto extends createZodDto(AiMapGenerationRequest.strict()) {}

/** Body for POST .../ai-maps/:jobId/refine (issue #410). */
export class AiMapRefineDto extends createZodDto(AiMapRefineRequest.strict()) {}

/** Body for POST .../ai-maps/:jobId/attach (issue #410). */
export class AttachGeneratedMapDto extends createZodDto(AttachGeneratedMapRequest.strict()) {}
