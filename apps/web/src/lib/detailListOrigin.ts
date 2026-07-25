import type { Location } from 'react-router-dom';
import { safeInternalPath } from './safeInternalPath';

/** Router state written when navigating from a list (or search) into a detail page. */
export type ListOrigin = {
  /** Full in-app path including query string, e.g. `/c/3/quests?q=foo`. */
  path: string;
  /** Document scroll offset captured at navigation time for restore on return. */
  scrollY?: number;
};

export type DetailListOriginState = {
  listOrigin?: ListOrigin;
};

const LIST_SURFACES =
  'party|quests|npcs|factions|locations|encounters|search|sessions|timeline|inventory|notes|storylines|inbox|proposals|trash';

/**
 * Campaign list/search surfaces that may be preserved as a detail-page return target.
 * Deliberately excludes detail routes (`/characters/:id`, etc.) so a mention hop cannot
 * bounce the user between two detail pages via the in-app return link.
 */
export function safeCampaignListReturnPath(
  raw: string | null | undefined,
  campaignId: number,
): string | null {
  const safe = safeInternalPath(raw);
  if (!safe) return null;
  const withoutHash = safe.split('#')[0]!;
  const slash = withoutHash.indexOf('?');
  const pathOnly = slash === -1 ? withoutHash : withoutHash.slice(0, slash);
  const query = slash === -1 ? '' : withoutHash.slice(slash);
  const prefix = `/c/${campaignId}`;
  if (pathOnly === prefix || pathOnly === `${prefix}/`) return prefix;
  const listPattern = new RegExp(`^${prefix}/(${LIST_SURFACES})$`);
  if (!listPattern.test(pathOnly)) return null;
  return pathOnly + query;
}

/** Human-readable in-app return label derived from a validated list path. */
export function labelForListReturnPath(path: string, campaignId: number): string {
  const pathname = path.split(/[?#]/)[0]!;
  const prefix = `/c/${campaignId}`;
  if (pathname === prefix || pathname === `${prefix}/`) return '← Back to dashboard';
  if (pathname.endsWith('/party')) return '← Back to party';
  if (pathname.endsWith('/quests')) return '← Back to quests';
  if (pathname.endsWith('/npcs')) return '← Back to NPCs';
  if (pathname.endsWith('/factions')) return '← Back to factions';
  if (pathname.endsWith('/locations')) return '← Back to locations';
  if (pathname.endsWith('/encounters')) return '← Back to encounters';
  if (pathname.endsWith('/search')) return '← Back to search';
  if (pathname.endsWith('/sessions')) return '← Back to sessions';
  if (pathname.endsWith('/timeline')) return '← Back to timeline';
  if (pathname.endsWith('/inventory')) return '← Back to inventory';
  if (pathname.endsWith('/notes')) return '← Back to notes';
  if (pathname.endsWith('/storylines')) return '← Back to storylines';
  const segment = pathname.slice(prefix.length + 1).split('/')[0] ?? 'list';
  return `← Back to ${segment}`;
}

export function readListOrigin(state: unknown): ListOrigin | null {
  if (!state || typeof state !== 'object') return null;
  const origin = (state as DetailListOriginState).listOrigin;
  if (!origin || typeof origin.path !== 'string') return null;
  const scrollY = origin.scrollY;
  return {
    path: origin.path,
    scrollY: typeof scrollY === 'number' && Number.isFinite(scrollY) ? scrollY : undefined,
  };
}

export function readListOriginScroll(state: unknown): number | undefined {
  return readListOrigin(state)?.scrollY;
}

/** Capture the current list location at navigation time (call from click handlers). */
export function captureListOrigin(location: Pick<Location, 'pathname' | 'search'>): ListOrigin {
  return {
    path: `${location.pathname}${location.search}`,
    scrollY: typeof window !== 'undefined' ? window.scrollY : 0,
  };
}

/** Preserve an existing list origin when hopping detail → detail (subquests, etc.). */
export function preserveListOriginState(state: unknown): DetailListOriginState | undefined {
  const origin = readListOrigin(state);
  return origin ? { listOrigin: origin } : undefined;
}

export function resolveDetailReturnTarget(
  state: unknown,
  campaignId: number,
  defaultPath: string,
  defaultLabel: string,
): { to: string; label: string; scrollY?: number } {
  const origin = readListOrigin(state);
  const preserved = origin ? safeCampaignListReturnPath(origin.path, campaignId) : null;
  if (preserved) {
    return {
      to: preserved,
      label: labelForListReturnPath(preserved, campaignId),
      scrollY: origin?.scrollY,
    };
  }
  return { to: defaultPath, label: defaultLabel };
}

/** State to pass on the in-app return link so the list can restore scroll. */
export function listOriginRestoreState(
  path: string,
  scrollY: number | undefined,
): DetailListOriginState | undefined {
  if (scrollY == null) return undefined;
  return { listOrigin: { path, scrollY } };
}
