import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { ServerSettings, SettingsUpdate } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { settings } from '../../db/schema';

type SettingsUpdateInput = z.infer<typeof SettingsUpdate>;

const DEFAULTS: z.infer<typeof ServerSettings> = {
  allowLocalLogin: true,
  allowSignup: false,
  experimentalAiDm: false,
};

@Injectable()
export class SettingsService {
  constructor(@Inject(DB) private readonly db: DrizzleDb) {}

  async getAll(): Promise<z.infer<typeof ServerSettings>> {
    const rows = await this.db.select().from(settings);
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const merged: Record<string, unknown> = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      const raw = map.get(key);
      if (raw !== undefined) {
        try {
          merged[key] = JSON.parse(raw);
        } catch {
          // ignore malformed stored value, keep default
        }
      }
    }
    return ServerSettings.parse(merged);
  }

  async getAllowLocalLogin(): Promise<boolean> {
    const all = await this.getAll();
    return all.allowLocalLogin;
  }

  async getAllowSignup(): Promise<boolean> {
    const all = await this.getAll();
    return all.allowSignup;
  }

  /**
   * Reads a JSON-encoded value stored under an arbitrary settings key. Returns
   * null when absent or unparseable. Used for structured config blobs (e.g. the
   * OIDC config) that live outside the flat ServerSettings shape.
   */
  async getJson<T>(key: string): Promise<T | null> {
    const rows = await this.db.select().from(settings).where(eq(settings.key, key)).limit(1);
    if (rows.length === 0) return null;
    try {
      return JSON.parse(rows[0].value) as T;
    } catch {
      return null;
    }
  }

  /** Upserts a JSON-encoded value under an arbitrary settings key. */
  async setJson(key: string, value: unknown): Promise<void> {
    const json = JSON.stringify(value);
    const existing = await this.db.select().from(settings).where(eq(settings.key, key)).limit(1);
    if (existing.length > 0) {
      await this.db.update(settings).set({ value: json }).where(eq(settings.key, key));
    } else {
      await this.db.insert(settings).values({ key, value: json });
    }
  }

  async update(input: SettingsUpdateInput): Promise<z.infer<typeof ServerSettings>> {
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      const json = JSON.stringify(value);
      const existing = await this.db.select().from(settings).where(eq(settings.key, key)).limit(1);
      if (existing.length > 0) {
        await this.db.update(settings).set({ value: json }).where(eq(settings.key, key));
      } else {
        await this.db.insert(settings).values({ key, value: json });
      }
    }
    return this.getAll();
  }
}
