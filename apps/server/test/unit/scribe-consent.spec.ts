import { describe, expect, it } from '@jest/globals';
import type { RecapDraftSource } from '../../src/modules/sessions/sessions.service';
import {
  applyScribeConsent,
  filterSourceForExternalAiConsent,
  retainSourceForLocalGeneration,
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
      { id: 20, name: 'Goblin ambush', status: 'ended', combatants: [] },
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
