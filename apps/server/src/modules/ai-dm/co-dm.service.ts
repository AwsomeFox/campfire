import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import {
  NpcCreate,
  LocationCreate,
  QuestCreate,
  SessionCreate,
  FactionCreate,
  EncounterGenerate,
  GenerateMapParams,
  AI_EXTERNAL_PROVIDER_PRIVACY,
  normalizeMapTheme,
  buildNarrationLanguageContract,
  resolveNarrationLanguage,
  StoryBeatProposalCreate,
  StoryBeatUpdate,
  StoryArcUpdate,
  ruleSystemAdapter,
} from '@campfire/schema';
import type { AiExternalContentPolicy, AiGenerationProvenance, CoDmDraftRequest, CoDmDraftResult, CoDmDraftTarget, HomebrewMechanicsProfile, NarrationLanguage, Proposal, Role, RuleSystemAdapter } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { campaigns, rulePacks, storyArcs } from '../../db/schema';
import { auditActor, type RequestUser } from '../../common/user.types';
import { nowIso } from '../../common/time';
import { fromJsonText } from '../../common/json';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { ProposalRecordsService, type ProposableEntityType } from '../proposals/proposal-records.service';
import { AiDmService } from './ai-dm.service';
import { AI_DM_PROVIDER, type AiDmProvider } from './ai-dm.provider';
import { createAiProvider, type AiProvider } from './providers';
import { resolveProviderStepUsage } from './providers/step-usage';
import { isWithheldFinishReason, describeWithheldTurn } from '../ai-driver/driver-safety';
import { AiProviderConfigService } from '../ai-provider-config/ai-provider-config.service';
import { provenanceEndpointBaseUrl, resolveAiProvenanceEgress } from '../../common/ai-provenance-endpoint';
import { StorylinesService } from '../storylines/storylines.service';

type CoDmDraftRequestInput = z.infer<typeof CoDmDraftRequest>;

/** Upper bound on a draft turn's output, before the remaining-budget clamp. */
const DRAFT_MAX_TOKENS = 4096;
const CO_DM_PROMPT_VERSION = 'co-dm-draft-v3';
/** Roughly 25k tokens before system instructions; larger storylines should be edited beat-by-beat. */
const STORYLINE_PROVIDER_PROMPT_MAX_CHARS = 100_000;

