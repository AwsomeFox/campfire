/**
 * Campaign switcher route memory (issue #760).
 *
 * When a multi-campaign user leaves one campaign for another, keep task context:
 *   1. Prefer the equivalent module in the target campaign when the user's role
 *      there allows it (entity ids never transfer — detail URLs collapse to the
 *      module root).
 *   2. Otherwise restore that campaign's last safe route for this user.
 *   3. Otherwise land on the target campaign dashboard.
 *
 * Routes are namespaced by userId so shared/family devices cannot leak another
 * account's place-in-campaign. Stored paths are re-validated against membership
 * and role before use; deleted/trashed campaigns and expired memberships drop
 * out of recent + last-safe resolution.
 */

import type { Campaign, Role } from '@campfire/schema';

/** Top-level campaign modules that can be remapped across campaigns. */
export type CampaignModule =
  | 'dashboard'
  | 'quests'
  | 'locations'
  | 'npcs'
  | 'factions'
  | 'party'
  | 'inventory'
  | 'sessions'
  | 'timeline'
  | 'session-zero'
  | 'encounters'
  | 'table'
  | 'compendium'
  | 'notes'
  | 'proposals'
  | 'storylines'
  | 'settings'
  | 'inbox'
  | 'trash'
  | 'members'
  | 'search';

/** Modules that require a DM seat (or server-admin-as-dm via roleIn). */
export const DM_ONLY_MODULES: ReadonlySet<CampaignModule> = new Set([
  'storylines',
  'settings',
  'inbox',
  'trash',
  'members',
]);

/**
 * Table is only meaningful while AI Driver mode is on. Treat it as never
 * "equivalent-safe" across campaigns — fall through to last-safe / dashboard.
 */
export const NON_EQUIVALENT_MODULES: ReadonlySet<CampaignModule> = new Set(['table']);

const MODULE_SEGMENT: Record<Exclude<CampaignModule, 'dashboard'>, string> = {
  quests: 'quests',
  locations: 'locations',
  npcs: 'npcs',
  factions: 'factions',
  party: 'party',
  inventory: 'inventory',
  sessions: 'sessions',
  timeline: 'timeline',
  'session-zero': 'session-zero',
  encounters: 'encounters',
  table: 'table',
  compendium: 'compendium',
  notes: 'notes',
  proposals: 'proposals',
  storylines: 'storylines',
  settings: 'settings',
  inbox: 'inbox',
  trash: 'trash',
  members: 'members',
  search: 'search',
};

const SEGMENT_TO_MODULE = new Map<string, CampaignModule>(
  Object.entries(MODULE_SEGMENT).map(([module, segment]) => [segment, module as CampaignModule]),
);

export type ParsedCampaignPath = {
  campaignId: number;
  module: CampaignModule;
  /** Pathname of the module root for this campaign (no entity id / query). */
  modulePath: string;
  /** Original pathname (no query/hash). */
  pathname: string;
};

export type CampaignSwitcherStorage = {
  /** Last in-campaign path per campaign id (string keys for JSON). */
  byCampaign: Record<string, { path: string; at: number }>;
  /** Most-recently-visited campaign ids (newest first). */
  recent: number[];
};

export type ResolveSwitchTargetInput = {
  targetCampaignId: number;
  /** Effective role in the target campaign; null = no membership / expired. */
  role: Role | null;
  /** False when the campaign is trashed/deleted or missing from the hub list. */
  campaignAccessible: boolean;
  /** Path the user is leaving (for equivalent-module preference). */
  sourcePath?: string | null;
  /** Stored last-safe path for the target (already user-namespaced). */
  lastSafeRoute?: string | null;
  /** Explicit Dashboard affordance — skip equivalent/last-safe. */
  preferDashboard?: boolean;
};

const STORAGE_PREFIX = 'campfire.campaignSwitcher.v1.';
const MAX_RECENT = 12;
const MAX_PATH_LEN = 512;

function storageKey(userId: number): string {
  return `${STORAGE_PREFIX}${userId}`;
}

/** Dashboard path for a campaign. */
export function campaignDashboardPath(campaignId: number): string {
  return `/c/${campaignId}`;
}

/** Module-root path for a campaign (entity ids never included). */
export function campaignModulePath(campaignId: number, module: CampaignModule): string {
  if (module === 'dashboard') return campaignDashboardPath(campaignId);
  return `/c/${campaignId}/${MODULE_SEGMENT[module]}`;
}

export function isModuleAllowedForRole(module: CampaignModule, role: Role | null): boolean {
  if (role == null) return false;
  if (DM_ONLY_MODULES.has(module) && role !== 'dm') return false;
  return true;
}

/**
 * Parse an in-app path into campaign + module. Detail URLs
 * (`/c/1/quests/9`) collapse to the module root. Returns null outside
 * `/c/:id…` or for unknown segments.
 */
