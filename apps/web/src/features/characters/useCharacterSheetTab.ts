import { useCallback, useEffect, useRef, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAnnounce } from '../../components/Announcer';
import {
  CHARACTER_SHEET_TAB_LABEL,
  CHARACTER_SHEET_TAB_ORDER,
  characterSheetSectionId,
  characterSheetTabStorageKey,
  parseCharacterSheetFocusParam,
  parseCharacterSheetTabParam,
  readPersistedCharacterSheetTab,
  resolveCharacterSheetTab,
  tabForFocus,
  writePersistedCharacterSheetTab,
  type CharacterSheetFocus,
  type CharacterSheetTab,
} from './characterSheetTabs';

type UseCharacterSheetTabOptions = {
  campaignId: number;
  characterId: number;
  liveEncounter: boolean;
};

export function useCharacterSheetTab({ campaignId, characterId, liveEncounter }: UseCharacterSheetTabOptions) {
  const [searchParams, setSearchParams] = useSearchParams();
  const announce = useAnnounce();
  const storageKey = characterSheetTabStorageKey(campaignId, characterId);

  const urlTab = parseCharacterSheetTabParam(searchParams.get('tab'));
  const urlFocus = parseCharacterSheetFocusParam(searchParams.get('focus'));
  const persistedTab = readPersistedCharacterSheetTab(storageKey);

  const tab = resolveCharacterSheetTab({
    urlTab,
    urlFocus,
    persistedTab,
    liveEncounter,
  });

  const tabRefs = useRef<Record<CharacterSheetTab, HTMLButtonElement | null>>({
    play: null,
    build: null,
  });

  const setTab = useCallback(
    (next: CharacterSheetTab, options?: { focus?: CharacterSheetFocus | null; replace?: boolean }) => {
      writePersistedCharacterSheetTab(storageKey, next);
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next === 'play') params.delete('tab');
          else params.set('tab', next);
          if (options?.focus) params.set('focus', options.focus);
          else if (options?.focus === null) params.delete('focus');
          return params;
        },
        { replace: options?.replace ?? next === 'play' },
      );
      announce(`${CHARACTER_SHEET_TAB_LABEL[next]} tab selected.`);
    },
    [announce, setSearchParams, storageKey],
  );

  // When a focus deep link targets the other tab, align the URL tab param once.
  useEffect(() => {
    if (!urlFocus || urlTab) return;
    const needed = tabForFocus(urlFocus);
    if (needed === tab && needed !== 'play') {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.set('tab', needed);
          return params;
        },
        { replace: true },
      );
    }
  }, [setSearchParams, tab, urlFocus, urlTab]);

  // Scroll the focused section into view after the owning panel is visible.
  useEffect(() => {
    if (!urlFocus) return;
    const sectionId = characterSheetSectionId(urlFocus);
    const timer = window.setTimeout(() => {
      const el = document.getElementById(sectionId);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
      el.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [tab, urlFocus]);

  function focusTab(which: CharacterSheetTab) {
    tabRefs.current[which]?.focus();
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const idx = CHARACTER_SHEET_TAB_ORDER.indexOf(tab);
    if (idx < 0) return;
    let next: CharacterSheetTab | null = null;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = CHARACTER_SHEET_TAB_ORDER[(idx + 1) % CHARACTER_SHEET_TAB_ORDER.length];
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = CHARACTER_SHEET_TAB_ORDER[(idx - 1 + CHARACTER_SHEET_TAB_ORDER.length) % CHARACTER_SHEET_TAB_ORDER.length];
        break;
      case 'Home':
        next = CHARACTER_SHEET_TAB_ORDER[0];
        break;
      case 'End':
        next = CHARACTER_SHEET_TAB_ORDER[CHARACTER_SHEET_TAB_ORDER.length - 1];
        break;
      default:
        return;
    }
    if (next && next !== tab) {
      event.preventDefault();
      setTab(next);
      requestAnimationFrame(() => focusTab(next));
    } else if (next) {
      event.preventDefault();
      focusTab(next);
    }
  }

  return {
    tab,
    urlFocus,
    setTab,
    tabRefs,
    onTabKeyDown,
  };
}
