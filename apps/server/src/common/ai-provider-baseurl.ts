/**
 * SSRF guard for AI provider `baseUrl` hosts (issues #1064, #570).
 *
 * Schema validation only constrains scheme (http/https) and forbids embedded
 * credentials. This module is the server-side host policy: block cloud metadata
 * / link-local / multicast targets always, block private/loopback ranges unless the
 * operator opts in (local Ollama / llama.cpp / LM Studio), and honor optional host
 * / CIDR allow/deny lists. Request-time DNS re-validation lives in
 * `ai-provider-outbound.ts`.
 *
 * Env:
 *  - `AI_PROVIDER_ALLOW_PRIVATE_HOSTS=1|true` — permit RFC1918, loopback, ULA, etc.
 *  - `AI_PROVIDER_BASEURL_ALLOW_HOSTS` — comma-separated hostnames; when non-empty,
 *    only listed hosts (plus still-blocked metadata/link-local) may be used.
 *  - `AI_PROVIDER_BASEURL_ALLOW_CIDRS` — comma-separated CIDRs; private addresses in
 *    these ranges are permitted without the blanket private opt-in.
 *  - `AI_PROVIDER_BASEURL_DENY_HOSTS` — comma-separated hostnames always rejected.
 */

import net from 'node:net';

/** Generic probe failure — must not reveal why a host was refused (issue #1064). */
export const AI_PROVIDER_PROBE_GENERIC_ERROR = 'Provider connection failed.';

/** Persist/config rejection message (no host-class detail). */
export const AI_PROVIDER_BASEURL_NOT_PERMITTED =
  'baseUrl host is not permitted by server policy.';

/** Well-known cloud metadata hostnames (always blocked). */
const METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
]);

export type AiProviderBaseUrlHostClass =
  | 'public'
  | 'private'
  | 'loopback'
  | 'link-local'
  | 'metadata'
  | 'multicast'
  | 'unspecified'
  | 'invalid';

export interface AiProviderBaseUrlPolicy {
  allowPrivateHosts: boolean;
  allowHosts: string[];
  allowCidrs: string[];
  denyHosts: string[];
}

/** Host classes that are never permitted, even via allowlist / private opt-in. */
export function isAlwaysBlockedHostClass(hostClass: AiProviderBaseUrlHostClass): boolean {
  return (
    hostClass === 'metadata' ||
    hostClass === 'link-local' ||
    hostClass === 'multicast' ||
    hostClass === 'unspecified' ||
    hostClass === 'invalid'
  );
}

export interface AiProviderBaseUrlDecision {
  ok: boolean;
  hostname: string;
  hostClass: AiProviderBaseUrlHostClass;
  /** Operator-facing / log reason — never return this on probe endpoints. */
  reason: string;
}

function parseHostList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
    .map((h) => (h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h));
}

function envFlagTrue(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === '1' || v === 'true';
}

/** Read the current process env into a policy object (pure-ish; re-read each call). */
export function resolveAiProviderBaseUrlPolicy(
  env: NodeJS.ProcessEnv = process.env,
): AiProviderBaseUrlPolicy {
  return {
    allowPrivateHosts: envFlagTrue(env.AI_PROVIDER_ALLOW_PRIVATE_HOSTS),
    allowHosts: parseHostList(env.AI_PROVIDER_BASEURL_ALLOW_HOSTS),
    allowCidrs: parseCidrList(env.AI_PROVIDER_BASEURL_ALLOW_CIDRS),
    denyHosts: parseHostList(env.AI_PROVIDER_BASEURL_DENY_HOSTS),
  };
}

function parseCidrList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function normalizeHostname(hostname: string): string {
  return stripBrackets(hostname).trim().toLowerCase().replace(/\.$/, '');
}

