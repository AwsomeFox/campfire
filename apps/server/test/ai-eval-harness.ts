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
  /**
   * #1052: when set, the harness also binds a SECOND deterministic provider as the campaign's
   * fallback, so failover can be driven offline. Its name is `mock-fallback`, which is how a
   * spec tells which provider actually served a turn.
   */
  fallback?: { model?: string; responses?: MockResponse[] };
}

export interface AiEvalHarness {
  ctx: TestAppContext;
  server: Server;
  /** The underlying deterministic provider — inspect `.received` to assert prompt/tools/system. */
  mock: MockAiProvider;
  /** #1052: the deterministic FALLBACK provider, when `options.fallback` was supplied. */
  fallbackMock?: MockAiProvider;
  /** #1052: enqueue turns onto the FALLBACK provider's queue. */
  scriptFallback(...responses: MockResponse[]): void;
  /**
   * Enqueue one or more scripted turns, consumed in order by subsequent `/turn` calls.
   * When the queue is exhausted the mock falls back to a deterministic echo of the prompt.
   */
  script(...responses: MockResponse[]): void;
  /**
   * #1500 — assert every provider call this turn consumed a scripted response, i.e. the mock
   * never fell back to its echo reply. A desynced test (the driver made more provider calls
   * than were scripted) silently echo-passes: the mock returns `echo: <prompt>` with
   * `finishReason: 'stop'` and no tool calls, so a test asserting only stop reason or
   * absence-of-effect still passes. Call this after a turn whose scripted provider calls you
   * want to bound; it throws if the mock echoed.
   */
  assertScriptDrained(): void;
  /**
   * Clear unconsumed scripted turns + the mock's request log. Use in `beforeEach` when a
   * suite shares one harness — early stopReasons (tool_error, budget_exhausted) otherwise
   * leave queued responses that pollute the next test.
   */
  resetMock(): void;
  /** Turn the server-wide experimental AI DM flag on (admin/dm). Required before any write. */
  enableExperimental(): Promise<void>;
  /** Create a campaign and return its id. */
  createCampaign(name?: string): Promise<number>;
  /**
   * Configure + (by default) enable the AI DM seat for a campaign. Pass `mode:'driver'` to arm the
   * autonomous driver loop — the harness first configures a deterministic `mock` provider for the
   * campaign (Driver mode requires a provider, #311) so the mode write is accepted. Co-DM / scribe
   * callers omit `mode` (they only need enabled + budget and must NOT configure a provider, so the
   * scribe keeps exercising its unconfigured-provider fallback path).
   */
  configureSeat(
    campaignId: number,
    patch?: {
      enabled?: boolean;
      mode?: 'off' | 'co_dm' | 'driver';
      model?: string;
      instructions?: string;
      tokenBudget?: number;
      /** #1049 structured table style. Loosely typed so a spec can also post an INVALID value
       *  and assert the strict DTO rejects it. */
      stylePresets?: Record<string, string>;
    },
  ): Promise<request.Response>;
  /** Configure a per-campaign `mock` AI provider (needed before switching a seat to Driver mode). */
  configureProvider(campaignId: number): Promise<request.Response>;
  /** POST a turn to the AI DM seat. */
  takeTurn(campaignId: number, body: { prompt: string; kind?: AiDmTurnKind; maxTokens?: number }): Promise<request.Response>;
  /** POST player input to the driver runtime (#312) — runs a streamed, tool-executing turn. */
  sendMessage(
    campaignId: number,
    body: { input: string; scene?: string; maxSteps?: number; maxTokens?: number; characterId?: number },
    headers?: Record<string, string>,
  ): Promise<request.Response>;
  /** Read the driver session state. */
  getDriverSession(campaignId: number): Promise<request.Response>;
  /** POST a stuck-ladder lever (#314): nudge/flag/vote/rules-lookup/request-takeover/grant-takeover/handback/resume. */
  lever(
    campaignId: number,
    lever: 'nudge' | 'flag' | 'vote' | 'rules-lookup' | 'request-takeover' | 'grant-takeover' | 'handback' | 'resume' | 'continue-without-ai',
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

  // #1052: an optional second provider so failover is exercisable with no network. Bound
  // through `resolveFallbackForExecution`, the same optional method the production resolver
  // implements — a harness without it simply has no fallback, which is the real default.
  const fallbackScript: MockResponse[] = [...(options.fallback?.responses ?? [])];
  const fallbackMock = options.fallback
    ? new MockAiProvider({ name: 'mock-fallback', model: options.fallback.model ?? 'mock-fallback-model', responses: fallbackScript })
    : undefined;

  const ctx = await createTestApp({
    overrides: [
      { token: AI_DM_PROVIDER, useValue: bridged },
      // Driver runtime (#312): resolve the SAME deterministic mock as the streaming
      // AiProvider, so the whole session loop runs offline with scripted turns.
      {
        token: AI_PROVIDER_RESOLVER,
        useValue: {
          resolve: async () => mock,
          ...(fallbackMock
            ? { resolveFallbackForExecution: async () => ({ provider: fallbackMock, model: fallbackMock.model }) }
            : {}),
        },
      },
    ],
  });
  const server = ctx.app.getHttpServer();

  const harness: AiEvalHarness = {
    ctx,
    server,
    mock,
    fallbackMock,
    script(...responses: MockResponse[]): void {
      // #1500 — refuse to enqueue once the mock already exhausted its queue and echoed. Pushes
      // would land behind the cursor and be silently dropped (a no-op script is the exact
      // false-confidence this guard exists to remove), so force the caller to resetMock() first.
      if (mock.isExhausted) {
        throw new Error(
          'ai-eval-harness.script(): the mock already exhausted its scripted queue and echoed ' +
            'a fallback reply — later pushes are silently dropped. Call resetMock() to re-arm a ' +
            'fresh queue, or script enough turns up front.',
        );
      }
      script.push(...responses);
    },
    scriptFallback(...responses: MockResponse[]): void {
      if (fallbackMock?.isExhausted) {
        throw new Error(
          'ai-eval-harness.scriptFallback(): the fallback mock already exhausted its scripted ' +
            'queue and echoed a fallback reply — later pushes are silently dropped. Call ' +
            'resetMock() to re-arm a fresh queue.',
        );
      }
      fallbackScript.push(...responses);
    },
    resetMock(): void {
      mock.clearResponses();
      mock.clearReceived();
      fallbackMock?.clearResponses();
      fallbackMock?.clearReceived();
    },
    assertScriptDrained(): void {
      // #1500 — the mock's echo fallback returns `echo: <prompt>` with finishReason 'stop' and
      // no tool calls, so a desynced test (more provider calls than scripted) can read it as a
      // clean `complete` and pass. Fail loudly instead.
      const echoes = mock.echoFallbacks;
      if (echoes > 0) {
        throw new Error(
          `assertScriptDrained(): the mock served ${echoes} echo fallback repl` +
            (echoes === 1 ? 'y' : 'ies') +
            ' after the scripted queue ran out — the driver made more provider calls than were ' +
            'scripted, so this test is likely echo-passing. Add the missing scripted turn(s) or ' +
            'raise maxSteps.',
        );
      }
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
    configureProvider(campaignId): Promise<request.Response> {
      return request(server)
        .put(`/api/v1/campaigns/${campaignId}/ai-provider`)
        .set(dm)
        .send({ providerType: 'mock', model: 'mock-1', apiKey: 'sk-test-key-1234' });
    },
    async configureSeat(campaignId, patch = {}): Promise<request.Response> {
      // Driver mode requires a configured provider (assertDriverAllowed, #311) — set one up first.
      if (patch.mode === 'driver') await harness.configureProvider(campaignId);
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
