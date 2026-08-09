#!/usr/bin/env node
/**
 * Native-addon smoke check — proves the declared Node floor can actually RUN the
 * server's prebuilt native dependencies, not merely install and compile against
 * them.
 *
 * Why this exists as a separate check: `npm run build` is `tsc` plus a Vite
 * bundle, and `test:pwa:dist` inspects web output. None of that loads a native
 * binding, so the Node-version gate could pass on a runtime where the addons are
 * unloadable and only fail when the server boots.
 *
 * Why importing is not enough: better-sqlite3 13.x ships prebuilt Node-API
 * binaries and has NO install script, so a runtime below the Node-API level the
 * prebuild targets produces no install-time error at all. Observed on Node
 * 22.13.1 (Node-API 9) against better-sqlite3 13.0.3's Node-API 10 prebuild:
 * `require('better-sqlite3')` SUCCEEDS, and the process then dies with SIGSEGV —
 * exit 139, no exception, no message — on the first `new Database()`. So this
 * opens a database and runs real queries; a segfault fails the step by exit code.
 *
 * Resolution is done from apps/server so the modules load exactly as the server
 * loads them, rather than via whatever the repo root happens to hoist.
 */
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const failures = [];

console.log(
  `check-native-addons: node ${process.version} (Node-API ${process.versions.napi ?? 'unknown'})`,
);

// better-sqlite3 — open, write, read back, and confirm FTS5 is compiled in
// (campaign/rules search depends on it, and a prebuild without it would
// otherwise surface as a runtime 500 rather than a failed check).
try {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE smoke (value INTEGER NOT NULL)');
    db.prepare('INSERT INTO smoke (value) VALUES (?)').run(42);
    const row = db.prepare('SELECT value FROM smoke').get();
    if (row?.value !== 42) {
      failures.push(`better-sqlite3 returned ${JSON.stringify(row)}, expected { value: 42 }`);
    }
    db.exec('CREATE VIRTUAL TABLE smoke_fts USING fts5(body)');
    const version = db.prepare('SELECT sqlite_version() AS v').pluck().get();
    console.log(`check-native-addons: better-sqlite3 ok (sqlite ${version}, fts5 available)`);
  } finally {
    db.close();
  }
} catch (err) {
  failures.push(`better-sqlite3 failed to load or run: ${err?.message ?? err}`);
}

// sharp — the other ABI-sensitive native dependency the server loads at runtime
// (attachment derivatives and encounter fog-of-war map rendering). Encode a tiny
// image so libvips is actually exercised, not just the binding resolved.
try {
  const sharp = require('sharp');
  const png = await sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
  })
    .png()
    .toBuffer();
  if (!Buffer.isBuffer(png) || png.length === 0) {
    failures.push('sharp produced an empty buffer');
  } else {
    console.log(`check-native-addons: sharp ok (libvips ${sharp.versions?.vips ?? 'unknown'})`);
  }
} catch (err) {
  failures.push(`sharp failed to load or run: ${err?.message ?? err}`);
}

if (failures.length > 0) {
  console.error('check-native-addons: FAILED');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('check-native-addons: ok — native addons load and run on this Node');
