import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { and, desc, eq, gt, gte, sql } from 'drizzle-orm';
import type { z } from 'zod';
import {
  AI_DM_SEAT_INHERITED_FIELDS,
  AiDmProactiveSettings,
  AiDmSeatDefaults,
} from '@campfire/schema';
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
import { aiDmSeats, aiDmUsageHistory, settings } from '../../db/schema';
import { nowIso } from '../../common/time';
import { auditActor, type RequestUser } from '../../common/user.types';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { AiProviderConfigService } from '../ai-provider-config/ai-provider-config.service';
import { AI_DM_PROVIDER, type AiDmProvider } from './ai-dm.provider';
import { SessionZeroService } from '../session-zero/session-zero.service';
import { SupportPreferencesService } from '../session-zero/support-preferences.service';
import { providerCapabilities } from './providers';
import type { AiProviderConfig } from './providers/factory';

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

export interface AiDmTokenReservation {
  campaignId: number;
  tokensReserved: number;
  tokenBudget: number;
  /**
   * Set the instant the hold is released from `tokens_reserved` — by meterTurn() or
   * markReservationUsageUnknown(). A reservation must be settled EXACTLY once: leaving
   * it unsettled strands campaign budget forever, settling it twice double-charges the
   * seat (once as used, once as unknown). Both settle paths flip this flag immediately
   * after their DB transaction commits and no-op when it is already true, so callers can
   * safely wrap metering in a try/catch that falls back to the unknown path (#563).
   */
  settled: boolean;
}

function budgetRemainingFor(seat: {
  tokenBudget: number;
  tokensUsed: number;
  tokensReserved: number;
  tokensUnknown: number;
}): number {
  return Math.max(0, seat.tokenBudget - seat.tokensUsed - seat.tokensReserved - seat.tokensUnknown);
}


function toDomain(row: typeof aiDmSeats.$inferSelect): AiDmSeat {
  return {
    campaignId: row.campaignId,
    mode: (row.mode as AiDmMode) ?? 'off',
    enabled: row.enabled,
    model: row.model,
    instructions: row.instructions,
    tokenBudget: row.tokenBudget,
    tokensUsed: row.tokensUsed,
    tokensReserved: row.tokensReserved,
    tokensRefunded: row.tokensRefunded,
    tokensUnknown: row.tokensUnknown,
    tokensOverage: row.tokensOverage,
    budgetRemaining: budgetRemainingFor(row),
    turnCount: row.turnCount,
    lastTurnAt: row.lastTurnAt,
    actionQueueDepth: row.actionQueueDepth ?? 8,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    proactiveSettings: AiDmProactiveSettings.parse(row.proactiveSettings ?? {}),
    // #1070: a persisted seat inherits nothing. Detach is whole-seat on first configure,
    // matching the provider's row-granularity override, so a configured campaign is its own
    // truth and must not report otherwise.
    inheritedFields: [],
  };
}

/**
 * In-memory default seat for a campaign that has never configured one — never persisted.
 *
 * `defaults` are the server-wide values from {@link AiDmService.getSeatDefaults} (#1070).
 * Passing them makes this seat the LIVE inherited view: a campaign with no row tracks the
 * server defaults until the moment it saves, exactly as a campaign with no provider override
 * tracks the server provider row. `inheritedFields` names what came from there, so a DM can
 * see an inherited token budget BEFORE enabling the seat — the point at which it could spend.
 *
 * Called with no `defaults` it behaves exactly as it did before #1070, which is what keeps
 * the pure/unit call sites (and any caller that has no DB handle) working unchanged.
 */
function defaultSeat(campaignId: number, defaults?: AiDmSeatDefaults): AiDmSeat {
  const ts = nowIso();
  return {
    campaignId,
    mode: defaults?.mode ?? 'off',
    enabled: false, // never inherited: switching a seat on is a human's decision (#1070)
    model: '',
    instructions: defaults?.instructions ?? '',
    tokenBudget: defaults?.tokenBudget ?? 0,
    tokensUsed: 0,
    tokensReserved: 0,
    tokensRefunded: 0,
    tokensUnknown: 0,
    tokensOverage: 0,
    budgetRemaining: 0,
    turnCount: 0,
    lastTurnAt: null,
    proactiveSettings: {
      enabled: false,
      triggers: { encounterEnded: true, hpCritical: true, objectiveCompleted: true },
      cooldownSeconds: 300,
      maxProactiveTokensPerHour: 5000,
    },
    actionQueueDepth: defaults?.actionQueueDepth ?? 8,
    // Only report a field as inherited when a server default actually supplied a value that
    // differs from the built-in fallback — otherwise every untouched install would claim to
    // be inheriting the same zeros it would have produced anyway.
    inheritedFields: defaults ? inheritedFieldsFor(defaults) : [],
    createdAt: ts,
    updatedAt: ts,
  };
}

