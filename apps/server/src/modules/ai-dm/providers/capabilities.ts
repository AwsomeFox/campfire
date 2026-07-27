/**
 * Per-provider-type CAPABILITIES table (issue #410). The vendor-neutral provider layer
 * (#309) already tells us WHICH adapter backs a config; this declares what each adapter
 * family can actually DO, so genuine AI map generation can route honestly:
 *
 *   - a text-only provider (Anthropic today) is NEVER asked to "generate an image" and
 *     have its prose passed off as one — it produces a structured BLUEPRINT that Campfire's
 *     own procedural renderer draws (labeled as such);
 *   - an OpenAI-compatible endpoint CAN be asked for a real text-to-image render;
 *   - the deterministic `mock` provider declares no image capability, so tests exercise the
 *     honest fallback path unless a dedicated fake IMAGE provider is injected.
 *
 * The concrete table lives here (server side) rather than in the schema because the runtime
 * `AiProviderType` union is broader than the config enum (`custom`/`noop` exist at runtime).
 * The SHAPE (`AiProviderCapabilities`) is the shared schema contract surfaced to clients.
 */

import type { AiProviderCapabilities } from '@campfire/schema';
import type { AiProviderType } from './ai-provider';

/**
 * Static capability declarations per provider type. `imageGeneration` gates whether the
 * map generator will attempt a real render through {@link createAiImageProvider}; when
 * false, generation falls back to the procedural-blueprint path (still honest, still useful).
 *
 * NOTE these are the DEFAULTS for the adapter family. A concrete deployment can point an
 * OpenAI-compatible `baseUrl` at an endpoint that lacks an images route; that surfaces as a
 * runtime provider error which the router treats as "image generation unavailable" and
 * degrades to the blueprint fallback — capability advertisement is a hint, not a guarantee.
 */
const CAPABILITIES: Record<AiProviderType, AiProviderCapabilities> = {
  // OpenAI-compatible: chat + tools + a text-to-image endpoint (/images/generations),
  // and image edits/inpaint on the same wire.
  openai: { text: true, toolCalling: true, imageGeneration: true, imageEditing: true },
  // Anthropic: strong text + tools, but NO first-party image-generation endpoint. This is
  // the crux of #410's honesty requirement — Anthropic maps route through the blueprint path.
  anthropic: { text: true, toolCalling: true, imageGeneration: false, imageEditing: false },
  // Gemini: text + tools; image generation via a distinct API surface we do not implement
  // here, so declared false (routes through the blueprint fallback) rather than faking it.
  gemini: { text: true, toolCalling: true, imageGeneration: false, imageEditing: false },
  // Deterministic offline mock: text only. Image-capable tests inject a fake IMAGE provider.
  mock: { text: true, toolCalling: true, imageGeneration: false, imageEditing: false },
  // No-op scaffold / fully custom DI binding: assume text-only unless a real provider is bound.
  noop: { text: true, toolCalling: false, imageGeneration: false, imageEditing: false },
  custom: { text: true, toolCalling: true, imageGeneration: false, imageEditing: false },
};

/** The declared capabilities for a provider type (issue #410). */
export function providerCapabilities(type: AiProviderType): AiProviderCapabilities {
  return CAPABILITIES[type] ?? { text: true, toolCalling: false, imageGeneration: false, imageEditing: false };
}

/** Convenience: does this provider type advertise text-to-image generation? */
export function supportsImageGeneration(type: AiProviderType): boolean {
  return providerCapabilities(type).imageGeneration === true;
}

/**
 * Provider types that contact NO external endpoint and therefore need no credential (#1052
 * review). Today that is the deterministic offline `mock` alone — precisely the one type
 * {@link createAiProvider} builds without calling `requireKey` and without throwing.
 *
 * `noop`/`custom` are deliberately absent: they are DI scaffolds that `createAiProvider`
 * refuses to build at all, so they are never a stored config whose credential needs deciding.
 */
const KEYLESS_PROVIDER_TYPES: ReadonlySet<AiProviderType> = new Set<AiProviderType>(['mock']);

/**
 * Does a provider of this type need an API key to serve a turn? (#1052 review)
 *
 * The single definition of "needs a credential", because the answer had been open-coded as
 * `providerType === 'mock'` in three separate places that were free to drift apart.
 *
 * It answers a question about a CONFIGURED ROW ONLY. It deliberately says nothing about which
 * row's endpoint a turn runs against: a keyless campaign override is a model-only override
 * whose providerType and baseUrl are discarded in favour of whoever owns the key (#373), and
 * that binding is the exfiltration defense rather than something a provider type may opt out
 * of. Callers that need "where did the request actually go?" must ask
 * `resolveEffectiveConfigWithEndpointScope`, which is the only authority on it.
 *
 * Defaults to TRUE for an unrecognised type. That is the conservative direction here: a false
 * "needs no credential" would suppress inheritance a deployment depends on, whereas the
 * default merely preserves the existing path.
 */
export function providerRequiresApiKey(type: AiProviderType): boolean {
  return !KEYLESS_PROVIDER_TYPES.has(type);
}
