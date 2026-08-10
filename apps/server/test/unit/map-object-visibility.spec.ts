import { MapObject, MapObjectCreate, MapObjectUpdate, filterMapObjectsForViewer } from '@campfire/schema';

describe('MapObject write contracts (issue #1308)', () => {
  const placement = {
    id: 'chest-1',
    label: 'Trapped chest',
    iconSlug: 'chest',
    x: 25,
    y: 75,
    dmOnly: false,
  };

  it('accepts a caller-supplied placement', () => {
    expect(MapObjectCreate.safeParse(placement).success).toBe(true);
  });

  it('rejects an unknown key on placement (.strict())', () => {
    expect(MapObjectCreate.safeParse({ ...placement, sneaky: true }).success).toBe(false);
  });

  it('rejects an id-bearing update payload — id is a route param, never a body field', () => {
    // MapObjectUpdate itself carries no `id` field at all; a caller that tries to smuggle
    // one through gets Zod's unknown-key rejection, same as AoeTemplateUpdate's own
    // `.strict()` convention.
    expect(MapObjectUpdate.safeParse({ id: 'other', x: 50 }).success).toBe(false);
  });

  it('does not materialize placement defaults on an omitted update field', () => {
    expect(MapObjectUpdate.parse({ x: 50 })).toEqual({ x: 50 });
  });

  it('rejects an out-of-range coordinate', () => {
    expect(MapObjectCreate.safeParse({ ...placement, x: 150 }).success).toBe(false);
    expect(MapObjectUpdate.safeParse({ y: -1 }).success).toBe(false);
  });

  it('rejects an empty iconSlug — a set piece must have a real icon, not a blank one', () => {
    expect(MapObjectCreate.safeParse({ ...placement, iconSlug: '' }).success).toBe(false);
  });

  it('issue #2175: fills a size default (5 — percent of map width) when size is omitted', () => {
    expect(MapObject.parse(placement).size).toBe(5);
  });

  it('issue #2175: accepts an explicit in-range size and rejects an out-of-range one', () => {
    expect(MapObjectCreate.safeParse({ ...placement, size: 24 }).success).toBe(true);
    expect(MapObjectCreate.safeParse({ ...placement, size: 0 }).success).toBe(false);
    expect(MapObjectCreate.safeParse({ ...placement, size: 101 }).success).toBe(false);
  });

  it('issue #2175: accepts a size patch and rejects an out-of-range size patch', () => {
    expect(MapObjectUpdate.safeParse({ size: 18 }).success).toBe(true);
    expect(MapObjectUpdate.safeParse({ size: 0 }).success).toBe(false);
    expect(MapObjectUpdate.safeParse({ size: 101 }).success).toBe(false);
  });

  it('issue #2175: does not materialize placement defaults on a size-only update field', () => {
    expect(MapObjectUpdate.parse({ size: 18 })).toEqual({ size: 18 });
  });
});

describe('filterMapObjectsForViewer (issue #1308) — the server\'s one map-object visibility computation', () => {
  const visible: import('@campfire/schema').MapObject = MapObject.parse({
    id: 'visible-1',
    label: 'Broken cart',
    iconSlug: 'cart',
    x: 10,
    y: 10,
    dmOnly: false,
  });
  const secret: import('@campfire/schema').MapObject = MapObject.parse({
    id: 'secret-1',
    label: 'Ambush trigger plate',
    iconSlug: 'trap',
    x: 90,
    y: 90,
    dmOnly: true,
  });

  it('an undefined role (the DM-facing internal-caller convention) sees every object', () => {
    const result = filterMapObjectsForViewer([visible, secret], undefined);
    expect(result.map((o) => o.id).sort()).toEqual(['secret-1', 'visible-1']);
  });

  it('the dm role sees every object', () => {
    const result = filterMapObjectsForViewer([visible, secret], 'dm');
    expect(result.map((o) => o.id).sort()).toEqual(['secret-1', 'visible-1']);
  });

  it('a player never receives a dmOnly object — dropped wholesale, not coordinate-redacted', () => {
    const result = filterMapObjectsForViewer([visible, secret], 'player');
    expect(result).toEqual([visible]);
    // The whole point (per the issue): existence too, not just position. A coordinate-only
    // redaction would still leak "the DM placed something here" via a null-coordinate stub.
    expect(result.find((o) => o.id === 'secret-1')).toBeUndefined();
  });

  it('a viewer never receives a dmOnly object either', () => {
    const result = filterMapObjectsForViewer([visible, secret], 'viewer');
    expect(result).toEqual([visible]);
  });

  it('does not mutate the input array', () => {
    const input = [visible, secret];
    filterMapObjectsForViewer(input, 'player');
    expect(input).toHaveLength(2);
  });
});
