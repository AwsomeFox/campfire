import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_KEYBOARD_BINDINGS,
  KEYBOARD_COMMANDS,
  chordFromKeyboardEvent,
  chordsEqual,
  chordsForCommand,
  findBindingConflicts,
  formatChordLabel,
  type KeyboardCommandId,
  type KeyChord,
} from '../lib/keyboardCommands/keyboardCommandRegistry';
import { Btn, Dialog } from './ui';

export function ShortcutHelpDialog({
  bindings,
  onSetBinding,
  onReset,
  onClose,
}: {
  bindings: Record<KeyboardCommandId, KeyChord>;
  onSetBinding: (id: KeyboardCommandId, chord: KeyChord) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [rebindingId, setRebindingId] = useState<KeyboardCommandId | null>(null);
  const [rebindError, setRebindError] = useState<string | null>(null);
  const titleId = useId();
  const conflicts = findBindingConflicts(bindings);

  useEffect(() => {
    if (rebindingId == null) return;
    const activeId: KeyboardCommandId = rebindingId;
    function onKeyDown(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setRebindingId(null);
        setRebindError(null);
        return;
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        onSetBinding(activeId, DEFAULT_KEYBOARD_BINDINGS[activeId]);
        setRebindingId(null);
        setRebindError(null);
        return;
      }
      const chord = chordFromKeyboardEvent(event);
      if (chord.key === 'shift' || chord.key === 'control' || chord.key === 'meta' || chord.key === 'alt') return;
      for (const cmd of KEYBOARD_COMMANDS) {
        if (cmd.id === activeId) continue;
        const existing = chordsForCommand(cmd.id, bindings);
        if (existing.some((existingChord) => chordsEqual(existingChord, chord))) {
          setRebindError(t('keyboard.rebindConflict', { shortcut: formatChordLabel(chord), command: cmd.label }));
          return;
        }
      }
      onSetBinding(activeId, chord);
      setRebindingId(null);
      setRebindError(null);
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [rebindingId, bindings, onSetBinding, t]);

  return (
    <Dialog
      title={t('keyboard.helpTitle')}
      titleId={titleId}
      titleAs="h2"
      className="w-full max-w-2xl max-h-[85vh] overflow-y-auto"
      onBackdropClick={onClose}
      data-keyboard-command-overlay
      actions={
        <div className="flex justify-between gap-2 w-full">
          <Btn type="button" ghost onClick={onReset}>
            {t('keyboard.resetDefaults')}
          </Btn>
          <Btn type="button" onClick={onClose}>
            {t('nav.done')}
          </Btn>
        </div>
      }
    >
      <p className="text-sm text-muted mb-4">{t('keyboard.helpIntro')}</p>
      {rebindError && (
        <p className="text-sm text-rose-400 mb-3" role="alert">
          {rebindError}
        </p>
      )}
      <table className="w-full text-sm mb-4">
        <thead>
          <tr className="text-left text-muted border-b border-[var(--color-divider)]">
            <th className="py-2 pr-3 font-medium">{t('keyboard.helpColumnAction')}</th>
            <th className="py-2 pr-3 font-medium">{t('keyboard.helpColumnShortcut')}</th>
            <th className="py-2 font-medium">{t('keyboard.helpColumnChange')}</th>
          </tr>
        </thead>
        <tbody>
          {KEYBOARD_COMMANDS.map((cmd) => {
            const chord = bindings[cmd.id];
            const altLabels = (cmd.altChords ?? [])
              .filter((alt) => !chordsEqual(alt, chord))
              .map((alt) => formatChordLabel(alt));
            return (
              <tr key={cmd.id} className="border-b border-[var(--color-divider)] align-top">
                <td className="py-3 pr-3">
                  <div className="font-medium text-white">{cmd.label}</div>
                  <div className="text-muted text-xs mt-0.5">{cmd.description}</div>
                  {cmd.contextHint && (
                    <div className="text-muted text-xs mt-0.5">{cmd.contextHint}</div>
                  )}
                </td>
                <td className="py-3 pr-3 whitespace-nowrap">
                  <kbd className="px-1.5 py-0.5 rounded bg-white/5 border border-[var(--color-divider)]">
                    {formatChordLabel(chord)}
                  </kbd>
                  {altLabels.length > 0 && (
                    <span className="text-muted text-xs block mt-1">
                      {t('keyboard.also')} {altLabels.join(', ')}
                    </span>
                  )}
                </td>
                <td className="py-3">
                  <Btn density="xs"
                    type="button"
                    ghost
                    className="text-xs"
                    aria-pressed={rebindingId === cmd.id}
                    onClick={() => {
                      setRebindError(null);
                      setRebindingId((current) => (current === cmd.id ? null : cmd.id));
                    }}
                  >
                    {rebindingId === cmd.id ? t('keyboard.rebindListening') : t('keyboard.rebind')}
                  </Btn>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {conflicts.size > 0 && (
        <p className="text-xs text-amber-300 mb-3" role="status">
          {t('keyboard.conflictWarning')}
        </p>
      )}
    </Dialog>
  );
}
