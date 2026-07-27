import {
  canonicalJson,
  moderationEvidenceCanonicalPayload,
  moderationEvidenceHash,
  moderationEvidenceMetadataHash,
  verifyModerationEvidence,
  type ModerationEvidencePayload,
} from '../../src/modules/moderation/moderation-evidence';

/**
 * Issue #601 — the integrity half of "integrity-protected snapshot".
 *
 * These assertions are about the ENCODING, not just the digest: the property that
 * makes the hash meaningful is that the canonical payload is injective, so no two
 * distinct evidence records can produce the same digest input. A digest over an
 * ambiguous encoding is a digest an attacker can collide by choosing their content
 * carefully, which for abuse evidence is the whole ballgame.
 */

const base: ModerationEvidencePayload = {
  campaignId: 7,
  targetType: 'comment',
  targetId: 42,
  reason: 'report',
  source: 'server_capture',
  authorUserId: '3',
  authorName: 'Abuser',
  recipientUserId: null,
  anchorEntityType: 'session',
  anchorEntityId: 9,
  revisionAt: '2026-01-01T00:00:00.000Z',
  capturedAt: '2026-01-01T00:00:01.000Z',
  context: { visibility: 'party_shared', inCharacter: false },
  content: 'the reported words',
};

describe('#601 moderation evidence hashing', () => {
  it('is stable for identical input and hex-sha256 shaped', () => {
    expect(moderationEvidenceHash(base)).toBe(moderationEvidenceHash({ ...base }));
    expect(moderationEvidenceHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('covers every field a reviewer would rely on', () => {
    // Each of these is a field an attacker with DB write access would want to change
    // quietly: what it is evidence of, who wrote it, when, in what context, and the
    // words themselves. Flipping any one must move the digest.
    const mutations: Array<Partial<ModerationEvidencePayload>> = [
      { campaignId: 8 },
      { targetType: 'whisper' },
      { targetId: 43 },
      { reason: 'pre_edit' },
      { source: 'reporter_supplied' },
      { authorUserId: '4' },
      { authorName: 'Someone Else' },
      { recipientUserId: '5' },
      { anchorEntityType: 'quest' },
      { anchorEntityId: 10 },
      { revisionAt: '2026-01-02T00:00:00.000Z' },
      { capturedAt: '2026-01-02T00:00:00.000Z' },
      { context: { visibility: 'whisper', inCharacter: false } },
      { content: 'something much more flattering' },
    ];
    const original = moderationEvidenceHash(base);
    for (const patch of mutations) {
      expect(moderationEvidenceHash({ ...base, ...patch })).not.toBe(original);
    }
  });

  it('is not fooled by content that mimics the field encoding', () => {
    // Without length prefixes, a body containing "\ncontent:..." could shift a field
    // boundary and let two different records serialize identically. Length-prefixing
    // is what forecloses that, so assert the pair actually differs.
    const a = { ...base, authorName: 'A', content: '\ncontent:18:the reported words' };
    const b = { ...base, authorName: 'A\ncontent:18:the reported words', content: '' };
    expect(moderationEvidenceHash(a)).not.toBe(moderationEvidenceHash(b));
  });

  it('records byte lengths, not character counts, for multi-byte content', () => {
    const payload = moderationEvidenceCanonicalPayload({ ...base, content: 'é' });
    // 'é' is one character but two UTF-8 bytes.
    expect(payload).toContain('content:2:é');
  });

  it('does not depend on the insertion order of context keys', () => {
    const forward = moderationEvidenceHash({ ...base, context: { a: 1, b: 2 } });
    const reversed = moderationEvidenceHash({ ...base, context: { b: 2, a: 1 } });
    expect(forward).toBe(reversed);
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    // Array order IS meaningful and must survive canonicalization.
    expect(canonicalJson([2, 1])).toBe('[2,1]');
  });

  it('reports intact / tampered / redacted distinctly', () => {
    const hash = moderationEvidenceHash(base);
    expect(verifyModerationEvidence(base, hash, null)).toBe('intact');
    expect(verifyModerationEvidence({ ...base, content: 'edited' }, hash, null)).toBe('tampered');
    // A recorded redaction explains the mismatch — conflating it with tampering would
    // train reviewers to ignore the alarm that matters.
    expect(verifyModerationEvidence({ ...base, content: '[redacted]' }, hash, '2026-02-01T00:00:00.000Z')).toBe(
      'redacted',
    );
  });

  /**
   * `redacted` must not be a way to switch integrity checking off. Redaction touches
   * only `content`, so the metadata digest still has to verify afterwards; if it does
   * not, something else was changed and the honest verdict is `tampered`.
   */
  it('still detects tampering on a REDACTED row via the metadata digest', () => {
    const hash = moderationEvidenceHash(base);
    const metaHash = moderationEvidenceMetadataHash(base);
    const redactedAt = '2026-02-01T00:00:00.000Z';
    const redacted = { ...base, content: '[redacted]' };

    // Content gone, everything else intact — the expected, benign case.
    expect(verifyModerationEvidence(redacted, hash, redactedAt, metaHash)).toBe('redacted');

    // The single field most worth forging: who wrote it. Rewriting it on a redacted
    // row must NOT read as a benign redaction.
    expect(verifyModerationEvidence({ ...redacted, authorUserId: '999' }, hash, redactedAt, metaHash)).toBe('tampered');
    expect(verifyModerationEvidence({ ...redacted, targetId: 4242 }, hash, redactedAt, metaHash)).toBe('tampered');
    expect(verifyModerationEvidence({ ...redacted, capturedAt: '2020-01-01T00:00:00.000Z' }, hash, redactedAt, metaHash)).toBe(
      'tampered',
    );
  });

  it('treats a snapshot with no stored metadata digest as unverifiable, not tampered', () => {
    // Rows written before the metadata digest existed have nothing to check against.
    // Accusing them of tampering would be a false alarm, which is the failure mode the
    // redacted/tampered split exists to avoid.
    const hash = moderationEvidenceHash(base);
    expect(verifyModerationEvidence({ ...base, content: '[redacted]' }, hash, '2026-02-01T00:00:00.000Z', '')).toBe(
      'redacted',
    );
  });

  it('keeps the content and metadata digests in separate domains', () => {
    // A metadata digest must never be substitutable for a content digest, even for a
    // record whose content happens to be empty.
    const empty = { ...base, content: '' };
    expect(moderationEvidenceMetadataHash(empty)).not.toBe(moderationEvidenceHash(empty));
  });
});
