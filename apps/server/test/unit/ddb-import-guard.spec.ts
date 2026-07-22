import {
  ddbImportSupported,
  DND5E_ADAPTER_ID,
  DND5E_PACK_SLUG,
  PF2E_PACK_SLUG,
  PF1E_PACK_SLUG,
  OPEN_LEGEND_PACK_SLUG,
  Dnd5eAdapter,
  Pf2eAdapter,
  OpenLegendAdapter,
  OsrAdapter,
  Archmage13aAdapter,
  StarfinderAdapter,
  ruleSystemAdapter,
} from '@campfire/schema';

/**
 * Issue #714 — D&D Beyond import is field-compatible only with an explicitly-D&D-5e
 * campaign. The importer maps a DDB sheet into the 5e character shape (six abilities, 5e
 * AC/HP math, 5e conditions, 5e skills/saves), so `ddbImportSupported` is the single helper
 * the UI checks to SHOW the import and the server checks to REJECT a direct-API request.
 *
 * The critical distinction from `ruleSystemAdapter`: a homebrew campaign (empty slug) FALLS
 * BACK to the 5e adapter for combat math, but must NOT be treated as "explicitly 5e" for the
 * import — otherwise every homebrew game would be offered (and accept) a 5e-only import.
 */
describe('ddbImportSupported — adapter capability (issue #714)', () => {
  it('the 5e adapter opts in; every other shipped adapter does not', () => {
    expect(Dnd5eAdapter.supportsDdbImport).toBe(true);
    expect(Pf2eAdapter.supportsDdbImport).toBeUndefined();
    expect(OpenLegendAdapter.supportsDdbImport).toBeUndefined();
    expect(OsrAdapter.supportsDdbImport).toBeUndefined();
    expect(Archmage13aAdapter.supportsDdbImport).toBeUndefined();
    expect(StarfinderAdapter.supportsDdbImport).toBeUndefined();
  });
});

describe('ddbImportSupported — rule-pack slug resolution', () => {
  it('true only for explicitly-5e slugs (family id AND the Open5e pack slug)', () => {
    expect(ddbImportSupported(DND5E_ADAPTER_ID)).toBe(true);
    expect(ddbImportSupported(DND5E_PACK_SLUG)).toBe(true);
    expect(ddbImportSupported('open5e-srd')).toBe(true);
  });

  it('false for every other registered system (Pathfinder, Starfinder, 13th Age, Open Legend, OSR)', () => {
    expect(ddbImportSupported(PF2E_PACK_SLUG)).toBe(false);
    expect(ddbImportSupported('pf2e')).toBe(false);
    expect(ddbImportSupported(PF1E_PACK_SLUG)).toBe(false);
    expect(ddbImportSupported(OPEN_LEGEND_PACK_SLUG)).toBe(false);
    expect(ddbImportSupported('open-legend')).toBe(false);
    expect(ddbImportSupported('starfinder-1e')).toBe(false);
    expect(ddbImportSupported('archmage-srd')).toBe(false);
    expect(ddbImportSupported('archmage')).toBe(false);
    // Every OSR retroclone slug resolves to the shared OSR adapter, which does not opt in.
    expect(ddbImportSupported('basic-fantasy')).toBe(false);
    expect(ddbImportSupported('osric')).toBe(false);
    expect(ddbImportSupported('old-school-essentials')).toBe(false);
    expect(ddbImportSupported('osr')).toBe(false);
  });

  it('false for a homebrew campaign (empty / null / undefined slug)', () => {
    // This is the key asymmetry with ruleSystemAdapter: an empty slug resolves to the 5e
    // adapter for combat, but is NOT treated as explicitly-5e for the import.
    expect(ddbImportSupported('')).toBe(false);
    expect(ddbImportSupported(null)).toBe(false);
    expect(ddbImportSupported(undefined)).toBe(false);
  });

  it('false for an unrecognized slug (never trust an unknown pack)', () => {
    expect(ddbImportSupported('my-homebrew-5e-ish')).toBe(false);
    expect(ddbImportSupported('dnd-5e')).toBe(false); // not a registered slug
    expect(ddbImportSupported('pathfinder')).toBe(false); // partial / wrong slug
  });

  it('does not change combat-adapter resolution: a homebrew/unknown slug still falls back to 5e', () => {
    // Guards against an over-fix that would have broken the existing 5e-default behaviour.
    expect(ruleSystemAdapter('').label).toBe('D&D 5e');
    expect(ruleSystemAdapter('open5e-srd').label).toBe('D&D 5e');
    expect(ruleSystemAdapter('my-homebrew-5e-ish').label).toBe('D&D 5e');
  });
});
