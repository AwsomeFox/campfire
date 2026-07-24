/**
 * Issue #682 — publish machine-readable error response schemas in the generated
 * OpenAPI document, and attach a default 4xx/5xx ErrorResponse to every
 * operation so generated clients (e.g. openapi-generator) get a typed error
 * model per route instead of falling back to `unknown` / string parsing.
 *
 * The shape published here is the exact shape the global AllExceptionsFilter
 * (see filters/all-exceptions.filter.ts) emits on the wire. Drift between this
 * and the runtime envelope is caught by test/api-error-envelope.e2e-spec.ts.
 */

/**
 * The OpenAPI schema component for a single per-field validation failure.
 * Mirrors the `FieldError` interface from api-error.envelope.ts exactly.
 */
export const FIELD_ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['field', 'message'],
  properties: {
    field: {
      type: 'string',
      description:
        'Dotted path to the offending field, or "(root)" for whole-body failures (RFC 9457 `errors[].field`-style)',
    },
    message: { type: 'string', description: 'Stable, short message describing the constraint that failed.' },
  },
} as const;

/**
 * The OpenAPI schema component for the unified error envelope. Mirrors
 * `ApiErrorEnvelope` from api-error.envelope.ts. Every field is documented so
 * an integrator reading the spec UI can implement against it without reading
 * the source.
 */
export const ERROR_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'code', 'message', 'requestId'],
  properties: {
    type: {
      type: 'string',
      format: 'uri-reference',
      description: 'RFC 9457 — a URI reference for the problem type; `about:blank` for built-in HTTP semantics.',
      example: 'about:blank',
    },
    title: {
      type: 'string',
      description: 'RFC 9457 — short, human-readable summary of the problem type (e.g. "Not Found").',
      example: 'Not Found',
    },
    status: {
      type: 'integer',
      format: 'int32',
      description: 'HTTP status code — mirrors the response status.',
      example: 404,
    },
    code: {
      type: 'string',
      description:
        'Machine-readable slug for the error category. Stable across releases; ' +
        'switch on this rather than `message` (which may evolve). ' +
        'Canonical HTTP-derived values: `bad_request`, `validation_failed`, `unauthorized`, ' +
        '`forbidden`, `not_found`, `conflict`, `payload_too_large`, `too_many_requests`, ' +
        '`unprocessable_entity`, `internal_error`, `error`. Domain-specific codes ' +
        '(e.g. `STALE_WRITE`, `COMBATANT_IDENTITY_CONFLICT`) are also valid.',
      example: 'not_found',
    },
    message: {
      type: 'string',
      description: 'Human-readable detail of what went wrong — safe to surface to integrators.',
      example: 'Quest 999 not found',
    },
    instance: {
      type: 'string',
      format: 'uri-reference',
      description: 'RFC 9457 — the request path that errored. REST only (omitted on MCP).',
      example: '/api/v1/quests/999',
    },
    requestId: {
      type: 'string',
      description:
        'Per-request correlation id — also echoed on the `X-Request-Id` response header. ' +
        'Include in support tickets for end-to-end traceability.',
      example: 'f3a2c1b0-9a73-4d6e-bc12-8a5f9d3e1a72',
    },
    errors: {
      type: 'array',
      description:
        'Per-field validation errors. Present only when the failure is a validation failure ' +
        '(code `validation_failed` or `bad_request` with structured field errors).',
      items: { $ref: '#/components/schemas/FieldError' },
    },
  },
} as const;

/**
 * The schema name under which the components are registered in components.schemas.
 */
export const ERROR_RESPONSE_SCHEMA_NAME = 'ErrorResponse';
export const FIELD_ERROR_SCHEMA_NAME = 'FieldError';

/** The HTTP status codes that get an automatic default ErrorResponse response. */
const DEFAULT_ERROR_STATUSES = [400, 401, 403, 404, 409, 413, 422, 429, 500] as const;

/**
 * Register the error schema components in the OpenAPI document and attach a
 * default 4xx/5xx ErrorResponse reference to every operation that doesn't
 * already declare one. Mutates the document in place — called by setupApiDocs()
 * in main.ts right after SwaggerModule.createDocument().
 *
 * Idempotent: safe to call more than once (subsequent calls overwrite the same
 * components / response entries with identical values, never duplicating).
 *
 * Why post-process rather than @ApiResponse on every controller: 50+ controllers
 * and 200+ operations is too many to keep decorated by hand, and the whole point
 * of #682 is that a hand-maintained allowlist is exactly what drifts. Walking the
 * generated spec once is the same approach api-docs.coverage.e2e-spec.ts already
 * uses to assert route/decorator bijection.
 */
export function registerErrorSchemas(document: {
  components?: { schemas?: Record<string, unknown> | null };
  paths?: Record<string, unknown> | null;
}): void {
  document.components ??= {};
  document.components.schemas ??= {};
  document.components.schemas[FIELD_ERROR_SCHEMA_NAME] = FIELD_ERROR_SCHEMA;
  document.components.schemas[ERROR_RESPONSE_SCHEMA_NAME] = ERROR_RESPONSE_SCHEMA;

  if (!document.paths) return;
  for (const operations of Object.values(document.paths)) {
    if (!operations || typeof operations !== 'object') continue;
    // Each path item is `{ get?, post?, ... }` plus Swagger extensions like
    // `parameters`; iterate over its OWN enumerable keys (avoiding inherited
    // Object.* props) and only mutate operation objects that carry a
    // `responses` map.
    const pathItem = operations as Record<string, unknown>;
    for (const op of Object.values(pathItem)) {
      if (!op || typeof op !== 'object') continue;
      const operation = op as { responses?: Record<string, unknown> };
      if (!operation.responses) continue;
      for (const status of DEFAULT_ERROR_STATUSES) {
        const key = String(status);
        if (operation.responses[key] === undefined) {
          operation.responses[key] = {
            description: errorDescription(status),
            content: {
              'application/json': {
                schema: { $ref: `#/components/schemas/${ERROR_RESPONSE_SCHEMA_NAME}` },
              },
              'application/problem+json': {
                schema: { $ref: `#/components/schemas/${ERROR_RESPONSE_SCHEMA_NAME}` },
              },
            },
          };
        }
      }
    }
  }
}

function errorDescription(status: number): string {
  switch (status) {
    case 400:
      return 'Bad request — invalid input (see `errors[]` for per-field detail).';
    case 401:
      return 'Unauthorized — authentication required or token invalid.';
    case 403:
      return 'Forbidden — caller lacks the role/scope for this operation.';
    case 404:
      return 'Not found — the referenced resource does not exist or is hidden from the caller.';
    case 409:
      return 'Conflict — the request conflicts with the current state (e.g. optimistic-concurrency mismatch, duplicate).';
    case 413:
      return 'Payload too large — request body or upload exceeded the size limit.';
    case 422:
      return 'Unprocessable entity — the request was syntactically valid but semantically rejected.';
    case 429:
      return 'Too many requests — rate limit exceeded; retry after the indicated window.';
    case 500:
      return 'Internal server error — see `requestId` for support correlation.';
    default:
      return 'Error response.';
  }
}
