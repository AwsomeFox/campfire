import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CoverageMapData, FileCoverageData } from 'istanbul-lib-coverage';
import libCoverage from 'istanbul-lib-coverage';

const SERVER_ROOT = path.resolve(__dirname, '..');
const MERGE_WORKER = path.join(__dirname, 'oidc-v8-merge-worker.cjs');
/** Post-jest merge target — see test/finalize-oidc-spawn-coverage.cjs (#556). */
const SPAWN_COVERAGE_SNAPSHOT = path.join(SERVER_ROOT, 'coverage', 'oidc-spawn-cov-snapshot.json');

/** Absolute path to oidc.service.ts — used by coverage-threshold guard (#556). */
export const OIDC_SERVICE_SOURCE = path.join(SERVER_ROOT, 'src', 'modules', 'auth', 'oidc.service.ts');

/** Temp dir where spawned `node dist/main.js` children write NODE_V8_COVERAGE JSON. */
let coverageDir: string | undefined;
/** Child V8 blob basenames already merged into the spawn snapshot. */
const mergedBlobBasenames = new Set<string>();

function jestCollectingCoverage(): boolean {
  return (
    process.env.npm_lifecycle_event === 'test:cov' ||
    process.argv.some((arg) => arg === '--coverage' || arg.startsWith('--coverage='))
  );
}

/** Whether OIDC spawn coverage forwarding is active for this jest run. */
export function oidcSpawnCoverageEnabled(): boolean {
  return jestCollectingCoverage();
}

/** Env overlay for spawnApp — forwards NODE_V8_COVERAGE when jest runs with --coverage. */
export function childV8CoverageEnv(): Record<string, string | undefined> {
  if (!jestCollectingCoverage()) return {};
  if (!coverageDir) {
    if (fs.existsSync(SPAWN_COVERAGE_SNAPSHOT)) {
      fs.rmSync(SPAWN_COVERAGE_SNAPSHOT, { force: true });
    }
    coverageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-oidc-v8cov-'));
  }
  return { NODE_V8_COVERAGE: coverageDir };
}

function isOidcServiceCoverageKey(file: string): boolean {
  return file === OIDC_SERVICE_SOURCE || file.endsWith(`${path.sep}oidc.service.ts`);
}

/** v8-to-istanbul adds an `all` field that can confuse istanbul source-map remapping. */
function sanitizeSpawnCoverageEntry(entry: FileCoverageData): FileCoverageData {
  const { all: _all, ...rest } = entry as FileCoverageData & { all?: unknown };
  return rest;
}

function selectOidcServiceCoverage(incoming: CoverageMapData): CoverageMapData {
  const selected: CoverageMapData = {};
  for (const [file, entry] of Object.entries(incoming)) {
    if (isOidcServiceCoverageKey(file)) {
      selected[file] = sanitizeSpawnCoverageEntry(entry);
    }
  }
  return selected;
}

function mergeCoverageDirInSubprocess(dir: string): CoverageMapData {
  const stdout = execFileSync(process.execPath, [MERGE_WORKER, dir], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  return JSON.parse(stdout.toString() || '{}') as CoverageMapData;
}

function writeSpawnSnapshot(incoming: CoverageMapData): void {
  let snapshot = libCoverage.createCoverageMap({});
  if (fs.existsSync(SPAWN_COVERAGE_SNAPSHOT)) {
    snapshot = libCoverage.createCoverageMap(
      JSON.parse(fs.readFileSync(SPAWN_COVERAGE_SNAPSHOT, 'utf8')) as CoverageMapData,
    );
  }
  snapshot.merge(incoming);
  fs.writeFileSync(SPAWN_COVERAGE_SNAPSHOT, JSON.stringify(snapshot.toJSON()));
}

function pendingBlobBasenames(): string[] {
  if (!coverageDir || !fs.existsSync(coverageDir)) return [];
  return fs
    .readdirSync(coverageDir)
    .filter((name) => name.endsWith('.json') && !mergedBlobBasenames.has(name));
}

/**
 * Merges new child V8 blobs into the on-disk spawn snapshot. Applied post-jest
 * (finalize-oidc-spawn-coverage.cjs) so v8 maps do not break report generation.
 */
export function mergePendingChildV8Coverage(): void {
  if (!coverageDir || !fs.existsSync(coverageDir)) return;
  const pending = pendingBlobBasenames();
  if (pending.length === 0) return;

  const incoming = selectOidcServiceCoverage(mergeCoverageDirInSubprocess(coverageDir));
  if (Object.keys(incoming).length > 0) {
    writeSpawnSnapshot(incoming);
  }
  for (const name of pending) {
    mergedBlobBasenames.add(name);
  }
}

/** Drains any remaining child blobs at suite end (safety net for the last child). */
export async function mergeChildV8Coverage(): Promise<void> {
  mergePendingChildV8Coverage();
}

/** Removes the temp V8 blob dir — call from suite afterAll. */
export function cleanupChildV8CoverageDir(): void {
  if (coverageDir && fs.existsSync(coverageDir)) {
    fs.rmSync(coverageDir, { recursive: true, force: true });
  }
  coverageDir = undefined;
  mergedBlobBasenames.clear();
}

/** file:// URL form jest/istanbul sometimes uses on Windows. */
export function oidcServiceSourceKeys(): string[] {
  return [OIDC_SERVICE_SOURCE, pathToFileURL(OIDC_SERVICE_SOURCE).href];
}
