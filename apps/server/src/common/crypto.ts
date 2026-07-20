import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

/**
 * Password hashing: node:crypto scrypt, no native deps.
 * Format: `scrypt:N:r:p:saltHex:hashHex`
 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, salt, expected.length, { N, r, p });
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** Session token: 32 random bytes hex. DB stores sha256(token), never the raw token. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Password-reset code: `cf_reset_<32 hex chars>` (16 random bytes). Handed to
 * an admin ONCE on approval (see PasswordResetService.approve); DB stores
 * sha256(code), never the raw code. Single-use + short expiry, so 128 bits of
 * entropy is ample for a code relayed out-of-band.
 */
const RESET_CODE_PREFIX = 'cf_reset_';

export function generateResetCode(): string {
  return `${RESET_CODE_PREFIX}${randomBytes(16).toString('hex')}`;
}

export function hashResetCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/**
 * API (PAT) token: `cf_pat_<48 hex chars>` (24 random bytes). DB stores
 * sha256(token); `tokenPrefix` (first 11 chars, e.g. `cf_pat_9f2a`) is kept
 * alongside for display purposes only — never enough to guess the token.
 */
const API_TOKEN_PREFIX = 'cf_pat_';
const API_TOKEN_DISPLAY_PREFIX_LEN = 11;

export function generateApiToken(): string {
  return `${API_TOKEN_PREFIX}${randomBytes(24).toString('hex')}`;
}

export function hashApiToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function apiTokenPrefix(token: string): string {
  return token.slice(0, API_TOKEN_DISPLAY_PREFIX_LEN);
}

export function looksLikeApiToken(token: string): boolean {
  return /^cf_pat_[0-9a-f]{48}$/.test(token);
}

/**
 * Campaign invite join code: 16 random bytes base64url (~22 chars, 128 bits —
 * unguessable). Stored PLAINTEXT in campaign_invites (unlike sessions/PATs,
 * which store sha256): the code is a shareable capability the DM re-displays
 * and re-copies from the UI, and it can only create a NEW membership at a
 * capped role (never dm) — it cannot impersonate an existing user. Codes are
 * always expiring, optionally use-capped, and revocable. See
 * modules/membership/invites.service.ts.
 */
export function generateInviteCode(): string {
  return randomBytes(16).toString('base64url');
}
