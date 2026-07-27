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
