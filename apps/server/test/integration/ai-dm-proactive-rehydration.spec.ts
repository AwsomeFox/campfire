import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { describe, expect, it, jest, afterEach } from '@jest/globals';
import { NEVER } from 'rxjs';
import { openDatabase, type DrizzleDb } from '../../src/db/db.module';
import { campaigns, aiDmSeats } from '../../src/db/schema';
import { AiDmService } from '../../src/modules/ai-dm/ai-dm.service';
import { ProactiveService } from '../../src/modules/ai-driver/proactive.service';
import { makeTempDataDir } from './fixtures';

/**
 * Issue #1587 — proactive narration silently stops for EVERY campaign after a restart.
 *
 * ── Why this is a REAL-SQLITE, service-layer spec, not an HTTP one ─────────────────────────
 * `ProactiveService`'s watcher registry is an in-memory `Map` of live rxjs subscriptions, wiped
 * clean by construction on every process start. The bug is specifically that nothing on boot
 * re-populates it from the durable `ai_dm_seats` rows — an HTTP e2e spec that boots one Nest app
 * and never restarts it cannot exercise "boot" at all; it would only prove the FIRST boot works,
 * which was never broken. So this drives `AiDmService.onApplicationBootstrap()` directly (same
 * hand-constructed-service pattern as ai-driver-control-state-persistence.spec.ts, no Nest
 * TestingModule) against a real, migrated SQLite file that already has seat rows written to it —
 * simulating exactly what a restart looks like: durable state present, in-memory state gone.
 *
 * `ProactiveService` is constructed for real too, wired to the SAME `AiDmService` instance via
 * `registerProactiveSettingsCallback` in its constructor — the exact production wiring — so the
 * assertions below are against a genuine watcher (`isWatching`), not a spy on an internal callback.
 */
describe('AiDmService proactive-watcher rehydration on boot (#1587)', () => {
  let dataDir: string;
  let sqlite: Database.Database | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** Construct AiDmService + ProactiveService over `db`, matching production wiring. */
  function makeServices(db: DrizzleDb): { aiDm: AiDmService; proactive: ProactiveService } {
    const audit = { log: jest.fn(async () => undefined) };
    const settings = {};
    const providerConfig = {};
    const sessionZero = {};
    const supportPreferences = {};
    const pricing = {};
    const provider = {};
    const aiDm = new AiDmService(
      db,
      audit as any,
      settings as any,
      providerConfig as any,
      sessionZero as any,
      supportPreferences as any,
      pricing as any,
      provider as any,
    );
    // Real CampaignEventsService is unnecessary — startWatching only needs an Observable to
    // subscribe to, and NEVER (an rxjs Observable that emits nothing) is enough to prove a
    // subscription was created without any real event machinery.
    const events = { streamFor: jest.fn(() => NEVER) };
    const driver = {};
    // The constructor call below is what registers ProactiveService's callback onto `aiDm` —
    // this MUST happen before aiDm.onApplicationBootstrap() runs, exactly like production
    // (every provider's constructor runs before any OnApplicationBootstrap hook fires).
    const proactive = new ProactiveService(events as any, driver as any, aiDm);
    return { aiDm, proactive };
  }

  it('an enabled seat gets a live watcher again after a simulated restart', async () => {
    dataDir = makeTempDataDir();
    const opened = openDatabase(dataDir);
    sqlite = opened.sqlite;
    const db = opened.orm;
    const ts = '2026-07-27T00:00:00.000Z';
    db.insert(campaigns).values({ name: 'Proactive Table', createdAt: ts, updatedAt: ts }).run();
    const [campaign] = db.select().from(campaigns).all();
    db.insert(aiDmSeats)
      .values({
        campaignId: campaign.id,
        enabled: true,
        proactiveSettings: {
          enabled: true,
          triggers: { encounterEnded: true, hpCritical: false, objectiveCompleted: false, npcTurn: false },
          cooldownSeconds: 300,
          maxProactiveTokensPerHour: 5_000,
        },
        createdAt: ts,
        updatedAt: ts,
      })
      .run();

    const { aiDm, proactive } = makeServices(db);
    // The bug: on unfixed code, nothing enumerates seats here, so isWatching stays false.
    expect(proactive.isWatching(campaign.id)).toBe(false);

    await aiDm.onApplicationBootstrap();

    expect(proactive.isWatching(campaign.id)).toBe(true);
  });

  it('a disabled seat is ANNOUNCED (stops a stale watcher), not silently skipped', async () => {
    dataDir = makeTempDataDir();
    const opened = openDatabase(dataDir);
    sqlite = opened.sqlite;
    const db = opened.orm;
    const ts = '2026-07-27T00:00:00.000Z';
    db.insert(campaigns).values({ name: 'Disabled Proactive Table', createdAt: ts, updatedAt: ts }).run();
    const [campaign] = db.select().from(campaigns).all();
    db.insert(aiDmSeats)
      .values({
        campaignId: campaign.id,
        enabled: true,
        proactiveSettings: {
          enabled: false,
          triggers: { encounterEnded: false, hpCritical: false, objectiveCompleted: false, npcTurn: false },
          cooldownSeconds: 300,
          maxProactiveTokensPerHour: 5_000,
        },
        createdAt: ts,
        updatedAt: ts,
      })
      .run();

    const { aiDm, proactive } = makeServices(db);

    // Simulate a watcher surviving from before — this can't happen on a genuinely cold boot
    // (the Map always starts empty), but it is exactly the scenario syncProactiveWatcher's own
    // "disabled seats are announced too" contract exists to protect against (a stale watcher at
    // a recycled campaign id), and the only observable way to prove this campaign was actually
    // PROCESSED during rehydration rather than skipped as an "already off, nothing to do"
    // optimization.
    const unsubscribe = jest.fn();
    (proactive as unknown as { campaigns: Map<number, { subscription: { unsubscribe: () => void } }> }).campaigns.set(
      campaign.id,
      { subscription: { unsubscribe } } as any,
    );
    expect(proactive.isWatching(campaign.id)).toBe(true);

    await aiDm.onApplicationBootstrap();

    // If the bootstrap path had "optimized" by only enumerating proactiveSettings.enabled
    // seats, this campaign would never have been touched and the stale entry would still be
    // sitting in the Map, unsubscribed. Its removal — via a real call to stopWatching — is the
    // proof this seat was announced rather than skipped.
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(proactive.isWatching(campaign.id)).toBe(false);
  });

  it('rehydration is a no-op when no campaign has ever configured a seat', async () => {
    dataDir = makeTempDataDir();
    const opened = openDatabase(dataDir);
    sqlite = opened.sqlite;
    const db = opened.orm;
    const { aiDm, proactive } = makeServices(db);
    await expect(aiDm.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(proactive.isWatching(1)).toBe(false);
  });
});
