import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { ApiTokenCreate } from '@campfire/schema';
import type { ApiToken, ApiTokenCreated } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { apiTokens, users } from '../../db/schema';
import { nowIso } from '../../common/time';
import { generateApiToken, hashApiToken, apiTokenPrefix } from '../../common/crypto';
import type { RequestUser, TokenContext } from '../../common/user.types';

type ApiTokenCreateInput = z.infer<typeof ApiTokenCreate>;

/** Throttle lastUsedAt writes to at most once per hour per token. */
const LAST_USED_THROTTLE_MS = 60 * 60 * 1000;

function toDomain(row: typeof apiTokens.$inferSelect): ApiToken {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    scope: row.scope as ApiToken['scope'],
    campaignId: row.campaignId,
    tokenPrefix: row.tokenPrefix,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface ResolvedToken {
  user: RequestUser;
  tokenContext: TokenContext;
}

@Injectable()
export class TokensService {
  constructor(@Inject(DB) private readonly db: DrizzleDb) {}

  async listOwn(userId: number): Promise<ApiToken[]> {
    const rows = await this.db.select().from(apiTokens).where(eq(apiTokens.userId, userId));
    return rows.map(toDomain);
  }

  async create(userId: number, input: ApiTokenCreateInput): Promise<ApiTokenCreated> {
    const raw = generateApiToken();
    const ts = nowIso();
    const [row] = await this.db
      .insert(apiTokens)
      .values({
        userId,
        name: input.name,
        scope: input.scope,
        campaignId: input.campaignId ?? null,
        tokenHash: hashApiToken(raw),
        tokenPrefix: apiTokenPrefix(raw),
        lastUsedAt: null,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();
    return { token: raw, apiToken: toDomain(row) };
  }

  async remove(userId: number, id: number): Promise<void> {
    const [row] = await this.db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId)))
      .limit(1);
    if (!row) throw new NotFoundException(`Token ${id} not found`);
    await this.db.delete(apiTokens).where(eq(apiTokens.id, id));
  }

  /**
   * Called from SessionAuthGuard. Looks up a raw Bearer token by its sha256
   * hash; if found (and the owning user is not disabled), returns a
   * RequestUser resolved from the OWNING user plus a TokenContext capturing
   * the token's scope cap. Updates lastUsedAt, throttled to 1/hour.
   */
  async resolveByRawToken(rawToken: string): Promise<ResolvedToken | null> {
    const tokenHash = hashApiToken(rawToken);
    const [row] = await this.db.select().from(apiTokens).where(eq(apiTokens.tokenHash, tokenHash)).limit(1);
    if (!row) return null;

    const [owner] = await this.db.select().from(users).where(eq(users.id, row.userId)).limit(1);
    if (!owner || owner.disabled) return null;

    const now = Date.now();
    const lastUsed = row.lastUsedAt ? new Date(row.lastUsedAt).getTime() : 0;
    if (now - lastUsed > LAST_USED_THROTTLE_MS) {
      await this.db.update(apiTokens).set({ lastUsedAt: new Date(now).toISOString() }).where(eq(apiTokens.id, row.id));
    }

    const user: RequestUser = {
      id: String(owner.id),
      name: owner.displayName || owner.username,
      serverRole: owner.serverRole as RequestUser['serverRole'],
    };
    const tokenContext: TokenContext = {
      tokenId: row.id,
      name: row.name,
      scope: row.scope as TokenContext['scope'],
      campaignId: row.campaignId,
    };
    return { user, tokenContext };
  }

  /** Convenience guard for controllers: 403 if `id` doesn't belong to `userId`. */
  async assertOwner(userId: number, id: number): Promise<void> {
    const [row] = await this.db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId)))
      .limit(1);
    if (!row) throw new ForbiddenException('Not your token');
  }
}
