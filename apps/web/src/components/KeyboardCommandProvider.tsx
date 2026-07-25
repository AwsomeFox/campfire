import { useCallback, useEffect, useMemo, useRef, useState, createContext, useContext, type ReactNode } from 'react';
import {
  DEFAULT_KEYBOARD_BINDINGS,
  KEYBOARD_BINDINGS_STORAGE_KEY,
  KEYBOARD_COMMANDS,
  formatAriaKeyshortcuts,
  formatChordLabel,
  chordsForCommand,
  isShortcutContextBlocked,
  matchKeyboardCommand,
  mergeBindings,
  parseStoredBindings,
  serializeBindings,
  type KeyboardCommandId,
  type KeyChord,
} from '../lib/keyboardCommands/keyboardCommandRegistry';
import { useCampaignAccess } from '../app/CampaignAccessContext';
import { GlobalSearchPalette } from './GlobalSearchPalette';
import { QuickCaptureDialog } from './QuickCaptureDialog';
import { ShortcutHelpDialog } from './ShortcutHelpDialog';

export type GuardedKeyboardAction = {
  canExecute: () => boolean;
  execute: () => void;
};

type Overlay = 'search' | 'quickCapture' | 'help' | null;

type KeyboardCommandContextValue = {
  bindings: Record<KeyboardCommandId, KeyChord>;
  setBinding: (id: KeyboardCommandId, chord: KeyChord) => void;
  resetBindings: () => void;
  chordLabel: (id: KeyboardCommandId) => string;
  ariaKeyshortcuts: (id: KeyboardCommandId) => string | undefined;
  openSearch: () => void;
  openQuickCapture: () => void;
  openHelp: () => void;
};

const KeyboardCommandContext = createContext<KeyboardCommandContextValue | null>(null);

export function useKeyboardCommands(): KeyboardCommandContextValue | null {
  return useContext(KeyboardCommandContext);
}

/** Convenience for controls that expose shortcut hints in title / aria-keyshortcuts. */
export function useKeyboardCommandHint(id: KeyboardCommandId): {
  ariaKeyshortcuts: string | undefined;
  shortcutLabel: string;
  titleSuffix: string;
} {
  const ctx = useKeyboardCommands();
  const shortcutLabel = ctx?.chordLabel(id) ?? formatChordLabel(DEFAULT_KEYBOARD_BINDINGS[id]);
  return {
    ariaKeyshortcuts: ctx?.ariaKeyshortcuts(id),
    shortcutLabel,
    titleSuffix: shortcutLabel ? ` (${shortcutLabel})` : '',
  };
}

/**
 * Register a guarded live action (issue #672). The provider only dispatches when
 * `canExecute()` is true — e.g. next turn while a running encounter is open.
 */
export function useKeyboardGuardedAction(id: KeyboardCommandId, action: GuardedKeyboardAction | null) {
  const ctx = useContext(KeyboardCommandInternalContext);
  const actionRef = useRef(action);
  actionRef.current = action;

  useEffect(() => {
    if (!ctx) return;
    const wrapped: GuardedKeyboardAction = {
      canExecute: () => actionRef.current?.canExecute() ?? false,
      execute: () => actionRef.current?.execute(),
    };
    ctx.registerAction(id, wrapped);
    return () => ctx.unregisterAction(id);
  }, [ctx, id]);
}

type InternalContextValue = {
  registerAction: (id: KeyboardCommandId, action: GuardedKeyboardAction) => void;
  unregisterAction: (id: KeyboardCommandId) => void;
};

const KeyboardCommandInternalContext = createContext<InternalContextValue | null>(null);

function loadInitialBindings(): Record<KeyboardCommandId, KeyChord> {
  if (typeof window === 'undefined') return { ...DEFAULT_KEYBOARD_BINDINGS };
  try {
    return mergeBindings(parseStoredBindings(localStorage.getItem(KEYBOARD_BINDINGS_STORAGE_KEY)));
  } catch {
    return { ...DEFAULT_KEYBOARD_BINDINGS };
  }
}

