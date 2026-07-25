import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ProcessCov } from '@bcoe/v8-coverage';
import libCoverage from 'istanbul-lib-coverage';
import v8toIstanbul from 'v8-to-istanbul';

const SERVER_ROOT = path.resolve(__dirname, '..');
const DIST_ROOT = path.join(SERVER_ROOT, 'dist');
/** Only merge OIDC-related server modules exercised by this suite (#556). */
const OIDC_DIST_PREFIXES = [
  path.join(DIST_ROOT, 'modules', 'auth', 'oidc'),
  path.join(DIST_ROOT, 'modules', 'auth', 'auth.'),
  path.join(DIST_ROOT, 'modules', 'settings'),
  path.join(DIST_ROOT, 'modules', 'users'),
  path.join(DIST_ROOT, 'modules', 'sessions'),
].map((p) => p.replace(/\\/g, '/'));

/** Temp dir where spawned `node dist/main.js` children write NODE_V8_COVERAGE JSON. */
let coverageDir: string | undefined;
/** Basenames already merged into `global.__coverage__` (each child exit writes one file). */
const mergedJsonBasenames = new Set<string>();

function jestCollectingCoverage(): boolean {
  // Jest workers do not receive `--coverage` in process.argv; npm lifecycle is reliable
  // for `npm run test:cov` (CI coverage job). Fall back to argv for direct invocations.
  return (
    process.env.npm_lifecycle_event === 'test:cov' ||
    process.argv.some((arg) => arg === '--coverage' || arg.startsWith('--coverage='))
  );
}

/** Env overlay for spawnApp — forwards NODE_V8_COVERAGE when jest runs with --coverage. */
export function childV8CoverageEnv(): Record<string, string | undefined> {
  if (!jestCollectingCoverage()) return {};
  if (!coverageDir) {
    coverageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-oidc-v8cov-'));
  }
  return { NODE_V8_COVERAGE: coverageDir };
}

function isOidcRelatedDistFile(scriptPath: string): boolean {
  const normalized = scriptPath.replace(/\\/g, '/');
  return OIDC_DIST_PREFIXES.some((prefix) => normalized.includes(prefix));
}

function scriptPathFromUrl(url: string): string | undefined {
  if (url.startsWith('file://')) {
    return path.normalize(fileURLToPath(url));
  }
  if (path.isAbsolute(url)) {
    return path.normalize(url);
  }
  return undefined;
}

/** Merge coverage from one pending child blob (if any). */
export async function mergeLatestChildV8Coverage(): Promise<void> {
  if (!coverageDir || !fs.existsSync(coverageDir)) return;

  const pending = fs
    .readdirSync(coverageDir)
    .filter((name) => name.endsWith('.json') && !mergedJsonBasenames.has(name));
  if (pending.length === 0) return;

  // Process one blob at a time to keep afterEach/afterAll hooks fast on CI.
  const name = pending[pending.length - 1];
  mergedJsonBasenames.add(name);
  const filePath = path.join(coverageDir, name);
  let processCov: ProcessCov | undefined;
  try {
    processCov = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ProcessCov;
  } catch {
    processCov = undefined;
  } finally {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* ignore */
    }
  }
  if (!processCov) return;

  const globalWithCoverage = globalThis as typeof globalThis & {
    __coverage__?: libCoverage.CoverageMapData;
  };
  if (!globalWithCoverage.__coverage__) {
    globalWithCoverage.__coverage__ = {};
  }

  for (const script of processCov.result) {
    const scriptPath = scriptPathFromUrl(script.url);
    if (!scriptPath?.startsWith(DIST_ROOT)) continue;
    if (!isOidcRelatedDistFile(scriptPath)) continue;
    if (!fs.existsSync(scriptPath)) continue;

    try {
      const converter = v8toIstanbul(scriptPath, 0, {
        source: fs.readFileSync(scriptPath, 'utf8'),
      });
      await converter.load();
      converter.applyCoverage(script.functions);
      const incoming = converter.toIstanbul();
      const coverageMap = libCoverage.createCoverageMap(globalWithCoverage.__coverage__);
      coverageMap.merge(incoming);
      // Update entries in-place — do not replace `__coverage__` or Jest loses its reference.
      for (const file of Object.keys(incoming)) {
        globalWithCoverage.__coverage__[file] = coverageMap.data[file];
      }
    } catch {
      // Skip dist files v8-to-istanbul cannot map (e.g. missing source maps).
    }
  }
}

/**
 * Drains any remaining child blobs at suite end (safety net for the last child).
 */
export async function mergeChildV8Coverage(): Promise<void> {
  if (!coverageDir || !fs.existsSync(coverageDir)) return;
  while (true) {
    const before = mergedJsonBasenames.size;
    await mergeLatestChildV8Coverage();
    if (mergedJsonBasenames.size === before) break;
  }
}

/** Removes the temp coverage dir — call from suite afterAll. */
export function cleanupChildV8CoverageDir(): void {
  if (coverageDir && fs.existsSync(coverageDir)) {
    fs.rmSync(coverageDir, { recursive: true, force: true });
  }
  coverageDir = undefined;
  mergedJsonBasenames.clear();
}

/** Absolute path to oidc.service.ts — used by coverage-threshold guard (#556). */
export const OIDC_SERVICE_SOURCE = path.join(SERVER_ROOT, 'src', 'modules', 'auth', 'oidc.service.ts');

/** file:// URL form jest/istanbul sometimes uses on Windows. */
export function oidcServiceSourceKeys(): string[] {
  return [OIDC_SERVICE_SOURCE, pathToFileURL(OIDC_SERVICE_SOURCE).href];
}
