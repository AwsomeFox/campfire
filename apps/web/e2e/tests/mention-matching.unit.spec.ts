import { expect, test } from '@playwright/test';
import type { MentionTarget } from '@campfire/schema';
import {
  buildMentionCandidates,
  findMentionMatches,
  normalizeMentionName,
} from '../../src/lib/mentionMatching';

function targets(...names: string[]): MentionTarget[] {
  return names.map((name, index) => ({ type: 'npc', id: index + 1, name }));
}

function linkedText(text: string, names: string[], forceFallback = false): string[] {
  const candidates = buildMentionCandidates(targets(...names));
  return findMentionMatches(text, candidates, { forceFallback }).map((match) => text.slice(match.start, match.end));
}

test.describe('Unicode markdown mention matching (issue #627)', () => {
  test('uses canonical decomposition and locale-independent Unicode lowercase keys', () => {
    expect(normalizeMentionName('  CAFÉ  ')).toBe(normalizeMentionName('cafe\u0301'));
    expect(normalizeMentionName('ÉCLAIR')).toBe(normalizeMentionName('e\u0301clair'));
    expect(normalizeMentionName('東京')).toBe('東京');
  });

  test('matches Arabic, Hebrew, CJK, accented/combining Latin, emoji names, and mixed scripts', () => {
    const text = 'قال زيد، ثم דוד! 東京京都 — CAFE\u0301; E\u0301CLAIR. 守り🐉 و Asha龍.';
    expect(linkedText(text, ['زيد', 'דוד', '東京', '京都', 'Café', 'Éclair', '守り🐉', 'Asha龍'])).toEqual([
      'زيد',
      'דוד',
      '東京',
      '京都',
      'CAFE\u0301',
      'E\u0301CLAIR',
      '守り🐉',
      'Asha龍',
    ]);
  });

  test('does not link partial names inside words in whitespace-delimited scripts', () => {
    expect(linkedText('supercaféine مرحبازيد שלוםדוד', ['Café', 'زيد', 'דוד'])).toEqual([]);
  });

  test('segments scripts without required spaces and supports single-character CJK names', () => {
    expect(linkedText('東京京都。王来了。', ['東京', '京都', '王'])).toEqual(['東京', '京都', '王']);
  });

  test('returns every repeated mention and is stateless across adjacent text-node calls', () => {
    expect(linkedText('زيد، زيد؛ زيد', ['زيد'])).toEqual(['زيد', 'زيد', 'زيد']);
    expect(linkedText('Vex.', ['Vex'])).toEqual(['Vex']);
    expect(linkedText('Vex!', ['Vex'])).toEqual(['Vex']);
  });

  test('handles punctuation in names and chooses the longest overlapping name', () => {
    expect(linkedText('(A+B) met Vex the Wise.', ['A+B', 'Vex', 'Vex the Wise'])).toEqual([
      'A+B',
      'Vex the Wise',
    ]);
  });

  test('drops canonical/case-equivalent same-name collisions deterministically', () => {
    const candidates = buildMentionCandidates([
      { type: 'npc', id: 1, name: 'Amélie' },
      { type: 'character', id: 2, name: 'AME\u0301LIE' },
      { type: 'npc', id: 3, name: 'Unique' },
    ]);
    expect(candidates.map((candidate) => candidate.target.name)).toEqual(['Unique']);
  });

  test('maps normalized matches back to exact original UTF-16 source ranges', () => {
    const text = 'Before CAFE\u0301 after';
    const matches = findMentionMatches(text, buildMentionCandidates(targets('Café')));
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ start: 7, end: 12 });
    expect(text.slice(matches[0].start, matches[0].end)).toBe('CAFE\u0301');
  });

  test('fallback keeps Unicode matching usable and rejects Latin/RTL partial words', () => {
    const text = 'زيد،東京京都 CAFE\u0301 Asha龍 supercaféine مرحبازيد';
    expect(linkedText(text, ['زيد', '東京', '京都', 'Café', 'Asha龍'], true)).toEqual([
      'زيد',
      '東京',
      '京都',
      'CAFE\u0301',
      'Asha龍',
    ]);
  });
});
