import { createHash } from 'node:crypto';
import type { ModerationEvidenceIntegrity } from '@campfire/schema';

/**
 * Integrity protection for moderation evidence snapshots (issue #601, bullet 2).
 *
 * WHAT "INTEGRITY-PROTECTED" MEANS HERE, PRECISELY
 * -----------------------------------------------
 * A snapshot is tamper-EVIDENT, not tamper-PROOF. `contentHash` is a plain
 * sha256 (node:crypto — no new dependency) over a canonical serialization of
 * the evidence fields. Recomputing it on every read turns any out-of-band write
 * to the row — an operator editing the DB, a bug in a future migration, a
 * partially-applied redaction — into a visible `tampered` verdict instead of a
 * silent rewrite of history.
 *
 * It is deliberately NOT an HMAC. A keyed MAC only helps if the key lives
 * somewhere the DB writer cannot reach; Campfire is a self-hosted single-process
 * binary next to its own SQLite file, so anyone who can rewrite the evidence row
 * can equally read the key out of the same box and recompute the MAC. Claiming
 * cryptographic non-repudiation we cannot deliver would be worse than being
 * clear about what we do deliver: a durable, checkable digest that makes silent
 * edits impossible and loud edits obvious.
 *
 * WHAT IS HASHED, AND WHY EACH FIELD IS IN IT
 * -------------------------------------------
 * Everything a reviewer would rely on when judging an incident months later:
 *
 *   campaignId, targetType, targetId  — WHICH artefact this is evidence of. Without
 *       them a snapshot could be silently re-pointed at a different, innocuous target.
 *   reason, source                    — WHY it was captured and whether the bytes came
 *       from the server or from the reporter. Re-labelling reporter-supplied prose as a
 *       server capture would launder unverified text into "the server saw this".
 *   authorUserId, authorName          — WHO wrote it: the accused. The single field most
 *       worth forging, so it is inside the digest, not merely alongside it.
 *   recipientUserId                   — for a whisper/notification, WHO received it.
 *   anchorEntityType, anchorEntityId  — WHERE it was said.
 *   revisionAt                        — WHICH version of the content this is (the source
 *       row's own updated_at at capture). Pins the snapshot to one revision so two
 *       snapshots of the same target are orderable and neither can be passed off as the
 *       other.
 *   capturedAt                        — WHEN we took it. Establishes that the snapshot
 *       predates the mutation it was taken to survive.
 *   context                           — the situating metadata (visibility, inCharacter,
 *       parentId, …). A whisper relabelled as a party-wide post reads very differently.
 *   content                           — the prose itself, hashed LAST so a truncation
 *       attack against the encoding cannot shift a field boundary into the body.
 *
 * NOT hashed: the row's `id` (assigned by SQLite after the payload is built) and
 * the redaction fields (they are, by definition, written after the hash and are
 * the recorded explanation for a later mismatch).
 *
 * CANONICAL ENCODING
 * ------------------
 * Every field is emitted as `name:<byteLength>:<utf8 value>\n`. Length-prefixing
 * is what makes the encoding injective: no value — however many colons, newlines
 * or field-looking substrings it contains — can forge a field boundary, so two
 * different evidence records can never produce the same digest input. A version
 * banner leads the payload so a future encoding change is a different digest
 * domain rather than a silent collision with v1 records.
 */
const CANONICAL_VERSION_BANNER = 'campfire.moderation.evidence.v1';

/**
 * Banner for the METADATA-only digest: everything above except `content`.
 *
 * Why a second digest exists. Redaction overwrites `content`, so the content digest
 * can no longer match by construction — which means `redacted_at` would otherwise be
 * a switch that disables integrity checking entirely. Anyone able to write the row
 * could stamp `redacted_at` and then rewrite `authorUserId`, `targetId` or `capturedAt`
 * freely, and every reader would see the benign verdict `redacted` instead of
 * `tampered`. The redaction path is reachable in-app by any non-conflicted DM, so this
 * is not a theoretical operator-only concern.
 *
 * The metadata digest closes that: it covers exactly the fields redaction does NOT
 * touch, so it must still verify AFTER a redaction. `redacted` therefore comes to mean
 * "the content was removed by a recorded redaction and nothing else changed", which is
 * what the doc above always claimed and what makes keeping the original content hash
 * worth doing. A distinct banner keeps the two digests in separate domains so one can
 * never be substituted for the other.
 */
const METADATA_VERSION_BANNER = 'campfire.moderation.evidence.meta.v1';

