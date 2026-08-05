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
 * Encounter events (issue #1520, follow-up to #501) — the documented boundary.
 *
 * `encounters[].events` is the round-by-round damage/heal/condition/death/turn trail
 * (issue #1068). It is NOT gated on per-member consent, and deliberately so: combatants
 * are campaign entities, not user accounts, and there is no per-event author to check
 * consent for — for the overwhelming majority of events `actor`/`target` are
 * combatant/character names, which (like a dice roll's `actor`) are campaign canon the DM
 * owns, not member-identifying. Dropping events wholesale to be "safe" would gut recap
 * quality for exactly the fights a recap is about, for no privacy gain.
 *
 * That "overwhelming majority" is doing real work, and an earlier version of this comment
 * asserted it without the qualifier (issue #1520 review). `token_batch` events are the
 * counterexample: `applyTokenBatch`/`undoTokenBatch` persist them with
 * `actor: user.name, actorId: null` — the acting member's DISPLAY NAME, not a combatant.
 * So `actor` is campaign canon exactly when the event names a combatant, and is a user
 * attribution otherwise. See {@link USER_ATTRIBUTED_EVENT_TYPES}.
 *
 * The ONE genuinely member-identifying value an event carries is `performedBy.userId` — the
 * real account id (or PAT `token:<name>`) of whoever committed the action that produced the
 * log line (see `action-resolver.service.ts#performedByFrom`). This is exactly the
 * `rollerUserId` shape: an internal join key with zero narrative value that a recap never
 * renders (`buildRecapDraft` never reads `performedBy`), so it is stripped UNCONDITIONALLY —
 * on both the external and local paths, like `rollerUserId` — rather than redacted per
 * consent like `rollerName`: there is no narrative fallback to preserve, so there is nothing
 * to gate. `role`/`kind` are retained; they are categorical ("dm"/"player",
 * "human"/"ai"/"system"), not an identity.
 */
function withoutPerformedByUserId(
  encounters: RecapDraftSource['encounters'],
): RecapDraftSource['encounters'] {
  return encounters.map((encounter) =>
    encounter.events
      ? {
          ...encounter,
          events: encounter.events.map((event) =>
            event.performedBy ? { ...event, performedBy: { ...event.performedBy, userId: null } } : event,
          ),
        }
      : encounter,
  );
}

/**
 * Encounter-event types whose `actor` is a USER's display name rather than a combatant's.
 *
 * Exactly one today (`token_batch`, written by `applyTokenBatch`/`undoTokenBatch` as
 * `actor: user.name, actorId: null`), but the set — not the single string — is the contract,
 * because the failure mode here is a future producer quietly adding a second one. A guard
 * test in `scribe-consent.spec.ts` scans every `insert(encounterEvents)` call in the server
 * for `actor: user.name` and requires each such event type to appear in this set, so adding
 * a producer without adding it here fails rather than silently leaking a display name.
 *
 * Stripping (rather than redacting per consent) matches `performedBy.userId`'s treatment and
 * for the same reason: a recap never renders a token-placement actor — `buildRecapDraft`
 * only reads `encounterLine`, which does not touch events — so there is no narrative
 * fallback to preserve and nothing to gate. The event itself, its round, type and `detail`
 * ("N token placements") all survive; only the member's name goes.
 */
export const USER_ATTRIBUTED_EVENT_TYPES: ReadonlySet<string> = new Set(['token_batch']);

/**
 * Clear `actor` on events whose actor is a user attribution rather than campaign canon.
 *
 * Applied on BOTH egress paths, like the two strips above — a member's display name reaching
 * an external model is the same disclosure whether the recap is drafted locally or not.
 */
function withoutUserAttributedActors(
  encounters: RecapDraftSource['encounters'],
): RecapDraftSource['encounters'] {
  return encounters.map((encounter) =>
    encounter.events
      ? {
          ...encounter,
          events: encounter.events.map((event) =>
            USER_ATTRIBUTED_EVENT_TYPES.has(event.type) ? { ...event, actor: null } : event,
          ),
        }
      : encounter,
  );
}

/** Both event-level strips, in one call, so the two egress paths cannot drift apart. */
function sanitizeEncounterEvents(
  encounters: RecapDraftSource['encounters'],
): RecapDraftSource['encounters'] {
  return withoutUserAttributedActors(withoutPerformedByUserId(encounters));
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
  /**
   * Notes the external-use gate withheld — counting BOTH reasons it can fire.
   *
   * Under `disabled` the gate rejects every shareable note whatever its author consented
   * to, so all of these are policy-excluded and none are consent-excluded; under
   * `member_consent` the reverse. The two never mix, so `campaignPolicy` alone determines
   * the cause and this stays one truthful total rather than two counters where one is
   * always zero. Anything rendering this MUST branch on `campaignPolicy` for the remedy —
   * telling players to opt in cannot help on a disabled-policy campaign.
   */
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
    source: {
      ...source,
      resolvedInbox,
      encounters: sanitizeEncounterEvents(source.encounters),
      ...(diceRolls ? { diceRolls } : {}),
    },
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
      encounters: sanitizeEncounterEvents(source.encounters),
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

/**
 * Append an explicit "N notes withheld" clause to a run's `detail` (issue #501).
 *
 * A run whose material was emptied by the external-use gate must never read as a bare
 * "nothing to recap" — that is the failure operators experience as "the scribe broke after
 * upgrading", when in fact it is working exactly as configured and needs a human action.
 * The count is also archived on `sourceStats` for the UI; this is the human-readable half
 * that shows up in job history and error surfaces.
 *
 * Lives here rather than on the service so the copy is unit-testable as a pure function —
 * this is exactly the kind of wording that gets silently reverted later.
 */
export function withheldConsentDetail(base: string, consent: ScribeConsentSummary): string {
  const withheld = consent.excludedInboxByConsent;
  if (withheld <= 0) return base;
  const notes = `${withheld} note${withheld === 1 ? '' : 's'}`;
  // Name the remedy that can ACTUALLY work. Under a `disabled` policy the gate rejects
  // every shareable note whatever its author consented to, so "pending author consent"
  // would send the DM — and any player acting on it — to a control that cannot change the
  // outcome. Only the DM changing the POLICY can.
  return consent.campaignPolicy === 'disabled'
    ? `${base}; ${notes} withheld because this campaign's AI content policy disallows external use of member-authored notes`
    : `${base}; ${notes} withheld pending author consent for external AI use`;
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
