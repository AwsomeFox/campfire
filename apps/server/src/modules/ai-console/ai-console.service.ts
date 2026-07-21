import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type {
  AiCapsUpdate,
  AiConsoleOverview,
  AiProviderHealthEntry,
  AiUsageCampaignRow,
  AiUsageModelRow,
  AiUsageRollup,
} from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { aiDmSeats, aiProviderConfigs, campaigns } from '../../db/schema';
import { nowIso } from '../../common/time';
import { auditActor, type RequestUser } from '../../common/user.types';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { AiProviderConfigService } from '../ai-provider-config/ai-provider-config.service';

type AiCapsUpdateInput = z.infer<typeof AiCapsUpdate>;

/**
 * Admin AI console (issue #315) — the server-admin cockpit over the AI program
 * (epic #308). It OWNS no metering of its own: budgets are enforced where the
 * spend happens (AiDmService meters per-seat; the server-wide cap it reads from
 * settings), and this service is the read/aggregate + admin-write layer on top:
 *
 *   - kill switch      → toggles ServerSettings.experimentalAiDm (the global gate
 *                        that already 403s every AI-DM path when off).
 *   - budgets & caps   → the server-wide token cap (settings) + per-campaign seat
 *                        tokenBudget (the existing AiDmSeat cap).
 *   - usage dashboard  → aggregated LIVE from the per-seat counters (no new ledger
 *                        table — the spec's `ai_usage` ledger is satisfied by the
 *                        existing atomic per-seat metering, issue #272).
 *   - model allowlist  → drives #310's allowedModels (AiProviderConfigService).
 *   - provider health  → a "test all" over the server + per-campaign providers.
 *
 * No API key or raw prompt is ever exposed by any method here.
 */
