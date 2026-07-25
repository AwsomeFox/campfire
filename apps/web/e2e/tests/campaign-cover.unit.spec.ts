/**
 * Campaign cover + ember brand helpers (issue #676).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  CAMPAIGN_COVER_MOTIFS,
  coverMonogram,
  cropForCampaign,
  motifForCampaign,
  resolveCampaignCover,
} from '../../src/lib/campaignCover';

test.describe('campaign cover helpers (issue #676)', () => {
  test('motifForCampaign is stable and overrideable', () => {
    const a = motifForCampaign(12);
    const b = motifForCampaign(12);
    expect(a).toBe(b);
    expect(CAMPAIGN_COVER_MOTIFS).toContain(a);
    expect(motifForCampaign(12, 'storm')).toBe('storm');
  });

  test('cropForCampaign stays within 0–100 bounds', () => {
    for (const id of [1, 7, 99, 1000, -3]) {
      const crop = cropForCampaign(id);
      expect(crop.focalX).toBeGreaterThanOrEqual(0);
      expect(crop.focalX).toBeLessThanOrEqual(100);
      expect(crop.focalY).toBeGreaterThanOrEqual(0);
      expect(crop.focalY).toBeLessThanOrEqual(100);
    }
  });

  test('resolveCampaignCover returns gradient, overlay, and variant height', () => {
    const tile = resolveCampaignCover({ campaignId: 3, variant: 'tile' });
    const strip = resolveCampaignCover({ campaignId: 3, variant: 'strip' });
    expect(tile.gradient).toContain('linear-gradient');
    expect(tile.overlay).toContain('linear-gradient');
    expect(tile.heightPx).toBeGreaterThan(strip.heightPx);
    expect(tile.motifId).toBe(motifForCampaign(3));
    expect(tile.motifTexture).toMatch(/rgba\(\d+,\d+,\d+,/);
    expect(tile.motifTexture).not.toContain('%2C');
  });

  test('coverMonogram uppercases the first grapheme', () => {
    expect(coverMonogram('emberfall')).toBe('E');
    expect(coverMonogram('  ')).toBe('?');
    expect(coverMonogram('🧙‍♂️ Arcane')).toBe('🧙');
  });
});

test.describe('ember brand tokens (issue #676)', () => {
  const indexCss = readFileSync(resolve(__dirname, '../../src/index.css'), 'utf8');

  test('display + ember tokens are defined without Google font imports', () => {
    expect(indexCss).toContain('--font-display:');
    expect(indexCss).toContain('--cf-ember-ambient:');
    expect(indexCss).toContain('.cf-ember-layer');
    expect(indexCss).not.toMatch(/@import\s+url\([^)]*fonts\.googleapis/i);
  });
});
