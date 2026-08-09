import crypto from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AiPortraitGenerationJob,
  type AiPortraitCost,
  type AiPortraitGenerationMethod,
  type AiPortraitGenerationRequest,
  type AiPortraitModeration,
  type AiPortraitPreview,
  type AiPortraitProvenance,
  type AiPortraitReadiness,
  type AiPortraitRefineRequest,
  type Attachment,
  type AttachGeneratedPortraitRequest,
  type Role,
} from '@campfire/schema';
import { nowIso } from '../../common/time';
import { auditActor, type RequestUser } from '../../common/user.types';
import { AuditService } from '../audit/audit.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { CharactersService } from '../characters/characters.service';
import { NpcsService } from '../npcs/npcs.service';
import { AiProviderConfigService } from '../ai-provider-config/ai-provider-config.service';
import {
  createAiImageProvider,
  providerCapabilities,
  type AiImageProvider,
  type AiProviderConfig,
} from '../ai-dm/providers';
import { AiProviderError } from '../ai-dm/providers/errors';

/** Default raster dimensions when the caller doesn't pick any (issue #1321) — square for portraits. */
const DEFAULT_IMAGE_DIMENSIONS = { width: 1024, height: 1024 };
/** Bounded per-request timeout for an image render (ms). */
const IMAGE_TIMEOUT_MS = 120_000;
/** Max jobs retained in-memory per campaign (oldest evicted) — bounds memory (single-instance). */
const MAX_JOBS_PER_CAMPAIGN = 20;
/** Max concurrently-running generation jobs per campaign (concurrency limit). */
const MAX_CONCURRENT_PER_CAMPAIGN = 2;
/** Default minimum spacing between job STARTS per campaign (rate limit), ms. */
const DEFAULT_AI_PORTRAIT_RATE_LIMIT_MS = 1_500;

/**
 * Minimum spacing between job STARTS per campaign (rate limit), ms. Mutable for tests.
 *
 * Overridable via `CAMPFIRE_AI_PORTRAIT_RATE_LIMIT_MS` so the browser e2e harness can switch
 * it off, the same way `CAMPFIRE_AI_MAP_RATE_LIMIT_MS` already does for maps. Per campaign.
 */
export let AI_PORTRAIT_RATE_LIMIT_MS = resolveConfiguredRateLimitMs();

function resolveConfiguredRateLimitMs(): number {
  const raw = process.env.CAMPFIRE_AI_PORTRAIT_RATE_LIMIT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_AI_PORTRAIT_RATE_LIMIT_MS;
  const parsed = Number(raw);
  // A malformed value must not silently disable a protective limit.
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_AI_PORTRAIT_RATE_LIMIT_MS;
}

/** Test-only: shrink/disable the per-campaign generation rate limit. */
export function setAiPortraitRateLimitMsForTests(ms: number): void {
  AI_PORTRAIT_RATE_LIMIT_MS = ms;
}

/** How a job was created — mirrors the ai-map caller policy (issue #1321). */
export type AiPortraitCaller = 'dm' | 'co-dm' | 'driver' | 'player';

export interface CreateJobOptions {
  /** Idempotency key (from the `Idempotency-Key` header / MCP arg) — replays the same job. */
  idempotencyKey?: string;
  /** Which surface requested it (audit attribution). */
  caller?: AiPortraitCaller;
}

/** Internal job record: the client-facing view plus in-memory preview bytes + control. */
interface JobRecord {
  job: AiPortraitGenerationJob;
  request: AiPortraitGenerationRequest;
  caller: AiPortraitCaller;
  /** Decoded preview bytes keyed by preview id (never persisted until attach). */
  bytes: Map<string, { buf: Buffer; mime: string }>;
  abort: AbortController;
}

