import { AoeTemplateDeclare, AoeTemplateUpdate } from '@campfire/schema';

describe('AoE template write contracts (issue #1913)', () => {
  const declaration = {
    id: 'aoe-1',
    shape: 'cone' as const,
    x: 25,
    y: 75,
    sizeFt: 30,
  };

  it('accepts a declaration without caller-controlled attribution', () => {
    expect(AoeTemplateDeclare.safeParse(declaration).success).toBe(true);
  });

  it('rejects a spoofed declarer on create', () => {
    expect(
      AoeTemplateDeclare.safeParse({
        ...declaration,
        declaredByUserId: 'dev:another-player',
      }).success,
    ).toBe(false);
  });

  it('accepts template changes but rejects a spoofed declarer on update', () => {
    expect(AoeTemplateUpdate.safeParse({ x: 50, sizeFt: 40, angleDeg: 90 }).success).toBe(true);
    expect(AoeTemplateUpdate.safeParse({ x: 50, declaredByUserId: 'dev:another-player' }).success).toBe(false);
  });

  it('does not materialize declaration defaults on an omitted update field', () => {
    expect(AoeTemplateUpdate.parse({ x: 50 })).toEqual({ x: 50 });
  });
});
