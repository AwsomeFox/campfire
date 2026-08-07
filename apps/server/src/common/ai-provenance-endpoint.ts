import type { AiGenerationProvenance } from '@campfire/schema';

/**
 * Decide whether a resolved endpoint's `baseUrl` may be recorded in durable generation
 * provenance (issue #501).
 *
 * The access model deliberately hides the admin-managed SERVER-default provider config
 * from campaign DMs: `AiProviderConfigService.getEffectiveView` returns only type, model,
 * source scope and credential readiness — never `baseUrl` — precisely so a DM who is not
 * a server admin cannot read the admin-configured endpoint.
 *
 * Generation provenance is persisted on scribe jobs and on filed proposals, both of which
 * ARE readable by any campaign DM, and the web UI renders the endpoint verbatim. Recording
 * the server row's `baseUrl` there would therefore reach around that boundary and disclose
 * internal topology (an internal proxy, a private gateway) to every DM on the install.
 *
 * So: keep the `scope` — "this ran against the server default" is the part that carries
 * provenance meaning — and drop the URL. A CAMPAIGN-scope `baseUrl` is kept: the DM
 * configured it and can already read it back from the campaign provider settings.
 *
 * Enforced at WRITE time on purpose. Redacting on read would leave the value in the
 * database and make every future reader — export, MCP, backup, archive — responsible for
 * remembering to strip it. Not writing it is the durable fix.
 */
export function provenanceEndpointBaseUrl(
  scope: AiGenerationProvenance['endpoint']['scope'],
  baseUrl: string | null | undefined,
): string | null {
  return scope === 'campaign' ? (baseUrl ?? null) : null;
}

/** Whether a generation actually left this deployment (issue #501/#1993). */
export type AiProvenanceEgress = 'external' | 'local';

/**
 * The operator's EXPLICIT declaration that the configured provider endpoint is
 * on-box / operator-controlled, so a generation through it does not constitute
 * external use (issue #501). Documented in
 * `website/docs/getting-started/installation.md`.
 *
 * Deliberately an explicit opt-in rather than an inference. Campfire will NOT try to
 * decide that a `baseUrl` is "local enough" by inspecting its host: a loopback or
 * RFC1918 address can just as easily be an egress proxy forwarding to a public vendor,
 * and guessing wrong leaks member-authored content that a member declined to share.
 * That is the operator's call to make, and it defaults to OFF (fail-closed).
 *
 * Note this is NOT the same knob as `AI_PROVIDER_ALLOW_PRIVATE_HOSTS`, which is the SSRF
 * host policy — permitting a private host as a *destination* says nothing about whether
 * content sent there stays inside the deployment.
 */
export function operatorDeclaredLocalAiEndpoint(): boolean {
  const raw = process.env.AI_PROVIDER_ENDPOINT_IS_LOCAL?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

/**
 * Decide whether a generation actually leaves the server, given only whether a provider
 * config resolved at all (issue #501, extracted for #1993).
 *
 * No configured provider ⇒ `'local'` — the run falls through to the injected/no-op seam,
 * which never transmits anywhere. A resolved config is `'external'` UNLESS the operator has
 * explicitly declared the endpoint local via `AI_PROVIDER_ENDPOINT_IS_LOCAL` — a genuinely
 * ambiguous `baseUrl` (it could be a localhost Ollama or a public API) stays external by
 * default (fail-closed).
 *
 * THE SHARED DECISION for every call site that populates
 * `AiGenerationProvenance.consent.externalSend` — `ScribeService`, `InboxSweepService`, and
 * `CoDmService` all call this rather than each re-implementing the operator-declared-local
 * check, so the three cannot drift into disagreeing about what "external" means (#1993
 * review: an earlier version of `CoDmService` implemented only the "configured ⇒ external"
 * half and ignored `AI_PROVIDER_ENDPOINT_IS_LOCAL` entirely, which misreported an on-box
 * Ollama deployment as external).
 */
export function resolveAiProvenanceEgress(configured: boolean): AiProvenanceEgress {
  if (!configured) return 'local';
  return operatorDeclaredLocalAiEndpoint() ? 'local' : 'external';
}