/**
 * AI portrait generation (issue #1321).
 *
 * Routes a DM's or owning player's brief through the configured provider HONESTLY:
 *   1. image provider          — a real text-to-image render (OpenAI-compatible), when the
 *                                 provider declares the imageGeneration capability;
 *   2. external instructions    — no capable provider: return concrete steps for a
 *                                 client-side external generator.
 *
 * There is NO procedural fallback — unlike maps (#306), Campfire has no first-party portrait
 * renderer, so a text-only provider (Anthropic) cannot produce a portrait. We never fake one.
 *
 * Jobs are in-memory (single-instance, mirroring the ai-map store): previews live in RAM and
 * NOTHING touches the attachment store or disk until the caller explicitly attaches a chosen
 * candidate — so cancellation or a provider failure leaves NO orphan files. Prompt,
 * provider/model, seed/params, dimensions, provenance, moderation, and cost are persisted with
 * the attachment audit record on attach.
 *
 * ATTACH AUTHORITY: generation is member-scoped, but linking a chosen portrait onto an entity
 * reuses the domain service's OWN authority check — `CharactersService.update` enforces
 * dm-or-owner, and NPC portrait writes are DM-only. So a player can only attach a generated
 * portrait to a character they own, exactly like a manual upload.
 */
@Injectable()
export class AiPortraitService {
  private readonly logger = new Logger(AiPortraitService.name);
  private readonly jobs = new Map<string, JobRecord>();
  /** `${campaignId}:${idempotencyKey}` → jobId, so a retried create returns the same job. */
  private readonly idempotency = new Map<string, string>();
  /** Last job-start time per campaign, for the rate limiter. */
  private readonly lastStart = new Map<number, number>();

  constructor(
    private readonly providerConfig: AiProviderConfigService,
    private readonly attachments: AttachmentsService,
    private readonly characters: CharactersService,
    private readonly npcs: NpcsService,
    private readonly audit: AuditService,
  ) {}

  // ── readiness (before spending) ──────────────────────────────────────────────

  /**
   * Compute what generation WOULD do without spending anything (issue #1321): the method that
   * would be used, the resolved provider capabilities, cost estimate, and moderation of the
   * prompt — so the UI can show cost + readiness BEFORE the caller clicks generate.
   */
  async readiness(campaignId: number, request: AiPortraitGenerationRequest): Promise<AiPortraitReadiness> {
    const moderation = moderatePortraitPrompt(composePortraitPrompt(request));
    const config = await this.safeResolveConfig(campaignId);
    const caps = config ? providerCapabilities(config.providerType) : null;
    const method = this.chooseMethod(config);
    const cost = this.estimateCost(method, request);
    const warnings = this.readinessWarnings(method);
    return {
      method,
      warnings,
      cost,
      moderation,
      capabilities: caps,
    };
  }

  // ── create / refine ───────────────────────────────────────────────────────────

