import { describe, expect, it } from '@jest/globals';
import type { RecapDraftSource } from '../../src/modules/sessions/sessions.service';
import { filterSourceForExternalAiConsent } from '../../src/modules/scribe/scribe-consent';

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
      includedAuthorUserIds: ['10'],
      excludedAuthorUserIds: ['11', '12'],
      includedInboxCount: 1,
      excludedInboxByConsent: 1,
      excludedInboxPrivate: 1,
    });
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
