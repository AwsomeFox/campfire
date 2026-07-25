/**
 * Request-time SSRF guard for AI provider outbound HTTP (issue #570).
 *
 * Config-time checks in `ai-provider-baseurl.ts` classify the URL host literal, but
 * DNS rebinding can make a public hostname resolve to a blocked address at connect
 * time. This module re-validates every outbound URL (and refuses redirects) before
 * fetch and after DNS resolution.
 */

import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import net from 'node:net';
import { Readable, Transform } from 'node:stream';
import { finished } from 'node:stream/promises';
import type { FetchInit, FetchLike, FetchResponse } from '../modules/ai-dm/providers/http';
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
  /** Addresses validated at check time and pinned for the outbound connect. */
  resolvedAddresses?: string[];
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
      resolvedAddresses: [hostname],
    };
  }

  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    if (records.length === 0) {
      return { ok: false, hostname, hostClass: 'invalid', reason: 'dns returned no addresses' };
    }
    const resolvedAddresses: string[] = [];
    let hostClass: AiProviderBaseUrlHostClass = 'public';
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
      resolvedAddresses.push(record.address);
      if (resolved.hostClass !== 'public') hostClass = resolved.hostClass;
    }
    return {
      ok: true,
      hostname,
      hostClass,
      reason: 'dns resolution ok',
      resolvedAddresses,
    };
  } catch {
    if (!requireDnsResolution) {
      return { ok: true, hostname, hostClass: 'public', reason: 'dns skipped at config check' };
    }
    return { ok: false, hostname, hostClass: 'invalid', reason: 'dns resolution failed' };
  }
}

function wrapNodeResponse(res: IncomingMessage): FetchResponse {
  const status = res.statusCode ?? 0;
  const chunks: Buffer[] = [];
  const tee = new Transform({
    transform(chunk, _enc, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      cb(null, chunk);
    },
  });
  res.pipe(tee);
  const body = Readable.toWeb(tee) as ReadableStream<Uint8Array>;
  const readBuffered = async (): Promise<string> => {
    await finished(res).catch(() => undefined);
    return Buffer.concat(chunks).toString('utf8');
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string) {
        const key = name.toLowerCase();
        const val = res.headers[key];
        if (val === undefined) return null;
        return Array.isArray(val) ? val[0] ?? null : val;
      },
    },
    text: readBuffered,
    json: async () => JSON.parse(await readBuffered()) as unknown,
    body,
  };
}

function pinnedLookup(pinnedAddress: string): net.LookupFunction {
  return (_hostname, _options, callback) => {
    const family = net.isIP(pinnedAddress) === 6 ? 6 : 4;
    callback(null, pinnedAddress, family);
  };
}

async function fetchWithPinnedAddresses(
  url: string,
  init: FetchInit,
  pinnedAddresses: string[],
): Promise<FetchResponse> {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === 'https:';
  const port = parsed.port ? Number(parsed.port) : isHttps ? 443 : 80;
  const path = `${parsed.pathname}${parsed.search}`;
  const hostHeader = parsed.host;
  let lastError: Error | undefined;

  for (const address of pinnedAddresses) {
    try {
      return await new Promise<FetchResponse>((resolve, reject) => {
        const requestOptions: https.RequestOptions = {
          hostname: address,
          port,
          path,
          method: init.method,
          headers: { ...init.headers, Host: hostHeader },
          servername: parsed.hostname,
          lookup: pinnedLookup(address),
          signal: init.signal,
        };
        const req = (isHttps ? https : http).request(requestOptions, (res) => resolve(wrapNodeResponse(res)));
        req.on('error', reject);
        init.signal?.addEventListener('abort', () => req.destroy(), { once: true });
        if (init.body) req.write(init.body);
        req.end();
      });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError ?? new AiProviderError('transport', 'ai: pinned outbound request failed', { provider: 'ai' });
}

/**
 * Fetch wrapper used by AI provider adapters: validates every request URL (with DNS)
 * and refuses HTTP redirects (redirect targets are not followed).
 */
export function createAiProviderGuardedFetch(
  policy: AiProviderBaseUrlPolicy = resolveAiProviderBaseUrlPolicy(),
): FetchLike {
  return async (url, init) => {
    const decision = await validateAiProviderOutboundUrl(url, policy);
    if (!decision.ok) {
      throw new AiProviderError('transport', 'ai: outbound URL blocked by server policy', {
        provider: 'ai',
        retryable: false,
      });
    }

    const pinnedAddresses = decision.resolvedAddresses;
    const res = pinnedAddresses?.length
      ? await fetchWithPinnedAddresses(url, init, pinnedAddresses)
      : await (() => {
          const baseFetch = (globalThis as { fetch?: FetchLike }).fetch;
          if (!baseFetch) {
            throw new AiProviderError('transport', 'ai: no fetch implementation available', { provider: 'ai' });
          }
          return baseFetch(url, { ...init, redirect: 'manual' } as FetchInit & { redirect?: string });
        })();
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
