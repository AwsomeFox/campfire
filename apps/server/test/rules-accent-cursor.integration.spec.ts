import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db/db.module';
import { RulesService } from '../src/modules/rules/rules.service';
import { foldForSearch } from '../src/common/text-search';
import { decodeRuleSearchCursor, encodeRuleSearchCursor } from '../src/modules/rules/rules-search';

describe('Accented content search and compendium cursor pagination (#1493)', () => {
  let dataDir: string;
  let dbCtx: ReturnType<typeof openDatabase>;
  let rulesService: RulesService;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-accent-cursor-test-'));
    dbCtx = openDatabase(dataDir);
    const mockAudit = { log: jest.fn().mockResolvedValue(undefined) } as any;
    const mockAccess = {} as any;
    rulesService = new RulesService(dbCtx.orm, dbCtx.ftsAvailable, mockAudit, mockAccess);
  });

  afterEach(() => {
    dbCtx.sqlite.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('searches Zoë/Zoe and Résumé/Resume symmetrically in both FTS and fallback paths', async () => {
    const ts = new Date().toISOString();
    const pack = dbCtx.sqlite
      .prepare('INSERT INTO rule_packs (slug, name, installed_at) VALUES (?, ?, ?) RETURNING id')
      .get('test-pack', 'Test Pack', ts) as { id: number };

    dbCtx.sqlite
      .prepare(`
        INSERT INTO rule_entries (pack_id, slug, name, type, summary, body, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(pack.id, 'zoe-npc', 'Zoë', 'spell', 'An NPC named Zoë', '', ts, ts);

    dbCtx.sqlite
      .prepare(`
        INSERT INTO rule_entries (pack_id, slug, name, type, summary, body, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(pack.id, 'resume-entry', 'Résumé', 'rule', 'A character Résumé', '', ts, ts);

    // FTS Path (primary production path backed by unicode61 remove_diacritics FTS table)
    const zoeResultFts = await rulesService.search({ q: 'Zoe' });
    expect(zoeResultFts.items.some((i) => i.name === 'Zoë')).toBe(true);

    const zoeAccentResultFts = await rulesService.search({ q: 'Zoë' });
    expect(zoeAccentResultFts.items.some((i) => i.name === 'Zoë')).toBe(true);

    const resumeResultFts = await rulesService.search({ q: 'Resume' });
    expect(resumeResultFts.items.some((i) => i.name === 'Résumé')).toBe(true);

    const resumeAccentResultFts = await rulesService.search({ q: 'Résumé' });
    expect(resumeAccentResultFts.items.some((i) => i.name === 'Résumé')).toBe(true);

    // Fallback LIKE Path (forces ftsAvailable = false)
    const fallbackRulesService = new RulesService(dbCtx.orm, false, { log: jest.fn() } as any, {} as any);

    const zoeAccentResultLike = await fallbackRulesService.search({ q: 'Zoë' });
    expect(zoeAccentResultLike.items.some((i) => i.name === 'Zoë')).toBe(true);

    const zoeResultLike = await fallbackRulesService.search({ q: 'Zoe' });
    expect(zoeResultLike.items.some((i) => i.name === 'Zoë')).toBe(true);

    const resumeAccentResultLike = await fallbackRulesService.search({ q: 'Résumé' });
    expect(resumeAccentResultLike.items.some((i) => i.name === 'Résumé')).toBe(true);

    const resumeResultLike = await fallbackRulesService.search({ q: 'Resume' });
    expect(resumeResultLike.items.some((i) => i.name === 'Résumé')).toBe(true);

    // Exact-name rank bucket ranking assertion (issue #1493 review feedback)
    expect(zoeResultFts.items[0].name).toBe('Zoë');
    expect(zoeResultLike.items[0].name).toBe('Zoë');
  });

  it('paginates a pack containing Æther Elemental without skipping entries between Æ and æ', async () => {
    const ts = new Date().toISOString();
    const pack = dbCtx.sqlite
      .prepare('INSERT INTO rule_packs (slug, name, installed_at) VALUES (?, ?, ?) RETURNING id')
      .get('pack-aether', 'Aether Pack', ts) as { id: number };

    // Corpus including non-ASCII names sorting around Æ / æ
    const names = ['Alpha', 'Æther Elemental', 'Çentaur', 'Étoile', 'Þurs', 'Zebra'];
    for (let i = 0; i < names.length; i++) {
      dbCtx.sqlite
        .prepare(`
          INSERT INTO rule_entries (pack_id, slug, name, type, summary, body, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(pack.id, `entry-${i}`, names[i], 'monster', `Summary for ${names[i]}`, '', ts, ts);
    }

    const fetchedNames: string[] = [];
    let cursor: string | undefined = undefined;

    do {
      const page = await rulesService.search({ q: '', pack: 'pack-aether', cursor, limit: 2 });
      for (const item of page.items) {
        fetchedNames.push(item.name);
      }
      cursor = page.nextCursor;
    } while (cursor);

    // Every item in the database pack must be returned exactly once
    expect(fetchedNames.length).toBe(names.length);
    expect(new Set(fetchedNames).size).toBe(names.length);
    for (const name of names) {
      expect(fetchedNames).toContain(name);
    }
  });

  it('paginates FTS search without returning duplicate items across pages', async () => {
    const ts = new Date().toISOString();
    const pack = dbCtx.sqlite
      .prepare('INSERT INTO rule_packs (slug, name, installed_at) VALUES (?, ?, ?) RETURNING id')
      .get('pack-fts-dup', 'FTS Dup Pack', ts) as { id: number };

    const names = [
      'Poisoned Apple',
      'Poisoned Arrow',
      'Poisoned Dagger',
      'Poisoned Well',
      'Poisoned Sword',
    ];
    for (let i = 0; i < names.length; i++) {
      dbCtx.sqlite
        .prepare(`
          INSERT INTO rule_entries (pack_id, slug, name, type, summary, body, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(pack.id, `fts-${i}`, names[i], 'item', `A poisoned item ${names[i]}`, '', ts, ts);
    }

    const fetchedIds: number[] = [];
    let cursor: string | undefined = undefined;

    do {
      const page = await rulesService.search({ q: 'Poisoned', pack: 'pack-fts-dup', cursor, limit: 2 });
      for (const item of page.items) {
        fetchedIds.push(item.id);
      }
      cursor = page.nextCursor;
    } while (cursor);

    expect(fetchedIds.length).toBe(names.length);
    expect(new Set(fetchedIds).size).toBe(names.length);
  });

  it('verifies fold agreement for a corpus of accented and mixed-case names', () => {
    const corpus = ['Zoë', 'Zoe', 'Café', 'Cafe', 'Résumé', 'Resume', 'Straße', 'Strasse', 'İstanbul', 'Istanbul'];
    for (const name of corpus) {
      const folded = foldForSearch(name);
      expect(typeof folded).toBe('string');
      expect(folded).toEqual(folded.toLowerCase());
      // Diacritics are removed
      expect(folded.normalize('NFD')).not.toMatch(/\p{Diacritic}/u);
    }
  });

  it('round-trips non-ASCII names through cursor encode/decode unchanged', () => {
    const nonAscii = 'Æther Elemental — Çentaur';
    const encoded = encodeRuleSearchCursor({ v: 1, m: 'browse', n: nonAscii, i: 99 });
    const decoded = decodeRuleSearchCursor(encoded, 'browse');
    expect(decoded).toEqual({ v: 1, m: 'browse', n: nonAscii, i: 99 });
  });
});
