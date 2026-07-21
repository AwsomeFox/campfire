/**
 * Deterministic AI eval/test harness (#318) — the reusable seam the later AI issues
 * (#312 driver runtime, #313 co-DM authoring, #316 scribe, #314 stuck ladder) test against.
 *
 * NOT a spec itself (no `describe`), so jest's testRegex ignores it — it is imported by the
 * AI flow specs. It wires the deterministic mock provider (#309) into the real AiDm HTTP path
 * by overriding the `AI_DM_PROVIDER` DI binding with a `ProviderBackedAiDmProvider` wrapping a
 * `MockAiProvider`. That means a suite can:
 *   - SCRIPT the model's turns (narration text, tool calls, exact usage) with `script(...)`,
 *   - drive the genuine `PUT/POST /campaigns/:id/ai-dm[...]` endpoints over supertest, and
 *   - assert the resulting narration / budget metering / audit / (future) state changes,
 * all offline, with no vendor call and no cost. Everything is reproducible: the mock derives
 * usage deterministically from text length unless a turn overrides it.
 *
 * The mock also RECORDS every request it served (`harness.mock.received`), so a test can assert
 * exactly what prompt / instructions (system) / tool registry the AiDm path assembled — which is
 * how the tool-call round-trip and prompt-assembly evals check the seam without a live model.
 *
 * Downstream issues import `createAiEvalHarness` and build their flow assertions on top; where a
 * behavior (driver tool-loop, scribe job, stuck ladder) is not built yet, its spec is a clearly
 * marked placeholder that the owning issue fleshes out using this same harness.
 */

import request from 'supertest';
import { createTestApp, closeTestApp, type TestAppContext } from './test-app';
import { AI_DM_PROVIDER } from '../src/modules/ai-dm/ai-dm.provider';
import { MockAiProvider } from '../src/modules/ai-dm/providers/mock-provider';
import type { MockResponse } from '../src/modules/ai-dm/providers/mock-provider';
import { ProviderBackedAiDmProvider } from '../src/modules/ai-dm/providers/ai-dm-bridge';
import type { AiToolSchema } from '../src/modules/ai-dm/providers/ai-provider';
import { AI_PROVIDER_RESOLVER } from '../src/modules/ai-driver/ai-provider-resolver';
import type { AiDmTurnKind } from '@campfire/schema';

/** dev-auth header identities (DEV_AUTH=1 path — see SessionAuthGuard). */
export const dm = { 'x-dev-role': 'dm', 'x-dev-user': 'ai-eval-dm' };
export const player = { 'x-dev-role': 'player', 'x-dev-user': 'ai-eval-player' };
export const viewer = { 'x-dev-role': 'viewer', 'x-dev-user': 'ai-eval-viewer' };

type Server = ReturnType<TestAppContext['app']['getHttpServer']>;

export interface AiEvalHarnessOptions {
  /** Model label the mock echoes back (informational). */
  model?: string;
  /** Tools to offer the model each turn (drives tool-call round-trip evals). */
  tools?: AiToolSchema[];
  /** Sampling temperature forwarded through the bridge. */
  temperature?: number;
  /** Responses to pre-load onto the mock's queue (more can be added via `script`). */
  responses?: MockResponse[];
}