/** Expand IPv4-mapped IPv6 (`:ffff:x.x.x.x` / `:ffff:hhhh:hhhh`) to dotted IPv4 when possible. */
function maybeIpv4Mapped(ip: string): string | null {
  const lower = ip.toLowerCase();
  if (!lower.startsWith(':ffff:') && !lower.startsWith('::ffff:')) return null;
  const mapped = lower.replace(/^::ffff:/, '').replace(/^:ffff:/, '');
  if (net.isIP(mapped) === 4) return mapped;
  // :ffff:7f00:1 → 127.0.0.1
  const hextets = mapped.split(':');
  if (hextets.length === 2 && hextets.every((h) => /^[0-9a-f]{1,4}$/i.test(h))) {
    const hi = parseInt(hextets[0], 16);
    const lo = parseInt(hextets[1], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

function ipv4Octets(ip: string): number[] | null {
  if (net.isIP(ip) !== 4) return null;
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return parts;
}

function classifyIpv4(ip: string): AiProviderBaseUrlHostClass {
  const o = ipv4Octets(ip);
  if (!o) return 'invalid';
  const [a, b] = o;
  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 169 && b === 254) {
    // AWS/GCP/Azure metadata address is the well-known link-local target.
    if (o[2] === 169 && o[3] === 254) return 'metadata';
    return 'link-local';
  }
  // Alibaba Cloud metadata (also inside CGNAT space — check before 100.64/10).
  if (a === 100 && b === 100 && o[2] === 100 && o[3] === 200) return 'metadata';
  // Carrier-grade NAT
  if (a === 100 && b >= 64 && b <= 127) return 'private';
  // Multicast 224.0.0.0/4
  if (a >= 224 && a <= 239) return 'multicast';
  return 'public';
}

function classifyIpv6(ip: string): AiProviderBaseUrlHostClass {
  const mapped = maybeIpv4Mapped(ip);
  if (mapped) return classifyIpv4(mapped);

  // Normalize for prefix checks via Buffer
  let buf: Buffer;
  try {
    buf = net.isIP(ip) === 6 ? ipv6ToBuffer(ip) : Buffer.alloc(0);
  } catch {
    return 'invalid';
  }
  if (buf.length !== 16) return 'invalid';

  // :: / unspecified
  if (buf.every((b) => b === 0)) return 'unspecified';
  // ::1 loopback
  if (buf.subarray(0, 15).every((b) => b === 0) && buf[15] === 1) return 'loopback';
  // fe80::/10 link-local
  if (buf[0] === 0xfe && (buf[1] & 0xc0) === 0x80) return 'link-local';
  // fc00::/7 unique local
  if ((buf[0] & 0xfe) === 0xfc) return 'private';
  // ff00::/8 multicast
  if (buf[0] === 0xff) return 'multicast';
  return 'public';
}

/** Expand an IPv6 string to a 16-byte buffer (handles `::` compression). */
function ipv6ToBuffer(ip: string): Buffer {
  const halves = ip.split('::');
  if (halves.length > 2) throw new Error('bad ipv6');
  const parseSide = (side: string): number[] => {
    if (!side) return [];
    return side.split(':').filter(Boolean).map((h) => {
      if (!/^[0-9a-f]{1,4}$/i.test(h)) throw new Error('bad hextet');
      return parseInt(h, 16);
    });
  };
  let head: number[];
  let tail: number[];
  if (halves.length === 1) {
    head = parseSide(halves[0]);
    tail = [];
    if (head.length !== 8) throw new Error('bad ipv6 length');
  } else {
    head = parseSide(halves[0]);
    tail = parseSide(halves[1]);
    const missing = 8 - head.length - tail.length;
    if (missing < 0) throw new Error('bad ipv6 length');
    head = head.concat(Array(missing).fill(0), tail);
  }
  const out = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) out.writeUInt16BE(head[i], i * 2);
  return out;
}

/**
 * Classify a hostname or IP literal for SSRF policy. Hostnames that are not IP
 * literals are `public` unless they are well-known metadata names (then
 * `metadata`) or the special `localhost` / `*.localhost` loopback names.
 */
export function classifyAiProviderHostname(hostname: string): AiProviderBaseUrlHostClass {
  const host = normalizeHostname(hostname);
  if (!host) return 'invalid';

  if (METADATA_HOSTNAMES.has(host)) return 'metadata';
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';

  const ipKind = net.isIP(host);
  if (ipKind === 4) {
    const cls = classifyIpv4(host);
    // Explicit AWS/GCP/Azure metadata address
    if (host === '169.254.169.254') return 'metadata';
    return cls;
  }
  if (ipKind === 6) return classifyIpv6(host);

  // Non-IP hostname — treated as public DNS name (no resolve-time check here).
  return 'public';
}

function hostMatchesList(hostname: string, list: string[]): boolean {
  const host = normalizeHostname(hostname);
  return list.some((entry) => entry === host);
}

function ipv4ToUint32(ip: string): number | null {
  const o = ipv4Octets(ip);
  if (!o) return null;
  return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
}

function ipv4InCidr(ip: string, cidr: string): boolean {
  const [network, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const ipNum = ipv4ToUint32(ip);
  const netNum = ipv4ToUint32(network);
  if (ipNum === null || netNum === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipNum & mask) === (netNum & mask);
}

function ipv6InCidr(ip: string, cidr: string): boolean {
  const [network, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 128) return false;
  let ipBuf: Buffer;
  let netBuf: Buffer;
  try {
    ipBuf = ipv6ToBuffer(ip);
    netBuf = ipv6ToBuffer(network);
  } catch {
    return false;
  }
  const fullBytes = Math.floor(bits / 8);
  const remBits = bits % 8;
  for (let i = 0; i < fullBytes; i++) {
    if (ipBuf[i] !== netBuf[i]) return false;
  }
  if (remBits === 0) return true;
  const mask = (0xff << (8 - remBits)) & 0xff;
  return (ipBuf[fullBytes] & mask) === (netBuf[fullBytes] & mask);
}

/** True when `address` falls inside any configured CIDR allow entry. */
export function hostMatchesAllowCidrs(address: string, cidrs: string[]): boolean {
  if (cidrs.length === 0) return false;
  const ipKind = net.isIP(address);
  return cidrs.some((cidr) => {
    if (!cidr.includes('/')) return false;
    if (ipKind === 4) return ipv4InCidr(address, cidr);
    if (ipKind === 6) return ipv6InCidr(address, cidr);
    return false;
  });
}

/**
 * Decide whether a candidate `baseUrl` may be used for an outbound provider call.
 * `baseUrl` may be undefined/empty (provider default endpoint) — that is always OK.
 */
export function evaluateAiProviderBaseUrl(
  baseUrl: string | null | undefined,
  policy: AiProviderBaseUrlPolicy = resolveAiProviderBaseUrlPolicy(),
): AiProviderBaseUrlDecision {
  if (baseUrl == null || !String(baseUrl).trim()) {
    return { ok: true, hostname: '', hostClass: 'public', reason: 'no override' };
  }

  let url: URL;
  try {
    url = new URL(String(baseUrl).trim());
  } catch {
    return { ok: false, hostname: '', hostClass: 'invalid', reason: 'unparseable URL' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, hostname: '', hostClass: 'invalid', reason: 'non-http(s) scheme' };
  }
  if (url.username || url.password) {
    return { ok: false, hostname: '', hostClass: 'invalid', reason: 'embedded credentials' };
  }

  const hostname = normalizeHostname(url.hostname);
  const hostClass = classifyAiProviderHostname(hostname);

  if (isAlwaysBlockedHostClass(hostClass)) {
    return { ok: false, hostname, hostClass, reason: `${hostClass} host blocked` };
  }

  if (hostMatchesList(hostname, policy.denyHosts)) {
    return { ok: false, hostname, hostClass, reason: 'host is on the deny list' };
  }

  if (policy.allowHosts.length > 0) {
    if (hostMatchesList(hostname, policy.allowHosts)) {
      return { ok: true, hostname, hostClass, reason: 'host is on the allow list' };
    }
    return { ok: false, hostname, hostClass, reason: 'host is not on the allow list' };
  }

  if (hostClass === 'private' || hostClass === 'loopback') {
    if (
      policy.allowPrivateHosts ||
      hostMatchesAllowCidrs(hostname, policy.allowCidrs)
    ) {
      return { ok: true, hostname, hostClass, reason: 'private hosts opted in' };
    }
    return {
      ok: false,
      hostname,
      hostClass,
      reason: 'private/loopback hosts require AI_PROVIDER_ALLOW_PRIVATE_HOSTS=1 or CIDR allowlist',
    };
  }

  return { ok: true, hostname, hostClass, reason: 'public host' };
}

/** True when the URL is permitted under the current (or supplied) policy. */
export function isAiProviderBaseUrlAllowed(
  baseUrl: string | null | undefined,
  policy?: AiProviderBaseUrlPolicy,
): boolean {
  return evaluateAiProviderBaseUrl(baseUrl, policy).ok;
}
