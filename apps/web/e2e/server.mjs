/**
 * Boots the built Campfire API server for the Playwright suite, configured to
 * ALSO serve the built web SPA from the same origin (WEB_DIST) — exactly the
 * single-image production topology, minus TLS.
 *
 * Why a launcher instead of pointing `webServer.command` straight at
 * `node ../server/dist/main.js`:
 *  - a fresh, isolated temp DATA_DIR per run, so every run starts from an empty
 *    DB and first-run /auth/setup succeeds deterministically (global-setup seeds
 *    it). The dir is created here and its path exported so nothing leaks into the
 *    repo `data/` dir.
 *  - ALLOW_INSECURE_HTTP=1: over plain http://127.0.0.1 the default helmet CSP
 *    `upgrade-insecure-requests` would rewrite every asset/`/api` request to
 *    https:// (where nothing listens) and the session cookie would be `Secure`
 *    (silently dropped over http). This flag drops both, matching the documented
 *    no-TLS homelab escape hatch.
 *  - DEV_AUTH is deliberately NOT set: the suite exercises REAL cookie sessions
 *    with REAL campaign memberships (dm/player/viewer), which the dev-header
 *    bypass can't model (dev users have no memberships, so client role gating —
 *    driven by `roleIn()` — wouldn't reflect the role under test).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repoWebRoot = resolve(here, '..'); // apps/web
const serverEntry = resolve(repoWebRoot, '../server/dist/main.js');
const webDist = resolve(repoWebRoot, 'dist');

const dataDir = mkdtempSync(resolve(tmpdir(), 'campfire-e2e-'));
const port = process.env.CAMPFIRE_E2E_PORT || '8123';

const child = spawn(process.execPath, [serverEntry], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'development',
    DATA_DIR: dataDir,
    WEB_DIST: webDist,
    PORT: port,
    ALLOW_INSECURE_HTTP: '1',
    // Keep the strict auth throttler out of the way — the seed step fires several
    // rapid login/setup calls that aren't testing rate limiting.
    THROTTLE_DISABLED: '1',
    // No dev-auth bypass: real sessions only (see header note).
    DEV_AUTH: '',
  },
});

const shutdown = () => {
  if (!child.killed) child.kill('SIGTERM');
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('exit', shutdown);

child.on('exit', (code) => process.exit(code ?? 0));
