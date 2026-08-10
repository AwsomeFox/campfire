/**
 * Keyboard command registry (issue #672).
 *
 * Pure model for discoverable, rebindable campaign shortcuts: chord parsing,
 * context guards (editors / foreign modals / IME), and aria-keyshortcuts
 * formatting. UI and localStorage live in KeyboardCommandProvider.
 */

import { isImeComposing, type CompositionKeyEvent } from '../compositionSafeSubmit';

export const KEYBOARD_BINDINGS_STORAGE_KEY = 'cf.keyboardShortcuts.v1';

/** Stable command ids — extend here when adding new shortcuts. */
export type KeyboardCommandId =
  | 'globalSearch'
  | 'quickCapture'
  | 'shortcutHelp'
  | 'encounterNextTurn'
  | 'safetyHold';

export type KeyChord = {
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
};

export type KeyboardCommandMeta = {
  id: KeyboardCommandId;
  label: string;
  description: string;
  /** Shown in help when the action is context-gated (e.g. live encounter). */
  contextHint?: string;
  defaultChord: KeyChord;
  /** Secondary chords that also trigger this command (e.g. `/` for search). */
  altChords?: KeyChord[];
};

export const KEYBOARD_COMMANDS: readonly KeyboardCommandMeta[] = [
  {
    id: 'globalSearch',
    label: 'Search campaign',
    description: 'Open campaign-wide search from any page.',
    defaultChord: { key: 'k', mod: true },
    altChords: [{ key: '/' }],
  },
  {
    id: 'quickCapture',
    label: 'Quick capture note',
    description: 'Jot a private note without leaving your current page.',
    defaultChord: { key: 'n', mod: true, shift: true },
  },
  {
    id: 'shortcutHelp',
    label: 'Keyboard shortcuts',
    description: 'Show shortcuts and change bindings.',
    defaultChord: { key: '?', shift: true },
  },
  {
    id: 'encounterNextTurn',
    label: 'Next turn',
    description: 'Advance initiative on a running encounter.',
    contextHint: 'Only while running an encounter as DM.',
    defaultChord: { key: '.', mod: true },
  },
  {
    // #599. Escape is not available (it closes dialogs) and every unmodified letter is
    // swallowed by the typing guard, so this is a chord — but it is a chord nobody has to
    // remember under pressure, because the button it mirrors is on screen beside it.
    //
    // Still not gated by application STATE — there is no point in a session at which
    // stopping the table is unavailable, so the handler passes an unconditional action.
    // The hint is about LOCATION: the handler is registered by `SafetyHoldBar`, which now
    // mounts only on the Table page, so the chord is live exactly where the button is.
    // Saying so beats a shortcuts panel that lists it as unconditional and then does
    // nothing when someone presses it mid-combat.
    id: 'safetyHold',
    label: 'Pause the table (safety)',
    description: 'Immediately stop encounter advancement and the AI DM. No reason required.',
    contextHint: 'On the Table page, alongside the Pause the table button.',
    defaultChord: { key: 'x', mod: true, shift: true },
  },
] as const;

export const DEFAULT_KEYBOARD_BINDINGS: Readonly<Record<KeyboardCommandId, KeyChord>> = Object.fromEntries(
  KEYBOARD_COMMANDS.map((cmd) => [cmd.id, cmd.defaultChord]),
) as Record<KeyboardCommandId, KeyChord>;

const COMMAND_BY_ID = new Map(KEYBOARD_COMMANDS.map((cmd) => [cmd.id, cmd]));

export function keyboardCommandMeta(id: KeyboardCommandId): KeyboardCommandMeta {
  return COMMAND_BY_ID.get(id)!;
}