  /**
   * Create a generation job, run it, and return the completed job with in-memory previews
   * (issue #1321). Enforces idempotency, per-campaign concurrency + rate limits, and the
   * prompt-moderation gate. Never persists an attachment — see {@link attach}.
   */
  async createJob(
    campaignId: number,
    request: AiPortraitGenerationRequest,
    user: RequestUser,
    role: Role,
    opts: CreateJobOptions = {},
  ): Promise<AiPortraitGenerationJob> {
    const caller = opts.caller ?? 'dm';

    // Idempotency: a retried create with the same key returns the identical job. The key is scoped
    // to the CALLER as well as the campaign, so two different members or PATs submitting the same
    // user-chosen key do NOT share a job — the response carries the private prompt and generated
    // bytes, and the job id lets a caller poll/refine/cancel/attach (issue #1321 review). For PATs
    // we use the immutable `tokenId` (not the non-unique `token:<name>` audit label) so two PATs
    // with the same name cannot collide.
    const callerId = user.tokenContext ? `pat:${user.tokenContext.tokenId}` : user.id;
    const idemKey = opts.idempotencyKey ? `${campaignId}:${callerId}:${opts.idempotencyKey}` : undefined;
    if (idemKey) {
      const existingId = this.idempotency.get(idemKey);
      const existing = existingId ? this.jobs.get(existingId) : undefined;
      if (existing && existing.job.campaignId === campaignId) return existing.job;
    }

    this.enforceRateAndConcurrency(campaignId);

    const prompt = composePortraitPrompt(request);
    const moderation = moderatePortraitPrompt(prompt);

    const id = `aiportrait-${crypto.randomBytes(9).toString('hex')}`;
    const ts = nowIso();
    const config = await this.safeResolveConfig(campaignId);
    const method = this.chooseMethod(config);

    // Enforce the server admin's model allowlist on a per-request imageModel override (review
    // feedback): without this a player-scoped caller could select a disallowed or more expensive
    // model using the server's configured credentials. The check runs BEFORE any provider call.
    if (request.imageModel && method === 'image-provider') {
      await this.assertModelAllowed(request.imageModel);
    }

    const base: AiPortraitGenerationJob = AiPortraitGenerationJob.parse({
      id,
      campaignId,
      status: moderation.flagged ? 'failed' : 'running',
      progress: moderation.flagged ? 100 : 5,
      method,
      prompt,
      provider: config?.providerType ?? null,
      model: config?.model ?? null,
      dimensions: method === 'image-provider' ? this.dimensionsFor(request) : null,
      moderation,
      cost: this.estimateCost(method, request),
      previews: [],
      externalInstructions: [],
      warnings: [],
      error: moderation.flagged ? 'Prompt was blocked by the content-moderation gate.' : null,
      createdBy: auditActor(user),
      createdAt: ts,
      updatedAt: ts,
    });

    const record: JobRecord = { job: base, request, caller, bytes: new Map(), abort: new AbortController() };
    this.registerJob(record);
    if (idemKey) this.idempotency.set(idemKey, id);

    if (moderation.flagged) {
      await this.audit.log({
        actor: auditActor(user),
        actorRole: role,
        action: 'ai-portrait.blocked',
        entityType: 'campaign',
        entityId: campaignId,
        campaignId,
        detail: `ai portrait prompt blocked (${moderation.categories.join(',') || 'policy'}) by ${caller}`,
      });
      return record.job;
    }

    // Charge the rate-limit slot only once a generation actually STARTS — a blocked prompt
    // runs no renderer and costs nothing, so it must not lock the campaign out (issue #1321,
    // mirroring the ai-map fix at ai-map.service.ts:237-242).
    this.lastStart.set(campaignId, Date.now());

    await this.runGeneration(record, config, user, role, caller);
    return record.job;
  }

  /** Refine an existing job: merge prompt/count deltas and generate a fresh job (issue #1321). */
  async refine(
    campaignId: number,
    jobId: string,
    refine: AiPortraitRefineRequest,
    user: RequestUser,
    role: Role,
    opts: CreateJobOptions = {},
  ): Promise<AiPortraitGenerationJob> {
    const prior = this.requireJob(jobId, campaignId);
    const fromPreview = refine.fromPreviewId
      ? prior.job.previews.find((p) => p.id === refine.fromPreviewId)
      : undefined;
    const merged: AiPortraitGenerationRequest = {
      ...prior.request,
      prompt: refine.prompt ?? prior.request.prompt,
      count: refine.count ?? prior.request.count,
      // Seed is a LOCAL label only — it identifies candidates in previews/audit and lets a refined
      // job derive deterministic preview ids. The OpenAI-compatible image API has no seed parameter,
      // so this does NOT influence the provider's output pixels (unlike the procedural map renderer).
      // It is retained for stable attribution, not for reproducibility.
      seed: fromPreview?.seed ?? prior.request.seed,
    };
    return this.createJob(campaignId, merged, user, role, { ...opts, caller: prior.caller });
  }

  // ── status / cancel ─────────────────────────────────────────────────────────

  /** Fetch a job's status view (issue #1321). */
  getJob(jobId: string, campaignId: number): AiPortraitGenerationJob {
    return this.requireJob(jobId, campaignId).job;
  }

  /**
   * Cancel a job (issue #1321). Aborts any in-flight provider call and marks the job cancelled.
   * Because nothing is persisted during generation, cancellation leaves NO orphan files.
   * Idempotent: cancelling a finished job is a no-op that returns its final state.
   */
  async cancelJob(jobId: string, campaignId: number, user: RequestUser, role: Role): Promise<AiPortraitGenerationJob> {
    const record = this.requireJob(jobId, campaignId);
    if (record.job.status === 'running' || record.job.status === 'queued') {
      record.abort.abort();
      record.job.status = 'cancelled';
      record.job.progress = 100;
      record.job.error = 'Cancelled by user.';
      record.job.previews = [];
      record.bytes.clear();
      record.job.updatedAt = nowIso();
      await this.audit.log({
        actor: auditActor(user),
        actorRole: role,
        action: 'ai-portrait.cancel',
        entityType: 'campaign',
        entityId: campaignId,
        campaignId,
        detail: `ai portrait job ${jobId} cancelled`,
      });
    }
    return record.job;
  }

