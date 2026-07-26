import type { AiExternalContentPolicy, AiGenerationProvenance } from '@campfire/schema';
import type { RecapDraftSource } from '../sessions/sessions.service';

export type ScribeConsentSummary = NonNullable<AiGenerationProvenance['consent']>;

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
    if (note.visibility !== 'dm_shared') {
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
