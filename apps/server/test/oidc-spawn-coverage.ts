import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import type { CoverageMapData } from 'istanbul-lib-coverage';
import libCoverage from 'istanbul-lib-coverage';

const execFileAsync = promisify(execFile);

const SERVER_ROOT = path.resolve(__dirname, '..');
const MERGE_WORKER = path.join(__dirname, 'oidc-v8-merge-worker.cjs');

/** Temp dir where spawned `node dist/main.js` children write NODE_V8_COVERAGE JSON. */
let coverageDir: string | undefined;

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

function applyMergedCoverage(incoming: CoverageMapData): void {
  const globalWithCoverage = globalThis as typeof globalThis & {
    __coverage__?: CoverageMapData;
  };
  if (!globalWithCoverage.__coverage__) {
    globalWithCoverage.__coverage__ = {};
  }
  const coverageMap = libCoverage.createCoverageMap(globalWithCoverage.__coverage__);
  coverageMap.merge(incoming);
  for (const file of Object.keys(incoming)) {
    globalWithCoverage.__coverage__[file] = coverageMap.data[file];
  }
}

async function mergeCoverageDirInSubprocess(dir: string): Promise<CoverageMapData> {
  const { stdout } = await execFileAsync(process.execPath, [MERGE_WORKER, dir], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  return JSON.parse(stdout || '{}') as CoverageMapData;
}

/**
 * Merges all child V8 blobs via a subprocess (keeps v8-to-istanbul off the
 * Jest worker heap) then applies the result to global.__coverage__ in-place.
 */
export async function mergeChildV8Coverage(): Promise<void> {
  if (!coverageDir || !fs.existsSync(coverageDir)) return;
  const incoming = await mergeCoverageDirInSubprocess(coverageDir);
  if (Object.keys(incoming).length > 0) {
    applyMergedCoverage(incoming);
  }
}

/** Removes the temp coverage dir — call from suite afterAll. */
export function cleanupChildV8CoverageDir(): void {
  if (coverageDir && fs.existsSync(coverageDir)) {
    fs.rmSync(coverageDir, { recursive: true, force: true });
  }
  coverageDir = undefined;
}

/** Absolute path to oidc.service.ts — used by coverage-threshold guard (#556). */
export const OIDC_SERVICE_SOURCE = path.join(SERVER_ROOT, 'src', 'modules', 'auth', 'oidc.service.ts');

/** file:// URL form jest/istanbul sometimes uses on Windows. */
export function oidcServiceSourceKeys(): string[] {
  return [OIDC_SERVICE_SOURCE, pathToFileURL(OIDC_SERVICE_SOURCE).href];
}
