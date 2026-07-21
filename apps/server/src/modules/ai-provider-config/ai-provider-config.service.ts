import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { AiProviderConfigView, type AiProviderConfigUpdate } from '@campfire/schema';
import { DB, type DrizzleDb, resolveDataDir } from '../../db/db.module';
import { aiProviderConfigs } from '../../db/schema';
import { encryptSecret, decryptSecret, secretLast4 } from '../../common/crypto';
import { nowIso } from '../../common/time';
import { auditActor, type RequestUser } from '../../common/user.types';
import { AuditService } from '../audit/audit.service';
import {
  createAiProvider,
  type AiProviderConfig,
  type AiProviderType,
} from '../ai-dm/providers';

type ConfigUpdateInput = z.infer<typeof AiProviderConfigUpdate>;
type ConfigView = z.infer<typeof AiProviderConfigView>;
type Scope = 'server' | 'campaign';
type Row = typeof aiProviderConfigs.$inferSelect;

/**
 * The KDF salt for deriving a 32-byte key from an `AI_CONFIG_KEY` passphrase. A
 * fixed application salt is fine here: the env var IS the secret, and we only ever
 * derive ONE key from it (a per-value random salt would need to be stored, which is
 * exactly what the keyfile fallback below does instead). A 64-hex `AI_CONFIG_KEY`
 * is used verbatim as raw key material and skips the KDF.
 */
const AI_CONFIG_KEY_SALT = 'campfire:ai-provider-config:v1';
/** Persisted keyfile used when `AI_CONFIG_KEY` is not set (auto-generated once). */
const AI_CONFIG_KEYFILE = 'ai-config.key';

/**
 * Resolve the 32-byte AES-256-GCM key that protects stored provider API keys.
 *
 * Precedence:
 *  1. `AI_CONFIG_KEY` env var — a 64-char hex string is used as raw key material;
 *     anything else is treated as a passphrase and stretched with scrypt. This is
 *     the operator-controlled, portable secret (document it; back it up — losing it
 *     makes stored keys unrecoverable, which is by design).
 *  2. A persisted random keyfile under DATA_DIR (`ai-config.key`), generated once
 *     with 0600 perms. This keeps encryption working out-of-the-box for a plain
 *     self-host that never sets the env var, while still never hardcoding a key.
 */
