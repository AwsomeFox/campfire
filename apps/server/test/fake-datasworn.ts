import express from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';

/**
 * Minimal fake datasworn source server for tests (issue #405), run in-process on an ephemeral
 * port. Serves a small SAMPLE of the REAL Ironsworn: Starforged datasworn document
 * (test/fixtures/datasworn-starforged-sample.json — extracted verbatim from the canonical
 * rsek/datasworn file), so the importer's fetch → validate → recursive-map path is exercised
 * against genuine datasworn shapes rather than invented ones. The fixture keeps the whole-
 * document structure (top-level license/authors, one collection per section, and an oracle
 * collection that nests a sub-collection so recursive flattening is covered).
 *
 * Extra endpoints exercise the importer's validation guards:
 *   - /starforged.json  → the real sample document (happy path)
 *   - /not-json         → a body that isn't JSON (parse-failure guard)
 *   - /wrong-shape.json → valid JSON with none of the expected sections (shape guard)
 *   - /non-open.json    → the sample with a non-open top-level license (license guard)
 *   - /missing.json     → 404 (HTTP-error guard)
 */

const SAMPLE_PATH = join(__dirname, 'fixtures', 'datasworn-starforged-sample.json');

export interface FakeDatasworn {
  baseUrl: string;
  /** Full URL of the real sample document (pass as the importer's `url`). */
  documentUrl: string;
  server: Server;
  close(): Promise<void>;
}

export async function startFakeDatasworn(): Promise<FakeDatasworn> {
  const sampleText = readFileSync(SAMPLE_PATH, 'utf8');
  const sample = JSON.parse(sampleText) as Record<string, unknown>;

  const app = express();
  app.get('/starforged.json', (_req, res) => res.type('application/json').send(sampleText));
  app.get('/not-json', (_req, res) => res.type('application/json').send('this is not json {'));
  app.get('/wrong-shape.json', (_req, res) => res.json({ hello: 'world', foo: [1, 2, 3] }));
  app.get('/non-open.json', (_req, res) => res.json({ ...sample, license: 'All Rights Reserved' }));
  // (no /missing.json handler → 404)

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind fake datasworn server');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    documentUrl: `${baseUrl}/starforged.json`,
    server,
    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
