/**
 * Passphrase-encrypted envelope for the AI credential encryption key (#496).
 *
 * Whole-server backups otherwise leave the auto-generated `DATA_DIR/ai-config.key`
 * BEHIND — restoring the archive to a fresh host recovers the encrypted provider-
 * config rows in the DB but leaves them undecryptable, because the new host
 * generates its OWN random keyfile the first time the service resolves the key.
 *
 * The AC forbids embedding the key in plaintext. This module wraps the raw
 * keyfile bytes in an AES-256-GCM envelope, keyed by an operator-supplied
 * BACKUP PASSPHRASE stretched with scrypt over a fresh per-envelope salt. The
 * operator does NOT need to know or manage the keyfile itself — the passphrase
 * is the portable secret they memorize (or store separately from the archive)
 * and use during restore. Losing the passphrase leaves the archive as safe as
 * one without a key envelope: DB + uploads restore fine, provider credentials
 * do not.
 *
 * Format (JSON-serialized alongside the ciphertext in the archive):
 *   { v: 1, kdf: 'scrypt', salt, iv, tag, ct }
 * All byte fields are base64 to survive JSON round-trips.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/** Zip entry name for the passphrase-encrypted keyfile envelope. */
export const KEY_ENVELOPE_ENTRY = 'ai-config.key.env.json';

/** Envelope format version — bump when the shape or algorithm changes. */
export const KEY_ENVELOPE_VERSION = 1;

/** Minimum passphrase length we accept. 12 chars is a reasonable floor for scrypt+GCM. */
export const KEY_ENVELOPE_MIN_PASSPHRASE_LEN = 12;

/** scrypt cost parameters. N=2^14 (16384) is Node's documented default and
 *  matches the interactive-use recommendation from the scrypt paper. Bumping
 *  higher requires setting maxmem too (roughly 128 * N * r bytes), which
 *  would trip Node's default 32 MiB cap and add ambient-config risk. */
const SCRYPT_N = 1 << 14;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
/** AES-256-GCM constants. */
const KEY_LEN = 32; // 256 bits
const IV_LEN = 12; // GCM standard
const TAG_LEN = 16; // GCM standard
const SALT_LEN = 16;

/** On-disk / in-archive representation of the envelope. */
export interface SerializedKeyEnvelope {
  v: number;
  kdf: 'scrypt';
  salt: string; // base64
  iv: string; // base64
  tag: string; // base64
  ct: string; // base64
}

/**
 * Wrap the raw keyfile bytes with a passphrase-derived AES-256-GCM key.
 *
 * @throws Error when passphrase is empty/too short — never encrypt with a
 *         trivially guessable secret.
 */
export function encryptKeyfile(keyBytes: Buffer, passphrase: string): SerializedKeyEnvelope {
  if (!passphrase || typeof passphrase !== 'string') {
    throw new Error('Backup key passphrase is required to encrypt the AI keyfile');
  }
  if (passphrase.length < KEY_ENVELOPE_MIN_PASSPHRASE_LEN) {
    throw new Error(
      `Backup key passphrase must be at least ${KEY_ENVELOPE_MIN_PASSPHRASE_LEN} characters`,
    );
  }
  if (!Buffer.isBuffer(keyBytes) || keyBytes.length === 0) {
    throw new Error('Keyfile bytes are empty — nothing to encrypt');
  }

  const salt = randomBytes(SALT_LEN);
  const derived = scryptSync(passphrase, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', derived, iv);
  const ct = Buffer.concat([cipher.update(keyBytes), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: KEY_ENVELOPE_VERSION,
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  };
}

/**
 * Unwrap an envelope. Throws a descriptive Error on any of:
 *   - malformed JSON / shape
 *   - unsupported format version or KDF
 *   - wrong passphrase (GCM auth failure)
 *   - tampered ciphertext (GCM auth failure)
 */
function decodeEnvelopeBase64(value: string, field: string): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error(`Backup key envelope field "${field}" is not valid base64`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0) {
    throw new Error(`Backup key envelope field "${field}" is not valid base64`);
  }
  return decoded;
}

export function decryptKeyfile(envelope: SerializedKeyEnvelope, passphrase: string): Buffer {
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('Backup key envelope is missing or malformed');
  }
  if (envelope.v !== KEY_ENVELOPE_VERSION) {
    throw new Error(
      `Unsupported backup key envelope version ${envelope.v} (this server supports v${KEY_ENVELOPE_VERSION})`,
    );
  }
  if (envelope.kdf !== 'scrypt') {
    throw new Error(`Unsupported backup key envelope KDF "${envelope.kdf}"`);
  }
  if (!passphrase || typeof passphrase !== 'string') {
    throw new Error('Backup key passphrase is required to decrypt the AI keyfile');
  }

  const GENERIC_DECRYPT_FAILURE =
    'Backup key envelope failed to decrypt — passphrase is wrong or the archive is corrupt';

  let salt: Buffer;
  let iv: Buffer;
  let tag: Buffer;
  let ct: Buffer;
  try {
    salt = decodeEnvelopeBase64(envelope.salt, 'salt');
    iv = decodeEnvelopeBase64(envelope.iv, 'iv');
    tag = decodeEnvelopeBase64(envelope.tag, 'tag');
    ct = decodeEnvelopeBase64(envelope.ct, 'ct');
    if (salt.length !== SALT_LEN || iv.length !== IV_LEN || tag.length !== TAG_LEN || ct.length === 0) {
      throw new Error(GENERIC_DECRYPT_FAILURE);
    }
  } catch (err) {
    if (err instanceof Error && err.message === GENERIC_DECRYPT_FAILURE) throw err;
    throw new Error(GENERIC_DECRYPT_FAILURE, { cause: err });
  }

  const derived = scryptSync(passphrase, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  const decipher = createDecipheriv('aes-256-gcm', derived, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    // AES-GCM raises on either wrong key or tampered ciphertext. Do not distinguish
    // the two to the caller — that distinction would be an oracle.
    throw new Error(GENERIC_DECRYPT_FAILURE);
  }
}

/**
 * Parse a JSON blob (as it appears in the archive) into a validated envelope.
 * Kept separate from decrypt so callers can validate structure before prompting
 * for a passphrase.
 */
export function parseKeyEnvelopeJson(json: string): SerializedKeyEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Backup key envelope is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Backup key envelope is not a JSON object');
  }
  const rec = parsed as Record<string, unknown>;
  const allowedKeys = new Set(['v', 'kdf', 'salt', 'iv', 'tag', 'ct']);
  for (const key of Object.keys(rec)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Backup key envelope contains unexpected field "${key}"`);
    }
  }
  if (
    typeof rec.v !== 'number' ||
    typeof rec.kdf !== 'string' ||
    typeof rec.salt !== 'string' ||
    typeof rec.iv !== 'string' ||
    typeof rec.tag !== 'string' ||
    typeof rec.ct !== 'string'
  ) {
    throw new Error('Backup key envelope is missing required fields');
  }
  return {
    v: rec.v,
    kdf: rec.kdf as 'scrypt',
    salt: rec.salt,
    iv: rec.iv,
    tag: rec.tag,
    ct: rec.ct,
  };
}
