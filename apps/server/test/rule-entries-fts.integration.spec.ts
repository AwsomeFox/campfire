import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db/db.module';

describe('rule entries FTS startup repair', () => {
  it('rebuilds an incomplete legacy external-content index even after a new row is indexed', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-rule-entries-fts-'));
    const ts = new Date('2035-01-01T00:00:00.000Z').toISOString();
    const first = openDatabase(dataDir);
    try {
      expect(first.ftsAvailable).toBe(true);
      const pack = first.sqlite
        .prepare('INSERT INTO rule_packs (slug, name, installed_at) VALUES (?, ?, ?) RETURNING id')
        .get('legacy-fts-pack', 'Legacy FTS pack', ts) as { id: number };
      const entry = first.sqlite
        .prepare(`
          INSERT INTO rule_entries (pack_id, slug, name, type, summary, body, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
        `)
        .get(pack.id, 'legacy-needle', 'Legacy Needle', 'spell', 'LegacyNeedle1507', '', ts, ts) as { id: number };

      // Model the historical upgrade state: content rows exist but the external FTS index is empty.
      first.sqlite.prepare(`
        INSERT INTO rule_entries_fts(rule_entries_fts, rowid, name, summary, body)
        VALUES ('delete', ?, ?, ?, ?)
      `).run(entry.id, 'Legacy Needle', 'LegacyNeedle1507', '');
      expect(first.sqlite.prepare('SELECT rowid FROM rule_entries_fts WHERE rule_entries_fts MATCH ?').all('LegacyNeedle1507')).toEqual([]);

      // A subsequent write is indexed by the trigger. The index is therefore non-empty but
      // still incomplete, the state produced when a legacy compendium gains one new entry.
      first.sqlite.prepare(`
        INSERT INTO rule_entries (pack_id, slug, name, type, summary, body, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(pack.id, 'newly-indexed', 'Newly Indexed', 'spell', 'NewlyIndexed1507', '', ts, ts);
      expect(first.sqlite.prepare('SELECT rowid FROM rule_entries_fts WHERE rule_entries_fts MATCH ?').all('NewlyIndexed1507')).toHaveLength(1);
      // A database created before the repair has no one-time upgrade marker.
      first.sqlite.prepare("DELETE FROM __db_meta WHERE key = 'rule_entries_fts_repair_v1'").run();
    } finally {
      first.sqlite.close();
    }

    const reopened = openDatabase(dataDir);
    try {
      expect(reopened.ftsAvailable).toBe(true);
      expect(reopened.sqlite.prepare('SELECT rowid FROM rule_entries_fts WHERE rule_entries_fts MATCH ?').all('LegacyNeedle1507')).toHaveLength(1);
      expect(reopened.sqlite.prepare('SELECT rowid FROM rule_entries_fts WHERE rule_entries_fts MATCH ?').all('NewlyIndexed1507')).toHaveLength(1);
      expect(reopened.sqlite.prepare("SELECT value FROM __db_meta WHERE key = 'rule_entries_fts_repair_v1'").get()).toEqual({ value: 'complete' });
    } finally {
      reopened.sqlite.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