/** True when focus is in a text field or other typing surface. */
export function isEditableElement(element: Element | null): boolean {
  if (!element || !(element instanceof HTMLElement)) return false;
  const tag = element.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    const input = element as HTMLInputElement;
    if (tag === 'INPUT') {
      const type = (input.type || 'text').toLowerCase();
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'checkbox' || type === 'radio' || type === 'file') {
        return false;
      }
    }
    return !input.disabled && !input.readOnly;
  }
  if (element.isContentEditable) return true;
  return Boolean(element.closest('[contenteditable=""], [contenteditable="true"]'));
}

/**
 * True when a global shortcut must not fire: IME composition, typing surfaces,
 * or a foreign modal dialog (not marked with data-keyboard-command-overlay).
 */
export function isShortcutContextBlocked(
  event: CompositionKeyEvent & { target?: EventTarget | null },
  options?: { allowInCommandOverlay?: boolean },
): boolean {
  if (isImeComposing(event)) return true;
  const target = event.target instanceof Element ? event.target : null;
  if (!options?.allowInCommandOverlay && target?.closest('[data-keyboard-command-overlay]')) {
    // Overlay inputs handle their own keys; global bindings are suppressed except
    // Escape (handled by useDialog on the overlay).
    return true;
  }
  if (isEditableElement(document.activeElement)) return true;
  const foreignDialog = document.querySelector('[role="dialog"][aria-modal="true"]:not([data-keyboard-command-overlay])');
  return Boolean(foreignDialog);
}

export function chordFromKeyboardEvent(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): KeyChord {
  return {
    key: normalizeKey(event.key),
    mod: event.ctrlKey || event.metaKey,
    shift: event.shiftKey,
    alt: event.altKey,
  };
}

function normalizeKey(key: string): string {
  if (key === ' ') return 'space';
  if (key.length === 1) return key.toLowerCase();
  return key.toLowerCase();
}

export function chordsEqual(a: KeyChord, b: KeyChord): boolean {
  return a.key === b.key
    && Boolean(a.mod) === Boolean(b.mod)
    && Boolean(a.shift) === Boolean(b.shift)
    && Boolean(a.alt) === Boolean(b.alt);
}

export function chordMatchesEvent(chord: KeyChord, event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): boolean {
  return chordsEqual(chord, chordFromKeyboardEvent(event));
}

export function chordsForCommand(
  id: KeyboardCommandId,
  bindings: Readonly<Record<KeyboardCommandId, KeyChord>>,
): KeyChord[] {
  const meta = keyboardCommandMeta(id);
  const primary = bindings[id] ?? meta.defaultChord;
  const alts = meta.altChords ?? [];
  return [primary, ...alts.filter((alt) => !chordsEqual(alt, primary))];
}

/** Resolve the first command whose binding matches `event`. */
export function matchKeyboardCommand(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  bindings: Readonly<Record<KeyboardCommandId, KeyChord>>,
  enabled: Readonly<Partial<Record<KeyboardCommandId, boolean>>> = {},
): KeyboardCommandId | null {
  for (const cmd of KEYBOARD_COMMANDS) {
    if (enabled[cmd.id] === false) continue;
    const chords = chordsForCommand(cmd.id, bindings);
    if (chords.some((chord) => chordMatchesEvent(chord, event))) return cmd.id;
  }
  return null;
}

/** Serialize a chord for storage, e.g. `mod+shift+n`. */
export function serializeChord(chord: KeyChord): string {
  const parts: string[] = [];
  if (chord.mod) parts.push('mod');
  if (chord.shift) parts.push('shift');
  if (chord.alt) parts.push('alt');
  parts.push(chord.key);
  return parts.join('+');
}

export function parseChordString(raw: string): KeyChord | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  const segments = trimmed.split('+').filter(Boolean);
  if (segments.length === 0) return null;
  const key = segments[segments.length - 1]!;
  const mods = new Set(segments.slice(0, -1));
  if (!key) return null;
  const chord: KeyChord = { key };
  if (mods.has('mod') || mods.has('ctrl') || mods.has('meta') || mods.has('cmd')) chord.mod = true;
  if (mods.has('shift')) chord.shift = true;
  if (mods.has('alt') || mods.has('option')) chord.alt = true;
  return chord;
}

