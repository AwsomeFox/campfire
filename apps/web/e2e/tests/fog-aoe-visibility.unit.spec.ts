/**
 * Client-side AoE fog filtering (issue #465) — defense in depth beside server redaction.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AoeTemplate } from '@campfire/schema';
import { filterAoeTemplatesForViewer } from '@campfire/schema';

const BATTLE_MAP = resolve(__dirname, '../../src/features/encounters/map/BattleMap.tsx');

function aoe(partial: Partial<AoeTemplate> & Pick<AoeTemplate, 'id'>): AoeTemplate {
  return {
    shape: 'circle',
    x: 50,
    y: 50,
    sizeFt: 20,
    angleDeg: 0,
    color: null,
    declaredByUserId: null,
    ...partial,
  };
}

test.describe('AoE fog visibility (issue #465)', () => {
  test('BattleMap filters non-DM AoE templates instead of relying on z-index alone', () => {
    const source = readFileSync(BATTLE_MAP, 'utf8');
    expect(source).toContain('filterAoeTemplatesForViewer');
    expect(source).toContain('viewerUserId');
    expect(source).not.toMatch(/canAoe && encounter\.aoe/);
  });

  test('filterAoeTemplatesForViewer mirrors server concealment rules', () => {
    const fog = { enabled: true, revealed: [{ x: 60, y: 60, w: 40, h: 40 }] };
    const templates = [aoe({ id: 'dark', x: 10, y: 10 }), aoe({ id: 'lit', x: 80, y: 80 })];
    expect(filterAoeTemplatesForViewer(templates, fog).map((t) => t.id)).toEqual(['lit']);
  });
});
