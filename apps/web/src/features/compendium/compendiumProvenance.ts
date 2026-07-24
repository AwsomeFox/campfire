/**
 * Compendium reader provenance helpers (issue #740).
 *
 * Rule packs/entries store `sourceUrl`, but the reader previously rendered
 * attribution as dead text — users could not open or copy the upstream link,
 * and a blank/malformed URL still looked like traceable provenance. These
 * helpers decide whether a stored URL is a safe, actionable http(s) link and
 * whether it is entry-specific or only the pack/API homepage.
 */

/** Honest fallback when no safe upstream link can be offered. */
export const COMPENDIUM_SOURCE_UNAVAILABLE = 'Source unavailable';

/** Label for an entry-specific deep link (differs from the pack homepage). */
export const COMPENDIUM_SOURCE_ENTRY_LABEL = 'Entry source';

/** Label when the URL is only the pack / API homepage (inherited or pack-level). */
export const COMPENDIUM_SOURCE_PACK_LABEL = 'Pack homepage';

export const COMPENDIUM_SOURCE_COPY_LABEL = 'Copy link';
export const COMPENDIUM_SOURCE_COPIED_LABEL = 'Copied!';

export type SourceUrlClass =
  | { ok: true; href: string }
  | { ok: false; reason: 'missing' | 'malformed' | 'non-http' };

/**
 * Classify a stored source URL: safe absolute http(s), or an honest failure reason.
 * Rejects relative paths, credentials-in-URL, and non-http schemes (javascript:, data:, …).
 */
export function classifySourceUrl(raw: string | null | undefined): SourceUrlClass {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { ok: false, reason: 'missing' };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'non-http' };
  }
  // Credentials in a rendered href are a footgun; treat as unusable provenance.
  if (url.username || url.password) {
    return { ok: false, reason: 'malformed' };
  }
  if (!url.hostname) {
    return { ok: false, reason: 'malformed' };
  }

  return { ok: true, href: url.href };
}

export type CompendiumSourceProvenance =
  | {
      kind: 'entry' | 'pack';
      href: string;
      label: string;
      unavailable: false;
    }
  | {
      kind: 'unavailable';
      reason: 'missing' | 'malformed' | 'non-http';
      unavailable: true;
      label: typeof COMPENDIUM_SOURCE_UNAVAILABLE;
    };

/**
 * Resolve the reader's source-link state from stored entry + pack URLs.
 *
 * - Entry URL present and valid, different from pack → entry-specific deep link.
 * - Entry URL present and valid, same as pack (or pack missing) → pack homepage.
 * - Entry URL absent, pack URL valid → pack homepage.
 * - Missing / malformed / non-http → "Source unavailable" (never imply a working link).
 *
 * When the entry URL is present but invalid we do NOT silently fall back to the
 * pack homepage: the row claimed a different source, and substituting the pack
 * would misrepresent provenance.
 */
export function resolveCompendiumSource(opts: {
  entrySourceUrl?: string | null;
  packSourceUrl?: string | null;
}): CompendiumSourceProvenance {
  const entryRaw = (opts.entrySourceUrl ?? '').trim();
  const packRaw = (opts.packSourceUrl ?? '').trim();

  if (entryRaw) {
    const entry = classifySourceUrl(entryRaw);
    if (!entry.ok) {
      return {
        kind: 'unavailable',
        reason: entry.reason,
        unavailable: true,
        label: COMPENDIUM_SOURCE_UNAVAILABLE,
      };
    }
    const pack = classifySourceUrl(packRaw);
    // Same normalized href as the pack → inherited pack/API homepage, not a deep link.
    if (pack.ok && pack.href === entry.href) {
      return {
        kind: 'pack',
        href: entry.href,
        label: COMPENDIUM_SOURCE_PACK_LABEL,
        unavailable: false,
      };
    }
    return {
      kind: 'entry',
      href: entry.href,
      label: COMPENDIUM_SOURCE_ENTRY_LABEL,
      unavailable: false,
    };
  }

  if (packRaw) {
    const pack = classifySourceUrl(packRaw);
    if (!pack.ok) {
      return {
        kind: 'unavailable',
        reason: pack.reason,
        unavailable: true,
        label: COMPENDIUM_SOURCE_UNAVAILABLE,
      };
    }
    return {
      kind: 'pack',
      href: pack.href,
      label: COMPENDIUM_SOURCE_PACK_LABEL,
      unavailable: false,
    };
  }

  return {
    kind: 'unavailable',
    reason: 'missing',
    unavailable: true,
    label: COMPENDIUM_SOURCE_UNAVAILABLE,
  };
}
