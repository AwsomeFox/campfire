import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SeedData } from '../global-setup';

// __dirname is provided by Playwright's CJS transform — avoid import.meta here.
const AUTH_DIR = resolve(__dirname, '..', '.auth');

/** Reads the ids written by global-setup.ts. */
export function seed(): SeedData {
  return JSON.parse(readFileSync(resolve(AUTH_DIR, 'seed.json'), 'utf8')) as SeedData;
}

/** Absolute path to a role's captured storageState. */
export function stateFor(role: 'admin' | 'dm' | 'player' | 'viewer'): string {
  return resolve(AUTH_DIR, `${role}.json`);
}
