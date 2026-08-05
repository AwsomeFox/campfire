import { describe, expect, it } from '@jest/globals';
import type { RecapDraftSource } from '../../src/modules/sessions/sessions.service';
import {
  applyScribeConsent,
  filterSourceForExternalAiConsent,
  retainSourceForLocalGeneration,
  withheldConsentDetail,
} from '../../src/modules/scribe/scribe-consent';

function source(): RecapDraftSource {
  return {
    resolvedInbox: [
      {
        id: 1,
        authorUserId: '10',
        visibility: 'dm_shared',
        body: 'Consented player note',
        resolvedNote: '',
        entityName: null,
      },
      {
        id: 2,
        authorUserId: '11',
        visibility: 'dm_shared',
        body: 'Opted-out player note',
        resolvedNote: '',
        entityName: null,
      },
      {
        id: 3,
        authorUserId: '12',
        visibility: 'private',
        body: 'Private note',
        resolvedNote: '',
        entityName: null,
      },
    ],
    encounters: [
      {
        id: 20,
        name: 'Goblin ambush',
        status: 'ended',
        combatants: [],
        events: [
          {
            id: 40,
            encounterId: 20,
            round: 1,
            type: 'damage',
            actor: 'Rook',
            target: 'Goblin 1',
            actorId: 1,
            targetId: 2,
            detail: 'took 8 damage',
            chainId: null,
            parentEventId: null,
            phase: 'consequence',
            performedBy: { userId: '10', role: 'player', kind: 'human' },
            metadata: {},
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    ],
    diceRolls: [
      {
        id: 30,
        label: 'Perception',
        actor: 'Rook',
        rollerName: 'Alice',
        rollerUserId: '10',
        total: 17,
        dc: 15,
        success: true,
        source: 'manual',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
}

describe('scribe external-AI consent filtering (#501)', () => {
  it('keeps only consenting member-authored inbox notes and retains non-note source', () => {
    const result = filterSourceForExternalAiConsent(source(), 'member_consent', new Set(['10']));

    expect(result.source.resolvedInbox.map((note) => note.id)).toEqual([1]);
    expect(result.source.encounters.map((encounter) => encounter.id)).toEqual([20]);
    expect(result.source.diceRolls?.map((roll) => roll.id)).toEqual([30]);
    expect(result.consent).toEqual({
      campaignPolicy: 'member_consent',
      externalSend: true,
      includedAuthorUserIds: ['10'],
      excludedAuthorUserIds: ['11', '12'],
      includedInboxCount: 1,
      excludedInboxByConsent: 1,
      excludedInboxPrivate: 1,
    });
  });

  it('strips the roller join key so it can never reach a prompt or an MCP client', () => {
    const result = filterSourceForExternalAiConsent(source(), 'member_consent', new Set(['10']));

    expect(result.source.diceRolls?.[0]).not.toHaveProperty('rollerUserId');
    expect(JSON.stringify(result.source)).not.toContain('rollerUserId');
  });

  it('redacts the display name of a roller who has not consented, keeping the in-fiction actor', () => {
    const rolls = source();
    rolls.diceRolls!.push({
      id: 31,
      label: 'Stealth',
      actor: 'Wren',
      rollerName: 'Bob',
      rollerUserId: '11', // not in the consenting set
      total: 8,
      dc: 15,
      success: false,
      source: 'manual',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const result = filterSourceForExternalAiConsent(rolls, 'member_consent', new Set(['10']));

    // The roll itself is a mechanical play event and is retained either way…
    expect(result.source.diceRolls?.map((roll) => roll.id)).toEqual([30, 31]);
    // …but the non-consenting roller's own display name is not sent.
    expect(result.source.diceRolls?.find((roll) => roll.id === 30)?.rollerName).toBe('Alice');
    expect(result.source.diceRolls?.find((roll) => roll.id === 31)?.rollerName).toBe('');
    // The character name is campaign canon the DM owns, not member-identifying, so it stays.
    expect(result.source.diceRolls?.find((roll) => roll.id === 31)?.actor).toBe('Wren');
  });

  it('includes a consenting author\'s party_shared note — shared-with-the-table is not private', () => {
    const withParty = source();
    withParty.resolvedInbox.push({
      id: 4,
      authorUserId: '10',
      visibility: 'party_shared',
      body: 'Party-shared note',
      resolvedNote: '',
      entityName: null,
    });

    const result = filterSourceForExternalAiConsent(withParty, 'member_consent', new Set(['10']));

    expect(result.source.resolvedInbox.map((note) => note.id)).toEqual([1, 4]);
    expect(result.consent.excludedInboxPrivate).toBe(1); // only the `private` note
  });

  it('never sends whisper notes, even when their author opted in', () => {
    const withWhisper = source();
    withWhisper.resolvedInbox.push({
      id: 5,
      authorUserId: '10',
      visibility: 'whisper',
      body: 'Secret channel note',
      resolvedNote: '',
      entityName: null,
    });

    const result = filterSourceForExternalAiConsent(withWhisper, 'member_consent', new Set(['10']));

    expect(result.source.resolvedInbox.map((note) => note.id)).toEqual([1]);
    expect(result.consent.excludedInboxPrivate).toBe(2); // the `private` note + the whisper
  });

  it('fails closed on an unknown or absent visibility rather than sending it', () => {
    const odd = source();
    // A future enum member / legacy row / hand-built source: not on the allow-list.
    odd.resolvedInbox.push({
      id: 6,
      authorUserId: '10',
      visibility: 'some_future_visibility' as never,
      body: 'Unknown visibility',
      resolvedNote: '',
      entityName: null,
    });
    odd.resolvedInbox.push({ id: 7, authorUserId: '10', body: 'No visibility field', resolvedNote: '', entityName: null });

    const result = filterSourceForExternalAiConsent(odd, 'member_consent', new Set(['10']));

    expect(result.source.resolvedInbox.map((note) => note.id)).toEqual([1]);
    expect(result.consent.excludedInboxPrivate).toBe(3);
  });

  it('excludes a note with no resolvable author even when the campaign policy allows sending', () => {
    const anon = source();
    anon.resolvedInbox = [
      { id: 8, authorUserId: '', visibility: 'dm_shared', body: 'Authorless', resolvedNote: '', entityName: null },
    ];

    const result = filterSourceForExternalAiConsent(anon, 'member_consent', new Set(['10']));

    expect(result.source.resolvedInbox).toEqual([]);
    expect(result.consent.excludedInboxByConsent).toBe(1);
  });

  it('excludes every inbox note when the campaign policy disables external source use', () => {
    const result = filterSourceForExternalAiConsent(source(), 'disabled', new Set(['10', '11']));

    expect(result.source.resolvedInbox).toEqual([]);
    expect(result.consent.includedAuthorUserIds).toEqual([]);
    expect(result.consent.excludedAuthorUserIds).toEqual(['10', '11', '12']);
    expect(result.consent.excludedInboxByConsent).toBe(2);
    expect(result.consent.excludedInboxPrivate).toBe(1);
  });
});

/**
 * Issue #1520 (follow-up to #501) — the documented boundary for encounter events.
 *
 * Encounter events are NOT gated on per-member consent: combatants are campaign entities,
 * not user accounts, and `actor`/`target` (combatant/character names) are campaign canon
 * the DM owns, same as a dice roll's `actor`. But `performedBy.userId` — the acting
 * member's real account id — IS member-identifying, and unlike `rollerName` it carries no
 * narrative value a recap ever renders, so it is stripped unconditionally rather than
 * gated on consent.
 */
describe('scribe encounter-event boundary (#1520)', () => {
  it('strips performedBy.userId from an event before it can reach an external client, even when the acting member has not consented', () => {
    // Prove this can actually fail: assert against the FILTERED payload the external path
    // produces, not against a helper in isolation.
    const result = filterSourceForExternalAiConsent(source(), 'member_consent', new Set());

    const event = result.source.encounters[0]?.events?.[0];
    expect(event).toBeDefined();
    expect(event?.performedBy?.userId).toBeNull();
    expect(JSON.stringify(result.source)).not.toContain('"userId":"10"');
  });

  it('keeps the mechanical trail — round, type, actor/target names, and detail — ungated', () => {
    const result = filterSourceForExternalAiConsent(source(), 'member_consent', new Set());

    const event = result.source.encounters[0]?.events?.[0];
    expect(event).toMatchObject({
      round: 1,
      type: 'damage',
      actor: 'Rook',
      target: 'Goblin 1',
      detail: 'took 8 damage',
    });
  });

  it('keeps performedBy.role/kind — categorical context, not an identity', () => {
    const result = filterSourceForExternalAiConsent(source(), 'member_consent', new Set());

    const event = result.source.encounters[0]?.events?.[0];
    expect(event?.performedBy?.role).toBe('player');
    expect(event?.performedBy?.kind).toBe('human');
  });

  it('strips performedBy.userId on the LOCAL path too — it never had a reason to leave assembly', () => {
    const result = retainSourceForLocalGeneration(source(), 'member_consent');

    expect(result.source.encounters[0]?.events?.[0]?.performedBy?.userId).toBeNull();
  });

  it('is unaffected by whether the acting member consented — the strip is unconditional, not a consent gate', () => {
    const consenting = filterSourceForExternalAiConsent(source(), 'member_consent', new Set(['10']));
    const notConsenting = filterSourceForExternalAiConsent(source(), 'member_consent', new Set());

    expect(consenting.source.encounters[0]?.events?.[0]?.performedBy?.userId).toBeNull();
    expect(notConsenting.source.encounters[0]?.events?.[0]?.performedBy?.userId).toBeNull();
  });

  it('leaves an event with no performedBy (legacy row) untouched', () => {
    const withLegacyEvent = source();
    withLegacyEvent.encounters[0]!.events!.push({
      id: 41,
      encounterId: 20,
      round: 1,
      type: 'turn',
      actor: null,
      target: null,
      actorId: null,
      targetId: null,
      detail: 'Round 1 begins',
      chainId: null,
      parentEventId: null,
      phase: null,
      performedBy: null,
      metadata: {},
      createdAt: '2026-01-01T00:00:01.000Z',
    });

    const result = filterSourceForExternalAiConsent(withLegacyEvent, 'member_consent', new Set());

    expect(result.source.encounters[0]?.events?.[1]?.performedBy).toBeNull();
  });
});

/**
 * Issue #501 is scoped to EXTERNAL use. When the resolved endpoint sends nothing off the
 * server — the shipped no-op provider, the injected test seam, or an endpoint the operator
 * explicitly declared local — external-use consent is not the applicable gate, and applying
 * it anyway silently empties recaps on the default self-hosted install.
 */
describe('scribe local-generation retention (#501)', () => {
  it('retains member-authored notes without consent when nothing leaves the server', () => {
    const result = retainSourceForLocalGeneration(source(), 'member_consent');

    // Both dm_shared notes survive — including author 11, who never opted in.
    expect(result.source.resolvedInbox.map((note) => note.id)).toEqual([1, 2]);
    expect(result.consent.excludedInboxByConsent).toBe(0);
    expect(result.consent.includedInboxCount).toBe(2);
    expect(result.consent.includedAuthorUserIds).toEqual(['10', '11']);
  });

  it('still drops private and whisper notes — that gate is not about external use', () => {
    const withWhisper = source();
    withWhisper.resolvedInbox.push({
      id: 5,
      authorUserId: '10',
      visibility: 'whisper',
      body: 'Secret channel note',
      resolvedNote: '',
      entityName: null,
    });

    const result = retainSourceForLocalGeneration(withWhisper, 'member_consent');

    expect(result.source.resolvedInbox.map((note) => note.id)).toEqual([1, 2]);
    // A whisper leaking into a party-visible published recap is an in-app confidentiality
    // break regardless of whether a vendor was ever involved.
    expect(result.consent.excludedInboxPrivate).toBe(2);
  });

  it('records externalSend=false so provenance is unambiguous about which gate ran', () => {
    const local = retainSourceForLocalGeneration(source(), 'member_consent');
    const external = filterSourceForExternalAiConsent(source(), 'member_consent', new Set(['10']));

    // Both can report excludedInboxByConsent: 0; only externalSend distinguishes
    // "everyone consented" from "the consent gate did not apply".
    expect(local.consent.externalSend).toBe(false);
    expect(external.consent.externalSend).toBe(true);
  });

  it('keeps every note under a `disabled` policy too — the policy governs external use', () => {
    const result = retainSourceForLocalGeneration(source(), 'disabled');

    expect(result.source.resolvedInbox.map((note) => note.id)).toEqual([1, 2]);
    expect(result.consent.campaignPolicy).toBe('disabled');
    expect(result.consent.externalSend).toBe(false);
  });

  it('never leaks the roller join key on the local path either', () => {
    const result = retainSourceForLocalGeneration(source(), 'member_consent');

    expect(result.source.diceRolls?.[0]).not.toHaveProperty('rollerUserId');
    // No consent gate applies locally, so the roller's own name is not redacted.
    expect(result.source.diceRolls?.[0]?.rollerName).toBe('Alice');
  });
});

describe('applyScribeConsent dispatch (#501)', () => {
  it('routes by egress, defaulting callers to the strict external gate', () => {
    const consenting = new Set(['10']);

    expect(applyScribeConsent(source(), 'member_consent', consenting, 'local').source.resolvedInbox).toHaveLength(2);
    expect(applyScribeConsent(source(), 'member_consent', consenting, 'external').source.resolvedInbox).toHaveLength(1);
  });
});

/**
 * Issue #501 review — the withheld message must name a remedy that can actually work.
 *
 * `excludedInboxByConsent` counts BOTH reasons the external-use gate fires, because
 * `consents()` returns false for a disabled policy exactly as it does for a non-consenting
 * member. Rendering "pending author consent" for a disabled-policy campaign sends the DM,
 * and any player who acts on it, to a control that changes nothing.
 */
describe('withheld-material message (#501)', () => {
  const summary = (over: Partial<Parameters<typeof withheldConsentDetail>[1]>) => ({
    campaignPolicy: 'member_consent' as const,
    externalSend: true,
    includedAuthorUserIds: [],
    excludedAuthorUserIds: [],
    includedInboxCount: 0,
    excludedInboxByConsent: 0,
    excludedInboxPrivate: 0,
    ...over,
  });

  it('leaves the base detail untouched when nothing was withheld', () => {
    expect(withheldConsentDetail('no inbox/encounter material', summary({}))).toBe('no inbox/encounter material');
  });

  it('points at member consent under a member_consent policy', () => {
    const detail = withheldConsentDetail('no inbox/encounter material', summary({ excludedInboxByConsent: 2 }));

    expect(detail).toContain('2 notes withheld pending author consent');
    expect(detail).not.toContain('policy');
  });

  it('points at the campaign POLICY — not author consent — when the policy is disabled', () => {
    const detail = withheldConsentDetail(
      'no inbox/encounter material',
      summary({ campaignPolicy: 'disabled', excludedInboxByConsent: 3 }),
    );

    // The count stays truthful about the volume withheld, whatever the cause…
    expect(detail).toContain('3 notes');
    expect(detail).toContain('AI content policy');
    // …but must NOT advise an opt-in that cannot change the outcome.
    expect(detail).not.toContain('pending author consent');
    expect(detail).not.toMatch(/opt in/i);
  });

  it('says "1 note" rather than "1 notes" on both branches', () => {
    expect(withheldConsentDetail('x', summary({ excludedInboxByConsent: 1 }))).toContain('1 note withheld');
    expect(
      withheldConsentDetail('x', summary({ campaignPolicy: 'disabled', excludedInboxByConsent: 1 })),
    ).toContain('1 note withheld');
  });

  it('reports the disabled-policy cause for material the gate actually rejected', () => {
    // End-to-end through the real filter rather than a hand-built summary: a disabled
    // policy excludes both dm_shared notes even though author 10 IS in the consenting set.
    const filtered = filterSourceForExternalAiConsent(source(), 'disabled', new Set(['10']));

    expect(filtered.consent.excludedInboxByConsent).toBe(2);
    expect(withheldConsentDetail('no inbox/encounter material', filtered.consent)).toContain('AI content policy');
  });
});
