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
  AiMapGenerationJob,
  normalizeMapTheme,
  type AiMapChips,
  type AiMapCost,
  type AiMapGenerationMethod,
  type AiMapGenerationRequest,
  type AiMapModeration,
  type AiMapPreview,
  type AiMapProvenance,
  type AiMapReadiness,
  type AiMapRefineRequest,
  type AttachGeneratedMapRequest,
  type Attachment,
  type GeneratedMapResult,
  type MapKind,
  type MapSize,
  type Role,
} from '@campfire/schema';
import { nowIso } from '../../common/time';
import { auditActor, type RequestUser } from '../../common/user.types';
import { AuditService } from '../audit/audit.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { EncountersService } from '../encounters/encounters.service';
import { AiProviderConfigService } from '../ai-provider-config/ai-provider-config.service';
import { generateMap } from '../maps/map-generator';
import {
  createAiImageProvider,
  providerCapabilities,
  type AiImageProvider,
  type AiProviderConfig,
} from '../ai-dm/providers';
import { AiProviderError } from '../ai-dm/providers/errors';

/** Default raster dimensions when the caller doesn't pick any (issue #410). */
const DEFAULT_IMAGE_DIMENSIONS = { width: 1024, height: 1024 };
/** Bounded per-request timeout for an image render (ms). */
const IMAGE_TIMEOUT_MS = 120_000;
/** Max jobs retained in-memory per campaign (oldest evicted) — bounds memory (single-instance). */
const MAX_JOBS_PER_CAMPAIGN = 20;
/** Max concurrently-running generation jobs per campaign (concurrency limit). */
const MAX_CONCURRENT_PER_CAMPAIGN = 2;
/** Default minimum spacing between job STARTS per campaign (rate limit), ms. */
const DEFAULT_AI_MAP_RATE_LIMIT_MS = 1_500;

/**
 * Minimum spacing between job STARTS per campaign (rate limit), ms. Mutable for tests.
 *
 * Overridable via `CAMPFIRE_AI_MAP_RATE_LIMIT_MS` so the browser e2e harness can switch
 * it off, the same way it already sets `THROTTLE_DISABLED` for the auth throttler. The
 * limit is per CAMPAIGN and the e2e suite shares one seeded campaign, so a spec that
 * generates a map silently charged the next spec's generation — which is how the AI-map
 * moderation spec came to fail depending on how quickly the preceding spec finished.
 * Bypassing it there is safe because the limiter itself is covered directly in
 * `test/unit/ai-map-routing.spec.ts` rather than incidentally by a browser journey.
 */
export let AI_MAP_RATE_LIMIT_MS = resolveConfiguredRateLimitMs();

function resolveConfiguredRateLimitMs(): number {
  const raw = process.env.CAMPFIRE_AI_MAP_RATE_LIMIT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_AI_MAP_RATE_LIMIT_MS;
  const parsed = Number(raw);
  // A malformed value must not silently disable a protective limit.
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_AI_MAP_RATE_LIMIT_MS;
}

/** Test-only: shrink/disable the per-campaign generation rate limit. */
export function setAiMapRateLimitMsForTests(ms: number): void {
  AI_MAP_RATE_LIMIT_MS = ms;
}

/** How a job was created — controls the reveal/replace policy on attach (issue #410). */
export type AiMapCaller = 'dm' | 'co-dm' | 'driver';

export interface CreateJobOptions {
  /** Idempotency key (from the `Idempotency-Key` header / MCP arg) — replays the same job. */
  idempotencyKey?: string;
  /** Which surface requested it: gates the reveal/replace-to-encounter policy on attach. */
  caller?: AiMapCaller;
}

/** Internal job record: the client-facing view plus in-memory preview bytes + control. */
interface JobRecord {
  job: AiMapGenerationJob;
  request: AiMapGenerationRequest;
  caller: AiMapCaller;
  /** Decoded preview bytes keyed by preview id (never persisted until attach). */
  bytes: Map<string, { buf: Buffer; mime: string }>;
  abort: AbortController;
}