/** Placeholder written over `content` once a snapshot is redacted (expiry or explicit request). */
export const MODERATION_REDACTED_CONTENT = '[redacted]';

/** The fields that go into the digest, in the fixed order documented above. */
export interface ModerationEvidencePayload {
  campaignId: number;
  targetType: string;
  targetId: number | null;
  reason: string;
  source: string;
  authorUserId: string;
  authorName: string;
  recipientUserId: string | null;
  anchorEntityType: string | null;
  anchorEntityId: number | null;
  revisionAt: string;
  capturedAt: string;
  context: Record<string, unknown>;
  content: string;
}

/**
 * Deterministic JSON for the `context` blob: object keys sorted at every depth so
 * two structurally identical contexts serialize to identical bytes regardless of
 * insertion order. (`JSON.stringify` preserves insertion order, which would make
 * the digest depend on the order a caller happened to build the object in.)
 * Arrays keep their order — order is meaningful there.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

function field(name: string, value: string): string {
  return `${name}:${Buffer.byteLength(value, 'utf8')}:${value}\n`;
}

/** Every field except `content`, in the fixed order documented above. */
function metadataFields(payload: ModerationEvidencePayload): string {
  return (
    field('campaignId', String(payload.campaignId)) +
    field('targetType', payload.targetType) +
    field('targetId', payload.targetId == null ? '' : String(payload.targetId)) +
    field('reason', payload.reason) +
    field('source', payload.source) +
    field('authorUserId', payload.authorUserId) +
    field('authorName', payload.authorName) +
    field('recipientUserId', payload.recipientUserId ?? '') +
    field('anchorEntityType', payload.anchorEntityType ?? '') +
    field('anchorEntityId', payload.anchorEntityId == null ? '' : String(payload.anchorEntityId)) +
    field('revisionAt', payload.revisionAt) +
    field('capturedAt', payload.capturedAt) +
    field('context', canonicalJson(payload.context))
  );
}

/** The exact bytes fed to sha256. Exported so a test can assert the layout, not just the digest. */
export function moderationEvidenceCanonicalPayload(payload: ModerationEvidencePayload): string {
  return `${CANONICAL_VERSION_BANNER}\n` + metadataFields(payload) + field('content', payload.content);
}

/** The metadata-only bytes — see METADATA_VERSION_BANNER for why this digest exists. */
export function moderationEvidenceMetadataPayload(payload: ModerationEvidencePayload): string {
  return `${METADATA_VERSION_BANNER}\n` + metadataFields(payload);
}

/** sha256, hex. See the module doc for what is covered and why it is not keyed. */
export function moderationEvidenceHash(payload: ModerationEvidencePayload): string {
  return createHash('sha256').update(moderationEvidenceCanonicalPayload(payload), 'utf8').digest('hex');
}

/** sha256, hex, over everything but the content. Survives redaction; see the banner doc. */
export function moderationEvidenceMetadataHash(payload: ModerationEvidencePayload): string {
  return createHash('sha256').update(moderationEvidenceMetadataPayload(payload), 'utf8').digest('hex');
}

/**
 * Verify a stored snapshot.
 *
 * A redacted row is reported as `redacted`, NOT `tampered`: the content mismatch is
 * the expected consequence of a recorded, audited redaction, and conflating the two
 * would train reviewers to ignore the alarm that matters.
 *
 * But `redacted` is NOT a free pass. Redaction touches only `content`, so the
 * metadata digest must still verify; if it does not, something other than the
 * redaction changed and the verdict is `tampered` after all. Without that check
 * `redacted_at` would be a one-flag way to switch integrity checking off and then
 * rewrite the accused's identity undetected. The original content hash is still never
 * rewritten on redaction — it is what lets a reviewer match the row against a
 * pre-redaction export.
 *
 * `storedMetadataHash` is empty only for a snapshot written before the metadata
 * digest existed; there is nothing to check against, so such a row keeps the old
 * behaviour rather than being falsely accused of tampering.
 */
export function verifyModerationEvidence(
  payload: ModerationEvidencePayload,
  storedHash: string,
  redactedAt: string | null,
  storedMetadataHash = '',
): ModerationEvidenceIntegrity {
  if (redactedAt != null) {
    if (!storedMetadataHash) return 'redacted';
    return moderationEvidenceMetadataHash(payload) === storedMetadataHash ? 'redacted' : 'tampered';
  }
  return moderationEvidenceHash(payload) === storedHash ? 'intact' : 'tampered';
}
