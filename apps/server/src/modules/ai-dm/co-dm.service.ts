import {
  ForbiddenException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import {
  NpcCreate,
  LocationCreate,
  QuestCreate,
  SessionCreate,
  FactionCreate,
  EncounterGenerate,
  GenerateMapParams,
} from '@campfire/schema';
import type { CoDmDraftRequest, CoDmDraftResult, CoDmDraftTarget, Proposal, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { aiDmSeats } from '../../db/schema';
import { nowIso } from '../../common/time';
import { auditActor, type RequestUser } from '../../common/user.types';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { ProposalRecordsService, type ProposableEntityType } from '../proposals/proposal-records.service';
import { AiDmService } from './ai-dm.service';
import { AI_DM_PROVIDER, type AiDmProvider } from './ai-dm.provider';
import { createAiProvider, type AiProvider } from './providers';
import { AiProviderConfigService } from '../ai-provider-config/ai-provider-config.service';

type CoDmDraftRequestInput = z.infer<typeof CoDmDraftRequest>;

/** Upper bound on a draft turn's output, before the remaining-budget clamp. */
const DRAFT_MAX_TOKENS = 4096;

/** Which proposal entity type each co-DM target files under. */
const TARGET_ENTITY_TYPE: Record<CoDmDraftTarget, ProposableEntityType> = {
  npc: 'npc',
  location: 'location',
  beat: 'quest', // a story beat / next objective is filed as a quest (#27)
  quest: 'quest', // a direct quest draft (#1056)
  faction: 'faction', // a faction draft (#1056)
  recap: 'session', // a session recap is filed as a session
  encounter: 'encounter',
  map: 'map',
};

/** Targets that support drafting N items at once; the rest ignore `count`. */
const MULTI_TARGETS = new Set<CoDmDraftTarget>(['npc', 'location', 'beat', 'quest', 'faction']);

/**
 * Co-DM authoring (issue #313) — the AI drafts content for the DM's approval queue.
 *
 * Given a DM brief ("make a shady fence NPC", "build a level-3 ambush"), this asks the
 * configured provider (the injected AI_DM_PROVIDER seam — a real model in production via
 * #312, the no-op scaffold in a stock install) for STRUCTURED content, then files it as a
 * PENDING PROPOSAL (#124) — never a direct write. The human DM reviews/approves/rejects it,
 * and only on approve does it land in canon (through the same write path a manual create
 * would take). Encounters/maps reuse the deterministic generators (#304/#306): the proposal
 * carries their seeded params and approval re-runs the generator.
 *
 * Gating mirrors the AI DM turn path: the server-wide experimentalAiDm flag AND an enabled
 * seat with remaining budget. Role gating (dm-only) is enforced by the controller/MCP tool.
 * The draft's token cost is metered against the seat budget (#272), and the proposer is
 * attributed to the AI seat + model — not the DM's name or a raw token.
 */
@Injectable()
export class CoDmService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly settings: SettingsService,
    private readonly aiDm: AiDmService,
    private readonly records: ProposalRecordsService,
    private readonly audit: AuditService,
    @Inject(AI_DM_PROVIDER) private readonly provider: AiDmProvider,
    private readonly providerConfig: AiProviderConfigService,
  ) {}

  /** 403 unless the server-wide experimental flag is on — the same choke point as the AI DM seat. */
  private async assertExperimentalEnabled(): Promise<void> {
    const all = await this.settings.getAll();
    if (!all.experimentalAiDm) {
      throw new ForbiddenException(
        'Server-side AI Dungeon Master is experimental and disabled. A server admin must enable it via PATCH /settings {experimentalAiDm:true}.',
      );
    }
  }

  /**
   * Draft content for the given target and file it as pending proposal(s). Returns the
   * proposal ids (never a direct write). Gated on the experimental flag + an enabled,
   * budgeted seat; the draft's token cost is metered against the seat.
   */
  async draft(campaignId: number, input: CoDmDraftRequestInput, user: RequestUser, role: Role): Promise<CoDmDraftResult> {
    await this.assertExperimentalEnabled();

    const seat = await this.aiDm.getSeat(campaignId);
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
    // Server-wide admin token cap (#384/#315): a co-DM draft spends provider tokens too, so it
    // must respect the global ceiling — a per-campaign budget with room doesn't override it.
    await this.aiDm.assertWithinServerTokenCap();

    const count = MULTI_TARGETS.has(input.target) ? input.count ?? 1 : 1;
    const maxTokens = Math.min(DRAFT_MAX_TOKENS, remaining);

    // Issue #564: the executable model derives ONLY from the effective provider config
    // (allowlist-validated at execution via AiDmService.resolveExecutionModel), NEVER from
    // the legacy `seat.model` label. Falling back to '' for an unconfigured provider keeps
    // the legacy no-op seam's behavior unchanged.
    const execModel = (await this.aiDm.resolveExecutionModel(campaignId)) ?? '';

    // Ask the provider for structured content. The persona (seat.instructions) is combined
    // with a target-specific "reply as JSON" directive; the DM's brief is the user turn.
    //
    // Issue #987: resolve the dynamically-configured provider (AiProviderConfigService →
    // createAiProvider) when one exists, mirroring ScribeService's pattern. Without this,
    // CoDmService always used the injected AI_DM_PROVIDER (NoopAiDmProvider by default),
    // so a configured provider's drafts were served by the no-op scaffold — which fails
    // JSON parsing (422). When no provider is configured, fall back to the legacy seam.
    const instructions = this.buildInstructions(seat.instructions, input.target, count);
    const config = await this.providerConfig.resolveEffectiveConfig(campaignId);

    let narration: string;
    let tokensUsed: number;
    let resolvedModel: string;

    if (config) {
      const aiProvider: AiProvider = createAiProvider(config);
      const result = await aiProvider.generate({
        system: instructions,
        messages: [{ role: 'user', content: input.prompt }],
        model: config.model,
        maxTokens,
      });
      narration = result.text;
      tokensUsed = result.usage.totalTokens;
      resolvedModel = config.model;
    } else {
      const result = await this.provider.generate({
        campaignId,
        kind: input.target === 'recap' ? 'recap' : 'narrate',
        prompt: input.prompt,
        instructions,
        model: execModel,
        maxTokens,
      });
      narration = result.narration;
      tokensUsed = result.tokensUsed;
      resolvedModel = execModel;
    }

    // Turn the provider text into validated proposal payloads for the target's entity type.
    const entityType = TARGET_ENTITY_TYPE[input.target];
    const payloads = this.toPayloads(input.target, narration, count);

    // Attribute the proposal to the AI seat + model, not the triggering DM (issue #313).
    // The label reflects the model that actually served the draft when a provider is
    // configured (resolved + allowlisted, issue #564). When NO provider is configured
    // (the legacy no-op seam — the shipped default), there is no executable model, so the
    // informational label falls back to the legacy `seat.model` text the DM set. That label
    // is DISPLAY-ONLY: it never drives execution (execModel above is '' in this branch, and
    // the no-op provider ignores it).
    const modelLabel = resolvedModel || seat.model || 'unconfigured';
    const attribution = {
      proposer: `AI DM (${modelLabel})`,
      proposerUserId: `ai-dm:${campaignId}`,
      proposerToken: null,
    };

    const proposals: Proposal[] = [];
    for (const payload of payloads) {
      proposals.push(await this.records.create(campaignId, entityType, null, 'create', payload, user, role, attribution));
    }

    const clampedTokens = Math.max(0, Math.floor(tokensUsed));
    const newTokensUsed = this.meterUsage(campaignId, seat.tokenBudget, clampedTokens);

    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'dm',
      action: 'ai-dm.draft',
      entityType: 'ai-dm',
      campaignId,
      detail: `${input.target} → ${proposals.length} ${entityType} proposal(s) via ${this.provider.name} (+${tokensUsed} tokens)`,
    });

    return {
      target: input.target,
      provider: this.provider.name,
      // Issue #564: report the EXACT model that served the draft (resolved + allowlisted)
      // when a provider is configured. When NO provider is configured (the legacy no-op
      // seam — execModel is ''), fall back to the legacy seat.model label so the response
      // still carries an informational model string (the field is documented as "the seat's
      // model label"), matching the proposer attribution label below.
      model: execModel || seat.model || '',
      entityType,
      proposalIds: proposals.map((p) => p.id),
      proposals,
      tokensUsed,
      tokenBudget: seat.tokenBudget,
      budgetRemaining: Math.max(0, seat.tokenBudget - newTokensUsed),
    };
  }

  /**
   * Meter the draft's token cost atomically against the seat budget (issue #272 idiom):
   * increment IN SQL, clamped to the budget, inside a transaction so concurrent drafts/turns
   * can't clobber each other's read-modify-write. Returns the post-update tokensUsed.
   */
  private meterUsage(campaignId: number, tokenBudget: number, tokensUsed: number): number {
    let total = tokenBudget;
    this.db.transaction((tx) => {
      const [updated] = tx
        .update(aiDmSeats)
        .set({
          tokensUsed: sql`MIN(${aiDmSeats.tokenBudget}, ${aiDmSeats.tokensUsed} + ${tokensUsed})`,
          updatedAt: nowIso(),
        })
        .where(eq(aiDmSeats.campaignId, campaignId))
        .returning()
        .all();
      // An enabled seat always has a persisted row (defaultSeat is disabled), so `updated`
      // exists; fall back to the budget defensively if it somehow doesn't.
      total = updated ? updated.tokensUsed : tokenBudget;
    });
    return total;
  }

  /** Persona + a target-specific instruction to reply with strict JSON the server can parse. */
  private buildInstructions(persona: string, target: CoDmDraftTarget, count: number): string {
    const base = persona ? `${persona}\n\n` : '';
    const shape = DRAFT_JSON_SHAPE[target];
    const arrayNote =
      MULTI_TARGETS.has(target) && count > 1
        ? `Return a JSON ARRAY of exactly ${count} such objects.`
        : 'Return a single JSON object.';
    return (
      `${base}You are drafting D&D content for the DM to review. Reply with ONLY JSON — no prose, ` +
      `no markdown fences. ${arrayNote} Each object matches: ${shape}`
    );
  }

  /**
   * Parse the provider text into one or more validated payloads for the target's entity
   * type. Every payload is validated (and unknown keys stripped) against the target's Create
   * schema, so what's stored applies cleanly on approve. encounter/map tolerate a missing/
   * non-JSON reply — they fall back to sensible generator defaults — and always pin a seed so
   * the approved generation is reproducible. Other targets require a JSON draft (recap falls
   * back to using the raw text as the recap body).
   */
  private toPayloads(target: CoDmDraftTarget, narration: string, count: number): Record<string, unknown>[] {
    const parsed = extractJson(narration);

    switch (target) {
      case 'npc':
      case 'location':
      case 'beat':
      case 'quest':
      case 'faction': {
        if (parsed === null) {
          throw new UnprocessableEntityException(
            `The AI did not return a JSON ${target} draft. Configure a real provider (the default no-op scaffold cannot author content) or retry.`,
          );
        }
        const items = Array.isArray(parsed) ? parsed : [parsed];
        return items
          .filter((it): it is Record<string, unknown> => it !== null && typeof it === 'object' && !Array.isArray(it))
          .slice(0, count)
          .map((raw) => this.validate(target, raw));
      }
      case 'recap': {
        const obj = firstObject(parsed);
        const recap = typeof obj?.recap === 'string' && obj.recap.trim() ? obj.recap : narration.trim();
        const title = typeof obj?.title === 'string' ? obj.title : undefined;
        return [this.validate('recap', { recap, ...(title ? { title } : {}) })];
      }
      case 'encounter':
      case 'map':
        return [this.validate(target, firstObject(parsed) ?? {})];
    }
  }

  /** Normalize + strict-shape a raw draft object into the stored proposal payload. */
  private validate(target: CoDmDraftTarget, raw: Record<string, unknown>): Record<string, unknown> {
    try {
      switch (target) {
        case 'npc':
          return NpcCreate.parse(raw) as Record<string, unknown>;
        case 'location':
          return LocationCreate.parse(raw) as Record<string, unknown>;
        case 'beat':
          // A "beat" is filed as a quest: map common narrative fields onto quest fields.
          return QuestCreate.parse({
            title: raw.title ?? raw.name ?? 'Untitled beat',
            body: raw.body ?? raw.summary ?? raw.description ?? '',
            ...(typeof raw.dmSecret === 'string' ? { dmSecret: raw.dmSecret } : {}),
          }) as Record<string, unknown>;
        case 'quest':
          return QuestCreate.parse({
            title: raw.title ?? raw.name ?? 'Untitled quest',
            body: raw.body ?? raw.description ?? '',
            ...(typeof raw.dmSecret === 'string' ? { dmSecret: raw.dmSecret } : {}),
            ...(typeof raw.status === 'string' ? { status: raw.status } : {}),
          }) as Record<string, unknown>;
        case 'faction':
          return FactionCreate.parse({
            name: raw.name ?? 'Untitled faction',
            ...(typeof raw.body === 'string' ? { body: raw.body } : {}),
            ...(typeof raw.standing === 'string' ? { standing: raw.standing } : {}),
            ...(typeof raw.dmSecret === 'string' ? { dmSecret: raw.dmSecret } : {}),
          }) as Record<string, unknown>;
        case 'recap':
          return SessionCreate.parse(raw) as Record<string, unknown>;
        case 'encounter':
          // Seed pinned so approve re-runs the identical generator (#304). Default a band.
          return EncounterGenerate.parse({
            difficulty: 'medium',
            ...raw,
            seed: typeof raw.seed === 'number' ? raw.seed : mintNumericSeed(),
          }) as Record<string, unknown>;
        case 'map':
          // Seed pinned so approve re-runs the identical generator (#306).
          return GenerateMapParams.parse({
            ...raw,
            seed: typeof raw.seed === 'string' && raw.seed ? raw.seed : mintStringSeed(),
          }) as Record<string, unknown>;
      }
    } catch (err) {
      throw new UnprocessableEntityException(
        `The AI draft for ${target} failed validation: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Per-target JSON hint the model is asked to fill (informational; the server re-validates). */
const DRAFT_JSON_SHAPE: Record<CoDmDraftTarget, string> = {
  npc: '{"name": string (required), "role"?: string, "disposition"?: string, "body"?: string, "dmSecret"?: string}',
  location:
    '{"name": string (required), "kind"?: string, "body"?: string, "dmSecret"?: string}',
  beat: '{"title": string (required), "body"?: string (markdown), "dmSecret"?: string}',
  quest:
    '{"title": string (required), "body"?: string (markdown), "status"?: "available"|"active"|"completed"|"failed", "dmSecret"?: string}',
  faction:
    '{"name": string (required), "body"?: string (markdown), "kind"?: string, "standing"?: "hostile"|"unfriendly"|"neutral"|"friendly"|"allied", "dmSecret"?: string}',
  recap: '{"title"?: string, "recap": string (markdown summary of the session)}',
  encounter:
    '{"difficulty": "trivial"|"easy"|"medium"|"hard"|"deadly", "count"?: number, "shape"?: string}',
  map: '{"kind"?: "dungeon"|"cave"|"wilderness", "size"?: "small"|"medium"|"large", "theme"?: string}',
};

/** A fresh uint32 seed for the encounter generator. */
function mintNumericSeed(): number {
  return crypto.randomBytes(4).readUInt32BE(0);
}

/** A fresh hex seed for the map generator. */
function mintStringSeed(): string {
  return crypto.randomBytes(8).toString('hex');
}

/** The first object from a parsed JSON value (unwrapping a single-element array). */
function firstObject(value: unknown): Record<string, unknown> | null {
  const v = Array.isArray(value) ? value[0] : value;
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Best-effort JSON extraction from model text: try a direct parse, then strip ``` fences,
 * then fall back to the first balanced {...} / [...] span. Returns null when nothing parses,
 * so the caller can decide whether that target tolerates a non-JSON reply.
 */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());

  const span = sliceBalanced(trimmed);
  if (span) candidates.push(span);

  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Extract the substring from the first `{`/`[` to its matching close, ignoring brackets in strings. */
function sliceBalanced(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start < 0) return null;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
