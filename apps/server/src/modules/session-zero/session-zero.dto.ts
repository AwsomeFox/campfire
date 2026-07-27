import { createZodDto } from 'nestjs-zod';
import {
  ExpectedUpdatedAt,
  SessionZeroAcknowledgment,
  SessionZeroAcknowledgmentInput,
  SessionZeroBoundarySubmission,
  SessionZeroBoundarySubmissionCreate,
  SessionZeroCharterPublish,
  SessionZeroCharterVersion,
  SessionZeroConsentStatus,
  SessionZeroGuardianConsent,
  SessionZeroGuardianConsentDecision,
  SessionZeroGuardianConsentRequest,
  SessionZeroPreviewPolicyUpdate,
  SessionZeroUpdate,
} from '@campfire/schema';

// .strict() at the DTO layer (see timeline.dto.ts / quests.dto.ts): an unrecognized
// body key 400s instead of the global ZodValidationPipe silently stripping it and
// 200-ing as a partial write.
export class SessionZeroUpdateDto extends createZodDto(SessionZeroUpdate.extend({ expectedUpdatedAt: ExpectedUpdatedAt }).strict()) {}

// ---- session-zero consent lifecycle (issue #600) ----
// Every request body below is `.strict()`. On the guardian route that is a safety
// control rather than a style choice: it is what turns an integrator's `birthDate`
// field into a 400 instead of a silently discarded key whose sender believes it
// was recorded.
export class SessionZeroCharterPublishDto extends createZodDto(SessionZeroCharterPublish) {}
export class SessionZeroAcknowledgmentInputDto extends createZodDto(SessionZeroAcknowledgmentInput) {}
export class SessionZeroBoundarySubmissionCreateDto extends createZodDto(SessionZeroBoundarySubmissionCreate) {}
export class SessionZeroGuardianConsentRequestDto extends createZodDto(SessionZeroGuardianConsentRequest) {}
export class SessionZeroGuardianConsentDecisionDto extends createZodDto(SessionZeroGuardianConsentDecision) {}
export class SessionZeroPreviewPolicyUpdateDto extends createZodDto(SessionZeroPreviewPolicyUpdate) {}

// Response DTOs, so the generated OpenAPI documents the exact consent shapes.
export class SessionZeroCharterVersionDto extends createZodDto(SessionZeroCharterVersion) {}
export class SessionZeroConsentStatusDto extends createZodDto(SessionZeroConsentStatus) {}
export class SessionZeroAcknowledgmentDto extends createZodDto(SessionZeroAcknowledgment) {}
export class SessionZeroBoundarySubmissionDto extends createZodDto(SessionZeroBoundarySubmission) {}
export class SessionZeroGuardianConsentDto extends createZodDto(SessionZeroGuardianConsent) {}
