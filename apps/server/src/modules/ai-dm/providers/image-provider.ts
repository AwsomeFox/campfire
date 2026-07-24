/**
 * Vendor-neutral IMAGE provider interface (issue #410) — the text-to-image sibling of the
 * `AiProvider` narration interface (#309). Genuine AI map generation talks to an image model
 * ONLY through this shape: a caller passes a prompt + size + count and gets back raw image
 * bytes + real usage, with NO vendor request/response types leaking across the boundary.
 *
 * The OpenAI-compatible adapter (openai-image-provider.ts) covers OpenAI Images, Azure, and
 * any `/images/generations`-speaking endpoint via a configurable baseUrl + model. A
 * deterministic mock (mock-image-provider.ts) implements it offline for tests/evals.
 */

/** A single generated raster image, decoded to bytes + its mime type. */
export interface AiGeneratedImage {
  /** Decoded image bytes (PNG/JPEG/WEBP), ready to persist as an attachment. */
  bytes: Buffer;
  mime: string;
  width?: number;
  height?: number;
}

/** A text-to-image request — provider-agnostic. */
export interface AiImageRequest {
  prompt: string;
  /** How many candidates to return (bounded by the caller; providers may cap lower). */
  n: number;
  /** Pixel dimensions, e.g. { width: 1024, height: 1024 }. */
  width: number;
  height: number;
  /** Model id to serve the request (provider-specific string, chosen by config). */
  model: string;
}

/** Real usage/cost accounting from an image response (best-effort — many providers omit it). */
export interface AiImageUsage {
  /** Number of images actually produced. */
  imageCount: number;
  /** Tokens billed, when the provider reports them (0 otherwise). */
  tokensUsed: number;
}

/** The complete result of an image generation. */
export interface AiImageResult {
  images: AiGeneratedImage[];
  usage: AiImageUsage;
  /** Model that actually served the request (echoed by the provider when available). */
  model: string;
}

/** Per-call knobs (cancellation, timeout override) — mirrors AiGenerateOptions. */
export interface AiImageOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** The one interface every image integration implements. Vendor-neutral by contract. */
export interface AiImageProvider {
  /** Short machine name surfaced in results/audit (e.g. 'openai-image', 'mock-image'). */
  readonly name: string;
  /** Which adapter family this is (mirrors AiProviderType for the text side). */
  readonly providerType: string;
  /** Generate one or more candidate images from a text prompt. */
  generateImage(req: AiImageRequest, opts?: AiImageOptions): Promise<AiImageResult>;
  /** Optional: edit/inpaint an existing image (imageEditing capability). */
  editImage?(base: Buffer, req: AiImageRequest, opts?: AiImageOptions): Promise<AiImageResult>;
}
