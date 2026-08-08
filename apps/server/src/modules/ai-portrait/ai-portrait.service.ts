import crypto from 'node:crypto';
import {
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

    // Idempotency: a retried create with the same key returns the identical job.
    const idemKey = opts.idempotencyKey ? `${campaignId}:${opts.idempotencyKey}` : undefined;
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
      // Continuity: reuse the chosen preview's seed as the base seed for the refined render.
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
   * AUTHORITY: the attach endpoint is reachable by any campaign member, but LINKING the portrait
   * reuses the domain service's own authority. `CharactersService.update` enforces dm-or-owner,
   * so a player may attach only to their OWN character; NPC updates are DM-only and the caller's
   * role must already be `'dm'` (asserted by the controller/MCP before reaching here).
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

    // Durable provenance beyond the attachment row: record the (excerpted) prompt + honest
    // provenance label so the origin of a genuine-AI portrait is always attributable from the log.
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

    // Link the chosen portrait onto the target entity by reusing the domain service's own update
    // path — which enforces dm-or-owner for a character and (for NPCs) requires the caller to be
    // a DM. The stored URL carries the version token (issue #498) so a later re-upload or
    // reveal/hide toggle invalidates any cached copy.
    const portraitUrl = `/api/v1/attachments/${attachment.id}/file?v=${this.attachments.versionToken(attachment)}`;

    if (body.entityType === 'character') {
      // CharactersService.update asserts dm-or-owner — a player can only set their OWN portrait.
      await this.characters.update(body.entityId, { portraitUrl }, user, role);
    } else {
      // NPC portrait writes are DM-only — the controller/MCP must have asserted `role === 'dm'`.
      if (role !== 'dm') {
        throw new ForbiddenException('Only a DM may attach a portrait to an NPC.');
      }
      await this.npcs.update(body.entityId, { portraitUrl }, user, role);
    }

    return { attachment, entity: { type: body.entityType, id: body.entityId }, provenance: preview.provenance };
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
      record.bytes.set(previewId, { buf: img.bytes, mime: img.mime });
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
        mime: img.mime,
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
