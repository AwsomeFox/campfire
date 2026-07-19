import { Global, Module } from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { BOOTSTRAP_SQL } from './bootstrap.sql';
import * as schema from './schema';

export const DB = Symbol('DB');
export type DrizzleDb = BetterSQLite3Database<typeof schema>;

export function createDb(): DrizzleDb {
  const dataDir = process.env.DATA_DIR ?? path.resolve(__dirname, '..', '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'campfire.db');

  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(BOOTSTRAP_SQL);

  return drizzle(sqlite, { schema });
}

@Global()
@Module({
  providers: [{ provide: DB, useFactory: createDb }],
  exports: [DB],
})
export class DbModule {}