@Injectable()
export class AiConsoleService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly settings: SettingsService,
    private readonly providers: AiProviderConfigService,
    private readonly audit: AuditService,
  ) {}

  // ── usage rollup (aggregated from the per-seat metering) ─────────────────────

  /**
   * Aggregate every configured AI-DM seat into the dashboard rollup: totals, a
   * per-campaign breakdown (joined to campaign names), and a per-model breakdown.
   * Purely a read over aiDmSeats — reflects the atomic per-turn metering as-is.
   */
  async getUsage(): Promise<AiUsageRollup> {
    const rows = await this.db
      .select({
        campaignId: aiDmSeats.campaignId,
        campaignName: campaigns.name,
        enabled: aiDmSeats.enabled,
        model: aiDmSeats.model,
        tokenBudget: aiDmSeats.tokenBudget,
        tokensUsed: aiDmSeats.tokensUsed,
        turnCount: aiDmSeats.turnCount,
        lastTurnAt: aiDmSeats.lastTurnAt,
      })
      .from(aiDmSeats)
      .leftJoin(campaigns, eq(campaigns.id, aiDmSeats.campaignId))
      .orderBy(asc(aiDmSeats.campaignId));

    const byCampaign: AiUsageCampaignRow[] = rows.map((r) => ({
      campaignId: r.campaignId,
      // A seat whose campaign was hard-deleted (non-FK DB) shows a placeholder name.
      campaignName: r.campaignName ?? `#${r.campaignId}`,
      enabled: r.enabled,
      model: r.model,
      tokenBudget: r.tokenBudget,
      tokensUsed: r.tokensUsed,
      turnCount: r.turnCount,
      lastTurnAt: r.lastTurnAt ?? null,
    }));

    const modelMap = new Map<string, AiUsageModelRow>();
    for (const r of rows) {
      const key = r.model ?? '';
      const agg = modelMap.get(key) ?? { model: key, tokensUsed: 0, turnCount: 0, seats: 0 };
      agg.tokensUsed += r.tokensUsed;
      agg.turnCount += r.turnCount;
      agg.seats += 1;
      modelMap.set(key, agg);
    }
    const byModel = [...modelMap.values()].sort((a, b) => b.tokensUsed - a.tokensUsed);

    const totalTokensUsed = rows.reduce((s, r) => s + r.tokensUsed, 0);
    const totalTurns = rows.reduce((s, r) => s + r.turnCount, 0);
    const settings = await this.settings.getAll();
    const serverTokenCap = settings.aiServerTokenCap;

    return {
      totalTokensUsed,
      totalTurns,
      seatCount: rows.length,
      activeSeatCount: rows.filter((r) => r.enabled).length,
      serverTokenCap,
      serverBudgetRemaining: serverTokenCap > 0 ? Math.max(0, serverTokenCap - totalTokensUsed) : null,
      byCampaign,
      byModel,
    };
  }

  // ── overview (single-shot console state) ─────────────────────────────────────

  async getOverview(): Promise<AiConsoleOverview> {
    const [settings, usage, serverView] = await Promise.all([
      this.settings.getAll(),
      this.getUsage(),
      this.providers.getServerView(),
    ]);
    return {
      killSwitchEnabled: settings.experimentalAiDm,
      serverTokenCap: settings.aiServerTokenCap,
      allowedModels: serverView?.allowedModels ?? [],
      serverProviderConfigured: !!serverView,
      serverProviderType: serverView?.providerType ?? null,
      usage,
    };
  }

  // ── kill switch ──────────────────────────────────────────────────────────────

  /**
   * The global opt-in / kill switch. `false` pauses ALL AI immediately: it flips
   * ServerSettings.experimentalAiDm, which AiDmService gates every configure/turn on
   * (assertExperimentalEnabled → 403), so in-flight-after-check turns are the only
   * ones that complete and no NEW turn can start. Audited server-wide.
   */
  async setKillSwitch(enabled: boolean, user: RequestUser): Promise<AiConsoleOverview> {
    await this.settings.update({ experimentalAiDm: enabled });
    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'dm',
      action: enabled ? 'ai-console.enable' : 'ai-console.kill',
      entityType: 'ai-console',
      detail: enabled ? 'AI enabled server-wide' : 'kill switch: all AI paused',
    });
    return this.getOverview();
  }

  // ── budgets & caps ─────────────────────────────────────────────────────────────

  /**
   * Set the server-wide token cap and/or per-campaign seat budgets. The server cap
   * lands in settings (enforced by AiDmService against aggregate usage); each
   * per-campaign entry upserts that seat's tokenBudget ONLY — usage counters are
   * never touched. Omitted fields are left unchanged. Audited.
   */
  async setCaps(input: AiCapsUpdateInput, user: RequestUser): Promise<AiConsoleOverview> {
    const detail: string[] = [];

    if (input.serverTokenCap !== undefined) {
      await this.settings.update({ aiServerTokenCap: input.serverTokenCap });
      detail.push(`serverCap=${input.serverTokenCap}`);
    }

    if (input.campaigns && input.campaigns.length > 0) {
      const ts = nowIso();
      for (const c of input.campaigns) {
        const [existing] = await this.db
          .select({ campaignId: aiDmSeats.campaignId })
          .from(aiDmSeats)
          .where(eq(aiDmSeats.campaignId, c.campaignId))
          .limit(1);
        if (existing) {
          await this.db
            .update(aiDmSeats)
            .set({ tokenBudget: c.tokenBudget, updatedAt: ts })
            .where(eq(aiDmSeats.campaignId, c.campaignId));
        } else {
          // Create a (disabled) seat carrying just the budget — the DM still has to
          // enable + point it at a model before any turn can run.
          await this.db.insert(aiDmSeats).values({
            campaignId: c.campaignId,
            enabled: false,
            model: '',
            instructions: '',
            tokenBudget: c.tokenBudget,
            tokensUsed: 0,
            turnCount: 0,
            lastTurnAt: null,
            createdAt: ts,
            updatedAt: ts,
          });
        }
      }
      detail.push(`campaignBudgets=${input.campaigns.length}`);
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'dm',
      action: 'ai-console.caps',
      entityType: 'ai-console',
      detail: detail.join(', ') || 'no-op',
    });
    return this.getOverview();
  }

  // ── model allowlist ─────────────────────────────────────────────────────────────

  async setAllowlist(models: string[], user: RequestUser): Promise<AiConsoleOverview> {
    await this.providers.setServerAllowedModels(models, user);
    return this.getOverview();
  }

  // ── provider health ("test all") ─────────────────────────────────────────────

  /**
   * Probe the server-default provider and every per-campaign override. Reuses
   * AiProviderConfigService.testConnection, which builds the real provider from the
   * decrypted (in-process) config and runs a minimal generation — returning ok/error
   * only, never a credential.
   */
  async testAll(): Promise<AiProviderHealthEntry[]> {
    const out: AiProviderHealthEntry[] = [];

    const serverView = await this.providers.getServerView();
    if (serverView) {
      const r = await this.providers.testConnection(null);
      out.push({ scope: 'server', campaignId: null, campaignName: null, ...r });
    }

    // Every campaign that has its own provider override, joined to its name.
    const overrides = await this.db
      .select({ campaignId: aiProviderConfigs.campaignId, campaignName: campaigns.name })
      .from(aiProviderConfigs)
      .leftJoin(campaigns, eq(campaigns.id, aiProviderConfigs.campaignId))
      .where(eq(aiProviderConfigs.scope, 'campaign'));

    for (const o of overrides) {
      if (o.campaignId == null) continue;
      const r = await this.providers.testConnection(o.campaignId);
      out.push({
        scope: 'campaign',
        campaignId: o.campaignId,
        campaignName: o.campaignName ?? `#${o.campaignId}`,
        ...r,
      });
    }

    return out;
  }
}
