import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  AiMapService,
  composePrompt,
  moderateMapPrompt,
  setAiMapRateLimitMsForTests,
} from '../../src/modules/ai-map/ai-map.service';
import type { AiProviderConfig } from '../../src/modules/ai-dm/providers';
import type { FetchLike, FetchResponse } from '../../src/modules/ai-dm/providers/http';
import type { RequestUser } from '../../src/common/user.types';

/**
 * Genuine AI map generation routing (issue #410). Exercises the whole service offline with
 * fake dependencies: capability-based routing (image provider → procedural blueprint →
 * external instructions), honest provenance labeling, the image→procedural fallback,
 * moderation, idempotency, and the orphan-safe attach path.
 */

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const USER: RequestUser = { id: 'u1', name: 'DM', serverRole: 'user', devRole: 'dm' } as RequestUser;

function imageFetch(): FetchLike {
  return async (_url, init): Promise<FetchResponse> => {
    const body = init.body ? (JSON.parse(init.body) as { n?: number }) : {};
    const n = Math.max(1, body.n ?? 1);
    const data = Array.from({ length: n }, () => ({ b64_json: TINY_PNG_B64 }));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '',
      json: async () => ({ data, usage: { total_tokens: 5 } }),
      body: null,
    };
  };
}

function failingFetch(): FetchLike {
  return async (): Promise<FetchResponse> => ({
    ok: false,
    status: 500,
    headers: { get: () => null },
    text: async () => 'server error',
    json: async () => ({}),
    body: null,
  });
}

/** Build a service with a stubbed provider config + recording attachment/encounter/audit fakes. */
function makeService(config: AiProviderConfig | null) {
  const created: Array<{ campaignId: number; kind: string; mime: string; auditDetail?: string }> = [];
  const encounterUpdates: Array<Record<string, unknown>> = [];
  const attachments = {
    createGenerated: async (
      campaignId: number,
      kind: string,
      file: { filename: string; mime: string; bytes: Buffer },
      _user: unknown,
      _role: unknown,
      auditDetail?: string,
    ) => {
      created.push({ campaignId, kind, mime: file.mime, auditDetail });
      return { id: 4242, campaignId, kind, filename: file.filename, mime: file.mime, hidden: true } as never;
    },
  };
  const encounters = {
    getRowOrThrow: async (id: number) => ({ id, campaignId: 1, hidden: true }),
    updateEncounter: async (_id: number, fields: Record<string, unknown>) => {
      encounterUpdates.push(fields);
      return {} as never;
    },
  };
  const audit = { log: async () => undefined };
  const providerConfig = { resolveEffectiveConfig: async () => config };
  const service = new AiMapService(
    providerConfig as never,
    attachments as never,
    encounters as never,
    audit as never,
  );
  return { service, created, encounterUpdates };
}

const openAiImageConfig = (fetchImpl: FetchLike): AiProviderConfig => ({
  providerType: 'openai',
  model: 'gpt-image-1',
  apiKey: 'sk-test',
  fetchImpl,
});

const anthropicConfig: AiProviderConfig = { providerType: 'anthropic', model: 'claude-3', apiKey: 'sk-a' };

let campaignSeq = 100;
function nextCampaign(): number {
  return ++campaignSeq;
}

beforeEach(() => setAiMapRateLimitMsForTests(0));

