import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { openDatabase } from '../../src/db/db.module';
import { campaigns, combatants, encounters } from '../../src/db/schema';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CampaignEventsService } from '../../src/modules/events/campaign-events.service';
import { RollsService } from '../../src/modules/rolls/rolls.service';
import { RevisionsService } from '../../src/modules/revisions/revisions.service';
import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import { EncountersService } from '../../src/modules/encounters/encounters.service';
import { fromJsonText } from '../../src/common/json';
import type { RequestUser } from '../../src/common/user.types';
import { makeTempDataDir } from './fixtures';

/**
 * Issue #747, service-layer: concurrent add/remove of conditions on the same
 * combatant must compose, not silently drop one caller's change.
 *
 * The HTTP e2e suite can't reliably reproduce the read-modify-write window —
 * supertest dispatches each request onto the Nest handler and better-sqlite3 is
 * synchronous, so two requests tend to run one-after-the-other rather than
 * interleaving at the drizzle `await` boundaries. This spec drives the SERVICE
 * directly, where `Promise.all([updateCombatant(), updateCombatant()])` DOES
 * interleave at the awaits: each drizzle better-sqlite3 query returns a sync
 * value wrapped in a resolved promise, so `await` yields to the microtask queue
 * and the two calls interleave between statements.
 *
 * Against the pre-fix code, conditions were derived from a STALE pre-await read
 * of the combatant row and written as a complete array inside the transaction
 * without rebasing against the fresh row — so two concurrent callers each
 * computed their next-array off the same stale snapshot, and whichever wrote
 * second clobbered the other (caller A adds 'poisoned' while caller B removes
 * 'prone' => the loser's whole-array write drops the winner's condition). The
 * fix rebases the add/remove deltas against the FRESH row read inside the
 * serialized transaction, so the two deltas compose as set union/difference.
 *
 * No Nest bootstrap: a real SQLite file + the services constructed by hand, so
 * it lives beside the other real-SQLite integration specs (mirrors the
 * password-reset-concurrency spec's shape).
 */
