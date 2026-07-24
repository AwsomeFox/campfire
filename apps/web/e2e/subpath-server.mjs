/**
 * Issue #798 — boots the FULL subpath topology for the Playwright suite:
 *
 *   browser -> subpath-proxy (:8132, strips /campfire)
 *           -> Campfire API+SPA (:8131, built with PUBLIC_BASE=/campfire)
 *
 * This launcher does THREE things the root e2e/server.mjs does not:
 *
 *   1. Builds the SPA with PUBLIC_BASE=/campfire into a SEPARATE dist directory
 *      (apps/web/dist-subpath) via vite's --outDir, so it does NOT clobber the
 *      root build the rest of the suite depends on. Skipped if the directory
 *      already exists and CAMPFIRE_SUBPATH_REBUILD is unset — set it to force.
 *   2. Points the backend's WEB_DIST at that prefixed dist, so the SPA it
 *      serves has /campfire-prefixed asset URLs.
 *   3. Spawns subpath-proxy.mjs in front of the backend, which strips /campfire
 *      before forwarding — the documented production contract.
 *
 * The Playwright config points baseURL at the PROXY port (:8132), so every
 * browser navigation automatically goes through the strip-prefix hop.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repoWebRoot = resolve(here, '..'); // apps/web
const serverEntry = resolve(repoWebRoot, '../server/dist/main.js');
const subpathDist = resolve(repoWebRoot, 'dist-subpath');

// Build the prefixed SPA into a DEDICATED outDir so the root E2E build at
// apps/web/dist is untouched. The build stamps PUBLIC_BASE=/campfire into every
// asset URL, the manifest scope/start_url, the SW deny patterns, and the
// in-app API client/router prefix. Pass --emptyOutDir so a stale prior build
// does not leak root-prefixed files into the subpath dist.
if (!existsSync(subpathDist) || process.env.CAMPFIRE_SUBPATH_REBUILD) {
  const build = spawn(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'build', '--', '--outDir', 'dist-subpath', '--emptyOutDir'],
    { cwd: repoWebRoot, stdio: 'inherit', env: { ...process.env, PUBLIC_BASE: '/campfire', VITE_PWA_DEV_SW: '1' } },
  );
  await new Promise((res, rej) => {
    build.on('close', (code) => (code === 0 ? res() : rej(new Error(`subpath web build exited ${code}`))));
  });
}

const dataDir = mkdtempSync(resolve(tmpdir(), 'campfire-subpath-e2e-'));
const backendPort = process.env.CAMPFIRE_SUBPATH_BACKEND_PORT || '8131';
const proxyPort = process.env.CAMPFIRE_SUBPATH_PROXY_PORT || '8132';

const backend = spawn(process.execPath, [serverEntry], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'development',
    DATA_DIR: dataDir,
    WEB_DIST: subpathDist,
    PORT: backendPort,
    // The browser hits the proxy over plain http on localhost.
    ALLOW_INSECURE_HTTP: '1',
    THROTTLE_DISABLED: '1',
    DEV_AUTH: '',
    // The server reads PUBLIC_BASE at runtime to prefix its OIDC redirects and
    // scope the OIDC flow cookie — it must match what the web build was stamped
    // with, even though the server's own routing never sees the prefix.
    PUBLIC_BASE: '/campfire',
  },
});

// Start the strip-prefix proxy in front of the backend.
const proxy = spawn(process.execPath, [resolve(here, 'subpath-proxy.mjs')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    CAMPFIRE_SUBPATH_BACKEND_PORT: backendPort,
    CAMPFIRE_SUBPATH_PROXY_PORT: proxyPort,
  },
});

const shutdown = () => {
  if (!backend.killed) backend.kill('SIGTERM');
  if (!proxy.killed) proxy.kill('SIGTERM');
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('exit', shutdown);

const exitOn = (child) =>
  child.on('exit', (code) => {
    shutdown();
    process.exit(code ?? 0);
  });
exitOn(backend);
exitOn(proxy);