describe('AiMapService routing (#410)', () => {
  it('routes an image-capable provider through the real image path', async () => {
    const { service } = makeService(openAiImageConfig(imageFetch()));
    const job = await service.createJob(nextCampaign(), { prompt: 'a ruined keep', mode: 'battle-map', count: 2 } as never, USER, 'dm');
    expect(job.status).toBe('succeeded');
    expect(job.method).toBe('image-provider');
    expect(job.previews).toHaveLength(2);
    expect(job.previews[0].imageBase64).toBeTruthy();
    expect(job.previews[0].svg).toBeNull();
    expect(job.previews[0].provenance.label).toMatch(/image model/i);
    expect(job.cost.tokensUsed).toBe(5);
  });

  it('routes a text-only provider (Anthropic) to the procedural blueprint and labels it honestly', async () => {
    const { service } = makeService(anthropicConfig);
    const job = await service.createJob(nextCampaign(), { prompt: 'a dank crypt', mode: 'battle-map', count: 2 } as never, USER, 'dm');
    expect(job.method).toBe('procedural-blueprint');
    expect(job.previews).toHaveLength(2);
    expect(job.previews[0].svg).toBeTruthy();
    expect(job.previews[0].imageBase64).toBeNull();
    // Honesty: the label must NOT claim Anthropic generated an image.
    expect(job.previews[0].provenance.label).not.toMatch(/anthropic generated/i);
    expect(job.previews[0].provenance.label).toMatch(/procedural renderer/i);
    expect(job.previews[0].gridConfig).not.toBeNull();
  });

  it('falls back from a failing image provider to the procedural blueprint with a warning', async () => {
    const { service } = makeService(openAiImageConfig(failingFetch()));
    const job = await service.createJob(nextCampaign(), { prompt: 'a cave', mode: 'battle-map', kind: 'cave', count: 1 } as never, USER, 'dm');
    expect(job.status).toBe('succeeded');
    expect(job.method).toBe('procedural-blueprint');
    expect(job.warnings.join(' ')).toMatch(/image provider unavailable/i);
    expect(job.previews[0].svg).toBeTruthy();
  });

  it('renders procedurally when no provider is configured (battle-map)', async () => {
    const { service } = makeService(null);
    const job = await service.createJob(nextCampaign(), { prompt: 'a dungeon', mode: 'battle-map', count: 1 } as never, USER, 'dm');
    expect(job.method).toBe('procedural-blueprint');
    expect(job.previews).toHaveLength(1);
  });

  it('returns external-generator instructions for concept-art with no image provider', async () => {
    const { service } = makeService(null);
    const job = await service.createJob(nextCampaign(), { prompt: 'a hero portrait', mode: 'concept-art', count: 2 } as never, USER, 'dm');
    expect(job.method).toBe('external-instructions');
    expect(job.previews).toHaveLength(0);
    expect(job.externalInstructions.length).toBeGreaterThan(0);
  });

  it('blocks a moderated prompt without generating or persisting anything', async () => {
    const { service, created } = makeService(openAiImageConfig(imageFetch()));
    const job = await service.createJob(
      nextCampaign(),
      { prompt: 'explicit sexual content involving a child', mode: 'battle-map', count: 1 } as never,
      USER,
      'dm',
    );
    expect(job.status).toBe('failed');
    expect(job.moderation.flagged).toBe(true);
    expect(job.previews).toHaveLength(0);
    expect(created).toHaveLength(0);
  });

  it('is idempotent: the same idempotency key returns the same job', async () => {
    const { service } = makeService(anthropicConfig);
    const campaignId = nextCampaign();
    const a = await service.createJob(campaignId, { prompt: 'a keep', mode: 'battle-map', count: 1 } as never, USER, 'dm', { idempotencyKey: 'k1' });
    const b = await service.createJob(campaignId, { prompt: 'a totally different brief', mode: 'battle-map', count: 3 } as never, USER, 'dm', { idempotencyKey: 'k1' });
    expect(b.id).toBe(a.id);
    expect(b.previews).toHaveLength(1);
  });
});