/** Which server defaults actually differ from the built-in fallbacks (#1070). */
function inheritedFieldsFor(defaults: AiDmSeatDefaults): string[] {
  const fallback = AiDmSeatDefaults.parse({});
  return AI_DM_SEAT_INHERITED_FIELDS.filter((field) => defaults[field] !== fallback[field]);
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
export class AiDmService implements OnApplicationBootstrap {
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

  /**
   * Reservations live in the DB but the in-flight provider calls that own them live in
   * memory, so a crash/restart mid-call leaves `tokens_reserved` held by nobody (#563).
   * Nothing would ever release it and the seat's usable budget would shrink permanently.
   * Campfire is a single-process SQLite deployment, so at bootstrap no provider call can
   * legitimately still be in flight: every surviving hold is stale. Convert them to
   * unknown spend rather than refunding — provider contact may well have happened and
   * really cost tokens, and the budget gate must stay conservative (issue #563: "never
   * clamp away actual/unknown spend"). Clean shutdowns settle their holds, so a normal
   * restart finds nothing to do here.
   */
  async onApplicationBootstrap(): Promise<void> {
    const stale = await this.db
      .select({ campaignId: aiDmSeats.campaignId, tokensReserved: aiDmSeats.tokensReserved })
      .from(aiDmSeats)
      .where(gt(aiDmSeats.tokensReserved, 0));
    if (stale.length === 0) return;

    const ts = nowIso();
    this.db.transaction((tx) => {
      tx.update(aiDmSeats)
        .set({
          tokensUnknown: sql`${aiDmSeats.tokensUnknown} + ${aiDmSeats.tokensReserved}`,
          tokensReserved: 0,
          updatedAt: ts,
        })
        .where(gt(aiDmSeats.tokensReserved, 0))
        .run();
    });

    for (const row of stale) {
      this.logger.warn(
        `Reclaimed a stale AI token reservation left by a previous run (campaign=${row.campaignId}, tokens=${row.tokensReserved}); recorded as unknown spend.`,
      );
      await this.audit.log({
        actor: 'system',
        actorRole: 'dm',
        action: 'ai-dm.reservation_reclaimed',
        entityType: 'ai-dm',
        campaignId: row.campaignId,
        detail: `stale reservation=${row.tokensReserved} from a previous process recorded as unknown spend`,
      });
    }
  }

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
      .select({
        total: sql<number>`COALESCE(SUM(${aiDmSeats.tokensUsed} + ${aiDmSeats.tokensReserved} + ${aiDmSeats.tokensUnknown}), 0)`,
      })
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
    // #1070: the server-defaults read happens ONLY on the inheritance path — a campaign that
    // has configured its seat resolves from its own row and never touches `settings`. That
    // matters because SettingsService.getJson hits SQLite on every call (no cache), and the
    // per-turn hot path must not gain a query for a value it cannot use.
    return row ? toDomain(row) : defaultSeat(campaignId, await this.getSeatDefaults());
  }

  /**
   * Server-wide AI seat defaults (#1070), or the built-in fallbacks when an admin has set none.
   *
   * Stored as one JSON value in the existing `settings` key/value table rather than a new
   * table, so this needed no migration at all. A malformed or partial stored value falls back
   * per-field through zod rather than throwing — a bad default must not be able to break every
   * campaign's seat read.
   */
  async getSeatDefaults(): Promise<AiDmSeatDefaults> {
    return this.settings.getAiSeatDefaults();
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
    // Use the SAME formula the spend gates use (#563 added tokensReserved/tokensUnknown to
    // budgetRemainingFor). Computing it as tokenBudget - tokensUsed here would let readiness
    // report budget available while in-flight reservations or unknown spend have actually
    // exhausted the seat — reopening for the campaign budget precisely the readiness-says-
    // green-then-403 divergence this issue closed for the server cap.
    const budgetRemaining = budgetRemainingFor(seat);
    const fix = (hash: string) => `/c/${campaignId}/settings#${hash}`;
    const checks: AiDmReadinessCheck[] = [];
    const push = (check: AiDmReadinessCheck) => checks.push(check);

    // Disclosure decision (#519 review): this reports the server-wide AI flag's real value
    // to any campaign DM, where the old client-side checklist showed non-admins only an
    // "ask your admin" note. That is deliberate, not drift. The flag is not a secret — every
    // AI gate already answers a member with a 403 that names it, and an admin-only console
    // read is not what kept it private. Telling a DM *why* the AI is unavailable is strictly
    // more useful than a vague "ask someone": it is the difference between a dead end and a
    // copyable request (see the `serverFlag` extra in AiSetupChecklist). The one thing we do
    // NOT do is imply the DM can act on it: `status` stays 'unknown' rather than 'blocked'
    // for a non-admin, and `fixHref` is null, so the row reads as someone else's step.
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
      detailKey: settings.experimentalAiDm ? 'serverFlag.on' : opts.isAdmin ? 'serverFlag.offAdmin' : 'serverFlag.offMember',
      detailParams: {},
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
      detailKey: serverCap.cap <= 0 ? 'serverCap.none' : serverCap.withinCap ? 'serverCap.within' : 'serverCap.reached',
      detailParams: { total: serverCap.total, cap: serverCap.cap },
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
      detailKey: provider.configured
        ? provider.ready
          ? 'provider.ready'
          : 'provider.noCredential'
        : 'provider.unconfigured',
      detailParams: {
        providerType: provider.providerType ?? 'provider',
        model: provider.model ?? 'model',
        source: provider.source ?? 'configuration',
        credentialSource: provider.credentialSource,
      },
      requiredForDriver: true,
      fixHref: fix('ai-dm-provider'),
    });

    let modelOk = provider.configured && provider.ready;
    let modelDetail = provider.model
      ? `Model ${provider.model} is selected.`
      : 'Choose the model that will execute AI requests.';
    let modelDetailKey = provider.model ? 'model.selected' : 'model.choose';
    let modelDetailParams: Record<string, string | number> = { model: provider.model ?? '' };
    try {
      // Readiness is a plain GET that a settings UI may poll, and it sends NOTHING outbound,
      // so it must not drag the DNS-resolving half of the baseUrl gate onto the read path —
      // that would let a polling client drive a resolver lookup per poll. The literal host
      // policy and the model allowlist still run here, and the rebinding defense itself is
      // untouched: `createAiProviderGuardedFetch` re-resolves and pins addresses on every
      // real outbound request, which is where it actually matters.
      const execution = await this.providerConfig.resolveExecutionModel(campaignId, { resolveDns: false });
      modelOk = !!execution;
      if (execution) {
        modelDetail = `Execution model ${execution.model} passes the server allowlist.`;
        modelDetailKey = 'model.allowed';
        modelDetailParams = { model: execution.model };
      }
    } catch (err) {
      modelOk = false;
      modelDetail = err instanceof Error ? err.message : 'The selected model is not executable.';
      // The rejection reason is composed by the allowlist policy at throw time and has no
      // enumerable id, so this variant carries the server sentence through as a parameter.
      modelDetailKey = 'model.rejected';
      modelDetailParams = { reason: modelDetail };
    }
    push({
      key: 'model',
      ok: modelOk,
      status: modelOk ? 'ok' : 'blocked',
      actor: 'dm',
      title: 'Executable model',
      detail: modelDetail,
      detailKey: modelDetailKey,
      detailParams: modelDetailParams,
      requiredForDriver: true,
      fixHref: fix('ai-dm-provider'),
    });

    // The gating step every other check silently assumed (#519 review): a table can have a
    // provider, a model and a budget and still have the AI switched OFF. `assertRunnable`
    // refuses an off/disabled seat, so readiness must report it rather than let the client
    // paint a green "ready" banner over an AI that does nothing. It is deliberately NOT
    // `requiredForDriver` — that set answers "is the configuration driver-capable", while
    // the driver ALSO needs mode === 'driver' specifically (folded into `driverOk` below);
    // marking it driver-required would either fail Co-DM tables or read as ok for a Co-DM
    // seat the driver cannot use.
    const seatArmed = seat.enabled && seat.mode !== 'off';
    push({
      key: 'mode',
      ok: seatArmed,
      status: seatArmed ? 'ok' : 'blocked',
      actor: 'dm',
      title: 'Operating mode',
      detail: !seatArmed
        ? 'The AI DM is off for this campaign. Pick Co-DM (it only proposes) or Driver (it holds the DM seat) to switch it on.'
        : seat.mode === 'driver'
          ? 'Driver mode is selected — the AI holds the DM seat and acts directly.'
          : 'Co-DM mode is selected — the AI only proposes, and a human DM approves every change.',
      detailKey: !seatArmed ? 'mode.off' : seat.mode === 'driver' ? 'mode.driver' : 'mode.coDm',
      detailParams: {},
      requiredForDriver: false,
      fixHref: fix('ai-dm-mode'),
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
      detailKey: seat.tokenBudget > 0 ? 'budget.available' : 'budget.unset',
      detailParams: { used: seat.tokensUsed, budget: seat.tokenBudget, remaining: budgetRemaining },
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
      detailKey: writeScope === 'direct' ? 'writeMode.direct' : writeScope === 'none' ? 'writeMode.readOnly' : 'writeMode.proposalOnly',
      detailParams: {},
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
      detailKey: contentCount > 0 ? 'rulesContent.present' : 'rulesContent.missing',
      detailParams: {},
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
      detailKey: consent.total === 0 ? 'supportConsent.none' : 'supportConsent.counts',
      detailParams: { consented: consent.consented, total: consent.total, tableConsented: consent.tableConsented },
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
      detailKey: 'secretPolicy.body',
      detailParams: {},
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
      detailKey: caps?.toolCalling ? 'driverTools.ok' : 'driverTools.missing',
      detailParams: { providerType: provider.providerType ?? 'provider' },
      requiredForDriver: true,
      fixHref: fix('ai-dm-provider'),
    });

    const driverChecks = checks.filter((check) => check.requiredForDriver);
    // `driverOk` must answer the same question `assertRunnable` does — "would a driver turn
    // start right now?" — or the checklist paints a green banner over a 403. `assertRunnable`
    // demands an ENABLED seat in DRIVER mode on top of the configuration checks, and none of
    // those checks looks at the seat's mode, so fold it in here (#519 review).
    const driverModeReady = seat.enabled && seat.mode === 'driver';
    const driverOk = driverChecks.every((check) => check.ok) && driverModeReady;
    const firstBlocked = driverChecks.find((check) => !check.ok);
    const driverModeReason = driverModeReady
      ? null
      : seat.mode === 'co_dm'
        ? 'The AI DM is in Co-DM mode. Switch the operating mode to Driver to run autonomous turns.'
        : 'The AI DM is off for this campaign. Switch the operating mode to Driver to run autonomous turns.';
    // Per-turn estimate. When this campaign has metered turns on record we use their mean
    // (real data beats a guess); otherwise we fall back to a conservative default shape.
    // It is deliberately NOT clamped to the remaining budget: a run that would overrun the
    // budget must still show its true expected size — `budgetRemaining` reports the ceiling
    // separately, and the budget check above is what actually blocks the run.
    // Parenthesized deliberately: `+` binds tighter than `??`, so the intent is already what
    // this reads — but an unparenthesized mix of the two is a silent-breakage trap for the
    // next edit, and this value is a spend estimate a DM makes decisions on.
    const estimatedTotalTokens =
      recentUsage ?? (DEFAULT_ESTIMATED_PROMPT_TOKENS + DEFAULT_ESTIMATED_COMPLETION_TOKENS);
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
      driverUnavailableReason: firstBlocked?.detail ?? driverModeReason,
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
    // `resolveExecutionModel` does not signal every failure by returning null — it THROWS
    // BadRequest when the model is off a tightened allowlist or the stored baseUrl fails
    // host policy. Left uncaught, tightening the allowlist would answer this gate with a
    // 400 while every neighbouring rejection in it is a 409, and the client would have to
    // sniff the message string to tell them apart. Re-raise as this gate's own status with
    // the reason preserved, so the HTTP contract is coherent per gate.
    const execution = await this.resolveExecutionModelForGate(
      campaignId,
      (reason) => new ConflictException(reason),
      'Driver mode requires an executable AI model. Set a provider model that passes the server allowlist, then switch the mode to Driver.',
    );
    if (!providerCapabilities(execution.config.providerType).toolCalling) {
      throw new ConflictException(
        `Driver mode requires a provider with tool-calling support. ${execution.config.providerType} cannot run the live Driver seat.`,
      );
    }
  }

  /**
   * Shared adapter between {@link AiProviderConfigService.resolveExecutionModel} and the two
   * driver gates. It normalizes BOTH failure shapes — the `null` return (nothing configured)
   * and the thrown `BadRequestException` (allowlist tightened, stored baseUrl now blocked) —
   * into the status the calling gate promises, keeping the underlying reason as the message
   * so the UI's gate explainer still has something specific to say.
   *
   * `resolveDns` is passed through: a gate that is immediately followed by the real provider
   * resolution (assertRunnable → runTurn) leaves the DNS-resolving revalidation to that one
   * call rather than doing it twice per turn.
   */
  private async resolveExecutionModelForGate(
    campaignId: number,
    wrap: (reason: string) => Error,
    unconfiguredReason: string,
    opts: { resolveDns?: boolean } = {},
  ): Promise<{ model: string; config: AiProviderConfig }> {
    let execution: { model: string; config: AiProviderConfig } | null;
    try {
      execution = await this.providerConfig.resolveExecutionModel(campaignId, opts);
    } catch (err) {
      if (err instanceof BadRequestException) {
        const response = err.getResponse();
        const reason =
          typeof response === 'string'
            ? response
            : ((response as { message?: string | string[] }).message ?? err.message);
        throw wrap(Array.isArray(reason) ? reason.join(' ') : reason);
      }
      throw err;
    }
    if (!execution) throw wrap(unconfiguredReason);
    return execution;
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
      // #1070: seed the new row from the server defaults for every field this call did not
      // specify. Detaching is whole-seat, so without seeding the act of saving ONE field
      // would silently revert the others to the built-in zeros the DM never chose.
      const base = defaultSeat(campaignId, await this.getSeatDefaults());
      await this.db.insert(aiDmSeats).values({
        campaignId,
        mode: input.mode ?? base.mode,
        enabled: nextEnabled ?? base.enabled,
        model: input.model ?? base.model,
        instructions: input.instructions ?? base.instructions,
        tokenBudget: input.tokenBudget ?? base.tokenBudget,
        actionQueueDepth: input.actionQueueDepth ?? base.actionQueueDepth,
        tokensUsed: 0,
        tokensReserved: 0,
        tokensRefunded: 0,
        tokensUnknown: 0,
        tokensOverage: 0,
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
        .set({
          tokensUsed: 0,
          tokensReserved: 0,
          tokensRefunded: 0,
          tokensUnknown: 0,
          tokensOverage: 0,
          turnCount: 0,
          lastTurnAt: null,
          updatedAt: nowIso(),
        })
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
   * Atomically reserve the worst-case tokens a provider call may spend before any
   * provider contact (#563). The reservation consumes both the campaign budget and
   * the server-wide cap until it is finalized by meterTurn() or
   * markReservationUsageUnknown(). When less capacity remains than requested, the
   * caller receives the smaller reservation and must clamp provider maxTokens to it.
   */
  async reserveTokenBudget(campaignId: number, requestedTokens: number): Promise<AiDmTokenReservation> {
    const requested = Math.max(0, Math.floor(requestedTokens));
    if (requested <= 0) {
      throw new ForbiddenException('AI Dungeon Master token budget exhausted (0 tokens available).');
    }

    let reservation: AiDmTokenReservation | undefined;
    this.db.transaction((tx) => {
      const [seat] = tx.select().from(aiDmSeats).where(eq(aiDmSeats.campaignId, campaignId)).limit(1).all();
      if (!seat) {
        throw new ForbiddenException(
          'The AI Dungeon Master seat is not enabled for this campaign. Configure it first: PUT /campaigns/:id/ai-dm {enabled:true, tokenBudget:N}.',
        );
      }
      if (!seat.enabled) {
        throw new ForbiddenException(
          'The AI Dungeon Master seat is not enabled for this campaign. Configure it first: PUT /campaigns/:id/ai-dm {enabled:true, tokenBudget:N}.',
        );
      }

      const campaignAvailable = budgetRemainingFor(seat);
      if (campaignAvailable <= 0) {
        throw new ForbiddenException(
          `AI Dungeon Master token budget exhausted (${seat.tokensUsed + seat.tokensUnknown + seat.tokensReserved}/${seat.tokenBudget}). Raise tokenBudget or reset usage to continue.`,
        );
      }

      const [capRow] = tx
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, 'aiServerTokenCap'))
        .limit(1)
        .all();
      let serverCap = 0;
      if (capRow?.value !== undefined) {
        try {
          serverCap = Number(JSON.parse(capRow.value));
        } catch {
          serverCap = 0;
        }
      }

      let serverAvailable = Number.POSITIVE_INFINITY;
      if (serverCap > 0) {
        const [agg] = tx
          .select({
            total: sql<number>`COALESCE(SUM(${aiDmSeats.tokensUsed} + ${aiDmSeats.tokensReserved} + ${aiDmSeats.tokensUnknown}), 0)`,
          })
          .from(aiDmSeats)
          .all();
        const total = Number(agg?.total ?? 0);
        serverAvailable = Math.max(0, serverCap - total);
        if (serverAvailable <= 0) {
          throw new ForbiddenException(
            `Server-wide AI token cap reached (${total}/${serverCap}). A server admin must raise it in the AI console (PUT /settings/ai/caps) or reset usage to continue.`,
          );
        }
      }

      const tokensReserved = Math.min(requested, campaignAvailable, serverAvailable);
      if (tokensReserved <= 0) {
        throw new ForbiddenException('AI Dungeon Master token budget exhausted (0 tokens available).');
      }

      const [updated] = tx
        .update(aiDmSeats)
        .set({
          tokensReserved: sql`${aiDmSeats.tokensReserved} + ${tokensReserved}`,
          updatedAt: nowIso(),
        })
        .where(eq(aiDmSeats.campaignId, campaignId))
        .returning()
        .all();
      reservation = {
        campaignId,
        tokensReserved,
        tokenBudget: updated.tokenBudget,
        settled: false,
      };
    });

    if (!reservation) {
      throw new ForbiddenException('AI Dungeon Master token budget exhausted (0 tokens available).');
    }
    return reservation;
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

    // Issue #564: the executable model derives ONLY from the effective provider config
    // (allowlist-validated at execution), NEVER from the legacy `seat.model` label. When
    // a provider is configured we resolve + revalidate its model here; the legacy no-op
    // seam (the default in a stock install) ignores the model, so falling back to '' for
    // an unconfigured provider keeps the existing scaffold behavior unchanged.
    const execModel = (await this.resolveExecutionModel(campaignId)) ?? '';

    const reservation = await this.reserveTokenBudget(campaignId, input.maxTokens ?? DEFAULT_MAX_TOKENS);
    let result: Awaited<ReturnType<AiDmProvider['generate']>>;
    try {
      result = await this.provider.generate({
        campaignId,
        kind: input.kind,
        prompt: input.prompt,
        instructions: seat.instructions,
        model: execModel,
        maxTokens: reservation.tokensReserved,
      });
    } catch (err) {
      await this.releaseReservationQuietly(reservation, {
        actor: auditActor(user),
        action: 'ai-dm.turn.unknown',
        detail: `${input.kind} via ${this.provider.name} model=${execModel || 'default'} usage unknown after provider error`,
        model: execModel,
      });
      throw err;
    }

    const tokensUsed = Math.max(0, Math.floor(result.tokensUsed));
    const metered = await this.meterTurn(
      campaignId,
      tokensUsed,
      {
        actor: auditActor(user),
        action: 'ai-dm.turn',
        // Issue #564: audit the EXACT model sent (resolved + allowlist-validated), not the
        // legacy seat.model label.
        detail: `${input.kind} via ${this.provider.name} model=${execModel || 'default'} (+${tokensUsed} tokens, reserved=${reservation.tokensReserved})`,
        model: execModel || existing?.model || seat.model || '',
      },
      reservation,
    );

    const updatedSeat = await this.getSeat(campaignId);
    return {
      narration: result.narration,
      provider: this.provider.name,
      kind: input.kind,
      tokensUsed,
      tokenBudget: seat.tokenBudget,
      budgetRemaining: metered.budgetRemaining,
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
    const remaining = budgetRemainingFor(seat);
    if (remaining <= 0) {
      throw new ForbiddenException(
        `AI Dungeon Master token budget exhausted (${seat.tokensUsed + seat.tokensUnknown + seat.tokensReserved}/${seat.tokenBudget}). Raise tokenBudget or reset usage to continue.`,
      );
    }
    const effective = await this.providerConfig.getEffectiveView(campaignId);
    if (!effective.configured || !effective.ready) {
      throw new ForbiddenException(
        'Driver mode requires a configured AI provider. Set a provider (or a server default) with an API key, then switch the mode to Driver.',
      );
    }
    // Same status-coherence adapter as assertDriverAllowed, but this gate answers 403.
    // `resolveDns: false` here because the caller (AiDriverService.runTurn) resolves the
    // provider for real moments later through the execution choke point, which DOES resolve
    // DNS — doing it in both made every driver turn perform two resolver lookups for one
    // request. The rebinding defense is unchanged: the guarded fetch re-resolves and pins
    // addresses per outbound request, and the allowlist + literal host policy still run here.
    const execution = await this.resolveExecutionModelForGate(
      campaignId,
      (reason) => new ForbiddenException(reason),
      'Driver mode requires an executable AI model. Set a provider model that passes the server allowlist, then switch the mode to Driver.',
      { resolveDns: false },
    );
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
   * Finalize ONE provider spend. With a reservation (#563), this refunds unused
   * capacity, records known overage instead of clamping it away, and releases the
   * in-flight hold. The no-reservation path remains for tests/internal callers but
   * provider contact paths should reserve first.
   *
   * A reservation handed to this method is ALWAYS settled, including when metering
   * throws: an un-released hold permanently shrinks the campaign's usable budget until
   * an admin resets usage, so a transient failure must never strand one. Callers
   * therefore do not need their own try/catch, and one that has a fallback to
   * markReservationUsageUnknown() is safe — the second settle no-ops.
   */
  async meterTurn(
    campaignId: number,
    tokensUsed: number,
    audit: { actor: string; action?: string; detail?: string; model?: string },
    reservation?: AiDmTokenReservation,
  ): Promise<{ seat: AiDmSeat; tokensUsed: number; budgetRemaining: number }> {
    if (reservation && reservation.campaignId !== campaignId) {
      throw new BadRequestException('AI token reservation does not belong to this campaign');
    }
    try {
      return await this.meterTurnInner(campaignId, tokensUsed, audit, reservation);
    } catch (err) {
      // The release transaction may or may not have committed before the throw (the
      // audit + history writes that follow it are un-guarded DB inserts). `settled`
      // records which: unsettled means the hold is still on the seat and must be
      // consumed as unknown spend; settled means the spend is already booked and
      // consuming it again would charge the same tokens twice.
      if (reservation && !reservation.settled) {
        try {
          await this.markReservationUsageUnknown(reservation, {
            actor: audit.actor,
            action: 'ai-dm.meter_failed',
            detail: `metering failed before the reservation was released; consumed reservation=${reservation.tokensReserved} as unknown spend`,
            model: audit.model,
          });
        } catch (releaseErr) {
          this.logger.error(
            `Failed to release AI token reservation (campaign=${campaignId}, tokens=${reservation.tokensReserved}) after a metering error: ${
              releaseErr instanceof Error ? releaseErr.message : String(releaseErr)
            }`,
          );
        }
      }
      throw err;
    }
  }

  private async meterTurnInner(
    campaignId: number,
    tokensUsed: number,
    audit: { actor: string; action?: string; detail?: string; model?: string },
    reservation?: AiDmTokenReservation,
  ): Promise<{ seat: AiDmSeat; tokensUsed: number; budgetRemaining: number }> {
    const cost = Math.max(0, Math.floor(tokensUsed));
    const reserved = reservation?.tokensReserved ?? 0;
    // Refund/overage are meaningful only RELATIVE to a pre-call reservation. Without one
    // there is no baseline, so booking the whole cost as overage would fabricate an
    // overrun for legacy/internal metering callers.
    const refunded = reservation ? Math.max(0, reserved - cost) : 0;
    const overage = reservation ? Math.max(0, cost - reserved) : 0;
    const ts = nowIso();
    const existing = await this.findRow(campaignId);
    let updatedRow: (typeof aiDmSeats.$inferSelect) | undefined;
    let tokenBudget = 0;
    if (existing) {
      tokenBudget = existing.tokenBudget;
      this.db.transaction((tx) => {
        const [updated] = tx
          .update(aiDmSeats)
          .set({
            tokensReserved: sql`MAX(0, ${aiDmSeats.tokensReserved} - ${reserved})`,
            tokensUsed: sql`${aiDmSeats.tokensUsed} + ${cost}`,
            tokensRefunded: sql`${aiDmSeats.tokensRefunded} + ${refunded}`,
            tokensOverage: sql`${aiDmSeats.tokensOverage} + ${overage}`,
            turnCount: sql`${aiDmSeats.turnCount} + 1`,
            lastTurnAt: ts,
            updatedAt: ts,
          })
          .where(eq(aiDmSeats.campaignId, campaignId))
          .returning()
          .all();
        updatedRow = updated;
      });
      // The hold is off the seat as of the commit above. Everything after this point
      // (audit, usage history) is bookkeeping that must not re-consume it.
      if (reservation) reservation.settled = true;
    } else {
      // assertRunnable guarantees an enabled row upstream, but stay honest if called bare.
      tokenBudget = reservation?.tokenBudget ?? 0;
      // No row to decrement means there is no hold left to strand either.
      if (reservation) reservation.settled = true;
    }

    await this.audit.log({
      actor: audit.actor,
      actorRole: 'dm',
      action: audit.action ?? 'ai-dm.driver.turn',
      entityType: 'ai-dm',
      campaignId,
      detail:
        audit.detail ??
        `+${cost} tokens, reserved=${reserved}, refunded=${refunded}, overage=${overage}, ${updatedRow?.tokensUsed ?? cost}/${tokenBudget}`,
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
      budgetRemaining: updatedRow ? budgetRemainingFor(updatedRow) : Math.max(0, tokenBudget - cost),
    };
  }

  /**
   * Provider contact happened but usage is unknown (e.g. a stream failed before a
   * usage block). Do not refund the reservation: consume it as unknown spend so
   * future budget gates stay conservative and the UI can surface the state (#563).
   *
   * Idempotent: a reservation already released by meterTurn() is left alone. Callers
   * that fall back here after a metering error cannot tell whether the release
   * transaction committed before the error, and consuming an already-released hold
   * would charge the same tokens twice (once as used, once as unknown).
   */
  async markReservationUsageUnknown(
    reservation: AiDmTokenReservation,
    audit: { actor: string; action?: string; detail?: string; model?: string },
  ): Promise<{ seat: AiDmSeat; tokensUnknown: number; budgetRemaining: number }> {
    if (reservation.settled) {
      const seat = await this.getSeat(reservation.campaignId);
      return { seat, tokensUnknown: 0, budgetRemaining: seat.budgetRemaining };
    }
    const ts = nowIso();
    let updatedRow: (typeof aiDmSeats.$inferSelect) | undefined;
    this.db.transaction((tx) => {
      const [updated] = tx
        .update(aiDmSeats)
        .set({
          tokensReserved: sql`MAX(0, ${aiDmSeats.tokensReserved} - ${reservation.tokensReserved})`,
          tokensUnknown: sql`${aiDmSeats.tokensUnknown} + ${reservation.tokensReserved}`,
          turnCount: sql`${aiDmSeats.turnCount} + 1`,
          lastTurnAt: ts,
          updatedAt: ts,
        })
        .where(eq(aiDmSeats.campaignId, reservation.campaignId))
        .returning()
        .all();
      updatedRow = updated;
    });
    reservation.settled = true;

    await this.audit.log({
      actor: audit.actor,
      actorRole: 'dm',
      action: audit.action ?? 'ai-dm.usage_unknown',
      entityType: 'ai-dm',
      campaignId: reservation.campaignId,
      detail: audit.detail ?? `usage unknown, consumed reservation=${reservation.tokensReserved}`,
    });

    return {
      seat: await this.getSeat(reservation.campaignId),
      tokensUnknown: reservation.tokensReserved,
      budgetRemaining: updatedRow ? budgetRemainingFor(updatedRow) : 0,
    };
  }

  /**
   * markReservationUsageUnknown() for `catch` blocks whose job is to surface the
   * ORIGINAL failure (a provider error, usually). Settling the hold is bookkeeping; if
   * it fails too, log it and let the real error reach the caller instead of masking it
   * with a database error (#563).
   */
  async releaseReservationQuietly(
    reservation: AiDmTokenReservation,
    audit: { actor: string; action?: string; detail?: string; model?: string },
  ): Promise<void> {
    try {
      await this.markReservationUsageUnknown(reservation, audit);
    } catch (err) {
      this.logger.error(
        `Failed to release AI token reservation (campaign=${reservation.campaignId}, tokens=${reservation.tokensReserved}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
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
