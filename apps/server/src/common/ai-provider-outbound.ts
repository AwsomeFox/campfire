/**
 * Request-time SSRF guard for AI provider outbound HTTP (issue #570).
 *
 * Config-time checks in `ai-provider-baseurl.ts` classify the URL host literal, but
 * DNS rebinding can make a public hostname resolve to a blocked address at connect
 * time. This module re-validates every outbound URL (and refuses redirects) before
 * fetch and after DNS resolution.
 */

import dns from 'node:dns/promises';
import net from 'node:net';
import type { FetchInit, FetchLike } from '../modules/ai-dm/providers/http';
import { AiProviderError } from '../modules/ai-dm/providers/errors';
import {
  classifyAiProviderHostname,
  evaluateAiProviderBaseUrl,
  hostMatchesAllowCidrs,
  isAlwaysBlockedHostClass,
  resolveAiProviderBaseUrlPolicy,
  type AiProviderBaseUrlHostClass,
  type AiProviderBaseUrlPolicy,
} from './ai-provider-baseurl';

export interface AiProviderOutboundDecision {
  ok: boolean;
  hostname: string;
  hostClass: AiProviderBaseUrlHostClass;
  /** Operator-facing reason — never return on probe endpoints. */
  reason: string;
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function normalizeHostname(hostname: string): string {
  return stripBrackets(hostname).trim().toLowerCase().replace(/\.$/, '');
}

function classifyResolvedAddress(
  address: string,
  policy: AiProviderBaseUrlPolicy,
): { ok: boolean; hostClass: AiProviderBaseUrlHostClass; reason: string } {
  const hostClass = classifyAiProviderHostname(address);
  if (isAlwaysBlockedHostClass(hostClass)) {
    return { ok: false, hostClass, reason: `${hostClass} address blocked` };
  }
  if (hostClass === 'private' || hostClass === 'loopback') {
    if (policy.allowPrivateHosts || hostMatchesAllowCidrs(address, policy.allowCidrs)) {
      return { ok: true, hostClass, reason: 'private address opted in' };
    }
    return { ok: false, hostClass, reason: 'private/loopback address blocked' };
  }
  return { ok: true, hostClass, reason: 'public address' };
}

export interface ValidateAiProviderOutboundOptions {
  /**
   * When false (config-time), an unresolvable public hostname is permitted after literal
   * checks — DNS is re-validated before every outbound request. When true (request-time),
   * DNS must succeed and every resolved address must pass policy.
   */
  requireDnsResolution?: boolean;
}

/**
 * Validate a candidate outbound URL: literal host policy plus DNS resolution for
 * hostnames (rebinding defense). IP literals skip DNS.
 */
export async function validateAiProviderOutboundUrl(
  url: string | null | undefined,
  policy: AiProviderBaseUrlPolicy = resolveAiProviderBaseUrlPolicy(),
  options: ValidateAiProviderOutboundOptions = {},
): Promise<AiProviderOutboundDecision> {
  const requireDnsResolution = options.requireDnsResolution ?? true;
  const literal = evaluateAiProviderBaseUrl(url, policy);
  if (!literal.ok) {
    return {
      ok: false,
      hostname: literal.hostname,
      hostClass: literal.hostClass,
      reason: literal.reason,
    };
  }

  if (url == null || !String(url).trim()) {
    return { ok: true, hostname: '', hostClass: 'public', reason: 'no override' };
  }

  let parsed: URL;
  try {
    parsed = new URL(String(url).trim());
  } catch {
    return { ok: false, hostname: '', hostClass: 'invalid', reason: 'unparseable URL' };
  }

  const hostname = normalizeHostname(parsed.hostname);
  const ipKind = net.isIP(hostname);
  if (ipKind) {
    const resolved = classifyResolvedAddress(hostname, policy);
    return {
      ok: resolved.ok,
      hostname,
      hostClass: resolved.hostClass,
      reason: resolved.reason,
    };
  }

  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    if (records.length === 0) {
      return { ok: false, hostname, hostClass: 'invalid', reason: 'dns returned no addresses' };
    }
    for (const record of records) {
      const resolved = classifyResolvedAddress(record.address, policy);
      if (!resolved.ok) {
        return {
          ok: false,
          hostname,
          hostClass: resolved.hostClass,
          reason: `dns for ${hostname} resolved to blocked ${record.address} (${resolved.hostClass})`,
        };
      }
    }
    return { ok: true, hostname, hostClass: 'public', reason: 'dns resolution ok' };
  } catch {
    if (!requireDnsResolution) {
      return { ok: true, hostname, hostClass: 'public', reason: 'dns skipped at config check' };
    }
    return { ok: false, hostname, hostClass: 'invalid', reason: 'dns resolution failed' };
  }
}

/**
 * Fetch wrapper used by AI provider adapters: validates every request URL (with DNS)
 * and refuses HTTP redirects (redirect targets are not followed).
 */
export function createAiProviderGuardedFetch(
  policy: AiProviderBaseUrlPolicy = resolveAiProviderBaseUrlPolicy(),
): FetchLike {
  const baseFetch = (globalThis as { fetch?: FetchLike }).fetch;
  if (!baseFetch) {
    throw new AiProviderError('transport', 'ai: no fetch implementation available', { provider: 'ai' });
  }

  return async (url, init) => {
    const decision = await validateAiProviderOutboundUrl(url, policy);
    if (!decision.ok) {
      throw new AiProviderError('transport', 'ai: outbound URL blocked by server policy', {
        provider: 'ai',
        retryable: false,
      });
    }

    const res = await baseFetch(url, { ...init, redirect: 'manual' } as FetchInit & { redirect?: string });
    if (res.status >= 300 && res.status < 400) {
      throw new AiProviderError('transport', 'ai: redirects are not permitted for provider requests', {
        provider: 'ai',
        retryable: false,
        status: res.status,
      });
    }
    return res;
  };
}
