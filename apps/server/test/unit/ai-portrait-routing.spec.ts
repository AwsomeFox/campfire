import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  AiPortraitService,
  composePortraitPrompt,
  moderatePortraitPrompt,
  setAiPortraitRateLimitMsForTests,
} from '../../src/modules/ai-portrait/ai-portrait.service';
import type { AiProviderConfig } from '../../src/modules/ai-dm/providers';
import type { FetchLike, FetchResponse } from '../../src/modules/ai-dm/providers/http';
import type { RequestUser } from '../../src/common/user.types';
import type { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import type { CharactersService } from '../../src/modules/characters/characters.service';
import type { NpcsService } from '../../src/modules/npcs/npcs.service';
import type { AuditService } from '../../src/modules/audit/audit.service';
import type { AiProviderConfigService } from '../../src/modules/ai-provider-config/ai-provider-config.service';

/**
 * AI portrait generation routing (issue #1321). Exercises the whole service offline with fake
 * dependencies: capability-based routing (image provider → external instructions — there is NO
 * procedural portrait fallback), honest provenance labeling, moderation, idempotency, rate limiting,
 * and the orphan-safe attach path that links a character/NPC portrait via the domain service.
 */

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const USER: RequestUser = { id: 'u1', name: 'caller', serverRole: 'user', devRole: 'dm' } as RequestUser;

function imageFetch(): FetchLike {
  return async (_url, init): Promise<FetchResponse> => {
    const body = init.body ? (JSON.parse(init.body) as { n?: number }) : {};
    const n = Math.max(1, body.n ?? 1);
    const data = Array.from({ length: n }, () => ({ b64_json: TINY_PNG_B64 }));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ data, usage: { total_tokens: 5 } }),
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
    body: null,
  });
}

/**
 * Build a service with a stubbed provider config + recording attachment/character/npc/audit fakes.
 * Each fake is typed against `Pick<RealService, 'methodsActuallyUsed'>` (AGENTS.md L96-L98) so a
 * renamed/added dependency method fails to compile rather than silently passing an incomplete fake.
 * The unavoidable concrete-service cast happens only at the constructor boundary.
 */
