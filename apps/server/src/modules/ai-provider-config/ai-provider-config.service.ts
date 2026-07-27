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
import {
  AI_PROVIDER_BASEURL_NOT_PERMITTED,
  AI_PROVIDER_PROBE_GENERIC_ERROR,
  resolveAiProviderBaseUrlPolicy,
} from '../../common/ai-provider-baseurl';
import { validateAiProviderOutboundUrl } from '../../common/ai-provider-outbound';
import { nowIso } from '../../common/time';
import { auditActor, auditActorRole, type RequestUser } from '../../common/user.types';
import { AuditService } from '../audit/audit.service';
import {
  createAiProvider,
  providerRequiresApiKey,
  type AiProviderConfig,
  type AiProviderType,
} from '../ai-dm/providers';

type ConfigUpdateInput = z.infer<typeof AiProviderConfigUpdate>;
type ConfigView = z.infer<typeof AiProviderConfigView>;
type TestInput = z.infer<typeof AiProviderTestRequest>;
type TestResult = z.infer<typeof AiProviderTestResult>;
type Scope = 'server' | 'campaign';
/**
 * #1052: which of a scope's two provider slots a row is. 'primary' is what every pre-#1052
 * row is and what every existing read path means; 'fallback' is an OPTIONAL second, fully
 * independent config used only after the primary exhausts its retries on a transient failure.
 *
 * Every row lookup below filters on this. Without the filter `serverRow()`/`campaignRow()`
 * — which are `.limit(1)` with no ORDER BY — would return an ARBITRARY one of the two rows,
 * so adding a fallback would non-deterministically swap the table's primary provider.
 */
