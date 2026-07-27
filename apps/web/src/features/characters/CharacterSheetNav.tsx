import type { KeyboardEvent, MutableRefObject } from 'react';
import {
  CHARACTER_SHEET_TAB_LABEL,
  CHARACTER_SHEET_TAB_ORDER,
  type CharacterSheetTab,
} from './characterSheetTabs';

type TabRefs = MutableRefObject<Record<CharacterSheetTab, HTMLButtonElement | null>>;

export function CharacterSheetNav({
  tab,
  setTab,
  tabRefs,
  onTabKeyDown,
  liveEncounter,
}: {
  tab: CharacterSheetTab;
  setTab: (next: CharacterSheetTab) => void;
  tabRefs: TabRefs;
  onTabKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  liveEncounter: boolean;
}) {
  return (
    <div
      className="cf-print-hide sticky top-0 z-20 -mx-4 px-4 py-2 bg-[var(--color-surface)]/95 backdrop-blur border-b border-slate-800/80"
      data-testid="character-sheet-tabs"
    >
      <div className="seg self-start inline-flex max-w-full" role="tablist" aria-label="Character sheet sections">
        {CHARACTER_SHEET_TAB_ORDER.map((t) => {
          const selected = tab === t;
          return (
            <button
              key={t}
              ref={(el) => {
                tabRefs.current[t] = el;
              }}
              type="button"
              role="tab"
              id={`character-sheet-tab-${t}`}
              aria-selected={selected}
              aria-controls={`character-sheet-panel-${t}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setTab(t)}
              onKeyDown={onTabKeyDown}
              className="seg-opt"
              style={{
                padding: '8px 14px',
                fontSize: 13,
                minHeight: 40,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              {CHARACTER_SHEET_TAB_LABEL[t]}
              {t === 'play' && liveEncounter && (
                <span className="tag tag-accent text-[9px] !py-0 !px-1.5" aria-label="Live encounter">
                  Live
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
