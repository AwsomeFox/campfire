import { createZodDto } from 'nestjs-zod';
import {
  AiPortraitGenerationRequest,
  AiPortraitRefineRequest,
  AttachGeneratedPortraitRequest,
} from '@campfire/schema';

/** Body for POST .../ai-portraits and .../ai-portraits/readiness (issue #1321). `.strict()` — unknown key 400s. */
export class AiPortraitGenerationDto extends createZodDto(AiPortraitGenerationRequest.strict()) {}

/** Body for POST .../ai-portraits/:jobId/refine (issue #1321). */
export class AiPortraitRefineDto extends createZodDto(AiPortraitRefineRequest.strict()) {}

/** Body for POST .../ai-portraits/:jobId/attach (issue #1321). */
export class AttachGeneratedPortraitDto extends createZodDto(AttachGeneratedPortraitRequest.strict()) {}