  // ── attach (the only persisting path) ─────────────────────────────────────────

  /**
   * Persist a chosen candidate as a `kind='portrait'` attachment (issue #1321) and set it as the
   * target entity's `portraitUrl`. Prompt, provider/model, seed/params, dimensions, provenance,
   * moderation, and cost are stamped into the attachment audit record. Orphan-safe: the
   * attachment write is atomic (rolls back its own bytes on failure), and it is the ONLY disk
   * write in the whole flow.
   *
   * AUTHORITY: generation is player-or-above scoped (the controller/MCP asserts `requireRole
   * 'player')`, but LINKING the portrait reuses the domain service's own authority. The target
   * entity is validated to belong to the SAME campaign and the caller's write authority is checked
   * BEFORE the attachment is persisted — so a rejected attach never consumes quota or leaves an
   * orphan. `CharactersService.update` re-checks dm-or-owner; NPC portrait writes are DM-only.
   */
  async attach(
    campaignId: number,
    jobId: string,
    body: AttachGeneratedPortraitRequest,
    user: RequestUser,
    role: Role,
  ): Promise<{ attachment: Attachment; entity: { type: 'character' | 'npc'; id: number }; provenance: AiPortraitProvenance }> {
    const record = this.requireJob(jobId, campaignId);
    if (record.job.status !== 'succeeded') {
      throw new ConflictException(`Job ${jobId} is ${record.job.status}; only a succeeded job can be attached.`);
    }
    const preview = record.job.previews.find((p) => p.id === body.previewId);
    const stored = record.bytes.get(body.previewId);
    if (!preview || !stored) {
      throw new NotFoundException(`Preview ${body.previewId} not found on job ${jobId}.`);
    }

    // Validate the target entity belongs to THIS campaign and the caller has write authority,
    // BEFORE persisting the attachment — so a cross-campaign or unauthorized target is rejected
    // without consuming quota or leaving an orphan attachment (issue #1321 review feedback).
    // Also returns the target's hidden flag so the attachment visibility can match it.
    const targetVisibility = await this.validateTarget(campaignId, body.entityType, body.entityId, user, role);

    const ext = mimeExt(stored.mime);
    const filename = sanitizeFilename(body.filename ?? `ai-portrait-${preview.seed}`) + `.${ext}`;
    const auditDetail = this.buildAttachAuditDetail(record.job, preview);

    const attachment = await this.attachments.createGenerated(
      campaignId,
      'portrait',
      { filename, mime: stored.mime, bytes: stored.buf, metadata: {
        title: body.filename ?? `AI portrait (${preview.seed})`,
        // The prompt can contain private DM prep, so it is deliberately kept in the restricted
        // audit trail and never copied into player-visible alt text.
        altText: 'AI-generated portrait',
        creator: preview.provenance.label,
        sourceUrl: '',
        license: '',
        rights: 'Review provider terms before redistribution.',
        attribution: preview.provenance.label,
      } },
      user,
      role,
      auditDetail,
    );

    // All post-commit steps (hide-if-needed, provenance audit, entity linkage) are inside ONE
    // rollback guard so a failure at ANY point rolls back the attachment rather than leaving a
    // quota-charged orphan (issue #1321 review feedback). The target was already validated above,
    // so authority should not fail here — but a race, concurrent edit, or audit/hide write failure
    // could still throw.
    const portraitUrl = `/api/v1/attachments/${attachment.id}/file?v=${this.attachments.versionToken(attachment)}`;
    try {
      // If the target NPC is hidden, the generated portrait MUST also be hidden — otherwise a non-DM
      // member could enumerate it through the attachment list and fetch the bytes even though the NPC
      // itself returns 404 (issue #1321 review feedback). Portraits default to visible, so hide it
      // explicitly here when the target is hidden.
      if (targetVisibility.hidden) {
        await this.attachments.setHidden(attachment.id, true, user, role);
      }

      // Durable provenance: record the (excerpted) prompt + honest provenance label so the origin
      // of a genuine-AI portrait is always attributable from the log. This is inside the rollback
      // guard so an audit-write failure rolls back the attachment rather than leaving an orphan.
      await this.audit.log({
        actor: auditActor(user),
        actorRole: role,
        action: 'ai-portrait.attach',
        entityType: 'attachment',
        entityId: attachment.id,
        campaignId,
        detail:
          `ai portrait attached: ${preview.provenance.label} | prompt="${excerpt(record.job.prompt, 200)}" | ` +
          `seed=${preview.seed} moderation=${record.job.moderation.flagged ? 'flagged' : 'clean'} ` +
          `cost=${record.job.cost.imageCount}img/${record.job.cost.tokensUsed}tok ` +
          `target=${body.entityType}:${body.entityId}`,
      });

      if (body.entityType === 'character') {
        // CharactersService.update asserts dm-or-owner — a player can only set their OWN portrait.
        await this.characters.update(body.entityId, { portraitUrl }, user, role);
      } else {
        await this.npcs.update(body.entityId, { portraitUrl }, user, role);
      }
    } catch (err) {
      // Defensive: the pre-validation should have caught authority issues, but a race, a concurrent
      // edit, or an audit-write failure could still throw after the attachment was committed. Roll
      // back the just-created attachment so the campaign is not charged quota for an unlinked portrait.
      try {
        await this.attachments.remove(attachment.id, user, role);
      } catch (cleanupErr) {
        this.logger.error(
          `AI portrait attach linkage failed for ${body.entityType}:${body.entityId} and attachment rollback could not complete: ${
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
          }`,
        );
      }
      throw err;
    }

    return { attachment, entity: { type: body.entityType, id: body.entityId }, provenance: preview.provenance };
  }