export type AiProviderRole = 'primary' | 'fallback';
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

  /** Drop the in-process key cache so the next decrypt reads fresh key material. */
  invalidateCachedKey(): void {
    this.cachedKey = null;
  }

  // ── row access ─────────────────────────────────────────────────────────────

  private async serverRow(role: AiProviderRole = 'primary'): Promise<Row | undefined> {
    const [row] = await this.db
      .select()
      .from(aiProviderConfigs)
      // The role filter is load-bearing, not cosmetic (#1052): this is `.limit(1)` with no
      // ORDER BY, so without it a configured fallback would be returned in place of the
      // primary on an arbitrary subset of queries.
      .where(and(eq(aiProviderConfigs.scope, 'server'), eq(aiProviderConfigs.role, role)))
      .limit(1);
    return row;
  }

  private async campaignRow(campaignId: number, role: AiProviderRole = 'primary'): Promise<Row | undefined> {
    const [row] = await this.db
      .select()
      .from(aiProviderConfigs)
      .where(
        and(
          eq(aiProviderConfigs.scope, 'campaign'),
          eq(aiProviderConfigs.campaignId, campaignId),
          eq(aiProviderConfigs.role, role),
        ),
      )
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

  /**
   * Persist-time SSRF gate (issues #1064, #570). Rejects a `baseUrl` whose host is
   * blocked by server policy and resolves DNS to catch rebinding at config time.
   */
  private async assertBaseUrlPermitted(
    baseUrl: string | null | undefined,
    requireDnsResolution = false,
  ): Promise<void> {
    const decision = await validateAiProviderOutboundUrl(baseUrl, resolveAiProviderBaseUrlPolicy(), {
      requireDnsResolution,
    });
    if (!decision.ok) {
      this.logger.warn(
        `ai-provider baseUrl rejected (host=${decision.hostname || '?'}, class=${decision.hostClass}): ${decision.reason}`,
      );
      throw new BadRequestException(AI_PROVIDER_BASEURL_NOT_PERMITTED);
    }
  }

  private async upsert(
    scope: Scope,
    campaignId: number | null,
    existing: Row | undefined,
    input: ConfigUpdateInput,
    user: RequestUser,
    auditCampaignId?: number,
    role: AiProviderRole = 'primary',
  ): Promise<void> {
    const ts = nowIso();
    await this.assertBaseUrlPermitted(input.baseUrl);

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

    // allowedModels is only meaningful at the server scope (the admin allowlist), and only on
    // the PRIMARY row (#1052): the allowlist is one server-wide policy, not a per-slot one, and
    // letting a fallback row carry its own copy would create a second, silently-diverging
    // source of truth for which models are permitted.
    const allowedModels =
      scope === 'server' && role === 'primary' && input.allowedModels !== undefined
        ? JSON.stringify(input.allowedModels)
        : (existing?.allowedModels ?? '[]');

    const values = {
      scope,
      campaignId,
      role,
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
      actorRole: auditActorRole(user),
      action: 'ai-provider.configure',
      entityType: 'ai-provider',
      campaignId: auditCampaignId ?? null,
      detail: `${scope}/${role} provider=${input.providerType} model=${input.model} key=${keyAction}`,
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
      actorRole: auditActorRole(user),
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
      actorRole: auditActorRole(user),
      action: 'ai-provider.key-clear',
      entityType: 'ai-provider',
      campaignId: campaignId ?? null,
      detail: row.scope,
    });
  }

  /**
   * Delete the server provider — BOTH ROLES (#1052 review).
   *
   * This was role-scoped to `'primary'` first, reasoning that a "remove the provider" click
   * should not silently wipe a configured backup. That was the wrong way round, for two reasons
   * that only became visible once the whole shape was on the table.
   *
   * A FALLBACK WITHOUT A PRIMARY IS NOT A BACKUP. Resolution reads the primary first and gives
   * up when there is none, so the surviving row serves no turn, answers no health probe, and is
   * reachable by no execution path. Keeping it preserves no capability whatsoever.
   *
   * WHAT IT DOES PRESERVE IS A SECRET. The row carries a stored, encrypted API key, and it
   * survived the one operation an admin performs in order to destroy exactly that. There is no
   * fallback UI in this release, so an operator working from the web app is never shown the
   * leftover — and re-creating a primary later silently re-arms it, on a credential the admin
   * then in post never knowingly configured and cannot see. A secret outliving the intent to
   * destroy it is the worse failure, and "inert at runtime" is not the axis that matters when
   * the question is whether the key is gone.
   *
   * THE OTHER DIRECTION STAYS INDEPENDENT: deleting the fallback leaves the primary alone. The
   * asymmetry is the point rather than an inconsistency — a fallback depends on a primary for
   * its meaning, and not the reverse.
   */
  async deleteServer(user: RequestUser): Promise<void> {
    await this.db.delete(aiProviderConfigs).where(eq(aiProviderConfigs.scope, 'server'));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: auditActorRole(user),
      action: 'ai-provider.delete',
      entityType: 'ai-provider',
      // Names both roles, so the trail shows the fallback's credential went with it rather than
      // leaving a reader to infer that from which endpoint was called.
      detail: 'server (primary + fallback)',
    });
  }

  /** Delete a campaign's provider override — BOTH ROLES, for the reasons on {@link deleteServer}. */
  async deleteCampaign(campaignId: number, user: RequestUser): Promise<void> {
    await this.db
      .delete(aiProviderConfigs)
      .where(and(eq(aiProviderConfigs.scope, 'campaign'), eq(aiProviderConfigs.campaignId, campaignId)));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: auditActorRole(user),
      action: 'ai-provider.delete',
      entityType: 'ai-provider',
      campaignId,
      detail: 'campaign (primary + fallback)',
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
  async resolveEffectiveConfig(campaignId: number, role: AiProviderRole = 'primary'): Promise<AiProviderConfig | null> {
    return (await this.resolveEffectiveConfigWithEndpointScope(campaignId, role)).config;
  }

  /**
   * `resolveEffectiveConfig` plus WHICH SCOPE actually supplied the endpoint (issue #501).
   *
   * Callers recording durable provenance must not use `getEffectiveView().source` for
   * this. That field answers "does a campaign override row exist?" — it is `'campaign'`
   * whenever any override exists, keyed or not. The question provenance needs answered is
   * "whose URL is this?", and the two only coincide when the override carries its own key.
   *
   * A KEYLESS campaign override inherits the SERVER row's `baseUrl` + `providerType` (the
   * #373 invariant binding the endpoint to whoever owns the key), so its endpoint is
   * server-owned even though a campaign row exists. Reporting that as `'campaign'` both
   * mis-states the provenance and — because the campaign view never shows a DM the
   * inherited server URL — discloses an endpoint they cannot otherwise obtain.
   *
   * `endpointScope` is null exactly when `config` is null (no provider row at all).
   */
  async resolveEffectiveConfigWithEndpointScope(
    campaignId: number,
    /**
     * #1052: which slot to resolve. `'fallback'` runs the IDENTICAL precedence and identical
     * #373 key/endpoint binding one slot over — campaign fallback ?? server fallback, and a
     * keyless campaign fallback inherits the SERVER FALLBACK's key + endpoint + provider type,
     * never the server PRIMARY's. Crossing the slots there would silently ship the primary's
     * credential to an endpoint the fallback row names, which is exactly the exfiltration
     * #373 closed, re-opened one level down.
     */
    role: AiProviderRole = 'primary',
  ): Promise<{ config: AiProviderConfig | null; endpointScope: 'campaign' | 'server' | null }> {
    const server = await this.serverRow(role);
    const camp = await this.campaignRow(campaignId, role);
    const primary = camp ?? server;
    if (!primary) return { config: null, endpointScope: null };

    /** The endpoint belongs to whichever row supplied the baseUrl below. */
    const primaryScope: 'campaign' | 'server' = camp ? 'campaign' : 'server';

    // The scope that supplies the key also supplies the endpoint + providerType.
    // When the primary scope has its own key, key+endpoint+type are self-consistent.
    if (primary.encryptedApiKey) {
      return {
        config: {
          providerType: primary.providerType as AiProviderType,
          model: primary.model,
          apiKey: decryptSecret(primary.encryptedApiKey, this.key),
          baseUrl: primary.baseUrl ?? undefined,
          params: safeJson(primary.params, {}),
        },
        endpointScope: primaryScope,
      };
    }

    // Campaign override without its own key — fall back to the SERVER key, and with it
    // the SERVER endpoint + providerType (NEVER the campaign's). The campaign keeps its
    // own model choice (allowlist-constrained) and sampling params, neither of which is
    // a credential destination.
    if (camp && server?.encryptedApiKey) {
      return {
        config: {
          providerType: server.providerType as AiProviderType,
          model: primary.model,
          apiKey: decryptSecret(server.encryptedApiKey, this.key),
          baseUrl: server.baseUrl ?? undefined,
          params: safeJson(primary.params, {}),
        },
        // The endpoint came from the SERVER row, not the campaign override.
        endpointScope: 'server',
      };
    }

    // A keyless campaign override may also inherit the server default's matching
    // environment credential. As with a stored server key, providerType + baseUrl
    // stay bound to the admin-controlled server row; a DM-controlled endpoint never
    // receives an operator environment secret.
    const serverEnvironmentKey = server ? environmentApiKey(server.providerType) : undefined;
    if (camp && serverEnvironmentKey) {
      return {
        config: {
          providerType: server!.providerType as AiProviderType,
          model: primary.model,
          apiKey: serverEnvironmentKey,
          baseUrl: server!.baseUrl ?? undefined,
          params: safeJson(primary.params, {}),
        },
        // Again the SERVER row's endpoint, inherited with the environment credential.
        endpointScope: 'server',
      };
    }

    // The server row itself falls back to the standard provider environment key
    // when its encrypted key has been deliberately cleared.
    if (!camp) {
      const environmentKey = environmentApiKey(primary.providerType);
      if (environmentKey) {
        return {
          config: {
            providerType: primary.providerType as AiProviderType,
            model: primary.model,
            apiKey: environmentKey,
            baseUrl: primary.baseUrl ?? undefined,
            params: safeJson(primary.params, {}),
          },
          endpointScope: 'server',
        };
      }
    }

    // No key resolvable in any scope (e.g. a keyless provider like `mock`, or an
    // override on a server default that itself has no key). Return the primary scope's
    // own endpoint/type — no server key is in play, so there is nothing to leak.
    return {
      config: {
        providerType: primary.providerType as AiProviderType,
        model: primary.model,
        apiKey: undefined,
        baseUrl: primary.baseUrl ?? undefined,
        params: safeJson(primary.params, {}),
      },
      endpointScope: primaryScope,
    };
  }

  /**
   * Resolve the EFFECTIVE model that WILL be sent to the provider for a campaign, AND
   * revalidate it against the server admin's `allowedModels` at EXECUTION time
   * (issue #564).
   *
   * The executable model derives ONLY from the effective provider config
   * (`resolveEffectiveConfig` → `model`), NEVER from the legacy `seat.model` label.
   * The allowlist was already checked when a campaign override's `model` was WRITTEN
   * (`putCampaign`), but an admin can tighten the allowlist AFTER a seat was
   * configured — so a model that was legal yesterday must still be rejected today.
   * This is the single execution-time choke point: every turn-bearing path (the driver
   * runtime, the legacy takeTurn/co-dm bridge) resolves the model through here, so a
   * legacy `seat.model` cannot bypass the admin policy regardless of provider type
   * (OpenAI-compatible OR Anthropic — both flow through the same `AiProviderConfig`).
   *
   * Returns `{ model, config }` so the caller can build the provider from the SAME
   * decrypted config the model was validated against (no second resolve that could
   * diverge). Throws `BadRequestException` when the resolved model is not on the
   * (non-empty) server allowlist. `null` when no provider is configured at all.
   *
   * `resolveDns` (default true) controls ONLY the rebinding half of the baseUrl gate; the
   * literal host policy always runs. Callers that will actually CONTACT the provider leave
   * it on. Pure REPORTING callers — the #519 readiness GET, which a DM's settings UI may
   * poll and which sends nothing outbound — pass false, so a read can never amplify into a
   * DNS lookup per poll against the host's resolver. That is safe because this resolution
   * is not the security boundary: `createAiProviderGuardedFetch` re-resolves and PINS the
   * addresses on every outbound request, so a rebind between here and the request is caught
   * there regardless of what this pre-flight saw.
   */
  async resolveExecutionModel(
    campaignId: number,
    opts: { resolveDns?: boolean; role?: AiProviderRole } = {},
  ): Promise<{ model: string; config: AiProviderConfig } | null> {
    const config = await this.resolveEffectiveConfig(campaignId, opts.role ?? 'primary');
    if (!config) return null;
    // Fail closed on a previously-stored blocked host (issues #1064, #570).
    await this.assertBaseUrlPermitted(config.baseUrl, opts.resolveDns ?? true);
    const allow = await this.getServerAllowedModels();
    if (allow.length > 0 && !allow.includes(config.model)) {
      throw new BadRequestException(
        `Model '${config.model}' is not in the server admin's allowlist (${allow.join(', ')}). ` +
          'The allowlist was tightened after this provider was configured — update the provider model to an allowed value.',
      );
    }
    return { model: config.model, config };
  }

  /**
   * Resolve the OPTIONAL fallback provider for a campaign (#1052), or null when none is
   * configured at either scope.
   *
   * Deliberately runs the SAME `resolveExecutionModel` — the same SSRF/base-URL re-check and
   * the same admin model allowlist. A fallback is a provider the table's turns will actually
   * be served by, so exempting it from execution-time policy would make "configure a fallback"
   * a way to route around the allowlist and the host policy in one step.
   *
   * A rejected fallback (blocked host, disallowed model) resolves to null rather than throwing:
   * the fallback exists to make a bad moment better, and letting its misconfiguration take down
   * a turn the PRIMARY could have served would invert the whole point. The rejection is logged
   * so it is not silent.
   */
  async resolveFallbackExecutionModel(
    campaignId: number,
    opts: { resolveDns?: boolean } = {},
  ): Promise<{ model: string; config: AiProviderConfig } | null> {
    try {
      return await this.resolveExecutionModel(campaignId, { ...opts, role: 'fallback' });
    } catch (err) {
      this.logger.warn(
        `Fallback AI provider for campaign ${campaignId} is configured but not usable, ignoring it: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  // ── fallback slot CRUD (#1052) ───────────────────────────────────────────────
  //
  // Thin wrappers over the primary-slot methods with `role: 'fallback'`. Deliberately NOT a
  // `role` request-body field on the existing routes: the slot is part of the resource's
  // identity, and a body field would make it possible to overwrite the primary by typo, on
  // endpoints whose whole job is storing a credential.

  async getServerFallbackView(): Promise<ConfigView | null> {
    const row = await this.serverRow('fallback');
    return row ? this.toView(row, localCredentialSource(row)) : null;
  }

  async getCampaignFallbackView(campaignId: number): Promise<ConfigView | null> {
    const [row, serverFallback] = await Promise.all([
      this.campaignRow(campaignId, 'fallback'),
      this.serverRow('fallback'),
    ]);
    return row ? this.toView(row, campaignCredentialSource(row, serverFallback)) : null;
  }

  /** Upsert the server-default FALLBACK provider (admin-gated at the controller). */
  async putServerFallback(input: ConfigUpdateInput, user: RequestUser): Promise<ConfigView> {
    // The fallback serves real turns, so it is bound by the same admin allowlist as a campaign
    // override. The server PRIMARY is exempt because it is the row that DEFINES the allowlist;
    // the fallback does not define it, so it must obey it.
    this.assertCampaignModelAllowed(input.model, await this.serverRow('primary'));
    const existing = await this.serverRow('fallback');
    await this.upsert('server', null, existing, input, user, undefined, 'fallback');
    const row = await this.serverRow('fallback');
    return this.toView(row!, localCredentialSource(row!));
  }

  /** Upsert a per-campaign FALLBACK override (DM-gated at the controller). */
  async putCampaignFallback(campaignId: number, input: ConfigUpdateInput, user: RequestUser): Promise<ConfigView> {
    this.assertCampaignModelAllowed(input.model, await this.serverRow('primary'));
    const existing = await this.campaignRow(campaignId, 'fallback');
    await this.upsert('campaign', campaignId, existing, input, user, campaignId, 'fallback');
    const row = await this.campaignRow(campaignId, 'fallback');
    return this.toView(row!, campaignCredentialSource(row!, await this.serverRow('fallback')));
  }

  /** Remove the server fallback slot entirely (no-op when unset). */
  async deleteServerFallback(user: RequestUser): Promise<void> {
    await this.db
      .delete(aiProviderConfigs)
      .where(and(eq(aiProviderConfigs.scope, 'server'), eq(aiProviderConfigs.role, 'fallback')));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: auditActorRole(user),
      action: 'ai-provider.delete',
      entityType: 'ai-provider',
      campaignId: null,
      detail: 'server/fallback removed',
    });
  }

  /** Remove a campaign's fallback slot entirely (no-op when unset). */
  async deleteCampaignFallback(campaignId: number, user: RequestUser): Promise<void> {
    await this.db
      .delete(aiProviderConfigs)
      .where(
        and(
          eq(aiProviderConfigs.scope, 'campaign'),
          eq(aiProviderConfigs.campaignId, campaignId),
          eq(aiProviderConfigs.role, 'fallback'),
        ),
      );
    await this.audit.log({
      actor: auditActor(user),
      actorRole: auditActorRole(user),
      action: 'ai-provider.delete',
      entityType: 'ai-provider',
      campaignId,
      detail: 'campaign/fallback removed',
    });
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
    // SSRF gate before any outbound request (issues #1064, #570). A blocked host returns the
    // same generic failure as other probe errors — never host-class / reachability detail.
    const baseUrlDecision = await validateAiProviderOutboundUrl(config.baseUrl);
    if (!baseUrlDecision.ok) {
      this.logger.warn(
        `testConnection blocked baseUrl (scope=${scope}, host=${baseUrlDecision.hostname || '?'}, class=${baseUrlDecision.hostClass}): ${baseUrlDecision.reason}`,
      );
      return AiProviderTestResult.parse({
        ok: false,
        scope,
        testedTarget: resolved.testedTarget,
        providerType: config.providerType,
        model: config.model,
        baseUrl: config.baseUrl ?? null,
        credentialSource: resolved.credentialSource,
        testedAt: nowIso(),
        error: AI_PROVIDER_PROBE_GENERIC_ERROR,
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
      const rawMessage = err instanceof Error ? err.message : String(err);
      this.logger.warn(`testConnection probe failed (scope=${scope}, target=${resolved.testedTarget}): ${rawMessage}`);
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

  /**
   * Issue #987: fetch the list of available models from the configured (or draft) provider.
   * Reuses the same resolve-config / createAiProvider pattern as testConnection. Returns
   * an empty array if the provider doesn't support model discovery (no `listModels` method).
   */
  async fetchAvailableModels(campaignId: number | null, input?: TestInput): Promise<string[]> {
    const resolved = input
      ? await this.resolveDraftTestCandidate(campaignId, input)
      : await this.resolveStoredTestCandidate(campaignId);
    const config = resolved.config;
    if (!config) return [];
    const baseUrlDecision = await validateAiProviderOutboundUrl(config.baseUrl);
    if (!baseUrlDecision.ok) {
      this.logger.warn(
        `fetchAvailableModels blocked baseUrl (host=${baseUrlDecision.hostname || '?'}, class=${baseUrlDecision.hostClass}): ${baseUrlDecision.reason}`,
      );
      throw new BadRequestException(AI_PROVIDER_PROBE_GENERIC_ERROR);
    }
    try {
      const provider = createAiProvider(config);
      if (!provider.listModels) return [];
      return await provider.listModels();
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      const rawMessage = err instanceof Error ? err.message : String(err);
      this.logger.warn(`fetchAvailableModels failed: ${rawMessage}`);
      throw new BadRequestException(AI_PROVIDER_PROBE_GENERIC_ERROR);
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

    // A keyless provider never consumes a credential, even if a stale/typed key exists.
    // #1052 review — the shared predicate rather than a third open-coded `=== 'mock'`.
    // Semantics are unchanged: this probes the DRAFT AS TYPED (`testedTarget` and the
    // 'candidate' source say so), not what resolution would run, so the candidate's own
    // provider type is the right thing to ask about here.
    if (!providerRequiresApiKey(input.providerType)) {
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
        : providerType === 'gemini'
          ? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
          : undefined;
  const value = raw?.trim();
  return value ? value : undefined;
}

function localCredentialSource(row: Row): AiProviderCredentialSource {
  if (row.encryptedApiKey) return 'stored';
  // #1052 review — one shared predicate rather than an open-coded `=== 'mock'`.
  if (!providerRequiresApiKey(row.providerType as AiProviderType)) return 'not-required';
  return environmentApiKey(row.providerType) ? 'environment' : 'none';
}

/** Describe a server-owned credential from a campaign's point of view. */
function inheritedServerCredentialSource(row: Row): AiProviderTestCredentialSource {
  const source = localCredentialSource(row);
  return source === 'stored' ? 'server' : source;
}

/**
 * What credential a campaign override will ACTUALLY run on.
 *
 * Environment keys are operator credentials. A campaign row may use its own stored key, but it
 * may not pair an environment key with its DM-controlled baseUrl, so environment fallback is
 * only inherited through an admin-controlled server-default row.
 *
 * #1052 review — THIS MIRRORS `resolveEffectiveConfigWithEndpointScope`'S PRECEDENCE, AND THE
 * ORDER IS THE WHOLE POINT.
 *
 * `not-required` used to be answered SECOND, before the server row was consulted at all, so a
 * campaign override set to the offline `mock` reported "needs no credential" while resolution
 * went on to inherit the server's key, endpoint and provider type and ran the turn against an
 * external vendor. The stated configuration and the executed one disagreed, and the DM was
 * shown the reassuring half.
 *
 * The fix belongs HERE and not in resolution, and that was tried the other way round first.
 * A keyless campaign override is a MODEL-ONLY override by design (#373): its providerType and
 * baseUrl are discarded in favour of whoever owns the key. Short-circuiting that for keyless
 * provider types looks like the tidier fix and is the wrong one, for two reasons.
 *
 * It makes "which row's endpoint serves this turn" depend on the campaign row's providerType —
 * a DM-controlled field, and precisely the input #373 removed from the endpoint decision. The
 * exemption is safe only for as long as a hard-coded set of "contacts nothing" types stays
 * correct; a type wrongly listed there hands a DM the endpoint choice back.
 *
 * And it breaks the #501 provenance contract, which `scribe` and `co-dm` each assert
 * independently: `endpointScope` must name where the request REALLY went, so a keyless
 * override reports `server`. Short-circuiting made it report `campaign` — the configuration's
 * scope rather than the execution's — which misleads exactly the operator asking which
 * endpoint saw their table's content.
 *
 * So resolution keeps its behaviour and the VIEW stops misreporting it: the server's credential
 * is checked first, and `not-required` is reached only when nothing is inherited and the
 * campaign's own keyless provider really is what runs. A DM who wants no external calls at all
 * still needs the ADMIN to clear the server row; what changes here is that the DM is no longer
 * told otherwise.
 */
function campaignCredentialSource(campaign: Row, server: Row | undefined): AiProviderCredentialSource {
  if (campaign.encryptedApiKey) return 'stored';
  const inherited = server ? localCredentialSource(server) : 'none';
  if (inherited === 'stored') return 'server';
  if (inherited === 'environment') return 'environment';
  if (!providerRequiresApiKey(campaign.providerType as AiProviderType)) return 'not-required';
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
