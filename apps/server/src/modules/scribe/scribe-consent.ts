import type { AiExternalContentPolicy, AiGenerationProvenance } from '@campfire/schema';
import type { RecapDraftSource } from '../sessions/sessions.service';

export type ScribeConsentSummary = NonNullable<AiGenerationProvenance['consent']>;

/**
 * Where the assembled material is about to go (issue #501).
 *
 * - `external` — the resolved endpoint sends content OFF this server. Member consent for
 *   external use is the applicable gate and is enforced.
 * - `local` — nothing leaves the deployment: the built-in no-op/injected provider seam, or
 *   an endpoint the operator has explicitly declared local. Consent for EXTERNAL use is
 *   not the applicable gate, so it is not enforced; the visibility gate still is.
 *
 * `external` is the fail-closed default everywhere this is threaded.
 */
export type ScribeEgress = 'external' | 'local';

/**
 * The ONLY note visibilities whose bodies may ever be considered for a generation
 * (issue #501). This is an explicit allow-list, not a deny-list, so an unknown/absent
 * visibility — a future enum member, a legacy row, a hand-built source in a test — is
 * treated as private and dropped rather than silently leaking. `private` and `whisper`
 * are author/recipient-only channels and are never eligible, whatever the author consented to.
 *
 * This gate applies on BOTH egress paths, and deliberately so: a whisper surfacing in a
 * party-visible published recap is an in-app confidentiality break that has nothing to do
 * with whether an external vendor was involved. Issue #501's acceptance lists "opted-out"
 * and "private" material as two separate exclusions; only the opted-out half is about
 * external use.
 */
const EXTERNALLY_SHAREABLE_VISIBILITIES: ReadonlySet<string> = new Set(['dm_shared', 'party_shared']);

export function emptyScribeConsent(policy: AiExternalContentPolicy = 'member_consent'): ScribeConsentSummary {
  return {
    campaignPolicy: policy,
    externalSend: true,
    includedAuthorUserIds: [],
    excludedAuthorUserIds: [],
    includedInboxCount: 0,
    excludedInboxByConsent: 0,
    excludedInboxPrivate: 0,
  };
}

/**
 * Dice rolls carry `rollerUserId` purely so the consent gate has a join key; it must never
 * reach a prompt or an MCP client. Both exits below strip it.
 */
function withoutRollerUserId(
  rolls: NonNullable<RecapDraftSource['diceRolls']>,
): NonNullable<RecapDraftSource['diceRolls']> {
  return rolls.map(({ rollerUserId: _rollerUserId, ...rest }) => rest);
}

/**
 * Apply the EXTERNAL-use gate: visibility allow-list, then per-member consent.
 *
 * Only ever call this on material bound for an endpoint that leaves the server.
 */
