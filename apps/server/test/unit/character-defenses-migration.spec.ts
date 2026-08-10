import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/db.module';

/**
 * Issue #2156 — `characters.resistances`/`vulnerabilities`/`immunities` reach an EXISTING
 * database.
 *
 * The trap this pins (same shape as #2144's `weapon-proficiencies-migration.spec.ts`):
 * `runMigrations` skips any step whose name is already recorded in `__migrations`. Adding
 * these columns inside `migrateCharactersTableForSheetDepth` — the obvious home, since it is
 * the same shape on the same table — would have shipped them to fresh installs only. Every
 * database that had ever booted has `0010_characters_sheet_depth` recorded, so the step would
 * never re-run, and the drizzle schema would go on selecting columns the table did not have.
 * They need their own entry, and this proves they have one.
 */
describe('character defenses migration (#2156)', () => {
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

  it('a fresh database gets the columns from the bootstrap DDL', () => {
    const { sqlite, dbPath } = openDatabase(dir) as unknown as { sqlite: Database.Database; dbPath: string };
    sqlite.close();
    const columns = characterColumns(dbPath ?? join(dir, 'campfire.db'));
    expect(columns).toContain('resistances');
    expect(columns).toContain('vulnerabilities');
    expect(columns).toContain('immunities');
  });

  it('an OLD database that predates the columns gets them on the next boot', () => {
    // Boot once to get a real, fully-migrated database, then take the columns away and mark
    // every migration as applied — exactly the state an installation upgrading from an
    // earlier release is in.
    const first = openDatabase(dir);
    first.sqlite.close();
    const path = join(dir, 'campfire.db');

    const raw = new Database(path);
    // SQLite cannot DROP a column on older versions, so rebuild the table without them.
    const cols = (raw.prepare('PRAGMA table_info(characters)').all() as Array<{ name: string }>)
      .map((c) => c.name)
      .filter((c) => !['resistances', 'vulnerabilities', 'immunities'].includes(c));
    raw.exec('PRAGMA foreign_keys=OFF');
    raw.exec(`CREATE TABLE characters_old AS SELECT ${cols.join(', ')} FROM characters`);
    raw.exec('DROP TABLE characters');
    raw.exec('ALTER TABLE characters_old RENAME TO characters');
    // …and forget only THIS step, leaving `0010_characters_sheet_depth` recorded. That
    // pairing is the whole point: an upgrading installation is in exactly this state, and it
    // is why the columns cannot ride along inside 0010.
    raw.prepare('DELETE FROM __migrations WHERE name = ?').run('0190_characters_defenses_2156');
    const applied = (raw.prepare('SELECT name FROM __migrations').all() as Array<{ name: string }>).map((r) => r.name);
    expect(applied).toContain('0010_characters_sheet_depth');
    raw.close();
    const before = characterColumns(path);
    expect(before).not.toContain('resistances');
    expect(before).not.toContain('vulnerabilities');
    expect(before).not.toContain('immunities');

    const second = openDatabase(dir);
    second.sqlite.close();
    const after = characterColumns(path);
    expect(after).toContain('resistances');
    expect(after).toContain('vulnerabilities');
    expect(after).toContain('immunities');
  });

  it('defaults an existing row to an empty array rather than NULL', () => {
    // fromJsonText would cope with NULL, but the columns are NOT NULL in the bootstrap DDL —
    // an ADD COLUMN without the same default would make the two shapes disagree.
    const { sqlite } = openDatabase(dir);
    const columns = sqlite.prepare('PRAGMA table_info(characters)').all() as Array<{ name: string; dflt_value: string | null; notnull: number }>;
    sqlite.close();
    for (const name of ['resistances', 'vulnerabilities', 'immunities']) {
      const col = columns.find((c) => c.name === name);
      expect(col?.notnull).toBe(1);
      expect(col?.dflt_value).toContain('[]');
    }
  });
});
