import { expect, test } from '@playwright/test';
import {
  buildFactionRevealPreview,
  buildLocationRevealPreview,
  buildNpcRevealPreview,
  buildQuestRevealPreview,
  previewSnippet,
} from '../../src/components/entityRevealPreview';

test.describe('entityRevealPreview (issue #710)', () => {
  test('previewSnippet trims long text at a word boundary', () => {
    const long = 'word '.repeat(50).trim();
    const snippet = previewSnippet(long, 40);
    expect(snippet.length).toBeLessThanOrEqual(42);
    expect(snippet.endsWith('…')).toBe(true);
  });

  test('buildQuestRevealPreview includes title, body, reward, objectives, giver, and subquests', () => {
    const preview = buildQuestRevealPreview({
      title: 'Rescue the heir',
      body: 'Find the missing noble in the catacombs.',
      reward: '500 gp',
      objectives: [{ text: 'Search the crypt' }],
      giverName: 'Baron Holt',
      subquestTitles: ['Map the tunnels'],
    });
    expect(preview.map((p) => p.label)).toEqual([
      'Quest',
      'Description',
      'Reward',
      'Objective',
      'Quest giver',
      'Subquest',
    ]);
    expect(preview[0].value).toBe('Rescue the heir');
    expect(preview.find((p) => p.label === 'Quest giver')?.value).toBe('Baron Holt');
  });

  test('buildNpcRevealPreview includes linked faction, location, and quests', () => {
    const preview = buildNpcRevealPreview({
      name: 'Mira Vale',
      role: 'Scout',
      body: 'Knows every back alley.',
      factionName: 'Lantern Guild',
      locationName: 'Moon Gate',
      connectedQuestTitles: ['Escort the envoy'],
    });
    expect(preview.some((p) => p.label === 'Faction' && p.value === 'Lantern Guild')).toBe(true);
    expect(preview.some((p) => p.label === 'Last seen' && p.value === 'Moon Gate')).toBe(true);
    expect(preview.some((p) => p.label === 'Connected quest')).toBe(true);
  });

  test('buildFactionRevealPreview includes members', () => {
    const preview = buildFactionRevealPreview({
      name: 'Iron Compact',
      body: 'A mercenary company.',
      memberNames: ['Rook', 'Sable'],
    });
    expect(preview.filter((p) => p.label === 'Member NPC').map((p) => p.value)).toEqual(['Rook', 'Sable']);
  });

  test('buildLocationRevealPreview includes NPCs, quests, and child locations', () => {
    const preview = buildLocationRevealPreview({
      name: 'Whisperwood',
      body: 'An ancient forest.',
      hereNpcNames: ['Guide'],
      connectedQuestTitles: ['Clear the path'],
      childLocationNames: ['Grove'],
    });
    expect(preview.some((p) => p.label === 'NPC here')).toBe(true);
    expect(preview.some((p) => p.label === 'Connected quest')).toBe(true);
    expect(preview.some((p) => p.label === 'Contains')).toBe(true);
  });
});