export function filterSourceForExternalAiConsent(
  source: RecapDraftSource,
  policy: AiExternalContentPolicy,
  consentingMemberIds: ReadonlySet<string>,
): { source: RecapDraftSource; consent: ScribeConsentSummary } {
  const includedAuthorUserIds = new Set<string>();
  /**
   * Authors who had at least one note excluded for ANY reason — consent OR visibility.
   *
   * Deliberately not "authors who withheld consent": a member whose only excluded note was
   * a whisper appears here even though granting consent would not surface it. Nothing
   * user-facing is driven off this set — the "N notes withheld pending author consent"
   * copy reads `excludedInboxByConsent` — but do not treat membership here as evidence
   * that someone declined.
   */
  const excludedAuthorUserIds = new Set<string>();
  let excludedInboxByConsent = 0;
  let excludedInboxPrivate = 0;

  const consents = (userId: string): boolean =>
    policy === 'member_consent' && userId !== '' && consentingMemberIds.has(userId);

  const resolvedInbox = source.resolvedInbox.filter((note) => {
    if (!EXTERNALLY_SHAREABLE_VISIBILITIES.has(note.visibility ?? '')) {
      excludedInboxPrivate += 1;
      if (note.authorUserId) excludedAuthorUserIds.add(note.authorUserId);
      return false;
    }

    const authorUserId = note.authorUserId ?? '';
    if (consents(authorUserId)) {
      includedAuthorUserIds.add(authorUserId);
      return true;
    }

    excludedInboxByConsent += 1;
    if (authorUserId) excludedAuthorUserIds.add(authorUserId);
    return false;
  });

  // Dice rolls are mechanical play events, not authored prose, so the roll itself is not
  // gated — but `rollerName` is the member's own display name, which IS member-identifying.
  // Redact it for a non-consenting roller; `buildRecapDraft` then falls back to the
  // in-fiction `actor` (a character name the DM owns as campaign canon) or "Unknown".
  const diceRolls = source.diceRolls
    ? withoutRollerUserId(
        source.diceRolls.map((roll) =>
          consents(roll.rollerUserId ?? '') ? roll : { ...roll, rollerName: '' },
        ),
      )
    : source.diceRolls;

  return {
    source: { ...source, resolvedInbox, ...(diceRolls ? { diceRolls } : {}) },
    consent: {
      campaignPolicy: policy,
      externalSend: true,
      includedAuthorUserIds: [...includedAuthorUserIds].sort(),
      excludedAuthorUserIds: [...excludedAuthorUserIds].sort(),
      includedInboxCount: resolvedInbox.length,
      excludedInboxByConsent,
      excludedInboxPrivate,
    },
  };
}

/**
 * Prepare material for a generation that never leaves this server (issue #501).
 *
 * The visibility allow-list still applies — see the note on
 * `EXTERNALLY_SHAREABLE_VISIBILITIES` — but per-member consent for EXTERNAL use is NOT
 * enforced, because there is no external use to consent to. Gating a purely local
 * generation on external-use consent is over-broad: it silently empties recaps on the
 * default self-hosted install, where the shipped provider makes no vendor call at all.
 */
export function retainSourceForLocalGeneration(
  source: RecapDraftSource,
  policy: AiExternalContentPolicy,
): { source: RecapDraftSource; consent: ScribeConsentSummary } {
  const includedAuthorUserIds = new Set<string>();
  const excludedAuthorUserIds = new Set<string>();
  let excludedInboxPrivate = 0;

  const resolvedInbox = source.resolvedInbox.filter((note) => {
    if (!EXTERNALLY_SHAREABLE_VISIBILITIES.has(note.visibility ?? '')) {
      excludedInboxPrivate += 1;
      if (note.authorUserId) excludedAuthorUserIds.add(note.authorUserId);
      return false;
    }
    if (note.authorUserId) includedAuthorUserIds.add(note.authorUserId);
    return true;
  });

  return {
    source: {
      ...source,
      resolvedInbox,
      ...(source.diceRolls ? { diceRolls: withoutRollerUserId(source.diceRolls) } : {}),
    },
    consent: {
      campaignPolicy: policy,
      externalSend: false,
      includedAuthorUserIds: [...includedAuthorUserIds].sort(),
      excludedAuthorUserIds: [...excludedAuthorUserIds].sort(),
      includedInboxCount: resolvedInbox.length,
      // Nothing was withheld for consent: the gate did not apply on this path. Reporting a
      // non-zero count here would make the DM chase consent that would change nothing.
      excludedInboxByConsent: 0,
      excludedInboxPrivate,
    },
  };
}

/** Apply the gate appropriate to where this material is actually going. */
export function applyScribeConsent(
  source: RecapDraftSource,
  policy: AiExternalContentPolicy,
  consentingMemberIds: ReadonlySet<string>,
  egress: ScribeEgress,
): { source: RecapDraftSource; consent: ScribeConsentSummary } {
  return egress === 'local'
    ? retainSourceForLocalGeneration(source, policy)
    : filterSourceForExternalAiConsent(source, policy, consentingMemberIds);
}