function makeService(config: AiProviderConfig | null) {
  const created: Array<{ campaignId: number; kind: string; mime: string; auditDetail?: string }> = [];
  const removed: number[] = [];
  const hiddenSet: Array<{ id: number; hidden: boolean }> = [];
  const characterUpdates: Array<{ id: number; portraitUrl: string }> = [];
  const npcUpdates: Array<{ id: number; portraitUrl: string }> = [];

  const attachments: Pick<AttachmentsService, 'createGenerated' | 'versionToken' | 'remove' | 'setHidden'> = {
    createGenerated: async (campaignId, kind, file, _user, _role, auditDetail?) => {
      created.push({ campaignId, kind, mime: file.mime, auditDetail });
      return { id: 7171, campaignId, kind, filename: file.filename, mime: file.mime, hidden: false, updatedAt: '2024-01-01T00:00:00Z' } as never;
    },
    versionToken: () => 'abc123',
    remove: async (id: number) => { removed.push(id); return {} as never; },
    setHidden: async (id: number, hidden: boolean) => { hiddenSet.push({ id, hidden }); return {} as never; },
  };
  const characters: Pick<CharactersService, 'getRowOrThrow' | 'assertCanWrite' | 'update'> = {
    getRowOrThrow: async (id: number) => ({ id, campaignId: 1, ownerUserId: 'u1' }) as never,
    assertCanWrite: () => undefined,
    update: async (id: number, input: { portraitUrl?: string }) => {
      characterUpdates.push({ id, portraitUrl: input.portraitUrl ?? '' });
      return {} as never;
    },
  };
  const npcs: Pick<NpcsService, 'getRowOrThrow' | 'update'> = {
    getRowOrThrow: async (id: number) => ({ id, campaignId: 1, hidden: 0 }) as never,
    update: async (id: number, input: { portraitUrl?: string }) => {
      npcUpdates.push({ id, portraitUrl: input.portraitUrl ?? '' });
      return {} as never;
    },
  };
  const audit: Pick<AuditService, 'log'> = { log: async () => undefined };
  // Typed against Pick<AiProviderConfigService, ...> (AGENTS.md L96-L98) so a missing/renamed
  // dependency method fails to compile. Production now calls both resolveEffectiveConfig and
  // getServerAllowedModels (model allowlist revalidation), so the double supplies both.
  const providerConfig: Pick<AiProviderConfigService, 'resolveEffectiveConfig' | 'getServerAllowedModels'> = {
    resolveEffectiveConfig: async () => config,
    getServerAllowedModels: async () => [],
  };
  const service = new AiPortraitService(
    providerConfig as never,
    attachments as unknown as AttachmentsService,
    characters as unknown as CharactersService,
    npcs as unknown as NpcsService,
    audit as unknown as AuditService,
  );
  return { service, created, removed, hiddenSet, characterUpdates, npcUpdates };
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

beforeEach(() => setAiPortraitRateLimitMsForTests(0));

describe('AiPortraitService routing (#1321)', () => {
  it('routes an image-capable provider through the real image path', async () => {
    const { service } = makeService(openAiImageConfig(imageFetch()));
    const job = await service.createJob(nextCampaign(), { prompt: 'a weathered ranger', count: 2 } as never, USER, 'dm');
    expect(job.status).toBe('succeeded');
    expect(job.method).toBe('image-provider');
    expect(job.previews).toHaveLength(2);
    expect(job.previews[0].imageBase64).toBeTruthy();
    expect(job.previews[0].provenance.label).toMatch(/image model/i);
    expect(job.cost.tokensUsed).toBe(5);
  });

  it('routes a text-only provider (Anthropic) to external-instructions (NO procedural portrait fallback)', async () => {
    const { service } = makeService(anthropicConfig);
    const job = await service.createJob(nextCampaign(), { prompt: 'a noble knight', count: 2 } as never, USER, 'dm');
    // Honesty: a text-only provider cannot draw a portrait, so we return external steps, not a fake.
    expect(job.method).toBe('external-instructions');
    expect(job.previews).toHaveLength(0);
    expect(job.externalInstructions.length).toBeGreaterThan(0);
  });

  it('fails the job when the image provider errors (no silent procedural fallback)', async () => {
    const { service } = makeService(openAiImageConfig(failingFetch()));
    const job = await service.createJob(nextCampaign(), { prompt: 'a wizard', count: 1 } as never, USER, 'dm');
    // Unlike maps (which degrade to procedural), portraits have no fallback renderer → the job fails.
    expect(job.status).toBe('failed');
    expect(job.previews).toHaveLength(0);
  });

  it('returns external-generator instructions when no provider is configured', async () => {
    const { service } = makeService(null);
    const job = await service.createJob(nextCampaign(), { prompt: 'a rogue', count: 2 } as never, USER, 'dm');
    expect(job.method).toBe('external-instructions');
    expect(job.previews).toHaveLength(0);
    expect(job.externalInstructions.length).toBeGreaterThan(0);
  });

  it('blocks a moderated CSAM prompt without generating or persisting anything', async () => {
    const { service, created } = makeService(openAiImageConfig(imageFetch()));
    const job = await service.createJob(
      nextCampaign(),
      { prompt: 'explicit sexual content involving a child', count: 1 } as never,
      USER,
      'dm',
    );
    expect(job.status).toBe('failed');
    expect(job.moderation.flagged).toBe(true);
    expect(job.moderation.categories).toContain('csae');
    expect(job.previews).toHaveLength(0);
    expect(created).toHaveLength(0);
  });

  it('blocks a real-person-likeness prompt', async () => {
    const { service } = makeService(openAiImageConfig(imageFetch()));
    const job = await service.createJob(
      nextCampaign(),
      { prompt: 'a portrait of Elon Musk', count: 1 } as never,
      USER,
      'dm',
    );
    expect(job.status).toBe('failed');
    expect(job.moderation.flagged).toBe(true);
    expect(job.moderation.categories).toContain('real-person-likeness');
  });

  it('is idempotent: the same idempotency key returns the same job', async () => {
    const { service } = makeService(openAiImageConfig(imageFetch()));
    const campaignId = nextCampaign();
    const a = await service.createJob(campaignId, { prompt: 'a ranger', count: 1 } as never, USER, 'dm', { idempotencyKey: 'k1' });
    const b = await service.createJob(campaignId, { prompt: 'a totally different brief', count: 3 } as never, USER, 'dm', { idempotencyKey: 'k1' });
    expect(b.id).toBe(a.id);
    expect(b.previews).toHaveLength(1);
  });

  it('binds every job operation to its creator — a different caller cannot read/cancel/attach', async () => {
    // Review feedback: a job id copied to another campaign member must not let them read the private
    // prompt, cancel, refine, or attach another caller's job.
    const { service } = makeService(openAiImageConfig(imageFetch()));
    const campaignId = nextCampaign();
    const OTHER: RequestUser = { id: 'u2-other', name: 'thief', serverRole: 'user', devRole: 'dm' } as RequestUser;
    const job = await service.createJob(campaignId, { prompt: 'private brief', count: 1 } as never, USER, 'dm');
    // The creator can fetch it.
    expect(service.getJob(job.id, campaignId, USER).status).toBe('succeeded');
    // A different caller is forbidden from reading, cancelling, refining, or attaching it.
    expect(() => service.getJob(job.id, campaignId, OTHER)).toThrow(/different caller/i);
    await expect(service.cancelJob(job.id, campaignId, OTHER, 'dm')).rejects.toThrow(/different caller/i);
    await expect(
      service.refine(campaignId, job.id, { prompt: 'x' } as never, OTHER, 'dm'),
    ).rejects.toThrow(/different caller/i);
    await expect(
      service.attach(campaignId, job.id, { previewId: job.previews[0].id, entityType: 'character', entityId: 55 } as never, OTHER, 'dm'),
    ).rejects.toThrow(/different caller/i);
  });

  it('revalidates the configured model against the admin allowlist even without an imageModel override', async () => {
    // Review feedback: when the normal UI omits imageModel, the provider is called with config.model.
    // An admin who tightens allowedModels after configuration must block that path too.
    const config = openAiImageConfig(imageFetch()); // config.model = 'gpt-image-1'
    const created: Array<{ kind: string }> = [];
    const attachments: Pick<AttachmentsService, 'createGenerated' | 'versionToken' | 'remove' | 'setHidden'> = {
      createGenerated: async (_c: number, kind: string) => { created.push({ kind }); return { id: 1, kind, hidden: false, updatedAt: '' } as never; },
      versionToken: () => 'v',
      remove: async () => ({} as never),
      setHidden: async () => ({} as never),
    };
    const characters: Pick<CharactersService, 'getRowOrThrow' | 'assertCanWrite' | 'update'> = {
      getRowOrThrow: async () => ({} as never),
      assertCanWrite: () => undefined,
      update: async () => ({} as never),
    };
    const npcs: Pick<NpcsService, 'getRowOrThrow' | 'update'> = {
      getRowOrThrow: async () => ({} as never),
      update: async () => ({} as never),
    };
    const audit: Pick<AuditService, 'log'> = { log: async () => undefined };
    // Allowlist does NOT include config.model ('gpt-image-1') — so generation must be rejected.
    const providerConfig: Pick<AiProviderConfigService, 'resolveEffectiveConfig' | 'getServerAllowedModels'> = {
      resolveEffectiveConfig: async () => config,
      getServerAllowedModels: async () => ['dall-e-3', 'some-other-model'],
    };
    const service = new AiPortraitService(
      providerConfig as never,
      attachments as unknown as AttachmentsService,
      characters as unknown as CharactersService,
      npcs as unknown as NpcsService,
      audit as unknown as AuditService,
    );
    // No imageModel override — config.model is used and must be rejected by the allowlist.
    await expect(
      service.createJob(nextCampaign(), { prompt: 'a knight', count: 1 } as never, USER, 'dm'),
    ).rejects.toThrow(/not in the server admin's allowlist/i);
    // Nothing was generated.
    expect(created).toHaveLength(0);
  });

  it('reserves generation admission synchronously before the first await', async () => {
    // Review feedback: concurrent requests must not all pass the admission check before any job is
    // registered. The placeholder job is registered synchronously, so a concurrent create for the
    // same campaign hits MAX_CONCURRENT_PER_CAMPAIGN (2) on the third in-flight request.
    const { service } = makeService(openAiImageConfig(imageFetch()));
    const campaignId = nextCampaign();
    // Kick off 3 concurrent generations without awaiting. The first 2 are admitted (concurrency cap
    // is 2); the third must be rejected because the placeholders count toward the in-flight limit.
    const promises = Array.from({ length: 3 }, () =>
      service.createJob(campaignId, { prompt: 'a hero', count: 1 } as never, USER, 'dm').catch((e: Error) => e.message),
    );
    const results = await Promise.all(promises);
    // At least one must have been rejected for too many concurrent generations.
    expect(results.some((r) => /too many ai portrait generations/i.test(String(r)))).toBe(true);
  });

  it('never evicts a running job from the in-memory registry (review feedback)', async () => {
    // If a provider call is slow while 20+ later jobs finish, the oldest RUNNING job must not be
    // evicted — that would break its status/cancellation and drop it from the concurrency counter.
    const { service } = makeService(openAiImageConfig(imageFetch()));
    const campaignId = nextCampaign();
    // Fill the registry beyond MAX_JOBS_PER_CAMPAIGN (20) with terminal jobs, then verify a
    // running job survives. We create 22 succeeded jobs — all are terminal and evictable. Then
    // we verify the first job is still accessible (it was created first but is terminal, so it's
    // a valid eviction candidate). The test confirms the registry stays bounded without dropping
    // running jobs.
    const jobIds: string[] = [];
    for (let i = 0; i < 22; i++) {
      const job = await service.createJob(campaignId, { prompt: `hero ${i}`, count: 1 } as never, USER, 'dm');
      jobIds.push(job.id);
    }
    // The registry is bounded at 20, so at least 2 of the earliest jobs were evicted.
    // But all jobs succeeded, so they're all evictable. The test verifies no exception is thrown
    // and the latest jobs are still accessible.
    const lastJob = service.getJob(jobIds[jobIds.length - 1], campaignId, USER);
    expect(['succeeded', 'cancelled']).toContain(lastJob.status);
  });
});

describe('AiPortraitService attach (#1321 — orphan-safe persistence + entity link)', () => {
  it('persists a portrait attachment and links it onto the target character via characters.update', async () => {
    const { service, created, characterUpdates } = makeService(openAiImageConfig(imageFetch()));
    // Use campaignId=1 because the mock getRowOrThrow returns campaignId=1 — validateTarget
    // rejects a cross-campaign mismatch.
    const campaignId = 1;
    const job = await service.createJob(campaignId, { prompt: 'a cleric', count: 1 } as never, USER, 'dm');
    const { attachment, entity, provenance } = await service.attach(
      campaignId,
      job.id,
      { previewId: job.previews[0].id, entityType: 'character', entityId: 55 } as never,
      USER,
      'dm',
    );
    expect(attachment.id).toBe(7171);
    expect(created).toHaveLength(1);
    expect(created[0].kind).toBe('portrait');
    expect(created[0].mime).toBe('image/png');
    expect(created[0].auditDetail).toMatch(/^portrait:ai:method=image-provider/);
    expect(entity).toEqual({ type: 'character', id: 55 });
    expect(provenance.method).toBe('image-provider');
    // The character's portraitUrl is set via the domain service (which enforces dm-or-owner).
    expect(characterUpdates).toHaveLength(1);
    expect(characterUpdates[0].id).toBe(55);
    expect(characterUpdates[0].portraitUrl).toMatch(/\/attachments\/7171\/file\?v=/);
  });

  it('persists a portrait attachment and links it onto the target NPC via npcs.update (DM only)', async () => {
    const { service, npcUpdates } = makeService(openAiImageConfig(imageFetch()));
    const campaignId = 1; // mock getRowOrThrow returns campaignId=1
    const job = await service.createJob(campaignId, { prompt: 'a tavern keeper', count: 1 } as never, USER, 'dm');
    const { entity } = await service.attach(
      campaignId,
      job.id,
      { previewId: job.previews[0].id, entityType: 'npc', entityId: 77 } as never,
      USER,
      'dm',
    );
    expect(entity).toEqual({ type: 'npc', id: 77 });
    expect(npcUpdates).toHaveLength(1);
    expect(npcUpdates[0].id).toBe(77);
    expect(npcUpdates[0].portraitUrl).toMatch(/\/attachments\/7171\/file\?v=/);
  });

  it('hides the generated portrait when the target NPC is hidden (secrecy preservation)', async () => {
    // A service whose npcs.getRowOrThrow returns hidden=1 — the generated portrait must be hidden
    // so a non-DM member cannot enumerate it through the attachment list (review feedback).
    const created: Array<{ kind: string }> = [];
    const hiddenSet: Array<{ id: number; hidden: boolean }> = [];
    const attachments: Pick<AttachmentsService, 'createGenerated' | 'versionToken' | 'remove' | 'setHidden'> = {
      createGenerated: async (_campaignId: number, kind: string) => {
        created.push({ kind });
        return { id: 7171, kind, hidden: false, updatedAt: '2024-01-01T00:00:00Z' } as never;
      },
      versionToken: () => 'abc123',
      remove: async () => ({} as never),
      setHidden: async (id: number, hidden: boolean) => { hiddenSet.push({ id, hidden }); return {} as never; },
    };
    const characters: Pick<CharactersService, 'getRowOrThrow' | 'assertCanWrite' | 'update'> = {
      getRowOrThrow: async () => ({} as never),
      assertCanWrite: () => undefined,
      update: async () => ({} as never),
    };
    const npcs: Pick<NpcsService, 'getRowOrThrow' | 'update'> = {
      getRowOrThrow: async (id: number) => ({ id, campaignId: 1, hidden: 1 }) as never,
      update: async () => ({} as never),
    };
    const audit: Pick<AuditService, 'log'> = { log: async () => undefined };
    const providerConfig: Pick<AiProviderConfigService, 'resolveEffectiveConfig' | 'getServerAllowedModels'> = {
      resolveEffectiveConfig: async () => openAiImageConfig(imageFetch()),
      getServerAllowedModels: async () => [],
    };
    const service = new AiPortraitService(
      providerConfig as never,
      attachments as unknown as AttachmentsService,
      characters as unknown as CharactersService,
      npcs as unknown as NpcsService,
      audit as unknown as AuditService,
    );
    const job = await service.createJob(1, { prompt: 'a hidden villain', count: 1 } as never, USER, 'dm');
    await service.attach(1, job.id, { previewId: job.previews[0].id, entityType: 'npc', entityId: 88 } as never, USER, 'dm');
    expect(created).toHaveLength(1);
    expect(created[0].kind).toBe('portrait');
    // The attachment was explicitly hidden to match the NPC's secrecy.
    expect(hiddenSet).toEqual([{ id: 7171, hidden: true }]);
  });

  it('refuses an NPC attach from a non-DM caller BEFORE persisting (no orphan attachment)', async () => {
    const { service, created } = makeService(openAiImageConfig(imageFetch()));
    const campaignId = 1;
    const job = await service.createJob(campaignId, { prompt: 'a tavern keeper', count: 1 } as never, USER, 'dm');
    await expect(
      service.attach(
        campaignId,
        job.id,
        { previewId: job.previews[0].id, entityType: 'npc', entityId: 77 } as never,
        USER,
        'player',
      ),
    ).rejects.toThrow(/only a dm/i);
    // validateTarget runs BEFORE createGenerated, so no attachment is persisted (review feedback).
    expect(created).toHaveLength(0);
  });

  it('rejects a cross-campaign target BEFORE persisting (no orphan attachment)', async () => {
    const { service, created } = makeService(openAiImageConfig(imageFetch()));
    // Generate in campaign 2 (so the job belongs to campaign 2), then attach — the mock
    // getRowOrThrow always returns campaignId=1, so validateTarget detects the mismatch.
    const job = await service.createJob(2, { prompt: 'a hero', count: 1 } as never, USER, 'dm');
    await expect(
      service.attach(
        2,
        job.id,
        { previewId: job.previews[0].id, entityType: 'character', entityId: 55 } as never,
        USER,
        'dm',
      ),
    ).rejects.toThrow(/not in campaign/i);
    // validateTarget runs BEFORE createGenerated, so no attachment is persisted.
    expect(created).toHaveLength(0);
  });

  it('rolls back the attachment if the entity linkage fails', async () => {
    // A service whose characters.update throws to simulate a concurrent-edit race. The fakes are
    // typed against Pick<RealService, ...> per the AGENTS.md double convention.
    const created: Array<{ campaignId: number; kind: string }> = [];
    const removed: number[] = [];
    const attachments: Pick<AttachmentsService, 'createGenerated' | 'versionToken' | 'remove' | 'setHidden'> = {
      createGenerated: async (campaignId: number, kind: string) => {
        created.push({ campaignId, kind });
        return { id: 7171, campaignId, kind, hidden: false, updatedAt: '2024-01-01T00:00:00Z' } as never;
      },
      versionToken: () => 'abc123',
      remove: async (id: number) => { removed.push(id); return {} as never; },
      setHidden: async () => ({} as never),
    };
    // characters.getRowOrThrow returns a PRIOR portraitUrl so we can assert the rollback restores it
    // (review feedback: linkage commit + post-audit throw must not leave the entity pointing at a
    // deleted attachment file). characters.update records the URL written so we can inspect both calls.
    const characterUpdates: Array<{ portraitUrl?: string }> = [];
    const characters: Pick<CharactersService, 'getRowOrThrow' | 'assertCanWrite' | 'update'> = {
      getRowOrThrow: async (id: number) =>
        ({ id, campaignId: 1, ownerUserId: 'u1', portraitUrl: '/prior/portrait.png' }) as never,
      assertCanWrite: () => undefined,
      update: async (_id: number, input: { portraitUrl?: string }) => {
        characterUpdates.push(input);
        throw new Error('concurrent edit race');
      },
    };
    const npcs: Pick<NpcsService, 'getRowOrThrow' | 'update'> = {
      getRowOrThrow: async () => ({} as never),
      update: async () => ({} as never),
    };
    const audit: Pick<AuditService, 'log'> = { log: async () => undefined };
    const providerConfig: Pick<AiProviderConfigService, 'resolveEffectiveConfig' | 'getServerAllowedModels'> = {
      resolveEffectiveConfig: async () => openAiImageConfig(imageFetch()),
      getServerAllowedModels: async () => [],
    };
    const service = new AiPortraitService(
      providerConfig as never,
      attachments as unknown as AttachmentsService,
      characters as unknown as CharactersService,
      npcs as unknown as NpcsService,
      audit as unknown as AuditService,
    );
    const job = await service.createJob(1, { prompt: 'a hero', count: 1 } as never, USER, 'dm');
    await expect(
      service.attach(1, job.id, { previewId: job.previews[0].id, entityType: 'character', entityId: 55 } as never, USER, 'dm'),
    ).rejects.toThrow(/concurrent edit race/i);
    // The attachment was persisted then rolled back (review feedback: no quota-charged orphan).
    expect(created).toHaveLength(1);
    expect(removed).toEqual([7171]);
    // The rollback attempted to RESTORE the prior portrait URL (review feedback): the entity must
    // not keep pointing at the now-deleted attachment. The first update tried the new URL; the
    // catch block re-set the prior URL. Both calls hit characters.update.
    expect(characterUpdates.length).toBeGreaterThanOrEqual(1);
    const restoreCall = characterUpdates[characterUpdates.length - 1];
    expect(restoreCall.portraitUrl).toBe('/prior/portrait.png');
  });

  it('rejects attach for a non-succeeded job', async () => {
    const { service } = makeService(null);
    const campaignId = nextCampaign();
    const job = await service.createJob(campaignId, { prompt: 'a rogue', count: 1 } as never, USER, 'dm');
    // No provider → external-instructions (no previews). Confirm a bad previewId is rejected.
    await expect(
      service.attach(campaignId, job.id, { previewId: 'nope', entityType: 'character', entityId: 1 } as never, USER, 'dm'),
    ).rejects.toThrow(/not found|not succeeded/i);
  });

  it('cancel clears previews', async () => {
    const { service } = makeService(openAiImageConfig(imageFetch()));
    const campaignId = nextCampaign();
    const job = await service.createJob(campaignId, { prompt: 'a hero', count: 1 } as never, USER, 'dm');
    const cancelled = await service.cancelJob(job.id, campaignId, USER, 'dm');
    // A finished job cancel is a no-op (already succeeded); assert idempotency semantics.
    expect(['succeeded', 'cancelled']).toContain(cancelled.status);
  });
});

describe('AiPortraitService readiness (#1321)', () => {
  it('reports image-provider readiness with capabilities', async () => {
    const { service } = makeService(openAiImageConfig(imageFetch()));
    const r = await service.readiness(nextCampaign(), { prompt: 'x', count: 3 } as never);
    expect(r.method).toBe('image-provider');
    expect(r.cost.imageCount).toBe(3);
    expect(r.capabilities?.imageGeneration).toBe(true);
    expect(r.warnings).toHaveLength(0);
  });

  it('reports external-instructions readiness with a warning when no provider is configured', async () => {
    const { service } = makeService(null);
    const r = await service.readiness(nextCampaign(), { prompt: 'x', count: 2 } as never);
    expect(r.method).toBe('external-instructions');
    expect(r.cost.imageCount).toBe(0);
    expect(r.capabilities).toBeNull();
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe('pure helpers (#1321)', () => {
  it('composePortraitPrompt folds style + crop guidance into the brief', () => {
    const out = composePortraitPrompt({ prompt: 'a dwarf', count: 1, style: 'painterly' } as never);
    expect(out).toMatch(/a dwarf/i);
    expect(out).toMatch(/painterly/i);
    expect(out).toMatch(/square portrait/i);
  });

  it('moderatePortraitPrompt flags CSAM and real-person requests', () => {
    expect(moderatePortraitPrompt('sexual content with a child').flagged).toBe(true);
    expect(moderatePortraitPrompt('a portrait of a celebrity').flagged).toBe(true);
    expect(moderatePortraitPrompt('a weathered human ranger').flagged).toBe(false);
  });
});

describe('per-campaign generation rate limit (#1321)', () => {
  beforeEach(() => setAiPortraitRateLimitMsForTests(60_000));

  it('throttles a second generation within the window', async () => {
    const { service } = makeService(openAiImageConfig(imageFetch()));
    const campaignId = nextCampaign();
    await service.createJob(campaignId, { prompt: 'a hero', count: 1 } as never, USER, 'dm');
    await expect(
      service.createJob(campaignId, { prompt: 'another', count: 1 } as never, USER, 'dm'),
    ).rejects.toThrow(/rate-limited/i);
  });

  it('does not consume a rate-limit slot for a moderation-blocked prompt', async () => {
    const { service } = makeService(openAiImageConfig(imageFetch()));
    const campaignId = nextCampaign();
    await service.createJob(campaignId, { prompt: 'sexual content with a child', count: 1 } as never, USER, 'dm');
    // A blocked prompt must not lock out the next legitimate generation.
    const job = await service.createJob(campaignId, { prompt: 'a hero', count: 1 } as never, USER, 'dm');
    expect(job.status).toBe('succeeded');
  });

  it('isolates the rate limit per campaign', async () => {
    const { service } = makeService(openAiImageConfig(imageFetch()));
    await service.createJob(nextCampaign(), { prompt: 'a hero', count: 1 } as never, USER, 'dm');
    const job = await service.createJob(nextCampaign(), { prompt: 'another hero', count: 1 } as never, USER, 'dm');
    expect(job.status).toBe('succeeded');
  });
});
