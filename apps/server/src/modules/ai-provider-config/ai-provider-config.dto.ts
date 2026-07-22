import { createZodDto } from 'nestjs-zod';
import { ApiPropertyOptional } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import {
  AiProviderConfigUpdate,
  AiProviderRemovalConfirm,
  AiProviderRemovalImpact,
  AiProviderTestRequest,
  AiProviderTestResult,
} from '@campfire/schema';

// .strict() at the DTO layer — an unknown/misspelled key is a 400, not a silent
// drop (matches the AI-DM seat DTO). The write payload's `apiKey` is write-only;
// it is never echoed back (reads use AiProviderConfigView, which omits it).
export class AiProviderConfigUpdateDto extends createZodDto(AiProviderConfigUpdate.strict()) {}

/** Strict, non-persisting connection-test candidate (issue #852). */
export class AiProviderTestRequestDto extends createZodDto(AiProviderTestRequest) {
  @ApiPropertyOptional({
    type: String,
    maxLength: 4096,
    writeOnly: true,
    description:
      'Candidate API key. A non-empty value is tested without being stored. Omit or send an empty string to reuse the stored/inherited credential that a blank key would use on save.',
  })
  declare apiKey?: string;
}

/**
 * nestjs-zod enforces `.strict()` at runtime but its Swagger conversion omits
 * `additionalProperties: false`. Use this shared operation schema so OpenAPI
 * clients receive the same exact contract, including the write-only key marker.
 */
export const AI_PROVIDER_TEST_REQUEST_OPENAPI_SCHEMA: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['providerType', 'model'],
  properties: {
    providerType: { type: 'string', enum: ['openai', 'anthropic', 'mock'] },
    model: { type: 'string', minLength: 1, maxLength: 120 },
    baseUrl: {
      type: 'string',
      maxLength: 2048,
      description: 'Optional absolute http(s) provider endpoint without embedded credentials.',
    },
    apiKey: {
      type: 'string',
      maxLength: 4096,
      writeOnly: true,
      description:
        'Candidate key tested without persistence. Omit or send an empty string to reuse the stored/inherited credential permitted for this scope.',
    },
  },
};

/** Fully described, credential-free test response for OpenAPI. */
export class AiProviderTestResultDto extends createZodDto(AiProviderTestResult) {}

/** Server-authored, credential-free removal preview (issue #755). */
export class AiProviderRemovalImpactDto extends createZodDto(AiProviderRemovalImpact) {}

/** Mandatory optimistic-concurrency token returned by the latest preview. */
export class AiProviderRemovalConfirmDto extends createZodDto(AiProviderRemovalConfirm) {}
