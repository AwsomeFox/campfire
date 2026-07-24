import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  ApiErrorCode,
  buildMcpEnvelope,
  buildRestEnvelope,
  codeForStatus,
  normalizeError,
  resolveRequestId,
} from '../../src/common/api-error.envelope';

/**
 * Issue #682 — pure unit tests for the unified error envelope.
 *
 * The envelope is the single source of truth shared by the REST
 * AllExceptionsFilter and MCP fail(). These tests assert the shape and the
 * status→code slug mapping without spinning up a Nest app; the e2e suite in
 * api-error-envelope.e2e-spec.ts covers the wire-level integration.
 */
describe('api-error.envelope — codeForStatus', () => {
  it('maps every documented status to its canonical slug', () => {
    const cases: Array<[number, ApiErrorCode]> = [
      [400, 'bad_request'],
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [409, 'conflict'],
      [413, 'payload_too_large'],
      [422, 'unprocessable_entity'],
      [429, 'too_many_requests'],
      [500, 'internal_error'],
      [502, 'internal_error'],
      [503, 'internal_error'],
      [504, 'internal_error'],
    ];
    for (const [status, expected] of cases) {
      expect(codeForStatus(status)).toBe(expected);
    }
  });

  it('collapses an unknown 4xx to "error" (bounded vocabulary)', () => {
    expect(codeForStatus(418)).toBe('error');
  });

  it('collapses an unknown 5xx to "internal_error"', () => {
    expect(codeForStatus(599)).toBe('internal_error');
  });
});

describe('api-error.envelope — normalizeError', () => {
  it('derives code/message from HttpException subclasses', () => {
    expect(normalizeError(new NotFoundException('Quest 99'))).toMatchObject({
      status: 404,
      code: 'not_found',
      message: 'Quest 99',
    });
    expect(normalizeError(new ForbiddenException('nope'))).toMatchObject({
      status: 403,
      code: 'forbidden',
      message: 'nope',
    });
    expect(normalizeError(new UnauthorizedException('expired'))).toMatchObject({
      status: 401,
      code: 'unauthorized',
    });
    expect(normalizeError(new ConflictException('version mismatch'))).toMatchObject({
      status: 409,
      code: 'conflict',
    });
  });

  it('keeps a string response as message', () => {
    const err = new HttpException('plain string detail', HttpStatus.BAD_REQUEST);
    expect(normalizeError(err).message).toBe('plain string detail');
  });

  it('maps express entity.too.large to 413 payload_too_large', () => {
    const err = Object.assign(new Error('request entity too large'), { type: 'entity.too.large' });
    expect(normalizeError(err)).toMatchObject({
      status: 413,
      code: 'payload_too_large',
    });
  });

  it('extracts structured errors[] from nestjs-zod message:string[] shape', () => {
    // This is exactly what nestjs-zod's ZodValidationPipe throws.
    const err = new BadRequestException({
      message: ['title: Required', 'reward: Invalid enum value'],
      error: 'Bad Request',
      statusCode: 400,
    });
    const norm = normalizeError(err);
    expect(norm.status).toBe(400);
    expect(norm.code).toBe('bad_request');
    expect(norm.errors).toEqual([
      { field: 'title', message: 'Required' },
      { field: 'reward', message: 'Invalid enum value' },
    ]);
    expect(norm.message).toContain('title: Required');
  });

  it('extracts structured errors[] from a raw ZodError', () => {
    const schema = z.object({ x: z.number().int() });
    const result = schema.safeParse({ x: 1.5 });
    if (!result.success) {
      const norm = normalizeError(result.error);
      expect(norm.status).toBe(400);
      expect(norm.code).toBe('validation_failed');
      expect(norm.errors?.[0]).toMatchObject({ field: 'x', message: expect.any(String) });
    } else {
      throw new Error('expected zod parse failure');
    }
  });

  it('falls back to internal_error + the original message for raw Errors', () => {
    const norm = normalizeError(new Error('boom'));
    expect(norm).toMatchObject({ status: 500, code: 'internal_error', message: 'boom' });
  });

  it('stringifies non-Error throws', () => {
    expect(normalizeError('weird')).toMatchObject({ status: 500, message: 'weird' });
    expect(normalizeError({ random: true })).toMatchObject({ status: 500, message: '{"random":true}' });
  });
});

