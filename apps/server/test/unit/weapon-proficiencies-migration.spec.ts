import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/db.module';

/**
 * Issue #2144 — `characters.weapon_proficiencies` reaches an EXISTING database.
 *
 * The trap this pins: `runMigrations` skips any step whose name is already recorded in
 * `__migrations`. Adding the column inside `migrateCharactersTableForSheetDepth` — the
 * obvious home, since it is the same shape on the same table — would have shipped it to
 * fresh installs only. Every database that had ever booted has `0010_characters_sheet_depth`
 * recorded, so the step would never re-run, and the drizzle schema would go on selecting a
 * column the table did not have. It needs its own entry, and this proves it has one.
 */
describe('weapon_proficiencies migration (#2144)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'campfire-migration-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function characterColumns(path: string): string[] {
    const raw = new Database(path);
    try {
      return (raw.prepare('PRAGMA table_info(characters)').all() as Array<{ name: string }>).map((c) => c.name);
    } finally {
      raw.close();
    }
  }

  it('a fresh database gets the column from the bootstrap DDL', () => {
    const { sqlite, dbPath } = openDatabase(dir) as unknown as { sqlite: Database.Database; dbPath: string };
    sqlite.close();
    expect(characterColumns(dbPath ?? join(dir, 'campfire.db'))).toContain('weapon_proficiencies');
  });

  it('an OLD database that predates the column gets it on the next boot', () => {
    // Boot once to get a real, fully-migrated database, then take the column away and mark
    // every migration as applied — exactly the state an installation upgrading from an
    // earlier release is in.
    const first = openDatabase(dir);
    first.sqlite.close();
    const path = join(dir, 'campfire.db');

    const raw = new Database(path);
    // SQLite cannot DROP a column on older versions, so rebuild the table without it.
    const cols = (raw.prepare('PRAGMA table_info(characters)').all() as Array<{ name: string }>)
      .map((c) => c.name)
      .filter((c) => c !== 'weapon_proficiencies');
    raw.exec('PRAGMA foreign_keys=OFF');
    raw.exec(`CREATE TABLE characters_old AS SELECT ${cols.join(', ')} FROM characters`);
    raw.exec('DROP TABLE characters');
    raw.exec('ALTER TABLE characters_old RENAME TO characters');
    // …and forget only THIS step, leaving `0010_characters_sheet_depth` recorded. That pairing
    // is the whole point: an upgrading installation is in exactly this state, and it is why
    // the column cannot ride along inside 0010.
    raw.prepare('DELETE FROM __migrations WHERE name = ?').run('0185_characters_weapon_proficiencies_2144');
    const applied = (raw.prepare('SELECT name FROM __migrations').all() as Array<{ name: string }>).map((r) => r.name);
    expect(applied).toContain('0010_characters_sheet_depth');
    raw.close();
    expect(characterColumns(path)).not.toContain('weapon_proficiencies');

    const second = openDatabase(dir);
    second.sqlite.close();
    expect(characterColumns(path)).toContain('weapon_proficiencies');
  });

  it('defaults an existing row to an empty record rather than NULL', () => {
    // `fromJsonText` would cope with NULL, but the column is NOT NULL in the bootstrap DDL —
    // an ADD COLUMN without the same default would make the two shapes disagree.
    const { sqlite } = openDatabase(dir);
    const col = (sqlite.prepare('PRAGMA table_info(characters)').all() as Array<{ name: string; dflt_value: string | null; notnull: number }>)
      .find((c) => c.name === 'weapon_proficiencies');
    sqlite.close();
    expect(col?.notnull).toBe(1);
    expect(col?.dflt_value).toContain('{}');
  });
});
