import type { TFunction } from 'i18next';

export type NavItem = {
  key: string;
  label: string;
  to?: string;
  soon?: boolean;
  badge?: number;
};

export type NavGroupKey = 'play' | 'prepare' | 'world' | 'records' | 'manage';

export type NavGroup = {
  key: NavGroupKey;
  label: string;
  items: NavItem[];
};

/** Mobile tab bar destinations — excluded from the More sheet to avoid duplicates (issue #643). */
export const MOBILE_TAB_BAR_KEYS = new Set(['dashboard', 'quests', 'party', 'notes']);

const GROUP_LABEL_KEYS: Record<NavGroupKey, string> = {
  play: 'nav.groupPlay',
  prepare: 'nav.groupPrepare',
  world: 'nav.groupWorld',
  records: 'nav.groupRecords',
  manage: 'nav.groupManage',
};

export function buildCampaignNavGroups(
  t: TFunction,
  campaignId: number,
  opts: {
    isDm: boolean;
    aiDriverActive: boolean;
    inboxCount: number;
    pendingProposals: number;
    trashCount: number;
  },
): NavGroup[] {
  const base = `/c/${campaignId}`;
  const { isDm, aiDriverActive, inboxCount, pendingProposals, trashCount } = opts;

  const groups: NavGroup[] = [
    {
      key: 'play',
      label: t(GROUP_LABEL_KEYS.play),
      items: [
        { key: 'dashboard', label: t('nav.dashboard'), to: base },
        { key: 'party', label: t('nav.party'), to: `${base}/party` },
        { key: 'inventory', label: t('nav.inventory'), to: `${base}/inventory` },
        { key: 'encounters', label: t('nav.encounters'), to: `${base}/encounters` },
        ...(aiDriverActive ? [{ key: 'table', label: t('nav.table'), to: `${base}/table` }] : []),
        { key: 'notes', label: t('nav.myNotes'), to: `${base}/notes` },
      ],
    },
    {
      key: 'prepare',
      label: t(GROUP_LABEL_KEYS.prepare),
      items: [
        { key: 'quests', label: t('nav.quests'), to: `${base}/quests` },
        { key: 'session-zero', label: t('nav.sessionZero'), to: `${base}/session-zero` },
        ...(isDm ? [{ key: 'storylines', label: t('nav.storylines'), to: `${base}/storylines` }] : []),
        { key: 'compendium', label: t('nav.compendium'), to: `${base}/compendium` },
      ],
    },
    {
      key: 'world',
      label: t(GROUP_LABEL_KEYS.world),
      items: [
        { key: 'world', label: t('nav.world'), to: `${base}/locations` },
        { key: 'npcs', label: t('nav.npcs'), to: `${base}/npcs` },
        { key: 'factions', label: t('nav.factions'), to: `${base}/factions` },
      ],
    },
    {
      key: 'records',
      label: t(GROUP_LABEL_KEYS.records),
      items: [
        { key: 'sessions', label: t('nav.sessions'), to: `${base}/sessions` },
        { key: 'timeline', label: t('nav.timeline'), to: `${base}/timeline` },
      ],
    },
  ];

  const manageItems: NavItem[] = isDm
    ? [
        { key: 'settings', label: t('nav.settings'), to: `${base}/settings` },
        { key: 'inbox', label: t('nav.scribeInbox'), to: `${base}/inbox`, badge: inboxCount },
        { key: 'proposals', label: t('nav.proposals'), to: `${base}/proposals`, badge: pendingProposals },
        { key: 'trash', label: t('nav.trash'), to: `${base}/trash`, badge: trashCount },
        { key: 'members', label: t('nav.members'), to: `${base}/members` },
      ]
    : [{ key: 'proposals', label: t('nav.myProposals'), to: `${base}/proposals` }];

  groups.push({
    key: 'manage',
    label: t(GROUP_LABEL_KEYS.manage),
    items: manageItems,
  });

  return groups;
}

/** Flat list of every campaign nav item (sidebar + tests). */
export function flattenNavGroups(groups: NavGroup[]): NavItem[] {
  return groups.flatMap((g) => g.items);
}

/** More-sheet groups with tab-bar duplicates removed (issue #643). */
export function navGroupsForMoreSheet(groups: NavGroup[]): NavGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !MOBILE_TAB_BAR_KEYS.has(item.key)),
    }))
    .filter((group) => group.items.length > 0);
}

export function isActiveNavPath(pathname: string, to: string | undefined, campaignId?: number): boolean {
  if (!to) return false;
  const path = to.split('#')[0];
  if (path === `/c/${campaignId}` || path === '/admin') {
    return pathname === path;
  }
  return pathname.startsWith(path);
}
