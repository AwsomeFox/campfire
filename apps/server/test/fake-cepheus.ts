import express from 'express';
import type { Server } from 'node:http';

/**
 * Minimal fake Cepheus Engine SRD mdBook server for tests, run in-process on an ephemeral
 * port. It serves raw Markdown for any `src/`-relative `*.md` path the importer requests
 * (see src/modules/rules/cepheus-importer.ts CEPHEUS_CHAPTERS), so a full offline install
 * works without hitting GitHub — the Cepheus analogue of test/fake-open5e.ts.
 *
 * Two shapes are served on purpose:
 *   - Most chapters return a small-but-real-shaped Markdown doc: an `# H1` title, a lead
 *     paragraph, and a couple of `##` sub-sections — enough to exercise normalize + summary.
 *   - `book1/equipment.md` returns a deliberately OVERSIZED doc (> the importer's body cap)
 *     built from many `##` headings, so the importer's split-at-headings path is exercised
 *     (an oversized chapter becomes several `section` entries, none over the cap).
 *   - `tools/*.md` (interactive generators) carry `<script>`/`<div>` scaffolding, proving the
 *     importer never fetches them (they are excluded from the manifest) — served only so an
 *     accidental fetch would be visibly wrong, and to exercise nothing.
 */

/** A small, real-shaped chapter body derived from the requested path. */
function smallChapter(path: string): string {
  const title = path.replace(/\.md$/, '').replace(/.*\//, '').replace(/-/g, ' ');
  return [
    `# ${title.replace(/\b\w/g, (c) => c.toUpperCase())}`,
    '',
    `This chapter covers the ${title} rules of the Cepheus Engine, resolved with the 2D6 core task system.`,
    '',
    '## Overview',
    '',
    'Roll 2D6, add the relevant characteristic DM and any skill levels; a total of 8+ succeeds.',
    '',
    '## Details',
    '',
    '- A first bullet of open game content.',
    '- A second bullet of open game content.',
    '',
    '| Column | Value |',
    '| --- | --- |',
    '| Example | 8+ |',
  ].join('\n');
}

/** An oversized chapter (> 48,000 chars) with many `##` headings, to exercise heading-split. */
function oversizedEquipment(): string {
  const lines: string[] = ['# Equipment', '', 'Equipment available to characters, grouped by category.', ''];
  // ~20 sections, each padded well past a few KB so the whole doc exceeds the 48,000-char cap
  // while each individual `##` section stays comfortably under it.
  const categories = [
    'Armor',
    'Weapons',
    'Computers',
    'Drugs',
    'Explosives',
    'Personal Devices',
    'Robots and Drones',
    'Sensory Aids',
    'Shelters',
    'Survival Equipment',
    'Tools',
    'Vehicles',
    'Communicators',
    'Currency',
  ];
  const filler = 'This paragraph describes a piece of open-game-content equipment in enough detail to occupy space. ';
  for (const cat of categories) {
    lines.push(`## ${cat}`, '');
    // ~3.5 KB per section → 14 sections ≈ 49 KB total, safely over the 48 KB cap.
    lines.push(filler.repeat(45));
    lines.push('');
  }
  return lines.join('\n');
}

const TOOL_HTML = `# Cepheus Engine Subsector Generator

This tool will generate a subsector.

<div><input type="radio" id="x" /></div>
<script src="pseudohex.js"></script>
<script>window.generate();</script>`;

export interface FakeCepheus {
  baseUrl: string;
  server: Server;
  /** Count of chapter fetches served (for asserting the importer fetched every manifest path). */
  requestCount(): number;
  close(): Promise<void>;
}

export async function startFakeCepheus(): Promise<FakeCepheus> {
  const app = express();
  let requests = 0;

  app.get(/.*\.md$/, (req, res) => {
    requests += 1;
    // req.path is like "/book1/equipment.md"; strip the leading slash.
    const rel = req.path.replace(/^\//, '');
    if (rel.startsWith('tools/')) {
      res.type('text/markdown').send(TOOL_HTML);
      return;
    }
    if (rel === 'book1/equipment.md') {
      res.type('text/markdown').send(oversizedEquipment());
      return;
    }
    res.type('text/markdown').send(smallChapter(rel));
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind fake Cepheus server');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    server,
    requestCount: () => requests,
    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
