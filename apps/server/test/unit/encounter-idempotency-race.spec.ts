/**
 * Issue #1909 review (Devin + Copilot, same defect): `recordEncounterOp` throws
 * `EncounterOpRaceMarker` — a plain `Error`, never an `HttpException` — when a concurrent
 * writer using the SAME (actorId, operation, key) primary key already committed its claim
 * first. `updateCombatant`/`removeCombatant` catch this and replay the winner's response via
 * `readEncounterOpAfterRace`; `EncountersService.adjustCombatantResource` (issue #1909) was
 * missing that catch on both of its `recordEncounterOp` call sites, so the marker escaped as
 * an unhandled 500 instead of the intended replay.
 *
 * A genuine two-writer race is not reproducible on a SINGLE connection: better-sqlite3
 * executes each `db.transaction()` callback fully synchronously on the one Node event loop, so
 * there is no point at which a second, truly concurrent transaction on the SAME connection can
 * interleave between one transaction's own SELECT and INSERT. This spec instead drives the
 * SHARED primitive directly and deterministically on one connection: a first commit, followed
 * by a second `recordEncounterOp` call for the identical claim standing in for the "loser" of a
 * real race, proving both (a) the marker is actually thrown on a colliding insert and (b)
 * `readEncounterOpAfterRace` actually returns the winner's stored response — exactly the two
 * facts `adjustCombatantResource`'s catch blocks rely on.
 *
 * For a race driven through the full SERVICE methods (`updateCombatant`,
 * `adjustCombatantResource`, `rollCombatantInitiative`, `rollDeathSave`) via two REAL,
 * independent `better-sqlite3` connections against one database file — the harness issue #2032
 * added once this narrower primitive-level proof turned out not to be enough to catch three
 * real defects in the surviving-JS-state-after-rollback behavior — see
 * `test/integration/encounter-op-race.spec.ts`.
 */
import { openDatabase } from '../../src/db/db.module';
import { campaigns, encounters } from '../../src/db/schema';
import {
  EncounterOpRaceMarker,
  encounterOpFingerprint,
  readEncounterOpAfterRace,
  recordEncounterOp,
  type EncounterOpClaim,
} from '../../src/modules/encounters/encounter-idempotency';
import { makeTempDataDir } from '../integration/fixtures';
import fs from 'node:fs';

describe('encounter-idempotency: race-marker replay (issue #1909 review)', () => {
  let dataDir: string;
  let db: any;
  let realEncounterId: number;
  let realCampaignId: number;

  beforeEach(() => {
    dataDir = makeTempDataDir();
    db = openDatabase(dataDir).orm;
    // `encounter_op_idempotency` FK-references real campaign/encounter rows.
    const ts = new Date().toISOString();
    const [camp] = db.insert(campaigns).values({ name: 'Race Test', createdAt: ts, updatedAt: ts }).returning().all();
    realCampaignId = camp.id;
    const [enc] = db
      .insert(encounters)
      .values({ campaignId: camp.id, name: 'Race Fight', status: 'running', createdAt: ts, updatedAt: ts })
      .returning()
      .all();
    realEncounterId = enc.id;
  });

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('a colliding recordEncounterOp throws EncounterOpRaceMarker, and readEncounterOpAfterRace replays the WINNER\'s response, not the loser\'s', async () => {
    const claim: EncounterOpClaim = {
      actorId: '1',
      operation: 'combatant.resource_adjust',
      key: 'race-key-1',
      encounterId: realEncounterId,
      campaignId: realCampaignId,
      fingerprint: encounterOpFingerprint({ combatantId: 1, key: 'kiPoints', delta: 1 }),
    };

    // The WINNER commits first, storing its own response body.
    recordEncounterOp(db, claim, new Date().toISOString(), { body: { id: 1, used: 1 }, role: 'dm' });

    // The LOSER: a second writer using the IDENTICAL (actorId, operation, key) primary key
    // — standing in for a genuinely concurrent second transaction whose own effect already
    // ran (and would double-apply the spend) before it discovers it lost the race here.
    expect(() =>
      recordEncounterOp(db, claim, new Date().toISOString(), { body: { id: 1, used: 2 }, role: 'dm' }),
    ).toThrow(EncounterOpRaceMarker);

    // The loser recovers by replaying the WINNER's committed response — never its own,
    // never a raw 500.
    const prior = await readEncounterOpAfterRace(db, claim);
    expect(prior.response).toEqual({ id: 1, used: 1 });
    expect(prior.responseRole).toBe('dm');
  });

  it('EncounterOpRaceMarker carries the losing claim so the caller can look itself up after the rollback', () => {
    const claim: EncounterOpClaim = {
      actorId: '2',
      operation: 'combatant.resource_adjust',
      key: 'race-key-2',
      encounterId: 5,
      campaignId: 5,
      fingerprint: encounterOpFingerprint({ combatantId: 5, spellLevel: 2, delta: -1 }),
    };
    const marker = new EncounterOpRaceMarker(claim);
    expect(marker.claim).toBe(claim);
    expect(marker).toBeInstanceOf(Error);
  });
});

// Issue #1909 review: structural proof that BOTH of adjustCombatantResource's
// `recordEncounterOp` call sites are actually wrapped in the catch above, not just that the
// shared primitive behaves correctly in isolation. A source-grep, matching the established
// "source-grep confirming X actually calls Y" convention this codebase already uses
// (spell-slot-concurrency.spec.ts, resourceTrackerLogic tests) for behavior that a live
// integration test cannot exercise directly.
describe('adjustCombatantResource wires the race-marker catch on both branches (issue #1909 review)', () => {
  it('both this.db.transaction(...) calls inside adjustCombatantResource are wrapped in a try/catch that recovers via readEncounterOpAfterRace', () => {
    const src = fs.readFileSync(
      require.resolve('../../src/modules/encounters/encounters.service.ts'),
      'utf8',
    );
    const method = src.slice(src.indexOf('async adjustCombatantResource('), src.indexOf('\n  async listTokenFormations('));
    expect(method).not.toBe('');

    const tryBlocks = method.match(/try \{\s*\n\s*this\.db\.transaction\(\(tx\) => \{/g) ?? [];
    expect(tryBlocks.length).toBe(2);

    const catches = method.match(/if \(opClaim && err instanceof EncounterOpRaceMarker\) \{\s*\n\s*const prior = await readEncounterOpAfterRace\(this\.db, err\.claim\);/g) ?? [];
    expect(catches.length).toBe(2);
  });
});
