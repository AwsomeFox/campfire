import { describe, it, expect } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import {
  KEY_ENVELOPE_MIN_PASSPHRASE_LEN,
  KEY_ENVELOPE_VERSION,
  decryptKeyfile,
  encryptKeyfile,
  parseKeyEnvelopeJson,
} from '../../src/modules/backup/backup-key-envelope';

/**
 * #496: The passphrase-encrypted envelope wraps the auto-generated AI
 * credential keyfile so backups become credential-portable across hosts
 * WITHOUT embedding key material in plaintext. This suite pins the
 * envelope contract: correct round-trip, hard failure on wrong passphrase,
 * hard failure on tampered ciphertext, minimum-passphrase enforcement.
 */
describe('backup key envelope (#496)', () => {
  const goodPassphrase = 'correct-horse-battery-staple';
  const wrongPassphrase = 'correct-horse-battery-STAPLE';

  it('round-trips a 32-byte keyfile', () => {
    const key = randomBytes(32).toString('hex'); // matches what the service writes
    const keyBytes = Buffer.from(key, 'utf8');
    const envelope = encryptKeyfile(keyBytes, goodPassphrase);
    expect(envelope.v).toBe(KEY_ENVELOPE_VERSION);
    expect(envelope.kdf).toBe('scrypt');
    const decrypted = decryptKeyfile(envelope, goodPassphrase);
    expect(decrypted.equals(keyBytes)).toBe(true);
  });

  it('never embeds the plaintext key in the envelope fields', () => {
    // A subtle regression could serialize the raw key alongside the ciphertext.
    // Assert every base64 field decodes to bytes that do NOT equal the input.
    const keyBytes = Buffer.from('a'.repeat(64), 'utf8');
    const envelope = encryptKeyfile(keyBytes, goodPassphrase);
    const salt = Buffer.from(envelope.salt, 'base64');
    const iv = Buffer.from(envelope.iv, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    const ct = Buffer.from(envelope.ct, 'base64');
    for (const field of [salt, iv, tag, ct]) {
      expect(field.equals(keyBytes)).toBe(false);
      // Substring scan for the plaintext (belt-and-braces vs bitwise equality):
      expect(field.toString('utf8').includes('aaaaaaaa')).toBe(false);
    }
  });

  it('produces different ciphertext on each call (random salt + IV)', () => {
    const keyBytes = Buffer.from('a'.repeat(64), 'utf8');
    const a = encryptKeyfile(keyBytes, goodPassphrase);
    const b = encryptKeyfile(keyBytes, goodPassphrase);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('rejects the wrong passphrase with a generic error (no oracle)', () => {
    const keyBytes = Buffer.from('a'.repeat(64), 'utf8');
    const envelope = encryptKeyfile(keyBytes, goodPassphrase);
    expect(() => decryptKeyfile(envelope, wrongPassphrase)).toThrow(
      /passphrase is wrong or the archive is corrupt/,
    );
  });

  it('rejects tampered ciphertext with a generic error', () => {
    const keyBytes = Buffer.from('a'.repeat(64), 'utf8');
    const envelope = encryptKeyfile(keyBytes, goodPassphrase);
    // Flip one byte of ciphertext
    const raw = Buffer.from(envelope.ct, 'base64');
    raw[0] ^= 0xff;
    const tampered = { ...envelope, ct: raw.toString('base64') };
    expect(() => decryptKeyfile(tampered, goodPassphrase)).toThrow(
      /passphrase is wrong or the archive is corrupt/,
    );
  });

  it('rejects an empty passphrase on encrypt and decrypt', () => {
    const keyBytes = Buffer.from('a'.repeat(64), 'utf8');
    expect(() => encryptKeyfile(keyBytes, '')).toThrow(/passphrase is required/);
    const envelope = encryptKeyfile(keyBytes, goodPassphrase);
    expect(() => decryptKeyfile(envelope, '')).toThrow(/passphrase is required/);
  });

  it('enforces the minimum passphrase length', () => {
    const keyBytes = Buffer.from('a'.repeat(64), 'utf8');
    const tooShort = 'a'.repeat(KEY_ENVELOPE_MIN_PASSPHRASE_LEN - 1);
    expect(() => encryptKeyfile(keyBytes, tooShort)).toThrow(
      new RegExp(`at least ${KEY_ENVELOPE_MIN_PASSPHRASE_LEN} characters`),
    );
  });

  it('rejects an empty key input', () => {
    expect(() => encryptKeyfile(Buffer.alloc(0), goodPassphrase)).toThrow(
      /Keyfile bytes are empty/,
    );
  });

  it('rejects unsupported envelope versions', () => {
    const keyBytes = Buffer.from('a'.repeat(64), 'utf8');
    const envelope = encryptKeyfile(keyBytes, goodPassphrase);
    const future = { ...envelope, v: envelope.v + 100 };
    expect(() => decryptKeyfile(future, goodPassphrase)).toThrow(
      /Unsupported backup key envelope version/,
    );
  });

  it('rejects malformed JSON in the parser', () => {
    expect(() => parseKeyEnvelopeJson('not json')).toThrow(/not valid JSON/);
    expect(() => parseKeyEnvelopeJson('[]')).toThrow(/not a JSON object/);
    expect(() => parseKeyEnvelopeJson('{}')).toThrow(/missing required fields/);
  });

  it('parseKeyEnvelopeJson round-trips a real envelope', () => {
    const keyBytes = Buffer.from('a'.repeat(64), 'utf8');
    const envelope = encryptKeyfile(keyBytes, goodPassphrase);
    const parsed = parseKeyEnvelopeJson(JSON.stringify(envelope));
    expect(parsed.v).toBe(envelope.v);
    expect(parsed.ct).toBe(envelope.ct);
    // And it decrypts cleanly.
    expect(decryptKeyfile(parsed, goodPassphrase).equals(keyBytes)).toBe(true);
  });

  it('rejects invalid field lengths (salt/iv/tag)', () => {
    const keyBytes = Buffer.from('a'.repeat(64), 'utf8');
    const envelope = encryptKeyfile(keyBytes, goodPassphrase);
    const badSalt = { ...envelope, salt: Buffer.from('short').toString('base64') };
    expect(() => decryptKeyfile(badSalt, goodPassphrase)).toThrow(/invalid field lengths/);
  });
});
