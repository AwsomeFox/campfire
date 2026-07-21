import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';

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

/**
 * Recap share-link token: `cf_share_<48 hex chars>` (24 random bytes — 192 bits,
 * unguessable). DB stores sha256(token); `tokenPrefix` (first 13 chars, e.g.
 * `cf_share_9f2a`) is kept alongside for display purposes only — never enough
 * to reconstruct the link. Same storage policy as PATs above.
 */
const SHARE_TOKEN_PREFIX = 'cf_share_';
const SHARE_TOKEN_DISPLAY_PREFIX_LEN = 13;

export function generateShareToken(): string {
  return `${SHARE_TOKEN_PREFIX}${randomBytes(24).toString('hex')}`;
}

export function hashShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function shareTokenPrefix(token: string): string {
  return token.slice(0, SHARE_TOKEN_DISPLAY_PREFIX_LEN);
}

export function looksLikeShareToken(token: string): boolean {
  return /^cf_share_[0-9a-f]{48}$/.test(token);
}

/**
 * Campaign ICS feed token: `cf_ics_<48 hex chars>` (24 random bytes) — the
 * capability secret in a campaign's public calendar-feed URL. Unlike session
 * tokens and PATs it is stored PLAINTEXT (campaigns.ics_token): the feed URL
 * must be re-displayable to members (calendar apps need it copy-pasted, and
 * "shown once" would be hostile UX for a read-only schedule feed). Same
 * entropy as a PAT, so it is equally unguessable.
 */
const ICS_TOKEN_PREFIX = 'cf_ics_';

export function generateIcsFeedToken(): string {
  return `${ICS_TOKEN_PREFIX}${randomBytes(24).toString('hex')}`;
}

export function looksLikeIcsFeedToken(token: string): boolean {
  return /^cf_ics_[0-9a-f]{48}$/.test(token);
}

/**
 * MCP OAuth (issue #37) secrets. Campfire acts as a minimal OAuth 2.1
 * authorization server so `/mcp` can be added as a Claude connector without a
 * hand-copied PAT. Four opaque token kinds, all following the same storage
 * policy as PATs/sessions where they are bearer secrets — DB stores sha256, not
 * the raw value:
 *  - `cf_client_<32 hex>`  dynamic-client-registration client id (PUBLIC id,
 *                          stored plaintext — it is not a secret, only an
 *                          identifier, like an OAuth client_id always is).
 *  - `cf_csec_<48 hex>`    optional client secret for confidential clients
 *                          (token_endpoint_auth_method != "none"); sha256-stored.
 *  - `cf_oac_<48 hex>`     one-time authorization code (short-lived); sha256-stored.
 *  - `cf_mcp_<48 hex>`     bearer ACCESS token presented on /mcp; sha256-stored.
 *  - `cf_ref_<48 hex>`     refresh token (rotated on use); sha256-stored.
 * Access/refresh tokens resolve to the SAME RequestUser + TokenContext model as
 * a PAT, so every existing scope/role cap (min(scope, membership), campaign
 * binding) applies unchanged — see OAuthService.resolveAccessToken().
 */
export function generateOAuthClientId(): string {
  return `cf_client_${randomBytes(16).toString('hex')}`;
}

export function generateOAuthClientSecret(): string {
  return `cf_csec_${randomBytes(24).toString('hex')}`;
}

export function generateAuthorizationCode(): string {
  return `cf_oac_${randomBytes(24).toString('hex')}`;
}

export function generateOAuthAccessToken(): string {
  return `cf_mcp_${randomBytes(24).toString('hex')}`;
}

export function generateOAuthRefreshToken(): string {
  return `cf_ref_${randomBytes(24).toString('hex')}`;
}

/** True for the bearer ACCESS-token shape presented on /mcp (`cf_mcp_<48 hex>`). */
export function looksLikeOAuthAccessToken(token: string): boolean {
  return /^cf_mcp_[0-9a-f]{48}$/.test(token);
}

/** Generic sha256(hex) for the OAuth opaque secrets above (same primitive as hashApiToken). */
export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Reversible secret encryption (issue #310) for at-rest storage of AI provider
 * API keys. Unlike every hash above (one-way), these ROUND-TRIP: the ciphertext
 * is decrypted in-process only at call time to hand the raw key to the provider
 * factory (#309), and is never returned to a client. AES-256-GCM is authenticated —
 * a tampered ciphertext (or a wrong key) fails the auth tag on decrypt and throws
 * rather than silently returning garbage. Self-describing payload, all base64:
 *   `gcm.v1.<iv(12B)>.<authTag(16B)>.<ciphertext>`
 * `key` MUST be exactly 32 bytes (see modules/ai-provider-config key resolution).
 */
const SECRET_ENC_PREFIX = 'gcm.v1';

export function encryptSecret(plaintext: string, key: Buffer): string {
  if (key.length !== 32) throw new Error('encryptSecret: key must be 32 bytes (aes-256-gcm)');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SECRET_ENC_PREFIX}.${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}

export function decryptSecret(payload: string, key: Buffer): string {
  if (key.length !== 32) throw new Error('decryptSecret: key must be 32 bytes (aes-256-gcm)');
  const parts = payload.split('.');
  // gcm . v1 . iv . tag . ct  => 5 segments
  if (parts.length !== 5 || `${parts[0]}.${parts[1]}` !== SECRET_ENC_PREFIX) {
    throw new Error('decryptSecret: unrecognized ciphertext format');
  }
  const iv = Buffer.from(parts[2], 'base64');
  const tag = Buffer.from(parts[3], 'base64');
  const ct = Buffer.from(parts[4], 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Masked display indicator: the last 4 chars of a secret (never the whole value). */
export function secretLast4(secret: string): string {
  return secret.length <= 4 ? secret : secret.slice(-4);
}

/**
 * RFC 7636 PKCE S256 challenge derivation: BASE64URL(SHA256(ASCII(verifier))),
 * no padding. Used by the token endpoint to validate a presented code_verifier
 * against the code_challenge captured at authorization time.
 */
export function pkceS256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