/** Which proposal entity type each co-DM target files under. */
const TARGET_ENTITY_TYPE: Record<CoDmDraftTarget, ProposableEntityType> = {
  npc: 'npc',
  location: 'location',
  arc: 'story_arc',
  beat: 'story_beat',
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
 *
 * REST (`POST /campaigns/:id/ai-dm/draft`, `CoDmController`) and MCP (the equivalent tool
 * in `mcp-tools.ts`) both call `draft()` below directly — one method, so there is no second
 * copy of the consent/provenance logic to drift out of sync between the two surfaces.
 *
 * External-AI provenance (issue #1993): see the doc comment on `buildGenerationProvenance`
 * for the audited finding that this path carries no member-identifying surface, and why
 * `consent` is still recorded (truthfully, never omitted) on every draft rather than
 * gated — reusing the same campaign-level `aiExternalContentPolicy` scribe reads (#501).
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
    private readonly storylines: StorylinesService,
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
    const editing = input.entityId != null;
    if (input.target === 'arc' && !editing) {
      throw new BadRequestException('Story arcs can be rewritten with entityId; creating arcs with co-DM drafting is not supported');
    }
    if (editing && input.target !== 'arc' && input.target !== 'beat') {
      throw new BadRequestException('entityId is supported only when rewriting an existing story arc or beat');
    }
    if (editing && (input.arcId != null || input.count != null)) {
      throw new BadRequestException('arcId and count are not used when rewriting an existing storyline entity');
    }
    const edit = editing
      ? await this.storylines.getRewriteContext(campaignId, input.target as 'arc' | 'beat', input.entityId!)
      : null;
    const providerPrompt = edit
      ? JSON.stringify({ rewriteInstructions: input.prompt, currentStoryline: edit.providerContext })
      : input.prompt;
    if (edit && providerPrompt.length > STORYLINE_PROVIDER_PROMPT_MAX_CHARS) {
      throw new UnprocessableEntityException(
        'Storyline rewrite context is too large for AI editing. Rewrite a single beat or shorten the arc before retrying.',
      );
    }
    const count = MULTI_TARGETS.has(input.target) && !editing ? input.count ?? 1 : 1;
    if (input.target === 'beat' && input.arcId != null) {
      const [arc] = await this.db
        .select({ campaignId: storyArcs.campaignId })
        .from(storyArcs)
        .where(eq(storyArcs.id, input.arcId))
        .limit(1);
      if (!arc || arc.campaignId !== campaignId) {
        throw new BadRequestException(`Story arc ${input.arcId} does not belong to this campaign`);
      }
    }
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
    const [campaign] = await this.db
      .select({
        ruleSystem: campaigns.ruleSystem,
        customMechanicsProfile: campaigns.customMechanicsProfile,
        aiExternalContentPolicy: campaigns.aiExternalContentPolicy,
      })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);
    // Issue #1993: the SAME campaign-level policy scribe reads (#501) — reused here rather
    // than invented anew, and recorded truthfully on every draft's provenance (never left
    // undefined) so a reviewer can't confuse "the policy question was never asked" with
    // "it was asked and nothing was excluded". See the doc comment on `buildGenerationProvenance`
    // for why co-DM's answer to "what was excluded" is always zero.
    const campaignPolicy = (campaign?.aiExternalContentPolicy ?? 'member_consent') as AiExternalContentPolicy;

    const adapter = ruleSystemAdapter(
      campaign?.ruleSystem,
      fromJsonText<HomebrewMechanicsProfile | null>(campaign?.customMechanicsProfile, null),
    );

    let packVersion: string | null = null;
    if (campaign?.ruleSystem) {
      const [packRow] = await this.db
        .select({ version: rulePacks.version })
        .from(rulePacks)
        .where(eq(rulePacks.slug, campaign.ruleSystem))
        .limit(1);
      if (packRow) {
        packVersion = packRow.version;
      }
    }

    const instructions = this.buildInstructions(
      seat.instructions,
      input.target,
      count,
      await this.resolveLanguageContract(campaignId, input.narrationLanguage),
      adapter,
      campaign?.ruleSystem,
      editing,
    );
    // `endpointScope` here is the scope that OWNS the resolved endpoint, not merely
    // whether a campaign override row exists — a keyless override executes against the
    // SERVER endpoint (#501).
    const { config, endpointScope: resolvedEndpointScope } =
      await this.providerConfig.resolveEffectiveConfigWithEndpointScope(campaignId);
    // Issue #1993: whether this draft actually leaves the server. Shared with
    // `ScribeService`/`InboxSweepService` via `resolveAiProvenanceEgress` (common/
    // ai-provenance-endpoint.ts) so the three cannot drift on what "external" means — a
    // configured provider is external UNLESS the operator has declared the endpoint local
    // via `AI_PROVIDER_ENDPOINT_IS_LOCAL` (an on-box Ollama, for example).
    const externalSend = resolveAiProvenanceEgress(config !== null) === 'external';
    const reservation = await this.aiDm.reserveTokenBudget(campaignId, DRAFT_MAX_TOKENS);

    let narration = '';
    let tokensUsed = 0;
    // #598 review: absence of a measurement is not a measurement of zero. Set when the
    // provider reported no usage AND produced nothing to estimate from — see the settlement
    // below, which consumes the reservation instead of refunding it.
    let usageUnknown = false;
    // #598 review: the provider's terminal state. A safety refusal has to reach the DM as a
    // refusal; the external-provider branch below is the only one that can report one.
    let withheldNotice: string | null = null;
    let resolvedModel = '';
    // #501 provenance: which provider/model/endpoint actually produced the draft.
    // Only assigned on the success paths — a provider throw releases the reservation
    // and rethrows below, so no half-resolved provenance is ever recorded.
    let providerName = '';
    let providerType: string | null = null;
    let endpointScope: AiGenerationProvenance['endpoint']['scope'] = 'injected';
    let endpointBaseUrl: string | null = null;

    try {
      if (config) {
        const aiProvider: AiProvider = createAiProvider(config);
        const result = await aiProvider.generate({
          system: instructions,
          messages: [{ role: 'user', content: providerPrompt }],
          model: config.model,
          maxTokens: reservation.tokensReserved,
        });
        // #598 review: a safety refusal arrives with the prose already discarded by the
        // adapter, so `text` is empty and `usage` is frequently absent too — a Gemini PROMPT
        // block carries no candidate and no `usageMetadata` at all. Reading `totalTokens`
        // straight through therefore metered ZERO and refunded the whole reservation, so a
        // DM could retry a blocked draft indefinitely: the provider bills every attempt and
        // the seat's budget gate never advances. Same fail-open the driver path fixed; this
        // is the entry point that still had it.
        const resolved = resolveProviderStepUsage(result.text, result, result.refusalChars ?? 0);
        narration = result.text;
        tokensUsed = resolved.tokens;
        usageUnknown = resolved.unknown;
        if (isWithheldFinishReason(result.finishReason)) {
          withheldNotice = describeWithheldTurn(result.finishReason);
        }
        resolvedModel = result.model || config.model;
        providerName = aiProvider.name;
        providerType = config.providerType;
        // The scope that OWNS the endpoint, so a keyless campaign override running against
        // the server endpoint is recorded as 'server' — both truthful and the condition
        // the baseUrl gate below keys off (#501 review).
        endpointScope = resolvedEndpointScope ?? 'none';
        // Never persist the SERVER row's baseUrl — co-DM drafts are filed as DM-readable
        // proposals, and the admin-managed server endpoint is deliberately hidden from
        // campaign DMs (#501 review).
        endpointBaseUrl = provenanceEndpointBaseUrl(endpointScope, config.baseUrl);
      } else {
        const result = await this.provider.generate({
          campaignId,
          kind: input.target === 'recap' ? 'recap' : 'narrate',
          prompt: providerPrompt,
          instructions,
          model: execModel,
          maxTokens: reservation.tokensReserved,
        });
        narration = result.narration;
        tokensUsed = result.tokensUsed;
        resolvedModel = execModel;
        providerName = this.provider.name;
        providerType = null;
        endpointScope = providerName === 'noop' ? 'none' : 'injected';
      }
    } catch (err) {
      await this.aiDm.releaseReservationQuietly(reservation, {
        actor: auditActor(user),
        action: 'ai-dm.draft.unknown',
        detail: `${input.target} draft usage unknown after provider error`,
        model: config?.model ?? execModel,
      });
      throw err;
    }

    const clampedTokens = Math.max(0, Math.floor(tokensUsed));
    // Settle the reservation EXACTLY once, by whichever route the measurement justifies, and
    // ALWAYS before the parse below can throw — a throw between here and settlement would
    // strand the reservation and permanently shrink the campaign's budget (#598 review).
    const metered = usageUnknown
      ? await this.aiDm.markReservationUsageUnknown(reservation, {
          actor: auditActor(user),
          action: 'ai-dm.draft.unknown',
          detail: `${input.target} draft reported no usage and produced nothing measurable; settling reserved=${reservation.tokensReserved} as unknown spend rather than metering zero`,
          model: resolvedModel,
        })
      : await this.aiDm.meterTurn(
          campaignId,
          clampedTokens,
          {
            actor: auditActor(user),
            action: 'ai-dm.draft',
            detail: `${input.target} draft metering (+${clampedTokens} tokens, reserved=${reservation.tokensReserved})`,
            model: resolvedModel,
          },
          reservation,
        );

    // #598 review: report a safety refusal AS a refusal. Without this the empty text fell
    // through to `toPayloads`, which cannot find JSON in it and blames the operator's setup
    // ("Configure a real provider…") — a wrong diagnosis for a draft the provider declined on
    // purpose, and the one message guaranteed to send a DM off editing settings that are fine.
    // Deliberately after settlement, so a refused draft is still paid for.
    if (withheldNotice) {
      throw new UnprocessableEntityException(withheldNotice);
    }

    // Turn the provider text into validated proposal payloads for the target's entity type.
    const entityType = TARGET_ENTITY_TYPE[input.target];
    const payloads = this.toPayloads(input.target, narration, count, { arcId: input.arcId, adapter, editing });

    // Attribute the proposal to the AI seat + model, not the triggering DM (issue #313).
    // The label reflects the model that actually served the draft when a provider is
    // configured (resolved + allowlisted, issue #564). When NO provider is configured
    // (the legacy no-op seam — the shipped default), there is no executable model, so the
    // informational label falls back to the legacy `seat.model` text the DM set. That label
    // is DISPLAY-ONLY: it never drives execution (execModel above is '' in this branch, and
    // the no-op provider ignores it).
    const modelLabel = resolvedModel || seat.model || 'unconfigured';
    const generationProvenance = this.buildGenerationProvenance({
      target: input.target,
      prompt: providerPrompt,
      instructions,
      provider: providerName,
      providerType,
      model: modelLabel,
      endpointScope,
      endpointBaseUrl,
      ruleset: { id: adapter.id, pack: campaign?.ruleSystem || null, version: packVersion },
      campaignPolicy,
      externalSend,
      sourceContextHash: edit?.contextHash ?? null,
    });
    const attribution = {
      proposer: `AI DM (${modelLabel})`,
      proposerUserId: `ai-dm:${campaignId}`,
      proposerToken: null,
      generationProvenance,
    };

    const proposals: Proposal[] = [];
    for (const payload of payloads) {
      proposals.push(
        await this.records.create(
          campaignId,
          entityType,
          input.entityId ?? null,
          editing ? 'update' : 'create',
          payload,
          user,
          role,
          attribution,
          edit?.baseSnapshot,
        ),
      );
    }

    await this.audit.log({
      actor: auditActor(user),
      actorRole: 'dm',
      action: 'ai-dm.draft',
      entityType: 'ai-dm',
      campaignId,
      // `providerName` (not `this.provider.name`) — with a configured provider the
      // injected no-op seam is bypassed entirely, so only the resolved name is truthful.
      detail: `${input.target} ${editing ? `#${input.entityId} update` : 'create'} → ${proposals.length} ${entityType} proposal(s) via ${providerName} (+${clampedTokens} tokens, reserved=${reservation.tokensReserved})`,
    });

    return {
      target: input.target,
      provider: providerName,
      // Issue #564: report the EXACT model that served the draft (resolved + allowlisted)
      // when a provider is configured. When NO provider is configured (the legacy no-op
      // seam — execModel is ''), fall back to the legacy seat.model label so the response
      // still carries an informational model string (the field is documented as "the seat's
      // model label"), matching the proposer attribution label below.
      model: execModel || seat.model || '',
      entityType,
      proposalIds: proposals.map((p) => p.id),
      proposals,
      tokensUsed: clampedTokens,
      tokenBudget: seat.tokenBudget,
      budgetRemaining: metered.budgetRemaining,
    };
  }

  /**
   * Issue #1993 — co-DM's member-identifying surface, audited against the #501/#1520
   * standard scribe's `consent` block was built for (see `scribe-consent.ts`).
   *
   * Enumerating what actually reaches the provider on this path: the REQUESTING DM's
   * free-text brief, the seat persona plus server-authored shape/rules/language boilerplate,
   * and, for #1311 rewrites, server-loaded DM-only Storylines prep (arc/beat prose,
   * branches, and the id/title/status labels of linked sessions, quests, or encounters).
   * That context contains no note, dice roll, `performedBy`/`rollerUserId`, member id, or
   * other member-authored row. It is DM-authored canon/prep plus relationship labels, so
   * the member note-consent filter used by scribe has no applicable author surface here.
   *
   * Finding: co-DM's assembled payload carries no member-identifying surface at all, so
   * there is nothing for a per-member consent-conditional filter to strip (applying one
   * here would be exactly the "machinery the problem doesn't need" #1993 warns against).
   * What WAS missing is that `consent` was silently omitted from every co-DM provenance
   * record — indistinguishable, to a DM reading the proposal review UI
   * (`GenerationProvenanceView` in ProposalsPage.tsx) or a future auditor, from a path
   * where this question was never asked. `campaignPolicy` + `externalSend` are now always
   * recorded truthfully (reusing the exact campaign-level policy scribe reads — no new
   * settings surface), with the note-consent counters fixed at zero because they are
   * structurally always zero on this path, not merely observed to be so this run.
   *
   * `externalSend` itself is computed by the shared `resolveAiProvenanceEgress` helper
   * (`common/ai-provenance-endpoint.ts`), NOT re-implemented here — a first draft of this
   * fix set `externalSend = true` whenever a provider config resolved, which ignored the
   * operator's `AI_PROVIDER_ENDPOINT_IS_LOCAL` declaration and misreported an on-box Ollama
   * deployment as external (review finding). `ScribeService` and `InboxSweepService` already
   * had that rule; the bug was co-DM implementing half of it instead of calling the same
   * function.
   */
  private buildGenerationProvenance(input: {
    target: CoDmDraftTarget;
    prompt: string;
    instructions: string;
    provider: string;
    providerType: string | null;
    model: string;
    endpointScope: AiGenerationProvenance['endpoint']['scope'];
    endpointBaseUrl?: string | null;
    ruleset: { id: string; pack: string | null; version: string | null };
    campaignPolicy: AiExternalContentPolicy;
    externalSend: boolean;
    sourceContextHash: string | null;
  }): AiGenerationProvenance {
    const promptHash = crypto
      .createHash('sha256')
      .update(JSON.stringify({
        promptVersion: CO_DM_PROMPT_VERSION,
        target: input.target,
        instructions: input.instructions,
        prompt: input.prompt,
      }))
      .digest('hex');
    return {
      source: 'co_dm',
      provider: input.provider,
      providerType: input.providerType,
      model: input.model,
      endpoint: { scope: input.endpointScope, baseUrl: input.endpointBaseUrl ?? null },
      sourceIds: { target: input.target },
      sourceHash: crypto.createHash('sha256').update(input.prompt).digest('hex'),
      sourceContextHash: input.sourceContextHash,
      promptVersion: CO_DM_PROMPT_VERSION,
      promptHash,
      ruleset: input.ruleset,
      consent: {
        campaignPolicy: input.campaignPolicy,
        externalSend: input.externalSend,
        includedAuthorUserIds: [],
        excludedAuthorUserIds: [],
        includedInboxCount: 0,
        excludedInboxByConsent: 0,
        excludedInboxPrivate: 0,
      },
      retentionNotice: AI_EXTERNAL_PROVIDER_PRIVACY.retentionNote,
      createdAt: nowIso(),
    };
  }

  /** Persona + a target-specific instruction to reply with strict JSON the server can parse. */
  private buildInstructions(
    persona: string,
    target: CoDmDraftTarget,
    count: number,
    languageContract: string,
    adapter: RuleSystemAdapter,
    ruleSystem?: string,
    editing = false,
  ): string {
    const base = persona ? `${persona}\n\n` : '';
    const shape = DRAFT_JSON_SHAPE(adapter)[target];
    const arrayNote =
      !editing && MULTI_TARGETS.has(target) && count > 1
        ? `Return a JSON ARRAY of exactly ${count} such objects.`
        : 'Return a single JSON object.';
    let systemPrompt = `You are drafting tabletop RPG content for ${adapter.label}.`;
    if (!ruleSystem || ruleSystem === 'neutral') {
      systemPrompt = `You are drafting tabletop RPG content. Ask for assumptions before applying mechanics.`;
    } else if (adapter.id === 'dnd5e') {
      systemPrompt = `You are drafting D&D content for the DM to review.`;
    }
    return (
      `${base}${languageContract}\n\n` +
      `${systemPrompt}${editing ? ' Rewrite the existing entity from the structured currentStoryline context and the rewriteInstructions. Return the complete rewritten title and prose fields.' : ''} Reply with ONLY JSON — no prose, ` +
      `no markdown fences. ${arrayNote} Each object matches: ${shape}`
    );
  }

  private async resolveLanguageContract(
    campaignId: number,
    override?: NarrationLanguage,
  ): Promise<string> {
    const [row] = await this.db
      .select({ narrationLanguage: campaigns.narrationLanguage })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);
    const { language, provenance } = resolveNarrationLanguage(row?.narrationLanguage, override);
    return buildNarrationLanguageContract(language, provenance);
  }

  /**
   * Parse the provider text into one or more validated payloads for the target's entity
   * type. Every payload is validated (and unknown keys stripped) against the target's Create
   * schema, so what's stored applies cleanly on approve. encounter/map tolerate a missing/
   * non-JSON reply — they fall back to sensible generator defaults — and always pin a seed so
   * the approved generation is reproducible. Other targets require a JSON draft (recap falls
   * back to using the raw text as the recap body).
   */
  private toPayloads(
    target: CoDmDraftTarget,
    narration: string,
    count: number,
    opts?: { arcId?: number; adapter?: RuleSystemAdapter; editing?: boolean },
  ): Record<string, unknown>[] {
    const parsed = extractJson(narration);

    switch (target) {
      case 'npc':
      case 'location':
      case 'arc':
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
          .map((raw) => this.validate(target, raw, opts));
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
  private validate(
    target: CoDmDraftTarget,
    raw: Record<string, unknown>,
    opts?: { arcId?: number; adapter?: RuleSystemAdapter; editing?: boolean },
  ): Record<string, unknown> {
    try {
      switch (target) {
        case 'npc':
          return NpcCreate.parse(raw) as Record<string, unknown>;
        case 'location':
          return LocationCreate.parse(raw) as Record<string, unknown>;
        case 'arc':
          if (opts?.editing) {
            if (typeof raw.title !== 'string' || typeof raw.summary !== 'string') {
              throw new Error('arc rewrite responses must include both title and summary');
            }
            return StoryArcUpdate.parse({ title: raw.title, summary: raw.summary }) as Record<string, unknown>;
          }
          return StoryArcUpdate.parse({
            title: raw.title ?? raw.name ?? 'Untitled arc',
            summary: raw.summary ?? raw.body ?? raw.description ?? '',
          }) as Record<string, unknown>;
        case 'beat':
          if (opts?.editing) {
            if (typeof raw.title !== 'string' || typeof raw.body !== 'string') {
              throw new Error('beat rewrite responses must include both title and body');
            }
            return StoryBeatUpdate.parse({ title: raw.title, body: raw.body }) as Record<string, unknown>;
          }
          return (opts?.editing ? StoryBeatUpdate : StoryBeatProposalCreate).parse({
            title: raw.title ?? raw.name ?? 'Untitled beat',
            body: raw.body ?? raw.summary ?? raw.description ?? '',
            ...(!opts?.editing && opts?.arcId != null ? { arcId: opts.arcId } : {}),
          }) as Record<string, unknown>;
        case 'quest':
          return QuestCreate.parse({
            title: raw.title ?? raw.name ?? 'Untitled quest',
            body: raw.body ?? raw.description ?? '',
            ...(typeof raw.reward === 'string' ? { reward: raw.reward } : {}),
            ...(typeof raw.dmSecret === 'string' ? { dmSecret: raw.dmSecret } : {}),
            ...(typeof raw.status === 'string' ? { status: raw.status } : {}),
          }) as Record<string, unknown>;
        case 'faction':
          return FactionCreate.parse({
            name: raw.name ?? 'Untitled faction',
            ...(typeof raw.body === 'string' ? { body: raw.body } : {}),
            ...(typeof raw.kind === 'string' ? { kind: raw.kind } : {}),
            ...(typeof raw.goals === 'string' ? { goals: raw.goals } : {}),
            ...(typeof raw.standing === 'string' ? { standing: raw.standing } : {}),
            ...(typeof raw.dmSecret === 'string' ? { dmSecret: raw.dmSecret } : {}),
          }) as Record<string, unknown>;
        case 'recap':
          return SessionCreate.parse(raw) as Record<string, unknown>;
        case 'encounter': {
          // Seed pinned so approve re-runs the identical generator (#304). Default a band.
          let validDifficulty = 'medium';
          if (typeof raw.difficulty === 'string' && ['trivial', 'easy', 'medium', 'hard', 'deadly'].includes(raw.difficulty)) {
            validDifficulty = raw.difficulty;
          }
          return EncounterGenerate.parse({
            ...raw,
            difficulty: validDifficulty,
            seed: typeof raw.seed === 'number' ? raw.seed : mintNumericSeed(),
          }) as Record<string, unknown>;
        }
        case 'map': {
          // Seed pinned so approve re-runs the identical generator (#306). The model may
          // hand back a FREE-FORM theme ("volcanic", "sylvan") that isn't in the procedural
          // MapTheme enum; normalize it to the nearest palette (or drop it) so a creative
          // theme no longer hard-fails GenerateMapParams.parse with a 422 (issue #410).
          const { theme: rawTheme, ...restMap } = raw;
          const normalizedTheme = normalizeMapTheme(rawTheme);
          return GenerateMapParams.parse({
            ...restMap,
            ...(normalizedTheme ? { theme: normalizedTheme } : {}),
            seed: typeof raw.seed === 'string' && raw.seed ? raw.seed : mintStringSeed(),
          }) as Record<string, unknown>;
        }
      }
    } catch (err) {
      throw new UnprocessableEntityException(
        `The AI draft for ${target} failed validation: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Per-target JSON hint the model is asked to fill (informational; the server re-validates). */
const DRAFT_JSON_SHAPE = (adapter: RuleSystemAdapter): Record<CoDmDraftTarget, string> => ({
  npc: '{"name": string (required), "role"?: string, "disposition"?: string, "body"?: string, "dmSecret"?: string}',
  location:
    '{"name": string (required), "kind"?: string, "body"?: string, "dmSecret"?: string}',
  arc: '{"title": string (required), "summary": string (required, markdown)}',
  beat: '{"title": string (required), "body": string (required, markdown)}',
  quest:
    '{"title": string (required), "body"?: string (markdown), "reward"?: string, "status"?: "available"|"active"|"completed"|"failed", "dmSecret"?: string}',
  faction:
    '{"name": string (required), "body"?: string (markdown), "kind"?: string, "goals"?: string, "standing"?: "hostile"|"unfriendly"|"neutral"|"friendly"|"allied", "dmSecret"?: string}',
  recap: '{"title"?: string, "recap": string (markdown summary of the session)}',
  encounter: adapter.supportsEncounterDifficulty
    ? '{"difficulty": "trivial"|"easy"|"medium"|"hard"|"deadly", "count"?: number, "shape"?: string}'
    : '{"difficulty"?: string (use native difficulty terms), "count"?: number, "shape"?: string}',
  map: '{"kind"?: "dungeon"|"cave"|"wilderness", "size"?: "small"|"medium"|"large", "theme"?: string}',
});

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
