import { Logger } from '@nestjs/common';

const logger = new Logger('Request');

export type RequestLogResult = 'ok' | 'error';

export interface RequestLogFields {
  requestId: string;
  transport: 'rest' | 'mcp';
  result: RequestLogResult;
  latencyMs: number;
  method?: string;
  path?: string;
  status?: number;
  actor?: string;
  campaignId?: number;
  tool?: string;
}

/** Patterns that replace the full match with a fixed redaction token. */
const FULL_MATCH_SECRET_PATTERNS: RegExp[] = [
  /\bsk-[a-zA-Z0-9_-]{10,}\b/g,
  /\bcf_pat_[a-f0-9]{48}\b/gi,
  /\bBearer\s+\S+/gi,
  /\bapi[_-]?key[=:]\s*\S+/gi,
];

/** Patterns that keep a query-param prefix and redact only the value. */
const PREFIX_SECRET_PATTERNS: RegExp[] = [
  // OIDC callback query params can carry provider error text or auth codes.
  /([?&]error_description=)[^&"]+/gi,
  /([?&]code=)[^&"]+/gi,
];

/**
 * Redact secret-like substrings from a log line (issue #684). Belt-and-suspenders
 * on top of field-level omission — catches values that slipped into paths/messages.
 */
export function redactLogSecrets(value: string): string {
  let out = value;
  for (const pattern of FULL_MATCH_SECRET_PATTERNS) {
    out = out.replace(pattern, '<redacted>');
  }
  for (const pattern of PREFIX_SECRET_PATTERNS) {
    out = out.replace(pattern, (_match, prefix: string) => `${prefix}<redacted>`);
  }
  return out;
}

/** Serialize a structured request log as a single JSON line for grep/jq pivots. */
export function formatRequestLog(fields: RequestLogFields): string {
  const payload: Record<string, string | number> = {
    type: 'request',
    requestId: fields.requestId,
    transport: fields.transport,
    result: fields.result,
    latencyMs: fields.latencyMs,
  };
  if (fields.method) payload.method = fields.method;
  if (fields.path) payload.path = fields.path;
  if (fields.status !== undefined) payload.status = fields.status;
  if (fields.actor) payload.actor = fields.actor;
  if (fields.campaignId !== undefined) payload.campaignId = fields.campaignId;
  if (fields.tool) payload.tool = fields.tool;
  return redactLogSecrets(JSON.stringify(payload));
}

export function logRequest(fields: RequestLogFields): void {
  logger.log(formatRequestLog(fields));
}
