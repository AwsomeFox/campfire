import type { AoeTemplate, FogState } from '@campfire/schema';
import { filterAoeTemplatesForViewer, pointInRevealedRegion } from '@campfire/schema';

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

describe('fog visibility helpers (issue #465)', () => {
  const partialFog: FogState = {
    enabled: true,
    revealed: [{ x: 60, y: 60, w: 40, h: 40 }],
  };

  it('pointInRevealedRegion matches token redaction semantics', () => {
    expect(pointInRevealedRegion(80, 80, partialFog)).toBe(true);
    expect(pointInRevealedRegion(10, 10, partialFog)).toBe(false);
  });

  it('filterAoeTemplatesForViewer returns all templates when fog is disabled', () => {
    const templates = [aoe({ id: 'dark' }), aoe({ id: 'lit', x: 80, y: 80 })];
    expect(filterAoeTemplatesForViewer(templates, { enabled: false, revealed: [] })).toHaveLength(2);
    expect(filterAoeTemplatesForViewer(templates, null)).toHaveLength(2);
  });

  it('filterAoeTemplatesForViewer withholds templates whose origin is in unrevealed fog', () => {
    const templates = [
      aoe({ id: 'hidden', x: 10, y: 10 }),
      aoe({ id: 'visible', x: 80, y: 80 }),
    ];
    const visible = filterAoeTemplatesForViewer(templates, partialFog);
    expect(visible.map((t) => t.id)).toEqual(['visible']);
  });

  it('player-declared templates stay visible to their owner in unrevealed fog', () => {
    const templates = [aoe({ id: 'mine', x: 10, y: 10, declaredByUserId: 'dev:p-1' })];
    expect(filterAoeTemplatesForViewer(templates, partialFog, { viewerUserId: 'dev:p-1' }).map((t) => t.id)).toEqual(['mine']);
    expect(filterAoeTemplatesForViewer(templates, partialFog, { viewerUserId: 'dev:p-2' })).toHaveLength(0);
  });
});
