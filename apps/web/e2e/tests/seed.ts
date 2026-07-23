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

/** 16:9 aspect ratio PNG buffer matching the battle map surface aspect ratio. */
export const PNG_16_9 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAYAAAACvn2aAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAARElEQVQoU2NgGAWjYBSMAgAAAQQAAAGn1v8AAAAASUVORUSCYII=',
  'base64',
);
