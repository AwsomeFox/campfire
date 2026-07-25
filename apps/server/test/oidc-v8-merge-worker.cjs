'use strict';

/**
 * Forked helper for oidc-spawn-coverage.ts — runs v8-to-istanbul in a child
 * process so the Jest worker stays under workerIdleMemoryLimit during OIDC e2e.
 *
 * Usage: node oidc-v8-merge-worker.cjs <coverageDir>
 * Writes merged istanbul CoverageMapData JSON to stdout.
 */
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const libCoverage = require('istanbul-lib-coverage');
const v8toIstanbul = require('v8-to-istanbul');

const coverageDir = process.argv[2];
const SERVER_ROOT = path.resolve(__dirname, '..');
const DIST_ROOT = path.join(SERVER_ROOT, 'dist');
const OIDC_DIST_PREFIXES = [
  path.join(DIST_ROOT, 'modules', 'auth', 'oidc'),
  path.join(DIST_ROOT, 'modules', 'auth', 'auth.'),
  path.join(DIST_ROOT, 'modules', 'settings'),
  path.join(DIST_ROOT, 'modules', 'users'),
  path.join(DIST_ROOT, 'modules', 'sessions'),
].map((p) => p.replace(/\\/g, '/'));

function isOidcRelatedDistFile(scriptPath) {
  const normalized = scriptPath.replace(/\\/g, '/');
  return OIDC_DIST_PREFIXES.some((prefix) => normalized.includes(prefix));
}

function scriptPathFromUrl(url) {
  if (url.startsWith('file://')) {
    return path.normalize(fileURLToPath(url));
  }
  if (path.isAbsolute(url)) {
    return path.normalize(url);
  }
  return undefined;
}

function distToSourcePath(scriptPath) {
  const rel = path.relative(DIST_ROOT, scriptPath);
  if (!rel.endsWith('.js')) return undefined;
  return path.join(SERVER_ROOT, 'src', rel.replace(/\.js$/, '.ts'));
}

async function mergeDir(dir) {
  const coverageMap = libCoverage.createCoverageMap({});
  if (!dir || !fs.existsSync(dir)) {
    return coverageMap.data;
  }

  const blobs = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  for (const name of blobs) {
    const filePath = path.join(dir, name);
    let processCov;
    try {
      processCov = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }

    for (const script of processCov.result) {
      const scriptPath = scriptPathFromUrl(script.url);
      if (!scriptPath?.startsWith(DIST_ROOT)) continue;
      if (!isOidcRelatedDistFile(scriptPath)) continue;
      if (!fs.existsSync(scriptPath)) continue;

      const sourcePath = distToSourcePath(scriptPath);
      if (!sourcePath || !fs.existsSync(sourcePath)) continue;

      try {
        const converter = v8toIstanbul(scriptPath, 0, {
          source: fs.readFileSync(scriptPath, 'utf8'),
        });
        await converter.load();
        converter.applyCoverage(script.functions);
        coverageMap.merge(converter.toIstanbul());
      } catch {
        // Skip dist files v8-to-istanbul cannot map (e.g. missing source maps).
      }
    }
  }

  return coverageMap.data;
}

mergeDir(coverageDir)
  .then((data) => {
    process.stdout.write(JSON.stringify(data));
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
