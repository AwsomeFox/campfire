/**
 * Skip-link target + route-change focus helpers (issue #591).
 *
 * Pure functions are unit-tested so e2e can stay thin; components call the
 * imperative helpers after navigation.
 */

export const MAIN_CONTENT_ID = 'main-content';
export const SKIP_TO_MAIN_ID = 'skip-to-main';

export const APP_DOCUMENT_TITLE = 'Campfire';

/** Matches EntityDeepLinkFocus — deep-linked entity rows expose this hash. */
export const ENTITY_DEEP_LINK_HASH = /^#entity-[a-z_-]+-\d+$/;

export function isEntityDeepLinkHash(hash: string): boolean {
  return ENTITY_DEEP_LINK_HASH.test(hash);
}

/**
 * Whether RouteChangeFocus should move focus after navigation.
 * Compares pathnames and treats entity deep-link hashes as non-route changes.
 * Query-only updates are handled by RouteChangeFocus (effect deps omit `search`).
 */
export function shouldMoveFocusOnNavigation(
  previousPathname: string | null,
  nextPathname: string,
  nextHash: string,
): boolean {
  if (previousPathname === nextPathname) return false;
  if (isEntityDeepLinkHash(nextHash)) return false;
  return true;
}

export function isModalDialogOpen(doc: Document): boolean {
  return Boolean(doc.querySelector('[role="dialog"][aria-modal="true"]'));
}

const NATURALLY_FOCUSABLE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);

export function isNaturallyFocusable(el: HTMLElement): boolean {
  if (NATURALLY_FOCUSABLE.has(el.tagName)) return true;
  return el.tabIndex >= 0;
}

/** Prefer the page h1; fall back to the stable main landmark. */
export function mainFocusTarget(main: HTMLElement): HTMLElement {
  const h1 = main.querySelector('h1');
  if (h1 instanceof HTMLElement) return h1;
  return main;
}

export function normalizePageTitle(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function pageTitleFromMain(main: HTMLElement): string | null {
  const h1 = main.querySelector('h1');
  if (!(h1 instanceof HTMLElement)) return null;
  const title = normalizePageTitle(h1.textContent ?? '');
  return title || null;
}

const PATH_SEGMENT_TITLES: Record<string, string> = {
  quests: 'Quests',
  locations: 'World',
  npcs: 'NPCs',
  factions: 'Factions',
  party: 'Party',
  inventory: 'Inventory',
  sessions: 'Sessions',
  timeline: 'Timeline',
  'session-zero': 'Session Zero',
  encounters: 'Encounters',
  table: 'Table',
  compendium: 'Compendium',
  notes: 'My notes',
  proposals: 'Proposals',
  storylines: 'Storylines',
  settings: 'Settings',
  inbox: 'Scribe inbox',
  trash: 'Trash',
  members: 'Members',
  search: 'Search',
  preferences: 'Preferences',
  tokens: 'API tokens',
  credits: 'Credits & attributions',
  admin: 'Server admin',
  users: 'Users',
  rules: 'Rule packs',
  ai: 'AI console',
  auth: 'Auth',
  storage: 'Storage',
  audit: 'Audit log',
  new: 'New',
};

/** Title fallback when the route has not painted an h1 yet (or never will). */
export function fallbackPageTitle(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  if (normalized === '/') return 'Campaigns';

  const parts = normalized.split('/').filter(Boolean);
  if (parts[0] === 'c' && parts.length === 2) return 'Dashboard';
  if (parts[0] === 'admin' && parts.length === 1) return 'Server admin';

  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const segment = parts[i];
    if (/^\d+$/.test(segment)) continue;
    const mapped = PATH_SEGMENT_TITLES[segment];
    if (mapped) return mapped;
  }

  return APP_DOCUMENT_TITLE;
}

export function formatDocumentTitle(opts: { page: string; campaignName?: string | null }): string {
  const page = normalizePageTitle(opts.page) || APP_DOCUMENT_TITLE;
  const parts = [page];
  if (opts.campaignName) parts.push(normalizePageTitle(opts.campaignName));
  if (page !== APP_DOCUMENT_TITLE) parts.push(APP_DOCUMENT_TITLE);
  return parts.join(' · ');
}

export function focusProgrammatically(el: HTMLElement): void {
  if (!isNaturallyFocusable(el)) {
    el.tabIndex = -1;
  }
  el.focus({ preventScroll: true });
}

/** Skip link href targets #main-content — focus that landmark, not the page h1. */
export function focusSkipDestination(main: HTMLElement): void {
  focusProgrammatically(main);
}

export type FocusMainOptions = {
  /** Called when a page title is resolved (from h1 or fallback). */
  onPageTitle?: (pageTitle: string) => void;
  fallbackPageTitle?: string;
  /** Skip when a modal dialog owns focus management. */
  skipWhenModalOpen?: boolean;
};

/**
 * Focus the main destination (h1 or main) without scrolling the viewport.
 * Waits briefly for async h1 text via MutationObserver, mirroring EntityDeepLinkFocus.
 */
export function focusMainDestination(main: HTMLElement, opts: FocusMainOptions = {}): () => void {
  if (opts.skipWhenModalOpen !== false && isModalDialogOpen(document)) {
    return () => {};
  }

  let observer: MutationObserver | null = null;
  let frame = 0;
  let timeout = 0;

  const publishTitle = () => {
    const fromDom = pageTitleFromMain(main);
    const page = fromDom ?? opts.fallbackPageTitle ?? fallbackPageTitle(window.location.pathname);
    opts.onPageTitle?.(page);
  };

  const focusTarget = (target: HTMLElement) => {
    publishTitle();
    frame = window.requestAnimationFrame(() => {
      focusProgrammatically(target);
    });
    observer?.disconnect();
    if (timeout) window.clearTimeout(timeout);
  };

  const tryFocusHeading = (): boolean => {
    const h1 = main.querySelector('h1');
    if (!(h1 instanceof HTMLElement)) return false;
    focusTarget(h1);
    return true;
  };

  if (!tryFocusHeading()) {
    observer = new MutationObserver(() => {
      void tryFocusHeading();
    });
    observer.observe(main, { childList: true, subtree: true, characterData: true });

    const focusMainIfStillHeadless = () => {
      if (main.querySelector('h1')) return;
      focusTarget(main);
    };

    // Many list screens have no h1 — do not leave focus on nav chrome for seconds.
    frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(focusMainIfStillHeadless);
    });

    timeout = window.setTimeout(() => {
      observer?.disconnect();
      focusMainIfStillHeadless();
    }, 10_000);
  }

  return () => {
    observer?.disconnect();
    if (timeout) window.clearTimeout(timeout);
    if (frame) window.cancelAnimationFrame(frame);
  };
}
