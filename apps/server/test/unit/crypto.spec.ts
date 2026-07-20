import {
  hashPassword,
  verifyPassword,
  generateSessionToken,
  hashSessionToken,
  generateResetCode,
  hashResetCode,
  generateApiToken,
  hashApiToken,
  apiTokenPrefix,
  looksLikeApiToken,
  generateInviteCode,
  generateShareToken,
  hashShareToken,
  shareTokenPrefix,
  looksLikeShareToken,
  generateIcsFeedToken,
  looksLikeIcsFeedToken,
} from '../../src/common/crypto';

/**
 * Unit tests for the crypto helpers (issue #79): password hashing round-trips,
 * token shapes, and the storage-hash / prefix / recogniser contracts. No DB,
 * no bootstrap — just the node:crypto-backed pure helpers.
 */
describe('crypto — password hashing (scrypt)', () => {
  it('verifies a correct password', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const stored = hashPassword('s3cret');
    expect(verifyPassword('guess', stored)).toBe(false);
  });

  it('produces the documented scrypt:N:r:p:salt:hash format', () => {
    const stored = hashPassword('pw');
    const parts = stored.split(':');
    expect(parts[0]).toBe('scrypt');
    expect(parts).toHaveLength(6);
  });

  it('salts: the same password hashes differently each time', () => {
    expect(hashPassword('pw')).not.toBe(hashPassword('pw'));
  });

  it('rejects a malformed stored value instead of throwing', () => {
    expect(verifyPassword('pw', 'not-a-real-hash')).toBe(false);
    expect(verifyPassword('pw', 'scrypt:bad')).toBe(false);
    expect(verifyPassword('pw', 'scrypt:x:y:z:aa:bb')).toBe(false); // non-numeric params
  });
});

describe('crypto — session tokens', () => {
  it('mints 64 hex chars (32 bytes)', () => {
    expect(generateSessionToken()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashSessionToken is a deterministic sha256 (64 hex), not the raw token', () => {
    const token = generateSessionToken();
    const h = hashSessionToken(token);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toBe(token);
    expect(hashSessionToken(token)).toBe(h); // stable
  });
});

describe('crypto — reset codes', () => {
  it('is prefixed and shaped cf_reset_<32 hex>', () => {
    expect(generateResetCode()).toMatch(/^cf_reset_[0-9a-f]{32}$/);
  });

  it('hashes deterministically and differently from the code', () => {
    const code = generateResetCode();
    expect(hashResetCode(code)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashResetCode(code)).not.toBe(code);
  });
});

describe('crypto — API (PAT) tokens', () => {
  it('is shaped cf_pat_<48 hex>', () => {
    const t = generateApiToken();
    expect(t).toMatch(/^cf_pat_[0-9a-f]{48}$/);
    expect(looksLikeApiToken(t)).toBe(true);
  });

  it('prefix is the first 11 chars (cf_pat_ + 4 hex) — display only', () => {
    const t = generateApiToken();
    expect(apiTokenPrefix(t)).toHaveLength(11);
    expect(t.startsWith(apiTokenPrefix(t))).toBe(true);
  });

  it('rejects non-PAT strings', () => {
    expect(looksLikeApiToken('cf_share_' + 'a'.repeat(48))).toBe(false);
    expect(looksLikeApiToken('cf_pat_zzzz')).toBe(false);
    expect(looksLikeApiToken('')).toBe(false);
  });

  it('hashApiToken is deterministic and not the raw token', () => {
    const t = generateApiToken();
    expect(hashApiToken(t)).not.toBe(t);
    expect(hashApiToken(t)).toBe(hashApiToken(t));
  });
});

describe('crypto — share tokens', () => {
  it('is shaped cf_share_<48 hex> and recognised', () => {
    const t = generateShareToken();
    expect(t).toMatch(/^cf_share_[0-9a-f]{48}$/);
    expect(looksLikeShareToken(t)).toBe(true);
  });

  it('prefix is the first 13 chars (cf_share_ + 4 hex)', () => {
    const t = generateShareToken();
    expect(shareTokenPrefix(t)).toHaveLength(13);
    expect(t.startsWith(shareTokenPrefix(t))).toBe(true);
  });

  it('does not confuse a PAT for a share token', () => {
    expect(looksLikeShareToken(generateApiToken())).toBe(false);
  });

  it('hashShareToken is a sha256 of the token', () => {
    expect(hashShareToken(generateShareToken())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('crypto — invite & ICS feed tokens', () => {
  it('invite code is base64url (~22 chars, no padding)', () => {
    expect(generateInviteCode()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('ICS feed token is shaped cf_ics_<48 hex> and recognised', () => {
    const t = generateIcsFeedToken();
    expect(t).toMatch(/^cf_ics_[0-9a-f]{48}$/);
    expect(looksLikeIcsFeedToken(t)).toBe(true);
  });

  it('recognisers are mutually exclusive across token families', () => {
    expect(looksLikeIcsFeedToken(generateApiToken())).toBe(false);
    expect(looksLikeApiToken(generateIcsFeedToken())).toBe(false);
  });
});
