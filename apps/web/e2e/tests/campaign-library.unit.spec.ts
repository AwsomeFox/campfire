import { expect, test } from '@playwright/test';
import { libraryBulkRequest, libraryQuery, libraryTargets, operationIdAfterUndo } from '../../src/features/library/CampaignLibraryPage';

test('library query includes every populated filter and omits blanks', () => {
  expect(libraryQuery({ q: 'dragon', type: 'npc', tagId: '4', collectionId: '9', visibility: 'hidden', status: 'active', owner: 'party', ignored: '' }))
    .toBe('q=dragon&type=npc&tagId=4&collectionId=9&visibility=hidden&status=active&owner=party');
});

test('library targets and bulk requests preserve deterministic selection order', () => {
  const selected = new Set(['quest:7', 'npc:3']);
  expect(libraryTargets(selected)).toEqual([{ entityType: 'quest', entityId: 7 }, { entityType: 'npc', entityId: 3 }]);
  expect(libraryBulkRequest('add_tag', selected, { taxonomyId: 8 })).toEqual({ operation: 'add_tag', taxonomyId: 8, targets: [{ entityType: 'quest', entityId: 7 }, { entityType: 'npc', entityId: 3 }] });
});

test('undo keeps failed operation id and clears it only after success', () => {
  expect(operationIdAfterUndo(42, false)).toBe(42);
  expect(operationIdAfterUndo(42, true)).toBeNull();
});
