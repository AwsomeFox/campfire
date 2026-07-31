import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { createTestApp, closeTestApp, type TestAppContext } from '../test-app';
import { ScribeService } from '../../src/modules/scribe/scribe.service';
import { SettingsService } from '../../src/modules/settings/settings.service';
import { DB, type DrizzleDb } from '../../src/db/db.module';
import { aiDmSeats, aiScribeJobs, campaigns, encounters, proposals } from '../../src/db/schema';
import { type RequestUser } from '../../src/common/user.types';
import { nowIso } from '../../src/common/time';

describe('ScribeService — duplicate recap check query scaling (#1530)', () => {
  let ctx: TestAppContext;
  let scribeService: ScribeService;
  let db: DrizzleDb;
  let campaignId: number;
  const user: RequestUser = {
    id: 'dev:test-dm-1530',
    name: 'Test DM',
    serverRole: 'admin',
    devRole: 'dm',
  };

  beforeEach(async () => {
    ctx = await createTestApp();
    scribeService = ctx.app.get(ScribeService);
    db = ctx.app.get(DB);

    const settingsService = ctx.app.get(SettingsService);
    await settingsService.update({ experimentalAiDm: true });

    const now = nowIso();
    const [c] = await db
      .insert(campaigns)
      .values({ name: 'Scribe Duplicate Test', createdAt: now, updatedAt: now })
      .returning({ id: campaigns.id });
    campaignId = c.id;

    await db.insert(aiDmSeats).values({ campaignId, enabled: true, tokenBudget: 10000, createdAt: now, updatedAt: now });

    // Seed ended encounter so hasRecapMaterial(source) is true regardless of consent policy
    await db.insert(encounters).values({
      campaignId,
      name: 'Battle of the Crossroads',
      status: 'ended',
      createdAt: now,
      updatedAt: now,
    });
  });

  afterEach(async () => {
    if (ctx) {
      await closeTestApp(ctx);
    }
  });

  it('issues constant number of database queries regardless of prior succeeded job count', async () => {
    const now = nowIso();
    const [prop0] = await db
      .insert(proposals)
      .values({
        campaignId,
        entityType: 'recap',
        entityId: 0,
        action: 'create',
        status: 'approved',
        payload: '{}',
        proposer: 'system',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: proposals.id });

    await db.insert(aiScribeJobs).values({
      campaignId,
      trigger: 'on_demand',
      status: 'succeeded',
      sourceHash: 'hash-initial',
      proposalId: prop0.id,
      createdBy: 'test-dm',
      createdAt: now,
    });

    let selectQueryCount = 0;
    const origSelect = db.select.bind(db);
    (db as any).select = (...args: any[]) => {
      selectQueryCount++;
      return (origSelect as any)(...args);
    };

    // Run 1: 1 prior succeeded job
    selectQueryCount = 0;
    await scribeService.run(campaignId, 'on_demand', user);
    const countWith1 = selectQueryCount;

    // Seed 20 additional succeeded jobs with different hashes and non-pending proposals
    for (let i = 1; i <= 20; i++) {
      const [prop] = await db
        .insert(proposals)
        .values({
          campaignId,
          entityType: 'recap',
          entityId: 0,
          action: 'create',
          status: 'approved',
          payload: '{}',
          proposer: 'system',
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: proposals.id });

      await db.insert(aiScribeJobs).values({
        campaignId,
        trigger: 'on_demand',
        status: 'succeeded',
        sourceHash: `hash-extra-${i}`,
        proposalId: prop.id,
        createdBy: 'test-dm',
        createdAt: now,
      });
    }

    // Run 2: 21 prior succeeded jobs
    selectQueryCount = 0;
    await scribeService.run(campaignId, 'on_demand', user);
    const countWith21 = selectQueryCount;

    (db as any).select = origSelect;

    // Query count must be strictly constant, not linear in prior succeeded jobs
    expect(countWith21).toBe(countWith1);
  });

  it('preserves precedence: pending proposal skip is reported ahead of identical source', async () => {
    const now = nowIso();

    const [pendingProp] = await db
      .insert(proposals)
      .values({
        campaignId,
        entityType: 'recap',
        entityId: 0,
        action: 'create',
        status: 'pending',
        payload: '{}',
        proposer: 'system',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: proposals.id });

    // Compute sourceHash for the assembled source material under local egress
    const assembly = await scribeService.assembleSourceWithConsent(campaignId, undefined, 'local');
    const crypto = await import('node:crypto');
    const sourceHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(assembly.source))
      .digest('hex');

    await db.insert(aiScribeJobs).values({
      campaignId,
      trigger: 'on_demand',
      status: 'succeeded',
      sourceHash,
      proposalId: pendingProp.id,
      createdBy: 'test-dm',
      createdAt: now,
    });

    const result = await scribeService.run(campaignId, 'on_demand', user);

    expect(result.job.status).toBe('skipped');
    expect(result.job.detail).toBe('a scribe recap proposal is already pending review');
  });

  it('reports identical source already drafted when proposal is not pending', async () => {
    const now = nowIso();

    const [approvedProp] = await db
      .insert(proposals)
      .values({
        campaignId,
        entityType: 'recap',
        entityId: 0,
        action: 'create',
        status: 'approved',
        payload: '{}',
        proposer: 'system',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: proposals.id });

    const assembly = await scribeService.assembleSourceWithConsent(campaignId, undefined, 'local');
    const crypto = await import('node:crypto');
    const sourceHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(assembly.source))
      .digest('hex');

    await db.insert(aiScribeJobs).values({
      campaignId,
      trigger: 'on_demand',
      status: 'succeeded',
      sourceHash,
      proposalId: approvedProp.id,
      createdBy: 'test-dm',
      createdAt: now,
    });

    const result = await scribeService.run(campaignId, 'on_demand', user);

    expect(result.job.status).toBe('skipped');
    expect(result.job.detail).toBe('identical source already drafted');
  });

  it('bypasses duplicate skip checks when force is true', async () => {
    const now = nowIso();

    const [pendingProp] = await db
      .insert(proposals)
      .values({
        campaignId,
        entityType: 'recap',
        entityId: 0,
        action: 'create',
        status: 'pending',
        payload: '{}',
        proposer: 'system',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: proposals.id });

    await db.insert(aiScribeJobs).values({
      campaignId,
      trigger: 'on_demand',
      status: 'succeeded',
      sourceHash: 'any-hash',
      proposalId: pendingProp.id,
      createdBy: 'test-dm',
      createdAt: now,
    });

    const result = await scribeService.run(campaignId, 'on_demand', user, { force: true });
    expect(result.job.detail).not.toBe('a scribe recap proposal is already pending review');
    expect(result.job.detail).not.toBe('identical source already drafted');
  });

  it('preserves skip-path behavior for post_session trigger', async () => {
    const now = nowIso();

    const [approvedProp] = await db
      .insert(proposals)
      .values({
        campaignId,
        entityType: 'recap',
        entityId: 0,
        action: 'create',
        status: 'approved',
        payload: '{}',
        proposer: 'system',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: proposals.id });

    const assembly = await scribeService.assembleSourceWithConsent(campaignId, undefined, 'local');
    const crypto = await import('node:crypto');
    const sourceHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(assembly.source))
      .digest('hex');

    await db.insert(aiScribeJobs).values({
      campaignId,
      trigger: 'post_session',
      status: 'succeeded',
      sourceHash,
      proposalId: approvedProp.id,
      createdBy: 'test-dm',
      createdAt: now,
    });

    const result = await scribeService.run(campaignId, 'post_session', user);

    expect(result.job.status).toBe('skipped');
    expect(result.job.detail).toBe('identical source already drafted');
  });
});
