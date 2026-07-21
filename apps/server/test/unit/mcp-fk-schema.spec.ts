import { flattenNullableNumericFks } from '../../src/modules/mcp/mcp-tools';

// Issue #371: nullable numeric FK fields must serialize with a concrete top-level
// numeric `type`, not an untyped `anyOf` union that MCP clients can't read.
describe('flattenNullableNumericFks (#371)', () => {
  it('flattens anyOf:[<integer>, null] into a top-level type:["integer","null"], keeping constraints & metadata', () => {
    const input = {
      type: 'object',
      properties: {
        giverNpcId: {
          anyOf: [{ type: 'integer', exclusiveMinimum: 0 }, { type: 'null' }],
          default: null,
          description: 'Quest giver',
        },
      },
    };
    const out = flattenNullableNumericFks(input) as {
      properties: { giverNpcId: { type?: unknown; exclusiveMinimum?: unknown; default?: unknown; description?: unknown; anyOf?: unknown } };
    };
    const fk = out.properties.giverNpcId;
    expect(fk.type).toEqual(['integer', 'null']);
    expect(fk.exclusiveMinimum).toBe(0);
    expect(fk.default).toBeNull();
    expect(fk.description).toBe('Quest giver');
    expect(fk.anyOf).toBeUndefined();
  });

  it('flattens the null-first ordering too', () => {
    const out = flattenNullableNumericFks({ anyOf: [{ type: 'null' }, { type: 'number' }] }) as { type?: unknown };
    expect(out.type).toEqual(['number', 'null']);
  });

  it('leaves already-flat nullable numbers untouched (mapX/mapY)', () => {
    const node = { type: ['number', 'null'], default: null };
    expect(flattenNullableNumericFks(node)).toEqual(node);
  });

  it('leaves non-null numeric FKs untouched', () => {
    const node = { type: 'integer', exclusiveMinimum: 0, description: 'Campaign id' };
    expect(flattenNullableNumericFks(node)).toEqual(node);
  });

  it('does not touch non-numeric nullable unions (e.g. string|null)', () => {
    const node = { anyOf: [{ type: 'string' }, { type: 'null' }] };
    expect(flattenNullableNumericFks(node)).toEqual(node);
  });

  it('recurses into nested properties', () => {
    const out = flattenNullableNumericFks({
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          properties: { parentId: { anyOf: [{ type: 'integer' }, { type: 'null' }] } },
        },
      },
    }) as { properties: { nested: { properties: { parentId: { type?: unknown } } } } };
    expect(out.properties.nested.properties.parentId.type).toEqual(['integer', 'null']);
  });
});