function resolveAiConfigKey(logger: Logger): Buffer {
  const env = process.env.AI_CONFIG_KEY?.trim();
  if (env) {
    if (/^[0-9a-fA-F]{64}$/.test(env)) return Buffer.from(env, 'hex');
    return scryptSync(env, AI_CONFIG_KEY_SALT, 32);
  }

  const keyfile = path.join(resolveDataDir(), AI_CONFIG_KEYFILE);
  try {
    const existing = fs.readFileSync(keyfile, 'utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(existing)) return Buffer.from(existing, 'hex');
  } catch {
    // not present yet — fall through and generate.
  }
  const key = randomBytes(32);
  fs.mkdirSync(path.dirname(keyfile), { recursive: true });
  fs.writeFileSync(keyfile, key.toString('hex'), { mode: 0o600 });
  logger.warn(
    `AI_CONFIG_KEY is not set — generated a persisted encryption key at ${keyfile} (0600). ` +
      'Set AI_CONFIG_KEY (64-hex or a passphrase) to control this secret yourself; back up whichever you use, ' +
      'as losing it makes stored provider API keys unrecoverable.',
  );
  return key;
}

/**
 * Encrypted AI-provider config storage (issue #310) — the credential/config layer
 * that feeds #309's provider factory. Owns two scopes:
 *   - `server`   : one admin-managed default row.
 *   - `campaign` : an optional per-campaign override that FALLS BACK to the server
 *                  default (including falling back to the server's API key when the
 *                  campaign supplies its own provider/model but no key of its own).
 *
 * The API key is encrypted at rest (aes-256-gcm) and is WRITE-ONLY: it is accepted
 * on write, stored only as ciphertext + a `keyLast4` indicator, and is NEVER returned
 * by a read, written to the audit log, or logged. `resolveEffectiveConfig` is the sole
 * path that decrypts it — in-process, at call time — for `createAiProvider`.
 */
@Injectable()
export class AiProviderConfigService {
  private readonly logger = new Logger(AiProviderConfigService.name);
  private cachedKey: Buffer | null = null;

  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
  ) {}

  private get key(): Buffer {
    if (!this.cachedKey) this.cachedKey = resolveAiConfigKey(this.logger);
    return this.cachedKey;
  }

  // ── row access ─────────────────────────────────────────────────────────────

  private async serverRow(): Promise<Row | undefined> {
    const [row] = await this.db
      .select()
      .from(aiProviderConfigs)
      .where(eq(aiProviderConfigs.scope, 'server'))
      .limit(1);
    return row;
  }

  private async campaignRow(campaignId: number): Promise<Row | undefined> {
    const [row] = await this.db
      .select()
      .from(aiProviderConfigs)
      .where(and(eq(aiProviderConfigs.scope, 'campaign'), eq(aiProviderConfigs.campaignId, campaignId)))
      .limit(1);
    return row;
  }

  // ── redacted view (NEVER carries the key) ────────────────────────────────────

  private toView(row: Row): ConfigView {
    return AiProviderConfigView.parse({
      scope: row.scope as Scope,
      campaignId: row.campaignId ?? null,
      providerType: row.providerType as AiProviderType,
      model: row.model,
      baseUrl: row.baseUrl ?? null,
      params: safeJson(row.params, {}),
      configured: !!row.encryptedApiKey,
      keyLast4: row.keyLast4 ?? null,
      allowedModels: safeJson<string[]>(row.allowedModels, []),
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  async getServerView(): Promise<ConfigView | null> {
    const row = await this.serverRow();
    return row ? this.toView(row) : null;
  }

  async getCampaignView(campaignId: number): Promise<ConfigView | null> {
    const row = await this.campaignRow(campaignId);
    return row ? this.toView(row) : null;
  }

  // ── writes ───────────────────────────────────────────────────────────────────

  /** Upsert the server-default config (admin-gated at the controller). */
  async putServer(input: ConfigUpdateInput, user: RequestUser): Promise<ConfigView> {
    const existing = await this.serverRow();
    await this.upsert('server', null, existing, input, user);
    const row = await this.serverRow();
    return this.toView(row!);
  }

  /**
   * Upsert a per-campaign override (DM-gated at the controller). Enforces the
   * server admin's model allowlist: if the server default lists `allowedModels`
   * and the requested `model` is not among them, the write is rejected.
   */
  async putCampaign(campaignId: number, input: ConfigUpdateInput, user: RequestUser): Promise<ConfigView> {
    const server = await this.serverRow();
    const allow = server ? safeJson<string[]>(server.allowedModels, []) : [];
    if (allow.length > 0 && !allow.includes(input.model)) {
      throw new BadRequestException(
        `Model '${input.model}' is not in the server admin's allowlist (${allow.join(', ')}).`,
      );
    }
    const existing = await this.campaignRow(campaignId);
    await this.upsert('campaign', campaignId, existing, input, user, campaignId);
    const row = await this.campaignRow(campaignId);
    return this.toView(row!);
  }

  private async upsert(
    scope: Scope,
    campaignId: number | null,
    existing: Row | undefined,
    input: ConfigUpdateInput,
    user: RequestUser,
    auditCampaignId?: number,
  ): Promise<void> {
    const ts = nowIso();

    // apiKey semantics: omitted => keep the stored key; '' => clear it; value => set/rotate.
    let encryptedApiKey = existing?.encryptedApiKey ?? null;
    let keyLast4 = existing?.keyLast4 ?? null;
    let keyAction: 'unchanged' | 'set' | 'rotated' | 'cleared' = 'unchanged';
    if (input.apiKey !== undefined) {
      if (input.apiKey === '') {
        encryptedApiKey = null;
        keyLast4 = null;
        keyAction = 'cleared';
      } else {
        encryptedApiKey = encryptSecret(input.apiKey, this.key);
        keyLast4 = secretLast4(input.apiKey);
        keyAction = existing?.encryptedApiKey ? 'rotated' : 'set';
      }
    }

    // allowedModels is only meaningful at the server scope (the admin allowlist).
    const allowedModels =
      scope === 'server' && input.allowedModels !== undefined
        ? JSON.stringify(input.allowedModels)
        : (existing?.allowedModels ?? '[]');

    const values = {
      scope,
      campaignId,
      providerType: input.providerType,
      baseUrl: input.baseUrl?.trim() ? input.baseUrl.trim() : null,
      model: input.model,
      params: JSON.stringify(input.params ?? {}),
      encryptedApiKey,
      keyLast4,
      allowedModels,
      updatedAt: ts,
    };

    if (existing) {
      await this.db.update(aiProviderConfigs).set(values).where(eq(aiProviderConfigs.id, existing.id));
    } else {
      await this.db.insert(aiProviderConfigs).values({
        ...values,
        createdBy: auditActor(user),
        createdAt: ts,
      });
    }

    // Audit records WHAT changed and the key ACTION only — never the key or last4.
    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'dm',
      action: 'ai-provider.configure',
      entityType: 'ai-provider',
      campaignId: auditCampaignId ?? null,
      detail: `${scope} provider=${input.providerType} model=${input.model} key=${keyAction}`,
    });
  }

  async deleteServer(user: RequestUser): Promise<void> {
    await this.db.delete(aiProviderConfigs).where(eq(aiProviderConfigs.scope, 'server'));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'dm',
      action: 'ai-provider.delete',
      entityType: 'ai-provider',
      detail: 'server',
    });
  }

  async deleteCampaign(campaignId: number, user: RequestUser): Promise<void> {
    await this.db
      .delete(aiProviderConfigs)
      .where(and(eq(aiProviderConfigs.scope, 'campaign'), eq(aiProviderConfigs.campaignId, campaignId)));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'dm',
      action: 'ai-provider.delete',
      entityType: 'ai-provider',
      campaignId,
      detail: 'campaign',
    });
  }

  // ── effective config (decrypted, server-side only — feeds #309's factory) ────

  /**
   * Resolve the EFFECTIVE, DECRYPTED provider config for a campaign: the campaign
   * override when present, otherwise the server default. When a campaign override
   * exists but carries no key of its own, the server default's key is used (so a
   * group can pick their own model on the server's key). Returns `null` when neither
   * scope is configured. The returned object carries the plaintext `apiKey` and is
   * for IN-PROCESS use only (createAiProvider) — it must never be serialized to a
   * client. This is the sole decryption path (#312 consumes it).
   */
  async resolveEffectiveConfig(campaignId: number): Promise<AiProviderConfig | null> {
    const server = await this.serverRow();
    const camp = await this.campaignRow(campaignId);
    const primary = camp ?? server;
    if (!primary) return null;

    let apiKey: string | undefined;
    if (primary.encryptedApiKey) {
      apiKey = decryptSecret(primary.encryptedApiKey, this.key);
    } else if (camp && server?.encryptedApiKey) {
      // Campaign override without its own key — fall back to the server key.
      apiKey = decryptSecret(server.encryptedApiKey, this.key);
    }

    return {
      providerType: primary.providerType as AiProviderType,
      model: primary.model,
      apiKey,
      baseUrl: primary.baseUrl ?? undefined,
      params: safeJson(primary.params, {}),
    };
  }

  // ── test-connection (builds the real provider via #309's factory) ────────────

  /**
   * Live probe: resolve the effective config, build the provider through #309's
   * factory, and run a minimal generation. Returns a plain ok/error — never any
   * credential. Real providers make a network call here; the `mock` type does not.
   */
  async testConnection(campaignId: number | null): Promise<{ ok: boolean; providerType: AiProviderType; model: string; error: string | null }> {
    const config = campaignId === null ? await this.serverEffectiveConfig() : await this.resolveEffectiveConfig(campaignId);
    if (!config) {
      return { ok: false, providerType: 'mock', model: '', error: 'No provider is configured for this scope.' };
    }
    try {
      const provider = createAiProvider(config);
      const result = await provider.generate({
        model: config.model,
        maxTokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return { ok: true, providerType: config.providerType, model: result.model || config.model, error: null };
    } catch (err) {
      return {
        ok: false,
        providerType: config.providerType,
        model: config.model,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** The server-default effective config (server scope has no campaign fallback). */
  private async serverEffectiveConfig(): Promise<AiProviderConfig | null> {
    const server = await this.serverRow();
    if (!server) return null;
    return {
      providerType: server.providerType as AiProviderType,
      model: server.model,
      apiKey: server.encryptedApiKey ? decryptSecret(server.encryptedApiKey, this.key) : undefined,
      baseUrl: server.baseUrl ?? undefined,
      params: safeJson(server.params, {}),
    };
  }
}

/** Parse a stored JSON blob, falling back to `fallback` on absence/corruption. */
function safeJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
