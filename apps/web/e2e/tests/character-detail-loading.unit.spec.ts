/**
 * Character detail loading contracts (issue #460).
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CHARACTER_PAGE = resolve(__dirname, '../../src/features/characters/CharacterPage.tsx');
const CHARACTER_LOADING = resolve(__dirname, '../../src/features/characters/CharacterDetailLoadingSkeleton.tsx');

test.describe('character detail loading (issue #460)', () => {
  test('CharacterPage uses the geometry-preserving loading skeleton', () => {
    const page = readFileSync(CHARACTER_PAGE, 'utf8');
    expect(page).toMatch(/CharacterDetailLoadingSkeleton/);
    expect(page).not.toMatch(/Skeleton lines=/);
    expect(page).toMatch(/setLoading\(true\)/);
    expect(page).toMatch(/setCharacter\(null\)/);
  });

  test('loading skeleton exposes named busy status without an h1', () => {
    const skeleton = readFileSync(CHARACTER_LOADING, 'utf8');
    expect(skeleton).toMatch(/role="status"/);
    expect(skeleton).toMatch(/aria-busy="true"/);
    expect(skeleton).toMatch(/Loading character…/);
    expect(skeleton).toMatch(/data-testid="character-detail-loading"/);
    expect(skeleton).not.toMatch(/<h1/);
  });

  test('error and not-found branches stay distinct from the loading shell', () => {
    const page = readFileSync(CHARACTER_PAGE, 'utf8');
    expect(page).toMatch(/NotFoundState/);
    expect(page).toMatch(/ErrorNote message=\{error\}/);
    expect(page).toMatch(/if \(notFound && !character\)/);
    expect(page).toMatch(/if \(error && !character\)/);
  });
});
