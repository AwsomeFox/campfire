/**
 * List-card previews must be bounded BEFORE they reach the DOM.
 *
 * The quest and NPC cards clamp their preview to two lines in CSS, but a clamp only limits
 * painting: the whole string still lands in the DOM, and in a `title` attribute it becomes
 * a tooltip the size of the field. `Quest.body` and `Npc.body` allow 50,000 characters and
 * both list endpoints are unpaginated, so the raw body would let one campaign push
 * megabytes of markdown through a single render.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CARD_EXCERPT_MAX, cardExcerpt } from '../../src/lib/cardExcerpt';

const ROOT = resolve(__dirname, '../../src');
const questList = readFileSync(resolve(ROOT, 'features/quests/QuestListPage.tsx'), 'utf8');
const npcList = readFileSync(resolve(ROOT, 'features/npcs/NpcListPage.tsx'), 'utf8');

test.describe('list card excerpts (bounded before render)', () => {
  test('a field-limit body is cut to the preview bound, not merely clamped', () => {
    const huge = 'word '.repeat(10_000); // 50k characters, the schema maximum
    const out = cardExcerpt(huge);
    expect(out.length).toBeLessThanOrEqual(CARD_EXCERPT_MAX + 1); // +1 for the ellipsis
    expect(out.endsWith('…')).toBe(true);
  });

  test('short bodies pass through untouched and empty ones stay empty', () => {
    expect(cardExcerpt('A quiet hook.')).toBe('A quiet hook.');
    expect(cardExcerpt('')).toBe('');
    expect(cardExcerpt(null)).toBe('');
    expect(cardExcerpt(undefined)).toBe('');
  });

  test('markdown marks are flattened rather than shown as punctuation', () => {
    const md = '# Heading\n\n- **bold** item\n> quoted\n\n`code` and [a link](https://example.com)';
    const out = cardExcerpt(md);
    expect(out).not.toMatch(/[#*_`>]/);
    expect(out).not.toContain('https://example.com');
    expect(out).toContain('bold item');
    expect(out).toContain('a link');
    // Multi-paragraph bodies read as one line, not a column of fragments.
    expect(out).not.toContain('\n');
  });

  test('the cut lands on a word boundary', () => {
    const body = `${'alpha '.repeat(60)}omega`;
    const out = cardExcerpt(body);
    expect(out.endsWith('…')).toBe(true);
    expect(out.replace('…', '').trimEnd()).toMatch(/alpha$/);
  });

  test('both list cards render the bounded excerpt, never the raw body', () => {
    for (const [name, source] of [['quest', questList], ['npc', npcList]] as const) {
      expect(source, `${name} list should import the helper`).toContain('cardExcerpt');
      // The raw body must not be handed to the preview or to a title attribute.
      expect(source).not.toMatch(/title=\{(q|npc)\.body\}/);
      expect(source).not.toMatch(/cf-card-excerpt[^>]*>\s*\{\s*(q|npc)\.body\s*\}/s);
    }
  });
});