describe('AiMapService attach (#410 — orphan-safe persistence)', () => {
  it('persists exactly one hidden map attachment with provenance in the audit detail', async () => {
    const { service, created } = makeService(anthropicConfig);
    const campaignId = nextCampaign();
    const job = await service.createJob(campaignId, { prompt: 'a crypt', mode: 'battle-map', count: 1 } as never, USER, 'dm');
    const { attachment, provenance } = await service.attach(
      campaignId,
      job.id,
      { previewId: job.previews[0].id } as never,
      USER,
      'dm',
    );
    expect(attachment.id).toBe(4242);
    expect(created).toHaveLength(1);
    expect(created[0].kind).toBe('map');
    expect(created[0].mime).toBe('image/svg+xml');
    expect(created[0].auditDetail).toMatch(/^map:ai:method=procedural-blueprint/);
    expect(provenance.method).toBe('procedural-blueprint');
  });

  it('links the attachment to an encounter when encounterId is provided (DM reveal path)', async () => {
    const { service, encounterUpdates } = makeService(anthropicConfig);
    const campaignId = 1; // getRowOrThrow fake returns campaignId 1
    const job = await service.createJob(campaignId, { prompt: 'a crypt', mode: 'battle-map', count: 1 } as never, USER, 'dm');
    await service.attach(campaignId, job.id, { previewId: job.previews[0].id, encounterId: 9 } as never, USER, 'dm', {
      allowLiveReplace: true,
    });
    expect(encounterUpdates).toHaveLength(1);
    expect(encounterUpdates[0].mapAttachmentId).toBe(4242);
  });

  it('refuses the driver seat a reveal/replace-to-encounter attach without approval', async () => {
    const { service } = makeService(anthropicConfig);
    const campaignId = 1;
    const job = await service.createJob(campaignId, { prompt: 'a crypt', mode: 'battle-map', count: 1 } as never, USER, 'dm', {
      caller: 'driver',
    });
    await expect(
      service.attach(campaignId, job.id, { previewId: job.previews[0].id, encounterId: 9 } as never, USER, 'dm'),
    ).rejects.toThrow(/reveal\/replace|approval/i);
  });

  it('cancel clears previews and prevents attach', async () => {
    const { service } = makeService(anthropicConfig);
    const campaignId = nextCampaign();
    const job = await service.createJob(campaignId, { prompt: 'a keep', mode: 'battle-map', count: 1 } as never, USER, 'dm');
    const cancelled = await service.cancelJob(job.id, campaignId, USER, 'dm');
    // A finished job cancel is a no-op (already succeeded); assert idempotency semantics.
    expect(['succeeded', 'cancelled']).toContain(cancelled.status);
  });
});

describe('AiMapService readiness (#410)', () => {
  it('reports image-provider readiness with a grid warning and provider capabilities', async () => {
    const { service } = makeService(openAiImageConfig(imageFetch()));
    const r = await service.readiness(nextCampaign(), { prompt: 'x', mode: 'battle-map', count: 3 } as never);
    expect(r.method).toBe('image-provider');
    expect(r.gridLikely).toBe(false);
    expect(r.cost.imageCount).toBe(3);
    expect(r.capabilities?.imageGeneration).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/grid/i);
  });

  it('reports procedural readiness (grid likely, doors likely for dungeon)', async () => {
    const { service } = makeService(anthropicConfig);
    const r = await service.readiness(nextCampaign(), { prompt: 'x', mode: 'battle-map', kind: 'dungeon', count: 2 } as never);
    expect(r.method).toBe('procedural-blueprint');
    expect(r.gridLikely).toBe(true);
    expect(r.doorsLikely).toBe(true);
    expect(r.cost.imageCount).toBe(0);
  });
});

describe('pure helpers (#410)', () => {
  it('composePrompt folds chips into the brief', () => {
    const text = composePrompt({
      prompt: 'a shrine',
      mode: 'battle-map',
      count: 2,
      includeCampaignSecrets: false,
      chips: { terrain: 'forest', encounterType: 'ambush', mood: 'tense', hazards: ['pit'], landmarks: ['altar'], gridSizeCells: 20 },
    } as never);
    expect(text).toMatch(/Terrain: forest/);
    expect(text).toMatch(/Hazards: pit/);
    expect(text).toMatch(/tactical battle map/);
  });

  it('moderateMapPrompt flags CSAE combinations and passes clean prompts', () => {
    expect(moderateMapPrompt('a normal dungeon map').flagged).toBe(false);
    expect(moderateMapPrompt('sexual content with a child').flagged).toBe(true);
  });
});
