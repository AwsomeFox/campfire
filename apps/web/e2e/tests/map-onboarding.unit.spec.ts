import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const MAP_ONBOARDING = resolve(ROOT, 'src/components/mapOnboarding.tsx');
const GET_A_MAP_PANEL = resolve(ROOT, 'src/components/GetAMapPanel.tsx');
const GENERATE_MAP_PANEL = resolve(ROOT, 'src/components/GenerateMapPanel.tsx');
const EXTERNAL_GENERATOR_CARD = resolve(ROOT, 'src/components/ExternalGeneratorCard.tsx');
const HANDOUTS_CARD = resolve(ROOT, 'src/features/dashboard/HandoutsCard.tsx');
const BATTLE_MAP = resolve(ROOT, 'src/features/encounters/map/BattleMap.tsx');
const REGION_MAP = resolve(ROOT, 'src/features/dashboard/RegionMap.tsx');

test.describe('maps onboarding concepts (issue #520)', () => {
  test('shared glossary names world maps, handouts, and encounter battle maps', () => {
    const source = readFileSync(MAP_ONBOARDING, 'utf8');
    expect(source).toContain("export type MapPurpose = 'world' | 'handout' | 'encounter'");
    expect(source).toContain('World map');
    expect(source).toContain('Handout');
    expect(source).toContain('Encounter battle map');
    expect(source).toContain('MapConceptGlossary');
    expect(source).toContain('MapPurposePicker');
  });

  test('GetAMapPanel routes generation and imports through the selected purpose', () => {
    const panel = readFileSync(GET_A_MAP_PANEL, 'utf8');
    const generate = readFileSync(GENERATE_MAP_PANEL, 'utf8');
    const external = readFileSync(EXTERNAL_GENERATOR_CARD, 'utf8');

    expect(panel).toContain('surfacePurpose');
    expect(panel).toContain('MapPurposePicker');
    expect(panel).toContain('mapPurposeMismatchMessage');
    expect(panel).toContain('useDisabledReason={purposeMismatch}');
    expect(panel).toContain('importDisabledReason={purposeMismatch}');
    expect(generate).toContain('generate-map-route-required');
    expect(generate).toContain('disabled={!preview || busy || !!useDisabledReason}');
    expect(external).toContain('generator-route-required');
    expect(external).toContain('disabled={!canImport}');
  });

  test('region, encounter, and handout surfaces declare their saving purpose', () => {
    expect(readFileSync(REGION_MAP, 'utf8')).toContain('surfacePurpose="world"');
    expect(readFileSync(BATTLE_MAP, 'utf8')).toContain('surfacePurpose="encounter"');
    expect(readFileSync(HANDOUTS_CARD, 'utf8')).toContain('purpose="handout"');
  });

  test('handout reveal warns that raw files bypass encounter fog', () => {
    const source = readFileSync(HANDOUTS_CARD, 'utf8');
    expect(source).toContain('handout-reveal-warning');
    expect(source).toContain('Reveal raw file');
    expect(source).toContain('exposes the raw image or PDF');
    expect(source).toContain('Encounter fog');
    expect(source).toContain('Cast player-safe projection do not protect');
  });

  test('encounter map explains player-safe cast/fog preview', () => {
    const source = readFileSync(BATTLE_MAP, 'utf8');
    expect(source).toContain('map-player-preview-note');
    expect(source).toContain('map-fog-player-preview');
    expect(source).toContain('player-safe fog projection');
    expect(source).toContain('Handout reveal is different');
  });
});
