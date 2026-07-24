/**
 * Deterministic mock IMAGE provider (issue #410). Makes NO network call, returns canned
 * (real, valid) PNG bytes, and RECORDS every request so tests can assert on the exact
 * prompt/size/count/model a caller assembled. Mirrors the mock text provider's contract
 * so the map generator's image-provider path is exercised entirely offline.
 */

import type {
  AiImageProvider,
  AiImageRequest,
  AiImageResult,
  AiImageOptions,
} from './image-provider';
import { AiProviderError } from './errors';

/** A minimal, valid 1×1 transparent PNG — a real image so magic-byte sniffing passes. */
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export interface MockImageProviderOptions {
  model?: string;
  name?: string;
  /** Throw this error instead of returning images (drives fallback/failure tests). */
  throwError?: Error;
}

export class MockImageProvider implements AiImageProvider {
  readonly providerType = 'mock';
  readonly name: string;
  readonly model: string;
  /** Every request this provider was asked to serve, in order — inspect in tests. */
  readonly received: AiImageRequest[] = [];
  private readonly throwError?: Error;

  constructor(opts: MockImageProviderOptions = {}) {
    this.name = opts.name ?? 'mock-image';
    this.model = opts.model ?? 'mock-image-model';
    this.throwError = opts.throwError;
  }

  async generateImage(req: AiImageRequest, _opts?: AiImageOptions): Promise<AiImageResult> {
    this.received.push(req);
    if (this.throwError) throw this.throwError;
    const n = Math.max(1, req.n);
    const bytes = Buffer.from(TINY_PNG_B64, 'base64');
    if (bytes.length === 0) {
      throw new AiProviderError('unknown', 'mock-image: canned PNG decode failed', { provider: this.name });
    }
    return {
      images: Array.from({ length: n }, () => ({
        bytes: Buffer.from(bytes),
        mime: 'image/png',
        width: req.width,
        height: req.height,
      })),
      usage: { imageCount: n, tokensUsed: 0 },
      model: req.model || this.model,
    };
  }
}
