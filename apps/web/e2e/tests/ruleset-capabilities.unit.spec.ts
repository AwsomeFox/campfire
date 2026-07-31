import { expect, test } from '@playwright/test';
import { ddbImportSupported, ruleSystemAdapter } from '@campfire/schema';
import {
  homebrewCapabilities,
  rulePackCapabilities,
  rulesetCapabilitiesForSelection,
} from '../../src/lib/rules';

test.describe('ruleset capability disclosures (#508)', () => {
  test('homebrew explicitly discloses adapter fallbacks without claiming an installed 5e pack', () => {
    const profile = homebrewCapabilities();
    const fallbackLabel = ruleSystemAdapter('').label;

    expect(profile.slug).toBe('');
    expect(profile.name).toBe('None / homebrew');
    expect(profile.isHomebrew).toBe(true);
    expect(profile.adapterLabel).toBe(fallbackLabel);
    expect(profile.mechanicsSummary).toContain(`falls back to ${fallbackLabel}`);
    expect(profile.mechanicsSummary).toContain('does not select a 5e rules pack');
    expect(profile.migrationPreview.join(' ')).toContain('Settings');

    expect(profile.capabilities.find((c) => c.key === 'compendium')).toMatchObject({
      status: 'unavailable',
    });
    expect(profile.capabilities.find((c) => c.key === 'combatMath')).toMatchObject({
      status: 'fallback',
    });
    expect(profile.capabilities.find((c) => c.key === 'difficulty')).toMatchObject({
      status: 'fallback',
    });
    expect(profile.capabilities.find((c) => c.key === 'ddb')).toMatchObject({
      status: ddbImportSupported('') ? 'available' : 'unavailable',
    });
  });

  test('installed 5e pack contrasts with homebrew by enabling compendium, AI and DDB', () => {
    const profile = rulePackCapabilities({
      slug: 'open5e-srd',
      name: 'D&D 5e SRD',
      entryCount: 123,
    });

    expect(profile.isHomebrew).toBe(false);
    expect(profile.capabilities.find((c) => c.key === 'compendium')).toMatchObject({
      status: 'available',
    });
    expect(profile.capabilities.find((c) => c.key === 'ai')).toMatchObject({
      status: 'available',
    });
    expect(profile.capabilities.find((c) => c.key === 'ddb')).toMatchObject({
      status: 'available',
    });
  });

  test('unknown uploaded packs disclose installed text plus combat fallback', () => {
    const profile = rulePackCapabilities({
      slug: 'uploaded-homebrew-pack',
      name: 'Uploaded Homebrew Pack',
      entryCount: 12,
    });

    expect(profile.capabilities.find((c) => c.key === 'compendium')).toMatchObject({
      status: 'available',
    });
    expect(profile.capabilities.find((c) => c.key === 'combatMath')).toMatchObject({
      status: 'fallback',
    });
    expect(profile.capabilities.find((c) => c.key === 'ddb')).toMatchObject({
      status: 'unavailable',
    });
  });

  test('selection helper returns homebrew for an empty slug and pack profile for a matching slug', () => {
    expect(rulesetCapabilitiesForSelection('', [])).toMatchObject({ isHomebrew: true });
    expect(
      rulesetCapabilitiesForSelection('open5e-srd', [
        { slug: 'open5e-srd', name: 'D&D 5e SRD', entryCount: 20 },
      ]),
    ).toMatchObject({ isHomebrew: false, slug: 'open5e-srd' });
  });

  test('cepheus-srd (in picker list but no schema adapter) reports fallback status for mechanics', () => {
    const profile = rulePackCapabilities({
      slug: 'cepheus-srd',
      name: 'Cepheus Engine SRD',
      entryCount: 50,
    });

    expect(profile.capabilities.find((c) => c.key === 'characterMath')).toMatchObject({
      status: 'fallback',
    });
    expect(profile.capabilities.find((c) => c.key === 'combatMath')).toMatchObject({
      status: 'fallback',
    });
    expect(profile.capabilities.find((c) => c.key === 'difficulty')).toMatchObject({
      status: 'fallback',
    });
    expect(profile.capabilities.find((c) => c.key === 'actions')).toMatchObject({
      status: 'fallback',
    });
  });
});