  /**
   * Validate the target entity exists, belongs to THIS campaign, and the caller has write
   * authority — BEFORE the attachment is persisted. This closes the cross-campaign gap (a DM in
   * campaign A supplying a character/NPC id from campaign B) and the persist-before-authorize
   * ordering issue (issue #1321 review feedback). Character authority is dm-or-owner (delegated to
   * `CharactersService.assertCanWrite`); NPC authority is DM-only. Returns the target's `hidden`
   * flag so the caller can match the attachment's visibility to the target's secrecy (a portrait
   * for a hidden NPC must stay hidden).
   */
  private async validateTarget(
    campaignId: number,
    entityType: 'character' | 'npc',
    entityId: number,
    user: RequestUser,
    role: Role,
  ): Promise<{ hidden: boolean }> {
    if (entityType === 'character') {
      const row = await this.characters.getRowOrThrow(entityId);
      if (row.campaignId !== campaignId) {
        throw new BadRequestException(`Character ${entityId} is not in campaign ${campaignId}.`);
      }
      // CharactersService.assertCanWrite: dm or the owning player. A viewer or non-owner player 403s
      // here, before any attachment bytes are written.
      this.characters.assertCanWrite(row, user, role);
      // Characters are always player-visible (no hidden flag), so the portrait is visible.
      return { hidden: false };
    }
    if (role !== 'dm') {
      throw new ForbiddenException('Only a DM may attach a portrait to an NPC.');
    }
    const row = await this.npcs.getRowOrThrow(entityId);
    if (row.campaignId !== campaignId) {
      throw new BadRequestException(`NPC ${entityId} is not in campaign ${campaignId}.`);
    }
    // Preserve the NPC's secrecy: if the NPC is hidden, the generated portrait must be hidden too,
    // or a non-DM member could enumerate it through the attachment list and fetch the bytes even
    // though the NPC itself returns 404 (issue #1321 review feedback).
    return { hidden: Boolean(row.hidden) };
  }

  // ── generation core ───────────────────────────────────────────────────────────