export function parseCampaignPath(raw: string | null | undefined): ParsedCampaignPath | null {
  if (!raw) return null;
  let pathname: string;
  try {
    // Allow absolute same-origin URLs and path+query inputs.
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      pathname = new URL(raw).pathname;
    } else {
      pathname = raw.split(/[?#]/)[0] ?? raw;
    }
  } catch {
    return null;
  }
  if (!pathname.startsWith('/c/')) return null;
  const parts = pathname.split('/').filter(Boolean); // ['c', id, module?, …]
  if (parts.length < 2 || parts[0] !== 'c') return null;
  if (!/^[1-9]\d*$/.test(parts[1]!)) return null;
  const campaignId = Number(parts[1]);
  if (!Number.isSafeInteger(campaignId) || campaignId <= 0) return null;

  if (parts.length === 2) {
    return {
      campaignId,
      module: 'dashboard',
      modulePath: campaignDashboardPath(campaignId),
      pathname: `/c/${campaignId}`,
    };
  }

  const segment = parts[2]!;
  // Cast-to-TV screen is outside chrome — not a switcher module.
  if (segment === 'screen') return null;
  const module = SEGMENT_TO_MODULE.get(segment);
  if (!module) return null;

  return {
    campaignId,
    module,
    modulePath: campaignModulePath(campaignId, module),
    pathname: `/c/${campaignId}/${segment}${parts.length > 3 ? `/${parts.slice(3).join('/')}` : ''}`,
  };
}

/**
 * True when `path` is a safe restore target for this user in `campaignId`
 * with the given role. Rejects open redirects, other campaigns, DM-only
 * modules for non-DMs, and unknown segments.
 */
export function isSafeCampaignRoute(
  path: string | null | undefined,
  campaignId: number,
  role: Role | null,
): boolean {
  if (!path || path.length > MAX_PATH_LEN) return false;
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return false;
  const parsed = parseCampaignPath(path);
  if (!parsed) return false;
  if (parsed.campaignId !== campaignId) return false;
  return isModuleAllowedForRole(parsed.module, role);
}

/**
 * Resolve where selecting a campaign should land.
 * Order: explicit Dashboard → equivalent module → last safe → dashboard.
 */
export function resolveCampaignSwitchTarget(input: ResolveSwitchTargetInput): string {
  const { targetCampaignId, role, campaignAccessible, preferDashboard } = input;
  const dashboard = campaignDashboardPath(targetCampaignId);

  if (!campaignAccessible || role == null) {
    // Caller should not offer the tile; still fail closed to hub home.
    return '/';
  }

  if (preferDashboard) return dashboard;

  const source = parseCampaignPath(input.sourcePath ?? null);
  if (
    source
    && source.campaignId !== targetCampaignId
    && !NON_EQUIVALENT_MODULES.has(source.module)
    && isModuleAllowedForRole(source.module, role)
  ) {
    return campaignModulePath(targetCampaignId, source.module);
  }

  const last = input.lastSafeRoute ?? null;
  if (last && isSafeCampaignRoute(last, targetCampaignId, role)) {
    // Restore the exact last path (including entity detail) — ids belong to
    // this campaign. Strip query/hash noise beyond length cap via parse check.
    const pathname = last.split(/[?#]/)[0] ?? last;
    return pathname;
  }

  return dashboard;
}

export function emptySwitcherStorage(): CampaignSwitcherStorage {
  return { byCampaign: {}, recent: [] };
}

export function parseSwitcherStorage(raw: string | null | undefined): CampaignSwitcherStorage {
  if (!raw) return emptySwitcherStorage();
  try {
    const parsed = JSON.parse(raw) as Partial<CampaignSwitcherStorage>;
    const byCampaign: CampaignSwitcherStorage['byCampaign'] = {};
    if (parsed.byCampaign && typeof parsed.byCampaign === 'object') {
      for (const [key, value] of Object.entries(parsed.byCampaign)) {
        if (!/^[1-9]\d*$/.test(key)) continue;
        if (!value || typeof value !== 'object') continue;
        const path = typeof value.path === 'string' ? value.path : null;
        const at = typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : 0;
        if (!path || path.length > MAX_PATH_LEN) continue;
        byCampaign[key] = { path, at };
      }
    }
    const recent: number[] = [];
    if (Array.isArray(parsed.recent)) {
      for (const id of parsed.recent) {
        if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && !recent.includes(id)) {
          recent.push(id);
        }
      }
    }
    return { byCampaign, recent: recent.slice(0, MAX_RECENT) };
  } catch {
    return emptySwitcherStorage();
  }
}

function readStorage(userId: number, store: StorageLike): CampaignSwitcherStorage {
  try {
    return parseSwitcherStorage(store.getItem(storageKey(userId)));
  } catch {
    return emptySwitcherStorage();
  }
}

function writeStorage(userId: number, data: CampaignSwitcherStorage, store: StorageLike): void {
  try {
    store.setItem(storageKey(userId), JSON.stringify(data));
  } catch {
    /* private mode / quota — memory-only for this session is fine */
  }
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): StorageLike | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage;
}

/**
 * Remember the current in-campaign path for this user and bump recents.
 * No-ops for paths that are not parseable campaign module routes.
 */
export function rememberCampaignRoute(
  userId: number,
  path: string,
  now = Date.now(),
  store: StorageLike | null = defaultStorage(),
): CampaignSwitcherStorage | null {
  if (!store) return null;
  const parsed = parseCampaignPath(path);
  if (!parsed) return readStorage(userId, store);

  // Store the module/detail pathname; role filtering happens on read so a later
  // demotion cannot restore a DM-only surface.
  const pathname = parsed.pathname;
  const data = readStorage(userId, store);
  data.byCampaign[String(parsed.campaignId)] = { path: pathname, at: now };
  data.recent = [parsed.campaignId, ...data.recent.filter((id) => id !== parsed.campaignId)].slice(
    0,
    MAX_RECENT,
  );
  writeStorage(userId, data, store);
  return data;
}

/** Last safe path for a campaign, or null when missing / role-invalid. */
export function getLastSafeCampaignRoute(
  userId: number,
  campaignId: number,
  role: Role | null,
  store: StorageLike | null = defaultStorage(),
): string | null {
  if (!store || role == null) return null;
  const data = readStorage(userId, store);
  const entry = data.byCampaign[String(campaignId)];
  if (!entry) return null;
  return isSafeCampaignRoute(entry.path, campaignId, role) ? entry.path : null;
}

/**
 * Recent campaign ids still present in `accessibleIds` (membership + not
 * deleted). Stale ids from archived-away memberships are pruned from storage.
 */
export function listRecentCampaignIds(
  userId: number,
  accessibleIds: ReadonlySet<number> | readonly number[],
  store: StorageLike | null = defaultStorage(),
): number[] {
  if (!store) return [];
  const accessible = accessibleIds instanceof Set ? accessibleIds : new Set(accessibleIds);
  const data = readStorage(userId, store);
  const nextRecent = data.recent.filter((id) => accessible.has(id));
  let pruned = false;
  if (nextRecent.length !== data.recent.length) {
    data.recent = nextRecent;
    pruned = true;
  }
  for (const key of Object.keys(data.byCampaign)) {
    const id = Number(key);
    if (!accessible.has(id)) {
      delete data.byCampaign[key];
      pruned = true;
    }
  }
  if (pruned) writeStorage(userId, data, store);
  return nextRecent;
}

/** Drop one campaign's memory (e.g. after trash/purge or lost access). */
export function forgetCampaignRoute(
  userId: number,
  campaignId: number,
  store: StorageLike | null = defaultStorage(),
): void {
  if (!store) return;
  const data = readStorage(userId, store);
  delete data.byCampaign[String(campaignId)];
  data.recent = data.recent.filter((id) => id !== campaignId);
  writeStorage(userId, data, store);
}

/** Clear all switcher memory for a user (logout / account switch on shared device). */
export function clearCampaignSwitcherForUser(
  userId: number,
  store: StorageLike | null = defaultStorage(),
): void {
  if (!store) return;
  try {
    store.removeItem(storageKey(userId));
  } catch {
    /* ignore */
  }
}

export type CampaignChooserFilters = {
  query: string;
  role: 'all' | Role;
  status: 'all' | Campaign['status'];
};

export type ChooserCampaign = {
  campaign: Campaign;
  role: Role | null;
};

/**
 * Filter + order the hub list for the accessible campaign chooser.
 * Search matches name/description; role/status filters are exact.
 */
export function filterChooserCampaigns(
  items: readonly ChooserCampaign[],
  filters: CampaignChooserFilters,
): ChooserCampaign[] {
  const q = filters.query.trim().toLowerCase();
  return items.filter(({ campaign, role }) => {
    if (campaign.deletedAt) return false;
    if (filters.role !== 'all' && role !== filters.role) return false;
    if (filters.status !== 'all' && campaign.status !== filters.status) return false;
    if (!q) return true;
    const hay = `${campaign.name}\n${campaign.description ?? ''}`.toLowerCase();
    return hay.includes(q);
  });
}

/** Location state written by the Switch campaign control. */
export type CampaignSwitchLocationState = {
  switchFrom?: string;
};

export function switchFromPath(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null;
  const switchFrom = (state as CampaignSwitchLocationState).switchFrom;
  if (typeof switchFrom !== 'string') return null;
  return parseCampaignPath(switchFrom) ? switchFrom.split(/[?#]/)[0]! : null;
}