export function KeyboardCommandProvider({
  campaignId,
  children,
}: {
  campaignId: number;
  children: ReactNode;
}) {
  const { canMemberWrite } = useCampaignAccess();
  const [bindings, setBindings] = useState(loadInitialBindings);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const actionsRef = useRef(new Map<KeyboardCommandId, GuardedKeyboardAction>());

  const persistBindings = useCallback((next: Record<KeyboardCommandId, KeyChord>) => {
    setBindings(next);
    try {
      localStorage.setItem(KEYBOARD_BINDINGS_STORAGE_KEY, serializeBindings(next));
    } catch {
      // Quota / private mode — in-memory bindings still apply for this session.
    }
  }, []);

  const setBinding = useCallback((id: KeyboardCommandId, chord: KeyChord) => {
    persistBindings({ ...bindings, [id]: chord });
  }, [bindings, persistBindings]);

  const resetBindings = useCallback(() => {
    persistBindings({ ...DEFAULT_KEYBOARD_BINDINGS });
    try {
      localStorage.removeItem(KEYBOARD_BINDINGS_STORAGE_KEY);
    } catch {
      // ignore
    }
  }, [persistBindings]);

  const chordLabel = useCallback((id: KeyboardCommandId) => formatChordLabel(bindings[id]), [bindings]);
  const ariaKeyshortcuts = useCallback(
    (id: KeyboardCommandId) => formatAriaKeyshortcuts(chordsForCommand(id, bindings)),
    [bindings],
  );

  const registerAction = useCallback((id: KeyboardCommandId, action: GuardedKeyboardAction) => {
    actionsRef.current.set(id, action);
  }, []);

  const unregisterAction = useCallback((id: KeyboardCommandId) => {
    actionsRef.current.delete(id);
  }, []);

  const dispatchCommand = useCallback((id: KeyboardCommandId) => {
    switch (id) {
      case 'globalSearch':
        setOverlay('search');
        return;
      case 'quickCapture':
        if (canMemberWrite) setOverlay('quickCapture');
        return;
      case 'shortcutHelp':
        setOverlay('help');
        return;
      case 'encounterNextTurn': {
        const action = actionsRef.current.get(id);
        if (action?.canExecute()) action.execute();
        return;
      }
      default:
        return;
    }
  }, [canMemberWrite]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (overlay) return;
      if (isShortcutContextBlocked(event)) return;
      const enabled: Partial<Record<KeyboardCommandId, boolean>> = {
        quickCapture: canMemberWrite,
        encounterNextTurn: actionsRef.current.get('encounterNextTurn')?.canExecute() ?? false,
      };
      const matched = matchKeyboardCommand(event, bindings, enabled);
      if (!matched) return;
      event.preventDefault();
      dispatchCommand(matched);
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [overlay, bindings, canMemberWrite, dispatchCommand]);

  const publicValue = useMemo<KeyboardCommandContextValue>(() => ({
    bindings,
    setBinding,
    resetBindings,
    chordLabel,
    ariaKeyshortcuts,
    openSearch: () => setOverlay('search'),
    openQuickCapture: () => {
      if (canMemberWrite) setOverlay('quickCapture');
    },
    openHelp: () => setOverlay('help'),
  }), [bindings, setBinding, resetBindings, chordLabel, ariaKeyshortcuts, canMemberWrite]);

  const internalValue = useMemo<InternalContextValue>(() => ({
    registerAction,
    unregisterAction,
  }), [registerAction, unregisterAction]);

  return (
    <KeyboardCommandContext.Provider value={publicValue}>
      <KeyboardCommandInternalContext.Provider value={internalValue}>
        {children}
        {overlay === 'search' && (
          <GlobalSearchPalette campaignId={campaignId} onClose={() => setOverlay(null)} />
        )}
        {overlay === 'quickCapture' && canMemberWrite && (
          <QuickCaptureDialog campaignId={campaignId} onClose={() => setOverlay(null)} />
        )}
        {overlay === 'help' && (
          <ShortcutHelpDialog
            bindings={bindings}
            onSetBinding={setBinding}
            onReset={resetBindings}
            onClose={() => setOverlay(null)}
          />
        )}
      </KeyboardCommandInternalContext.Provider>
    </KeyboardCommandContext.Provider>
  );
}

export function keyboardCommandCatalog() {
  return KEYBOARD_COMMANDS;
}