  private async runGeneration(
    record: JobRecord,
    config: AiProviderConfig | null,
    user: RequestUser,
    role: Role,
    caller: AiPortraitCaller,
  ): Promise<void> {
    const { job } = record;
    try {
      if (config && providerCapabilities(config.providerType).imageGeneration === true) {
        await this.generateWithImageProvider(record, config);
      } else if (config) {
        // A text-only provider (Anthropic/Gemini) cannot draw a portrait — we do NOT degrade to a
        // procedural renderer (there is none for portraits). Be honest: return external steps.
        this.generateExternalInstructions(record, config);
      } else {
        this.generateExternalInstructions(record, null);
      }
      job.status = 'succeeded';
      job.progress = 100;
      job.updatedAt = nowIso();
      await this.audit.log({
        actor: auditActor(user),
        actorRole: role,
        action: 'ai-portrait.generate',
        entityType: 'campaign',
        entityId: job.campaignId,
        campaignId: job.campaignId,
        detail:
          `ai portrait generated via ${job.method} by ${caller} | ` +
          `${job.cost.imageCount}img/${job.cost.tokensUsed}tok | prompt="${excerpt(job.prompt, 120)}"`,
      });
    } catch (err) {
      if (record.abort.signal.aborted) {
        // The cancel handler already set the terminal state; don't overwrite it.
        return;
      }
      job.status = 'failed';
      job.progress = 100;
      job.error = err instanceof Error ? err.message.slice(0, 400) : String(err);
      job.updatedAt = nowIso();
      this.logger.warn(`AI portrait generation failed: ${job.error}`);
    }
  }

  /** Genuine text-to-image render through the configured OpenAI-compatible image provider. */
  private async generateWithImageProvider(record: JobRecord, config: AiProviderConfig): Promise<void> {
    const { job, request } = record;
    const image: AiImageProvider = createAiImageProvider(config, request.imageModel);
    const dims = this.dimensionsFor(request);
    const result = await image.generateImage(
      { prompt: job.prompt, n: request.count, width: dims.width, height: dims.height, model: request.imageModel ?? config.model },
      { signal: record.abort.signal, timeoutMs: IMAGE_TIMEOUT_MS },
    );
    const previews: AiPortraitPreview[] = result.images.map((img, i) => {
      const seed = `${baseSeed(request)}-${i}`;
      const previewId = `${job.id}-p${i}`;
      // Whitelist raster mimes only (issue #1321 review feedback): a provider returning SVG or an
      // unexpected mime would bypass the attachment image-probe exemption and could introduce XSS
      // when the portrait is later served through <img src=...>. Reject anything that is not a
      // known raster format rather than trusting img.mime blindly.
      const mime = assertRasterMime(img.mime);
      record.bytes.set(previewId, { buf: img.bytes, mime });
      const provenance: AiPortraitProvenance = {
        method: 'image-provider',
        providerType: config.providerType,
        model: result.model,
        label: `Generated by ${config.providerType} image model "${result.model}".`,
        seed,
      };
      return {
        id: previewId,
        method: 'image-provider',
        imageBase64: img.bytes.toString('base64'),
        mime,
        width: img.width ?? dims.width,
        height: img.height ?? dims.height,
        seed,
        provenance,
        warnings: [],
      };
    });
    job.previews = previews;
    job.cost = { imageCount: previews.length, tokensUsed: result.usage.tokensUsed, estimatedUsd: job.cost.estimatedUsd };
    job.dimensions = dims;
    if (previews.length === 0) throw new AiProviderError('invalid_request', 'image provider returned no previews');
  }

  /** Terminal fallback (issue #1321): no capable provider — return concrete external steps. */
  private generateExternalInstructions(record: JobRecord, config: AiProviderConfig | null): void {
    const { job } = record;
    job.previews = [];
    job.cost = { imageCount: 0, tokensUsed: 0, estimatedUsd: 0 };
    const cfgNote = config
      ? `The configured provider (${config.providerType}) cannot generate images.`
      : 'No AI provider is configured for this campaign.';
    job.externalInstructions = [
      `${cfgNote} Portraits cannot be produced by the first-party renderer (there is none for portraits).`,
      'Option A — configure an OpenAI-compatible image provider (Settings → AI provider), then re-run this generation.',
      `Option B — use an external generator with this brief, export a square image, then upload it as a portrait: "${excerpt(job.prompt, 200)}".`,
    ];
  }