describe('encounter condition concurrency (real SQLite, service layer)', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** Build the EncountersService against a fresh temp SQLite DB. */
  function build() {
    const { orm } = openDatabase(dataDir);
    const audit = new AuditService(orm);
    const events = new CampaignEventsService();
    const rolls = new RollsService(orm);
    const revisions = new RevisionsService(orm, audit);
    const attachments = new AttachmentsService(orm, audit);
    const encountersService = new EncountersService(orm, audit, events, rolls, revisions, attachments);
    return { orm, encountersService };
  }

  const dmUser: RequestUser = { id: 'dev:dm', name: 'DM', serverRole: 'admin', devRole: 'dm' };

  /**
   * Seed a campaign + encounter + one monster combatant, returning the ids.
   * `conditions` lets a test start the combatant from a non-empty condition set.
   */
  function seedCombatant(
    orm: ReturnType<typeof build>['orm'],
    conditions: string[] = [],
  ): { encounterId: number; combatantId: number } {
    const ts = new Date().toISOString();
    const [campaign] = orm
      .insert(campaigns)
      .values({ name: 'Condition Race', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    const [encounter] = orm
      .insert(encounters)
      .values({
        campaignId: campaign.id,
        name: 'Condition Fight',
        status: 'running',
        round: 1,
        turnIndex: 0,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    const [combatant] = orm
      .insert(combatants)
      .values({
        encounterId: encounter.id,
        kind: 'monster',
        name: 'Target',
        initiative: 10,
        initMod: 0,
        hpCurrent: 50,
        hpMax: 50,
        conditions: JSON.stringify(conditions),
        sortOrder: 0,
      })
      .returning()
      .all();
    return { encounterId: encounter.id, combatantId: combatant.id };
  }

  /** Read the combatant's persisted conditions array straight from the row. */
  function readConditions(orm: ReturnType<typeof build>['orm'], combatantId: number): string[] {
    const [row] = orm.select().from(combatants).where(eq(combatants.id, combatantId)).limit(1).all();
    return fromJsonText<string[]>(row.conditions, []);
  }

  it('two concurrent addConditions of DIFFERENT conditions both land (#747)', async () => {
    dataDir = makeTempDataDir();
    const { orm, encountersService } = build();
    const { encounterId, combatantId } = seedCombatant(orm, []);

    // Both callers add a distinct condition off the same empty snapshot. The
    // pre-fix stale whole-array write dropped one: each computed [] + [its own]
    // => whichever wrote second left the row with only ITS condition. The fix
    // rebases off the fresh row, so the two adds compose to both present.
    const results = await Promise.all([
      encountersService.updateCombatant(encounterId, combatantId, { addConditions: ['poisoned'] }, dmUser, 'dm'),
      encountersService.updateCombatant(encounterId, combatantId, { addConditions: ['frightened'] }, dmUser, 'dm'),
    ]);

    // The later-committing response reflects both conditions present.
    const revisionA = new Set(results[0].conditions);
    const revisionB = new Set(results[1].conditions);
    expect(revisionA.has('poisoned')).toBe(true);
    expect(revisionB.has('frightened')).toBe(true);
    // By the second commit both conditions are present (the loser's response
    // shows the winner's condition too, since the fresh read sees it).
    expect(revisionB.has('poisoned')).toBe(true);

    // The persisted row holds both conditions — no lost update.
    const persisted = readConditions(orm, combatantId).slice().sort();
    expect(persisted).toEqual(['frightened', 'poisoned']);
  });

  it('concurrent add + remove of DIFFERENT conditions compose (#747)', async () => {
    dataDir = makeTempDataDir();
    const { orm, encountersService } = build();
    // Start with both conditions present, then race adding one against removing the other.
    const { encounterId, combatantId } = seedCombatant(orm, ['prone', 'poisoned']);

    // Caller A removes 'prone'; caller B adds 'frightened'. The pre-fix code
    // derived both next-arrays off the same ['prone','poisoned'] snapshot and
    // the second writer clobbered the first — e.g. if B wrote last, 'prone'
    // survived (A's removal lost); if A wrote last, 'frightened' was dropped.
    // The fix composes: 'prone' removed AND 'frightened' added.
    await Promise.all([
      encountersService.updateCombatant(encounterId, combatantId, { removeConditions: ['prone'] }, dmUser, 'dm'),
      encountersService.updateCombatant(encounterId, combatantId, { addConditions: ['frightened'] }, dmUser, 'dm'),
    ]);

    const persisted = readConditions(orm, combatantId).slice().sort();
    expect(persisted).toEqual(['frightened', 'poisoned']);
  });

  it('concurrent add + remove of the SAME condition stays internally consistent (#747)', async () => {
    dataDir = makeTempDataDir();
    const { orm, encountersService } = build();
    // 'prone' is present; one caller removes it while another re-adds it. The
    // fix composes deterministically off the fresh row: whichever delta runs
    // second rebases against the first's committed result, so the array never
    // carries a duplicate or a torn state.
    const { encounterId, combatantId } = seedCombatant(orm, ['prone']);

    await Promise.all([
      encountersService.updateCombatant(encounterId, combatantId, { removeConditions: ['prone'] }, dmUser, 'dm'),
      encountersService.updateCombatant(encounterId, combatantId, { addConditions: ['prone'] }, dmUser, 'dm'),
    ]);

    // The persisted value is one of the two consistent outcomes — the array
    // never holds a duplicate 'prone' and never escapes the {present, absent}
    // set. (Exact outcome depends on serialized order; both are valid.)
    const persisted = readConditions(orm, combatantId);
    expect(persisted.filter((c) => c === 'prone').length).toBeLessThanOrEqual(1);
  });

  it('re-adding an already-present condition is idempotent under concurrency (#747)', async () => {
    dataDir = makeTempDataDir();
    const { orm, encountersService } = build();
    const { encounterId, combatantId } = seedCombatant(orm, ['poisoned']);

    // Two callers both re-add 'poisoned' (a retry). The set union is idempotent:
    // no duplicate, and the persisted array stays exactly ['poisoned'].
    const results = await Promise.all([
      encountersService.updateCombatant(encounterId, combatantId, { addConditions: ['poisoned'] }, dmUser, 'dm'),
      encountersService.updateCombatant(encounterId, combatantId, { addConditions: ['poisoned'] }, dmUser, 'dm'),
    ]);

    for (const r of results) {
      expect(r.conditions).toEqual(['poisoned']);
    }
    expect(readConditions(orm, combatantId)).toEqual(['poisoned']);
  });

  it('returns the committed condition revision from each concurrent caller (#747)', async () => {
    dataDir = makeTempDataDir();
    const { orm, encountersService } = build();
    const { encounterId, combatantId } = seedCombatant(orm, []);

    // Each caller's returned Combatant is the row RETURNING from its own UPDATE
    // inside the serialized transaction — i.e. the committed revision at the
    // moment that caller's tx ran, not a stale pre-await snapshot. After both
    // commit, a fresh read must agree with the union of the two returned sets.
    const [a, b] = await Promise.all([
      encountersService.updateCombatant(encounterId, combatantId, { addConditions: ['stunned'] }, dmUser, 'dm'),
      encountersService.updateCombatant(encounterId, combatantId, { addConditions: ['dazed'] }, dmUser, 'dm'),
    ]);

    const unionOfRevisions = new Set([...a.conditions, ...b.conditions]);
    const persisted = new Set(readConditions(orm, combatantId));
    // Every condition present in a returned revision is present in the row, and
    // the row holds exactly the union (no phantom condition fabricated by a
    // stale snapshot, no real condition dropped).
    for (const c of unionOfRevisions) expect(persisted.has(c)).toBe(true);
    expect(persisted).toEqual(new Set(['stunned', 'dazed']));
  });

  it('a burst of N concurrent distinct adds all land — no lost updates (#747)', async () => {
    dataDir = makeTempDataDir();
    const { orm, encountersService } = build();
    const { encounterId, combatantId } = seedCombatant(orm, []);

    // 20 callers each add a distinct condition simultaneously. A stale
    // whole-array write would keep only the last writer's single condition; the
    // fresh-rebased delta path composes all 20.
    const N = 20;
    const labels = Array.from({ length: N }, (_, i) => `cond-${i}`);
    await Promise.all(
      labels.map((label) =>
        encountersService.updateCombatant(encounterId, combatantId, { addConditions: [label] }, dmUser, 'dm'),
      ),
    );

    const persisted = readConditions(orm, combatantId).slice().sort();
    expect(persisted).toEqual(labels.slice().sort());
  });

  it('a DM and an AI-DM driver adding different conditions concurrently both land (#747)', async () => {
    dataDir = makeTempDataDir();
    const { orm, encountersService } = build();
    const { encounterId, combatantId } = seedCombatant(orm, []);

    // Two authorized writers with different provenance (a human DM and the AI
    // DM driver seat) each apply a condition to the same combatant. The role is
    // the same ('dm') for both — the authz gate is identical — so the race is
    // purely about the delta composing, not about permission.
    const aiDmUser: RequestUser = { id: 'ai-dm-seat:1', name: 'AI DM', serverRole: 'admin', devRole: 'dm' };
    await Promise.all([
      encountersService.updateCombatant(encounterId, combatantId, { addConditions: ['blinded'] }, dmUser, 'dm'),
      encountersService.updateCombatant(encounterId, combatantId, { addConditions: ['deafened'] }, aiDmUser, 'dm'),
    ]);

    const persisted = readConditions(orm, combatantId).slice().sort();
    expect(persisted).toEqual(['blinded', 'deafened']);
  });
});
