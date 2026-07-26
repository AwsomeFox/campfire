import type { AiExternalContentPolicy, AiGenerationProvenance } from '@campfire/schema';
import type { RecapDraftSource } from '../sessions/sessions.service';

export type ScribeConsentSummary = NonNullable<AiGenerationProvenance['consent']>;

/**
 * The ONLY note visibilities whose bodies may ever be considered for an external send
 * (issue #501). This is an explicit allow-list, not a deny-list, so an unknown/absent
 * visibility — a future enum member, a legacy row, a hand-built source in a test — is
 * treated as private and dropped rather than silently leaking. `private` and `whisper`
 * are author/recipient-only channels and are never eligible, whatever the author consented to.
 */
const EXTERNALLY_SHAREABLE_VISIBILITIES: ReadonlySet<string> = new Set(['dm_shared', 'party_shared']);

export function emptyScribeConsent(policy: AiExternalContentPolicy = 'member_consent'): ScribeConsentSummary {
  return {
    campaignPolicy: policy,
    includedAuthorUserIds: [],
    excludedAuthorUserIds: [],
    includedInboxCount: 0,
    excludedInboxByConsent: 0,
    excludedInboxPrivate: 0,
  };
}

export function filterSourceForExternalAiConsent(
  source: RecapDraftSource,
  policy: AiExternalContentPolicy,
  consentingMemberIds: ReadonlySet<string>,
): { source: RecapDraftSource; consent: ScribeConsentSummary } {
  const includedAuthorUserIds = new Set<string>();
  const excludedAuthorUserIds = new Set<string>();
  let excludedInboxByConsent = 0;
  let excludedInboxPrivate = 0;

  const resolvedInbox = source.resolvedInbox.filter((note) => {
    if (!EXTERNALLY_SHAREABLE_VISIBILITIES.has(note.visibility ?? '')) {
      excludedInboxPrivate += 1;
      if (note.authorUserId) excludedAuthorUserIds.add(note.authorUserId);
      return false;
    }

    const authorUserId = note.authorUserId ?? '';
    const include = policy === 'member_consent' && authorUserId !== '' && consentingMemberIds.has(authorUserId);
    if (include) {
      includedAuthorUserIds.add(authorUserId);
      return true;
    }

    excludedInboxByConsent += 1;
    if (authorUserId) excludedAuthorUserIds.add(authorUserId);
    return false;
  });

  return {
    source: { ...source, resolvedInbox },
    consent: {
      campaignPolicy: policy,
      includedAuthorUserIds: [...includedAuthorUserIds].sort(),
      excludedAuthorUserIds: [...excludedAuthorUserIds].sort(),
      includedInboxCount: resolvedInbox.length,
      excludedInboxByConsent,
      excludedInboxPrivate,
    },
  };
}