  // ── routing + estimation helpers ───────────────────────────────────────────────

  /** Decide which method WOULD serve this request given the resolved provider (issue #1321). */
  private chooseMethod(config: AiProviderConfig | null): AiPortraitGenerationMethod {
    const canImage = !!config && providerCapabilities(config.providerType).imageGeneration === true;
    return canImage ? 'image-provider' : 'external-instructions';
  }

  /** Rough cost estimate before spending (issue #1321). */
  private estimateCost(method: AiPortraitGenerationMethod, request: AiPortraitGenerationRequest): AiPortraitCost {
    if (method === 'image-provider') {
      return { imageCount: request.count, tokensUsed: 0, estimatedUsd: null };
    }
    return { imageCount: 0, tokensUsed: 0, estimatedUsd: 0 };
  }

  /** Readiness warnings for the chosen method (issue #1321). */
  private readinessWarnings(method: AiPortraitGenerationMethod): string[] {
    if (method === 'external-instructions') {
      return ['No image-capable provider is configured; portraits will return external-generator steps instead of an image.'];
    }
    return [];
  }

  private dimensionsFor(request: AiPortraitGenerationRequest): { width: number; height: number } {
    return request.dimensions ?? DEFAULT_IMAGE_DIMENSIONS;
  }

  private buildAttachAuditDetail(job: AiPortraitGenerationJob, preview: AiPortraitPreview): string {
    const dims = job.dimensions ? `${job.dimensions.width}x${job.dimensions.height}` : 'default';
    return (
      `portrait:ai:method=${preview.provenance.method}:provider=${preview.provenance.providerType ?? 'none'}:` +
      `model=${preview.provenance.model ?? 'none'}:seed=${preview.seed}:dims=${dims}:` +
      `mod=${job.moderation.flagged ? 'flagged' : 'clean'}:cost=${job.cost.imageCount}i/${job.cost.tokensUsed}t`
    );
  }

  // ── job registry plumbing ─────────────────────────────────────────────────────

  private async safeResolveConfig(campaignId: number): Promise<AiProviderConfig | null> {
    try {
      return await this.providerConfig.resolveEffectiveConfig(campaignId);
    } catch (err) {
      this.logger.warn(`Failed to resolve AI provider config for campaign ${campaignId}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Enforce the server admin's model allowlist on a per-request override (review feedback).
   * If the server has configured `allowedModels` and the requested model is not among them,
   * reject BEFORE any provider call — a player-scoped caller must not select a disallowed or
   * more expensive model using the server's configured credentials.
   */
  private async assertModelAllowed(model: string): Promise<void> {
    const allowed = await this.providerConfig.getServerAllowedModels();
    if (allowed.length > 0 && !allowed.includes(model)) {
      throw new BadRequestException(
        `Model '${model}' is not in the server admin's allowlist (${allowed.join(', ')}).`,
      );
    }
  }

  private registerJob(record: JobRecord): void {
    this.jobs.set(record.job.id, record);
    // Evict oldest jobs for this campaign beyond the cap.
    const campaignJobs = [...this.jobs.values()].filter((r) => r.job.campaignId === record.job.campaignId);
    if (campaignJobs.length > MAX_JOBS_PER_CAMPAIGN) {
      campaignJobs
        .sort((a, b) => a.job.createdAt.localeCompare(b.job.createdAt))
        .slice(0, campaignJobs.length - MAX_JOBS_PER_CAMPAIGN)
        .forEach((r) => this.jobs.delete(r.job.id));
    }
  }

  private requireJob(jobId: string, campaignId: number): JobRecord {
    const record = this.jobs.get(jobId);
    if (!record || record.job.campaignId !== campaignId) {
      throw new NotFoundException(`AI portrait job ${jobId} not found for this campaign.`);
    }
    return record;
  }