/**
 * Genuine AI map generation (issue #410).
 *
 * Routes a DM's brief through the configured provider HONESTLY:
 *   1. image provider          — a real text-to-image render (OpenAI-compatible), when the
 *                                 provider declares the imageGeneration capability;
 *   2. procedural blueprint     — a text-only provider (Anthropic) can't draw, so we render
 *                                 the map with Campfire's OWN procedural generator (#306) and
 *                                 label it as such — we NEVER claim the text model made an image;
 *   3. external instructions    — no capable provider (or concept-art with none): return
 *                                 concrete steps for a client-side external generator.
 *
 * Jobs are in-memory (single-instance, mirroring the driver session store): previews live in
 * RAM and NOTHING touches the attachment store or disk until the DM explicitly attaches a
 * chosen candidate — so cancellation or a provider failure leaves NO orphan files. Prompt,
 * provider/model, seed/params, dimensions, provenance, moderation, and cost are persisted with
 * the attachment audit record on attach.
 */
@Injectable()
export class AiMapService {
  private readonly logger = new Logger(AiMapService.name);
  private readonly jobs = new Map<string, JobRecord>();
  /** `${campaignId}:${idempotencyKey}` → jobId, so a retried create returns the same job. */
  private readonly idempotency = new Map<string, string>();
  /** Last job-start time per campaign, for the rate limiter. */
  private readonly lastStart = new Map<number, number>();

  constructor(
    private readonly providerConfig: AiProviderConfigService,
    private readonly attachments: AttachmentsService,
    private readonly encounters: EncountersService,
    private readonly audit: AuditService,
  ) {}

  // ── readiness (before spending) ──────────────────────────────────────────────

  /**
   * Compute what generation WOULD do without spending anything (issue #410): the method that
   * would be used, the resolved provider capabilities, cost estimate, moderation of the
   * prompt, and grid/doors/corridors readiness warnings — so the UI can show cost + readiness
   * BEFORE the DM clicks generate.
   */
  async readiness(campaignId: number, request: AiMapGenerationRequest): Promise<AiMapReadiness> {
    const moderation = moderateMapPrompt(composePrompt(request));
    const config = await this.safeResolveConfig(campaignId);
    const caps = config ? providerCapabilities(config.providerType) : null;
    const method = this.chooseMethod(request, config);
    const cost = this.estimateCost(method, request);
    const readiness = this.readinessFor(method, request);
    return {
      mode: request.mode,
      method,
      gridLikely: readiness.gridLikely,
      doorsLikely: readiness.doorsLikely,
      corridorsLikely: readiness.corridorsLikely,
      warnings: readiness.warnings,
      cost,
      moderation,
      capabilities: caps,
    };
  }

  // ── create / refine ───────────────────────────────────────────────────────────

  /**
   * Create a generation job, run it, and return the completed job with in-memory previews
   * (issue #410). Enforces idempotency, per-campaign concurrency + rate limits, and the
   * prompt-moderation gate. Never persists an attachment — see {@link attach}.
   */
  async createJob(
    campaignId: number,
    request: AiMapGenerationRequest,
    user: RequestUser,
    role: Role,
    opts: CreateJobOptions = {},
  ): Promise<AiMapGenerationJob> {
    const caller = opts.caller ?? 'dm';

    // Idempotency: a retried create with the same key returns the identical job.
    const idemKey = opts.idempotencyKey ? `${campaignId}:${opts.idempotencyKey}` : undefined;
    if (idemKey) {
      const existingId = this.idempotency.get(idemKey);
      const existing = existingId ? this.jobs.get(existingId) : undefined;
      if (existing && existing.job.campaignId === campaignId) return existing.job;
    }

    this.enforceRateAndConcurrency(campaignId);

    const prompt = composePrompt(request);
    const moderation = moderateMapPrompt(prompt);

    const id = `aimap-${crypto.randomBytes(9).toString('hex')}`;
    const ts = nowIso();
    const config = await this.safeResolveConfig(campaignId);
    const method = this.chooseMethod(request, config);

    const base: AiMapGenerationJob = AiMapGenerationJob.parse({
      id,
      campaignId,
      status: moderation.flagged ? 'failed' : 'running',
      progress: moderation.flagged ? 100 : 5,
      mode: request.mode,
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
        action: 'ai-map.blocked',
        entityType: 'campaign',
        entityId: campaignId,
        campaignId,
        detail: `ai map prompt blocked (${moderation.categories.join(',') || 'policy'}) by ${caller}`,
      });
      return record.job;
    }