export interface AiEvalHarness {
  ctx: TestAppContext;
  server: Server;
  /** The underlying deterministic provider — inspect `.received` to assert prompt/tools/system. */
  mock: MockAiProvider;
  /**
   * Enqueue one or more scripted turns, consumed in order by subsequent `/turn` calls.
   * When the queue is exhausted the mock falls back to a deterministic echo of the prompt.
   */
  script(...responses: MockResponse[]): void;
  /** Turn the server-wide experimental AI DM flag on (admin/dm). Required before any write. */
  enableExperimental(): Promise<void>;
  /** Create a campaign and return its id. */
  createCampaign(name?: string): Promise<number>;
  /** Configure + (by default) enable the AI DM seat for a campaign. */
  configureSeat(
    campaignId: number,
    patch?: { enabled?: boolean; model?: string; instructions?: string; tokenBudget?: number },
  ): Promise<request.Response>;
  /** POST a turn to the AI DM seat. */
  takeTurn(campaignId: number, body: { prompt: string; kind?: AiDmTurnKind; maxTokens?: number }): Promise<request.Response>;
  /** POST player input to the driver runtime (#312) — runs a streamed, tool-executing turn. */
  sendMessage(
    campaignId: number,
    body: { input: string; scene?: string; maxSteps?: number; maxTokens?: number },
    headers?: Record<string, string>,
  ): Promise<request.Response>;
  /** Read the driver session state. */
  getDriverSession(campaignId: number): Promise<request.Response>;
  /** POST a stuck-ladder lever (#314): nudge/flag/vote/rules-lookup/request-takeover/grant-takeover/handback/resume. */
  lever(
    campaignId: number,
    lever: 'nudge' | 'flag' | 'vote' | 'rules-lookup' | 'request-takeover' | 'grant-takeover' | 'handback' | 'resume',
    body?: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<request.Response>;
  /** Read the seat as the DM. */
  getSeat(campaignId: number): Promise<request.Response>;
  /** Read the campaign audit log as the DM. */
  getAudit(campaignId: number): Promise<request.Response>;
  /** Tear down the app + temp data dir. */
  close(): Promise<void>;
}

/**
 * Boot a full Campfire test app whose AI DM seat is backed by a deterministic mock provider.
 *
 * The `responses` array is shared by reference with the `MockAiProvider`, so `script(...)` can
 * enqueue turns at any point after boot (the mock consumes them lazily per `/turn` call).
 */
export async function createAiEvalHarness(options: AiEvalHarnessOptions = {}): Promise<AiEvalHarness> {
  // Shared queue: the mock reads from this same array, so `script` can enqueue post-boot.
  const script: MockResponse[] = [...(options.responses ?? [])];
  const mock = new MockAiProvider({ model: options.model ?? 'mock-model', responses: script });
  const bridged = new ProviderBackedAiDmProvider(mock, {
    tools: options.tools,
    temperature: options.temperature,
  });

  const ctx = await createTestApp({
    overrides: [
      { token: AI_DM_PROVIDER, useValue: bridged },
      // Driver runtime (#312): resolve the SAME deterministic mock as the streaming
      // AiProvider, so the whole session loop runs offline with scripted turns.
      { token: AI_PROVIDER_RESOLVER, useValue: { resolve: async () => mock } },
    ],
  });
  const server = ctx.app.getHttpServer();

  const harness: AiEvalHarness = {
    ctx,
    server,
    mock,
    script(...responses: MockResponse[]): void {
      script.push(...responses);
    },
    async enableExperimental(): Promise<void> {
      const res = await request(server).patch('/api/v1/settings').set(dm).send({ experimentalAiDm: true });
      if (res.status !== 200) throw new Error(`enableExperimental failed: ${res.status} ${res.text}`);
    },
    async createCampaign(name = 'AI Eval Campaign'): Promise<number> {
      const res = await request(server).post('/api/v1/campaigns').set(dm).send({ name });
      if (!res.body?.id) throw new Error(`createCampaign failed: ${res.status} ${res.text}`);
      return res.body.id as number;
    },
    configureSeat(campaignId, patch = {}): Promise<request.Response> {
      const body = { enabled: true, tokenBudget: 100_000, ...patch };
      return request(server).put(`/api/v1/campaigns/${campaignId}/ai-dm`).set(dm).send(body);
    },
    takeTurn(campaignId, body): Promise<request.Response> {
      return request(server).post(`/api/v1/campaigns/${campaignId}/ai-dm/turn`).set(dm).send(body);
    },
    sendMessage(campaignId, body, headers = dm): Promise<request.Response> {
      return request(server).post(`/api/v1/campaigns/${campaignId}/ai-dm/message`).set(headers).send(body);
    },
    getDriverSession(campaignId): Promise<request.Response> {
      return request(server).get(`/api/v1/campaigns/${campaignId}/ai-dm/session`).set(dm);
    },
    lever(campaignId, lever, body = {}, headers = dm): Promise<request.Response> {
      return request(server).post(`/api/v1/campaigns/${campaignId}/ai-dm/${lever}`).set(headers).send(body);
    },
    getSeat(campaignId): Promise<request.Response> {
      return request(server).get(`/api/v1/campaigns/${campaignId}/ai-dm`).set(dm);
    },
    getAudit(campaignId): Promise<request.Response> {
      return request(server).get(`/api/v1/campaigns/${campaignId}/audit`).set(dm);
    },
    async close(): Promise<void> {
      await closeTestApp(ctx);
    },
  };

  return harness;
}
