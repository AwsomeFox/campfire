import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { InboxSweepEntityType } from '@campfire/schema';
import { AiProviderConfigService } from '../ai-provider-config/ai-provider-config.service';
import { createAiProvider, type AiProviderConfig } from '../ai-dm/providers/factory';

/**
 * Bootstrapped campaign context (issue #1644) — the cheap `get_campaign_summary`-shaped
 * id/name lists the classifier needs to choose create-vs-update and pick a target id.
 * Deliberately just ids+names, never dmSecret/hidden-flag content: the sweep runs with
 * DM authority (the route is dm-gated), so this is safe to hand to the model, but there
 * is no reason to widen the blast radius of a provider call by including secret text.
 */
export interface InboxSweepContext {
  campaignId: number;
  quests: Array<{ id: number; name: string }>;
  npcs: Array<{ id: number; name: string }>;
  locations: Array<{ id: number; name: string }>;
  characters: Array<{ id: number; name: string }>;
}

/** One inbox capture to classify. */
export interface InboxSweepCapture {
  noteId: number;
  body: string;
}

const ClassificationSchema = z.object({
  action: z.enum(['create', 'update', 'dismiss', 'unsupported']),
  entityType: InboxSweepEntityType.nullable().default(null),
  targetId: z.number().int().positive().nullable().default(null),
  fields: z.record(z.string(), z.unknown()).default({}),
  reason: z.string().min(1).max(1000),
});

export type InboxSweepClassification = z.infer<typeof ClassificationSchema>;

/** Thrown by the default classifier when no AI provider is configured for the campaign. */
export class NoProviderConfiguredError extends Error {
  constructor() {
    super('no AI provider configured for this campaign');
    this.name = 'NoProviderConfiguredError';
  }
}

/** Thrown when the provider responded, but not with the classifier JSON contract. */
export class InvalidInboxSweepClassificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInboxSweepClassificationError';
  }
}

export const INBOX_SWEEP_CLASSIFIER = Symbol('INBOX_SWEEP_CLASSIFIER');

/** DI seam (mirrors AI_DM_PROVIDER) so orchestration is testable without a live model. */
export interface InboxSweepClassifier {
  classify(
    capture: InboxSweepCapture,
    context: InboxSweepContext,
    config?: AiProviderConfig | null,
  ): Promise<InboxSweepClassification>;
}

function buildSystemPrompt(context: InboxSweepContext): string {
  return (
    'You are the campaign scribe triaging one open inbox capture (a DM-facing note or ' +
    'player suggestion) for a tabletop campaign. Decide what canon change, if any, it implies.\n\n' +
    'Known campaign entities (choose a targetId from here when action="update"; never invent an id):\n' +
    JSON.stringify(
      {
        quests: context.quests,
        npcs: context.npcs,
        locations: context.locations,
        characters: context.characters,
      },
      null,
      0,
    ) +
    '\n\n' +
    'Respond with ONLY a single JSON object, no prose, matching exactly:\n' +
    '{"action":"create"|"update"|"dismiss"|"unsupported",' +
    '"entityType":"quest"|"npc"|"location"|"character"|null,' +
    '"targetId": number|null,' +
    '"fields": object,' +
    '"reason": string}\n\n' +
    'Rules:\n' +
    '- action="create": entityType is set, targetId is null, fields holds the new entity\'s ' +
    'fields (quest needs "title"; npc/location/character need "name").\n' +
    '- action="update": entityType and targetId (an id from the known entities above) are set, ' +
    'fields holds only the changed fields.\n' +
    '- action="dismiss": the capture implies no canon change (e.g. banter, a question already ' +
    'answered in play). entityType/targetId are null, fields is empty.\n' +
    '- action="unsupported": the capture asks for something this sweep cannot do — objective ' +
    'ticks, HP changes, or combat/initiative writes are ALWAYS unsupported. entityType/targetId ' +
    'are null, fields is empty, and reason must say what kind of write is needed instead.\n' +
    '- "reason" is always a short human-readable explanation, shown to the DM.'
  );
}

function extractJsonObject(text: string): unknown {
  // Providers are instructed to respond with ONLY the JSON object, so the common case is
  // the whole (trimmed) response parsing cleanly — try that first rather than always doing
  // first-`{`/last-`}` slicing, which can span the wrong boundaries if the model wraps the
  // object in prose that itself contains braces.
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to brace-slicing below
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('provider response did not contain a JSON object');
  }
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * Default classifier (issue #1644): one model call per capture, not a batch.
 *
 * Why per-capture rather than batched: each capture's outcome (proposed / skipped /
 * errored) is filed and resolved independently and must be individually retry-safe —
 * a single batched call that partially fails would leave an ambiguous "which of these
 * N items actually got a valid answer" state to untangle. Per-capture calls also let
 * this reuse the exact same provider-resolution shape as the AI scribe (#316) with no
 * new batching/parsing contract, at the cost of N calls instead of one; the sweep is a
 * DM-triggered, on-demand action (not a hot loop), so that cost is acceptable.
 */
@Injectable()
export class AiInboxSweepClassifier implements InboxSweepClassifier {
  constructor(@Inject(AiProviderConfigService) private readonly providerConfig: AiProviderConfigService) {}

  async classify(
    capture: InboxSweepCapture,
    context: InboxSweepContext,
    resolvedConfig?: AiProviderConfig | null,
  ): Promise<InboxSweepClassification> {
    const config =
      resolvedConfig === undefined
        ? (await this.providerConfig.resolveEffectiveConfigWithEndpointScope(context.campaignId)).config
        : resolvedConfig;
    if (!config) throw new NoProviderConfiguredError();

    const provider = createAiProvider(config);
    const result = await provider.generate({
      system: buildSystemPrompt(context),
      messages: [{ role: 'user', content: capture.body }],
      model: config.model,
      maxTokens: config.params?.maxTokens ?? 600,
    });

    try {
      return ClassificationSchema.parse(extractJsonObject(result.text));
    } catch (err) {
      throw new InvalidInboxSweepClassificationError(
        `invalid classifier response: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
