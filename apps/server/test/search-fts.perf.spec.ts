import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { SearchService } from '../src/modules/search/search.service';
import { openDatabase } from '../src/db/db.module';

const user = { id: 'dm-1', name: 'DM', serverRole: 'user' as const };

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

describe('campaign search FTS performance (issue #533)', () => {
  it('keeps p95 below 50ms on a 5000-entity campaign fixture', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-search-fts-'));
    const opened = openDatabase(dataDir);
    try {
      expect(opened.campaignSearchFtsAvailable).toBe(true);

      const ts = new Date('2035-01-01T00:00:00.000Z').toISOString();
      const campaignRow = opened.sqlite
        .prepare('INSERT INTO campaigns (name, created_at, updated_at) VALUES (?, ?, ?) RETURNING id')
        .get('Search FTS perf', ts, ts) as { id: number };
      const campaignId = campaignRow.id;
      const insertNpc = opened.sqlite.prepare(`
        INSERT INTO npcs (campaign_id, name, body, hidden, created_at, updated_at)
        VALUES (?, ?, ?, 0, ?, ?)
      `);
      const seed = opened.sqlite.transaction(() => {
        for (let i = 0; i < 5000; i += 1) {
          insertNpc.run(
            campaignId,
            `Benchmark NPC ${i}`,
            `BenchmarkNeedle533 appears in this searchable body ${i}.`,
            ts,
            ts,
          );
        }
      });
      seed();

      const unused = {} as never;
      const service = new SearchService(
        opened.orm,
        true,
        unused,
        unused,
        unused,
        unused,
        unused,
        unused,
        unused,
        unused,
        unused,
        unused,
        unused,
        unused,
        unused,
      );

      await service.search(campaignId, user, 'dm', 'BenchmarkNeedle533', 50);
      const samples: number[] = [];
      for (let i = 0; i < 25; i += 1) {
        const start = performance.now();
        const res = await service.search(campaignId, user, 'dm', 'BenchmarkNeedle533', 50);
        samples.push(performance.now() - start);
        expect(res.results).toHaveLength(50);
      }
      expect(p95(samples)).toBeLessThan(50);
    } finally {
      opened.sqlite.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