    // Charge the per-campaign rate-limit slot only once a generation actually STARTS.
    // Setting it before the moderation early-return above meant a blocked prompt — which
    // runs no renderer and costs nothing — still locked the campaign out of its next
    // legitimate generation for the whole window. The limit exists to bound expensive
    // work, so work that never happened must not spend it.
    this.lastStart.set(campaignId, Date.now());

    await this.runGeneration(record, config, user, role, caller);
    return record.job;
  }

  /** Refine an existing job: merge prompt/chips deltas and generate a fresh job (issue #410). */
  async refine(
    campaignId: number,
    jobId: string,
    refine: AiMapRefineRequest,
    user: RequestUser,
    role: Role,
    opts: CreateJobOptions = {},
  ): Promise<AiMapGenerationJob> {
    const prior = this.requireJob(jobId, campaignId);
    const fromPreview = refine.fromPreviewId
      ? prior.job.previews.find((p) => p.id === refine.fromPreviewId)
      : undefined;
    const merged: AiMapGenerationRequest = {
      ...prior.request,
      prompt: refine.prompt ?? prior.request.prompt,
      chips: mergeChips(prior.request.chips, refine.chips),
      count: refine.count ?? prior.request.count,
      // Continuity: reuse the chosen preview's seed as the base seed for the refined render.
      seed: fromPreview?.seed ?? prior.request.seed,
    };
    return this.createJob(campaignId, merged, user, role, { ...opts, caller: prior.caller });
  }

  // ── status / cancel ─────────────────────────────────────────────────────────

  /** Fetch a job's status view (issue #410). */
  getJob(jobId: string, campaignId: number): AiMapGenerationJob {
    return this.requireJob(jobId, campaignId).job;
  }

  /**
   * Cancel a job (issue #410). Aborts any in-flight provider call and marks the job cancelled.
   * Because nothing is persisted during generation, cancellation leaves NO orphan files.
   * Idempotent: cancelling a finished job is a no-op that returns its final state.
   */
  async cancelJob(jobId: string, campaignId: number, user: RequestUser, role: Role): Promise<AiMapGenerationJob> {
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
        action: 'ai-map.cancel',
        entityType: 'campaign',
        entityId: campaignId,
        campaignId,
        detail: `ai map job ${jobId} cancelled`,
      });
    }
    return record.job;
  }

  // ── attach (the only persisting path) ─────────────────────────────────────────

  /**
   * Persist a chosen candidate as a hidden 'map' attachment (issue #410) and, when
   * `encounterId` is set, link it as that encounter's battle map + grid (the reveal/replace
   * path). Prompt, provider/model, seed/params, dimensions, provenance, moderation, and cost
   * are stamped into the attachment audit record. Orphan-safe: the attachment write is atomic
   * (rolls back its own bytes on failure), and it is the ONLY disk write in the whole flow.
   *
   * The `caller` policy (issue #410): the autonomous DRIVER seat may generate/preview during
   * prep but may NOT reveal/replace a LIVE map — so a driver-created job is refused an
   * `encounterId` link here unless an explicit policy/approval is provided by the DM.
   */
  async attach(
    campaignId: number,
    jobId: string,
    body: AttachGeneratedMapRequest,
    user: RequestUser,
    role: Role,
    opts: { allowLiveReplace?: boolean } = {},
  ): Promise<{ attachment: Attachment; result: GeneratedMapResult | null; provenance: AiMapProvenance }> {
    const record = this.requireJob(jobId, campaignId);
    if (record.job.status !== 'succeeded') {
      throw new ConflictException(`Job ${jobId} is ${record.job.status}; only a succeeded job can be attached.`);
    }
    const preview = record.job.previews.find((p) => p.id === body.previewId);
    const stored = record.bytes.get(body.previewId);
    if (!preview || !stored) {
      throw new NotFoundException(`Preview ${body.previewId} not found on job ${jobId}.`);
    }

    // Driver reveal/replace policy (issue #410): generating/previewing during prep is fine, but
    // linking a generated map onto a LIVE encounter (reveal/replace) is a DM decision.
    if (body.encounterId !== undefined && record.caller === 'driver' && !opts.allowLiveReplace) {
      throw new ForbiddenException(
        'The autonomous AI DM seat may generate maps during prep but cannot reveal/replace a live map without DM approval. Attach without an encounterId, or have the DM link it.',
      );
    }

    const ext = mimeExt(stored.mime);
    const filename = sanitizeMapFilename(body.filename ?? `ai-map-${preview.seed}`) + `.${ext}`;
    const auditDetail = this.buildAttachAuditDetail(record.job, preview);

    const attachment = await this.attachments.createGenerated(
      campaignId,
      'map',
      { filename, mime: stored.mime, bytes: stored.buf, metadata: {
        title: body.filename ?? `AI map (${preview.seed})`,
        // The prompt can contain private DM prep, so it is deliberately kept in
        // the restricted audit trail and never copied into player-visible alt text.
        altText: 'AI-generated battle map',
        creator: preview.provenance.label,
        sourceUrl: '',
        // Generation origin is not a licence. Leave this unknown unless a real
        // provider/output licence is supplied, and retain the caveat in rights.
        license: '',
        rights: 'Review provider terms before redistribution.',
        attribution: preview.provenance.label,
      } },
      user,
      role,
      auditDetail,
    );

    // Durable provenance beyond the attachment row: record the (excerpted) prompt + honest
    // provenance label so the origin of a genuine-AI map is always attributable from the log.
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'ai-map.attach',
      entityType: 'attachment',
      entityId: attachment.id,
      campaignId,
      detail:
        `ai map attached: ${preview.provenance.label} | prompt="${excerpt(record.job.prompt, 200)}" | ` +
        `seed=${preview.seed} moderation=${record.job.moderation.flagged ? 'flagged' : 'clean'} ` +
        `cost=${record.job.cost.imageCount}img/${record.job.cost.tokensUsed}tok`,
    });

    let result: GeneratedMapResult | null = null;
    if (body.encounterId !== undefined && preview.gridConfig) {
      const row = await this.encounters.getRowOrThrow(body.encounterId);
      if (row.campaignId !== campaignId) {
        throw new BadRequestException(`Encounter ${body.encounterId} is not in campaign ${campaignId}.`);
      }
      await this.encounters.updateEncounter(
        body.encounterId,
        {
          mapAttachmentId: attachment.id,
          mapAlignment: body.mapAlignment,
          gridSize: preview.gridConfig.gridSize,
          gridScale: preview.gridConfig.gridScale,
          gridUnit: preview.gridConfig.gridUnit,
          gridType: preview.gridConfig.gridType,
        },
        user,
        role,
      );
      result = {
        attachmentId: attachment.id,
        seed: preview.seed,
        kind: (record.request.kind ?? 'dungeon') as MapKind,
        widthCells: Math.max(1, Math.round(preview.width / 40)),
        heightCells: Math.max(1, Math.round(preview.height / 40)),
        roomCount: 0,
        gridConfig: preview.gridConfig,
      };
    }

    return { attachment, result, provenance: preview.provenance };
  }

  // ── generation core ───────────────────────────────────────────────────────────

  private async runGeneration(
    record: JobRecord,
    config: AiProviderConfig | null,
    user: RequestUser,
    role: Role,
    caller: AiMapCaller,
  ): Promise<void> {
    const { job } = record;
    try {
      if (job.method === 'image-provider' && config) {
        await this.generateWithImageProvider(record, config);
      } else if (job.method === 'procedural-blueprint') {
        this.generateWithProcedural(record, config);
      } else {
        this.generateExternalInstructions(record);
      }
      job.status = 'succeeded';
      job.progress = 100;
      job.updatedAt = nowIso();
      await this.audit.log({
        actor: auditActor(user),
        actorRole: role,
        action: 'ai-map.generate',
        entityType: 'campaign',
        entityId: job.campaignId,
        campaignId: job.campaignId,
        detail:
          `ai map generated method=${job.method} provider=${job.provider ?? 'none'} model=${job.model ?? 'none'} ` +
          `previews=${job.previews.length} cost=${job.cost.imageCount}img/${job.cost.tokensUsed}tok by ${caller}`,
      });
    } catch (err) {
      if (record.abort.signal.aborted) {
        // Cancellation already set the terminal state; don't overwrite it.
        return;
      }
      // Image-provider failure → degrade to the honest procedural fallback (issue #410).
      if (job.method === 'image-provider') {
        this.logger.warn(
          `Image provider failed for job ${job.id}; falling back to procedural blueprint: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        try {
          job.method = 'procedural-blueprint';
          job.warnings = [...job.warnings, 'Image provider unavailable — rendered with the procedural generator instead.'];
          this.generateWithProcedural(record, config);
          job.status = 'succeeded';
          job.progress = 100;
          job.updatedAt = nowIso();
          return;
        } catch (fallbackErr) {
          job.error = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        }
      } else {
        job.error = err instanceof Error ? err.message : String(err);
      }
      job.status = 'failed';
      job.progress = 100;
      job.updatedAt = nowIso();
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
    const previews: AiMapPreview[] = result.images.map((img, i) => {
      const seed = `${baseSeed(request)}-${i}`;
      const previewId = `${job.id}-p${i}`;
      record.bytes.set(previewId, { buf: img.bytes, mime: img.mime });
      const provenance: AiMapProvenance = {
        method: 'image-provider',
        providerType: config.providerType,
        model: result.model,
        label: `Generated by ${config.providerType} image model "${result.model}".`,
        seed,
      };
      const warnings =
        request.mode === 'battle-map'
          ? ['Raster image: the grid is an overlay estimate, not cell-perfect. Calibrate the grid after attaching.']
          : [];
      return {
        id: previewId,
        method: 'image-provider',
        svg: null,
        imageBase64: img.bytes.toString('base64'),
        mime: img.mime,
        width: img.width ?? dims.width,
        height: img.height ?? dims.height,
        seed,
        gridConfig: request.mode === 'battle-map' ? this.estimateGrid(request) : null,
        provenance,
        warnings,
      };
    });
    job.previews = previews;
    job.cost = { imageCount: previews.length, tokensUsed: result.usage.tokensUsed, estimatedUsd: job.cost.estimatedUsd };
    job.dimensions = dims;
    if (previews.length === 0) throw new AiProviderError('invalid_request', 'image provider returned no previews');
  }

  /**
   * Render candidates with Campfire's OWN procedural generator (#306) from a blueprint derived
   * from the brief/chips. HONEST provenance: even when a text provider is configured, the
   * IMAGE was drawn by the first-party renderer — the label says so and never credits the text
   * model with drawing it.
   */
  private generateWithProcedural(record: JobRecord, config: AiProviderConfig | null): void {
    const { job, request } = record;
    const kind = (request.kind ?? kindFromChips(request.chips) ?? 'dungeon') as MapKind;
    const size = (request.size ?? 'medium') as MapSize;
    const theme = normalizeMapTheme(request.theme) ?? normalizeMapTheme(request.chips?.terrain);
    const previews: AiMapPreview[] = [];
    for (let i = 0; i < request.count; i++) {
      const seed = `${baseSeed(request)}-${i}`;
      const map = generateMap({
        kind,
        size,
        seed,
        complexity: request.complexity,
        theme,
        gridScale: request.gridScale,
        gridUnit: request.gridUnit,
      });
      const previewId = `${job.id}-p${i}`;
      record.bytes.set(previewId, { buf: Buffer.from(map.svg, 'utf8'), mime: 'image/svg+xml' });
      const label = config
        ? `Blueprint informed by ${config.providerType}; drawn by Campfire's procedural renderer (the text model did not generate an image).`
        : "Drawn by Campfire's procedural renderer (no image-capable provider configured).";
      previews.push({
        id: previewId,
        method: 'procedural-blueprint',
        svg: map.svg,
        imageBase64: null,
        mime: 'image/svg+xml',
        width: map.widthCells * 40,
        height: map.heightCells * 40,
        seed,
        gridConfig: map.gridConfig,
        provenance: {
          method: 'procedural-blueprint',
          providerType: config?.providerType ?? null,
          model: config?.model ?? null,
          label,
          seed,
        },
        warnings: request.mode === 'concept-art'
          ? ['Concept-art requested but no image provider is available; showing a grid-aligned procedural battle map instead.']
          : [],
      });
    }
    job.previews = previews;
    job.cost = { imageCount: 0, tokensUsed: 0, estimatedUsd: 0 };
  }

  /** Terminal fallback (issue #410): no capable provider — return concrete external steps. */
  private generateExternalInstructions(record: JobRecord): void {
    const { job } = record;
    job.previews = [];
    job.cost = { imageCount: 0, tokensUsed: 0, estimatedUsd: 0 };
    job.externalInstructions = [
      'No image-capable AI provider is configured for this campaign, and concept art cannot be produced by the first-party procedural renderer.',
      'Option A — configure an OpenAI-compatible image provider (Settings → AI provider), then re-run this generation.',
      'Option B — generate a battle map with the built-in procedural generator (POST .../maps/generate) which is offline and license-clean.',
      `Option C — use an external generator (e.g. Watabou / donjon) with this brief, export the image, then import it: "${excerpt(job.prompt, 200)}".`,
    ];
  }

  // ── routing + estimation helpers ───────────────────────────────────────────────

  /** Decide which method WOULD serve this request given the resolved provider (issue #410). */
  private chooseMethod(request: AiMapGenerationRequest, config: AiProviderConfig | null): AiMapGenerationMethod {
    const canImage = !!config && providerCapabilities(config.providerType).imageGeneration === true;
    if (canImage) return 'image-provider';
    // No image provider: a battle map can still be produced procedurally; concept art can't.
    if (request.mode === 'battle-map') return 'procedural-blueprint';
    return 'external-instructions';
  }

  private estimateCost(method: AiMapGenerationMethod, request: AiMapGenerationRequest): AiMapCost {
    if (method === 'image-provider') {
      return { imageCount: request.count, tokensUsed: 0, estimatedUsd: null };
    }
    return { imageCount: 0, tokensUsed: 0, estimatedUsd: 0 };
  }

  private readinessFor(
    method: AiMapGenerationMethod,
    request: AiMapGenerationRequest,
  ): { gridLikely: boolean; doorsLikely: boolean; corridorsLikely: boolean; warnings: string[] } {
    const warnings: string[] = [];
    if (method === 'procedural-blueprint') {
      const kind = request.kind ?? kindFromChips(request.chips) ?? 'dungeon';
      const doorsLikely = kind === 'dungeon';
      const corridorsLikely = kind === 'dungeon';
      if (!doorsLikely) warnings.push(`Doors/corridors are unlikely for kind "${kind}" — use "dungeon" for room-and-corridor layouts.`);
      if (request.mode === 'concept-art') warnings.push('Concept-art requested but will render as a procedural battle map (no image provider).');
      return { gridLikely: true, doorsLikely, corridorsLikely, warnings };
    }
    if (method === 'image-provider') {
      warnings.push('Raster AI images do not guarantee cell-perfect grids, connected corridors, or usable doors — calibrate the grid after attaching.');
      return { gridLikely: false, doorsLikely: false, corridorsLikely: false, warnings };
    }
    warnings.push('No image-capable provider configured — concept art requires an external generator.');
    return { gridLikely: false, doorsLikely: false, corridorsLikely: false, warnings };
  }

  private dimensionsFor(request: AiMapGenerationRequest): { width: number; height: number } {
    return request.dimensions ?? DEFAULT_IMAGE_DIMENSIONS;
  }

  /** A best-effort grid overlay for a raster battle-map image (calibratable afterwards). */
  private estimateGrid(request: AiMapGenerationRequest) {
    const cells = request.chips?.gridSizeCells ?? 20;
    return {
      gridSize: Math.max(1, Math.min(100, 100 / cells)),
      gridScale: request.gridScale ?? 5,
      gridUnit: request.gridUnit ?? 'ft',
      gridType: 'square' as const,
    };
  }

  private buildAttachAuditDetail(job: AiMapGenerationJob, preview: AiMapPreview): string {
    const dims = job.dimensions ? `${job.dimensions.width}x${job.dimensions.height}` : 'svg';
    return (
      `map:ai:method=${preview.provenance.method}:provider=${preview.provenance.providerType ?? 'none'}:` +
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
      throw new NotFoundException(`AI map job ${jobId} not found for this campaign.`);
    }
    return record;
  }

  private enforceRateAndConcurrency(campaignId: number): void {
    const running = [...this.jobs.values()].filter(
      (r) => r.job.campaignId === campaignId && (r.job.status === 'running' || r.job.status === 'queued'),
    ).length;
    if (running >= MAX_CONCURRENT_PER_CAMPAIGN) {
      throw new ServiceUnavailableException(
        `Too many AI map generations already running for this campaign (max ${MAX_CONCURRENT_PER_CAMPAIGN}). Wait for one to finish.`,
      );
    }
    const last = this.lastStart.get(campaignId);
    if (last !== undefined && AI_MAP_RATE_LIMIT_MS > 0 && Date.now() - last < AI_MAP_RATE_LIMIT_MS) {
      throw new ServiceUnavailableException('AI map generation is rate-limited; please wait a moment before generating again.');
    }
  }
}

// ── pure helpers (exported for unit tests) ──────────────────────────────────────

/** Fold the prompt + chips into one text brief the provider/blueprint consumes (issue #410). */
export function composePrompt(request: AiMapGenerationRequest): string {
  const parts: string[] = [request.prompt.trim()];
  const c = request.chips;
  if (c) {
    if (c.terrain) parts.push(`Terrain: ${c.terrain}.`);
    if (c.encounterType) parts.push(`Encounter type: ${c.encounterType}.`);
    if (c.mood) parts.push(`Mood: ${c.mood}.`);
    if (c.hazards.length > 0) parts.push(`Hazards: ${c.hazards.join(', ')}.`);
    if (c.landmarks.length > 0) parts.push(`Landmarks: ${c.landmarks.join(', ')}.`);
    if (c.gridSizeCells) parts.push(`Grid: ${c.gridSizeCells} cells across.`);
  }
  if (request.mode === 'battle-map') {
    parts.push('Render a top-down tactical battle map with a clear square grid, walls, doors, and corridors.');
  } else {
    parts.push('Render illustrative concept art of the scene (no tactical grid required).');
  }
  return parts.join(' ');
}

/**
 * Deterministic, offline content-moderation gate for a map prompt (issue #410). Conservative
 * keyword screen: blocks prompts that combine minors with sexual content, or that request
 * real-person sexual imagery. This is a guardrail, not a classifier — provider-side moderation
 * still applies to real image calls. Returns a structured result (never throws).
 */
export function moderateMapPrompt(prompt: string): AiMapModeration {
  const p = ` ${prompt.toLowerCase()} `;
  const categories: string[] = [];
  const sexual = /(sexual|nude|nudity|explicit|porn|nsfw|erotic)/.test(p);
  const minors = /(child|children|kid|minor|underage|infant|toddler|preteen|prepubescent)/.test(p);
  if (sexual && minors) categories.push('csae');
  if (/(gore|dismember|torture)\b/.test(p) && sexual) categories.push('sexual-violence');
  return {
    flagged: categories.length > 0,
    categories,
    note: categories.length > 0 ? 'Prompt blocked by the content-moderation gate.' : null,
  };
}

/** Resolve a stable base seed for a request (caller's, or a fresh crypto-random hex). */
function baseSeed(request: AiMapGenerationRequest): string {
  return request.seed ?? crypto.randomBytes(8).toString('hex');
}

/** Merge two chip sets (refine over base), concatenating list fields uniquely. */
function mergeChips(base: AiMapChips | undefined, over: AiMapChips | undefined): AiMapChips | undefined {
  if (!base) return over;
  if (!over) return base;
  return {
    terrain: over.terrain ?? base.terrain,
    encounterType: over.encounterType ?? base.encounterType,
    mood: over.mood ?? base.mood,
    hazards: [...new Set([...base.hazards, ...over.hazards])].slice(0, 12),
    landmarks: [...new Set([...base.landmarks, ...over.landmarks])].slice(0, 12),
    gridSizeCells: over.gridSizeCells ?? base.gridSizeCells,
  };
}

/** Infer a MapKind from the terrain chip when the request doesn't pick one. */
function kindFromChips(chips: AiMapChips | undefined): MapKind | undefined {
  const terrain = chips?.terrain?.toLowerCase() ?? '';
  if (/cave|cavern|underground|grotto|mine/.test(terrain)) return 'cave';
  if (/forest|wood|jungle|swamp|marsh|wild|outdoor|field|plain/.test(terrain)) return 'wilderness';
  if (/dungeon|crypt|tomb|keep|castle|temple|ruin/.test(terrain)) return 'dungeon';
  return undefined;
}

/** File extension for a stored mime type. */
function mimeExt(mime: string): string {
  switch (mime) {
    case 'image/svg+xml':
      return 'svg';
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
function sanitizeMapFilename(s: string): string {
  return s.replace(/[ -/\\]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || 'ai-map';
}

/** Short excerpt for audit/instruction strings. */
function excerpt(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}
