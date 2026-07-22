import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import {
  AiProviderConfigView,
  AiProviderTestResult,
  type AiProviderConfigUpdate,
  type AiProviderCredentialSource,
  type AiProviderTestCredentialSource,
  type AiProviderTestRequest,
} from '@campfire/schema';
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
type TestInput = z.infer<typeof AiProviderTestRequest>;
type TestResult = z.infer<typeof AiProviderTestResult>;
type Scope = 'server' | 'campaign';
type Row = typeof aiProviderConfigs.$inferSelect;
type TestedTarget = TestResult['testedTarget'];

interface ResolvedTestCandidate {
  config: AiProviderConfig | null;
  testedTarget: TestedTarget;
  credentialSource: AiProviderTestCredentialSource;
}

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
 *                  default. When the campaign supplies no key of its own it may still
 *                  reuse the server's key — but ONLY together with the server's endpoint
 *                  and providerType, never with a campaign-controlled destination (see
 *                  the security invariant on `resolveEffectiveConfig`, issue #373).
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

  private toView(row: Row, credentialSource: AiProviderCredentialSource): ConfigView {
    return AiProviderConfigView.parse({
      scope: row.scope as Scope,
      campaignId: row.campaignId ?? null,
      providerType: row.providerType as AiProviderType,
      model: row.model,
      baseUrl: row.baseUrl ?? null,
      params: safeJson(row.params, {}),
      configured: !!row.encryptedApiKey,
      keyLast4: row.keyLast4 ?? null,
      credentialSource,
      ready: credentialSource !== 'none',
      allowedModels: safeJson<string[]>(row.allowedModels, []),
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  async getServerView(): Promise<ConfigView | null> {
    const row = await this.serverRow();
    return row ? this.toView(row, localCredentialSource(row)) : null;
  }

  async getCampaignView(campaignId: number): Promise<ConfigView | null> {
    const [row, server] = await Promise.all([this.campaignRow(campaignId), this.serverRow()]);
    return row ? this.toView(row, campaignCredentialSource(row, server)) : null;
  }

  /**
   * Non-secret "which provider is in effect" indicator for a campaign (issue #399).
   *
   * A campaign DM cannot read the admin-only server-default config, but the campaign
   * AI settings still need to show which provider is actually resolved and whether it
   * comes from the SERVER default or a CAMPAIGN override. This returns ONLY the type,
   * model, source scope, and non-secret credential readiness — NEVER key material
   * (`keyLast4`, ciphertext, and environment values are all absent). It mirrors the
   * `resolveEffectiveConfig` precedence (`campaign ?? server`) without decrypting.
   */
  async getEffectiveView(
    campaignId: number,
  ): Promise<{
    configured: boolean;
    providerType: AiProviderType | null;
    model: string | null;
    source: 'server' | 'campaign' | null;
    credentialSource: AiProviderCredentialSource;
    ready: boolean;
  }> {
    const server = await this.serverRow();
    const camp = await this.campaignRow(campaignId);
    const primary = camp ?? server;
    if (!primary) {
      return {
        configured: false,
        providerType: null,
        model: null,
        source: null,
        credentialSource: 'none',
        ready: false,
      };
    }
    const credentialSource = camp
      ? campaignCredentialSource(camp, server)
      : localCredentialSource(primary);
    // A keyless campaign override borrows provider type + endpoint from the
    // credential-owning server row (issue #373). Reflect that actual type here,
    // rather than claiming the override's type will receive the server credential.
    const effectiveProviderType =
      camp && (credentialSource === 'server' || credentialSource === 'environment') && server
        ? server.providerType
        : primary.providerType;
    return {
      configured: true,
      providerType: effectiveProviderType as AiProviderType,
      model: primary.model,
      source: camp ? 'campaign' : 'server',
      credentialSource,
      ready: credentialSource !== 'none',
    };
  }

  // ── writes ───────────────────────────────────────────────────────────────────

  /** Upsert the server-default config (admin-gated at the controller). */
  async putServer(input: ConfigUpdateInput, user: RequestUser): Promise<ConfigView> {
    const existing = await this.serverRow();
    await this.upsert('server', null, existing, input, user);
    const row = await this.serverRow();
    return this.toView(row!, localCredentialSource(row!));
  }

  /**
   * Upsert a per-campaign override (DM-gated at the controller). Enforces the
   * server admin's model allowlist: if the server default lists `allowedModels`
   * and the requested `model` is not among them, the write is rejected.
   */
  async putCampaign(campaignId: number, input: ConfigUpdateInput, user: RequestUser): Promise<ConfigView> {
    const server = await this.serverRow();
    this.assertCampaignModelAllowed(input.model, server);
    const existing = await this.campaignRow(campaignId);
    await this.upsert('campaign', campaignId, existing, input, user, campaignId);
    const row = await this.campaignRow(campaignId);
    const serverAfter = await this.serverRow();
    return this.toView(row!, campaignCredentialSource(row!, serverAfter));
  }

  private assertCampaignModelAllowed(model: string, server: Row | undefined): void {
    const allow = server ? safeJson<string[]>(server.allowedModels, []) : [];
    if (allow.length > 0 && !allow.includes(model)) {
      throw new BadRequestException(
        `Model '${model}' is not in the server admin's allowlist (${allow.join(', ')}).`,
      );
    }
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

  /** The server admin's model allowlist (issue #310/#315). [] when unset/unrestricted. */
  async getServerAllowedModels(): Promise<string[]> {
    const row = await this.serverRow();
    return row ? safeJson<string[]>(row.allowedModels, []) : [];
  }

  /**
   * Replace the server admin's model allowlist (issue #315 console editor) without
   * touching the provider/key/model fields. Requires an existing server-default row —
   * an allowlist is only meaningful once a provider is configured. Audits the change
   * (count only — model names are not secret but the audit stays terse). Returns the
   * redacted server view.
   */
  async setServerAllowedModels(models: string[], user: RequestUser): Promise<ConfigView> {
    const existing = await this.serverRow();
    if (!existing) {
      throw new BadRequestException(
        'Configure the server-default AI provider first (PUT /settings/ai-provider) before setting a model allowlist.',
      );
    }
    await this.db
      .update(aiProviderConfigs)
      .set({ allowedModels: JSON.stringify(models), updatedAt: nowIso() })
      .where(eq(aiProviderConfigs.id, existing.id));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'dm',
      action: 'ai-provider.allowlist',
      entityType: 'ai-provider',
      detail: `server allowlist=${models.length} model(s)`,
    });
    const row = await this.serverRow();
    return this.toView(row!, localCredentialSource(row!));
  }

  /**
   * Clear only the encrypted credential for a scope. This intentionally does not
   * reuse the full config PUT: a stale browser must not overwrite provider/model,
   * endpoint, sampling params, or the server allowlist while revoking a secret.
   * The audit records the action and scope only — never the key or its last four.
   */
  async clearServerKey(user: RequestUser): Promise<ConfigView> {
    const existing = await this.serverRow();
    if (!existing) throw new NotFoundException('No server-default AI provider is configured.');
    await this.clearStoredKey(existing, user);
    const row = (await this.serverRow())!;
    return this.toView(row, localCredentialSource(row));
  }

  async clearCampaignKey(campaignId: number, user: RequestUser): Promise<ConfigView> {
    const existing = await this.campaignRow(campaignId);
    if (!existing) throw new NotFoundException('No campaign AI provider override is configured.');
    await this.clearStoredKey(existing, user, campaignId);
    const [row, server] = await Promise.all([this.campaignRow(campaignId), this.serverRow()]);
    return this.toView(row!, campaignCredentialSource(row!, server));
  }

  private async clearStoredKey(row: Row, user: RequestUser, campaignId?: number): Promise<void> {
    await this.db
      .update(aiProviderConfigs)
      .set({ encryptedApiKey: null, keyLast4: null, updatedAt: nowIso() })
      .where(eq(aiProviderConfigs.id, row.id));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'dm',
      action: 'ai-provider.key-clear',
      entityType: 'ai-provider',
      campaignId: campaignId ?? null,
      detail: row.scope,
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
   * override when present, otherwise the server default. Returns `null` when neither
   * scope is configured. The returned object carries the plaintext `apiKey` and is
   * for IN-PROCESS use only (createAiProvider) — it must never be serialized to a
   * client. This is the sole decryption path (#312 consumes it).
   *
   * SECURITY INVARIANT (issue #373): the server default's key must NEVER be paired
   * with a campaign-controlled destination. The API key, `baseUrl`, and `providerType`
   * are resolved together as one coherent unit from the SAME scope — the scope that
   * OWNS the key also owns where that key is sent and how it is presented. A campaign
   * override that carries its own key controls its own endpoint; a campaign override
   * WITHOUT a key falls back to the server key AND the server's endpoint/providerType
   * (it may still pick its own `model`, which is constrained by the admin allowlist and
   * is not a credential destination). This closes the exfiltration where a DM could set
   * `baseUrl: 'https://attacker.example'` with no key and have the server's admin key
   * shipped there.
   */
  async resolveEffectiveConfig(campaignId: number): Promise<AiProviderConfig | null> {
    const server = await this.serverRow();
    const camp = await this.campaignRow(campaignId);
    const primary = camp ?? server;
    if (!primary) return null;

    // The scope that supplies the key also supplies the endpoint + providerType.
    // When the primary scope has its own key, key+endpoint+type are self-consistent.
    if (primary.encryptedApiKey) {
      return {
        providerType: primary.providerType as AiProviderType,
        model: primary.model,
        apiKey: decryptSecret(primary.encryptedApiKey, this.key),
        baseUrl: primary.baseUrl ?? undefined,
        params: safeJson(primary.params, {}),
      };
    }

    // Campaign override without its own key — fall back to the SERVER key, and with it
    // the SERVER endpoint + providerType (NEVER the campaign's). The campaign keeps its
    // own model choice (allowlist-constrained) and sampling params, neither of which is
    // a credential destination.
    if (camp && server?.encryptedApiKey) {
      return {
        providerType: server.providerType as AiProviderType,
        model: primary.model,
        apiKey: decryptSecret(server.encryptedApiKey, this.key),
        baseUrl: server.baseUrl ?? undefined,
        params: safeJson(primary.params, {}),
      };
    }

    // A keyless campaign override may also inherit the server default's matching
    // environment credential. As with a stored server key, providerType + baseUrl
    // stay bound to the admin-controlled server row; a DM-controlled endpoint never
    // receives an operator environment secret.
    const serverEnvironmentKey = server ? environmentApiKey(server.providerType) : undefined;
    if (camp && serverEnvironmentKey) {
      return {
        providerType: server!.providerType as AiProviderType,
        model: primary.model,
        apiKey: serverEnvironmentKey,
        baseUrl: server!.baseUrl ?? undefined,
        params: safeJson(primary.params, {}),
      };
    }

    // The server row itself falls back to the standard provider environment key
    // when its encrypted key has been deliberately cleared.
    if (!camp) {
      const environmentKey = environmentApiKey(primary.providerType);
      if (environmentKey) {
        return {
          providerType: primary.providerType as AiProviderType,
          model: primary.model,
          apiKey: environmentKey,
          baseUrl: primary.baseUrl ?? undefined,
          params: safeJson(primary.params, {}),
        };
      }
    }

    // No key resolvable in any scope (e.g. a keyless provider like `mock`, or an
    // override on a server default that itself has no key). Return the primary scope's
    // own endpoint/type — no server key is in play, so there is nothing to leak.
    return {
      providerType: primary.providerType as AiProviderType,
      model: primary.model,
      apiKey: undefined,
      baseUrl: primary.baseUrl ?? undefined,
      params: safeJson(primary.params, {}),
    };
  }

  // ── test-connection (builds the real provider via #309's factory) ────────────

  /**
   * Live, NON-PERSISTING probe (issue #852). Controllers always supply `input`, so
   * the visible draft is what gets tested. The optional branch is retained only for
   * the admin "test all" health readout, which intentionally probes stored configs.
   *
   * Blank candidate-key semantics mirror a save with a blank key:
   *  - server: reuse its stored key, else the matching environment credential;
   *  - campaign: reuse its stored key, else inherit the server credential together
   *    with the server-owned provider/baseUrl (the issue #373 SSRF invariant);
   *  - mock: no credential is required.
   */
  async testConnection(campaignId: number | null, input?: TestInput): Promise<TestResult> {
    const scope: Scope = campaignId === null ? 'server' : 'campaign';
    const resolved = input
      ? await this.resolveDraftTestCandidate(campaignId, input)
      : await this.resolveStoredTestCandidate(campaignId);
    const config = resolved.config;
    if (!config) {
      return AiProviderTestResult.parse({
        ok: false,
        scope,
        testedTarget: resolved.testedTarget,
        providerType: 'mock',
        model: '',
        baseUrl: null,
        credentialSource: 'none',
        testedAt: nowIso(),
        error: 'No provider is configured for this scope.',
      });
    }
    try {
      const provider = createAiProvider(config);
      await provider.generate({
        model: config.model,
        maxTokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return AiProviderTestResult.parse({
        ok: true,
        scope,
        testedTarget: resolved.testedTarget,
        providerType: config.providerType,
        model: config.model,
        baseUrl: config.baseUrl ?? null,
        credentialSource: resolved.credentialSource,
        testedAt: nowIso(),
        error: null,
      });
    } catch (err) {
      return AiProviderTestResult.parse({
        ok: false,
        scope,
        testedTarget: resolved.testedTarget,
        providerType: config.providerType,
        model: config.model,
        baseUrl: config.baseUrl ?? null,
        credentialSource: resolved.credentialSource,
        testedAt: nowIso(),
        error: redactCredential(err instanceof Error ? err.message : String(err), config.apiKey),
      });
    }
  }

  /** Resolve a submitted draft without writing it or auditing it. */
  private async resolveDraftTestCandidate(
    campaignId: number | null,
    input: TestInput,
  ): Promise<ResolvedTestCandidate> {
    const [server, campaign] = await Promise.all([
      this.serverRow(),
      campaignId === null ? Promise.resolve(undefined) : this.campaignRow(campaignId),
    ]);
    if (campaignId !== null) this.assertCampaignModelAllowed(input.model, server);

    const candidate: AiProviderConfig = {
      providerType: input.providerType,
      model: input.model,
      baseUrl: input.baseUrl?.trim() || undefined,
      params: {},
    };
    const candidateApiKey = input.apiKey?.trim();

    // Mock never consumes a credential, even if a stale/typed key exists.
    if (input.providerType === 'mock') {
      return {
        config: candidate,
        testedTarget: campaignId === null ? 'server-default' : 'campaign-override',
        credentialSource: 'not-required',
      };
    }

    // A non-empty candidate key is used only for this probe and never persisted.
    if (candidateApiKey) {
      return {
        config: { ...candidate, apiKey: candidateApiKey },
        testedTarget: campaignId === null ? 'server-default' : 'campaign-override',
        credentialSource: 'candidate',
      };
    }

    if (campaignId === null) {
      if (server?.encryptedApiKey) {
        return {
          config: { ...candidate, apiKey: decryptSecret(server.encryptedApiKey, this.key) },
          testedTarget: 'server-default',
          credentialSource: 'stored',
        };
      }
      const environmentKey = environmentApiKey(input.providerType);
      return {
        config: { ...candidate, apiKey: environmentKey },
        testedTarget: 'server-default',
        credentialSource: environmentKey ? 'environment' : 'none',
      };
    }

    // A blank campaign key first reuses that campaign row's stored credential. It
    // may therefore test the visible campaign provider/base URL exactly as a save
    // that keeps the key would.
    if (campaign?.encryptedApiKey) {
      return {
        config: { ...candidate, apiKey: decryptSecret(campaign.encryptedApiKey, this.key) },
        testedTarget: 'campaign-override',
        credentialSource: 'stored',
      };
    }

    // Otherwise a campaign may borrow an admin/operator credential only as one
    // coherent unit with the server-owned provider and endpoint. The visible model
    // remains the draft model; provider/baseUrl metadata reports what was truly hit.
    if (server?.encryptedApiKey) {
      return {
        config: {
          providerType: server.providerType as AiProviderType,
          model: input.model,
          apiKey: decryptSecret(server.encryptedApiKey, this.key),
          baseUrl: server.baseUrl ?? undefined,
          params: {},
        },
        testedTarget: 'inherited-server-default',
        credentialSource: 'server',
      };
    }
    const inheritedEnvironmentKey = server ? environmentApiKey(server.providerType) : undefined;
    if (server && inheritedEnvironmentKey) {
      return {
        config: {
          providerType: server.providerType as AiProviderType,
          model: input.model,
          apiKey: inheritedEnvironmentKey,
          baseUrl: server.baseUrl ?? undefined,
          params: {},
        },
        testedTarget: 'inherited-server-default',
        credentialSource: 'environment',
      };
    }

    return {
      config: candidate,
      testedTarget: 'campaign-override',
      credentialSource: 'none',
    };
  }

  /** Stored-config path used only by the existing admin provider-health action. */
  private async resolveStoredTestCandidate(campaignId: number | null): Promise<ResolvedTestCandidate> {
    if (campaignId === null) {
      const server = await this.serverRow();
      return {
        config: await this.serverEffectiveConfig(),
        testedTarget: 'server-default',
        credentialSource: server ? localCredentialSource(server) : 'none',
      };
    }

    const [campaign, server] = await Promise.all([this.campaignRow(campaignId), this.serverRow()]);
    const source = campaign
      ? campaignCredentialSource(campaign, server)
      : server
        ? inheritedServerCredentialSource(server)
        : 'none';
    const inherited = !campaign || source === 'server' || source === 'environment';
    return {
      config: await this.resolveEffectiveConfig(campaignId),
      testedTarget: inherited ? 'inherited-server-default' : 'campaign-override',
      credentialSource: source,
    };
  }

  /** The server-default effective config (server scope has no campaign fallback). */
  private async serverEffectiveConfig(): Promise<AiProviderConfig | null> {
    const server = await this.serverRow();
    if (!server) return null;
    return {
      providerType: server.providerType as AiProviderType,
      model: server.model,
      apiKey: server.encryptedApiKey
        ? decryptSecret(server.encryptedApiKey, this.key)
        : environmentApiKey(server.providerType),
      baseUrl: server.baseUrl ?? undefined,
      params: safeJson(server.params, {}),
    };
  }
}

/** Standard vendor credentials used only when the matching configured row has no stored key. */
function environmentApiKey(providerType: string): string | undefined {
  const raw =
    providerType === 'openai'
      ? process.env.OPENAI_API_KEY
      : providerType === 'anthropic'
        ? process.env.ANTHROPIC_API_KEY
        : undefined;
  const value = raw?.trim();
  return value ? value : undefined;
}

function localCredentialSource(row: Row): AiProviderCredentialSource {
  if (row.encryptedApiKey) return 'stored';
  if (row.providerType === 'mock') return 'not-required';
  return environmentApiKey(row.providerType) ? 'environment' : 'none';
}

/** Describe a server-owned credential from a campaign's point of view. */
function inheritedServerCredentialSource(row: Row): AiProviderTestCredentialSource {
  const source = localCredentialSource(row);
  return source === 'stored' ? 'server' : source;
}

function campaignCredentialSource(campaign: Row, server: Row | undefined): AiProviderCredentialSource {
  // Environment keys are operator credentials. A campaign row may use its own
  // stored key (and a keyless mock needs none), but it may not pair an environment
  // key with its DM-controlled baseUrl. Environment fallback is therefore only
  // inherited through an admin-controlled server-default row.
  if (campaign.encryptedApiKey) return 'stored';
  if (campaign.providerType === 'mock') return 'not-required';
  if (!server) return 'none';
  const fallback = localCredentialSource(server);
  if (fallback === 'stored') return 'server';
  if (fallback === 'environment') return 'environment';
  return 'none';
}

/** Remove the exact credential from provider-supplied error text before serialization. */
function redactCredential(message: string, credential: string | undefined): string {
  return credential ? message.split(credential).join('[REDACTED]') : message;
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
