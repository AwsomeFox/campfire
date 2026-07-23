import { ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { AiDmMode, AiDmSeat, AiDmSeatUpdate, AiDmTurnRequest, AiDmTurnResult, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { aiDmSeats } from '../../db/schema';
import { nowIso } from '../../common/time';
import { auditActor, type RequestUser } from '../../common/user.types';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { AiProviderConfigService } from '../ai-provider-config/ai-provider-config.service';
import { AI_DM_PROVIDER, type AiDmProvider } from './ai-dm.provider';

type AiDmSeatUpdateInput = z.infer<typeof AiDmSeatUpdate>;
type AiDmTurnRequestInput = z.infer<typeof AiDmTurnRequest>;

/** Default per-turn output cap when the caller doesn't specify maxTokens. */
const DEFAULT_MAX_TOKENS = 512;

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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
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
  /**
   * Optional hook invoked when configure leaves Driver mode (#1071). Wired by
   * AiDriverService at construction so the seat path can tear down the live
   * in-memory driver session without creating an AiDm→AiDriver DI cycle.
   */
  private driverSessionTeardown: ((campaignId: number) => void) | null = null;

  /**
   * Per-campaign budget-spend serialization (#1058). Prevents the driver and
   * scribe from both passing the budget gate simultaneously and making provider
   * calls that the SQL clamp will later cap. Callers acquire before the provider
   * call and release after metering.
   */
  private readonly spendLocks = new Map<number, Promise<void>>();

  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly providerConfig: AiProviderConfigService,
    @Inject(AI_DM_PROVIDER) private readonly provider: AiDmProvider,
  ) {}

  /**
   * Acquire an advisory spend-lock for a campaign (#1058). Returns a release
   * function that the caller MUST invoke after metering. This serializes
   * provider-call + meter pairs so concurrent spenders can't both pass the
   * budget gate before either meters.
   */
  async acquireSpendLock(campaignId: number): Promise<() => void> {
    // Wait for any prior holder to release.
    while (this.spendLocks.has(campaignId)) {
      await this.spendLocks.get(campaignId);
    }
    // Plant our own lock.
    let release!: () => void;
    const lock = new Promise<void>((resolve) => { release = resolve; });
    this.spendLocks.set(campaignId, lock);
    return () => {
      this.spendLocks.delete(campaignId);
      release();
    };
  }

  /** Register the driver-session teardown used when the seat leaves Driver mode (#1071). */
  registerDriverSessionTeardown(fn: (campaignId: number) => void): void {
    this.driverSessionTeardown = fn;
  }

  /** 403 unless the server-wide experimental flag is on. The single choke point for the whole feature. */
  private async assertExperimentalEnabled(): Promise<void> {
    const all = await this.settings.getAll();
    if (!all.experimentalAiDm) {
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
    const { aiServerTokenCap: cap } = await this.settings.getAll();
    if (!cap || cap <= 0) return;
    const [agg] = await this.db
      .select({ total: sql<number>`COALESCE(SUM(${aiDmSeats.tokensUsed}), 0)` })
      .from(aiDmSeats);
    const total = Number(agg?.total ?? 0);
    if (total >= cap) {
      throw new ForbiddenException(
        `Server-wide AI token cap reached (${total}/${cap}). A server admin must raise it in the AI console (PUT /settings/ai/caps) or reset usage to continue.`,
      );
    }
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
    const effective = await this.providerConfig.resolveEffectiveConfig(campaignId);
    if (!effective) {
      throw new ConflictException(
        'Driver mode requires a configured AI provider. Set a provider (or a server default) with an API key, then switch the mode to Driver.',
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
        tokensUsed: 0,
        turnCount: 0,
        lastTurnAt: null,
        createdAt: ts,
        updatedAt: ts,
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
    audit: { actor: string; action?: string; detail?: string },
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

    return {
      seat: await this.getSeat(campaignId),
      tokensUsed: cost,
      budgetRemaining: Math.max(0, tokenBudget - newTokensUsed),
    };
  }
}
