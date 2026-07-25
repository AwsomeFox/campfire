import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CoverageMapData, FileCoverageData } from 'istanbul-lib-coverage';
import libCoverage from 'istanbul-lib-coverage';

const SERVER_ROOT = path.resolve(__dirname, '..');
const MERGE_WORKER = path.join(__dirname, 'oidc-v8-merge-worker.cjs');
/** Absolute path to oidc.service.ts — used by coverage-threshold guard (#556). */
export const OIDC_SERVICE_SOURCE = path.join(SERVER_ROOT, 'src', 'modules', 'auth', 'oidc.service.ts');

/** Temp dir where spawned `node dist/main.js` children write NODE_V8_COVERAGE JSON. */
let coverageDir: string | undefined;
/** Child V8 blob basenames already merged into global.__coverage__. */
const mergedBlobBasenames = new Set<string>();

function jestCollectingCoverage(): boolean {
  // Jest workers do not receive `--coverage` in process.argv; npm lifecycle is reliable
  // for `npm run test:cov` (CI coverage job). Fall back to argv for direct invocations.
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
    coverageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campfire-oidc-v8cov-'));
  }
  return { NODE_V8_COVERAGE: coverageDir };
}

function coverageGlobal(): typeof global {
  // Match babel-plugin-istanbul's default coverageGlobalScope (`this` via
  // `new Function('return this')()`), which may differ from the jest vm's
  // `global` binding in ESM/transformed modules.
  return Function('return this')() as typeof global;
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

function applyMergedCoverage(incoming: CoverageMapData): void {
  const globalObject = coverageGlobal() as typeof global & {
    __coverage__?: CoverageMapData;
  };
  if (!globalObject.__coverage__) {
    globalObject.__coverage__ = {};
  }
  const coverageMap = libCoverage.createCoverageMap(globalObject.__coverage__);
  coverageMap.merge(incoming);
  for (const file of Object.keys(incoming)) {
    globalObject.__coverage__[file] = coverageMap
      .fileCoverageFor(file)
      .toJSON() as FileCoverageData;
  }
}

function mergeCoverageDirInSubprocess(dir: string): CoverageMapData {
  const stdout = execFileSync(process.execPath, [MERGE_WORKER, dir], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  return JSON.parse(stdout.toString() || '{}') as CoverageMapData;
}

function pendingBlobBasenames(): string[] {
  if (!coverageDir || !fs.existsSync(coverageDir)) return [];
  return fs
    .readdirSync(coverageDir)
    .filter((name) => name.endsWith('.json') && !mergedBlobBasenames.has(name));
}

/**
 * Merges any new child V8 blobs via a subprocess (keeps v8-to-istanbul off the
 * Jest worker heap) and applies the result to global.__coverage__ in-place.
 * Call after each spawned child exits so Jest sees the data before finalizing.
 */
export function mergePendingChildV8Coverage(): void {
  if (!coverageDir || !fs.existsSync(coverageDir)) return;
  const pending = pendingBlobBasenames();
  if (pending.length === 0) return;

  const incoming = selectOidcServiceCoverage(mergeCoverageDirInSubprocess(coverageDir));
  if (Object.keys(incoming).length > 0) {
    applyMergedCoverage(incoming);
  }
  for (const name of pending) {
    mergedBlobBasenames.add(name);
  }
}

/** Drains any remaining child blobs at suite end (safety net for the last child). */
export async function mergeChildV8Coverage(): Promise<void> {
  mergePendingChildV8Coverage();
}

/** Removes the temp coverage dir — call from suite afterAll. */
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