describe('api-error.envelope — buildRestEnvelope', () => {
  it('carries RFC 9457 fields + requestId + instance on REST', () => {
    const env = buildRestEnvelope({
      err: new NotFoundException('Quest 99'),
      requestId: 'abc-123',
      instance: '/api/v1/quests/99',
    });
    expect(env).toMatchObject({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      code: 'not_found',
      message: 'Quest 99',
      instance: '/api/v1/quests/99',
      requestId: 'abc-123',
    });
  });

  it('sanitizes the message for uncaught 5xx (non-HttpException)', () => {
    const env = buildRestEnvelope({
      err: new Error('pg connection failed: postgres://user:pass@host'),
      requestId: 'r',
    });
    expect(env.status).toBe(500);
    expect(env.code).toBe('internal_error');
    expect(env.message).not.toContain('postgres');
    expect(env.message).not.toContain('pass');
    expect(env.message).toBe('Something went wrong. Please try again later.');
  });

  it('preserves intentional HttpException 5xx messages (e.g. 503)', () => {
    const env = buildRestEnvelope({
      err: new HttpException('Campaign data directory is unreadable', 503),
      requestId: 'r',
    });
    expect(env.status).toBe(503);
    expect(env.message).toContain('unreadable');
  });

  it('passes through domain extension fields from HttpException bodies', () => {
    const env = buildRestEnvelope({
      err: new ConflictException({
        code: 'COMBATANT_IDENTITY_CONFLICT',
        message: 'Already present',
        combatantId: 42,
      }),
      requestId: 'r',
    });
    expect(env.code).toBe('COMBATANT_IDENTITY_CONFLICT');
    expect(env.combatantId).toBe(42);
  });

  it('strips query strings from instance', () => {
    const env = buildRestEnvelope({
      err: new ForbiddenException('nope'),
      requestId: 'r',
      instance: '/api/v1/campaigns/1/search?q=secret',
    });
    expect(env.instance).toBe('/api/v1/campaigns/1/search');
  });

  it('preserves structured errors[] on a 400 validation failure', () => {
    const env = buildRestEnvelope({
      err: new BadRequestException({ message: ['name: Required'] }),
      requestId: 'r',
    });
    expect(env.errors).toEqual([{ field: 'name', message: 'Required' }]);
  });

  it('omits errors[] when there are no field errors', () => {
    const env = buildRestEnvelope({ err: new NotFoundException('x'), requestId: 'r' });
    expect(env.errors).toBeUndefined();
  });

  it('omits instance when none was provided', () => {
    const env = buildRestEnvelope({ err: new NotFoundException('x'), requestId: 'r' });
    expect(env.instance).toBeUndefined();
  });
});

describe('api-error.envelope — buildMcpEnvelope', () => {
  it('wraps the envelope under { error: ... } and omits HTTP-only fields', () => {
    const wrapped = buildMcpEnvelope(new NotFoundException('Quest 99'));
    expect(wrapped.error).toMatchObject({
      status: 404,
      code: 'not_found',
      message: 'Quest 99',
    });
    expect(wrapped.error.type).toBeUndefined();
    expect(wrapped.error.title).toBeUndefined();
    expect(wrapped.error.instance).toBeUndefined();
  });

  it('always sets a requestId for MCP', () => {
    const wrapped = buildMcpEnvelope(new BadRequestException('x'));
    expect(typeof wrapped.error.requestId).toBe('string');
    expect(wrapped.error.requestId!.length).toBeGreaterThan(0);
  });

  it('sanitizes 5xx messages on MCP too', () => {
    const wrapped = buildMcpEnvelope(new Error('postgres://user:pass@host died'));
    expect(wrapped.error.status).toBe(500);
    expect(wrapped.error.message).not.toContain('postgres');
    expect(wrapped.error.message).toBe('Something went wrong. Please try again later.');
  });

  it('keeps structured errors[] for validation failures', () => {
    const wrapped = buildMcpEnvelope(new BadRequestException({ message: ['hp: must be > 0'] }));
    expect(wrapped.error.errors).toEqual([{ field: 'hp', message: 'must be > 0' }]);
  });
});

describe('api-error.envelope — resolveRequestId', () => {
  it('accepts a well-formed inbound id', () => {
    expect(resolveRequestId('abc-123_456.789')).toBe('abc-123_456.789');
  });

  it('generates a fresh id when no inbound value is provided', () => {
    const id = resolveRequestId(undefined);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('rejects oversized inbound values (log-injection guard)', () => {
    const tooLong = 'a'.repeat(200);
    const id = resolveRequestId(tooLong);
    expect(id).not.toBe(tooLong);
    expect(id.length).toBeLessThanOrEqual(36);
  });

  it('rejects inbound values containing illegal characters', () => {
    const id = resolveRequestId('bad id with spaces');
    expect(id).not.toBe('bad id with spaces');
  });
});
