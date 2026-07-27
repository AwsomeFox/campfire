/**
 * OpenAI-compatible IMAGE adapter (issue #410). One adapter covers OpenAI Images, Azure
 * OpenAI, and any endpoint that speaks the `/images/generations` shape, via a configurable
 * `baseUrl` + `model`. Thin fetch-based client (no vendor SDK); the `fetch` impl is
 * injectable so tests run against recorded fixtures — never the live network.
 *
 * All OpenAI wire types stay INSIDE this file: the class only accepts/returns the
 * vendor-neutral `AiImageProvider` types. Responses are requested as base64 (`b64_json`) so
 * the bytes are in-hand immediately (no second fetch of a signed URL that could 404/leak).
 */

import type {
  AiImageProvider,
  AiImageRequest,
  AiImageResult,
  AiImageOptions,
  AiGeneratedImage,
} from './image-provider';
import { AiProviderError } from './errors';
import {
  type FetchLike,
  type RetryConfig,
  DEFAULT_RETRY,
  DEFAULT_TIMEOUT_MS,
  postAndReadJson,
} from './http';

export interface OpenAiImageProviderOptions {
  apiKey: string;
  /** Defaults to the public OpenAI endpoint; override for Azure or a compatible gateway. */
  baseUrl?: string;
  /** Default image model (e.g. 'gpt-image-1', 'dall-e-3'); per-request `model` overrides it. */
  model: string;
  timeoutMs?: number;
  retry?: RetryConfig;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: FetchLike;
  /** Extra headers (e.g. Azure api-key). */
  headers?: Record<string, string>;
  /** Short provider name surfaced in results/audit. */
  name?: string;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export class OpenAiImageProvider implements AiImageProvider {
  readonly providerType = 'openai';
  readonly name: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly retry: RetryConfig;

  constructor(private readonly opts: OpenAiImageProviderOptions) {
    this.name = opts.name ?? 'openai-image';
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike);
    if (!this.fetchImpl) {
      throw new AiProviderError('transport', 'openai-image: no fetch implementation available', { provider: this.name });
    }
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retry = opts.retry ?? DEFAULT_RETRY;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private authHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.opts.apiKey}`,
      ...this.opts.headers,
    };
  }

  async generateImage(req: AiImageRequest, opts?: AiImageOptions): Promise<AiImageResult> {
    const body: Record<string, unknown> = {
      model: req.model || this.opts.model,
      prompt: req.prompt,
      n: Math.max(1, req.n),
      size: `${req.width}x${req.height}`,
      response_format: 'b64_json',
    };
    const json = await postAndReadJson<OpenAiImageResponse>(this.fetchImpl, this.url('/images/generations'), this.authHeaders(), body, {
      provider: this.name,
      timeoutMs: opts?.timeoutMs ?? this.timeoutMs,
      retry: this.retry,
      signal: opts?.signal,
    });
    return this.parse(json, req);
  }

  private parse(json: OpenAiImageResponse, req: AiImageRequest): AiImageResult {
    const images: AiGeneratedImage[] = (json.data ?? [])
      .map((d) => d.b64_json)
      .filter((b): b is string => typeof b === 'string' && b.length > 0)
      .map((b64) => ({ bytes: Buffer.from(b64, 'base64'), mime: 'image/png', width: req.width, height: req.height }));
    if (images.length === 0) {
      throw new AiProviderError('invalid_request', `${this.name}: provider returned no image data`, { provider: this.name });
    }
    return {
      images,
      usage: {
        imageCount: images.length,
        tokensUsed: json.usage?.total_tokens ?? 0,
      },
      model: req.model || this.opts.model,
    };
  }
}

// ---------- OpenAI image wire types (private to this adapter) ----------

interface OpenAiImageResponse {
  data?: Array<{ b64_json?: string; url?: string }>;
  usage?: { total_tokens?: number };
}
