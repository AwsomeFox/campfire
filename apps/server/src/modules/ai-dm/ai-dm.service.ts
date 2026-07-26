import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { AiDmProactiveSettings } from '@campfire/schema';
import type {
  AiDmMode,
  AiDmReadiness,
  AiDmReadinessCheck,
  AiDmSeat,
  AiDmSeatUpdate,
  AiDmTurnRequest,
  AiDmTurnResult,
  AiDmUsageHistoryEntry,
  AiDmUsageHistoryResponse,
  Role,
} from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { aiDmSeats, aiDmUsageHistory } from '../../db/schema';
import { nowIso } from '../../common/time';
import { auditActor, type RequestUser } from '../../common/user.types';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { AiProviderConfigService } from '../ai-provider-config/ai-provider-config.service';
import { AI_DM_PROVIDER, type AiDmProvider } from './ai-dm.provider';
import { SessionZeroService } from '../session-zero/session-zero.service';
import { SupportPreferencesService } from '../session-zero/support-preferences.service';
import { providerCapabilities } from './providers';

type AiDmSeatUpdateInput = z.infer<typeof AiDmSeatUpdate>;
type AiDmTurnRequestInput = z.infer<typeof AiDmTurnRequest>;

/** Default per-turn output cap when the caller doesn't specify maxTokens. */
const DEFAULT_MAX_TOKENS = 512;

/**
 * Readiness cost-estimate shape (#519) used only when a campaign has NO metered turns to
 * average yet: a typical assembled prompt plus one bounded narration reply. Once real turns
 * exist, {@link AiDmService.recentTurnTokenAverage} replaces this with observed usage.
 */
const DEFAULT_ESTIMATED_PROMPT_TOKENS = 750;
const DEFAULT_ESTIMATED_COMPLETION_TOKENS = 1024;
/** Share of a turn's tokens attributed to completion when only a total is known. */
const DEFAULT_COMPLETION_SHARE =
  DEFAULT_ESTIMATED_COMPLETION_TOKENS / (DEFAULT_ESTIMATED_PROMPT_TOKENS + DEFAULT_ESTIMATED_COMPLETION_TOKENS);
/** How many recent metered turns the readiness estimate averages over. */
const READINESS_USAGE_SAMPLE = 20;

function toDomain(row: typeof aiDmSeats.$inferSelect): AiDmSeat {
  return {
    campaignId: row.campaignId,
    mode: (row.mode as AiDmMode) ?? 'off',
    enabled: row.enabled,
    model: row.model,
    instructions: row.instructions,
    tokenBudget: row.tokenBudget,
    tokensUsed: row.tokensUsed,
    turnCount: row.turnCount,
    lastTurnAt: row.lastTurnAt,
    actionQueueDepth: row.actionQueueDepth ?? 8,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    proactiveSettings: AiDmProactiveSettings.parse(row.proactiveSettings ?? {}),
  };
}

/** In-memory default seat for a campaign that has never configured one — never persisted. */
function defaultSeat(campaignId: number): AiDmSeat {
  const ts = nowIso();
  return {
    campaignId,
    mode: 'off',
    enabled: false,
    model: '',
    instructions: '',
    tokenBudget: 0,
    tokensUsed: 0,
    turnCount: 0,
    lastTurnAt: null,
    proactiveSettings: {
      enabled: false,
      triggers: { encounterEnded: true, hpCritical: true, objectiveCompleted: true },
      cooldownSeconds: 300,
      maxProactiveTokensPerHour: 5000,
    },
    actionQueueDepth: 8,
    createdAt: ts,
    updatedAt: ts,
  };
}

/**
 * Experimental server-side AI Dungeon Master (issue #28).
 *
 * This service owns the per-campaign "AI DM seat" and the metering/gating/audit
 * around it — it does NOT itself generate any text. Narration comes from the
 * injected AiDmProvider (AI_DM_PROVIDER); the shipped default is a no-op that
 * makes no network calls and returns a scaffold response (see ai-dm.provider.ts).
 * Campfire never calls an LLM vendor from the server.
 *
 * Two independent gates protect every write path:
 *   1. ServerSettings.experimentalAiDm — the server-wide opt-in (admin only).
 *   2. the per-campaign seat's `enabled` flag (turns only).
 * Plus a per-campaign token budget that a turn is metered against.
 */
@Injectable()
export class AiDmService {
  private readonly logger = new Logger(AiDmService.name);

  /**
   * Optional hook invoked when configure leaves Driver mode (#1071). Wired by
   * AiDriverService at construction so the seat path can tear down the live
   * in-memory driver session without creating an AiDm→AiDriver DI cycle.
   */
  private driverSessionTeardown?: (campaignId: number) => void;
  private proactiveSettingsCallback?: (
    campaignId: number,
    settings?: AiDmProactiveSettings,
    seatEnabled?: boolean,
  ) => void;

