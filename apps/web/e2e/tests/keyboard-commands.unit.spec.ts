/**
 * Keyboard command registry (issue #672).
 *
 * Pure unit coverage for chord matching, editable-target guards, rebinding
 * storage, and guarded live-action gating — no browser required.
 */
import { expect, test } from '@playwright/test';
import {
  DEFAULT_KEYBOARD_BINDINGS,
  chordFromKeyboardEvent,
  chordsEqual,
  formatAriaKeyshortcuts,
  formatChordLabel,
  matchKeyboardCommand,
  mergeBindings,
  parseChordString,
  parseStoredBindings,
  serializeBindings,
  serializeChord,
} from '../../src/lib/keyboardCommands/keyboardCommandRegistry';

test.describe('keyboard command registry (issue #672)', () => {
  test('matches mod+k to global search and slash alternate', () => {
    const bindings = { ...DEFAULT_KEYBOARD_BINDINGS };
    expect(
      matchKeyboardCommand(
        { key: 'k', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false },
        bindings,
      ),
    ).toBe('globalSearch');
    expect(
      matchKeyboardCommand(
        { key: 'k', ctrlKey: false, metaKey: true, shiftKey: false, altKey: false },
        bindings,
      ),
    ).toBe('globalSearch');
    expect(
      matchKeyboardCommand(
        { key: '/', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false },
        bindings,
      ),
    ).toBe('globalSearch');
  });

  test('matches quick capture and shortcut help chords', () => {
    const bindings = { ...DEFAULT_KEYBOARD_BINDINGS };
    expect(
      matchKeyboardCommand(
        { key: 'n', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false },
        bindings,
        { quickCapture: true },
      ),
    ).toBe('quickCapture');
    expect(
      matchKeyboardCommand(
        { key: '?', ctrlKey: false, metaKey: false, shiftKey: true, altKey: false },
        bindings,
      ),
    ).toBe('shortcutHelp');
  });

  test('guarded encounter next turn only matches when enabled', () => {
    const bindings = { ...DEFAULT_KEYBOARD_BINDINGS };
    const event = { key: '.', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };
    expect(matchKeyboardCommand(event, bindings, { encounterNextTurn: false })).toBeNull();
    expect(matchKeyboardCommand(event, bindings, { encounterNextTurn: true })).toBe('encounterNextTurn');
  });

  test('serialize and parse stored bindings', () => {
    const custom = { ...DEFAULT_KEYBOARD_BINDINGS, globalSearch: { key: 's', mod: true } };
    const raw = serializeBindings(custom);
    const parsed = mergeBindings(parseStoredBindings(raw));
    expect(parsed.globalSearch).toEqual({ key: 's', mod: true });
    expect(chordsEqual(parsed.quickCapture, DEFAULT_KEYBOARD_BINDINGS.quickCapture)).toBe(true);
  });

  test('formats aria-keyshortcuts and display labels', () => {
    const chord = { key: 'k', mod: true };
    expect(formatChordLabel(chord)).toMatch(/K/i);
    expect(formatAriaKeyshortcuts([chord])).toBe('Control+K Meta+K');
    expect(formatAriaKeyshortcuts([{ key: '?', shift: true }])).toBe('Shift+?');
  });

  test('parses stored chord strings', () => {
    expect(parseChordString('mod+shift+n')).toEqual({ key: 'n', mod: true, shift: true });
    expect(serializeChord(chordFromKeyboardEvent({
      key: 'n',
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
      altKey: false,
    }))).toBe('mod+shift+n');
  });
});
