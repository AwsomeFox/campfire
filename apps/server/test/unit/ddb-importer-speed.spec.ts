import { computeSpeed } from '../../src/modules/characters/ddb-importer';

describe('computeSpeed (issue #1985)', () => {
  it('defaults to 30 when no race or speed modifiers exist', () => {
    expect(computeSpeed({})).toBe(30);
  });

  it('uses race.weightSpeeds.normal.walk when present', () => {
    expect(
      computeSpeed({
        race: {
          weightSpeeds: {
            normal: { walk: 25 },
          },
        },
      }),
    ).toBe(25);
  });

  it('applies speed bonus modifiers to racial walk speed', () => {
    expect(
      computeSpeed({
        race: {
          weightSpeeds: {
            normal: { walk: 30 },
          },
        },
        modifiers: {
          class: [
            { type: 'bonus', subType: 'unarmored-movement', value: 10 },
          ],
        },
      }),
    ).toBe(40);
  });

  it('uses customSpeeds distance override over racial speed', () => {
    expect(
      computeSpeed({
        race: {
          weightSpeeds: {
            normal: { walk: 30 },
          },
        },
        customSpeeds: [{ movementId: 1, distance: 35 }],
      }),
    ).toBe(35);
  });

  it('applies speed set modifiers over racial speed', () => {
    expect(
      computeSpeed({
        race: {
          weightSpeeds: {
            normal: { walk: 30 },
          },
        },
        modifiers: {
          feat: [
            { type: 'set', subType: 'speed', value: 45 },
          ],
        },
      }),
    ).toBe(45);
  });
});