  /**
   * Per-campaign, in-process budget-spend queues (#1058). Each value is the tail
   * promise for that campaign. Appending synchronously before awaiting the prior
   * tail gives FIFO mutex semantics even when multiple waiters arrive together.
   * Campfire's SQLite server is a single-process deployment; this advisory mutex
   * deliberately coordinates spenders inside that process.
   */
  private readonly spendLockTails = new Map<number, Promise<void>>();

  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly providerConfig: AiProviderConfigService,
    private readonly sessionZero: SessionZeroService,
    private readonly supportPreferences: SupportPreferencesService,
    @Inject(AI_DM_PROVIDER) private readonly provider: AiDmProvider,
  ) {}

  /** Register proactive settings change callback (#1044). */
  registerProactiveSettingsCallback(
    fn: (campaignId: number, settings?: AiDmProactiveSettings, seatEnabled?: boolean) => void,
  ): void {
    this.proactiveSettingsCallback = fn;
  }

  /**
   * Run one provider-spend operation while holding the campaign's advisory
   * mutex (#1058). The queue is planted before awaiting its predecessor, so
   * simultaneous waiters cannot wake and both become owners. Cleanup lives in
   * `finally`: provider, config, and metering failures cannot strand the lock.
   *
   * Callers must keep the budget re-check, provider call, and metering inside
   * `operation`; checking before entering the mutex would reintroduce the TOCTOU
   * race this helper closes.
   */
  async withSpendLock<T>(campaignId: number, operation: () => Promise<T>): Promise<T> {
    const predecessor = this.spendLockTails.get(campaignId) ?? Promise.resolve();
    let release!: () => void;
    const owned = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.then(() => owned);
    this.spendLockTails.set(campaignId, tail);

    await predecessor;
    try {
      return await operation();
    } finally {
      release();
      if (this.spendLockTails.get(campaignId) === tail) {
        this.spendLockTails.delete(campaignId);
      }
    }
  }

  /** Register the driver-session teardown used when the seat leaves Driver mode (#1071). */
  registerDriverSessionTeardown(fn: (campaignId: number) => void): void {
    this.driverSessionTeardown = fn;
  }

  /** 403 unless the server-wide experimental flag is on. The single choke point for the whole feature. */
  async isExperimentalEnabled(): Promise<boolean> {
    const all = await this.settings.getAll();
    return !!all.experimentalAiDm;
  }

  private async assertExperimentalEnabled(): Promise<void> {
    if (!(await this.isExperimentalEnabled())) {
      throw new ForbiddenException(
        'Server-side AI Dungeon Master is experimental and disabled. A server admin must enable it via PATCH /settings {experimentalAiDm:true}.',
      );
    }
  }

  /**
   * Enforce the server-wide token cap (issue #315). 0 = unlimited. When positive,
   * a turn is rejected once SUM(tokensUsed) across all seats reaches the cap. Read
   * from ServerSettings so an admin can raise/lower it live from the AI console.
   *
   * Public so the token-SPENDING paths that AiDmService doesn't own — the driver
   * runtime (assertRunnable, below) and the co-DM / scribe pre-checks — all bound
   * themselves by the same admin ceiling (#384). Previously only takeTurn() called
   * it, so the driver (the path that actually burns provider tokens) ignored the cap.
   */
  async assertWithinServerTokenCap(): Promise<void> {
    const status = await this.serverTokenCapStatus();
    if (!status.withinCap) {
      throw new ForbiddenException(
        `Server-wide AI token cap reached (${status.total}/${status.cap}). A server admin must raise it in the AI console (PUT /settings/ai/caps) or reset usage to continue.`,
      );
    }
  }

  /**
   * Mean tokens per metered turn over this campaign's most recent turns, or `null` when it
   * has none yet. Powers the readiness cost estimate (#519) so the number a DM sees before a
   * run reflects what THIS table actually spends rather than a fixed guess.
   */
  private async recentTurnTokenAverage(campaignId: number): Promise<number | null> {
    const rows = await this.db
      .select({ tokensUsed: aiDmUsageHistory.tokensUsed })
      .from(aiDmUsageHistory)
      .where(eq(aiDmUsageHistory.campaignId, campaignId))
      .orderBy(desc(aiDmUsageHistory.id))
      .limit(READINESS_USAGE_SAMPLE);
    const samples = rows.map((row) => Number(row.tokensUsed)).filter((n) => Number.isFinite(n) && n > 0);
    if (samples.length === 0) return null;
    return Math.round(samples.reduce((sum, n) => sum + n, 0) / samples.length);
  }

  /**
   * Non-throwing read of the same ceiling {@link assertWithinServerTokenCap} enforces, so
   * the readiness model (#519) can REPORT the cap instead of showing a green checklist that
   * the very next turn 403s on. Both share this one query so the two can never diverge.
   */
  private async serverTokenCapStatus(): Promise<{ cap: number; total: number; withinCap: boolean }> {
    const { aiServerTokenCap: cap } = await this.settings.getAll();
    if (!cap || cap <= 0) return { cap: 0, total: 0, withinCap: true };
    const [agg] = await this.db
      .select({ total: sql<number>`COALESCE(SUM(${aiDmSeats.tokensUsed}), 0)` })
      .from(aiDmSeats);
    const total = Number(agg?.total ?? 0);
    return { cap, total, withinCap: total < cap };
  }

  /**
   * Resolve the executable model for a turn and revalidate it against the admin
   * allowlist at EXECUTION time (issue #564). Public so EVERY token-spending path
   * that AiDmService's siblings own — the legacy takeTurn below, the co-DM drafts,
   * the scribe — all derive the model from the SAME policy-checked source rather
   * than the legacy `seat.model` label (which a DM could set to arbitrary text and
   * bypass the admin allowlist). Returns the resolved model, or `null` when no
   * provider is configured (callers fall back to the no-op seam). Throws
   * `BadRequestException` when the resolved model is off the (non-empty) allowlist.
   */
  async resolveExecutionModel(campaignId: number): Promise<string | null> {
    const resolved = await this.providerConfig.resolveExecutionModel(campaignId);
    return resolved?.model ?? null;
  }

  private async findRow(campaignId: number): Promise<(typeof aiDmSeats.$inferSelect) | undefined> {
    const [row] = await this.db.select().from(aiDmSeats).where(eq(aiDmSeats.campaignId, campaignId)).limit(1);
    return row;
  }

  /** Read the seat (its configured, un-metered default when none exists yet). No experimental gate — reads are inert. */
  async getSeat(campaignId: number): Promise<AiDmSeat> {
    const row = await this.findRow(campaignId);
    return row ? toDomain(row) : defaultSeat(campaignId);
  }

  /**
   * Redact DM-only fields for non-DM callers (issue #261). `instructions` is
   * DM-authored steering — the persona/house rules where plot secrets live —
   * and must not leak to players/viewers, mirroring dmSecret/hidden everywhere
   * else. DM callers get the full seat; everyone else gets it with
   * `instructions` omitted entirely.
   */
  redactSeatForRole(seat: AiDmSeat, role: Role): AiDmSeat | Omit<AiDmSeat, 'instructions'> {
    if (role === 'dm') return seat;
    const { instructions: _instructions, ...rest } = seat;
    return rest;
  }

  /** Convenience: read the seat and redact it for the caller's role in one step. */
  async getSeatForRole(campaignId: number, role: Role): Promise<AiDmSeat | Omit<AiDmSeat, 'instructions'>> {
    return this.redactSeatForRole(await this.getSeat(campaignId), role);
  }

  /**
   * Central AI onboarding readiness model (#519). This is intentionally read-only
   * and non-secret: it summarizes whether the table is ready to promote AI actions
   * without returning provider keys, participant support text, or DM instructions.
   */
  async getReadiness(
    campaignId: number,
    user: RequestUser,
    opts: { isAdmin: boolean },
  ): Promise<AiDmReadiness> {
    const seat = await this.getSeat(campaignId);
    const [settings, providerView, charter, consent, serverCap, recentUsage] = await Promise.all([
      this.settings.getAll(),
      this.providerConfig.getEffectiveView(campaignId),
      this.sessionZero.get(campaignId),
      this.supportPreferences.aiConsentCounts(campaignId),
      this.serverTokenCapStatus(),
      this.recentTurnTokenAverage(campaignId),
    ]);
    const provider = providerView as AiDmReadiness['provider'];
    const budgetRemaining = Math.max(0, seat.tokenBudget - seat.tokensUsed);
    const fix = (hash: string) => `/c/${campaignId}/settings#${hash}`;
    const checks: AiDmReadinessCheck[] = [];
    const push = (check: AiDmReadinessCheck) => checks.push(check);

    push({
      key: 'serverFlag',
      ok: !!settings.experimentalAiDm,
      status: settings.experimentalAiDm ? 'ok' : opts.isAdmin ? 'blocked' : 'unknown',
      actor: 'admin',
      title: 'Server AI enabled',
      detail: settings.experimentalAiDm
        ? 'The server-wide AI switch is on.'
        : opts.isAdmin
          ? 'Turn on the server-wide AI switch before promoting AI actions.'
          : 'A server admin must enable experimental AI before this campaign can run AI actions.',
      requiredForDriver: true,
      fixHref: opts.isAdmin ? '/admin/ai' : null,
    });

    push({
      key: 'serverCap',
      ok: serverCap.withinCap,
      status: serverCap.withinCap ? 'ok' : 'blocked',
      actor: 'admin',
      title: 'Server-wide token cap',
      detail: serverCap.cap <= 0
        ? 'No server-wide AI token cap is set.'
        : serverCap.withinCap
          ? `${serverCap.total.toLocaleString()} / ${serverCap.cap.toLocaleString()} server-wide tokens used.`
          : `The server-wide AI token cap is reached (${serverCap.total.toLocaleString()}/${serverCap.cap.toLocaleString()}). A server admin must raise it or reset usage.`,
      requiredForDriver: true,
      fixHref: opts.isAdmin ? '/admin/ai' : null,
    });

    push({
      key: 'provider',
      ok: provider.configured && provider.ready,
      status: provider.configured && provider.ready ? 'ok' : 'blocked',
      // The deep link always points at CAMPAIGN settings, where a DM can add (or fix) a
      // campaign override — so the DM is the actor unless the effective config is the
      // server default, which only an admin can repair in place.
      actor: provider.configured && provider.source === 'server' ? 'admin' : 'dm',
      title: 'Provider and credential',
      detail: provider.configured
        ? provider.ready
          ? `Using ${provider.providerType ?? 'provider'} / ${provider.model ?? 'model'} from ${provider.source ?? 'configuration'} with ${provider.credentialSource} credentials.`
          : 'A provider is configured, but no usable credential is available.'
        : 'Configure a campaign provider or ask a server admin to set a server default.',
      requiredForDriver: true,
      fixHref: fix('ai-dm-provider'),
    });

    let modelOk = provider.configured && provider.ready;
    let modelDetail = provider.model
      ? `Model ${provider.model} is selected.`
      : 'Choose the model that will execute AI requests.';
    try {
      const execution = await this.providerConfig.resolveExecutionModel(campaignId);
      modelOk = !!execution;
      if (execution) modelDetail = `Execution model ${execution.model} passes the server allowlist.`;
    } catch (err) {
      modelOk = false;
      modelDetail = err instanceof Error ? err.message : 'The selected model is not executable.';
    }
    push({
      key: 'model',
      ok: modelOk,
      status: modelOk ? 'ok' : 'blocked',
      actor: 'dm',
      title: 'Executable model',
      detail: modelDetail,
      requiredForDriver: true,
      fixHref: fix('ai-dm-provider'),
    });

    push({
      key: 'budget',
      ok: seat.tokenBudget > 0 && budgetRemaining > 0,
      status: seat.tokenBudget > 0 && budgetRemaining > 0 ? 'ok' : 'blocked',
      actor: 'dm',
      title: 'Budget available',
      detail: seat.tokenBudget > 0
        ? `${seat.tokensUsed.toLocaleString()} / ${seat.tokenBudget.toLocaleString()} tokens used; ${budgetRemaining.toLocaleString()} remain.`
        : 'Set a positive hard token budget before Driver can run.',
      requiredForDriver: true,
      fixHref: fix('ai-dm-budget'),
    });

    const writeScope = user.tokenContext?.writeScope ?? 'direct';
    push({
      key: 'writeMode',
      ok: writeScope === 'direct',
      status: writeScope === 'direct' ? 'ok' : 'blocked',
      actor: 'dm',
      title: 'Write mode',
      detail: writeScope === 'direct'
        ? 'This session can make direct DM-approved writes when the selected AI mode allows them.'
        : `This token is ${writeScope === 'none' ? 'read-only' : 'proposal-only'}; use a direct-write DM session before starting Driver.`,
      requiredForDriver: true,
      fixHref: null,
    });

    const contentCount =
      charter.lines.length +
      charter.veils.length +
      charter.safetyTools.length +
      (charter.houseRules.trim() ? 1 : 0) +
      (charter.toneAndExpectations.trim() ? 1 : 0);
    push({
      key: 'rulesContent',
      ok: contentCount > 0,
      status: contentCount > 0 ? 'ok' : 'warning',
      actor: 'dm',
      title: 'Rules and table content',
      detail: contentCount > 0
        ? 'Session-zero safety, house-rule, or tone guidance is available to the AI.'
        : 'Add session-zero lines, veils, safety tools, house rules, or tone guidance so AI output has table boundaries.',
      requiredForDriver: false,
      fixHref: `/c/${campaignId}/session-zero`,
    });

    push({
      key: 'supportConsent',
      ok: consent.total === 0 || consent.consented > 0,
      status: consent.total === 0 || consent.consented > 0 ? 'ok' : 'warning',
      actor: 'table',
      title: 'Participant support consent',
      detail: consent.total === 0
        ? 'No participant support notes are on file.'
        : `${consent.consented} of ${consent.total} support notes allow AI use; ${consent.tableConsented} can influence public narration.`,
      requiredForDriver: false,
      fixHref: `/c/${campaignId}/session-zero#support-preferences`,
    });

    push({
      key: 'secretPolicy',
      ok: true,
      status: 'ok',
      actor: 'dm',
      title: 'Secret and privacy policy',
      detail:
        'Provider keys stay write-only/redacted, participant support text is opt-in for AI, and Driver uses player-scoped reads unless a DM-approved secret is explicitly needed.',
      requiredForDriver: false,
      fixHref: fix('ai-dm-provider'),
    });

    const caps = provider.providerType ? providerCapabilities(provider.providerType) : null;
    push({
      key: 'driverTools',
      ok: !!caps?.toolCalling,
      status: caps?.toolCalling ? 'ok' : 'blocked',
      actor: 'dm',
      title: 'Driver tool capability',
      detail: caps?.toolCalling
        ? `${provider.providerType} supports tool calls for live Driver play.`
        : 'Driver requires a provider with tool-calling support.',
      requiredForDriver: true,
      fixHref: fix('ai-dm-provider'),
    });

    const driverChecks = checks.filter((check) => check.requiredForDriver);
    const driverOk = driverChecks.every((check) => check.ok);
    const firstBlocked = driverChecks.find((check) => !check.ok);
    // Per-turn estimate. When this campaign has metered turns on record we use their mean
    // (real data beats a guess); otherwise we fall back to a conservative default shape.
    // It is deliberately NOT clamped to the remaining budget: a run that would overrun the
    // budget must still show its true expected size — `budgetRemaining` reports the ceiling
    // separately, and the budget check above is what actually blocks the run.
    const estimatedTotalTokens = recentUsage ?? DEFAULT_ESTIMATED_PROMPT_TOKENS + DEFAULT_ESTIMATED_COMPLETION_TOKENS;
    const estimatedCompletionTokens = Math.round(estimatedTotalTokens * DEFAULT_COMPLETION_SHARE);
    const estimatedPromptTokens = estimatedTotalTokens - estimatedCompletionTokens;
    return {
      campaignId,
      // A check that is not `ok` never counts as ready — including one whose status is
      // `unknown` because the caller cannot see it (the server flag, for a non-admin DM).
      // Only `warning` checks (advisory, never blocking) may be false and still be ready.
      ok: checks.every((check) => check.ok || check.status === 'warning'),
      driverOk,
      mode: seat.mode,
      provider,
      budgetRemaining,
      checks,
      estimatedCost: {
        estimatedPromptTokens,
        estimatedCompletionTokens,
        estimatedTotalTokens: estimatedPromptTokens + estimatedCompletionTokens,
        estimatedUsd: null,
        note: recentUsage
          ? 'Per-turn estimate from this campaign’s recent metered turns. Actual usage depends on context, tools, and model pricing.'
          : 'Best-effort per-turn estimate before sending to the provider — this campaign has no metered turns yet. Actual usage depends on context, tools, and model pricing.',
      },
      driverUnavailableReason: firstBlocked?.detail ?? null,
    };
  }

  /**
   * Driver mode (issue #311) hands the DM seat to the AI, so it carries hard
   * preconditions beyond the server experimental flag (already asserted by every
   * configure): a POSITIVE token budget AND a configured provider (a campaign
   * override or the server default — see AiProviderConfigService). Selecting
   * `driver` without both is a 409 with a clear, actionable reason. `off`/`co_dm`
   * have no such gate (co_dm only ever proposes into the approval queue).
   */
  private async assertDriverAllowed(campaignId: number, resultingTokenBudget: number): Promise<void> {
    if (resultingTokenBudget <= 0) {
      throw new ConflictException(
        'Driver mode requires a positive token budget. Set a budget first, then switch the mode to Driver.',
      );
    }
    const effective = await this.providerConfig.getEffectiveView(campaignId);
    if (!effective.configured || !effective.ready) {
      throw new ConflictException(
        'Driver mode requires a configured AI provider. Set a provider (or a server default) with an API key, then switch the mode to Driver.',
      );
    }
    const execution = await this.providerConfig.resolveExecutionModel(campaignId);
    if (!execution) {
      throw new ConflictException(
        'Driver mode requires an executable AI model. Set a provider model that passes the server allowlist, then switch the mode to Driver.',
      );
    }
    if (!providerCapabilities(execution.config.providerType).toolCalling) {
      throw new ConflictException(
        `Driver mode requires a provider with tool-calling support. ${execution.config.providerType} cannot run the live Driver seat.`,
      );
    }
  }

  /** Configure the seat (dm only). Gated on the server experimental flag. Upserts; omitted fields are left unchanged. */
  async configure(campaignId: number, input: AiDmSeatUpdateInput, user: RequestUser): Promise<AiDmSeat> {
    await this.assertExperimentalEnabled();
    const ts = nowIso();
    const existing = await this.findRow(campaignId);
    const current = existing ? toDomain(existing) : defaultSeat(campaignId);

    // The mode/budget that WILL be in effect after this update (omitted => unchanged).
    const resultingMode: AiDmMode = input.mode ?? current.mode;
    const resultingTokenBudget = input.tokenBudget ?? current.tokenBudget;
    // Re-validate the driver preconditions only when this write actually touches the
    // mode or the budget — so editing e.g. `instructions` on an already-driver seat is
    // never blocked by a later provider/budget change, but selecting Driver (or lowering
    // the budget while in Driver) is.
    if (resultingMode === 'driver' && (input.mode !== undefined || input.tokenBudget !== undefined)) {
      await this.assertDriverAllowed(campaignId, resultingTokenBudget);
    }

    // `enabled` is the legacy per-seat turn-gate; `mode` (off/co-dm/driver) is the operating
    // control the UI actually exposes. Keep them consistent: choosing any active mode enables
    // the seat and 'off' disables it, unless the caller sets `enabled` explicitly. Without this
    // the UI's mode picker (which PUTs only {mode}) would leave enabled=false, and every turn —
    // co-DM and Driver alike — would be refused with "seat is not enabled".
    const nextEnabled: boolean | undefined =
      input.enabled !== undefined
        ? input.enabled
        : input.mode !== undefined
          ? input.mode !== 'off'
          : undefined;

    if (!existing) {
      const base = defaultSeat(campaignId);
      await this.db.insert(aiDmSeats).values({
        campaignId,
        mode: input.mode ?? base.mode,
        enabled: nextEnabled ?? base.enabled,
        model: input.model ?? base.model,
        instructions: input.instructions ?? base.instructions,
        tokenBudget: input.tokenBudget ?? base.tokenBudget,
        actionQueueDepth: input.actionQueueDepth ?? base.actionQueueDepth,
        tokensUsed: 0,
        turnCount: 0,
        lastTurnAt: null,
        createdAt: ts,
        updatedAt: ts,
        proactiveSettings: (input.proactiveSettings ?? base.proactiveSettings) as any,
      });
    } else {
      await this.db
        .update(aiDmSeats)
        .set({
          ...(input.mode !== undefined ? { mode: input.mode } : {}),
          ...(nextEnabled !== undefined ? { enabled: nextEnabled } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
          ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
          ...(input.proactiveSettings !== undefined ? { proactiveSettings: input.proactiveSettings as any } : {}),
          ...(input.actionQueueDepth !== undefined ? { actionQueueDepth: input.actionQueueDepth } : {}),
          updatedAt: ts,
        })
        .where(eq(aiDmSeats.campaignId, campaignId));
    }

    const changed = Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined);
    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'dm',
      action: 'ai-dm.configure',
      entityType: 'ai-dm',
      campaignId,
      detail: changed.join(', ') || 'no-op',
    });

    this.proactiveSettingsCallback?.(campaignId, input.proactiveSettings, nextEnabled ?? current.enabled);

    // Leaving Driver must drop the live in-memory session (status/state/actingDm/vote/stuck).
    // Otherwise a driver→off→driver cycle can strand the seat behind a human_control handback
    // the DM has no reason to perform (#1071).
    if (current.mode === 'driver' && resultingMode !== 'driver') {
      this.driverSessionTeardown?.(campaignId);
    }

    return this.getSeat(campaignId);
  }

  /** Reset the metering counters (tokensUsed/turnCount/lastTurnAt) without changing config. dm only, experimental-gated. */
  async resetUsage(campaignId: number, user: RequestUser): Promise<AiDmSeat> {
    await this.assertExperimentalEnabled();
    const existing = await this.findRow(campaignId);
    if (existing) {
      await this.db
        .update(aiDmSeats)
        .set({ tokensUsed: 0, turnCount: 0, lastTurnAt: null, updatedAt: nowIso() })
        .where(eq(aiDmSeats.campaignId, campaignId));
    }
    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'dm',
      action: 'ai-dm.reset',
      entityType: 'ai-dm',
      campaignId,
    });
    return this.getSeat(campaignId);
  }

  /**
   * The AI DM takes a turn: the provider produces narration, and its token cost is
   * metered against the per-campaign budget. Gated on the server experimental flag,
   * the seat being enabled, and having budget remaining. The server performs no LLM
   * call itself — text comes from the injected provider (no-op by default).
   */
  async takeTurn(campaignId: number, input: AiDmTurnRequestInput, user: RequestUser): Promise<AiDmTurnResult> {
    await this.assertExperimentalEnabled();

    const existing = await this.findRow(campaignId);
    const seat = existing ? toDomain(existing) : defaultSeat(campaignId);
    if (!seat.enabled) {
      throw new ForbiddenException(
        'The AI Dungeon Master seat is not enabled for this campaign. Configure it first: PUT /campaigns/:id/ai-dm {enabled:true, tokenBudget:N}.',
      );
    }

    const remaining = seat.tokenBudget - seat.tokensUsed;
    if (remaining <= 0) {
      throw new ForbiddenException(
        `AI Dungeon Master token budget exhausted (${seat.tokensUsed}/${seat.tokenBudget}). Raise tokenBudget or reset usage to continue.`,
      );
    }

    // Server-wide HARD token cap (issue #315 admin console). When set (>0), the
    // aggregate tokens metered across EVERY seat may not exceed it — a per-campaign
    // budget still having room doesn't override the server ceiling. Checked here so
    // a turn is stopped with a clear reason before any (potential) provider spend.
    await this.assertWithinServerTokenCap();

    // Issue #564: the executable model derives ONLY from the effective provider config
    // (allowlist-validated at execution), NEVER from the legacy `seat.model` label. When
    // a provider is configured we resolve + revalidate its model here; the legacy no-op
    // seam (the default in a stock install) ignores the model, so falling back to '' for
    // an unconfigured provider keeps the existing scaffold behavior unchanged.
    const execModel = (await this.resolveExecutionModel(campaignId)) ?? '';

    const maxTokens = Math.min(input.maxTokens ?? DEFAULT_MAX_TOKENS, remaining);
    const result = await this.provider.generate({
      campaignId,
      kind: input.kind,
      prompt: input.prompt,
      instructions: seat.instructions,
      model: execModel,
      maxTokens,
    });

    const tokensUsed = Math.max(0, Math.floor(result.tokensUsed));
    const ts = nowIso();

    // Meter the turn's token cost atomically (issue #272). The old shape read
    // seat.tokensUsed, computed newTokensUsed = tokensUsed + n in JS, then wrote it back
    // across the provider await — two concurrent turns could each read the same
    // tokensUsed and the second UPDATE would clobber the first, under-counting the budget
    // (a governance cap must not rely on better-sqlite3 happening to serialize the two
    // separate statements). We increment IN SQL inside a transaction (mirroring
    // EncountersService.updateCombatant's read-write-in-one-tx idiom) and capture the
    // post-update total from the same statement's RETURNING. `MIN(token_budget, ...)`
    // preserves the old clamp so the counter never overshoots the cap — the turn landing
    // on/over the cap still runs, but the next one 403s (remaining<=0).
    let newTokensUsed = 0;
    if (existing) {
      this.db.transaction((tx) => {
        const [updated] = tx
          .update(aiDmSeats)
          .set({
            tokensUsed: sql`MIN(${aiDmSeats.tokenBudget}, ${aiDmSeats.tokensUsed} + ${tokensUsed})`,
            turnCount: sql`${aiDmSeats.turnCount} + 1`,
            lastTurnAt: ts,
            updatedAt: ts,
          })
          .where(eq(aiDmSeats.campaignId, campaignId))
          .returning()
          .all();
        newTokensUsed = updated.tokensUsed;
      });
    } else {
      // enabled seat with no persisted row is impossible (defaultSeat.enabled=false),
      // but guard anyway so an enabled-in-memory seat never silently drops metering. A
      // single INSERT is atomic on its own, so no read-modify-write race applies here.
      newTokensUsed = Math.min(seat.tokenBudget, seat.tokensUsed + tokensUsed);
      await this.db.insert(aiDmSeats).values({
        campaignId,
        enabled: seat.enabled,
        model: seat.model,
        instructions: seat.instructions,
        tokenBudget: seat.tokenBudget,
        tokensUsed: newTokensUsed,
        turnCount: 1,
        lastTurnAt: ts,
        createdAt: ts,
        updatedAt: ts,
      });
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'dm',
      action: 'ai-dm.turn',
      entityType: 'ai-dm',
      campaignId,
      // Issue #564: audit the EXACT model sent (resolved + allowlist-validated), not the
      // legacy seat.model label.
      detail: `${input.kind} via ${this.provider.name} model=${execModel || 'default'} (+${tokensUsed} tokens, ${newTokensUsed}/${seat.tokenBudget})`,
    });

    // #1060: same per-turn history contract as meterTurn — takeTurn meters
    // independently and must not skip the history row.
    await this.recordUsageHistory({
      campaignId,
      tokensUsed,
      action: 'ai-dm.turn',
      model: execModel || existing?.model || seat.model || '',
      actor: auditActor(user),
      createdAt: ts,
    });

    const updatedSeat = await this.getSeat(campaignId);
    return {
      narration: result.narration,
      provider: this.provider.name,
      kind: input.kind,
      tokensUsed,
      tokenBudget: seat.tokenBudget,
      budgetRemaining: Math.max(0, seat.tokenBudget - newTokensUsed),
      seat: updatedSeat,
    };
  }

  /**
   * Assert the seat may run an autonomous driver turn (#312): the server-wide
   * experimental flag is on, the seat exists AND is enabled, and it has budget
   * remaining. Returns the seat. Same gates/messages as takeTurn(), factored out so
   * the driver runtime (AiDriverService) reuses them without duplicating the policy.
   */
  async assertRunnable(campaignId: number): Promise<AiDmSeat> {
    await this.assertExperimentalEnabled();
    const existing = await this.findRow(campaignId);
    const seat = existing ? toDomain(existing) : defaultSeat(campaignId);
    if (!seat.enabled) {
      throw new ForbiddenException(
        'The AI Dungeon Master seat is not enabled for this campaign. Configure it first: PUT /campaigns/:id/ai-dm {enabled:true, tokenBudget:N}.',
      );
    }
    // The autonomous DRIVER loop may run ONLY in driver mode (#376). `enabled` alone must never
    // arm it: choosing Co-DM (the propose-only mode) sets enabled=true, and an explicit
    // {enabled:true, mode:'off'} is also enabled — neither may drive live-play writes. Co-DM and
    // scribe are propose-only and have their own gates; only driver mode holds the DM seat.
    if (seat.mode !== 'driver') {
      throw new ForbiddenException(
        `The AI Dungeon Master is in ${seat.mode === 'co_dm' ? 'Co-DM' : 'Off'} mode. The autonomous driver runs only in Driver mode — switch the mode to Driver (PUT /campaigns/:id/ai-dm {mode:'driver'}) to run turns.`,
      );
    }
    if (seat.tokenBudget - seat.tokensUsed <= 0) {
      throw new ForbiddenException(
        `AI Dungeon Master token budget exhausted (${seat.tokensUsed}/${seat.tokenBudget}). Raise tokenBudget or reset usage to continue.`,
      );
    }
    const effective = await this.providerConfig.getEffectiveView(campaignId);
    if (!effective.configured || !effective.ready) {
      throw new ForbiddenException(
        'Driver mode requires a configured AI provider. Set a provider (or a server default) with an API key, then switch the mode to Driver.',
      );
    }
    const execution = await this.providerConfig.resolveExecutionModel(campaignId);
    if (!execution) {
      throw new ForbiddenException(
        'Driver mode requires an executable AI model. Set a provider model that passes the server allowlist, then switch the mode to Driver.',
      );
    }
    if (!providerCapabilities(execution.config.providerType).toolCalling) {
      throw new ForbiddenException(
        `Driver mode requires a provider with tool-calling support. ${execution.config.providerType} cannot run the live Driver seat.`,
      );
    }
    // The driver is the path that actually spends provider tokens — bound it by the server-wide
    // admin cap too (#384/#315), not just the per-campaign budget.
    await this.assertWithinServerTokenCap();
    return seat;
  }

  /**
   * Atomically meter ONE driver step's REAL token usage against the per-campaign
   * budget and audit it (#312) — the same read-write-in-one-tx idiom takeTurn() uses
   * for #272 (MIN(token_budget, ...) clamp so the counter never overshoots the cap).
   * Returns the seat after metering + budget remaining. The driver calls this after
   * every provider stream so a long session's budget is a HARD stop, step by step.
   */
  async meterTurn(
    campaignId: number,
    tokensUsed: number,
    audit: { actor: string; action?: string; detail?: string; model?: string },
  ): Promise<{ seat: AiDmSeat; tokensUsed: number; budgetRemaining: number }> {
    const cost = Math.max(0, Math.floor(tokensUsed));
    const ts = nowIso();
    const existing = await this.findRow(campaignId);
    let newTokensUsed = 0;
    let tokenBudget = 0;
    if (existing) {
      tokenBudget = existing.tokenBudget;
      this.db.transaction((tx) => {
        const [updated] = tx
          .update(aiDmSeats)
          .set({
            tokensUsed: sql`MIN(${aiDmSeats.tokenBudget}, ${aiDmSeats.tokensUsed} + ${cost})`,
            turnCount: sql`${aiDmSeats.turnCount} + 1`,
            lastTurnAt: ts,
            updatedAt: ts,
          })
          .where(eq(aiDmSeats.campaignId, campaignId))
          .returning()
          .all();
        newTokensUsed = updated.tokensUsed;
      });
    } else {
      // assertRunnable guarantees an enabled row upstream, but stay honest if called bare.
      newTokensUsed = cost;
    }

    await this.audit.log({
      actor: audit.actor,
      actorRole: 'dm',
      action: audit.action ?? 'ai-dm.driver.turn',
      entityType: 'ai-dm',
      campaignId,
      detail: audit.detail ?? `+${cost} tokens, ${newTokensUsed}/${tokenBudget}`,
    });

    // Fall back to the seat's configured model when callers omit audit.model so
    // history rows stay populated for existing driver/scribe/co-DM call sites.
    const model = (audit.model?.trim() || existing?.model || '').trim();
    await this.recordUsageHistory({
      campaignId,
      tokensUsed: cost,
      action: audit.action ?? 'ai-dm.driver.turn',
      model,
      actor: audit.actor,
      createdAt: ts,
    });

    return {
      seat: await this.getSeat(campaignId),
      tokensUsed: cost,
      budgetRemaining: Math.max(0, tokenBudget - newTokensUsed),
    };
  }

  /**
   * Best-effort per-turn history write (#1060). Shared by takeTurn + meterTurn so
   * every successfully metered spend produces one history row. Failures are logged
   * but never rethrown — metering/budget must not fail because history did.
   */
  private async recordUsageHistory(row: {
    campaignId: number;
    tokensUsed: number;
    action: string;
    model: string;
    actor: string;
    createdAt: string;
  }): Promise<void> {
    if (row.tokensUsed <= 0) return;
    try {
      await this.db.insert(aiDmUsageHistory).values(row);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `ai_dm_usage_history insert failed for campaign ${row.campaignId} action=${row.action} tokens=${row.tokensUsed}: ${message}`,
      );
    }
  }

  /**
   * List per-turn usage history for a campaign (issue #1060). Newest-first, capped at
   * `limit` (default 100, max 500). Used by the DM's usage sparkline and the audit view.
   * The endpoint that exposes this is DM-only; the read itself is unfiltered because
   * history is DM-only material by construction.
   */
  async listUsageHistory(
    campaignId: number,
    opts: { limit?: number; sinceIso?: string } = {},
  ): Promise<AiDmUsageHistoryResponse> {
    const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
    const conditions = [eq(aiDmUsageHistory.campaignId, campaignId)];
    if (opts.sinceIso) {
      conditions.push(gte(aiDmUsageHistory.createdAt, normalizeSinceIso(opts.sinceIso)));
    }
    const rows = await this.db
      .select()
      .from(aiDmUsageHistory)
      .where(conditions.length === 1 ? conditions[0] : and(...conditions))
      // id DESC breaks ties when concurrent meters share a millisecond timestamp.
      .orderBy(desc(aiDmUsageHistory.createdAt), desc(aiDmUsageHistory.id))
      .limit(limit);

    const items: AiDmUsageHistoryEntry[] = rows.map((r) => ({
      id: r.id,
      campaignId: r.campaignId,
      tokensUsed: r.tokensUsed,
      action: r.action,
      model: r.model,
      actor: r.actor,
      createdAt: r.createdAt,
    }));
    const totalTokens = items.reduce((sum, r) => sum + r.tokensUsed, 0);
    return { items, totalTokens, count: items.length };
  }
}

/** Validate + canonicalize `?since=` to UTC ISO so TEXT comparisons are chronological. */
function normalizeSinceIso(sinceIso: string): string {
  const trimmed = sinceIso.trim();
  if (!trimmed) {
    throw new BadRequestException('since must be a valid ISO-8601 timestamp');
  }
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    throw new BadRequestException('since must be a valid ISO-8601 timestamp');
  }
  return new Date(ms).toISOString();
}