export function parseStoredBindings(raw: string | null): Partial<Record<KeyboardCommandId, KeyChord>> {
  if (!raw) return {};
  try {
    const data = JSON.parse(raw) as Record<string, string>;
    const out: Partial<Record<KeyboardCommandId, KeyChord>> = {};
    for (const cmd of KEYBOARD_COMMANDS) {
      const value = data[cmd.id];
      if (typeof value !== 'string') continue;
      const chord = parseChordString(value);
      if (chord) out[cmd.id] = chord;
    }
    return out;
  } catch {
    return {};
  }
}

export function mergeBindings(
  overrides: Partial<Record<KeyboardCommandId, KeyChord>>,
): Record<KeyboardCommandId, KeyChord> {
  return { ...DEFAULT_KEYBOARD_BINDINGS, ...overrides };
}

export function serializeBindings(bindings: Readonly<Record<KeyboardCommandId, KeyChord>>): string {
  const out: Record<string, string> = {};
  for (const cmd of KEYBOARD_COMMANDS) {
    const chord = bindings[cmd.id];
    if (chord && !chordsEqual(chord, cmd.defaultChord)) {
      out[cmd.id] = serializeChord(chord);
    }
  }
  return JSON.stringify(out);
}

const MOD_LABEL = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform)
  ? '⌘'
  : 'Ctrl';

/** Human-readable label for tooltips / help (issue #672 discoverability). */
export function formatChordLabel(chord: KeyChord): string {
  const parts: string[] = [];
  if (chord.mod) parts.push(MOD_LABEL);
  if (chord.alt) parts.push('Alt');
  if (chord.shift) parts.push('Shift');
  parts.push(formatKeyToken(chord.key));
  return parts.join(chord.mod && !chord.shift && !chord.alt ? '' : '+').replace(/^\+/, '');
}

function formatKeyToken(key: string): string {
  switch (key) {
    case 'space': return 'Space';
    case '.': return '.';
    case '/': return '/';
    case '?': return '?';
    default: return key.length === 1 ? key.toUpperCase() : key;
  }
}

function formatAriaChord(chord: KeyChord, modKey: 'Control' | 'Meta' | null): string {
  const parts: string[] = [];
  if (modKey) parts.push(modKey);
  if (chord.alt) parts.push('Alt');
  if (chord.shift) parts.push('Shift');
  parts.push(formatAriaKeyToken(chord.key));
  return parts.join('+');
}

/** WAI-ARIA aria-keyshortcuts value (Control/Meta variants for cross-platform). */
export function formatAriaKeyshortcuts(chords: readonly KeyChord[]): string {
  return chords
    .flatMap((chord) => {
      if (chord.mod) {
        return [
          formatAriaChord(chord, 'Control'),
          formatAriaChord(chord, 'Meta'),
        ];
      }
      return [formatAriaChord(chord, null)];
    })
    .join(' ');
}

function formatAriaKeyToken(key: string): string {
  switch (key) {
    case 'space': return 'Space';
    case '.': return '.';
    case '/': return 'Slash';
    case '?': return '?';
    default: return key.length === 1 ? key.toUpperCase() : key;
  }
}

export function findBindingConflicts(
  bindings: Readonly<Record<KeyboardCommandId, KeyChord>>,
): Map<string, KeyboardCommandId[]> {
  const bySerialized = new Map<string, KeyboardCommandId[]>();
  for (const cmd of KEYBOARD_COMMANDS) {
    for (const chord of chordsForCommand(cmd.id, bindings)) {
      const key = serializeChord(chord);
      const list = bySerialized.get(key) ?? [];
      list.push(cmd.id);
      bySerialized.set(key, list);
    }
  }
  const conflicts = new Map<string, KeyboardCommandId[]>();
  for (const [key, ids] of bySerialized) {
    const unique = [...new Set(ids)];
    if (unique.length > 1) conflicts.set(key, unique);
  }
  return conflicts;
}
