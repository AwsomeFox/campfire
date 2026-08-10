import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isCampaignEvent } from '../../src/lib/useCampaignEvents';

const ROOT = resolve(__dirname, '../..');
const RUN_SESSION_PAGE = resolve(ROOT, 'src/features/encounters/RunSessionPage.tsx');
const ENCOUNTERS_SERVICE = resolve(ROOT, '../server/src/modules/encounters/encounters.service.ts');

test.describe('campaign condition definitions (issue #1505)', () => {
  test('campaign.updated is accepted and refreshes the live run-session campaign snapshot', () => {
    expect(isCampaignEvent({ type: 'campaign.updated', campaignId: 5, at: '2026-08-09T00:00:00.000Z' })).toBe(true);

    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    expect(source).toMatch(/useCampaigns\(\)/);
    expect(source).toMatch(/event\.type === 'campaign\.updated'[\s\S]*?refreshCampaigns\(\)/);
  });

  test('only player patches that introduce a condition name load campaign definitions', () => {
    const source = readFileSync(ENCOUNTERS_SERVICE, 'utf8');
    expect(source).toMatch(/if \(conditionNames\.length > 0\) \{[\s\S]*?conditionDefinitions/);
  });
});