  private enforceRateAndConcurrency(campaignId: number): void {
    const running = [...this.jobs.values()].filter(
      (r) => r.job.campaignId === campaignId && (r.job.status === 'running' || r.job.status === 'queued'),
    ).length;
    if (running >= MAX_CONCURRENT_PER_CAMPAIGN) {
      throw new ServiceUnavailableException(
        `Too many AI portrait generations already running for this campaign (max ${MAX_CONCURRENT_PER_CAMPAIGN}). Wait for one to finish.`,
      );
    }
    const last = this.lastStart.get(campaignId);
    if (last !== undefined && AI_PORTRAIT_RATE_LIMIT_MS > 0 && Date.now() - last < AI_PORTRAIT_RATE_LIMIT_MS) {
      throw new ServiceUnavailableException('AI portrait generation is rate-limited; please wait a moment before generating again.');
    }
  }
}

// ── pure helpers (exported for unit tests) ──────────────────────────────────────

/** Fold the prompt + optional style preset into one text brief the provider consumes (issue #1321). */
export function composePortraitPrompt(request: AiPortraitGenerationRequest): string {
  const parts: string[] = [request.prompt.trim()];
  if (request.style === 'realistic') parts.push('Photorealistic style.');
  else if (request.style === 'painterly') parts.push('Painterly oil-painting style.');
  else if (request.style === 'illustration') parts.push('Detailed digital illustration style.');
  parts.push('Square portrait suitable for a circular avatar crop, centered on the face.');
  return parts.join(' ');
}

/**
 * Deterministic, offline content-moderation gate for a portrait prompt (issue #1321). Conservative
 * keyword screen: blocks prompts that combine minors with sexual content, request real-person
 * likenesses, or request real-person sexual imagery. This is a guardrail, not a classifier —
 * provider-side moderation still applies to real image calls. Returns a structured result.
 */
export function moderatePortraitPrompt(prompt: string): AiPortraitModeration {
  const p = ` ${prompt.toLowerCase()} `;
  const categories: string[] = [];
  const sexual = /(sexual|nude|nudity|explicit|porn|nsfw|erotic|lingerie|swimsuit|bikini)/.test(p);
  const minors = /(child|children|kid|minor|underage|infant|toddler|preteen|prepubescent|baby)/.test(p);
  if (sexual && minors) categories.push('csae');
  if (/(gore|dismember|torture)\b/.test(p) && sexual) categories.push('sexual-violence');
  // Real-person likeness requests are blocked for portrait generation (privacy + provider policy).
  if (/(real person|real-life|celebrity|famous person|elon musk|donald trump|joe biden|barack obama)/.test(p)) {
    categories.push('real-person-likeness');
  }
  return {
    flagged: categories.length > 0,
    categories,
    note: categories.length > 0 ? 'Prompt blocked by the content-moderation gate.' : null,
  };
}

/** Resolve a stable base seed for a request (caller's, or a fresh crypto-random hex). */
function baseSeed(request: AiPortraitGenerationRequest): string {
  return request.seed ?? crypto.randomBytes(8).toString('hex');
}

/** File extension for a stored mime type. */
function mimeExt(mime: string): string {
  switch (mime) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    default:
      return 'bin';
  }
}

/** Collapse a filename to a safe single-line slug (mirrors maps.service). */
function sanitizeFilename(s: string): string {
  return s.replace(/[ -/\\]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || 'ai-portrait';
}

/** Short excerpt for audit/instruction strings. */
function excerpt(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

/** The only mimes a portrait attachment may have — raster formats servable through <img> safely. */
const ALLOWED_PORTRAIT_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * Assert a provider-returned mime is a whitelisted raster format (issue #1321 review feedback).
 * A provider returning SVG or an unexpected mime would bypass the attachment image-probe exemption
 * and could introduce XSS when served through <img src=...>. Returns the mime if allowed, else
 * throws to fail the job.
 */
function assertRasterMime(mime: string): string {
  if (!ALLOWED_PORTRAIT_MIMES.has(mime)) {
    throw new AiProviderError('invalid_response', `image provider returned unsupported mime type "${mime}"; expected one of ${[...ALLOWED_PORTRAIT_MIMES].join(', ')}`);
  }
  return mime;
}
